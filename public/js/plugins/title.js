//=============================================================================
// title.js
//=============================================================================
/*:
 * @plugindesc 标题画面改造：只保留「开始游戏」「说明」「功能牌图鉴」，按钮美化并置于画面 1/3 处
 * @author DerekGoodman
 *
 * @help
 * ============================================================================
 * 功能
 * ============================================================================
 *  · 标题命令只剩「开始游戏」和「说明」，继续游戏 / 设置 已移除
 *  · 命令按钮改为自绘圆角按钮，横向居中，整组靠画面下方并留出底部空间
 *  · 游戏标题文字居中，紧贴按钮上方（整块文字都在画面下部）
 *  · 点「说明」进入独立说明画面，文字由你自己编辑，点任意位置返回
 *  · 按钮为单击直达，适配移动端触屏
 *
 * ============================================================================
 * 说明文字在哪里改
 * ============================================================================
 *  往下找 “★ 说明文字编辑区 ★”，只改 HELP_TITLE 和 HELP_LINES 就行，
 *  不需要动其它任何代码。说明画面点任意位置返回。
 *
 * ============================================================================
 * 安装
 * ============================================================================
 *  放进 js/plugins/，在插件管理器里启用。无参数。
 *  载入顺序随意，但建议放在 678.js 之前。
 * ============================================================================
 */

var D678T = D678T || {};

(function () {
'use strict';

//=============================================================================
// ★★★★★★★★★★★★★★  说明文字编辑区（改这里）  ★★★★★★★★★★★★★★
//=============================================================================
//  HELP_TITLE 是「说明」画面顶部的小标题。
//  HELP_LINES 是正文，支持两种写法，任选一种：
//
//  写法一（反引号，推荐）：整段文字直接写，换行就是换行，不用管标点。
//      D678T.HELP_LINES = `第一行
//      第二行
//
//      空一行后的第四行`;
//
//  写法二（数组）：每个字符串是一行，空行写 ''。
//      注意每一行末尾都要有英文逗号 , 最后一行可以不加。
//      漏一个逗号整个插件就会失效（JS 语法错误）。
//
//   · 一行建议不超过 28 个汉字，太长会被框裁掉
//   · 最多约 26 行，超出会顶到画面底部
//   · 说明画面点任意位置即返回标题
//=============================================================================

D678T.HELP_TITLE = '678版本v1.8';

D678T.HELP_LINES = `8名玩家进行21点对局，每次1对1分成4组同时进行

数字牌从数字1-11不重复，游戏为回合制
发数字牌后牌面小的一方先手回合

对局失败-5生命值
爆牌-3生命值
对方满点-3生命值
失败次数多的人胜利会额外扣失败少的人差额生命值
平局后本局生命值惩罚会额外多1叠加：如1，2，4，8……
胜方获得1张功能牌
败方获得2张功能牌
全游戏功能牌36张，36张都发出后所有玩家将不能再获得
每名玩家最多可携带6张功能牌
任意功能牌使用后会重新进入公共池

生命值归0将会被淘汰出局，最终留下的获得最终胜利！

版本改动：
1.8：新增功能牌图鉴，新增4张功能牌至36张，优化血量计算公式
1.7：正式开放天梯模式
1.6：新增8张功能牌至32张
1.5：完善多人对战模式
1.4：多人对战功能优化，新增锦标赛模式
1.3：新增多人对战功能`;

//=============================================================================
// ★★★★★★★★★★★★★★  说明文字编辑区 结束  ★★★★★★★★★★★★★★
//=============================================================================

//=============================================================================
// 配色 / 尺寸
//=============================================================================

var TC = {
    face1:  '#5fb98d',                  // 按钮渐变上（浅绿，不压封面）
    face2:  '#3f8f6a',                  // 按钮渐变下
    faceH1: '#7fd3a6',                  // 高亮态渐变上
    faceH2: '#52a87d',                  // 高亮态渐变下
    edge:   '#ffeaa0',                  // 浅金描边
    edgeD:  'rgba(255,235,170,0.55)',   // 未选中描边
    text:   '#ffffff',
    textD:  '#f0fff7',
    gray:   '#b9c8c0',
    panel:  'rgba(0,0,0,0.78)',
    bg1:    '#12482f',
    bg2:    '#0a2417'
};

var BTN_W = 360, BTN_H = 74;
// 【间隙 22 -> 34】(2026-08-07) 678net.js 要在「多人游戏」按钮下方那道间隙里
// 画一行 17 号红字（天梯模式对局中人数）。17 号字加 4px 描边的实际墨迹约 21px，
// 22 的间隙塞进去上下各只剩 0.5px，看着是糊在两个按钮边上的。
// 34 的话净空 32px，字上下各留 4px 富余。
//
// 三道间隙一起放大（不是只放大那一道）—— 只改一道会让按钮组看着是排歪了。
// 按钮组底部锚定不变，3 个按钮时顶边按公式自动算出。
// 标题字（画在顶边 - 96）848 -> 824，都还在画面里。
var BTN_GAP = 34;
var BTN_BOTTOM = 70;                    // 按钮组距画面底部留出的空间

// 圆角矩形路径
function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

// 画一个按钮：渐变面 + 金边 + 顶部高光
// on = 选中/悬停态，press = 按下态（移动端手指按住时给反馈）
D678T.drawButton = function (bmp, x, y, w, h, on, press) {
    var ctx = bmp._context;
    ctx.save();
    if (press) { y += 2; h -= 2; }          // 按下时轻微下沉
    // 投影
    if (!press) {
        roundRect(ctx, x + 2, y + 4, w, h, 12);
        ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fill();
    }
    var g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, press ? TC.faceH2 : (on ? TC.faceH1 : TC.face1));
    g.addColorStop(1, press ? TC.face2  : (on ? TC.faceH2 : TC.face2));
    roundRect(ctx, x, y, w, h, 12);
    ctx.fillStyle = g;
    ctx.globalAlpha = press ? 1 : 0.92;     // 略透，不完全压住封面
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = (on || press) ? TC.edge : TC.edgeD;
    ctx.lineWidth = (on || press) ? 3 : 2;
    ctx.stroke();
    // 顶部高光
    roundRect(ctx, x + 6, y + 5, w - 12, Math.floor(h * 0.42), 8);
    var hg = ctx.createLinearGradient(0, y + 5, 0, y + 5 + h * 0.42);
    hg.addColorStop(0, 'rgba(255,255,255,' + (press ? 0.10 : (on ? 0.34 : 0.24)) + ')');
    hg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hg; ctx.fill();
    ctx.restore();
    bmp._setDirty();
};

// 命中测试
D678T.hitTest = function (list, x, y) {
    for (var i = 0; i < list.length; i++) {
        var b = list[i];
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return i;
    }
    return -1;
};

//=============================================================================
// 标题命令窗口：开始游戏 / 说明 / 功能牌图鉴
//
// 窗口本身整体隐藏，只留它的命令表与 handler（键盘/手柄仍能用）。
// 按钮改画在场景最顶层的独立精灵上（见下面 createTitleButtons），
// 这样不管封面图挂在背景层还是前景层，都不可能盖住按钮。
//=============================================================================

Window_TitleCommand.prototype.makeCommandList = function () {
    this.addCommand('开始游戏', 'newGame');
    this.addCommand('说明',     'gameHelp');
    this.addCommand('功能牌图鉴', 'funcCodex');
};

var _WTC_init = Window_TitleCommand.prototype.initialize;
Window_TitleCommand.prototype.initialize = function () {
    _WTC_init.call(this);
    this.visible = false;      // 不显示窗口，按钮由 _btnSprite 绘制
    this.opacity = 0;
};

Window_TitleCommand.prototype.updatePlacement = function () {
    this.x = -1000; this.y = -1000;   // 挪出画面，杜绝任何残影
};

// 窗口自带的触屏处理会“第一下选中、第二下确认”，移动端体验很差 ->
// 完全交给我们自己的单击直达逻辑
Window_TitleCommand.prototype.processTouch = function () {};

//=============================================================================
// Scene_Title：绑定说明，标题文字居中
//=============================================================================

var _ST_createCommandWindow = Scene_Title.prototype.createCommandWindow;
Scene_Title.prototype.createCommandWindow = function () {
    _ST_createCommandWindow.call(this);
    this._commandWindow.setHandler('gameHelp', this.commandGameHelp.bind(this));
    this._commandWindow.setHandler('funcCodex', this.commandFuncCodex.bind(this));
    this.createTitleButtons();
};

Scene_Title.prototype.commandGameHelp = function () {
    SceneManager.push(Scene_GameHelp);
};

Scene_Title.prototype.commandFuncCodex = function () {
    SceneManager.push(Scene_FuncCodex);
};

// 按钮层：最后 addChild，永远在封面图（背景层/前景层）与窗口层之上
Scene_Title.prototype.createTitleButtons = function () {
    var W = Graphics.width, H = Graphics.height;
    this._btnBmp = new Bitmap(W, H);
    this._btnSprite = new Sprite(this._btnBmp);
    this._btnSprite.z = 100;
    this.addChild(this._btnSprite);

    // 全部靠下排布，底部留出 BTN_BOTTOM 的空间
    // 最后两个按钮（说明 / 功能牌图鉴）左右并排，保持 3 行高度
    var list = this._commandWindow._list || [];
    var n = list.length;
    var pairLast = (n >= 4 &&
        list[n - 2].symbol === 'gameHelp' && list[n - 1].symbol === 'funcCodex');
    var rows = pairLast ? (n - 1) : n;
    var totalH = rows * BTN_H + (rows - 1) * BTN_GAP;
    var y0 = H - BTN_BOTTOM - totalH;
    if (y0 < 10) y0 = 10;
    var x = Math.round(W / 2 - BTN_W / 2);
    D678T._btnTop = y0;              // 供标题文字定位

    var halfW = Math.round((BTN_W - 16) / 2);   // 并排按钮各占一半，中间留 16 间距
    this._btns = [];
    for (var i = 0; i < n; i++) {
        if (pairLast && i >= n - 2) {
            var isLeft = (i === n - 2);
            this._btns.push({
                x: isLeft ? x : x + halfW + 16,
                y: y0 + (rows - 1) * (BTN_H + BTN_GAP),
                w: halfW, h: BTN_H,
                label: list[i].name, symbol: list[i].symbol, half: true
            });
        } else {
            this._btns.push({
                x: x, y: y0 + i * (BTN_H + BTN_GAP), w: BTN_W, h: BTN_H,
                label: list[i].name, symbol: list[i].symbol, half: false
            });
        }
    }
    this._btnPress = -1;
    this._btnCache = '';
    this.refreshTitleButtons();
};

// 高亮只跟「正在按下」走。命令窗口的下标和鼠标位置都不参与绘制 ——
// 原来是 on = (i === _btnHover) || (_btnHover < 0 && i === idx)，
// 两截都会造成「某个按钮莫名亮着」：idx 那截让当前下标常驻高亮，
// _btnHover 那截会捡到上一个场景遗留的触摸坐标（详见 updateTitleButtons）。
// 键盘和手柄照旧能用（命令表与 handler 都还在），只是屏幕上不显示光标位置。
Scene_Title.prototype.refreshTitleButtons = function () {
    var key = String(this._btnPress);
    if (key === this._btnCache) return;      // 没变化就不重画，省开销
    this._btnCache = key;

    var bmp = this._btnBmp;
    bmp.clear();
    for (var i = 0; i < this._btns.length; i++) {
        var b = this._btns[i];
        var press = (i === this._btnPress);
        var on = press;
        D678T.drawButton(bmp, b.x, b.y, b.w, b.h, on, press);
        bmp.fontSize = b.half ? 24 : 30;
        bmp.textColor = (on || press) ? TC.edge : TC.textD;
        bmp.outlineColor = 'rgba(0,0,0,0.8)';
        bmp.outlineWidth = 4;
        bmp.drawText(b.label, b.x, b.y + (BTN_H - 38) / 2 + (press ? 2 : 0),
            b.w, 38, 'center');
    }
};

// 移动端：手指按下即高亮，抬起时若还在同一个按钮上就直接执行（单击直达）
var _ST_update = Scene_Title.prototype.update;
Scene_Title.prototype.update = function () {
    _ST_update.call(this);
    this.updateTitleButtons();
};

// 只认「按下」，不认「悬停」。
//
// RMMV 里没有真正的悬停：TouchInput._onMouseMove 只在按住时才更新 x/y，
// 鼠标空移根本不动坐标，触屏更是停在最后一次触摸点不放。所以原来那个
// _btnHover 从来不是悬停，只是「上次按的位置」，而且下一次触摸之前一直不变。
//
// 这造成一个实际 bug：大厅的「返回」按钮（x 250–470, y 1170–1232）正好压在
// 标题的「说明」按钮（x 180–540, y 1136–1210）上。点返回弹回标题后，坐标
// 还停在那儿，下一帧 _btnHover 就被算成「说明」并且一直亮着 ——
// 表现就是「每次从多人游戏出来都默认选中说明」。
//
// 这两块必然重叠，不是巧合：按钮组底部锚定（BTN_BOTTOM=70），最后一个按钮
// 永远贴在 y 1136–1210；而大厅的返回按钮也贴着底边。所以就算以后往标题
// 加减命令项，最后那一个还是会被返回按钮的坐标扫到。
Scene_Title.prototype.updateTitleButtons = function () {
    if (!this._btns || !this._btnSprite) return;
    var w = this._commandWindow;
    // 淡入中 / 窗口没激活（正在切场景）时不接受点击
    var live = !!w && w.active && !this.isBusy() && !SceneManager.isSceneChanging();
    this._btnSprite.visible = true;

    if (!live) {
        if (this._btnPress >= 0) {
            this._btnPress = -1;
            this.refreshTitleButtons();
        }
        return;
    }

    var hit = D678T.hitTest(this._btns, TouchInput.x, TouchInput.y);

    if (TouchInput.isPressed()) {
        // 只在真的「这一下刚按下」时才认，避免把上一个场景遗留的按压状态算进来
        if (this._btnPress < 0 && TouchInput.isTriggered() && hit >= 0) {
            this._btnPress = hit;
            this._commandWindow.select(hit);   // 同步键盘光标，不影响绘制
            SoundManager.playCursor();
        } else if (this._btnPress >= 0 && hit !== this._btnPress) {
            this._btnPress = -1;      // 手指滑出按钮 -> 取消
        }
    } else {
        if (TouchInput.isReleased() && this._btnPress >= 0 && hit === this._btnPress) {
            var b = this._btns[this._btnPress];
            this._btnPress = -1;
            this.refreshTitleButtons();
            this.callTitleButton(b.symbol);
            return;
        }
        this._btnPress = -1;
    }
    this.refreshTitleButtons();
};

Scene_Title.prototype.callTitleButton = function (symbol) {
    var w = this._commandWindow;
    if (!w || !w.active) return;
    SoundManager.playOk();
    w.deactivate();
    if (symbol === 'newGame')  { this.commandNewGame(); return; }
    if (symbol === 'gameHelp') { this.commandGameHelp(); w.activate(); return; }
    if (symbol === 'funcCodex') { this.commandFuncCodex(); w.activate(); return; }
};

// 从说明画面返回后重新激活按钮
var _ST_start = Scene_Title.prototype.start;
Scene_Title.prototype.start = function () {
    _ST_start.call(this);
    if (this._commandWindow) this._commandWindow.activate();
    this._btnPress = -1;
    // 缓存清空强制重画一次 —— 从别的场景弹回来时确保没有残留高亮
    this._btnCache = '';
    this.refreshTitleButtons();
};

// 标题居中，紧贴在按钮组上方（整块文字都在画面下部）
Scene_Title.prototype.drawGameTitle = function () {
    var w = Graphics.width;
    var top = D678T._btnTop;
    if (top === undefined) {
        // 还没建按钮时按同样的规则先算一次（命令数按 3 估）
        var totalH = 3 * BTN_H + 2 * BTN_GAP;
        top = Graphics.height - BTN_BOTTOM - totalH;
    }
    var y = top - 96;
    if (y < 0) y = 0;
    var bmp = this._gameTitleSprite.bitmap;
    bmp.fontSize = 56;
    bmp.textColor = TC.text;
    bmp.outlineColor = 'rgba(0,0,0,0.85)';
    bmp.outlineWidth = 8;
    bmp.drawText($dataSystem.gameTitle, 0, y, w, 64, 'center');
};

//=============================================================================
// Scene_GameHelp：说明画面
//=============================================================================

function Scene_GameHelp() { this.initialize.apply(this, arguments); }
Scene_GameHelp.prototype = Object.create(Scene_Base.prototype);
Scene_GameHelp.prototype.constructor = Scene_GameHelp;
window.Scene_GameHelp = Scene_GameHelp;

Scene_GameHelp.prototype.initialize = function () {
    Scene_Base.prototype.initialize.call(this);
};

Scene_GameHelp.prototype.create = function () {
    Scene_Base.prototype.create.call(this);
    var bg = new Bitmap(Graphics.width, Graphics.height);
    var ctx = bg._context;
    var g = ctx.createLinearGradient(0, 0, 0, Graphics.height);
    g.addColorStop(0, TC.bg1); g.addColorStop(1, TC.bg2);
    ctx.fillStyle = g; ctx.fillRect(0, 0, Graphics.width, Graphics.height);
    bg._setDirty();
    this.addChild(new Sprite(bg));
    this._bmp = new Bitmap(Graphics.width, Graphics.height);
    this.addChild(new Sprite(this._bmp));
    this.refresh();
};

Scene_GameHelp.prototype.start = function () {
    Scene_Base.prototype.start.call(this);
    this.startFadeIn(this.fadeSpeed(), false);
};

// 正文取行：既接受数组，也接受一整段带换行的字符串
Scene_GameHelp.prototype.lines = function () {
    var l = D678T.HELP_LINES;
    if (typeof l === 'string') {
        l = l.replace(/\r\n/g, '\n').split('\n');
        // 反引号写法常带缩进，统一去掉每行行首行尾空白
        l = l.map(function (s) { return s.replace(/^[ \t]+|[ \t]+$/g, ''); });
        while (l.length && l[0] === '') l.shift();
        while (l.length && l[l.length - 1] === '') l.pop();
    }
    if (!l || !l.length) return ['（说明内容尚未填写）'];
    return l;
};

Scene_GameHelp.prototype.txt = function (s, x, y, w, size, color, align) {
    var b = this._bmp;
    b.fontSize = size;
    b.textColor = color || TC.text;
    b.outlineColor = 'rgba(0,0,0,0.8)';
    b.outlineWidth = 4;
    b.drawText(s, x, y, w, size + 10, align || 'left');
};

Scene_GameHelp.prototype.refresh = function () {
    var b = this._bmp, W = Graphics.width, H = Graphics.height;
    b.clear();

    // 面板
    var px = 40, py = 60, pw = W - 80, ph = H - 160;
    var ctx = b._context;
    ctx.save();
    roundRect(ctx, px, py, pw, ph, 14);
    ctx.fillStyle = TC.panel; ctx.fill();
    ctx.strokeStyle = TC.edge; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
    b._setDirty();

    this.txt(D678T.HELP_TITLE || '说明', px, py + 26, pw, 34, TC.edge, 'center');
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px + 30, py + 82); ctx.lineTo(px + pw - 30, py + 82); ctx.stroke();
    ctx.restore();
    b._setDirty();

    var lines = this.lines();
    for (var i = 0; i < lines.length; i++) {
        this.txt(String(lines[i]), px + 40, py + 108 + i * 38, pw - 80, 24, TC.text, 'left');
    }

    this.txt('点击任意位置返回', 0, H - 76, W, 22, TC.gray, 'center');
};

// 点任意位置 / 按任意确认键都返回标题
Scene_GameHelp.prototype.update = function () {
    Scene_Base.prototype.update.call(this);
    // 开头几帧不收输入，避免“进入说明”那一下的按键/触摸被当成返回
    if (this._guard === undefined) this._guard = 12;
    if (this._guard > 0) { this._guard--; return; }
    if (Input.isTriggered('cancel') || Input.isTriggered('ok')) {
        SoundManager.playCancel();
        this.popScene();
        return;
    }
    if (TouchInput.isTriggered()) {
        SoundManager.playCancel();
        this.popScene();
    }
};

Scene_GameHelp.prototype.popScene = function () {
    if (this._popped) return;
    this._popped = true;
    SceneManager.pop();
};

//=============================================================================
// Scene_FuncCodex：功能牌图鉴
//=============================================================================

function Scene_FuncCodex() { this.initialize.apply(this, arguments); }
Scene_FuncCodex.prototype = Object.create(Scene_Base.prototype);
Scene_FuncCodex.prototype.constructor = Scene_FuncCodex;
window.Scene_FuncCodex = Scene_FuncCodex;

Scene_FuncCodex.prototype.initialize = function () {
    Scene_Base.prototype.initialize.call(this);
    this._page = 0;
    this._guard = 12;
};

// 每页 2 列 × 3 行 = 6 张。32 张牌 → 6 页。
Scene_FuncCodex.PAGE_SIZE = 6;
Scene_FuncCodex.COLS = 2;

Scene_FuncCodex.prototype.create = function () {
    Scene_Base.prototype.create.call(this);

    // 背景
    var bg = new Bitmap(Graphics.width, Graphics.height);
    var ctx = bg._context;
    var g = ctx.createLinearGradient(0, 0, 0, Graphics.height);
    g.addColorStop(0, TC.bg1); g.addColorStop(1, TC.bg2);
    ctx.fillStyle = g; ctx.fillRect(0, 0, Graphics.width, Graphics.height);
    bg._setDirty();
    this.addChild(new Sprite(bg));

    // 文字层
    this._bmp = new Bitmap(Graphics.width, Graphics.height);
    this.addChild(new Sprite(this._bmp));

    // 卡图精灵层
    this._cardLayer = new Sprite();
    this.addChild(this._cardLayer);
    this._cardSprites = [];

    this._funcs = (typeof D678 !== 'undefined' && D678.FUNCS) ? D678.FUNCS : [];
    this._pages = Math.max(1, Math.ceil(this._funcs.length / Scene_FuncCodex.PAGE_SIZE));

    this.refresh();
};

Scene_FuncCodex.prototype.start = function () {
    Scene_Base.prototype.start.call(this);
    this.startFadeIn(this.fadeSpeed(), false);
};

Scene_FuncCodex.prototype.txt = function (s, x, y, w, size, color, align) {
    var b = this._bmp;
    b.fontSize = size;
    b.textColor = color || TC.text;
    b.outlineColor = 'rgba(0,0,0,0.8)';
    b.outlineWidth = 4;
    b.drawText(s, x, y, w, size + 10, align || 'left');
};

// 卡图原始尺寸 360×510，图鉴里缩到 150×213
Scene_FuncCodex.IMG_W = 150;
Scene_FuncCodex.IMG_H = 213;

Scene_FuncCodex.prototype.refresh = function () {
    var W = Graphics.width, H = Graphics.height;
    var b = this._bmp;
    b.clear();

    // 清掉旧精灵
    for (var i = 0; i < this._cardSprites.length; i++) {
        this._cardLayer.removeChild(this._cardSprites[i]);
    }
    this._cardSprites = [];

    // 标题
    this.txt('功能牌图鉴', 0, 40, W, 36, TC.edge, 'center');

    var ctx = b._context;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(80, 92); ctx.lineTo(W - 80, 92); ctx.stroke();
    ctx.restore();
    b._setDirty();

    // 布局
    var cols = Scene_FuncCodex.COLS;
    var imgW = Scene_FuncCodex.IMG_W, imgH = Scene_FuncCodex.IMG_H;
    var cellW = 320;                         // 每格宽（720 / 2 - 40 间距）
    var cellH = imgH + 24 + 96;              // 卡图 + 名 + 说明(4行)
    var gridW = cols * cellW;
    var startX = Math.round((W - gridW) / 2);
    var startY = 120;
    var textH = 20;                          // 每行说明文字高

    var start = this._page * Scene_FuncCodex.PAGE_SIZE;
    var end = Math.min(start + Scene_FuncCodex.PAGE_SIZE, this._funcs.length);

    for (var idx = start; idx < end; idx++) {
        var f = this._funcs[idx];
        var slot = idx - start;
        var col = slot % cols;
        var row = Math.floor(slot / cols);
        var cx = startX + col * cellW;
        var cy = startY + row * cellH;

        // 卡图精灵
        var sp = new Sprite(ImageManager.loadPicture(f.img));
        sp.scale.x = sp.scale.y = imgW / 360;
        sp.x = cx + Math.round((cellW - imgW) / 2);
        sp.y = cy;
        this._cardLayer.addChild(sp);
        this._cardSprites.push(sp);

        // 名称
        this.txt(f.name, cx, cy + imgH + 2, cellW, 22, TC.edge, 'center');

        // 说明（按 \n 分行，最多 4 行）
        var lines = (f.desc || '').split('\n');
        for (var li = 0; li < Math.min(lines.length, 4); li++) {
            this.txt(lines[li], cx + 8, cy + imgH + 28 + li * textH,
                     cellW - 16, 16, TC.gray, 'center');
        }
    }

    // 底部：页码 + 按钮
    var by = H - 130;
    this.txt((this._page + 1) + ' / ' + this._pages, 0, by, W, 24, TC.gray, 'center');

    // 上一页 / 下一页 / 返回
    var bw = 160, bh = 54, gap = 24;
    var btns = [
        { label: '上一页', x: Math.round(W / 2 - bw * 1.5 - gap),      enabled: this._page > 0 },
        { label: '下一页', x: Math.round(W / 2 - bw / 2),              enabled: this._page < this._pages - 1 },
        { label: '返回',   x: Math.round(W / 2 + bw / 2 + gap),        enabled: true },
    ];
    this._codexBtns = [];
    for (var bi = 0; bi < btns.length; bi++) {
        var bt = btns[bi];
        var press = (this._btnPress === bi);
        var on = bt.enabled;
        ctx.save();
        roundRect(ctx, bt.x, by + 36, bw, bh, 10);
        var g2 = ctx.createLinearGradient(0, by + 36, 0, by + 36 + bh);
        if (!on) { g2.addColorStop(0, '#2a3a34'); g2.addColorStop(1, '#1a2a24'); }
        else if (press) { g2.addColorStop(0, TC.faceH1); g2.addColorStop(1, TC.faceH2); }
        else { g2.addColorStop(0, TC.face1); g2.addColorStop(1, TC.face2); }
        ctx.fillStyle = g2; ctx.fill();
        ctx.strokeStyle = on ? TC.edge : TC.edgeD; ctx.lineWidth = 2; ctx.stroke();
        ctx.restore();
        b._setDirty();
        this.txt(bt.label, bt.x, by + 36 + (bh - 28) / 2 + (press ? 2 : 0),
                 bw, 28, on ? (press ? TC.edge : TC.textD) : TC.gray, 'center');
        this._codexBtns.push({ x: bt.x, y: by + 36, w: bw, h: bh, enabled: on, idx: bi });
    }
    this._btnPress = -1;
};

Scene_FuncCodex.prototype.update = function () {
    Scene_Base.prototype.update.call(this);
    // 匹配中开着图鉴时对局开始了 —— 自动关掉，让 D678Net 接手进对局场景。
    // _codexBack 只有从 D678Net push 进来时才非空（标题画面开的图鉴是 null），
    // 所以不会误触发。states 到了 = 开赛盘面已就绪，pop 后 D678Net.start
    // 恢复匹配页，第一帧 pollNet 就把 Scene_D678 推上去。
    if (D678N._codexBack && D678N.inbox &&
        D678N.inbox.states && D678N.inbox.states.length > 0) {
        this.popScene();
        return;
    }
    if (this._guard > 0) { this._guard--; return; }

    // 键盘：左右翻页，确认/取消返回
    if (Input.isTriggered('left') && this._page > 0) {
        SoundManager.playCursor();
        this._page--;
        this.refresh();
        return;
    }
    if (Input.isTriggered('right') && this._page < this._pages - 1) {
        SoundManager.playCursor();
        this._page++;
        this.refresh();
        return;
    }
    if (Input.isTriggered('cancel') || Input.isTriggered('ok')) {
        SoundManager.playCancel();
        this.popScene();
        return;
    }

    // 触屏
    var hit = -1;
    for (var i = 0; i < this._codexBtns.length; i++) {
        var bt = this._codexBtns[i];
        if (!bt.enabled) continue;
        if (TouchInput.x >= bt.x && TouchInput.x < bt.x + bt.w &&
            TouchInput.y >= bt.y && TouchInput.y < bt.y + bt.h) { hit = i; break; }
    }

    if (TouchInput.isTriggered() && hit >= 0) {
        SoundManager.playOk();
        if (hit === 0 && this._page > 0) { this._page--; this.refresh(); return; }
        if (hit === 1 && this._page < this._pages - 1) { this._page++; this.refresh(); return; }
        if (hit === 2) { this.popScene(); return; }
    }

    // 按下高亮
    if (TouchInput.isPressed() && hit >= 0) {
        if (this._btnPress !== hit) { this._btnPress = hit; this.refresh(); }
    } else if (this._btnPress >= 0) {
        this._btnPress = -1;
        this.refresh();
    }
};

Scene_FuncCodex.prototype.popScene = function () {
    if (this._popped) return;
    this._popped = true;
    SceneManager.pop();
};

})();
