//=============================================================================
// server.js —— 678 联机服务器（单人对决 1v1）
//=============================================================================
//
// 跑法：
//   node server.js --dir "C:\derek\文档\new\678"
//   然后浏览器开 http://localhost:3000
//
// 部署到 Railway / Render 时不用传 --dir：默认读同目录下的 public/，
// 端口读 process.env.PORT（平台强制），所以那两个参数都不要写死。
//
//=============================================================================
// 设计要点（改代码前先读这段）
//=============================================================================
//
// 1) 规则全部由服务器跑，客户端只是显示 + 发意图。
//    规则代码直接 require 678core.js —— 和浏览器加载的是同一个文件，
//    所以不存在「服务端和客户端规则实现走偏」这类最难查的 bug。
//
// 2) 每个客户端收到的盘面都是「镜像后自己永远是 side 0」的视图。
//    这样 678.js 里所有绘制代码（大量硬编码 sides[0] / turn===0）一行都不用改。
//    镜像 + 遮蔽只在 maskView 一个函数里做，是安全关键，改它要格外小心。
//
// 3) 对方暗牌一律发 v:null，牌库只发 checkN 前缀，对战日志揭牌前完全不发
//    （logAct 记了 handStr，里面含暗牌数值）。别人开 devtools 也偷不到底牌。
//
// 4) 传输用 SSE + POST，不用 WebSocket：零依赖（只用 Node 内置 http）、
//    EventSource 自带断线重连、而且以后 NW.js 当局域网主机时也能用
//    （RMMV 1.6.2 的 NW.js 是 Node 8，跑不了新版 ws）。
//
// 5) D678.Game 是模块级全局，loseHp 和 autoDiscard 在调用时刻读它。
//    多房间同进程时这是唯一的共享全局隐患 —— 所有推进房间的代码
//    必须包在 withRoom() 里。见那个函数的注释。
//
//=============================================================================

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// 规则层的位置有两种：开发时这个文件在 server/ 下，678core.js 在上一层；
// 装配到上线包后两者同级。两个都试，省得为部署单独改一行。
const D678 = (() => {
    for (const p of ['./678core.js', '../678core.js']) {
        try { return require(p); } catch (e) {
            if (e.code !== 'MODULE_NOT_FOUND') throw e;
        }
    }
    throw new Error('找不到 678core.js（同级或上一层都没有）');
})();

//=============================================================================
// 配置
//=============================================================================

function argOf(name, def) {
    const i = process.argv.indexOf(name);
    return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : def;
}

const CFG = {
    // 游戏文件根目录。本地开发指向 RMMV 工程，部署时用同目录的 public/
    dir: path.resolve(argOf('--dir', path.join(__dirname, 'public'))),
    // 平台会塞 PORT 进来，不能写死
    port: Number(process.env.PORT || argOf('--port', 3000)),

    // 决斗起始 HP。默认沿用单机的 100，但 1v1 里伤害全砸在两个人身上，
    // 一方大约要输 13~14 场才归零（整场约 25~30 局 / 半小时）。
    // 觉得拖就把这里调成 40 或 60，不影响单机。
    startHp: Number(argOf('--hp', D678.START_HP)),

    // 回合超时（秒）。到时自动判过牌 —— stand 永远是合法动作。
    // 写 0 关掉计时（本地调试用）。
    turnSec: Number(argOf('--turn-sec', 30)),

    // 掉线后多久强制结束房间（秒）。界面上不再显示这个倒计时 ——
    // 玩家看到的是「对方已掉线 X 秒」并且随时可以自己点返回主菜单，
    // 所以这里只是一道兜底，不需要催人。
    graceSec: Number(argOf('--grace-sec', 300)),

    // 「继续」确认的超时（秒）。有人挂机不点继续时自动替他确认。
    // 给足时间 —— 这是「看结算面板」的时间，不该催人。
    ackSec: Number(argOf('--ack-sec', 120)),

    // 弃牌选择的时限（秒）。独立于 ackSec：弃牌要挑牌，
    // 不能和「看完结算点继续」共用一个计时器，否则演出耗掉的时间
    // 会算在挑牌头上，看起来就像只给了十几秒。
    discardSec: Number(argOf('--discard-sec', 10)),

    // 一方点了「继续」之后，等这么久双方一起进下一局（毫秒）。
    // 不再要求双方各点一次 —— 谁先点谁触发，另一方跟着走。
    advanceMs: Number(argOf('--advance-ms', 2000)),

    // 空房间清理（分钟）
    idleMin: Number(argOf('--idle-min', 30)),
};

// 时间戳要拼进格式串里，不能当第一个参数传 —— 那样 %s 不会被替换
const log = (fmt, ...a) => console.log(new Date().toISOString().slice(11, 19) + ' ' + fmt, ...a);

//=============================================================================
// 静态文件
//=============================================================================

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.svg':  'image/svg+xml',
    '.ogg':  'audio/ogg',
    '.m4a':  'audio/mp4',
    '.mp3':  'audio/mpeg',
    '.wav':  'audio/wav',
    '.ttf':  'font/ttf',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
    '.ico':  'image/x-icon',
};

function serveStatic(req, res, urlPath) {
    let rel = decodeURIComponent(urlPath.split('?')[0]);
    if (rel === '/' || rel === '') rel = '/index.html';

    // 目录穿越防护：解析后必须仍在 CFG.dir 之内
    const full = path.resolve(path.join(CFG.dir, rel));
    if (full !== CFG.dir && !full.startsWith(CFG.dir + path.sep)) {
        res.writeHead(403).end('forbidden');
        return;
    }

    fs.stat(full, (err, st) => {
        if (err || !st.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
               .end('404 ' + rel);
            return;
        }
        const ext = path.extname(full).toLowerCase();
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Content-Length': st.size,
            // 图片音频给长缓存（首屏 60MB，回访不该再下一遍）；
            // js/json 不缓存，改了插件刷新就能看到
            'Cache-Control': /\.(png|jpe?g|gif|webp|ogg|m4a|mp3|wav|ttf|woff2?)$/.test(ext)
                ? 'public, max-age=604800' : 'no-cache',
        });
        fs.createReadStream(full).pipe(res);
    });
}

//=============================================================================
// 工具
//=============================================================================

function rndId(n, chars) {
    chars = chars || 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 去掉易混的 I O 0 1
    let s = '';
    for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}

function lanIPs() {
    const out = [];
    const ifs = os.networkInterfaces();
    for (const k of Object.keys(ifs)) {
        for (const a of ifs[k]) {
            if (a.family === 'IPv4' && !a.internal) out.push(a.address);
        }
    }
    return out;
}

// 名字清洗：限长、去首尾空白、禁用 AI 名单里的名字。
// 禁用是必须的 —— D678_Player 的 isGod 是按名字判的（name === GOD_NAME），
// 真人取名「超哥」会被当成知道牌库顺序的 AI。
const AI_NAME_SET = new Set(D678.AI_NAMES);

function cleanName(s, fallback) {
    s = String(s == null ? '' : s).replace(/[\r\n\t]/g, ' ').trim();
    // 按显示宽度截断（中文算 2）：排名列表就 696px 宽，太长会溢出
    let w = 0, out = '';
    for (const ch of s) {
        const cw = ch.charCodeAt(0) > 0x7f ? 2 : 1;
        if (w + cw > 16) break;
        w += cw; out += ch;
    }
    s = out.trim();
    if (!s) s = fallback || '玩家';
    if (AI_NAME_SET.has(s)) s += '.';   // 撞 AI 名字就加个点区分
    return s;
}

//=============================================================================
// 视图遮蔽（安全关键）
//=============================================================================
//
// 把真实盘面转成「给 side=me 的那个人看的」视图，做两件事：
//
//   镜像：接收方在自己屏幕上永远是 side 0。这样 678.js 里所有
//         硬编码 sides[0] / turn===0 / total(0) 的绘制代码都不用改。
//   遮蔽：对方暗牌 v:null；牌库只留 checkN 前缀；日志揭牌前不发。
//
// 【雷区】对方暗牌发 null 之后，客户端若调用 total(1) 会把 null 当 0 算，
// 得到一个看似正常但错误的数字（不是 NaN，所以不会当场炸）。
// 现在的绘制层不调用它 —— totalString 遇到暗牌推 '?' 且不累加，
// drawShowdown 读 result.totals，unseenForPlayer 跳过未揭示暗牌。
// 以后改界面时如果需要对方点数，一律从 result.totals 取，别调 total(1)。
//
function maskView(b, me, snapPre) {
    const mySide = b.sides[me];

    // 牌库：长度真实（canHit / 「牌库已空」都要用），值只给查看牌库看到的那几张
    const deck = b.deck.map((v, i) => (i < mySide.checkN ? v : null));

    const maskSide = (si) => {
        const s = b.sides[si];
        const mine = (si === me);
        return {
            cards: s.cards.map(c => ({
                // 自己的牌全给；对方的暗牌在揭牌前不给数值
                v: (mine || b.revealed || !c.hidden) ? c.v : null,
                hidden: c.hidden,
            })),
            stood: s.stood,
            // 对方用过几张查看牌库不该暴露，只发自己的
            checkN: mine ? s.checkN : 0,
        };
    };

    // result 的 totals/busts/maxes 都是按 side 索引的数组，要跟着镜像；
    // winnerP / loserP 是 Player 对象引用，不能发（会把对方全部字段带出去）
    let result = null;
    if (b.result) {
        const r = b.result;
        const sw = (arr) => (me === 0 ? arr : [arr[1], arr[0]]);
        result = {
            totals: sw(r.totals), busts: sw(r.busts), maxes: sw(r.maxes),
            winner: r.tie ? -1 : (r.winner === me ? 0 : 1),
            tie: !!r.tie,
            dmg: r.dmg || 0, items: r.items || 0, target: r.target,
            winnerName: r.winnerP ? r.winnerP.name : '',
            loserName:  r.loserP  ? r.loserP.name  : '',
        };
    }

    const P = (si) => {
        const p = b.players[si];
        return {
            name: p.name, hp: p.hp, alive: p.alive,
            wins: p.wins, losses: p.losses, maxPoint: p.maxPoint,
            funcUses: p.funcUses,
            // 自己的功能牌给真实 id；对方只给张数（这是双方对称的公开信息，
            // 单机里 drawOppName 也一直显示对手手牌数）
            funcs: (si === me) ? p.funcs.slice(0) : null,
            funcCount: p.funcs.length,
        };
    };

    // 结算时发两份手牌：pre 是发牌前的，用来在揭牌演出期间显示；
    // players 里那份是发牌后的，客户端等演出走完（finishBattle）才切过去。
    // 单机的节奏就是「演出结束才看到奖励」，不这样分两段会早两秒露出来。
    const preOf = (si) => {
        if (!snapPre) return null;
        const arr = snapPre[si];
        return (si === me) ? arr.slice(0) : null;
    };
    const preCount = (si) => (snapPre ? snapPre[si].length : null);

    const ord = (f) => (me === 0 ? [f(0), f(1)] : [f(1), f(0)]);

    return {
        deck: deck,
        rule: b.rule,
        standStreak: b.standStreak,
        turn: (b.turn === me) ? 0 : 1,
        revealed: !!b.revealed,
        finished: !!b.finished,
        redeals: b.redeals,
        sides: ord(maskSide),
        players: ord(P),
        result: result,
        // 见 preOf 的注释：只有结算那一帧会带上
        preFuncs: snapPre ? ord(preOf) : null,
        preFuncCounts: snapPre ? ord(preCount) : null,
    };
}

// 对战日志：只在揭牌后才允许下发（logAct 记的 hand 含暗牌数值）。
// side 也要镜像 —— drawBattleLog 按 side 上色（我方青、对方橙）。
function maskLog(b, me) {
    if (!b.revealed) return null;
    return (b.log || []).map(e => ({
        name: e.name, what: e.what, hand: e.hand,
        side: (e.side === me) ? 0 : 1,
    }));
}

//=============================================================================
// 房间
//=============================================================================

const rooms = new Map();   // code -> room
const bySid = new Map();   // sid  -> {room, seatIndex}

// 【必读】D678.Game 是 678core.js 里的模块级全局，而：
//   · D678_Player.loseHp 在调用时刻读它（记淘汰顺序 outAt）
//   · D678.autoDiscard 在调用时刻读它（弃牌回池）
//   · new D678.Battle(...) 构造时捕获 this.game = D678.Game
// 多房间同进程时这是唯一的共享全局隐患。所有推进房间状态的代码
// 必须包在这里面，否则 A 房的结算可能把牌还进 B 房的池子。
// Node 单线程 + 每次推进都是同步的，所以这样就够 —— 但绝不能在
// fn 里面 await，那会让另一个房间的回调插进来。
function withRoom(room, fn) {
    const prev = D678.Game;
    D678.Game = room.game;
    try { return fn(); } finally { D678.Game = prev; }
}

function newRoom() {
    let code;
    do { code = rndId(4); } while (rooms.has(code));
    const room = {
        code: code,
        seats: [null, null],
        game: null,
        battle: null,
        phase: 'lobby',      // lobby | battle | resolved | over
        seq: 0,
        // 每次结算 +1。客户端记住自己播过哪一次，同一次不再重播演出。
        // 少了它，弃牌后服务器重推的那份 resolved 状态会被当成新结算，
        // 客户端从 roundResult 被打回 resolve —— 而 _netFinished 已经是 true，
        // netFinish 立刻 return，于是双方各自卡死在不同阶段。
        resolveId: 0,
        turnTimer: null,
        ackTimer: null,
        discardTimer: null,
        discardDeadline: 0,
        advanceTimer: null,      // 「2 秒后开下一局」的定时器
        advanceAt: 0,            // 那一刻的时间戳，用来给客户端显示
        createdAt: Date.now(),
        touched: Date.now(),
        overInfo: null,
    };
    rooms.set(code, room);
    log('房间 %s 创建', code);
    return room;
}

function addSeat(room, name) {
    const i = room.seats.findIndex(s => s === null);
    if (i < 0) return null;
    const sid = rndId(24, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    // 同房重名会让排名列表和对战日志分不清谁是谁（logAct 记的是 name）
    const other = room.seats.find(s => s);
    if (other && other.name === name) name = name + '(2)';
    const seat = {
        sid: sid, name: name, index: i,
        player: null,
        sse: null, connected: false,
        disconnectAt: 0,
        owesDiscard: false,
        acked: false,
    };
    room.seats[i] = seat;
    bySid.set(sid, { room: room, index: i });
    room.touched = Date.now();
    log('房间 %s 座位 %d = %s', room.code, i, name);
    return seat;
}

function dropRoom(room, why) {
    clearTimeout(room.turnTimer);
    clearTimeout(room.ackTimer);
    clearTimeout(room.discardTimer);
    room.seats.forEach(s => {
        if (!s) return;
        clearTimeout(s.graceTimer);
        bySid.delete(s.sid);
    });
    rooms.delete(room.code);
    log('房间 %s 关闭（%s）', room.code, why);
}

//=============================================================================
// 推送（SSE）
//=============================================================================

function sendTo(seat, type, data) {
    if (!seat || !seat.sse) return;
    const payload = JSON.stringify(Object.assign({ t: type }, data));
    try {
        seat.sse.write('data: ' + payload + '\n\n');
    } catch (e) {
        seat.connected = false;
    }
}

function pushRoom(room) {
    room.seats.forEach(seat => {
        if (!seat) return;
        sendTo(seat, 'room', {
            room: room.code,
            phase: room.phase,
            mySeat: seat.index,
            startHp: CFG.startHp,
            turnSec: CFG.turnSec,
            seats: room.seats.map(s => s ? {
                name: s.name, connected: s.connected,
            } : null),
        });
    });
}

// 每个座位收到的是各自镜像后的视图 —— 这是整套设计的核心
function pushState(room, extra) {
    if (!room.battle) return;
    const b = room.battle;
    room.seq++;
    room.seats.forEach(seat => {
        if (!seat) return;
        const me = seat.index;
        const other = room.seats.find(s => s && s !== seat);
        sendTo(seat, 'state', Object.assign({
            seq: room.seq,
            resolveId: room.resolveId,
            phase: room.phase,
            round: room.game ? room.game.round : 1,
            b: maskView(b, me, room.preFuncs),
            log: maskLog(b, me),
            // 发「还剩多少毫秒」而不是绝对时间戳：两台设备的钟差几分钟很常见，
            // 客户端拿时间戳减本地 Date.now() 会算出离谱的倒计时。
            turnLeft: room.turnDeadline ? Math.max(0, room.turnDeadline - Date.now()) : 0,
            discardLeft: (seat.owesDiscard && room.discardDeadline)
                ? Math.max(0, room.discardDeadline - Date.now()) : 0,
            owesDiscard: seat.owesDiscard,
            myAcked: !!seat.acked,
            // 对手状态：是否已点继续 / 是否还在弃牌 / 掉线了多久（毫秒）
            peerAcked: !!(other && other.acked),
            peerOwes: !!(other && other.owesDiscard),
            peerGone: !!(other && !other.connected),
            peerGoneMs: (other && !other.connected && other.disconnectAt)
                ? Date.now() - other.disconnectAt : 0,
            peerName: other ? other.name : '',
        }, extra || {}));
    });
}

// 对手动作的文字提示：只发给「不是行动方」的那个人。
// 单机里 pushMsg 收到的就是「对方抽牌」这类第三人称措辞，
// 而自己的动作单机也不推消息（结果直接看盘面），所以这里行为一致。
function pushEvent(room, actorIndex, msg) {
    if (!msg) return;
    room.seats.forEach(seat => {
        if (!seat || seat.index === actorIndex) return;
        sendTo(seat, 'event', { msg: msg });
    });
}

//=============================================================================
// 对局流程
//=============================================================================

function startDuel(room) {
    // 起始 HP 要在造 Player 之前设好（构造函数里读 D678.START_HP）。
    // 客户端画血条也用 D678.START_HP 当分母，所以那边会用 room 消息里的
    // startHp 覆盖一次，两边保持一致。
    const savedHp = D678.START_HP;
    D678.START_HP = CFG.startHp;
    try {
        const game = new D678.GameClass();
        // GameClass 构造出的是 1 人 + 7 AI，整份换成两名真人
        game.players = room.seats.map((s, i) => {
            const p = new D678.Player(i, s.name, true);
            s.player = p;
            return p;
        });
        room.game = game;
    } finally {
        D678.START_HP = savedHp;
    }

    room.phase = 'battle';
    pushRoom(room);
    nextBattle(room);
}

function nextBattle(room) {
    withRoom(room, () => {
        // 1v1 里配对是固定的，不需要 makeRound 的配对逻辑，只借它的轮次编号语义
        room.game.round++;
        room.game.players.forEach(p => { p.prevLast = p.last; p.last = null; });
        room.battle = new D678.Battle(room.game.players[0], room.game.players[1], false);
    });
    room.phase = 'battle';
    room.preFuncs = null;
    room.seats.forEach(s => { if (s) { s.acked = false; s.owesDiscard = false; } });
    // 计时器必须在 pushState 之前武装 —— 否则这一份状态里的 turnLeft 是 0，
    // 客户端第一回合就没有倒计时可显示（这就是「第一回合不显示」的原因）
    armTurnTimer(room);
    pushState(room, { fresh: true });
}

//--- 回合计时 --------------------------------------------------------------
// 超时判过牌：stand 永远是合法动作，不会因为「明牌已满 21 不能要牌」这类
// 限制而失败。CFG.turnSec = 0 时不计时（本地调试）。

function armTurnTimer(room) {
    clearTimeout(room.turnTimer);
    room.turnDeadline = 0;
    if (!CFG.turnSec || room.phase !== 'battle' || !room.battle) return;
    if (room.battle.finished) return;
    room.turnDeadline = Date.now() + CFG.turnSec * 1000;
    room.turnTimer = setTimeout(() => {
        const b = room.battle;
        if (!b || b.finished || room.phase !== 'battle') return;
        const si = b.turn;
        log('房间 %s 座位 %d 回合超时 -> 判过牌', room.code, si);
        applyAction(room, si, { type: 'stand' }, true);
    }, CFG.turnSec * 1000);
}

//--- 应用一个动作 ----------------------------------------------------------

function applyAction(room, si, action, forced) {
    const b = room.battle;
    if (!b || b.finished || room.phase !== 'battle') return { ok: false, err: '当前不能行动' };
    if (b.turn !== si) return { ok: false, err: '还没轮到你' };

    let msg = '', ok = true, err = '', failNote = '';

    withRoom(room, () => {
        if (action.type === 'hit') {
            if (!b.canHit(si)) {
                ok = false;
                err = b.deck.length === 0 ? '牌库已空' : '明牌合计大于等于21点无法继续要牌';
                return;
            }
            const ev = b.act(si, 'hit');
            msg = ev.msg;
        } else if (action.type === 'stand') {
            const ev = b.act(si, 'stand');
            msg = ev.msg;
        } else if (action.type === 'func') {
            const p = room.game.players[si];
            const id = action.id;
            // 必须真的持有这张牌 —— 客户端发来的 id 一律不可信
            if (!id || p.funcs.indexOf(id) < 0) { ok = false; err = '你没有这张功能牌'; return; }
            const r = b.useFunc(si, id);
            if (!r.ok) { ok = false; err = r.err || '无法使用'; return; }
            msg = r.msg;
            if (r.fail) failNote = '此号牌已在场上';
        } else {
            ok = false; err = '未知动作';
        }
    });

    if (!ok) return { ok: false, err: err };

    if (forced) msg = (msg || '') + '（超时）';
    pushEvent(room, si, msg);

    // 平局：doResolve 里走 tie 分支，pendingRedeal=true 但 finished 仍是 false
    if (b.result && b.result.tie) { enterResolved(room, true); return { ok: true, fail: failNote }; }
    if (b.finished) { enterResolved(room, false); return { ok: true, fail: failNote }; }

    armTurnTimer(room);   // 先武装再推，让这份状态带上新的 turnLeft
    pushState(room);
    return { ok: true, fail: failNote };
}

//--- 结算 ------------------------------------------------------------------
// 单机的节奏是：onBattleEnd 播演出（_wait 150/200 帧）→ finishBattle 才发功能牌。
// 服务器这边一次把结算算完并推下去，客户端靠自己的 _wait 倒计时把
// 「揭牌演出 → 弃牌界面 → 轮结果」按原节奏依次呈现，节奏归各人自己控制。

function enterResolved(room, isTie) {
    clearTimeout(room.turnTimer);
    room.turnDeadline = 0;
    clearAdvance(room);  // 上一次结算的推进定时器绝不能带进这一次
    room.phase = 'resolved';
    room.isTie = !!isTie;
    room.resolveId++;    // 客户端靠它判断「这次结算我播过没有」
    room.seats.forEach(s => { if (s) { s.acked = false; s.owesDiscard = false; } });

    // 发牌前先拍一张手牌快照，客户端在揭牌演出期间显示这份，
    // 演出走完才切到发牌后的 —— 对齐单机「演出结束才看到奖励」的节奏
    room.preFuncs = room.game.players.map(p => p.funcs.slice(0));

    if (!isTie) {
        withRoom(room, () => {
            const need = room.battle.grantFuncs();   // 胜者摸 1、败者摸 2
            need.forEach(p => {
                const seat = room.seats.find(s => s && s.player === p);
                if (seat) seat.owesDiscard = true;
            });
            // 淘汰者的功能牌回公共池
            room.game.players.forEach(p => {
                if (!p.alive && p.funcs.length > 0) room.game.returnAllFuncs(p);
            });
        });
    }

    // 弃牌计时从「客户端演出走完、弃牌界面真正打开」那一刻算起才公平。
    // 服务器不知道各人的演出进度，所以给一个够宽的窗口：
    // 演出最长 200 帧（约 3.3 秒），discardSec 是净挑牌时间。
    if (room.seats.some(s => s && s.owesDiscard)) {
        armDiscardTimer(room, CFG.discardSec * 1000 + 4000);
    }

    pushState(room, { resolved: true, tie: !!isTie });
    armAckTimer(room);
}

// 弃牌超时：只替还欠弃牌的人自动弃，不动别人的 acked
function armDiscardTimer(room, ms) {
    clearTimeout(room.discardTimer);
    room.discardDeadline = 0;
    if (!CFG.discardSec) return;
    room.discardDeadline = Date.now() + ms;
    room.discardTimer = setTimeout(() => {
        if (room.phase !== 'resolved') return;
        const owing = room.seats.filter(s => s && s.owesDiscard);
        if (!owing.length) return;
        withRoom(room, () => {
            owing.forEach(s => {
                log('房间 %s 座位 %d 弃牌超时 -> 自动弃', room.code, s.index);
                D678.autoDiscard(s.player);
                s.owesDiscard = false;
            });
        });
        room.discardDeadline = 0;
        pushState(room, { resolved: true, tie: !!room.isTie, autoDiscarded: true });
        advanceIfDiscardsDone(room);   // 自动弃完就直接开下一局
    }, ms);
}

// 有人挂机不点「继续」时替他确认，免得另一个人无限等
function armAckTimer(room) {
    clearTimeout(room.ackTimer);
    if (!CFG.ackSec) return;
    // 还要挑牌的话，「继续」的窗口得把挑牌时间也算进去
    const extra = room.seats.some(s => s && s.owesDiscard)
        ? CFG.discardSec * 1000 + 4000 : 0;
    room.ackTimer = setTimeout(() => {
        if (room.phase !== 'resolved') return;
        withRoom(room, () => {
            room.seats.forEach(s => {
                if (!s) return;
                if (s.owesDiscard) { D678.autoDiscard(s.player); s.owesDiscard = false; }
                s.acked = true;
            });
        });
        log('房间 %s 继续确认超时 -> 自动推进', room.code);
        doAdvance(room);   // 兜底：无条件推进，不再看 acked / owesDiscard
    }, CFG.ackSec * 1000 + extra);
}

// 排一次「延后推进」。谁先点继续谁触发，双方一起走 ——
// 延迟由服务器统一计时，所以两边看到的下一局是同一时刻开始的。
// 已经在倒数时不重排，免得后点的那一方把时间又往后推。
function scheduleAdvance(room, ms) {
    if (room.phase !== 'resolved') return;
    // 已经在倒数就不重排时间（免得后点的人把开局往后推），
    // 但状态还是要推一次 —— 否则第二个人点继续时收不到任何回执，
    // 界面会一直停在「点击任意位置继续」。
    if (!room.advanceTimer) {
        room.advanceAt = Date.now() + ms;
        room.advanceTimer = setTimeout(() => {
            room.advanceTimer = null;
            room.advanceAt = 0;
            doAdvance(room);
        }, ms);
    }
    // 让双方立刻知道「要开下一局了」，好把界面切成过渡态
    pushState(room, { resolved: true, tie: !!room.isTie, advancing: true });
}

function clearAdvance(room) {
    clearTimeout(room.advanceTimer);
    room.advanceTimer = null;
    room.advanceAt = 0;
}

// 弃牌路径专用：所有人都弃完了就立刻开下一局，不需要任何人点确认。
// 名字写清楚是为了和「点继续 + 2 秒延迟」那条路区分开 ——
// 之前两条路共用一个函数，而它里面有「必须有人 acked」的守卫，
// 于是弃牌走完永远推进不了（表现就是弃完卡住）。
function advanceIfDiscardsDone(room) {
    if (room.phase !== 'resolved') return;
    if (room.seats.some(s => s && s.owesDiscard)) return;   // 还有人在挑牌
    doAdvance(room);
}

// 真正开下一局 / 平局重发
function doAdvance(room) {
    if (room.phase !== 'resolved') return;
    clearAdvance(room);
    clearTimeout(room.ackTimer);
    clearTimeout(room.discardTimer);
    room.discardDeadline = 0;

    if (room.isTie) {
        // 平局重新发牌：沿用同一个 Battle，只 newDeal（和单机 doRedeal 一致）
        withRoom(room, () => {
            const b = room.battle;
            b.pendingRedeal = false;
            b.result = null;
            b.redeals++;
            b.newDeal();
        });
        room.phase = 'battle';
        room.preFuncs = null;
        room.seats.forEach(s => { if (s) s.acked = false; });
        pushState(room, { fresh: true, redealt: true });
        armTurnTimer(room);
        return;
    }

    const dead = room.game.players.filter(p => !p.alive);
    if (dead.length > 0) { enterOver(room); return; }
    nextBattle(room);
}

function enterOver(room) {
    clearTimeout(room.turnTimer);
    clearTimeout(room.ackTimer);
    room.phase = 'over';
    const ps = room.game.players;
    room.overInfo = ps.map(p => ({
        name: p.name, hp: p.hp, alive: p.alive,
        wins: p.wins, losses: p.losses, maxPoint: p.maxPoint,
        games: p.wins + p.losses, funcUses: p.funcUses,
    }));
    room.seats.forEach(seat => {
        if (!seat) return;
        const me = seat.index;
        sendTo(seat, 'over', {
            win: room.game.players[me].alive,
            stats: (me === 0) ? room.overInfo : [room.overInfo[1], room.overInfo[0]],
        });
    });
    log('房间 %s 决斗结束', room.code);
}

//=============================================================================
// 掉线 / 重连
//=============================================================================

function onDisconnect(room, seat) {
    seat.connected = false;
    seat.sse = null;
    seat.disconnectAt = Date.now();
    log('房间 %s 座位 %d(%s) 掉线', room.code, seat.index, seat.name);
    pushRoom(room);

    const other = room.seats.find(s => s && s !== seat);
    // 不发倒计时 —— 界面上改成「已掉线 X 秒」+ 随时可点返回主菜单。
    // 催一个倒计时没意义：对方回不回来不是这边能控制的事。
    if (other) sendTo(other, 'peer', { gone: true, name: seat.name });

    clearTimeout(seat.graceTimer);
    seat.graceTimer = setTimeout(() => {
        if (seat.connected) return;
        // 1v1 好友对战里让 AI 接管很别扭，直接结束房间让对方回大厅。
        // AI 托管留给第二步的锦标赛（那边一个人退出不该毁掉整场赛事）。
        const o = room.seats.find(s => s && s !== seat);
        if (o) sendTo(o, 'abort', { reason: seat.name + ' 掉线未回来，本场结束' });
        dropRoom(room, '对手掉线超时');
    }, CFG.graceSec * 1000);
}

function onReconnect(room, seat) {
    clearTimeout(seat.graceTimer);
    seat.connected = true;
    seat.disconnectAt = 0;
    log('房间 %s 座位 %d(%s) 重连', room.code, seat.index, seat.name);

    const other = room.seats.find(s => s && s !== seat);
    if (other) sendTo(other, 'peer', { gone: false, name: seat.name });

    // 重连后要能接着打：先补房间信息，再补当前盘面
    pushRoom(room);
    if (room.phase === 'over' && room.overInfo) {
        const me = seat.index;
        sendTo(seat, 'over', {
            win: room.game.players[me].alive,
            stats: (me === 0) ? room.overInfo : [room.overInfo[1], room.overInfo[0]],
        });
    } else if (room.battle) {
        // 直接复用 pushState 的字段构造，免得重连这条路上的字段名慢慢走偏
        pushState(room, { resync: true, resolved: room.phase === 'resolved',
                          tie: !!room.isTie });
    }
}

//=============================================================================
// HTTP
//=============================================================================

function readBody(req, cb) {
    let n = 0;
    const chunks = [];
    req.on('data', c => {
        n += c.length;
        if (n > 64 * 1024) { req.destroy(); return; }   // 正常请求都很小
        chunks.push(c);
    });
    req.on('end', () => {
        try { cb(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
        catch (e) { cb(null); }
    });
}

function json(res, code, obj) {
    const s = JSON.stringify(obj);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(s),
        'Cache-Control': 'no-store',
    });
    res.end(s);
}

function seatOf(sid) {
    const e = bySid.get(sid);
    if (!e) return null;
    const seat = e.room.seats[e.index];
    return seat ? { room: e.room, seat: seat } : null;
}

const server = http.createServer((req, res) => {
    const u = req.url || '/';

    if (!u.startsWith('/api/')) { serveStatic(req, res, u); return; }

    //--- SSE ---------------------------------------------------------------
    if (u.startsWith('/api/events')) {
        const sid = new URL(u, 'http://x').searchParams.get('sid') || '';
        const found = seatOf(sid);
        if (!found) { res.writeHead(404).end('no session'); return; }
        const { room, seat } = found;

        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',   // 防止反向代理缓冲住推送
        });
        res.write(': ok\n\n');

        // 换掉旧连接（刷新页面时旧的还没被回收）
        if (seat.sse && seat.sse !== res) { try { seat.sse.end(); } catch (e) {} }
        seat.sse = res;
        room.touched = Date.now();

        const wasConnected = seat.connected;
        if (wasConnected) { seat.connected = true; pushRoom(room); }
        else onReconnect(room, seat);

        // 心跳：防代理和浏览器把闲置连接掐掉
        const hb = setInterval(() => {
            try { res.write(': hb\n\n'); } catch (e) {}
        }, 20000);

        req.on('close', () => {
            clearInterval(hb);
            if (seat.sse === res) onDisconnect(room, seat);
        });

        // 两个人都连上了就开打
        if (room.phase === 'lobby' &&
            room.seats.every(s => s && s.connected)) {
            startDuel(room);
        }
        return;
    }

    //--- 建房 / 加入 -------------------------------------------------------
    if (u === '/api/create' && req.method === 'POST') {
        readBody(req, body => {
            if (!body) return json(res, 400, { err: '请求格式错误' });
            const room = newRoom();
            const seat = addSeat(room, cleanName(body.name, '房主'));
            json(res, 200, { room: room.code, sid: seat.sid, mySeat: seat.index });
        });
        return;
    }

    if (u === '/api/join' && req.method === 'POST') {
        readBody(req, body => {
            if (!body) return json(res, 400, { err: '请求格式错误' });
            const code = String(body.room || '').toUpperCase().trim();
            const room = rooms.get(code);
            if (!room) return json(res, 404, { err: '房间不存在' });
            if (room.phase !== 'lobby') return json(res, 409, { err: '这个房间已经开打了' });
            const seat = addSeat(room, cleanName(body.name, '客人'));
            if (!seat) return json(res, 409, { err: '房间已满' });
            json(res, 200, { room: room.code, sid: seat.sid, mySeat: seat.index });
        });
        return;
    }

    //--- 动作 --------------------------------------------------------------
    if (u === '/api/act' && req.method === 'POST') {
        readBody(req, body => {
            if (!body) return json(res, 400, { err: '请求格式错误' });
            const found = seatOf(body.sid);
            if (!found) return json(res, 404, { err: '会话失效' });
            const { room, seat } = found;
            room.touched = Date.now();

            // seq 兜住重复提交：手机上双击「要牌」会发两次，
            // 第二次带的还是旧 seq，直接拒掉
            if (body.seq !== undefined && Number(body.seq) !== room.seq) {
                return json(res, 200, { ok: false, stale: true });
            }
            const r = applyAction(room, seat.index, body.action || {}, false);
            json(res, 200, r);
        });
        return;
    }

    //--- 弃牌 --------------------------------------------------------------
    if (u === '/api/discard' && req.method === 'POST') {
        readBody(req, body => {
            if (!body) return json(res, 400, { err: '请求格式错误' });
            const found = seatOf(body.sid);
            if (!found) return json(res, 404, { err: '会话失效' });
            const { room, seat } = found;
            room.touched = Date.now();
            if (!seat.owesDiscard) return json(res, 200, { ok: false, err: '现在不需要弃牌' });

            const ids = Array.isArray(body.ids) ? body.ids : [];
            const p = seat.player;
            const need = p.funcs.length - D678.MAX_FUNC;
            // 只能弃到刚好剩 MAX_FUNC 张 —— 和单机 onDiscardTouch 的限制一致
            if (ids.length !== need) return json(res, 200, { ok: false, err: '要弃 ' + need + ' 张' });

            const pool = p.funcs.slice(0);
            for (const id of ids) {
                const k = pool.indexOf(id);
                if (k < 0) return json(res, 200, { ok: false, err: '你没有这张牌' });
                pool.splice(k, 1);
            }
            withRoom(room, () => {
                ids.forEach(id => {
                    const k = p.funcs.indexOf(id);
                    if (k >= 0) { p.funcs.splice(k, 1); room.game.returnFunc(id); }
                });
            });
            seat.owesDiscard = false;
            // 没人再欠弃牌就把弃牌计时收掉，免得它稍后误触发 autoDiscard
            if (!room.seats.some(s => s && s.owesDiscard)) {
                clearTimeout(room.discardTimer);
                room.discardDeadline = 0;
            }
            pushState(room, { resolved: true, tie: !!room.isTie });
            // 都弃完了就直接开下一局，不要求任何人点确认
            advanceIfDiscardsDone(room);
            json(res, 200, { ok: true, peerOwes: room.seats.some(s => s && s.owesDiscard) });
        });
        return;
    }

    //--- 继续 --------------------------------------------------------------
    if (u === '/api/ack' && req.method === 'POST') {
        readBody(req, body => {
            if (!body) return json(res, 400, { err: '请求格式错误' });
            const found = seatOf(body.sid);
            if (!found) return json(res, 404, { err: '会话失效' });
            const { room, seat } = found;
            room.touched = Date.now();
            // 只在结算阶段接受 —— 别的阶段来的 ack 一律无视，
            // 否则一个迟到的请求会把下一局的 acked 提前置上，
            // 表现就是「对方刚点完，我这边只看了两秒就自动跳了」
            if (room.phase !== 'resolved') {
                return json(res, 200, { ok: true, ignored: true, phase: room.phase });
            }
            seat.acked = true;
            // 还有人在挑牌就先不排推进 —— 弃牌那条路走完会自己开下一局
            if (room.seats.some(s => s && s.owesDiscard)) {
                pushState(room, { resolved: true, tie: !!room.isTie });
                return json(res, 200, { ok: true, waiting: true });
            }
            // 谁先点谁触发：排一个统一的 2 秒延迟，双方一起进下一局。
            // 这里必须是 scheduleAdvance 而不是立刻推进 —— 否则对方刚看到
            // 结算就被拽走（这正是「另一方只有 2 秒」的直接原因）。
            scheduleAdvance(room, CFG.advanceMs);
            json(res, 200, { ok: true, waiting: false, advanceMs: CFG.advanceMs });
        });
        return;
    }

    //--- 退出 --------------------------------------------------------------
    if (u === '/api/leave' && req.method === 'POST') {
        readBody(req, body => {
            const found = body && seatOf(body.sid);
            if (found) {
                const other = found.room.seats.find(s => s && s !== found.seat);
                if (other) sendTo(other, 'abort', { reason: found.seat.name + ' 离开了房间' });
                dropRoom(found.room, '玩家主动退出');
            }
            json(res, 200, { ok: true });
        });
        return;
    }

    json(res, 404, { err: 'unknown api' });
});

//=============================================================================
// 启动
//=============================================================================

// 清理没人的房间
setInterval(() => {
    const now = Date.now();
    for (const room of Array.from(rooms.values())) {
        const anyone = room.seats.some(s => s && s.connected);
        if (!anyone && now - room.touched > CFG.idleMin * 60 * 1000) {
            dropRoom(room, '长时间无人');
        }
    }
}, 60 * 1000);

if (!fs.existsSync(CFG.dir)) {
    console.error('游戏目录不存在: ' + CFG.dir);
    console.error('本地开发请指定: node server.js --dir "C:\\derek\\文档\\new\\678"');
    process.exit(1);
}
if (!fs.existsSync(path.join(CFG.dir, 'index.html'))) {
    console.error('目录里没有 index.html: ' + CFG.dir);
    process.exit(1);
}

// 给测试用：房间状态是模块内私有的，而 D678.Game 只在 withRoom 期间有效，
// 所以测试没法从外面拿到盘面去构造边界场景（比如把手牌补满逼出弃牌）。
// 只导出引用，不导出任何操作函数。
module.exports = { rooms, CFG, withRoom };

server.listen(CFG.port, '0.0.0.0', () => {
    console.log('');
    console.log('  678 联机服务器已启动');
    console.log('  ─────────────────────────────────────────');
    console.log('  游戏目录  %s', CFG.dir);
    console.log('  起始 HP   %d', CFG.startHp);
    console.log('  回合超时  %s', CFG.turnSec ? CFG.turnSec + ' 秒' : '关闭');
    console.log('');
    console.log('  本机      http://localhost:%d', CFG.port);
    lanIPs().forEach(ip => console.log('  局域网    http://%s:%d', ip, CFG.port));
    console.log('');
});
