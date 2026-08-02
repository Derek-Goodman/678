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
// 本日计数（标题画面上方三行）
//=============================================================================
// 全服累计，所有人看到同一个数（你定的）。
//
//   游玩次数 = 进入对局。单机在这里报；多人由服务器在开赛时自己加
//              （startTourney / startDuel），这边不能再报，会重复。
//   完局次数 = 单机打到结算画面（拿第几名都算）
//   冠军次数 = 单机最后幸存者。冠军同时也计入完局。
//
// 连不上服务器（单机 exe / 服务器没起）就整块不画 —— 留三个「0」或者
// 「--」在标题上比不显示更难看，而且会让人以为功能坏了。
D678N.daily = null;      // 最近一次拿到的计数。null = 还没问到 / 问不到

D678N.dailyFetch = function (cb) {
    D678N.Net.post('/api/daily', {}, function (r) {
        if (r && r.ok) D678N.daily = r;
        if (cb) cb(D678N.daily);
    });
};

// 上报一次。服务器返回的新值顺手存下来，标题回去就是最新的。
D678N.dailyBump = function (kind) {
    D678N.Net.post('/api/daily', { bump: kind }, function (r) {
        if (r && r.ok) D678N.daily = r;
    });
};

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
    over:   null,    // 决斗结束 / 锦标赛结束
    abort:  null,    // 房间被终止
    peer:   null,    // 对手掉线 / 回来
    elim:   null,    // 锦标赛：我被淘汰了（带名次）
    netdown: false,  // 连接断了
};

D678N.clearInbox = function () {
    var b = D678N.inbox;
    b.room = null; b.state = null; b.events = [];
    b.over = null; b.abort = null; b.peer = null; b.elim = null;
    b.netdown = false;
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
    case 'eliminated': b.elim = data; break;
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
        // 排名列表的「胜/负」一栏靠这两个：lastText 先看 last，没有才退回
        // prevLast 并标「上轮」。少了它们那一栏在联机下永远是「—」。
        // last 服务器只发我这桌的两个人（别人桌本轮的结果不该提前知道），
        // prevLast 是上一轮的、全场都打完了，8 个人的都发。
        p.last     = info.last || null;
        p.prevLast = info.prevLast || null;
        // 锦标赛的 8 人里可能有超哥；1v1 不发这个字段，两边都是真人
        p.isGod = !!info.isGod;
        // 真人的连线状态（''/'gone'/'left'）。AI 一律空串，所以排名表里
        // 看不出谁是 AI —— 那是服务器那边故意的。
        p.netStatus = info.status || '';
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

// 连线状态的中文标注。空串表示不标注 —— AI 和正常在线的人都走这一支，
// 所以排名表里看不出谁是 AI。
D678N.statusText = function (st) {
    if (st === 'left') return '离开';
    if (st === 'gone') return '掉线';
    return '';
};

// 锦标赛：我被淘汰后暂存的名次（跨场景，Scene_D678 pop 回大厅要用）
D678N.elim = null;
// 赛事最终排名，大厅收到 over 时存这里
D678N.finalOver = null;

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
    // 锦标赛里被淘汰、从牌桌 pop 回来的。SSE 不断（Net 没 reset），
    // 所以赛事结束时那份 over 还会推过来，pollNet 收到就切到排名页。
    if (D678N.elim) {
        this._page = 'elim';
        this.refresh();
        return;
    }
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

    if (this._page === 'menu' || this._page === 'duel' ||
        this._page === 'tourney') this.drawOnline();

    if (this._page === 'menu')    this.drawMenu();
    if (this._page === 'duel')    this.drawDuel();
    if (this._page === 'tourney') this.drawTourney();
    if (this._page === 'waiting') this.drawWaiting();
    if (this._page === 'elim')    this.drawElim();
    if (this._page === 'ranks')   this.drawFinalRanks();

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
        { label: '锦标赛', cb: this.onTourney.bind(this) },
        { label: '单人对决', cb: this.onDuel.bind(this) },
    ], 380);
};

Scene_D678Net.prototype.drawTourney = function () {
    this.txt('锦标赛', 0, 336, Graphics.width, 30, LC.gold, 'center');
    this.buttons([
        { label: '匹配模式', cb: this.onMatch.bind(this) },
        // 「暂未开启」并进标题：它是 dim 按钮，点了没反应，
        // 不说一句玩家会以为是坏的
        { label: '天梯模式（暂未开启）', dim: true, cb: function () {} },
    ], 400);
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

    if (info.mode === 'tourney') { this.drawTourneyLobby(info); return; }

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

// 锦标赛大厅。8 席分两列画 —— 单列 8 行会撞到底部的返回按钮。
//
// 没有「开始」按钮：全员就绪且 ≥2 人时服务器自己开赛（你定的）。谁没点准备
// 在这张表里一眼看得见，所以不需要手动兜底。
Scene_D678Net.prototype.drawTourneyLobby = function (info) {
    var W = Graphics.width;
    var seats = info.seats || [];
    var taken = info.takenN || 0;
    var readyN = 0;
    for (var k = 0; k < seats.length; k++) if (seats[k] && seats[k].ready) readyN++;

    this.txt('锦标赛 · 匹配模式', 0, 300, W, 30, LC.gold, 'center');
    this.txt('房间 ' + (info.room || '') + '　　已就绪 ' + readyN + '/' + taken,
        0, 336, W, 20, LC.gray, 'center');

    // 准备按钮。一个人也能点 —— 他确实准备好了，只是还差人，
    // 下面那行提示会说明为什么没开赛
    this.buttons([{
        label: info.myReady ? '取消准备' : '准备',
        cb: this.onReady.bind(this),
    }], 366);

    this.txt('选手（' + taken + '/' + (info.seatN || 8) + '）',
        0, 462, W, 20, LC.gray, 'center');

    // 两列 × 4 行。i 是真实座位号（自己那行要标 ▶），空位不画。
    var col = [90, 380], colW = 250, y0 = 492, rowH = 34, per = 4;
    var shown = 0;
    for (var i = 0; i < seats.length; i++) {
        var s = seats[i];
        if (!s) continue;
        var cx = col[Math.floor(shown / per)], cy = y0 + (shown % per) * rowH;
        shown++;
        var st, cl;
        if (!s.connected)   { st = '掉线';   cl = LC.red; }
        else if (s.ready)   { st = '就绪';   cl = LC.green; }
        else                { st = '未就绪'; cl = LC.gray; }
        var mark = (i === info.mySeat) ? '▶ ' : '　';
        this.txt(mark + s.name, cx, cy, colW - 70, 20, LC.text, 'left');
        this.txt(st, cx + colW - 70, cy, 70, 20, cl, 'right');
    }

    // 这里原来有一行「其余 N 席开赛时由 AI 补齐（含超哥）」，已删（你定的）。
    // 补位本身照旧，只是不在界面上说 —— 排名表里也看不出谁是 AI
    // （statusText 对 AI 返回空串），两处口径这样才一致。

    // 为什么还没开赛，一句话说清 —— 少了这句，一个人点了准备什么也没发生，
    // 看起来像按钮坏了
    var hint, hcol;
    if (info.needMore) {
        hint = '至少需要 2 名玩家才能开赛，等人来…'; hcol = LC.gray;
    } else if (!info.myReady) {
        hint = '点「准备」，全员就绪立刻开赛'; hcol = LC.gold;
    } else {
        hint = '等其他选手准备…'; hcol = LC.gray;
    }
    this.txt(hint, 0, 664, W, 22, hcol, 'center');
};

// 被淘汰后的等待页。赛事还在跑，等最终排名推过来。
//
// 为什么不直接回主菜单：朋友局里「最后谁赢了」是必问的一句。连接留着，
// 赛事结束时服务器会把 over 推给所有座位（含已淘汰的），这边收到就弹排名。
Scene_D678Net.prototype.drawElim = function () {
    var W = Graphics.width, e = D678N.elim || {};
    this.panel(60, 320, W - 120, 260);
    this.txt('你被淘汰了', 60, 356, W - 120, 34, LC.red, 'center');
    if (e.rank) {
        this.txt('第 ' + e.rank + ' 名' + (e.total ? ' / 共 ' + e.total + ' 人' : ''),
            60, 404, W - 120, 28, LC.gold, 'center');
    }
    this.txt('赛事仍在进行，最终排名出来会显示在这里',
        60, 456, W - 120, 20, LC.gray, 'center');
    this.txt('不想等就点下面的返回', 60, 492, W - 120, 18, LC.gray, 'center');
};

// 赛事最终排名。行高 62 × 8 行放不进大厅这块地方，所以压成一行一条，
// 只保留名次 / 名字 / HP / 状态 —— 详细战绩牌桌上的排名表已经有了。
Scene_D678Net.prototype.drawFinalRanks = function () {
    var W = Graphics.width, o = D678N.finalOver || {};
    var list = o.ranks || [];
    var myRank = o.myRank || 0;

    this.txt(o.win ? '你是本届冠军！' : '赛事结束', 0, 300, W, 32,
        o.win ? LC.gold : LC.text, 'center');
    if (list[0]) {
        this.txt('冠军：' + list[0].name + (myRank ? '　　你：第 ' + myRank + ' 名' : ''),
            0, 340, W, 20, LC.gray, 'center');
    }

    this.panel(50, 372, W - 100, 12 + list.length * 34);
    for (var i = 0; i < list.length; i++) {
        var p = list[i], y = 382 + i * 34;
        var mine = (i + 1 === myRank);
        var col = mine ? LC.gold : (p.alive ? LC.text : '#8a9a92');
        this.txt(String(i + 1), 72, y, 40, 20, mine ? LC.gold : LC.gray, 'left');
        this.txt(p.name, 112, y, 220, 20, col, 'left');
        this.txt('HP ' + Math.max(0, p.hp), 340, y, 90, 20,
            p.hp > 30 ? col : LC.red, 'left');
        // 掉线 / 离开标在最右边（你定的）。AI 和正常在线的人这里是空的。
        var st = D678N.statusText(p.status);
        if (st) this.txt(st, W - 180, y, 110, 20, LC.red, 'right');
    }
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

    // 赛事结束（我已被淘汰，在大厅等最终排名）
    if (b.over) {
        D678N.finalOver = b.over;
        b.over = null;
        this._page = 'ranks';
        this.refresh();
        return;
    }

    if (b.room) {
        var r = b.room;
        b.room = null;
        this._roomInfo = r;
        D678N.Net.room = r.room;
        D678N.Net.mySeat = r.mySeat;
        // 淘汰后停在名次页 / 排名页，别被房间消息拽回等待页 —— pushRoom 是
        // 发给所有座位的（包括已淘汰的），别人一掉线就会推一份，
        // 不加这个判断淘汰画面会被冲掉
        if (this._page !== 'waiting' &&
            this._page !== 'elim' && this._page !== 'ranks') {
            this._page = 'waiting';
        }
        // lobby 阶段恢复：没有盘面会来，收掉「正在恢复」显示正常的等待页。
        // 其余阶段继续挂着，等下面那份 resync 盘面把我们推进对局场景。
        if (this._resuming && r.phase === 'lobby') this._resuming = false;
        this.refresh();
    }

    // 第一份盘面到了就进对局场景（盘面留在 inbox 里，由那边取用）。
    // 淘汰后不再进 —— 服务器本来就不给已淘汰的座位推盘面（pushStateT 跳过
    // left 的人），这里是第二道锁。
    if (b.state && !this._leaving &&
        this._page !== 'elim' && this._page !== 'ranks') {
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

Scene_D678Net.prototype.onTourney = function () {
    this._page = 'tourney';
    this.refresh();
};

// 匹配：服务器找一个未满未开始的锦标赛房，没有就建。不要房号 —— 朋友局
// 直接进同一个空房就行（你定的）。
Scene_D678Net.prototype.onMatch = function () {
    var name = D678N.savedName() || this.askName();
    if (!name) return;
    var self = this;
    this._busy = true;
    D678N.Net.post('/api/match', { name: name }, function (r, code) {
        self._busy = false;
        if (!r || code !== 200) {
            self.notice((r && r.err) || '匹配失败，服务器没响应');
            self.refresh();
            return;
        }
        D678N.setSession({ sid: r.sid, room: r.room });
        D678N.Net.mySeat = r.mySeat;
        D678N.Net.connect(r.sid);
        self._page = 'waiting';
        self.refresh();
    });
};

// 准备 / 取消准备。全员就绪且 ≥2 人时服务器立刻开赛，这边不用判 ——
// 开赛的信号是第一份盘面到达（pollNet 里那条 b.state）。
Scene_D678Net.prototype.onReady = function () {
    if (!D678N.Net.sid) return;
    var self = this;
    this._busy = true;
    D678N.Net.post('/api/ready', { sid: D678N.Net.sid }, function (r, code) {
        self._busy = false;
        if (!r || code !== 200) {
            self.notice((r && r.err) || '操作失败');
            self.refresh();
            return;
        }
        // 界面不在这里改 —— 服务器会推一份新的 room 消息，
        // 以那份为准，免得本地状态和服务器打架
        self.refresh();
    });
};

Scene_D678Net.prototype.onBack = function () {
    // 淘汰等待页 / 最终排名页：赛事跟我已经没关系了，直接清会话回子页。
    // 不发 /api/leave —— 服务器那边我早就是 left 了，再发一次没有意义。
    if (this._page === 'elim' || this._page === 'ranks') {
        D678N.elim = null;
        D678N.finalOver = null;
        D678N.Net.reset();
        this._page = 'tourney';
        this._roomInfo = null;
        this.refresh();
        return;
    }
    if (this._page === 'waiting') {
        // 已经建/进了房，退出要通知服务器（1v1 关房间，锦标赛只摘席位）
        if (D678N.Net.sid) D678N.Net.post('/api/leave', { sid: D678N.Net.sid }, null);
        var wasTourney = !!(this._roomInfo && this._roomInfo.mode === 'tourney');
        D678N.Net.reset();
        // 锦标赛退回子页而不是主菜单 —— 想再匹配一次少点一下
        this._page = wasTourney ? 'tourney' : 'menu';
        this._roomInfo = null;
        this.refresh();
        return;
    }
    if (this._page === 'duel' || this._page === 'tourney') {
        this._page = 'menu'; this.refresh(); return;
    }
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
    // 本日游玩次数：单机进牌桌算一次。
    //
    // 埋在这儿而不是标题按钮上 —— 点了「开始游戏」还要过地图事件才真的开局，
    // 中途退出不该算。多人模式不在这里报：服务器开赛时自己加了，
    // 这边再报一次就翻倍。
    if (!this._net) D678N.dailyBump('play');
    if (!this._net) return;
    this._netWaitAck  = false;   // 已点继续，等对手
    this._netAutoDiscarded = null;  // 上次结算被随机弃掉的功能牌（提示用）
    this._netPeerGone = null;    // 对手掉线信息
    this._netDeadline = 0;       // 本回合截止时间戳
    this._netOver     = null;
    this._netPre      = null;    // 揭牌演出期间显示的发牌前手牌
    this._netApplied  = 0;
    this._netPlayedResolve = 0;  // 已播过演出的结算编号（同一次不重播）
    this._netPreApplied = 0;     // 已套用过发牌前快照的结算编号（同一次不重套）
    this._netTurnLeft = 0;       // 回合剩余毫秒（收到时的快照）
    this._netTurnAt   = 0;
    this._netAckCool  = 0;       // 点「继续」后的冷却帧，防误触
    this._netAckSentAt = 0;      // 上次发 ack 的时刻（等太久时提示可重发）
    this._netPeerGoneMs = 0;     // 对手已掉线多久
    this._netPeerGoneAt = 0;
    this._netAdvancing = false;  // 服务器已在倒数「开下一局」
    this._netWaitRound = false;  // 锦标赛：我这桌完了，还在等别人打完本轮
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
    var tourney = (m.mode === 'tourney');
    var v = m.b;

    // 【两种模式的盘面形状不一样】1v1 的 maskView 把 players 嵌在 m.b 里；
    // 锦标赛的 pushStateT 把牌面和玩家列表发成两个平级字段（m.b / m.players），
    // 因为那份 players 是全场 8 人（排名列表要），不属于某一桌。
    var plist = tourney ? m.players : (v && v.players);
    if (!plist) return;   // 不该发生，但别让一份坏消息把场景搞崩

    // 副本：players[0] 永远是本地玩家（服务器已镜像）
    var g = D678N.buildReplica(plist, m.round, this._netStartHp);
    D678.Game = g;

    // 锦标赛：轮空、或者我这桌打完了而本轮还没结束 —— 服务器不发牌面
    // （m.b 为 null）。这时候没有 battle 可建，停在轮次等待屏。
    if (tourney && !v) {
        this._battle = null;
        this._netBye = !!m.bye;
        this._netBusyTables = m.busyTables || 0;
        this._phase = 'netwaitround';
        this.refresh();
        return;
    }
    this._netBye = false;
    this._netBusyTables = m.busyTables || 0;
    // 服务器算好的「我这桌完了，本轮还没结束」。它一直发，之前客户端没读，
    // 于是打完的人卡在轮结果画面等一个永远不来的下一局。
    if (m.waitingRound !== undefined) this._netWaitRound = !!m.waitingRound;

    var first = !this._battle;
    this._battle = D678N.buildBattle(v, g);

    // 多人模式功能牌超过 MAX_FUNC 是服务器随机弃的（不再手动挑）。
    // 存下来等演出走完再报 —— 这会儿手牌还显示着发牌前那份，
    // 立刻弹「已弃掉 XX」的话玩家看着 6 张牌被告知弃了 2 张，对不上。
    if (m.autoDiscarded !== undefined) this._netAutoDiscarded = m.autoDiscarded;

    // 倒计时按「还剩多少毫秒」+ 收到的时刻算，不用服务器的绝对时间戳 ——
    // 两台设备的钟差几分钟很常见，用时间戳会算出离谱的秒数
    if (m.turnLeft !== undefined) {
        this._netTurnLeft = m.turnLeft;
        this._netTurnAt = Date.now();
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
    // 服务器已经在倒数「2 秒后开下一局」
    if (m.advancing) this._netAdvancing = true;

    // 揭牌演出期间先显示发牌前的手牌，等 finishBattle 再切到发牌后的。
    //
    // 只在「这次结算的第一份状态」上做这个替换 —— 服务器每次推 resolved 都带
    // preFuncs（锦标赛里别人桌一动就重推一份），每次都替换的话演出走完之后
    // 手牌又会被打回发牌前那 6 张，玩家看不到刚摸的牌。
    var rid0 = m.resolveId || 0;
    if (v.preFuncs && rid0 !== this._netPreApplied) {
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
        this._netFinished = false;
        this._netWaitRound = false;
        this._netAutoDiscarded = null;
        this._report = null;
        this._lastLog = null;
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

    // 【别再无条件写 _phase = 'battle'】锦标赛里别人桌每动一下，pushStateT 都会
    // 给我推一份状态（8 个人共用一条广播）。这些状态既没有 fresh 也没有 resolved，
    // 会一路落到下面 —— 原来那两行把我的 _phase 从 resolve / discard / roundResult
    // 打回 battle，于是：揭牌演出半路被打断，netFinish 再也不会被调用，
    // 功能牌满了也开不出弃牌界面。1v1 只有对手一个人推状态，撞不上这条路。
    //
    // 已经落定的阶段一律不动，只有真在牌桌上（battle）或还没开局（netwait）
    // 才跟着服务器走。
    if (this.netPhaseSettled()) {
        // 唯一允许的越级：我已经收尾完（轮结果 / 等对方弃牌），服务器说本轮
        // 还没结束 —— 切到轮次等待屏。放在守卫里面是因为守卫会提前 return，
        // 而这个转换恰恰要靠「后来的那几份状态」触发（我弃完牌那一刻，
        // 别人可能还在打）。
        this.netToWaitRoundIfNeeded();
        this.refresh();
        return;
    }

    if (first || m.resync) {
        // 重连回来正好赶上「我这桌完了、别人还在打」：直接落到等待屏，
        // 别把人塞回一个已经结束的牌桌
        this._phase = this._netWaitRound ? 'netwaitround' : 'battle';
        this._wait = 0;
        this.refresh();
        return;
    }

    this._phase = 'battle';
    this.refresh();
};

// 「这个阶段已经落定，别被别人桌的状态推翻」。
// 锦标赛里 8 个人共用一条广播，别人桌每动一下我都会收到一份状态 ——
// 不挡的话我的 resolve / roundResult 会被打回 battle，揭牌演出半路断掉。
Scene_D678.prototype.netPhaseSettled = function () {
    var ph = this._phase;
    return ph === 'roundResult' || ph === 'resolve' || ph === 'tie' ||
           ph === 'netwaitround' || ph === 'netover' || ph === 'gameover';
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

    if (this._showList) return;
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

    // over 必须在 elim 之前判：服务器在同一个 tick 里先发 eliminated
    // 再发 over（最后一轮把人淘汰完就宣布结束），两条会在同一帧到达。
    // 先处理 elim 的话会把人踢回大厅，然后大厅再弹一次排名 —— 明明还在
    // 牌桌上却被弹回去，很突然。over 自带 myRank，信息一条都不少。
    if (b.over) {
        this._netOver = b.over;
        var tourney = (b.over.mode === 'tourney');
        b.over = null;
        b.elim = null;              // 同一帧的淘汰通知并进这次结算
        // 沿用单机的淘汰 / 通关画面
        this._phase = 'gameover';
        this._battle = null;
        if (tourney) {
            this._notice = this._netOver.win
                ? '你是本届冠军！'
                : '你获得第 ' + (this._netOver.myRank || 0) + ' 名';
            this._report = this.netTourneyReport();
        } else {
            this._notice = this._netOver.win
                ? '你赢下了这场决斗！'
                : '你被淘汰了……';
            this._report = this.netFinalReport();
        }
        this.refresh();
        return;
    }

    // 锦标赛：我被淘汰但赛事还在继续 —— 退回大厅等最终排名。
    // 连接不断（Net 不 reset），赛事结束时那份 over 会推到大厅去。
    if (b.elim) {
        D678N.elim = { rank: b.elim.rank || 0, total: b.elim.total || 0 };
        b.elim = null;
        SceneManager.pop();
    }
};

// 剩余秒数：拿收到时的剩余毫秒减去本地流逝的时间，全程只用本地时钟，
// 所以两台设备钟不同步也不影响
Scene_D678.prototype.netTurnSec = function () {
    if (!this._netTurnLeft || !this._netTurnAt) return -1;
    return Math.max(0, Math.ceil((this._netTurnLeft - (Date.now() - this._netTurnAt)) / 1000));
};
// 每秒重画一次就够，不必每帧
Scene_D678.prototype.netTickClock = function () {
    var show = -1;
    if (this._phase === 'battle') show = this.netTurnSec();
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

// 锦标赛的结算文字。1v1 那份读 o.stats（只有两个人），锦标赛发的是
// o.ranks（全场 8 人的名次表），字段不一样所以分开写。
Scene_D678.prototype.netTourneyReport = function () {
    var o = this._netOver;
    if (!o || !o.ranks || !o.ranks.length) return null;
    var champ = o.ranks[0];
    var me = o.ranks[(o.myRank || 1) - 1] || o.ranks[0];
    var rate = function (a, b) {
        var g = a + b;
        return g > 0 ? Math.round(a / g * 100) + '%' : '—';
    };
    return [
        '冠军：' + (champ ? champ.name : '?'),
        '我的名次：第 ' + (o.myRank || 0) + ' 名 / 共 ' + o.ranks.length + ' 人',
        '最终 HP：' + Math.max(0, me.hp) + '　对局 ' + (me.games || 0) + ' 场',
        '胜 ' + me.wins + '　负 ' + me.losses + '　胜率 ' + rate(me.wins, me.losses),
        '满点 ' + me.maxPoint + ' 次　共使用功能牌 ' + (me.funcUses || 0) + ' 次',
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

    // 【多人模式没有手动弃牌】超过 MAX_FUNC 由服务器随机弃掉多余的（你定的），
    // 所以这里不再开弃牌界面，只把弃掉了哪几张报出来 —— 不报的话玩家看到的
    // 就是「刚摸了 2 张，手上还是 6 张」，以为奖励没发。
    // 放在 netUsePre(false) 之后是必须的：那一步刚把手牌切成发牌后的真实状态。
    this.netNoticeAutoDiscard();
    this.netToRoundResult();
    // 锦标赛：我这桌打完了但本轮没结束 —— 停在「第 N 轮」等待屏，
    // 等所有人打完（你定的）。先走完 netToRoundResult 是故意的：
    // 它把 _lastLog / _battleKeep / _report 都备好了，点开排名和对战日志才有东西看。
    this.netToWaitRoundIfNeeded();
};

// 报「超过 6 张，已随机弃掉 XX、YY」。只报一次，报完清掉。
Scene_D678.prototype.netNoticeAutoDiscard = function () {
    var ids = this._netAutoDiscarded;
    this._netAutoDiscarded = null;
    if (!ids || !ids.length) return;
    var names = [];
    for (var i = 0; i < ids.length; i++) names.push(D678.funcName(ids[i]));
    this.pushMsg('功能牌超过 ' + D678.MAX_FUNC + ' 张，已随机弃掉：' + names.join('、'));
};

// 切轮次等待屏。只从「自己这场已经收尾」的阶段切。
Scene_D678.prototype.netToWaitRoundIfNeeded = function () {
    if (!this._netWaitRound) return;
    if (this._phase !== 'roundResult') return;
    this._netBye = false;
    // netDrawWaitRound 走的是「自己清屏自己画」那条路（refresh 里提前 return），
    // 不会调 refreshCards —— 所以牌精灵得在这儿先收掉。
    // 从 roundResult 过来时 _battle 已经是 null（netToRoundResult 清过）。
    if (this._battle) { this._battleKeep = this._battle; this._battle = null; }
    this.refreshCards();
    this._phase = 'netwaitround';
    this._notice = '';
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

// 这里原来包了 onDiscardConfirm（把手动挑好的牌 POST 给 /api/discard）。
// 多人模式改成服务器随机弃之后，联机根本走不到弃牌界面，那个包装和
// /api/discard 一起删了。单机的 onDiscardConfirm 原样保留，没被碰过。

//--- 本日完局 / 冠军次数（只统计单机，你定的）------------------------------
//
// checkGameEnd 恰好只有两个出口：被淘汰（不 alive）和最后幸存者（alive）。
// 两者都算「完局」，后者额外算「冠军」—— 和你说的「冠军同时也会在完局
// 次数那里增加」一致。
//
// 联机不报：锦标赛和单人对决打完不计入完局（你定的）。
var _cge = Scene_D678.prototype.checkGameEnd;
Scene_D678.prototype.checkGameEnd = function () {
    var ended = _cge.call(this);
    if (!ended || this._net || this._dailyReported) return ended;
    // checkGameEnd 一局里可能被调到两次（beginRound 和结算各一次），
    // 而它是幂等的 —— 计数可不是，所以自己上一道锁
    this._dailyReported = true;
    var champ = !!(D678.Game && D678.Game.human().alive);
    D678N.dailyBump('finish');
    if (champ) D678N.dailyBump('champ');
    return ended;
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

//--- 绘制：掉线 / 离开的标注 ------------------------------------------------
//
// 两处都用「改一下再调原函数」的写法，不动 678.js 本体。

// 对手名字后缀（掉线）/（离开）（你定的）。1v1 不发 status，所以那边不受影响
// —— 1v1 本来就有「对方已掉线 X 秒」那行提示。
var _oppName = Scene_D678.prototype.drawOppName;
Scene_D678.prototype.drawOppName = function (opp) {
    var st = this._net ? D678N.statusText(opp.netStatus) : '';
    if (!st) { _oppName.call(this, opp); return; }
    var real = opp.name;
    opp.name = real + '（' + st + '）';
    _oppName.call(this, opp);
    opp.name = real;
};

// 排名表：状态标在每行最右边（你定的）。原函数把名次 / HP / 战绩画到
// x≈600 为止，600~690 是空的。
var _rankList = Scene_D678.prototype.drawRankList;
Scene_D678.prototype.drawRankList = function () {
    _rankList.call(this);
    if (!this._net || !D678.Game) return;
    var bmp = this._ovBmp;
    var list = D678.Game.rankedPlayers();
    for (var i = 0; i < list.length; i++) {
        var st = D678N.statusText(list[i].netStatus);
        // 行距和原函数一致（140 + i*68，名字画在 y+6）
        if (st) this.txt(bmp, st, 600, 140 + i * 68 + 6, 88, 22, LC.red, 'right');
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

    // 锦标赛：本轮轮空、或者我这桌打完了在等最慢那一桌。678.js 的 refresh
    // 按 _phase 分发，认不得这个阶段，所以自己画。
    //
    // 轮空时服务器压根不发牌面；我这桌打完那种情况牌面照发（pushStateT 故意
    // 不过滤 done 的桌，弃牌界面和揭牌演出都要靠它），是 netToWaitRoundIfNeeded
    // 把 _battle 收掉后切进来的。
    if (this._phase === 'netwaitround') { this.netDrawWaitRound(); return; }

    _rf.call(this);
    this.netDrawOverlay();
};

// 轮次等待屏。轮次屏障是设计决定（每轮所有人都打过一场），代价就是打完的人
// 要等最慢那一桌 —— 所以这里必须说清在等什么，不然像卡住了。
Scene_D678.prototype.netDrawWaitRound = function () {
    var bmp = this._uiBmp, W = NLY.SW;
    bmp.clear();
    if (this._ovBmp) this._ovBmp.clear();
    this._hits = [];

    if (this._showList) { this.drawRankList(); return; }

    var g = D678.Game;
    this.txt(bmp, '第 ' + (g ? g.round : 1) + ' 轮', 0, 200, W, 34, LC.gold, 'center');
    this.txt(bmp, this._netBye ? '本轮轮空' : '你这桌打完了',
        0, 260, W, 30, LC.text, 'center');

    // 自己这一轮的胜负。切到这屏是跳过了轮结果画面的，不写这一行等于把
    // 「我刚才赢没赢」吞掉了 —— 演出看完就只剩一句「你这桌打完了」。
    // last 由 netSetLast 从结算结果反填；平局不设 last（和单机一致）。
    var me = g ? g.human() : null;
    if (!this._netBye && me && me.last) {
        var won = (me.last.type === 'win');
        this.txt(bmp, won ? '你赢了这一场' : '你输了这一场，-' + me.last.dmg + ' HP',
            0, 296, W, 22, won ? LC.green : LC.red, 'center');
    }

    var n = this._netBusyTables || 0;
    this.txt(bmp, n > 0
        ? '其他玩家还在对局，还有 ' + n + ' 桌在打'
        : '正在开下一轮…', 0, 336, W, 22, LC.gray, 'center');
    if (g) {
        this.txt(bmp, '场上还有 ' + g.alivePlayers().length + ' 人',
            0, 372, W, 20, LC.gray, 'center');
    }

    this.txt(bmp, '点击任意处查看全场排名', 0, 440, W, 20, LC.gray, 'center');
    this._hits.push({ x: 0, y: 0, w: W, h: NLY.SH,
        cb: this.onToggleList.bind(this) });
};

Scene_D678.prototype.netDrawOverlay = function () {
    var bmp = this._uiBmp;

    // 回合倒计时已经在 drawHpBar 里画到第二行右侧（原来放名字的位置），
    // 这里不再重复画。

    // 这里原来画弃牌倒计时（「剩 N 秒，超时自动弃」）。多人模式超过
    // MAX_FUNC 现在是当场随机弃，没有挑牌这一步，也就没有倒计时可画。

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
        if (!this._showList) {
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
    if (this._phase === 'roundResult' && !this._showList) {
        var msg, col;
        if (this._netWaitAck) { msg = '正在开启下一局';   col = LC.gold; }
        else if (this._netAdvancing) { msg = '对方已确认'; col = LC.green; }
        else { msg = '点击任意位置继续';   col = LC.white; }
        // 不画背景框 —— 原来那个框（y=1070–1116）会压住 678.js:1492 那行
        // 「点击上方血条查看全体排名与统计」（y=1100）。框删掉，字留着。
        this.txt(bmp, msg, 0, 1070, NLY.SW, 24, col, 'center');
    }

    // 这里原来是「对方丢弃功能牌中……」那一屏。多人模式超过 MAX_FUNC 当场
    // 随机弃，没人需要等别人挑牌，peerDiscard 这个阶段整个不存在了。

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

//=============================================================================
// 标题画面上方的本日计数
//=============================================================================
// 三行字：本日游玩次数 / 本日完局次数 / 本日冠军次数（全服累计，你定的）。
//
// 【为什么放在 678net.js 而不是 title.js】取数要联网，而 title.js 先加载、
// 那会儿还没有 D678N.Net。这个文件本来就已经包了 Scene_Title 的
// createCommandWindow / callTitleButton / start，顺路挂上最省事。
//
// 【为什么单独一个精灵】title.js 的 _btnBmp 有 _btnCache 这道「没变化就不重画」
// 的优化，往里画会被它的缓存判断吃掉（按钮状态没变就整块不刷）。
// 单独一层还能保证不挡按钮的点击区。
var DAILY_Y = 26;          // 顶部留白里，封面图上方那条空带
var DAILY_LH = 30;         // 行高

var _stCreate = Scene_Title.prototype.create;
Scene_Title.prototype.create = function () {
    _stCreate.call(this);
    this._dailyBmp = new Bitmap(Graphics.width, DAILY_Y + DAILY_LH * 3 + 10);
    this._dailySprite = new Sprite(this._dailyBmp);
    this._dailySprite.z = 101;      // 按钮层是 100，这层在它上面
    this.addChild(this._dailySprite);
    this._dailyShown = '';
    this.drawDailyCounts();

    // 每次回到标题都问一次（打完一局回来数字就是新的），
    // 之后每 10 秒刷一次 —— 比大厅那个 5 秒的心跳松一档，标题不需要那么灵敏。
    D678N.dailyFetch();
    this._dailyTick = 0;
};

var _stUpdate2 = Scene_Title.prototype.update;
Scene_Title.prototype.update = function () {
    _stUpdate2.call(this);
    if (this._dailyTick === undefined) return;
    if (++this._dailyTick >= 600) {      // 约 10 秒（60fps）
        this._dailyTick = 0;
        D678N.dailyFetch();
    }
    this.drawDailyCounts();
};

Scene_Title.prototype.drawDailyCounts = function () {
    if (!this._dailyBmp) return;
    var d = D678N.daily;
    // 问不到就整块不画（单机 exe / 服务器没起）—— 留三个 0 在标题上
    // 比不显示更难看，还会让人以为功能坏了
    var key = d ? (d.plays + '/' + d.finishes + '/' + d.champs) : '';
    if (key === this._dailyShown) return;    // 没变化不重画
    this._dailyShown = key;

    var bmp = this._dailyBmp;
    bmp.clear();
    if (!d) return;

    var rows = [
        ['本日游玩次数', d.plays,    '#ffd766'],
        ['本日完局次数', d.finishes, '#ffffff'],
        ['本日冠军次数', d.champs,   '#5cff9d'],
    ];
    for (var i = 0; i < rows.length; i++) {
        var y = DAILY_Y + i * DAILY_LH;
        bmp.fontSize = 22;
        bmp.outlineColor = 'rgba(0,0,0,0.85)';
        bmp.outlineWidth = 5;
        bmp.textColor = '#b9c8c0';
        bmp.drawText(rows[i][0] + '：', 0, y, Graphics.width / 2 + 40, 26, 'right');
        bmp.textColor = rows[i][2];
        bmp.drawText(String(rows[i][1]), Graphics.width / 2 + 46, y, 200, 26, 'left');
    }
};

})();
