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
// 卡牌图的**源图**尺寸。绘制代码一律用「目标宽 / D678.CARD_W」算缩放比
// （见 678.js 里所有 sp.scale.x 的赋值），所以换了图就必须同步改这里，
// 否则卡牌会整体画错大小 —— 源图缩一半而这里不改，牌就变成两倍大。
//
// 2026-08-03 从 720x1020 PNG 改成 360x510 JPEG：屏幕上最大只画到 118px，
// 原来那个尺寸等于下了 37 倍于所需的像素，36 张 32MB。
// 详见 678.js 里 ImageManager.loadPicture 那段注释。
//
// 【服务器不读这两个】它们纯属绘制层。这份文件浏览器和服务器共用，
// 但 server.js 一次都没引用过 CARD_W/CARD_H —— 改它不影响任何规则。
D678.CARD_W     = 360;
D678.CARD_H     = 510;

// 我方暗牌的蒙版色调 [r, g, b, gray]，范围 -255~255。
// 负值压暗，数值越小蒙版越重；-72 大约是压暗 28%，牌面依然清楚可辨。
D678.HOLE_TONE  = [-72, -72, -72, 0];

// 复制品（copy 造出来的假牌）的色调。压绿、抬红蓝 -> 偏紫，
// 和 COL.purple(#c98bff) 同一个色系，玩家一眼能认出「这张不是真的」。
// +1/-1 也是假牌但**不染色** —— 它们本来就有自己的卡图，不会跟真牌混淆。
D678.FAKE_TONE  = [30, -70, 60, 0];

// AI 名单：以后要加人，只在这个数组里加一行字符串即可。
// 超哥固定登场，其余从名单里随机抽 D678.AI_COUNT 位。
D678.AI_NAMES = [
    '超哥',
    '蒙奇D路痴', '撸本萎', '法国赌神', '大师兄', '嘎子哥', '武藤游戏','明明如意','我叫阿逼','山鸡不会飞','不知火爆','阿伟已经赢了','强如人机','里昂',
    '赌圣', '花开富贵', '亚瑟', '炉石玩家', '周树人', '周杰棍', '柯南', '承太郎', '哈基米', '城之内', '我爱斗地主', '贝克汉姆', '杰哥你很勇', '华强买瓜',
    '草莓姐姐', '潮汕浪趴兄', '最强大脑凯文', '十一', '图图', '我不会打牌', '神之一手', '圣诞老登', '哥只是传说', '奥本海默', '祥子不吃翔', '翠西'
];
D678.GOD_NAME = '超哥';   // 已知牌库顺序 + 所有底牌的AI，单机必定登场
D678.AI_COUNT = 6;        // 超哥之外随机登场的AI数量

//--- 天梯 AI 名单 ----------------------------------------------------------
// 和上面的 AI_NAMES **完全不重叠**，是另一套人（你定的）。单机永远用 AI_NAMES，
// 天梯永远用这一份 —— 两边的名字撞车会让「天梯榜上的人」和「单机里的人」
// 看起来是同一批，那份「天梯上有一堆真人在玩」的错觉就没了。
//
// 【为什么是 300 个】2026-08-10 从 115 扩到 300。理由是**牌桌撞名**，不是榜：
// 每局从这份名单洗牌抽 7 个（见下面的 rollLadNames），115 个的时候连着两局
// 至少撞一个名字的概率约 35% —— 用户报「经常遇到同一个 AI」就是这个组合数学。
// 300 个把它压到约 15%。
//
//   名单大小    连续两局撞名概率
//   115             ~35%
//   200             ~19%
//   300             ~15%
//   500             ~10%
//
// 【为什么停在 300，不是 500】真人起点是 1000 分，而榜改为 300 行
// （LAD_BOARD_N）。名单越大，1000 分那条线上面挤的 AI 越多：
//
//   名单大小    1000 分以上的 AI    新人（1000 分）大致名次
//   115              55                  ~56（榜上看得见自己）
//   300             ~147                ~148（未上榜）
//   500             ~244                ~245（未上榜）
//
// 300 已经会把刚定级完的新人挤出前 300。**这是你 2026-08-10 拍板接受的**
// （「真人玩得不好肯定也会不上榜」）—— 榜是高手榜，不是花名册。往上再加
// 就只是让这个效果更极端，同时把跨季那一次重放的开销也一起放大，
// 而撞名概率从 15% 到 10% 已经感觉不出来了。
//
// 【名单大小只决定天花板，不决定上线初的人数】那个闸门是 10 场门槛。
// 实测两条曲线形状一模一样、只是等比放大：
//
//   上线后        47 名单    115 名单
//   0.5 天           0          0
//   1 天            28         64
//   2 天            43        104
//   3 天            46        113
//   4 天            47        115（满）
//
// 【新增的 185 个不影响现有 115 行】人格是逐名字独立哈希的，所以老名字的
// 分数、场次、历史一个都没动。但**榜首和所有名次会整个重排** —— 新人里
// 必然有比原榜首更强的。
//
// 【全部 4-8 字、纯汉字/字母/数字】必须过 server.js 的 chkLadName ——
// 真人能取的名字范围和 AI 一致，否则「这个名字我取不了」就露出 AI 了。
//
// 【为什么掺 30% 英文】2026-08-07 换过一版。上一版 115 个全是中文，而且
// 大半写成了句子（「一把梭哈就完事」「我妈叫我吃饭」），整份名单一眼看出是
// 同一支笔写的 —— 真人 ID 更短、更像代号，而且中文玩家里英文名 + 数字
// （Mike520 这种）是最常见的形态之一。所以按中文 7 / 英文 3 的比例掺。
//
// 【改名单等于换人】分数、场次、冠军、平均名次全是 ladPersona 从名字哈希
// 出来的（见 server.js 的 ladPersona）。动这个数组，榜上那些行连同它们的
// 历史一起换一批人，榜首和名次会整个重排。
D678.LAD_AI_NAMES = [
    //--- 中文 80 ---
    // 打牌口气
    '要牌狂魔', '停牌保平', '逢七必爆', '见八就停', '三张就够了',
    '爆牌小天才', '暗牌先生', '明牌给你看', '牛牛克星', '比多我不行',
    '洗牌的手', '荷官很偏心', '底牌是七', '点数刚刚好',
    // 运气玄学
    '欧皇本人', '非酋附体', '玄不救非', '十连保底', '概率学徒',
    '反向玄学家', '拜过关二爷', '手感发烫', '今日运气佳', '昨天赢过一把',
    '直觉流选手', '天选之人',
    // 天梯人格
    '常年第八名', '掉分大师', '上分好难', '段位是买的', '天梯民工',
    '排位狂人', '稳如老狗', '会算牌的猫', '我不是AI', '真人玩家一号',
    '查无此人', '路人甲乙丙',
    // 生活切片
    '午休摸鱼中', '加班到十点', '打工人甲', '摸鱼冠军', '老板在身后',
    '我在会议中', '厕所五分钟', '通勤地铁上', '排队等奶茶', '泡面三分钟',
    '外卖到了', '猫踩键盘', '陪娃写作业', '睡前最后一把',
    // 设备与网络
    '网速堪忧', '掉线小王子', '电量告急', '充电线在哪', '流量不多了',
    '信号只一格', '高铁上打牌', '手滑点错了',
    // 心态
    '心态已崩', '这局不算', '重开一把', '最后一局了', '说好只玩一把',
    '明天再战', '我就是不服', '再来十把',
    // 人物感
    '隔壁老陈', '楼下大爷', '夜班保安小王', '通宵战神', '起床困难户',
    '咖啡续命中', '熬夜冠军', '早班公交司机',
    // 杂
    '空调二十六', '躺着打牌', '单手操作', '新手请指教',

    //--- 中文 +130（2026-08-10 扩到 300 时加的）---
    // 打牌口气
    '补牌到七', '停在六点', '爆了就爆', '我要梭了', '这张给我',
    '不要了谢谢', '差一点爆', '稳住不动', '看牌不说话', '底牌好看',
    '点数虚高', '七点封顶', '八点也敢要', '摸到就赢', '手气在牌里',
    '弃牌保命', '全下试试', '慢慢出牌', '先看看再说', '牌好人不好',
    '洗牌快一点', '发牌请偏心', '明牌也不怕', '暗牌更刺激', '这副牌认识我',
    // 运气玄学
    '锦鲤附体', '转发这条', '保底出奇迹', '一发入魂', '玄学爱好者',
    '逆天改命中', '拜过财神爷', '抽卡歪了', '今日不宜', '手气回来了',
    '昨晚梦到七', '概率骗人', '大数定律', '运气守恒', '攒了三天运',
    '小赌怡情', '今天很旺', '命里缺七', '求个好牌', '摸牌先搓手',
    // 天梯人格
    '卡在青铜', '分数虚高', '掉到解放前', '我是分奴', '天梯代练',
    '冲榜失败', '打完就跑', '保分选手', '苟到第三', '只想上榜',
    '混子一枚', '榜上无名', '昨天还第一', '我真的是人', '段位不重要',
    '排名焦虑', '打到手抽筋', '天梯钉子户', '分数原地踏步',
    // 生活切片
    '早班挤地铁', '午饭排长队', '周报还没写', '打卡完毕', '老板刚走',
    '甲方又改', '电梯里两分钟', '等外卖中', '泡面已泡好', '下班倒计时',
    '加班狗一只', '娃睡了终于', '洗碗前一局', '遛狗回来打', '快递到楼下',
    '上厕所带手机', '吃饭不看牌', '边走边打', '蹲在阳台', '沙发上瘫着',
    '被窝里打牌', '会议第三小时',
    // 设备与网络
    '又卡住了', '手机发烫', '五格信号', '断线重连中', '只剩一格电',
    '数据流量党', '屏幕裂了', '充电中打牌', '耳机没电', '触屏不灵',
    '换机重登', '后台在更新', '移动网络差', '连的邻居网', '隧道里断了',
    '电脑上打的',
    // 心态
    '我不服气', '再赌一把', '说走就走', '佛系打牌', '输了就睡',
    '赢了就跑', '下次一定', '别急别急', '手别抖了', '平常心就好',
    '已经不生气', '冷静分析中', '破罐破摔', '就玩这一局', '认真起来了',
    '稳住别急',
    // 人物感
    '楼上大姐', '门口保安老李', '前排小张', '后厨老赵', '隔壁班同学',
    '夜市摊主', '三楼租客', '值夜班的', '早点铺老板', '快递小哥王',
    '出租车司机', '校门口小卖部',

    //--- 英文 35 ---
    // 牌桌术语
    'AllIn666', 'Bet7Win', 'Draw2Win', 'Ace777', 'Sev7n',
    'Bust8', 'Stand21', 'HitMe7', 'LastCall', 'OneMore7',
    // 运气
    'LuckyDog', 'NoLuck66', 'GodBless', 'RNGesus', 'Fortune8', 'Unlucky7',
    // 英文名 + 数字
    'Kevin7', 'Mike520', 'Jayden88', 'Nana233', 'Coco1024',
    'Ryan0721', 'Yuki1108', 'Leo1995', 'TomCat88',
    // 游戏黑话
    'GGWP66', 'EZWin7', 'AFKing', 'NoobKing', 'TiltKing', 'Rekt777',
    // 生活 / 设备
    'Sleepy7', 'Coffee6', 'Lagging', 'LowBatt',

    //--- 英文 +55（2026-08-10 扩到 300 时加的）---
    // 牌桌术语
    'Hit17', 'Stay7', 'Bust77', 'Deck66', 'Flop7',
    'Raise8', 'Fold77', 'Split8', 'Push66', 'Chip777',
    'Deal7', 'Hole7', 'Soft17', 'Hard8',
    // 运气
    'Lucky88', 'Charm7', 'Omen777', 'Jinx66', 'Karma8',
    'Wish777', 'Fate66', 'Roll777', 'Curse7', 'Bless88',
    // 英文名 + 数字
    'Alex0803', 'Bella520', 'Chris66', 'Daisy77', 'Eric1024',
    'Fiona88', 'Grace233', 'Henry21', 'Iris1108', 'Jack1995',
    'Kate666', 'Lucas77', 'Momo520', 'Nick0917', 'Olive88',
    'Peter233', 'Queen77',
    // 游戏黑话
    'GGEZ77', 'Noob666', 'Pwned7', 'Camping7', 'Smurf88',
    'Clutch7', 'Nerfed7', 'Buffed8',
    // 生活 / 设备
    'Tired77', 'Mocha7', 'Latte66', 'WiFi666', 'Charge8',
    'Offline7',
];

// 天梯里「超哥」（知道牌库顺序的那套逻辑）有几个登场。
// 0 个 75% / 1 个 20% / 2 个 5%（你定的）。
//
// 【为什么不是必定登场】单机里他每局都在，天梯里那等于给所有人加一道
// 固定的税 —— 实测他会系统性吃掉真人一个名次，真人的分数天花板被压低。
// 变成 1/4 出场后他仍是明确的「boss 局」，但不再是常态。
//
// 【为什么是个函数而不是常量】测试要能钉死数量。概率性的东西写进断言
// 就是随机失败（_test_tourney 里「超哥该在场」那条就是这么挂的），
// 所以留一个 forceN 覆写口：给了就用给的，没给才抽。
D678.LAD_GOD_FORCE = null;   // 测试用：设成 0/1/2 就固定那么多个
D678.rollGodN = function () {
    if (D678.LAD_GOD_FORCE !== null) return D678.LAD_GOD_FORCE;
    var u = Math.random();
    if (u < 0.75) return 0;
    if (u < 0.95) return 1;
    return 2;
};

// 天梯本局的 AI 名单：从 LAD_AI_NAMES 里随机抽 n 个，不重名。
// exclude 是要避开的名字（真人自己的天梯名）—— 撞上的话榜和排名表里
// 会出现两个同名的人，分不出哪个是自己。
D678.rollLadNames = function (n, exclude) {
    var ex = (exclude || '').trim();
    var pool = [];
    for (var i = 0; i < D678.LAD_AI_NAMES.length; i++) {
        var nm = D678.LAD_AI_NAMES[i];
        if (ex && nm === ex) continue;
        pool.push(nm);
    }
    return D678.shuffle(pool).slice(0, Math.max(0, n));
};

// 单机里「我」叫什么。
//
// 【为什么是个可覆写的钩子，而不是直接读 localStorage】这个文件是纯规则层，
// server.js 用 require 加载它跑在 Node 里，那边没有 localStorage，
// 直接读会当场抛异常。所以核心只留默认值，由客户端（678net.js）覆写成
// 大厅里设的昵称 —— 插件加载顺序是 678core 在前、678net 在后，
// 而单机对局是玩家进游戏之后才建的，覆写一定赶得上。
D678.humanName = function () { return '我'; };

// 本局登场的AI名单：超哥 + 随机 AI_COUNT 位，顺序打乱。
// exclude 是要避开的名字（玩家自己的昵称）—— 名单里本来就有「阿德」「老王」
// 这类常见昵称，撞上的话排名表里会出现两个同名的人，分不出哪个是自己。
// 抽之前先把它从池子里摘掉，比抽完再换更省事，也保证 7 个 AI 之间不重名。
D678.rollAINames = function (exclude) {
    var ex = (exclude || '').trim();
    var pool = [];
    for (var i = 0; i < D678.AI_NAMES.length; i++) {
        var nm = D678.AI_NAMES[i];
        if (nm === D678.GOD_NAME) continue;
        if (ex && nm.trim() === ex) continue;      // 跟玩家同名，避开
        pool.push(nm);
    }
    var picked = D678.shuffle(pool).slice(0, D678.AI_COUNT);
    // 兜底：万一以后名单被删到不够 AI_COUNT 个，宁可重复也别少人
    // （少人会让 alivePlayers / 名次计算全部错位）
    while (picked.length < D678.AI_COUNT && pool.length) {
        picked.push(pool[picked.length % pool.length]);
    }
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
    // 【卡面说明里不再写「对方之前的过牌作废」】那条逻辑还在（见 useFunc 之后
    // 界面/服务器把对方的 stood 清掉那段），只是不往卡面上写了 —— 你定的。
    D678.FUNCS.push({ id: 'swap', img: 'swap', name: '互换明牌', kind: 'swap',
        desc: '将双方最新的一张明牌互相交换。\n不消耗回合。' });
    D678.FUNCS.push({ id: 'return', img: 'return', name: '退回明牌', kind: 'return',
        desc: '将自己最新的一张明牌退回牌库底部\n（本局最后才会被抽到）。\n不消耗回合。' });
    D678.FUNCS.push({ id: 'rob', img: 'rob', name: '强夺', kind: 'rob',
        desc: '夺取对方最新的一张明牌放到自己场上。\n不消耗回合。' });
    // 【id / img 仍是 pickback】只改玩家看到的名字。id 是存档与联机协议的一部分
    // （玩家手上的功能牌按 id 存），img 对应 img/pictures/pickback.jpg。
    D678.FUNCS.push({ id: 'pickback', img: 'pickback', name: '抽暗牌', kind: 'pickback',
        desc: '进行一次普通抽牌，但该牌以背面放置，\n对方无法看到（自己可见）。\n抽牌后本回合结束。' });
    D678.FUNCS.push({ id: 'rule18', img: 'rule18', name: '规则18', kind: 'rule',
        desc: '规则变为 18 点，超过 18 点即爆牌。\n规则牌互相覆盖，场上只存在一张。\n不消耗回合。' });
    D678.FUNCS.push({ id: 'rule24', img: 'rule24', name: '规则24', kind: 'rule',
        desc: '规则变为 24 点，超过 24 点即爆牌。\n规则牌互相覆盖，场上只存在一张。\n不消耗回合。' });
    D678.FUNCS.push({ id: 'rule+1', img: 'rule+1', name: '规则+1', kind: 'rule',
        desc: '场上所有牌（含底牌与之后抽到的牌）点数 +1，\n目标点数仍为 21。\n规则牌互相覆盖，场上只存在一张。\n不消耗回合。' });
    D678.FUNCS.push({ id: 'rule-1', img: 'rule-1', name: '规则-1', kind: 'rule',
        desc: '场上所有牌（含底牌与之后抽到的牌）点数 -1，\n目标点数仍为 21。\n规则牌互相覆盖，场上只存在一张。\n不消耗回合。' });
    D678.FUNCS.push({ id: 'rule>21', img: 'rule21', name: '规则大21', kind: 'rule',
        desc: '低于 21 点视为爆牌，21 点为满点，\n高于 21 点为有效点数，双方都超过时以接近 21 者获胜。\n规则牌互相覆盖，场上只存在一张。\n不消耗回合。' });
    D678.FUNCS.push({ id: 'check', img: 'check', name: '查看牌库', kind: 'check',
        desc: '查看牌库顶部 4 张牌（不足则显示剩余）。\n结果会常驻显示，只有自己可见。\n不消耗回合。' });
    D678.FUNCS.push({ id: 'repick', img: 'repick', name: '重抽', kind: 'repick',
        desc: '将自己最新的一张明牌洗进牌库，然后重抽一张（明牌）。\n刚洗回去的那个数字这次抽不到。\n抽牌后本回合结束。' });
    D678.FUNCS.push({ id: 'reback', img: 'reback', name: '干扰', kind: 'reback',
        desc: '强制替换对方的第一张底牌，\n换上来的数字一定不是原来那张。\n换下的牌洗回牌库。\n不消耗回合。' });
    D678.FUNCS.push({ id: 'picksmall', img: 'picksmall', name: '抽小', kind: 'picksmall',
        desc: '抽出目前牌库中最小的那张数字牌（明牌）。\n抽牌后本回合结束。' });
    // 【新牌一律追加在末尾】_test_solo.js 用 ALL_FUNC_IDS().slice(0, MAX_FUNC+2)
    // 取前 8 个 id 造测试数据，插在中间会把那个测试的前提悄悄换掉。
    D678.FUNCS.push({ id: 'pickbig', img: 'pickbig', name: '抽大', kind: 'pickbig',
        desc: '将自己最新的一张明牌退回牌库底部，\n然后抽出牌库中最大的那张数字牌（明牌）。\n刚退回去的那张不算在「最大」里。\n抽牌后本回合结束。' });
    // num：视作数字牌打在自己场上。num 就是它的点数。
    // 【这三张造出来的牌统称「虚空数字」】不来自牌库、退回/重抽时直接消失，
    // 卡面上用这个词代替原来那句解释（你定的命名）。代码里对应的是 c.fake。
    D678.FUNCS.push({ id: '+1', img: '+1', name: '加一', kind: 'num', num: 1,
        desc: '视作一张 +1 的数字牌打在自己场上，\n自己总点数 +1（对方不受影响）。\n虚空数字牌。\n打出后本回合结束。' });
    D678.FUNCS.push({ id: '-1', img: '-1', name: '减一', kind: 'num', num: -1,
        desc: '视作一张 -1 的数字牌打在自己场上，\n自己总点数 -1（对方不受影响）。\n虚空数字牌。\n打出后本回合结束。' });
    D678.FUNCS.push({ id: 'copy', img: 'copy', name: '复制', kind: 'copy',
        desc: '复制自己最新的一张明牌的点数，\n在场上放一张同点数的复制品（另一种颜色）。\n虚空数字牌。\n打出后本回合结束。' });
    // 【这三张改的是判定本身，不只是目标点数】前五张规则牌都还是
    // 「求和，比谁接近一个目标数」，这三张跳出了那个形状 ——
    // 见 D678_Battle.prototype.scoreOf 上方的长注释。
    D678.FUNCS.push({ id: 'rulecow', img: 'rulecow', name: '规则牛牛', kind: 'rule',
        desc: '3 或 4 张牌凑十取余，余数即成绩（10 为牛牛）。\n没有爆牌限制，每位玩家最多 5 张牌（含底牌）。\n规则牌互相覆盖，场上只存在一张。\n不消耗回合。' });
    D678.FUNCS.push({ id: 'rulemore', img: 'rulemore', name: '规则比多', kind: 'rule',
        desc: '改为比牌的张数，多者获胜。\n超过 21 点仍算爆牌，张数相同才比谁近 21 点。\n规则牌互相覆盖，场上只存在一张。\n不消耗回合。' });
    // 【这张的卡面被 4 行上限逼着把末尾两句并成一行】其它规则牌是
    // 「规则牌互相覆盖，场上只存在一张。」+「不消耗回合。」两行，这张多了
    // 「底牌重掷」那句代价，不并就是 5 行、面板会截断（见 _test_rules.js
    // 的 B3-6e，那个上限是从 678.js 的绘制参数算出来的）。
    D678.FUNCS.push({ id: 'rulenoseencard', img: 'rulenoseencard', name: '规则暗牌', kind: 'rule',
        desc: '只有暗牌的点数计入判定，明牌一律不算。\n出牌时自己的底牌换成随机的一张。\n仍以接近 21 点为目标，超过即爆牌。\n规则牌互相覆盖，只存在一张。不消耗回合。' });
    // 【唯一一张要玩家在回合中途做选择的牌】其它牌打出去就结算完了，
    // 这张会留下一个「待选」状态（pending2），选完才真正拿牌。
    // 所以它牵动的地方比别的牌多：回合计时、掉线兜底、平局重发的清理。
    D678.FUNCS.push({ id: '2pick1', img: '2pick1', name: '二选一', kind: 'pick2',
        desc: '一次性抽出两张数字牌，选一张放到自己场上（明牌），\n另一张塞入牌库底部。\n牌库只剩 1 张时直接抽那一张。\n抽牌后本回合结束。' });
    // 【rulenull 用 kind:'rule'】走已有的 rule 分支，this.rule = 'rulenull' 后
    // isCowRule / isMoreRule / isHiddenRule / isOver21Rule 全部返回 false，
    // target() 回到 21、mod() 回到 0 —— 自然就是默认规则，不用额外写判定。
    D678.FUNCS.push({ id: 'rulenull', img: 'rulenull', name: '规则标准21', kind: 'rule',
        desc: '没有规则就是最好的规则。\n恢复默认的 21 点规则。\n规则牌互相覆盖，场上只存在一张。\n不消耗回合。' });
    // helppick：往对方场上加一张牌库里最小的明牌，不消耗回合。
    // 不进 GAIN_KINDS（加的是对方不是自己），牛牛上限在 useFunc 里单独挡对方。
    D678.FUNCS.push({ id: 'helppick', img: 'helppick', name: '帮小抽', kind: 'helppick',
        desc: '帮对方抽一张牌库里最小的数字牌\n（明牌）。\n不消耗回合。' });
    // mirror：放在对方场上，动态复制自己同位置的明牌，点数算对方头上（骚扰）。
    // 是虚空数字牌（fake），不进 GAIN_KINDS（加的是对方不是自己），牛牛上限在
    // useFunc 里单独挡对方侧。
    // resolveMirror 在 scoreVals / endTurn / useFunc 末尾刷新，保证值始终同步。
    D678.FUNCS.push({ id: 'mirror', img: 'mirror', name: '镜像复制', kind: 'mirror',
        desc: '在对方场上放一张镜像牌，\n复制自己同位置的明牌\n（暗牌无法复制，显示 0），\n点数算在对方头上。不消耗回合。' });
    // destroy：把对方最新的非底牌放到牌库最下方，不消耗回合。
    // 明牌暗牌都能破坏，被破坏的是暗牌时不透露点数。
    D678.FUNCS.push({ id: 'destroy', img: 'destroy', name: '破坏', kind: 'destroy',
        desc: '将对方最新的一张牌\n放到牌库最下方（必须非底牌，\n不论明牌暗牌）。\n不消耗回合。' });
    // 【规则明牌是规则暗牌的严格取反】countsForScore 那一处收口，
    // 判定/爆牌线/满点/AI 的标量推演全都跟着走。
    // 代价：没有（你定的）—— 规则暗牌那张的底牌重掷是因为它等于拼底牌，
    // 偷看过自己底牌的人出了就稳赢；这张是双方明牌全公开，对手还能继续
    // 抽牌、也能覆盖规则，不需要额外的代价。
    //
    // 连带影响（都是这条规则的性质，不是 bug）：抽暗牌 / 复制底牌 /
    // 重抽底牌 / 干扰 / 查看牌库这五张在它生效期间全是废牌 ——
    // 暗牌不算分，底牌是什么都无所谓。
    // 【id 'duel' 和联机的 1v1 房间模式撞名】room.mode === 'duel' /
    // D678N.mode === 'duel' / this._page === 'duel' 指的是「单人对决」那个页面，
    // 跟这张规则牌毫无关系。两者不在同一个命名空间（这张只出现在 b.rule 和
    // 玩家手牌的 id 里），功能上不会互相影响，但**搜 'duel' 会同时命中两种含义**
    // —— 查这张牌的时候用 isUpRule / RULE_IDS，别用字符串搜。
    D678.FUNCS.push({ id: 'duel', img: 'duel', name: '规则明牌', kind: 'rule',
        desc: '只有明牌的点数计入判定，暗牌一律不算。\n仍以接近 21 点为目标，超过即爆牌。\n规则牌互相覆盖，场上只存在一张。\n不消耗回合。' });
    // 【比少不是比多的镜像，它多一道「必须 ≥21」的门】只反过来比张数的话，
    // 开局双方各 2 张、谁抽谁落后 -> 双方都不抽，整局冻住；而且
    // 退回明牌把自己减到 1 张就必胜（1 张不可能爆）。加上这道门之后
    // 1 张最多 11 点、达不到 21 直接判负，那条捷径自然没了。
    //
    // 排序 [张数少, 近21]（你定的：3 张 25 胜 4 张 21），跟比多严格对称。
    // 爆牌线反过来：**低于** 21 即判负，超过 21 没有上界（同规则大21）。
    D678.FUNCS.push({ id: 'ruleless', img: 'ruleless', name: '规则比少', kind: 'rule',
        desc: '必须达到 21 点以上，未达到即判负。\n达标者之间张数少者胜，张数相同再比近 21。\n规则牌互相覆盖，场上只存在一张。\n不消耗回合。' });
    // re2big：双方各自最大的一张明牌压到牌库底，两张的顺序随机。
    // 并列时取最新那张（你定的）。虚空数字不进牌库、直接消失。
    // 双方都没有明牌时照样能用，只是没有效果。
    D678.FUNCS.push({ id: 're2big', img: 're2big', name: '去大', kind: 're2big',
        desc: '将双方各自最大的一张明牌放到牌库最下方\n（两张的顺序随机）。\n没有明牌的一方不受影响。\n不消耗回合。' });
    // repickback：换自己的底牌，方向和 干扰 正好相反（那张换对方的）。
    // 复用 rerollOwnHole，所以「一定不是原来那张」靠取牌顺序天然成立。
    // 牌库空时只能抽回同一张（你定的：照样算生效、动画照播）。
    D678.FUNCS.push({ id: 'repickback', img: 'repickback', name: '重抽底牌', kind: 'repickback',
        desc: '将自己的底牌洗回牌库，重新抽一张底牌，\n一定不会抽到同一个数字。\n牌库已空时会抽回原来那张。\n不消耗回合。' });
    // copyback：复制自己底牌的点数，以**暗牌**形式追加。
    // 【它是全池子里唯一能绕过要牌闸门加点数的牌】暗牌不进 upTotal，
    // 所以底牌 10 + 复制品 = 手上 20 点，而明牌合计照旧、还能继续要牌。
    // 进 GAIN_KINDS（场上多一张牌），牛牛下满 5 张时用不出去。
    D678.FUNCS.push({ id: 'copyback', img: 'copyback', name: '复制底牌', kind: 'copyback',
        desc: '复制自己底牌的点数，在场上追加一张暗牌\n（对方看不到）。虚空数字牌。\n打出后本回合结束。' });
    // smallchangebig：自己最小的明牌 <-> 对方最大的明牌。
    // 不看位置（全场最小 / 全场最大），并列取最新那张。
    // 就地换数值（牌不换阵营），和 互换明牌 同一套做法。
    D678.FUNCS.push({ id: 'smallchangebig', img: 'smallchangebig', name: '以小换大',
        kind: 'smallchangebig',
        desc: '将自己最小的一张明牌与对方最大的一张明牌\n互相交换。\n任一方没有明牌时无效果。\n不消耗回合。' });
})();

D678.funcData = function (id) {
    for (var i = 0; i < D678.FUNCS.length; i++) {
        if (D678.FUNCS[i].id === id) return D678.FUNCS[i];
    }
    return null;
};
D678.funcName = function (id) { var f = D678.funcData(id); return f ? f.name : id; };
// 这次出牌换掉了谁的底牌：返回使用者视角的 side（0 自己 / 1 对方），
// 没换底牌就返回 -1。客户端靠它决定往哪一排播「新底牌飞进来」的演出。
//
// 【收在这里】单机、联机客户端、以及对方动作那条路径一共四处要判同一件事，
// 各自写一份 if 迟早漏掉某张牌 —— 而漏掉的表现是「那张牌用了没有动画」，
// 跟功能没生效长得一模一样（见 678.js 的 holeSwapFx）。
//
// res 是 useFunc 的返回值。规则暗牌只在真的重掷成功时才有 value ——
// 牌库空 / 没底牌那两种情况规则照样生效，但底牌没动，不该播。
D678.holeSwapSideOf = function (res) {
    if (!res || !res.ok || res.fail) return -1;
    if (res.kind === 'repickback') return 0;
    if (res.kind === 'reback')     return 1;
    if (res.id === 'rulenoseencard' &&
        res.value !== undefined && res.value !== null) return 0;
    return -1;
};
D678.ALL_FUNC_IDS = function () {
    return D678.FUNCS.map(function (f) { return f.id; });
};
// 所有规则牌的 id。
// 【从 FUNCS 推出来，别手写】AI 的 vulnPenalty / godVulnPenalty 要枚举
// 「对手可能拿哪张规则牌把我打爆」，原来那里各自硬写了一份五张的清单 ——
// 加新规则牌时漏改任何一份，AI 就会对那张牌的风险视而不见，
// 而且不报错、只是变傻。
D678.RULE_IDS = D678.FUNCS.filter(function (f) { return f.kind === 'rule'; })
    .map(function (f) { return f.id; });

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
// 一张牌在文字里怎么写（日志、点数行共用）。假牌必须标出来 —— 否则
// 「7+7」这种在「1~11 各一张」的牌库里根本不可能的组合会被当成 bug，
// 而 -1 直接拼出来是「7+-1」，读不通。
//   +1 / -1 -> (+1) / (-1)   有专属卡图，直接用卡图名
//   复制品    -> (7)          括号本身就说明了是虚空数字，不再多写一个「复」
//   普通牌    -> 7
D678.cardFaceStr = function (c) {
    if (!c) return '?';
    if (c.fake) {
        // 镜像没复制到牌时 face='mirror'，公式里显示 (0) 而不是 (mirror)
        var fv = (c.face && c.face !== 'mirror') ? c.face : c.v;
        return '(' + fv + ')';
    }
    return String(c.v);
};
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
    // 【按名字判是默认值，不是唯一入口】单机和房号锦标赛靠名字认超哥
    // （名单里就叫「超哥」），这条保持原样。
    //
    // 但天梯里超哥要换名字：随便哪个 AI 都可能挂超哥逻辑，名字照常显示
    // （你定的 ——「我是人不是AI」这种普通名字背后可能是超哥）。所以这里
    // 只给默认值，天梯建房时直接改 p.isGod。
    //
    // 改完之后 isGod 有两个来源，容易漏：所有读它的地方（AI.profile、
    // canDrawFunc、knowsTop、godStandValue…）读的都是这个字段本身，
    // 没有任何一处重新按名字算，所以覆写是安全的。
    this.isGod    = (name === D678.GOD_NAME);
    // 对每个对手的战绩：{ 对手id: {name, wins, losses} }。
    // 淘汰页要列「VS B 对局 3 场，胜率 33%」，而 game.pairedLog 只记
    // 「这两个人打过没有」（配对用），不记胜负 —— 所以单独存一份。
    // 平局不计入（重新发牌，和 wins/losses 的口径一致）。
    this.vsLog    = {};
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
// 伤害不再含累计败场加罚，底伤固定 5；lossPenalty 已移除。
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
    // 名字走 D678.humanName()（客户端会覆写成大厅设的昵称），
    // 并把它从 AI 名单里避开，免得排名表出现两个同名的人
    var myName = D678.humanName();
    var names = D678.rollAINames(myName);
    this.players.push(new D678_Player(0, myName, true));
    for (var i = 0; i < names.length; i++) {
        this.players.push(new D678_Player(i + 1, names[i], false));
    }
    this.pool      = D678.shuffle(D678.ALL_FUNC_IDS());  // 公共功能牌池
    this.pairedLog = {};   // "a-b" -> true 本轮循环内已交手
    this._lastPairs = {};  // 上一轮的配对，防止循环重置后连续撞同一个对手
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
    var lastPairs = this._lastPairs;   // 上一轮的配对，防止循环重置后连续撞同一个对手
    var best = null;
    for (var attempt = 0; attempt < 200; attempt++) {
        var pool = D678.shuffle(alive.slice(0));
        var pairs = [], bye = null, repeats = 0, consecutives = 0;
        if (pool.length % 2 === 1) bye = pool.pop();
        while (pool.length >= 2) {
            var a = pool.shift();
            // 三层偏好：
            //   1. 最优：不在 pairedLog 里 且 不是上一轮的对手
            //   2. 次选：不在 pairedLog 里（但可能是上一轮的对手）
            //   3. 兜底：pairedLog 里的（循环重置，没法避免）
            var idx = -1, idxOK = -1;
            for (var i = 0; i < pool.length; i++) {
                var pk = this.pairKey(a, pool[i]);
                if (!this.pairedLog[pk]) {
                    if (!lastPairs[pk]) { idx = i; break; }
                    if (idxOK < 0) idxOK = i;
                }
            }
            if (idx < 0) idx = idxOK;
            if (idx < 0) { idx = 0; repeats++; }
            if (lastPairs[this.pairKey(a, pool[idx])]) consecutives++;
            var b = pool.splice(idx, 1)[0];
            pairs.push([a, b]);
        }
        // 主排序：repeats 少的优先；次排序：consecutives 少的优先
        if (!best || repeats < best.repeats ||
            (repeats === best.repeats && consecutives < best.consecutives)) {
            best = { pairs: pairs, bye: bye, repeats: repeats, consecutives: consecutives };
        }
        if (repeats === 0 && consecutives === 0) break;
    }
    if (best.repeats > 0) {   // 全部组合都打过了 -> 重新开始循环
        this.resetPairLog();
    }
    this._lastPairs = {};
    for (var j = 0; j < best.pairs.length; j++) {
        var key = this.pairKey(best.pairs[j][0], best.pairs[j][1]);
        this.pairedLog[key] = true;
        this._lastPairs[key] = true;
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
    // 【必须清】上一局若停在二选一的待选上（平局重发、或对局被中断），
    // 不清的话新的一局开局就带着上一局的两张候选，等玩家一选就凭空多张牌。
    this.pending2 = null;
    this.sides = this.players.map(function (p, i) {
        return {
            p: p, index: i,
            cards: [],          // {v:数值, hidden:是否背面, uid:稳定身份}
            stood: false,
            checkN: 0,          // 查看牌库剩余可见张数
            known: []           // AI 推理出的“对方底牌一定是X”
        };
    });
    // 发牌: 每人 1 底牌 + 1 明牌
    for (var i = 0; i < 2; i++) {
        this.sides[i].cards.push(D678.mkCard(this.deck.shift(), true));
    }
    for (var j = 0; j < 2; j++) {
        this.sides[j].cards.push(D678.mkCard(this.deck.shift(), false));
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
    for (var i = 0; i < c.length; i++) p.push(D678.cardFaceStr(c[i]));
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

// 牛牛下每人最多能有几张牌（含底牌、含虚空数字 —— 复制品/加减一样占位置）。
// 【这是「每方各自」的上限，不是两家合计】5 张对 5 张是合法局面，
// 牛牛照样能出、照样生效；只是这时双方都拿不到牌了。
// 这个上限**代替**了「明牌合计 < 21」那道要牌闸门（见 canHit），
// 所以它同时是牛牛下一局的长度上限。
D678.COW_MAX_CARDS = 5;
// 撞上上限时给玩家看的那句话。要牌闸门和功能牌闸门共用同一句 ——
// 两处分别写的话措辞早晚会漂。
D678.cowCapMsg = function () {
    return '牛牛规则下最多 ' + D678.COW_MAX_CARDS + ' 张牌（含底牌）';
};

// 牛牛失效：任一方牌数超过上限。
//
// 【这条现在只在「牛牛还没生效」时才可能为真】牛牛生效期间所有拿牌的路子
// 都被 canHit / cardGainBlockedReason 堵住了，谁也涨不到 6 张。
// 能超上限的只有别的规则下（明牌合计那条线松得多），那时这条谓词的作用是
// 让 ruleBlockedReason 拒掉牛牛 —— 见那个函数。
// isCowRule 里那层 !cowBroken() 因此是防御性的：留着是为了万一以后新增了
// 别的发牌途径，宁可让判定退回 21 点，也别让「6 张牌的牛牛」这种
// 规则上不存在的局面被静默算出成绩来。
D678_Battle.prototype.cowBroken = function () {
    for (var i = 0; i < this.sides.length; i++) {
        if (this.sides[i].cards.length > D678.COW_MAX_CARDS) return true;
    }
    return false;
};
// 牛牛判定是否真的在生效。失效时这张牌仍然占着规则位（覆盖掉之前那张），
// 但判定退回默认的「接近 21 点」。
D678_Battle.prototype.isCowRule  = function () {
    return this.rule === 'rulecow' && !this.cowBroken();
};

// 这张规则牌现在能不能打出去。返回 '' 表示能，否则是拒绝的理由。
// 【收在这里】useFunc 要用它拦下非法出牌，AI 的 vulnPenalty / godVulnPenalty
// 也要用它 —— 那两处枚举「对手可能拿哪张规则牌把我打爆」，
// 把一张对手根本打不出来的牌算成威胁会让 AI 白白保守。
D678_Battle.prototype.ruleBlockedReason = function (id) {
    // 牛牛出牌时就已经有人**超过**上限的话，打出去等于立刻失效 —— 拒掉，
    // 而不是让玩家白扔一张规则牌。
    // 注意是「超过 5 张」才拒：5 张对 5 张完全合法，牛牛照样能出。
    if (id === 'rulecow' && this.cowBroken()) {
        return '有一方超过 ' + D678.COW_MAX_CARDS + ' 张牌';
    }
    return '';
};

// 这张功能牌会不会让使用者的场上多一张牌。
// 【按 kind 判，别按 id 列清单】新增功能牌时漏改这里的后果是牛牛下能超上限，
// 而那种错不抛异常 —— 只是让一条规则悄悄失效。
//   pick / pickback / picksmall -> 从牌库拿一张
//   pick2                      -> 抽两张选一张留下（净 +1）
//   rob                        -> 从对方场上拿一张过来
//   num / copy / copyback      -> 造一张虚空数字
// 净张数不变的不算：swap 和 smallchangebig（都是互换）、return（只减）、
// re2big（只减）、reback（换对方底牌）、repickback（换自己底牌）、
// repick 和 pickbig（都是先去一张再拿一张）、check / rule（不碰牌）。
// helppick 和 mirror 都不在里面：它们往**对方**场上加牌，牛牛上限在 useFunc
// 各自分支里单独挡对方那侧。
D678.GAIN_KINDS = ['pick', 'pickback', 'picksmall', 'pick2', 'rob', 'num', 'copy',
                   'copyback'];
D678.funcGainsCard = function (id) {
    var f = D678.funcData(id);
    return !!f && D678.GAIN_KINDS.indexOf(f.kind) >= 0;
};

// 牛牛下 si 方已经满 5 张时，任何「获得牌」的功能牌都用不出去。
// 返回 '' 表示能用，否则是拒绝的理由。
//
// 【为什么是拦下而不是「消耗掉再失败」】同一道上限在要牌那边是拦下的
// （canHit 直接不让点，见 noHitReason），功能牌这边跟着拦，两边口径一致，
// 也不至于让玩家白扔一张牌。要牌和功能牌共用 cowCapMsg 那句提示。
D678_Battle.prototype.cardGainBlockedReason = function (si, id) {
    if (!this.isCowRule()) return '';
    if (!D678.funcGainsCard(id)) return '';
    if (this.sides[si].cards.length < D678.COW_MAX_CARDS) return '';
    return D678.cowCapMsg();
};
D678_Battle.prototype.isMoreRule = function () { return this.rule === 'rulemore'; };
D678_Battle.prototype.isHiddenRule = function () { return this.rule === 'rulenoseencard'; };
D678_Battle.prototype.isUpRule = function () { return this.rule === 'duel'; };
// 规则比少：必须 ≥21 才算达标，达标者之间张数少者胜。
D678_Battle.prototype.isLessRule = function () { return this.rule === 'ruleless'; };
// 成绩「越大越好」的规则（默认是越接近目标点数越好）
D678_Battle.prototype.isHighRule = function () { return this.isCowRule(); };

// 这张牌是否计入判定。规则暗牌只算暗牌，规则明牌只算明牌（严格取反）。
D678_Battle.prototype.countsForScore = function (c) {
    if (this.isHiddenRule()) return !!c.hidden;
    if (this.isUpRule()) return !c.hidden;
    return true;
};
// 拿到一张牌会让判定用的点数变多少。
// 规则暗牌下抽一张明牌对成绩毫无影响（这条规则下抽牌只会逼近抽不动，
// 所以 AI 基本会停牌，除非手里有「抽暗牌」）—— AI 的推演必须知道这件事，
// 否则它会以为抽牌能改善成绩。规则明牌下反过来，抽暗牌才是白抽。
D678_Battle.prototype.scoreDelta = function (v, hidden) {
    if (this.isHiddenRule() && !hidden) return 0;
    if (this.isUpRule() && hidden) return 0;
    return this.adj(v);
};

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
// 计入判定的那些牌的点数（含修正），一张一个元素。
// 牛牛要按「哪几张」凑十，光有和不够，所以判定层统一从这里取原料。
// 镜像牌的动态值刷新：遍历双方场上所有 mirror 牌，按其当前位置索引
// 去看对方同位置的牌——是明牌就复制 v 和 face，否则（没牌 / 暗牌）显示
// mirror 自身的卡图、点数 0。
//
// 【位置就是数组下标】mirror 牌在谁的 cards 里就复制对面同下标的那张。
// 放对方场上时复制自己同位置的牌（骚扰），被 swap / rob 挪回自己场上后
// 自动反转为复制对方同位置的牌（借牌）—— 不需要改 resolveMirror，
// 它本来就两边都扫。下标随 return / destroy 等移牌自然前移，mirror 跟着
// 换复制对象，跟「位置」的直觉一致。
//
// 调用时机：scoreVals（算分前）、endTurn（回合切换前）、useFunc 末尾
// （出牌后立刻同步），三处覆盖了所有牌面可能变化的入口。
D678_Battle.prototype.resolveMirror = function () {
    for (var s = 0; s < 2; s++) {
        var c = this.sides[s].cards;
        for (var i = 0; i < c.length; i++) {
            if (!c[i].mirror) continue;
            var oc = this.sides[1 - s].cards[i];
            if (oc && !oc.hidden) {
                c[i].v = oc.v;
                c[i].face = oc.face || String(oc.v);
            } else {
                c[i].v = 0;
                c[i].face = 'mirror';
            }
        }
    }
};
D678_Battle.prototype.scoreVals = function (si) {
    this.resolveMirror();
    var out = [], c = this.sides[si].cards, m = this.mod();
    for (var i = 0; i < c.length; i++) {
        if (!this.countsForScore(c[i])) continue;
        out.push(c[i].v + m);
    }
    return out;
};

// 点数的下限。任何情况下点数都不该是负数，最低就是 0 点（你定的）。
// 负数点数来自虚空的 -1 和 rule-1 的修正：底牌 1 再用两张 -1 就是 -1 点。
//
// 【为什么收在一个函数里】负点数会毒到下游每一处：距离算成 22（比爆牌还远）、
// 牛牛的个位算出 9（-1 的个位）、显示成「1+(-1)+(-1)=-1」。
// 与其在每处各夹一次，不如让 total / upTotal 这两个出口就不产出负数。
D678.clampTotal = function (t) { return t < 0 ? 0 : t; };

// 总点数（含修正，最低 0）。
// 【规则暗牌下这里只算暗牌】判定、爆牌线、满点全都建立在 total 之上，
// 所以「哪些牌算数」只在这一处收口，isBustVal / distVal / AI 的标量推演
// 就自动跟着走，不用各自再判一次规则。
// 要「牌面上所有牌的和」（显示用）请用 rawSum(si, false)。
D678_Battle.prototype.total = function (si) {
    var v = this.scoreVals(si), s = 0;
    for (var i = 0; i < v.length; i++) s += v[i];
    return D678.clampTotal(s);
};
// 明牌点数（含修正，最低 0）
D678_Battle.prototype.upTotal = function (si) {
    return D678.clampTotal(
        this.rawSum(si, true) + this.mod() * this.countCards(si, true));
};
D678_Battle.prototype.isBustVal = function (t) {
    if (this.isCowRule()) return false;          // 牛牛没有爆牌，凑不出只是成绩 0
    // 规则大21 和 规则比少 都把爆牌线倒过来：低于 21 即判负，上面没有界。
    if (this.isOver21Rule() || this.isLessRule()) return t < 21;
    return t > this.target();
};
// 判负的那个状态在界面上叫什么。爆牌线倒过来的两张规则牌下不能叫「爆牌」——
// 那两条规则判负的条件是**低于** 21 点，写「爆牌」会让玩家以为自己超了。
D678_Battle.prototype.bustWord = function () {
    return (this.isOver21Rule() || this.isLessRule()) ? '未达 21' : '爆牌';
};
// 「离理想还差多少」，越小越好。判定不用它（判定看 cmpScore），
// 它是 AI 的启发式标量：godDist / canImprove / 平手次级判据都靠它排序。
//
// 牛牛没有目标点数，但成绩只取决于总点数的个位（见 cowScore 的推导），
// 所以「距牛牛还差几点」= 10 - 个位，这个代理量对启发式足够好用。
D678_Battle.prototype.distVal = function (t) {
    if (this.isCowRule()) {
        // 0 点是无牛（最差），不是牛牛 —— 否则这个代理量会把最差局面
        // 报成「已经到牛牛了」，AI 就不再想改善它。
        if (t <= 0) return 10;
        var d = ((t % 10) + 10) % 10;
        return d === 0 ? 0 : 10 - d;
    }
    return Math.abs(t - this.target());
};
D678_Battle.prototype.isMaxVal = function (t) {
    // 牛牛：个位 0 即满点，但 0 点本身是无牛
    if (this.isCowRule()) return t > 0 && ((t % 10) + 10) % 10 === 0;
    return !this.isBustVal(t) && t === this.target();
};

//--- 牛牛 -------------------------------------------------------------------
//
// 规则要求**恰好 3 或 4 张**牌凑成 10 的倍数才算有牛，余下牌的和的个位即成绩。
// 设拿走的那部分和为 S（S ≡ 0 mod 10），余下的和就是 T - S，
// 而 (T - S) mod 10 = T mod 10 —— 也就是说**成绩只取决于总点数的个位**，
// 拿哪几张去凑都一样。唯一要判定的是「存在几张牌的子集能凑出 10 的倍数」，
// 以及「凑完后是否还有剩余牌」。
//
// 判定用 mod 10 的子集和 DP，但按张数分层：reach[k][r] 为真表示
// 「存在恰好 k 张牌的子集，其和的个位为 r」。每加一张牌做一次推进。
// k 的范围 0..COW_MAX_CARDS。只关心 reach[3][0] 和 reach[4][0]。
//
// 负数牌（假的 -1、以及 rule-1 修正）用 ((x%10)+10)%10 归一化，
// 否则 JS 的 % 会给出负余数，掩码下标就越界了。
D678._cowEmptyRow = function () {
    var r = [];
    for (var i = 0; i < 10; i++) r.push(false);
    return r;
};
D678.cowReach = function (vals) {
    var reach = [];
    for (var i = 0; i <= D678.COW_MAX_CARDS; i++) reach.push(D678._cowEmptyRow());
    reach[0][0] = true;                     // 空集的个位为 0
    for (i = 0; i < vals.length; i++) reach = D678.cowReachAdd(reach, vals[i]);
    return reach;
};
// 往 reach 上再加一张牌，返回新掩码（不改原数组）。
// AI 沿着抽牌链递推时用，省得每加一张就把整手牌重算一遍。
D678.cowReachAdd = function (reach, v) {
    var d = ((v % 10) + 10) % 10;
    var next = [];
    for (var i = 0; i <= D678.COW_MAX_CARDS; i++)
        next.push(reach[i] ? reach[i].slice(0) : D678._cowEmptyRow());
    // 从高 k 往低，避免同一张牌被重复计入
    for (var k = D678.COW_MAX_CARDS - 1; k >= 0; k--) {
        if (!reach[k]) continue;
        for (var r = 0; r < 10; r++) {
            if (reach[k][r]) next[k + 1][(r + d) % 10] = true;
        }
    }
    return next;
};
// 把 2D 掩码序列化成字符串，用作 AI 分布合并 / 缓存的键。
D678.cowReachKey = function (reach) {
    if (!reach) return '';
    var s = '';
    for (var k = 0; k <= D678.COW_MAX_CARDS; k++) {
        if (!reach[k]) { s += '----------'; continue; }
        for (var r = 0; r < 10; r++) s += reach[k][r] ? '1' : '0';
    }
    return s;
};
// 构成「牛」恰好要 3 或 4 张牌。手上不足 3 张一律无牛。
D678.COW_MIN_CARDS = 3;

// 成绩：0=无牛，0.5=有牛没点，1~9=牛1~牛9，10=牛牛
//
// reach 是 cowReach 返回的 2D 掩码，n 是手上计入判定的张数。
// 恰好 3 或 4 张的子集和为 10 的倍数才算有牛。
// 有剩余牌时牛值 = 总点数个位（0 记作 10 即牛牛）；
// 无剩余牌（全部牌都用于凑牛，即 n=3 且 reach[3][0]，或 n=4 且 reach[4][0]）
//   = 有牛没点（0.5），比任何有分牛都差，比无牛好。
// 多个有效组合时选牛值最高的 —— 因为牛值 = total%10 与子集无关，
// 「有剩余」永远 ≥ 「有牛没点」，所以优先看有没有剩余。
//
// reach 缺失（undefined）时保守当有牛且有余牌（AI 估对手，高估对手是安全方向）。
//
// total 为 0 也算无牛：1 + (-1) + 0 这种废牌凑出 0，
// 按个位算会记成牛牛满点，白拿一个满点不合理。
D678.cowScoreFrom = function (total, reach, n) {
    if (n !== undefined && n < D678.COW_MIN_CARDS) return 0;
    if (total <= 0) return 0;
    if (!reach) {
        // reach 缺失：保守当有牛且有余牌
        var d = ((total % 10) + 10) % 10;
        return d === 0 ? 10 : d;
    }
    var has3 = reach[3] && reach[3][0];
    var has4 = reach[4] && reach[4][0];
    // 有剩余的牛：3 张牛且 n>3，或 4 张牛且 n>4
    if ((has3 && n > 3) || (has4 && n > 4)) {
        var d2 = ((total % 10) + 10) % 10;
        return d2 === 0 ? 10 : d2;
    }
    // 全部牌凑牛，无剩余
    if ((has3 && n === 3) || (has4 && n === 4)) return 0.5;
    return 0;
};

//--- 判定（唯一权威） -------------------------------------------------------
//
// 【为什么要有这一层】原来 doResolve 和 AI.resolveUtil 各自手写了一份
// 「爆牌 -> 比 dist -> 同点平局」。加了改判定方式的规则牌之后，那份重复
// 会变成真正的 bug 源：两边不一致时 AI 会按错的胜负规则思考，
// 而且这种错不抛异常，只是让 AI 悄悄变傻。所以统一收到这里。
//
// score(): {bust, max, rank[]}。rank 按字典序比大小，越大越好，
// 所以「越接近目标点数越好」写成 rank=[-dist]，
// 「点数越大越好」（牛牛）写成 rank=[score]，
// 「先比张数再比接近」（比多）写成 rank=[张数, -dist]。
D678_Battle.prototype.scoreOf = function (si) {
    var vals = this.scoreVals(si);
    var t = 0;
    for (var i = 0; i < vals.length; i++) t += vals[i];
    if (this.isCowRule()) {
        // 掩码和张数一起传进去：构成牛恰好要 3 或 4 张
        var cow = D678.cowScoreFrom(t, D678.cowReach(vals), vals.length);
        return { bust: false, max: cow === 10, rank: [cow], total: t, cow: cow };
    }
    var bust = this.isBustVal(t);
    if (this.isMoreRule()) {
        // 爆牌保留：只在没爆的人之间比张数，张数相同再比谁近 21。
        return { bust: bust, max: this.isMaxVal(t), total: t,
                 rank: [vals.length, -this.distVal(t)], cards: vals.length };
    }
    if (this.isLessRule()) {
        // 比多的镜像：张数**少**者胜，张数相同再比谁近 21。
        // 「必须 ≥21」那道门走的是 bust（isBustVal 在这条规则下判 t < 21），
        // 所以这里不用再判一次 —— cmpScore 先比 bust，达不到的人根本进不到
        // rank 的比较里。双方都达不到就是双爆，平局重发。
        return { bust: bust, max: this.isMaxVal(t), total: t,
                 rank: [-vals.length, -this.distVal(t)], cards: vals.length };
    }
    return { bust: bust, max: this.isMaxVal(t), total: t, rank: [-this.distVal(t)] };
};

// 比较两个成绩：返回 >0 表示 x 赢，<0 表示 y 赢，0 表示平。
// 双方同时爆牌算平（平局重发），与原来的 doResolve 一致。
D678.cmpScore = function (x, y) {
    if (x.bust && y.bust) return 0;
    if (x.bust !== y.bust) return x.bust ? -1 : 1;
    var a = x.rank, b = y.rank;
    var n = Math.max(a.length, b.length);
    for (var i = 0; i < n; i++) {
        var av = a[i] || 0, bv = b[i] || 0;
        if (Math.abs(av - bv) > 0.0001) return av > bv ? 1 : -1;
    }
    return 0;
};

// 平局加伤：翻倍制。第 1 次平 +1，第 2 次 +2，第 3 次 +4，之后 8 / 16 / 32…
//
// 【为什么收成一个函数】doResolve 和 AI.resolveUtil 各要算一次，原来两处
// 分别写 `b.redeals || 0`。改成翻倍之后两处只要有一处漏改，AI 就会按错的
// 伤害估值 —— 那种偏差不会报错，只表现为「AI 在平过几次之后打得莫名其妙」。
//
// n 是已经平过几次（redeals）。0 次平局不加伤。
D678.tieBonusOf = function (n) {
    n = n || 0;
    return n <= 0 ? 0 : Math.pow(2, n - 1);
};

// 败场差 comeback 加伤：胜者败场比败者多时，差额计入额外伤害，不设上限。
// 胜者败场 ≤ 败者败场时不触发（领先者赢了不多打）。
// doResolve 和 AI.resolveUtil 共用这一个函数 —— 两边必须一致，
// 否则 AI 在败场差大的时候会误判赌注大小。
D678.comebackBonusOf = function (winnerLosses, loserLosses) {
    var diff = (winnerLosses || 0) - (loserLosses || 0);
    return diff > 0 ? diff : 0;
};

// 是否可以要牌（明牌合计 >= 21 不可要牌）。
// 【注意这里始终看明牌合计，不受 规则暗牌 影响】它是「还能不能动」的闸门，
// 也是整场对局的长度上限。
//
// 牛牛是唯一的例外：那条规则下没有爆牌，明牌合计根本不是有意义的刹车
// （凑十只看个位，21 点这条线在牛牛下毫无意义），所以闸门换成张数上限 ——
// 满 5 张就抽不动了。这同样堵住了「牛牛没有爆牌 -> 无限抽牌」那条路，
// 而且比 21 点更硬（牌库只有 11 张）。
// 牛牛失效（有人超 5 张）时自动退回明牌合计那条线。
D678_Battle.prototype.canHit = function (si) {
    if (this.deck.length === 0) return false;
    if (this.isCowRule()) {
        return this.sides[si].cards.length < D678.COW_MAX_CARDS;
    }
    return this.upTotal(si) < 21;
};

// 抽不动的原因（给玩家看的那行提示）。
// 【收在这里】客户端、联机客户端、服务器两处校验一共四个地方要这句话，
// 原来各自硬写「明牌合计大于等于21点」—— 牛牛下闸门换成张数之后
// 那句话就是错的，四份各改一遍迟早漏。
D678_Battle.prototype.noHitReason = function (si) {
    if (this.deck.length === 0) return '牌库已空';
    if (this.isCowRule()) return D678.cowCapMsg();
    return '明牌合计大于等于21点无法继续要牌';
};

//--- 牌面操作 --------------------------------------------------------------

D678_Battle.prototype.newestUp = function (si) {
    var c = this.sides[si].cards;
    for (var i = c.length - 1; i >= 0; i--) { if (!c[i].hidden) return c[i]; }
    return null;
};
// 点数最大 / 最小的那张明牌。并列时取**最新**那张（你定的口径，
// 去大 和 以小换大 共用）—— 所以比较用 >= / <=，后面的同值牌会顶掉前面的。
//
// 【先刷镜像】镜像牌的点数是动态的（resolveMirror 才算出来），
// 不刷就可能拿一个过期的值去比大小，挑错牌。
D678_Battle.prototype.extremeUp = function (si, wantMax) {
    this.resolveMirror();
    var c = this.sides[si].cards, best = null;
    for (var i = 0; i < c.length; i++) {
        if (c[i].hidden) continue;
        if (!best) { best = c[i]; continue; }
        if (wantMax ? (c[i].v >= best.v) : (c[i].v <= best.v)) best = c[i];
    }
    return best;
};
D678_Battle.prototype.maxUp = function (si) { return this.extremeUp(si, true); };
D678_Battle.prototype.minUp = function (si) { return this.extremeUp(si, false); };
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
    this.sides[si].cards.push(D678.mkCard(v, hidden));
    return v;
};
D678_Battle.prototype.doPick = function (si, num, hidden) {
    var idx = this.deck.indexOf(num);
    if (idx < 0) return null;
    this.deck.splice(idx, 1);
    this.consumeCheck();
    this.sides[si].cards.push(D678.mkCard(num, hidden));
    return num;
};
// 牌库里当前最小的数值（空库返回 null）
D678_Battle.prototype.deckMin = function () {
    if (this.deck.length === 0) return null;
    var m = this.deck[0];
    for (var i = 1; i < this.deck.length; i++) { if (this.deck[i] < m) m = this.deck[i]; }
    return m;
};
D678_Battle.prototype.deckMax = function () {
    if (this.deck.length === 0) return null;
    var m = this.deck[0];
    for (var i = 1; i < this.deck.length; i++) { if (this.deck[i] > m) m = this.deck[i]; }
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

// 把 si 方自己的第一张底牌换成牌库里随机的一张，换下来的洗回牌库。
// 返回 {oldValue, value}，换不了（没有底牌 / 牌库空）时返回 null。
//
// 【和 reback 的区别只有方向】reback 换的是对方的底牌，换上来的那张是
// 自己亲手放的、所以自己确知；这里换的是**自己**的底牌，对手看不见新的那张，
// 所以 known 的更新方向正好相反：
//   · side.known 记的是「我推理出对方底牌有X」—— 我方底牌动了，跟它无关，不能碰。
//   · opp.known 记的是「对方推理出我方底牌有X」—— 换掉的那个作废，必须摘掉。
//     新的那张对手没见过，不能替他记上（那等于凭空送他情报）。
// 这两条搞反的后果不会抛异常，只会让 AI 拿着一个已经不成立的前提推演。
//
// 【只换第一张】用过「抽暗牌」的人手上可能有多张暗牌，但底牌指的是开局那张
// （firstHole 找的就是它），后面暗抽来的不动 —— 你定的口径。
D678_Battle.prototype.rerollOwnHole = function (si) {
    var hole = this.firstHole(si);
    if (!hole) return null;
    if (this.deck.length === 0) return null;
    var idx = Math.floor(Math.random() * this.deck.length);
    var newV = this.deck.splice(idx, 1)[0];
    var oldV = hole.v;
    hole.v = newV;
    this.shuffleInto(oldV);        // 换下来的牌洗回牌库
    this.consumeCheck();           // 牌库被动过，查看牌库的情报作废一层
    D678.remove(this.sides[1 - si].known, oldV);
    return { oldValue: oldV, value: newV };
};

//--- 回合 ------------------------------------------------------------------

D678_Battle.prototype.endTurn = function () {
    this.resolveMirror();
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

// 「照样打出去，但没有效果」。
//
// 【为什么大部分不合规的出牌是失效而不是拦下】你定的口径：功能牌尽量都能用，
// 不合规的时候用了就白用。原来有 15 处是**拦下**（牌不消耗、提示一句），
// 玩家看到的是「点了没反应」，而且哪张牌在什么局面下能点全靠自己记。
// 现在统一成：牌消耗掉、回合仍在自己手上、日志记「（失败：原因）」。
//
// 【唯一的例外是牛牛的 5 张上限】那道门仍然拦下（含要牌按钮）——
// 见 cardGainBlockedReason 和 ruleBlockedReason。
//
// 失效不结束回合、也不清对方的过牌（下面 res.fail 那两处分支），
// 跟「抽号牌撞上已在场上」那种既有的失败表现一致。
D678_Battle.prototype.funcFail = function (res, f, why) {
    res.ok = true;
    res.fail = true;
    res.err = why;
    res.msg = '对方使用了' + f.name + '（失败）';
    return res;
};

// 返回 {ok, endTurn, msg, err}
D678_Battle.prototype.useFunc = function (si, id, simulate) {
    var f = D678.funcData(id);
    var side = this.sides[si], opp = this.sides[1 - si];
    // kind 一起带出去 —— 界面靠它决定播哪套动画（比如重抽要播收牌+发牌）。
    // 光靠 id 的话调用方得再查一次 funcData。
    var res = { ok: false, endTurn: false, msg: '', err: '', id: id,
                kind: f ? f.kind : '' };
    if (!f) return res;

    // 牛牛下满 5 张就拿不到牌了 —— 这道闸门必须在所有拿牌分支之前收口，
    // 不然得在 pick / pickback / picksmall / rob / num / copy 六处各写一遍。
    var gblock = this.cardGainBlockedReason(si, id);
    if (gblock) { res.err = gblock; return res; }

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
    case 'pick2':
        if (this.deck.length === 0) { this.funcFail(res, f, '牌库已空'); break; }
        // 牌库只剩 1 张 -> 没得选，退化成一次普通抽牌（牌照样消耗，你定的）
        if (this.deck.length === 1) {
            res.value = this.doDraw(si, false);
            res.only = true;                 // 界面靠它知道「这次没有选择环节」
            res.ok = true; res.endTurn = true;
            res.msg = '对方使用了' + f.name;
            break;
        }
        // 【两张候选不真的从牌库里拿走】只记下「预定了牌库顶这两张」。
        // 真拿走的话 deck.length 会先掉 2 再回 1，对手那份盘面能看出这个
        // 跳变，等于白白告诉他「他正在二选一」之外还多漏一点信息；
        // 而 canHit / 「牌库已空」这些也都读 deck.length，少一张就会误判。
        // 选完（pick2Resolve）才真的移除选中的那张、把另一张压到底。
        this.pending2 = {
            side: si,
            vals: [this.deck[0], this.deck[1]],
            funcName: f.name
        };
        res.ok = true;
        res.endTurn = false;                 // 选完才结束回合
        res.pending2 = this.pending2.vals.slice(0);
        res.msg = '对方使用了' + f.name;
        break;
    case 'pickback':
        if (this.deck.length === 0) { this.funcFail(res, f, '牌库已空'); break; }
        res.value = this.doDraw(si, true);
        res.ok = true; res.endTurn = true;
        res.msg = '对方使用了' + f.name;
        break;
    case 'swap':
        var a = this.newestUp(si), b = this.newestUp(1 - si);
        if (!a || !b) {
            this.funcFail(res, f, b ? '我方场上没有明牌' : '对方场上没有明牌');
            break;
        }
        res.value = a.v; res.other = b.v;     // 换之前的值，给 msg / what 用
        // 【假牌跟着数值走】（你定的规则）换的是「这张牌是什么」，所以
        // fake/face 必须跟 v 一起换：我的假 +1 换给对方，对方拿到的就是
        // 一张假 +1；换过来的真 7 在我这儿是一张真 7。
        // 只换 v 的话会造出「真牌显示 1 点」和「假牌显示 7 点」这种四不像。
        // mirror 标记同理：镜像牌被 swap 挪到对面后，仍然是一张动态镜像。
        var t = a.v; a.v = b.v; b.v = t;
        var tf = a.fake, tc = a.face, tm = a.mirror;
        if (b.fake) a.fake = true; else delete a.fake;
        if (b.face) a.face = b.face; else delete a.face;
        if (b.mirror) a.mirror = true; else delete a.mirror;
        if (tf) b.fake = true; else delete b.fake;
        if (tc) b.face = tc; else delete b.face;
        if (tm) b.mirror = true; else delete b.mirror;
        res.ok = true; res.msg = '对方使用了' + f.name + '，' + res.value + ' 和 ' + res.other + ' 互换';
        break;
    case 'rob':
        var rb = this.newestUp(1 - si);
        if (!rb) { this.funcFail(res, f, '对方场上没有明牌'); break; }
        var pos = opp.cards.indexOf(rb);
        opp.cards.splice(pos, 1);
        // 换手就是换阵营，给个新 uid —— 客户端会当成「新到我这边的牌」重新入场，
        // 正是强夺该有的观感。沿用旧 uid 的话它会从对方那一排原地跳过来。
        // 假牌被抢走仍然是假牌（fake/face 一起带过去）；
        // 镜像牌被抢走仍然是镜像（mirror 标记带过去，到新位置后照常动态刷新）。
        var rbCard = D678.mkCard(rb.v, false, rb.fake, rb.face);
        if (rb.mirror) rbCard.mirror = true;
        side.cards.push(rbCard);
        res.value = rb.v;
        res.ok = true; res.msg = '对方使用了' + f.name + '，夺走了 ' + res.value + ' 点明牌';
        break;
    case 'return':
        var rt = this.newestUp(si);
        if (!rt) { this.funcFail(res, f, '我方场上没有明牌'); break; }
        var p2 = side.cards.indexOf(rt);
        side.cards.splice(p2, 1);
        // 假牌不进牌库，直接消失（见 mkCard 的注释）—— 等于白扔一张功能牌，
        // 但玩家看得见那是复制品/加减牌，不拦着他。
        if (!rt.fake) this.deck.push(rt.v);
        res.fakeGone = !!rt.fake;
        res.value = rt.v;
        res.ok = true; res.msg = '对方使用了' + f.name + '，退回了 ' + res.value + ' 点明牌';
        break;
    case 'rule':
        // 【这处仍然是拦下、不消耗牌】跟牛牛那道 5 张上限一个待遇（你定的）：
        // 已经有人超过 5 张时规则牛牛用不出去，而不是打出去之后失效。
        // 别顺手改成 funcFail —— 牛牛相关的门是全工程唯一保留「拦下」的两处。
        var rblock = this.ruleBlockedReason(id);
        if (rblock) { res.err = rblock; return res; }
        this.rule = id;
        // 【规则暗牌自带代价：出牌方自己的底牌重掷】这条规则实际上就是拼底牌
        // （开局双方各只有 1 张暗牌），不加代价的话「偷看自己底牌是 10 -> 出这张」
        // 就是稳赢，胜负在发牌那一刻就定了。重掷之后出牌方也得赌一次。
        //
        // 【每次出都重掷】手上有两张就能连着重掷两次（规则牌不消耗回合），
        // 已经是暗牌规则时再出一张也照样重掷 —— 你定的口径：花一张牌买一次重摇。
        if (id === 'rulenoseencard') {
            // 牌库空时换不了，规则照样生效（不因为换不成就让整张牌失效）
            var rr = this.rerollOwnHole(si);
            if (rr) { res.oldValue = rr.oldValue; res.value = rr.value; }
        }
        res.ok = true; res.msg = '对方使用了' + f.name;
        break;
    case 'check':
        side.checkN = Math.min(4, this.deck.length);
        res.ok = true; res.msg = '对方使用了' + f.name;
        break;
    case 'repick':
        // 自己最新的明牌洗回牌库，然后重抽一张。
        //
        // 【刚洗回去那个数字这次抽不到】靠顺序保证：先抽，再把旧牌洗回去。
        // 和「抽大」排除刚退回那张是同一个路子（见 pickbig 分支的注释），
        // 不用额外的排除逻辑。原来是「先洗回去再抽」，于是有 1/(n+1) 抽回同一张，
        // 玩家看到的是「用了重抽好像没反应」—— 这条改动就是为了掐掉那种空转。
        //
        // 例外：牌库空时没有别的牌可抽，只能洗回去再抽回同一张（你定的）。
        // 这时牌照样消耗，等于白出一张 —— 但不拦着他出。
        var rp = this.newestUp(si);
        if (!rp) { this.funcFail(res, f, '我方场上没有明牌'); break; }
        var rpPos = side.cards.indexOf(rp);
        side.cards.splice(rpPos, 1);
        res.fakeGone = !!rp.fake;
        res.oldValue = rp.v;
        res.oldFace = rp.face || undefined;   // 镜像牌 v=0 但 face='mirror'，收牌动画要靠它加载 mirror.jpg
        if (rp.fake) {
            // 假牌不洗回牌库，直接消失，然后照常重抽一张（见 mkCard 的注释）。
            // 它本来就不占牌库的位子，所以没有「排除刚洗回去那张」这回事。
            res.value = this.doDraw(si, false);
        } else if (this.deck.length === 0) {
            this.shuffleInto(rp.v);
            res.value = this.doDraw(si, false);
        } else {
            res.value = this.doDraw(si, false);
            this.shuffleInto(rp.v);
        }
        res.same = (!rp.fake && res.value === rp.v);
        res.ok = true; res.endTurn = true;
        res.msg = '对方使用了' + f.name + '，洗掉 ' +
            res.oldValue + ' 重抽到 ' + res.value;
        break;
    case 'reback':
        // 强制替换对方第一张底牌。换上来的一定不是原来那张：
        // 新牌从牌库里取，而牌库里不可能有场上已经存在的那个数字。
        //
        // 【牌库空时换回同一张，仍然算生效】你定的口径：这一手照样算成功
        // （日志按成功记、对方的过牌照样作废），只是换上来还是那个数字，
        // 而且**动画照播** —— 见客户端的 holeSwapFx。
        // 原来这里是拦下（牌不消耗），改这个的理由和别的失效一样：
        // 「点了没反应」比「用了没效果」更难理解。
        var hole = this.firstHole(1 - si);
        if (!hole) { this.funcFail(res, f, '对方没有底牌'); break; }
        res.oldValue = hole.v;
        if (this.deck.length === 0) {
            // 洗回去再抽回来，等于原地不动。牌面不用改，只标记一下给界面。
            res.value = hole.v;
            res.same = true;
            res.ok = true; res.msg = '对方使用了' + f.name;
            break;
        }
        var pickIdx = Math.floor(Math.random() * this.deck.length);
        var newV = this.deck.splice(pickIdx, 1)[0];
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
        if (this.deck.length === 0) { this.funcFail(res, f, '牌库已空'); break; }
        var mn = this.deckMin();
        this.doPick(si, mn, false);
        res.value = mn;
        res.ok = true; res.endTurn = true;
        res.msg = '对方使用了' + f.name + '，抽到了 ' + res.value;
        break;
    case 'pickbig':
        // 先退明牌再抽最大，而「最大」要**除开刚退回去的那张**（你定的规则）——
        // 不然退一张 11 就等于原地抽回来，白费一张功能牌。
        //
        // 实现上靠顺序保证：先把明牌摘下来、此时算 deckMax（牌库里还没有它），
        // 再把它压到底，最后抽那个最大值。不用额外的排除逻辑。
        if (this.deck.length === 0) { this.funcFail(res, f, '牌库已空'); break; }
        var pb = this.newestUp(si);
        // 没有明牌可退 -> 失效但牌照样消耗（和 copy 同一个规矩，你定的）
        if (!pb) { this.funcFail(res, f, '我方场上没有明牌'); break; }
        side.cards.splice(side.cards.indexOf(pb), 1);
        var mx = this.deckMax();
        res.oldValue = pb.v;
        res.fakeGone = !!pb.fake;
        if (!pb.fake) this.deck.push(pb.v);   // 假牌不进牌库
        this.doPick(si, mx, false);
        res.value = mx;
        res.ok = true; res.endTurn = true;
        res.msg = '对方使用了' + f.name + '，退回 ' +
            (res.fakeGone ? '复制品' : res.oldValue) + ' 抽到了 ' + res.value;
        break;
    case 'num':
        // 视作数字牌打在自己场上（+1 / -1）。不来自牌库 -> 假牌。
        // 点数照常进 total / upTotal，所以它也会把「明牌合计 <21」那道
        // 要牌闸门往上/往下推 —— -1 让你还能再抽一张，这是它的正经用法。
        side.cards.push(D678.mkCard(f.num, false, true, f.img));
        res.value = f.num;
        res.ok = true; res.endTurn = true;
        res.msg = '对方使用了' + f.name;
        break;
    case 'copy':
        // 复制自己最新的**明牌**的点数（newestUp 会跳过暗牌）。
        // 场上一张明牌都没有时失效，但牌照样消耗（你定的）。
        var cp = this.newestUp(si);
        if (!cp) { this.funcFail(res, f, '我方没有明牌可以复制'); break; }
        // 【face 要一起复制】复制一张 +1 得到的就是另一张 +1（-1 同理）。
        // 原来只复制点数，于是复制 +1 得到一张「1 点的复制品」，显示成 1 ——
        // 玩家看到的是「我复制了 +1，场上却多了张 1」，读不通。
        // 点数本来就相同（+1 的 v 就是 1），所以这只影响显示成哪张卡图。
        // 镜像牌被复制后仍然是镜像（mirror 标记带过去）。
        var cpCard = D678.mkCard(cp.v, false, true, cp.face);
        if (cp.mirror) cpCard.mirror = true;
        side.cards.push(cpCard);
        res.value = cp.v;
        res.ok = true; res.endTurn = true;
        res.msg = '对方使用了' + f.name + '，复制了 ' + res.value;
        break;
    case 'helppick':
        // 帮对方抽牌库里最小的一张明牌。不消耗回合。
        if (this.deck.length === 0) { this.funcFail(res, f, '牌库已空'); break; }
        // 牛牛下对方满 5 张就不能再往对方场上加牌（helppick 不在 GAIN_KINDS
        // 里，cardGainBlockedReason 不会挡，所以在这里单独挡对方那侧）
        if (this.isCowRule() && opp.cards.length >= D678.COW_MAX_CARDS) {
            res.err = D678.cowCapMsg(); return res;
        }
        var hpMn = this.deckMin();
        this.doPick(1 - si, hpMn, false);
        res.value = hpMn;
        res.ok = true; res.msg = '对方使用了' + f.name + '，帮对方抽出了 ' + res.value;
        break;
    case 'mirror':
        // 在对方场上放一张镜像虚空牌，动态复制自己同位置的明牌，
        // 点数算在对方头上（骚扰：往对方头上塞牌、促使其爆牌）。
        // resolveMirror 遍历双方，mirror 牌在 opp 侧时自动复制 self 同位置——
        // 方向反转不需要改 resolveMirror，它本来就两边都扫。
        // 初始 v=0 face='mirror'（同位置没牌 / 是暗牌时保持 0）。
        // 不消耗回合。牛牛上限查对方（不在 GAIN_KINDS 里，这里单独挡）。
        if (this.isCowRule() && opp.cards.length >= D678.COW_MAX_CARDS) {
            res.err = D678.cowCapMsg(); return res;
        }
        var mc = D678.mkCard(0, false, true, 'mirror');
        mc.mirror = true;
        opp.cards.push(mc);
        this.resolveMirror();
        res.ok = true; res.endTurn = false;
        res.msg = '对方使用了' + f.name;
        break;
    case 'destroy':
        // 把对方最新的非底牌放到牌库最下方。不消耗回合。
        // 底牌始终在 index 0，所以对方只有 1 张牌时没有可破坏的目标。
        // 明牌暗牌都能破坏；暗牌被破坏时不透露点数（日志只写「暗牌」）。
        // 假牌（虚空数字 / 镜像）不进牌库，直接消失。
        if (opp.cards.length <= 1) { this.funcFail(res, f, '对方没有可破坏的牌'); break; }
        var dst = opp.cards.pop();
        res.targetHidden = dst.hidden;
        res.fakeGone = !!dst.fake;
        res.value = dst.v;                 // 暗牌不给对方看，下面 msg 按 targetHidden 挑
        if (!dst.fake) this.deck.push(dst.v);
        this.resolveMirror();
        res.ok = true; res.msg = '对方使用了' + f.name + '，破坏了' +
            (res.targetHidden ? '一张暗牌' : ' ' + res.value + ' 点明牌');
        break;
    case 're2big':
        // 双方各自最大的一张明牌压到牌库底，两张的顺序随机。
        // 一方没有明牌就只处理另一方；双方都没有也照样能用，只是没有效果
        //（你定的：不拒绝，白扔算玩家失误）。
        // 并列取最新那张（maxUp 用 >= 比较）。虚空数字不进牌库、直接消失。
        var big0 = this.maxUp(si), big1 = this.maxUp(1 - si);
        res.mine  = big0 ? big0.v : null;
        res.other = big1 ? big1.v : null;
        res.mineFake  = !!(big0 && big0.fake);
        res.otherFake = !!(big1 && big1.fake);
        if (!big0 && !big1) { this.funcFail(res, f, '双方都没有明牌'); break; }
        // 【先摘牌再压库】两张都摘下来之后才往牌库底压，否则先压进去的那张
        // 会参与另一侧的挑选（虽然 maxUp 只看场上，但顺序清楚一点更稳）。
        if (big0) side.cards.splice(side.cards.indexOf(big0), 1);
        if (big1) opp.cards.splice(opp.cards.indexOf(big1), 1);
        var toBottom = [];
        if (big0 && !big0.fake) toBottom.push(big0.v);
        if (big1 && !big1.fake) toBottom.push(big1.v);
        D678.shuffle(toBottom);              // 两张的顺序随机（你定的）
        for (var tb = 0; tb < toBottom.length; tb++) this.deck.push(toBottom[tb]);
        this.resolveMirror();
        res.ok = true;
        res.msg = '对方使用了' + f.name;
        break;
    case 'repickback':
        // 换自己的底牌，方向和 干扰 相反。「一定不是原来那张」靠 rerollOwnHole
        // 的取牌顺序天然成立（先从牌库取新的，旧的后洗回去）。
        //
        // 【牌库空时算生效、不算失效】你定的：那时底牌洗回去只能抽回同一张，
        // 但动画照播。和 干扰 那边的处理一致。
        var myHole = this.firstHole(si);
        if (!myHole) { this.funcFail(res, f, '我方没有底牌'); break; }
        res.oldValue = myHole.v;
        if (this.deck.length === 0) {
            res.value = myHole.v;
            res.same = true;
            res.ok = true; res.msg = '对方使用了' + f.name;
            break;
        }
        var rrb = this.rerollOwnHole(si);
        res.value = rrb.value;
        res.ok = true;
        res.msg = '对方使用了' + f.name;
        break;
    case 'copyback':
        // 复制自己底牌的点数，以**暗牌**形式追加。虚空数字（fake）。
        //
        // 【这是唯一能绕过要牌闸门加点数的牌】暗牌不进 upTotal，所以
        // 底牌 10 + 这张 = 手上 20 点，而「明牌合计 <21」那道闸门毫无察觉。
        // 进 GAIN_KINDS，所以牛牛下满 5 张时在函数开头就被拦下了。
        //
        // 静态复制、不是镜像：之后底牌被 干扰 / 重抽底牌 换掉，这张不跟着变。
        var chb = this.firstHole(si);
        if (!chb) { this.funcFail(res, f, '我方没有底牌'); break; }
        side.cards.push(D678.mkCard(chb.v, true, true, chb.face));
        res.value = chb.v;
        res.ok = true; res.endTurn = true;
        res.msg = '对方使用了' + f.name;
        break;
    case 'smallchangebig':
        // 自己最小的明牌 <-> 对方最大的明牌。不看位置（全场最小/最大），
        // 并列取最新那张。就地换数值，牌不换阵营（和 swap 同一套做法，
        // 所以 fake / face / mirror 必须跟着 v 一起换 —— 见 swap 分支的注释）。
        var sMin = this.minUp(si), oMax = this.maxUp(1 - si);
        if (!sMin || !oMax) {
            this.funcFail(res, f, sMin ? '对方场上没有明牌' : '我方场上没有明牌');
            break;
        }
        res.value = sMin.v; res.other = oMax.v;
        var sv2 = sMin.v; sMin.v = oMax.v; oMax.v = sv2;
        var sf = sMin.fake, sc = sMin.face, sm = sMin.mirror;
        if (oMax.fake) sMin.fake = true; else delete sMin.fake;
        if (oMax.face) sMin.face = oMax.face; else delete sMin.face;
        if (oMax.mirror) sMin.mirror = true; else delete sMin.mirror;
        if (sf) oMax.fake = true; else delete oMax.fake;
        if (sc) oMax.face = sc; else delete oMax.face;
        if (sm) oMax.mirror = true; else delete oMax.mirror;
        this.resolveMirror();
        res.ok = true;
        res.msg = '对方使用了' + f.name + '，' + res.value + ' 和 ' + res.other + ' 互换';
        break;
    }

    // 出牌后镜像牌的值可能因这次牌面变化而需要刷新
    //（对方加了牌 / 换了牌 / 被破坏了牌）。endTurn 里也会刷一次，
    // 但不消耗回合的牌不走 endTurn，所以这里兜底。
    this.resolveMirror();

    if (res.ok) {
        // 日志：使用了什么牌、结果如何
        var what = '使用了' + f.name;
        // 【失败原因走 res.err，别写死】原来这里一律写「该号牌已在场上」，
        // 那是抽号牌的失败原因；复制失败是「没有明牌可以复制」，
        // 写死之后日志上会给出一个跟事实无关的理由。
        if (res.fail)                     what += '（失败：' + (res.err || '无法使用') + '）';
        else if (f.kind === 'pick')       what += '，抽出了 ' + f.num;
        else if (f.kind === 'pickback')   what += '，暗抽了 1 张';
        else if (f.kind === 'swap')       what += '，' + res.value + ' 和 ' + res.other + ' 互换';
        else if (f.kind === 'rob')        what += '，夺走对方 ' + res.value + ' 点明牌';
        else if (f.kind === 'return')     what += '，退回 ' + res.value + ' 点明牌';
        else if (f.kind === 'rule')       what += '，规则变为' + f.name +
                                                  // 规则暗牌会重掷出牌方的底牌（换不成时没有这两个字段）
                                                  (res.value !== undefined && res.value !== null ?
                                                   '，自己底牌 ' + res.oldValue + ' 换成 ' + res.value : '');
        else if (f.kind === 'check')      what += '，看了牌库顶 ' + side.checkN + ' 张';
        else if (f.kind === 'repick')     what += '，洗掉 ' + res.oldValue + ' 重抽到 ' +
                                                  res.value + (res.same ? '（又是同一张）' : '');
        else if (f.kind === 'reback')     what += '，替换了对方底牌' +
                                                  (res.same ? '（牌库已空，没有变化）' : '');
        else if (f.kind === 'picksmall')  what += '，抽出了最小的 ' + res.value;
        else if (f.kind === 'pickbig')    what += '，退回 ' +
                                                  (res.fakeGone ? '复制品' : res.oldValue) +
                                                  ' 抽出了最大的 ' + res.value;
        else if (f.kind === 'num')        what += '，场上多了 ' + f.name;
        else if (f.kind === 'copy')       what += '，复制了 ' + res.value;
        else if (f.kind === 'helppick')   what += '，帮对方抽出了 ' + res.value;
        else if (f.kind === 'mirror')     what += '，镜像复制';
        else if (f.kind === 'destroy')    what += '，破坏了对方' +
                                                  (res.targetHidden ? '一张暗牌' : ' ' + res.value + ' 点明牌');
        // 【去大：自己那张写点数，对方那张也写】双方各去一张，日志上两个都要有，
        // 不然看日志的人不知道对方掉了什么。虚空那张标出来（它是消失、没进牌库）。
        else if (f.kind === 're2big')     what += '，去掉自己' +
                                                  (res.mine === null ? '（无明牌）' :
                                                   ' ' + res.mine + (res.mineFake ? '（虚空）' : '')) +
                                                  '、对方' +
                                                  (res.other === null ? '（无明牌）' :
                                                   ' ' + res.other + (res.otherFake ? '（虚空）' : ''));
        // 【这两张不写点数，但不是为了防泄漏】日志只在揭牌后才下发/展示
        //（服务器 maskLog、单机的轮结果页），而 logAct 记的 hand 本来就含
        // 暗牌数值 —— 写不写都泄不了。不写纯粹是因为这两张的动作对象是
        // 「自己的底牌」，点数在同一行的 hand 里已经看得到了。
        else if (f.kind === 'repickback') what += '，重抽了自己的底牌' +
                                                  (res.same ? '（牌库已空，没有变化）' : '');
        else if (f.kind === 'copyback')   what += '，复制了自己的底牌';
        else if (f.kind === 'smallchangebig')
                                          what += '，自己 ' + res.value + ' 和对方 ' +
                                                  res.other + ' 互换';
        else if (f.kind === 'pick2' && res.only) {
            what += '，牌库只剩 1 张，抽出了 ' + res.value;
        }
        // 【二选一留着待选时不记日志】此刻还没选，写「使用了二选一」之后紧跟着
        // 又要写一条「选了 N」，日志上是两行半截话。等 pick2Resolve 一次写完整。
        // （退化成抽 1 张那种没有选择环节，上面已经补完，照常记。）
        if (!this.pending2) this.logAct(si, what);

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
        // 只有抽牌类（指定抽牌成功 / 抽暗牌）才结束回合
        if (res.endTurn) this.endTurn();
    }
    return res;
};

//--- 二选一的待选状态 ------------------------------------------------------
//
// pending2 = { side, vals:[a,b], funcName }
// 它是整个规则层唯一一个「回合停在中途」的状态，所以有三条不变量：
//   1. 存在期间那两张牌**还在牌库里**（只是被预定），deck.length 不变；
//   2. 只有 pending2.side 能选，别人的任何动作都该被上层拦住；
//   3. 一定要被清掉 —— 选完清、平局重发清、newDeal 清、AI 推演的克隆里不带。
// 漏清的后果是下一局开局就带着上一局的候选，随机冒出来，最难查。

// 还在等谁选（没有待选就返回 -1）
D678_Battle.prototype.pending2Side = function () {
    return this.pending2 ? this.pending2.side : -1;
};

// 选一张。idx 是 0/1；越界或没有待选都返回 null（上层当非法请求处理）。
// 返回 {value, other} —— 拿到的那张、压回牌库底的那张。
D678_Battle.prototype.pick2Resolve = function (si, idx) {
    var p = this.pending2;
    if (!p || p.side !== si) return null;
    if (idx !== 0 && idx !== 1) return null;
    var keep = p.vals[idx], other = p.vals[1 - idx];
    // 【先清 pending2 再动牌】doDraw / endTurn 都可能回头读盘面状态，
    // 留着一个已经作废的待选会让它们看到不一致的局面。
    this.pending2 = null;
    // 两张候选此前只是被预定，现在才真的从牌库里取走
    D678.remove(this.deck, keep);
    D678.remove(this.deck, other);
    this.consumeCheck();                 // 牌库被动过，查看牌库的情报作废一层
    this.sides[si].cards.push(D678.mkCard(keep, false));
    this.deck.push(other);               // 没选的那张压到牌库底
    this.logAct(si, '使用了' + (p.funcName || '二选一') +
        '，抽出了 ' + keep + '（另一张压回牌库底）');
    // 抽牌类一律结束回合
    this.standStreak = 0;
    this.sides[si].stood = false;
    this.sides[1 - si].stood = false;
    this.endTurn();
    return { value: keep, other: other };
};

// 超时 / 掉线兜底：随机选一张。
// 【为什么不默认选第一张】固定选第一张的话，超时就等于「总是拿牌库顶那张」，
// 知道牌库顺序的人（超哥、用过查看牌库的人）能靠拖时间拿到确定的牌。
D678_Battle.prototype.pick2Auto = function (si) {
    if (!this.pending2 || this.pending2.side !== si) return null;
    return this.pick2Resolve(si, Math.random() < 0.5 ? 0 : 1);
};

//--- 结算 ------------------------------------------------------------------

D678_Battle.prototype.doResolve = function () {
    this.revealed = true;
    // 胜负一律走 scoreOf + cmpScore（唯一权威），别在这里重写一份比较逻辑 ——
    // AI.resolveUtil 用的是同一对函数，两边必须永远一致。
    var s0 = this.scoreOf(0), s1 = this.scoreOf(1);
    var t0 = s0.total, t1 = s1.total;
    var b0 = s0.bust, b1 = s1.bust;
    var m0 = s0.max, m1 = s1.max;
    var c = D678.cmpScore(s0, s1);
    var win = (c === 0) ? -1 : (c > 0 ? 0 : 1);

    var info = {
        totals: [t0, t1], busts: [b0, b1], maxes: [m0, m1],
        winner: win, tie: (win < 0), dmg: 0, target: this.target()
    };
    // 牛牛的成绩不是点数，结算画面要显示「牛4 / 无牛」，所以单独带出去
    if (this.isCowRule()) info.cows = [s0.cow, s1.cow];
    // 比多和比少的判定都先看张数，所以结算画面要显示双方各几张
    if (this.isMoreRule() || this.isLessRule()) info.cardCounts = [s0.cards, s1.cards];
    // 【「爆牌」这个词在爆牌线倒过来的规则下是错的】规则大21 和 规则比少
    // 判负的条件是**低于** 21 点，写「爆牌」等于告诉玩家他超了。
    // 收在这里是因为单机和联机两个结算画面读的是同一份 result ——
    // 各自判一次规则迟早漂，而且联机那份 result 里本来就没有 rule 字段。
    info.bustWord = this.bustWord();

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

    // 伤害 = 5（底伤） + 败方爆牌 3 + 胜方满点 3 + 平局加伤 + 败场差加伤
    // 例：对方满点、自己爆牌 -> 5 + 3 + 3 = 11
    //     干净一局输 -> 5
    //
    // 【平局加伤】翻倍制：平 1 次 +1、2 次 +2、3 次 +4，之后 8/16/32…
    // redeals 是本次拼点已经重发过几次，也就是已经平了几次 —— 新 Battle 会
    // 归零，所以惩罚只在这一场里累积。
    // 【败场差加伤】comeback 机制：胜者败场比败者多时，差额计入额外伤害。
    // 只在胜者败场 > 败者败场时触发（落后者赢了才加伤），不设上限。
    // 单机、1v1、锦标赛、天梯共用这一份规则，AI 的估值（AI.resolveUtil）
    // 也走同一个 D678.tieBonusOf 和 D678.comebackBonusOf。
    var items = 5;
    if (info.busts[lose]) items += 3;
    if (info.maxes[win]) items += 3;
    var tieBonus = D678.tieBonusOf(this.redeals);
    var comeback = D678.comebackBonusOf(W.losses, L.losses);
    var dmg = items + tieBonus + comeback;
    info.dmg = dmg;
    info.items = items;
    info.tieBonus = tieBonus;
    info.comeback = comeback;
    // 分出胜负这一帧也要显示平局次数（解释伤害是怎么来的）。
    //
    // 【这里发的是次数不是加伤】翻倍之后两者不再相等（平 3 次 = 加伤 4）。
    // 客户端拿它画「平局✖N」，要的是次数；原来两者相等所以直接复用了
    // tieBonus，现在必须分开。
    info.tieCount = this.redeals || 0;

    W.wins++;
    L.losses++;
    // 对手战绩（淘汰页的「VS B 对局 N 场，胜率 X%」）。
    // 单机联机共用这一份 —— 联机时服务器跑的就是这个函数。
    D678.noteVs(W, L, true);
    D678.noteVs(L, W, false);
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
    // 【克隆里不带待选状态】AI 推演二选一时是「立刻挑更好的那张」，
    // 不该在推演盘面上留一个等人选的状态；带过去的话推演里的
    // useFunc('2pick1') 会看到已经有 pending2 而行为跑偏。
    b.pending2 = null;
    b.sides = this.sides.map(function (s) {
        return {
            p: { funcs: s.p.funcs.slice(0), isGod: s.p.isGod, name: s.p.name,
                 hp: s.p.hp, losses: s.p.losses, isHuman: s.p.isHuman },
            index: s.index,
            // uid 照抄 —— 克隆是给 AI 推演用的，不进画面，但 newestUp / indexOf
            // 那些定位逻辑要跟真盘面一致，别在这儿引入差异
            cards: s.cards.map(function (c) {
                // fake 要照抄：AI 推演里 return / repick 碰到假牌走的是
                // 「消失」那条路，漏了它推演出的牌库和真盘面就会分叉。
                // mirror 也要照抄：resolveMirror 靠它在克隆盘面上刷新镜像值，
                // 漏了它镜像牌就变成一张恒 0 的死牌，AI 估值全错。
                // face 不抄 —— 纯绘制用，推演不进画面。
                var o = { v: c.v, hidden: c.hidden, uid: c.uid };
                if (c.fake) o.fake = true;
                if (c.mirror) o.mirror = true;
                return o;
            }),
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
//
// 【假牌不算】假牌不是从牌库来的，它的点数跟牌库里那张同号真牌毫无关系。
// 把一张假 +1 记成「1 号牌已经露面」，AI 就会以为真的 1 号还在别处，
// 未见牌集合少一张 —— 爆牌率、对手点数分布、指定抽牌的成功率全跟着错。
D678.AI.unseen = function (b, si) {
    var known = {}, i, c;
    var mine = b.sides[si].cards, opp = b.sides[1 - si].cards;
    var god  = !!b.sides[si].p.isGod;
    for (i = 0; i < mine.length; i++) { if (!mine[i].fake) known[mine[i].v] = true; }
    for (i = 0; i < opp.length; i++) {
        if (opp[i].fake) continue;
        if (god || !opp[i].hidden) known[opp[i].v] = true;
    }
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
// 是否确切知道牌库顶 n 张。
// 【二选一要的是「顶两张」，knowsNext 只保证顶一张】查看牌库看到的是
// checkN 张，只用过一次查看牌库（checkN=4）时顶两张都是已知的；
// 但 checkN 被抽牌消耗到 1 时就只知道一张，那时第二张仍然是未知的。
D678.AI.knowsTop = function (b, si, n) {
    if (b.deck.length < n) return false;
    return !!b.sides[si].p.isGod || b.sides[si].checkN >= n;
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

// 从一个标量点数还原出成绩对象。
//
// 前五张规则牌下这是**精确**的（成绩只是点数的函数），所以老路径分毫不变。
// 改判定方式的三张需要点数之外的情报：
//   · 比多  -> 张数 n（张数是公开信息，看得见，能精确带上）
//   · 牛牛  -> 凑十掩码 reach（2D 掩码，cowReach 返回值）
// 拿不到时退回保守假设：reach 缺失就当「凑得出」（多数手牌确实凑得出，
// 且这只用在**估对手**上 —— 我方成绩永远走 scoreOf 精确算，
// 高估对手是安全方向）。n 缺失就用盘面上的实际张数。
D678.AI.scoreFromTotal = function (b, si, t, n, reach) {
    if (b.isCowRule()) {
        // 张数缺失时用盘面实际张数（跟比多那支一样的兜底）——
        // 构成牛恰好要 3 或 4 张，这个约束不能因为标量还原就丢掉。
        var cn = (n === undefined) ? b.countCards(si, false) : n;
        var cow = D678.cowScoreFrom(t, reach, cn);
        return { bust: false, max: cow === 10, rank: [cow], total: t, cow: cow };
    }
    var bust = b.isBustVal(t);
    if (b.isMoreRule() || b.isLessRule()) {
        var cnt = (n === undefined) ? b.countCards(si, false) : n;
        // 比少的 rank 是负张数（少者胜），和 scoreOf 那边必须一致 ——
        // 这两处算出不同的 rank 会让 AI 按一套规则推演、按另一套结算。
        var nRank = b.isLessRule() ? -cnt : cnt;
        return { bust: bust, max: b.isMaxVal(t), total: t,
                 rank: [nRank, -b.distVal(t)], cards: cnt };
    }
    return { bust: bust, max: b.isMaxVal(t), total: t, rank: [-b.distVal(t)] };
};

// mt / ot 可以是标量点数（老路径）或成绩对象（改判定的规则牌用）
D678.AI.asScore = function (b, si, x) {
    if (x !== null && typeof x === 'object') return x;
    return this.scoreFromTotal(b, si, x);
};

// 若此刻结算，si 方的收益（HP 单位，含累计败场加伤 / 淘汰 / 功能牌补偿）
D678.AI.resolveUtil = function (b, si, mt, ot) {
    var sm = this.asScore(b, si, mt), so = this.asScore(b, 1 - si, ot);
    var bm = sm.bust, bo = so.bust;
    var mm = sm.max,  mo = so.max;
    // 胜负走 doResolve 用的同一个比较器，不在这里重写
    var c = D678.cmpScore(sm, so);
    var win = (c === 0) ? 0 : (c > 0 ? 1 : -1);
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
    // 平局加伤：翻倍制（doResolve 里的 tieBonus，同一个 D678.tieBonusOf）。
    // 这里必须跟着算 —— 不算的话平过几次之后 AI 会低估赌注，
    // 该保守的时候还在赌爆牌。
    // 败场差加伤同理：comeback 机制下落后者赢的收益更大，
    // 不算的话 AI 在败场差大的时候会低估自己的赢面收益。
    var tieBonus = D678.tieBonusOf(b.redeals);
    var items, dmg, cb, v;
    if (win > 0) {
        items = 5 + (bo ? 3 : 0) + (mm ? 3 : 0);
        cb = D678.comebackBonusOf(meP.losses, opP.losses);
        dmg = items + tieBonus + cb;
        v = dmg;
        if ((opP.hp || 0) - dmg <= 0) v += this.HP_KILL;
        return v;
    }
    items = 5 + (bm ? 3 : 0) + (mo ? 3 : 0);
    cb = D678.comebackBonusOf(opP.losses, meP.losses);
    dmg = items + tieBonus + cb;
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
// 返回 {t, n, rc} 条目数组（不再是裸点数）：t 点数、n 张数、rc 凑十掩码。
// 「比多」要张数、「牛牛」要凑十位，这两样沿着抽牌链都能精确递推，
// 所以超哥在新规则下仍然不依赖任何对手模型。
D678.AI.godOppTotals = function (b, si) {
    var oi = 1 - si;
    var cow = b.isCowRule();
    var t = b.total(oi);
    var n = b.countCards(oi, false);
    var rc = cow ? D678.cowReach(b.scoreVals(oi)) : null;
    var out = [{ t: t, n: n, rc: rc }];
    if (b.sides[oi].stood) return out;      // 已停牌，只有这一个可能
    var deck = b.deck.slice(0);
    var up = b.upTotal(oi);
    var guard = 0;
    // 闸门走 chainCanDraw：牛牛下是张数上限，别的规则下才是明牌合计 < 21
    while (deck.length > 0 && this.chainCanDraw(b, up, n) && guard++ < 12) {
        var v = deck.shift();
        var dv = b.scoreDelta(v, false);    // 抽的是明牌
        t  += dv;
        up += b.adj(v);
        n++;
        if (cow) rc = D678.cowReachAdd(rc, dv);
        out.push({ t: t, n: n, rc: rc });
        if (b.isBustVal(t) && !b.isOver21Rule()) break;   // 爆了不会再要
    }
    return out;
};

// 分布条目 -> 成绩对象
D678.AI.entScore = function (b, oi, e) {
    return this.scoreFromTotal(b, oi, e.t, e.n, e.rc);
};

// 沿着推演出来的抽牌链，「还抽得动吗」。
//
// 【为什么不能直接调 canHit】canHit 问的是**当前真实盘面**，而这些推演走在
// 假想的未来（对手已经又抽了两张）。所以这里拿链上递推出来的 up / n 复判一次
// 同一条闸门 —— 口径必须跟 canHit 完全一致，否则 AI 会以为对手还能抽
// （或者以为对手已经抽不动了），对手模型直接算错。
// up: 该方明牌合计（含规则修正）；n: 该方牌数（含暗牌）。
D678.AI.chainCanDraw = function (b, up, n) {
    if (b.isCowRule()) return n < D678.COW_MAX_CARDS;
    return up < 21;
};

// 超哥的停牌价值：对手所有可能停手点里的最坏结果（minimax）
D678.AI.godStandValue = function (b, si) {
    var mt = b.scoreOf(si);            // 我方成绩永远精确算，不用标量还原
    var ots = this.godOppTotals(b, si);
    var worst = Infinity;
    for (var i = 0; i < ots.length; i++) {
        var v = this.resolveUtil(b, si, mt, this.entScore(b, 1 - si, ots[i]));
        if (v < worst) worst = v;
    }
    if (worst === Infinity) worst = 0;
    // 平手（0）之间还要分优劣：越靠近目标点数越好，作为极小的次级判据，
    // 保证他在“怎么走都不败”时仍然选最接近 21 的那条线。
    var tie = -this.godDist(b, b.total(si)) * 0.001;
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
    var cand = D678.RULE_IDS;
    var save = b.rule, hits = 0, own = 0;
    for (var i = 0; i < cand.length; i++) {
        if (cand[i] === save) continue;
        if (funcs.indexOf(cand[i]) < 0) continue;   // 超哥知道对手到底有哪几张
        if (b.ruleBlockedReason(cand[i])) continue; // 他现在打不出来的牌不算威胁
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
    var oi = 1 - si;
    // 对手张数是公开信息（暗牌也看得见张数），所以「比多」下能精确带上
    var oppN = b.countCards(oi, false);
    if (god) {
        // 超哥不做概率估计：把对手所有可能的停手点等权列出，
        // 真正的取舍在 godStandValue 里按最坏情况做。
        var ots = this.godOppTotals(b, si);
        for (i = 0; i < ots.length; i++) {
            out.push({ t: ots[i].t, w: 1 / ots.length, n: ots[i].n, rc: ots[i].rc });
        }
        return out;
    } else {
        // 我方已知的、计入对手判定的那些牌值（规则暗牌下明牌不算）
        var knownVals = [];
        if (!b.isHiddenRule()) {
            var oc = b.sides[oi].cards;
            for (i = 0; i < oc.length; i++) {
                if (!oc[i].hidden) knownVals.push(b.adj(oc[i].v));
            }
        }
        var kn = b.sides[si].known;
        for (var q = 0; q < kn.length; q++) knownVals.push(b.adj(kn[q]));
        var base = 0;
        for (i = 0; i < knownVals.length; i++) base += knownVals[i];
        var cowR = b.isCowRule() ? D678.cowReach(knownVals) : null;
        var k = this.oppHiddenUnknown(b, si);
        if (k <= 0 || U.length === 0) {
            out.push({ t: base, w: 1, n: oppN, rc: cowR });
        } else {
            // 精确枚举对手暗牌的所有组合，不再用“平均牌”近似
            var cs = this.combos(U, Math.min(k, U.length), 400);
            if (!cs.length) {
                out.push({ t: base, w: 1, n: oppN, rc: cowR });
            } else {
                // 不再等权：按每个候选点数能否解释对手的实际选择加权
                var mtV = this.oppViewOfMe(b, si, U);
                var wsum = 0, tmp = [];
                for (i = 0; i < cs.length; i++) {
                    var t = base, rc = cowR;
                    for (j = 0; j < cs[i].length; j++) {
                        // 枚举的是对手的**暗牌**，规则暗牌下这些是算数的
                        var av = b.adj(cs[i][j]);
                        t += av;
                        if (rc) rc = D678.cowReachAdd(rc, av);
                    }
                    var w = this.behaviorWeight(b, si, t, U, mtV);
                    tmp.push({ t: t, w: w, n: oppN, rc: rc });
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
    out = this.mergeDist(out, b);
    // 对手若尚未停牌，按“对手也在最大化自己收益”展开其后续要牌。
    // 闸门走 chainCanDraw（牛牛下是张数上限），跟 canHit 同一口径。
    if (!b.sides[1 - si].stood && b.deck.length > 0 &&
        this.chainCanDraw(b, b.upTotal(1 - si), b.countCards(1 - si, false))) {
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

// 对手是否会在点数 ot 时继续要牌 —— 用对手自己的 HP 收益判断，而非固定阈值。
// ent 是该点数对应的分布条目（带张数 / 凑十掩码），改判定的规则牌下必须带上，
// 否则「抽一张」的收益会按错的判定方式算。
D678.AI.oppWouldHit = function (b, si, ot, U, mtView, ent) {
    var oi = 1 - si;
    if (b.isBustVal(ot) && !b.isOver21Rule()) return false;
    var e = ent || { t: ot };
    var stand = this.resolveUtil(b, oi, this.entScore(b, oi, e), mtView);
    var hit = 0;
    for (var j = 0; j < U.length; j++) {
        var dv = b.scoreDelta(U[j], false);
        var he = {
            t: e.t + dv,
            n: (e.n === undefined) ? undefined : e.n + 1,
            rc: e.rc ? D678.cowReachAdd(e.rc, dv) : e.rc
        };
        hit += this.resolveUtil(b, oi, this.entScore(b, oi, he), mtView);
    }
    hit /= U.length;
    return hit > stand;
};

// 按点数合并分布：前五张规则牌下只有总点数影响结果，合并后条目数恒定在 ~40 以内。
//
// 【改判定的三张要多带键】比多的结果还取决于张数，牛牛还取决于能否凑十 ——
// 只按点数合并会把不同结果的条目并成一条，等于把 AI 的对手模型悄悄算错。
// 所以这两种规则下把 n / rc 也放进键里。老五张的键保持只有 t，
// 合并率和原来分毫不差（新规则的条目数上界也仍然很小：n ≤ ~12、rc 至多 1024 种，
// 实际远小于此，因为 t 和 n 强相关）。
D678.AI.mergeDist = function (list, b) {
    // 牛牛也要带 n：那条规则的抽牌闸门是张数上限（见 expandOpp），
    // 张数不同的条目「还能不能再抽」不一样，合并掉会让展开用错的张数继续推。
    // 比少和比多一样，成绩取决于张数 —— 不带 n 会把「同点数不同张数」
    // 这种结果相反的条目并成一条。
    var needN  = !!(b && (b.isMoreRule() || b.isLessRule() || b.isCowRule()));
    var needRC = !!(b && b.isCowRule());
    var m = {}, out = [], i, k;
    for (i = 0; i < list.length; i++) {
        var e = list[i];
        k = String(e.t);
        if (needN)  k += '|' + e.n;
        if (needRC) k += '|' + D678.cowReachKey(e.rc);
        if (m[k]) { m[k].w += e.w; continue; }
        m[k] = { t: e.t, w: e.w, n: e.n, rc: e.rc };
    }
    var keys = Object.keys(m);
    for (i = 0; i < keys.length; i++) out.push(m[keys[i]]);
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
        // 【这道 21 闸门看的是明牌合计，不是判定点数】规则暗牌下 e.t 只含暗牌，
        // 拿它跟 21 比会以为对手还能一直抽。所以那条规则下改用张数近似的明牌合计
        // ——对手抽不动的真正条件仍由 oppWouldHit 里的 canHit 兜底。
        //
        // 牛牛下这条线整个换掉：那条规则的闸门是张数上限，
        // 点数越过 21 完全合法（也没有爆牌），按 21 判会以为对手早就停手了。
        var blocked;
        if (b.isCowRule()) {
            blocked = !this.chainCanDraw(b, 0, (e.n === undefined)
                ? b.countCards(1 - si, false) : e.n);
        } else {
            var gate = b.isHiddenRule() ? b.upTotal(1 - si) : e.t;
            blocked = (gate >= 21);
        }
        // 缓存键必须带上「结果还取决于什么」：牛牛下同一个点数配不同的凑十掩码 /
        // 张数是不同的局面，只按 t 缓存会把别的条目的答案套上来。
        var ck = b.isCowRule()
            ? (e.t + '|' + e.n + '|' + D678.cowReachKey(e.rc)) : String(e.t);
        if (blocked) hit = false;
        else if (hitCache[ck] !== undefined) hit = hitCache[ck];
        else hit = hitCache[ck] = this.oppWouldHit(b, si, e.t, U, mtView, e);
        if (!hit) { out.push(e); continue; }
        moved = true;
        for (j = 0; j < U.length; j++) {
            var dv = b.scoreDelta(U[j], false);      // 对手抽的是明牌
            out.push({
                t: e.t + dv,
                w: e.w / U.length,
                n: (e.n === undefined) ? undefined : e.n + 1,
                rc: e.rc ? D678.cowReachAdd(e.rc, dv) : e.rc
            });
        }
    }
    if (!moved) return this.mergeDist(out, b);
    return this.expandOpp(b, si, this.mergeDist(out, b), U, depth - 1);
};

// 我方点数 mt 面对对手分布时的期望收益（HP 单位）
D678.AI.valueVs = function (b, si, mt, dist) {
    if (!dist.length) return 0;
    var v = 0, tot = 0;
    for (var i = 0; i < dist.length; i++) {
        tot += dist[i].w;
        // 条目转成成绩对象再比 —— 分布里带着张数 / 凑十位
        v += dist[i].w * this.resolveUtil(b, si, mt, this.entScore(b, 1 - si, dist[i]));
    }
    return tot > 0 ? v / tot : 0;
};

// 我方当前点数被对手规则牌破坏的风险代价
D678.AI.vulnPenalty = function (b, si) {
    var opp = b.sides[1 - si];
    var n = (opp.p.funcs || []).length;
    if (n <= 0) return 0;
    var cand = D678.RULE_IDS;
    var god = !!b.sides[si].p.isGod;
    var save = b.rule, hits = 0, seen = 0;
    for (var i = 0; i < cand.length; i++) {
        if (cand[i] === save) continue;
        if (god && opp.p.funcs.indexOf(cand[i]) < 0) continue;   // 超哥知道对手到底有什么
        if (b.ruleBlockedReason(cand[i])) continue;   // 现在打不出来的牌不算威胁
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
    // 我方成绩走 scoreOf 精确算（牛牛要看具体是哪几张牌，标量还原不出来）
    var v = this.valueVs(b, si, b.scoreOf(si), this.oppDist(b, si, U));
    return v - this.vulnPenalty(b, si);
};

// 在克隆盘面上加一张牌（用于推演）
D678.AI.simAdd = function (b, si, v, hidden) {
    D678.remove(b.deck, v);
    // 推演盘面不进画面，uid 用不上；但给一个负数占位，免得 undefined
    // 混进 cardKey 那类拼字符串的地方（推演不该影响真实 uid 的计数）
    b.sides[si].cards.push({ v: v, hidden: !!hidden, uid: -1 });
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

// 未见牌里是否存在“抽了之后不爆、且成绩更好”的牌。
//
// 【为什么不能只比 distVal】改判定的三张规则牌下「更好」不是「更接近目标」：
//   · 牛牛  -> 抽一张可能把无牛变成有牛、或把个位推大，得用 cmpScore 比
//   · 比多  -> 多一张牌本身就是改善，哪怕点数更远
//   · 规则暗牌 -> 抽明牌对成绩**毫无影响**（scoreDelta 为 0），
//               所以这条规则下抽牌永远不算改善，AI 会正确地停牌
// 统一改成「拿抽牌后的成绩跟现在的成绩比」，老五张下与原来等价
// （成绩 rank 就是 -dist，比 dist 小即 rank 大）。
D678.AI.canImprove = function (b, si) {
    var U = this.unseen(b, si);
    var curS = b.scoreOf(si);
    var cur = curS.total;
    var cowR = b.isCowRule() ? D678.cowReach(b.scoreVals(si)) : null;
    var n = b.countCards(si, false);
    for (var i = 0; i < U.length; i++) {
        var dv = b.scoreDelta(U[i], false);          // 抽到的是明牌
        var t = cur + dv;
        if (b.isBustVal(t)) continue;
        var rc = cowR ? D678.cowReachAdd(cowR, dv) : null;
        var s = this.scoreFromTotal(b, si, t, n + 1, rc);
        if (D678.cmpScore(s, curS) > 0) return true;
    }
    return false;
};

// 是否处在“绝不该要牌”的局面：已经爆牌、且没有任何一张未见牌能救回来。
// 此时抽与不抽对胜负分毫不差（爆牌就是爆牌，不会再多扣血），
// 期望值因此完全相等，noise 会随机把天平推向要牌 —— 玩家看到的就是
// 「爆到 23 了还在抽，一路抽到 30」。结果虽不变，但既难看又白耗牌库，
// 把牌堆里对手或自己可能需要的牌冲掉，所以显式禁掉。
D678.AI.neverHit = function (b, si) {
    // 规则暗牌下抽明牌对成绩分毫不差（scoreDelta 为 0），却会把明牌合计
    // 推向 21（抽不动）、还白耗牌库。期望值上两条路完全相等，noise 会随机
    // 选到抽牌 —— 就是上面那段注释描述的难看行为，这里显式禁掉。
    // （手里有「抽暗牌」时那是功能牌路径，不受这条约束。）
    if (b.isHiddenRule()) return true;
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
    // 牛牛没有爆牌，bustRate 恒为 0，这条下限会退化成「只要有一张牌能改善就必抽」，
    // 把期望值判断整个短路掉。可抽牌在牛牛下是实打实的赌博
    // （9 点抽到 5 就掉成 4 点），必须交给期望值精算，所以这里让路。
    if (b.isCowRule()) return false;
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
    // 规则标准21 已经是默认规则：当前没有规则（或已经是标准21）时用这张
    // 等于白扔，闸门直接拦下。只有现有规则对自己不利时才该出。
    if (id === 'rulenull' && (!b.rule || b.rule === 'rulenull')) return false;
    var save = b.rule;
    b.rule = id;
    var t     = b.total(si);
    var bust  = b.isBustVal(t);
    var isMax = b.isMaxVal(t);
    var dist  = b.distVal(t);
    // 【改判定的五张过不了「离目标多远」这道闸门】它们没有「目标点数」这回事，
    // 或者那个距离量对它们没有意义：
    //   · 牛牛      -> 该问的是「改完之后我的牛几点」
    //   · 比多      -> 该问的是「我的张数是不是不比对手少」
    //   · 规则暗牌  -> 该问的是「我的暗牌是不是比对手的强」
    //                 （双方通常各只有 1 张暗牌，离 21 点都远得很，
    //                   按原闸门算 dist 恒大于 RULE_NEAR，这张牌永远出不去）
    //   · 规则比少  -> 爆牌线是反的（低于 21 判负），原闸门那句
    //                 `!bust && dist <= RULE_NEAR` 在没到 21 时恒为假，
    //                 这张牌会永远出不去
    //   · 规则明牌  -> 有目标点数（仍是 21），原闸门算得出来也不算错，
    //                 但这条规则下双方的成绩**全是公开信息**（暗牌不计分），
    //                 cmpScore 是精确的、严格比距离代理量更准：
    //                 我 20 点、对手正好 21 点时距离闸门会放行一手必输的牌。
    // 所以这五张换成「改完之后我相对对手是不是真的更好」——
    // 直接拿 cmpScore 比双方成绩，比任何距离代理量都准。
    if (b.isCowRule() || b.isMoreRule() || b.isHiddenRule() ||
        b.isLessRule() || b.isUpRule()) {
        // 【规则暗牌要按重掷之后的底牌判，不能按现在这张】出这张牌会把自己的
        // 底牌换成随机一张，所以拿当前底牌算出来的成绩，正是这一手会亲手作废的
        // 前提 —— 不换的话 AI 会因为「我现在底牌 10」而出牌，而出完那张 10 就没了。
        // 换成「候选的平均值」当代理：闸门只要挡住「换完平均还不如对手」就够，
        // 真正的取舍在 simFunc 那边按候选逐一取期望。
        var hole = null, holeSave = 0;
        if (b.isHiddenRule() && id === 'rulenoseencard') {
            hole = b.firstHole(si);
            if (hole && b.deck.length > 0) {
                var pool = b.sides[si].p.isGod ? b.deck : D678.AI.unseen(b, si);
                if (pool.length) {
                    var sum = 0;
                    for (var pi = 0; pi < pool.length; pi++) sum += pool[pi];
                    holeSave = hole.v;
                    hole.v = Math.round(sum / pool.length);
                } else {
                    hole = null;
                }
            } else {
                hole = null;
            }
        }
        var mine = b.scoreOf(si), theirs = b.scoreOf(1 - si);
        var better = D678.cmpScore(mine, theirs) > 0;
        if (hole) hole.v = holeSave;
        // 对手的暗牌我方看不见，scoreOf 会把它按面值算进去 ——
        // 这是乐观估计，但双方同样口径，作为闸门够用（真正的取舍在 simFunc 的期望值里）。
        b.rule = save;
        return better;
    }
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

// 二选一：两张候选里挑哪张（返回 0 或 1）。
// 【用完整估值挑，不用「离目标多近」这种代理量】牛牛下更近不等于更好
// （9 点抽到 5 会掉成牛4），比多下张数比点数重要 —— 只有 bestValue
// 是跨全部规则都对的口径。深度给 2 就够：这一步之后的分歧很快收敛，
// 而 AI.step 是实时调用的，深度再大会拖慢出牌节奏。
D678.AI.pick2Choose = function (b, si, vals) {
    var v0 = this.pick2Val(b, si, vals[0], 2);
    var v1 = this.pick2Val(b, si, vals[1], 2);
    return (v1 > v0) ? 1 : 0;
};

// 二选一：拿到点数 v 那一张之后的局面价值。
// 抽的是明牌、拿完结束回合，所以跟普通抽牌同一条路子。
D678.AI.pick2Val = function (b, si, v, depth) {
    var c = b.clone();
    this.simAdd(c, si, v, false);
    c.sides[si].stood = false;
    c.standStreak = 0;
    return this.bestValue(c, si, Math.max(0, depth - 1));
};

// 模拟使用一张功能牌，返回 {value, ok}
D678.AI.simFunc = function (b, si, id, depth) {
    var f = D678.funcData(id);
    var god = !!b.sides[si].p.isGod;
    // 超哥的估值单位是“胜负”（±1），不是 HP，所以情报/功能牌折价要换算
    var fv = god ? this.GOD_FUNC_VAL : this.FUNC_VAL;
    // 【拿牌闸门要在这里也判一次】下面 pick / pickback / picksmall / num / copy
    // 这几条分支各自调 simAdd 推演，根本不经过 useFunc，所以光靠 useFunc 拦
    // 只能保证「AI 出了也失败」——它仍然会把这张牌估成有价值、白扔一个回合
    // （AI.step 里 useFunc 失败会被迫改成过牌）。这里直接不给它当候选。
    if (b.cardGainBlockedReason(si, id)) return null;
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
            // 知道下一张是什么，抽暗牌的结果是确定的
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
    } else if (f.kind === 'pick2') {
        if (b.deck.length === 0) return null;
        // 牌库只剩 1 张 -> 退化成普通抽牌，结果是确定的
        if (b.deck.length === 1) {
            var c1 = b.clone();
            this.simAdd(c1, si, b.deck[0], false);
            c1.sides[si].stood = false;
            c1.standStreak = 0;
            val = this.bestValue(c1, si, Math.max(0, depth - 1));
        } else {
            var Up2 = this.unseen(b, si);
            if (!Up2.length) return null;
            if (this.knowsTop(b, si, 2)) {
                // 知道牌库顶两张是什么 -> 直接挑更好的那张，没有不确定性
                var ka = b.deck[0], kb = b.deck[1];
                val = Math.max(this.pick2Val(b, si, ka, depth),
                               this.pick2Val(b, si, kb, depth));
            } else {
                // 【只算每张单独的价值，不枚举牌对】二选一的收益是
                // max(v(a), v(b))，而 v 只取决于那一张牌 —— 所以先把每张的
                // 价值各算一次（|U| 次 bestValue，跟抽暗牌同一个量级），
                // 再对所有牌对取 max 求平均，只是 O(|U|²) 次比大小。
                // 直接枚举牌对要 |U|² 次 bestValue，深度一上来就卡。
                var vs = [];
                for (var q2 = 0; q2 < Up2.length; q2++) {
                    vs.push(this.pick2Val(b, si, Up2[q2], depth));
                }
                var sum2 = 0, cnt2 = 0;
                for (var x2 = 0; x2 < vs.length; x2++) {
                    for (var y2 = x2 + 1; y2 < vs.length; y2++) {
                        sum2 += Math.max(vs[x2], vs[y2]);
                        cnt2++;
                    }
                }
                if (!cnt2) return null;
                // 附加值：没选的那张进了牌库底，等于知道了牌库最后一张是什么
                val = sum2 / cnt2 + (god ? 0.02 : 0.5);
            }
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
        var oldV = rpc.v;
        // 先把这张明牌拿掉，再看重抽的结果。
        // 在克隆盘面上用 newestUp 重新定位，避免场上有同值牌时错删。
        var cr = b.clone();
        cr.sides[si].cards.splice(cr.sides[si].cards.indexOf(cr.newestUp(si)), 1);
        // 【刚洗回去那张这次抽不到】useFunc 是先抽再洗回去，所以推演里
        // 那张旧牌不进候选。牌库空是唯一的例外（必定抽回同一张）。
        var rpEmpty = (b.deck.length === 0);
        if (rpEmpty) {
            var cE = cr.clone();
            this.simAdd(cE, si, oldV, false);
            val = this.bestValue(cE, si, Math.max(0, depth - 1));
        } else if (god) {
            // 超哥知道牌库顺序，抽的必定是牌库顶那张 —— 没有随机性。
            // （旧牌是抽完之后才洗回去的，影响不到这一抽。）
            var cB = cr.clone();
            this.simAdd(cB, si, b.deck[0], false);
            val = this.bestValue(cB, si, Math.max(0, depth - 1));
        } else {
            // 其他人眼里重抽的结果是「未见牌里除掉刚洗回去那张」的随机一张。
            // cr 里那张牌已经离场，unseen 会把它算成未见 —— 手工摘掉。
            var Ur = this.unseen(cr, si);
            D678.remove(Ur, oldV);
            if (!Ur.length) return null;
            var sr = 0;
            for (var ri = 0; ri < Ur.length; ri++) {
                var cc2 = cr.clone();
                this.simAdd(cc2, si, Ur[ri], false);
                sr += this.bestValue(cc2, si, Math.max(0, depth - 1));
            }
            val = sr / Ur.length;
        }
    } else if (f.kind === 'pickbig') {
        // 和 picksmall 对称：「牌库最大的那张」对不同情报水平的人是不同的量。
        // 超哥直接看得见牌库；其他人只知道未见牌集合（牌库 + 对方暗牌），
        // 所以要枚举「哪几张在对方手里」，每种情况下的牌库最大值取平均。
        if (b.deck.length === 0) return null;
        var pbT = b.newestUp(si);
        if (!pbT) return null;                       // 没明牌可退 -> 必定失效
        var Ub = this.unseen(b, si);
        if (!Ub.length) return null;
        // 退掉那张明牌的代价已经如实体现在盘面里（点数掉了），不另外扣分。
        var maxes = [];
        if (god) {
            var gx = b.deckMax();
            if (gx === null) return null;
            maxes.push(gx);
        } else {
            var kb = this.oppHiddenUnknown(b, si);
            if (kb <= 0) {
                maxes.push(Math.max.apply(null, Ub));
            } else {
                var cbb = this.combos(Ub, Math.min(kb, Ub.length), 120);
                for (var xi = 0; xi < cbb.length; xi++) {
                    var restB = Ub.filter(function (v) { return cbb[xi].indexOf(v) < 0; });
                    if (restB.length) maxes.push(Math.max.apply(null, restB));
                }
                if (!maxes.length) maxes.push(Math.max.apply(null, Ub));
            }
        }
        var sbig = 0, nbig = 0;
        for (var mj = 0; mj < maxes.length; mj++) {
            var cbg = b.clone();
            var tgt = cbg.newestUp(si);
            if (!tgt) continue;
            cbg.sides[si].cards.splice(cbg.sides[si].cards.indexOf(tgt), 1);
            if (!tgt.fake) cbg.deck.push(tgt.v);
            // simAdd 会从牌库里移掉这个值。退回去那张压在底部、不是最大值，
            // 所以这里的顺序和 useFunc 里一致。
            this.simAdd(cbg, si, maxes[mj], false);
            cbg.sides[si].stood = false;
            cbg.standStreak = 0;
            sbig += this.bestValue(cbg, si, Math.max(0, depth - 1));
            nbig++;
        }
        if (!nbig) return null;
        val = sbig / nbig;
    } else if (f.kind === 'num' || f.kind === 'copy') {
        // 两张都是「往自己场上加一张假牌」，结果完全确定（没有随机性），
        // 所以直接推演那一个盘面就行，不用像抽牌那样对未见牌取期望。
        var addV;
        if (f.kind === 'num') {
            addV = f.num;
        } else {
            var cpT = b.newestUp(si);
            if (!cpT) return null;                   // 没明牌可复制 -> 必定失效
            addV = cpT.v;
        }
        var cadd = b.clone();
        // 假牌：不占牌库里的任何一张，所以不能走 simAdd（那个会从牌库里移掉这个值）。
        cadd.sides[si].cards.push({ v: addV, hidden: false, uid: -1, fake: true });
        cadd.sides[si].stood = false;
        cadd.standStreak = 0;
        val = this.bestValue(cadd, si, Math.max(0, depth - 1));
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
    } else if (f.kind === 'repickback') {
        // 【要按期望估，不能只掷一次】它把自己的底牌换成随机一张，而底牌在
        // 默认规则下是计分的 —— 直接 useFunc 只采到一个样本，估值会随机漂移，
        // AI 有时把一手烂底牌估成好棋。照 reback / 规则暗牌那两处的路子
        // 枚举候选取平均。
        var rbkHole = b.firstHole(si);
        if (!rbkHole) return null;                    // 没底牌 -> 必定失效
        if (b.deck.length === 0) return null;         // 牌库空 -> 抽回同一张，白扔
        // 【规则明牌下这张是废牌】那条规则不算暗牌，换底牌对成绩毫无影响 ——
        // 早退一步，既不让 AI 白扔牌，也省掉下面整轮枚举。
        if (b.isUpRule()) return null;
        var rbkCand = god ? b.deck.slice(0) : this.unseen(b, si);
        if (!rbkCand.length) return null;
        // 【候选上界 5，比 reback / 规则暗牌那两处的 8 小】这三处都是
        // 「枚举底牌候选 × bestValue」，单张估值就要 6ms 左右 —— 是全部
        // 功能牌里最贵的一档。原来跟着写 8，实测让 AI 每次决策的耗时接近翻倍
        // （手上有几张新牌时 6.6ms -> 11.8ms），天梯那种一局要打几十轮的
        // 场合会累积到用例的时间预算之外（server/_test_ladhistory.js 的
        // ladPlay 给一局 120 秒）。
        //
        // 砍到 5 的代价很小：这本来就是个近似 —— slice 取的是前几个候选，
        // 连均匀抽样都不是，多枚举几个并不换来成比例的准确度。
        var rbkCap = 5;
        if (rbkCand.length > rbkCap) rbkCand = rbkCand.slice(0, rbkCap);
        var srb = 0, nrb = 0;
        for (var rbi = 0; rbi < rbkCand.length; rbi++) {
            var crb = b.clone();
            var hrb = crb.firstHole(si);
            if (!hrb) continue;
            var oldRB = hrb.v;
            hrb.v = rbkCand[rbi];
            D678.remove(crb.deck, rbkCand[rbi]);
            crb.deck.push(oldRB);
            // 换的是**自己**的底牌：对手对我方底牌的推理作废，
            // 而我方对对手底牌的推理（side.known）不受影响 ——
            // 方向和 reback 正好相反，见 rerollOwnHole 的注释。
            D678.remove(crb.sides[1 - si].known, oldRB);
            crb.sides[si].stood = false;
            crb.standStreak = 0;
            srb += this.bestValue(crb, si, depth);
            nrb++;
        }
        if (!nrb) return null;
        val = srb / nrb - fv;
    } else if (f.kind === 'copyback') {
        // 复制自己的底牌，以暗牌形式追加。结果完全确定（没有随机性），
        // 所以直接推演那一个盘面 —— 和 num / copy 同一个路子。
        var cbH = b.firstHole(si);
        if (!cbH) return null;                        // 没底牌 -> 必定失效
        // 【规则明牌下这张是废牌】造出来的是**暗**牌，而那条规则不算暗牌，
        // 白扔一张牌还白扔一个回合（这张消耗回合）。
        if (b.isUpRule()) return null;
        var ccb = b.clone();
        // 假牌不占牌库里的任何一张，所以不走 simAdd（那个会从牌库移掉这个值）。
        // hidden:true 是关键 —— 它不进 upTotal，所以不推那道要牌闸门。
        ccb.sides[si].cards.push({ v: cbH.v, hidden: true, uid: -1, fake: true });
        ccb.sides[si].stood = false;
        ccb.standStreak = 0;
        val = this.bestValue(ccb, si, Math.max(0, depth - 1));
    } else if (id === 'rulenoseencard' && b.firstHole(si) && b.deck.length > 0) {
        // 【这张要按期望估，不能只掷一次】它会把出牌方自己的底牌换成随机一张，
        // 而这条规则下底牌就是成绩本身 —— 直接 useFunc 只能采到一个样本，
        // 估值会随机漂移，AI 有时把一手烂底牌估成好棋。
        // 所以照 reback 的路子枚举候选取平均。
        if (!this.ruleTimingOK(b, si, id)) return null;
        var hcand = god ? b.deck.slice(0) : this.unseen(b, si);
        if (!hcand.length) return null;
        if (hcand.length > 8) hcand = hcand.slice(0, 8);
        var sh = 0;
        for (var hi = 0; hi < hcand.length; hi++) {
            var ch = b.clone();
            var hh = ch.firstHole(si);
            if (!hh) continue;
            var oldHV = hh.v;
            ch.rule = id;
            hh.v = hcand[hi];
            D678.remove(ch.deck, hcand[hi]);
            ch.deck.push(oldHV);
            // 对手对我方底牌的推理作废（useFunc 里 rerollOwnHole 做的是同一件事）
            D678.remove(ch.sides[1 - si].known, oldHV);
            sh += this.bestValue(ch, si, depth);
        }
        val = sh / hcand.length - fv;
    } else {
        // 规则牌先过时机闸门：离新目标太远就不出，把牌留到够得着的时候
        if (f.kind === 'rule' && !this.ruleTimingOK(b, si, id)) return null;
        var r = c.useFunc(si, id, true);
        if (!r.ok) return null;
        // 【必定失效的牌不当候选】useFunc 现在对大部分不合规的出牌返回
        // ok=true, fail=true（照样消耗、没有效果）—— 那是给**玩家**的口径，
        // AI 跟着学就是白扔手牌。所以这里把 fail 挡掉，等价于改造之前
        // 「useFunc 拒绝 -> 返回 null」的效果。
        //
        // 抽号牌那张不受影响：它有自己的分支，在那里按成功率算期望
        //（撞牌失败是有情报收益的，不是纯亏）。
        if (r.fail) return null;
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
        // 【AI 的二选一是瞬间的】它不看倒计时，当场挑更好的那张。
        // 不在这里选完的话盘面会停在待选状态上，回合永远不结束。
        if (r.pending2) {
            var pk = this.pick2Choose(b, si, r.pending2);
            var pr = b.pick2Resolve(si, pk);
            return { side: si, action: 'func', id: d.id, msg: r.msg,
                     kind: r.kind, endTurn: true,
                     pick2: { value: pr ? pr.value : null,
                              other: pr ? pr.other : null } };
        }
        // kind / oldValue 透出来给界面用：重抽要播「旧牌飞回牌库 + 新牌入场」
        // 那套完整动画，收牌那一半需要知道洗回去的是哪个数字
        // （见 678.js 的 redealCard）。same 留着，别的地方还在读。
        //
        // 【ok / value 也要带】D678.holeSwapSideOf 读这两个字段判断
        // 「这一手换了谁的底牌」（规则暗牌只在真的重掷了才有 value）。
        // 少带一个的话对方用重抽底牌 / 干扰 / 规则暗牌时不播换牌动画 ——
        // 而那种漏法看着就像「对方用了牌但什么也没发生」。
        return { side: si, action: 'func', id: d.id, msg: r.msg, fail: !!r.fail,
                 ok: !!r.ok, value: r.value,
                 endTurn: !!r.endTurn, same: !!r.same,
                 kind: r.kind, oldValue: r.oldValue };
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

// 造一张牌。uid 是**稳定身份**，整局唯一、只增不减。
//
// 【为什么需要】客户端的 refreshCards 靠 cardKey 判断「这张牌还是原来那张吗」，
// key 一样就复用旧精灵（原地不动），不一样就新建精灵、从画面中央飞过来
// （发牌入场动画）。key 原来用**数组下标**，于是「删掉中间那张牌」会让后面
// 所有牌的下标往前挪、key 全变 —— 它们被当成新牌一起重新入场。
//
// 实际症状：用过「抽暗牌」之后再「重抽」，暗牌和新抽的明牌**一起**重新入场。
// 抽暗牌把一张暗牌 push 到了末尾，于是明牌在中间，repick 删的就是中间那张。
// rob / return 删的也是 newestUp，同样可能是中间那张。
//
// 用 uid 代替下标之后，删谁都不影响别人的身份。
//
// 【fake / face 两个可选字段】
//   fake: 这张牌不是从牌库来的（+1 / -1 / copy 造出来的）。它**永远不能回牌库** ——
//         牌库是「1~11 各一张」，塞一张假的进去会让 pick 抽到重复数字、
//         AI 的未见牌推算全盘错位。所以 return / repick 碰到假牌一律让它消失。
//   face: 卡图名，缺省时用 String(v)。+1/-1 有自己的卡图（v=1 的假牌不该显示成
//         「1」号牌），copy 的复制品没有专属图，靠 D678.FAKE_TONE 染色区分。
//
// 只在为真时才写进对象，让普通牌保持原来的形状 —— 联机的线格式按字段发，
// 多两个恒为 undefined 的字段是白付带宽。
D678._cardUid = 0;
D678.mkCard = function (v, hidden, fake, face) {
    var c = { v: v, hidden: !!hidden, uid: ++D678._cardUid };
    if (fake) c.fake = true;
    if (face) c.face = face;
    return c;
};

// 记一场对手战绩。me 对 op 赢了没有 -> me.vsLog[op.id] 累加。
// 名字一起存下来 —— 淘汰页只拿到这一份数据，没有 players 数组可查名字。
D678.noteVs = function (me, op, won) {
    if (!me || !op) return;
    if (!me.vsLog) me.vsLog = {};
    var e = me.vsLog[op.id];
    if (!e) { e = me.vsLog[op.id] = { name: op.name, wins: 0, losses: 0 }; }
    e.name = op.name;               // 改过名的话跟着更新
    if (won) e.wins++; else e.losses++;
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
    // copy 排在 pick 之下、picksmall 之上：它拿到的点数是确定的（自己看得见），
    // 但只能复制场上已有的数字，不像指定抽牌那样想要几点就几点。
    // pickbig 要垫一张明牌进去才能抽，净收益不如无代价的 picksmall。
    // num（+1/-1）只挪动 1 点，适用面最窄，排在最后 —— 但仍高于 check，
    // 因为它至少是确定的 1 点，而查看牌库对已经定型的局面毫无用处。
    var order = { pick: 3, rob: 2.6, pickback: 2.4, rule: 2.3, swap: 2.2,
                  copy: 2.15, picksmall: 2.1, pickbig: 1.9, reback: 1.8,
                  repick: 1.6, 'return': 1.4, num: 1.3, check: 1.2 };
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
