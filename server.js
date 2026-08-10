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
const zlib = require('zlib');
// 只给天梯登录令牌用。房号和 sid 照旧走 rndId（Math.random）——
// 那两个猜中了也只能进一个房间，令牌猜中了是别人的号。
const crypto = require('crypto');

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

    // 锦标赛：AI 走一步之前停多久（毫秒）。0 = 立刻。
    // 给一点延迟是为了让人看清对手做了什么，不是为了拟人。
    aiStepMs: Number(argOf('--ai-step-ms', 900)),

    // 锦标赛的回合时限。默认沿用 turnSec；想让 8 人赛更紧凑就单独调这个，
    // 不影响 1v1。轮次屏障下每轮耗时 = 最慢那一桌，所以这个值放大了 8 倍效果。
    tourneyTurnSec: Number(argOf('--tourney-turn-sec', 0)),

    // 天梯的回合时限（秒）。比锦标赛的 30 秒短 —— 整场 33 轮，每轮省 10 秒
    // 就是省 5 分钟（你定的）。
    //
    // 【2026-08-07 从 20 秒压到 10 秒】配套把 AI 拟人延迟的上限从 16 秒压到
    // 9 秒（见 LAD_DELAY）。这两个值是绑在一起的：AI 的长考上限必须留在回合
    // 时限之内，否则玩家看着对手思考的时间就等于自己的全部限时。
    ladTurnSec: Number(argOf('--lad-turn-sec', 10)),

    // 天梯里「挂机过之后」的回合时限（秒）。
    //
    // 【2026-08-07 从 5 秒改回 10 秒 = 不降速】（你定的）10 秒本来就够短，
    // 掉线的人回来发现回合只剩一半太苛刻。默认值等于 ladTurnSec，所以天梯
    // 里降速这件事不再发生；写 --lad-gone-turn-sec 5 可以调回来。
    // 详见 goneSecOf 的注释。
    ladGoneTurnSec: Number(argOf('--lad-gone-turn-sec', 10)),

    // 天梯假匹配的总时长范围（毫秒）。计数从 1/8 走到 8/8 用掉这么久。
    //
    // 【为什么故意留长】这段时间是真给真人留的窗口 —— 同一个窗口里点开启排位
    // 的人会被塞进同一桌。55~90 秒是「等得住 + 有机会碰上真人」的折中（你定的）。
    ladFillMinMs: Number(argOf('--lad-fill-min-ms', 55000)),
    ladFillMaxMs: Number(argOf('--lad-fill-max-ms', 90000)),

    // 天梯 AI 拟人延迟的缩放。**只给测试用** —— 一整场 33 轮、每步 1.8~16 秒，
    // 回归测试等不起二十分钟。
    //
    // 【为什么是缩放而不是「设成 0」】设 0 等于把拟人延迟这条整个绕过去，
    // 那么「延迟是随机的」「纯 AI 桌不瞬间结算」这些行为在测试里就永远验不到，
    // 而它们恰恰是最容易写错的部分。缩放保留了全部分支和随机性，只是把
    // 墙上时间按比例压缩。
    ladThinkScale: Number(argOf('--lad-think-scale', 1)),

    // 掉线的人轮到他时用这个更短的时限（秒）。他不会来操作，让在线的那个人
    // 干等满 turnSec 没有意义 —— 而且 678core 里 standStreak>=2 才结算、
    // hit 会把它归零，所以在线方每要一张牌都要多买一个完整回合的等待。
    // 重连回来立刻恢复成 turnSec（见 armTurnTimer）。
    goneTurnSec: Number(argOf('--gone-turn-sec', 10)),
    // 二选一的选牌时限（秒）。已废弃——二选一超时改挂在回合计时器上（含
    // 思考池），不再另起短窗口。保留解析是为了老命令行 / 测试脚本不报错。
    pick2Sec: Number(argOf('--pick2-sec', 10)),

    // 掉线后多久强制结束房间（秒）。界面上不再显示这个倒计时 ——
    // 玩家看到的是「对方已掉线 X 秒」并且随时可以自己点返回主菜单，
    // 所以这里只是一道兜底，不需要催人。
    graceSec: Number(argOf('--grace-sec', 300)),

    // 锦标赛【大厅】里掉线多久就彻底移除座位（秒）。开赛后走 graceSec，
    // 两者不是一回事：大厅里的人还没投入任何东西，占着席位挡别人。
    //
    // 为什么不是「立刻移除」：EventSource 遇到网络抖动会断开再自动重连，
    // 通常一两秒就回来；刷新页面也是断开重连（靠 sessionStorage 找回座位）。
    // 判得太急，抖一下或刷一次页面就被踢回菜单。10 秒足够盖住这两种情况，
    // 而真走掉的人最多多占 10 秒席位。
    lobbyGraceSec: Number(argOf('--lobby-grace-sec', 10)),

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

    // 访客多久没心跳就算离线（秒）。客户端在大厅里每 5 秒 ping 一次，
    // 给到 15 秒是留两次丢包的余量 —— 手机切后台会掉几次，
    // 卡太紧的话人数会一直跳。
    visitorSec: Number(argOf('--visitor-sec', 15)),

    // 「本日」按哪个时区算（小时）。默认东八区。
    //
    // 【别用服务器本地时间】部署平台（Zeabur / Railway）跑在 UTC，不校正的话
    // 「本日」会在北京时间早上 8 点翻篇 —— 正好是有人在玩的时候，
    // 数字会当着人的面归零。
    tzOffset: Number(argOf('--tz-offset', 8)),

    // 要落盘的数据存哪个目录（本日计数、天梯账号）。
    //
    // 【为什么要能改】容器化部署每次上线都拿新镜像重建容器，运行期写出来的
    // 文件不在镜像里，重建完就没了。本日计数无所谓（归零就归零），
    // **但账号不行** —— 那等于每次上线所有人重新注册。
    //
    // 解法是在平台上挂一个持久卷、把 DATA_DIR 指向挂载点（比如 /data）。
    // 没配就退回 server/ 目录：本地 `node server.js` 照旧能跑，
    // 部署时不挂卷也能跑，只是账号活不过下一次上线。
    dataDir: path.resolve(process.env.DATA_DIR || argOf('--data-dir', __dirname)),
};

// 数据目录可能不存在（挂载点是空的 / 传了个新路径）。建不出来也别让服务起不来
// —— 落盘那两处各自 try 过，最坏情况是存不住，功能照常。
try { fs.mkdirSync(CFG.dataDir, { recursive: true }); } catch (e) {}

// 数据目录到底能不能写。
//
// 【为什么光打印路径不够】路径对、目录也在，但卷没真挂上去 —— 那时候写的是
// 容器自己的文件系统，下次上线照样清号，而日志上看不出任何区别。所以真写一个
// 探测文件再删掉，把结果打在启动横幅上。
//
// 返回 ok / 只读 / 建不出来，附带这个目录里已有的账号数（挂对了的话重新部署
// 之后这个数不该归零 —— 那是「持久化真的生效了」最直接的证据）。
function probeDataDir() {
    const out = { ok: false, why: '', accFileBytes: -1 };
    const probe = path.join(CFG.dataDir, '.write-probe');
    try {
        fs.writeFileSync(probe, String(Date.now()), 'utf8');
        fs.unlinkSync(probe);
        out.ok = true;
    } catch (e) {
        out.why = e.code || e.message;
    }
    try {
        out.accFileBytes = fs.statSync(path.join(CFG.dataDir,
            '678-account.json')).size;
    } catch (e) { /* 第一次跑还没这个文件，正常 */ }
    return out;
}

// 时间戳要拼进格式串里，不能当第一个参数传 —— 那样 %s 不会被替换
const log = (fmt, ...a) => console.log(new Date().toISOString().slice(11, 19) + ' ' + fmt, ...a);

//=============================================================================
// 本日计数：游玩 / 完局 / 冠军 / 联机人数
//=============================================================================
// 标题画面上方那四行。**全服累计**，所有人看到同一个数（你定的）。
//
//   plays    **只算单机**：点「开始游戏」真的进了牌桌算一次（你定的）。
//            多人模式不计入 —— 那是 online 那一项的事。
//   finishes 单机打到结算画面的次数（拿到第几名都算）。
//   champs   单机最后幸存者的次数。冠军同时也计入 finishes。
//   online   多人开局的人数：锦标赛或 1v1 正常开局时，按在场真人数加
//            （2 真人的锦标赛 +2）。补位的 AI 不算。
//
// 【故意不做去重】同一台设备反复开局照样一直加（你定的）。代价是这个接口
// 谁都能拿脚本刷 —— 朋友之间玩不管，所以只做一道单请求上限防呆，
// 不做频率限制（那会误伤真的连着打好几局的人）。
//
// 【为什么 online 不信客户端】开赛这件事服务器自己知道，让客户端上报等于
// 白开一个能刷的口子。单机那三项没办法 —— 服务器看不见单机局，只能客户端报。
const DAILY_FILE = path.join(CFG.dataDir, '_daily.json');
const DAILY_MAX_BUMP = 8;      // 单次请求最多加这么多（多人开赛按人数加，8 人赛顶格）

const daily = { day: '', plays: 0, finishes: 0, champs: 0, online: 0 };

// 「今天」是哪天。按 CFG.tzOffset 校正后取 YYYY-MM-DD。
function dayKey(t) {
    const d = new Date((t || Date.now()) + CFG.tzOffset * 3600 * 1000);
    return d.toISOString().slice(0, 10);
}

// 翻篇检查。每次读写都先过一遍 —— 用定时器在午夜触发的话，
// 进程刚好那会儿在重启就漏掉了，而这个判断是幂等的。
function dailyRoll() {
    const k = dayKey();
    if (daily.day !== k) {
        if (daily.day) {
            log('本日计数翻篇 %s -> %s（游玩 %d / 完局 %d / 冠军 %d / 联机 %d）',
                daily.day, k, daily.plays, daily.finishes, daily.champs,
                daily.online);
        }
        daily.day = k;
        daily.plays = 0; daily.finishes = 0; daily.champs = 0; daily.online = 0;
        dailySave();
    }
}

let dailyDirty = false, dailySaveTimer = null;

// 落盘是防「进程崩了重启」，不是防重新部署 —— Railway 重新部署会把文件系统
// 一起冲掉，那种情况下数字照样归零，这是纯内存方案本来就有的代价。
// 写得很碎所以攒 2 秒一次，避免每次开局都同步写盘。
function dailySave() {
    dailyDirty = true;
    if (dailySaveTimer) return;
    dailySaveTimer = setTimeout(() => {
        dailySaveTimer = null;
        if (!dailyDirty) return;
        dailyDirty = false;
        try {
            fs.writeFileSync(DAILY_FILE, JSON.stringify(daily), 'utf8');
        } catch (e) {
            // 只读文件系统之类的环境写不了，不该因此让服务跑不起来
            log('本日计数写盘失败（忽略）: %s', e.message);
        }
    }, 2000);
}

function dailyLoad() {
    try {
        const raw = fs.readFileSync(DAILY_FILE, 'utf8');
        const o = JSON.parse(raw);
        if (o && typeof o.day === 'string') {
            daily.day = o.day;
            daily.plays    = Number(o.plays)    || 0;
            daily.finishes = Number(o.finishes) || 0;
            daily.champs   = Number(o.champs)   || 0;
            daily.online   = Number(o.online)   || 0;
        }
    } catch (e) { /* 没有文件是正常的（第一次跑） */ }
    dailyRoll();   // 存的是昨天的就地归零
}

function dailyBump(kind, n) {
    dailyRoll();
    const k = Math.max(1, Math.min(DAILY_MAX_BUMP, Number(n) || 1));
    if (kind === 'play')   daily.plays    += k;
    else if (kind === 'finish') daily.finishes += k;
    else if (kind === 'champ')   daily.champs   += k;
    else if (kind === 'online')  daily.online   += k;
    else return false;
    dailySave();
    return true;
}

function dailyView() {
    dailyRoll();
    return { day: daily.day, plays: daily.plays,
             finishes: daily.finishes, champs: daily.champs,
             online: daily.online };
}

// 锦标赛固定 8 个位置：真人占前面，其余由 AI 补齐（超哥必定在内）。
// 和单机一致 —— 单机就是 1 真人 + 7 AI。
const TOURNEY_SEATS = 8;

// 8 个真人就不放超哥了 —— 8 席全是人的时候他没位置坐。
// 所以真人上限就是 TOURNEY_SEATS 本身，不留席位。
const TOURNEY_MAX_HUMANS = TOURNEY_SEATS;

// 本局要补的 AI 名单。rollAINames 里 AI_COUNT 是写死的 6（单机 1 人 + 7 AI），
// 锦标赛的补位数随真人数变，所以临时改再还原 —— 和 startDuel 处理
// START_HP 的手法一致。超哥由 rollAINames 无条件塞进去，只要 need >= 1
// 他就一定在场；need === 0（8 个真人）时整份名单为空，他自然不登场。
function rollFillNames(need) {
    if (need <= 0) return [];
    const saved = D678.AI_COUNT;
    // rollAINames 返回 AI_COUNT + 1 个（多的那个是超哥），所以少要一个
    D678.AI_COUNT = Math.max(0, need - 1);
    try {
        return D678.rollAINames().slice(0, need);
    } finally {
        D678.AI_COUNT = saved;
    }
}

//=============================================================================
// 天梯的 AI 拟人延迟
//=============================================================================
//
// 现在的锦标赛是固定 900ms 一步 —— 8 个人里 7 个以毫秒级精度轮流出手，
// 一眼就是机器。天梯要「像真人在思考」：多数步几秒，偶尔长考久一点，
// 每步之间的间隔都不一样（你定的）。
//
// 【2026-08-07 整体压到 1~9 秒】原来是 1.8~16 秒、均值 4.8 秒/步，整场
// 20~24 分钟。回合时限同时从 20 秒压到 10 秒，16 秒的长考就越界了 ——
// 长考上限必须留在回合时限之内（那时还没有思考池）。
//
// 【三档的权重没动】72 / 21 / 7 是原来实测反解出来的形状：绝大多数步是
// 「随手就出」，少数犹豫一下，偶尔卡住想很久。分布的形状才是拟人感的来源，
// 不是具体秒数。
//
// 【2026-08-07 长考档拉到 15 秒，常规 / 稍慢两档不动】（你定的）
// 有了思考池之后，超过回合时限的那一截有地方扣，长考不再需要留在 10 秒内。
//
// 只拉最上面那 7%：整场均值 3.44 -> 3.65 秒/步，时长几乎不变（约 16.5 分钟）。
// 【为什么不整体等比拉到 1~15】那样常规档变成 1~6.25 秒，均值 5.28 秒/步、
// 整场 24 分钟 —— 比 2026-08-07 压缩之前还长，而多出来的时间几乎全在
// 10 秒线以下，压根不走思考池（池子只盖得住超出回合时限的那一截）。
// 「常规步也跟着变慢」不是要的效果，要的是长考更长。
const LAD_DELAY = [
    { w: 72, lo: 1000, hi:  4000 },   // 常规
    { w: 21, lo: 4000, hi:  6500 },   // 稍慢
    { w:  7, lo: 6500, hi: 15000 },   // 长考（会吃思考池）
];

// 思考池空了之后的档位：整个分布必须落在回合时限之内，否则 AI 会一直被
// 判超时过牌。上限 9 秒 = ladTurnSec 留 1 秒余量，让「几乎用完时间」
// 仍然看得出是在思考而不是卡住。
const LAD_DELAY_NOBANK = [
    { w: 72, lo: 1000, hi: 4000 },
    { w: 21, lo: 4000, hi: 6500 },
    { w:  7, lo: 6500, hi: 9000 },
];

//--- 思考池 ----------------------------------------------------------------
// 天梯专属：每人整场独享一份累计思考时间（你定的）。回合时限烧完之后可以
// 继续动用它，单回合最多动用 LAD_BANK_TURN_MS，池子空了就只剩每回合 10 秒。
//
// 【为什么单回合要另设上限】只有总量的话，一个人可以在某一步上耗掉整池
// 60 秒 —— 轮次屏障下同轮另外三桌全在等他，那 60 秒里别人只看得到一个
// 倒计时。15 秒的上限把单回合最长封在 10+15=25 秒。
//
// 真人和 AI 用同一份口径（都是 60 秒 / 单回合 15 秒），这样玩家看到对手那份
// x/60 在掉的时候，它和自己那份是同一种东西。
const LAD_BANK_MS      = 60000;
const LAD_BANK_TURN_MS = 15000;

// 测试缩放只作用在 AI 的拟人延迟上（ladThinkScale），真人的回合时限和池子
// 都是真实墙上时间。所以 AI 扣池子时要把「压缩过的超时」还原回真实量，
// 否则 --lad-think-scale 0.02 下 AI 每步只扣几毫秒，池子永远见不到底 ——
// 「池子空了换 1~9 秒那档」那条分支就永远测不到。
function ladUnscale(ms) {
    const k = CFG.ladThinkScale || 1;
    return k > 0 ? ms / k : ms;
}

function ladRollDelay(bands) {
    const tot = bands.reduce((s, x) => s + x.w, 0);
    let u = Math.random() * tot;
    let ms = bands[bands.length - 1].hi;
    for (const d of bands) {
        if ((u -= d.w) < 0) { ms = d.lo + Math.random() * (d.hi - d.lo); break; }
    }
    return ms;
}

// 一步的拟人延迟（已按 ladThinkScale 缩放）。bankLeftMs 是这个 AI 还剩多少
// 思考池，单位是真实毫秒；不传 = 不关心扣费（当作池子充足）。
//
// 【池子空了要换档而不是截断】截断的话所有长考都恰好停在回合时限上，
// 一眼看得出是撞了什么线；换成 1~9 秒那档，观感是「这个对手后半场出手变快了」
// —— 真人时间快用完时正是这样。
function ladThinkMs(bankLeftMs) {
    const hasBank = (bankLeftMs === undefined) || bankLeftMs > 0;
    let raw = ladRollDelay(hasBank ? LAD_DELAY : LAD_DELAY_NOBANK);
    if (hasBank && bankLeftMs !== undefined) {
        // 池子不够支撑这次长考：能想到的最长 = 回合时限 + 剩下的池子
        // （单回合还有 15 秒的上限）。这一步会把池子扣到 0，下一步走 NOBANK 档。
        const cap = CFG.ladTurnSec * 1000
                  + Math.min(bankLeftMs, LAD_BANK_TURN_MS);
        raw = Math.min(raw, cap);
    }
    return Math.max(1, Math.round(raw * CFG.ladThinkScale));
}

// 这一步延迟要从池子里扣多少（真实毫秒）。只有超出回合时限的那一截才扣。
function ladBankCost(delayMs) {
    const over = ladUnscale(delayMs) - CFG.ladTurnSec * 1000;
    return over > 0 ? Math.min(over, LAD_BANK_TURN_MS) : 0;
}

// 池子存在哪：真人存座位（跟着重连走），AI 存 room.ladBank（AI 没有座位 ——
// 和 room.aiNet 同一个理由，见那边的注释）。两种都按 pIdx 取，调用方不用分。
//
// 【非天梯一律返回 0】1v1 / 锦标赛 / 单机没有思考池这回事，读到 0 的话
// armTurnTimerT 那边算出来的 deadline 就等于原来的行为，不用到处加模式判断。
function ladBankLeft(room, pIdx) {
    if (!room || room.mode !== 'ladder') return 0;
    const seat = room.seats.find(s => s && s.pIdx === pIdx);
    if (seat) {
        if (typeof seat.ladBank !== 'number') seat.ladBank = LAD_BANK_MS;
        return Math.max(0, seat.ladBank);
    }
    if (!room.ladBank) room.ladBank = {};
    if (typeof room.ladBank[pIdx] !== 'number') room.ladBank[pIdx] = LAD_BANK_MS;
    return Math.max(0, room.ladBank[pIdx]);
}

function ladBankSpend(room, pIdx, ms) {
    if (!room || room.mode !== 'ladder' || !(ms > 0)) return;
    const left = ladBankLeft(room, pIdx);
    const next = Math.max(0, left - ms);
    const seat = room.seats.find(s => s && s.pIdx === pIdx);
    if (seat) seat.ladBank = next;
    else room.ladBank[pIdx] = next;
}

// 这个回合最多能动用多少池子（真实毫秒）。单回合上限和剩余总量取小的那个。
function ladBankTurnMs(room, pIdx) {
    return Math.min(LAD_BANK_TURN_MS, ladBankLeft(room, pIdx));
}

// AI 这一步的计划：{delay, cost}。delay 是已缩放的等待毫秒，cost 是这一步
// 要从池子里扣掉多少（真实毫秒）。
//
// 【为什么要先抽好再等】客户端显示的思考池必须和 AI 真实的思考时长一致，
// 详见 armTurnTimerT 里 aiPlan 那段注释。
function ladAiPlan(room, pIdx) {
    if (room.mode !== 'ladder') return { delay: CFG.aiStepMs, cost: 0 };
    const delay = ladThinkMs(ladBankLeft(room, pIdx));
    return { delay: delay, cost: ladBankCost(delay) };
}

// 纯 AI 桌的假时长封顶（毫秒）。
//
// 【为什么需要】startRound 里两边都是 AI 的桌走 simulateMatch 当场算完 ——
// 8 人一轮 4 桌，真人只占 1 桌，另外 3 桌**零耗时**完成。而 pushStateT 会把
// 「本轮还有几桌在打」发给客户端（busyTables），于是天梯里看到的是：一开局
// 另外 3 桌立刻全部打完，只剩自己在打，自己打完那一瞬间整轮就结束。
//
// 7 个 AI 全都有拟人延迟、但他们互相打却是 0 秒完成 —— 这个矛盾比 AI 秒出牌
// 更刺眼。所以天梯下纯 AI 桌照样立刻算出结果（保证正确），但**推迟公布**。
//
// 封顶是为了不让它们成为轮次屏障的瓶颈：AI 桌要封在「真人那桌的中位耗时」
// 附近，否则轮次屏障等的就不再是真人而是这些假桌。
//
// 【2026-08-07 从 35 秒降到 20 秒】这个值是跟着真人桌的节奏定的，不是独立的。
// 回合时限 20→10 秒、AI 延迟上限 16→9 秒之后，真人桌中位从 30 秒左右降到
// 15~18 秒，35 秒的封顶就反过来成了瓶颈。改 ladTurnSec 或 LAD_DELAY 的时候
// 都要回来重算这一条。
//
// 【2026-08-07 长考档拉到 15 秒后抬到 24 秒】实测一桌平均 5.0 步、均值
// 3.65 秒/步 -> 假桌均值约 18.3 秒，20 秒的封顶会削掉相当一部分右尾，
// 「步数多的桌确实更久」在那一段就消失了。24 秒留出余量，同时仍然压在
// 真人桌（AI 长考 + 真人可能动用思考池）的中位附近，不至于反过来成为
// 轮次屏障的瓶颈。
const LAD_AI_TABLE_CAP_MS = 24000;

// 一桌纯 AI 对局的「看起来打了多久」。按实际步数抽，所以步数多的桌确实更久。
//
// stepsBySide 是 [side0 步数, side1 步数]，pIdxBySide 是这两侧的 pIdx ——
// 【纯 AI 桌也要扣思考池】（你定的）一个 AI 整场约 35 桌，只在跟真人同桌时
// 扣的话它整场只碰到真人约 5 次，池子几乎不动，玩家看到的那份 x/60 一整场
// 都是满的。扣了才有机会看到对手池子见底。
function ladFakeTableMs(room, pIdxBySide, stepsBySide) {
    let ms = 0;
    for (let si = 0; si < 2; si++) {
        const pIdx = pIdxBySide[si];
        const n = Math.max(0, stepsBySide[si] | 0);
        for (let i = 0; i < n; i++) {
            const d = ladThinkMs(ladBankLeft(room, pIdx));
            ms += d;
            ladBankSpend(room, pIdx, ladBankCost(d));
        }
    }
    if (ms === 0) ms = ladThinkMs();      // 一步都没走（双方都冻结）也要有点时长
    // 封顶也要跟着缩放，否则测试里 ladThinkMs 被压到 2% 而封顶还是 24 秒 ——
    // 那条封顶就永远不会触发，等于没测到
    return Math.min(ms, LAD_AI_TABLE_CAP_MS * CFG.ladThinkScale);
}

//=============================================================================
// AI 也会掉线 / 离开（只天梯）
//=============================================================================
//
// 天梯的整个前提是「让人以为在跟真人打」。8 个人打一整局没有一个掉线、没有
// 一个中途走人，本身就是个破绽 —— 真人局里这两件事经常发生。所以给 AI 掷骰：
//
//   掉线  5%   15~45 秒随机，期间不能做任何动作，回合计时器照常烧完自动过牌，
//              到点自己回来接着打
//   离开  2%   再也不回来，一路自动过牌挨打到血空被淘汰
//
// 【为什么只天梯】（2026-08-07 你定的）锦标赛用的是单机那批名字（超哥、
// 嘎子哥），玩家本来就知道对面是 AI，给它加掉线只是给对局添堵。
//
// 【为什么不排除同桌的那个 AI】（你定的）掉线正好落在你对面时你会实打实等
// 2~3 个回合 —— 这跟真人掉线的体验一模一样，最有说服力的掉线恰恰是亲身等到
// 的那一次。5% 本来就少。
//
// 【状态存房间上，不伪造座位】掉线 / 离开两个标注现在全靠座位算
// （maskViewT 里 `st.left ? 'left' : st.connected ? '' : 'gone'`），而 AI 压根
// 没有座位。塞假座位进 room.seats 会连累一片 —— 在线人数、结算、轮次屏障、
// 开赛条件到处遍历它。所以另存一份 room.aiNet，取 status 的地方「先看座位，
// 没座位再看 aiNet」。客户端三处渲染（对手名字后缀、排名表、最终排名）
// 一行都不用改。
const LAD_AI_GONE_P = 0.05;     // 每个 AI 每局掉线的概率
const LAD_AI_LEFT_P = 0.02;     // 每个 AI 每局直接离开的概率
// 掉线时长的下界从 30 秒放宽到 15 秒（2026-08-07 你定的）。回合时限压到 10 秒
// 之后，30 秒起步的掉线固定要烧掉 3 个以上回合，短掉线（「网卡了一下就回来」）
// 这一档整个不存在。15 秒起就能出现「只错过一两个回合」的掉线。
const LAD_AI_GONE_MIN_MS = 15000;
const LAD_AI_GONE_MAX_MS = 45000;

// 测试用的强制口：null = 按概率抽，'gone' / 'left' / 'ok' = 钉死。
// 和 D678.LAD_GOD_FORCE 同一套路 —— 概率性的东西写进断言就是随机失败。
let LAD_AI_NET_FORCE = null;
function setAiNetForce(v) { LAD_AI_NET_FORCE = v; }

// 掉线时长。测试里 ladThinkScale 会把整局压快，掉线时长也得跟着缩 ——
// 不缩的话一次掉线就超过整局时长，测不到「自己回来了」那一段。
function aiGoneMs() {
    const span = LAD_AI_GONE_MAX_MS - LAD_AI_GONE_MIN_MS;
    const ms = LAD_AI_GONE_MIN_MS + Math.random() * span;
    return Math.max(1, Math.round(ms * CFG.ladThinkScale));
}

// 开赛时给每个 AI 掷一次。返回 {pIdx: {st, at}}，st 是 'gone' / 'left'，
// at 是「第几轮开始时触发」。
//
// 【为什么按局掷而不是按轮掷】一局约 28 轮，5% 逐轮掷下来几乎每个 AI 都会掉
// 一次线 —— 那就不是「个别 AI 偶尔掉线」而是全场都在掉。按局掷的话 7 个 AI
// 期望 0.35 次掉线，大约每 3 局见一次。
//
// 【两个都中按离开算】更严重的那个。
function aiNetRoll(room) {
    if (!room || room.mode !== 'ladder' || !room.game) return;
    room.aiNet = {};
    room.aiNetPlan = {};
    room.game.players.forEach((p, pIdx) => {
        if (p.isHuman) return;
        let st = null;
        if (LAD_AI_NET_FORCE) {
            if (LAD_AI_NET_FORCE === 'ok') return;
            st = LAD_AI_NET_FORCE;
        } else {
            const u = Math.random();
            if (u < LAD_AI_LEFT_P) st = 'left';
            else if (u < LAD_AI_LEFT_P + LAD_AI_GONE_P) st = 'gone';
        }
        if (!st) return;
        // 触发轮次：1~12 轮之间随机。第 1 轮就掉线的话开局就有人是灰的，
        // 太巧；太靠后又可能人已经被淘汰了轮不到。
        room.aiNetPlan[pIdx] = { st: st, round: 1 + Math.floor(Math.random() * 12) };
    });
}

// 每轮开始时调：把计划里到点的那些置成掉线 / 离开。
function aiNetTick(room) {
    if (!room || room.mode !== 'ladder' || !room.aiNetPlan || !room.game) return;
    // makeRound() 里 this.round++ 已经跑过了（startRound 先配对再调这里），
    // 所以第一轮进来 round 就是 1
    const rnd = room.game.round || 0;
    for (const key of Object.keys(room.aiNetPlan)) {
        const plan = room.aiNetPlan[key];
        if (plan.round > rnd) continue;
        delete room.aiNetPlan[key];
        const pIdx = Number(key);
        const p = room.game.players[pIdx];
        // 已经被淘汰的不用掉线了（它的 status 已经是「离开」）
        if (!p || !p.alive) continue;
        if (plan.st === 'left') {
            aiNetSet(room, pIdx, 'left', 0);
            log('房间 %s AI %s 离开（不再回来）', room.code, p.name);
        } else {
            const ms = aiGoneMs();
            aiNetSet(room, pIdx, 'gone', ms);
            log('房间 %s AI %s 掉线 %d 秒', room.code, p.name, Math.round(ms / 1000));
        }
    }
}

// 置状态。backMs > 0 就排一个解冻定时器。
//
// 【为什么解冻要自己推一次状态】状态只在有事发生时才推（pushStateT）。
// 不推的话玩家界面上那个「掉线」会一直挂着，直到下一次有人出牌才消失 ——
// 而掉线的人正好不出牌，很可能整轮都不刷。
// quiet = 只改状态不推盘面。淘汰标注要用它 —— 那一刻紧接着就是
// sendTo(eliminated) + releaseSeatConn（收掉 SSE），多推一份状态会挤在
// 「写入」和「关连接」之间，让本来就存在的竞态更容易踩到（表现为客户端
// 收不到 eliminated）。淘汰的标注不急着这一下推：赛事继续的话下一轮
// startRound 会推，赛事结束的话 enterOverT 直接读 aiNetOf 拍进 overInfo。
function aiNetSet(room, pIdx, st, backMs, quiet) {
    if (!room.aiNet) room.aiNet = {};
    const rec = room.aiNet[pIdx];
    if (rec && rec.timer) clearTimeout(rec.timer);
    const now = Date.now();
    const out = { st: st, at: now, timer: null };
    room.aiNet[pIdx] = out;
    if (backMs > 0) {
        out.timer = setTimeout(() => {
            const cur = room.aiNet && room.aiNet[pIdx];
            if (!cur || cur !== out) return;         // 已经被改成别的了
            delete room.aiNet[pIdx];
            const p = room.game && room.game.players[pIdx];
            log('房间 %s AI %s 重连回来了', room.code, p ? p.name : pIdx);
            if (room.phase === 'battle' || room.phase === 'resolved') {
                pushStateT(room);
                // 正好轮到它：解冻后要立刻接着走，否则它会干等到超时判过牌
                const bt = room.battles &&
                    room.battles.find(x => !x.done && x.b && !x.b.finished &&
                        x.pIdx[x.b.turn] === pIdx);
                if (bt) { armTurnTimerT(room, bt); stepAIIfNeeded(room, bt); }
            }
        }, backMs);
    }
    if (!quiet && (room.phase === 'battle' || room.phase === 'resolved')) {
        pushStateT(room);
    }
}

// 这个 pIdx 此刻的假网络状态：'' / 'gone' / 'left'
function aiNetOf(room, pIdx) {
    const rec = room.aiNet && room.aiNet[pIdx];
    return rec ? rec.st : '';
}

// 冻结 = 不能做任何动作。掉线和离开都冻结。
function aiFrozen(room, pIdx) {
    const st = aiNetOf(room, pIdx);
    return st === 'gone' || st === 'left';
}

// 被淘汰的 AI 也标「离开」（你定的）—— 真人被淘汰时服务器会置 seat.left
// （为了不再推盘面给他），所以排名表里真人淘汰后带着「离开」而 AI 什么都没有。
// 那个差别肉眼看得出来：一局下来只有真人会「离开」，剩下 7 个永远在线。
function aiNetMarkOut(room, pIdx) {
    if (!room || room.mode !== 'ladder') return;
    const p = room.game && room.game.players[pIdx];
    if (!p || p.isHuman) return;
    aiNetSet(room, pIdx, 'left', 0, true);   // quiet：见 aiNetSet 的注释
}

// 房间销毁 / 赛事结束时清掉所有解冻定时器。漏了会让进程一直握着房间对象。
function aiNetClear(room) {
    if (!room || !room.aiNet) return;
    for (const k of Object.keys(room.aiNet)) {
        const rec = room.aiNet[k];
        if (rec && rec.timer) clearTimeout(rec.timer);
    }
    room.aiNet = {};
    room.aiNetPlan = {};
}

//=============================================================================
// 天梯假匹配
//=============================================================================
//
// 界面上从 (1/8 匹配中) 走到 (8/8 匹配中) 然后开赛。这个计数是**假的** ——
// 不真的一个一个把 AI 加进房（你定的）。真人在这段窗口里进来会占掉真实席位，
// 计数照走。
//
// 【间隔按纯随机切分，不加保底】7 个切点直接在总时长上随机取。实测这样
// p90 间隔 20 秒、最长能到 68 秒，5% 的间隔超过 25 秒 —— 也就是二十次里
// 会有一次卡在某个数字上一分多钟。你说这正是真实游戏里常有的情况（等 1 分钟
// 没人进来），所以保留；加了保底反而假。
function ladRollFill() {
    const lo = Math.max(1000, CFG.ladFillMinMs);
    const hi = Math.max(lo + 1, CFG.ladFillMaxMs);
    const total = Math.round(lo + Math.random() * (hi - lo));
    // 要涨 7 次（1/8 是自己，涨到 8/8）。
    //
    // 【最后一次必须钉在总时长上】原来 7 个切点全是 [0,1) 均匀随机，于是最大
    // 那个切点的期望只有 7/8 —— 实测抽到 72.2 秒的总时长，60.3 秒就开赛了。
    // 那样实际匹配时长是 48~79 秒，不是定好的 55~90 秒。
    // 前 6 个随机、第 7 个固定在 total，两头就都对得上。
    const cuts = [];
    for (let i = 0; i < 6; i++) cuts.push(Math.random());
    cuts.sort((a, b) => a - b);
    const at = cuts.map(c => Math.round(c * total));
    at.push(total);
    return { total: total, at: at };
}

// 每个房间的回合时限（秒）。锦标赛可以单独设，没设就沿用 turnSec。
//
// 【天梯必须在锦标赛之前判】天梯房的 mode 是 'ladder'，而它走的是整套
// 锦标赛逻辑（startRound / checkRoundBarrier 那些函数都判 mode==='tourney'
// 的地方要一并放行）。这里如果先判 tourney，天梯就会拿到 30 秒而不是 10 秒。
function turnSecOf(room) {
    if (room.mode === 'ladder') return CFG.turnSec ? CFG.ladTurnSec : 0;
    if (room.mode === 'tourney' && CFG.tourneyTurnSec) return CFG.tourneyTurnSec;
    return CFG.turnSec;
}

// 挂机 / 掉线之后那个更短的回合时限（秒）。别处沿用全局的 goneTurnSec
// （10 秒）；天梯**不降速**，掉线和挂机的回合都是完整的 ladTurnSec。
//
// 【天梯为什么不降速】（2026-08-07 你定的）正常回合已经压到 10 秒，
// 再降到 5 秒对掉线的人太苛刻 —— 他可能只是网卡了一下，回来发现回合只剩
// 一半。10 秒本来就够短，代价是 AI 掉线那 15~45 秒里同桌的人每回合等
// 10 秒而不是 5 秒（一次掉线多等 5~15 秒）。
//
// ladGoneTurnSec 这个参数因此在天梯里不再起作用，保留它是为了能从命令行
// 调回降速（写 --lad-gone-turn-sec 5 就恢复原来的行为）。
//
// 兜底 `|| tsec` 保留：goneTurnSec 被设成 0 时表示「不降速」，
// 那就该退回这个房间的正常时限，而不是变成 0 秒立刻判过牌。
function goneSecOf(room, tsec) {
    if (room.mode === 'ladder') return CFG.ladGoneTurnSec || tsec;
    return CFG.goneTurnSec || tsec;
}

// 这个房间是不是走 8 人赛事那套（锦标赛 + 天梯）。
// 【为什么要这个】原来通篇写 mode === 'tourney'，加了天梯之后每一处都要
// 兼容两种 —— 漏一处的症状是「天梯房走 1v1 的分支」，而 1v1 只有 2 个座位，
// 表现是各种下标越界。集中成一个判据，加第三种模式时也只改这里。
function isTourneyLike(room) {
    return room.mode === 'tourney' || room.mode === 'ladder';
}

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

// gzip：只压文本类。png/ogg/ttf 本身已经是压缩格式，再压一遍省不到几个
// 百分点，白烧 CPU。
//
// 【为什么值得做】js + json + html 一共 3.2MB，gzip 后 0.57MB ——
// 新设备首屏白省 2.6MB，而且这部分是**阻塞**的（rpg_core 没下完游戏起不来），
// 省下来的时间比省同样体积的图片更值钱。
const GZIP_EXT = /^\.(js|json|html|css|svg)$/;

// 压完的结果按「路径 + mtime + size」缓存在内存里。
//
// 不缓存的话每个新访客都要把 rpg_core.js（1MB）重新压一遍 —— 那是同步 CPU
// 密集活，会卡住事件循环，而这个进程同时还在跑对局的定时器和 SSE 推送。
// 键里带 mtime/size 是为了本地开发：改了插件刷新就能看到新的，
// 不用重启服务器（js 本来就是 no-cache，缓存键跟着文件变才对得上）。
//
// 上限是防「以后往 public/ 塞进几百个大 json」把内存吃光。文本资源现在
// 一共 3.2MB，压完 0.57MB，离上限还很远。
const gzCache = new Map();
const GZ_CACHE_MAX = 16 * 1024 * 1024;
let gzCacheBytes = 0;

function gzipCached(full, st, cb) {
    const key = full + '|' + st.mtimeMs + '|' + st.size;
    const hit = gzCache.get(key);
    if (hit) { cb(null, hit); return; }

    fs.readFile(full, (err, raw) => {
        if (err) { cb(err); return; }
        // level 9 而不是默认的 6：这些文件压完就一直躺在缓存里复用，
        // 多花的那点 CPU 只付一次，省下的字节每个访客都受益。
        zlib.gzip(raw, { level: 9 }, (e, buf) => {
            if (e) { cb(e); return; }
            if (gzCacheBytes + buf.length <= GZ_CACHE_MAX) {
                gzCache.set(key, buf);
                gzCacheBytes += buf.length;
            }
            cb(null, buf);
        });
    });
}

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
        const type = MIME[ext] || 'application/octet-stream';
        // 图片音频字体给长缓存（回访不该再下一遍）；js/json 不缓存，
        // 改了插件刷新就能看到。
        //
        // 【为什么是 30 天而不是一年】文件名里没有内容哈希（cardback.png 换了图
        // 还叫 cardback.png），缓存期就是「改了图之后老玩家最久看到旧图多久」。
        // 一年太长 —— 想安全地缓存一年，得先给资源名加哈希。
        const cache = /^\.(png|jpe?g|gif|webp|ogg|m4a|mp3|wav|ttf|woff2?|ico)$/.test(ext)
            ? 'public, max-age=2592000' : 'no-cache';

        const sendRaw = () => {
            res.writeHead(200, {
                'Content-Type': type,
                'Content-Length': st.size,
                'Cache-Control': cache,
            });
            fs.createReadStream(full).pipe(res);
        };

        const accepts = String(req.headers['accept-encoding'] || '');
        if (!GZIP_EXT.test(ext) || !/\bgzip\b/.test(accepts)) { sendRaw(); return; }

        gzipCached(full, st, (err, buf) => {
            // 压不动就照原样发，别因为压缩失败把游戏文件变成 500
            if (err || !buf) { sendRaw(); return; }
            res.writeHead(200, {
                'Content-Type': type,
                // 发压缩后的准确长度，浏览器才有下载进度；不发就退化成 chunked
                'Content-Length': buf.length,
                'Content-Encoding': 'gzip',
                // 中间缓存（CDN / 代理）必须按 Accept-Encoding 分开存，
                // 否则会把 gzip 的那份发给不支持的客户端
                'Vary': 'Accept-Encoding',
                'Cache-Control': cache,
            });
            res.end(buf);
        });
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
// 天梯账号
//=============================================================================
//
// 明文存密码（你定的）。这个体量不搞加盐哈希，代价是这份文件泄了就等于泄了
// 一份「账号+密码」对照表 —— 所以登录界面上挂一句「请勿使用你在其他地方用的
// 密码」，风险交给玩家自己判断。
//
// 【文件绝不能放进 CFG.dir】serveStatic 把那底下所有文件都对外提供，放进去
// 等于挂在网上任人下载。这里写 CFG.dataDir，和 public/ 没有交集。
//
// 【天梯游戏名和多人首界面那个玩家名是两个东西】后者存在浏览器 localStorage
// 里、随便改、管锦标赛和单机；天梯名绑在账号上、全服唯一、每天只能改一次。
// 不共用是因为：登录天梯顺带改掉朋友局的名字说不通，退出天梯后名字还锁着
// 每天一次更说不通。
//
// 落盘的只有账号、密码、游戏名、最后一次改名是哪天。**登录令牌只在内存里**
// —— 进程重启就得重新认证（客户端收到 401 回登录页）。

const ACC_FILE = path.join(CFG.dataDir, '678-account.json');

// 账号总数上限。注册接口不需要鉴权，谁都能拿脚本灌 —— 满了就不再收新的。
// 2000 个账号的 JSON 大约 200KB，离撑爆任何东西都很远。
const ACC_MAX = 2000;

// 同一个 IP 两次注册之间至少隔这么久（毫秒）。挡的是脚本连发，
// 不挡正常人 —— 一个人一辈子就注册一次。
const REG_COOL_MS = 10000;

// 令牌上限。认证一次发一个，满了淘汰最早的（Map 保插入序）。
const TOKEN_MAX = 5000;

const accounts  = new Map();   // 账号小写 -> {acc, pw, name, renamedDay}
const ladNames  = new Map();   // 游戏名小写 -> 账号小写（唯一性索引）
const ladTokens = new Map();   // 令牌 -> 账号小写
const regCool   = new Map();   // IP -> 上次注册时刻

//--- 校验 ------------------------------------------------------------------

// 账号：4-16 位，只收 ASCII 字母数字下划线。
//
// 不收中文 —— 它是登录 ID，得能在任何输入法状态下敲出来；而且中文还有
// 全角半角、繁简这些等价问题，比对起来全是坑。大小写不敏感（Derek 和 derek
// 是同一个号），但原样保留一份给界面显示。
function chkAcc(s) {
    s = String(s == null ? '' : s);
    return /^[A-Za-z0-9_]{4,16}$/.test(s) ? s : null;
}

// 密码：4-16 位可打印 ASCII，不含空白。
// 禁空白是防「手机输入法自动补了个尾随空格」那种查不出来的登录失败。
function chkPw(s) {
    s = String(s == null ? '' : s);
    if (s.length < 4 || s.length > 16) return null;
    return /^[\x21-\x7e]+$/.test(s) ? s : null;
}

// 天梯游戏名：4-8 个字符，汉字算 1 个。汉字 / 字母 / 数字，别的一概不收。
//
// 【为什么不收 emoji 和标点】8 个汉字正好等于 cleanName 的宽度上限 16
// （排名列表就 696px 宽），emoji 的绘制宽度不可控，而且截断会切碎代理对。
//
// 【为什么撞 AI 名字要直接拒】678core 的 isGod 是按名字判的
// （name === GOD_NAME），真人取名「超哥」会被当成知道牌库顺序的 AI。
// 不能像 cleanName 那样撞了就加个点 —— 那会破了 4-8 位这条。
function chkLadName(s) {
    s = String(s == null ? '' : s).trim();
    let n = 0;
    for (const ch of s) {
        const c = ch.codePointAt(0);
        const ok = (c >= 0x30 && c <= 0x39) ||       // 0-9
                   (c >= 0x41 && c <= 0x5a) ||       // A-Z
                   (c >= 0x61 && c <= 0x7a) ||       // a-z
                   (c >= 0x4e00 && c <= 0x9fff);     // 汉字
        if (!ok) return null;
        n++;
    }
    if (n < 4 || n > 8) return null;
    if (AI_NAME_SET.has(s)) return null;
    return s;
}

//--- 落盘 ------------------------------------------------------------------

let accDirty = false, accSaveTimer = null;

// 攒 2 秒写一次，和本日计数同一个思路。注册和改名都是低频操作，
// 认证则完全不写盘 —— 别让每次登录都同步写一遍文件。
//
// 【先写临时文件再改名】账号不像本日计数那样丢了就丢了。直接覆写的话，
// 进程在写一半时被杀（部署、OOM）会留下一个截断的 JSON，下次启动读不回来
// —— 那是所有人的号一起没。rename 在同一个文件系统上是原子的。
function accSave() {
    accDirty = true;
    if (accSaveTimer) return;
    accSaveTimer = setTimeout(() => {
        accSaveTimer = null;
        if (!accDirty) return;
        accDirty = false;
        const out = { v: 1, list: [] };
        for (const a of accounts.values()) {
            out.list.push({ acc: a.acc, pw: a.pw, name: a.name,
                            renamedDay: a.renamedDay,
                            // 天梯战绩。ladSeason 存的是「这个分属于哪个赛季」，
                            // 少了它跨月重启会把上个赛季的分当本赛季的用
                            ladScore: a.ladScore, ladSeason: a.ladSeason,
                            ladGames: a.ladGames, ladSGames: a.ladSGames,
                            ladRankSum: a.ladRankSum, ladChamps: a.ladChamps,
                            // 历史战绩（最多 20 条）
                            ladHistory: a.ladHistory || [] });
        }
        const tmp = ACC_FILE + '.tmp';
        try {
            // 账号字段缩进显示，但 ladHistory 压成一行——
            // 20 条历史 × 十几个字段，全展开一个账号占几百行。
            // 用 0 做占位符再正则替换回紧凑数组。
            const items = out.list.map(a => {
                const hist = JSON.stringify(a.ladHistory);
                a.ladHistory = 0;
                let s = JSON.stringify(a, null, 2);
                s = s.replace(/"ladHistory": 0/, '"ladHistory": ' + hist);
                return s.replace(/^/gm, '    ');
            });
            fs.writeFileSync(tmp,
                '{\n  "v": 1,\n  "list": [\n' +
                items.join(',\n') + '\n  ]\n}', 'utf8');
            fs.renameSync(tmp, ACC_FILE);
        } catch (e) {
            log('天梯账号写盘失败（忽略）: %s', e.message);
            try { fs.unlinkSync(tmp); } catch (e2) {}
        }
    }, 2000);
}

function accLoad() {
    let raw = null;
    try { raw = fs.readFileSync(ACC_FILE, 'utf8'); }
    catch (e) { return; }            // 没有文件是正常的（第一次跑）
    // 去掉 BOM。我们自己写的没有，但这个文件是有可能被手工看/改的
    // （Windows 记事本、PowerShell 的 Out-File 都会加 BOM），而 JSON.parse
    // 遇到 BOM 直接抛 —— 那就会走到下面「读不回来」那条路，
    // 把整份账号挪进 .bad，所有人的号一起没。
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    let o = null;
    try { o = JSON.parse(raw); } catch (e) {}
    if (!o || !Array.isArray(o.list)) {
        // 读不回来别静默当成「没有账号」—— 那样下一次 accSave 就把这个坏文件
        // 覆盖掉，连证据都没了。挪到 .bad 留着，空着起服务。
        log('！天梯账号文件读不回来，已挪到 678-account.json.bad，本次以空账号启动');
        try { fs.renameSync(ACC_FILE, ACC_FILE + '.bad'); } catch (e) {}
        return;
    }
    for (const a of o.list) {
        const acc = chkAcc(a && a.acc);
        if (!acc) continue;
        const key = acc.toLowerCase();
        // 天梯字段读回来要过一遍数值校验：文件是可能被手工改的，
        // 一个 NaN 混进分数会顺着 Δ 公式污染整条链（NaN 参与比较永远 false，
        // 地板兜不住），而且会写回盘上。
        const num = (v, def) => (typeof v === 'number' && isFinite(v)) ? v : def;
        const rec = {
            acc: acc, pw: String(a.pw == null ? '' : a.pw), name: '',
            renamedDay: String(a.renamedDay || ''),
            ladScore:   Math.max(LAD_FLOOR, Math.round(num(a.ladScore, LAD_BASE))),
            ladSeason:  String(a.ladSeason || ''),
            ladGames:   Math.max(0, Math.round(num(a.ladGames, 0))),
            ladSGames:  Math.max(0, Math.round(num(a.ladSGames, 0))),
            ladRankSum: Math.max(0, Math.round(num(a.ladRankSum, 0))),
            ladChamps:  Math.max(0, Math.round(num(a.ladChamps, 0))),
            ladHistory: Array.isArray(a.ladHistory) ? a.ladHistory.slice(0, 20) : [],
        };
        // 名字要过一遍校验再认：规则以后收紧的话，老数据里不合规的那些
        // 就当没起过名，让他重新起一个
        const nm = a.name ? chkLadName(a.name) : null;
        if (nm && !ladNames.has(nm.toLowerCase())) {
            rec.name = nm;
            ladNames.set(nm.toLowerCase(), key);
        }
        accounts.set(key, rec);
    }
    log('天梯账号载入 %d 个（%s）', accounts.size, ACC_FILE);
}

//--- 令牌 / 请求辅助 -------------------------------------------------------

function newToken() {
    if (ladTokens.size >= TOKEN_MAX) {
        // 淘汰最早的那个。被淘汰的人下一次操作收到 401，客户端回登录页重认证
        const first = ladTokens.keys().next();
        if (!first.done) ladTokens.delete(first.value);
    }
    return crypto.randomBytes(16).toString('hex');
}

function accOfToken(tk) {
    const key = ladTokens.get(String(tk == null ? '' : tk));
    return key ? (accounts.get(key) || null) : null;
}

//--- GM ---------------------------------------------------------------------
// 运营数据（本日计数那四行、在线人数那两行）只有 GM 看得见（你定的）。
// 别人和未登录的一律拿不到数字，客户端收不到就整块不画。
//
// 【门禁必须在服务器】只在客户端判 `if (acc === 'derekgoodman')` 的话接口
// 照样对外裸奔 —— 改个前端变量、或者直接 curl 一下就看到了。
//
// 【按小写比】账号唯一性本来就是按小写存的（见 ladNames / accounts 的键）。
//
// 【密码不写死】账号由你自己注册并保管（2026-08-07 你定的）。所以这里只认
// 账号名 —— 谁登录上这个账号谁就是 GM。
const GM_ACC = 'derekgoodman';

function isGmAcc(a) {
    return !!(a && String(a.acc || '').toLowerCase() === GM_ACC);
}

// 请求带的令牌是不是 GM 的。给 /api/daily 和 /api/stats 用。
function isGmToken(tk) {
    return isGmAcc(accOfToken(tk));
}

// 发给客户端的账号信息。**绝不带 pw** —— 明文存是一回事，顺着接口发回去
// 是另一回事（浏览器 devtools 里直接就能看到）。
function accView(a) {
    return {
        acc: a.acc,
        name: a.name || '',
        // 今天还能不能改名。还没起过名时是「首次设置」，不算改名，所以也是 true
        canRename: !a.name || a.renamedDay !== dayKey(),
        // 天梯分和段位（开启排位界面要显示）
        score: ladScoreOf(a),
        tier: ladTier(ladScoreOf(a)),
        games: a.ladGames || 0,
        champs: a.ladChamps || 0,
        avgRank: (a.ladGames > 0) ? (a.ladRankSum / a.ladGames) : null,
        season: ladSeason(nowSec()).label,
    };
}

//=============================================================================
// 天梯计分
//=============================================================================
//
// 【为什么是收敛式而不是纯累加】纯累加（第1名+30、第8名-10 那种）只要平均
// 名次好于收支平衡点，分数就无上限地涨 —— 排行榜变成按在线时长排序，玩得多
// 的人永远第一，新人永远追不上。这个盘子小，头名跑远了榜就死了。
//
// 收敛式带自动刹车：分越高期望值越大，同样的名次给的分越少，到某个点停住。
// 两个水平一样的人，打 20 局和打 200 局最后落在同一个分段。
//
// 公式（N 人桌，名次 rank）：
//     s = (N - rank) / (N - 1)          实得成绩，第 1 名 = 1，末名 = 0
//     e = 1 / (1 + 10^((A - R) / 400))  期望成绩，A = 同桌其余人的平均分
//     Δ = K × (s - e)
// 收支平衡点正好在第 4.5 名（8 人桌的纯随机位置）—— 进前半区就赚，
// 掉后半区就亏，玩家不看说明也懂。

const LAD_BASE   = 1000;   // 新号起始分
const LAD_FLOOR  = 500;    // 分数地板。掉穿是纯挫败，没有信息量
const LAD_SCALE  = 400;    // Elo 尺度。放大 -> 榜的跨度变大
const LAD_MINGAMES = 10;   // 上榜门槛（累计场次）
const LAD_BOARD_N  = 100;  // 榜显示前多少名（AI 名单 300 个，撑得满还有余）

// K 值。定级期给大的（10 局就能落到大致正确的位置，不用爬几十局），
// 高分区收紧（榜首不会天天换）。
function ladK(score, games) {
    if (games < LAD_MINGAMES) return 120;
    if (score >= 1300) return 40;
    return 60;
}

// 段位。线是按**实测分布**定的，不是拍脑袋 —— 详见 ladAiState 的注释。
// 新号 1000 分落在「普通」的上沿：往上爬有三档，掉下去有一档。
const LAD_TIERS = [
    { min: 1220, name: '顶尖' },
    { min: 1120, name: '高手' },
    { min: 1020, name: '精通' },
    { min:  900, name: '普通' },
    { min:    0, name: '新手' },
];
function ladTier(score) {
    for (let i = 0; i < LAD_TIERS.length; i++) {
        if (score >= LAD_TIERS[i].min) return LAD_TIERS[i].name;
    }
    return LAD_TIERS[LAD_TIERS.length - 1].name;
}

//--- 赛季 ------------------------------------------------------------------
// 北京时间的自然月：8 月赛季 = 8/1 00:00 ~ 8/31 23:59（你定的）。
//
// 【必须自己加时区偏移】服务器多半跑在 UTC（Zeabur 就是），直接用
// getMonth() 会让赛季在北京时间早上 8 点才翻篇 —— 玩家 0 点看榜还是上个月。
const LAD_TZ = 8 * 3600;

function nowSec() { return Math.floor(Date.now() / 1000); }

function ladSeason(sec) {
    // 挪到北京时间再取年月：+8h 之后用 UTC 系列函数读，等价于按北京时间读
    const d = new Date((sec + LAD_TZ) * 1000);
    const y = d.getUTCFullYear(), m = d.getUTCMonth();
    return {
        y: y, m: m,
        startSec: Date.UTC(y, m, 1) / 1000 - LAD_TZ,       // 北京 1 日 00:00
        nextSec:  Date.UTC(y, m + 1, 1) / 1000 - LAD_TZ,
        key: y + '-' + (m + 1),
        label: y + '年' + (m + 1) + '月赛季',
    };
}

//--- 确定性哈希 ------------------------------------------------------------
// FNV-1a **加 murmur3 的收尾混合**。
//
// 【收尾混合不能省】FNV 单独用时高位扩散很差，而 ladFrac 取的正好是高位
// （除以 2^32）。少了这一步，'#k5' 和 '#k25' 这种只差一个字符的输入会给出
// 相关的小数 —— Box-Muller 的两路取样一相关，每个 AI 的正态就带一个固定
// 偏向。实测症状：某个 AI 的平均名次死钉在 6.00，基准 1178 的收敛到 751
// （偏离 8 个标准差）。加上之后偏离回到 3 倍标准误以内。
function ladH32(s) {
    let x = 2166136261;
    for (let i = 0; i < s.length; i++) {
        x ^= s.charCodeAt(i);
        x = Math.imul(x, 16777619);
    }
    x ^= x >>> 16; x = Math.imul(x, 2246822507);
    x ^= x >>> 13; x = Math.imul(x, 3266489909);
    x ^= x >>> 16;
    return x >>> 0;
}
function ladFrac(s) { return ladH32(s) / 4294967296; }

//--- 基准分 -> 真收敛分 ----------------------------------------------------
// 【为什么不能直接拿基准分当收敛点】名次被 clamp 到 1~8 再取整，高基准的 AI
// 头部被截掉一截（目标名次 1.6 时正态的左尾全压在第 1 名上），实得成绩因此
// 低于目标成绩，收敛点就落在基准之下。实测差值：
//     基准 1200 -> 收敛 1175（-25）
//     基准 1300 -> 收敛 1242（-58）
//     基准 1420 -> 收敛 1297（-123）  <- 抬基准已经没用了
// 所以 AI 的分数天花板是 1300 左右。段位「顶尖」如果定在 1350，那一档
// 永远只有真人，AI 一个都进不去 —— 榜上看就是空的。
//
// 这里对 sd=1.9 的正态做数值积分算出截断后的实得成绩，再反解收敛分。
// 赛季开局的分数用它，这样分数在赛季里是围绕它波动，不是单向往下掉。
const LAD_RANK_SD = 1.9;
const ladConvCache = new Map();
function ladConv(base) {
    if (ladConvCache.has(base)) return ladConvCache.get(base);
    const e = 1 / (1 + Math.pow(10, (LAD_BASE - base) / LAD_SCALE));
    const target = 8 - 7 * e;
    let sum = 0, tot = 0;
    for (let z = -6; z <= 6; z += 0.004) {
        const w = Math.exp(-z * z / 2);
        const r = Math.min(8, Math.max(1, Math.round(target + z * LAD_RANK_SD)));
        sum += w * (8 - r) / 7;
        tot += w;
    }
    const s = sum / tot;
    const R = (s <= 0 || s >= 1) ? base
            : Math.round(LAD_BASE + LAD_SCALE * Math.log10(s / (1 - s)));
    ladConvCache.set(base, R);
    return R;
}

//--- AI 的分数漂移 ---------------------------------------------------------
// 你要的是「分数在随机时刻不停地动，像真有人在玩」。
//
// 【为什么是无状态的纯函数】不存任何漂移状态，分数是 f(名字, 时刻) ——
// 从赛季起点确定性地重放一串虚拟对局。这样 Zeabur 上进程重启、多实例都不会
// 让数字跳：同一时刻任何请求算出来都是同一个分。而且场次、平均名次、冠军
// 次数跟着一起长，几个数字互相对得上，不会出现「分涨了但场次没动」。
//
// 【人格分两层】
//   · core（不带赛季种子）—— 长期强弱，跨季稳定。少了它「谁强谁弱」每月洗牌，
//     榜就没有熟脸了。
//   · wob（带赛季种子，±70）—— 赛季浮动。少了它实测榜首连续三个月同一个 AI。
//
// 【基准区间 720~1280 是反推出来的】要让收敛中位落在 998 ≈ 真人的 1000 起点。
// 原来用 880~1380，收敛中位 1117 —— 于是平均名次 4.5（纯随机水平）的真人会
// 收敛到 1156 分，白拿 156 分还直接进「高手」。
//
// 【start 一律是 1000，不是收敛分】base 只决定这个 AI **打得多好**（喂给
// ladRollRank 的目标名次），不再直接当分数发下去。
//
// 原来 start = ladConv(base)，等于每个 AI 开局就白拿一个 766~1302 的分。
// 配 400~800 场时还自洽，但场次夹到 LAD_LAUNCH 之后只剩个位数 —— 于是出现
// 「5 场 1302 分、均名次 1.2」这种行：比该场次全胜的上限（1218）还高 84 分，
// 真人怎么打都到不了。当时实测 115 行里有 5 行数学上不可能，你一眼看出来的
// 就是它。（_tmp 的名单校验里留了一条「分数 <= 1000 + 场次*32」的断言防复发）
//
// 现在所有人从 1000 出发，靠重放一局一局爬。强弱照样分得开（base 决定名次
// 分布，分数跟着名次走），代价是上线头几天榜挤在 1000 附近 —— 那是对的，
// 因为天梯就是刚开。
function ladPersona(name, seedKey) {
    const core = 720 + Math.floor(ladFrac(name + '#b') * 561);          // 720~1280
    const wob  = Math.round((ladFrac(name + '#w' + seedKey) - 0.5) * 140);
    const base = Math.max(820, Math.min(1420, core + wob));
    // 名义 rate。下面的作息筛会拒掉约 60%（LAD_HOURS 的平均值 ~0.40），
    // 所以要先除回去，实际落地才是 3~14 局/天。
    const rate = (3 + ladFrac(name + '#r' + seedKey) * 11) / 0.40;
    return { base: base, core: core, start: LAD_BASE, rate: rate,
             phase: ladFrac(name + '#p' + seedKey) };
}

// 一天里各时段的活跃权重（北京时间 0 点起，每格 1 小时）。
// 晚 8~11 点高峰，凌晨 3~6 点近乎没人 —— 全天均匀铺开的话凌晨四点也在打牌，
// 那个一眼就假。
const LAD_HOURS = [
    0.30, 0.16, 0.08, 0.04, 0.03, 0.04,   //  0~5
    0.10, 0.24, 0.34, 0.40, 0.44, 0.46,   //  6~11
    0.52, 0.44, 0.42, 0.46, 0.50, 0.56,   // 12~17
    0.66, 0.80, 1.00, 0.96, 0.74, 0.50,   // 18~23
];

// 第 k 局虚拟对局的时刻。每局自带 ±40% 抖动 —— 所以分数变动落在零散的随机
// 时刻上，不是整点跳一次。
function ladMatchAt(name, p, k, startSec, seedKey) {
    const step = 86400 / p.rate;
    const jit = (ladFrac(name + '#j' + seedKey + '_' + k) - 0.5) * 0.8;
    return startSec + (k + p.phase + jit) * step;
}

// 这一局打不打得起来。均匀排好的时刻再过一道接受筛：凌晨那几格权重低，
// 多数候选局被筛掉 —— 场次在夜里几乎不长，白天晚上长得快。
// 保持无状态、可重放，代价只是 rate 被打了个折（已在 ladPersona 里补回）。
function ladHappens(name, k, t, seedKey) {
    const hr = Math.floor((((t + LAD_TZ) % 86400) + 86400) % 86400 / 3600);
    return ladFrac(name + '#h' + seedKey + '_' + k) < LAD_HOURS[hr];
}

// 本局名次：围绕人格目标名次取正态样本，clamp 到 1~8。
function ladRollRank(name, p, k, seedKey) {
    const e = 1 / (1 + Math.pow(10, (LAD_BASE - p.base) / LAD_SCALE));
    const target = 8 - 7 * e;
    const u = ladFrac(name + '#k' + seedKey + '_' + k);
    const v = ladFrac(name + '#k2' + seedKey + '_' + k);
    // Box-Muller。u 可能是 0，加 1e-12 防 log(0)
    const z = Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * v);
    return Math.min(8, Math.max(1, Math.round(target + z * LAD_RANK_SD)));
}

// 天梯的「上线时刻」。AI 的虚拟对局从这里才开始数 —— 场次 / 冠军的累计起点。
//
// 【为什么需要这么一条线】原来这里是 LAD_AI_EPOCH = 2026-06-01，历史赛季
// 一路重放到今天，于是 AI 的场次累到了 400~800 场。天梯 2026-08-06 才真的
// 开放，「刚上线就有人打了 700 局」一眼假（你报的）。
//
// 【分数也从这条线起算】以前这里写的是「分数不需要时间累积」—— 那时 start 是
// 收敛分，个位数场次也能挂 1300。现在 start 一律 1000（见 ladPersona），
// 分数和场次同一条时间线：场次少就意味着分还没爬开，两个数字互相对得上。
//
// 【往后不用再动】重放是 f(名字, 时刻)，场次自己跟着真实时间长：上线第 1 天
// 中位 9 场，第 2 天 19 场，第 7 天 67 场。分数跟着一起慢慢散开。
const LAD_LAUNCH = Date.UTC(2026, 7, 6) / 1000 - LAD_TZ;   // 北京 2026-08-06

// 单个赛季内的重放。返回 {score, games, rankSum, champs}。
// upto 截断到某个时刻（当前赛季用 now，历史赛季用赛季终点）。
//
// 【起点要夹一道 LAD_LAUNCH】天梯是 8/6 上线的，而 8 月赛季从 8/1 起算 ——
// 不夹的话头 5 天的对局也会被重放出来，等于凭空多算 5 天的场次。
function ladReplaySeason(name, season, upto, startScore) {
    const seedKey = season.key;
    const p = ladPersona(name, seedKey);
    const from = Math.max(season.startSec, LAD_LAUNCH);
    let R = (startScore === undefined) ? p.start : startScore;
    let games = 0, rankSum = 0, champs = 0;
    for (let k = 0; k < 100000; k++) {
        const t = ladMatchAt(name, p, k, from, seedKey);
        if (t > upto) break;
        if (!ladHappens(name, k, t, seedKey)) continue;
        const r = ladRollRank(name, p, k, seedKey);
        const s = (8 - r) / 7;
        const e = 1 / (1 + Math.pow(10, (LAD_BASE - R) / LAD_SCALE));
        let d = Math.round(ladK(R, games) * (s - e));
        if (r === 1 && d < 1) d = 1;          // 赢了不涨分说不通
        R = Math.max(LAD_FLOOR, R + d);
        games++; rankSum += r;
        if (r === 1) champs++;
    }
    return { score: R, games: games, rankSum: rankSum, champs: champs };
}

// 历史赛季的累计（场次 / 名次和 / 冠军）。**只在赛季翻篇时变**，所以可以
// 永久缓存 —— 否则每次查榜都要从 2026-06 重放到现在，赛季越多越慢。
const ladHistCache = new Map();   // '名字|赛季key' -> {games, rankSum, champs}
function ladHistory(name, curSeason) {
    const ck = name + '|' + curSeason.key;
    const hit = ladHistCache.get(ck);
    if (hit) return hit;
    let games = 0, rankSum = 0, champs = 0;
    // 从上线时刻起算。上线那个赛季（8 月）本身不在历史里 —— 循环条件是
    // 「早于当前赛季起点」，所以上线当月就是当前赛季时这个循环一次都不跑。
    let cur = LAD_LAUNCH;
    // 一个月一个月往前推到当前赛季（不含）
    let guard = 0;
    while (cur < curSeason.startSec && guard++ < 600) {
        const sn = ladSeason(cur);
        const r = ladReplaySeason(name, sn, Math.min(sn.nextSec, curSeason.startSec));
        games += r.games; rankSum += r.rankSum; champs += r.champs;
        cur = sn.nextSec;
    }
    const out = { games: games, rankSum: rankSum, champs: champs };
    ladHistCache.set(ck, out);
    return out;
}

// 一个 AI 此刻的榜行。分数按赛季重置，场次 / 均名次 / 冠军是累计的。
function ladAiState(name, now) {
    const sn = ladSeason(now);
    const cur = ladReplaySeason(name, sn, now);
    const hist = ladHistory(name, sn);
    const games = hist.games + cur.games;
    const rankSum = hist.rankSum + cur.rankSum;
    return {
        name: name,
        score: cur.score,
        games: games,
        // 【本赛季场次】上榜门槛看这个，不是 games（2026-08-07 你定的：每赛季
        // 重新爬一次才有动力）。games 仍是生涯累计 —— 榜上「场次」那一列和
        // avgRank 用它，那是「这人打过多少局」，跨季不该清零。
        sGames: cur.games,
        champs: hist.champs + cur.champs,
        avgRank: games > 0 ? rankSum / games : null,
        ai: true,
    };
}

//--- 真人的分 --------------------------------------------------------------
// 账号记录上的天梯字段（accLoad / accSave 里跟着走）：
//   ladScore     本赛季分数
//   ladSeason    这个分属于哪个赛季（key）。对不上就先做软重置
//   ladGames     累计场次（跨赛季，上榜门槛看它）
//   ladRankSum   累计名次和（算平均排名）
//   ladChamps    累计冠军次数
//   ladSGames    本赛季场次（K 值的定级期看它）
//
// 【跨季软重置】新分 = (旧分 + 1000) / 2。月赛季下每月削一半差值：
// 1300 分的人下月从 1150 起。清零太狠（一个月的努力全没），不重置又让
// 赛季这个概念没意义。
function ladScoreOf(a) {
    const sn = ladSeason(nowSec());
    if (a.ladSeason !== sn.key) {
        // 惰性重置：读到的时候才算。定时任务会漏掉不活跃的号，而这个不会。
        const old = (typeof a.ladScore === 'number') ? a.ladScore : LAD_BASE;
        a.ladScore = Math.round((old + LAD_BASE) / 2);
        a.ladSeason = sn.key;
        a.ladSGames = 0;
        accSave();
    }
    return a.ladScore;
}

// 一局结束后给真人算 Δ。
//
// 【同桌均分不能用「实际抽到谁的平均分」】D678.AI.profile() 里除超哥外所有 AI
// 返回同一组参数（depth 2 / expand 2 / th 0.6 / noise 0.45）—— 榜上写 1280 的
// 和写 750 的，打起来一模一样。用实际平均分的话，「抽到 7 个高分 AI」那局同样
// 的名次会给更多分，而实际难度没有任何差别。那是计分本身的漏洞。
//
// 所以真人的 A 只看**超哥有几个**（真正影响难度的只有这个），以及同桌有几个
// 真人（真人的分是真的，该算进去）。
const LAD_AI_FIELD = 1035;   // 普通 AI 的等效分（实测 AI 榜的中位数）
const LAD_GOD_FIELD = 1600;  // 超哥的等效分

function ladFieldAvg(room, meSeat) {
    const g = room.game;
    let sum = 0, n = 0;
    g.players.forEach((p, i) => {
        if (meSeat && i === meSeat.pIdx) return;         // 不含自己
        const st = room.seats.find(s => s && s.pIdx === i);
        if (st && st.ladAcc) {
            // 同桌的真人：用他真实的分
            const a = accounts.get(st.ladAcc);
            sum += a ? ladScoreOf(a) : LAD_BASE;
        } else if (p.isGod) {
            sum += LAD_GOD_FIELD;
        } else {
            sum += LAD_AI_FIELD;
        }
        n++;
    });
    return n > 0 ? sum / n : LAD_AI_FIELD;
}

// 结算：把这一局的名次算进账号。返回 {delta, score, tier, ...} 给客户端。
function ladSettle(room, seat, rank, total) {
    const a = seat.ladAcc ? accounts.get(seat.ladAcc) : null;
    if (!a) return null;
    const before = ladScoreOf(a);
    const N = Math.max(2, total);
    const s = (N - rank) / (N - 1);
    const A = ladFieldAvg(room, seat);
    const e = 1 / (1 + Math.pow(10, (A - before) / LAD_SCALE));
    const sGames = a.ladSGames || 0;
    let d = Math.round(ladK(before, sGames) * (s - e));
    if (rank === 1 && d < 1) d = 1;
    const after = Math.max(LAD_FLOOR, before + d);

    a.ladScore   = after;
    a.ladGames   = (a.ladGames || 0) + 1;
    a.ladSGames  = sGames + 1;
    a.ladRankSum = (a.ladRankSum || 0) + rank;
    if (rank === 1) a.ladChamps = (a.ladChamps || 0) + 1;
    accSave();
    // 榜有 30 秒缓存。不在这里失效的话「打完一局去看榜」最多要等 30 秒才看到
    // 新分数和新名次 —— 那正是玩家最想马上看一眼的时刻。
    // 结算是低频事件，让它多算一次全榜（约 130ms）完全划得来。
    ladBoardBust();

    log('天梯结算 %s 第 %d/%d 名，%s%d -> %d 分',
        a.name || a.acc, rank, N, (after - before >= 0 ? '+' : ''),
        after - before, after);
    return {
        delta: after - before,
        score: after,
        tier: ladTier(after),
        games: a.ladGames,
        champs: a.ladChamps || 0,
        avgRank: a.ladRankSum / a.ladGames,
    };
}

//--- 历史战绩 ----------------------------------------------------------------
// 在账号上记一条天梯对局。淘汰 / 退出时调 ladHistoryAdd 建一条 pending，
// 对局结束（enterOverT）时调 ladHistoryFinalize 补 endedAt / overInfo / expectedEndAt。
//
// 【为什么 pending 也要写盘】玩家被淘汰后赛事可能还在打（多真人），
// 他回大厅点「历史战绩」要看到「对局中」。pending 条目存账号文件里，
// 服务器重启也不丢。万一房间被异常销毁（掉线未回来等），条目会永远停在
// pending —— 罕见，可接受。

function ladHistoryAdd(accKey, gameId, startedAt, rank, total, result, quit, vsLog) {
    const a = accKey ? accounts.get(accKey) : null;
    if (!a) return;
    if (!a.ladHistory) a.ladHistory = [];
    // 同一局不应该有两条；保险起见去重
    a.ladHistory = a.ladHistory.filter(h => h.gameId !== gameId);
    a.ladHistory.unshift({
        gameId: gameId,
        startedAt: startedAt || Date.now(),
        endedAt: null,             // null = 对局未结束
        expectedEndAt: null,       // null = 对局未结束
        rank: rank,
        total: total,
        delta: result ? result.delta : 0,
        score: result ? result.score : 0,
        tier: result ? result.tier : '',
        quit: !!quit,
        overInfo: null,            // null = 不能看详情
        // 被淘汰 / 退出时拍的 vsLog：你对每个交手过的对手的胜负。
        // overInfo 是最终数据，但 vsLog 在你离场后就不再变了 —— 拍一份留着。
        vsLog: vsLog || null,
    });
    if (a.ladHistory.length > 20) a.ladHistory.length = 20;
}

// 对局结束时补全 pending 条目。expectedEndAt 之前详情锁定（单人天梯快进）。
function ladHistoryFinalize(accKey, gameId, endedAt, expectedEndAt, overInfo) {
    const a = accKey ? accounts.get(accKey) : null;
    if (!a || !a.ladHistory) return;
    const entry = a.ladHistory.find(h => h.gameId === gameId);
    if (!entry) return;
    entry.endedAt = endedAt;
    entry.expectedEndAt = expectedEndAt;
    entry.overInfo = overInfo;
}

// 把房间里所有还没结算的天梯座位按**末名**结算。
//
// 用在「房间要被销毁、但赛事还没走到 enterOverT」的时刻 —— 那条路上没有
// 名次可言（赛事没打完），而且不按末名算就等于给掉线开了一道免罚门。
//
// 【为什么不用 rankOf 的真实名次】rankOf 是按存活者 HP 排的，领先时掉线会
// 算出第 1 名 —— 那样「赢着的时候拔网线」就成了最优策略。和 /api/leave
// 那条同一个口径：中途走人一律末名。
function ladSettleAllLeft(room, why) {
    if (!room || room.mode !== 'ladder' || !room.game) return;
    const total = room.game.players.length;
    room.seats.forEach(seat => {
        if (!seat || !seat.ladAcc || seat.ladResult) return;
        seat.ladResult = ladSettle(room, seat, total, total);
        if (seat.ladResult) {
            seat.ladResult.quit = true;
            ladHistoryAdd(seat.ladAcc, room.code, room.tourneyStartAt,
                total, total, seat.ladResult, true,
                snapshotVsLog(room, seat.pIdx));
            log('房间 %s %s %s -> 按末名结算', room.code, seat.name, why);
            // 连接大概已经没了，发了也就发了（sendTo 自己判 seat.sse）
            sendTo(seat, 'ladscore', seat.ladResult);
        }
    });
}

//--- 榜 --------------------------------------------------------------------
// 真人行 + AI 行合并排序取前 LAD_BOARD_N。缓存 30 秒 —— 分数本来就是分钟级
// 在动，30 秒的滞后看不出来。
//
// 【开销随「赛季内已过天数」长，不是固定值】每个 AI 都要把本赛季的对局从
// 赛季初重放到现在，所以月初便宜、月末贵。300 个 AI 实测：
//   赛季第 4 天    ~26ms
//   赛季第 30 天   ~80ms（按每 AI 每月中位 283 局线性推）
// 30 秒缓存下一分钟摊两次，可以忽略。
//
// 【真正大的那一次是跨月】ladHistory 按「名字|赛季」永久缓存，但赛季一翻篇
// 全部失效，要把过去每个月重放一遍。300 个 × 12 个赛季实测约 1 秒，单线程
// 阻塞，一个赛季只发生一次、只卡第一个查榜的人。真嫌难看就挪到启动预热。
let ladBoardCache = null, ladBoardAt = 0;
const LAD_BOARD_TTL = 30000;

// 让榜的缓存立刻失效。结算后调（见 ladSettle），测试里直接改账号后也要调。
function ladBoardBust() { ladBoardCache = null; ladBoardAt = 0; }

function ladBoard() {
    const now = Date.now();
    if (ladBoardCache && now - ladBoardAt < LAD_BOARD_TTL) return ladBoardCache;
    const t = nowSec();
    const rows = [];
    // AI。**和真人同一道 10 场门槛**（你定的）。不满 10 场的 AI 就是「定级中」，
    // 不进榜 —— 榜上每一行都是打够 10 场的，跟真人一个口径。
    //
    // 原来是 games > 0 就进榜，理由是「AI 没有定级这回事」。但那会让榜上出现
    // 3 场就挂高分的行，而真人打满 10 场定级完才 1000 出头 —— 两套尺子。
    // 所以现在 AI 也得爬过 10 场，榜是跟着时间自己长满的。
    for (const nm of D678.LAD_AI_NAMES) {
        const st = ladAiState(nm, t);
        if (st.sGames >= LAD_MINGAMES) rows.push(st);
    }
    // 真人。门槛按**本赛季**场次算（2026-08-07 你定的）。
    //
    // 【这里原来是累计场次】理由写的是「按赛季场次算的话月初全体定级中，榜会
    // 空掉好几个小时」。现在反过来接受那个代价 —— 每赛季重新爬一次正是动力
    // 来源。实测 9/1：当天 0 行、第 1 天爬起来一批、第 3 天基本满。空榜那段窗口
    // 客户端画一行「新赛季刚开始，所有人都在定级中」（见 678net.js 的 drawBoard）。
    //
    // 【必须先调 ladScoreOf 再读 ladSGames】ladScoreOf 里有跨季惰性重置，
    // 它才会把 ladSGames 归零。反过来的话月初第一次查榜读到的是**上赛季的
    // 残值** —— 上个月打满 10 局的人会直接上榜，这道门槛等于没有。
    // 原来的代码正是先读 ladGames 后调 ladScoreOf（累计场次不受重置影响，
    // 所以那时候没事），换成赛季字段后这个顺序就是 bug。
    for (const a of accounts.values()) {
        if (!a.name) continue;                       // 还没起天梯名
        const score = ladScoreOf(a);                 // 先触发跨季重置
        if ((a.ladSGames || 0) < LAD_MINGAMES) continue;
        const games = a.ladGames || 0;
        rows.push({
            name: a.name, score: score, games: games,
            champs: a.ladChamps || 0,
            avgRank: games > 0 ? a.ladRankSum / games : null,
            ai: false, acc: a.acc.toLowerCase(),
        });
    }
    rows.sort((x, y) => (y.score - x.score) || x.name.localeCompare(y.name));
    rows.forEach((r, i) => { r.rank = i + 1; });
    ladBoardCache = { rows: rows, season: ladSeason(t).label };
    ladBoardAt = now;
    return ladBoardCache;
}

// 发给客户端的榜：前 100 行 + 自己那一行（可能在 100 名以外）。
function ladBoardView(acc) {
    const b = ladBoard();
    const view = r => ({
        rank: r.rank, name: r.name, score: r.score, tier: ladTier(r.score),
        games: r.games, champs: r.champs,
        // 平均排名保留 1 位小数（你定的，比如 2.3）
        avgRank: (r.avgRank == null) ? null : Math.round(r.avgRank * 10) / 10,
    });
    const out = {
        season: b.season,
        total: b.rows.length,
        rows: b.rows.slice(0, LAD_BOARD_N).map(view),
        me: null,
    };
    if (acc) {
        const key = acc.acc.toLowerCase();
        const mine = b.rows.find(r => !r.ai && r.acc === key);
        if (mine) {
            out.me = view(mine);
            out.me.onBoard = mine.rank <= LAD_BOARD_N;
        } else {
            // 没上榜：可能是场次不够（定级中），也可能是还没起名
            //
            // 【定级看赛季场次】和 ladBoard 同一道门槛（2026-08-07 改）。
            // 同样必须先调 ladScoreOf 触发跨季重置，再读 ladSGames ——
            // 否则月初「还差几局」会按上赛季的场次算出 0。
            const score = ladScoreOf(acc);
            const sGames = acc.ladSGames || 0;
            const games = acc.ladGames || 0;
            out.me = {
                rank: null, name: acc.name || '', score: score,
                tier: ladTier(score), games: games,
                champs: acc.ladChamps || 0,
                avgRank: games > 0
                    ? Math.round(acc.ladRankSum / games * 10) / 10 : null,
                onBoard: false,
                rating: sGames < LAD_MINGAMES,      // 定级中
                need: Math.max(0, LAD_MINGAMES - sGames),
            };
        }
    }
    return out;
}

// 取客户端 IP。平台在前面架了反向代理，socket 上看到的是代理的地址，
// 所以先认 x-forwarded-for 的第一段。这个头可以伪造 —— 它只用来给注册
// 加个冷却，不做任何鉴权用途。
function ipOf(req) {
    const f = req.headers['x-forwarded-for'];
    if (f) return String(f).split(',')[0].trim().slice(0, 45);
    return String((req.socket && req.socket.remoteAddress) || '').slice(0, 45);
}

function regTooSoon(ip) {
    const now = Date.now();
    // 顺手清过期的，免得这个表跟着 IP 数一直涨
    if (regCool.size > 1000) {
        for (const [k, t] of regCool) {
            if (now - t > REG_COOL_MS) regCool.delete(k);
        }
    }
    const last = regCool.get(ip);
    return !!(last && now - last < REG_COOL_MS);
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
// 视角置换：把「我」搬到 players[0]、对手搬到 players[1]，其余按原序跟在后面。
//
// 为什么对手一定放 1 号位：客户端 buildBattle 是按 sides[i] <-> players[i]
// 平行数组接的（`b.sides[i].p = game.players[i]`）。让对手固定落在 1 号位，
// 那段代码在 8 人赛下一行都不用改，而排名列表读的是整个 players 数组、
// 按 outAt/hp 自己排序，不依赖数组顺序。
//
// 轮空的人没有对手：只有自己在 0 号位，其余原序跟随。
function viewOrder(playerN, mePIdx, oppPIdx) {
    const ord = [mePIdx];
    if (oppPIdx >= 0 && oppPIdx !== mePIdx) ord.push(oppPIdx);
    for (let i = 0; i < playerN; i++) {
        if (i !== mePIdx && i !== oppPIdx) ord.push(i);
    }
    return ord;
}

//--- 结算结果的遮蔽（1v1 和锦标赛共用这一份）--------------------------------
//
// 【为什么必须共用】原来 maskView 和 maskViewT 各自手写了一份字段清单，
// 而 doResolve 会按规则往 result 上挂额外字段：
//   · 牛牛  -> r.cows        （成绩是「牛4 / 牛牛 / 无牛」，不是点数）
//   · 比多  -> r.cardCounts  （判定看张数，点数根本不该显示）
// 两份清单都漏了这两个字段，于是多人模式下：
//   · 拼点画面退回画总点数（drawShowdownTotal 靠 r.cows / r.cardCounts 分支）
//   · 满点大字写「满点!」而不是「牛 牛 !」（maxFxText 读 r.cows）
// 规则在服务器上其实是生效的 —— 只是客户端拿不到成绩，看起来像「没生效」。
// 这就是用户报的「牛牛/比多没生效、拼点时显示也不会」。
//
// 【新增规则牌时看这里】如果新规则也往 result 上挂按 side 索引的数组，
// 加进 SIDE_ARRAYS 就行，两种模式一起生效，不会再漏一边。
// 挂的是标量（双方对称）就加进 SCALARS。
const RESULT_SIDE_ARRAYS = ['totals', 'busts', 'maxes', 'cows', 'cardCounts'];
const RESULT_SCALARS     = ['tie', 'dmg', 'items', 'target',
                            'tieCount', 'tieBonus', 'comeback'];

// meSide 是「我」在这桌的 side（0/1）。返回的视图里我恒为下标 0。
// winnerP / loserP 是 Player 对象引用，绝不能直接发（会把对方全部字段带出去），
// 所以单独抽成 winnerName / loserName。
function maskResult(r, meSide) {
    if (!r) return null;
    const sw = (arr) => (meSide === 0 ? arr.slice(0) : [arr[1], arr[0]]);
    const out = {
        winner: r.tie ? -1 : (r.winner === meSide ? 0 : 1),
        winnerName: r.winnerP ? r.winnerP.name : '',
        loserName:  r.loserP  ? r.loserP.name  : '',
    };
    // 按 side 索引的数组：跟着镜像。没有这个字段的规则就不发（客户端按
    // 「有没有这个字段」分支，发个 undefined 会让 JSON 里整个消失，正合适）
    RESULT_SIDE_ARRAYS.forEach(k => {
        if (Array.isArray(r[k])) out[k] = sw(r[k]);
    });
    // 双方对称的标量：原样带过去。tie 要保证是布尔，别把 undefined 发出去
    RESULT_SCALARS.forEach(k => {
        if (r[k] !== undefined) out[k] = (k === 'tie') ? !!r[k] : r[k];
    });
    if (out.tie === undefined) out.tie = false;
    if (out.dmg === undefined) out.dmg = 0;
    if (out.items === undefined) out.items = 0;
    return out;
}

//--- 二选一待选状态的遮蔽（1v1 和锦标赛共用）-------------------------------
//
// 【两张候选的点数只发给选的那个人】对手只该知道「他正在二选一」——
// 知道候选是什么就等于知道了牌库顶两张，那是查看牌库才有的情报。
// 没选的那张会压到牌库底，所以泄漏出去连「牌库最后一张是什么」都送了。
//
// 【锦标赛原来整个漏了这个字段】maskViewT 的 view 里压根没有 pick2，
// 客户端于是永远不知道「该我选牌了」：buildBattle 造出来的副本 pending2
// 是 null，drawPick2 不会被调用，两个候选牌的点击区一个都不注册 ——
// 表现就是用户报的「二选一点击后无任何反应」。
function maskPick2(b, meSide) {
    if (!b.pending2) return null;
    const mine = (b.pending2.side === meSide);
    return {
        mine: mine,
        vals: mine ? b.pending2.vals.slice(0) : null,
    };
}

// b 是一桌对局；me / opp 是这桌的两个 side 对应的 game.players 下标。
// meSide 是「我」在这桌的 side（0 或 1）—— 镜像后我永远显示成 side 0。
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
                // 假牌标记 + 卡图名（+1/-1/复制品）。
                // 【不算泄漏】假牌一律正面打出，双方本来就看得见；
                // 不发的话对方那一排的复制品不染色、+1/-1 会显示成 1 号牌。
                fake: c.fake || undefined,
                face: c.face || undefined,
                // 稳定身份，客户端的精灵靠它认牌（见 678.js 的 cardKey）。
                // 【不算泄漏】uid 只是个自增序号，不带任何牌面信息 ——
                // 从它只能看出「这张牌是第几张被造出来的」，而出牌顺序本来就
                // 是双方都看得见的。不发的话客户端只能退回下标，
                // 「删中间那张」时后面的牌会全部误判成新牌重新入场。
                uid: c.uid,
            })),
            stood: s.stood,
            // 对方用过几张查看牌库不该暴露，只发自己的
            checkN: mine ? s.checkN : 0,
        };
    };

    // result 的 totals/busts/maxes 都是按 side 索引的数组，要跟着镜像；
    // winnerP / loserP 是 Player 对象引用，不能发（会把对方全部字段带出去）
    const result = maskResult(b.result, me);

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

    // 二选一的待选状态（遮蔽规则见 maskPick2）
    const pick2 = maskPick2(b, me);

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
        pick2: pick2,
        // 见 preOf 的注释：只有结算那一帧会带上
        preFuncs: snapPre ? ord(preOf) : null,
        preFuncCounts: snapPre ? ord(preCount) : null,
    };
}

// 锦标赛版的遮蔽。和 1v1 那个分开写，不去改已经跑通的那条路。
//
// 差别只有两处：
//   · players 是全部 8 个（排名列表要），sides 仍然只有 2 个（一桌就两个人）
//   · players 多带 isHuman / isGod / status，客户端 buildReplica 靠它们
//     正确构造副本 —— 1v1 版那边写死了 isHuman=(i===0) 和 isGod=false
//
// bt 是一桌（含 pIdx 对、side 映射）；seat 是看这份数据的那个人。
// bt 为 null 表示这个人本轮轮空或已经打完，此时不发任何牌面。
function maskViewT(room, bt, seat, snapPre) {
    const g = room.game;
    const mePIdx = seat.pIdx;
    const oppPIdx = bt ? (bt.pIdx[0] === mePIdx ? bt.pIdx[1] : bt.pIdx[0]) : -1;
    const ord = viewOrder(g.players.length, mePIdx, oppPIdx);

    const P = (pIdx) => {
        const p = g.players[pIdx];
        const st = room.seats.find(s => s && s.pIdx === pIdx);
        // 假 AI 桌算完了但还没公布：HP/胜负用公布前的快照，
        // 否则真人那桌一推状态，另外几桌 AI 已经掉血了，
        // 而这一轮还没打完 —— 泄漏 AI 身份。
        const fakeBt = room.battles.find(x => x.fakeAI && !x.done &&
                                              x.pIdx.indexOf(pIdx) >= 0);
        const ps = (fakeBt && fakeBt.preStats && fakeBt.preStats[pIdx]) || null;
        return {
            name: p.name,
            hp: ps ? ps.hp : p.hp,
            alive: p.alive,
            wins: ps ? ps.wins : p.wins,
            losses: ps ? ps.losses : p.losses,
            maxPoint: ps ? ps.maxPoint : p.maxPoint,
            funcUses: p.funcUses,
            // 【淘汰顺序，排名表按它排】少了这个字段客户端副本里所有死人的
            // outAt 都是 0，rankedPlayers 的 `b.outAt - a.outAt` 对每一对死人
            // 都返回 0 —— sort 是稳定的，于是死人区退化成 players 数组的原序，
            // 也就是 viewOrder 给的 pIdx 升序。症状：已经淘汰的人名次会随着
            // 后面有人被淘汰而变动，而且最早淘汰的可能排在后淘汰的上面
            // （你报的）。服务器的最终排名和淘汰页是另一条路（直接读
            // room.game，outAt 是真值），所以那两处一直是对的 —— 只有对局中
            // 途看的那张排名表在骗人，这也是它能活到现在的原因。
            //
            // 不算信息泄漏：淘汰顺序是玩家每轮都看得见的公开信息。
            outAt: p.outAt || 0,
            funcs: (pIdx === mePIdx) ? p.funcs.slice(0) : null,
            funcCount: p.funcs.length,
            // 客户端要靠这两个还原 AI 行为（超哥按超哥打）。
            //
            // 【天梯下绝不发 isGod】天梯里超哥借用普通 AI 的名字，玩家不该知道
            // 这局谁是超哥 —— 发下去的话打开 devtools 就能看出来，换名字整个
            // 白做。核对过：客户端只在 678net.js 的 buildReplica 里把它存进副本，
            // 联机对局里从不读它（读它的只有单机的教程对手筛选），所以不发是
            // 安全的。缺字段时 buildReplica 那句 `!!info.isGod` 得到 false。
            isHuman: !!p.isHuman,
            isGod: (room.mode === 'ladder') ? undefined : !!p.isGod,
            // 排名列表的「胜/负」一栏（drawRankList -> lastText）。
            // prevLast 是上一轮的，那一轮全场都打完了，8 个人的都能发。
            // last 是本轮的，只发我这桌的两个人 —— 别人桌本轮打完没打完、
            // 谁赢了，在轮次屏障放开之前不该让我提前知道。
            prevLast: p.prevLast || null,
            last: (bt && bt.pIdx.indexOf(pIdx) >= 0) ? (p.last || null) : null,
            // 连线状态。真人看座位，AI 看 room.aiNet（天梯下 AI 也会掉线 /
            // 离开，见 aiNetRoll）—— 两边同一套取值，所以客户端
            // statusText() 那三处渲染不用区分谁是 AI。
            status: st ? (st.left ? 'left' : (st.connected ? '' : 'gone'))
                       : aiNetOf(room, pIdx),
            // 这个人此刻是否还在打（等待画面里「谁在对局」用）
            inBattle: !!room.battles.find(x => !x.done && x.pIdx.indexOf(pIdx) >= 0),
        };
    };

    let view = null;
    if (bt) {
        const b = bt.b;
        const meSide = (bt.pIdx[0] === mePIdx) ? 0 : 1;

        const maskSide = (si) => {
            const s = b.sides[si];
            const mine = (si === meSide);
            return {
                v: undefined,
                cards: s.cards.map(c => ({
                    v: (mine || b.revealed || !c.hidden) ? c.v : null,
                    hidden: c.hidden,
                    uid: c.uid,      // 见 maskSide（1v1 那份）里的注释
                    // 假牌标记 / 卡图名，同上：正面打出的牌，不涉及遮蔽
                    fake: c.fake || undefined,
                    face: c.face || undefined,
                })),
                stood: s.stood,
                checkN: mine ? s.checkN : 0,
            };
        };

        // 【和 1v1 共用 maskResult】原来这里手写了一份字段清单，漏掉了
        // 牛牛的 cows 和比多的 cardCounts —— 见 maskResult 上方的注释。
        const result = maskResult(b.result, meSide);

        const preOf = (pIdx) => {
            if (!snapPre) return null;
            return (pIdx === mePIdx) ? (snapPre[pIdx] || []).slice(0) : null;
        };

        view = {
            deck: b.deck.map((v, i) => (i < b.sides[meSide].checkN ? v : null)),
            rule: b.rule,
            standStreak: b.standStreak,
            turn: (b.turn === meSide) ? 0 : 1,
            revealed: !!b.revealed,
            finished: !!b.finished,
            redeals: b.redeals,
            sides: [maskSide(meSide), maskSide(1 - meSide)],
            result: result,
            // 【这个字段原来整个没有】少了它锦标赛的二选一点了没反应，
            // 见 maskPick2 上方的注释
            pick2: maskPick2(b, meSide),
            preFuncs: snapPre ? ord.map(preOf) : null,
            preFuncCounts: snapPre
                ? ord.map(i => (snapPre[i] ? snapPre[i].length : null)) : null,
        };
    }

    return {
        b: view,
        players: ord.map(P),
        // 我在这份 players 里的下标恒为 0；对手恒为 1（有对手时）
        oppIdx: (oppPIdx >= 0) ? 1 : -1,
        round: g.round,
        bye: !bt && !!(room.byePIdx === mePIdx),
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
// 锦标赛版日志遮蔽。和 1v1 同一条规矩：揭牌前一律不发（logAct 记的 hand
// 含暗牌数值）。side 要按「我在这桌是 side 几」镜像，drawBattleLog 按 side 上色。
function maskLogT(bt, meSide) {
    const b = bt.b;
    if (!b.revealed) return null;
    return (b.log || []).map(e => ({
        name: e.name, what: e.what, hand: e.hand,
        side: (e.side === meSide) ? 0 : 1,
    }));
}

function withRoom(room, fn) {
    const prev = D678.Game;
    D678.Game = room.game;
    try { return fn(); } finally { D678.Game = prev; }
}

// mode: 'duel'（1v1，2 座）| 'tourney'（8 人存活赛，AI 补位）
//
// 【锦标赛的三个身份别混用】一个人有三个下标，1v1 里它们恰好重合，
// 所以那套代码通篇用一个 si 兼职三者。8 人赛必须分开：
//   seatIdx  0..N-1   座位号（bySid 找人用）
//   pIdx     0..7     game.players 的下标（规则层认这个）
//   side     0 | 1    所在那一桌的 side（b.turn / b.sides 认这个）
// 一旦有一处拿 seatIdx 当 side 用，症状是「某人的操作打到别人桌上」，
// 而且只在特定配对下出现 —— 命名分开就是为了让这种错写不出来。
function newRoom(mode) {
    let code;
    do { code = rndId(4); } while (rooms.has(code));
    // 天梯和锦标赛一样是 8 席。少了这条天梯房只有 2 个座位 ——
    // 症状是补 AI 时 addSeat 返回 null，8 人里只坐得下 2 个。
    const seatN = (mode === 'tourney' || mode === 'ladder') ? TOURNEY_SEATS : 2;
    const room = {
        code: code,
        mode: mode || 'duel',
        seats: new Array(seatN).fill(null),
        game: null,
        // 本轮所有对局。1v1 恒定一条；锦标赛一轮最多 4 条同时进行。
        battles: [],
        byePIdx: -1,         // 本轮轮空的 game.players 下标（锦标赛，奇数人时）
        phase: 'lobby',      // lobby | battle | resolved | over
        seq: 0,
        // 每次结算 +1。客户端记住自己播过哪一次，同一次不再重播演出。
        // 少了它，弃牌后服务器重推的那份 resolved 状态会被当成新结算，
        // 客户端从 roundResult 被打回 resolve —— 而 _netFinished 已经是 true，
        // netFinish 立刻 return，于是双方各自卡死在不同阶段。
        resolveId: 0,
        turnTimer: null,
        ackTimer: null,
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
        // game.players 的下标。锦标赛里 index（座位号）和 pIdx 未必相等 ——
        // 有人离开后座位号会留着空洞，而 pIdx 是开赛时定死的。
        pIdx: -1,
        left: false,        // 永久离开（宽限期满 / 被淘汰踢回大厅）
        sse: null, connected: false,
        disconnectAt: 0,
        // 上一次结算被随机弃掉的功能牌 id（多人模式超过 MAX_FUNC 自动弃）。
        // 只用来给客户端报「弃了哪几张」，下一局发牌时清空。
        autoDiscarded: null,
        acked: false,
        // 锦标赛大厅的「准备」。全员就绪且 ≥2 人就自动开赛（你定的）。
        // 掉线立刻清掉 —— 否则赛事可能在他人不在的情况下开打。
        ready: false,
    };
    room.seats[i] = seat;
    bySid.set(sid, { room: room, index: i });
    room.touched = Date.now();
    log('房间 %s 座位 %d = %s', room.code, i, name);
    return seat;
}

// 把座位从房间里彻底摘掉，席位重新变空（只用于锦标赛大厅阶段）。
//
// 和 seat.left 的区别：left 是「开赛后离开」—— 位置必须留着，因为规则层
// 还要按 pIdx 找他、按 outAt 给他排名。大厅阶段还没有 game，没有这个包袱，
// 所以直接摘掉让席位能给下一个人。
function removeSeat(room, seat) {
    clearTimeout(seat.graceTimer);
    bySid.delete(seat.sid);
    if (room.seats[seat.index] === seat) room.seats[seat.index] = null;
    log('房间 %s 座位 %d(%s) 离开大厅', room.code, seat.index, seat.name);
}

// 收掉一个座位的 SSE，并让它的 sid 失效。
//
// 用在「这个人跟这场赛事再也没关系了」的时刻（被淘汰）——
// 位置还得留着（规则层要按 pIdx 找他、按 outAt 排名），
// 但那条长连接没有任何用处了，挂着白占服务器资源（你定的）。
//
// 【必须先发完消息再调】关掉之后 sendTo 就是空操作了。
//
// bySid 一起删掉是为了：客户端的 EventSource 自带重连，不删的话它拿这个
// 还有效的 sid 敲回来又会建一条新连接（onReconnect 还会把他当掉线归来）。
// 删了之后 /api/events 认不出这个 sid，客户端那边会清掉会话回菜单 ——
// 而客户端收到 eliminated 时也会自己 Net.reset()，两边都关，谁先谁后都行。
function releaseSeatConn(room, seat) {
    if (!seat) return;
    clearTimeout(seat.graceTimer);
    if (seat.sse) {
        try { seat.sse.end(); } catch (e) { /* 对端已经断了就无所谓 */ }
        seat.sse = null;
    }
    seat.connected = false;
    bySid.delete(seat.sid);
}

function dropRoom(room, why) {
    clearTimeout(room.turnTimer);
    clearTimeout(room.ackTimer);
    clearTimeout(room.roundTimer);
    // 天梯假计数的定时器。漏掉的话房间销毁后 ladFillTick 还会跑，
    // 对着已经从 rooms 里删掉的房间 pushRoom / startLadder
    clearTimeout(room.ladFillTimer);
    // 锦标赛一轮有多桌，每桌两个定时器 —— 漏掉的话房间销毁后
    // 回调还会对着已删除的房间跑 pushStateT
    (room.battles || []).forEach(bt => {
        clearTimeout(bt.turnTimer);
        clearTimeout(bt.aiTimer);
    });
    // AI 假掉线的解冻定时器。同上，漏了会对着已删除的房间 pushStateT
    aiNetClear(room);
    room.seats.forEach(s => {
        if (!s) return;
        clearTimeout(s.graceTimer);
        bySid.delete(s.sid);
    });
    rooms.delete(room.code);
    log('房间 %s 关闭（%s）', room.code, why);
}

//=============================================================================
// 在线人数
//=============================================================================
//
// 服务器本来只认识「坐进座位的人」—— 有 sid 才有 SSE 连接。站在多人菜单上
// 还没建房的人是完全看不见的，而那恰恰是最该数进去的：两个人同时在菜单上
// 却互相看到「0 人在线」，然后各自走掉，这个功能就白做了。
//
// 所以让大厅页每 5 秒 POST 一次 /api/stats，这个请求本身就是心跳。
// 去重靠客户端的 tab 令牌（sessionStorage，同浏览器两个标签页算两个人）：
//   · 还在菜单上晃：只有 token，没有 sid
//   · 建了房在等人：token 不变，多带一个 sid
// 统计时凡是「sid 指向一个还连着的座位」的访客一律跳过 —— 那个人已经被
// 座位那一遍数过了。token 不变是去重能成立的前提，别改成每次随机。
//
// 进了对局就不再 ping（大厅场景已经不在了），那条访客记录 15 秒后自然过期，
// 而这期间他一直被座位数着，所以人数不会因此跳动。

const visitors = new Map();   // token -> {at, sid}

// 上限纯粹是防刷：这接口不需要鉴权，谁都能拿不同 token 灌进来。
// 满了就不再收新的（老的照常刷新），最坏情况是人数偏小，不会把内存吃光。
const VISITOR_MAX = 5000;

function touchVisitor(token, sid) {
    if (!token) return;
    if (!visitors.has(token) && visitors.size >= VISITOR_MAX) return;
    visitors.set(token, { at: Date.now(), sid: sid || null });
}

function sweepVisitors() {
    const dead = Date.now() - CFG.visitorSec * 1000;
    for (const [k, v] of visitors) {
        if (v.at < dead) visitors.delete(k);
    }
}

// 按模式和阶段细分，给 GM 看运营全貌。每个字段都是真人座位数（非房间数）。
//   online         总在线（座位 + 散客）
//   tourneyLobby   锦标赛大厅里等人的真人
//   duelLobby      1v1 大厅里等人的真人
//   ladLobby       天梯匹配中的真人
//   duelPlaying    1v1 对局中的真人
//   tourneyPlaying 锦标赛对局中的真人
//   ladPlaying     天梯对局中的真人
//   aiPlaying      AI 模拟对局数（不是真人，单独一个字段）
function computeStats() {
    sweepVisitors();

    const liveSids = new Set();
    let seated = 0;
    let tourneyLobby = 0, duelLobby = 0, ladLobby = 0;
    let duelPlaying = 0, tourneyPlaying = 0, ladPlaying = 0;

    for (const room of rooms.values()) {
        const live = room.seats.filter(s => s && !s.left && s.connected);
        live.forEach(s => liveSids.add(s.sid));
        seated += live.length;
        const isLobby = room.phase === 'lobby';
        const isInGame = room.phase !== 'lobby' && room.phase !== 'over';
        if (!isLobby && !isInGame) continue;   // over：结算面板还挂着，人已不在对局
        if (room.mode === 'ladder') {
            if (isLobby) ladLobby += live.length;
            else ladPlaying += live.length;
        } else if (room.mode === 'tourney') {
            if (isLobby) tourneyLobby += live.length;
            else tourneyPlaying += live.length;
        } else {
            // duel（1v1）
            if (isLobby) duelLobby += live.length;
            else duelPlaying += live.length;
        }
    }

    let loose = 0;
    for (const v of visitors.values()) {
        // sid 指向活座位的已经数过了；sid 失效（房间销毁了但页面还开着）
        // 的仍然算在线 —— 那个人确实还盯着屏幕
        if (v.sid && liveSids.has(v.sid)) continue;
        loose++;
    }

    // 【门面数在客户端，不在这里】标题画面那行「天梯模式对局中人数：N」
    // （200~1000，给所有玩家看）是客户端按本地时钟算的，压根不走这个接口。
    // 这里一律真人真数，GM 看的是真实运营情况。
    return {
        online: seated + loose,
        tourneyLobby: tourneyLobby,
        duelLobby: duelLobby,
        ladLobby: ladLobby,
        duelPlaying: duelPlaying,
        tourneyPlaying: tourneyPlaying,
        ladPlaying: ladPlaying,
        aiPlaying: ladAiPlayingCount(),
    };
}

// 此刻有多少个 **AI** 在模拟对局。
//
// 【这个数是从漂移模型推出来的，不是编的】AI 的虚拟对局时刻本来就是确定性
// 算出来的（ladMatchAt + 作息筛），所以「上一场开在多久之前」是可算的：
// 落在一局时长以内的就还在打。于是这个数天然跟着作息走 —— 晚上八九点二十几个，
// 凌晨三四点个位数，和榜上分数在动的那批人是同一批。
//
// 【2026-08-07 起只发给 GM】原来它被加进 stats.online 冒充在线人数，
// 现在在线人数一律是真数（见 computeStats），这个数单独作为 aiPlaying 字段
// 发给 GM 看运营情况。所以这里**不再**加上真人 —— 真人走 ladRealPlaying()。
//
// 一局按 18 分钟算（实测中位数：60 场模拟里真人第 28 轮出局、每轮 36 秒）。
const LAD_GAME_MS = 18 * 60 * 1000;

let ladPlayCache = -1, ladPlayAt = 0;
function ladAiPlayingCount() {
    const now = Date.now();
    // 30 秒缓存。这个数分钟级才有变化，而 /api/stats 是每 5 秒一次心跳 ——
    // 不缓存的话每次心跳都要把整份 LAD_AI_NAMES 的当季对局重放一遍。
    if (ladPlayCache >= 0 && now - ladPlayAt < 30000) return ladPlayCache;
    const t = Math.floor(now / 1000);
    const sn = ladSeason(t);
    const seedKey = sn.key;
    // 起点和 ladReplaySeason 一样要夹 LAD_LAUNCH，否则上线当天算出来的
    // kNow 是按「赛季初就开打」推的，对不上榜上的场次
    const from = Math.max(sn.startSec, LAD_LAUNCH);
    let n = 0;
    for (const nm of D678.LAD_AI_NAMES) {
        const p = ladPersona(nm, seedKey);
        // 从起点往后找最后一场不晚于现在的对局。步长是固定的，
        // 所以可以直接从 now 附近倒着找几步，不用整季重放。
        const step = 86400 / p.rate;
        const kNow = Math.floor((t - from) / step);
        for (let k = kNow + 2; k >= 0 && k >= kNow - 4; k--) {
            const at = ladMatchAt(nm, p, k, from, seedKey);
            if (at > t) continue;
            if (!ladHappens(nm, k, at, seedKey)) continue;
            // 最近一场开在多久之前
            if ((t - at) * 1000 < LAD_GAME_MS) n++;
            break;      // 只看最近那一场
        }
    }
    ladPlayCache = n;
    ladPlayAt = now;
    return n;
}

// 真的在天梯房里打的真人。加进去，免得「我自己正在打，界面却说 0 人在天梯」。
function ladRealPlaying() {
    let n = 0;
    for (const room of rooms.values()) {
        if (room.mode !== 'ladder') continue;
        if (room.phase === 'lobby' || room.phase === 'over') continue;
        n += room.seats.filter(s => s && !s.left && s.connected).length;
    }
    return n;
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
    // 锦标赛大厅：在座的真人数（掉线的人 10 秒内还占着席位，也算在座）
    const taken = room.seats.filter(s => s && !s.left).length;
    room.seats.forEach(seat => {
        if (!seat) return;
        sendTo(seat, 'room', {
            room: room.code,
            mode: room.mode,
            phase: room.phase,
            mySeat: seat.index,
            startHp: CFG.startHp,
            turnSec: turnSecOf(room),
            seatN: room.seats.length,
            takenN: taken,
            // 「我点过准备没有」。界面靠它把按钮在准备/取消之间切。
            myReady: !!seat.ready,
            // 少于 2 人时点了准备也开不了赛，界面要明说在等人（否则像坏了）
            // 天梯不用这条：它不靠「准备」开赛，满 8 人（假计数走完）就开
            needMore: room.mode === 'tourney' && room.phase === 'lobby' && taken < 2,
            // 天梯的假匹配状态。客户端靠它画 (N/8 匹配中) 和总计时。
            ladder: room.mode === 'ladder' || undefined,
            ladFill: (room.mode === 'ladder' && room.phase === 'lobby')
                ? ladFillView(room) : undefined,
            seats: room.seats.map(s => (s && !s.left) ? {
                name: s.name, connected: s.connected, ready: !!s.ready,
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
            // 多人模式超过 MAX_FUNC 是随机自动弃的（不再手动挑），
            // 这里把弃掉的 id 发给他，界面提示「已随机弃掉 XX、YY」。
            autoDiscarded: seat.autoDiscarded,
            myAcked: !!seat.acked,
            // 对手状态：是否已点继续 / 掉线了多久（毫秒）
            peerAcked: !!(other && other.acked),
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
// 锦标赛推盘面：每个座位只拿自己那一桌 + 全场 8 人的公开信息。
//
// 【安全关键】A 桌的人绝不能从这份数据里看到 B 桌的任何牌面 ——
// maskViewT 只接受 seat 自己那一桌的 bt，别图省事传整个 room.battles。
function pushStateT(room, extra) {
    room.seq++;
    room.seats.forEach(seat => {
        if (!seat || seat.left) return;
        // 【不能加 !x.done】自己那桌打完了照样要发牌面 —— applyActionT 是先
        // 置 bt.done 再推这份状态的，过滤掉 done 的话玩家永远收不到自己这场的
        // 结算（揭牌演出、对战日志、弃牌界面全都没了，直接跳到下一轮）。
        // 「在等本轮结束」由 bt.done 单独判，见下面的 waitingRound。
        const bt = room.battles.find(x => x.pIdx.indexOf(seat.pIdx) >= 0);
        const btDone = !!(bt && bt.done);
        const v = maskViewT(room, bt, seat, bt ? bt.preFuncs : null);
        const meSide = bt ? (bt.pIdx[0] === seat.pIdx ? 0 : 1) : -1;
        // 本轮还有几桌在打（等待画面用）
        const busy = room.battles.filter(x => !x.done).length;
        // 还在打的那几桌是谁跟谁（等待画面要显示成「AA vs BB」一行一桌）。
        //
        // 【为什么要发这个】原来只发 busyTables（一个数字），客户端靠
        // players[i].inBattle 自己凑名字 —— 凑出来的是一串平铺的名字，
        // 分不出谁跟谁打，而且轮空的人压根收不到 waitingRound，
        // 那一屏什么都没有。
        //
        // 【不算泄漏】配对本身是公开信息：轮结果页本来就会列出全场每一桌的
        // 胜负。这里只给「谁跟谁」，不给任何牌面、点数、谁赢了。
        const pairsBusy = room.battles.filter(x => !x.done).map(x => ({
            a: room.game.players[x.pIdx[0]].name,
            b: room.game.players[x.pIdx[1]].name,
            // 我自己那桌标一下，客户端高亮
            mine: x.pIdx.indexOf(seat.pIdx) >= 0 || undefined,
        }));
        sendTo(seat, 'state', Object.assign({
            seq: room.seq,
            // 天梯也发 'tourney' —— 客户端的绘制层按它走 8 人赛那套，
            // 一行都不用改。天梯特有的东西走下面的 ladder 字段。
            mode: 'tourney',
            ladder: room.mode === 'ladder' || undefined,
            // 我那桌的编号。extra 里的 btId 是「这次事件属于哪一桌」，
            // 两者不等就说明这份 fresh / resolved 是别人桌的，客户端要忽略。
            myBtId: bt ? bt.id : -1,
            resolveId: bt ? bt.resolveId : 0,
            phase: room.phase,
            round: room.game ? room.game.round : 1,
            b: v.b,
            players: v.players,
            bye: v.bye,
            // 我这桌打完了（或者本轮压根没我的桌）但本轮还没结束 ——
            // 客户端据此停在轮次等待屏。
            //
            // 【轮空的人也要停在这一屏】原来这里有 `&& !v.bye`，于是轮空那一轮
            // 玩家看不到「谁在对局」—— 他既没有自己的牌桌，又被排除在等待屏
            // 之外，那一屏是空的（你报的第 2 条）。轮空本来就是「这一轮没我的
            // 事，等别人打完」，正该看这一屏。
            waitingRound: (!bt || btDone) && busy > 0,
            busyTables: busy,
            // 还在打的那几桌（「AA vs BB」一行一桌）
            busyPairs: pairsBusy,
            log: bt ? maskLogT(bt, meSide) : null,
            // 打完的桌 turnDeadline 是上一手留下的旧值，别让客户端拿它倒计时
            turnLeft: (bt && !btDone && bt.turnDeadline)
                ? Math.max(0, bt.turnDeadline - Date.now()) : 0,
            // 思考池（天梯）。客户端据此在回合时限烧完后接着画「思考时间 x/y」。
            //
            // 【两边都发】玩家要能看到对手那份在掉（你定的）。镜像后自己
            // 永远是 side 0，所以这里也按 [我, 对手] 的顺序发，和 v.b.sides
            // 一致 —— 客户端不用再判方向。
            //
            // turn 是**当前行动方**这个回合可动用的量（另一方没在用池子）。
            // 真人和 AI 都是 armTurnTimerT 算好的 bankTurnMs = min(单回合上限,
            // 池子)，口径完全一致 —— AI 那边曾经发的是「这一步实际要花多少」
            // （常规步 0），于是「对方思考时间 0/60s」成了 AI 的标记，见那边注释。
            bank: (room.mode === 'ladder' && bt && !btDone && meSide >= 0) ? {
                left: [ladBankLeft(room, bt.pIdx[meSide]),
                       ladBankLeft(room, bt.pIdx[1 - meSide])],
                turn: bt.bankTurnMs || 0,
                // 【单回合上限也要发】客户端给**非行动方**算「他轮到时能想
                // 几秒」用的是 min(cap, 池子)，不能拿上面那个 turn ——
                // turn 只属于当前行动方，画到另一侧就成了「对手的额度显示在
                // 我这一行」。写死 15000 在客户端等于把常量抄了两份。
                cap: LAD_BANK_TURN_MS,
            } : undefined,
            // 超过 MAX_FUNC 被随机弃掉的那几张（多人模式不再手动挑牌）
            autoDiscarded: seat.autoDiscarded,
        }, extra || {}));
    });
}

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

//=============================================================================
// 锦标赛：8 人存活赛
//=============================================================================
//
// 一轮的形状（和单机 checkGameEnd -> makeRound 一致）：
//   makeRound() 给出 pairs + bye  ->  纯 AI 的桌当场用 simulateMatch 算完
//   有真人的桌变成 room.battles 里的一条，交互着打
//   所有桌都 done 且没人欠弃牌  ->  轮次屏障放开  ->  淘汰 -> 下一轮
//
// 轮次屏障是设计决定：打完的人要等最慢那一桌。平局也等（那一桌 newDeal
// 重打，其他人跟着多等一局）。这样赛程语义最干净 —— 每轮所有人都打过一场。

// 离开的人手上的功能牌全部回公共池（你定的）。
//
// 【为什么必须每轮都调一次，而不是转 left 时调一次就完】
// 678core 的 grantFuncs 是「胜者摸 1、败者摸 2」，它不看 alive 也不看 left
// （那份文件单机联机共用，不能为联机加判断）。而离开的人一路自动过牌，
// 场场是败者 —— 于是他每轮白拿 2 张攒在手上永远不出，公共池会被慢慢抽干。
//
// 所以每次发完牌都把离开者的牌立刻退回去：净效果等于「不给他发」，
// 而池子的收支始终是平的。顺序很重要 —— 必须在随机弃牌之前退，否则会先
// 把他手上那几张随机弃掉一部分、再整手退回，日志和「弃了哪几张」的提示
// 都会带上一个已经离开的人。
function returnFuncsOfLeft(room) {
    if (!room.game) return;
    room.seats.forEach(s => {
        if (!s || !s.left || s.pIdx < 0) return;
        const p = room.game.players[s.pIdx];
        if (p && p.funcs.length > 0) room.game.returnAllFuncs(p);
    });
}

// 「全员就绪就立刻开赛」的唯一判定点。
//
// 必须在这三个时机都调一次，漏掉任何一个房间都会卡住：
//   · 有人点准备（/api/ready）
//   · 有人进房（新人一来「全员就绪」就不成立了，他走了才可能重新成立）
//   · 有人的座位被移除（大厅掉线满 10 秒）—— 少了这次调用，房间会一直
//     等一个已经不存在的人
//
// 「≥2 人」是硬条件（你定的）：一个人点了准备也不开，界面靠 needMore 说明原因。
function maybeStartTourney(room) {
    if (!room || room.mode !== 'tourney' || room.phase !== 'lobby') return false;
    const seated = room.seats.filter(s => s && !s.left);
    if (seated.length < 2) return false;
    if (!seated.every(s => s.ready && s.connected)) return false;
    room.touched = Date.now();
    startTourney(room);
    return true;
}

function startTourney(room) {
    const humans = room.seats.filter(s => s && !s.left);
    const need = TOURNEY_SEATS - humans.length;
    const aiNames = rollFillNames(need);

    const savedHp = D678.START_HP;
    D678.START_HP = CFG.startHp;
    try {
        const game = new D678.GameClass();
        const players = [];
        // 真人占前面，pIdx 就是入座顺序；AI 补后面
        humans.forEach((s, i) => {
            const p = new D678.Player(players.length, s.name, true);
            s.pIdx = players.length;
            s.player = p;
            players.push(p);
        });
        aiNames.forEach(nm => {
            // 第三个参数 isHuman=false；isGod 由 Player 构造函数按名字判
            players.push(new D678.Player(players.length, nm, false));
        });
        game.players = players;
        room.game = game;
    } finally {
        D678.START_HP = savedHp;
    }

    room.phase = 'battle';
    // 本日**联机人数**：按在场真人数加（2 真人的锦标赛 +2），补位的 AI 不算。
    // 【不是 plays】游玩次数只算单机（你定的）—— 光进多人模式不该让那个数涨。
    // 服务器自己知道开赛这件事，不用客户端上报，少一个能刷的口子。
    dailyBump('online', humans.length);
    log('房间 %s 锦标赛开始：%d 真人 + %d AI（超哥%s）',
        room.code, humans.length, aiNames.length,
        aiNames.indexOf(D678.GOD_NAME) >= 0 ? '在场' : '不在场');
    pushRoom(room);
    startRound(room);
}

//=============================================================================
// 天梯房
//=============================================================================

// 找一个还在攒人的天梯房，没有就建一个。
//
// 【为什么共用同一个房】假匹配那 55~90 秒是真给真人留的窗口 —— 同一个窗口里
// 点「开启排位」的人要进同一桌，否则真人永远碰不到真人（你定的：故意把时间
// 留长，尽量匹配多一点真人）。
function findLadderRoom() {
    for (const r of rooms.values()) {
        if (r.mode !== 'ladder' || r.phase !== 'lobby') continue;
        // 假计数已经走满了的房不再收人（下一刻就要开赛）
        if (r.ladFill && r.ladShown >= TOURNEY_SEATS) continue;
        const taken = r.seats.filter(s => s && !s.left).length;
        if (taken < TOURNEY_SEATS) return r;
    }
    return null;
}

// 天梯房的假匹配状态。ladShown 是界面上显示的人数（含自己）。
function ladFillView(room) {
    const real = room.seats.filter(s => s && !s.left).length;
    return {
        shown: Math.max(real, room.ladShown || 1),
        total: TOURNEY_SEATS,
        // 从建房那一刻算起的总耗时（毫秒）—— 界面上那个总计时
        elapsed: Date.now() - (room.ladStartAt || Date.now()),
    };
}

// 启动一个天梯房的假计数。
//
// 计数是假的（不真的一个一个把 AI 加进房），但**真人进来会占真实席位**，
// 而且显示人数不会低于真实人数 —— 否则 3 个真人进来了界面还写 2/8。
function ladStartFill(room) {
    room.ladStartAt = Date.now();
    room.ladShown = 1;
    room.ladFill = ladRollFill();
    room.ladFillIdx = 0;
    ladFillTick(room);
    log('房间 %s 天梯匹配开始，假计数总时长 %ss',
        room.code, (room.ladFill.total / 1000).toFixed(1));
}

// 排下一次递增。到点了就 +1 并推一份房间信息；走满 8 个就开赛。
function ladFillTick(room) {
    clearTimeout(room.ladFillTimer);
    if (room.phase !== 'lobby' || room.mode !== 'ladder') return;
    const f = room.ladFill;
    if (!f) return;
    if (room.ladFillIdx >= f.at.length) {
        // 计数走满 -> 开赛
        room.ladShown = TOURNEY_SEATS;
        pushRoom(room);
        startLadder(room);
        return;
    }
    const due = room.ladStartAt + f.at[room.ladFillIdx];
    const wait = Math.max(0, due - Date.now());
    room.ladFillTimer = setTimeout(() => {
        if (room.phase !== 'lobby' || room.mode !== 'ladder') return;
        room.ladFillIdx++;
        // 真人可能已经进来把显示人数顶上去了，取大的那个
        const real = room.seats.filter(s => s && !s.left).length;
        room.ladShown = Math.max(real, (room.ladShown || 1) + 1);
        if (room.ladShown > TOURNEY_SEATS) room.ladShown = TOURNEY_SEATS;
        pushRoom(room);
        ladFillTick(room);
    }, wait);
}

// 开赛。真人占前面的 pIdx，其余用天梯名单补齐，再按概率挑 0~2 个挂超哥逻辑。
function startLadder(room) {
    clearTimeout(room.ladFillTimer);
    const humans = room.seats.filter(s => s && !s.left);
    if (humans.length === 0) { dropRoom(room, '天梯房里没有真人'); return; }
    const need = TOURNEY_SEATS - humans.length;
    // 避开所有真人的名字，免得榜和排名表里出现两个同名的人
    const taken = humans.map(s => s.name);
    let aiNames = D678.rollLadNames(need + taken.length);
    aiNames = aiNames.filter(nm => taken.indexOf(nm) < 0).slice(0, need);

    const savedHp = D678.START_HP;
    D678.START_HP = CFG.startHp;
    try {
        const game = new D678.GameClass();
        const players = [];
        humans.forEach(s => {
            const p = new D678.Player(players.length, s.name, true);
            s.pIdx = players.length;
            s.player = p;
            players.push(p);
        });
        aiNames.forEach(nm => {
            const p = new D678.Player(players.length, nm, false);
            // 天梯名单里不会有「超哥」这个名字，所以构造函数判出来一定是 false。
            // 下面按概率重新指定。
            p.isGod = false;
            players.push(p);
        });
        game.players = players;
        room.game = game;

        // 超哥：0 个 75% / 1 个 20% / 2 个 5%（你定的）。
        // 【名字不变】被选中的 AI 照常显示自己的名字 —— 玩家看不出这局谁是超哥。
        // 只能从 AI 里挑，真人不可能是超哥。
        const godN = Math.min(D678.rollGodN(), aiNames.length);
        const aiIdx = players.map((p, i) => i).filter(i => !players[i].isHuman);
        const picked = D678.shuffle(aiIdx).slice(0, godN);
        picked.forEach(i => { players[i].isGod = true; });
        room.ladGodN = picked.length;
        room.ladGodNames = picked.map(i => players[i].name);
    } finally {
        D678.START_HP = savedHp;
    }

    room.phase = 'battle';
    dailyBump('online', humans.length);
    // 历史战绩要用：对局开始时间
    room.tourneyStartAt = Date.now();
    // 谁会掉线 / 离开，这一局一次掷定（见 aiNetRoll）
    aiNetRoll(room);
    // 超哥是谁只记在服务器日志里 —— 客户端永远收不到（见 maskViewT 的 isGod）
    log('房间 %s 天梯开始：%d 真人 + %d AI，超哥 %d 个（%s）',
        room.code, humans.length, aiNames.length, room.ladGodN,
        room.ladGodNames.length ? room.ladGodNames.join('/') : '无');
    pushRoom(room);
    startRound(room);
}

// 摆好新一轮。纯 AI 的桌立刻算完，有真人的桌留着交互打。
function startRound(room) {
    const g = room.game;
    let r;
    withRoom(room, () => {
        g.players.forEach(p => { if (p.alive) { p.prevLast = p.last; p.last = null; } });
        r = g.makeRound();
        if (r.bye) r.bye.last = { type: 'bye', dmg: 0 };
    });

    room.battles = [];
    room.byePIdx = r.bye ? g.players.indexOf(r.bye) : -1;
    room.phase = 'battle';
    room.seats.forEach(s => { if (s) { s.acked = false; s.autoDiscarded = null; } });

    // 到点的 AI 在这里掉线 / 离开。**必须在配对之后、开打之前** ——
    // 下面纯 AI 桌的快路要读冻结状态来决定强制过牌。
    aiNetTick(room);

    r.pairs.forEach(pair => {
        const [pa, pb] = pair;
        const ia = g.players.indexOf(pa), ib = g.players.indexOf(pb);
        const seatA = room.seats.find(s => s && !s.left && s.pIdx === ia);
        const seatB = room.seats.find(s => s && !s.left && s.pIdx === ib);

        // 两边都不是活人（AI，或者已经离开的人）-> 当场算完，没有等的理由。
        // 离开的人交给 simulateMatch 等于让 AI 替他打完这一场 —— 不行，
        // 他该是一路自动过牌。所以只有「双方都是 AI」才走这条快路。
        if (!seatA && !seatB && !pa.isHuman && !pb.isHuman) {
            // 【天梯：算完但推迟公布】详见 LAD_AI_TABLE_CAP_MS 的注释 ——
            // 立刻公布的话另外 3 桌零耗时完成，而这 7 个 AI 全都有拟人延迟，
            // 「他们互相打是 0 秒」这个矛盾比 AI 秒出牌更刺眼。
            if (room.mode === 'ladder') {
                // 按侧分开数：思考池是每个 AI 各自一份，扣费要扣到人头上
                const stepsBySide = [0, 0];
                const raw = D678.AI.step;
                // 【冻结的一方要强制过牌】掉线 / 离开的 AI 在纯 AI 桌上也不能
                // 正常打 —— 否则界面上是「这人显示离开，血却一点没掉、还赢了」，
                // 比不标注更假。包一层 AI.step，轮到冻结那一方就直接过牌，
                // 和它在真人桌上的行为一致（forceStand）。
                const frozenA = aiFrozen(room, ia), frozenB = aiFrozen(room, ib);
                D678.AI.step = function (b, si) {
                    // simulateMatch 里 pa 是 side 0、pb 是 side 1（new Battle(pa, pb)）
                    if ((si === 0 && frozenA) || (si === 1 && frozenB)) {
                        // 冻结的一方不算「在思考」，不计步、不扣池子
                        b.act(si, 'stand');
                        return { side: si, action: 'stand', msg: '对方过牌' };
                    }
                    stepsBySide[si]++;
                    return raw.call(this, b, si);
                };
                // 在 simulateMatch 改掉 HP/胜负之前拍一张快照 ——
                // 假桌的 done 被推迟了，但 doResolve 会当场改玩家对象。
                // 不快照的话真人那桌一推 pushStateT，另外几桌 AI 已经掉血了，
                // 而这一轮还没打完 —— 真人不会在轮次中途掉血，这等于泄漏 AI 身份。
                const preStats = {};
                preStats[ia] = { hp: pa.hp, wins: pa.wins, losses: pa.losses,
                                 maxPoint: pa.maxPoint };
                preStats[ib] = { hp: pb.hp, wins: pb.wins, losses: pb.losses,
                                 maxPoint: pb.maxPoint };
                try {
                    withRoom(room, () => { D678.simulateMatch(pa, pb); });
                } finally {
                    D678.AI.step = raw;
                }
                // 假桌也要进 battles，否则 busyTables 数不到它，
                // 「本轮还有几桌在打」永远只算真人那桌。
                const fake = {
                    id: room.battles.length,
                    pIdx: [ia, ib],
                    b: null, done: false, resolveId: 0, preFuncs: null,
                    isTie: false, turnTimer: null, turnDeadline: 0,
                    turnStartAt: 0, turnGoneDeadline: 0, aiTimer: null,
                    turnHardDeadline: 0, bankTurnMs: 0, bankCharged: 0,
                    aiPlan: null,
                    // 标记：这桌已经算完了，只是还没到公布时间
                    fakeAI: true,
                    // 公布之前的 HP/胜负快照（P 函数据此遮蔽）
                    preStats: preStats,
                };
                room.battles.push(fake);
                fake.aiTimer = setTimeout(() => {
                    if (room.phase !== 'battle') return;
                    fake.done = true;
                    pushStateT(room);
                    checkRoundBarrier(room);
                }, ladFakeTableMs(room, [ia, ib], stepsBySide));
                return;
            }
            withRoom(room, () => { D678.simulateMatch(pa, pb); });
            return;
        }

        const bt = {
            id: room.battles.length,
            pIdx: [ia, ib],
            b: null,
            done: false,
            resolveId: 0,
            preFuncs: null,
            isTie: false,
            turnTimer: null,
            turnDeadline: 0,
            turnStartAt: 0,
            turnGoneDeadline: 0,
            aiTimer: null,
            // 思考池（天梯）：硬截止 = turnDeadline + 本回合可动用的池子
            turnHardDeadline: 0,
            bankTurnMs: 0,
            bankCharged: 0,
            aiPlan: null,
        };
        withRoom(room, () => { bt.b = new D678.Battle(pa, pb, false); });
        room.battles.push(bt);
    });

    // 全是 AI 桌（真人都轮空 / 都离开了）-> 这一轮没有交互，直接收
    if (room.battles.length === 0) { checkRoundBarrier(room); return; }

    room.battles.forEach(bt => armTurnTimerT(room, bt));
    pushStateT(room, { fresh: true });
    room.battles.forEach(bt => stepAIIfNeeded(room, bt));
}

//--- 每桌各自的回合计时 ----------------------------------------------------
// 和 1v1 的 armTurnTimer 同一套规矩（锚在回合起点、掉线只许缩短），
// 差别是状态存在 bt 上而不是 room 上 —— 一轮有 4 桌同时在跑。

function armTurnTimerT(room, bt) {
    clearTimeout(bt.turnTimer);
    bt.turnDeadline = 0;
    const tsec = turnSecOf(room);
    if (!tsec || room.phase !== 'battle' || !bt.b || bt.b.finished || bt.done) return;

    const now = Date.now();
    if (!bt.turnStartAt) bt.turnStartAt = now;

    const pIdx = bt.pIdx[bt.b.turn];
    const seat = room.seats.find(s => s && s.pIdx === pIdx);
    const isAI = !room.game.players[pIdx].isHuman;
    const left = !!(seat && seat.left);

    // 离开的人：不等，立刻自动过牌（你定的）。AI 不用计时器，走 stepAIIfNeeded。
    if (left) {
        bt.turnDeadline = now;
        bt.turnTimer = setTimeout(() => forceStand(room, bt, '离开'), 0);
        return;
    }
    // 【掉线的 AI 要挂真计时器】下面的 AI 分支只写 turnDeadline 不 setTimeout
    // （怕和 AI 长考抢，详见那段注释）。但掉线的 AI 压根不会行动
    // （stepAIIfNeeded 直接 return），没有真计时器就永远卡在这个回合。
    // 挂上之后它和真人掉线走完全同一条路：倒计时烧完 -> 判过牌。
    //
    // 【掉线不动用思考池】（你定的）掉线的人没在思考，池子留着给他回来用。
    // 天梯下掉线和挂机的回合都是完整 tsec（10 秒），不再降速 —— goneSecOf
    // 在天梯里返回的就是 tsec 本身，见那边的注释。
    if (isAI && aiFrozen(room, pIdx)) {
        const gsec = room.game.players[pIdx].aiIdled ? goneSecOf(room, tsec) : tsec;
        bt.turnDeadline = bt.turnStartAt + gsec * 1000;
        bt.turnTimer = setTimeout(() => forceStand(room, bt, 'AI 掉线'),
            Math.max(0, bt.turnDeadline - now));
        return;
    }
    // AI 回合：不挂计时器（它不会超时），但**要给一个只用于显示的 deadline**。
    //
    // 【为什么】pushStateT 的 turnLeft 是从 bt.turnDeadline 算的，原来这里直接
    // return，于是对方回合时 turnDeadline 停在 0、客户端拿到 turnLeft=0，
    // 倒计时整个不画 —— 玩家看着对面干等，不知道还要等多久，也不知道界面
    // 是不是卡住了。锦标赛下 AI 900ms 就走完，看不出来；天梯的拟人延迟
    // 最长 15 秒，这个空白很明显。
    //
    // 【为什么不挂真的计时器】AI 一定会在延迟到点后行动（stepAIIfNeeded），
    // 挂一个超时计时器只会和它抢：AI 的长考现在**本来就可能比 tsec 长**
    // （长考档上限 15 秒 > 回合 10 秒，超出部分吃思考池），挂计时器会把它
    // 自己判超时。所以这里只写 deadline，不 setTimeout。
    // AI 提前走完时倒计时停在中途，这和真人对手提前出牌是一样的观感。
    //
    // 【延迟要在这里就抽好】客户端画的思考池要和 AI 真实的思考时长一致。
    // 原来是 stepAIIfNeeded 里才抽，那时 deadline 已经发出去了 —— 客户端
    // 会按「可能用满 15 秒」推算池子，等 AI 只想了 12 秒就走完，下一帧池子
    // 又跳回去一截。所以抽好存在 bt.aiPlan 上，stepAIIfNeeded 直接用。
    // 【两侧的 deadline 口径必须一致】turnDeadline 一律是**完整的回合时限**，
    // 超出的那一段走 turnHardDeadline。这样客户端两边用同一套算法画：
    // 先正常倒数到 0，再接着画思考池。
    //
    // 【为什么不能写 min(延迟, 回合时限)】那样倒计时的起点就等于 AI 这一步
    // 抽到的思考时长：抽到 2.2 秒，玩家看到「等对方 3s」然后它正好数到 0 出手。
    // 实测一局的起点是 7,5,5,3,10,10,5,2,5,10 秒，而真人恒定 10 秒 ——
    // 倒计时起点逐回合变、且预告了它要想多久，一眼看得出对面是 AI。
    // 原来的 min 只封住了上界（防「对手倒计时比我长」），下界漏了。
    //
    // AI 提前走完时倒计时停在中途，这和真人对手提前出牌是同一个观感。
    if (isAI) {
        if (!bt.aiPlan) bt.aiPlan = ladAiPlan(room, pIdx);
        bt.turnDeadline = bt.turnStartAt + tsec * 1000;
        // 硬截止 = 它真实什么时候落子（可能比回合时限长，那截吃思考池）。
        // AI 不挂计时器，所以这个值没人读，留着是为了排查时看得出计划；
        // 它**不发给客户端**（发的是上面那个完整时限）。
        bt.turnHardDeadline = bt.turnStartAt + bt.aiPlan.delay;
        // 【发的是额度，不是这一步的花费】和真人同一个口径 min(单回合上限, 池子)。
        // 原来发 aiPlan.cost —— 常规步 cost=0，客户端画出「对方思考时间 0/60s」，
        // 而真人那一行恒定 15/60。一个还没开始想的对手额度显示 0，
        // 这个数不可能出现在真人身上，是第二处泄露。
        // 真正的扣费走 stepAIIfNeeded 里的 plan.cost，跟这个显示值无关。
        bt.bankTurnMs = ladBankTurnMs(room, pIdx);
        return;
    }

    // 真人：回合时限 tsec，烧完之后还能动用思考池（天梯专属）。
    //
    // 【挂机 / 掉线不给池子】（你定的）掉线的人没在思考，池子留着给他回来用；
    // 挂机（上个回合被判过牌）同样不给 —— 不然一个挂机的人每个回合都要
    // 烧掉 10+15=25 秒，同轮另外三桌全在等他。挂机的人正常操作一次就
    // 清掉 idled，池子立刻恢复可用。
    //
    // 天梯下 goneSecOf 返回的就是 tsec（10 秒，不降速，你定的），所以
    // sec 这一行在天梯里恒等于 tsec；别处仍然是 10 秒降速那套。
    const short = !!(seat && seat.idled);
    const sec = short ? goneSecOf(room, tsec) : tsec;

    const canBank = !short && !!(seat && seat.connected);
    const bankTurn = canBank ? ladBankTurnMs(room, pIdx) : 0;

    bt.turnDeadline = bt.turnStartAt + sec * 1000;
    // 真正判过牌的时刻。池子为 0 时和 turnDeadline 相同。
    bt.turnHardDeadline = bt.turnDeadline + bankTurn;
    bt.bankTurnMs = bankTurn;

    // 【二选一不另起短计时器】选牌窗口 = 整个回合计时（含思考池），和普通回合
    // 一样挂在 turnHardDeadline 上。超时（玩家没操作导致自动跳过）时如果还有
    // pending2，随机选一张——见 forceStand。不再用 min(pick2Sec, 回合剩余) 提前
    // 开火；玩家有思考池时，即使回合时限到了也不该替他选。
    //
    // 判过牌挂在硬截止上（回合时限 + 本回合可动用的池子）。
    // 池子那一段烧完时要把它扣掉 —— 玩家确实用掉了那段时间。
    bt.turnTimer = setTimeout(() => {
        if (bt.bankTurnMs > 0) ladBankSpend(room, pIdx, bt.bankTurnMs);
        forceStand(room, bt, short ? '挂机' : (bt.bankTurnMs > 0 ? '思考时间用尽' : '超时'));
    }, Math.max(0, bt.turnHardDeadline - now));
}

function forceStand(room, bt, why) {
    if (!bt.b || bt.b.finished || bt.done || room.phase !== 'battle') return;
    // 二选一超时 -> 随机选（pick2Resolve 会 endTurn），不直接判过牌。
    if (bt.b.pending2) {
        const who = bt.b.pending2.side;
        log('房间 %s 第 %d 桌 pIdx=%d 二选一超时 -> 随机选',
            room.code, bt.id, bt.pIdx[who]);
        applyActionT(room, bt, who,
            { type: 'pick2', idx: Math.random() < 0.5 ? 0 : 1 }, true);
        return;
    }
    log('房间 %s 第 %d 桌 pIdx=%d %s -> 判过牌',
        room.code, bt.id, bt.pIdx[bt.b.turn], why);
    applyActionT(room, bt, bt.b.turn, { type: 'stand' }, true);
}

// 轮到 AI（或轮到已离开的人）就自己走。延迟一下让人看清对手做了什么。
function stepAIIfNeeded(room, bt) {
    // 【天梯的假 AI 桌不能走这里】它没有 bt.b（结果早就算完了），而且它的
    // aiTimer 挂的是「到点公布」那个回调 —— clearTimeout 会把公布取消掉，
    // 那一桌就永远 done 不了，轮次屏障卡死。
    if (bt.fakeAI) return;
    clearTimeout(bt.aiTimer);
    if (!bt.b || bt.b.finished || bt.done || room.phase !== 'battle') return;
    const pIdx = bt.pIdx[bt.b.turn];
    const p = room.game.players[pIdx];
    const seat = room.seats.find(s => s && s.pIdx === pIdx);
    if (seat && seat.left) {
        // 离开的人一路自动过牌，且 losses 照常累加（你定的）
        bt.aiTimer = setTimeout(() => forceStand(room, bt, '离开'), 0);
        return;
    }
    if (p.isHuman) return;

    // 【掉线 / 离开的 AI 不动作】天梯下 AI 也会掉线（见 aiNetRoll）。
    //   · 离开：一路自动过牌，和真人离开同一个口径
    //   · 掉线：什么都不做，让 armTurnTimerT 挂的回合计时器烧完判过牌
    //     —— 真人掉线就是这个样子（干等到超时），所以观感一致
    if (aiNetOf(room, pIdx) === 'left') {
        bt.aiTimer = setTimeout(() => forceStand(room, bt, 'AI 离开'), 0);
        return;
    }
    if (aiFrozen(room, pIdx)) return;

    // 天梯：拟人延迟（多数 1~4 秒，偶尔长考到 15 秒，每步都不一样）。
    // 超过回合时限的那一截吃思考池；池子空了长考档退到 9 秒（见 ladThinkMs）。
    // 锦标赛照旧固定 900ms —— 那是「让人看清对手做了什么」的节奏，
    // 不是为了拟人（你定的，两套模式各管一摊）。
    //
    // 计划是 armTurnTimerT 抽好的（客户端的 deadline 用的是同一个数）。
    // 万一没有（非天梯、或者被别的路径绕过），当场补一个。
    if (!bt.aiPlan) bt.aiPlan = ladAiPlan(room, pIdx);
    const plan = bt.aiPlan;
    let wait = (room.mode === 'ladder') ? plan.delay : CFG.aiStepMs;

    // 【不能要牌时缩短延迟】明牌已 ≥ 21（或牛牛满 5 张）时 canHit 返回 false，
    // AI 只能过牌或用不消耗回合的功能牌 —— 没什么好想的，长考反而不像真人。
    // 只缩短延迟，decide 照常跑（功能牌该用还是会用）。
    // cost 也要清零：没真想那么久，不该扣思考池。
    if (!bt.b.canHit(bt.b.turn)) {
        wait = Math.min(wait, 500);
        plan.cost = 0;
    }

    bt.aiTimer = setTimeout(() => {
        if (!bt.b || bt.b.finished || bt.done || room.phase !== 'battle') return;
        const si = bt.b.turn;
        // 【扣在真的想完之后】计划在 armTurnTimerT 里就抽好了，但那时还没
        // 真的等 —— 对局中途被打断（平局重发、房间销毁）的话那一步没发生，
        // 不该扣。扣在这里，口径是「想完了才付钱」。
        if (plan.cost > 0) ladBankSpend(room, bt.pIdx[si], plan.cost);
        let ev = null;
        withRoom(room, () => { ev = D678.AI.step(bt.b, si); });
        if (ev && ev.msg) pushEventT(room, bt, si, ev.msg);

        if (bt.b.result && bt.b.result.tie) { resolveTable(room, bt, true); return; }
        if (bt.b.finished) { resolveTable(room, bt, false); return; }

        // 换人（或同一人接着走）都要重抽下一步的计划
        bt.aiPlan = null;
        if (bt.b.turn !== si) {
            bt.turnStartAt = 0; bt.turnGoneDeadline = 0; bt.bankCharged = 0;
        }
        armTurnTimerT(room, bt);
        pushStateT(room);
        stepAIIfNeeded(room, bt);
    }, wait);
}

// 对手动作的文字提示：只发给同桌的另一个人
function pushEventT(room, bt, actorSide, msg) {
    if (!msg) return;
    const otherPIdx = bt.pIdx[1 - actorSide];
    const seat = room.seats.find(s => s && !s.left && s.pIdx === otherPIdx);
    if (seat) sendTo(seat, 'event', { msg: msg });
}

//--- 锦标赛版的一个动作 ----------------------------------------------------

function applyActionT(room, bt, side, action, forced) {
    const b = bt.b;
    if (!b || b.finished || bt.done || room.phase !== 'battle') {
        return { ok: false, err: '当前不能行动' };
    }
    if (b.turn !== side) return { ok: false, err: '还没轮到你' };

    // 挂机标记，和 1v1 同一套（见 applyAction 里的注释）。
    // 锦标赛里 side 是「这一桌的 0/1」，得先换成座位。
    // 二选一超时同样不算挂机 —— 他有操作，只是慢了。
    const actorPIdx = bt.pIdx[side];
    const actorT = room.seats.find(s => s && s.pIdx === actorPIdx);
    if (actorT && !(forced && action.type === 'pick2')) actorT.idled = !!forced;
    // 掉线的 AI 没有座位，挂机标记记在 player 上 —— armTurnTimerT 靠它把
    // 第二个回合起缩到 goneSecOf，和真人掉线同一套（不缩的话 15~45 秒的
    // 掉线只烧得掉一两个回合，看着不像掉线像是在长考）
    if (!actorT && !(forced && action.type === 'pick2')) {
        const ap = room.game.players[actorPIdx];
        if (ap && !ap.isHuman) ap.aiIdled = !!forced;
    }

    const turnBefore = b.turn;
    let msg = '', ok = true, err = '', failNote = '';
    let repick = null;      // 见 applyAction 里的注释

    withRoom(room, () => {
        if (action.type === 'hit') {
            if (!b.canHit(side)) {
                ok = false;
                err = b.noHitReason(side);
                return;
            }
            msg = b.act(side, 'hit').msg;
        } else if (action.type === 'stand') {
            msg = b.act(side, 'stand').msg;
        } else if (action.type === 'func') {
            const p = room.game.players[bt.pIdx[side]];
            const id = action.id;
            if (!id || p.funcs.indexOf(id) < 0) { ok = false; err = '你没有这张功能牌'; return; }
            const r = b.useFunc(side, id);
            if (!r.ok) { ok = false; err = r.err || '无法使用'; return; }
            msg = r.msg;
            // 失败原因照抄 useFunc 给的，别写死抽号牌那一种
            // （复制失败是「我方没有明牌可以复制」）
            if (r.fail) failNote = r.err || '无法使用';
            if (r.kind === 'repick') {
                const nc = b.sides[side].cards[b.sides[side].cards.length - 1];
                repick = { uid: nc ? nc.uid : 0, oldValue: r.oldValue, oldFace: r.oldFace };
            }
        } else if (action.type === 'pick2') {
            // 二选一的选择。只有待选那一方能选，idx 只接受 0/1 ——
            // 客户端发来的一律不可信，越界或不是他的回合都拒掉。
            const rp = b.pick2Resolve(side, action.idx);
            if (!rp) { ok = false; err = '现在不能选牌'; return; }
            msg = '对方选了 ' + rp.value;
        } else {
            ok = false; err = '未知动作';
        }
    });

    if (!ok) return { ok: false, err: err };

    // 【思考池扣费】真人用掉的池子 = 从回合起点到此刻超出回合时限的那一截。
    //
    // 三个坑，所以口径写在这里而不是别处：
    //   · 必须在动作**合法之后**扣 —— 上面 `if (!ok) return` 那条路回合没走完、
    //     turnStartAt 不变，在它之前扣的话一次非法点击就白扣一笔。
    //   · 必须在下面 turnStartAt 归零之前扣。
    //   · 一个回合里可能有多个动作（功能牌 endTurn=false），所以记账用
    //     bt.bankCharged 存「这个回合已经扣过多少」，每次只补差额。
    //   · forced 不走这里 —— 超时判过牌时 armTurnTimerT 的计时器已经按整段
    //     bankTurnMs 扣过了，再扣一次就是双倍。
    if (!forced && actorT && bt.turnStartAt && bt.bankTurnMs > 0) {
        const over = Date.now() - bt.turnStartAt - turnSecOf(room) * 1000;
        const want = Math.max(0, Math.min(over, bt.bankTurnMs));
        const delta = want - (bt.bankCharged || 0);
        if (delta > 0) {
            ladBankSpend(room, actorPIdx, delta);
            bt.bankCharged = want;
        }
    }

    if (forced) msg = (msg || '') + '（超时）';
    pushEventT(room, bt, side, msg);

    if (b.result && b.result.tie) { resolveTable(room, bt, true); return { ok: true, fail: failNote }; }
    if (b.finished) { resolveTable(room, bt, false); return { ok: true, fail: failNote }; }

    if (b.turn !== turnBefore) {
        bt.turnStartAt = 0; bt.turnGoneDeadline = 0;
        bt.aiPlan = null;               // 换人：下一步的拟人延迟要重抽
        bt.bankCharged = 0;             // 思考池记账也跟着回合走
    }
    armTurnTimerT(room, bt);
    pushStateT(room, repick ? { repick: repick } : null);
    stepAIIfNeeded(room, bt);
    return { ok: true, fail: failNote };
}

//--- 一桌打完 --------------------------------------------------------------

function resolveTable(room, bt, isTie) {
    clearTimeout(bt.turnTimer);
    clearTimeout(bt.aiTimer);
    bt.turnDeadline = 0;
    // 【全场唯一，不是每桌各数】客户端靠它判「这次结算我播过没有」。
    // 原来是 bt.resolveId++（每桌独立、新一轮换桌就从 0 重新数），于是
    // 第一轮我那桌数到 1、第二轮我那桌也数到 1 —— 客户端把第二轮的结算
    // 误认成第一轮那次，演出整个跳过，**拼点画面从第二轮起再也不出现**。
    // 用房间级的自增数就永远不会撞。
    room.resolveId++;
    bt.resolveId = room.resolveId;
    bt.isTie = !!isTie;

    if (isTie) {
        // 平局：这一桌重发再打，其他桌跟着等（你定的）。
        // 不要求任何人点确认 —— 一个人挂机不该卡住全场 8 个人。
        //
        // 【必须带 btId】pushStateT 的 extra 是 Object.assign 合并进**每一个**
        // 座位的消息的，所以 fresh / resolved / tie 会广播给全场 8 个人。
        // 不标明是哪一桌的话，别人桌平局重发会把我从轮结果页拽回对局画面
        // （客户端 m.fresh 分支无条件写 _phase='battle'），而回轮结果页的两条
        // 路都要求特定阶段 —— 于是一直钉在对局界面，直到本轮结束。
        // 一轮 4 桌，任意一桌平局就会发生一次，所以这个很常见。
        pushStateT(room, { resolved: true, tie: true, btId: bt.id });
        setTimeout(() => {
            if (bt.done || room.phase !== 'battle') return;
            withRoom(room, () => {
                bt.b.pendingRedeal = false;
                bt.b.result = null;
                bt.b.redeals++;
                bt.b.newDeal();
            });
            bt.turnStartAt = 0;
            bt.turnGoneDeadline = 0;
            bt.aiPlan = null;           // 重发是新的一手，延迟重抽
            bt.bankCharged = 0;
            armTurnTimerT(room, bt);
            pushStateT(room, { fresh: true, redealt: true, btId: bt.id });
            stepAIIfNeeded(room, bt);
        }, CFG.advanceMs);
        return;
    }

    // 发牌前拍一张手牌快照，客户端在揭牌演出期间显示这份
    bt.preFuncs = {};
    bt.pIdx.forEach(i => { bt.preFuncs[i] = room.game.players[i].funcs.slice(0); });

    withRoom(room, () => {
        const need = bt.b.grantFuncs();
        // 先把离开者刚摸到的牌退回池子，再随机弃 —— 见 returnFuncsOfLeft 的注释
        returnFuncsOfLeft(room);
        need.forEach(p => {
            const pi = room.game.players.indexOf(p);
            const seat = room.seats.find(s => s && s.pIdx === pi);
            // 已离开的人牌刚被退光，不可能还超上限
            if (seat && seat.left) return;
            // 【多人模式不再手动挑牌】超过 MAX_FUNC 一律随机弃掉多余的（你定的）。
            // 真人和 AI 走同一条路 —— AI 若用 autoDiscard（按价值弃最差的），
            // 等于白拿一个「弃牌总是弃对」的优势。
            // 弃掉哪几张记在座位上，下一份状态带给客户端提示，
            // 否则玩家只会看到手牌莫名少了几张。
            const gone = D678.randomDiscard(p);
            if (seat) seat.autoDiscarded = gone;
        });
        room.game.players.forEach(p => {
            if (!p.alive && p.funcs.length > 0) room.game.returnAllFuncs(p);
        });
    });

    bt.done = true;
    // 不再有「欠弃牌」这回事：上面已经随机弃完了，轮次屏障也就不用等它。
    // btId 见上面平局分支的注释 —— 客户端靠它判掉别人桌的结算。
    pushStateT(room, { resolved: true, tie: false, btId: bt.id });
    checkRoundBarrier(room);
}

//--- 轮次屏障 --------------------------------------------------------------

function checkRoundBarrier(room) {
    if (room.phase !== 'battle' && room.phase !== 'resolved') return;
    if (room.battles.some(x => !x.done)) return;                 // 还有桌在打
    // 原来这里还要等「没人欠弃牌」。多人模式改成随机自动弃之后，
    // 结算那一刻牌就已经弃完了，屏障只需要看桌打完没有。
    room.battles.forEach(bt => { clearTimeout(bt.turnTimer); clearTimeout(bt.aiTimer); });

    // 给一点时间看自己那桌的结果，再开下一轮
    clearTimeout(room.roundTimer);
    room.roundTimer = setTimeout(() => {
        // 【被淘汰的 AI 标「离开」】真人被淘汰时下面会置 s.left（为了不再推
        // 盘面给他），于是排名表里真人淘汰后带着「离开」而 AI 什么都没有 ——
        // 一局下来只有真人会离开，剩下 7 个永远在线，这个差别肉眼看得出来
        // （你报的）。所以 AI 淘汰后也标上。
        room.game.players.forEach((p, pIdx) => {
            if (p.isHuman || p.alive) return;
            if (aiNetOf(room, pIdx) === 'left') return;      // 已经标过了
            aiNetMarkOut(room, pIdx);
        });
        // 淘汰：血空的人踢回大厅，赛事继续（你定的）
        const outSeats = [];
        room.seats.forEach(s => {
            if (!s || s.left) return;
            const p = room.game.players[s.pIdx];
            if (p && !p.alive) outSeats.push(s);
        });
        outSeats.forEach(s => {
            const rank = rankOf(room, s.pIdx);
            // 【天梯：被淘汰就是这一局的最终名次，当场结算】
            // 不能等 enterOverT —— 淘汰的人 SSE 会被 releaseSeatConn 收掉，
            // 那时候再发加减分他收不到。ladResult 存在座位上，enterOverT 和
            // 重连都读它，保证同一局只算一次。
            let ladR = null;
            if (room.mode === 'ladder' && s.ladAcc && !s.ladResult) {
                s.ladResult = ladSettle(room, s, rank, room.game.players.length);
                ladR = s.ladResult;
                ladHistoryAdd(s.ladAcc, room.code, room.tourneyStartAt,
                    rank, room.game.players.length, ladR, false,
                    snapshotVsLog(room, s.pIdx));
            }
            sendTo(s, 'eliminated', Object.assign({
                rank: rank, total: room.game.players.length,
                name: room.game.players[s.pIdx].name,
                lad: ladR || undefined,
            }, eliminatedStats(room, s.pIdx)));
            log('房间 %s %s 被淘汰（第 %d 名），踢回大厅', room.code,
                room.game.players[s.pIdx].name, rank);
            s.left = true;   // 位置留着（规则层还要按 outAt 排名），但不再推盘面
            // 出局了就跟这场赛事没关系了 —— 主动收掉这条 SSE，别让它一直挂着
            // （你定的，减服务器压力）。战绩已经在上面那条消息里发全了，
            // 关掉不会丢东西。
            releaseSeatConn(room, s);
        });

        const aliveN = room.game.players.filter(p => p.alive).length;
        // 【掉线 ≠ 离开】只看 left 不看 connected —— 单人天梯掉线时游戏要继续
        // 推进（AI 照打、掉线的人超时自动过牌），等他重连回来接着打。
        // graceTimer 到点才置 left=true，那之后这里 humansLeft 才会归零。
        const humansLeft = room.seats.filter(s => s && !s.left).length;
        if (aliveN <= 1 || humansLeft === 0) {
            // 单人天梯：最后一个真人离开时赛事还没打完（aliveN > 1），
            // 立刻快进模拟剩余 AI 轮次，算出最终排名。结果不马上公布 ——
            // 设 expectedEndAt = now + 轮数 × 40s，到时间才能看详情，
            // 否则第 8 名淘汰后秒出排名就等于告诉玩家「其余 7 个是 AI」。
            if (humansLeft === 0 && aliveN > 1 && room.mode === 'ladder') {
                fastForwardLad(room);
            } else {
                enterOverT(room);
            }
            return;
        }
        startRound(room);
    }, CFG.advanceMs);
}

// 淘汰页的战绩。口径和单机 buildFinalReport 完全一致（你定的「跟单人模式
// 下失败一致」），外加对每个对手的分项战绩。
//
// 只发给**被淘汰的那个人自己**，所以不需要遮蔽 —— 他已经出局了，
// 知道全场谁跟谁打了多少场不影响任何还在进行的对局。
function eliminatedStats(room, pIdx) {
    const p = room.game.players[pIdx];
    const games = p.wins + p.losses;
    const rate = (a, n) => (n > 0 ? Math.round(a / n * 100) : null);
    // 对手战绩：按对局数从多到少排，同数按名字稳定排序，
    // 免得每次进页面顺序都在跳
    const vs = Object.keys(p.vsLog || {}).map(k => {
        const e = p.vsLog[k];
        const n = e.wins + e.losses;
        return { name: e.name, games: n, wins: e.wins, losses: e.losses,
                 rate: rate(e.wins, n) };
    }).sort((a, b) => (b.games - a.games) || a.name.localeCompare(b.name));
    return {
        hp: Math.max(0, p.hp),
        games: games, wins: p.wins, losses: p.losses,
        winRate: rate(p.wins, games),
        maxPoint: p.maxPoint, maxRate: rate(p.maxPoint, games),
        funcUses: p.funcUses || 0,
        vs: vs,
    };
}

// 拍一份 vsLog 快照给历史战绩用：你对每个交手过的对手的胜负。
// 玩家被淘汰 / 退出后 vsLog 不再变，拍一份存进历史条目。
function snapshotVsLog(room, pIdx) {
    const p = room.game ? room.game.players[pIdx] : null;
    if (!p) return null;
    const rate = (a, n) => (n > 0 ? Math.round(a / n * 100) : null);
    return Object.keys(p.vsLog || {}).map(k => {
        const e = p.vsLog[k];
        const n = e.wins + e.losses;
        return { name: e.name, games: n, wins: e.wins, losses: e.losses,
                 rate: rate(e.wins, n) };
    }).sort((a, b) => (b.games - a.games) || a.name.localeCompare(b.name));
}

// 名次：已淘汰的按 outAt 倒数，存活的按血量。和 rankedPlayers 同一套语义。
function rankOf(room, pIdx) {
    const ranked = room.game.rankedPlayers();
    const i = ranked.indexOf(room.game.players[pIdx]);
    return (i >= 0) ? i + 1 : room.game.players.length;
}

// 快进模拟：所有真人离开后，把剩余 AI 轮次一次性算完，再走 enterOverT。
//
// 每轮固定 40 秒（你定的），expectedEndAt = now + 轮数 × 40s。
// 到时间之前历史战绩显示「对局中」，过了才能看详情 —— 避免泄露 AI 身份。
function fastForwardLad(room) {
    const g = room.game;
    let ffRounds = 0;
    const rawAIStep = D678.AI.step;
    withRoom(room, () => {
        while (g.alivePlayers().length > 1 && ffRounds < 200) {
            const r = g.makeRound();
            if (r.bye) r.bye.last = { type: 'bye', dmg: 0 };
            r.pairs.forEach(pair => {
                const pa = pair[0], pb = pair[1];
                const ia = g.players.indexOf(pa), ib = g.players.indexOf(pb);
                const frozenA = aiFrozen(room, ia), frozenB = aiFrozen(room, ib);
                // 冻结的 AI（掉线 / 离开）强制过牌，和正常轮次的行为一致
                try {
                    if (frozenA || frozenB) {
                        D678.AI.step = function (b, si) {
                            if ((si === 0 && frozenA) || (si === 1 && frozenB)) {
                                b.act(si, 'stand');
                                return { side: si, action: 'stand', msg: '对方过牌' };
                            }
                            return rawAIStep.call(this, b, si);
                        };
                    } else {
                        D678.AI.step = rawAIStep;
                    }
                    D678.simulateMatch(pa, pb);
                } finally {
                    D678.AI.step = rawAIStep;
                }
            });
            // 被淘汰的玩家手牌退回池子（和正常 doResolveT 里的逻辑一致）
            g.players.forEach(p => {
                if (!p.alive && p.funcs.length > 0) g.returnAllFuncs(p);
            });
            ffRounds++;
        }
    });
    D678.AI.step = rawAIStep;
    room._ffExpectedEndAt = Date.now() + ffRounds * 40000;
    log('房间 %s 天梯快进模拟：%d 轮，预计 %ds 后公布结果',
        room.code, ffRounds, ffRounds * 40);
    enterOverT(room);
}

function enterOverT(room) {
    room.battles.forEach(bt => { clearTimeout(bt.turnTimer); clearTimeout(bt.aiTimer); });
    clearTimeout(room.roundTimer);
    clearTimeout(room.ladFillTimer);
    room.phase = 'over';
    const ranked = room.game.rankedPlayers();
    room.overInfo = ranked.map((p, i) => {
        const pi = room.game.players.indexOf(p);
        const st = room.seats.find(s => s && s.pIdx === pi);
        return {
            rank: i + 1, name: p.name, hp: p.hp, alive: p.alive,
            wins: p.wins, losses: p.losses, maxPoint: p.maxPoint,
            games: p.wins + p.losses, funcUses: p.funcUses,
            // 和 maskViewT 里的 status 同一套取值：真人看座位，AI 看 aiNet。
            // 天梯下被淘汰的 AI 会被标成「离开」（见 aiNetMarkOut）——
            // 真人淘汰后本来就带这个标注，AI 不带的话最终排名里一眼看出
            // 「只有真人会离开」。
            status: st ? (st.left ? 'left' : (st.connected ? '' : 'gone'))
                       : aiNetOf(room, pi),
        };
    });
    // 发给所有座位，包括已淘汰的（他们的 SSE 还连着）—— 淘汰的人回到大厅后
    // 靠这份数据弹一次最终排名，否则他永远不知道最后谁赢了（你定的）
    room.seats.forEach(seat => {
        if (!seat) return;
        const me = room.game.players[seat.pIdx];
        const myRank = ranked.indexOf(me) + 1;
        // 天梯：活到最后的人在这里结算。已经算过的（被淘汰 / 中途退出）
        // 不再算第二次 —— ladResult 就是这道闸门。
        if (room.mode === 'ladder' && seat.ladAcc && !seat.ladResult) {
            seat.ladResult = ladSettle(room, seat, myRank, room.game.players.length);
            // 冠军：之前没被淘汰 / 退出，没有 pending 条目，这里建一条
            ladHistoryAdd(seat.ladAcc, room.code, room.tourneyStartAt,
                myRank, room.game.players.length, seat.ladResult, false,
                snapshotVsLog(room, seat.pIdx));
        }
        sendTo(seat, 'over', {
            mode: 'tourney',
            win: ranked[0] === me,
            myRank: myRank,
            ranks: room.overInfo,
            ladder: room.mode === 'ladder' || undefined,
            lad: seat.ladResult || undefined,
        });
    });
    // 天梯历史战绩：把这一局所有 pending 条目补全 endedAt / overInfo / expectedEndAt。
    // 快进模拟的 expectedEndAt 在未来 —— 到时间之前详情锁定。
    if (room.mode === 'ladder') {
        const endedAt = Date.now();
        const expectedEndAt = room._ffExpectedEndAt || endedAt;
        room.seats.forEach(seat => {
            if (!seat || !seat.ladAcc) return;
            ladHistoryFinalize(seat.ladAcc, room.code, endedAt, expectedEndAt, room.overInfo);
        });
        accSave();
    }
    // 解冻定时器不用留了 —— overInfo 已经拍好快照（status 在上面读过），
    // 之后再改 aiNet 也影响不到任何显示。留着只会让房间在销毁前多握几个定时器。
    aiNetClear(room);
    log('房间 %s %s结束，冠军 %s', room.code,
        room.mode === 'ladder' ? '天梯' : '锦标赛',
        ranked[0] ? ranked[0].name : '?');
}

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
    // 本日联机人数：1v1 两个座位都是真人，开打就是 +2（不计入 plays，见 startTourney）
    dailyBump('online', room.seats.filter(s => s).length);
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
    room.seats.forEach(s => { if (s) { s.acked = false; s.autoDiscarded = null; } });
    room.turnStartAt = 0;
    room.turnGoneDeadline = 0;
    // 计时器必须在 pushState 之前武装 —— 否则这一份状态里的 turnLeft 是 0，
    // 客户端第一回合就没有倒计时可显示（这就是「第一回合不显示」的原因）
    armTurnTimer(room);
    pushState(room, { fresh: true });
}

//--- 回合计时 --------------------------------------------------------------
// 超时判过牌：stand 永远是合法动作，不会因为「明牌已满 21 不能要牌」这类
// 限制而失败。CFG.turnSec = 0 时不计时（本地调试）。

// 每次行动后重排。掉线 / 重连时也要重排（onDisconnect / onReconnect 各调一次）——
// 时限是在行动那一刻算好的，中途掉线不重排的话那一个回合仍然等满 turnSec。
//
// 截止时间一律从 room.turnStartAt 这个锚点算，不是从「现在」算：
//   · 正常     -> 回合起点 + turnSec
//   · 挂机过    -> 回合起点 + goneTurnSec（10 秒），直到他正常操作一次为止
//
// 【判据是「上个回合被判过牌」，不是「此刻掉线」】（你定的规则）
//
// 规则：超时 30 秒被自动判过牌之后，下一个回合的时限降到 10 秒，直到他
// 正常操作为止。掉线的人走同一条路 —— 掉线那个回合仍然是完整 30 秒
// （他可能马上就回来），只有等这 30 秒烧完、被自动判了过牌，
// 下一个回合才变成 10 秒；重连并真的操作一次就恢复 30 秒。
//
// 这样挂机和掉线是同一套语义：**代价发生在「已经浪费过一个回合」之后**，
// 而不是「一检测到你不在就立刻缩短」。对在线那一方的好处是不用陪着
// 挂机的人一轮一轮等满 30 秒。
//
// 锚定到回合起点（不是「现在」）是为了让重连能干净地恢复：直接重算就行，
// 不用记「掉线时还剩多少」。因为切换只发生在回合之间、不在回合中途，
// 所以不再需要原来那套「取 min 防算出过去时刻」的兜底。
function armTurnTimer(room) {
    clearTimeout(room.turnTimer);
    room.turnDeadline = 0;
    if (!CFG.turnSec || room.phase !== 'battle' || !room.battle) return;
    if (room.battle.finished) return;

    const now = Date.now();
    if (!room.turnStartAt) room.turnStartAt = now;

    const si = room.battle.turn;
    const seat = room.seats[si];
    // idled：上一次轮到他时是被自动判过牌的（超时或掉线烧完）。
    // 他正常操作一次就清掉（见 applyAction）。
    const short = !!(seat && seat.idled);
    const sec = short ? (CFG.goneTurnSec || CFG.turnSec) : CFG.turnSec;

    room.turnDeadline = room.turnStartAt + sec * 1000;

    // 【二选一不另起短计时器】选牌窗口 = 整个回合剩余时间，和普通回合一样挂在
    // turnDeadline 上。超时（玩家没操作导致自动跳过）时如果还有 pending2，
    // 随机选一张而不是直接判过牌——见下面的回调。不再用 min(pick2Sec, 回合剩余)
    // 提前开火，那是「还有思考时间却替他选了」。
    room.turnTimer = setTimeout(() => {
        const b = room.battle;
        if (!b || b.finished || room.phase !== 'battle') return;
        if (b.pending2) {
            // 二选一超时 -> 随机选（pick2Resolve 会 endTurn）
            const who = b.pending2.side;
            log('房间 %s 座位 %d 二选一超时 -> 随机选', room.code, who);
            applyAction(room, who, { type: 'pick2', idx: Math.random() < 0.5 ? 0 : 1 }, true);
            return;
        }
        log('房间 %s 座位 %d 回合超时 -> 判过牌（%d 秒时限%s）',
            room.code, b.turn, sec, short ? '，挂机中' : '');
        applyAction(room, b.turn, { type: 'stand' }, true);
    }, Math.max(0, room.turnDeadline - Date.now()));
}

//--- 应用一个动作 ----------------------------------------------------------

function applyAction(room, si, action, forced) {
    const b = room.battle;
    if (!b || b.finished || room.phase !== 'battle') return { ok: false, err: '当前不能行动' };
    if (b.turn !== si) return { ok: false, err: '还没轮到你' };

    // 挂机标记（你定的规则）：被自动判过牌就挂上，下一个回合只给
    // goneTurnSec；真人自己操作一次就摘掉，恢复完整 turnSec。
    // 掉线的人也走这一条 —— 掉线那个回合照旧 30 秒，烧完被判过牌之后
    // 才降速，重连并操作一次就恢复。
    //
    // 【二选一超时不算挂机】（你定的）超时随机选那次是 forced，但他确实
    // 操作过 —— 牌已经打出去了，只是选得慢。挂上 idled 会让他下一个回合
    // 无端降到 10 秒，那是给挂机的人的惩罚，不该落到他头上。
    const actor = room.seats[si];
    if (actor && !(forced && action.type === 'pick2')) actor.idled = !!forced;

    // 只有抽牌类动作会结束回合（用功能牌通常不会），所以不能无条件重置锚点，
    // 否则每用一张功能牌都白送一个完整回合的时间
    const turnBefore = b.turn;

    let msg = '', ok = true, err = '', failNote = '';
    // 重抽的动画信息（哪一方、洗回去的是哪个数字）。客户端要靠它播
    // 「旧牌飞回牌库 + 新牌入场」那套完整动画 —— 少了收牌那一半，
    // 玩家会觉得「用了重抽好像没反应」。
    //
    // 【不涉及遮蔽】洗回去那张是**明牌**，本来就双方可见。
    let repick = null;

    withRoom(room, () => {
        if (action.type === 'hit') {
            if (!b.canHit(si)) {
                ok = false;
                err = b.noHitReason(si);
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
            // 失败原因照抄 useFunc 给的，别写死抽号牌那一种
            if (r.fail) failNote = r.err || '无法使用';
            if (r.kind === 'repick') {
                // 【发新牌的 uid，不发 side】extra 对所有座位是同一份，
                // 没法按人镜像；而客户端恒把自己当 side 0。发 uid 的话它在
                // 自己那份已镜像的盘面里一找就知道是哪一排，免疫镜像问题。
                const nc = b.sides[si].cards[b.sides[si].cards.length - 1];
                repick = { uid: nc ? nc.uid : 0, oldValue: r.oldValue, oldFace: r.oldFace };
            }
        } else if (action.type === 'pick2') {
            // 二选一的选择。只有待选那一方能选，idx 只接受 0/1
            const rp = b.pick2Resolve(si, action.idx);
            if (!rp) { ok = false; err = '现在不能选牌'; return; }
            msg = '对方选了 ' + rp.value;
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

    if (b.turn !== turnBefore) {
        room.turnStartAt = 0;        // 换人了：下面 armTurnTimer 会重新锚定
        room.turnGoneDeadline = 0;
    }
    armTurnTimer(room);   // 先武装再推，让这份状态带上新的 turnLeft
    pushState(room, repick ? { repick: repick } : null);
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
    room.seats.forEach(s => { if (s) { s.acked = false; s.autoDiscarded = null; } });

    // 发牌前先拍一张手牌快照，客户端在揭牌演出期间显示这份，
    // 演出走完才切到发牌后的 —— 对齐单机「演出结束才看到奖励」的节奏
    room.preFuncs = room.game.players.map(p => p.funcs.slice(0));

    if (!isTie) {
        withRoom(room, () => {
            const need = room.battle.grantFuncs();   // 胜者摸 1、败者摸 2
            // 【多人模式不再手动挑牌】和锦标赛同一条规矩：超过 MAX_FUNC
            // 随机弃掉多余的（你定的）。弃了哪几张记在座位上给界面提示。
            need.forEach(p => {
                const seat = room.seats.find(s => s && s.player === p);
                const gone = D678.randomDiscard(p);
                if (seat) seat.autoDiscarded = gone;
            });
            // 淘汰者的功能牌回公共池
            room.game.players.forEach(p => {
                if (!p.alive && p.funcs.length > 0) room.game.returnAllFuncs(p);
            });
        });
    }

    pushState(room, { resolved: true, tie: !!isTie });
    armAckTimer(room);
}

// 这里原来有 armDiscardTimer（弃牌超时替人自动弃）。多人模式改成
// 「超过 MAX_FUNC 当场随机弃」之后，没有任何时刻会存在「欠弃牌」的人，
// 那个定时器、room.discardTimer / discardDeadline、/api/discard 一并删了。
// --discard-sec 还认（老命令行和测试脚本会传），但不再有作用。

// 有人挂机不点「继续」时替他确认，免得另一个人无限等
function armAckTimer(room) {
    clearTimeout(room.ackTimer);
    if (!CFG.ackSec) return;
    room.ackTimer = setTimeout(() => {
        if (room.phase !== 'resolved') return;
        withRoom(room, () => {
            room.seats.forEach(s => { if (s) s.acked = true; });
        });
        log('房间 %s 继续确认超时 -> 自动推进', room.code);
        doAdvance(room);   // 兜底：无条件推进，不再看 acked
    }, CFG.ackSec * 1000);
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

// 真正开下一局 / 平局重发
function doAdvance(room) {
    if (room.phase !== 'resolved') return;
    clearAdvance(room);
    clearTimeout(room.ackTimer);

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

    // 锦标赛【大厅】掉线：就绪标记立刻清掉，10 秒后座位彻底移除。
    //
    // 就绪必须马上清 —— 留着的话赛事可能在他人不在的情况下开打。清了之后
    // 「全员就绪」自然不成立，这 10 秒里房间开不了赛，等于他有 10 秒回来的
    // 窗口；真走了就移除席位，然后重算一次开赛条件（少了这次重算，
    // 剩下的人会一直等一个已经不存在的人）。
    //
    // 放在下面那条 peer 消息之前是故意的：peer 是 1v1 的「对手掉线了」提示，
    // 大厅里一屋子人收到它没有意义。
    if (isTourneyLike(room) && room.phase === 'lobby') {
        seat.ready = false;
        pushRoom(room);
        clearTimeout(seat.graceTimer);
        seat.graceTimer = setTimeout(() => {
            if (seat.connected) return;      // 回来了
            removeSeat(room, seat);
            // 天梯房里真人全走了就没有开赛的意义 —— 那一桌会变成 8 个 AI
            // 互相打给没人看。假计数的定时器也要一起停掉。
            if (!room.seats.some(s => s)) {
                dropRoom(room, '大厅里没人了');
                return;
            }
            pushRoom(room);
            if (room.mode === 'tourney') maybeStartTourney(room);
        }, CFG.lobbyGraceSec * 1000);
        return;
    }

    pushRoom(room);

    // 【只在 1v1 发】peer 是「你的对手掉线了」，客户端收到会弹一个红框 +「退出」
    // 按钮。这条 find 取的是「座位数组里第一个不是他的人」—— 1v1 里那就是对手，
    // 8 人赛里只是碰巧排在最前面的那个座位，跟掉线的人多半不同桌。结果是：
    // 随便谁掉线，某个毫不相干的玩家屏上冒出「对方掉线」，而他的对手好好地
    // 坐在对面；真正同桌那个人反而什么都收不到。而且 peer{gone:false} 在
    // onReconnect 里同样是 find 第一个，挑中别人的话最初那个框就永久留在屏上。
    //
    // 锦标赛不需要它：同桌掉线由 maskViewT 的 status 标注（对手名字后缀
    // 「（掉线）」、排名列表显示「掉线」），是标注而不是挡路的框 —— 他那桌
    // goneTurnSec 自动过牌，赛事照走，玩家没有理由退出。
    //
    // 【赛事已经结束就不发】phase === 'over' 时对手关掉浏览器、或者看完战绩
    // 自己走了 —— 那是「最后一局打完之后离开」，不是掉线。这时候在对方屏上
    // 弹「对方掉线」是错的：这一场早就结束了，他掉不掉线都不影响任何东西
    // （你定的）。
    if (!isTourneyLike(room) && room.phase !== 'over') {
        const other = room.seats.find(s => s && s !== seat);
        // 不发倒计时 —— 界面上改成「已掉线 X 秒」+ 随时可点返回主菜单。
        // 催一个倒计时没意义：对方回不回来不是这边能控制的事。
        if (other) sendTo(other, 'peer', { gone: true, name: seat.name });
    }

    // 正好轮到掉线这个人时，把他的回合缩到 goneTurnSec。必须重排 + 推一次状态：
    // 时限是行动那一刻算好的，不重排的话这一个回合仍然等满 turnSec；
    // 而 pushRoom / peer 都不带 turnLeft，不推 state 在线方的倒计时不会更新。
    if (room.phase === 'battle' && room.battle && !room.battle.finished) {
        armTurnTimer(room);
        pushState(room);
    }

    // 锦标赛：一个人掉线不该毁掉整场赛事。缩短他那桌的回合、推一份新盘面，
    // 别人照常打；宽限期烧完转成「离开」（一路自动过牌，不再等他）。
    if (isTourneyLike(room)) {
        const bt = room.battles.find(x => !x.done && x.pIdx.indexOf(seat.pIdx) >= 0);
        if (bt && room.phase === 'battle') {
            armTurnTimerT(room, bt);
            pushStateT(room);
        } else {
            pushStateT(room);
        }
        clearTimeout(seat.graceTimer);
        seat.graceTimer = setTimeout(() => {
            if (seat.connected) return;
            seat.left = true;
            log('房间 %s %s 宽限期满 -> 判为离开', room.code, seat.name);
            // 手上的牌立刻回池，不等到下一轮发牌才退
            withRoom(room, () => { returnFuncsOfLeft(room); });
            // 他那桌若正等他行动，立刻自动过牌把牌局推下去
            const b2 = room.battles.find(x => !x.done && x.pIdx.indexOf(seat.pIdx) >= 0);
            if (b2 && room.phase === 'battle') {
                if (b2.b && b2.b.turn === (b2.pIdx[0] === seat.pIdx ? 0 : 1)) {
                    forceStand(room, b2, '离开');
                } else {
                    armTurnTimerT(room, b2);
                }
            }
            // 全部真人都走了就收房间
            if (!room.seats.some(s => s && !s.left && s.connected)) {
                // 【天梯：收房间之前必须结算】这条路原来直接 dropRoom 就 return，
                // 跳过了 enterOverT —— 而结算在那里面。后果是可利用的：
                // 打得差时直接关浏览器，宽限期满房间静默销毁，一分不扣；
                // 而老实点「退出」的人按末名扣分。关标签页严格优于主动退出。
                //
                // 掉线永不回来在语义上就是中途退出，按末名算（和 /api/leave
                // 同一个口径）。重连回来的人走不到这里（上面 seat.connected
                // 那条就 return 了）。
                ladSettleAllLeft(room, '掉线未回来');
                if (room.mode === 'ladder' && room.game) {
                    room.seats.forEach(s => { if (s && s.sse) releaseSeatConn(room, s); });
                    fastForwardLad(room);
                }
                dropRoom(room, '赛事里所有真人都离开了');
                return;
            }
            pushStateT(room);
            checkRoundBarrier(room);
        }, CFG.graceSec * 1000);
        return;
    }

    clearTimeout(seat.graceTimer);
    seat.graceTimer = setTimeout(() => {
        if (seat.connected) return;
        // 【赛事已结束就静静收房间】看完战绩离开的人不该让对方收到
        // 「掉线未回来，本场结束」—— 那一场早就结束了，说「本场结束」是错的
        // （你定的）。房间照旧要收，只是不通知。
        if (room.phase === 'over') { dropRoom(room, '结束后对手离开'); return; }
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

    // 和 onDisconnect 里那条一样，只在 1v1 发 —— 锦标赛里 find 挑中的多半
    // 不是同桌那个人，清框会清到别人头上，而该清的那个永远清不掉。
    if (!isTourneyLike(room)) {
        const other = room.seats.find(s => s && s !== seat);
        if (other) sendTo(other, 'peer', { gone: false, name: seat.name });
    }

    // 锦标赛 / 天梯：恢复他那桌的时限，补一份房间信息 + 盘面
    if (isTourneyLike(room)) {
        pushRoom(room);
        if (room.phase === 'over' && room.overInfo) {
            const me = room.game.players[seat.pIdx];
            const ranked = room.game.rankedPlayers();
            sendTo(seat, 'over', {
                mode: 'tourney', win: ranked[0] === me,
                myRank: ranked.indexOf(me) + 1, ranks: room.overInfo,
                // 重连回来也要能看到自己的加减分（结算面板要显示）。
                // seat.ladResult 是 enterOverT 那一刻算好存下的 —— 不能在这里
                // 重算，那会把同一局的分算第二次。
                ladder: room.mode === 'ladder' || undefined,
                lad: seat.ladResult || undefined,
            });
            return;
        }
        if (room.game) {
            const bt = room.battles.find(x => !x.done && x.pIdx.indexOf(seat.pIdx) >= 0);
            if (bt && room.phase === 'battle') armTurnTimerT(room, bt);
            pushStateT(room, { resync: true });
            if (bt) stepAIIfNeeded(room, bt);
        }
        return;
    }

    // 恢复回 turnSec。turnStartAt 不动 —— 锚点还是这个回合真正开始的时刻，
    // 所以他拿回的是「本回合剩下的时间」，不是重新给满 30 秒。
    // 必须在下面 pushState 之前重排，否则 resync 那份状态带的还是缩短后的
    // turnLeft，刚回来的人看到 3 秒而其实有 20 秒。
    if (room.phase === 'battle' && room.battle && !room.battle.finished) {
        armTurnTimer(room);
    }

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

        // 1v1：两个人都连上了就开打。
        // 锦标赛不在这里开 —— 连上只是入座，要等各人点「准备」（/api/ready）。
        // 否则第 2 个人一连上就把还没到的人关在门外了。
        // 天梯也不在这里开 —— 它由假计数走完触发（ladFillTick）。
        // 少了这条排除，天梯房第一个人一连上就会走 startDuel（2 席那套），
        // 而天梯房有 8 席，seats.every 永远不成立倒是碰巧挡住了 —— 但那是
        // 巧合，不是设计。写明白。
        if (!isTourneyLike(room) && room.phase === 'lobby' &&
            room.seats.every(s => s && s.connected)) {
            startDuel(room);
        }
        // 重连回来的人如果正好补齐了「全员就绪」就直接开（掉线会清就绪标记，
        // 所以正常不会在这儿触发；留着是防某条路忘了清）
        maybeStartTourney(room);
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

    //--- 锦标赛：匹配（有未满未开始的房就进，否则建一个）------------------
    // 不做公开房间列表 —— 名字只对同房的人可见，不暴露给还没进房的访客。
    if (u === '/api/match' && req.method === 'POST') {
        readBody(req, body => {
            if (!body) return json(res, 400, { err: '请求格式错误' });
            const name = cleanName(body.name, '选手');
            let room = null;
            for (const r of rooms.values()) {
                if (r.mode !== 'tourney' || r.phase !== 'lobby') continue;
                const taken = r.seats.filter(s => s && !s.left).length;
                if (taken < TOURNEY_MAX_HUMANS) { room = r; break; }
            }
            if (!room) room = newRoom('tourney');
            const seat = addSeat(room, name);
            if (!seat) return json(res, 409, { err: '房间刚好满了，再点一次' });
            json(res, 200, {
                room: room.code, sid: seat.sid, mySeat: seat.index, mode: 'tourney',
            });
        });
        return;
    }

    //--- 锦标赛：准备 / 取消准备（全员就绪且 ≥2 人则立刻开赛）--------------
    // 没有「开始」按钮 —— 谁没点准备在席位表里看得见，不需要兜底的手动开始
    // （你定的）。挂机的人卡住房间是可接受的，朋友局互相喊一声就行。
    if (u === '/api/ready' && req.method === 'POST') {
        readBody(req, body => {
            if (!body) return json(res, 400, { err: '请求格式错误' });
            const found = seatOf(body.sid);
            if (!found) return json(res, 404, { err: '会话失效' });
            const { room, seat } = found;
            if (!seat || seat.left) return json(res, 404, { err: '会话失效' });
            if (room.mode !== 'tourney') return json(res, 400, { err: '不是锦标赛房间' });
            if (room.phase !== 'lobby') return json(res, 409, { err: '已经开始了' });
            // 不传 ready 就当切换，传了就照传的设
            seat.ready = (body.ready === undefined) ? !seat.ready : !!body.ready;
            room.touched = Date.now();
            const taken = room.seats.filter(s => s && !s.left).length;
            json(res, 200, { ok: true, ready: seat.ready, takenN: taken });
            // 先回响应再判开赛：startTourney 会推一大堆 SSE，
            // 别让 HTTP 响应吊在后面
            if (!maybeStartTourney(room)) pushRoom(room);
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

    //--- 恢复会话 ----------------------------------------------------------
    // 客户端刷新后拿 sessionStorage 里的 sid 来问「我这个座位还在吗」。
    //
    // 必须是 XHR 能打的普通接口，不能让客户端靠 EventSource 的 onerror 判断 ——
    // EventSource 不暴露 HTTP 状态码（404 / 500 / 断网都是同一个空事件），
    // 而且浏览器对 4xx 会无限重连，表现就是卡在「正在重连」永远出不来。
    //
    // 必须回 mySeat：它原来只在 create / join 的响应里给，sessionStorage 只存了
    // {sid, room}，刷新后 mySeat 归 0 —— 坐 1 号位的人回来镜像会整个反过来。
    // phase 一起带上，客户端靠它决定回大厅等待页还是进对局场景。
    if (u === '/api/resume' && req.method === 'POST') {
        readBody(req, body => {
            if (!body) return json(res, 400, { err: '请求格式错误' });
            const found = seatOf(body.sid);
            if (!found) return json(res, 404, { err: '会话已失效' });
            const { room, seat } = found;
            // 锦标赛还要回「我在哪一桌、哪个 side」—— 只回 phase 的话
            // 刷新后不知道自己该看哪桌的牌面
            const bt = (isTourneyLike(room) && room.battles)
                ? room.battles.find(x => !x.done && x.pIdx.indexOf(seat.pIdx) >= 0)
                : null;
            json(res, 200, {
                ok: true, room: room.code, mySeat: seat.index,
                mode: room.mode, phase: room.phase, name: seat.name,
                pIdx: seat.pIdx,
                pairId: bt ? bt.id : -1,
                side: bt ? (bt.pIdx[0] === seat.pIdx ? 0 : 1) : -1,
            });
        });
        return;
    }

    //--- 天梯：注册 --------------------------------------------------------
    // 注册成功直接发令牌（等于顺带登录）。让人注册完再去点一次「认证」是白
    // 多一步 —— 他刚刚才输过这对账号密码。
    if (u === '/api/lad/reg' && req.method === 'POST') {
        readBody(req, body => {
            if (!body) return json(res, 400, { err: '请求格式错误' });
            const acc = chkAcc(body.acc);
            if (!acc) return json(res, 400, { err: '账号是 4-16 位字母、数字或下划线' });
            const pw = chkPw(body.pw);
            if (!pw) return json(res, 400, { err: '密码是 4-16 位字母、数字或符号' });
            const key = acc.toLowerCase();
            if (accounts.has(key)) return json(res, 409, { err: '这个账号已经被注册了' });
            if (accounts.size >= ACC_MAX) {
                return json(res, 507, { err: '账号数已达上限，联系管理员' });
            }
            const ip = ipOf(req);
            if (regTooSoon(ip)) {
                return json(res, 429, { err: '注册太频繁，等十秒再试' });
            }
            regCool.set(ip, Date.now());
            // 天梯字段给足初值。少了 ladSeason 的话第一次 ladScoreOf 会认为
            // 「赛季对不上」，当场把 1000 软重置成 1000 —— 结果一样但会白写一次盘
            const rec = { acc: acc, pw: pw, name: '', renamedDay: '',
                          ladScore: LAD_BASE, ladSeason: ladSeason(nowSec()).key,
                          ladGames: 0, ladSGames: 0, ladRankSum: 0, ladChamps: 0 };
            accounts.set(key, rec);
            accSave();
            const tk = newToken();
            ladTokens.set(tk, key);
            log('天梯注册 %s（共 %d 个账号）', acc, accounts.size);
            json(res, 200, Object.assign({ ok: true, token: tk }, accView(rec)));
        });
        return;
    }

    //--- 天梯：认证 --------------------------------------------------------
    // 账号不存在和密码错一律回同一句「账号或密码不对」—— 分开说等于告诉
    // 试密码的人「这个账号存在，继续试」。
    if (u === '/api/lad/auth' && req.method === 'POST') {
        readBody(req, body => {
            if (!body) return json(res, 400, { err: '请求格式错误' });
            const acc = chkAcc(body.acc);
            const pw  = chkPw(body.pw);
            if (!acc || !pw) return json(res, 401, { err: '账号或密码不对' });
            const rec = accounts.get(acc.toLowerCase());
            if (!rec || rec.pw !== pw) return json(res, 401, { err: '账号或密码不对' });
            const tk = newToken();
            ladTokens.set(tk, acc.toLowerCase());
            json(res, 200, Object.assign({ ok: true, token: tk }, accView(rec)));
        });
        return;
    }

    //--- 天梯：拿自己的信息（刷新页面后用令牌换回登录态）------------------
    if (u === '/api/lad/me' && req.method === 'POST') {
        readBody(req, body => {
            body = body || {};
            const rec = accOfToken(body.token);
            if (!rec) return json(res, 401, { err: '登录已失效，请重新认证' });
            json(res, 200, Object.assign({ ok: true }, accView(rec)));
        });
        return;
    }

    //--- 天梯：排行榜 ------------------------------------------------------
    // 不要求登录 —— 匹配中和没登录时都要能看榜（你定的：匹配时有东西可看）。
    // 带了令牌就多回一行「我」，没带就只有前 100。
    if (u === '/api/lad/board' && req.method === 'POST') {
        readBody(req, body => {
            body = body || {};
            const rec = body.token ? accOfToken(body.token) : null;
            json(res, 200, Object.assign({ ok: true }, ladBoardView(rec)));
        });
        return;
    }

    //--- 天梯：历史战绩 ----------------------------------------------------
    // 必须登录。返回最近 20 场天梯对局，新在上。
    // pending（对局未结束或快进模拟未到时间）只返回 startedAt + status，
    // 不带排名 / 分数 / overInfo —— 单人天梯不能泄露 AI 身份。
    if (u === '/api/lad/history' && req.method === 'POST') {
        readBody(req, body => {
            body = body || {};
            const rec = accOfToken(body.token);
            if (!rec) return json(res, 401, { err: '请先登录天梯账号' });
            const a = accounts.get(rec.acc.toLowerCase());
            if (!a) return json(res, 404, { err: '账号不存在' });
            const now = Date.now();
            const hist = (a.ladHistory || []).map(h => {
                if (!h.endedAt || now < (h.expectedEndAt || 0)) {
                    return { gameId: h.gameId, startedAt: h.startedAt,
                             status: 'pending' };
                }
                return {
                    gameId: h.gameId, startedAt: h.startedAt,
                    endedAt: h.endedAt, rank: h.rank, total: h.total,
                    delta: h.delta, score: h.score, tier: h.tier,
                    quit: h.quit, overInfo: h.overInfo,
                    vsLog: h.vsLog || null, status: 'done',
                };
            });
            json(res, 200, { ok: true, history: hist });
        });
        return;
    }

    //--- 天梯：开启排位 ----------------------------------------------------
    // **必须登录**（分要挂在账号上）而且必须已经起过天梯名 —— 榜上显示的是
    // 天梯名，没名字的人上不了榜，让他先去起名。
    //
    // 同一个账号只能有一个排位会话：重复点会拿回原来那个房间的 sid，
    // 而不是又开一桌（否则一个人能同时占好几桌，榜也会被自己刷）。
    if (u === '/api/lad/match' && req.method === 'POST') {
        readBody(req, body => {
            body = body || {};
            const rec = accOfToken(body.token);
            if (!rec) return json(res, 401, { err: '请先登录天梯账号' });
            if (!rec.name) return json(res, 400, { err: '请先设置天梯游戏名' });
            const key = rec.acc.toLowerCase();

            // 已经在某个天梯房里了 -> 回原来那个（刷新页面 / 重复点）
            for (const r of rooms.values()) {
                if (r.mode !== 'ladder') continue;
                const mine = r.seats.find(s => s && !s.left && s.ladAcc === key);
                if (mine) {
                    return json(res, 200, {
                        room: r.code, sid: mine.sid, mySeat: mine.index,
                        mode: 'ladder', again: true,
                    });
                }
            }

            let room = findLadderRoom();
            const fresh = !room;
            if (!room) room = newRoom('ladder');
            const seat = addSeat(room, rec.name);
            if (!seat) {
                if (fresh) dropRoom(room, '天梯房建好却坐不下人');
                return json(res, 409, { err: '匹配失败，再点一次' });
            }
            // 结算要靠这个找账号。存小写 key 而不是对象引用 ——
            // accounts 里的记录可能被 accLoad 换成新对象。
            seat.ladAcc = key;
            seat.ladResult = null;
            // 新房才起假计数；进已有的房是搭别人的车（你定的：同窗口的真人同桌）
            if (fresh) ladStartFill(room);
            else pushRoom(room);
            log('天梯匹配 %s 进房 %s（%s）', rec.name, room.code,
                fresh ? '新开' : '搭车');
            json(res, 200, {
                room: room.code, sid: seat.sid, mySeat: seat.index,
                mode: 'ladder',
            });
        });
        return;
    }

    //--- 天梯：设置 / 修改游戏名 -------------------------------------------
    // 首次设置不算用掉当天那一次（注册完就要起名，起完发现打错字当天就锁死
    // 太糙）。之后每天一次，记在服务器的账号上 —— 记浏览器的话清一下
    // localStorage 就能无限改。翻篇点复用 dayKey()，和本日计数同一套
    // （北京时间 00:00）。
    if (u === '/api/lad/name' && req.method === 'POST') {
        readBody(req, body => {
            body = body || {};
            const rec = accOfToken(body.token);
            if (!rec) return json(res, 401, { err: '登录已失效，请重新认证' });
            const nm = chkLadName(body.name);
            if (!nm) return json(res, 400, { err: '名字是 4-8 位汉字、字母或数字' });
            const today = dayKey();
            const first = !rec.name;
            if (!first && rec.renamedDay === today) {
                return json(res, 429, Object.assign(
                    { err: '每天只能修改一次' }, accView(rec)));
            }
            // 改成和现在一样的名字：直接当成功返回，别把当天那一次用掉
            if (rec.name === nm) {
                return json(res, 200, Object.assign({ ok: true }, accView(rec)));
            }
            const lower = nm.toLowerCase();
            const owner = ladNames.get(lower);
            // 唯一性按小写比 —— 榜上同时有 Derek 和 derek 是分不清谁是谁的
            if (owner && owner !== rec.acc.toLowerCase()) {
                return json(res, 409, Object.assign(
                    { err: '这个名字有人用了' }, accView(rec)));
            }
            if (rec.name) ladNames.delete(rec.name.toLowerCase());
            rec.name = nm;
            ladNames.set(lower, rec.acc.toLowerCase());
            // 首次设置不写 renamedDay，所以当天还能再改一次
            if (!first) rec.renamedDay = today;
            accSave();
            json(res, 200, Object.assign({ ok: true, first: first }, accView(rec)));
        });
        return;
    }

    //--- 在线人数（兼心跳）-------------------------------------------------
    // 大厅页每 5 秒打一次。故意不更新 room.touched —— 那是「房间有人在用」的
    // 判据，被一个只是站在菜单上的旁观者刷新的话，空房间永远等不到清理。
    if (u === '/api/stats' && req.method === 'POST') {
        readBody(req, body => {
            body = body || {};
            // 令牌只用来去重，不做身份用途，所以限个长度就够。
            // 客户端发的一律不可信，别直接拿去当 Map 的键。
            const token = String(body.token == null ? '' : body.token)
                .replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
            // sid 要验过才认，否则随便编一个就能把自己从统计里抹掉
            const found = body.sid ? seatOf(body.sid) : null;
            touchVisitor(token, found ? body.sid : null);
            // 【心跳和数字要分开】门禁只挡数字，上面的 touchVisitor 一定要跑 ——
            // 这个请求同时是「我还在线」的心跳，非 GM 也得数进在线人数里，
            // 不然 GM 看到的在线数会漏掉所有没登录 GM 的人。
            //
            // 非 GM 回 {gm:false} 不带任何数字（你定的）。客户端拿不到 online
            // 就整块不画那两行。
            if (!isGmToken(body.ladToken)) return json(res, 200, { gm: false });
            json(res, 200, Object.assign({ gm: true }, computeStats()));
        });
        return;
    }

    //--- 本日计数（标题画面上方四行）--------------------------------------
    // 不带 bump 就是纯读；带了就加一次再返回新值。
    //
    // 【只接受单机那三项】play / finish / champ 服务器看不见单机局，只能客户端报。
    // online 由服务器在开赛时自己加（startTourney / startDuel）——
    // 这里**故意不收** online，否则谁都能拿脚本把联机人数刷上去。
    //
    // 【读要 GM，写不要】(2026-08-07 你定的：这四行只有 GM 看得见)
    //   · 计数照旧对所有人开放上报 —— 挡了的话数字就不长了，GM 自己也看不到
    //     全服的真实活跃。
    //   · 但返回的数字只给 GM。非 GM 回 {ok:true, gm:false} 不带数字，
    //     客户端 dailyFetch 拿不到 plays 就整块不画。
    if (u === '/api/daily' && req.method === 'POST') {
        readBody(req, body => {
            body = body || {};
            const bump = String(body.bump == null ? '' : body.bump);
            const gm = isGmToken(body.ladToken);
            if (bump) {
                if (bump !== 'play' && bump !== 'finish' && bump !== 'champ') {
                    return json(res, 200, Object.assign({ ok: false, err: '未知计数' },
                        gm ? dailyView() : { gm: false }));
                }
                dailyBump(bump, body.n);
            }
            if (!gm) return json(res, 200, { ok: true, gm: false });
            json(res, 200, Object.assign({ ok: true, gm: true }, dailyView()));
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
            if (isTourneyLike(room)) {
                // 由座位查到自己那一桌 —— 绝不能拿 seat.index 当 side 用
                const bt = room.battles.find(x =>
                    !x.done && x.pIdx.indexOf(seat.pIdx) >= 0);
                if (!bt) return json(res, 200, { ok: false, err: '你本轮已经打完了' });
                const side = (bt.pIdx[0] === seat.pIdx) ? 0 : 1;
                return json(res, 200, applyActionT(room, bt, side, body.action || {}, false));
            }
            const r = applyAction(room, seat.index, body.action || {}, false);
            json(res, 200, r);
        });
        return;
    }

    // 这里原来是 /api/discard（客户端把手动挑好的牌发上来）。多人模式改成
    // 「超过 MAX_FUNC 当场随机弃」之后没有手动挑牌这一步，接口整个删了。
    // 客户端对应的 onDiscardConfirm 联机分支也删了，不会再有人调它。

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
            // 锦标赛：一个人退出不该毁掉整场赛事。标成离开、把他那桌推下去，
            // 剩下的人照常打；真人全走了才收房间。
            if (found && isTourneyLike(found.room) &&
                found.room.phase !== 'lobby') {
                const { room, seat } = found;
                // 【天梯：中途退出按末名结算】rankOf 是按存活者 HP 排的，
                // 领先时退出会显示第 1 名 —— 不挡的话「打得好就跑」是最优策略。
                // 断线重连回来的不算退出（那条路走 graceTimer，不到这里）。
                if (room.mode === 'ladder' && seat.ladAcc && !seat.ladResult) {
                    const total = room.game ? room.game.players.length : 8;
                    seat.ladResult = ladSettle(room, seat, total, total);
                    if (seat.ladResult) {
                        seat.ladResult.quit = true;
                        ladHistoryAdd(seat.ladAcc, room.code, room.tourneyStartAt,
                            total, total, seat.ladResult, true,
                            snapshotVsLog(room, seat.pIdx));
                        sendTo(seat, 'ladscore', seat.ladResult);
                    }
                }
                seat.left = true;
                log('房间 %s %s 主动退出%s', room.code, seat.name,
                    room.mode === 'ladder' ? '天梯（按末名结算）' : '锦标赛');
                withRoom(room, () => { returnFuncsOfLeft(room); });
                const bt = room.battles.find(x =>
                    !x.done && x.pIdx.indexOf(seat.pIdx) >= 0);
                if (bt && room.phase === 'battle' && bt.b &&
                    bt.b.turn === (bt.pIdx[0] === seat.pIdx ? 0 : 1)) {
                    forceStand(room, bt, '离开');
                } else if (bt && room.phase === 'battle') {
                    armTurnTimerT(room, bt);
                }
                if (!room.seats.some(s => s && !s.left && s.connected)) {
                    // 这个人自己已经在上面结算过了。但同房**另一个掉线还没
                    // 结算的人**会跟着房间一起被销毁 —— 他也得按末名算，
                    // 否则「等队友退出」又是一道免罚门。
                    ladSettleAllLeft(room, '房间随他人退出销毁');
                    // 天梯：快进模拟剩余 AI 轮次，算出最终排名再销毁。
                    // 先关 SSE —— enterOverT 会发 over（含完整排名表），
                    // 退出的玩家不该收到（单人天梯会泄露 AI 身份）。
                    if (room.mode === 'ladder' && room.game) {
                        room.seats.forEach(s => { if (s && s.sse) releaseSeatConn(room, s); });
                        fastForwardLad(room);
                    }
                    dropRoom(room, '赛事里所有真人都离开了');
                } else {
                    pushStateT(room);
                    checkRoundBarrier(room);
                }
                return json(res, 200, { ok: true });
            }
            // 锦标赛 / 天梯大厅：只摘他的席位，房间留给还在等的人。
            // 走 dropRoom 会把一屋子人一起赶回菜单 —— 8 人赛永远凑不起来。
            if (found && isTourneyLike(found.room) &&
                found.room.phase === 'lobby') {
                const { room, seat } = found;
                removeSeat(room, seat);
                if (!room.seats.some(s => s)) {
                    dropRoom(room, '大厅里没人了');
                } else {
                    pushRoom(room);
                    if (room.mode === 'tourney') maybeStartTourney(room);
                }
                return json(res, 200, { ok: true });
            }
            if (found) {
                // 【赛事已结束就不通知对方】看完战绩点返回是正常收尾，不是
                // 「离开了房间」这种意外事件（你定的）。房间照旧收掉。
                if (found.room.phase === 'over') {
                    dropRoom(found.room, '结束后玩家返回');
                    return json(res, 200, { ok: true });
                }
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
            // 天梯房被当成「长时间无人」收掉时，里面可能还有没结算的人
            // （所有人都掉线、宽限期那条路又没走到）。一样按末名算。
            ladSettleAllLeft(room, '房间长时间无人');
            dropRoom(room, '长时间无人');
        }
    }
    // 没人来问人数时也得扫，否则关掉页面的访客会一直留在表里
    sweepVisitors();
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

dailyLoad();
accLoad();

// 给测试用：房间状态是模块内私有的，而 D678.Game 只在 withRoom 期间有效，
// 所以测试没法从外面拿到盘面去构造边界场景（比如把手牌补满逼出随机弃牌）。
// 只导出引用，不导出任何操作函数。daily 也导出，回归要断言计数。
// accounts / ladTokens 给天梯回归用（要能直接改 renamedDay 模拟翻篇）。
// 天梯计分的几个纯函数一起导出：赛季边界、段位线、Δ 公式、AI 漂移都要能
// 单独断言 —— 只能通过 HTTP 验的话，测「北京时间 9/1 00:00 翻篇」就得
// 改系统时钟。
module.exports = {
    rooms, CFG, withRoom, visitors, daily, accounts, ladTokens, accSave,
    ladSeason, ladTier, ladConv, ladAiState, ladBoard, ladBoardView,
    ladPersona, ladReplaySeason, ladFrac, ladK, ladBoardBust,
    ladAiPlayingCount, ladRealPlaying, aiNetRoll, aiNetOf, setAiNetForce, GM_ACC,
    LAD_BASE, LAD_FLOOR, LAD_SCALE, LAD_MINGAMES, LAD_BOARD_N, LAD_TIERS,
    LAD_LAUNCH, LAD_AI_GONE_P, LAD_AI_LEFT_P,
    // 思考池 / 回合计时那一套。_test_ladbank.js 全靠这些名字 ——
    // 少了任何一个它会以 `SRV.xxx is not a function` 整个挂掉（30 条断言
    // 一条都不跑），而挂掉的样子和「功能坏了」看起来一样。
    LAD_DELAY, LAD_DELAY_NOBANK, LAD_BANK_MS, LAD_BANK_TURN_MS,
    ladThinkMs, ladBankCost, ladBankLeft, ladBankSpend, ladBankTurnMs,
    ladAiPlan, armTurnTimerT, applyActionT, turnSecOf, goneSecOf,
};

server.listen(CFG.port, '0.0.0.0', () => {
    console.log('');
    console.log('  678 联机服务器已启动');
    console.log('  ─────────────────────────────────────────');
    console.log('  游戏目录  %s', CFG.dir);
    // 挂了持久卷没生效的话，这几行是唯一能当场看出来的地方
    const pr = probeDataDir();
    console.log('  数据目录  %s%s', CFG.dataDir,
        process.env.DATA_DIR ? '（DATA_DIR）' : '（默认，上线会被冲掉）');
    console.log('  可写      %s', pr.ok ? '是' : '！否（' + pr.why + '）—— 账号存不住');
    if (!process.env.DATA_DIR) {
        console.log('  ！没设 DATA_DIR，账号活不过下一次上线。挂了卷就把它指过去');
    }
    console.log('  账号文件  %s', pr.accFileBytes >= 0
        ? pr.accFileBytes + ' 字节 / ' + accounts.size + ' 个账号'
        : '还没有（第一次跑，或者卷是新的）');
    console.log('  起始 HP   %d', CFG.startHp);
    console.log('  回合超时  %s', CFG.turnSec ? CFG.turnSec + ' 秒' : '关闭');
    console.log('  在线判定  %d 秒无心跳算离线', CFG.visitorSec);
    console.log('');
    console.log('  本机      http://localhost:%d', CFG.port);
    lanIPs().forEach(ip => console.log('  局域网    http://%s:%d', ip, CFG.port));
    console.log('');
});
