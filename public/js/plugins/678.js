//=============================================================================
// 678.js
//=============================================================================
/*:
 * @plugindesc 21点卡牌淘汰赛（678） 调用命令: start678
 * @author DerekGoodman
 *
 * @help
 * ============================================================================
 * 使用方法
 * ============================================================================
 * 事件中使用插件命令:
 *
 *   start678
 *
 * 进入后先询问玩家是否知道规则：
 *   知道     -> 直接开始第 1 轮
 *   不知道   -> 先跑一场固定开局的教学对局（5+6 对 1+11，最终 21:21 平局），
 *               教程不掉血、不计胜负、不占轮次，结束后接着打第 1 轮，
 *               对手名单沿用教程里排名画面展示过的那 8 位。
 *
 * 游戏结束（玩家被淘汰 或 玩家成为最后幸存者）后自动返回地图。
 *
 * ============================================================================
 * 回合规则
 * ============================================================================
 *  只有抽牌类动作会结束回合：要牌、过牌、指定抽牌成功、抽暗牌、重抽、抽小。
 *  其余功能牌（互换/强夺/退回/规则牌/查看牌库/干扰）不消耗回合，可以连续使用。
 *  指定抽牌失败（该号牌已在场上）只消耗该功能牌，回合仍在自己手上。
 *
 *  使用功能牌成功后，对方之前的过牌一律作废（“连续过牌”计数清零）：
 *  回合仍在自己手上，但对方必定能再行动一次，
 *  因此不存在“对方过牌 -> 我方用规则牌 -> 我方过牌 -> 直接结算”这种情况。
 *  双方连续过牌两次才进入结算。
 *
 * ============================================================================
 * 结算规则
 * ============================================================================
 *  单方爆牌：爆牌方直接判负（伤害多算一份）。
 *  双方爆牌：平局，立即重新发牌（不比谁更接近目标点数）。
 *  双方未爆且同点：平局，立即重新发牌。
 *
 *  【三张改判定方式的规则牌】胜负一律走 Battle.scoreOf + D678.cmpScore
 *  这一对函数（678core.js），不要在别处另写一份比较逻辑：
 *    · 规则牛牛   任意几张凑成 10 的倍数，余下的和的个位即成绩，越大越好
 *                （10 点为牛牛=满点；凑不出算无牛，成绩 0）。本规则下没有爆牌。
 *    · 规则比多   先比张数，多者胜；超过 21 点仍算爆牌；张数相同才比接近 21。
 *                注意这条打破了「满点必胜」——恰好 21 点也可能因张数少而输。
 *    · 规则暗牌   只有暗牌计入判定，明牌一律不算；仍以接近 21 点为目标。
 *
 *  伤害 = 1（底伤）+ 本场平局次数 + 败方累计败场数 + 败方爆牌 1 + 胜方满点 1
 *
 *  【平局加伤】每平一次，这一场的底伤 +1：干净一局输是 -1，平过一次再输 -2，
 *  平两次 -3，以此类推。惩罚只在这一场（同一次拼点）里累积，新的一场归零。
 *  拼点画面显示「平局✖N」。单机、1v1、锦标赛共用这一份规则。
 *
 * ============================================================================
 * 功能牌的发放与弃牌
 * ============================================================================
 *  结算后胜者摸 1 张、败者摸 2 张。
 *  本局这场对战里被用掉的功能牌，交手的两个人这次发牌都摸不到（取双方并集）。
 *  牌本身照旧回公共池给别人摸，只是这两位隔一次发牌才可能再拿到。
 *
 *  手上超过 D678.MAX_FUNC 张时必须弃牌，且只能弃到刚好剩 MAX_FUNC 张 ——
 *  不能多弃。选满之后其余牌点不动，想换要先取消一张。
 *
 * ============================================================================
 * AI
 * ============================================================================
 *  AI 出规则牌有时机限制：改完规则后自己必须已经满点，
 *  或者离新目标点数不超过 D678.AI.RULE_NEAR 点且不爆，才会出手。
 *  否则把牌留着 —— 避免 1+2 就甩规则18 这种离目标还差十几点的出牌。
 *  唯一例外是对手已经停牌/抽不动、而新规则能直接把他打爆且自己没爆。
 *  改判定方式的那三张没有「目标点数」，闸门换成「改完之后我的成绩是否真的
 *  压过对手」（直接用 cmpScore 比），见 D678.AI.ruleTimingOK。
 *
 *  超哥必定登场，他知道牌库的完整顺序（每次抽到什么牌都算得到），
 *  也看得见对方的底牌，因此他的要牌/过牌是确定性最优的。
 *  因为他本来就知道牌库，「查看牌库」对他毫无价值，所以他不会摸到这张牌，
 *  这张牌会留在公共牌池里给其他更需要情报的玩家。
 *  其余 AI 从 D678.AI_NAMES 里随机抽 D678.AI_COUNT 位。
 *  要增加 AI，只需往 D678.AI_NAMES 数组里加名字。
 *
 * ============================================================================
 * 排名规则
 * ============================================================================
 *  存活者按 HP 从高到低排列；被淘汰者按淘汰时间倒序排在存活者之后，
 *  即最早被淘汰的人固定占据最后一名。
 *
 * ============================================================================
 * 素材要求 (img/pictures/, 每张 720x1020)
 * ============================================================================
 *  1 ~ 11        数字牌
 *  cardback      背面牌
 *  pick1~pick11  抽X号
 *  swap return rob pickback
 *  rule18 rule24 rule+1 rule-1 rule21 check
 *  repick reback picksmall
 * ============================================================================
 */

var D678 = D678 || {};

(function () {
'use strict';

// 规则层在 678core.js 里。加载顺序错了就立刻报明确的错，
// 不要等到玩家点开对局才莫名崩在某个 undefined 上。
if (!D678.Battle || !D678.GameClass) {
    throw new Error('678.js 需要先加载 678core.js —— 插件管理器里把 678core 排到 678 之前');
}

// 拆分前这两个类是同一个 IIFE 内的函数声明，拆开后从 D678 上取回来。
var D678_Battle = D678.Battle;
var D678_Game   = D678.GameClass;

//=============================================================================
// 场景 - 布局常量
//=============================================================================

var LY = {
    SW: 720, SH: 1280,
    CARD_W: 100, CARD_H: 142,
    FCARD_W: 88, FCARD_H: 125,
    OPP_CARD_Y: 190,
    MY_CARD_Y: 660,
    FUNC_Y: 880,
    BTN_Y: 1180,
    // 场上生效的规则牌：画在“规则：…”那行文字下方的空位
    RULE_W: 62, RULE_X: 24, RULE_Y: 416
};
D678.LY = LY;

//=============================================================================
// 图片改用 JPEG（首屏体积）
//=============================================================================
//
// 卡牌图原本是 720x1020 的 32 位 PNG，一张 600KB~1.3MB，36 张共 32MB ——
// 而它们在屏幕上最大只画到 118px 宽（drawDiscardPanel 那个 118），
// 手牌更小（LY.CARD_W=100）。等于下载了 37 倍于实际需要的像素。
//
// 改成 360x510 JPEG q90 之后 36 张一共 1.1MB，对最大显示尺寸仍有 3 倍超采样。
// 能用 JPEG 是因为**这些图全部不透明**（连圆角都是实心的，抽样 14790 点
// 无一个 alpha<255），所以 PNG 的无损压缩和 alpha 通道都是纯浪费。
//
// 【为什么只重写 loadPicture / loadTitle1，不改 loadBitmap】
// loadBitmap 是所有图片目录共用的。img/system 下 Window.png、IconSet.png、
// Balloon.png 真的需要 alpha，一起转成 JPEG 会让窗口边框和图标糊掉、
// 透明处变成黑块。所以按目录逐个放行，改哪个目录心里有数。
//
// 【加 JPG_EXT 常量而不是各处写死 '.jpg'】以后要回退成 PNG 或换 WebP，
// 只改这一行。三处 loader 必须一致，分散写死迟早漏一个。
//
// 【D678.CARD_W/CARD_H 要跟着改】见 678core.js 里那两个常量的注释 ——
// 所有绘制代码都是「目标宽 / D678.CARD_W」算缩放比，源图尺寸变了
// 那两个常量不跟着变，卡牌会画成原来的两倍大。
var JPG_EXT = '.jpg';

// img/pictures/：36 张卡牌图，全部已转 JPEG
ImageManager.loadPicture = function (filename, hue) {
    if (!filename) return this.loadEmptyBitmap();
    var path = 'img/pictures/' + encodeURIComponent(filename) + JPG_EXT;
    var bitmap = this.loadNormalBitmap(path, hue || 0);
    bitmap.smooth = true;      // 原 loadPicture 传的 smooth 就是 true
    return bitmap;
};

// img/titles1/：标题背景 fm，720x1280 全不透明，1702KB -> 240KB
ImageManager.loadTitle1 = function (filename, hue) {
    if (!filename) return this.loadEmptyBitmap();
    var path = 'img/titles1/' + encodeURIComponent(filename) + JPG_EXT;
    var bitmap = this.loadNormalBitmap(path, hue || 0);
    bitmap.smooth = true;
    return bitmap;
};

// img/system/ 只放行启动 logo 这一张。
//
// CustomLogo 插件用 loadSystem 加载它（不是 loadPicture），而它是
// 720x1281 的全屏插画、全不透明、644KB，走 Scene_Boot.loadSystemImages ——
// 在首屏阻塞路径上，转完只要 27KB。
//
// 【白名单而不是黑名单】同目录下那十几张系统图必须留 PNG。写成
// 「除了这几个都转」的话，以后 MV 加一张新系统图就会被误转。
var SYSTEM_JPG = { 'Derek': true };

var _IM_loadSystem = ImageManager.loadSystem;
ImageManager.loadSystem = function (filename, hue) {
    if (filename && SYSTEM_JPG[filename]) {
        var path = 'img/system/' + encodeURIComponent(filename) + JPG_EXT;
        var bitmap = this.loadNormalBitmap(path, hue || 0);
        bitmap.smooth = false;   // 原 loadSystem 传的 smooth 是 false
        return bitmap;
    }
    return _IM_loadSystem.call(this, filename, hue);
};

var COL = {
    bg1: '#0b2b1c', bg2: '#04140d',
    line: 'rgba(255,255,255,0.18)',
    white: '#ffffff', gray: '#b9c8c0', gold: '#ffd766',
    red: '#ff5a5a', green: '#5cff9d', blue: '#7fd4ff',
    aqua: '#48e6d2',      // 我方回合
    orange: '#ff9a4d',    // 对方回合
    purple: '#c98bff'     // 规则被变更
};

//=============================================================================
// Scene_D678
//=============================================================================

function Scene_D678() { this.initialize.apply(this, arguments); }
Scene_D678.prototype = Object.create(Scene_Base.prototype);
Scene_D678.prototype.constructor = Scene_D678;
window.Scene_D678 = Scene_D678;

Scene_D678.prototype.initialize = function () {
    Scene_Base.prototype.initialize.call(this);
};

Scene_D678.prototype.create = function () {
    Scene_Base.prototype.create.call(this);
    this._phase      = 'init';
    this._wait       = 0;
    this._hits       = [];
    this._anims      = [];
    this._msgs       = [];
    this._battle     = null;
    this._roundInfo  = null;
    this._selFunc    = null;
    this._showList   = false;
    this._showRule   = false;   // 场上规则牌的详情浮窗
    this._discardFor = null;
    this._discardSel = [];
    this._resultInfo = null;
    this._lastLog    = null;   // 上一场对局的日志，供轮结果画面展示
    this._notice     = '';
    this._noticeTime = 0;
    this._cardSprites = {};
    // 结算演出：满点时先放大字，面板延后淡入（见 onBattleEnd / drawOverlay）
    this._panelHold  = 0;    // 还需压住结算面板不画的帧数
    this._panelFade  = 1;    // 面板不透明度 0~1
    this._shake      = 0;    // 剩余震屏帧数
    this._shakePow   = 0;    // 震屏幅度（像素）
    this._fxQueue    = [];   // 延时触发的特效 [{t:剩余帧, fn:回调}]
    this.createBackground();
    this.createLayers();
    this.preloadImages();
};

Scene_D678.prototype.preloadImages = function () {
    for (var i = 1; i <= 11; i++) ImageManager.loadPicture(String(i));
    ImageManager.loadPicture('cardback');
    D678.FUNCS.forEach(function (f) { ImageManager.loadPicture(f.img); });
};

// 背景四周多画 PAD 像素并向左上偏移：满点演出会震屏（updateShake 推整个场景的
// x/y），背景若正好 720x1280 就会在边缘露出黑边。多出来的一圈把它兜住。
Scene_D678.prototype.createBackground = function () {
    var PAD = 16;
    var W = LY.SW + PAD * 2, H = LY.SH + PAD * 2;
    var b = new Bitmap(W, H);
    var ctx = b._context;
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, COL.bg1); g.addColorStop(1, COL.bg2);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // 分隔线坐标是屏幕坐标，画到位图上要补 PAD
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(20 + PAD, 640 + PAD); ctx.lineTo(700 + PAD, 640 + PAD);
    ctx.stroke();
    b._setDirty();
    this._bgSprite = new Sprite(b);
    this._bgSprite.x = -PAD;
    this._bgSprite.y = -PAD;
    this.addChild(this._bgSprite);
};

Scene_D678.prototype.createLayers = function () {
    this._cardLayer = new Sprite();
    this.addChild(this._cardLayer);

    this._uiBmp = new Bitmap(LY.SW, LY.SH);
    this._uiSprite = new Sprite(this._uiBmp);
    this.addChild(this._uiSprite);

    this._fxLayer = new Sprite();
    this.addChild(this._fxLayer);

    this._ovBmp = new Bitmap(LY.SW, LY.SH);
    this._ovSprite = new Sprite(this._ovBmp);
    this.addChild(this._ovSprite);

    // 高光特效层：在结算面板之上。满点大字必须走这一层，
    // 否则会被 drawShowdown 的 rgba(0,0,0,0.85) 面板平切掉一半。
    // 只给满点这类高光用 —— 不能把 _fxLayer 整体上移，
    // 那会让 funcFx/dealFx 盖住排名列表和弃牌选择界面。
    this._fxTopLayer = new Sprite();
    this.addChild(this._fxTopLayer);

    this._topLayer = new Sprite();   // 覆盖层之上（弃牌选择用）
    this.addChild(this._topLayer);
};

//--- 绘制工具 --------------------------------------------------------------

Scene_D678.prototype.txt = function (bmp, text, x, y, w, size, color, align) {
    bmp.fontSize = size || 22;
    bmp.textColor = color || COL.white;
    bmp.outlineColor = 'rgba(0,0,0,0.75)';
    bmp.outlineWidth = 4;
    bmp.drawText(text, x, y, w || (LY.SW - x), size + 8, align || 'left');
};
Scene_D678.prototype.box = function (bmp, x, y, w, h, fill, stroke, r) {
    var ctx = bmp._context;
    r = r || 8;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
    ctx.restore();
    bmp._setDirty();
};

//--- 点数字符串 ------------------------------------------------------------

Scene_D678.prototype.totalString = function (b, si, revealAll) {
    var cards = b.sides[si].cards;
    var parts = [], base = 0, visible = 0;
    for (var i = 0; i < cards.length; i++) {
        if (cards[i].hidden && !revealAll) { parts.push('?'); }
        else {
            // 虚空数字写成 (+1) / (-1) / (7)，见 D678.cardFaceStr ——
            // 直接拼数值会得到「7+-1」和看着像 bug 的「7+7」。
            parts.push(D678.cardFaceStr(cards[i]));
            base += cards[i].v; visible++;
        }
    }
    if (visible === 0) return parts.join('+') + '=?';
    // 规则+1/-1 时显示成 “1+2+3=6+3”：等号后是牌面合计，再挂上修正总量，
    // 不再画出最终点数（最终点数由下面的大字/结算显示）。
    var s = parts.join('+') + '=' + base;
    var m = b.mod();
    if (m !== 0) {
        // 修正量按“手上所有牌”算，含看不见的暗牌 —— 只数明牌会少算，
        // 例如对方 ?(6)+7+11 在 rule-1 下应显示 18-3 而不是 18-2。
        var d = m * cards.length;
        s += (d >= 0 ? '+' : '-') + Math.abs(d);
    }
    return s;
};

//--- 卡牌精灵 --------------------------------------------------------------

// 卡牌精灵的身份。
//
// 【用 uid 不用下标】原来是 si_idx_值_正反，而「删掉中间那张牌」会让后面所有
// 牌的下标往前挪、key 全变 —— refreshCards 把它们当新牌一起重新入场。
// 实际症状：用过「抽暗牌」之后再「重抽」，暗牌和新抽的明牌一起飞进来
// （抽暗牌把暗牌 push 到末尾，于是明牌在中间，repick 删的就是中间那张）。
// rob / return 删的也是 newestUp，同样可能是中间那张。
//
// uid 由 D678.mkCard 发，整局唯一、只增不减，删谁都不影响别人。
// 值和正反仍然进 key —— 互换明牌（swap）改的是 v、揭牌改的是正反，
// 这两种都该重画。
Scene_D678.prototype.cardKey = function (si, idx, c, revealAll) {
    var shown = (si === 0 || revealAll || !c.hidden);
    // uid 缺失时退回下标（AI 推演盘面、以及万一有没走 mkCard 的旧路径）
    var id = (c.uid === undefined || c.uid === null) ? ('i' + idx) : c.uid;
    // face / fake 也进 key：互换明牌会把「假」连同数值一起换走（见 useFunc 的
    // swap 分支），此时 uid 和正反都没变，只有这两个字段变了 —— 不进 key
    // 的话精灵会留着旧卡图和旧染色，画面上那张牌还是原来的样子。
    return si + '_u' + id + '_' + c.v + '_' + (shown ? 'f' : 'b') +
        (c.face ? '_' + c.face : '') + (c.fake ? '_k' : '');
};

Scene_D678.prototype.refreshCards = function () {
    var b = this._battle;
    var used = {};
    if (b) {
        for (var si = 0; si < 2; si++) {
            var cards = b.sides[si].cards;
            var n = cards.length;
            var span = Math.min(LY.CARD_W + 12, Math.floor(660 / Math.max(n, 1)));
            var totalW = span * (n - 1) + LY.CARD_W;
            var sx = Math.floor((LY.SW - totalW) / 2);
            var y = (si === 0) ? LY.MY_CARD_Y : LY.OPP_CARD_Y;
            for (var i = 0; i < n; i++) {
                var c = cards[i];
                var key = this.cardKey(si, i, c, b.revealed);
                used[key] = true;
                var sp = this._cardSprites[key];
                var shown = (si === 0 || b.revealed || !c.hidden);
                if (!sp) {
                    // face 优先于数值：+1/-1 是 v=1/-1 的假牌，但要显示自己的
                    // 卡图而不是「1」号牌。复制品没有 face，显示成数值 + 染色。
                    sp = new Sprite(ImageManager.loadPicture(
                        shown ? (c.face || String(c.v)) : 'cardback'));
                    sp.scale.x = sp.scale.y = LY.CARD_W / D678.CARD_W;
                    sp.opacity = 0;
                    sp.x = LY.SW / 2 - LY.CARD_W / 2;
                    sp.y = 420;
                    this._cardLayer.addChild(sp);
                    this._cardSprites[key] = sp;
                    sp._new = true;
                }
                sp._tx = sx + span * i;
                sp._ty = y;
                // 我方暗牌：自己看得见牌面，但压一层淡黑蒙版提示“对方看不到这张”。
                // 结算翻牌后大家都看得见了，蒙版随之撤掉。
                // setColorTone 内部会比对数值，重复设同一个值不会有额外开销，
                // 且图片异步加载完成后会自动重新套用，所以每次刷新都直接设。
                var masked = (si === 0 && c.hidden && !b.revealed);
                // 【虚空数字一律染色，+1/-1 也染】原来只染没有专属卡图的那种
                // （复制品），理由是「+1/-1 有自己的卡图，不会被误认成真牌」。
                // 但染色的意义是标出「这张牌不来自牌库」这个共同属性 ——
                // 三张虚空数字应该一眼看出是同一类，所以条件只看 fake。
                // 虚空数字不可能是暗牌（一律正面打出），两种色调互斥，不用叠加。
                var tone = [0, 0, 0, 0];
                if (masked) tone = D678.HOLE_TONE;
                else if (c.fake && shown) tone = D678.FAKE_TONE;
                sp.setColorTone(tone);
            }
        }
    }
    for (var k in this._cardSprites) {
        if (!used[k]) {
            var s2 = this._cardSprites[k];
            this._cardLayer.removeChild(s2);
            delete this._cardSprites[k];
        }
    }
    // 离开对局画面（轮结果 / 赛事结束）时，规则牌精灵一并收起
    if (!b && this._ruleSprite) this._ruleSprite.visible = false;
};

Scene_D678.prototype.updateCardSprites = function () {
    for (var k in this._cardSprites) {
        var sp = this._cardSprites[k];
        if (sp._tx === undefined) continue;
        sp.x += (sp._tx - sp.x) * 0.28;
        sp.y += (sp._ty - sp.y) * 0.28;
        if (Math.abs(sp._tx - sp.x) < 1) sp.x = sp._tx;
        if (Math.abs(sp._ty - sp.y) < 1) sp.y = sp._ty;
        if (sp.opacity < 255) sp.opacity += 24;
    }
};

//--- 主界面刷新 ------------------------------------------------------------

Scene_D678.prototype.refresh = function () {
    this.refreshCards();
    var bmp = this._uiBmp;
    bmp.clear();
    this._hits = [];
    this.drawHpBar();
    var b = this._battle;
    if (b) {
        this.drawBattle(b);
    }
    // 非对局画面（轮结果 / 结束）的内容由下面的 refresh 覆写统一绘制，
    // 这里不再画 notice，否则会压在对战记录面板上。
    this.drawOverlay();
};

// 界面上怎么称呼一个玩家。
//
// 【单机：自己一律「你」】单机是一个人打 7 个 AI，界面本来就在用第二人称
// 跟玩家说话（「你被淘汰了」「你是本届冠军」），名字那儿再冒出昵称就成了
// 第三人称。那 7 个 AI 的名字是随机排的，自己是谁不需要靠昵称认。
//
// 【多人：自己显示昵称】（2026-08-05 你定的）同桌是真人，排名表 / 拼点 /
// 结算这些地方我和别人是并排列出来的 —— 别人那几行是昵称，我这行写「你」
// 就成了两套口径，看排名时得先在心里做一次换算。血条那个「你」是例外，
// 由 hpSelfLabel() 单独管：那一行只有我自己，标的是「这条命是谁的」，
// 不是在一堆人里指认我。
//
// 【只改显示，不改数据】`p.name` / `vsLog` 里的名字 / 服务器下发的名字
// 全都不动 —— 那些是数据，改了会连累 AI 避重名（rollAINames）、
// 联机的座位识别、以及日志里存的历史记录。
Scene_D678.prototype.dispName = function (p) {
    if (!p) return '';
    if (!p.isHuman) return p.name;
    // 多人下昵称理论上一定有（大厅不让空名进房），但盘面异常时别画成空白
    return this._net ? (p.name || '你') : '你';
};
// 日志行用的那份：log 里只有 name 字符串和 side，没有玩家对象。
// side 0 恒是自己 —— 联机下服务器按人做过镜像，客户端永远把自己当 side 0
// （见 _test_leak.js 的「自己永远 side 0」那条）。
// 多人下这一栏和对手的动作行交替出现，所以同样用昵称，口径跟 dispName 一致。
Scene_D678.prototype.dispLogName = function (e) {
    if (!e) return '';
    if (e.side !== 0) return e.name;
    return this._net ? (e.name || '你') : '你';
};

// 血条左侧那个标签。这一行只有我自己，所以单机多人都写「你」——
// 多人下别处（排名 / 拼点 / 结算）都改成昵称了，这里是有意留的例外。
// 多人返空串：678net.js 的 drawHpBar 包装要在同一个位置画自己那份
// （灰色 + 让位给回合倒计时），两边都画会叠字。
Scene_D678.prototype.hpSelfLabel = function () {
    return this._net ? '' : '你';
};

Scene_D678.prototype.drawHpBar = function () {
    var bmp = this._uiBmp, me = D678.Game.human();
    this.box(bmp, 12, 10, 696, 56, 'rgba(0,0,0,0.45)', COL.line, 10);
    this.txt(bmp, this.hpSelfLabel(), 26, 22, 120, 24, COL.white);
    var w = 300, x = 110, y = 30;
    var ratio = Math.max(0, Math.min(1, me.hp / D678.START_HP));
    this.box(bmp, x, y, w, 18, 'rgba(255,255,255,0.15)', null, 6);
    if (ratio > 0) this.box(bmp, x, y, Math.floor(w * ratio), 18,
        ratio > 0.4 ? '#4be08a' : '#ff6b6b', null, 6);
    // HP 后面挂上「此刻输一局至少掉多少血」（底伤 + 累计败场）——
    // 败场越多这个数越大，玩家该知道自己现在输一局有多贵
    this.txt(bmp, 'HP ' + me.showHp() + '（-' + me.lossPenalty() + '）',
        x + w + 12, 20, 180, 24, COL.gold);
    this.txt(bmp, this._showList ? '▲ 收起' : '▼ 排名', 590, 22, 110, 22, COL.blue);
    this._hits.push({ x: 12, y: 10, w: 696, h: 56, cb: this.onToggleList.bind(this) });
    this.txt(bmp, '第 ' + D678.Game.round + ' 轮   存活 ' + D678.Game.alivePlayers().length + ' 人',
        26, 72, 400, 20, COL.gray);
};

Scene_D678.prototype.drawBattle = function (b) {
    var bmp = this._uiBmp;
    var opp = b.players[1];
    this.drawOppName(opp);
    this.txt(bmp, 'HP ' + opp.showHp() + '（-' + opp.lossPenalty() + '）',
        0, 130, LY.SW, 20, COL.gray, 'center');

    // 对方点数
    this.txt(bmp, this.totalString(b, 1, b.revealed), 0, 350, LY.SW, 30,
        b.revealed ? COL.gold : COL.white, 'center');
    // 我方点数
    this.txt(bmp, this.totalString(b, 0, true), 0, 610, LY.SW, 30, COL.white, 'center');
    // 底牌标记
    this.txt(bmp, '（左起第一张为底牌）', 0, 812, LY.SW, 16, COL.gray, 'center');

    // 场上生效的规则牌实体（原来的“规则：…”文字已去掉，改为点卡查看）
    this.drawRuleCard(b);

    // 回合（居中）
    var turnTxt = b.finished ? '结算' : (b.turn === 0 ? '我方回合' : '对方回合');
    this.txt(bmp, turnTxt, 0, 420, LY.SW, 26, b.turn === 0 ? COL.aqua : COL.orange, 'center');

    // 对方行为日志（靠右）
    if (this._msgs.length) {
        this.txt(bmp, '对方动作', 380, 452, 316, 16, COL.gray, 'right');
        for (var i = 0; i < this._msgs.length; i++) {
            this.txt(bmp, this._msgs[i], 380, 474 + i * 24, 316, 20, COL.white, 'right');
        }
    }

    // 未见的牌：不会让我方爆牌的牌标金色
    this.drawUnseen(b, 24, 540);

    // 查看牌库结果
    if (b.sides[0].checkN > 0) {
        var top = b.deck.slice(0, b.sides[0].checkN);
        this.txt(bmp, '牌库顶：' + top.join('  '), 24, 566, 680, 20, COL.gold);
    }

    this.drawFuncHand(b);
    this.drawButtons(b);

    // 提示：画在最后，作为底部横幅，避免压住右侧的对方动作日志
    if (this._noticeTime > 0 && this._notice) {
        this.box(bmp, 40, 1100, 640, 46, 'rgba(0,0,0,0.82)', COL.red, 8);
        this.txt(bmp, this._notice, 40, 1111, 640, 24, COL.red, 'center');
    }
};

// 对手名字 + 后缀「（胜率x%　功能牌n）」。
// 名字本身仍然居中（位置和以前一致），后缀紧跟在名字右边，
// 字号比名字小、用灰色，与「第 X 轮」那行同一个色阶。
Scene_D678.prototype.drawOppName = function (opp) {
    var bmp = this._uiBmp;
    var NAME_SIZE = 30, SUB_SIZE = 20;
    var suffix = '（胜率' + opp.rateText(opp.winRate()) +
                 '　功能牌' + opp.funcs.length + '）';
    bmp.fontSize = NAME_SIZE;
    var nameW = bmp.measureTextWidth(opp.name);
    var nx = Math.floor((LY.SW - nameW) / 2);
    this.txt(bmp, opp.name, nx, 96, nameW + 8, NAME_SIZE, COL.gold, 'left');
    // 小字基线对齐到名字的视觉中线：(30+8)/2 - (20+8)/2 = 5
    this.txt(bmp, suffix, nx + nameW + 4, 96 + 5, LY.SW - (nx + nameW), SUB_SIZE,
        COL.gray, 'left');
};

// 场上生效的规则牌：在规则文字下方摆一张实体卡，纯展示。
// 它只读 b.rule，不参与任何流转 —— 规则牌用掉后回公共池、被后一张覆盖，
// 都由 useFunc 那边照原逻辑处理，这里只是跟着 b.rule 变化重画。
Scene_D678.prototype.drawRuleCard = function (b) {
    var bmp = this._uiBmp;
    var x = LY.RULE_X, y = LY.RULE_Y;
    var w = LY.RULE_W, h = Math.round(w * D678.CARD_H / D678.CARD_W);
    this.syncRuleSprite(b.rule, x, y, w);
    if (!b.rule) return;          // 没有规则牌就空着，不画占位框
    // 卡图由精灵绘制，这里只描边 + 在下方标名字
    this.box(bmp, x - 3, y - 3, w + 6, h + 6, null, COL.purple, 7);
    this.txt(bmp, D678.funcName(b.rule), x - 12, y + h + 4, w + 24, 14, COL.purple, 'center');
    // 点卡查看当前规则详情
    this._hits.push({ x: x - 3, y: y - 3, w: w + 6, h: h + 20,
        cb: this.onToggleRuleInfo.bind(this) });
};

// 规则详情浮窗：点场上的规则牌打开，点任意处关闭
Scene_D678.prototype.onToggleRuleInfo = function () {
    this._showRule = !this._showRule;
    this.refresh();
};

Scene_D678.prototype.drawRuleInfo = function () {
    var b = this._battle;
    if (!b || !b.rule) { this._showRule = false; return; }
    var bmp = this._ovBmp;
    var f = D678.funcData(b.rule);
    var lines = (f ? f.desc : '').split('\n');
    var w = 600, x = (LY.SW - w) / 2, y = 300;
    var h = 150 + lines.length * 26;
    this.box(bmp, 0, 0, LY.SW, LY.SH, 'rgba(0,0,0,0.6)', null, 0);
    this.box(bmp, x, y, w, h, 'rgba(0,0,0,0.92)', COL.purple, 12);
    this.txt(bmp, '当前规则', x, y + 16, w, 20, COL.gray, 'center');
    this.txt(bmp, f ? f.name : b.rule, x, y + 46, w, 30, COL.purple, 'center');
    this.txt(bmp, this.ruleGoalString(b), x, y + 88, w, 22, COL.gold, 'center');
    for (var i = 0; i < lines.length; i++) {
        this.txt(bmp, lines[i], x + 28, y + 126 + i * 26, w - 56, 18, COL.white, 'left');
    }
    this.txt(bmp, '点击任意处关闭', 0, y + h + 12, LY.SW, 18, COL.gray, 'center');
    this._hits.push({ x: 0, y: 0, w: LY.SW, h: LY.SH, cb: this.onToggleRuleInfo.bind(this) });
};

// 规则说明面板上那行金字。
// 【不能一律写「目标 N 点」】改判定方式的三张没有目标点数这回事，
// 照着写会直接骗玩家（牛牛下会写成「目标 21 点」）。
Scene_D678.prototype.ruleGoalString = function (b) {
    if (b.isCowRule()) {
        return '凑十取余，点数越大越好（10 点为牛牛）；每人最多 ' +
               D678.COW_MAX_CARDS + ' 张牌';
    }
    // 牛牛占着规则位但已失效（有人超张数）—— 不能只写「目标 21 点」，
    // 那样玩家看不出自己那张规则牌为什么不起作用了。
    if (b.rule === 'rulecow') {
        return '牛牛已失效（有一方超过 ' + D678.COW_MAX_CARDS +
               ' 张牌），目标 ' + b.target() + ' 点';
    }
    if (b.isMoreRule())   return '张数多者胜，超过 21 点仍算爆牌';
    if (b.isHiddenRule()) return '只算暗牌，目标 21 点';
    return '目标 ' + b.target() + ' 点';
};

// 规则牌精灵：常驻一个，随 b.rule 换图 / 隐藏
Scene_D678.prototype.syncRuleSprite = function (id, x, y, w) {
    if (!this._ruleSprite) {
        this._ruleSprite = new Sprite();
        this._cardLayer.addChild(this._ruleSprite);
    }
    var sp = this._ruleSprite;
    if (!id) { sp.visible = false; return; }
    var f = D678.funcData(id);
    if (!f) { sp.visible = false; return; }
    sp.bitmap = ImageManager.loadPicture(f.img);
    sp.scale.x = sp.scale.y = w / D678.CARD_W;
    sp.x = x; sp.y = y;
    sp.visible = true;
};

// 未见的牌逐张绘制：
//   能凑成满点的那张 -> 红色
//   抽到后不会爆牌   -> 金色
//   抽到后会爆牌     -> 灰色
// 抽到这张牌之后是「满点 / 好 / 坏」。
//
// 【为什么不能只看爆不爆】牛牛下没有爆牌，按老逻辑每张都是「安全」=> 全部金色，
// 这一行就不再传递任何信息了。规则暗牌下抽明牌对成绩分毫不差，
// 每张都该是灰的（抽了白抽）。所以统一改成「抽了之后成绩是变好还是变坏」，
// 判定口径跟 AI 的 canImprove 一致，都走 cmpScore。
Scene_D678.prototype.unseenTone = function (b, v) {
    var curS = b.scoreOf(0);
    var dv = b.scoreDelta(v, false);                 // 抽到的是明牌
    var t = curS.total + dv;
    if (b.isBustVal(t)) return 'bad';
    var rc = b.isCowRule()
        ? D678.cowReachAdd(D678.cowReach(b.scoreVals(0)), dv) : null;
    var s = D678.AI.scoreFromTotal(b, 0, t, b.countCards(0, false) + 1,
        rc ? rc[0] : undefined);
    if (s.max) return 'max';
    return D678.cmpScore(s, curS) > 0 ? 'good' : 'bad';
};

Scene_D678.prototype.drawUnseen = function (b, x, y) {
    var bmp = this._uiBmp;
    var uns = this.unseenForPlayer(b);
    var label = '未见的牌：';
    this.txt(bmp, label, x, y, 200, 20, COL.gray, 'left');
    bmp.fontSize = 20;
    var cx = x + bmp.measureTextWidth(label) + 6;
    if (!uns.length) { this.txt(bmp, '无', cx, y, 100, 20, COL.gray, 'left'); return; }
    for (var i = 0; i < uns.length; i++) {
        var v = uns[i];
        var tone = this.unseenTone(b, v);
        var s = String(v);
        bmp.fontSize = 20;
        var tw = bmp.measureTextWidth(s);
        // 满点牌用红色，能变好的金色，变坏/会爆的灰色
        this.txt(bmp, s, cx, y, 60, 20,
            tone === 'max' ? COL.red : (tone === 'good' ? COL.gold : COL.gray), 'left');
        bmp.fontSize = 20;
        cx += tw + 14;
    }
};

// 假牌（+1/-1/复制品）不算 —— 它不占牌库里的名额，把它记成「这个号出现过」
// 会让这一行少列一张真牌。和 678core.js 里 D678.AI.unseen 同一个道理。
Scene_D678.prototype.unseenForPlayer = function (b) {
    var known = {}, i;
    var mine = b.sides[0].cards, opp = b.sides[1].cards;
    for (i = 0; i < mine.length; i++) { if (!mine[i].fake) known[mine[i].v] = true; }
    for (i = 0; i < opp.length; i++) {
        if (opp[i].fake) continue;
        if (!opp[i].hidden || b.revealed) known[opp[i].v] = true;
    }
    var out = [];
    for (var v = 1; v <= 11; v++) { if (!known[v]) out.push(v); }
    return out;
};

// 二选一的选择面板：占掉功能牌区，其余画面照旧。
//
// 【只占功能牌区，不盖场面】（你定的）玩家要看着双方点数、未见的牌、
// 当前规则才能决定选哪张 —— 面板铺满屏幕的话等于让人闭着眼选。
// 所以只占 y=830 往下那一条，牌桌和点数全程可见。
//
// 【2026-08-05 改掉了半透明蒙版，换成不透明面板 + 直接藏掉功能牌】（你定的）
// 原来那版有两个毛病，根子都是**层级**：
//   1. 蒙版画在 `_uiBmp`（= `_uiSprite`），而功能牌精灵在 `_cardLayer`，
//      建的时候 `_cardLayer` 在前、`_uiSprite` 在后 —— 位图在精灵之上，
//      所以 0.78 的黑压不掉功能牌，只把它压暗成 22% 透出来，
//      正好糊在两张候选牌周围，候选牌反而看不清。
//   2. 更糟的是候选牌精灵也在 `_cardLayer`，等于**连要看的那两张一起压暗**。
// 现在：功能牌精灵直接 `visible = false`（不靠蒙版遮），面板用不透明底，
// 候选牌精灵挪到 `_topLayer`（在 `_uiSprite` 之上，弃牌面板早就这么干了，
// 见 syncDiscardSprites）—— 谁也压不到它。
Scene_D678.prototype.drawPick2 = function (b) {
    var bmp = this._uiBmp;
    var vals = b.pending2.vals;
    // 【先把功能牌藏掉】不是靠蒙版遮，是真的不画 —— 传空数组让所有
    // 功能牌精灵 visible = false。不做这一步的话上一帧的手牌会一直留在屏幕上。
    this.syncFuncSprites([], 20, LY.FUNC_Y);
    // 不透明面板（原来是 0.78 半透明蒙版）。候选牌在 _topLayer，不受它影响。
    this.box(bmp, 20, 830, LY.SW - 40, 340, 'rgba(6,20,14,0.97)', COL.gold, 12);
    this.txt(bmp, '二选一：选择要留下的牌', 0, 842, LY.SW, 24, COL.gold, 'center');
    this.txt(bmp, '另一张会被塞入牌库底部', 0, 872, LY.SW, 18, COL.gray, 'center');

    // 两张候选并排画在面板中间。
    // 【y 从 FUNC_Y+20=900 挪到 906，并且副标题收到 872】原来副标题底边 894、
    // 金框顶边 895，只差 1px，而 txt 的描边（outlineWidth 4）还会再往外溢 ——
    // 看上去就是字压在卡图上。现在副标题底边 890、金框顶边 901，留 11px。
    var cw = LY.FCARD_W, gap = 60;
    var totalW = cw * 2 + gap;
    var x0 = (LY.SW - totalW) / 2;
    var y = 906;
    this.syncPick2Sprites(vals, x0, y, gap);
    for (var i = 0; i < 2; i++) {
        var x = x0 + (cw + gap) * i;
        this.box(bmp, x - 5, y - 5, cw + 10, LY.FCARD_H + 10, null, COL.gold, 8);
        // 点数写在卡图下方，卡图底边 y+125=1031，这行 1040 起，留 9px
        this.txt(bmp, String(vals[i]) + ' 点', x - 6, y + LY.FCARD_H + 9,
            cw + 12, 20, COL.white, 'center');
        this._hits.push({ x: x - 5, y: y - 5, w: cw + 10, h: LY.FCARD_H + 34,
            cb: this.onPick2.bind(this, i) });
    }
};

// 候选牌的精灵。跟功能牌区那套分开管（key 带 'p2' 前缀），
// 免得选完之后残留的精灵被当成功能牌复用。
//
// 【放 _topLayer 不放 _cardLayer】`_cardLayer` 在 `_uiSprite` 之下，
// 面板底色会把候选牌压暗（原来就是这个毛病）。`_topLayer` 是最上层，
// 弃牌面板的卡图也放那儿（syncDiscardSprites）—— 同一个道理，同一个做法。
Scene_D678.prototype.syncPick2Sprites = function (vals, x0, y, gap) {
    if (!this._p2Sprites) this._p2Sprites = {};
    var used = {};
    for (var i = 0; i < vals.length; i++) {
        var key = 'p2-' + i + '-' + vals[i];
        used[key] = true;
        var sp = this._p2Sprites[key];
        if (!sp) {
            sp = new Sprite(ImageManager.loadPicture(String(vals[i])));
            sp.scale.x = sp.scale.y = LY.FCARD_W / D678.CARD_W;
            this._topLayer.addChild(sp);
            this._p2Sprites[key] = sp;
        }
        sp.x = x0 + (LY.FCARD_W + gap) * i;
        sp.y = y;
        sp.visible = true;
    }
    this.clearPick2Sprites(used);
};
// 清掉不再需要的候选精灵。传 keep 就只留那几个，不传就全清（选完时用）。
Scene_D678.prototype.clearPick2Sprites = function (keep) {
    if (!this._p2Sprites) return;
    for (var k in this._p2Sprites) {
        if (keep && keep[k]) continue;
        this._topLayer.removeChild(this._p2Sprites[k]);
        delete this._p2Sprites[k];
    }
};

Scene_D678.prototype.onPick2 = function (idx) {
    var b = this._battle;
    if (!b || !b.pending2 || b.pending2.side !== 0) return;
    this.pick2Commit(idx);
};

// 落实选择。单机直接调规则层；联机那份在 678net.js 里覆写成发请求。
Scene_D678.prototype.pick2Commit = function (idx) {
    var b = this._battle;
    var r = b.pick2Resolve(0, idx);
    if (!r) return;
    this.clearPick2Sprites(null);
    this.funcFx();
    this.afterPlayerAction();
};

Scene_D678.prototype.drawFuncHand = function (b) {
    var bmp = this._uiBmp;
    var me = D678.Game.human();
    // 待选期间功能牌区整个让给选择面板：不能再出别的牌，也不能要牌/过牌
    if (b.pending2 && b.pending2.side === 0) { this.drawPick2(b); return; }
    this.clearPick2Sprites(null);
    // 多人模式超过上限是服务器当场随机弃掉多余的（不像单机让玩家自己挑），
    // 所以这条规则要写在界面上 —— 只在结算后弹一句「已随机弃掉 XX」的话，
    // 玩家攒到 5、6 张时没有预期，突然少两张。
    //
    // 【必须按 _net 分】这个函数单机联机共用，而这条规则只对联机成立。
    // 不分的话单机也会显示「自动丢弃」，那是假的（单机是手动挑）。
    // 宽度从 300 放到 640 才装得下这一整行。
    var cap = '功能牌 ' + me.funcs.length + '/' + D678.MAX_FUNC;
    if (this._net) {
        cap += '（多人模式下超过 ' + D678.MAX_FUNC + ' 张自动随机丢弃）';
    }
    this.txt(bmp, cap, 20, 846, 640, 18, COL.gray);
    this.syncFuncSprites(me.funcs, 20, LY.FUNC_Y);
    var span = Math.min(LY.FCARD_W + 24, Math.floor(680 / Math.max(me.funcs.length, 1)));
    for (var i = 0; i < me.funcs.length; i++) {
        var x = 20 + span * i;
        var sel = (this._selFunc === i);
        if (sel) this.box(bmp, x - 4, LY.FUNC_Y - 4, LY.FCARD_W + 8, LY.FCARD_H + 8, null, COL.gold, 6);
        this.txt(bmp, D678.funcName(me.funcs[i]), x - 6, LY.FUNC_Y + LY.FCARD_H + 2,
            LY.FCARD_W + 12, 16, sel ? COL.gold : COL.white, 'center');
        this._hits.push({ x: x, y: LY.FUNC_Y, w: LY.FCARD_W, h: LY.FCARD_H + 20,
            cb: this.onFuncTouch.bind(this, i) });
    }
    if (this._selFunc !== null && me.funcs[this._selFunc]) {
        var f = D678.funcData(me.funcs[this._selFunc]);
        this.box(bmp, 16, 1026, 688, 140, 'rgba(0,0,0,0.55)', COL.line, 8);
        this.txt(bmp, f.name, 30, 1030, 300, 22, COL.gold);
        // 说明文字限宽到 480，右侧留给「使用」大按钮，两者不重叠
        var lines = f.desc.split('\n');
        for (var j = 0; j < lines.length; j++) {
            this.txt(bmp, lines[j], 30, 1058 + j * 24, 480, 18, COL.white);
        }
        this.drawUseButton(b);
    }
};

// 「使用」按钮：做成醒目的实心大按钮，和说明面板明显区分，避免误触
Scene_D678.prototype.drawUseButton = function (b) {
    var bmp = this._uiBmp;
    var x = 522, y = 1046, w = 168, h = 100;
    var usable = (b && !b.finished && b.turn === 0 && this._phase === 'battle');
    var ctx = bmp._context;
    ctx.save();
    // 外发光，把按钮从面板里"抬"出来
    if (usable) {
        this.box(bmp, x - 5, y - 5, w + 10, h + 10, 'rgba(255,215,102,0.22)', null, 12);
    }
    ctx.restore();
    this.box(bmp, x, y, w, h,
        usable ? 'rgba(70,175,110,0.95)' : 'rgba(70,70,70,0.7)',
        usable ? COL.gold : COL.line, 10);
    // 顶部高光
    this.box(bmp, x + 6, y + 5, w - 12, 30, 'rgba(255,255,255,0.18)', null, 7);
    this.txt(bmp, '使 用', x, y + 32, w, 34, usable ? COL.white : '#888', 'center');
    if (usable) {
        this._hits.push({ x: x, y: y, w: w, h: h, fx: true,
                          cb: this.onUseFunc.bind(this) });
    }
};

Scene_D678.prototype.syncFuncSprites = function (ids, x0, y0) {
    if (!this._funcSprites) this._funcSprites = [];
    var span = Math.min(LY.FCARD_W + 24, Math.floor(680 / Math.max(ids.length, 1)));
    while (this._funcSprites.length < ids.length) {
        var sp = new Sprite();
        sp.scale.x = sp.scale.y = LY.FCARD_W / D678.CARD_W;
        this._cardLayer.addChild(sp);
        this._funcSprites.push(sp);
    }
    for (var i = 0; i < this._funcSprites.length; i++) {
        var s = this._funcSprites[i];
        if (i < ids.length) {
            var f = D678.funcData(ids[i]);
            s.bitmap = ImageManager.loadPicture(f.img);
            s.x = x0 + span * i; s.y = y0; s.visible = true;
        } else { s.visible = false; }
    }
};

Scene_D678.prototype.drawButtons = function (b) {
    var bmp = this._uiBmp;
    // pick2Waiting 也要算进来：待选期间 onHit/onStand 本来就会拒（弹「请先选一张」），
    // 但按钮还画成亮的、还注册命中区 —— 看着能点、点了被拒，和 _showList
    // 那几个的处理不一致。压暗掉更老实。
    var active = (b && !b.finished && b.turn === 0 && this._phase === 'battle' &&
        !this._showList && !this._discardFor && !this._showRule &&
        !this.pick2Waiting());
    var bw = 300, bh = 68;
    var y = LY.BTN_Y;
    var canHit = active && b.canHit(0);
    this.box(bmp, 30, y, bw, bh, canHit ? 'rgba(60,140,90,0.85)' : 'rgba(60,60,60,0.6)', COL.line, 10);
    this.txt(bmp, '要牌', 30, y + 18, bw, 28, canHit ? COL.white : '#888', 'center');
    this.box(bmp, 390, y, bw, bh, active ? 'rgba(150,110,40,0.85)' : 'rgba(60,60,60,0.6)', COL.line, 10);
    this.txt(bmp, '过牌', 390, y + 18, bw, 28, active ? COL.white : '#888', 'center');
    if (active) {
        // fx: true —— 点中时放一下高光脉冲（见 updateInput / tapFx）
        this._hits.push({ x: 30, y: y, w: bw, h: bh, fx: true,
                          cb: this.onHit.bind(this) });
        this._hits.push({ x: 390, y: y, w: bw, h: bh, fx: true,
                          cb: this.onStand.bind(this) });
    }
};

//=============================================================================
// 覆盖层：排名列表 / 弃牌选择
//=============================================================================

Scene_D678.prototype.drawOverlay = function () {
    var bmp = this._ovBmp;
    bmp.clear();
    if (this._discardFor) { this._hits = []; this.drawDiscard(); return; }
    if (this._showList) { this.drawRankList(); return; }
    if (this._showRule) { this.drawRuleInfo(); return; }
    // 满点演出期间压住面板，让大字独占画面（_panelHold 由 update 递减）
    if (this._panelHold > 0) return;
    if (this._phase === 'resolve' || this._phase === 'tie') { this.drawShowdown(); return; }
};

// 拼点结果：双方最终点数用大字并排，中间一行大字写谁获胜，下方列出本局对战日志
Scene_D678.prototype.drawShowdown = function () {
    var b = this._battle, r = b && b.result;
    if (!r || !r.totals) return;
    var bmp = this._ovBmp, opp = b.players[1];
    var t0 = r.totals[0], t1 = r.totals[1];

    this.box(bmp, 60, 300, 600, 380, 'rgba(0,0,0,0.85)', COL.gold, 14);

    // 对方
    this.txt(bmp, opp.name, 60, 318, 600, 24, COL.gray, 'center');
    this.drawShowdownTotal(t1, r.busts[1], r.maxes[1], 348, r, 1);

    // 中间大字：以我方为准写“胜 / 负”，胜为红色、负为绿色。
    // 平局把次数直接写进这个大字里（「平局✖1」「平局✖2」…，你定的）——
    // 平一次这一场的底伤就 +1，次数本身已经把代价说清了，不另加说明文字。
    var mid, midCol;
    if (r.tie)               { mid = '平局✖' + (r.tieCount || 1); midCol = COL.blue; }
    else if (r.winner === 0) { mid = '胜';     midCol = COL.red; }
    else                     { mid = '负';     midCol = COL.green; }
    this.txt(bmp, mid, 60, 434, 600, 54, midCol, 'center');

    // 我方：单机「你」、多人昵称（走 dispName，和排名表 / 结算报表同一个口径）。
    // 上面那行画的是对手昵称，两行并排 —— 多人下这里写「你」就是两套称呼。
    this.txt(bmp, this.dispName(b.players[0]), 60, 512, 600, 24, COL.gray, 'center');
    this.drawShowdownTotal(t0, r.busts[0], r.maxes[0], 542, r, 0);

    // 平局说明（拼点阶段不显示本局扣了多少生命值，伤害只在轮次结算报表里给出）。
    // 平局次数写在上面那个中间大字里，这里不重复。
    if (r.tie) {
        this.txt(bmp, '重新发牌', 60, 622, 600, 26, COL.gray, 'center');
    }
};

// 结算面板里的一行点数。
//
// 数字必须在面板正中间，不管有没有「爆牌 / 满点」后缀 —— 原来是把
// String(t) 和后缀拼成一整串再居中，居中的是「21　满点」这整串，
// 数字就被后缀往左推了。普通情况画的是「18」，居中的就是数字本身，
// 于是满点/爆牌时数字位置和平时对不上，看着就是偏的。
//
// 现在数字独立居中，后缀画在数字右边 —— 数字的位置和有没有后缀无关。
Scene_D678.prototype.drawShowdownTotal = function (t, bust, max, y, r, si) {
    var bmp = this._ovBmp;
    var col = bust ? COL.red : (max ? COL.gold : COL.white);
    var s = String(t);
    var tag = bust ? '爆牌' : (max ? '满点' : '');

    // 【牛牛下点数不是成绩】总点数 24 的成绩是「牛4」，直接画 24 会看不懂。
    // doResolve 把成绩放在 r.cows 里带出来（联机走同一份 result，无需另配）。
    if (r && r.cows) {
        var cow = r.cows[si];
        s = (cow === 0) ? '无牛' : (cow === 10 ? '牛牛' : '牛' + cow);
        if (cow === 0) col = COL.gray;
        tag = '';                        // 「牛牛」本身已经说明是满点
    } else if (r && r.cardCounts) {
        // 比多：判定看的是张数，所以点数根本不该出现在这里 ——
        // 写「5 张　24 点」会让人以为 24 点也参与了胜负。
        // 爆牌是唯一的例外（爆了就直接输，张数多也没用），那时整行只写「爆牌」。
        // 「满点」后缀留着：它不是判定依据，但要多打一点伤害，是玩家该看到的信息。
        s = bust ? '爆牌' : (r.cardCounts[si] + ' 张');
        if (bust) tag = '';
    }

    // 数字居中在面板宽度上（面板 x 60 宽 600）
    this.txt(bmp, s, 60, y, 600, 60, col, 'center');

    if (!tag) return;

    // 后缀紧跟在数字右侧。数字实际宽度要按 60 号字量出来，
    // 不能猜 —— 一位数和两位数差一半宽度。
    bmp.fontSize = 60;
    var numW = bmp.measureTextWidth(s);
    var tagX = 60 + 300 + numW / 2 + 16;      // 面板中线 + 数字半宽 + 间距
    this.txt(bmp, tag, tagX, y + 16, 120, 30, col, 'left');
};

// 排名里的胜负一栏。本轮还没打完时退回上一轮的结果（prev=true 时标注“上轮”），
// 这样对战途中打开排名也能看到所有人最近一次的胜负。
Scene_D678.prototype.lastText = function (p) {
    var e = p.last, prev = false;
    if (!e) { e = p.prevLast; prev = true; }
    if (!e) return { s: '—', c: COL.gray, d: '', prev: false };
    if (e.type === 'bye')  return { s: '轮空', c: COL.gold, d: '', prev: prev };
    if (e.type === 'win')  return { s: '胜', c: COL.red,   d: '', prev: prev };
    return { s: '负', c: COL.green, d: '-' + e.dmg, prev: prev };
};

Scene_D678.prototype.drawRankList = function () {
    var bmp = this._ovBmp;
    this.box(bmp, 12, 70, 696, 640, 'rgba(0,0,0,0.88)', COL.gold, 12);
    this.txt(bmp, '排　名', 0, 80, LY.SW, 24, COL.gold, 'center');
    this.txt(bmp, '（存活者按 HP，淘汰者按淘汰顺序）', 0, 110, LY.SW, 16, COL.gray, 'center');
    var list = D678.Game.rankedPlayers();
    for (var i = 0; i < list.length; i++) {
        var p = list[i], y = 140 + i * 68;
        this.box(bmp, 26, y, 668, 62, p.isHuman ? 'rgba(80,120,60,0.5)' : 'rgba(255,255,255,0.06)',
            p.alive ? COL.line : 'rgba(255,80,80,0.4)', 8);
        this.txt(bmp, String(i + 1), 36, y + 6, 40, 22, COL.gold);
        this.txt(bmp, this.dispName(p), 76, y + 6, 240, 22, p.alive ? COL.white : '#888');
        // 淘汰者 HP 一律显示 0，不露出负数
        var hp = p.showHp();
        this.txt(bmp, 'HP ' + hp, 320, y + 6, 120, 22, hp > 30 ? COL.white : COL.red);
        if (p.alive) {
            var lt = this.lastText(p);
            if (lt.prev && lt.s !== '—') this.txt(bmp, '上轮', 414, y + 9, 40, 16, COL.gray);
            this.txt(bmp, lt.s, 450, y + 6, 60, 24, lt.c);
            this.txt(bmp, lt.d, 500, y + 6, 100, 24, lt.c);
        } else {
            // 淘汰者不显示胜负，改为写明最终名次（名次即排序位置，无需再标淘汰顺序）
            this.txt(bmp, '第' + D678.numCN(i + 1) + '名', 450, y + 6, 160, 22, '#888');
        }
        // 胜率 / 满点率的分母都是真正打完的场次（平局重发，不计入）。
        // 「功能牌N」是手上现有张数，「已使用x次」是整场赛事累计打出的次数。
        this.txt(bmp, '胜' + p.wins + '　负' + p.losses +
            '　胜率' + p.rateText(p.winRate()) +
            '　满点' + p.maxPoint + '(' + p.rateText(p.maxRate()) + ')' +
            '　功能牌' + p.funcs.length +
            '（已使用功能牌' + (p.funcUses || 0) + '次）', 76, y + 32, 616, 16, COL.gray);
    }
    this.txt(bmp, '点击任意处关闭', 0, 676, LY.SW, 18, COL.gray, 'center');
    this._hits.push({ x: 0, y: 0, w: LY.SW, h: LY.SH, cb: this.onToggleList.bind(this) });
};

Scene_D678.prototype.drawDiscard = function () {
    var bmp = this._ovBmp, p = this._discardFor;
    this.box(bmp, 0, 0, LY.SW, LY.SH, 'rgba(0,0,0,0.8)', null, 0);
    this.txt(bmp, '功能牌超过 ' + D678.MAX_FUNC + ' 张，请选择要弃掉的牌', 0, 200, LY.SW, 26, COL.gold, 'center');
    // 只能弃到刚好剩 MAX_FUNC 张：need 是固定张数，不是下限。
    // 选满之后未选中的牌不再注册点击，想换要先取消一张。
    var need = Math.max(0, p.funcs.length - D678.MAX_FUNC);
    var full = (this._discardSel.length >= need);
    this.txt(bmp, '需要弃掉 ' + need + ' 张（已选 ' + this._discardSel.length + ' 张）',
        0, 240, LY.SW, 22, COL.white, 'center');
    // 卡图高度 = 118 * (1020/720) ≈ 167，名字画在卡图下方，避免被卡精灵挡住
    var perRow = 4, x0 = 60, y0 = 320, spanX = 150, spanY = 230;
    var imgH = Math.round(118 * D678.CARD_H / D678.CARD_W);
    for (var i = 0; i < p.funcs.length; i++) {
        var cx = x0 + (i % perRow) * spanX, cy = y0 + Math.floor(i / perRow) * spanY;
        var sel = this._discardSel.indexOf(i) >= 0;
        // 已选够时，其余牌压暗表示点不动了
        var lock = (full && !sel);
        this.box(bmp, cx - 6, cy - 6, 130, imgH + 34,
            sel ? 'rgba(255,80,80,0.35)' : (lock ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.08)'),
            sel ? COL.red : COL.line, 8);
        this.txt(bmp, D678.funcName(p.funcs[i]), cx - 6, cy + imgH + 8, 130, 18,
            sel ? COL.red : (lock ? '#777' : COL.white), 'center');
        if (!lock) {
            this._hits.push({ x: cx - 6, y: cy - 6, w: 130, h: imgH + 34,
                cb: this.onDiscardTouch.bind(this, i) });
        }
    }
    this.syncDiscardSprites(p.funcs, x0, y0, spanX, spanY, perRow, full, this._discardSel);
    if (full) {
        this.txt(bmp, '已选够 ' + need + ' 张，想换请先取消一张', 0, 1090, LY.SW, 18, COL.gray, 'center');
    }
    // 必须恰好选 need 张才能确定
    var ok = (this._discardSel.length === need);
    this.box(bmp, 210, 1130, 300, 70, ok ? 'rgba(60,140,90,0.9)' : 'rgba(70,70,70,0.7)', COL.line, 10);
    this.txt(bmp, '确定', 210, 1148, 300, 28, ok ? COL.white : '#888', 'center');
    if (ok) this._hits.push({ x: 210, y: 1130, w: 300, h: 70, cb: this.onDiscardConfirm.bind(this) });
};

Scene_D678.prototype.syncDiscardSprites = function (ids, x0, y0, spanX, spanY, perRow, full, sel) {
    if (!this._dcSprites) { this._dcSprites = []; }
    while (this._dcSprites.length < ids.length) {
        var sp = new Sprite();
        sp.scale.x = sp.scale.y = 118 / D678.CARD_W;
        this._topLayer.addChild(sp);
        this._dcSprites.push(sp);
    }
    for (var i = 0; i < this._dcSprites.length; i++) {
        var s = this._dcSprites[i];
        if (i < ids.length && this._discardFor) {
            s.bitmap = ImageManager.loadPicture(D678.funcData(ids[i]).img);
            s.x = x0 + (i % perRow) * spanX; s.y = y0 + Math.floor(i / perRow) * spanY;
            s.visible = true;
            // 选够之后点不动的牌连卡图一起压暗，跟外框的压暗保持一致
            var lock = (full && sel && sel.indexOf(i) < 0);
            s.setColorTone(lock ? [-90, -90, -90, 0] : [0, 0, 0, 0]);
        } else s.visible = false;
    }
};

Scene_D678.prototype.clearDiscardSprites = function () {
    if (!this._dcSprites) return;
    for (var i = 0; i < this._dcSprites.length; i++) this._dcSprites[i].visible = false;
};

//=============================================================================
// 输入
//=============================================================================

Scene_D678.prototype.updateInput = function () {
    if (!TouchInput.isTriggered()) return;
    var x = TouchInput.x, y = TouchInput.y;
    for (var i = this._hits.length - 1; i >= 0; i--) {
        var h = this._hits[i];
        if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
            // 反馈要在回调之前放 —— 回调往往立刻换状态重画（要牌之后按钮就
            // 灰掉了），先放特效才保证这一下看得见。特效在 _fxLayer 上，
            // 不受随后 refresh 的影响。
            if (h.fx) {
                this.tapFx(h.x, h.y, h.w, h.h);
                SoundManager.playCursor();
            }
            h.cb();
            return;
        }
    }
    // 满点演出可以点击跳过：赶时间的玩家不必等完整 3.3 秒
    if (this._phase === 'resolve' && this._panelHold > 0) {
        this.skipMaxFx();
        return;
    }
    // 点击空白区域取消功能牌选中
    if (this._selFunc !== null && !this._showList && !this._discardFor) {
        this._selFunc = null;
        this.refresh();
        return;
    }
    if (this._phase === 'roundResult' && this._wait <= 0) this.nextRound();
    // gameover 不再点击即退出：画面保留，只能通过「返回主菜单」按钮离开
};

Scene_D678.prototype.onToggleList = function () {
    this._showList = !this._showList;
    this.refresh();
};
Scene_D678.prototype.onFuncTouch = function (i) {
    this._selFunc = (this._selFunc === i) ? null : i;
    this.refresh();
};
Scene_D678.prototype.onDiscardTouch = function (i) {
    var k = this._discardSel.indexOf(i);
    if (k >= 0) { this._discardSel.splice(k, 1); this.refresh(); return; }
    // 只能弃到刚好剩 MAX_FUNC 张，选满就不再接受新选择
    var need = Math.max(0, this._discardFor.funcs.length - D678.MAX_FUNC);
    if (this._discardSel.length >= need) return;
    this._discardSel.push(i);
    this.refresh();
};
Scene_D678.prototype.onDiscardConfirm = function () {
    var p = this._discardFor;
    var sel = this._discardSel.slice(0).sort(function (a, b) { return b - a; });
    for (var i = 0; i < sel.length; i++) {
        var id = p.funcs.splice(sel[i], 1)[0];
        D678.Game.returnFunc(id);
    }
    this._discardFor = null; this._discardSel = [];
    this.clearDiscardSprites();
    this.afterDiscard();
};

Scene_D678.prototype.notice = function (s) {
    this._notice = s; this._noticeTime = 100;
};

// 跳过满点演出：清掉高光层的特效与排队中的分拍，面板立刻到位。
// _wait 也一并收回到普通结算的长度，避免跳过了却还在干等。
Scene_D678.prototype.skipMaxFx = function () {
    this._fxQueue = [];
    for (var i = this._anims.length - 1; i >= 0; i--) {
        if (this._anims[i].layer === this._fxTopLayer) {
            this._fxTopLayer.removeChild(this._anims[i].s);
            this._anims.splice(i, 1);
        }
    }
    this._panelHold = 0;
    this._panelFade = 1;
    this._shake = 0;
    this.x = 0; this.y = 0;
    this._wait = Math.min(this._wait, 60);
    this.refresh();
};

// 待选期间只能选牌 —— 要牌 / 过牌 / 出别的功能牌一律挡住。
// 【三个入口都要挡】只挡界面按钮不够：联机那份会覆写 onHit/onStand，
// 挡在这一层的话两边都得写一遍，所以做成一个谓词让三处共用。
Scene_D678.prototype.pick2Waiting = function () {
    var b = this._battle;
    return !!(b && b.pending2 && b.pending2.side === 0);
};

Scene_D678.prototype.onHit = function () {
    var b = this._battle;
    if (!b || b.turn !== 0 || b.finished) return;
    if (this.pick2Waiting()) { this.notice('请先在两张牌里选一张'); return; }
    if (!b.canHit(0)) {
        this.notice(b.noHitReason(0));
        this.refresh(); return;
    }
    this._selFunc = null;
    b.act(0, 'hit');
    this.afterPlayerAction();
};

Scene_D678.prototype.onStand = function () {
    var b = this._battle;
    if (!b || b.turn !== 0 || b.finished) return;
    if (this.pick2Waiting()) { this.notice('请先在两张牌里选一张'); return; }
    this._selFunc = null;
    b.act(0, 'stand');
    this.afterPlayerAction();
};

Scene_D678.prototype.onUseFunc = function () {
    var b = this._battle, me = D678.Game.human();
    if (!b || b.turn !== 0 || b.finished) return;
    if (this.pick2Waiting()) { this.notice('请先在两张牌里选一张'); return; }
    if (this._selFunc === null) return;
    var id = me.funcs[this._selFunc];
    if (!id) return;
    var r = b.useFunc(0, id);
    if (!r.ok) { this.notice(r.err || '无法使用'); this.refresh(); return; }
    this.funcFx();
    // 失败原因由 useFunc 给出（抽号牌是「此号牌已在场上」，
    // 复制是「我方没有明牌可以复制」）—— 别写死其中一种
    if (r.fail) this.notice('失败：' + (r.err || '无法使用'));
    // 【重抽一律播完整动画】必须在 refresh 之前动精灵，否则那一帧就已经
    // 复用了旧精灵。收牌用 r.oldValue（洗回去那张的数值），发牌靠扔掉
    // 新牌的精灵让它重新入场。
    if (r.kind === 'repick') this.redealCard(0, r.oldValue);
    this._selFunc = null;
    // 二选一：回合没结束，盘面停在待选上。这里只 refresh 让选择面板出来，
    // 不能走 afterPlayerAction —— 那会去推进回合、让 AI 行动。
    if (r.pending2) { this.refresh(); return; }
    this.afterPlayerAction();
};

// 重抽的完整动画：旧牌飞回牌库 + 新牌重新入场 + 横扫光。
//
// 【为什么不能只靠 key 变化】重抽拿到同一个数字时，新牌的值和正反都和旧牌
// 一样。uid 变了所以 key 也变了、新精灵会入场 —— 但那只有「飞进来」没有
// 「收回去」，看着像牌凭空闪了一下。而玩家反馈最多的正是「用了重抽好像没反应」。
//
// 所以这里做两件事：
//   1. 旧牌：拿它的数值造一个临时精灵，从原位飞回牌库方向再淡出（收牌）
//   2. 新牌：把末尾那张的精灵扔掉，下一次 refreshCards 会新建 ——
//      而新建的精灵天生从画面中央、opacity 0 飞向目标位，和发牌入场同一套
//
// oldValue 可能是 undefined（比如联机下服务器没带过来），那就只播新牌入场，
// 不至于什么都不显示。
Scene_D678.prototype.redealCard = function (si, oldValue) {
    var b = this._battle;
    if (!b) return;
    var cards = b.sides[si].cards;
    if (!cards.length) return;

    // 【新牌不用管】uid 变了所以 key 一定是新的，refreshCards 会自己建精灵、
    // 从画面中央飞过来。原来这儿要手工扔掉旧精灵，那是 key 用下标时代的事：
    // 重抽到同一个数字时 si_idx_值_正反 完全一致，不扔就原地不动。
    //
    // 要做的是**旧牌**那一半：它已经从 cards 里删掉了，但精灵还在
    // （refreshCards 要到下一次调用才会清）。趁它还在，读出坐标当收牌动画的
    // 起点，看起来就是「那张牌从原位飞回牌库」。
    var live = {};
    for (var i = 0; i < cards.length; i++) {
        live[this.cardKey(si, i, cards[i], b.revealed)] = true;
    }
    var fromX = LY.SW / 2 - LY.CARD_W / 2;
    var fromY = (si === 0) ? LY.MY_CARD_Y : LY.OPP_CARD_Y;
    var prefix = si + '_';
    for (var k in this._cardSprites) {
        if (k.indexOf(prefix) !== 0 || live[k]) continue;
        // 这一排里已经不存在的精灵 = 刚被洗回牌库那张
        var sp = this._cardSprites[k];
        fromX = sp.x; fromY = sp.y;
        break;
    }

    if (oldValue !== undefined && oldValue !== null) {
        this.returnCardFx(si, oldValue, fromX, fromY);
    }
    this.redealSweepFx(si);
};

// 收牌：一张牌从 (x,y) 飞向画面中央上方（牌库方向）并淡出、缩小。
// 用临时精灵，不进 _cardSprites —— 它不代表场上的任何一张牌。
Scene_D678.prototype.returnCardFx = function (si, v, x, y) {
    var sp = new Sprite(ImageManager.loadPicture(String(v)));
    sp.scale.x = sp.scale.y = LY.CARD_W / D678.CARD_W;
    sp.x = x; sp.y = y;
    var tx = LY.SW / 2 - LY.CARD_W / 2, ty = 380;   // 牌库方向（和 dealFx 同一处）
    this.addFx(sp, 22, function (s, r) {
        s.x = x + (tx - x) * r;
        s.y = y + (ty - y) * r;
        s.opacity = 255 * (1 - r);
        var k = (LY.CARD_W / D678.CARD_W) * (1 - r * 0.45);
        s.scale.x = s.scale.y = k;
    });
};

// 重抽用的横扫光。不能直接用 dealFx —— 它的 y 固定在 380，那是整局发牌用的
// 位置，正好落在两排牌之间的空档里（对方牌在 y=190，我方在 y=660），
// 两边都不挨着。这里按行定位，光带扫过那一排。
Scene_D678.prototype.redealSweepFx = function (si) {
    var rowY = (si === 0) ? LY.MY_CARD_Y : LY.OPP_CARD_Y;
    var H = LY.CARD_H + 40;
    var bmp = new Bitmap(LY.SW, H), ctx = bmp._context;
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0,    'rgba(255,255,255,0)');
    g.addColorStop(0.5,  'rgba(255,255,255,0.42)');
    g.addColorStop(1,    'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, LY.SW, H);
    bmp._setDirty();

    var sp = new Sprite(bmp);
    sp.y = rowY - 20;
    sp.blendMode = 1;                 // 叠加，像光扫过去
    this.addFx(sp, 26, function (s, r) {
        s.opacity = 220 * (1 - r);
        s.scale.y = 1 + r * 0.5;
    });
};

Scene_D678.prototype.afterPlayerAction = function () {
    var b = this._battle;
    this._wait = 30;
    this.refresh();
    if (b.finished || (b.result && b.result.tie)) this.onBattleEnd();
};

//=============================================================================
// 特效
//=============================================================================

// top 为真时挂到 _fxTopLayer（结算面板之上），否则挂常规特效层
Scene_D678.prototype.addFx = function (sprite, dur, fn, top) {
    var layer = top ? this._fxTopLayer : this._fxLayer;
    layer.addChild(sprite);
    this._anims.push({ s: sprite, t: 0, d: dur, fn: fn, layer: layer });
};

Scene_D678.prototype.updateFx = function () {
    for (var i = this._anims.length - 1; i >= 0; i--) {
        var a = this._anims[i];
        a.t++;
        a.fn(a.s, a.t / a.d, a.t);
        if (a.t >= a.d) {
            (a.layer || this._fxLayer).removeChild(a.s);
            this._anims.splice(i, 1);
        }
    }
};

// 延时若干帧后再放特效：满点演出要分拍，靠它排时序
Scene_D678.prototype.laterFx = function (delay, fn) {
    if (delay <= 0) { fn.call(this); return; }
    this._fxQueue.push({ t: delay, fn: fn });
};

Scene_D678.prototype.updateFxQueue = function () {
    for (var i = this._fxQueue.length - 1; i >= 0; i--) {
        if (--this._fxQueue[i].t <= 0) {
            var fn = this._fxQueue[i].fn;
            this._fxQueue.splice(i, 1);
            fn.call(this);
        }
    }
};

// 震屏：整场景一起偏移。RMMV 的 Scene_Base 没有内建震屏，
// 这里直接推 this.x / this.y，衰减到 0 时归位。
Scene_D678.prototype.shake = function (frames, power) {
    this._shake = frames;
    this._shakePow = power;
};

Scene_D678.prototype.updateShake = function () {
    if (this._shake <= 0) {
        if (this.x !== 0 || this.y !== 0) { this.x = 0; this.y = 0; }
        return;
    }
    this._shake--;
    var p = this._shakePow * (this._shake / 10);      // 线性衰减
    this.x = Math.round((Math.random() - 0.5) * 2 * p);
    this.y = Math.round((Math.random() - 0.5) * 2 * p);
    if (this._shake <= 0) { this.x = 0; this.y = 0; }
};

// 结算面板淡入：满点演出结束后，面板在 MAXFX_FADE 帧内浮出来。
// _ovSprite 是排名列表 / 弃牌界面共用的，所以那些界面打开时一律按全不透明处理，
// 只有正在淡入的结算面板才吃 _panelFade。
Scene_D678.prototype.updatePanelFade = function () {
    if (this._panelHold > 0) {
        this._panelHold--;
        if (this._panelHold > 0) return;
        this.refresh();      // 压制解除，这一帧把面板画进 _ovBmp
        // 这里故意不 return：必须在同一帧把不透明度按 _panelFade(=0) 设好。
        // 否则面板会以全不透明弹出一帧、下一帧再跳回淡入起点，出现一下闪烁。
    }
    if (this._showList || this._discardFor || this._showRule) {
        this._ovSprite.opacity = 255;
        return;
    }
    if (this._panelFade < 1) {
        this._panelFade = Math.min(1, this._panelFade + 1 / D678.MAXFX_FADE);
    }
    this._ovSprite.opacity = Math.round(255 * this._panelFade);
};

Scene_D678.prototype.ringBitmap = function (color) {
    var b = new Bitmap(256, 256), ctx = b._context;
    ctx.strokeStyle = color; ctx.lineWidth = 10;
    ctx.beginPath(); ctx.arc(128, 128, 100, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(128, 128, 76, 0, Math.PI * 2); ctx.stroke();
    b._setDirty();
    return b;
};

// 所有功能牌通用特效
Scene_D678.prototype.funcFx = function (cx, cy) {
    cx = cx === undefined ? LY.SW / 2 : cx;
    cy = cy === undefined ? 500 : cy;
    var sp = new Sprite(this.ringBitmap('#ffd766'));
    sp.anchor.x = sp.anchor.y = 0.5;
    sp.x = cx; sp.y = cy;
    this.addFx(sp, 34, function (s, r) {
        s.scale.x = s.scale.y = 0.3 + r * 1.8;
        s.opacity = 255 * (1 - r);
        s.rotation = r * 1.2;
    });
    var sp2 = new Sprite(this.ringBitmap('#7fd4ff'));
    sp2.anchor.x = sp2.anchor.y = 0.5;
    sp2.x = cx; sp2.y = cy;
    this.addFx(sp2, 26, function (s, r) {
        s.scale.x = s.scale.y = 1.6 - r * 1.2;
        s.opacity = 255 * (1 - r * r);
    });
};

// 按钮点击反馈。
//
// 这个场景的输入是「isTriggered 那一帧直接跑回调」，没有按下/抬起状态，
// 所以按钮天生没有任何反馈 —— 点了要牌、过牌、使用，画面上看不出被点过。
// 补一个短促的高光脉冲：画在 _fxLayer 上（在 _uiBmp 的按钮之上、_ovSprite
// 的面板之下），所以不用改任何绘制函数，也不会盖住排名列表和弃牌界面。
//
// 走现有的 addFx / updateFx 机制，两条 update 路径（正常 + 教程）都会跑到。
Scene_D678.prototype.tapFx = function (x, y, w, h) {
    var pad = 6;
    var bw = w + pad * 2, bh = h + pad * 2;
    // 圆角用 this.box —— 这个文件里没有独立的 roundRect
    var bmp = new Bitmap(bw, bh);
    this.box(bmp, 2, 2, bw - 4, bh - 4, 'rgba(255,255,255,0.42)', '#ffeaa0', 12);

    var sp = new Sprite(bmp);
    sp.anchor.x = sp.anchor.y = 0.5;
    sp.x = x + w / 2;
    sp.y = y + h / 2;
    this.addFx(sp, 14, function (s, r) {
        // 先快速亮起再淡出，同时轻微放大 —— 像按下去弹回来
        s.opacity = 255 * (1 - r * r);
        s.scale.x = s.scale.y = 1 + r * 0.06;
    });
};

// 发牌特效
Scene_D678.prototype.dealFx = function () {
    var b = new Bitmap(LY.SW, 260), ctx = b._context;
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(0, 120, LY.SW, 20);
    b._setDirty();
    var sp = new Sprite(b);
    sp.y = 380;
    this.addFx(sp, 30, function (s, r) {
        s.opacity = 255 * (1 - r);
        s.scale.y = 1 + r * 2;
    });
};

// 揭牌特效
Scene_D678.prototype.revealFx = function () {
    var b = new Bitmap(LY.SW, 200), ctx = b._context;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, LY.SW, 200);
    b._setDirty();
    var sp = new Sprite(b);
    sp.y = LY.OPP_CARD_Y - 20;
    sp.blendMode = 1;
    this.addFx(sp, 28, function (s, r) { s.opacity = 200 * (1 - r); });
};

//--- 满点演出 --------------------------------------------------------------
//
// 演出只放给**胜者**，一次结算最多一次，不必考虑两边同时演出。
//
// 前五张规则牌下「满点必胜」：isMaxVal 要求不爆且恰好等于目标点数，
// 双方都满点则距离相等 -> 平局，doResolve 在 tie 分支就 return 了。
// 但 规则比多 把这条前提打破了 —— 它先比张数，所以恰好 21 点的人可能因为
// 张数少而输。所以触发条件写的是 r.maxes[r.winner]，不是「谁满点」。
//
// 演出放在屏幕正中而不是贴胜者牌区：结算面板占 y 300~680 且几乎不透明，
// 贴牌区必然被平切。居中 + 走 _fxTopLayer + 面板延后淡入，三者一起才不打架。
// 三拍的帧数。写成绝对帧而不是比例，是因为「大字开始淡出」和「面板开始淡入」
// 必须精确对齐同一帧，用比例算两边很容易差出十几帧变成互相打架。
D678.MAXFX_DELAY = 18;   // 第一拍：只翻底牌，等这么久再砸字
D678.MAXFX_SHOW  = 44;   // 第二拍：大字独占画面
D678.MAXFX_FADE  = 16;   // 第三拍：大字淡出 / 面板淡入（同时进行）
// 面板被压住的总帧数 = 前两拍。到这一帧大字开始退、面板开始进。
D678.MAXFX_HOLD  = D678.MAXFX_DELAY + D678.MAXFX_SHOW;
// 结算总时长：普通胜负 150 帧（2.5s），满点 200 帧（约 3.3s）
D678.RESOLVE_WAIT     = 150;
D678.RESOLVE_WAIT_MAX = 200;

// 满点演出上那行大字。牛牛下「满点」这个词是错的 —— 那条规则里满点就叫牛牛，
// 玩家看到的成绩行也写着「牛牛」，大字再写「满点」两边对不上。
// 【为什么按 r.cows 判而不是 b.isCowRule()】结算时 revealed 已经翻牌，
// 而 cowBroken 会随场上张数变化；r.cows 是 doResolve 当时定下来的成绩，
// 跟成绩行读的是同一份数据，不会出现「行里写牛牛、大字写满点」。
Scene_D678.prototype.maxFxText = function (si) {
    var r = this._battle && this._battle.result;
    if (r && r.cows && r.cows[si] === 10) return '牛 牛 !';
    return '满 点 !';
};

// 渐变填色的「满点!」位图。textColor 只能纯色，所以直接画在 _context 上
// （项目里 box / ringBitmap / dealFx 已经是这个路子）。
Scene_D678.prototype.maxTextBitmap = function (txt) {
    var W = 640, H = 170;
    var b = new Bitmap(W, H), ctx = b._context;
    txt = txt || '满 点 !';
    ctx.save();
    // 走 Bitmap 自己的字体名（GameFont），别写死字体族。
    // _makeFontNameText 是 MV 内部方法，保险起见留一条回退。
    b.fontSize = 104;
    ctx.font = 'bold ' + (b._makeFontNameText ? b._makeFontNameText()
        : b.fontSize + 'px ' + (b.fontFace || 'GameFont'));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var cx = W / 2, cy = H / 2;
    // 描边由粗到细叠三层，做出一道有厚度的暖色边，比单层 outlineWidth 扎实
    var edges = [
        { w: 18, c: 'rgba(90,30,0,0.95)' },
        { w: 11, c: '#ff8a00' },
        { w: 5,  c: '#ffd766' }
    ];
    ctx.lineJoin = 'round';
    for (var i = 0; i < edges.length; i++) {
        ctx.lineWidth = edges[i].w;
        ctx.strokeStyle = edges[i].c;
        ctx.strokeText(txt, cx, cy);
    }
    // 字面渐变：上白下橙，中段压金色，金属感来自这道过渡
    var g = ctx.createLinearGradient(0, cy - 54, 0, cy + 54);
    g.addColorStop(0,    '#fffdf0');
    g.addColorStop(0.42, '#ffe98a');
    g.addColorStop(0.62, '#ffc23d');
    g.addColorStop(1,    '#ff9a1f');
    ctx.fillStyle = g;
    ctx.fillText(txt, cx, cy);
    ctx.restore();
    b._setDirty();
    return b;
};

// 过冲弹性缓动：0 -> OVERSHOOT -> 回落 1.0，尾段小幅回弹。
// 原来的 0.4 + min(1,r*4)*0.9 在 22 帧就涨到 1.35 然后一秒只是轻抖，
// 所以观感是「软」的；这条曲线是先砸下来再收住。
//
// 过冲只取 1.9：字面实宽约 480px，1.9 倍到约 910px 会溢出 720 的屏宽 ——
// 这是「砸」下来时想要的冲出画面感，但再大（试过 2.4）就整块糊出屏幕，
// 看着像渲染出错而不像特效。
D678.MAXFX_OVERSHOOT = 1.9;
D678.maxEase = function (r) {
    var o = D678.MAXFX_OVERSHOOT;
    if (r < 0.16) return o - (o - 1) * Math.pow(r / 0.16, 0.55);   // 冲入并收缩到 1.0
    var k = (r - 0.16) / 0.84;
    return 1.0 + Math.sin(k * Math.PI * 2.2) * 0.05 * (1 - k);     // 余韵回弹
};

Scene_D678.prototype.maxFx = function (si) {
    var cx = LY.SW / 2, cy = 470;      // 居中：面板 300~680 的视觉中心
    var self = this;

    // 1) 冲击白闪 —— 3 帧全屏，卖「砸」的那一下
    var fb = new Bitmap(LY.SW, LY.SH);
    fb.fillRect(0, 0, LY.SW, LY.SH, '#ffffff');
    var flash = new Sprite(fb);
    flash.blendMode = 1;
    this.addFx(flash, 10, function (s, r) {
        s.opacity = 210 * Math.max(0, 1 - r * 3.2);
    }, true);

    // 2) 轻微震屏
    this.shake(10, 7);

    // 3) 暗角：压暗牌桌，让大字在花哨的牌面上仍然读得清。
    //    寿命与大字一致，最后 MAXFX_FADE 帧一起退掉，把画面交还给结算面板。
    var life = D678.MAXFX_SHOW + D678.MAXFX_FADE;
    var vb = new Bitmap(LY.SW, LY.SH);
    var vctx = vb._context;
    var rg = vctx.createRadialGradient(cx, cy, 120, cx, cy, 620);
    rg.addColorStop(0, 'rgba(0,0,0,0)');
    rg.addColorStop(1, 'rgba(0,0,0,0.72)');
    vctx.fillStyle = rg;
    vctx.fillRect(0, 0, LY.SW, LY.SH);
    vb._setDirty();
    var vig = new Sprite(vb);
    vig.opacity = 0;
    this.addFx(vig, life, function (s, r, tick) {
        var fadeOut = Math.max(0, tick - D678.MAXFX_SHOW) / D678.MAXFX_FADE;
        s.opacity = 255 * Math.min(1, tick / 6) * (1 - Math.min(1, fadeOut));
    }, true);

    // 4) 扩散光环两道，错开 6 帧
    [0, 6].forEach(function (delay, k) {
        self.laterFx(delay, function () {
            var ring = new Sprite(this.ringBitmap(k === 0 ? '#ffd766' : '#fff3c4'));
            ring.anchor.x = ring.anchor.y = 0.5;
            ring.x = cx; ring.y = cy;
            this.addFx(ring, 44, function (s, r) {
                s.scale.x = s.scale.y = 0.15 + Math.pow(r, 0.6) * 2.9;
                s.opacity = 255 * (1 - r) * (1 - r);
            }, true);
        });
    });

    // 5) 主体大字。缩放走 maxEase（过冲后收住），
    //    到第 MAXFX_SHOW 帧开始缩小淡出，正好是面板淡入那一帧。
    var sp = new Sprite(this.maxTextBitmap(this.maxFxText(si)));
    sp.anchor.x = sp.anchor.y = 0.5;
    sp.x = cx; sp.y = cy;
    this.addFx(sp, life, function (s, r, tick) {
        var base = D678.maxEase(Math.min(1, tick / D678.MAXFX_SHOW));
        if (tick <= D678.MAXFX_SHOW) {
            s.opacity = 255;
            s.scale.x = s.scale.y = base;
        } else {
            var k = Math.min(1, (tick - D678.MAXFX_SHOW) / D678.MAXFX_FADE);
            s.opacity = 255 * (1 - k);
            s.scale.x = s.scale.y = base * (1 - k * 0.25);
        }
    }, true);
};

//=============================================================================
// 流程
//=============================================================================

// 注意：下方「新手教程」一节覆写了 start，改为先进入询问画面，
// 玩家选「知道规则」后才走 beginRound。
Scene_D678.prototype.start = function () {
    Scene_Base.prototype.start.call(this);
    this.startFadeIn(this.fadeSpeed(), false);
    this.beginRound();
};

Scene_D678.prototype.pushMsg = function (s) {
    if (!s) return;
    this._msgs.push(s);
    while (this._msgs.length > 3) this._msgs.shift();
};

Scene_D678.prototype.beginRound = function () {
    if (this.checkGameEnd()) return;
    var g = D678.Game, me = g.human();
    this._msgs = [];
    this._report = null;
    this._selFunc = null;
    this._notice = '';
    // 结算演出状态不跨轮残留，免得上一轮跳过时留下半透明的面板
    this._panelHold = 0;
    this._panelFade = 1;
    var r = g.makeRound();
    this._roundInfo = r;
    // 清空本轮胜负前先存一份，好让对战途中打开排名仍能看到上一轮的结果
    g.players.forEach(function (p) {
        if (p.alive) { p.prevLast = p.last; p.last = null; }
    });
    if (r.bye) r.bye.last = { type: 'bye', dmg: 0 };

    var myPair = null;
    for (var i = 0; i < r.pairs.length; i++) {
        if (r.pairs[i][0] === me || r.pairs[i][1] === me) myPair = r.pairs[i];
    }
    this._myPair = myPair;
    if (!myPair) {                       // 玩家轮空
        this._battle = null;
        this._lastLog = null;            // 轮空没有对战记录
    this._reportVs = null;           // 对手战绩块（只有 gameover 用）
        this.simulateOthers();
        this.handleElimination();
        this._phase = 'roundResult';
        this._notice = '本轮轮空';
        this._wait = 20;
        this.buildRoundReport();
        this.refresh();
        return;
    }
    var opp = (myPair[0] === me) ? myPair[1] : myPair[0];
    this._battle = new D678_Battle(me, opp, false);
    this._tieShown = false;
    this._phase = 'battle';
    this._wait = 40;
    this.dealFx();
    this.refresh();
};

Scene_D678.prototype.update = function () {
    Scene_Base.prototype.update.call(this);
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
    if (this._discardFor || this._showList) return;
    if (this._wait > 0) { this._wait--; return; }
    switch (this._phase) {
    case 'battle':  this.updateBattle(); break;
    case 'tie':     this.doRedeal(); break;
    case 'resolve': this.finishBattle(); break;
    }
};

Scene_D678.prototype.updateBattle = function () {
    var b = this._battle;
    if (!b) return;
    if (b.finished || (b.result && b.result.tie)) { this.onBattleEnd(); return; }
    if (b.turn === 1) {
        var ev = D678.AI.step(b, 1);
        if (ev.action === 'func') this.funcFx();
        // AI 的二选一不演出选择过程（你定的）：它是瞬间选完的，
        // 只在提示条上说清结果 —— 否则玩家只看到「对方使用了二选一」，
        // 场上多了张牌却不知道是怎么来的。
        if (ev.pick2 && ev.pick2.value !== null) {
            this.pushMsg(ev.msg + '，抽出了 ' + ev.pick2.value);
        } else {
            this.pushMsg(ev.msg);
        }
        this._wait = 45;
        // 对方重抽也要播完整动画（收牌 + 发牌）—— 否则看不出他到底做了什么。
        // 判 kind 而不是 ev.same：抽到不同数字时旧牌同样该飞回牌库。
        if (ev.kind === 'repick') this.redealCard(1, ev.oldValue);
        this.refresh();
        if (b.finished || (b.result && b.result.tie)) this.onBattleEnd();
    }
};

Scene_D678.prototype.onBattleEnd = function () {
    var b = this._battle;
    if (b.result && b.result.tie) {
        if (this._phase === 'tie') return;
        this._phase = 'tie';
        b.revealed = true;
        this.revealFx();
        // 平局一律不放满点演出，面板照旧立刻画。
        // （牛牛 / 规则比多 下双方可以同时满点又打平 —— 双牛牛、或张数点数全同，
        //   那时也不放演出：演出是给胜者的。）
        this._panelHold = 0;
        this._panelFade = 1;
        this.pushMsg('平局，重新发牌');
        this._wait = 100;
        this.refresh();
        return;
    }
    if (b.finished && this._phase !== 'resolve') {
        this._phase = 'resolve';
        var r = b.result;
        this.revealFx();
        // 【只给胜者放演出】原来是「谁满点给谁放」，靠的是「满点必胜」这条前提。
        // 规则比多 把这条前提打破了：先比张数，所以恰好 21 点（满点）的人
        // 完全可能因为张数少而输 —— 那时会给刚输掉的人放一场庆祝演出。
        // 前五张规则牌下满点仍然必胜，所以这个收紧对它们没有任何影响。
        var isMax = !!(r.maxes[r.winner]);
        if (isMax) {
            // 满点：先翻底牌，第 MAXFX_DELAY 帧砸大字，这段时间不画结算面板。
            // 只有满点才拉长（约 3.3 秒），普通胜负仍是 150 帧（2.5 秒）。
            this._panelHold = D678.MAXFX_HOLD;
            this._panelFade = 0;
            var side = r.winner;
            this.laterFx(D678.MAXFX_DELAY, function () { this.maxFx(side); });
            this._wait = D678.RESOLVE_WAIT_MAX;
        } else {
            this._panelHold = 0;
            this._panelFade = 1;
            this._wait = D678.RESOLVE_WAIT;
        }
        // 拼点阶段不报伤害，只报胜负
        this.pushMsg(r.winner === 0 ? '胜' : '负');
        this.refresh();
    }
};

Scene_D678.prototype.doRedeal = function () {
    var b = this._battle;
    b.pendingRedeal = false;
    b.result = null;
    b.redeals++;
    this._panelHold = 0;
    this._panelFade = 1;
    b.newDeal();
    this._msgs = ['平局，已重新发牌'];
    this._phase = 'battle';
    this._wait = 40;
    this.dealFx();
    this.refresh();
};

Scene_D678.prototype.finishBattle = function () {
    var b = this._battle;
    var need = b.grantFuncs();
    var human = D678.Game.human();
    var humanNeed = false;
    need.forEach(function (p) {
        if (p.isHuman) humanNeed = true; else D678.autoDiscard(p);
    });
    this.handleElimination();
    if (humanNeed && human.alive && human.funcs.length > D678.MAX_FUNC) {
        this._discardFor = human;
        this._discardSel = [];
        this._phase = 'discard';
        this.refresh();
        return;
    }
    this.afterDiscard();
};

Scene_D678.prototype.afterDiscard = function () {
    this.simulateOthers();
    this.handleElimination();
    // 轮结果画面要展示本局对战记录，_battle 置空前先把日志留下来
    this._lastLog = (this._battle && this._battle.log) ? this._battle.log.slice(0) : null;
    this._battle = null;
    this._phase = 'roundResult';
    this._notice = '本轮结束　点击继续';
    this._wait = 20;
    this.buildRoundReport();
    this.refresh();
};

Scene_D678.prototype.simulateOthers = function () {
    var r = this._roundInfo, mp = this._myPair;
    if (!r) return;
    for (var i = 0; i < r.pairs.length; i++) {
        var pr = r.pairs[i];
        if (mp && pr === mp) continue;
        if (!pr[0].alive || !pr[1].alive) continue;
        D678.simulateMatch(pr[0], pr[1]);
        this.handleElimination();
    }
};

Scene_D678.prototype.handleElimination = function () {
    var g = D678.Game, changed = false;
    g.players.forEach(function (p) {
        if (!p.alive && p.funcs.length > 0) { g.returnAllFuncs(p); changed = true; }
    });
    if (changed) g.resetPairLog();
};

Scene_D678.prototype.buildRoundReport = function () {
    var r = this._roundInfo, rows = [];
    if (!r) { this._report = null; return; }
    for (var i = 0; i < r.pairs.length; i++) {
        var a = r.pairs[i][0], b = r.pairs[i][1];
        var mine = (a.isHuman || b.isHuman);
        var w = (a.last && a.last.type === 'win') ? a : ((b.last && b.last.type === 'win') ? b : null);
        // 名字走 dispName —— 单机里我那一行显示「你」而不是昵称
        if (!w) {
            rows.push({ type: 'none', win: this.dispName(a), lose: this.dispName(b),
                        me: mine });
            continue;
        }
        var l = (w === a) ? b : a;
        rows.push({ type: 'match', win: this.dispName(w), lose: this.dispName(l),
                    dmg: l.last.dmg, out: !l.alive, me: mine });
    }
    if (r.bye) rows.push({ type: 'bye', win: this.dispName(r.bye), me: r.bye.isHuman });
    this._report = rows;
};

// 结算报表：各列对齐
Scene_D678.prototype.drawReport = function (rows, x, y, lineH) {
    var bmp = this._uiBmp;
    // 列位置（相对 x）
    var cWin = 0, cW = 132, cVS = 176, cL = 224, cLose = 268, cDmg = 400;
    for (var i = 0; i < rows.length; i++) {
        var r = rows[i], yy = y + i * lineH;
        // 玩家自己的那一场用金框标出来
        if (r.me) {
            this.box(bmp, x - 14, yy - 7, 588, lineH - 4, 'rgba(255,215,102,0.12)', COL.gold, 6);
        }
        if (r.type === 'bye') {
            this.txt(bmp, r.win, x + cWin, yy, 130, 22, COL.white, 'right');
            this.txt(bmp, '轮空', x + cW, yy, 120, 22, COL.gold, 'left');
            continue;
        }
        if (r.type === 'none') {
            this.txt(bmp, r.win, x + cWin, yy, 130, 22, COL.gray, 'right');
            this.txt(bmp, '未进行', x + cW, yy, 160, 22, COL.gray, 'left');
            continue;
        }
        this.txt(bmp, r.win,  x + cWin,  yy, 130, 22, COL.white, 'right');
        this.txt(bmp, '胜',   x + cW,    yy, 40,  22, COL.red,   'left');
        this.txt(bmp, 'VS',   x + cVS,   yy, 40,  22, COL.gray,  'left');
        this.txt(bmp, '负',   x + cL,    yy, 40,  22, COL.green, 'left');
        this.txt(bmp, r.lose, x + cLose, yy, 130, 22, COL.white, 'left');
        this.txt(bmp, '-' + r.dmg + (r.out ? ' 淘汰' : ''), x + cDmg, yy, 160, 22,
            r.out ? COL.red : COL.green, 'left');
    }
};

Scene_D678.prototype.nextRound = function () {
    if (this.checkGameEnd()) return;
    this.beginRound();
};

Scene_D678.prototype.checkGameEnd = function () {
    var g = D678.Game;
    if (!g.human().alive) {
        this._phase = 'gameover';
        this._battle = null;
        this._notice = '你被淘汰了……';
        var me = g.human();
        this._report = this.buildFinalReport(g.rankedPlayers().indexOf(me) + 1);
        this._reportVs = this.buildVsRows();
        this.refresh();
        return true;
    }
    if (g.alivePlayers().length <= 1) {
        this._phase = 'gameover';
        this._battle = null;
        this._notice = '最后的幸存者！你赢得了这场赌局！';
        this._report = this.buildFinalReport(1);
        this._reportVs = this.buildVsRows();
        this.refresh();
        return true;
    }
    return false;
};

// 淘汰 / 通关画面的战绩表。胜率与满点率的分母是真正打完的场次（平局重发不计入）
//
// 【2026-08-05 改成和锦标赛淘汰页一致（你定的）】原来这里在我的详情之后
// 按名次列全员（8 行），有两个问题：
//   1. 和联机锦标赛淘汰页的观感不一致 —— 那边是「我的详情 + 对手战绩」，
//      没有全员表（见 678net.js 的 drawElim）。
//   2. 那 8 行画到 y=708，而对战记录框从 y=584 起、后画、半透明 ——
//      最后 4 个人本来就被盖住了，等于白画。
// 现在只留我的详情 5 行，全员信息走血条上的「▼ 排名」（gameover 时
// drawHpBar 照样画、命中区照样注册，点得开），那份还更详细。
Scene_D678.prototype.buildFinalReport = function (rank) {
    var g = D678.Game, me = g.human();
    return [
        '最终名次：第 ' + rank + ' 名 / ' + g.players.length + ' 人',
        '最终 HP：' + me.showHp() + '　对局 ' + me.games() + ' 场',
        '胜 ' + me.wins + '　负 ' + me.losses + '　胜率 ' + me.rateText(me.winRate()),
        '满点 ' + me.maxPoint + ' 次　满点率 ' + me.rateText(me.maxRate()),
        '共使用功能牌 ' + (me.funcUses || 0) + ' 次'
    ];
};

// 对每个对手的头对头战绩，给结算页的「对手战绩」块用。
// 口径和锦标赛淘汰页完全一致（678net.js:872-883）：VS 名字 / 对局 N 场 / 胜率 Z%。
//
// 【为什么不是排名表里那个胜率】排名表列的是那个人的**总胜率**，
// 这里是**他跟我**打的胜率 —— 两个数不一样，回答的也不是同一个问题
// （「谁厉害」vs「我打得过谁」）。所以两块都留着，不重复。
//
// 数据来自 me.vsLog（core 层记的，单机联机共用同一条 doResolve 路径），
// 平局不计入 —— 和 wins/losses 的口径一致。
Scene_D678.prototype.buildVsRows = function () {
    var me = D678.Game.human(), out = [];
    var log = me.vsLog || {};
    for (var id in log) {
        if (!Object.prototype.hasOwnProperty.call(log, id)) continue;
        var e = log[id], g = e.wins + e.losses;
        out.push({
            name: e.name,
            games: g,
            // 没打过的显示 '—'（和 rateText / 联机的 pct 一致），不显示 0%
            rate: g > 0 ? Math.round(e.wins / g * 100) : null
        });
    }
    // 交手多的排前面，同场次按胜率高的在前 —— 让「打得最多的对手」一眼看到
    out.sort(function (a, b) {
        if (b.games !== a.games) return b.games - a.games;
        return (b.rate === null ? -1 : b.rate) - (a.rate === null ? -1 : a.rate);
    });
    return out;
};

Scene_D678.prototype.leaveScene = function () {
    if (this._leaving) return;
    this._leaving = true;
    SceneManager.pop();
};

//--- 非对局画面的补充绘制 --------------------------------------------------

var _D678_refresh = Scene_D678.prototype.refresh;
Scene_D678.prototype.refresh = function () {
    _D678_refresh.call(this);
    if (!this._battle) {
        this.syncFuncSprites([], 20, LY.FUNC_Y);
        var bmp = this._uiBmp;
        var rows = this._report || [];
        // 【gameover 的几何单独算】要装「我的详情 5 行 + 对手战绩块」，而且
        // 整块必须收在 y<584 以内 —— 对战记录框从 584 起、后画、半透明，
        // 越线的行会被它盖住（原来的全员表就是这么白画了 4 行）。
        var over0 = (this._phase === 'gameover');
        var vs    = over0 ? (this._reportVs || []) : [];
        var top   = over0 ? 132 : 268;
        var rowY  = over0 ? 196 : 340;
        var lineH = over0 ? 28  : 42;
        // 【高度按真实内容底边算，别照抄锦标赛那个公式】原来写的是
        // `196 + (30 + n*26)`，那是从 678net.js 的 drawElim 抄来的 ——
        // 但那边头部只有 4 行文字、起始 y 也不一样，照抄的结果是**每种条数
        // 都溢出 6px**，末行正好压在金色边框上／掉到框外（用户看到的
        // 「所有玩家名称超过了框」）。
        //
        // 现在从底边倒推，和下面画 VS 块用的是同一套数：
        //   VS 标题 y  = rowY + 5*lineH + 8      （= top + 212）
        //   末行 y     = 标题 + 26 + (n-1)*26
        //   末行底边   = 末行 y + 20              （行高 20）
        // 相对 top 就是 232 + 26n，再留 16 的下边距。
        var PAD = 16, VS_LINE = 26, VS_ROW_H = 20;
        var vsTopOff = 5 * lineH + (rowY - top) + 8;      // VS 标题相对 top
        var hgt;
        if (!over0) {
            hgt = 300;
        } else if (vs.length) {
            hgt = vsTopOff + VS_LINE + (vs.length - 1) * VS_LINE + VS_ROW_H + PAD;
        } else {
            hgt = (rowY - top) + 5 * lineH + PAD;         // 没对手就只装 5 行
        }
        this.box(bmp, 40, top, 640, hgt, 'rgba(0,0,0,0.5)', COL.line, 12);
        this.txt(bmp, over0 ? '最终战绩' : ('第 ' + D678.Game.round + ' 轮结果'),
            0, top + 18, LY.SW, 28, COL.gold, 'center');
        if (rows.length && typeof rows[0] === 'string') {
            for (var i = 0; i < rows.length; i++) {
                this.txt(bmp, rows[i], 0, rowY + i * lineH, LY.SW,
                    over0 ? 20 : 22, COL.white, 'center');
            }
            // 对手战绩块：坐标 / 列宽 / 配色全部照锦标赛淘汰页（678net.js:872-883），
            // 两边观感一致。720 宽下 96/316/456 三列正好排满。
            if (vs.length) {
                var vy = rowY + rows.length * lineH + 8;
                this.txt(bmp, '对手战绩', 0, vy, LY.SW, 20, COL.gold, 'center');
                for (var k = 0; k < vs.length; k++) {
                    var v = vs[k], ry = vy + 26 + k * 26;
                    this.txt(bmp, 'VS ' + v.name, 96, ry, 220, 20, COL.white, 'left');
                    this.txt(bmp, '对局 ' + v.games + ' 场', 316, ry, 140, 20, COL.gray, 'left');
                    // 胜率颜色：过半绿、其余灰，一眼看出打得过谁（同锦标赛）
                    var vcol = (v.rate !== null && v.rate >= 50) ? COL.green : COL.gray;
                    this.txt(bmp, '胜率 ' + (v.rate === null ? '—' : v.rate + '%'),
                        456, ry, 160, 20, vcol, 'left');
                }
            }
        } else {
            this.drawReport(rows, 66, rowY, lineH);
        }
        // 锦标赛：我这桌打完了、本轮还没结束时，在框上方点明在等什么，
        // 并在报表下面列出还在打的人（你定的，复用这个页面不另做）。
        // 只有联机锦标赛有这两行 —— 单机和 1v1 的 netStillPlaying 返回空。
        if (this._net && this._netWaitRound && this.netStillPairs) {
            this.txt(bmp, '其他玩家还在对局', 0, 238, LY.SW, 24, COL.gold, 'center');
            // 一行一桌，横排「AA  vs  BB」。
            //
            // 【为什么不是一串名字】原来把所有还在打的人平铺成「甲、乙、丙、丁」，
            // 名字长度不一时看着很乱，而且分不出谁跟谁打（你报的第 3 条）。
            // 现在按桌走：左边名字右对齐、vs 居中定宽、右边名字左对齐 ——
            // 名字再长短不齐，vs 那一列也永远对得整整齐齐。
            var pairs = this.netStillPairs();
            if (pairs.length) {
                this.txt(bmp, '对局中', 0, 386, LY.SW, 20, COL.gray, 'center');
                // 三列：左名 / vs / 右名。vs 钉在屏幕中线上。
                var cx = LY.SW / 2, nameW = 200, vsW = 56;
                for (var pi = 0; pi < pairs.length; pi++) {
                    var pr = pairs[pi], py = 414 + pi * 26;
                    // 自己那桌用金色（轮空时不会有 mine，全是灰白）
                    var pcol = pr.mine ? COL.gold : COL.aqua;
                    this.txt(bmp, pr.a, cx - vsW / 2 - nameW, py, nameW, 20,
                        pcol, 'right');
                    this.txt(bmp, 'vs', cx - vsW / 2, py, vsW, 20,
                        COL.gray, 'center');
                    this.txt(bmp, pr.b, cx + vsW / 2, py, nameW, 20,
                        pcol, 'left');
                }
            }
        }
        this.drawBattleLog();
        var over = (this._phase === 'gameover');
        // 【联机的轮结果页整行让位】678net.js 的 netDrawOverlay 在 y=1070 画
        // 自己那句（「点击任意位置继续」/「其他玩家还在对局（还有 N 桌）」…），
        // 这行在 y=1066 —— 两行 24 号字差 4 像素、画在同一张 bitmap 上，
        // 会叠成一团。单机和联机的其他阶段照旧。
        if (!(this._net && this._phase === 'roundResult')) {
            this.txt(bmp, this._notice || (over ? '' : '点击继续'),
                0, 1066, LY.SW, 24, COL.gold, 'center');
        }
        if (!over) {
            this.txt(bmp, '点击上方血条查看全体排名与统计', 0, 1100, LY.SW, 20, COL.gray, 'center');
        } else {
            // 结束后画面保留，另给一个返回主菜单的按钮
            this.drawBackButton();
        }
    }
};

// 本局对战记录：画在「第X轮结果」界面，谁做了什么、动作后的牌面
Scene_D678.prototype.drawBattleLog = function () {
    var bmp = this._uiBmp;
    var log = this._lastLog || [];
    var x = 40, y = 584, w = 640, h = 470, lineH = 24;
    var maxLines = 16;
    this.box(bmp, x, y, w, h, 'rgba(0,0,0,0.5)', COL.line, 12);
    this.txt(bmp, '本局对战记录', x, y + 8, w, 20, COL.gold, 'center');

    if (!log.length) {
        this.txt(bmp, '（本轮轮空，无对战记录）', x, y + 44, w, 18, COL.gray, 'center');
        return;
    }
    // 超出可显示行数时只留最近的，开头标注省略了多少条
    var start = 0, shown = log;
    if (log.length > maxLines) {
        start = log.length - maxLines;
        shown = log.slice(start);
    }
    var ly = y + 38;
    if (start > 0) {
        this.txt(bmp, '…前 ' + start + ' 条已省略', x + 16, ly, w - 32, 16, COL.gray, 'left');
        ly += 20;
    }
    for (var i = 0; i < shown.length; i++) {
        var e = shown[i];
        // 我方一行用青色、对方用橙色，一眼分得清是谁的动作
        var col = (e.side === 0) ? COL.aqua : COL.orange;
        this.txt(bmp, this.dispLogName(e) + e.what, x + 16, ly, 430, 18, col, 'left');
        this.txt(bmp, e.hand, x + 452, ly, 172, 18, COL.white, 'right');
        ly += lineH;
    }
};

// 「返回主菜单」按钮：只在游戏结束、且没有弹出层挡着时可点
Scene_D678.prototype.drawBackButton = function () {
    var bmp = this._uiBmp;
    var x = 210, y = 1120, w = 300, h = 70;
    this.box(bmp, x, y, w, h, 'rgba(60,140,90,0.9)', COL.gold, 10);
    this.txt(bmp, '返回主菜单', x, y + 20, w, 28, COL.white, 'center');
    if (!this._showList && !this._discardFor) {
        this._hits.push({ x: x, y: y, w: w, h: h, cb: this.backToTitle.bind(this) });
    }
};

Scene_D678.prototype.backToTitle = function () {
    if (this._leaving) return;
    this._leaving = true;
    D678.Game = null;
    AudioManager.stopBgm();
    AudioManager.stopBgs();
    SceneManager.goto(Scene_Title);
};



//=============================================================================
// 新手教程
//=============================================================================

// 固定牌序：发牌吃掉前 4 张（我方底牌 5 / 对方底牌 1 / 我方明牌 6 / 对方明牌 11），
// 之后依次是我方要牌 3、我方要牌 7、对方要牌 9，最终双方 21 点平局。
D678.TUT_DECK = [5, 1, 6, 11, 3, 7, 9, 2, 4, 8, 10];

// 框选目标：坐标全部跟着实际绘制代码算，不写死重复的魔法数字
Scene_D678.prototype.tutRect = function (key) {
    switch (key) {
    case 'hp':       return { x: 12, y: 8, w: 696, h: 60 };
    case 'rank':     return { x: 574, y: 14, w: 134, h: 44 };
    case 'unseen':   return { x: 18, y: 534, w: 688, h: 32 };
    case 'oppLog':   return { x: 374, y: 446, w: 326, h: 104 };
    case 'hit':      return { x: 26, y: LY.BTN_Y - 4, w: 308, h: 76 };
    case 'stand':    return { x: 386, y: LY.BTN_Y - 4, w: 308, h: 76 };
    case 'myCards':  return this.tutCardRect(0, 0, -1);
    case 'oppCards': return this.tutCardRect(1, 0, -1);
    case 'oppHole':  return this.tutCardRect(1, 0, 0);
    case 'allCards':                       // 双方牌区一起框住
        var a = this.tutCardRect(1, 0, -1), c = this.tutCardRect(0, 0, -1);
        if (!a || !c) return null;
        var x = Math.min(a.x, c.x), y = Math.min(a.y, c.y);
        return { x: x, y: y,
                 w: Math.max(a.x + a.w, c.x + c.w) - x,
                 h: Math.max(a.y + a.h, c.y + c.h) - y };
    }
    return null;
};

// 卡牌框：沿用 refreshCards 的排布算法，牌数变了框也跟着变（to = -1 表示到最后一张）
Scene_D678.prototype.tutCardRect = function (si, from, to) {
    var b = this._battle;
    if (!b) return null;
    var n = b.sides[si].cards.length;
    if (to < 0) to = n - 1;
    var span = Math.min(LY.CARD_W + 12, Math.floor(660 / Math.max(n, 1)));
    var totalW = span * (n - 1) + LY.CARD_W;
    var sx = Math.floor((LY.SW - totalW) / 2);
    var y = (si === 0) ? LY.MY_CARD_Y : LY.OPP_CARD_Y;
    var x0 = sx + span * from, x1 = sx + span * to + LY.CARD_W;
    return { x: x0 - 6, y: y - 6, w: (x1 - x0) + 12, h: LY.CARD_H + 12 };
};

// 教程脚本。每步: box 框选目标 / lines 文字(1~3句) / allow 允许的按钮
//   allow 为 null 时点任意处推进；为 'hit'/'stand' 时只有该按钮可点，
//   点另一个按钮会弹 hitMsg / standMsg 而不真的执行。
//   wait 为自动推进的帧数（用于展示对方回合这类不需要玩家点的步骤）。
//   enter 在进入该步时调用一次。
D678.TUT_STEPS = [
    { box: 'hp', lines: [
        '这是玩家的生命值，如果生命值降为 0 游戏将会失败',
        '对局失败了会 -1 生命值，如果爆牌会额外 -1 生命值'] },
    { box: 'hp', lines: [
        '对方满点胜利，也会额外 -1 生命值',
        '每次对局失败都会累计 -1 生命值'] },
    { box: 'rank', lines: ['点击此处打开目前排名情况'] },
    { box: null, openRank: true, lines: [
        '这是 ' + '{N}' + ' 位玩家的排名情况，记得点开查看'] },
    { box: null, closeRank: true, lines: [
        '游戏为 21 点规则',
        '低于 21 点哪方接近 21 点则获胜',
        '如果超过了 21 点就属于爆牌'] },
    { box: null, lines: [
        '爆牌后无论是否接近 21 点，都无法获胜',
        '比如对方 3 点、我方 22 点，也是我方输了本局'] },
    { box: 'allCards', lines: [
        '每局每名玩家会发两张牌',
        '一张底牌，一张明牌'] },
    { box: 'allCards', lines: [
        '双方都无法查看对方的底牌，明牌是可见的',
        '数字牌不会重复，从 1-11 随机抽出发出'] },
    { box: 'myCards', lines: ['比方已经拿到了底牌 5 跟明牌 6'] },
    { box: 'oppHole', lines: [
        '那么对方的底牌里肯定就不会是 5 跟 6',
        '包括对方已有的明牌 11 也是不会有的'] },
    { box: 'unseen', lines: [
        '此处是记牌区，所有未见过的数字牌就会在此显示',
        '金色的数字就是拿了不会爆牌的数字牌',
        '红色的数字 10 则是拿到了以后达到 21 点的牌'] },
    { box: 'allCards', lines: [
        '每局发牌后由牌面小的一方先手行动',
        '对方明牌 11，我方明牌 6，那么就由我方开始行动'] },
    { box: 'hit',   lines: ['点击要牌按钮即可要牌'] },
    { box: 'stand', lines: ['点击过牌按钮则会轮到对方行动'] },
    { box: 'hit', allow: 'hit',
      standMsg: '教程里请先点要牌',
      lines: [
        '由于我方目前的总点数是 11 点，肯定无法赢得对方',
        '那么请点击要牌按钮选择要牌'] },
    { box: 'myCards', lines: [
        '我方获得了数字 3',
        '要牌后就会轮到对方行动'] },
    // 对方回合：自动播放，不需要玩家点
    { box: null, oppAct: 'stand', wait: 90, lines: ['对方选择了过牌'] },
    { box: 'oppLog', lines: [
        '此处会记录对方的行动，对方选择了过牌就会显示在此'] },
    { box: 'allCards', lines: [
        '我方目前总点数是 14 点，对方明牌是 11',
        '如果对方底牌超过 3 的话，那么我方则无法获胜',
        '要合理推理出对方的底牌并最终拼点获胜'] },
    { box: null, lines: [
        '现在轮到你操作了',
        '点击过牌后双方就会进入揭底牌阶段',
        '目前牌面不一定能赢得对方'] },
    { box: 'hit', allow: 'hit',
      standMsg: '目前牌面不一定能赢得对方，请选择要牌',
      lines: ['那么请点击要牌按钮选择要牌'] },
    { box: 'myCards', lines: [
        '我方获得了数字 7，目前是 21 点',
        '要牌后轮到对方行动'] },
    { box: null, oppAct: 'hit', wait: 90, lines: [
        '对方选择了要牌，获得了数字 9'] },
    { box: 'stand', allow: 'stand',
      hitMsg: '目前已经 21 点了，再要牌就会爆牌了',
      lines: [
        '我方已经 21 点，再要牌必定爆牌',
        '正常对局中即使 21 点的情况下也能继续要牌',
        '请慎重查看每局的对战情况来做出行动选择'] },
    { box: null, lines: [
        '对方刚才要牌了，所以连续过牌次数重新计算',
        '还需要对方也过牌一次才会揭底牌'] },
    { box: null, oppAct: 'stand', wait: 100, showdown: true, lines: [
        '双方连续过牌两次，此时将会揭开双方底牌'] },
    { box: null, lines: [
        '对方 21 点，我方也是 21 点',
        '那么这局就是平局处理，需要重新对局'] },
    { box: null, lines: [
        '游戏除了普通数字牌外，还会有不同的功能牌',
        '通过游戏过程了解具体使用方式和功能'] },
    { box: null, lines: ['祝你获得好的成绩获得冠军！'] }
];

//--- 教程流程 --------------------------------------------------------------

Scene_D678.prototype.startTutorial = function () {
    var g = D678.Game, me = g.human();
    // 教程对手不能是超哥：他看得见底牌，会和「双方都无法查看对方的底牌」矛盾
    var cand = g.players.filter(function (p) { return !p.isHuman && !p.isGod; });
    var opp = cand.length ? D678.rndPick(cand) : g.players[1];
    me.funcs = []; opp.funcs = [];
    var b = new D678_Battle(me, opp, false);
    // 覆写成固定开局：教程每句话都要对得上具体牌面，不能交给随机
    b.deck = D678.TUT_DECK.slice(4);
    b.rule = null;
    b.sides[0].cards = [{ v: 5, hidden: true }, { v: 6, hidden: false }];
    b.sides[1].cards = [{ v: 1, hidden: true }, { v: 11, hidden: false }];
    b.sides[0].stood = false;  b.sides[1].stood = false;
    b.sides[0].checkN = 0;     b.sides[1].checkN = 0;
    b.standStreak = 0;
    b.turn = 0;                     // 明牌 6 < 11，我方先手
    b.revealed = false;
    b.log = [];
    this._battle = b;
    this._tutOpp = opp;
    this._tutOn  = true;
    this._tutIdx = 0;
    this._tutWait = 0;
    this._tutFrame = 0;
    this._tutShowdown = false;
    this._phase = 'tut';
    this._msgs = [];
    this.dealFx();
    this.tutEnter();
};

Scene_D678.prototype.tutStep = function () {
    return this._tutOn ? (D678.TUT_STEPS[this._tutIdx] || null) : null;
};

Scene_D678.prototype.tutEnter = function () {
    var s = this.tutStep();
    if (!s) { this.endTutorial(); return; }
    this._tutWait = s.wait || 0;
    if (s.openRank)  this._showList = true;
    if (s.closeRank) this._showList = false;
    if (s.oppAct) {
        this._msgs = [];
        this.pushMsg(this._battle.act(1, s.oppAct).msg);
    }
    if (s.showdown) {
        this._tutShowdown = true;
        this._battle.revealed = true;
        this.revealFx();
    }
    this.refresh();
};

Scene_D678.prototype.tutAdvance = function () {
    this._tutIdx++;
    this.tutEnter();
};

Scene_D678.prototype.endTutorial = function () {
    this._tutOn = false;
    this._tutShowdown = false;
    this._showList = false;
    this._battle = null;
    this._msgs = [];
    if (this._tutArrow) this._tutArrow.visible = false;
    if (this._tutBmp) this._tutBmp.clear();
    // 教程打平：不掉血、不计胜负、round 仍是 0，接着就是正式第 1 轮
    this.beginRound();
};

//--- 教程输入：只有当前步该点的地方生效 ------------------------------------

Scene_D678.prototype.tutUpdateInput = function () {
    var s = this.tutStep();
    if (!s) return true;
    var click = TouchInput.isTriggered();
    var key   = Input.isTriggered('ok') || Input.isTriggered('c');
    if (!click && !key) return true;

    // 键盘/手柄：确定键等价于按下当前步允许的按钮，没有则直接推进
    if (key && !click) {
        if (s.allow === 'hit' || s.allow === 'stand') this.tutAct(s.allow);
        else this.tutAdvance();
        return true;
    }
    var x = TouchInput.x, y = TouchInput.y;
    var rh = this.tutRect('hit'), rs = this.tutRect('stand');
    var inRect = function (r) {
        return r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    };
    // 教程自己算命中区（tutRect），绕开了 _hits，所以点击反馈得在这儿单独放。
    // 不允许的那一步也放 —— 否则玩家会以为没点到，而不是「这一步不能这么做」。
    if (inRect(rh)) {
        this.tapFx(rh.x, rh.y, rh.w, rh.h);
        SoundManager.playCursor();
        if (s.allow === 'hit') this.tutAct('hit');
        else { this.notice(s.hitMsg || '教程里这一步还不能要牌'); this.refresh(); }
        return true;
    }
    if (inRect(rs)) {
        this.tapFx(rs.x, rs.y, rs.w, rs.h);
        SoundManager.playCursor();
        if (s.allow === 'stand') this.tutAct('stand');
        else { this.notice(s.standMsg || '教程里这一步还不能过牌'); this.refresh(); }
        return true;
    }
    // 需要按按钮的步骤：点空白处不推进，避免玩家一路乱点跳过操作练习
    if (!s.allow) this.tutAdvance();
    return true;
};

Scene_D678.prototype.tutAct = function (action) {
    this._notice = ''; this._noticeTime = 0;
    this._msgs = [];
    this._battle.act(0, action);
    this.tutAdvance();
};

Scene_D678.prototype.updateTut = function () {
    this._tutFrame++;
    if (this._tutWait > 0) {
        this._tutWait--;
        if (this._tutWait === 0) this.tutAdvance();
    }
    this.updateTutArrow();
};

//--- 教程绘制：文字带 + 框选框 + 指向箭头 ------------------------------------

Scene_D678.prototype.createTutLayer = function () {
    if (this._tutSprite) return;
    this._tutBoxBmp = new Bitmap(LY.SW, LY.SH);
    this._tutBoxSprite = new Sprite(this._tutBoxBmp);
    this.addChild(this._tutBoxSprite);
    this._tutBmp = new Bitmap(LY.SW, LY.SH);
    this._tutSprite = new Sprite(this._tutBmp);
    this.addChild(this._tutSprite);
    this._tutArrow = new Sprite(this.tutArrowBitmap());
    this._tutArrow.anchor.x = 0.5;
    this._tutArrow.visible = false;
    this.addChild(this._tutArrow);
};

Scene_D678.prototype.tutArrowBitmap = function () {
    var b = new Bitmap(72, 56), ctx = b._context;
    ctx.fillStyle = COL.red;
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(36, 52); ctx.lineTo(6, 8); ctx.lineTo(66, 8);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    b._setDirty();
    return b;
};

Scene_D678.prototype.drawTut = function () {
    this.createTutLayer();
    var s = this.tutStep();
    this._tutBoxBmp.clear();
    this._tutBmp.clear();
    if (!s) { this._tutArrow.visible = false; return; }

    // 框选框：box 的描边固定 2px，单圈在手机上太细，
    // 所以叠四圈做出一道有厚度的红色光边，由内到外逐层变淡。
    var r = s.box ? this.tutRect(s.box) : null;
    if (r) {
        var rings = [
            { d: 0,  c: COL.red },
            { d: 3,  c: COL.red },
            { d: 7,  c: 'rgba(255,90,90,0.55)' },
            { d: 11, c: 'rgba(255,90,90,0.24)' }
        ];
        for (var k = 0; k < rings.length; k++) {
            var d = rings[k].d;
            this.box(this._tutBoxBmp, r.x - d, r.y - d, r.w + d * 2, r.h + d * 2,
                null, rings[k].c, 10 + d);
        }
    }
    // 指向箭头：只在需要玩家按按钮的步骤出现
    var arrow = (s.allow && r);
    this._tutArrow.visible = !!arrow;
    if (arrow) {
        this._tutArrow.x = r.x + r.w / 2;
        this._tutArrowY = r.y - 62;
    }
    // 文字带：放在功能牌那条空带，教程期间玩家 0 张功能牌，不会挡东西
    var bmp = this._tutBmp;
    var n = D678.Game ? D678.Game.players.length : 8;
    var lines = s.lines.map(function (t) { return t.replace('{N}', String(n)); });
    var bx = 30, by = 900, bw = 660, bh = 60 + lines.length * 34;
    this.box(bmp, bx, by, bw, bh, 'rgba(0,0,0,0.86)', COL.gold, 12);
    this.txt(bmp, '新手教程', bx, by + 10, bw, 17, COL.gray, 'center');
    for (var i = 0; i < lines.length; i++) {
        this.txt(bmp, lines[i], bx + 20, by + 38 + i * 34, bw - 40, 21, COL.white, 'center');
    }
    var tip = s.allow
        ? '请点击上方指示的按钮'
        : (this._tutWait > 0 ? '（点击可加速）' : '点击任意处继续');
    this.txt(bmp, tip, bx, by + bh - 26, bw, 16, COL.gold, 'center');
};

Scene_D678.prototype.updateTutArrow = function () {
    if (!this._tutArrow || !this._tutArrow.visible) return;
    var t = this._tutFrame;
    this._tutArrow.y = this._tutArrowY + Math.sin(t * 0.14) * 9;
    this._tutArrow.opacity = 205 + Math.sin(t * 0.14) * 50;
    if (this._tutBoxSprite) {
        this._tutBoxSprite.opacity = 190 + Math.sin(t * 0.1) * 65;
    }
};

//--- 开局询问：是否已经知道规则 ---------------------------------------------

Scene_D678.prototype.askButtons = function () {
    return [
        { x: 110, y: 600, w: 500, h: 96, label: '我知道规则，直接开始', tut: false },
        { x: 110, y: 720, w: 500, h: 96, label: '不知道，教我一遍',     tut: true  }
    ];
};

Scene_D678.prototype.drawAsk = function () {
    var bmp = this._uiBmp;
    bmp.clear();
    this._hits = [];
    this.box(bmp, 60, 392, 600, 136, 'rgba(0,0,0,0.7)', COL.gold, 14);
    this.txt(bmp, '你知道本游戏的规则吗？', 60, 420, 600, 26, COL.white, 'center');
    this.txt(bmp, '选择「教我一遍」会先进行一场固定开局的教学对局',
        60, 470, 600, 17, COL.gray, 'center');
    var btns = this.askButtons();
    for (var i = 0; i < btns.length; i++) {
        var b = btns[i], on = (this._askSel === i);
        this.box(bmp, b.x, b.y, b.w, b.h,
            on ? 'rgba(70,175,110,0.95)' : 'rgba(0,0,0,0.6)',
            on ? COL.gold : COL.line, 12);
        if (on) this.box(bmp, b.x + 8, b.y + 6, b.w - 16, 28, 'rgba(255,255,255,0.18)', null, 7);
        this.txt(bmp, b.label, b.x, b.y + 32, b.w, 26, on ? COL.white : COL.gray, 'center');
        this._hits.push({ x: b.x, y: b.y, w: b.w, h: b.h,
            cb: this.onAskChoose.bind(this, i) });
    }
    this.txt(bmp, '点击选择，或用方向键选择后按确定键', 0, 856, LY.SW, 18, COL.gray, 'center');
};

Scene_D678.prototype.askUpdateInput = function () {
    if (Input.isRepeated('down') || Input.isRepeated('right')) {
        this._askSel = (this._askSel + 1) % 2; this.refresh(); return;
    }
    if (Input.isRepeated('up') || Input.isRepeated('left')) {
        this._askSel = (this._askSel + 1) % 2; this.refresh(); return;
    }
    if (Input.isTriggered('ok') || Input.isTriggered('c')) {
        this.onAskChoose(this._askSel); return;
    }
};

Scene_D678.prototype.onAskChoose = function (i) {
    if (this._phase !== 'ask') return;
    var b = this.askButtons()[i];
    if (!b) return;
    this._askSel = i;
    if (b.tut) this.startTutorial();
    else { this._phase = 'init'; this.beginRound(); }
};

//--- 钩子 ------------------------------------------------------------------

var _D678_tut_create = Scene_D678.prototype.create;
Scene_D678.prototype.create = function () {
    _D678_tut_create.call(this);
    this._tutOn = false;
    this._askSel = 0;
};

// start 原本直接 beginRound，改成先弹询问
Scene_D678.prototype.start = function () {
    Scene_Base.prototype.start.call(this);
    this.startFadeIn(this.fadeSpeed(), false);
    this._phase = 'ask';
    this.refresh();
};

var _D678_tut_update = Scene_D678.prototype.update;
Scene_D678.prototype.update = function () {
    if (this._phase === 'ask') {
        Scene_Base.prototype.update.call(this);
        this._ovSprite.opacity = 255;
        this.updateInput();
        this.askUpdateInput();
        return;
    }
    if (this._tutOn) {
        Scene_Base.prototype.update.call(this);
        this.updateCardSprites();
        this.updateFxQueue();
        this.updateFx();
        this.updateShake();
        // 教程固定打成 21:21 平局，不会满点，面板一律全不透明
        this._ovSprite.opacity = 255;
        if (this._noticeTime > 0) {
            this._noticeTime--;
            if (this._noticeTime === 0) { this._notice = ''; this.refresh(); }
        }
        this.tutUpdateInput();
        this.updateTut();
        return;
    }
    _D678_tut_update.call(this);
};

// 教程期间：按钮外观按当前步是否允许来画，其余点击区域一律不注册
var _D678_tut_drawButtons = Scene_D678.prototype.drawButtons;
Scene_D678.prototype.drawButtons = function (b) {
    if (!this._tutOn) { _D678_tut_drawButtons.call(this, b); return; }
    var s = this.tutStep();
    var bmp = this._uiBmp, bw = 300, bh = 68, y = LY.BTN_Y;
    var onHit   = !!(s && s.allow === 'hit');
    var onStand = !!(s && s.allow === 'stand');
    this.box(bmp, 30, y, bw, bh, onHit ? 'rgba(60,140,90,0.85)' : 'rgba(60,60,60,0.6)', COL.line, 10);
    this.txt(bmp, '要牌', 30, y + 18, bw, 28, onHit ? COL.white : '#888', 'center');
    this.box(bmp, 390, y, bw, bh, onStand ? 'rgba(150,110,40,0.85)' : 'rgba(60,60,60,0.6)', COL.line, 10);
    this.txt(bmp, '过牌', 390, y + 18, bw, 28, onStand ? COL.white : '#888', 'center');
};

// 询问阶段只画问句；教程阶段在最上层补文字带与框选
var _D678_tut_refresh = Scene_D678.prototype.refresh;
Scene_D678.prototype.refresh = function () {
    if (this._phase === 'ask') {
        this.refreshCards();
        this.drawAsk();
        this._ovBmp.clear();
        if (this._tutBmp) this._tutBmp.clear();
        if (this._tutBoxBmp) this._tutBoxBmp.clear();
        if (this._tutArrow) this._tutArrow.visible = false;
        return;
    }
    _D678_tut_refresh.call(this);
    if (this._tutOn) {
        this._hits = [];          // 教程期间锁掉血条 / 卡牌 / 功能牌区的点击
        this.drawTut();
    }
};

// 教程的平局揭牌画面沿用 drawShowdown，但不走 tie 阶段的自动重发
var _D678_tut_drawOverlay = Scene_D678.prototype.drawOverlay;
Scene_D678.prototype.drawOverlay = function () {
    if (this._tutOn) {
        var bmp = this._ovBmp;
        bmp.clear();
        if (this._showList) { this.drawRankList(); this._hits = []; return; }
        if (this._tutShowdown) this.drawShowdown();
        return;
    }
    _D678_tut_drawOverlay.call(this);
};

//=============================================================================
// 插件命令
//=============================================================================

var _D678_pluginCommand = Game_Interpreter.prototype.pluginCommand;
Game_Interpreter.prototype.pluginCommand = function (command, args) {
    _D678_pluginCommand.call(this, command, args);
    if (command && command.toLowerCase() === 'start678') {
        D678.Game = new D678_Game();
        SceneManager.push(Scene_D678);
    }
};

})();
