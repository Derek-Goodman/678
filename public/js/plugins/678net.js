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

// 单机也用这个昵称：覆写 678core 留的钩子（核心那边不能直接读 localStorage，
// 它要跑在 Node 里）。没设过昵称时退回核心的默认值。
//
// 【只影响下一局】D678_Game 在构造时把名字定下来，所以在大厅改完名
// 再开新的单机赌局才生效，进行中的那局不会中途改名。
D678.humanName = function () {
    var s = D678N.savedName();
    return s ? s : '我';
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
// 标题上那行「天梯模式对局中人数」的数
//=============================================================================
//
// 【这个数是造的，和 stats 里那些不是一回事】（2026-08-07 你定的）
// stats.online / ladPlaying / aiPlaying 全是真数，而且只有 GM 看得见
// （见 drawOnline 和服务器的 computeStats）。这一行是给**所有玩家**看的门面数，
// 量级差两个数量级：GM 同时看到「1 人在线 · 12 个 AI 模拟对局」和这行的
// 「对局中人数：687」，两个数没有任何关系，别当成同一个东西的两种口径。
//
// 【为什么纯客户端算、不问服务器】标题画面在连服务器之前就要显示这行字，
// 而且单机 exe / 服务器没起 / 断网的时候也得有 —— 走接口的话这些情况下
// 就是一片空白。代价是不同时区的人同一时刻看到的数不一样，没人会去对比，
// 而且用本地时钟反而让「深夜人少」符合看的人自己的作息。
//
// 【曲线形状】凌晨 3~5 点见底（50 上下），下午明显比上午多（你定的），
// 峰值在晚 20 点（900）—— 和服务器 LAD_HOURS 那份作息表同向，那边也是
// 20 点权重最高。区间 [50, 1000]（你定的：不一定要过千）。
//
// 【18 点和 21 点那两个凹陷是故意的】（你定的）吃饭掉一下、21 点再掉一下，
// 所以晚上是双峰不是单峰。代价是 22→23 的夜间收工那一段斜率很陡
// （一小时差 530），_test_ladui.js 的 maxJump 门槛为此放宽过，别当成 bug 收窄回去。
var LAD_FAKE_HOURS = [
    250, 110, 100, 60, 55, 50,      //  0~5   后半夜见底
    75, 88, 95, 110, 150, 250,      //  6~11  早上爬起来
    350, 450, 555, 675, 690, 700,   // 12~17 下午高于上午
    400, 850, 900, 650, 830, 300,   // 18~23 18/21 点凹陷，峰值在 20 点
];

// 20 秒一桶的确定性抖动。用哈希而不是 Math.random —— 同一分钟内反复调
// （标题每 30 帧查一次）必须得到同一个数，否则数字会每半秒乱跳一次。
function ladFakeWobble(bucket) {
    var h = 2166136261;
    var s = 'w' + bucket;
    for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h * 16777619) >>> 0;
    }
    return (h >>> 8) / 16777216;      // 0~1
}

// 此刻「天梯模式对局中」的人数。
D678N.ladFakePlaying = function (now) {
    var d = now ? new Date(now) : new Date();
    var hr = d.getHours(), mi = d.getMinutes();
    // 整点锚点之间按分钟线性插值，所以一整天是缓慢起伏的，不是每小时跳一档
    var a = LAD_FAKE_HOURS[hr];
    var b = LAD_FAKE_HOURS[(hr + 1) % 24];
    var base = a + (b - a) * (mi / 60);
    // ±1.2% 的抖动，20 秒换一次 —— 让它看着是活的
    var bucket = Math.floor(d.getTime() / 20000);
    var w = 1 + (ladFakeWobble(bucket) - 0.5) * 0.024;
    var n = Math.round(base * w);
    // 真夹子，不是跳档 —— 写成 if (n < 50) n = 20 那种「低于下界就换个更小的数」
    // 会在边界上凿出一个断崖（199 直接掉到 50，中间的数一个都不经过），
    // 标题上看着就是数字忽然塌一截。踩过一次。
    if (n < 50) n = 50;
    if (n > 1000) n = 1000;
    return n;
};

//=============================================================================
// 天梯登录态
//=============================================================================
//
// 令牌存 sessionStorage，和对局会话同一个理由（见上面那段）：localStorage
// 是同浏览器所有标签页共享的，双开测试时两边会互相顶。刷新页面不丢，
// 关标签页就没了。
//
// 账号名另外存 localStorage —— 那只是「下次帮你填上」的便利，不是登录态。
//
// 【服务器重启后令牌就失效了】它只在服务器内存里。客户端收到 401 就把本地
// 那份清掉、回登录页，不要在界面上装作还登录着。
D678N.ladToken = function () {
    try { return sessionStorage.getItem('d678_lad') || ''; } catch (e) { return ''; }
};
D678N.setLadToken = function (t) {
    try {
        if (t) sessionStorage.setItem('d678_lad', t);
        else sessionStorage.removeItem('d678_lad');
    } catch (e) {}
};
D678N.lastAcc = function () {
    try { return localStorage.getItem('d678_lad_acc') || ''; } catch (e) { return ''; }
};
D678N.setLastAcc = function (s) {
    try { localStorage.setItem('d678_lad_acc', s); } catch (e) {}
};

// 内存里的天梯身份。null = 没登录。
// {acc, name, canRename, score, tier, games, champs, avgRank, season}
D678N.lad = null;

// 从接口响应里装配天梯身份。
//
// 【为什么要这么一个函数】/api/lad/reg、/auth、/me、/name 四个接口都回同一份
// accView，原来每处各自手写 `{acc: r.acc, name: r.name, canRename: r.canRename}`
// —— 加了 score/tier/games 之后漏掉任何一处，那一条路进来就没有段位和分数，
// 「开启排位」界面上是空的。集中成一份，以后加字段只改这里。
D678N.setLadFrom = function (r) {
    if (!r) { D678N.lad = null; return null; }
    D678N.lad = {
        acc: r.acc, name: r.name || '', canRename: !!r.canRename,
        score: r.score, tier: r.tier, games: r.games,
        champs: r.champs, avgRank: r.avgRank, season: r.season,
    };
    return D678N.lad;
};

// 一局天梯打完后，把结算回来的分数补进登录态 —— 否则回到「开启排位」界面
// 显示的还是打之前那个分，得退出重登才更新。
D678N.applyLadResult = function (lad) {
    if (!lad || !D678N.lad) return;
    if (typeof lad.score === 'number') D678N.lad.score = lad.score;
    if (lad.tier) D678N.lad.tier = lad.tier;
    if (typeof lad.games === 'number') D678N.lad.games = lad.games;
    if (typeof lad.champs === 'number') D678N.lad.champs = lad.champs;
    if (typeof lad.avgRank === 'number') D678N.lad.avgRank = lad.avgRank;
};

// 天梯页现在停在哪一步。三步是递进的，服务器的状态决定走到哪：
//   login  没认证 —— 输账号密码
//   name   认证了但还没起名 —— 输 4-8 位游戏名
//   ready  有名字了 —— 「开启排位」可以点
D678N.ladStage = function () {
    if (!D678N.lad) return 'login';
    return D678N.lad.name ? 'ready' : 'name';
};

//=============================================================================
// 本日计数（标题画面上方四行）
//=============================================================================
// 全服累计。
//
//   游玩次数 = 进入对局。单机在这里报；多人由服务器在开赛时自己加
//              （startTourney / startDuel），这边不能再报，会重复。
//   完局次数 = 单机打到结算画面（拿第几名都算）
//   冠军次数 = 单机最后幸存者。冠军同时也计入完局。
//   联机人数 = 多人开局的人数，服务器自己加
//
// 【2026-08-07 起只有 GM 看得见】（你定的）非 GM 和未登录的人一律看不到这
// 四行。门禁在服务器（/api/daily 只对 GM 回数字），这边只要把天梯令牌带上；
// 拿不到 plays 就整块不画。
//
// 【上报照旧对所有人开放】挡了的话数字就不长了，GM 自己也看不到全服的真实
// 活跃 —— 门禁只挡「读」。
//
// 连不上服务器（单机 exe / 服务器没起）同样整块不画 —— 留四个「0」在标题上
// 比不显示更难看，而且会让人以为功能坏了。
D678N.daily = null;      // 最近一次拿到的计数。null = 还没问到 / 不是 GM

// 服务器认 GM 靠天梯令牌。没登录就是空串，服务器回 {gm:false}。
D678N.dailyFetch = function (cb) {
    D678N.Net.post('/api/daily', { ladToken: D678N.ladToken() }, function (r) {
        // gm 为假时服务器不带数字，得把本地那份清掉 —— 否则退出登录后
        // 标题上还挂着最后一次看到的数字
        D678N.daily = (r && r.ok && r.gm) ? r : null;
        if (cb) cb(D678N.daily);
    });
};

// 上报一次。GM 的话服务器会回新值，顺手存下来，标题回去就是最新的。
D678N.dailyBump = function (kind) {
    D678N.Net.post('/api/daily',
        { bump: kind, ladToken: D678N.ladToken() }, function (r) {
            if (r && r.ok && r.gm) D678N.daily = r;
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
    // 【必须是队列，不能只留最新一份】盘面里带着 fresh / resolved 这类
    // **一次性事件标记**，而服务器常常在几毫秒内连推好几份：
    // 实测录到过 `fresh` 在 5888ms、后面两份普通状态在 5893ms —— 相差 5 毫秒，
    // 落在同一帧（16.7ms）里。只留最新一份的话那个 fresh 在进 netApply 之前
    // 就被覆盖掉了，客户端永远不知道新一轮开始了，于是**卡在上一轮的画面上**。
    // 这就是「一桌还没打完、另一桌打完了却停在牌局界面」的根因。
    states: [],      // 盘面队列，按到达顺序
    events: [],      // 对手动作文字，按顺序
    over:   null,    // 决斗结束 / 锦标赛结束
    abort:  null,    // 房间被终止
    peer:   null,    // 对手掉线 / 回来
    elim:   null,    // 锦标赛：我被淘汰了（带名次）
    ladscore: null,  // 天梯：这一局的加减分（中途退出时单独走这条）
    netdown: false,  // 连接断了
};

// 队列上限。正常一帧最多来几份，堆到这个数说明场景没在消费
// （切场景的空档），丢最老的那些普通状态 —— 但**带事件标记的一份都不丢**。
D678N.INBOX_MAX = 120;

// 早结束的人在对战日志页上至少停留这么多帧（60 = 1 秒）。
//
// 【为什么需要】演出 2.5 秒比服务器的推进延迟（advanceMs，默认 2 秒）长，
// 所以最慢那桌只要跟我差不到 0.5 秒，fresh 就会在我演出没走完时到达，
// 日志页一帧都不显示。多留 1 秒把这个缝盖住。
//
// 代价：早结束的人比服务器落后最多 1 秒，下一轮开局时他的回合计时已经在跑。
// 1 秒对 30 秒的回合可以接受；给太长就变成惩罚早打完的人了。
D678N.LOG_DWELL = 60;

D678N.clearInbox = function () {
    var b = D678N.inbox;
    b.room = null; b.states = []; b.events = [];
    b.over = null; b.abort = null; b.peer = null; b.elim = null;
    b.ladscore = null;
    b.netdown = false;
};

D678N.Net.emit = function (type, data) {
    var b = D678N.inbox;
    switch (type) {
    case 'room':    b.room = data; break;
    case 'state':
        b.states.push(data);
        if (b.states.length > D678N.INBOX_MAX) {
            // 超限就丢最老的普通状态（不带 fresh / resolved 的那些）。
            // 一个都没得丢才丢队首 —— 那种情况下已经积压严重，保新不保旧。
            var k = b.states.findIndex(function (m) {
                return !m.fresh && !m.resolved;
            });
            b.states.splice(k >= 0 ? k : 0, 1);
        }
        break;
    case 'event':   b.events.push(data.msg); if (b.events.length > 8) b.events.shift(); break;
    case 'over':    b.over = data; break;
    case 'abort':   b.abort = data; break;
    case 'peer':    b.peer = data; break;
    case 'eliminated': b.elim = data; break;
    // 天梯加减分。中途退出时单独走这条 —— 那时候不会有 over / eliminated
    // （退出的人不再收赛事消息），但分已经结算了，得让他看到。
    case 'ladscore':
        b.ladscore = data;
        D678N.applyLadResult(data);
        break;
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
        // 淘汰顺序。rankedPlayers 拿它给死人排名（越早淘汰名次越靠后），
        // 漏了它死人区就按座位号排 —— 名次不锁死，最早淘汰的可能排在上面。
        // 1v1 不发这个字段（两个人的排名表没意义），缺了得到 0，行为不变。
        p.outAt = info.outAt || 0;
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
    // 已淘汰人数 = 最大的 outAt。原来钉死 0，和上面抄下来的 outAt 对不上；
    // 客户端不会自己淘汰人（服务器权威），但让这两个值自洽比留个矛盾好。
    g.outCount = g.players.reduce(function (m, p) {
        return Math.max(m, p.outAt || 0);
    }, 0);
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
            // uid 照抄服务器发的 —— 精灵靠它认牌。丢了的话「删中间那张」时
            // 后面的牌会被当成新牌一起重新入场（见 678.js 的 cardKey）。
            cards: s.cards.map(function (c) {
                // fake / face 照抄：绘制层靠它们给复制品染色、给 +1/-1 换卡图
                // （见 678.js 的 refreshCards）。服务器只在为真时才发这两个字段。
                var o = { v: c.v, hidden: c.hidden, uid: c.uid };
                if (c.fake) o.fake = true;
                if (c.face) o.face = c.face;
                return o;
            }),
            stood: s.stood, checkN: s.checkN, known: [],
        };
    });
    // 二选一的待选。服务器已经按人遮蔽过：只有选的那个人拿到两张候选的点数，
    // 对手那份 vals 是 null（他只知道有人在选）。
    // 【side 恒为 0】客户端永远把自己当 side 0，所以 mine 直接映射成 0/1。
    b.pending2 = v.pick2 ? {
        side: v.pick2.mine ? 0 : 1,
        vals: v.pick2.vals || null,
        funcName: '二选一'
    } : null;
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

// 天梯段位配色。顶尖金、高手橙、精通青、普通白、新手灰 ——
// 一眼能看出高低，不用去比数字。
// 和 LC 放一起：drawLadReady 和榜页都要用，定义在用它的函数之后虽然
// 也能跑（绘制是后调的），但读起来像是漏了。
var TIER_COL = {
    '顶尖': '#ffd766', '高手': '#ff9a4d', '精通': '#48e6d2',
    '普通': '#ffffff', '新手': '#b9c8c0',
};

var BTN_W = 420, BTN_H = 78, BTN_GAP = 24;

// 在线信息两行的 y，和它下面标题 / 按钮的 y。
//
// 【为什么要重排】原来在线行在 292（占 292~322），天梯行在 324（占 324~354），
// 而「锦标赛」/「单人对决」标题画在 336（30 号字占 40 高，336~376）——
// 天梯行和标题重叠了 18 像素（你报的）。当时 drawDuel 把标题从 300 让到 336
// 只避开了第一行，后来加的天梯行没跟着让。
//
// 【为什么不是简单往下推】现在天梯那行还要多带一段「N 个 AI 模拟对局中」。
// 三行的话底边到 386，而菜单按钮从 380 起 —— 又会压到按钮上。所以两个天梯
// 数字并进同一行（真人红色 · AI 灰色），整块保持两行，再把标题和按钮让开。
//
// 【行距按 size + 10 算】this.txt 的绘制高度是 size + 10，20 号字占 30 高 ——
// 按 20 算间距会重叠 7 像素。
var ONLINE_Y = 288;          // 第一行：在线 / 对局中 / 等人   288~318
var ONLINE_Y2 = 318;         // 第二行：天梯真人 / AI 模拟     318~348
var MENU_TITLE_Y = 360;      // 「锦标赛」「单人对决」标题      360~400
var MENU_BTN_Y = 412;        // 菜单按钮起点

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

//=============================================================================
// 天梯登录表单（全画在 canvas 上，输入走 window.prompt）
//=============================================================================
//
// 【为什么不用 DOM <input>】试过，点不动。RMMV 启动时给 document.body 抹了
// user-select:none（Graphics._disableTextSelection），盖在画布上的输入框继承下来
// 就选不中内容；再加上 RMMV 在 document 上收触摸/指针事件、画布是等比缩放
// 居中的（位置要跟着窗口和页面滚动算），坑一个接一个。
//
// 现在的做法和「修改名字」那边一致：面板上每栏画出当前值，点「输入」用
// window.prompt 依次问一遍。prompt 是浏览器自己的输入框，中文输入法、
// 手机键盘、粘贴全都天然正常，还不受 maxLength 卡住拼音的影响。
//
// 坐标只有一份 —— ladLayout() 同时喂给绘制和命中测试。

var LAD_IN_H = 52, LAD_ROW = 68, LAD_LBL_W = 96;

// stage: login | name。reg = 注册态（多一栏「确认密码」）
function ladLayout(stage, reg) {
    var W = Graphics.width;
    // 388 而不是 340 —— 天梯页的名字条比别处高（多一行红字，到 310），
    // 「天梯模式」那行标题占 336~376，面板必须从这之后开始
    var px = Math.round(W / 2 - BTN_W / 2), py = 388, pw = BTN_W;
    var ix = px + 24 + LAD_LBL_W, iw = pw - 48 - LAD_LBL_W;
    var rows = [];
    if (stage === 'name') {
        rows.push({ key: 'name', label: '游戏名', ph: '4-8 位' });
    } else {
        rows.push({ key: 'acc', label: '账号', ph: '4-16 位字母数字' });
        rows.push({ key: 'pw', label: '密码', ph: '4-16 位' });
        if (reg) rows.push({ key: 'pw2', label: '确认密码', ph: '再输一次' });
    }
    for (var i = 0; i < rows.length; i++) {
        rows[i].x = ix; rows[i].w = iw; rows[i].h = LAD_IN_H;
        rows[i].y = py + 26 + i * LAD_ROW;
    }
    var last = rows[rows.length - 1];
    // 提示语那一行（登录页写「别用你在其他地方用的密码」，起名页写位数）
    var hintY = last.y + LAD_IN_H + 10;
    var btnY = hintY + 30;
    var bh = 60;
    // 「输入」独占一行，主按钮在它下面 —— 输入是每次都要点的那个，
    // 挤在认证/注册旁边会让人以为三个是并列的选项
    var btns = [{ key: 'edit', label: '输入',
                  x: px + 24, y: btnY, w: pw - 48, h: bh }];
    var y2 = btnY + bh + 16;
    if (stage === 'name') {
        btns.push({ key: 'setname', label: '确定',
                    x: px + (pw - 200) / 2, y: y2, w: 200, h: bh });
    } else {
        var bw = (pw - 48 - 20) / 2;
        btns.push({ key: 'auth', label: '认证', x: px + 24, y: y2, w: bw, h: bh });
        btns.push({ key: 'reg',  label: reg ? '确认注册' : '注册',
                    x: px + 24 + bw + 20, y: y2, w: bw, h: bh });
    }
    return { px: px, py: py, pw: pw, ph: y2 + bh + 24 - py,
             rows: rows, btns: btns, hintY: hintY };
}

// 输入暂存。没有 DOM 了，就是三个字符串 —— 画面读它、prompt 写它、
// 提交时取它。live() 表示「这一步有东西要填」，ready 那步是 false。
D678N.LadForm = {
    vals: null,         // {acc, pw, pw2} 或 {name}；null = 没在填
    _sig: '',           // 当前是哪一套（stage|reg）

    live: function () { return !!this.vals; },

    // 当前这一套要填哪几栏
    keys: function () {
        if (!this._sig) return [];
        var parts = this._sig.split('|');
        if (parts[0] === 'name') return ['name'];
        return parts[1] === '1' ? ['acc', 'pw', 'pw2'] : ['acc', 'pw'];
    },

    // 这一栏的显示值。密码不遮（你定的：明着输入就行，不搞星号）——
    // 而且 prompt 输错字只能靠回来看一眼，遮了就没法核对
    shown: function (key) {
        var v = this.vals && this.vals[key];
        return v ? String(v) : '';
    },

    // 切到这一套。已经填的留着 —— 点「注册」展开确认密码那栏时
    // 不该让人把账号密码重打一遍
    open: function (stage, reg) {
        var sig = stage + '|' + (reg ? 1 : 0);
        if (this.vals && this._sig === sig) return;
        var keep = this.values();
        this._sig = sig;
        this.vals = {};
        var ks = this.keys();
        for (var i = 0; i < ks.length; i++) {
            this.vals[ks[i]] = keep[ks[i]] || '';
        }
    },

    // 记一栏。null / undefined 当没改（prompt 被取消）
    set: function (key, v) {
        if (!this.vals || v == null) return;
        this.vals[key] = String(v).trim();
    },

    values: function () {
        var o = {};
        if (!this.vals) return o;
        for (var k in this.vals) {
            o[k] = String(this.vals[k] || '').trim();
        }
        return o;
    },

    clearPw: function () {
        if (!this.vals) return;
        ['pw', 'pw2'].forEach(function (k) {
            if (k in this.vals) this.vals[k] = '';
        }, this);
    },

    close: function () {
        this.vals = null; this._sig = '';
    },
};

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
    this._ladReg = false;     // 天梯登录表单是不是展开成注册态（多一栏确认密码）
    // 天梯匹配总计时上次画出来的秒数。-1 = 还没画过（下一帧就重画一次）。
    // updateLadClock 靠它判断「秒数变了没」，见那边注释。
    this._ladClockShown = -1;
    this._ladFillMs = 0;
    this._ladFillAt = 0;

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
        // GM 判定（2026-08-07 起这几行只有 GM 看得见）。没登录就是空串，
        // 服务器回 {gm:false} 不带数字。心跳照旧记 —— 门禁只挡数字，
        // 不挡「我还在线」，否则 GM 看到的在线数会漏掉所有没登录 GM 的人。
        ladToken: D678N.ladToken(),
    }, function (r, code) {
        if (!r || code !== 200) {
            // 老服务器没这个接口（404）。标记一下别再画那一行，
            // 也别弹提示 —— 人数是附加信息，缺了不影响开局。
            self._statsFail = true;
            return;
        }
        self._statsFail = false;
        var old = D678N.stats;
        // 非 GM：清掉本地那份，那两行就不画了（退出登录后不能还挂着旧数字）
        D678N.stats = r.gm ? r : null;
        var now = D678N.stats;
        // 数字没变就不重绘，省得每 5 秒白刷一遍整个画面
        if (!old !== !now || (old && now &&
            (old.online !== now.online || old.playing !== now.playing ||
             old.waiting !== now.waiting || old.ladPlaying !== now.ladPlaying ||
             old.aiPlaying !== now.aiPlaying))) {
            self.refresh();
        }
    });
};

Scene_D678Net.prototype.updateStats = function () {
    if (this._statsWait > 0) { this._statsWait--; return; }
    this._statsWait = 300;   // 60fps → 5 秒
    this.pingStats();
};

// 在线人数那两行。等待页不画 —— 那时候「谁在这个房间里」才是要紧事，
// 全局人数只是噪音。
//
// 【只有 GM 看得见】（2026-08-07 你定的）非 GM 拿不到 D678N.stats
// （pingStats 里 gm 为假就置 null），所以这里 !s 直接不画。
//
// 【这两行的数字一律是真的】原来 online 里掺了 AI 模拟对局的假人数。现在只有
// GM 看，冲了假数反而看不出「到底有没有人在玩」，所以 online / ladPlaying 都是
// 真人，AI 模拟数单独一段（灰色）摆在第二行。
//
// 【别和标题上那行红字搞混】标题画面「天梯模式对局中人数：N」是**造的门面数**
// （2026-08-07 你定的，见 D678N.ladFakePlaying），给所有玩家看、量级 200~1000。
// 这两行是运营数字、只给 GM、量级个位到几十。GM 会同时看到两个数，它们之间
// 没有任何换算关系 —— 一个是门面，一个是实情，故意分开的。
Scene_D678Net.prototype.drawOnline = function () {
    var W = Graphics.width;
    var s = D678N.stats;
    if (this._statsFail) return;
    // 没登录 GM / 还没问到：整块不画（不是「连接中…」—— 那会让非 GM 看到
    // 一行永远不消失的提示）
    if (!s) return;

    var parts = ['在线 ' + s.online + ' 人'];
    if (s.playing > 0) parts.push(s.playing + ' 人对局中');
    if (s.waiting > 0) parts.push(s.waiting + ' 个房间等人');
    // 有人在等就标绿：这时候点「加入房间」马上能开一局
    var col = s.waiting > 0 ? LC.green : (s.online > 1 ? LC.text : LC.gray);
    this.txt('● ' + parts.join(' · '), 0, ONLINE_Y, W, 20, col, 'center');

    // 第二行：天梯真人（红）+ AI 模拟（灰）。两个数字并在一行 ——
    // 各占一行的话底边会压到下面的标题上。
    // 真人那段为 0 时只显示 AI 那段。
    var lad = [];
    if (s.ladPlaying > 0) lad.push(s.ladPlaying + ' 人天梯对局中');
    if (s.aiPlaying > 0) lad.push(s.aiPlaying + ' 个 AI 模拟对局');
    if (!lad.length) return;
    // 有真人就用红色（真人在打是要紧信息），只有 AI 时用灰色（那只是背景噪音）
    this.txt(lad.join(' · '), 0, ONLINE_Y2, W, 20,
             s.ladPlaying > 0 ? LC.red : LC.gray, 'center');
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

    // 排行榜自己占满整屏（100 行要地方），不画「多人游戏」标题和名字条。
    // 它的返回按钮也自己画 —— 位置和别处不一样（底部要留给分页按钮）。
    if (this._page === 'board') {
        this.drawBoard();
        if (this._noticeTime > 0 && this._notice) {
            this.panel(60, H - 200, W - 120, 64);
            this.txt(this._notice, 60, H - 182, W - 120, 24, LC.red, 'center');
        }
        return;
    }

    this.txt('多人游戏', 0, 120, W, 44, LC.gold, 'center');
    // 玩家名条。原来是一行 20 号灰字（整屏最小）加一句「（点这里可改）」，
    // 点击区还没画框 —— 看不出能点。现在名字提到 32 号白字，和菜单按钮同级，
    // 「修改」做成独立小按钮。点名字本身不改名，避免误触。
    // 名字条是三分的（你定的）：
    //   多人首界面   玩家名 + 「修改」，随便改
    //   锦标赛 / 单人对决 / 等待 / 淘汰 / 排名   只显示，没有按钮
    //   天梯页       天梯游戏名 + 「修改」，下面挂红字「每天只能修改一次」
    //
    // 【为什么天梯名和玩家名不共用】登录天梯顺带改掉朋友局的名字说不通，
    // 退出天梯后名字还锁着每天一次更说不通。所以两套各管一摊。
    // 【天梯的页面要显示天梯名，不是多人游戏名】名字条原来只在 _page==='ladder'
    // 时认天梯名。天梯打完一局落到 ranks / elim 页时 isLad 是 false，于是上方
    // 显示的是多人游戏昵称 —— 而这一页的名次和战绩全是按天梯名算的，
    // 看着就成了「叫 B 的人拿了第 3 名，而排名表里第 3 名写着 A」（你报的第 4 条）。
    //
    // 判据：天梯页本身，或者这一局是天梯局（结算数据上带 ladder / lad 标记）。
    var ladGame = !!(D678N.finalOver && D678N.finalOver.ladder) ||
                  !!(D678N.elim && D678N.elim.lad) ||
                  !!(this._roomInfo && this._roomInfo.ladder);
    var isLad = (this._page === 'ladder');
    var showLadName = isLad ||
        (ladGame && (this._page === 'ranks' || this._page === 'elim' ||
                     this._page === 'waiting'));
    var lad = D678N.lad;
    var nm = showLadName ? (lad ? (lad.name || '') : '') : D678N.savedName();
    var px = Math.round(W / 2 - BTN_W / 2), py = 186;
    var ph = isLad ? 124 : 96;
    this.panel(px, py, BTN_W, ph);
    this.txt(showLadName ? '天梯游戏名' : '玩家名',
             px + 24, py + 12, 200, 18, LC.gray, 'left');

    var mw = 96, mh = 56;
    var mx = px + BTN_W - 20 - mw;
    var my = isLad ? py + 36 : py + (ph - mh) / 2;
    // 【赛事结束后不给改名】（2026-08-05 你定的）淘汰页 / 最终排名页上那些
    // 名次和战绩是服务器按**当时那个名字**算好发下来的，就摆在这块名字条
    // 下面。这时候改名，界面上就成了「叫 B 的人拿了第 3 名，而排名表里
    // 第 3 名写着 A」—— 两个名字指同一个人，看着像是排错了。
    // 名字本身照旧显示：那是「这一局我是谁」的说明，去掉反而少了信息。
    // 看完点返回回到子页，那时候按钮就回来了（改的是下一局的名字）。
    // 天梯页：登录了才给改名按钮（没登录时下面就是登录表单，那才是当务之急）。
    // 其余页只有多人首界面能改。
    var canRename = isLad ? !!lad : (this._page === 'menu');
    this.txt(nm || (showLadName ? (lad ? '未设置' : '未登录') : '未设置'),
             px + 24, py + 40,
             (canRename ? mx - px - 40 : BTN_W - 48), 32,
             nm ? LC.text : LC.gray, 'left');

    // 红字。天梯改名的限次说明，只写一句（你要的）
    if (isLad && lad) {
        this.txt('每天只能修改一次', px + 24, py + 86, BTN_W - 48, 20,
                 LC.red, 'left');
    }

    if (canRename) {
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
                          cb: (isLad ? this.onLadRename : this.onChangeName)
                              .bind(this) });
    }

    if (this._page === 'menu' || this._page === 'duel' ||
        this._page === 'tourney') this.drawOnline();

    if (this._page === 'menu')    this.drawMenu();
    if (this._page === 'duel')    this.drawDuel();
    if (this._page === 'tourney') this.drawTourney();
    if (this._page === 'ladder')  this.drawLadder();
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
    ], MENU_BTN_Y);
};

Scene_D678Net.prototype.drawTourney = function () {
    this.txt('锦标赛', 0, MENU_TITLE_Y, Graphics.width, 30, LC.gold, 'center');
    this.buttons([
        { label: '匹配模式', cb: this.onMatch.bind(this) },
        { label: '天梯模式', cb: this.onLadder.bind(this) },
    ], MENU_TITLE_Y + 64);
};

// 天梯页。三步递进（login → name → ready），「开启排位」三步都画 ——
// 没登录的人也该看得见它，只是点不动（你定的）。
Scene_D678Net.prototype.drawLadder = function () {
    var W = Graphics.width;
    var stage = D678N.ladStage();
    this.txt('天梯模式', 0, 336, W, 30, LC.gold, 'center');

    if (stage === 'ready') {
        this.drawLadReady();
        return;
    }

    var lay = ladLayout(stage, !!this._ladReg);
    this.panel(lay.px, lay.py, lay.pw, lay.ph);
    for (var i = 0; i < lay.rows.length; i++) {
        var r = lay.rows[i];
        this.txt(r.label, lay.px + 24, r.y + (LAD_IN_H - 26) / 2,
                 LAD_LBL_W, 24, LC.text, 'left');
        // 框和里头的值都画在 canvas 上。输入走「输入」按钮 + window.prompt
        var ctx = this._bmp._context;
        ctx.save();
        roundRect(ctx, r.x, r.y, r.w, r.h, 8);
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,235,170,0.55)';
        ctx.lineWidth = 2; ctx.stroke();
        ctx.restore();
        this._bmp._setDirty();
        // 有值就显示值，没值显示灰色的占位说明（那栏该填什么）
        var v = D678N.LadForm.shown(r.key);
        this.txt(v || r.ph, r.x + 12, r.y + (LAD_IN_H - 26) / 2,
                 r.w - 24, 24, v ? LC.text : LC.gray, 'left');
    }

    // 【这句是明文存密码的配套】不加的话玩家会拿他在别处用的密码来注册
    this.txt(stage === 'name' ? '4-8 位，汉字、字母或数字'
                              : '请勿使用你在其他地方用的密码',
             lay.px + 24, lay.hintY, lay.pw - 48, 18, LC.gray, 'left');

    for (var j = 0; j < lay.btns.length; j++) {
        var b = lay.btns[j];
        var press = (this._press === 100 + j);
        drawBtn(this._bmp, b.x, b.y, b.w, b.h, press, press);
        this._bmp.fontSize = 26;
        this._bmp.textColor = press ? LC.edge : LC.text;
        this._bmp.outlineColor = 'rgba(0,0,0,0.8)';
        this._bmp.outlineWidth = 4;
        this._bmp.drawText(b.label, b.x, b.y + (b.h - 32) / 2 + (press ? 2 : 0),
                           b.w, 32, 'center');
        this._hits.push({ x: b.x, y: b.y, w: b.w, h: b.h, i: 100 + j,
                          cb: this.ladBtnCb(b.key) });
    }

    var rankY = lay.py + lay.ph + 28;
    this.drawRankBtn(rankY, false);
    // 没登录也给榜按钮 —— 让人先看到「这里有个榜、上面有一堆人」，
    // 比一个点不动的灰按钮更能说明登录之后有什么。
    // 未登录时「开启排位」下方还有一行说明灰字（BTN_H + 6 起、16 高，
    // 到 BTN_H + 22），所以榜按钮要让到 BTN_H + 30 之后。
    this.drawBoardBtn(rankY + BTN_H + 30);
};

// 登录且有名字了：段位 + 天梯分，然后「开启排位」「排行榜」「退出登录」
Scene_D678Net.prototype.drawLadReady = function () {
    var W = Graphics.width;
    var px = Math.round(W / 2 - BTN_W / 2);
    var lad = D678N.lad || {};
    this.txt('账号 ' + (lad.acc || ''), px + 24, 384, BTN_W - 48, 20,
             LC.gray, 'left');

    // 段位 + 天梯分 + 战绩（你定的：开启排位界面也要显示）。
    // 这些值跟着 /api/lad/me 和结算回来的数据走，见 D678N.setLadFrom。
    //
    // 【两行，不是一行】原来四样东西挤在一个 58 高的面板里、共用一条基线：
    // 段位画在 px+20 起宽 110，分数画在 px+130 起宽 120，而战绩那行是
    // **右对齐画在 px+20 起宽 380 的框里** —— 那个框整个盖住了前两个。
    // 右对齐的字从右边往左长，场次 / 均排名 / 冠军三样都有的时候左边缘会伸到
    // 分数上面去，于是「分」和场次糊在一起（你报的字叠在一起）。
    // 现在第一行只放段位 + 分数，战绩单独一行，两行都左对齐、各自占满宽度，
    // 谁变长都不会再撞。
    var sy = 410;
    var PH = 92;                        // 两行：14 起段位，56 起战绩
    this.panel(px, sy, BTN_W, PH);
    var tier = lad.tier || '—';
    this.txt(tier, px + 20, sy + 14, 110, 28, TIER_COL[tier] || LC.text, 'left');
    this.txt(lad.score == null ? '' : (lad.score + ' 分'),
             px + 136, sy + 16, 140, 24, LC.gold, 'left');
    // 【总是画全四样】原来 `if (lad.games)` 这种写法在 0 场 / 0 冠时整项消失，
    // 新账号只看得到段位和分数。你要的是四样都显示，所以 0 也画出来 ——
    // 「0 冠」本身就是信息。平均排名没打过时没有意义，那一项显示 '—'。
    var sub = [
        '总场次 ' + (lad.games || 0),
        '均排名 ' + (lad.avgRank == null ? '—' : Number(lad.avgRank).toFixed(1)),
        '冠军 ' + (lad.champs || 0),
    ].join('　·　');
    this.txt(sub, px + 20, sy + 56, BTN_W - 40, 20, LC.gray, 'left');

    // 面板下方留 16 —— 和原来 58 高时的间距一致
    var ry = sy + PH + 16;
    this.drawRankBtn(ry, true);
    this.drawBoardBtn(ry + BTN_H + 16);

    var bw = 200, bh = 54;
    var bx = px + BTN_W - bw, by = ry + BTN_H + 16 + 62 + 16;
    var press = (this._press === 110);
    drawBtn(this._bmp, bx, by, bw, bh, press, press);
    this._bmp.fontSize = 22;
    this._bmp.textColor = press ? LC.edge : LC.text;
    this._bmp.outlineColor = 'rgba(0,0,0,0.8)';
    this._bmp.outlineWidth = 4;
    this._bmp.drawText('退出登录', bx, by + (bh - 28) / 2 + (press ? 2 : 0),
                       bw, 28, 'center');
    this._hits.push({ x: bx, y: by, w: bw, h: bh, i: 110,
                      cb: this.onLadLogout.bind(this) });
};

// 「排行榜」。放在开启排位下方（你定的）。不要求登录 —— 没登录也能看榜，
// 只是看不到自己那一行。
Scene_D678Net.prototype.drawBoardBtn = function (y) {
    var W = Graphics.width;
    var x = Math.round(W / 2 - BTN_W / 2);
    var press = (this._press === 121);
    var h = 62;
    drawBtn(this._bmp, x, y, BTN_W, h, press, press);
    this._bmp.fontSize = 26;
    this._bmp.textColor = press ? LC.edge : LC.text;
    this._bmp.outlineColor = 'rgba(0,0,0,0.8)';
    this._bmp.outlineWidth = 4;
    this._bmp.drawText('天梯排行榜', x, y + (h - 32) / 2 + (press ? 2 : 0),
                       BTN_W, 32, 'center');
    this._hits.push({ x: x, y: y, w: BTN_W, h: h, i: 121,
                      cb: this.onBoard.bind(this) });
};

// 「功能牌图鉴」。和排行榜按钮同宽同高，放在它下方。
Scene_D678Net.prototype.drawCodexBtn = function (y) {
    var W = Graphics.width;
    var x = Math.round(W / 2 - BTN_W / 2);
    var press = (this._press === 122);
    var h = 62;
    drawBtn(this._bmp, x, y, BTN_W, h, press, press);
    this._bmp.fontSize = 26;
    this._bmp.textColor = press ? LC.edge : LC.text;
    this._bmp.outlineColor = 'rgba(0,0,0,0.8)';
    this._bmp.outlineWidth = 4;
    this._bmp.drawText('功能牌图鉴', x, y + (h - 32) / 2 + (press ? 2 : 0),
                       BTN_W, 32, 'center');
    this._hits.push({ x: x, y: y, w: BTN_W, h: h, i: 122,
                      cb: this.onCodex.bind(this) });
};

// 「开启排位」。lit = 亮着（登录且有名字）。没登录也画，只是点不动 ——
// 看不见的按钮等于没告诉玩家「登录之后有东西」。
Scene_D678Net.prototype.drawRankBtn = function (y, lit) {
    var W = Graphics.width;
    var x = Math.round(W / 2 - BTN_W / 2);
    var press = lit && (this._press === 120);
    drawBtn(this._bmp, x, y, BTN_W, BTN_H, press, press);
    this._bmp.fontSize = 32;
    this._bmp.textColor = lit ? (press ? LC.edge : LC.text) : LC.gray;
    this._bmp.outlineColor = 'rgba(0,0,0,0.8)';
    this._bmp.outlineWidth = 4;
    this._bmp.drawText('开启排位', x, y + (BTN_H - 40) / 2 + (press ? 2 : 0),
                       BTN_W, 40, 'center');
    if (!lit) {
        // 【灰字要在按钮下方，不能压在按钮里】原来是 y + BTN_H - 4，
        // 那是按钮底边**往上** 4 像素 —— 字压在按钮内侧，而且字底
        // （y+90）离榜按钮顶（y+92）只剩 2 像素，看着是糊在一起的
        // （你报的第 5 条）。改成按钮下方 6 像素起。
        this.txt('认证登录并设置游戏名后可用', x, y + BTN_H + 6, BTN_W, 16,
                 LC.gray, 'center');
        return;
    }
    this._hits.push({ x: x, y: y, w: BTN_W, h: BTN_H, i: 120,
                      cb: this.onRank.bind(this) });
};

//=============================================================================
// 天梯排行榜
//=============================================================================
//
// 一屏 20 行，前 100 名分 5 页。自己那一行**钉在最上方**（你定的），
// 不在前 100 就显示「未上榜」+ 真实名次，不足 10 局显示「定级中」。

var BOARD_ROWS = 20;

// 五列的 x 和宽。列宽是按最长内容定的：分数 4 位、场次 4 位、
// 均名次 3 字符（2.3）、冠军 3 位。
function boardCols(W) {
    var x0 = 40, w = W - 80;
    return {
        rank:  { x: x0,          w: 70  },
        tier:  { x: x0 + 74,     w: 70  },
        name:  { x: x0 + 150,    w: w - 150 - 330 },
        score: { x: x0 + w - 326, w: 90  },
        games: { x: x0 + w - 232, w: 80  },
        avg:   { x: x0 + w - 148, w: 70  },
        champ: { x: x0 + w - 74,  w: 74  },
    };
}

Scene_D678Net.prototype.drawBoardRow = function (c, y, r, hi) {
    var col = hi ? LC.gold : LC.text;
    // 名次。未上榜时服务器给的 rank 是真实名次（可能 >100），没有就画 —
    this.txt(r.rank == null ? '—' : String(r.rank), c.rank.x, y, c.rank.w, 22,
             hi ? LC.gold : LC.gray, 'center');
    this.txt(r.tier || '', c.tier.x, y, c.tier.w, 22,
             TIER_COL[r.tier] || LC.text, 'center');
    this.txt(r.name || '', c.name.x, y, c.name.w, 22, col, 'left');
    this.txt(String(r.score), c.score.x, y, c.score.w, 22, col, 'right');
    this.txt(String(r.games), c.games.x, y, c.games.w, 22,
             hi ? LC.gold : LC.gray, 'right');
    // 平均排名保留 1 位小数（服务器已经四舍五入过，这里只补 .0）
    this.txt(r.avgRank == null ? '—' : r.avgRank.toFixed(1),
             c.avg.x, y, c.avg.w, 22, hi ? LC.gold : LC.gray, 'right');
    this.txt(String(r.champs), c.champ.x, y, c.champ.w, 22,
             r.champs > 0 ? LC.gold : LC.gray, 'right');
};

Scene_D678Net.prototype.drawBoard = function () {
    var W = Graphics.width, H = Graphics.height;
    var d = this._board;
    if (!d) { this.txt('读取中…', 0, 400, W, 28, LC.gray, 'center'); return; }
    var c = boardCols(W);

    this.txt('天梯排行榜', 0, 40, W, 40, LC.gold, 'center');
    // 赛季标题（你定的：2026年8月赛季，跨月自动变）
    this.txt(d.season || '', 0, 88, W, 26, LC.text, 'center');

    //--- 自己那一行，钉在最上方 -------------------------------------------
    var top = 130;
    if (d.me) {
        this.panel(32, top, W - 64, 62);
        if (d.me.rating) {
            // 不足 10 局：不占榜位，说清还差几局
            this.txt('定级中', c.rank.x, top + 20, c.rank.w, 22, LC.gray, 'center');
            this.txt(d.me.tier || '', c.tier.x, top + 20, c.tier.w, 22,
                     TIER_COL[d.me.tier] || LC.text, 'center');
            this.txt((d.me.name || '我') + '  还需 ' + d.me.need + ' 局定级',
                     c.name.x, top + 20, c.name.w, 22, LC.gold, 'left');
            this.txt(String(d.me.score), c.score.x, top + 20, c.score.w, 22,
                     LC.gold, 'right');
            this.txt(String(d.me.games), c.games.x, top + 20, c.games.w, 22,
                     LC.gray, 'right');
        } else {
            this.drawBoardRow(c, top + 20, d.me, true);
            if (!d.me.onBoard) {
                this.txt('未上榜', c.name.x + c.name.w - 80, top + 20, 80, 20,
                         LC.red, 'right');
            }
        }
    } else {
        this.panel(32, top, W - 64, 62);
        this.txt('登录天梯账号后可以看到自己的排名', 32, top + 20, W - 64, 22,
                 LC.gray, 'center');
    }

    //--- 表头 -------------------------------------------------------------
    // 【表头和榜身的框要留够间距】原来表头在 top+78、榜身框从 top+100 起，
    // 而 this.txt 的实际绘制高度是 size+10（=28）—— 表头字底压到 top+106，
    // 比框顶低 6 像素，看着就是灰字和框叠在一起（你报的第 6 条）。
    var hy = top + 76;
    this.txt('名次', c.rank.x,  hy, c.rank.w,  18, LC.gray, 'center');
    this.txt('段位', c.tier.x,  hy, c.tier.w,  18, LC.gray, 'center');
    this.txt('玩家', c.name.x,  hy, c.name.w,  18, LC.gray, 'left');
    this.txt('天梯分', c.score.x, hy, c.score.w, 18, LC.gray, 'right');
    this.txt('场次', c.games.x, hy, c.games.w, 18, LC.gray, 'right');
    this.txt('均排名', c.avg.x, hy, c.avg.w,   18, LC.gray, 'right');
    this.txt('冠军', c.champ.x, hy, c.champ.w, 18, LC.gray, 'right');

    //--- 榜身 -------------------------------------------------------------
    // 框顶要在表头字底（hy + 28）之下
    var y0 = hy + 40, rowH = 26;
    this.panel(32, y0 - 8, W - 64, BOARD_ROWS * rowH + 14);
    var pg = this._boardPage || 0;
    var rows = d.rows || [];
    var myName = (d.me && d.me.name) || '';
    if (!rows.length) {
        // 【赛季初的空窗】上榜门槛看的是**本赛季**场次（2026-08-07 你定的：
        // 每赛季重新爬一次才有动力），所以每月 1 号头十几个小时确实一个人都
        // 没满 10 局 —— 实测 9/1 当天 0 行、第 1 天 49 行、第 3 天满。
        // 空着一个框比说清楚更像坏了，所以画两行灰字。
        var cy = y0 + (BOARD_ROWS * rowH) / 2 - 34;
        this.txt('新赛季刚开始，所有人都在定级中', 32, cy, W - 64, 22,
                 LC.gray, 'center');
        // 10 这个数和上面「不足 10 局显示定级中」的注释同一个来源
        // （服务器的 LAD_MINGAMES）。客户端没有这个常量，沿用本文件的惯例写死。
        this.txt('（满 10 局上榜）', 32, cy + 34, W - 64, 20, LC.gray, 'center');
    }
    for (var i = 0; i < BOARD_ROWS; i++) {
        var r = rows[pg * BOARD_ROWS + i];
        if (!r) break;
        this.drawBoardRow(c, y0 + i * rowH, r, r.name === myName);
    }

    //--- 分页 + 返回 ------------------------------------------------------
    var pages = Math.max(1, Math.ceil(rows.length / BOARD_ROWS));
    var by = y0 + BOARD_ROWS * rowH + 24;
    var bw = 130, bh = 54, gap = 16;
    var self = this;
    var mk = function (label, i, x, on, cb) {
        var press = on && (self._press === i);
        drawBtn(self._bmp, x, by, bw, bh, press, press);
        self._bmp.fontSize = 24;
        self._bmp.textColor = on ? (press ? LC.edge : LC.text) : LC.gray;
        self._bmp.outlineColor = 'rgba(0,0,0,0.8)';
        self._bmp.outlineWidth = 4;
        self._bmp.drawText(label, x, by + (bh - 30) / 2 + (press ? 2 : 0),
                           bw, 30, 'center');
        if (on) self._hits.push({ x: x, y: by, w: bw, h: bh, i: i, cb: cb });
    };
    var totalW = bw * 3 + gap * 2;
    var sx = Math.round(W / 2 - totalW / 2);
    mk('上一页', 200, sx, pg > 0, function () {
        self._boardPage = Math.max(0, (self._boardPage || 0) - 1);
        self.refresh();
    });
    // 中间那格不是按钮，写页码
    this.txt((pg + 1) + ' / ' + pages, sx + bw + gap, by + 14, bw, 26,
             LC.text, 'center');
    mk('下一页', 201, sx + (bw + gap) * 2, pg < pages - 1, function () {
        self._boardPage = Math.min(pages - 1, (self._boardPage || 0) + 1);
        self.refresh();
    });

    var rx = Math.round(W / 2 - 110);
    this.panel(rx, by + bh + 18, 220, 56);
    this.txt('返回', rx, by + bh + 33, 220, 26, LC.text, 'center');
    this._hits.push({ x: rx, y: by + bh + 18, w: 220, h: 56, i: -1,
                      cb: this.onBack.bind(this) });
};

Scene_D678Net.prototype.ladBtnCb = function (key) {
    var self = this;
    return function () {
        if (key === 'edit')    { self.onLadEdit(); return; }
        if (key === 'auth')    { self.onLadAuth(); return; }
        if (key === 'reg')     { self.onLadReg(); return; }
        if (key === 'setname') { self.onLadSetName(); return; }
    };
};

// 天梯匹配中。黑屏 + (N/8 匹配中) + 总计时 + 排行榜按钮（你定的）。
//
// 【计数是服务器给的假计数】不真的一个一个把 AI 加进房。真人在这段窗口里
// 进来会占真实席位，计数取「假计数和真人数的较大者」，所以不会出现
// 「3 个真人进来了界面还写 2/8」。
Scene_D678Net.prototype.drawLadMatching = function (info) {
    var W = Graphics.width, H = Graphics.height;
    var f = info.ladFill || { shown: 1, total: 8, elapsed: 0 };

    // 整屏压黑 —— 匹配中就该是一块干净的黑屏（你定的）
    var ctx = this._bmp._context;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.88)';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    this._bmp._setDirty();

    this.txt('天梯排位', 0, 150, W, 40, LC.gold, 'center');

    // (N/8 匹配中)
    this.txt('（' + f.shown + '/' + f.total + ' 匹配中）', 0, 300, W, 56,
             LC.text, 'center');

    // 总计时。算法收在 ladFillSec()（updateLadClock 每秒靠它判断该不该重画，
    // 两处必须用同一份）。
    var sec = this.ladFillSec();
    this.txt('已匹配 ' + Math.floor(sec / 60) + ':' +
             ('0' + (sec % 60)).slice(-2), 0, 372, W, 30, LC.gray, 'center');

    // 进度条：8 格，占几格就亮几格
    var cw = 46, ch = 10, cg = 10;
    var totW = f.total * cw + (f.total - 1) * cg;
    var cx = Math.round(W / 2 - totW / 2), cy = 428;
    for (var i = 0; i < f.total; i++) {
        var on = i < f.shown;
        ctx.save();
        roundRect(ctx, cx + i * (cw + cg), cy, cw, ch, 4);
        ctx.fillStyle = on ? LC.gold : 'rgba(255,255,255,0.18)';
        ctx.fill();
        ctx.restore();
    }
    this._bmp._setDirty();

    this.txt('正在等待其他玩家加入', 0, 462, W, 22, LC.gray, 'center');

    // 排行榜按钮（你定的：等的时候有东西可看）
    this.drawBoardBtn(516);

    // 功能牌图鉴按钮
    this.drawCodexBtn(516 + 62 + 16);

    // 取消匹配
    var bw = 220, bh = 56;
    var bx = Math.round(W / 2 - bw / 2), by = 516 + 62 + 16 + 62 + 20;
    var press = (this._press === 130);
    drawBtn(this._bmp, bx, by, bw, bh, press, press);
    this._bmp.fontSize = 24;
    this._bmp.textColor = press ? LC.edge : LC.text;
    this._bmp.outlineColor = 'rgba(0,0,0,0.8)';
    this._bmp.outlineWidth = 4;
    this._bmp.drawText('取消匹配', bx, by + (bh - 30) / 2 + (press ? 2 : 0),
                       bw, 30, 'center');
    // 取消匹配走 onBack 的 waiting 分支：它会发 /api/leave 摘掉席位、
    // 清会话、退回天梯页。单独写一个 onLeave 等于把那套逻辑抄第二份。
    this._hits.push({ x: bx, y: by, w: bw, h: bh, i: 130,
                      cb: this.onBack.bind(this) });
};

Scene_D678Net.prototype.drawDuel = function () {
    // 在线信息占 288~348（两行），所以标题从 MENU_TITLE_Y=360 起 ——
    // 原来是 336，和天梯那一行重叠了（见 ONLINE_Y 那段注释）
    this.txt('单人对决', 0, MENU_TITLE_Y, Graphics.width, 30, LC.gold, 'center');
    this.buttons([
        { label: '建立房间', cb: this.onCreate.bind(this) },
        { label: '加入房间', cb: this.onJoinPrompt.bind(this) },
    ], MENU_TITLE_Y + 64);
};

Scene_D678Net.prototype.drawWaiting = function () {
    var W = Graphics.width;
    var info = this._roomInfo;
    if (!info) { this.txt('连接中…', 0, 400, W, 28, LC.gray, 'center'); return; }

    // 【天梯匹配页要在 seats 判断之前】它压根不读 seats（界面上是假计数，
    // 不列席位），而下面那条 `!info.seats` 会把它导到「正在恢复」页上去。
    // _resuming 仍然优先：那时候连 ladder 标记都还没到（/api/resume 只回
    // room/phase/mySeat），该显示恢复中。
    if (!this._resuming && info.ladder) { this.drawLadMatching(info); return; }

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

    this.drawLadDelta(e.lad, top + panelH + 14);
};

// 天梯加减分那一行（你定的：整场结束后显示 -30 / +12 这样）。
// 只有天梯局才有 lad，锦标赛这里是 undefined，整块不画。
Scene_D678Net.prototype.drawLadDelta = function (lad, y) {
    if (!lad) return;
    var W = Graphics.width;
    var d = lad.delta;
    var sign = (d > 0 ? '+' : '');
    this.panel(50, y, W - 100, 62);
    // 涨分金、掉分红 —— 不用绿色，绿在这套界面里是「有人在等你」的意思
    this.txt('天梯分 ' + sign + d, 74, y + 16, 200, 30,
             d >= 0 ? LC.gold : LC.red, 'left');
    this.txt(lad.tier + '  ' + lad.score + ' 分',
             W - 74 - 300, y + 18, 300, 26, TIER_COL[lad.tier] || LC.text, 'right');
    if (lad.quit) {
        this.txt('中途退出按末名结算', 74, y + 40, W - 148, 18, LC.red, 'left');
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
        // 名次那半句用昵称 —— 这一行左半是「冠军：某某」，右半写「你」就是
        // 两套人称（多人一律昵称，见 678.js 的 dispName）。上面那句大字
        // 「你是本届冠军！」是对我说的话，不是名字栏，照旧留第二人称。
        var myName = (myRank && list[myRank - 1]) ? list[myRank - 1].name : '';
        this.txt('冠军：' + list[0].name +
                 (myRank ? ('　　' + (myName || '你') + '：第 ' + myRank + ' 名') : ''),
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

    this.drawLadDelta(o.lad, 372 + 12 + list.length * 34 + 14);
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
    this.updateLadClock();
    this.updateInput();
};

// 天梯匹配页的总计时要每秒自己走一遍（你报的）。
//
// 【为什么原来会卡住】drawLadMatching 里那段本地补齐（_ladFillMs +
// 从收到起走了多久）算得是对的，但**没人触发重画** —— refresh() 只在收到
// 消息、点按钮这些时刻调。于是「已匹配 0:07」一直停着，直到下一个假人进来
// 推一份 room 消息才跳一大截。看起来就是「时间一段一段地变」。
//
// 【为什么不每帧 refresh】refresh() 要重画整屏（含 100 行的榜、进度条），
// 60fps 全量重画白烧。和对局里的 netTickClock 同一套办法：只在**显示出来的
// 那个秒数**变了的时候重画。
Scene_D678Net.prototype.updateLadClock = function () {
    var info = this._roomInfo;
    if (this._page !== 'waiting' || this._resuming || !info || !info.ladder) {
        this._ladClockShown = -1;
        return;
    }
    var sec = this.ladFillSec();
    if (sec !== this._ladClockShown) {
        this._ladClockShown = sec;
        this.refresh();
    }
};

// 匹配已经过了几秒。服务器每条 room 消息带 elapsed，两条之间用本地时钟补齐
// —— 否则数字只在服务器推消息时才跳（假计数最长能隔一分钟不动）。
//
// _ladFillMs / _ladFillAt 是「服务器说过的那个值」和「收到它的时刻」，
// 在 pollNet 收 room 消息时记下。当前值 = 那个值 + 从那时起走了多久。
//
// 【收在一个函数里】drawLadMatching 要用它画，updateLadClock 要用它判断
// 该不该重画 —— 两处算法必须是同一份，各写一遍就会出现「画的是 8 秒、
// 判断用的是 7 秒」这种自己跟自己不同步。
Scene_D678Net.prototype.ladFillSec = function () {
    var info = this._roomInfo;
    var f = (info && info.ladFill) || null;
    var ms = (f && f.elapsed) || 0;
    if (this._ladFillAt) {
        ms = Math.max(ms, (this._ladFillMs || 0) + (Date.now() - this._ladFillAt));
    }
    return Math.floor(ms / 1000);
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
        // 天梯：把结算回来的分补进登录态，否则回「开启排位」界面显示的还是
        // 打之前那个分
        if (b.over.lad) D678N.applyLadResult(b.over.lad);
        b.over = null;
        this._page = 'ranks';
        this.refresh();
        return;
    }

    // 天梯中途退出：不会有 over / eliminated（退出的人不再收赛事消息），
    // 但分已经结算了。停在当前页弹一句，让他知道扣了多少。
    if (b.ladscore) {
        var ls = b.ladscore;
        b.ladscore = null;
        this.notice('天梯分 ' + (ls.delta > 0 ? '+' : '') + ls.delta +
                    '，当前 ' + ls.score + ' 分（' + ls.tier + '）');
        this.refresh();
    }

    if (b.room) {
        var r = b.room;
        b.room = null;
        this._roomInfo = r;
        D678N.Net.room = r.room;
        D678N.Net.mySeat = r.mySeat;
        // 天梯匹配的总计时：记下服务器说的那个值和收到它的时刻，
        // 两条消息之间用本地时钟补齐（见 drawLadMatching）
        if (r.ladFill) {
            this._ladFillMs = r.ladFill.elapsed || 0;
            this._ladFillAt = Date.now();
        }
        // 淘汰后停在名次页 / 排名页，别被房间消息拽回等待页 —— pushRoom 是
        // 发给所有座位的（包括已淘汰的），别人一掉线就会推一份，
        // 不加这个判断淘汰画面会被冲掉。
        // 【榜页同理】在匹配中点开榜，别人一进房推一份 room 就把榜冲掉了
        if (this._page !== 'waiting' && this._page !== 'board' &&
            this._page !== 'elim' && this._page !== 'ranks') {
            this._page = 'waiting';
        }
        // lobby 阶段恢复：没有盘面会来，收掉「正在恢复」显示正常的等待页。
        // 其余阶段继续挂着，等下面那份 resync 盘面把我们推进对局场景。
        if (this._resuming && r.phase === 'lobby') this._resuming = false;
        // 【在榜页时不重画】重画会把榜换成等待页。只跳过这一次重画 ——
        // 下面「第一份盘面到了就进对局场景」那段必须照跑，否则匹配中开着榜
        // 就永远进不去对局。
        if (this._page !== 'board') this.refresh();
    }

    // 第一份盘面到了就进对局场景（盘面**留在队列里**，由那边取用）。
    // 淘汰后不再进 —— 服务器本来就不给已淘汰的座位推盘面（pushStateT 跳过
    // left 的人），这里是第二道锁。
    if (b.states.length && !this._leaving &&
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

//--- 天梯 ------------------------------------------------------------------

Scene_D678Net.prototype.onLadder = function () {
    this._page = 'ladder';
    this._ladReg = false;
    // 有令牌就问一次 /api/lad/me。
    //
    // 【为什么每次都问，不只在 !D678N.lad 时问】原来是「已经登录着就跳过」，
    // 于是内存里那份旧分会一直挂在「开启排位」界面上，直到退出登录重进或者
    // 关标签页（你报的「分要好久才刷新」的另一半）。进这一页是低频操作，
    // 多一个请求换「进来看到的一定是最新分」值得。
    //
    // 【已经登录时不要置 _busy】那会让界面闪成「加载中」再跳回来。有旧值就
    // 先照旧画，请求回来了再刷一次 —— 观感上就是数字自己更新了一下。
    var tk = D678N.ladToken();
    if (tk) {
        var self = this;
        var had = !!D678N.lad;
        if (!had) this._busy = true;
        this.refresh();
        D678N.Net.post('/api/lad/me', { token: tk }, function (r, code) {
            self._busy = false;
            if (r && code === 200 && r.ok) D678N.setLadFrom(r);
            else if (!had) D678N.setLadToken('');   // 服务器重启过，令牌没了
            else if (code === 401) {
                // 登录着但令牌失效了（服务器重启）：清干净回登录页，
                // 别让界面装作还登录着
                D678N.setLadToken('');
                D678N.setLadFrom(null);
            }
            self.syncLadForm();
            self.refresh();
        });
        return;
    }
    this.syncLadForm();
    this.refresh();
};

// 表单该开哪一套 / 该关掉。每次页面或步骤变了都调一次。
Scene_D678Net.prototype.syncLadForm = function () {
    if (this._page !== 'ladder') { D678N.LadForm.close(); return; }
    var stage = D678N.ladStage();
    if (stage === 'ready') { D678N.LadForm.close(); return; }
    D678N.LadForm.open(stage, !!this._ladReg);
};

// 「输入」按钮：把这一步该填的几栏依次问一遍。中途按取消就停在那儿，
// 已经答过的留着 —— 别因为最后一栏取消了把前面的也清掉。
//
// 用 window.prompt 而不是画布上的输入框：浏览器自己的输入框，中文输入法、
// 手机键盘、粘贴全都天然正常（房号那边一直就是这么做的）。
Scene_D678Net.prototype.onLadEdit = function () {
    var F = D678N.LadForm;
    if (!F.live()) return;
    var ks = F.keys();
    for (var i = 0; i < ks.length; i++) {
        var k = ks[i];
        var s = window.prompt(LAD_ASK[k], F.shown(k) ||
                              (k === 'acc' ? D678N.lastAcc() : ''));
        if (s === null) break;         // 取消：停下，前面答过的保留
        F.set(k, s);
    }
    this.refresh();
};

// 每栏的问法。写清位数和字符范围 —— prompt 没有占位说明那一行
var LAD_ASK = {
    acc:  '输入账号（4-16 位字母或数字）',
    pw:   '输入密码（4-16 位，请勿使用你在其他地方用的密码）',
    pw2:  '再输一次密码',
    name: '输入天梯游戏名（4-8 位汉字、字母或数字）',
};

Scene_D678Net.prototype.onLadAuth = function () {
    var v = D678N.LadForm.values();
    // 还没填就先问一遍 —— 直接点「认证」的人不该只得到一句「都要填」
    if (!v.acc || !v.pw) {
        this.onLadEdit();
        v = D678N.LadForm.values();
    }
    if (!v.acc || !v.pw) { this.notice('账号和密码都要填'); this.refresh(); return; }
    var self = this;
    this._busy = true;
    D678N.Net.post('/api/lad/auth', { acc: v.acc, pw: v.pw }, function (r, code) {
        self._busy = false;
        if (!r || code !== 200 || !r.ok) {
            self.notice((r && r.err) || '认证失败，服务器没响应');
            D678N.LadForm.clearPw();
            self.refresh();
            return;
        }
        D678N.setLadToken(r.token);
        D678N.setLastAcc(r.acc);
        D678N.setLadFrom(r);
        self._ladReg = false;
        self.syncLadForm();
        self.refresh();
    });
};

// 第一次点「注册」展开「确认密码」那一栏并当场问一次；再点「确认注册」
// 才真的提交。这就是你说的「点击注册后会让对方再次输入密码确认」。
Scene_D678Net.prototype.onLadReg = function () {
    var F = D678N.LadForm;
    if (!this._ladReg) {
        this._ladReg = true;
        this.syncLadForm();
        var v0 = F.values();
        // 账号密码还没填就三栏一起问；填了就只问确认密码那一栏
        if (!v0.acc || !v0.pw) {
            this.onLadEdit();
        } else {
            F.set('pw2', window.prompt(LAD_ASK.pw2, ''));
        }
        this.refresh();
        return;
    }
    var v = D678N.LadForm.values();
    if (!v.acc || !v.pw) { this.notice('账号和密码都要填'); this.refresh(); return; }
    if (!v.pw2) { this.notice('请再输一次密码确认'); this.refresh(); return; }
    if (v.pw !== v.pw2) {
        this.notice('两次输入的密码不一样');
        this.refresh();
        return;
    }
    var self = this;
    this._busy = true;
    D678N.Net.post('/api/lad/reg', { acc: v.acc, pw: v.pw }, function (r, code) {
        self._busy = false;
        if (!r || code !== 200 || !r.ok) {
            self.notice((r && r.err) || '注册失败，服务器没响应');
            self.refresh();
            return;
        }
        // 注册成功直接就是登录态（服务器一并发了令牌），跳到起名那一步
        D678N.setLadToken(r.token);
        D678N.setLastAcc(r.acc);
        D678N.setLadFrom(r);
        self._ladReg = false;
        self.syncLadForm();
        self.notice('注册成功，接下来设置游戏名');
        self.refresh();
    });
};

Scene_D678Net.prototype.onLadSetName = function () {
    var v = D678N.LadForm.values();
    if (!v.name) {                       // 直接点「确定」的人先问一遍
        this.onLadEdit();
        v = D678N.LadForm.values();
    }
    if (!v.name) { this.notice('名字不能为空'); this.refresh(); return; }
    this.postLadName(v.name);
};

// 「修改」按钮：ready 那一步没有输入框，用原生 prompt 拿一次就够 ——
// 改名是偶发操作，为它常驻一个输入框会把这一页塞满。
Scene_D678Net.prototype.onLadRename = function () {
    if (!D678N.lad) return;
    if (!D678N.lad.canRename) {
        this.notice('每天只能修改一次');
        this.refresh();
        return;
    }
    var s = window.prompt('输入游戏名（4-8 位汉字、字母或数字）',
                          D678N.lad.name || '');
    if (s === null) return;
    s = String(s).trim();
    if (!s) { this.notice('名字不能为空'); this.refresh(); return; }
    this.postLadName(s);
};

Scene_D678Net.prototype.postLadName = function (name) {
    var self = this;
    this._busy = true;
    D678N.Net.post('/api/lad/name',
        { token: D678N.ladToken(), name: name }, function (r, code) {
        self._busy = false;
        if (code === 401) { self.onLadExpired(); return; }
        if (!r || code !== 200 || !r.ok) {
            self.notice((r && r.err) || '设置失败，服务器没响应');
            // 被拒时服务器会把当前状态一起回来（canRename 可能变了）
            if (r && r.acc) D678N.setLadFrom(r);
            self.refresh();
            return;
        }
        D678N.setLadFrom(r);
        self.syncLadForm();
        self.refresh();
    });
};

// 令牌失效（服务器重启过）。别装作还登录着 —— 回登录页重新认证。
Scene_D678Net.prototype.onLadExpired = function () {
    D678N.setLadToken('');
    D678N.lad = null;
    this._ladReg = false;
    this.syncLadForm();
    this.notice('登录已失效，请重新认证');
    this.refresh();
};

Scene_D678Net.prototype.onLadLogout = function () {
    D678N.setLadToken('');
    D678N.lad = null;
    this._ladReg = false;
    this.syncLadForm();
    this.refresh();
};

// 开启排位。服务器找一个还在攒人的天梯房，没有就建一个 ——
// 同一个匹配窗口里点的真人会进同一桌（服务器那边的 findLadderRoom）。
Scene_D678Net.prototype.onRank = function () {
    if (!D678N.ladToken()) { this.notice('请先登录天梯账号'); this.refresh(); return; }
    var self = this;
    this._busy = true;
    D678N.Net.post('/api/lad/match', { token: D678N.ladToken() }, function (r, code) {
        self._busy = false;
        if (!r || code !== 200) {
            self.notice((r && r.err) || '匹配失败，服务器没响应');
            self.refresh();
            return;
        }
        D678N.setSession({ sid: r.sid, room: r.room });
        D678N.Net.mySeat = r.mySeat;
        D678N.Net.connect(r.sid);
        // 总计时以服务器那份为准（room 消息里的 ladFill.elapsed），
        // 本地只在两条消息之间补齐 —— 见 drawLadMatching。
        // 重复点匹配时服务器回的是原来那个房间，elapsed 从建房算起，对的。
        self._ladFillMs = 0;
        self._ladFillAt = 0;
        self._page = 'waiting';
        self.refresh();
    });
};

// 功能牌图鉴。直接推场景，不需要网络请求。
Scene_D678Net.prototype.onCodex = function () {
    SceneManager.push(Scene_FuncCodex);
};

// 排行榜。不要求登录 —— 匹配中也能看（你定的：等的时候有东西可做）。
// 记住从哪一页来的，看完能回去。
Scene_D678Net.prototype.onBoard = function () {
    var self = this;
    this._boardBack = this._page;
    this._busy = true;
    D678N.Net.post('/api/lad/board', { token: D678N.ladToken() || '' },
    function (r, code) {
        self._busy = false;
        if (!r || code !== 200) {
            self.notice((r && r.err) || '排行榜读取失败');
            self.refresh();
            return;
        }
        self._board = r;
        self._boardPage = 0;
        self._page = 'board';
        self.refresh();
    });
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
// 开赛的信号是第一份盘面到达（pollNet 里那条 b.states）。
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
    // 排行榜：回到进来时那一页。**绝不能顺手清会话** —— 匹配中点开榜再返回
    // 要还在匹配里（服务器那边席位一直占着，清了就变成「界面回菜单但服务器
    // 还在给我攒人」，开赛时没人接盘面）。
    if (this._page === 'board') {
        this._board = null;
        this._page = this._boardBack || 'ladder';
        this._boardBack = null;
        this.refresh();
        return;
    }
    // 淘汰等待页 / 最终排名页：赛事跟我已经没关系了，直接清会话回子页。
    // 不发 /api/leave —— 服务器那边我早就是 left 了，再发一次没有意义。
    if (this._page === 'elim' || this._page === 'ranks') {
        var wasLad = !!(D678N.finalOver && D678N.finalOver.ladder) ||
                     !!(D678N.elim && D678N.elim.lad);
        D678N.elim = null;
        D678N.finalOver = null;
        D678N.Net.reset();
        // 天梯打完退回天梯页（想再排一局少点两下），锦标赛回锦标赛子页
        this._page = wasLad ? 'ladder' : 'tourney';
        this._roomInfo = null;
        if (wasLad) this.syncLadForm();
        this.refresh();
        return;
    }
    if (this._page === 'waiting') {
        // 已经建/进了房，退出要通知服务器（1v1 关房间，锦标赛只摘席位）
        if (D678N.Net.sid) D678N.Net.post('/api/leave', { sid: D678N.Net.sid }, null);
        var wasTourney = !!(this._roomInfo && this._roomInfo.mode === 'tourney');
        var wasLadder = !!(this._roomInfo && this._roomInfo.ladder);
        D678N.Net.reset();
        // 锦标赛退回子页而不是主菜单 —— 想再匹配一次少点一下。
        // 天梯退回天梯页（那儿才有「开启排位」）。
        this._page = wasLadder ? 'ladder' : (wasTourney ? 'tourney' : 'menu');
        this._roomInfo = null;
        this._ladFillAt = 0; this._ladFillMs = 0;
        if (wasLadder) this.syncLadForm();
        this.refresh();
        return;
    }
    // 天梯退回锦标赛子页（它是从那儿进来的）。登录态**不清** ——
    // 出去看一眼再回来还要重输一遍账号密码太烦。表单要收掉，
    // 不然那几个 DOM 输入框会浮在别的页面上。
    if (this._page === 'ladder') {
        D678N.LadForm.close();
        this._ladReg = false;
        this._page = 'tourney';
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
    // 场景走了 DOM 浮层必须跟着走，否则那几个输入框会一直浮在标题画面
    // 和牌桌上（它们挂在 document.body 上，不受场景树管）
    D678N.LadForm.close();
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
    this._netBank     = null;    // 思考池快照 {left:[我,对手], turn}（天梯）
    this._netBankAt   = 0;
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
    // 还在打的那几桌是谁跟谁（服务器算好的，一桌一条 {a, b, mine}）。
    // 等待画面按「AA vs BB」一行一桌画 —— 见 netStillPairs。
    if (m.busyPairs !== undefined) this._netBusyPairs = m.busyPairs || [];
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

    // 思考池（天梯）。和 turnLeft 同一套：存收到时的快照 + 收到的时刻，
    // 本地推算，不碰服务器时钟。
    if (m.bank !== undefined) {
        this._netBank = m.bank || null;
        this._netBankAt = Date.now();
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

    // 重抽的完整动画（旧牌飞回牌库 + 新牌入场）。
    //
    // 【为什么要服务器告诉我】新牌的 uid 变了，所以它会自然重新入场 ——
    // 但那只有「飞进来」没有「收回去」，看着像牌凭空闪了一下，玩家最常反馈的
    // 就是「用了重抽好像没反应」。收牌那一半需要知道洗回去的是哪个数字，
    // 那个信息只有服务器有。
    //
    // 发的是**新牌的 uid** 而不是 side —— extra 对所有座位是同一份、没法按人
    // 镜像，而我恒把自己当 side 0。按 uid 在自己那份盘面里找就免疫镜像问题。
    if (m.repick && this._battle) {
        this.netRepickFx(m.repick);
    }

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
        // 【必须重置这两个】resolveId 在锦标赛里是**每桌独立**的，新一轮换了桌
        // 就从 0 重新数 —— 第一轮我那桌是 bt#0 数到 1，第二轮我那桌是 bt#1，
        // 也会数到 1。不重置的话「同一次结算不重播」那道判断会把第二轮的结算
        // 误认成第一轮那次，onBattleEnd 整个跳过：**拼点画面从第二轮起再也
        // 不出现**（第一轮正常，所以看着像「偶尔显示 1-2 次」）。
        // preFuncs 的判断同理。
        this._netPlayedResolve = 0;
        this._netPreApplied = 0;
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
        // 【保护期】演出期间来的 fresh 会把演出打断（m.fresh 分支在落定守卫
        // 之前，无条件把 _phase 打回 battle），所以必须压住。
        // onBattleEnd 刚把 _wait 设成演出长度（普通 150 / 满点 200 / 平局 100 帧）。
        //
        // 早结束的人再多留 LOG_DWELL 帧，保证日志页真的看得见。
        //
        // 【为什么必须多留】演出 2.5 秒比服务器的推进延迟（advanceMs，默认 2 秒）
        // 长。实测：我这桌 5183ms 结算、最后一桌 5437ms 结算，只差 254ms ——
        // fresh 在我演出还没走完时就到了，保护期和 _wait 同一帧归零，
        // 先释放 fresh 把阶段切成 battle，netFinish 那一支就轮不到，
        // **日志页 0 帧**。只有最慢那桌比我晚 0.5 秒以上才碰巧看得到，
        // 所以症状是「时有时无」。
        //
        // 最后一桌（waitingRound 为 false）一帧都不多留 —— 他停留就是在拖着
        // 所有人，这是你定的。两种情况就靠这一个判断分流。
        var dwell = this._netWaitRound ? D678N.LOG_DWELL : 0;
        this.netHold((this._wait || 0) + dwell);
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

    // 【队列要一份一份排完，不能只取最新那份】
    //
    // 盘面里带着 fresh / resolved 这类一次性事件标记，而服务器常在同一帧内
    // 连推好几份（实测 fresh 和后面两份普通状态只差 5 毫秒）。只取最新的话
    // 那个标记就丢了，客户端不知道新一轮开始，卡在上一轮的画面上。
    //
    // 一帧里排完好几份是安全的：
    //   · 结算 -> netApply 起展示保护期，后面那几份被压进 _netPending，不会
    //     把演出打断
    //   · 同一次结算重复推 -> resolveId 那道判断挡住，不重播演出
    //   · 都是普通状态 -> 最后一份决定画面，中间几份只是白算一遍
    if (b.states.length) {
        var q = b.states;
        b.states = [];
        for (var si = 0; si < q.length; si++) this.netApply(q[si]);
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
        // 【天梯：淘汰这条路也要更新分数】服务器发 eliminated 时是带 lad 的
        // （见 server.js 的 outSeats 那段），但这里原来只存了整份 elim，
        // 没把分数补进登录态。而天梯里被淘汰的人**收不到 over**：淘汰那一刻
        // 客户端 Net.reset()、服务器也主动收掉 SSE。所以对没赢的那 7 个人来说
        // 「打完一局」走的就是这条路 —— 漏掉这一句，「开启排位」界面上的分
        // 会一直是打之前那个值（你报的「分要好久才刷新」）。
        if (b.elim.lad) D678N.applyLadResult(b.elim.lad);
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

// 思考池的两个数（天梯）。返回 {turn, pool, active} —— turn 是本回合还能想
// 几秒，pool 是整场还剩几秒，两个一起减（你定的：15/60 -> 12/57 -> 5/50）。
// active 为 true 表示回合时限已经烧完、正在动用池子。
//
// 【为什么两个数一起减】它们是同一段时间的两种口径：本回合已经想了 3 秒，
// 那么本回合的额度和整场的总量都各少 3 秒。分开减（比如池子只在回合结束时
// 才扣）会让玩家看到「想了 10 秒，池子一动不动」，反而像坏了。
//
// si 是要看哪一侧：0 = 我，1 = 对手（服务器按 [我, 对手] 发，见 pushStateT）。
Scene_D678.prototype.netBankSec = function (si) {
    var bk = this._netBank;
    if (!bk || !bk.left) return null;
    var pool = bk.left[si] || 0;
    var acting = (si === this._netBankSide());

    // 【本回合额度不能直接用 bk.turn】那个数只属于当前行动方。给非行动方
    // 画的话，对手回合时我这一行会显示**对手的**额度 —— 两行数字一样，
    // 看起来像自己的池子在对手回合被扣。非行动方按 min(上限, 池子) 自己算。
    var turnMs = acting ? (bk.turn || 0)
                        : Math.min(bk.cap || 0, pool);

    var over = 0;
    if (acting && turnMs > 0) {
        // 「回合时限烧完之后又过了多久」。两个快照来自同一条消息
        // （见 onState 里 turnLeft / bank 相邻那两段），所以用同一个起点算。
        over = (Date.now() - (this._netBankAt || Date.now()))
             - (this._netTurnLeft || 0);
        if (over < 0) over = 0;
        if (over > turnMs) over = turnMs;
    }
    return {
        turn: Math.max(0, Math.ceil((turnMs - over) / 1000)),
        pool: Math.max(0, Math.ceil((pool - over) / 1000)),
        active: over > 0,
    };
};

// 现在轮到哪一侧（镜像后 0 永远是我）。没有牌面时返回 -1。
Scene_D678.prototype._netBankSide = function () {
    var b = this._battle;
    return (b && !b.finished) ? b.turn : -1;
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
    // 【思考池也要进这个指纹】netTurnSec 在池子那一段恒等于 0 —— 只看它的话
    // 「思考时间 12/57」画出来就再也不动了，玩家会以为界面卡住。
    // 把两侧的秒数一起混进去，任一个变了就重画。
    if (this._phase === 'battle' && this._netBank) {
        var mb = this.netBankSec(0), ob = this.netBankSec(1);
        if (mb) show = show * 1000 + mb.turn * 100 + (mb.pool % 100);
        if (ob) show = show * 1000 + ob.turn * 100 + (ob.pool % 100);
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
        // 胜者一律写昵称（多人口径，见 678.js 的 dispName）：负的时候这里写的是
        // 对手昵称，赢的时候写「你」就成了两套称呼
        ('胜者：' + (o.win ? (me.name || '你') : op.name)),
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
        // 名次行也写昵称：紧贴上面那行「冠军：某某」，写「我的名次」是两套人称
        (me.name || '我') + '：第 ' + (o.myRank || 0) + ' 名 / 共 ' + o.ranks.length + ' 人',
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

// 联机下播重抽的完整动画。
//
// 服务器发的是新牌的 uid（不是 side）—— 在自己那份**已镜像**的盘面里找它属于
// 哪一排，这样不管是我重抽还是对手重抽都能定位对。找不到就不播，
// 不至于因为一次动画把别的事情搞坏。
Scene_D678.prototype.netRepickFx = function (rp) {
    var b = this._battle;
    if (!b || !rp || !rp.uid) return;
    for (var si = 0; si < 2; si++) {
        var cards = b.sides[si].cards;
        if (!cards.length) continue;
        // 重抽的新牌一定在末尾（doDraw 是 push）
        if (cards[cards.length - 1].uid === rp.uid) {
            this.redealCard(si, rp.oldValue);
            return;
        }
    }
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
        // r.fail 是服务器的 failNote，内容就是失败原因（抽号牌 / 复制各不相同）
        if (r.fail) self.notice('失败：' + (typeof r.fail === 'string' ? r.fail : '无法使用'));
        self.refresh();
    });
};

// 二选一的选择：联机不能本地结算（那等于让客户端决定抽到哪张牌），
// 只把选了哪个下标发上去，服务器改盘面再推回来。
var _p2c = Scene_D678.prototype.pick2Commit;
Scene_D678.prototype.pick2Commit = function (idx) {
    if (!this._net) { _p2c.call(this, idx); return; }
    if (!this.pick2Waiting()) return;
    this.netSend({ type: 'pick2', idx: idx });
};

var _oh = Scene_D678.prototype.onHit;
Scene_D678.prototype.onHit = function () {
    if (!this._net) { _oh.call(this); return; }
    var b = this._battle;
    if (!this.netCanAct()) return;
    if (this.pick2Waiting()) { this.notice('请先在两张牌里选一张'); return; }
    // 本地先挡一下明显不合法的，省一次往返（服务器仍会独立校验）
    if (!b.canHit(0)) {
        this.notice(b.noHitReason(0));
        this.refresh();
        return;
    }
    this.netSend({ type: 'hit' });
};

var _os = Scene_D678.prototype.onStand;
Scene_D678.prototype.onStand = function () {
    if (!this._net) { _os.call(this); return; }
    if (this.pick2Waiting()) { this.notice('请先在两张牌里选一张'); return; }
    this.netSend({ type: 'stand' });
};

var _ouf = Scene_D678.prototype.onUseFunc;
Scene_D678.prototype.onUseFunc = function () {
    if (!this._net) { _ouf.call(this); return; }
    if (!this.netCanAct()) return;
    if (this.pick2Waiting()) { this.notice('请先在两张牌里选一张'); return; }
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

//--- 血条那一行：只标「你」，右侧放回合倒计时 --------------------------------
// 自己的昵称不画在血条上 —— 这一行只有我自己，昵称对自己没有信息量，
// 而且要留出第二行右侧给回合倒计时。别处（排名 / 拼点 / 结算）多人下
// 一律显示昵称，只有这一处是「你」，见 678.js 的 hpSelfLabel。

var _hp = Scene_D678.prototype.drawHpBar;
Scene_D678.prototype.drawHpBar = function () {
    if (!this._net) { _hp.call(this); return; }

    // 原逻辑在多人下不画这个标签（hpSelfLabel 返回空串），位置留给下面这行
    _hp.call(this);

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
        // 我的思考池（天梯）。紧贴在倒计时**左边**，右对齐（你定的）。
        //
        // 【为什么是右对齐而不是从固定 x 左对齐】原来在 x=200 左对齐，
        // 而左边「第 X 轮   存活 N 人」8 人局能画到 x≈235 —— 两串字直接叠在
        // 一起。右对齐到倒计时左侧之后，这一行的排布是：
        //   26~235  第 X 轮 存活 N 人
        //   250~400 思考时间 x/ys（右对齐，最长「思考时间 15/60s」约 152 像素）
        //   408~708 你的回合 / 等对方 Ns（右对齐）
        // 中间两段各留 15 像素以上的空隙，三段都不重叠。
        //
        // 【为什么自己的画在这里而不是画面下方】这一行本来就是「我的时间」
        // 那一行（回合倒计时在同一行右侧），两个数挨着才看得出「回合时限
        // 烧完了，现在开始吃池子」这个交接。
        var mb = this.netBankSec(0);
        if (mb && mb.pool > 0) {
            this.txt(bmp, '思考时间 ' + mb.turn + '/' + mb.pool + 's',
                250, 72, 150, 20, mb.active ? LC.red : LC.gray, 'right');
        }
    }
};

//--- 对手的思考池 ----------------------------------------------------------
// 画在对手 HP 那一行下面（y=130 那行高 30，到 160 为止；对手手牌从
// OPP_CARD_Y=190 起），这一段是空的。
//
// 【为什么要显示对方的】天梯下 AI 长考可以到 15 秒，超过回合时限 10 秒。
// 只画回合倒计时的话它会归零然后干等好几秒 —— 看起来像卡死。把对方的池子
// 画出来，那几秒就有了解释。
var _dBattle = Scene_D678.prototype.drawBattle;
Scene_D678.prototype.drawBattle = function (b) {
    _dBattle.call(this, b);
    if (!this._net || !b || b.finished) return;
    var ob = this.netBankSec(1);
    if (!ob || ob.pool <= 0) return;
    this.txt(this._uiBmp, '对方思考时间 ' + ob.turn + '/' + ob.pool + 's',
        0, 160, D678.LY.SW, 18, ob.active ? LC.orange : LC.gray, 'center');
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
// 【已废弃，留着不删】原来靠 players[i].inBattle 凑一串名字，画出来是平铺的
// 「甲、乙、丙、丁」—— 分不出谁跟谁打。现在服务器直接发配对（busyPairs），
// 走 netStillPairs。这个函数还留着是因为 678.js:2119 用
// `this.netStillPlaying` 的存在性判断「这是不是联机锦标赛」。
Scene_D678.prototype.netStillPlaying = function () {
    var p = this.netStillPairs();
    return p.map(function (x) { return x.a + ' vs ' + x.b; });
};

// 还在打的那几桌。一条一桌 {a, b, mine}。
//
// 服务器发的 busyPairs 优先；没有（老服务器 / 还没收到）就退回 inBattle 凑，
// 那时候只能两两配不出来，返回空让界面少画一块而不是画错。
Scene_D678.prototype.netStillPairs = function () {
    return this._netBusyPairs || [];
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
    //
    // 【赛事结束后不画】那时候对手掉不掉线都不影响任何东西，弹「对方掉线」
    // 只会让人以为出了问题（你定的）。服务器在 phase==='over' 之后已经不发
    // peer 了，但结算**之前**就掉线的话这个标记早就置上了，会残留到结束画面
    // —— 所以这儿也要判一道。
    if (this._netPeerGone &&
        this._phase !== 'gameover' && this._phase !== 'netover') {
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
        // 【挪到上方空白带】原来画在 y=440~580，正好压在牌桌中段：牌面、
        // 点数、结算面板全被盖住，玩家看不到这一局到底打成什么样（你定的）。
        // 血条占 y=10~66，对方牌区从 y≈130 起 —— 中间那条 76~126 是空的，
        // 高度 96 的框放在 y=76 刚好卡进去，一点不压牌。
        this.box(bmp, 60, 76, 600, 96, 'rgba(0,0,0,0.9)', LC.red, 12);
        this.txt(bmp, '本场结束', 60, 90, 600, 26, LC.red, 'center');
        this.txt(bmp, this._netOver.reason || '', 60, 124, 600, 20, LC.gray, 'center');
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
// （全服累计）。前三项只统计单机，联机人数是多人开局的人数。
//
// 【只有 GM 看得见】（2026-08-07 你定的）门禁在服务器，这边靠 D678N.daily
// 为 null 时整块不画。所以行为是：进游戏先不显示，去多人模式登录天梯
// （账号 derekgoodman）之后回标题才有 —— 令牌存 sessionStorage，关标签页
// 就没了，服务器重启也失效，那时候要重新登录一次。
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

    // 「多人游戏」下方那行红字。单独一层，和本日计数同一个理由：
    // title.js 的 _btnBmp 有 _btnCache 那道「没变化就不重画」的优化，
    // 往里画会被它整块刷掉。
    this._ladLineBmp = new Bitmap(Graphics.width, Graphics.height);
    this._ladLineSprite = new Sprite(this._ladLineBmp);
    this._ladLineSprite.z = 101;
    this.addChild(this._ladLineSprite);
    this._ladLineShown = -1;
    this._ladLineTick = 0;
    this.drawLadPlayingLine();

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
    // 半秒查一次够了 —— 那个数 20 秒才换一桶
    if (++this._ladLineTick >= 30) {
        this._ladLineTick = 0;
        this.drawLadPlayingLine();
    }
};

// 「天梯模式对局中人数：N」。红色小字，画在「多人游戏」按钮下方的间隙里。
//
// 【y 从按钮算，不写死】title.js 的按钮是底部锚定、按命令数排版的
// （createTitleButtons），命令项以后有增减，写死的 y 就会跑到按钮上。
// 所以直接找 symbol==='d678net' 那个按钮，画在它的下边缘之下。
// title.js 没加载时（_btns 不存在）兜一个按同样规则算的估值。
Scene_Title.prototype.drawLadPlayingLine = function () {
    if (!this._ladLineBmp) return;
    var n = D678N.ladFakePlaying();
    if (n === this._ladLineShown) return;      // 没变化不重画
    this._ladLineShown = n;

    var bmp = this._ladLineBmp;
    bmp.clear();

    var y = null, gap = 34;
    var btns = this._btns;
    if (btns && btns.length) {
        for (var i = 0; i < btns.length; i++) {
            if (btns[i].symbol !== 'd678net') continue;
            var b = btns[i];
            y = b.y + b.h;
            // 到下一个按钮之间的净空。最后一个按钮下方按 BTN_BOTTOM 估。
            var next = btns[i + 1];
            gap = next ? (next.y - y) : 34;
            break;
        }
    }
    if (y === null) {
        // title.js 没接管标题（或命令表还没建）：按 3 个按钮 + 34 间隙估。
        // 顶边 = 1280 - 70 - (3*74 + 2*34) = 920，多人游戏是第 2 个
        // （920 + 108 = 1028），它的下边缘 1028 + 74 = 1102。
        var y0 = Graphics.height - 70 - (3 * 74 + 2 * 34);
        y = y0 + (74 + 34) + 74;
        gap = 34;
    }

    // 传 gap 当绘制高度，drawText 会在这道间隙里垂直居中
    bmp.fontSize = 17;
    bmp.textColor = '#ff6b6b';
    bmp.outlineColor = 'rgba(0,0,0,0.85)';
    bmp.outlineWidth = 4;
    bmp.drawText('天梯模式对局中人数：' + n, 0, y, Graphics.width, gap, 'center');
};

Scene_Title.prototype.drawDailyCounts = function () {
    if (!this._dailyBmp) return;
    var d = D678N.daily;
    // 问不到就整块不画（单机 exe / 服务器没起 / 不是 GM）—— 留四个 0 在标题上
    // 比不显示更难看，还会让人以为功能坏了。
    // 非 GM 时 dailyFetch 把 D678N.daily 置成 null，所以这条同时是 GM 门禁的
    // 客户端一半（真门禁在服务器：/api/daily 不给非 GM 回数字）。
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
