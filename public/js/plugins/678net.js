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

// 【整个包在 try 里】联机是可选功能，一次请求发不出去绝不能把场景搞崩。
//
// exe（NW.js）和 MV 编辑器的「游戏测试」都是 file:// 起源，相对路径
// '/api/daily' 会被解析成 file:///api/daily —— Chromium 对 file:// 的 POST
// 直接在 xhr.send() 那一行**同步抛异常**（不是走 onerror）。
// 而 Scene_D678.create 里有一次 dailyBump('play')，异常从那里冒出来的话
// 整个场景创建失败，单机就再也进不去了。浏览器连着服务器时不会发生，
// 所以这条只在 exe / 编辑器里现形，很容易漏。
D678N.Net.post = function (path, body, cb) {
    try {
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
    } catch (e) {
        // 发不出去就当没这回事：本日计数不显示，其余照常
        if (cb) cb(null, 0);
    }
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
        // 锦标赛：这个人此刻是否还在打（服务器 maskViewT 算好发下来的）。
        // 轮结果页靠它列出「还在对局的玩家」。
        p.inBattle = !!info.inBattle;
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
    // 锦标赛里被淘汰、从牌桌 pop 回来的。
    //
    // 【SSE 已经断了】收到 eliminated 那一刻客户端就 Net.reset()、服务器也
    // 主动收掉了那条连接（你定的：出局的人不该再占着长连接）。所以赛事结束
    // 那份 over **不会**再推过来 —— 淘汰页看完点返回就行，不等最终排名。
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
// 淘汰页。口径和单机失败画面一致（你定的）：名次 + 战绩，再加上
// 对每个对手的分项战绩。
//
// 【不再写「赛事仍在进行」】玩家出局了就跟这场赛事没关系了，等最终排名
// 没有意义 —— 看完战绩点返回就行（你定的）。
Scene_D678Net.prototype.drawElim = function () {
    var W = Graphics.width, e = D678N.elim || {};
    var pct = function (v) { return (v === null || v === undefined) ? '—' : v + '%'; };

    var vs = e.vs || [];
    // 面板高度跟着对手条数长：头部 236 + 每条 26，留 16 底边
    var vsH = vs.length ? (30 + vs.length * 26) : 0;
    var panelH = 236 + vsH;
    var top = 300;
    this.panel(50, top, W - 100, panelH);

    this.txt('你被淘汰了', 50, top + 22, W - 100, 32, LC.red, 'center');
    if (e.rank) {
        this.txt('第 ' + e.rank + ' 名' + (e.total ? ' / 共 ' + e.total + ' 人' : ''),
            50, top + 66, W - 100, 26, LC.gold, 'center');
    }

    // 战绩四行，和单机 buildFinalReport 一样的内容
    var y = top + 104;
    var rows = [
        '最终 HP：' + (e.hp === undefined ? '0' : e.hp) +
            '　对局 ' + (e.games || 0) + ' 场',
        '胜 ' + (e.wins || 0) + '　负 ' + (e.losses || 0) +
            '　胜率 ' + pct(e.winRate),
        '满点 ' + (e.maxPoint || 0) + ' 次　满点率 ' + pct(e.maxRate),
        '共使用功能牌 ' + (e.funcUses || 0) + ' 次',
    ];
    for (var i = 0; i < rows.length; i++) {
        this.txt(rows[i], 50, y + i * 28, W - 100, 20, LC.text, 'center');
    }

    // 对每个对手的战绩（你定的）：VS B 对局 3 场，胜率 33%
    if (vs.length) {
        var vy = y + rows.length * 28 + 8;
        this.txt('对手战绩', 50, vy, W - 100, 20, LC.gold, 'center');
        for (var k = 0; k < vs.length; k++) {
            var v = vs[k], ry = vy + 26 + k * 26;
            this.txt('VS ' + v.name, 96, ry, 220, 20, LC.text, 'left');
            this.txt('对局 ' + v.games + ' 场', 316, ry, 140, 20, LC.gray, 'left');
            // 胜率颜色：过半绿、其余灰，一眼看出打得过谁
            var col = (v.rate !== null && v.rate >= 50) ? LC.green : LC.gray;
            this.txt('胜率 ' + pct(v.rate), 456, ry, 160, 20, col, 'left');
        }
    }
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
    // 从主菜单退回标题：把 mode 清掉。
    //
    // 【为什么必须在这儿也清】mode 是「Scene_D678 认不认联机」的唯一开关
    // （create 里 `D678N.mode === 'duel'`）。它在大厅收到第一份盘面时设成
    // 'duel'，正常路径靠 Scene_D678Net.create 或 backToTitle 清掉。
    // 但 RMMV 的场景切换有过渡帧 —— 大厅设完 mode 排上 push 之后还会再跑
    // 几帧 update，这期间按返回就走到这里，pop 覆盖掉刚排上的 push，
    // 人回到标题而 mode 还是 'duel'。下一次点「开始游戏」就被当成联机局，
    // 卡在「等待服务器…」再也进不去。
    D678N.mode = null;
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
    // 【双条件】mode 只是意图，sid 才是「真的连上了」的证据（SSE 连通后才有）。
    //
    // 光看 mode 的话，任何一条漏清 mode 的退出路径都会让下一次单机局被当成
    // 联机 —— 进去就停在 'netwait' 等一份永远不来的盘面，也就是
    // 「进完多人再进单人卡在等待服务器」。加上 sid 这道，即使以后又漏清了
    // mode，单机也只会正常开局。
    this._net = (D678N.mode === 'duel' && !!D678N.Net.sid);
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
    this._netTourney = false;    // 这一场是锦标赛（底部提示语要用，见 netDrawOverlay）
    // 展示保护期：>0 时压住新状态，先把轮结果页看完（见 netApply 里的注释）
    this._netHoldFrames = 0;
    this._netPending = null;     // 保护期内收到的最新那份带牌面的状态
    // 【一次性事件标记要单独记】fresh 只在某一份状态上出现一次，而 _netPending
    // 会被后来的普通状态覆盖 —— 混在一起存就会把 fresh 丢掉，保护期结束后
    // 永远出不了轮结果页。详见 netReleaseHold。
    this._netPendFresh = false;
    this._netPendRedealt = false;
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
    // 底部提示语要靠它区分：锦标赛推进靠轮次屏障，任何「点击继续」都是假的
    this._netTourney = tourney;
    var v = m.b;

    // 【两种模式的盘面形状不一样】1v1 的 maskView 把 players 嵌在 m.b 里；
    // 锦标赛的 pushStateT 把牌面和玩家列表发成两个平级字段（m.b / m.players），
    // 因为那份 players 是全场 8 人（排名列表要），不属于某一桌。
    var plist = tourney ? m.players : (v && v.players);
    if (!plist) return;   // 不该发生，但别让一份坏消息把场景搞崩

    // 副本：players[0] 永远是本地玩家（服务器已镜像）
    var g = D678N.buildReplica(plist, m.round, this._netStartHp);
    D678.Game = g;

    this._netBusyTables = m.busyTables || 0;
    // 服务器算好的「我这桌完了，本轮还没结束」。轮结果页靠它决定
    // 提示语写「其他玩家还在对局」还是「点击任意位置继续」。
    if (m.waitingRound !== undefined) this._netWaitRound = !!m.waitingRound;

    // 锦标赛轮空：服务器不发牌面（m.b 为 null），没有 battle 可建。
    // 直接落到轮结果页 —— 报表写「轮空」、对战记录写「（本轮轮空，无对战记录）」，
    // 和单机轮空看到的是同一个页面（你定的，不另做页面）。
    if (tourney && !v) {
        this._netBye = true;
        // 轮空也要有 _roundInfo，否则 buildRoundReport 会拿上一轮的残留去画。
        // 和单机 678.js:1324 同一套：pairs 空、bye 指向我。
        var meP = g.human();
        meP.last = { type: 'bye', dmg: 0 };
        this._roundInfo = { pairs: [], bye: meP };
        this._lastLog = null;
        this._battleKeep = this._battle;
        this._battle = null;
        this._phase = 'roundResult';
        this._notice = '';
        this._wait = 20;
        this.buildRoundReport();
        this.refreshCards();
        this.refresh();
        return;
    }
    this._netBye = false;

    var first = !this._battle;

    // 【落定阶段绝不能凭一份普通状态重建 _battle】
    //
    // 678.js 的补充绘制整块挂在 `if (!this._battle)` 上 —— 那一块画的是
    // 「第 N 轮结果 + 报表 + 本局对战记录」。轮结果页靠 netToRoundResult 把
    // _battle 收成 null 才画得出来。
    //
    // 这一行原来是无条件的，于是**任何后续状态都会把 _battle 重建**，下一次
    // refresh 时那个条件不成立，整页连带对战日志一起消失，玩家看到的是牌桌。
    // 1v1 里对手点「继续」推来的 advancing 就够触发一次（那份状态照旧带
    // resolved:true），锦标赛里别人桌每动一下都触发。这就是「对局完成后
    // 看不到对局日志」的根因。
    //
    // 但换局是合法的，必须放过去，否则新一局没有牌面可画：
    //   · 我那桌的 fresh（新一局 / 平局重发）
    //   · 我那桌一次**没播过**的 resolved（resolveId 变了）
    // 别人桌的那两种（btId 不是我）以及重复推的同一次结算都不算。
    var rid1 = m.resolveId || 0;
    var foreign1 = (m.btId !== undefined && m.myBtId !== undefined &&
                    m.btId !== m.myBtId);
    var replayed1 = !!(rid1 && rid1 === this._netPlayedResolve);
    var needBoard = !foreign1 && (m.fresh || (m.resolved && !replayed1));

    // 【展示保护期】演出还没走完 / 轮结果页还没停够时间，就先把这份状态压住。
    //
    // 时序：演出 150 帧（满点 200 帧），而服务器屏障放开后只等 advanceMs
    // （默认 2 秒）就推全场 fresh。我这桌**最后**打完时屏障当场放开，
    // 那份 fresh 会在我演出没走完时到达 —— 下面 m.fresh 的分支会把 _phase
    // 打回 'battle'、_lastLog 清空，netFinish 再也不跑，轮结果页和对战日志
    // 整个被跳过。这就是「有时候看不到对局日志」剩下的那一半原因。
    //
    // 处理：保护期内只更新公共信息（排名、血量都靠上面的 buildReplica），
    // 把最新那份带牌面的状态存进 _netPending，等保护期结束再应用。
    // 存最新的而不是第一份 —— 中间对手可能已经动过了，应用旧的会闪一下。
    if (this._netHoldFrames > 0) {
        // 【牌面存最新的，事件标记单独粘住】
        //
        // 新一轮开始后别人桌马上就动，服务器又给全场推普通状态 —— 那些不带
        // fresh。只存「最新那份状态」的话 fresh 就被覆盖丢了，保护期结束时
        // 走不到「进下一局」的分支，于是永远卡在上一轮的轮结果页，
        // 而服务器已经在下一轮了。这就是「卡在某个奇怪画面」的根因。
        //
        // 牌面要最新的（应用旧的会闪一下），标记要累积的 —— 两者分开存。
        if (v) this._netPending = m;
        if (m.fresh) this._netPendFresh = true;
        if (m.redealt) this._netPendRedealt = true;
        this.refresh();
        return;
    }

    if (!this.netPhaseSettled() || needBoard) {
        this._battle = D678N.buildBattle(v, g);
    }

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

    // 【别人桌的 fresh / resolved 一律不认】
    //
    // pushStateT 的 extra 是 Object.assign 合并进每一个座位的消息的，所以
    // 某一桌平局重发时，那份 {fresh:true} 会广播给全场 8 个人。而下面 m.fresh
    // 的分支无条件写 _phase='battle' 并清掉 _netWaitRound —— 我明明已经在
    // 轮结果页等着，会被拽回对局画面，然后再也回不去（回轮结果页的两条路
    // 都要求特定阶段）。一轮 4 桌，任意一桌平局就发生一次，所以很常见。
    //
    // 服务器现在在 extra 里带 btId（事件属于哪一桌），每份状态里带 myBtId
    // （我那桌）。两者都有且不等，就是别人桌的事，只更新公共信息后返回。
    //
    // 注意 startRound 推的那份 fresh 是**全场**的（新一轮开始），它不带 btId ——
    // 所以这里必须判 `m.btId !== undefined`，不能只看不等。
    if (m.btId !== undefined && m.myBtId !== undefined && m.btId !== m.myBtId) {
        // 排名、血量、还在打的人这些公共信息已经在上面更新过了（buildReplica），
        // 刷新一下让轮结果页的「还有 N 桌」跟着变，别动阶段。
        this.refresh();
        return;
    }

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
        // 新一局真的开始了，压住的那份（如果还有）已经过时，
        // 连累积的标记一起丢掉，免得回头又应用一次
        this._netPending = null;
        this._netPendFresh = false;
        this._netPendRedealt = false;
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
        // 【保护期只盖住演出，一帧不多】演出期间来的 fresh 会把演出打断
        // （m.fresh 分支在落定守卫之前，无条件把 _phase 打回 battle），
        // 所以必须压住。onBattleEnd 刚把 _wait 设成演出长度
        // （普通 150 帧 / 满点 200 帧 / 平局 100 帧）。
        //
        // 【为什么不再多留 90 帧】你定的规则：早结束的人停在日志页等最慢那桌，
        // 最后一桌不停、直接进下一轮，大家一起开始。
        //   · 早结束 -> fresh 还没来，保护期烧完 netFinish 正常跑，进日志页；
        //     之后靠落定守卫一直停在那儿，等 fresh 到了立刻进下一轮。
        //   · 最后一桌 -> 屏障当场放开，fresh 在演出期间就到并被压住；
        //     保护期和 _wait 同一帧归零，先释放 fresh 把阶段切成 battle，
        //     netFinish 那一支就轮不到了 —— 日志页自然被跳过，不拖别人。
        // 多留那 90 帧的话最后一桌会白等，正是你要避免的。
        this.netHold(this._wait || 0);
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
    // 已经落定的阶段一律不动，只刷新（提示语里的「还有 N 人在对局」要跟着变）。
    if (this.netPhaseSettled()) { this.refresh(); return; }

    if (first || m.resync) {
        // 重连回来正好赶上「我这桌完了、别人还在打」：落到轮结果页，
        // 别把人塞回一个已经结束的牌桌
        this._phase = this._netWaitRound ? 'roundResult' : 'battle';
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
           ph === 'netover' || ph === 'gameover';
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

    // 展示保护期倒数。烧完就把压住的那份状态放出来 ——
    // 放在 netPoll 之后、本地推进之前：这一帧收到的东西已经进了 _netPending，
    // 现在正好是应用它的时机。
    if (this._netHoldFrames > 0) {
        this._netHoldFrames--;
        if (this._netHoldFrames === 0) this.netReleaseHold();
    }

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
        // 【整份留下】原来只挑了 rank / total，战绩那些字段全被丢掉，
        // 淘汰页的「胜 x 负 x 胜率」和对手战绩就都画不出来。
        D678N.elim = b.elim;
        b.elim = null;
        // 出局了就跟这场赛事没关系了 —— 断开 SSE、清掉会话，别再占服务器
        // 一条长连接（你定的）。服务器那边也会主动关，这里是客户端侧的一半：
        // 不关的话 EventSource 会自动重连，拿一个已经失效的 sid 反复敲
        // /api/events。
        D678N.Net.reset();
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
    // 锦标赛里打完了本轮没结束的话，就一直待在这个页面等服务器推下一轮
    // （提示语会写「其他玩家还在对局」）—— 不另切页面，你定的。
    this.netToRoundResult();
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

// 这里原来有 netToWaitRoundIfNeeded：切到一个自己画的「第 N 轮」等待屏。
// 按你定的改成**复用轮结果页**（就是单机那个带对战记录的页面），
// 只在上方多一行「其他玩家还在对局」并在报表里列出还在打的人 ——
// 所以不再需要切阶段，roundResult 一直待着就行，等服务器推下一轮。
// 那个独立页面和 netDrawWaitRound 一起删了。

Scene_D678.prototype.netToRoundResult = function () {
    this._lastLog = this._netLog ? this._netLog.slice(0) : null;
    this._battleKeep = this._battle;
    this._phase = 'roundResult';
    // 提示语交给下面那个「继续」按钮，这里不再写字，免得两处叠在一起
    this._notice = '';
    this._wait = 20;
    this.buildRoundReport();
    this._battle = null;
    // 【这里不再起保护期】停留多久由「最慢那一桌打完没有」决定，不是定时的：
    // 走到这儿说明我早结束，落定守卫会一直把我留在这一页，直到服务器推 fresh
    // （最后一桌打完、屏障放开）那一刻立刻进下一轮 —— 你定的规则。
    this.refresh();
};

// 起一段展示保护期（帧）。取最大值，不缩短已有的保护期。
Scene_D678.prototype.netHold = function (frames) {
    this._netHoldFrames = Math.max(this._netHoldFrames || 0, frames);
};

// 保护期结束：把压住的那份状态应用掉，并把累积到的一次性标记贴回去。
Scene_D678.prototype.netReleaseHold = function () {
    var m = this._netPending;
    var fresh = this._netPendFresh, redealt = this._netPendRedealt;
    this._netPending = null;
    this._netPendFresh = false;
    this._netPendRedealt = false;
    if (!m) return;
    // 已经走到终局画面了就别再把人拽回牌桌 —— 保护期内可能来过 over
    if (this._phase === 'netover' || this._phase === 'gameover') return;
    // 把粘住的 fresh 贴回最新那份牌面上。
    //
    // 只在这份状态本身不是结算时才贴 —— 万一保护期里又来了一次**新的**结算
    // （resolveId 变了），那份该按结算走演出，贴上 fresh 会让它去放发牌动画，
    // 结算就丢了。实际上这种时序几乎不可能（保护期比一整回合短得多），
    // 但判一下不花钱。
    if (fresh && !m.resolved) {
        m.fresh = true;
        if (redealt) m.redealt = true;
    }
    this.netApply(m);
};

// 这里原来包了 onDiscardConfirm（把手动挑好的牌 POST 给 /api/discard）。
// 多人模式改成服务器随机弃之后，联机根本走不到弃牌界面，那个包装和
// /api/discard 一起删了。单机的 onDiscardConfirm 原样保留，没被碰过。

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
    // 锦标赛不发 ack：推进靠轮次屏障，/api/ack 只认 room.phase==='resolved'，
    // 而锦标赛整轮停在 'battle'。发过去就是个空响应，白跑一趟。
    if (this._netTourney) return;
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

// 联机下由服务器判定结束（over 消息），这里不本地判。
//
// 单机分支里顺便记「本日完局 / 冠军次数」（只统计单机，你定的）——
// checkGameEnd 恰好只有两个出口：被淘汰（不 alive）和最后幸存者（alive），
// 两者都算完局，后者额外算冠军。
//
// 【别再给 checkGameEnd 单独包一层】这个 IIFE 里 var 是函数作用域的，
// 再写一个 `var _cge` 就是同一个变量：后包的那层会把 _cge 覆盖成先包的那层，
// 于是 _cge.call(this) 调回自己，无限递归。单机进对局就爆栈，
// 而联机分支不走 _cge 所以一点症状都没有（烟测只构造联机场景，全绿）。
// 要加东西就往这个函数里加。
var _cge = Scene_D678.prototype.checkGameEnd;
Scene_D678.prototype.checkGameEnd = function () {
    if (!this._net) {
        var ended = _cge.call(this);
        // 一局里会被调到两次（beginRound 和结算各一次），原函数是幂等的，
        // 计数可不是 —— 所以自己上一道锁
        if (ended && !this._dailyReported) {
            this._dailyReported = true;
            var champ = !!(D678.Game && D678.Game.human().alive);
            D678N.dailyBump('finish');
            if (champ) D678N.dailyBump('champ');
        }
        return ended;
    }
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

    _rf.call(this);
    this.netDrawOverlay();
};

// 还在对局的其他玩家（锦标赛，轮结果页用）。
// 服务器每个玩家都带 inBattle，buildReplica 接了下来。
// 排除自己 —— 我已经在看轮结果页了，把自己列进「还在对局」很怪。
Scene_D678.prototype.netStillPlaying = function () {
    var g = D678.Game;
    if (!g || !g.players) return [];
    var out = [];
    for (var i = 1; i < g.players.length; i++) {
        if (g.players[i].inBattle) out.push(g.players[i].name);
    }
    return out;
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
        if (this._netTourney) {
            // 【锦标赛任何情况都不写「点击」】推进靠轮次屏障，/api/ack 只认
            // room.phase==='resolved'，而锦标赛整轮停在 'battle' —— 点了是个
            // 空响应，什么都不会发生，那行字是个假按钮。
            //
            // 判据是「这一场是锦标赛」，不是 _netWaitRound —— 我是最慢那一桌时
            // 本轮当场就结束了，waitingRound 是 false，原来那个条件会漏到下面
            // 1v1 那套 ack 文案上去。
            var n = this._netBusyTables || 0;
            msg = n > 0 ? '其他玩家还在对局（还有 ' + n + ' 桌）'
                        : '本轮已结束，正在开下一轮…';
            col = LC.gray;
        } else if (this._netWaitAck) { msg = '正在开启下一局';   col = LC.gold; }
        // 对方点了继续：服务器排了 advanceMs（2 秒）的延迟，这段时间双方都
        // 停在日志页上。写「对方已开启下一局」而不是「对方已确认」——
        // 后者只说了他点过，没说接下来要发生什么（你定的措辞）。
        else if (this._netAdvancing) { msg = '对方已开启下一局'; col = LC.green; }
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
// 四行字：本日游玩次数 / 本日完局次数 / 本日冠军次数 / 本日联机人数
// （全服累计，你定的）。前三项只统计单机，联机人数是多人开局的人数。
//
// 【为什么放在 678net.js 而不是 title.js】取数要联网，而 title.js 先加载、
// 那会儿还没有 D678N.Net。这个文件本来就已经包了 Scene_Title 的
// createCommandWindow / callTitleButton / start，顺路挂上最省事。
//
// 【为什么单独一个精灵】title.js 的 _btnBmp 有 _btnCache 这道「没变化就不重画」
// 的优化，往里画会被它的缓存判断吃掉（按钮状态没变就整块不刷）。
// 单独一层还能保证不挡按钮的点击区。
var DAILY_X = 24;          // 靠左（你定的），留一点边距别贴着屏幕边
var DAILY_Y = 26;          // 顶部留白里，封面图上方那条空带
var DAILY_LH = 30;         // 行高
// 「本日游玩次数：」7 个字 × 22 号字，量出来约 154，给到 168 留点余量。
// 三行标签字数相同，所以数字会自然对齐成一列。
var DAILY_LABEL_W = 168;

var _stCreate = Scene_Title.prototype.create;
Scene_Title.prototype.create = function () {
    _stCreate.call(this);
    this._dailyBmp = new Bitmap(Graphics.width, DAILY_Y + DAILY_LH * 4 + 10);
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
    var key = d ? (d.plays + '/' + d.finishes + '/' + d.champs +
                   '/' + (d.online || 0)) : '';
    if (key === this._dailyShown) return;    // 没变化不重画
    this._dailyShown = key;

    var bmp = this._dailyBmp;
    bmp.clear();
    if (!d) return;

    var rows = [
        ['本日游玩次数', d.plays,        '#ffd766'],
        ['本日完局次数', d.finishes,     '#ffffff'],
        ['本日冠军次数', d.champs,       '#5cff9d'],
        ['本日联机人数', d.online || 0,  '#7fd4ff'],
    ];
    // 整块靠左（你定的）。标签左对齐顶着 DAILY_X，数字紧跟在标签之后 ——
    // 标签都是 6 个字等宽，所以数字自然也对齐成一列，不用量宽度。
    for (var i = 0; i < rows.length; i++) {
        var y = DAILY_Y + i * DAILY_LH;
        bmp.fontSize = 22;
        bmp.outlineColor = 'rgba(0,0,0,0.85)';
        bmp.outlineWidth = 5;
        bmp.textColor = '#b9c8c0';
        bmp.drawText(rows[i][0] + '：', DAILY_X, y, DAILY_LABEL_W, 26, 'left');
        bmp.textColor = rows[i][2];
        bmp.drawText(String(rows[i][1]),
            DAILY_X + DAILY_LABEL_W, y, 120, 26, 'left');
    }
};

})();
