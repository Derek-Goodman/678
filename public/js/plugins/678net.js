//=============================================================================
// 678net.js
//=============================================================================
/*:
 * @plugindesc 678 联机（单人对决 1v1）。需要 678core.js + 678.js，排在它们之后。
 * @author DerekGoodman
 *
 * @help
 * ============================================================================
 * 这是什么
 * ============================================================================
 *  给 678 加联机。标题多一个「多人游戏」，里面是「锦标赛」和「单人对决」，
 *  目前只做了单人对决：两个真人 1v1，规则和单机完全一样
 *  （胜者摸 1 张、败者摸 2 张、平局重发、100 生命值、功能牌全套）。
 *
 * ============================================================================
 * 怎么跑
 * ============================================================================
 *  1. 起服务器：  node server.js --dir "工程目录"
 *  2. 浏览器开    http://localhost:3000
 *  3. 标题 → 多人游戏 → 单人对决 → 建立房间 / 加入房间
 *
 *  建房后画面会给出一个带房号的链接，发给对方点开就自动进房。
 *
 * ============================================================================
 * 设计要点
 * ============================================================================
 *  · 规则全部在服务器跑，这边只显示 + 发意图。对方暗牌客户端根本收不到
 *    （服务器发 v:null），揭牌时才补真值，所以开 devtools 也偷不到底牌。
 *  · 服务器发来的盘面是「镜像后自己永远是 side 0」的，所以 678.js 里
 *    所有硬编码 sides[0] / turn===0 的绘制代码一行都不用改。
 *  · 对 Scene_D678 的改动全部是「存原函数、包一层、按 _net 分支」，
 *    不改 678.js 本体 —— 和它自己的新手教程一节同一个写法。
 *
 * ============================================================================
 * 加载顺序
 * ============================================================================
 *  678core → 678 → title（可选）→ 678net
 *  无参数。
 * ============================================================================
 */

var D678N = D678N || {};

(function () {
'use strict';

if (typeof D678 === 'undefined' || !D678.Battle) {
    throw new Error('678net.js 需要先加载 678core.js 和 678.js');
}

//=============================================================================
// 配置
//=============================================================================

D678N.TURN_WARN = 10;      // 剩多少秒开始把倒计时标红

// 名字存本地，只输一次
D678N.savedName = function () {
    try { return localStorage.getItem('d678_name') || ''; } catch (e) { return ''; }
};
D678N.saveName = function (s) {
    try { localStorage.setItem('d678_name', s); } catch (e) {}
};

// 会话用 sessionStorage 而不是 localStorage：同一个浏览器开两个标签页
// 测试时，localStorage 是共享的，两边会抢同一个座位
D678N.session = function () {
    try { return JSON.parse(sessionStorage.getItem('d678_sess') || 'null'); } catch (e) { return null; }
};
D678N.setSession = function (o) {
    try {
        if (o) sessionStorage.setItem('d678_sess', JSON.stringify(o));
        else sessionStorage.removeItem('d678_sess');
    } catch (e) {}
};

// 在线人数的去重令牌。和会话一样存 sessionStorage —— 同一浏览器开两个
// 标签页测试时会各拿一个令牌，各算一个人（存 localStorage 的话两个标签页
// 共享，两个人只会显示成一个）。
// 必须整个会话稳定不变：服务器靠它认「还是那个访客」，每次随机就成了
// 每 5 秒新增一个人，人数会一路涨。
D678N.visitorToken = function () {
    try {
        var t = sessionStorage.getItem('d678_tab');
        if (!t) {
            t = String(Date.now() % 1e8) +
                Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, '');
            sessionStorage.setItem('d678_tab', t);
        }
        return t;
    } catch (e) {
        // 隐私模式下 sessionStorage 会抛。给个进程内的临时值，
        // 人数照样准（只是刷新后换个身份）
        if (!D678N._tabFallback) {
            D678N._tabFallback = 'x' + Math.random().toString(36).slice(2, 10);
        }
        return D678N._tabFallback;
    }
};

// 最近一次拿到的在线人数。null = 还没问到
D678N.stats = null;

//=============================================================================
// 传输层：SSE 收 + POST 发
//=============================================================================

D678N.Net = {
    sid: null,
    room: null,
    mySeat: 0,
    es: null,
    handlers: {},
    lastSeq: 0,
    connected: false,
};

//--- 收件箱 ----------------------------------------------------------------
// 不用「每个场景各自注册回调」，因为消息可能正好在场景切换的空档到达
// （大厅刚收到第一份盘面就要 push Scene_D678，那一帧两个场景都不在位）。
// 改成服务器消息一律先落到 inbox，场景在自己的 update 里取用 —— RMMV
// 本来就是帧驱动的，这样最省心，也不会丢消息。
D678N.inbox = {
    room:   null,    // 最新房间状态
    state:  null,    // 最新盘面
    events: [],      // 对手动作文字，按顺序
    over:   null,    // 决斗结束
    abort:  null,    // 房间被终止
    peer:   null,    // 对手掉线 / 回来
    netdown: false,  // 连接断了
};

D678N.clearInbox = function () {
    var b = D678N.inbox;
    b.room = null; b.state = null; b.events = [];
    b.over = null; b.abort = null; b.peer = null; b.netdown = false;
};

D678N.Net.emit = function (type, data) {
    var b = D678N.inbox;
    switch (type) {
    case 'room':    b.room = data; break;
    case 'state':   b.state = data; break;
    case 'event':   b.events.push(data.msg); if (b.events.length > 8) b.events.shift(); break;
    case 'over':    b.over = data; break;
    case 'abort':   b.abort = data; break;
    case 'peer':    b.peer = data; break;
    case 'netdown': b.netdown = true; break;
    }
};

D678N.Net.post = function (path, body, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', path, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function () {
        var r = null;
        try { r = JSON.parse(xhr.responseText); } catch (e) {}
        if (cb) cb(r, xhr.status);
    };
    xhr.onerror = function () { if (cb) cb(null, 0); };
    xhr.send(JSON.stringify(body || {}));
};

D678N.Net.connect = function (sid) {
    this.close();
    this.sid = sid;
    var self = this;
    var es = new EventSource('/api/events?sid=' + encodeURIComponent(sid));
    this.es = es;
    es.onopen = function () { self.connected = true; };
    es.onerror = function () {
        // EventSource 自带重连，这里只标记状态给界面用
        self.connected = false;
        self.emit('netdown', {});
    };
    es.onmessage = function (ev) {
        var m = null;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (!m || !m.t) return;
        self.connected = true;
        // 乱序的旧盘面直接丢掉
        if (m.t === 'state') {
            if (m.seq && m.seq < self.lastSeq) return;
            self.lastSeq = m.seq || 0;
        }
        self.emit(m.t, m);
    };
};

D678N.Net.close = function () {
    if (this.es) { try { this.es.close(); } catch (e) {} }
    this.es = null;
    this.connected = false;
};

D678N.Net.reset = function () {
    this.close();
    this.sid = null; this.room = null; this.mySeat = 0; this.lastSeq = 0;
    D678N.setSession(null);
};

// 当前动作要带的 seq —— 服务器靠它拒掉重复提交（手机双击）
D678N.Net.seq = function () { return this.lastSeq; };

//=============================================================================
// 客户端的赛事副本
//=============================================================================
//
// 视图层要读 D678.Game 的 human() / round / alivePlayers() / rankedPlayers()
// / players，以及 player 的 funcs/name/alive/last/isHuman/hp/wins/losses/
// maxPoint/funcUses/prevLast/isGod。这里造一个只满足这些的副本。
//
// 关键：players[0] 永远是本地玩家（服务器已经把盘面镜像过），
// 而且只有本地玩家 isHuman=true —— 虽然对面也是真人，但 buildRoundReport
// 和 drawRankList 用 isHuman 来高亮「我那一行」，只标本地的才对。
//
D678N.buildReplica = function (players, round, startHp) {
    var g = Object.create(D678.GameClass.prototype);
    g.players = players.map(function (info, i) {
        var p = new D678.Player(i, info.name, i === 0);
        p.hp       = info.hp;
        p.alive    = info.alive;
        p.wins     = info.wins;
        p.losses   = info.losses;
        p.maxPoint = info.maxPoint;
        p.funcUses = info.funcUses || 0;
        // 自己的功能牌是真 id；对手只知道张数，用占位补齐长度
        // （drawOppName 只读 .length，不会去看内容）
        p.funcs = info.funcs ? info.funcs.slice(0) : new Array(info.funcCount).fill(null);
        p.isGod = false;   // 1v1 里两边都是真人
        return p;
    });
    g.round    = round || 1;
    g.pool     = [];
    g.outCount = 0;
    g.finished = false;
    g.result   = null;
    if (startHp) D678.START_HP = startHp;   // 血条分母
    return g;
};

// 把服务器发来的盘面套到一个 D678.Battle 形状的对象上，
// 这样 total / adj / mod / isMaxVal / canHit / target / handStr 这些
// 显示辅助方法直接能用（它们只依赖本方数据和牌库长度，都是准确的）
D678N.buildBattle = function (v, game) {
    var b = Object.create(D678.Battle.prototype);
    b.game     = game;
    b.isSim    = false;
    b.players  = game.players;
    b.deck     = v.deck.slice(0);
    b.rule     = v.rule;
    b.standStreak = v.standStreak;
    b.turn     = v.turn;
    b.revealed = v.revealed;
    b.finished = v.finished;
    b.redeals  = v.redeals || 0;
    b.result   = v.result;
    b.pendingRedeal = false;
    b.sides = v.sides.map(function (s, i) {
        return {
            p: game.players[i], index: i,
            cards: s.cards.map(function (c) { return { v: c.v, hidden: c.hidden }; }),
            stood: s.stood, checkN: s.checkN, known: [],
        };
    });
    b.log = null;   // 日志由服务器在揭牌后单独下发
    return b;
};

//=============================================================================
// 大厅界面
//=============================================================================

var LC = {
    bg1: '#12482f', bg2: '#0a2417',
    panel: 'rgba(0,0,0,0.78)',
    edge: '#ffeaa0', text: '#ffffff', gray: '#b9c8c0',
    gold: '#ffd766', red: '#ff5a5a', green: '#5cff9d',
    // 和 678.js 里 COL 的取值保持一致：我方回合青色、对方回合橙色。
    // COL 是那个 IIFE 里的 var，外面拿不到，所以在这儿抄一份。
    aqua: '#48e6d2', orange: '#ff9a4d',
};

var BTN_W = 420, BTN_H = 78, BTN_GAP = 24;

// 在线人数那一行的 y。玩家名条占 186~282，菜单按钮从 380 起，
// 这一行塞在中间的空档里。
var ONLINE_Y = 292;

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

// 有 title.js 就复用它的按钮外观，保证风格统一；没有就自己画一个近似的
function drawBtn(bmp, x, y, w, h, on, press) {
    if (typeof D678T !== 'undefined' && D678T.drawButton) {
        D678T.drawButton(bmp, x, y, w, h, on, press);
        return;
    }
    var ctx = bmp._context;
    ctx.save();
    if (press) { y += 2; h -= 2; }
    var g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, on ? '#7fd3a6' : '#5fb98d');
    g.addColorStop(1, on ? '#52a87d' : '#3f8f6a');
    roundRect(ctx, x, y, w, h, 12);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = LC.edge; ctx.lineWidth = on ? 3 : 2; ctx.stroke();
    ctx.restore();
    bmp._setDirty();
}

function Scene_D678Net() { this.initialize.apply(this, arguments); }
Scene_D678Net.prototype = Object.create(Scene_Base.prototype);
Scene_D678Net.prototype.constructor = Scene_D678Net;
window.Scene_D678Net = Scene_D678Net;
D678N.Scene = Scene_D678Net;

Scene_D678Net.prototype.initialize = function () {
    Scene_Base.prototype.initialize.call(this);
};

Scene_D678Net.prototype.create = function () {
    Scene_Base.prototype.create.call(this);
    this._page   = 'menu';     // menu | duel | waiting | joining
    this._hits   = [];
    this._notice = '';
    this._noticeTime = 0;
    this._press  = null;   // null = 没按下；不能用 -1，返回按钮的 i 就是 -1
    this._roomInfo = null;
    this._busy   = false;
    this._resuming = false;   // 刷新后正在恢复对局
    this._statsWait = 1;      // 1 = 下一帧就问一次，别等满 5 秒
    this._statsFail = false;  // 服务器没有 /api/stats（老版本）

    var W = Graphics.width, H = Graphics.height;
    var bg = new Bitmap(W, H);
    var ctx = bg._context;
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, LC.bg1); g.addColorStop(1, LC.bg2);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    bg._setDirty();
    this.addChild(new Sprite(bg));

    this._bmp = new Bitmap(W, H);
    this.addChild(new Sprite(this._bmp));

    this.bindNet();
    this.refresh();
};

Scene_D678Net.prototype.start = function () {
    Scene_Base.prototype.start.call(this);
    this.startFadeIn(this.fadeSpeed(), false);
    this._guard = 10;
    // 刷新页面后回来的：标题画面检测到会话，把我们推到这儿接着恢复
    if (D678N.resumeSid) {
        var sid = D678N.resumeSid;
        D678N.resumeSid = null;
        this.doResume(sid);
        return;
    }
    // 从链接带房号进来的（?room=XXXX）：直接尝试加入
    var auto = D678N.autoRoom;
    if (auto) { D678N.autoRoom = null; this.doJoin(auto); }
};

// 刷新后拿旧 sid 换回座位。必须先用 XHR 探一次再连 SSE ——
// EventSource 拿不到 404，无效 sid 会让它无限重连、界面卡在「正在恢复」。
Scene_D678Net.prototype.doResume = function (sid) {
    var self = this;
    this._resuming = true;
    this._busy = true;
    this._page = 'waiting';
    this.refresh();
    D678N.Net.post('/api/resume', { sid: sid }, function (r, code) {
        self._busy = false;
        if (!r || code !== 200 || !r.ok) {
            // 座位没了（房间已销毁 / 超过 5 分钟宽限）—— 清掉会话正常回菜单
            self._resuming = false;
            D678N.Net.reset();
            self._page = 'menu';
            self.notice(code === 404 ? '刚刚那局已经结束了' : '恢复对局失败');
            self.refresh();
            return;
        }
        // mySeat 必须从服务器拿回来 —— sessionStorage 只存了 {sid, room}，
        // 不补这一步坐 1 号位的人回来镜像会整个反过来
        D678N.Net.mySeat = r.mySeat;
        D678N.Net.room = r.room;
        self._roomInfo = { room: r.room, phase: r.phase, mySeat: r.mySeat };
        // lobby 阶段（建了房还没人来）不会有盘面推过来，就停在等待页；
        // 其余阶段 onReconnect 会推 resync 盘面，pollNet 收到就 push 对局场景
        self._resuming = (r.phase !== 'lobby');
        D678N.Net.connect(sid);
        self.refresh();
    });
};

Scene_D678Net.prototype.bindNet = function () {
    D678N.clearInbox();
};

//--- 在线人数 --------------------------------------------------------------
// 每 5 秒问一次，这个请求本身就是「我还在」的心跳。
// 带上当前 sid（有的话）让服务器能去重 —— 建了房在等人的时候，
// 我既是一个访客又是一个连着的座位，不带 sid 就会被数两次。

Scene_D678Net.prototype.pingStats = function () {
    var self = this;
    D678N.Net.post('/api/stats', {
        token: D678N.visitorToken(),
        sid: D678N.Net.sid || null,
    }, function (r, code) {
        if (!r || code !== 200) {
            // 老服务器没这个接口（404）。标记一下别再画那一行，
            // 也别弹提示 —— 人数是附加信息，缺了不影响开局。
            self._statsFail = true;
            return;
        }
        self._statsFail = false;
        var old = D678N.stats;
        D678N.stats = r;
        // 数字没变就不重绘，省得每 5 秒白刷一遍整个画面
        if (!old || old.online !== r.online || old.playing !== r.playing ||
            old.waiting !== r.waiting) {
            self.refresh();
        }
    });
};

Scene_D678Net.prototype.updateStats = function () {
    if (this._statsWait > 0) { this._statsWait--; return; }
    this._statsWait = 300;   // 60fps → 5 秒
    this.pingStats();
};

// 在线人数那一行。等待页不画 —— 那时候「谁在这个房间里」才是要紧事，
// 全局人数只是噪音。
Scene_D678Net.prototype.drawOnline = function () {
    var W = Graphics.width;
    var s = D678N.stats;
    if (this._statsFail) return;
    if (!s) {
        this.txt('● 连接中…', 0, ONLINE_Y, W, 20, LC.gray, 'center');
        return;
    }
    var parts = ['在线 ' + s.online + ' 人'];
    if (s.playing > 0) parts.push(s.playing + ' 人对局中');
    if (s.waiting > 0) parts.push(s.waiting + ' 个房间等人');
    // 有人在等就标绿：这时候点「加入房间」马上能开一局
    var col = s.waiting > 0 ? LC.green : (s.online > 1 ? LC.text : LC.gray);
    this.txt('● ' + parts.join(' · '), 0, ONLINE_Y, W, 20, col, 'center');
};

//--- 绘制 ------------------------------------------------------------------

Scene_D678Net.prototype.txt = function (s, x, y, w, size, color, align) {
    var b = this._bmp;
    b.fontSize = size;
    b.textColor = color || LC.text;
    b.outlineColor = 'rgba(0,0,0,0.8)';
    b.outlineWidth = 4;
    b.drawText(s, x, y, w, size + 10, align || 'left');
};

Scene_D678Net.prototype.panel = function (x, y, w, h) {
    var ctx = this._bmp._context;
    ctx.save();
    roundRect(ctx, x, y, w, h, 14);
    ctx.fillStyle = LC.panel; ctx.fill();
    ctx.strokeStyle = LC.edge; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
    this._bmp._setDirty();
};

// 一组竖排按钮，返回时已经把点击区注册进 _hits
Scene_D678Net.prototype.buttons = function (list, y0) {
    var W = Graphics.width;
    var x = Math.round(W / 2 - BTN_W / 2);
    for (var i = 0; i < list.length; i++) {
        var it = list[i];
        var y = y0 + i * (BTN_H + BTN_GAP);
        var press = (this._press === i);
        var on = press;
        drawBtn(this._bmp, x, y, BTN_W, BTN_H, on && !it.dim, press && !it.dim);
        this._bmp.fontSize = 32;
        this._bmp.textColor = it.dim ? LC.gray : (press ? LC.edge : LC.text);
        this._bmp.outlineColor = 'rgba(0,0,0,0.8)';
        this._bmp.outlineWidth = 4;
        this._bmp.drawText(it.label, x, y + (BTN_H - 40) / 2 + (press ? 2 : 0),
            BTN_W, 40, 'center');
        if (it.sub) {
            this.txt(it.sub, x, y + BTN_H - 4, BTN_W, 16, LC.gray, 'center');
        }
        if (!it.dim) {
            this._hits.push({ x: x, y: y, w: BTN_W, h: BTN_H, i: i, cb: it.cb });
        }
    }
};

Scene_D678Net.prototype.refresh = function () {
    var b = this._bmp, W = Graphics.width, H = Graphics.height;
    b.clear();
    this._hits = [];

    this.txt('多人游戏', 0, 120, W, 44, LC.gold, 'center');
    // 玩家名条。原来是一行 20 号灰字（整屏最小）加一句「（点这里可改）」，
    // 点击区还没画框 —— 看不出能点。现在名字提到 32 号白字，和菜单按钮同级，
    // 「修改」做成独立小按钮。点名字本身不改名，避免误触。
    var nm = D678N.savedName();
    var px = Math.round(W / 2 - BTN_W / 2), py = 186, ph = 96;
    this.panel(px, py, BTN_W, ph);
    this.txt('玩家名', px + 24, py + 12, 200, 18, LC.gray, 'left');

    var mw = 96, mh = 56;
    var mx = px + BTN_W - 20 - mw, my = py + (ph - mh) / 2;
    this.txt(nm || '未设置', px + 24, py + 40, mx - px - 40, 32,
             nm ? LC.text : LC.gray, 'left');

    // 按下反馈沿用 i: -2（改名一直占着这个号），和菜单按钮同一套观感
    var mpress = (this._press === -2);
    drawBtn(this._bmp, mx, my, mw, mh, mpress, mpress);
    this._bmp.fontSize = 24;
    this._bmp.textColor = mpress ? LC.edge : LC.text;
    this._bmp.outlineColor = 'rgba(0,0,0,0.8)';
    this._bmp.outlineWidth = 4;
    this._bmp.drawText(nm ? '修改' : '设置', mx,
        my + (mh - 34) / 2 + (mpress ? 2 : 0), mw, 34, 'center');
    // 没存过名字时也要能点 —— 原来 if (nm) 为假整行都不画，
    // 第一次进来看不到「我是谁」，也没法主动设名字
    this._hits.push({ x: mx, y: my, w: mw, h: mh, i: -2,
                      cb: this.onChangeName.bind(this) });

    if (this._page === 'menu' || this._page === 'duel') this.drawOnline();

    if (this._page === 'menu')    this.drawMenu();
    if (this._page === 'duel')    this.drawDuel();
    if (this._page === 'waiting') this.drawWaiting();

    if (this._noticeTime > 0 && this._notice) {
        this.panel(60, H - 200, W - 120, 64);
        this.txt(this._notice, 60, H - 182, W - 120, 24, LC.red, 'center');
    }

    // 返回
    var bx = W / 2 - 110, by = H - 110;
    this.panel(bx, by, 220, 62);
    this.txt('返回', bx, by + 18, 220, 26, LC.text, 'center');
    this._hits.push({ x: bx, y: by, w: 220, h: 62, i: -1, cb: this.onBack.bind(this) });
};

// 按钮不带 sub 说明 —— 标题已经说清是什么了，灰字副标题只是噪音。
// buttons() 仍支持 sub 字段，以后想加回来传一下就行。
Scene_D678Net.prototype.drawMenu = function () {
    this.buttons([
        // 「敬请期待」并进标题：它是 dim 按钮，点了没反应，
        // 不说一句玩家会以为是坏的
        { label: '锦标赛（敬请期待）', dim: true, cb: function () {} },
        { label: '单人对决', cb: this.onDuel.bind(this) },
    ], 380);
};

Scene_D678Net.prototype.drawDuel = function () {
    // 336 而不是原来的 300 —— 在线人数那一行占了 292~322
    this.txt('单人对决', 0, 336, Graphics.width, 30, LC.gold, 'center');
    this.buttons([
        { label: '建立房间', cb: this.onCreate.bind(this) },
        { label: '加入房间', cb: this.onJoinPrompt.bind(this) },
    ], 400);
};

Scene_D678Net.prototype.drawWaiting = function () {
    var W = Graphics.width;
    var info = this._roomInfo;
    if (!info) { this.txt('连接中…', 0, 400, W, 28, LC.gray, 'center'); return; }

    // 刷新后正在恢复：盘面还没到，房间信息也还没带 seats，
    // 直接走下面会踩 info.seats[i] 的空指针
    if (this._resuming || !info.seats) {
        this.panel(60, 340, W - 120, 200);
        this.txt('正在恢复对局…', 60, 396, W - 120, 30, LC.gold, 'center');
        this.txt('房间 ' + (info.room || ''), 60, 444, W - 120, 22, LC.gray, 'center');
        this.txt('稍等一下，正在把你放回牌桌', 60, 480, W - 120, 18, LC.gray, 'center');
        return;
    }

    this.panel(60, 300, W - 120, 340);
    this.txt('房间号', 60, 322, W - 120, 20, LC.gray, 'center');
    this.txt(info.room, 60, 350, W - 120, 56, LC.gold, 'center');

    // 可直接分享的链接：对方点开就自动进房，不用手打房号
    var link = location.origin + location.pathname + '?room=' + info.room;
    this.txt('把这个链接发给对方：', 60, 424, W - 120, 18, LC.gray, 'center');
    this.txt(link, 70, 448, W - 140, 17, LC.text, 'center');

    this.txt('座位', 60, 492, W - 120, 18, LC.gray, 'center');
    for (var i = 0; i < 2; i++) {
        var s = info.seats[i];
        var y = 518 + i * 32;
        var label = s ? s.name : '（空）';
        var st = s ? (s.connected ? '已就绪' : '连接中…') : '等待加入';
        var col = s ? (s.connected ? LC.green : LC.gray) : LC.gray;
        var mark = (i === info.mySeat) ? '▶ ' : '　';
        this.txt(mark + (i + 1) + '. ' + label, 100, y, 300, 20, LC.text, 'left');
        this.txt(st, W - 400, y, 300, 20, col, 'right');
    }

    var ready = info.seats.filter(function (s) { return s && s.connected; }).length;
    this.txt(ready >= 2 ? '双方就绪，即将开始…' : '等待对手加入…',
        0, 660, W, 24, ready >= 2 ? LC.green : LC.gray, 'center');
};

//--- 输入 ------------------------------------------------------------------

Scene_D678Net.prototype.update = function () {
    Scene_Base.prototype.update.call(this);
    if (this._guard > 0) this._guard--;
    if (this._noticeTime > 0) {
        this._noticeTime--;
        if (this._noticeTime === 0) this.refresh();
    }
    this.pollNet();
    this.updateStats();
    this.updateInput();
};

Scene_D678Net.prototype.pollNet = function () {
    var b = D678N.inbox;

    if (b.abort) {
        var why = b.abort.reason || '房间已关闭';
        b.abort = null;
        D678N.Net.reset();
        this._page = 'menu';
        this._roomInfo = null;
        this._resuming = false;   // 恢复途中房间被终止：别卡在「正在恢复」
        this.notice(why);
        this.refresh();
        return;
    }

    if (b.room) {
        var r = b.room;
        b.room = null;
        this._roomInfo = r;
        D678N.Net.room = r.room;
        D678N.Net.mySeat = r.mySeat;
        if (this._page !== 'waiting') this._page = 'waiting';
        // lobby 阶段恢复：没有盘面会来，收掉「正在恢复」显示正常的等待页。
        // 其余阶段继续挂着，等下面那份 resync 盘面把我们推进对局场景。
        if (this._resuming && r.phase === 'lobby') this._resuming = false;
        this.refresh();
    }

    // 第一份盘面到了就进对局场景（盘面留在 inbox 里，由那边取用）
    if (b.state && !this._leaving) {
        this._leaving = true;
        D678N.mode = 'duel';
        SceneManager.push(Scene_D678);
    }
};

Scene_D678Net.prototype.updateInput = function () {
    if (this._guard > 0 || this._busy) return;
    var x = TouchInput.x, y = TouchInput.y;
    var hit = -1;
    for (var i = 0; i < this._hits.length; i++) {
        var h = this._hits[i];
        if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) { hit = i; break; }
    }

    if (TouchInput.isPressed()) {
        if (TouchInput.isTriggered() && hit >= 0) {
            this._press = this._hits[hit].i;
            SoundManager.playCursor();
            this.refresh();
        }
    } else if (TouchInput.isReleased()) {
        // 空闲哨兵用 null 而不是 -1 —— 返回按钮的 i 就是 -1，
        // 用 -1 当哨兵会让它永远点不动（这就是「返回按钮没反应」的原因）
        if (this._press !== null && hit >= 0 && this._hits[hit].i === this._press) {
            var cb = this._hits[hit].cb;
            this._press = null;
            this.refresh();
            SoundManager.playOk();
            cb();
            return;
        }
        this._press = null;
        this.refresh();
    }

    if (Input.isTriggered('cancel')) { SoundManager.playCancel(); this.onBack(); }
};

Scene_D678Net.prototype.notice = function (s) {
    this._notice = s; this._noticeTime = 240;
};

//--- 动作 ------------------------------------------------------------------

// 名字用浏览器原生 prompt：网页版天然有输入法，中文/emoji/手机键盘全都正常。
// 样式和游戏不搭，但能立刻用；以后换成盖在画布上的 DOM <input> 只动这一个函数。
Scene_D678Net.prototype.askName = function () {
    var cur = D678N.savedName();
    var s = window.prompt('输入你的名字（最多 8 个汉字）', cur || '玩家');
    if (s === null) return null;
    s = String(s).trim().slice(0, 8);  // 截断到 8 字符，免得超长名字压扁或溢出
    if (!s) { this.notice('名字不能为空'); this.refresh(); return null; }
    D678N.saveName(s);
    return s;
};

Scene_D678Net.prototype.onChangeName = function () {
    if (this.askName()) this.refresh();
};

Scene_D678Net.prototype.onDuel = function () {
    this._page = 'duel';
    this.refresh();
};

Scene_D678Net.prototype.onBack = function () {
    if (this._page === 'waiting') {
        // 已经建/进了房，退出要通知服务器把房间关掉
        if (D678N.Net.sid) D678N.Net.post('/api/leave', { sid: D678N.Net.sid }, null);
        D678N.Net.reset();
        this._page = 'menu';
        this._roomInfo = null;
        this.refresh();
        return;
    }
    if (this._page === 'duel') { this._page = 'menu'; this.refresh(); return; }
    SceneManager.pop();
};

Scene_D678Net.prototype.onCreate = function () {
    var name = D678N.savedName() || this.askName();
    if (!name) return;
    var self = this;
    this._busy = true;
    D678N.Net.post('/api/create', { name: name }, function (r, code) {
        self._busy = false;
        if (!r || code !== 200) { self.notice('建房失败，服务器没响应'); self.refresh(); return; }
        D678N.setSession({ sid: r.sid, room: r.room });
        D678N.Net.mySeat = r.mySeat;
        D678N.Net.connect(r.sid);
        self._page = 'waiting';
        self.refresh();
    });
};

Scene_D678Net.prototype.onJoinPrompt = function () {
    var name = D678N.savedName() || this.askName();
    if (!name) return;
    var code = window.prompt('输入 4 位房号', '');
    if (code === null) return;
    code = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 4) { this.notice('房号是 4 位'); this.refresh(); return; }
    this.doJoin(code);
};

Scene_D678Net.prototype.doJoin = function (code) {
    var name = D678N.savedName() || this.askName();
    if (!name) return;
    var self = this;
    this._busy = true;
    this._page = 'waiting';
    this.refresh();
    D678N.Net.post('/api/join', { room: code, name: name }, function (r, st) {
        self._busy = false;
        if (!r || st !== 200) {
            self.notice((r && r.err) || '加入失败');
            self._page = 'duel';
            self.refresh();
            return;
        }
        D678N.setSession({ sid: r.sid, room: r.room });
        D678N.Net.mySeat = r.mySeat;
        D678N.Net.connect(r.sid);
        self.refresh();
    });
};

Scene_D678Net.prototype.terminate = function () {
    Scene_Base.prototype.terminate.call(this);
};

//=============================================================================
// Scene_D678 补丁
//=============================================================================
//
// 全部是「存原函数、包一层、按 _net 分支」，和 678.js 里新手教程一节
// 同一个写法，不改 678.js 本体。绘制函数一个都没碰 —— 因为服务器发来的
// 盘面已经镜像成「我永远是 side 0」，那些硬编码 sides[0] 的代码本来就对。
//
// 联机下客户端不许改任何游戏状态：所有会 mutate 的入口
// （act / useFunc / grantFuncs / newDeal / returnFunc）都被换成发意图。
//

var _cr = Scene_D678.prototype.create;
Scene_D678.prototype.create = function () {
    _cr.call(this);
    this._net = (D678N.mode === 'duel');
    if (!this._net) return;
    this._netWaitAck  = false;   // 已点继续，等对手
    this._netOwes     = false;   // 还欠弃牌
    this._netPeerGone = null;    // 对手掉线信息
    this._netDeadline = 0;       // 本回合截止时间戳
    this._netOver     = null;
    this._netPre      = null;    // 揭牌演出期间显示的发牌前手牌
    this._netApplied  = 0;
    this._netPlayedResolve = 0;  // 已播过演出的结算编号（同一次不重播）
    this._netPreApplied = 0;     // 已套用过发牌前快照的结算编号（同一次不重套）
    this._netTurnLeft = 0;       // 回合剩余毫秒（收到时的快照）
    this._netTurnAt   = 0;
    this._netDiscardLeft = 0;
    this._netDiscardAt   = 0;
    this._netAckCool  = 0;       // 点「继续」后的冷却帧，防误触
    this._netAckSentAt = 0;      // 上次发 ack 的时刻（等太久时提示可重发）
    this._netPeerGoneMs = 0;     // 对手已掉线多久
    this._netPeerGoneAt = 0;
    this._netPeerOwes = false;   // 对方还欠弃牌
    this._netAdvancing = false;  // 服务器已在倒数「开下一局」
};

// 原 start 会先弹「知道规则吗」的询问（教程那一节改的），联机跳过
var _st = Scene_D678.prototype.start;
Scene_D678.prototype.start = function () {
    if (!this._net) { _st.call(this); return; }
    Scene_Base.prototype.start.call(this);
    this.startFadeIn(this.fadeSpeed(), false);
    this._phase = 'netwait';
    this._msgs = [];
    this._notice = '等待服务器…';
    this.refresh();
};

//--- 应用服务器盘面 --------------------------------------------------------

Scene_D678.prototype.netApply = function (m) {
    var v = m.b;
    var first = !this._battle;

    // 副本：players[0] 永远是本地玩家（服务器已镜像）
    var g = D678N.buildReplica(v.players, m.round, this._netStartHp);
    D678.Game = g;
    this._battle = D678N.buildBattle(v, g);
    this._netOwes = !!m.owesDiscard;

    // 倒计时按「还剩多少毫秒」+ 收到的时刻算，不用服务器的绝对时间戳 ——
    // 两台设备的钟差几分钟很常见，用时间戳会算出离谱的秒数
    if (m.turnLeft !== undefined) {
        this._netTurnLeft = m.turnLeft;
        this._netTurnAt = Date.now();
    }
    if (m.discardLeft !== undefined) {
        this._netDiscardLeft = m.discardLeft;
        this._netDiscardAt = Date.now();
    }

    // 对手掉线状态由每份盘面带过来，比 peer 消息可靠（重连后也能对上）
    if (m.peerGone) {
        if (!this._netPeerGone) this._netPeerGone = { name: m.peerName };
        this._netPeerGoneMs = m.peerGoneMs || 0;
        this._netPeerGoneAt = Date.now();
    } else if (m.peerGone === false) {
        this._netPeerGone = null;
    }

    // 对手是否已点继续，用来显示「等待对手」还是「对方已确认」
    this._netWaiting = !!(m.myAcked && !m.peerAcked);
    if (m.myAcked !== undefined) this._netWaitAck = !!m.myAcked || this._netWaitAck;
    // 对方是否还欠弃牌（决定我这边显示轮结果还是等待屏）
    if (m.peerOwes !== undefined) this._netPeerOwes = !!m.peerOwes;
    // 服务器已经在倒数「2 秒后开下一局」
    if (m.advancing) this._netAdvancing = true;

    // 副本是新建的，_discardFor 还指着上一份副本里的旧 Player 对象。
    // 不重新指过来的话，onDiscardConfirm 读的是旧 funcs，弃牌必然对不上。
    if (this._discardFor) {
        if (m.owesDiscard) this._discardFor = g.human();
        else {
            // 服务器已经替我自动弃了（超时），把界面收掉
            this._discardFor = null;
            this._discardSel = [];
            this.clearDiscardSprites();
            if (m.autoDiscarded) this.notice('弃牌超时，已自动弃牌');
        }
    }

    // 揭牌演出期间先显示发牌前的手牌，等 finishBattle 再切到发牌后的。
    //
    // 只在「这次结算的第一份状态」上做这个替换。服务器每次推 resolved 都带
    // preFuncs，包括对方弃完牌后的那次重推 —— 如果每次都替换，我正开着弃牌
    // 界面（8 张）会被换成发牌前的快照（6 张），选中的下标随之错位，
    // 看起来就是「对方弃的牌显示到我这边」。双方手牌都满时必然触发，
    // 因为那时两边都欠弃牌，重推一定发生在我弃牌界面还开着的时候。
    var rid0 = m.resolveId || 0;
    if (v.preFuncs && rid0 !== this._netPreApplied && !this._discardFor) {
        this._netPreApplied = rid0;
        this._netPre = { funcs: v.preFuncs, counts: v.preFuncCounts };
        this.netUsePre(true);
    } else if (!v.preFuncs) {
        this._netPre = null;
        this._netPost = null;
    }

    if (m.log) this._netLog = m.log;

    // 新一局 / 平局重发：放发牌演出
    if (m.fresh) {
        this._msgs = m.redealt ? ['平局，已重新发牌'] : [];
        this._selFunc = null;
        this._notice = '';
        this._panelHold = 0;
        this._panelFade = 1;
        this._netWaitAck = false;
        this._netWaiting = false;
        this._netAdvancing = false;
        this._netPeerOwes = false;
        this._netFinished = false;
        this._report = null;
        this._lastLog = null;
        // 上一局可能停在弃牌 / 等待屏，这些残留必须清掉
        this._discardFor = null;
        this._discardSel = [];
        this.clearDiscardSprites();
        this._phase = 'battle';
        this._wait = 40;
        this.dealFx();
        this.refresh();
        return;
    }

    // 结算：交给原 onBattleEnd 播演出（它只读 result / finished，不改状态）
    if (m.resolved) {
        this.netSetLast(v.result);
        this._roundInfo = { pairs: [[g.players[0], g.players[1]]], bye: null };

        // 同一次结算只播一次演出。弃牌后服务器会把 resolved 状态再推一遍，
        // 少了这道判断就会把已经走到 roundResult 的客户端打回 resolve，
        // 而 _netFinished 已是 true → netFinish 立刻 return → 双方各自卡死。
        var rid = m.resolveId || 0;
        if (rid && rid === this._netPlayedResolve) {
            this.refresh();
            return;
        }
        this._netPlayedResolve = rid;
        this._netFinished = false;
        this._phase = 'battle';
        this.onBattleEnd();
        return;
    }

    if (first || m.resync) {
        this._phase = 'battle';
        this._wait = 0;
        this.refresh();
        return;
    }

    this._phase = 'battle';
    this.refresh();
};

// 在发牌前 / 发牌后两份手牌之间切换（只影响显示）
Scene_D678.prototype.netUsePre = function (usePre) {
    if (!this._netPre || !D678.Game) return;
    var g = D678.Game;
    if (usePre) {
        if (!this._netPost) {
            this._netPost = g.players.map(function (p) { return p.funcs.slice(0); });
        }
        for (var i = 0; i < g.players.length; i++) {
            var f = this._netPre.funcs[i];
            var n = this._netPre.counts[i];
            g.players[i].funcs = f ? f.slice(0) : new Array(n || 0).fill(null);
        }
    } else if (this._netPost) {
        for (var j = 0; j < g.players.length; j++) {
            g.players[j].funcs = this._netPost[j].slice(0);
        }
        this._netPost = null;
        this._netPre = null;
    }
};

// 从结算结果反填 last，让 buildRoundReport / drawRankList 原样可用。
// 平局不设 last —— 单机 doResolve 在 tie 分支直接 return，也没设。
Scene_D678.prototype.netSetLast = function (r) {
    if (!r || r.tie || !D678.Game) return;
    var ps = D678.Game.players;
    var w = (r.winner === 0) ? 0 : 1, l = 1 - w;
    ps[w].last = { type: 'win',  dmg: 0,     vs: ps[l].name };
    ps[l].last = { type: 'lose', dmg: r.dmg, vs: ps[w].name };
};

//--- 主循环 ----------------------------------------------------------------

var _up = Scene_D678.prototype.update;
Scene_D678.prototype.update = function () {
    if (!this._net) { _up.call(this); return; }

    Scene_Base.prototype.update.call(this);
    this.netPoll();

    this.updateCardSprites();
    this.updateFxQueue();
    this.updateFx();
    this.updateShake();
    this.updatePanelFade();
    if (this._noticeTime > 0) {
        this._noticeTime--;
        if (this._noticeTime === 0) { this._notice = ''; this.refresh(); }
    }
    this.updateInput();
    this.netTickClock();

    if (this._discardFor || this._showList) return;
    // 等待对方弃牌：这一屏纯等服务器，不做任何本地推进
    if (this._phase === 'peerDiscard') return;
    if (this._wait > 0) { this._wait--; return; }

    // 联机下这两个分支不能本地推进（会改状态），改成发意图后等服务器
    switch (this._phase) {
    case 'tie':     this.netAckOnce(); break;
    case 'resolve': this.netFinish();  break;
    }
};

Scene_D678.prototype.netPoll = function () {
    var b = D678N.inbox;

    if (b.abort) {
        var why = b.abort.reason || '房间已关闭';
        b.abort = null;
        this._netOver = { aborted: true, reason: why };
        this._phase = 'netover';
        this._battle = null;
        this.refresh();
        return;
    }

    if (b.room) {
        this._netStartHp = b.room.startHp || D678.START_HP;
        if (b.room.startHp) D678.START_HP = b.room.startHp;
        b.room = null;
    }

    if (b.peer) {
        if (b.peer.gone) {
            this._netPeerGone = b.peer;
            this._netPeerGoneMs = 0;
            this._netPeerGoneAt = Date.now();
        } else {
            this._netPeerGone = null;
            this.notice((b.peer.name || '对手') + ' 回来了');
        }
        b.peer = null;
        this.refresh();
    }

    if (b.events.length) {
        for (var i = 0; i < b.events.length; i++) this.pushMsg(b.events[i]);
        b.events = [];
        this.refresh();
    }

    if (b.state) {
        var m = b.state;
        b.state = null;
        this.netApply(m);
    }

    if (b.over) {
        this._netOver = b.over;
        b.over = null;
        // 决斗结束：沿用单机的淘汰 / 通关画面
        this._phase = 'gameover';
        this._battle = null;
        this._notice = this._netOver.win
            ? '你赢下了这场决斗！'
            : '你被淘汰了……';
        this._report = this.netFinalReport();
        this.refresh();
    }
};

// 剩余秒数：拿收到时的剩余毫秒减去本地流逝的时间，全程只用本地时钟，
// 所以两台设备钟不同步也不影响
Scene_D678.prototype.netTurnSec = function () {
    if (!this._netTurnLeft || !this._netTurnAt) return -1;
    return Math.max(0, Math.ceil((this._netTurnLeft - (Date.now() - this._netTurnAt)) / 1000));
};
Scene_D678.prototype.netDiscardSec = function () {
    if (!this._netDiscardLeft || !this._netDiscardAt) return -1;
    return Math.max(0, Math.ceil((this._netDiscardLeft - (Date.now() - this._netDiscardAt)) / 1000));
};

// 每秒重画一次就够，不必每帧
Scene_D678.prototype.netTickClock = function () {
    var show = -1;
    if (this._discardFor) show = this.netDiscardSec();
    else if (this._phase === 'battle') show = this.netTurnSec();
    // 掉线计时也要走，否则「已掉线 X 秒」不会自己往上跳
    if (this._netPeerGone) {
        var ms = (this._netPeerGoneMs || 0) + (Date.now() - (this._netPeerGoneAt || Date.now()));
        show = (show >= 0 ? show * 1000 : 0) + Math.floor(ms / 1000);
    }
    if (show !== this._netClockShown) {
        this._netClockShown = show;
        this.refresh();
    }
};

Scene_D678.prototype.netFinalReport = function () {
    var o = this._netOver;
    if (!o || !o.stats) return null;
    var me = o.stats[0], op = o.stats[1];
    var rate = function (a, b) {
        var g = a + b;
        return g > 0 ? Math.round(a / g * 100) + '%' : '—';
    };
    return [
        (o.win ? '胜者：你' : '胜者：' + op.name),
        '最终 HP：' + Math.max(0, me.hp) + '　对局 ' + me.games + ' 场',
        '胜 ' + me.wins + '　负 ' + me.losses + '　胜率 ' + rate(me.wins, me.losses),
        '满点 ' + me.maxPoint + ' 次',
        '共使用功能牌 ' + (me.funcUses || 0) + ' 次',
    ];
};

//--- 不许本地推进的三处 ----------------------------------------------------

// 平局重发：单机在这里直接 newDeal()，联机必须由服务器发牌
var _rd = Scene_D678.prototype.doRedeal;
Scene_D678.prototype.doRedeal = function () {
    if (!this._net) { _rd.call(this); return; }
    this.netAckOnce();
};

// 结算后发功能牌：单机在这里 grantFuncs()，联机服务器已经发过了，
// 这边只负责按原节奏把「奖励」显示出来、需要弃牌就开弃牌界面
var _fb = Scene_D678.prototype.finishBattle;
Scene_D678.prototype.finishBattle = function () {
    if (!this._net) { _fb.call(this); return; }
    this.netFinish();
};

Scene_D678.prototype.netFinish = function () {
    if (this._netFinished) return;
    this._netFinished = true;

    // 演出走完了，切到发牌后的手牌
    this.netUsePre(false);

    if (this._netOwes) {
        var me = D678.Game.human();
        if (me.funcs.length > D678.MAX_FUNC) {
            this._discardFor = me;
            this._discardSel = [];
            this._phase = 'discard';
            this.refresh();
            return;
        }
    }
    // 我不用弃、但对方要弃：不进轮结果，直接进等待屏。
    // 弃完由服务器推下一局，全程不需要点确认。
    if (this._netPeerOwes) { this.netToPeerDiscard(); return; }
    this.netToRoundResult();
};

// 对方还在弃牌时的等待屏
Scene_D678.prototype.netToPeerDiscard = function () {
    this._lastLog = this._netLog ? this._netLog.slice(0) : null;
    this._phase = 'peerDiscard';
    this._notice = '';
    this._wait = 0;
    this.refresh();
};

Scene_D678.prototype.netToRoundResult = function () {
    this._lastLog = this._netLog ? this._netLog.slice(0) : null;
    this._battleKeep = this._battle;
    this._phase = 'roundResult';
    // 提示语交给下面那个「继续」按钮，这里不再写字，免得两处叠在一起
    this._notice = '';
    this._wait = 20;
    this.buildRoundReport();
    this._battle = null;
    this.refresh();
};

// 弃牌确认：单机在这里改 p.funcs 并 returnFunc，联机发意图
var _dc = Scene_D678.prototype.onDiscardConfirm;
Scene_D678.prototype.onDiscardConfirm = function () {
    if (!this._net) { _dc.call(this); return; }
    var p = this._discardFor;
    if (!p) return;
    var need = Math.max(0, p.funcs.length - D678.MAX_FUNC);
    if (this._discardSel.length !== need) return;

    var ids = this._discardSel.map(function (i) { return p.funcs[i]; });
    var self = this;
    this._discardBusy = true;
    D678N.Net.post('/api/discard', { sid: D678N.Net.sid, ids: ids }, function (r) {
        self._discardBusy = false;
        if (!r || !r.ok) {
            self.notice((r && r.err) || '弃牌失败');
            self.refresh();
            return;
        }
        self._discardFor = null;
        self._discardSel = [];
        self._netOwes = false;
        self.clearDiscardSprites();
        self._netAckCool = 20;   // 约 1/3 秒，够挡住同一下点击的余波
        // 我弃完了但对方还在挑 -> 等待屏；都弃完了服务器会直接推下一局，
        // 这里也进等待屏顶一下，免得空一帧闪出旧画面
        self.netToPeerDiscard();
    });
};

//--- 对手回合：等，不跑 AI -------------------------------------------------

var _ub = Scene_D678.prototype.updateBattle;
Scene_D678.prototype.updateBattle = function () {
    if (!this._net) { _ub.call(this); return; }
    // 联机下什么都不做：对手的动作由服务器推过来
};

//--- 我的动作：发意图 ------------------------------------------------------

Scene_D678.prototype.netCanAct = function () {
    var b = this._battle;
    return !!(b && !b.finished && b.turn === 0 && this._phase === 'battle' && !this._netBusy);
};

Scene_D678.prototype.netSend = function (action) {
    if (!this.netCanAct()) return;
    var self = this;
    this._netBusy = true;
    this._selFunc = null;
    this.refresh();
    D678N.Net.post('/api/act', {
        sid: D678N.Net.sid, seq: D678N.Net.seq(), action: action,
    }, function (r) {
        self._netBusy = false;
        if (!r) { self.notice('网络异常'); self.refresh(); return; }
        if (r.stale) { self.refresh(); return; }   // 重复提交，静默丢掉
        if (!r.ok) { self.notice(r.err || '无法操作'); self.refresh(); return; }
        if (r.fail) self.notice('此号牌已在场上');
        self.refresh();
    });
};

var _oh = Scene_D678.prototype.onHit;
Scene_D678.prototype.onHit = function () {
    if (!this._net) { _oh.call(this); return; }
    var b = this._battle;
    if (!this.netCanAct()) return;
    // 本地先挡一下明显不合法的，省一次往返（服务器仍会独立校验）
    if (!b.canHit(0)) {
        this.notice(b.deck.length === 0 ? '牌库已空' : '明牌合计大于等于21点无法继续要牌');
        this.refresh();
        return;
    }
    this.netSend({ type: 'hit' });
};

var _os = Scene_D678.prototype.onStand;
Scene_D678.prototype.onStand = function () {
    if (!this._net) { _os.call(this); return; }
    this.netSend({ type: 'stand' });
};

var _ouf = Scene_D678.prototype.onUseFunc;
Scene_D678.prototype.onUseFunc = function () {
    if (!this._net) { _ouf.call(this); return; }
    if (!this.netCanAct()) return;
    if (this._selFunc === null) return;
    var me = D678.Game.human();
    var id = me.funcs[this._selFunc];
    if (!id) return;
    this.netSend({ type: 'func', id: id });
};

//--- 继续 / 结束 -----------------------------------------------------------

Scene_D678.prototype.netAckOnce = function () {
    if (this._netWaitAck) return;
    this._netWaitAck = true;
    this._notice = '';          // 收掉「点击继续」，换成下面那块「已确认」
    this.netSendAck();
    this.refresh();
};

// ack 要能重发：网络抖一下丢了这一个请求，服务器就永远等不到我，
// 而客户端 _netWaitAck 已经置上、不会再发第二次 —— 那就真卡住了。
// 失败就退回未确认状态让玩家再点，成功但对方还没点则起一个兜底重发。
Scene_D678.prototype.netSendAck = function () {
    var self = this;
    this._netAckSentAt = Date.now();
    D678N.Net.post('/api/ack', { sid: D678N.Net.sid }, function (r) {
        if (!r) {
            // 请求没到服务器，允许玩家再点一次
            self._netWaitAck = false;
            self._notice = '网络异常，请再点一次继续';
            self._noticeTime = 180;
            self.refresh();
            return;
        }
        if (r.ignored) {
            // 服务器已经不在结算阶段了（对方先推进了），等下一份盘面就好
            self.refresh();
            return;
        }
        self._netWaiting = !!r.waiting;
        self.refresh();
    });
};

var _nr = Scene_D678.prototype.nextRound;
Scene_D678.prototype.nextRound = function () {
    if (!this._net) { _nr.call(this); return; }
    if (this._netAckCool > 0) return;   // 刚点过弃牌确认，别把那一下也算成「继续」
    this._netFinished = false;
    this.netAckOnce();
};

// 联机下轮结果画面必须等玩家自己点，而且刚从弃牌界面出来的那几帧不收点击 ——
// 否则确认弃牌的那一下会在下一帧被轮结果画面再吃一次，看起来就像自动跳了
var _ui = Scene_D678.prototype.updateInput;
Scene_D678.prototype.updateInput = function () {
    if (!this._net) { _ui.call(this); return; }
    if (this._netAckCool > 0) {
        this._netAckCool--;
        // 冷却期间仍然要把点击区画出来（_hits 由 refresh 填），只是不响应
        if (TouchInput.isTriggered()) return;
    }
    _ui.call(this);
};

// 联机下由服务器判定结束（over 消息），这里不本地判
var _cge = Scene_D678.prototype.checkGameEnd;
Scene_D678.prototype.checkGameEnd = function () {
    if (!this._net) return _cge.call(this);
    return this._phase === 'gameover' || this._phase === 'netover';
};

var _bt = Scene_D678.prototype.backToTitle;
Scene_D678.prototype.backToTitle = function () {
    if (this._net) {
        if (D678N.Net.sid) D678N.Net.post('/api/leave', { sid: D678N.Net.sid }, null);
        D678N.Net.reset();
        D678N.mode = null;
        D678.Game = null;
    }
    _bt.call(this);
};

//--- 自己的名字不显示，那个位置改放回合倒计时 ------------------------------
// 单机里玩家永远叫「我」，名字和血条挤同一行没问题。联机下自己的名字
// 对自己毫无信息量（对手名字在上方已经有了），所以整个不画，
// 腾出来的第二行右侧放回合倒计时。

var _hp = Scene_D678.prototype.drawHpBar;
Scene_D678.prototype.drawHpBar = function () {
    if (!this._net) { _hp.call(this); return; }

    var me = D678.Game.human();
    var real = me.name;
    me.name = '';                // 让原逻辑不画名字
    _hp.call(this);
    me.name = real;

    var bmp = this._uiBmp;

    // 血条左侧只留一个「你」，标明这条是自己的血
    this.txt(bmp, '你', 26, 22, 70, 24, LC.gray, 'left');

    // 第二行右侧（原来放名字的位置）改放回合倒计时。
    // 左侧是原有的「第 X 轮   存活 N 人」，两者不重叠。
    var b = this._battle;
    if (this._phase === 'battle' && b && !b.finished) {
        var left = this.netTurnSec();
        if (left >= 0) {
            var mine = (b.turn === 0);
            var col = mine ? (left <= D678N.TURN_WARN ? LC.red : LC.aqua) : LC.orange;
            this.txt(bmp, (mine ? '你的回合 ' : '等对方 ') + left + 's',
                408, 72, 300, 20, col, 'right');
        }
    }
};

//--- 绘制：叠一层联机状态 --------------------------------------------------
// 这个包装必须是最外层的 refresh —— 678.js 自己已经包了两层
// （非对局画面补充绘制 + 教程），所以 678net.js 必须最后加载。

// LY / COL 是 678.js 那个 IIFE 里的 var，外面拿不到。
// LY 有导出（D678.LY），COL 没有 —— 所以颜色用本文件的 LC，
// 它的 gray/gold/red 取值和 COL 一致，外观不变。
var NLY = D678.LY;

var _rf = Scene_D678.prototype.refresh;
Scene_D678.prototype.refresh = function () {
    if (!this._net) { _rf.call(this); return; }

    // 首帧盘面到达前 D678.Game 还是 null，drawHpBar 会炸，所以先自己画
    if (!D678.Game) {
        var bmp0 = this._uiBmp;
        bmp0.clear();
        this._hits = [];
        this.txt(bmp0, this._notice || '连接中…', 0, 600, NLY.SW, 28, LC.gray, 'center');
        return;
    }

    _rf.call(this);
    this.netDrawOverlay();
};

Scene_D678.prototype.netDrawOverlay = function () {
    var bmp = this._uiBmp;

    // 回合倒计时已经在 drawHpBar 里画到第二行右侧（原来放名字的位置），
    // 这里不再重复画。

    // 弃牌倒计时：画在覆盖层上（弃牌界面用的是 _ovBmp，画 _uiBmp 会被盖住）
    //
    // y=280 不是随便挑的：678.js 的 drawDiscard 在 y=240 画「需要弃掉 N 张」，
    // 22 号字经 drawText 后实占 240–272（高度是 size + 10），卡片区从 320 起。
    // 原来这行画在 252，和上面那行重叠 20 像素，两行几乎叠在一起。
    // 280 起画占 280–312，离卡片还有 8 像素余量。
    if (this._discardFor) {
        var ds = this.netDiscardSec();
        if (ds >= 0) {
            this.txt(this._ovBmp, '剩 ' + ds + ' 秒，超时自动弃',
                0, 280, NLY.SW, 22, ds <= 10 ? LC.red : LC.gray, 'center');
        }
    }

    // 对手掉线：报「已掉线多久」而不是倒计时 —— 对方回不回来不是这边能
    // 控制的事，倒计时只是干等。同时给一个立刻返回主菜单的按钮。
    // 摆在对方牌位左边的空档里（x=8~128）。对方牌是居中排的，2~4 张时
    // 左边缘在 x≈248~136，所以这一竖条不会压到牌；而且掉线的人不会再要牌，
    // 张数只会停在原地，不存在「牌变多了压过来」。
    //
    // 原来是屏幕中央 600×176 的大框，压住了牌桌中段，影响正常出牌 ——
    // 在线方本来就该能照常打，框不该挡路。
    if (this._netPeerGone) {
        var g = this._netPeerGone;
        var ms = (this._netPeerGoneMs || 0) + (Date.now() - (this._netPeerGoneAt || Date.now()));
        var sec = Math.floor(ms / 1000);
        var tsec = sec < 60 ? (sec + ' 秒')
                            : (Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒');

        var px = 8, py = 190, pw = 120, ph = 142;
        this.box(bmp, px, py, pw, ph, 'rgba(0,0,0,0.88)', LC.red, 8);
        // 名字不画在这儿 —— 上方 drawOppName 已经显示了，而这条只有 120 宽，
        // 长名字（可到 16 显示宽度）会直接溢出
        this.txt(bmp, '对方掉线', px, py + 8, pw, 18, LC.red, 'center');
        this.txt(bmp, '已 ' + tsec, px, py + 34, pw, 16, LC.gray, 'center');

        var bx = px + 10, by = py + 92, bw = pw - 20, bh = 40;
        this.box(bmp, bx, by, bw, bh, 'rgba(60,140,90,0.95)', LC.gold, 8);
        this.txt(bmp, '退出', bx, by + 9, bw, 20, LC.white, 'center');
        if (!this._showList && !this._discardFor) {
            this._hits.push({ x: bx, y: by, w: bw, h: bh,
                              cb: this.backToTitle.bind(this) });
        }
    }

    // 轮结果画面：只有一行状态字，点画面任意位置继续。
    // 之前既有「继续」按钮又有「点击任意位置」提示，两者位置重叠、语义冲突，
    // 所以按钮整个删掉，只留一行字说明当前在等什么。
    //
    // _netWaitAck（我点过）优先于 _netAdvancing（服务器在倒数）判断 ——
    // advancing 是 pushState 推给所有座位的，两边同时置上，_netWaitAck
    // 那个分支原来几乎轮不到显示（只在 ack 发出、advancing 状态还没回来的
    // 几十毫秒里出现）。现在点了的人看「正在开启下一局」，没点的人看
    // 「对方已确认」，两边有区分。
    if (this._phase === 'roundResult' && !this._showList && !this._discardFor) {
        var msg, col;
        if (this._netWaitAck) { msg = '正在开启下一局';   col = LC.gold; }
        else if (this._netAdvancing) { msg = '对方已确认'; col = LC.green; }
        else { msg = '点击任意位置继续';   col = LC.white; }
        // 不画背景框 —— 原来那个框（y=1070–1116）会压住 678.js:1492 那行
        // 「点击上方血条查看全体排名与统计」（y=1100）。框删掉，字留着。
        this.txt(bmp, msg, 0, 1070, NLY.SW, 24, col, 'center');
    }

    // 对方还在弃牌：整屏压暗只留一句话。画在 _ovBmp 上才能盖住卡牌层。
    // 这一屏没有任何可点的东西 —— 弃完由服务器直接开下一局，不需要确认。
    if (this._phase === 'peerDiscard') {
        var ob = this._ovBmp;
        this.box(ob, 0, 0, NLY.SW, NLY.SH, 'rgba(0,0,0,0.92)', null, 0);
        this.txt(ob, '对方丢弃功能牌中……', 0, 600, NLY.SW, 28, LC.gold, 'center');
        var ps = this.netDiscardSec();
        if (ps >= 0) {
            this.txt(ob, '剩 ' + ps + ' 秒', 0, 646, NLY.SW, 20, LC.gray, 'center');
        }
        this._hits = [];   // 这一屏不接受任何点击
    }

    // 等服务器发牌 / 房间被终止
    if (this._phase === 'netwait') {
        this.txt(bmp, '等待服务器…', 0, 600, NLY.SW, 26, LC.gray, 'center');
    }
    if (this._phase === 'netover' && this._netOver && this._netOver.aborted) {
        this.box(bmp, 60, 440, 600, 140, 'rgba(0,0,0,0.9)', LC.red, 14);
        this.txt(bmp, '本场结束', 60, 466, 600, 30, LC.red, 'center');
        this.txt(bmp, this._netOver.reason || '', 60, 508, 600, 22, LC.gray, 'center');
        this.drawBackButton();
    }

    // 断网提示
    if (!D678N.Net.connected && D678N.Net.sid) {
        this.txt(bmp, '● 连接中断，正在重连…', 24, 1156, 400, 20, LC.red, 'left');
    }
};

//=============================================================================
// 标题菜单：加「多人游戏」
//=============================================================================
//
// title.js 是整体替换 makeCommandList 的（不是包一层），所以这里包它的结果，
// 把新项插在「开始游戏」之后。createTitleButtons 按 _list 长度自动排版、
// 标题文字也跟着上移，所以不用手调任何坐标。
//
var _mcl = Window_TitleCommand.prototype.makeCommandList;
Window_TitleCommand.prototype.makeCommandList = function () {
    _mcl.call(this);
    var at = -1;
    for (var i = 0; i < this._list.length; i++) {
        if (this._list[i].symbol === 'newGame') { at = i; break; }
    }
    var item = { name: '多人游戏', symbol: 'd678net', enabled: true, ext: null };
    if (at >= 0) this._list.splice(at + 1, 0, item);
    else this._list.push(item);
};

var _ccw = Scene_Title.prototype.createCommandWindow;
Scene_Title.prototype.createCommandWindow = function () {
    _ccw.call(this);
    this._commandWindow.setHandler('d678net', this.commandD678Net.bind(this));
};

Scene_Title.prototype.commandD678Net = function () {
    SceneManager.push(Scene_D678Net);
};

// title.js 用自绘按钮走 callTitleButton 分发，得让它认识新符号
if (Scene_Title.prototype.callTitleButton) {
    var _ctb = Scene_Title.prototype.callTitleButton;
    Scene_Title.prototype.callTitleButton = function (symbol) {
        if (symbol === 'd678net') {
            var w = this._commandWindow;
            if (!w || !w.active) return;
            SoundManager.playOk();
            w.deactivate();
            this.commandD678Net();
            return;
        }
        _ctb.call(this, symbol);
    };
}

//=============================================================================
// 链接直接进房：?room=XXXX
//=============================================================================

(function readRoomFromUrl() {
    try {
        var m = /[?&]room=([A-Za-z0-9]{4})\b/.exec(location.search || '');
        if (m) D678N.autoRoom = m[1].toUpperCase();
    } catch (e) {}
})();

//=============================================================================
// 刷新后自动回到刚刚的对局
//=============================================================================
//
// 会话存在 sessionStorage 里，刷新不丢（只有关标签页才清）。服务器那边
// 掉线后座位保留 graceSec（默认 300 秒），/api/events 还会主动顶掉旧连接 ——
// 整套重连逻辑本来就有，缺的只是刷新后没人去把 sid 捡回来。
//
// 不能从标题直接 push Scene_D678：它认不认联机全看 D678N.mode，而那个是
// 大厅收到第一份盘面时才设的，跳过就会当单机局跑空的 D678.Game 然后炸。
// 所以借道大厅，让它照原路走完（探测 → 连 SSE → 等盘面 → 设 mode → push）。
var _stStart = Scene_Title.prototype.start;
Scene_Title.prototype.start = function () {
    _stStart.call(this);
    if (D678N._autoDone) return;

    // 带房号进来的话直接跳到大厅，省掉玩家自己点「多人游戏」
    if (D678N.autoRoom) {
        D678N._autoDone = true;
        SceneManager.push(Scene_D678Net);
        return;
    }

    // 刷新后捡回会话。链接带房号的优先 —— 那是玩家刚点了新链接，
    // 意图明确，不该被旧会话截走。
    var sess = D678N.session();
    if (sess && sess.sid) {
        D678N._autoDone = true;
        D678N.resumeSid = sess.sid;
        SceneManager.push(Scene_D678Net);
    }
};

})();
