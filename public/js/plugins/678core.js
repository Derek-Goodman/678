//=============================================================================
// 678core.js
//=============================================================================
/*:
 * @plugindesc 678 规则层（无界面）。必须排在 678.js 之前加载。
 * @author DerekGoodman
 *
 * @help
 * ============================================================================
 * 这是什么
 * ============================================================================
 *  678 的纯规则代码：常量、功能牌数据、玩家、赛事、对局、AI。
 *  完全不碰界面，所以既能当 RMMV 插件用，也能被 Node 直接 require ——
 *  联机服务器就是靠这一点跑和客户端完全相同的规则，不存在两份实现走偏的问题。
 *
 *  界面（Scene_D678 / 新手教程 / 插件命令 start678）在 678.js 里。
 *  规则说明、素材要求那些文档也都在 678.js 的头部注释里。
 *
 * ============================================================================
 * 加载顺序
 * ============================================================================
 *  插件管理器里 678core 必须排在 678 之前，否则 678.js 会直接抛错。
 *  无参数。
 * ============================================================================
 */

var D678 = D678 || {};

(function () {
'use strict';

//=============================================================================
// 常量 / 数据
//=============================================================================

D678.START_HP   = 100;
D678.MAX_FUNC   = 6;
D678.CARD_W     = 720;
D678.CARD_H     = 1020;

// 我方暗牌的蒙版色调 [r, g, b, gray]，范围 -255~255。
// 负值压暗，数值越小蒙版越重；-72 大约是压暗 28%，牌面依然清楚可辨。
D678.HOLE_TONE  = [-72, -72, -72, 0];

// AI 名单：以后要加人，只在这个数组里加一行字符串即可。
// 超哥固定登场，其余从名单里随机抽 D678.AI_COUNT 位。
D678.AI_NAMES = [
    '超哥',
    '蒙奇D路痴', '撸本萎', '法国赌神', '大师兄', '嘎子哥', '武藤游戏','明明如意','我叫阿逼','山鸡不会飞','不知火爆','阿伟已经赢了','强如人机','里昂',
    '赌圣', '花开富贵', '亚瑟', '炉石玩家', '周树人', '周杰棍', '柯南', '承太郎', '哈基米', '城之内', '我爱斗地主', '贝克汉姆', '杰哥你很勇', '华强买瓜',
    '草莓姐姐', '潮汕浪趴兄', '最强大脑凯文', '十一', '图图', '我不会打牌', '神之一手', '圣诞老登', '哥只是传说', '奥本海默', '祥子不吃翔', '翠西'
];
D678.GOD_NAME = '超哥';   // 已知牌库顺序 + 所有底牌的AI，必定登场
D678.AI_COUNT = 6;        // 超哥之外随机登场的AI数量

// 本局登场的AI名单：超哥 + 随机 AI_COUNT 位，顺序打乱
D678.rollAINames = function () {
    var pool = [];
    for (var i = 0; i < D678.AI_NAMES.length; i++) {
        if (D678.AI_NAMES[i] !== D678.GOD_NAME) pool.push(D678.AI_NAMES[i]);
    }
    var picked = D678.shuffle(pool).slice(0, D678.AI_COUNT);
    picked.push(D678.GOD_NAME);
    return D678.shuffle(picked);
};

D678.FUNCS = [];
(function () {
    for (var i = 1; i <= 11; i++) {
        D678.FUNCS.push({
            id: 'pick' + i, img: 'pick' + i, name: '抽' + i + '号', kind: 'pick', num: i,
            desc: '从牌库中指定抽出 ' + i + ' 号牌（明牌）。\n若该牌已在场上则抽牌失败，不消耗回合\n（该牌仍会被消耗）。\n抽牌成功后本回合结束。'
        });
    }
    D678.FUNCS.push({ id: 'swap', img: 'swap', name: '互换明牌', kind: 'swap',
        desc: '将双方最新的一张明牌互相交换。\n不消耗回合，但对方之前的过牌作废。' });
    D678.FUNCS.push({ id: 'return', img: 'return', name: '退回明牌', kind: 'return',
        desc: '将自己最新的一张明牌退回牌库底部\n（本局最后才会被抽到）。\n不消耗回合，但对方之前的过牌作废。' });
    D678.FUNCS.push({ id: 'rob', img: 'rob', name: '强夺', kind: 'rob',
        desc: '夺取对方最新的一张明牌放到自己场上。\n不消耗回合，但对方之前的过牌作废。' });
    D678.FUNCS.push({ id: 'pickback', img: 'pickback', name: '抽底牌', kind: 'pickback',
        desc: '进行一次普通抽牌，但该牌以背面放置，\n对方无法看到（自己可见）。\n抽牌后本回合结束。' });
    D678.FUNCS.push({ id: 'rule18', img: 'rule18', name: '规则18', kind: 'rule',
        desc: '规则变为 18 点，超过 18 点即爆牌。\n规则牌互相覆盖，场上只存在一张。\n不消耗回合，但对方之前的过牌作废。' });
    D678.FUNCS.push({ id: 'rule24', img: 'rule24', name: '规则24', kind: 'rule',
        desc: '规则变为 24 点，超过 24 点即爆牌。\n规则牌互相覆盖，场上只存在一张。\n不消耗回合，但对方之前的过牌作废。' });
    D678.FUNCS.push({ id: 'rule+1', img: 'rule+1', name: '规则+1', kind: 'rule',
        desc: '场上所有牌（含底牌与之后抽到的牌）点数 +1，\n目标点数仍为 21。\n规则牌互相覆盖，场上只存在一张。\n不消耗回合，但对方之前的过牌作废。' });
    D678.FUNCS.push({ id: 'rule-1', img: 'rule-1', name: '规则-1', kind: 'rule',
        desc: '场上所有牌（含底牌与之后抽到的牌）点数 -1，\n目标点数仍为 21。\n规则牌互相覆盖，场上只存在一张。\n不消耗回合，但对方之前的过牌作废。' });
    D678.FUNCS.push({ id: 'rule>21', img: 'rule21', name: '规则大21', kind: 'rule',
        desc: '低于 21 点视为爆牌，21 点为满点，\n高于 21 点为有效点数，双方都超过时以接近 21 者获胜。\n规则牌互相覆盖，场上只存在一张。\n不消耗回合，但对方之前的过牌作废。' });
    D678.FUNCS.push({ id: 'check', img: 'check', name: '查看牌库', kind: 'check',
        desc: '查看牌库顶部 4 张牌（不足则显示剩余）。\n结果会常驻显示，只有自己可见。\n不消耗回合，但对方之前的过牌作废。' });
    D678.FUNCS.push({ id: 'repick', img: 'repick', name: '重抽', kind: 'repick',
        desc: '将自己最新的一张明牌洗进牌库，然后重抽一张（明牌）。\n因为洗回去了，有可能重新抽到同一个数字。\n抽牌后本回合结束。' });
    D678.FUNCS.push({ id: 'reback', img: 'reback', name: '干扰', kind: 'reback',
        desc: '强制替换对方的第一张底牌，\n换上来的数字一定不是原来那张。\n换下的牌洗回牌库。\n不消耗回合，但对方之前的过牌作废。' });
    D678.FUNCS.push({ id: 'picksmall', img: 'picksmall', name: '抽小', kind: 'picksmall',
        desc: '抽出目前牌库中最小的那张数字牌（明牌）。\n抽牌后本回合结束。' });
})();

D678.funcData = function (id) {
    for (var i = 0; i < D678.FUNCS.length; i++) {
        if (D678.FUNCS[i].id === id) return D678.FUNCS[i];
    }
    return null;
};
D678.funcName = function (id) { var f = D678.funcData(id); return f ? f.name : id; };
D678.ALL_FUNC_IDS = function () {
    return D678.FUNCS.map(function (f) { return f.id; });
};

//=============================================================================
// 工具
//=============================================================================

D678.shuffle = function (arr) {
    for (var i = arr.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
};
D678.rndPick = function (arr) { return arr[Math.floor(Math.random() * arr.length)]; };
// 名次用的中文数字：1~20 够用，超出直接回退到阿拉伯数字
D678.CN_NUM = ['零','一','二','三','四','五','六','七','八','九','十'];
D678.numCN = function (n) {
    if (n <= 10) return D678.CN_NUM[n];
    if (n < 20) return '十' + D678.CN_NUM[n - 10];
    if (n === 20) return '二十';
    return String(n);
};
D678.copy = function (arr) { return arr.slice(0); };
D678.remove = function (arr, v) {
    var i = arr.indexOf(v);
    if (i >= 0) { arr.splice(i, 1); return true; }
    return false;
};

//=============================================================================
// 玩家
//=============================================================================

function D678_Player(id, name, isHuman) {
    this.id       = id;
    this.name     = name;
    this.isHuman  = !!isHuman;
    this.hp       = D678.START_HP;
    this.alive    = true;
    this.prevLast = null;   // 上一轮的胜负（对战途中查看排名时展示）
    this.wins     = 0;
    this.losses   = 0;
    this.maxPoint = 0;      // 满点次数
    this.funcs    = [];     // 手上的功能牌 id
    // 打出去的功能牌不会立刻原地摸回来：本局用掉的记在 usedThis，
    // 结算发牌前轮转到 usedLast，发牌时从候选里排除，发完即清空。
    // 牌本身照旧回公共池给别人摸，只是自己隔一次发牌才可能再拿到。
    this.usedThis = [];     // 本局已打出的功能牌 id
    this.usedLast = [];     // 上一局打出的功能牌 id（本次发牌禁止摸到）
    this.funcUses = 0;      // 整场赛事累计打出的功能牌次数（含失败的指定抽牌）
    this.last     = null;   // {type:'win'|'lose'|'bye'|'tie', dmg:n, vs:name}
    this.outAt    = 0;      // 淘汰顺序（0=存活，1=第一个被淘汰）
    this.isGod    = (name === D678.GOD_NAME);
}
D678.Player = D678_Player;

D678_Player.prototype.hasFunc = function (id) { return this.funcs.indexOf(id) >= 0; };
// 场次只算真正打完的对局（平局会重新发牌、不计胜负，所以不进分母）
D678_Player.prototype.games = function () { return this.wins + this.losses; };
// 胜率 / 满点率，单位为百分比整数。没打过时返回 null，由界面显示成 '—'
D678_Player.prototype.winRate = function () {
    var g = this.games();
    return g > 0 ? Math.round(this.wins / g * 100) : null;
};
D678_Player.prototype.maxRate = function () {
    var g = this.games();
    return g > 0 ? Math.round(this.maxPoint / g * 100) : null;
};
D678_Player.prototype.rateText = function (v) {
    return (v === null || v === undefined) ? '—' : (v + '%');
};
// 界面上显示的 HP：伤害可能打穿 0，展示时一律截到 0，不露出负数
D678_Player.prototype.showHp = function () { return Math.max(0, this.hp); };
D678_Player.prototype.loseHp = function (n) {
    this.hp -= n;
    if (this.hp <= 0 && this.alive) {
        this.alive = false;
        // 记录淘汰顺序：越早淘汰名次越靠后（第一个被淘汰的固定第八名）
        if (D678.Game) this.outAt = ++D678.Game.outCount;
    }
};

//=============================================================================
// 全局赛事
//=============================================================================

D678.Game = null;

function D678_Game() {
    this.players = [];
    var names = D678.rollAINames();
    this.players.push(new D678_Player(0, '我', true));
    for (var i = 0; i < names.length; i++) {
        this.players.push(new D678_Player(i + 1, names[i], false));
    }
    this.pool      = D678.shuffle(D678.ALL_FUNC_IDS());  // 公共功能牌池
    this.pairedLog = {};   // "a-b" -> true 本轮循环内已交手
    this.round     = 0;
    this.outCount  = 0;    // 已淘汰人数，用于确定淘汰顺序
    this.finished  = false;
    this.result    = null; // 'win' | 'lose'
}
D678.GameClass = D678_Game;

D678_Game.prototype.human = function () { return this.players[0]; };
D678_Game.prototype.alivePlayers = function () {
    return this.players.filter(function (p) { return p.alive; });
};
// 存活者按 HP 从高到低；淘汰者按淘汰时间倒序（最早淘汰排最后一名）
D678_Game.prototype.rankedPlayers = function () {
    return this.players.slice(0).sort(function (a, b) {
        if (a.alive !== b.alive) return a.alive ? -1 : 1;
        if (a.alive) return b.hp - a.hp;
        return b.outAt - a.outAt;
    });
};

// 功能牌池操作 -------------------------------------------------------------
// 某张功能牌是否会被某人摸到。
// 超哥本来就知道牌库顺序，查看牌库对他是一张废牌 —— 不发给他，
// 让这张牌留在池子里给真正需要情报的人。
D678_Game.prototype.canDrawFunc = function (player, id) {
    if (!player) return true;
    if (player.isGod && id === 'check') return false;
    // 上一局自己打出去的牌，这次发牌不摸回来
    if (player.usedLast && player.usedLast.indexOf(id) >= 0) return false;
    return true;
};

D678_Game.prototype.drawFuncs = function (player, n) {
    var got = [];
    for (var i = 0; i < n; i++) {
        var cand = [];
        for (var k = 0; k < this.pool.length; k++) {
            if (!this.canDrawFunc(player, this.pool[k])) continue;
            if (!player.hasFunc(this.pool[k]) && got.indexOf(this.pool[k]) < 0) cand.push(this.pool[k]);
        }
        if (cand.length === 0) break;
        var id = D678.rndPick(cand);
        D678.remove(this.pool, id);
        player.funcs.push(id);
        got.push(id);
    }
    return got;
};
D678_Game.prototype.returnFunc = function (id) {
    if (id) this.pool.push(id);
};
D678_Game.prototype.returnAllFuncs = function (player) {
    while (player.funcs.length > 0) this.returnFunc(player.funcs.pop());
};

// 配对 ---------------------------------------------------------------------
D678_Game.prototype.pairKey = function (a, b) {
    return Math.min(a.id, b.id) + '-' + Math.max(a.id, b.id);
};
D678_Game.prototype.resetPairLog = function () { this.pairedLog = {}; };

D678_Game.prototype.makeRound = function () {
    var alive = this.alivePlayers();
    var best = null;
    for (var attempt = 0; attempt < 200; attempt++) {
        var pool = D678.shuffle(alive.slice(0));
        var pairs = [], bye = null, repeats = 0;
        if (pool.length % 2 === 1) bye = pool.pop();
        while (pool.length >= 2) {
            var a = pool.shift();
            var idx = -1;
            for (var i = 0; i < pool.length; i++) {
                if (!this.pairedLog[this.pairKey(a, pool[i])]) { idx = i; break; }
            }
            if (idx < 0) { idx = 0; repeats++; }
            var b = pool.splice(idx, 1)[0];
            pairs.push([a, b]);
        }
        if (!best || repeats < best.repeats) best = { pairs: pairs, bye: bye, repeats: repeats };
        if (repeats === 0) break;
    }
    if (best.repeats > 0) {   // 全部组合都打过了 -> 重新开始循环
        this.resetPairLog();
    }
    for (var j = 0; j < best.pairs.length; j++) {
        this.pairedLog[this.pairKey(best.pairs[j][0], best.pairs[j][1])] = true;
    }
    this.round++;
    return best;
};

//=============================================================================
// 对局 (一场 1v1 淘汰赛比赛，内部可能因平局多次重新发牌)
//=============================================================================

function D678_Battle(pA, pB, isSim) {
    this.game     = D678.Game;
    this.isSim    = !!isSim;
    this.players  = [pA, pB];
    this.finished = false;
    this.result   = null;   // {winner: side, loser: side, dmg: n, ...}
    this.redeals  = 0;
    this.newDeal();
}
D678.Battle = D678_Battle;

D678_Battle.prototype.newDeal = function () {
    var self = this;
    this.deck = D678.shuffle([1,2,3,4,5,6,7,8,9,10,11]);
    this.rule = null;
    this.standStreak = 0;
    this.result = null;
    this.pendingRedeal = false;
    this.pendingDeal = [];
    this.sides = this.players.map(function (p, i) {
        return {
            p: p, index: i,
            cards: [],          // {v:数值, hidden:是否背面}
            stood: false,
            checkN: 0,          // 查看牌库剩余可见张数
            known: []           // AI 推理出的“对方底牌一定是X”
        };
    });
    // 发牌: 每人 1 底牌 + 1 明牌
    for (var i = 0; i < 2; i++) {
        this.sides[i].cards.push({ v: this.deck.shift(), hidden: true });
    }
    for (var j = 0; j < 2; j++) {
        this.sides[j].cards.push({ v: this.deck.shift(), hidden: false });
    }
    // 明牌小的先手
    var u0 = this.sides[0].cards[1].v, u1 = this.sides[1].cards[1].v;
    this.turn = (u0 <= u1) ? 0 : 1;
    this.revealed = false;

    // 对战日志：结算画面展示双方每一步动作（模拟对局不记录，logAct 自己会跳过）
    this.log = [];
    this.logAct(this.turn,     '先手');
    this.logAct(1 - this.turn, '后手');
};

//--- 对战日志 --------------------------------------------------------------

// 某方当前的牌面串，例如 "1+3" / "1+3+7"
D678_Battle.prototype.handStr = function (si) {
    var c = this.sides[si].cards, p = [];
    for (var i = 0; i < c.length; i++) p.push(c[i].v);
    return p.join('+');
};

// 记一条日志：谁、做了什么、动作后他的牌面
D678_Battle.prototype.logAct = function (si, what) {
    if (this.isSim || !this.log) return;
    this.log.push({
        name: this.players[si].name,
        side: si,
        what: what,
        hand: this.handStr(si)
    });
};

//--- 基本计算 --------------------------------------------------------------

D678_Battle.prototype.mod = function () {
    if (this.rule === 'rule+1') return 1;
    if (this.rule === 'rule-1') return -1;
    return 0;
};
D678_Battle.prototype.adj = function (v) { return v + this.mod(); };
D678_Battle.prototype.target = function () {
    if (this.rule === 'rule18') return 18;
    if (this.rule === 'rule24') return 24;
    return 21;
};
D678_Battle.prototype.isOver21Rule = function () { return this.rule === 'rule>21'; };

D678_Battle.prototype.rawSum = function (si, onlyUp) {
    var s = 0, c = this.sides[si].cards;
    for (var i = 0; i < c.length; i++) {
        if (onlyUp && c[i].hidden) continue;
        s += c[i].v;
    }
    return s;
};
D678_Battle.prototype.countCards = function (si, onlyUp) {
    var n = 0, c = this.sides[si].cards;
    for (var i = 0; i < c.length; i++) { if (!(onlyUp && c[i].hidden)) n++; }
    return n;
};
// 总点数（含修正）
D678_Battle.prototype.total = function (si) {
    return this.rawSum(si, false) + this.mod() * this.countCards(si, false);
};
// 明牌点数（含修正）
D678_Battle.prototype.upTotal = function (si) {
    return this.rawSum(si, true) + this.mod() * this.countCards(si, true);
};
D678_Battle.prototype.isBustVal = function (t) {
    if (this.isOver21Rule()) return t < 21;
    return t > this.target();
};
D678_Battle.prototype.distVal = function (t) {
    return Math.abs(t - this.target());
};
D678_Battle.prototype.isMaxVal = function (t) {
    return !this.isBustVal(t) && t === this.target();
};

// 是否可以要牌（明牌合计 >= 21 不可要牌）
D678_Battle.prototype.canHit = function (si) {
    if (this.deck.length === 0) return false;
    return this.upTotal(si) < 21;
};

//--- 牌面操作 --------------------------------------------------------------

D678_Battle.prototype.newestUp = function (si) {
    var c = this.sides[si].cards;
    for (var i = c.length - 1; i >= 0; i--) { if (!c[i].hidden) return c[i]; }
    return null;
};
D678_Battle.prototype.onField = function (v) {
    for (var s = 0; s < 2; s++) {
        var c = this.sides[s].cards;
        for (var i = 0; i < c.length; i++) { if (c[i].v === v) return true; }
    }
    return false;
};
D678_Battle.prototype.consumeCheck = function () {
    for (var s = 0; s < 2; s++) {
        if (this.sides[s].checkN > 0) this.sides[s].checkN--;
    }
};
D678_Battle.prototype.doDraw = function (si, hidden) {
    if (this.deck.length === 0) return null;
    var v = this.deck.shift();
    this.consumeCheck();
    this.sides[si].cards.push({ v: v, hidden: !!hidden });
    return v;
};
D678_Battle.prototype.doPick = function (si, num, hidden) {
    var idx = this.deck.indexOf(num);
    if (idx < 0) return null;
    this.deck.splice(idx, 1);
    this.consumeCheck();
    this.sides[si].cards.push({ v: num, hidden: !!hidden });
    return num;
};
// 牌库里当前最小的数值（空库返回 null）
D678_Battle.prototype.deckMin = function () {
    if (this.deck.length === 0) return null;
    var m = this.deck[0];
    for (var i = 1; i < this.deck.length; i++) { if (this.deck[i] < m) m = this.deck[i]; }
    return m;
};
// 把一张牌洗回牌库：插到随机位置。
// 不整体重排是刻意的 —— 超哥的设定是知道牌库顺序，他直接读 b.deck，
// 插牌后重新读一遍仍然成立；而「可能重新抽到同一张」只取决于插入位置，
// 随机插入已经能给出 1/(n+1) 的概率，不需要再洗一遍。
D678_Battle.prototype.shuffleInto = function (v) {
    var pos = Math.floor(Math.random() * (this.deck.length + 1));
    this.deck.splice(pos, 0, v);
    return pos;
};
// 对手的第一张底牌（找第一张背面牌；newestUp 只碰明牌，所以它始终是开局那张）
D678_Battle.prototype.firstHole = function (si) {
    var c = this.sides[si].cards;
    for (var i = 0; i < c.length; i++) { if (c[i].hidden) return c[i]; }
    return null;
};

//--- 回合 ------------------------------------------------------------------

D678_Battle.prototype.endTurn = function () {
    this.turn = 1 - this.turn;
    if (this.standStreak >= 2) { this.doResolve(); return; }
    if (this.deck.length === 0 && !this.canHit(this.turn) && this.sides[this.turn].stood) {
        this.doResolve();
    }
};

// action: 'hit' | 'stand'
D678_Battle.prototype.act = function (si, action) {
    var ev = { side: si, action: action, msg: '' };
    if (action === 'hit') {
        if (!this.canHit(si)) { ev.fail = true; return ev; }
        var v = this.doDraw(si, false);
        ev.value = v;
        ev.msg = '对方抽牌';
        this.logAct(si, '抽牌获得了 ' + v);
        this.standStreak = 0;
        this.sides[si].stood = false;
        this.endTurn();
    } else {
        this.sides[si].stood = true;
        this.standStreak++;
        ev.msg = '对方过牌';
        this.logAct(si, '过牌');
        this.endTurn();
    }
    return ev;
};

//--- 功能牌 ----------------------------------------------------------------

// 返回 {ok, endTurn, msg, err}
D678_Battle.prototype.useFunc = function (si, id, simulate) {
    var f = D678.funcData(id);
    var side = this.sides[si], opp = this.sides[1 - si];
    var res = { ok: false, endTurn: false, msg: '', err: '', id: id };
    if (!f) return res;

    switch (f.kind) {
    case 'pick':
        if (this.deck.indexOf(f.num) < 0) {
            res.ok = true; res.fail = true; res.err = '此号牌已在场上';
            res.msg = '对方使用了' + f.name + '（失败）';
        } else {
            this.doPick(si, f.num, false);
            res.ok = true; res.endTurn = true;
            res.msg = '对方使用了' + f.name;
        }
        break;
    case 'pickback':
        if (this.deck.length === 0) { res.err = '牌库已空'; return res; }
        res.value = this.doDraw(si, true);
        res.ok = true; res.endTurn = true;
        res.msg = '对方使用了' + f.name;
        break;
    case 'swap':
        var a = this.newestUp(si), b = this.newestUp(1 - si);
        if (!a || !b) { res.err = b ? '我方场上没有明牌' : '对方场上没有明牌'; return res; }
        var t = a.v; a.v = b.v; b.v = t;
        res.ok = true; res.msg = '对方使用了' + f.name;
        break;
    case 'rob':
        var rb = this.newestUp(1 - si);
        if (!rb) { res.err = '对方场上没有明牌'; return res; }
        var pos = opp.cards.indexOf(rb);
        opp.cards.splice(pos, 1);
        side.cards.push({ v: rb.v, hidden: false });
        res.ok = true; res.msg = '对方使用了' + f.name;
        break;
    case 'return':
        var rt = this.newestUp(si);
        if (!rt) { res.err = '我方场上没有明牌'; return res; }
        var p2 = side.cards.indexOf(rt);
        side.cards.splice(p2, 1);
        this.deck.push(rt.v);
        res.ok = true; res.msg = '对方使用了' + f.name;
        break;
    case 'rule':
        this.rule = id;
        res.ok = true; res.msg = '对方使用了' + f.name;
        break;
    case 'check':
        side.checkN = Math.min(4, this.deck.length);
        res.ok = true; res.msg = '对方使用了' + f.name;
        break;
    case 'repick':
        // 自己最新的明牌洗回牌库，然后重抽一张。
        // 因为是洗回去再抽，有可能抽到刚洗进去的那一张（同一个数字）。
        var rp = this.newestUp(si);
        if (!rp) { res.err = '我方场上没有明牌'; return res; }
        var rpPos = side.cards.indexOf(rp);
        side.cards.splice(rpPos, 1);
        this.shuffleInto(rp.v);
        res.oldValue = rp.v;
        res.value = this.doDraw(si, false);
        res.same = (res.value === rp.v);
        res.ok = true; res.endTurn = true;
        res.msg = '对方使用了' + f.name;
        break;
    case 'reback':
        // 强制替换对方第一张底牌。换上来的一定不是原来那张：
        // 新牌从牌库里取，而牌库里不可能有场上已经存在的那个数字。
        var hole = this.firstHole(1 - si);
        if (!hole) { res.err = '对方没有底牌'; return res; }
        if (this.deck.length === 0) { res.err = '牌库已空'; return res; }
        var pickIdx = Math.floor(Math.random() * this.deck.length);
        var newV = this.deck.splice(pickIdx, 1)[0];
        res.oldValue = hole.v;
        hole.v = newV;
        res.value = newV;
        this.shuffleInto(res.oldValue);      // 换下来的牌洗回牌库
        this.consumeCheck();                 // 牌库被动过，查看牌库的情报作废一层
        // known 是有方向的：side.known 记的是「我推理出对方底牌有X」。
        // 换掉的是对方的底牌，所以只更新 side.known（换下的作废、换上的我亲手放的必然知道）。
        // opp.known 记的是对方对**我**底牌的推理，我方底牌没动，不能清。
        D678.remove(side.known, res.oldValue);
        if (side.known.indexOf(newV) < 0) side.known.push(newV);
        res.ok = true; res.msg = '对方使用了' + f.name;
        break;
    case 'picksmall':
        if (this.deck.length === 0) { res.err = '牌库已空'; return res; }
        var mn = this.deckMin();
        this.doPick(si, mn, false);
        res.value = mn;
        res.ok = true; res.endTurn = true;
        res.msg = '对方使用了' + f.name;
        break;
    }

    if (res.ok) {
        // 日志：使用了什么牌、结果如何
        var what = '使用了' + f.name;
        if (res.fail)                     what += '（失败：该号牌已在场上）';
        else if (f.kind === 'pick')       what += '，抽出了 ' + f.num;
        else if (f.kind === 'pickback')   what += '，暗抽了 1 张';
        else if (f.kind === 'swap')       what += '，双方最新明牌互换';
        else if (f.kind === 'rob')        what += '，夺走对方明牌';
        else if (f.kind === 'return')     what += '，明牌退回牌库底';
        else if (f.kind === 'rule')       what += '，规则变为' + f.name;
        else if (f.kind === 'check')      what += '，看了牌库顶 ' + side.checkN + ' 张';
        else if (f.kind === 'repick')     what += '，洗掉 ' + res.oldValue + ' 重抽到 ' +
                                                  res.value + (res.same ? '（又是同一张）' : '');
        else if (f.kind === 'reback')     what += '，替换了对方底牌';
        else if (f.kind === 'picksmall')  what += '，抽出了最小的 ' + res.value;
        this.logAct(si, what);

        D678.remove(side.p.funcs, id);
        if (!simulate) {
            this.game.returnFunc(id);
            // 记下本局用过的牌，结算发牌时避开（推演用的克隆盘面没有这个数组）
            if (Array.isArray(side.p.usedThis) && side.p.usedThis.indexOf(id) < 0) {
                side.p.usedThis.push(id);
            }
            // 整场赛事累计的功能牌使用次数（排名 / 淘汰画面要展示）
            if (typeof side.p.funcUses === 'number') side.p.funcUses++;
        }
        if (!res.fail) {
            // 使用功能牌后，对方之前的过牌一律作废：
            // 回合仍在自己手上，但对方必须重新获得一次行动机会，
            // 因此不可能出现“对方过牌 -> 我方用功能牌 -> 我方过牌 -> 直接结算”。
            this.standStreak = 0;
            side.stood = false;
            opp.stood = false;
        }
        // 只有抽牌类（指定抽牌成功 / 抽底牌）才结束回合
        if (res.endTurn) this.endTurn();
    }
    return res;
};

//--- 结算 ------------------------------------------------------------------

D678_Battle.prototype.doResolve = function () {
    this.revealed = true;
    var t0 = this.total(0), t1 = this.total(1);
    var b0 = this.isBustVal(t0), b1 = this.isBustVal(t1);
    var d0 = this.distVal(t0), d1 = this.distVal(t1);
    var m0 = this.isMaxVal(t0), m1 = this.isMaxVal(t1);
    var win = -1;

    // 双方同时爆牌 -> 平局重新发牌（不再比谁更接近目标点数）
    if (b0 && b1) win = -1;
    else if (b0 !== b1) win = b0 ? 1 : 0;
    else if (d0 !== d1) win = (d0 < d1) ? 0 : 1;
    else win = -1;      // 同点平局

    var info = {
        totals: [t0, t1], busts: [b0, b1], maxes: [m0, m1],
        winner: win, tie: (win < 0), dmg: 0, target: this.target()
    };

    if (win < 0) {
        info.tie = true;
        // 这是本次拼点的第几次平局。redeals 是「已经重发过几次」，
        // 此刻还没为这次平局自增（自增发生在 newDeal 之前），所以 +1。
        // 拼点画面显示「平局✖N」用这个，客户端不用自己去推该不该加一。
        info.tieCount = (this.redeals || 0) + 1;
        this.result = info;
        this.pendingRedeal = true;
        return info;
    }

    var lose = 1 - win;
    var W = this.players[win], L = this.players[lose];

    if (m0) W === this.players[0] ? null : null;
    if (m0) this.players[0].maxPoint++;
    if (m1) this.players[1].maxPoint++;

    // 伤害 = 1（底伤） + 本次拼点的平局次数 + 累计败场数（不因胜利重置）
    //        + 败方爆牌 1 + 胜方满点 1
    // 例：此前已败 5 次，本局平过 2 次、对方满点、自己爆牌
    //     -> 1 + 2 + 5 + 1 + 1 = 10
    //
    // 【平局加伤】每平一次，这一场的底伤 +1（你定的）：干净一局输是 -1，
    // 平过一次再输就是 -2，以此类推。redeals 是本次拼点已经重发过几次，
    // 也就是已经平了几次 —— 新 Battle 会归零，所以惩罚只在这一场里累积。
    // 单机、1v1、锦标赛共用这一份规则，AI 的估值（AI.resolveUtil）也跟着加。
    var items = 1;
    if (info.busts[lose]) items++;
    if (info.maxes[win]) items++;
    var tieBonus = this.redeals || 0;
    var dmg = items + L.losses + tieBonus;
    info.dmg = dmg;
    info.items = items;
    info.tieBonus = tieBonus;
    // 分出胜负这一帧也要显示平局次数（解释伤害是怎么来的）。
    // 平局那一帧走上面的分支，两边都叫 tieCount，客户端一视同仁。
    info.tieCount = tieBonus;
    info.prevLosses = L.losses;

    W.wins++;
    L.losses++;
    L.loseHp(dmg);
    W.last = { type: 'win',  dmg: 0,   vs: L.name };
    L.last = { type: 'lose', dmg: dmg, vs: W.name };

    info.winnerP = W; info.loserP = L;
    this.result = info;
    this.finished = true;
    return info;
};

// 结算后发放功能牌（胜1败2），返回需要弃牌的玩家列表
D678_Battle.prototype.grantFuncs = function () {
    var r = this.result, out = [];
    if (!r || r.tie) return out;
    // 发牌前轮转：本局打出的牌成为“这次不许摸到”的名单，
    // 发完即清空，所以禁用只持续一次发牌，不会把牌永久锁死。
    //
    // 禁用名单取**双方的并集**：本局这场对战里被用掉的功能牌，
    // 交手的两个人这次发牌都摸不到（不再是各自只避开自己打出的那几张）。
    // 牌本身照旧回公共池给别人摸，只是这两位隔一次发牌才可能再拿到。
    var banned = [];
    [r.winnerP, r.loserP].forEach(function (p) {
        (p.usedThis || []).forEach(function (id) {
            if (banned.indexOf(id) < 0) banned.push(id);
        });
    });
    [r.winnerP, r.loserP].forEach(function (p) {
        p.usedLast = banned;
        p.usedThis = [];
    });
    this.game.drawFuncs(r.winnerP, 1);
    this.game.drawFuncs(r.loserP, 2);
    [r.winnerP, r.loserP].forEach(function (p) { p.usedLast = []; });
    [r.winnerP, r.loserP].forEach(function (p) {
        if (p.alive && p.funcs.length > D678.MAX_FUNC) out.push(p);
    });
    return out;
};

//--- 克隆（AI 推演用） -----------------------------------------------------

D678_Battle.prototype.clone = function () {
    var b = Object.create(D678_Battle.prototype);
    b.game = this.game;
    b.isSim = true;
    b.players = this.players;
    b.finished = this.finished;
    b.result = null;
    b.redeals = this.redeals;
    b.deck = this.deck.slice(0);
    b.rule = this.rule;
    b.standStreak = this.standStreak;
    b.turn = this.turn;
    b.revealed = this.revealed;
    b.sides = this.sides.map(function (s) {
        return {
            p: { funcs: s.p.funcs.slice(0), isGod: s.p.isGod, name: s.p.name,
                 hp: s.p.hp, losses: s.p.losses, isHuman: s.p.isHuman },
            index: s.index,
            cards: s.cards.map(function (c) { return { v: c.v, hidden: c.hidden }; }),
            stood: s.stood, checkN: s.checkN, known: s.known.slice(0)
        };
    });
    b.doResolve = function () { this.revealed = true; this.finished = true; };
    return b;
};

//=============================================================================
// AI 决策引擎（概率 + 功能牌组合枚举）
//=============================================================================

D678.AI = {};

// 我方视角看不到的牌（牌库 + 对方暗牌），超哥可看到全部
D678.AI.unseen = function (b, si) {
    var known = {}, i, c;
    var mine = b.sides[si].cards, opp = b.sides[1 - si].cards;
    var god  = !!b.sides[si].p.isGod;
    for (i = 0; i < mine.length; i++) known[mine[i].v] = true;
    for (i = 0; i < opp.length; i++) { if (god || !opp[i].hidden) known[opp[i].v] = true; }
    var kn = b.sides[si].known;
    for (i = 0; i < kn.length; i++) known[kn[i]] = true;
    var out = [];
    for (var v = 1; v <= 11; v++) { if (!known[v]) out.push(v); }
    return out;
};

// si 方是否确切知道牌库顶那张牌：超哥永远知道，其他人只在用过查看牌库时知道
D678.AI.knowsNext = function (b, si) {
    if (b.deck.length === 0) return false;
    return !!b.sides[si].p.isGod || b.sides[si].checkN > 0;
};

// 对方仍然未知的暗牌数量
D678.AI.oppHiddenUnknown = function (b, si) {
    if (b.sides[si].p.isGod) return 0;
    var opp = b.sides[1 - si].cards, n = 0;
    for (var i = 0; i < opp.length; i++) { if (opp[i].hidden) n++; }
    n -= b.sides[si].known.length;
    return Math.max(0, n);
};

//--- 估值常量（单位：HP） --------------------------------------------------
D678.AI.HP_KILL  = 32;    // 把对手打到淘汰的额外价值
D678.AI.HP_DIE   = 46;    // 自己被淘汰的额外代价
// 一张功能牌折算的 HP 价值（必须远小于最小伤害 1）。
//
// 曾经调低到 0.15 想让 AI 少囤牌 —— 出手率确实从 4% 升到 13.3%，
// 但实测强度反而下降（250 场赛事平均名次 4.74 vs 4.26，z≈3.3），所以调回。
// 原因是 simFunc 从不计算「打出去的牌会回到公共牌池、可能被对手摸走」这项成本，
// 也没算上 usedLast 冷却（自己下一次发牌摸不回来）。
// 门槛调低只是放行了更多被高估的出牌，并不是让 AI 变会用牌。
// 要真正用好功能牌，得改 simFunc 的估值本身（把入池成本和连出组合纳进去）。
D678.AI.FUNC_VAL = 0.35;

// 超哥的估值单位是“胜负”（赢=+1 / 输=-1 / 平=0），不是 HP。
// 一张功能牌只值 3% 个胜负，保证他永远不会为了留牌而放弃赢局。
D678.AI.GOD_FUNC_VAL = 0.03;

// 输也分好坏：爆牌输要多吃一份伤害（doResolve 里 items 多算 1），
// 所以在“反正都是输”的局面里，爆牌严格劣于点数不足。
// 这个惩罚只在必败线上起作用，小于 1 保证他不会为了躲爆牌而放弃任何平局或胜局。
D678.AI.GOD_BUST_PENALTY = 0.4;

// AI 强度档位：超哥知道牌库顺序，推演是单线的（不分叉），
// 所以可以把深度拉到 6 而开销仍然很小；阈值更低、且不加随机扰动。
//
// th 是功能牌的出手门槛（要比不出牌多赚这么多 HP 才出）。
// 曾经调到 0.25 想让 AI 更愿意出牌，实测变弱，已回退到 0.6 —— 详见 FUNC_VAL 的注释。
// 这个门槛除了「利润要求」还兼任一道防线：simFunc 的估值本身带偏差，
// 门槛高会把估值不可靠的出牌一并挡在外面。
// noise 实测影响很小（与无噪声最优解的分歧率仅 0.6%），因为它的幅度小于 th，
// 在功能牌选择上基本被门槛吃掉，要牌/停牌上两条路的差距通常也远大于它。
D678.AI.profile = function (p) {
    if (p && p.isGod) return { depth: 6, expand: 3, th: 0.15, noise: 0 };
    return { depth: 2, expand: 2, th: 0.6, noise: 0.45 };
};

// 若此刻结算，si 方的收益（HP 单位，含累计败场加伤 / 淘汰 / 功能牌补偿）
D678.AI.resolveUtil = function (b, si, mt, ot) {
    var bm = b.isBustVal(mt), bo = b.isBustVal(ot);
    var dm = b.distVal(mt),   doo = b.distVal(ot);
    var mm = b.isMaxVal(mt),  mo = b.isMaxVal(ot);
    var win;
    // 双方同时爆牌 -> 平局重新发牌，与 doResolve 保持一致
    if (bm && bo) win = 0;
    else if (bm !== bo) win = bm ? -1 : 1;
    else if (Math.abs(dm - doo) > 0.0001) win = (dm < doo) ? 1 : -1;
    else win = 0;
    // 超哥只看胜负：多扣对手生命值、把对手打死，对他没有额外价值。
    // 他唯一的目标是尽量靠近目标点数把这一局赢下来，
    // 所以绝不会为了多打一点伤害去赌对手爆牌而放弃稳赢的线路。
    // 唯一的例外是输法本身有优劣：自己爆牌要多吃一份伤害，
    // 所以“已知下一张必爆”时他宁可停牌认小输，也不会白爆一张。
    if (b.sides[si].p.isGod) {
        if (win < 0 && bm) return win - this.GOD_BUST_PENALTY;
        return win;
    }
    if (win === 0) return 0;                    // 平局重发，视为中性
    var meP = b.sides[si].p, opP = b.sides[1 - si].p;
    // 平局加伤：本次拼点每平一次，底伤 +1（doResolve 里的 tieBonus）。
    // 这里必须跟着加 —— 不加的话平过几次之后 AI 会低估赌注，
    // 该保守的时候还在赌爆牌。
    var tieBonus = b.redeals || 0;
    var items, dmg, v;
    if (win > 0) {
        items = 1 + (bo ? 1 : 0) + (mm ? 1 : 0);
        dmg = items + (opP.losses || 0) + tieBonus;   // 吃对手累计败场 + 平局加伤
        v = dmg;
        if ((opP.hp || 0) - dmg <= 0) v += this.HP_KILL;
        return v;
    }
    items = 1 + (bm ? 1 : 0) + (mo ? 1 : 0);
    dmg = items + (meP.losses || 0) + tieBonus;  // 我方败场越多、平局越多，再输一次越痛
    // 败者摸 2 张、胜者摸 1 张，只补差额；必须远小于伤害，否则会“乐于输牌”
    v = -dmg + this.FUNC_VAL;
    if ((meP.hp || 0) - dmg <= 0) v -= this.HP_DIE;
    return v;
};

// 从 U 中取 k 张的全部组合（上限 cap 组）
D678.AI.combos = function (U, k, cap) {
    var out = [];
    if (k <= 0) return [[]];
    if (k > U.length) return [];
    (function rec(start, cur) {
        if (out.length >= cap) return;
        if (cur.length === k) { out.push(cur.slice(0)); return; }
        for (var i = start; i < U.length; i++) {
            cur.push(U[i]);
            rec(i + 1, cur);
            cur.pop();
            if (out.length >= cap) return;
        }
    })(0, []);
    return out;
};

// 对手眼中我方的点数（对手看不到我方暗牌时用未见牌均值补全）
D678.AI.oppViewOfMe = function (b, si, U) {
    if (b.sides[1 - si].p.isGod) return b.total(si);   // 对手是超哥，他看得见
    var hid = 0, c = b.sides[si].cards;
    for (var i = 0; i < c.length; i++) { if (c[i].hidden) hid++; }
    if (hid === 0 || !U.length) return b.total(si);
    var avg = 0;
    for (var j = 0; j < U.length; j++) avg += b.adj(U[j]);
    avg /= U.length;
    return b.upTotal(si) + avg * hid;
};

// 超哥视角：对手能达到的所有最终点数。
//
// 他不猜对手在想什么 —— 猜错一次就会像“停在11点等对方爆”那样丢掉必胜局。
// 因为牌库顺序已知，对手继续要牌只能沿着牌库顺序拿牌，
// 所以“对手可能停在哪些点数”是一个有限的确定集合：
// 现在就停、抽1张后停、抽2张后停 …… 直到爆牌或抽不动。
// 超哥对这个集合取最坏情况（见 godStandValue），因此不依赖任何对手模型。
D678.AI.godOppTotals = function (b, si) {
    var oi = 1 - si;
    var t = b.total(oi);
    var out = [t];
    if (b.sides[oi].stood) return out;      // 已停牌，只有这一个可能
    var deck = b.deck.slice(0);
    var up = b.upTotal(oi);
    var guard = 0;
    while (deck.length > 0 && up < 21 && guard++ < 12) {
        var v = deck.shift();
        t  += b.adj(v);
        up += b.adj(v);
        out.push(t);
        if (b.isBustVal(t) && !b.isOver21Rule()) break;   // 爆了不会再要
    }
    return out;
};

// 超哥的停牌价值：对手所有可能停手点里的最坏结果（minimax）
D678.AI.godStandValue = function (b, si) {
    var mt = b.total(si);
    var ots = this.godOppTotals(b, si);
    var worst = Infinity;
    for (var i = 0; i < ots.length; i++) {
        var v = this.resolveUtil(b, si, mt, ots[i]);
        if (v < worst) worst = v;
    }
    if (worst === Infinity) worst = 0;
    // 平手（0）之间还要分优劣：越靠近目标点数越好，作为极小的次级判据，
    // 保证他在“怎么走都不败”时仍然选最接近 21 的那条线。
    var tie = -this.godDist(b, mt) * 0.001;
    return worst + tie - this.godVulnPenalty(b, si);
};

// 距目标点数的距离（爆牌记一个大值）
D678.AI.godDist = function (b, t) {
    if (b.isBustVal(t)) return 50;
    return b.distVal(t);
};

// 对手手上的规则牌可能把超哥现在的点数打爆 —— 换算成胜负单位的小额惩罚
D678.AI.godVulnPenalty = function (b, si) {
    var opp = b.sides[1 - si];
    var funcs = opp.p.funcs || [];
    if (!funcs.length) return 0;
    var cand = ['rule18', 'rule24', 'rule+1', 'rule-1', 'rule>21'];
    var save = b.rule, hits = 0, own = 0;
    for (var i = 0; i < cand.length; i++) {
        if (cand[i] === save) continue;
        if (funcs.indexOf(cand[i]) < 0) continue;   // 超哥知道对手到底有哪几张
        own++;
        b.rule = cand[i];
        if (b.isBustVal(b.total(si))) hits++;
        b.rule = save;
    }
    b.rule = save;
    if (!own || !hits) return 0;
    return (hits / own) * 0.5;                      // 胜负单位，最多扣半个胜
};

// 对手最终点数的加权分布 [{t:点数, w:权重}]
D678.AI.oppDist = function (b, si, U) {
    var out = [], i, j;
    var god = !!b.sides[si].p.isGod;
    if (god) {
        // 超哥不做概率估计：把对手所有可能的停手点等权列出，
        // 真正的取舍在 godStandValue 里按最坏情况做。
        var ots = this.godOppTotals(b, si);
        for (i = 0; i < ots.length; i++) out.push({ t: ots[i], w: 1 / ots.length });
        return out;
    } else {
        var base = b.upTotal(1 - si);
        var kn = b.sides[si].known;
        for (var q = 0; q < kn.length; q++) base += b.adj(kn[q]);
        var k = this.oppHiddenUnknown(b, si);
        if (k <= 0 || U.length === 0) {
            out.push({ t: base, w: 1 });
        } else {
            // 精确枚举对手暗牌的所有组合，不再用“平均牌”近似
            var cs = this.combos(U, Math.min(k, U.length), 400);
            if (!cs.length) {
                out.push({ t: base, w: 1 });
            } else {
                // 不再等权：按每个候选点数能否解释对手的实际选择加权
                var mtV = this.oppViewOfMe(b, si, U);
                var wsum = 0, tmp = [];
                for (i = 0; i < cs.length; i++) {
                    var t = base;
                    for (j = 0; j < cs[i].length; j++) t += b.adj(cs[i][j]);
                    var w = this.behaviorWeight(b, si, t, U, mtV);
                    tmp.push({ t: t, w: w });
                    wsum += w;
                }
                if (wsum <= 0) {      // 全部矛盾时退回等权，别把分布算成空
                    for (i = 0; i < tmp.length; i++) tmp[i].w = 1 / tmp.length;
                } else {
                    for (i = 0; i < tmp.length; i++) tmp[i].w /= wsum;
                }
                for (i = 0; i < tmp.length; i++) out.push(tmp[i]);
            }
        }
    }
    out = this.mergeDist(out);
    // 对手若尚未停牌，按“对手也在最大化自己收益”展开其后续要牌
    if (!b.sides[1 - si].stood && b.upTotal(1 - si) < 21 && b.deck.length > 0) {
        var pf = this.profile(b.sides[1 - si].p);
        out = this.expandOpp(b, si, out, U, pf.expand);
    }
    return out;
};

//--- 从对手的动作反推他的暗牌 ------------------------------------------------
//
// 原来枚举对手暗牌时所有组合等权，等价于「对手那张暗牌是随机的」——
// 可是对手已经做出过选择，选择本身就是情报。
// 一个在该要牌的点数上主动停手的人是可疑的，所以「能解释他为什么敢停」的
// 候选点数（接近目标点数 / 已经爆牌）应该拿到更高权重。
// 似然函数直接复用对手模型本身（oppMustHit / oppWouldHit），
// 保证「我推测的对手」和「实际会那样打的对手」是同一套判断。
D678.AI.STAND_HARD = 0.03;   // 与「必须要牌却停手了」矛盾：几乎不可能
D678.AI.STAND_SOFT = 0.25;   // 与「该要牌却停手了」矛盾：不太像

// 镜像 mustHit 的判断，但针对假设的对手点数 t。
// 对手的未见牌集合拿我方的 U 近似（两边规模相当，够用）。
D678.AI.oppMustHit = function (b, si, t, U) {
    var oi = 1 - si;
    if (!b.canHit(oi)) return false;
    if (b.sides[oi].p.isGod || b.sides[oi].checkN > 0) return false;
    if (!U.length) return false;
    var bustNow = b.isBustVal(t), dist = b.distVal(t);
    var bust = 0, better = false;
    for (var i = 0; i < U.length; i++) {
        var nt = t + b.adj(U[i]);
        if (b.isBustVal(nt)) { bust++; continue; }
        if (bustNow || b.distVal(nt) < dist) better = true;
    }
    if (bustNow) return better;
    if (!better) return false;
    return (bust / U.length) < this.FORCE_HIT_BUST;
};

// 候选点数 t 与对手已做出的选择有多吻合
D678.AI.behaviorWeight = function (b, si, t, U, mtView) {
    if (!b.sides[1 - si].stood) return 1;      // 还没表态，没有情报可用
    if (this.oppMustHit(b, si, t, U)) return this.STAND_HARD;
    if (this.oppWouldHit(b, si, t, U, mtView)) return this.STAND_SOFT;
    return 1;
};

// 对手是否会在点数 ot 时继续要牌 —— 用对手自己的 HP 收益判断，而非固定阈值
D678.AI.oppWouldHit = function (b, si, ot, U, mtView) {
    var oi = 1 - si;
    if (b.isBustVal(ot) && !b.isOver21Rule()) return false;
    var stand = this.resolveUtil(b, oi, ot, mtView);
    var hit = 0;
    for (var j = 0; j < U.length; j++) {
        hit += this.resolveUtil(b, oi, ot + b.adj(U[j]), mtView);
    }
    hit /= U.length;
    return hit > stand;
};

// 按点数合并分布：只有总点数影响结果，合并后条目数恒定在 ~40 以内
D678.AI.mergeDist = function (list) {
    var m = {}, out = [], i, k;
    for (i = 0; i < list.length; i++) {
        k = list[i].t;
        m[k] = (m[k] || 0) + list[i].w;
    }
    var keys = Object.keys(m);
    for (i = 0; i < keys.length; i++) out.push({ t: Number(keys[i]), w: m[keys[i]] });
    return out;
};

// 对手后续要牌的分布展开
D678.AI.expandOpp = function (b, si, list, U, depth) {
    if (depth <= 0 || U.length === 0) return list;
    var mtView = this.oppViewOfMe(b, si, U);
    var hitCache = {};
    var out = [], i, j, moved = false;
    for (i = 0; i < list.length; i++) {
        var e = list[i];
        var hit;
        if (e.t >= 21) hit = false;
        else if (hitCache[e.t] !== undefined) hit = hitCache[e.t];
        else hit = hitCache[e.t] = this.oppWouldHit(b, si, e.t, U, mtView);
        if (!hit) { out.push(e); continue; }
        moved = true;
        for (j = 0; j < U.length; j++) {
            out.push({ t: e.t + b.adj(U[j]), w: e.w / U.length });
        }
    }
    if (!moved) return this.mergeDist(out);
    return this.expandOpp(b, si, this.mergeDist(out), U, depth - 1);
};

// 我方点数 mt 面对对手分布时的期望收益（HP 单位）
D678.AI.valueVs = function (b, si, mt, dist) {
    if (!dist.length) return 0;
    var v = 0, tot = 0;
    for (var i = 0; i < dist.length; i++) {
        tot += dist[i].w;
        v += dist[i].w * this.resolveUtil(b, si, mt, dist[i].t);
    }
    return tot > 0 ? v / tot : 0;
};

// 我方当前点数被对手规则牌破坏的风险代价
D678.AI.vulnPenalty = function (b, si) {
    var opp = b.sides[1 - si];
    var n = (opp.p.funcs || []).length;
    if (n <= 0) return 0;
    var cand = ['rule18', 'rule24', 'rule+1', 'rule-1', 'rule>21'];
    var god = !!b.sides[si].p.isGod;
    var save = b.rule, hits = 0, seen = 0;
    for (var i = 0; i < cand.length; i++) {
        if (cand[i] === save) continue;
        if (god && opp.p.funcs.indexOf(cand[i]) < 0) continue;   // 超哥知道对手到底有什么
        seen++;
        b.rule = cand[i];
        if (b.isBustVal(b.total(si))) hits++;
        b.rule = save;
    }
    b.rule = save;
    if (!seen || !hits) return 0;
    var p = god ? 0.85 : (hits / seen) * Math.min(1, n / 4) * 0.6;
    return p * ((b.sides[si].p.losses || 0) + 2.2);
};

// 直接停牌的价值
D678.AI.standValue = function (b, si) {
    if (b.sides[si].p.isGod) return this.godStandValue(b, si);
    var U = this.unseen(b, si);
    var v = this.valueVs(b, si, b.total(si), this.oppDist(b, si, U));
    return v - this.vulnPenalty(b, si);
};

// 在克隆盘面上加一张牌（用于推演）
D678.AI.simAdd = function (b, si, v, hidden) {
    D678.remove(b.deck, v);
    b.sides[si].cards.push({ v: v, hidden: !!hidden });
};

// 当前局面的最优价值（停牌 / 要牌 递归，单位 HP）
D678.AI.bestValue = function (b, si, depth) {
    var sv = this.standValue(b, si);
    if (depth <= 0 || !b.canHit(si)) return sv;
    var U = this.unseen(b, si);
    if (U.length === 0) return sv;
    // 确切知道下一张（超哥永远知道 / 其他人用过查看牌库）-> 只推演那一张，不做期望
    if (this.knowsNext(b, si)) {
        var c2 = b.clone();
        this.simAdd(c2, si, b.deck[0], false);
        return Math.max(sv, this.bestValue(c2, si, depth - 1));
    }
    var sum = 0;
    for (var i = 0; i < U.length; i++) {
        var c = b.clone();
        this.simAdd(c, si, U[i], false);
        sum += this.bestValue(c, si, depth - 1);
    }
    var hv = sum / U.length;
    return Math.max(sv, hv);
};

// 抽牌爆牌率
D678.AI.bustRate = function (b, si) {
    var U = this.unseen(b, si);
    if (!U.length) return 1;
    var n = 0;
    for (var i = 0; i < U.length; i++) {
        if (b.isBustVal(b.total(si) + b.adj(U[i]))) n++;
    }
    return n / U.length;
};

//--- 要牌的硬性下限 --------------------------------------------------------
//
// 期望值算得再自洽，也不该得出“8 点对 18 点规则不抽牌”这种结论。
// 根因是 AI 看不见对方暗牌：对手明牌 3+9=12 时它会算出“对手多半已经爆了”，
// 于是 8 点停牌的期望反而是正的 —— 推导没错，结论离谱。
// 治法不是调阈值（会连带影响所有正常局面），而是给期望值加两条不可逾越的下限：
//   1) 自己当前已经算爆牌、而且补牌真能救回来 -> 必抽，停下来是白送
//   2) 爆牌率低于 FORCE_HIT_BUST 且抽牌有可能变好 -> 必抽，宁可爆也要拼
// 情报完全的一方（超哥 / 用过查看牌库）不受此约束：他知道下一张是什么，
// 期望值就是确定值，硬塞一张他明知会爆的牌只会让他变笨。
//
// 阈值取 0.30 而不是更高：这条下限只该在“怎么算都该拼”的绝境生效
// （例如 8 点对 18 点规则，爆率 17%）。爆率四成上下时要不要牌本来就是
// 接近五五的权衡，交给期望值精算，硬性下限不该插手。
D678.AI.FORCE_HIT_BUST = 0.30;

// 未见牌里是否存在“抽了之后不爆、且更接近目标”的牌
D678.AI.canImprove = function (b, si) {
    var U = this.unseen(b, si);
    var cur = b.total(si);
    var curBust = b.isBustVal(cur);
    var curDist = b.distVal(cur);
    for (var i = 0; i < U.length; i++) {
        var t = cur + b.adj(U[i]);
        if (b.isBustVal(t)) continue;
        if (curBust || b.distVal(t) < curDist) return true;
    }
    return false;
};

// 是否处在“绝不该要牌”的局面：已经爆牌、且没有任何一张未见牌能救回来。
// 此时抽与不抽对胜负分毫不差（爆牌就是爆牌，不会再多扣血），
// 期望值因此完全相等，noise 会随机把天平推向要牌 —— 玩家看到的就是
// 「爆到 23 了还在抽，一路抽到 30」。结果虽不变，但既难看又白耗牌库，
// 把牌堆里对手或自己可能需要的牌冲掉，所以显式禁掉。
D678.AI.neverHit = function (b, si) {
    if (!b.isBustVal(b.total(si))) return false;
    return !this.canImprove(b, si);
};

// 是否处在“必须要牌”的局面
D678.AI.mustHit = function (b, si) {
    if (!b.canHit(si)) return false;
    if (this.knowsNext(b, si)) return false;      // 情报完全 -> 交给期望值精算
    // canImprove 必须排在爆牌判断之前：普通规则下爆牌是不可逆的，
    // 23 点再抽只会变 25、30，结果分毫不差，纯粹白抽还消耗牌库。
    // 只有 规则>21（“爆”指低于 21）下补牌才真能救回来，那时 canImprove 为真。
    if (!this.canImprove(b, si)) return false;
    if (b.isBustVal(b.total(si))) return true;    // 已经爆了且能救 -> 必抽
    return this.bustRate(b, si) < this.FORCE_HIT_BUST;
};

//--- 规则牌的出手时机闸门 ----------------------------------------------------
//
// 问题：AI 会开局就甩规则牌。比如自己 1+2=3 却立刻用规则18 ——
// 期望值上说得通（改完规则对手更可能爆），但离 18 点还差 15 点，
// 这张牌等真要用的时候已经没了，观感也蠢。
//
// 根因是 simFunc 对规则牌只问「改完之后这盘的期望值高不高」，
// 完全没问「我自己够不够得着这个新目标」。这不是调阈值能解决的，
// 因为期望值本身没错，缺的是一条时机约束。
//
// 闸门：改完规则后，自己要么已经满点，要么离新目标不超过 RULE_NEAR 点
// 且没爆，才允许出这张牌；否则连评估都不做，把牌留着。
D678.AI.RULE_NEAR = 4;

D678.AI.ruleTimingOK = function (b, si, id) {
    var save = b.rule;
    b.rule = id;
    var t     = b.total(si);
    var bust  = b.isBustVal(t);
    var isMax = b.isMaxVal(t);
    var dist  = b.distVal(t);
    // 对手在新规则下会不会爆、他是否还能动。
    //
    // oppLocked 必须在新规则下算：canHit 看的是明牌合计 < 21，而合计含规则修正。
    // 例如自己出 rule-1 会把对手的明牌合计一起压低，原本抽不动的对手又能抽了 ——
    // 若按旧规则判定「他已经定型」，就会拿一个改完即失效的前提去放行这一手。
    var oppBust   = b.isBustVal(b.total(1 - si));
    var oppLocked = b.sides[1 - si].stood ||
                    !b.canHit(1 - si) ||
                    b.deck.length === 0;
    b.rule = save;

    if (isMax) return true;                             // 改完就是满点，随时可以出
    if (!bust && dist <= this.RULE_NEAR) return true;   // 差得不多，够得着

    // 例外：对手已经定型（停牌了、或者抽不动了），而新规则直接把他打爆、
    // 自己又没爆 —— 这一手能立刻锁定胜负，不该被闸门拦下。
    if (oppLocked && oppBust && !bust) return true;

    return false;
};

// 模拟使用一张功能牌，返回 {value, ok}
D678.AI.simFunc = function (b, si, id, depth) {
    var f = D678.funcData(id);
    var god = !!b.sides[si].p.isGod;
    // 超哥的估值单位是“胜负”（±1），不是 HP，所以情报/功能牌折价要换算
    var fv = god ? this.GOD_FUNC_VAL : this.FUNC_VAL;
    var c = b.clone();
    var val = null;
    if (f.kind === 'pick') {
        var U = this.unseen(b, si);
        if (U.indexOf(f.num) < 0) return null;             // 自己看得见 -> 必定失败
        var k = this.oppHiddenUnknown(b, si);
        var pSucc = U.length > 0 ? Math.max(0, (U.length - k)) / U.length : 0;
        this.simAdd(c, si, f.num, false);
        c.sides[si].stood = false;
        c.standStreak = 0;
        var vSucc = this.bestValue(c, si, Math.max(0, depth - 1));
        // 失败：损失一张牌，但确定了对方底牌（情报价值；超哥本来就知道，无情报收益）
        var intel = god ? 0 : (k > 0 ? 0.9 : 0);
        var vFail = this.bestValue(b, si, depth) - fv + intel;
        val = pSucc * vSucc + (1 - pSucc) * vFail;
    } else if (f.kind === 'pickback') {
        if (b.deck.length === 0) return null;
        var U2 = this.unseen(b, si);
        if (!U2.length) return null;
        if (this.knowsNext(b, si)) {
            // 知道下一张是什么，抽底牌的结果是确定的
            var cd = b.clone();
            this.simAdd(cd, si, b.deck[0], true);
            cd.sides[si].stood = false;
            cd.standStreak = 0;
            // 藏牌让对手看不清自己的点数，是个小额附加值（换算到对应单位）
            val = this.bestValue(cd, si, Math.max(0, depth - 1)) + (god ? 0.03 : 0.8);
        } else {
            var s = 0;
            for (var i = 0; i < U2.length; i++) {
                var c2 = b.clone();
                this.simAdd(c2, si, U2[i], true);
                c2.sides[si].stood = false;
                c2.standStreak = 0;
                s += this.bestValue(c2, si, Math.max(0, depth - 1));
            }
            // 暗牌让对手的估计变差：按对手手上功能牌数折算情报收益
            val = s / U2.length + 0.8;
        }
    } else if (f.kind === 'check') {
        if (b.sides[si].checkN > 0 || b.deck.length === 0) return null;
        if (b.sides[si].p.isGod) return null;   // 超哥本来就知道牌库，查看牌库毫无价值
        var br = this.bustRate(b, si);
        var base = this.bestValue(b, si, depth);
        // 情报价值：越是进退两难（爆牌率中段）越值钱
        var unc = 1 - Math.abs(br - 0.5) * 2;
        var bonus = unc * 1.1;
        if (!b.canHit(si)) bonus = 0;                        // 不能要牌时看牌无用
        val = base + bonus;
    } else if (f.kind === 'picksmall') {
        if (b.deck.length === 0) return null;
        // 「牌库最小的那张」对不同情报水平的人是不同的量：
        // 超哥直接看得见牌库，最小值是确定的；
        // 其他人只知道未见牌集合 U = 牌库 + 对方暗牌，
        // 所以要枚举「哪几张在对方手里」，每种情况下的牌库最小值取平均。
        var Up = this.unseen(b, si);
        if (!Up.length) return null;
        if (god) {
            var gm = b.deckMin();
            if (gm === null) return null;
            var cg = b.clone();
            this.simAdd(cg, si, gm, false);
            val = this.bestValue(cg, si, Math.max(0, depth - 1));
        } else {
            var kk = this.oppHiddenUnknown(b, si);
            var mins = [];
            if (kk <= 0) {
                mins.push(Math.min.apply(null, Up));
            } else {
                var cbs = this.combos(Up, Math.min(kk, Up.length), 120);
                for (var ci = 0; ci < cbs.length; ci++) {
                    var rest = Up.filter(function (v) { return cbs[ci].indexOf(v) < 0; });
                    if (rest.length) mins.push(Math.min.apply(null, rest));
                }
                if (!mins.length) mins.push(Math.min.apply(null, Up));
            }
            var sp = 0;
            for (var mi = 0; mi < mins.length; mi++) {
                var cm = b.clone();
                this.simAdd(cm, si, mins[mi], false);
                sp += this.bestValue(cm, si, Math.max(0, depth - 1));
            }
            val = sp / mins.length;
        }
    } else if (f.kind === 'repick') {
        var rpc = b.newestUp(si);
        if (!rpc) return null;
        // 牌库空也能用：那张牌洗回去后牌库就有 1 张，重抽必定拿回同一张
        var oldV = rpc.v;
        // 先把这张明牌拿掉、洗回牌库，再看重抽的结果。
        // 在克隆盘面上用 newestUp 重新定位，避免场上有同值牌时错删。
        var cr = b.clone();
        cr.sides[si].cards.splice(cr.sides[si].cards.indexOf(cr.newestUp(si)), 1);
        cr.deck.push(oldV);
        if (god) {
            // 洗回去是随机插入：以 1/(n+1) 抽到刚洗进去的那张，
            // 否则抽到他原本已知的牌库顶那张。这两种结果都是确定的。
            var n0 = b.deck.length;
            var pSame = 1 / (n0 + 1);
            var vSame = null, vTop = null;
            var cA = cr.clone();
            this.simAdd(cA, si, oldV, false);
            vSame = this.bestValue(cA, si, Math.max(0, depth - 1));
            if (n0 > 0) {
                var cB = cr.clone();
                this.simAdd(cB, si, b.deck[0], false);
                vTop = this.bestValue(cB, si, Math.max(0, depth - 1));
                val = pSame * vSame + (1 - pSame) * vTop;
            } else {
                val = vSame;
            }
        } else {
            // 其他人眼里重抽的结果就是「未见牌 ∪ 刚洗回去的那张」里随机一张
            var Ur = this.unseen(cr, si);
            if (Ur.indexOf(oldV) < 0) Ur = Ur.concat([oldV]);
            if (!Ur.length) return null;
            var sr = 0;
            for (var ri = 0; ri < Ur.length; ri++) {
                var cc2 = cr.clone();
                this.simAdd(cc2, si, Ur[ri], false);
                sr += this.bestValue(cc2, si, Math.max(0, depth - 1));
            }
            val = sr / Ur.length;
        }
    } else if (f.kind === 'reback') {
        if (b.deck.length === 0) return null;
        var oppHole = b.firstHole(1 - si);
        if (!oppHole) return null;
        // 干扰的收益主要不是改变点数，而是**情报**：换上去的那张是自己放的，
        // 所以换完之后自己确知对方这张底牌。把这一点如实建模成
        // 「新底牌值 v + 自己把 v 记进 known」，收益自然从 bestValue 里长出来，
        // 不需要另外拍一个奖励系数。
        var cand = god ? b.deck.slice(0) : this.unseen(b, si);
        if (!cand.length) return null;
        if (cand.length > 8) cand = cand.slice(0, 8);
        var sb = 0;
        for (var bi = 0; bi < cand.length; bi++) {
            var cb2 = b.clone();
            var h2 = cb2.firstHole(1 - si);
            if (!h2) continue;
            var oldH = h2.v;
            h2.v = cand[bi];
            D678.remove(cb2.deck, cand[bi]);
            cb2.deck.push(oldH);
            D678.remove(cb2.sides[si].known, oldH);
            if (cb2.sides[si].known.indexOf(cand[bi]) < 0) {
                cb2.sides[si].known.push(cand[bi]);
            }
            cb2.sides[si].stood = false;
            cb2.standStreak = 0;
            sb += this.bestValue(cb2, si, depth);
        }
        val = sb / cand.length - fv;
    } else {
        // 规则牌先过时机闸门：离新目标太远就不出，把牌留到够得着的时候
        if (f.kind === 'rule' && !this.ruleTimingOK(b, si, id)) return null;
        var r = c.useFunc(si, id, true);
        if (!r.ok) return null;
        val = this.bestValue(c, si, depth);
    }
    return { value: val, id: id };
};

// 一次决策：返回 {action:'func',id} / {action:'hit'} / {action:'stand'}
D678.AI.decide = function (b, si) {
    var side = b.sides[si];
    var pf = this.profile(side.p);
    var depth = pf.depth;
    var base = this.bestValue(b, si, depth);
    var best = { action: null, value: base };
    var funcs = side.p.funcs.slice(0);

    // 非抽牌类功能牌不结束回合，可以连续使用。
    // 这里每次只评估“出一张”：出完之后回合仍在自己手上，decide 会再跑一次，
    // 需要连出时自然会连出。实测这样比“两张组合前瞻”更强——
    // 组合前瞻会把成对才成立的收益记在第一张头上，诱导 AI 出一张就停。
    if (b._fuTurn !== b.turn) { b._fuTurn = b.turn; b.turnFuncUses = 0; }
    var canUseFunc = (b.turnFuncUses || 0) < 5;

    if (canUseFunc) {
        var tried = {};
        for (var i = 0; i < funcs.length; i++) {
            if (tried[funcs[i]]) continue;
            tried[funcs[i]] = true;
            var r1 = this.simFunc(b, si, funcs[i], depth);
            if (!r1) continue;
            var v = r1.value;
            if (pf.noise) v += (Math.random() - 0.5) * pf.noise;
            if (v > best.value + pf.th) best = { action: 'func', id: funcs[i], value: v };
        }
    }

    if (best.action === 'func') return best;

    if (!b.canHit(si)) return { action: 'stand' };
    // 硬性下限优先于期望值，但排在功能牌之后：
    // 功能牌不结束回合（抽牌类除外），出完之后 decide 会再跑一次，
    // 该抽的那一张不会因为先出了一张功能牌而漏掉。
    if (this.neverHit(b, si)) return { action: 'stand' };
    if (this.mustHit(b, si)) return { action: 'hit' };
    var sv = this.standValue(b, si);
    var hv = -Infinity;
    var U = this.unseen(b, si);
    if (U.length) {
        if (this.knowsNext(b, si)) {
            var cc = b.clone();
            this.simAdd(cc, si, b.deck[0], false);
            hv = this.bestValue(cc, si, depth - 1);
        } else {
            var s2 = 0;
            for (var k2 = 0; k2 < U.length; k2++) {
                var c3 = b.clone();
                this.simAdd(c3, si, U[k2], false);
                s2 += this.bestValue(c3, si, depth - 1);
            }
            hv = s2 / U.length;
        }
        if (pf.noise) hv += (Math.random() - 0.5) * pf.noise;
    }
    return (hv > sv) ? { action: 'hit' } : { action: 'stand' };
};

// 执行 AI 的一步，返回事件（供界面播放 / 模拟使用）
D678.AI.step = function (b, si) {
    var d = this.decide(b, si);
    if (d.action === 'func') {
        b.turnFuncUses = (b.turnFuncUses || 0) + 1;
        var f = D678.funcData(d.id);
        var r = b.useFunc(si, d.id);
        if (r.fail && f.kind === 'pick') {
            // 抽牌失败 -> 该号牌一定在对方暗牌里
            if (b.sides[si].known.indexOf(f.num) < 0) b.sides[si].known.push(f.num);
        }
        if (!r.ok) return { side: si, action: 'stand', msg: '对方过牌', _forced: true, ev: b.act(si, 'stand') };
        // same 透出来给界面用：重抽拿到同一个数字时牌会原地不动，
        // 界面靠这个标记把那张牌重新「发」一次（见 678.js 的 redealCard）
        return { side: si, action: 'func', id: d.id, msg: r.msg, fail: !!r.fail,
                 endTurn: !!r.endTurn, same: !!r.same };
    }
    if (d.action === 'hit' && b.canHit(si)) {
        var e = b.act(si, 'hit');
        return { side: si, action: 'hit', msg: '对方抽牌', value: e.value };
    }
    b.act(si, 'stand');
    return { side: si, action: 'stand', msg: '对方过牌' };
};

//=============================================================================
// AI vs AI 模拟
//=============================================================================

D678.simulateMatch = function (pA, pB) {
    var b = new D678_Battle(pA, pB, true);
    var guard = 0;
    while (!b.finished && guard++ < 400) {
        if (b.pendingRedeal) { b.pendingRedeal = false; b.redeals++; b.newDeal(); continue; }
        D678.AI.step(b, b.turn);
        if (b.result && b.result.tie && !b.finished) { b.pendingRedeal = true; }
    }
    if (!b.finished) { b.doResolve(); }
    if (b.result && b.result.tie) { b.result = null; return null; }
    var need = b.grantFuncs();
    // AI 超过 6 张自动弃掉价值最低的（对 AI 而言的暂停选择）
    need.forEach(function (p) { D678.autoDiscard(p); });
    return b.result;
};

// 随机弃掉超出上限的功能牌，返回被弃掉的 id 数组（给界面报「弃了哪几张」用）。
//
// 【和 autoDiscard 的分工】autoDiscard 按价值弃最差的，那是 AI 的选择逻辑；
// 这个纯随机，是**多人模式的规则**：超过 6 张不再让人手动挑，服务器直接随机弃。
// 联机里必须随机 —— 按价值弃等于服务器替人做了一个更优的选择，
// 而同桌的 AI 也用同一套价值表的话，等于 AI 白拿一个「弃牌总是弃对」的优势。
// 随机对所有人一视同仁，规则也一句话说得清。
//
// 调用方要保证 D678.Game 指向正确的那局（服务器多房间共用这个模块级全局，
// 必须包在 withRoom 里）—— 和 autoDiscard 同一个约束。
D678.randomDiscard = function (p) {
    var out = [];
    while (p.funcs.length > D678.MAX_FUNC) {
        var i = Math.floor(Math.random() * p.funcs.length);
        var id = p.funcs.splice(i, 1)[0];
        out.push(id);
        D678.Game.returnFunc(id);
    }
    return out;
};

D678.autoDiscard = function (p) {
    // 价值排序：中间号码的 pick 最有用（更容易凑到目标），规则牌次之。
    // picksmall 只能拿到最小牌，适用面窄于任意指定抽牌，所以排在 pick 之下；
    // repick 是把一张换成随机一张，期望收益有限；reback 只干扰对方、不改善自己。
    var order = { pick: 3, rob: 2.6, pickback: 2.4, rule: 2.3, swap: 2.2,
                  picksmall: 2.1, reback: 1.8, repick: 1.6, 'return': 1.4, check: 1.2 };
    while (p.funcs.length > D678.MAX_FUNC) {
        var worst = 0, wv = Infinity;
        for (var i = 0; i < p.funcs.length; i++) {
            var f = D678.funcData(p.funcs[i]);
            var v = order[f.kind] !== undefined ? order[f.kind] : 1;
            if (f.kind === 'pick') {
                // 1 号和 11 号的适用面窄于 5~9 号
                v += 0.5 - Math.abs(f.num - 7) * 0.09;
            }
            if (v < wv) { wv = v; worst = i; }
        }
        var id = p.funcs.splice(worst, 1)[0];
        D678.Game.returnFunc(id);
    }
};

//=============================================================================
// 导出
//=============================================================================
// 浏览器里 var D678 已经是全局，这里显式挂一次 window 只为语义清楚（幂等）；
// Node 里 var 是模块作用域，必须走 module.exports 服务器才拿得到。
if (typeof module !== 'undefined' && module.exports) module.exports = D678;
else if (typeof window !== 'undefined') window.D678 = D678;

})();
