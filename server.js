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

    // 掉线的人轮到他时用这个更短的时限（秒）。他不会来操作，让在线的那个人
    // 干等满 turnSec 没有意义 —— 而且 678core 里 standStreak>=2 才结算、
    // hit 会把它归零，所以在线方每要一张牌都要多买一个完整回合的等待。
    // 重连回来立刻恢复成 turnSec（见 armTurnTimer）。
    goneTurnSec: Number(argOf('--gone-turn-sec', 10)),
    // 二选一的选牌时限（秒）。实际窗口是 min(这个值, 回合剩余时间)。
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

// 每个房间的回合时限（秒）。锦标赛可以单独设，没设就沿用 turnSec。
function turnSecOf(room) {
    if (room.mode === 'tourney' && CFG.tourneyTurnSec) return CFG.tourneyTurnSec;
    return CFG.turnSec;
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
                            renamedDay: a.renamedDay });
        }
        const tmp = ACC_FILE + '.tmp';
        try {
            fs.writeFileSync(tmp, JSON.stringify(out), 'utf8');
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
        const rec = {
            acc: acc, pw: String(a.pw == null ? '' : a.pw), name: '',
            renamedDay: String(a.renamedDay || ''),
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

// 发给客户端的账号信息。**绝不带 pw** —— 明文存是一回事，顺着接口发回去
// 是另一回事（浏览器 devtools 里直接就能看到）。
function accView(a) {
    return {
        acc: a.acc,
        name: a.name || '',
        // 今天还能不能改名。还没起过名时是「首次设置」，不算改名，所以也是 true
        canRename: !a.name || a.renamedDay !== dayKey(),
    };
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
                            'tieCount', 'tieBonus', 'prevLosses'];

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
        return {
            name: p.name, hp: p.hp, alive: p.alive,
            wins: p.wins, losses: p.losses, maxPoint: p.maxPoint,
            funcUses: p.funcUses,
            funcs: (pIdx === mePIdx) ? p.funcs.slice(0) : null,
            funcCount: p.funcs.length,
            // 客户端要靠这两个还原 AI 行为（超哥按超哥打）
            isHuman: !!p.isHuman, isGod: !!p.isGod,
            // 排名列表的「胜/负」一栏（drawRankList -> lastText）。
            // prevLast 是上一轮的，那一轮全场都打完了，8 个人的都能发。
            // last 是本轮的，只发我这桌的两个人 —— 别人桌本轮打完没打完、
            // 谁赢了，在轮次屏障放开之前不该让我提前知道。
            prevLast: p.prevLast || null,
            last: (bt && bt.pIdx.indexOf(pIdx) >= 0) ? (p.last || null) : null,
            // 真人的连线状态。AI 一律不标注 —— 排名列表里看不出谁是 AI。
            status: st ? (st.left ? 'left' : (st.connected ? '' : 'gone')) : '',
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
    const seatN = (mode === 'tourney') ? TOURNEY_SEATS : 2;
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
    // 锦标赛一轮有多桌，每桌两个定时器 —— 漏掉的话房间销毁后
    // 回调还会对着已删除的房间跑 pushStateT
    (room.battles || []).forEach(bt => {
        clearTimeout(bt.turnTimer);
        clearTimeout(bt.aiTimer);
    });
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

// online  = 还连着的座位 + 没被座位数过的访客
// playing = 已经开打的房间里还连着的座位
// waiting = 建好了、还差一个人的房间数（至少有一个人真连着）
function computeStats() {
    sweepVisitors();

    const liveSids = new Set();
    let playing = 0, waiting = 0, seated = 0;

    for (const room of rooms.values()) {
        const live = room.seats.filter(s => s && !s.left && s.connected);
        live.forEach(s => liveSids.add(s.sid));
        seated += live.length;
        if (room.phase === 'lobby') {
            // 「等人」= 还没开始、还没坐满。原来写死了 < 2（1v1 两座），
            // 锦标赛是 8 座，得按房间自己的席数判。
            if (live.length > 0 && live.length < room.seats.length) waiting++;
        } else if (room.phase !== 'over') {
            // 打完的房间不销毁（结算面板还要看），但那些人已经不在对局中了 ——
            // 不排除会显示成「N 人对局中」而其实他们正在看排名
            playing += live.length;
        }
    }

    let loose = 0;
    for (const v of visitors.values()) {
        // sid 指向活座位的已经数过了；sid 失效（房间销毁了但页面还开着）
        // 的仍然算在线 —— 那个人确实还盯着屏幕
        if (v.sid && liveSids.has(v.sid)) continue;
        loose++;
    }

    return { online: seated + loose, playing: playing, waiting: waiting };
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
            needMore: room.mode === 'tourney' && room.phase === 'lobby' && taken < 2,
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
        sendTo(seat, 'state', Object.assign({
            seq: room.seq,
            mode: 'tourney',
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
            // 客户端据此停在轮次等待屏
            waitingRound: (!bt || btDone) && !v.bye && busy > 0,
            busyTables: busy,
            log: bt ? maskLogT(bt, meSide) : null,
            // 打完的桌 turnDeadline 是上一手留下的旧值，别让客户端拿它倒计时
            turnLeft: (bt && !btDone && bt.turnDeadline)
                ? Math.max(0, bt.turnDeadline - Date.now()) : 0,
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

    r.pairs.forEach(pair => {
        const [pa, pb] = pair;
        const ia = g.players.indexOf(pa), ib = g.players.indexOf(pb);
        const seatA = room.seats.find(s => s && !s.left && s.pIdx === ia);
        const seatB = room.seats.find(s => s && !s.left && s.pIdx === ib);

        // 两边都不是活人（AI，或者已经离开的人）-> 当场算完，没有等的理由。
        // 离开的人交给 simulateMatch 等于让 AI 替他打完这一场 —— 不行，
        // 他该是一路自动过牌。所以只有「双方都是 AI」才走这条快路。
        if (!seatA && !seatB && !pa.isHuman && !pb.isHuman) {
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
    if (isAI) return;

    // 挂机降速，和 1v1 的 armTurnTimer 同一套（详见那边的注释）：
    // 判据是「上个回合被自动判过牌」，不是「此刻掉线」——
    // 掉线那个回合仍然给满 tsec，烧完判过牌之后下一个回合才降到 10 秒。
    const short = !!(seat && seat.idled);
    const sec = short ? (CFG.goneTurnSec || tsec) : tsec;

    bt.turnDeadline = bt.turnStartAt + sec * 1000;

    // 二选一的待选：窗口 = min(pick2Sec, 回合剩余)，超时随机选。
    // 跟 1v1 的 armTurnTimer 同一套语义，详见那边的注释。
    if (bt.b.pending2) {
        const leftMs = bt.turnDeadline - now;
        const wait = Math.max(0, Math.min(CFG.pick2Sec * 1000, leftMs));
        bt.pick2Deadline = now + wait;
        bt.turnTimer = setTimeout(() => {
            if (!bt.b || bt.b.finished || bt.done || room.phase !== 'battle') return;
            if (!bt.b.pending2) return;              // 已经选过了
            const who = bt.b.pending2.side;
            log('房间 %s 第 %d 桌 pIdx=%d 二选一超时 -> 随机选',
                room.code, bt.id, bt.pIdx[who]);
            applyActionT(room, bt, who,
                { type: 'pick2', idx: Math.random() < 0.5 ? 0 : 1 }, true);
        }, wait);
        return;
    }
    bt.pick2Deadline = 0;

    bt.turnTimer = setTimeout(() => forceStand(room, bt, short ? '挂机' : '超时'),
        Math.max(0, bt.turnDeadline - now));
}

function forceStand(room, bt, why) {
    if (!bt.b || bt.b.finished || bt.done || room.phase !== 'battle') return;
    log('房间 %s 第 %d 桌 pIdx=%d %s -> 判过牌',
        room.code, bt.id, bt.pIdx[bt.b.turn], why);
    applyActionT(room, bt, bt.b.turn, { type: 'stand' }, true);
}

// 轮到 AI（或轮到已离开的人）就自己走。延迟一下让人看清对手做了什么。
function stepAIIfNeeded(room, bt) {
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

    bt.aiTimer = setTimeout(() => {
        if (!bt.b || bt.b.finished || bt.done || room.phase !== 'battle') return;
        const si = bt.b.turn;
        let ev = null;
        withRoom(room, () => { ev = D678.AI.step(bt.b, si); });
        if (ev && ev.msg) pushEventT(room, bt, si, ev.msg);

        if (bt.b.result && bt.b.result.tie) { resolveTable(room, bt, true); return; }
        if (bt.b.finished) { resolveTable(room, bt, false); return; }

        if (bt.b.turn !== si) { bt.turnStartAt = 0; bt.turnGoneDeadline = 0; }
        armTurnTimerT(room, bt);
        pushStateT(room);
        stepAIIfNeeded(room, bt);
    }, CFG.aiStepMs);
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
    const actorT = room.seats.find(s => s && s.pIdx === bt.pIdx[side]);
    if (actorT && !(forced && action.type === 'pick2')) actorT.idled = !!forced;

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
                repick = { uid: nc ? nc.uid : 0, oldValue: r.oldValue };
            }
        } else if (action.type === 'pick2') {
            // 二选一的选择。只有待选那一方能选，idx 只接受 0/1 ——
            // 客户端发来的一律不可信，越界或不是他的回合都拒掉。
            const rp = b.pick2Resolve(side, action.idx);
            if (!rp) { ok = false; err = '现在不能选牌'; return; }
            msg = '对方选了 1 张牌';
        } else {
            ok = false; err = '未知动作';
        }
    });

    if (!ok) return { ok: false, err: err };

    if (forced) msg = (msg || '') + '（超时）';
    pushEventT(room, bt, side, msg);

    if (b.result && b.result.tie) { resolveTable(room, bt, true); return { ok: true, fail: failNote }; }
    if (b.finished) { resolveTable(room, bt, false); return { ok: true, fail: failNote }; }

    if (b.turn !== turnBefore) { bt.turnStartAt = 0; bt.turnGoneDeadline = 0; }
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
        // 淘汰：血空的人踢回大厅，赛事继续（你定的）
        const outSeats = [];
        room.seats.forEach(s => {
            if (!s || s.left) return;
            const p = room.game.players[s.pIdx];
            if (p && !p.alive) outSeats.push(s);
        });
        outSeats.forEach(s => {
            const rank = rankOf(room, s.pIdx);
            sendTo(s, 'eliminated', Object.assign({
                rank: rank, total: room.game.players.length,
                name: room.game.players[s.pIdx].name,
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
        const humansLeft = room.seats.filter(s => s && !s.left && s.connected).length;
        if (aliveN <= 1 || humansLeft === 0) { enterOverT(room); return; }
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

// 名次：已淘汰的按 outAt 倒数，存活的按血量。和 rankedPlayers 同一套语义。
function rankOf(room, pIdx) {
    const ranked = room.game.rankedPlayers();
    const i = ranked.indexOf(room.game.players[pIdx]);
    return (i >= 0) ? i + 1 : room.game.players.length;
}

function enterOverT(room) {
    room.battles.forEach(bt => { clearTimeout(bt.turnTimer); clearTimeout(bt.aiTimer); });
    clearTimeout(room.roundTimer);
    room.phase = 'over';
    const ranked = room.game.rankedPlayers();
    room.overInfo = ranked.map((p, i) => {
        const pi = room.game.players.indexOf(p);
        const st = room.seats.find(s => s && s.pIdx === pi);
        return {
            rank: i + 1, name: p.name, hp: p.hp, alive: p.alive,
            wins: p.wins, losses: p.losses, maxPoint: p.maxPoint,
            games: p.wins + p.losses, funcUses: p.funcUses,
            // 和 maskViewT 里的 status 同一套取值。AI 一律空串 ——
            // 排名表里看不出谁是 AI（有座位才是真人）。
            status: st ? (st.left ? 'left' : (st.connected ? '' : 'gone')) : '',
        };
    });
    // 发给所有座位，包括已淘汰的（他们的 SSE 还连着）—— 淘汰的人回到大厅后
    // 靠这份数据弹一次最终排名，否则他永远不知道最后谁赢了（你定的）
    room.seats.forEach(seat => {
        if (!seat) return;
        const me = room.game.players[seat.pIdx];
        sendTo(seat, 'over', {
            mode: 'tourney',
            win: ranked[0] === me,
            myRank: ranked.indexOf(me) + 1,
            ranks: room.overInfo,
        });
    });
    log('房间 %s 锦标赛结束，冠军 %s', room.code, ranked[0] ? ranked[0].name : '?');
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

    // 【二选一的待选另起一个更短的时限】选牌窗口 = min(pick2Sec, 回合剩余)。
    // 你定的：回合只剩 3 秒时用这张牌，选牌也只有 3 秒；超时随机选，
    // 且因为「他有操作、只是慢了」不挂 idled（见 applyAction）。
    // 取 min 而不是另开一个完整窗口，是为了不让这张牌变成偷时间的手段。
    const p2 = room.battle.pending2;
    if (p2) {
        const left = room.turnDeadline - Date.now();
        const wait = Math.max(0, Math.min(CFG.pick2Sec * 1000, left));
        room.pick2Deadline = Date.now() + wait;
        room.turnTimer = setTimeout(() => {
            const b = room.battle;
            if (!b || b.finished || room.phase !== 'battle') return;
            if (!b.pending2) return;                 // 这期间已经选过了
            const who = b.pending2.side;
            log('房间 %s 座位 %d 二选一超时 -> 随机选（%d 秒）',
                room.code, who, Math.round(wait / 1000));
            applyAction(room, who, { type: 'pick2', idx: Math.random() < 0.5 ? 0 : 1 }, true);
        }, wait);
        return;
    }
    room.pick2Deadline = 0;

    room.turnTimer = setTimeout(() => {
        const b = room.battle;
        if (!b || b.finished || room.phase !== 'battle') return;
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
                repick = { uid: nc ? nc.uid : 0, oldValue: r.oldValue };
            }
        } else if (action.type === 'pick2') {
            // 二选一的选择。只有待选那一方能选，idx 只接受 0/1
            const rp = b.pick2Resolve(si, action.idx);
            if (!rp) { ok = false; err = '现在不能选牌'; return; }
            msg = '对方选了 1 张牌';
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
    if (room.mode === 'tourney' && room.phase === 'lobby') {
        seat.ready = false;
        pushRoom(room);
        clearTimeout(seat.graceTimer);
        seat.graceTimer = setTimeout(() => {
            if (seat.connected) return;      // 回来了
            removeSeat(room, seat);
            if (!room.seats.some(s => s)) {
                dropRoom(room, '大厅里没人了');
                return;
            }
            pushRoom(room);
            maybeStartTourney(room);
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
    if (room.mode !== 'tourney' && room.phase !== 'over') {
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
    if (room.mode === 'tourney') {
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
                dropRoom(room, '锦标赛里所有真人都离开了');
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
    if (room.mode !== 'tourney') {
        const other = room.seats.find(s => s && s !== seat);
        if (other) sendTo(other, 'peer', { gone: false, name: seat.name });
    }

    // 锦标赛：恢复他那桌的时限，补一份房间信息 + 盘面
    if (room.mode === 'tourney') {
        pushRoom(room);
        if (room.phase === 'over' && room.overInfo) {
            const me = room.game.players[seat.pIdx];
            const ranked = room.game.rankedPlayers();
            sendTo(seat, 'over', {
                mode: 'tourney', win: ranked[0] === me,
                myRank: ranked.indexOf(me) + 1, ranks: room.overInfo,
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
        if (room.mode !== 'tourney' && room.phase === 'lobby' &&
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
            const bt = (room.mode === 'tourney' && room.battles)
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
            const rec = { acc: acc, pw: pw, name: '', renamedDay: '' };
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
            json(res, 200, computeStats());
        });
        return;
    }

    //--- 本日计数（标题画面上方四行）--------------------------------------
    // 不带 bump 就是纯读；带了就加一次再返回新值。
    //
    // 【只接受单机那三项】play / finish / champ 服务器看不见单机局，只能客户端报。
    // online 由服务器在开赛时自己加（startTourney / startDuel）——
    // 这里**故意不收** online，否则谁都能拿脚本把联机人数刷上去。
    if (u === '/api/daily' && req.method === 'POST') {
        readBody(req, body => {
            body = body || {};
            const bump = String(body.bump == null ? '' : body.bump);
            if (bump) {
                if (bump !== 'play' && bump !== 'finish' && bump !== 'champ') {
                    return json(res, 200, Object.assign({ ok: false, err: '未知计数' },
                        dailyView()));
                }
                dailyBump(bump, body.n);
            }
            json(res, 200, Object.assign({ ok: true }, dailyView()));
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
            if (room.mode === 'tourney') {
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
            if (found && found.room.mode === 'tourney' &&
                found.room.phase !== 'lobby') {
                const { room, seat } = found;
                seat.left = true;
                log('房间 %s %s 主动退出锦标赛', room.code, seat.name);
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
                    dropRoom(room, '锦标赛里所有真人都离开了');
                } else {
                    pushStateT(room);
                    checkRoundBarrier(room);
                }
                return json(res, 200, { ok: true });
            }
            // 锦标赛大厅：只摘他的席位，房间留给还在等的人。
            // 走 dropRoom 会把一屋子人一起赶回菜单 —— 8 人赛永远凑不起来。
            if (found && found.room.mode === 'tourney' &&
                found.room.phase === 'lobby') {
                const { room, seat } = found;
                removeSeat(room, seat);
                if (!room.seats.some(s => s)) {
                    dropRoom(room, '大厅里没人了');
                } else {
                    pushRoom(room);
                    maybeStartTourney(room);   // 他一走可能正好凑成全员就绪
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
module.exports = { rooms, CFG, withRoom, visitors, daily, accounts, ladTokens };

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
