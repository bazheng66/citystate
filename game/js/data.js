// 城邦演武 —— 规则数据
// 类型：据点争夺即时战略。三方起步、五个势力、城镇 / 法塔 / 城堡 / 村庄 / 要塞、
// 附属建筑、摧毁后进驻重建、法术、科技与敕令。数值、地图与规则均为原创。
(function (root) {
  "use strict";
  const CS = root.CS || (root.CS = {});

  CS.VERSION = "3.0";
  CS.TILE = 20;
  // 战役地图的默认尺寸；大陆征服的地图尺寸写在地图对象上（map.cols / map.rows / map.W / map.H）
  CS.COLS = 40;
  CS.ROWS = 25;
  CS.W = CS.TILE * CS.COLS; // 800
  CS.H = CS.TILE * CS.ROWS; // 500
  CS.MAPK = CS.TILE / 32; // 以前按 32px 格子写的“地图距离”乘这个系数
  CS.STEP = 1 / 30;

  // ---- 势力 ----
  CS.FACTIONS = {
    duchy: {
      name: "西境公国", short: "公国",
      color: "#3c7fe0", dark: "#1f4a96", light: "#9cc6ff",
      motto: "圣光与盾墙。治疗旗让部队越战越稳，天罚专砸城墙。",
      spells: ["heal", "smite", "advent"],
    },
    horde: {
      name: "赤血部落", short: "部落",
      color: "#d0402f", dark: "#7c1d14", light: "#ffab9c",
      motto: "快、狠、碎城。嗜血旗加攻速和攻城伤害，烈焰雨压制密集阵型。",
      spells: ["lust", "fire", "worms"],
    },
    cult: {
      name: "冰谷教团", short: "教团",
      color: "#33b5c4", dark: "#17616b", light: "#b5f1f7",
      motto: "身板脆，但能让敌人动不了。霜寒旗减速，冰封定身，暴风雪清场。",
      spells: ["frost", "freeze", "blizzard"],
    },
    sylvan: {
      name: "金叶林盟", short: "林盟",
      color: "#e0a92a", dark: "#7a5a10", light: "#ffe7a0",
      motto: "游侠射得最远，鹿骑跑得最快。生机旗回血，荆棘把人钉在原地，飓风扫荡一片。",
      spells: ["bloom", "thorns", "gale"],
    },
    grave: {
      name: "枯骨王庭", short: "王庭",
      color: "#9a6bd6", dark: "#48296f", light: "#dcc4ff",
      motto: "便宜、耐打、越打越多。恐惧旗让敌人更脆，瘟疫慢慢磨，亡者军团从地里爬出来。",
      spells: ["dread", "plague", "legion"],
    },
    wild: {
      name: "独立城邦", short: "中立",
      color: "#8c7a5a", dark: "#4f4431", light: "#d6c7a5",
      spells: [],
    },
  };
  CS.PLAYABLE = ["duchy", "horde", "cult", "sylvan", "grave"];
  // 归属色板：大陆征服里同一势力可能出现多家，旗帜和脚环按归属上色
  CS.PALETTE = [
    { color: "#3c7fe0", dark: "#1f4a96", light: "#9cc6ff" },
    { color: "#d0402f", dark: "#7c1d14", light: "#ffab9c" },
    { color: "#33b5c4", dark: "#17616b", light: "#b5f1f7" },
    { color: "#e0a92a", dark: "#7a5a10", light: "#ffe7a0" },
    { color: "#9a6bd6", dark: "#48296f", light: "#dcc4ff" },
    { color: "#e867a8", dark: "#7c2452", light: "#ffc2e0" },
    { color: "#a3d936", dark: "#4c6a10", light: "#e2f7a8" },
    { color: "#e8e8f0", dark: "#70707c", light: "#ffffff" },
    { color: "#8c7a5a", dark: "#4f4431", light: "#d6c7a5" }, // 8 = 中立
  ];
  CS.FACTION_CI = { duchy: 0, horde: 1, cult: 2, sylvan: 3, grave: 4, wild: 8 };

  // ---- 伤害/护甲克制表 ----
  // 步兵(normal) > 骑兵；骑兵(cleave) > 弓手/投石；弓手(pierce) > 步兵；投石(siege) > 城；法师(magic) 通吃但贵
  CS.DMG = {
    normal: { light: 1.1, heavy: 1.0, mounted: 1.6, machine: 1.2, beast: 1.0, fort: 0.45 },
    pierce: { light: 1.1, heavy: 1.45, mounted: 0.55, machine: 0.35, beast: 0.8, fort: 0.12 },
    cleave: { light: 1.7, heavy: 0.6, mounted: 1.0, machine: 1.8, beast: 0.9, fort: 0.3 },
    siege: { light: 0.55, heavy: 0.6, mounted: 0.35, machine: 1.0, beast: 0.6, fort: 3.2 },
    magic: { light: 1.0, heavy: 1.0, mounted: 1.0, machine: 1.0, beast: 1.3, fort: 0.6 },
  };

  // ---- 兵种（每名士兵的数值） ----
  CS.UNITS = {
    foot: {
      name: "步兵", size: 6, hp: 56, dmg: 8, cd: 1.0, range: 9, speed: 32,
      armor: "heavy", dmgType: "normal", gold: 40, train: 4.5, aggro: 90, key: "Q",
      tip: "结阵近战，专克骑兵。怕弓手。",
    },
    archer: {
      name: "弓手", size: 5, hp: 29, dmg: 6, cd: 1.25, range: 96, speed: 32,
      armor: "light", dmgType: "pierce", gold: 55, train: 5, aggro: 125, proj: "arrow", key: "W",
      tip: "远程射击，克步兵。被骑兵冲到就完了。",
    },
    cav: {
      name: "骑兵", size: 4, hp: 78, dmg: 10, cd: 1.05, range: 11, speed: 58,
      armor: "mounted", dmgType: "cleave", gold: 80, train: 7, aggro: 110, charge: 2.6, key: "E", wide: true,
      tip: "冲锋第一击 ×2.6。专杀弓手和投石车，撞上步兵阵会吃亏。",
    },
    siege: {
      name: "投石车", size: 2, hp: 95, dmg: 42, cd: 4.2, range: 165, minRange: 34, speed: 18,
      armor: "machine", dmgType: "siege", gold: 105, train: 9, aggro: 180, proj: "stone", splash: 24, key: "R", wide: true,
      tip: "射程最远，砸城墙 ×3.2。打人很差，要有人护着。",
    },
    mage: {
      name: "法师", size: 3, hp: 37, dmg: 14.5, cd: 2.0, range: 92, speed: 29,
      armor: "light", dmgType: "magic", gold: 90, train: 7, aggro: 125, proj: "bolt", splash: 14, key: "T",
      tip: "魔法溅射，无视护甲。只能在法塔训练。",
    },
    guard: {
      name: "禁卫", size: 3, hp: 165, dmg: 17, cd: 1.35, range: 11, speed: 28,
      armor: "heavy", dmgType: "normal", gold: 125, train: 9, aggro: 95, splash: 13, key: "Y", req: 1, wide: true,
      tip: "三人一队的重甲精兵，每一击都溅射周围敌人。需要 1 级以上的城堡。",
    },
    ogre: {
      name: "食人魔", size: 1, hp: 520, dmg: 30, cd: 2.0, range: 15, speed: 26,
      armor: "beast", dmgType: "normal", gold: 0, train: 0, aggro: 120, splash: 18, big: true,
    },
    avatar: {
      name: "圣使", size: 1, hp: 700, dmg: 26, cd: 1.0, range: 16, speed: 46,
      armor: "beast", dmgType: "magic", gold: 0, train: 0, aggro: 140, splash: 26, summon: true, big: true,
    },
    worm: {
      name: "石虫", size: 1, hp: 300, dmg: 22, cd: 1.2, range: 14, speed: 42,
      armor: "beast", dmgType: "cleave", gold: 0, train: 0, aggro: 140, splash: 14, summon: true, big: true,
    },
    bone: {
      name: "骸骨兵", size: 8, hp: 46, dmg: 8, cd: 0.9, range: 9, speed: 38,
      armor: "light", dmgType: "normal", gold: 0, train: 0, aggro: 130, summon: true,
    },
  };
  CS.RECRUITABLE = ["foot", "archer", "cav", "siege", "mage", "guard"];

  // 各势力的兵种特色（乘法修正）
  CS.FACTION_UNIT = {
    duchy: {
      foot: { name: "盾卫", resist: { pierce: 0.7 } },
      archer: { name: "长弓手", range: 1.08 },
      cav: { name: "圣殿骑士", hp: 1.1 },
      siege: { name: "配重投石机" },
      mage: { name: "牧师", healAura: 2.2 },
      guard: { name: "皇家禁卫", resist: { pierce: 0.8 } },
    },
    horde: {
      foot: { name: "狂战士", dmg: 1.3, hp: 0.9 },
      archer: { name: "猎手", cd: 0.9 },
      cav: { name: "狼骑", speed: 1.15 },
      siege: { name: "破城锤车", dmg: 1.15, range: 0.85 },
      mage: { name: "火萨满", splash: 1.6 },
      guard: { name: "碎颅者", dmg: 1.2, hp: 0.92 },
    },
    cult: {
      foot: { name: "冰卫", hp: 0.85, gold: 0.8 },
      archer: { name: "冰弩手", slowHit: 0.35 },
      cav: { name: "雪狼骑", speed: 1.05, slowHit: 0.25 },
      siege: { name: "冰锥投掷器" },
      mage: { name: "冰巫", slowHit: 0.5, dmg: 1.1 },
      guard: { name: "寒铁卫", slowHit: 0.3 },
    },
    sylvan: {
      foot: { name: "林卫", speed: 1.08 },
      archer: { name: "游侠", range: 1.14, dmg: 1.08, gold: 1.1 },
      cav: { name: "鹿骑", speed: 1.12, hp: 0.94 },
      siege: { name: "藤弩炮", range: 1.06 },
      mage: { name: "德鲁伊", healAura: 1.6 },
      guard: { name: "橡木卫士", hp: 1.1, speed: 0.95 },
    },
    grave: {
      foot: { name: "尸卒", hp: 1.18, speed: 0.9, gold: 0.85 },
      archer: { name: "掷骨魔", cd: 0.95, gold: 0.9 },
      cav: { name: "梦魇骑", dmg: 1.1 },
      siege: { name: "骨炮" },
      mage: { name: "疫医", dmg: 1.12, slowHit: 0.2 },
      guard: { name: "憎恶", hp: 1.25, dmg: 0.95 },
    },
    wild: {
      foot: { name: "民兵", hp: 0.9 },
      archer: { name: "猎户" },
    },
  };

  CS.TIER = [
    { name: "", hp: 1, dmg: 1 },
    { name: "老兵", hp: 1.3, dmg: 1.25 },
    { name: "精锐", hp: 1.65, dmg: 1.5 },
  ];

  // ---- 据点 ----
  CS.STRUCTS = {
    town: {
      name: "城镇", hp: 650, gold: 1.25, mana: 0, supply: 3, radius: 30, half: 40,
      recruit: ["foot", "archer"], upgrade: [150, 300], shot: 5,
    },
    tower: {
      name: "法塔", hp: 520, gold: 0.45, mana: 0.9, supply: 2, radius: 26, half: 22,
      recruit: ["foot", "mage"], upgrade: [160, 320], shot: 7,
    },
    castle: {
      name: "城堡", hp: 1250, gold: 1.7, mana: 0.2, supply: 4, radius: 36, half: 50,
      recruit: ["foot", "archer", "cav", "siege", "guard"], upgrade: [200, 400], shot: 6,
    },
    village: {
      name: "村庄", hp: 380, gold: 0.9, mana: 0, supply: 2, radius: 24, half: 30,
      recruit: ["foot"], upgrade: [110, 220], shot: 3,
    },
    fort: {
      name: "要塞", hp: 1000, gold: 0.3, mana: 0, supply: 2, radius: 26, half: 26,
      recruit: ["foot", "archer"], upgrade: [170, 340], shot: 12, shotCd: 0.8, shotR: 150,
    },
  };
  CS.SLOT_OFFSETS = [[-54, 34], [0, 58], [54, 34]];
  CS.ADDONS = {
    mine: { name: "金矿", gold: 75, desc: "+0.85 金/秒", income: { gold: 0.85 } },
    obelisk: { name: "方尖碑", gold: 75, desc: "+0.55 法力/秒", income: { mana: 0.55 } },
    farm: { name: "农场", gold: 60, desc: "+2 部队上限", supply: 2 },
    watch: { name: "箭楼", gold: 90, desc: "城防火力 ×2，射程 +30", watch: true },
  };
  CS.GARRISON_MAX = 4;
  CS.MANA_CAP = 150;
  CS.MANA_BASE = 0.8; // 每秒基础法力

  // ---- 法术 ----
  // kind: banner 旗帜光环 / strike 一次性打击 / area 持续区域 / summon 召唤
  // fx（旗帜的作用）: heal 回血 / lust 加速 / frost 减速易伤
  CS.SPELLS = {
    heal: { name: "圣疗旗", kind: "banner", fx: "heal", mana: 25, cd: 12, radius: 90, dur: 12, power: 8, burst: 22, desc: "插下立刻回血 22，之后旗下友军每秒回血 8" },
    smite: { name: "天罚", kind: "strike", mana: 40, cd: 9, radius: 46, power: 110, stun: 0.8, fort: 260, desc: "神光砸下：重伤并击晕，对城墙伤害极高" },
    advent: { name: "圣使降临", kind: "summon", mana: 80, cd: 45, unit: "avatar", count: 1, dur: 40, needs: "tower", desc: "召唤圣使作战 40 秒（需控制法塔）" },
    lust: { name: "嗜血旗", kind: "banner", fx: "lust", mana: 25, cd: 12, radius: 90, dur: 12, power: 1.6, haste: 1.3, desc: "旗下友军攻速 ×1.6、移速 ×1.3，攻城 ×1.6" },
    fire: { name: "烈焰雨", kind: "area", mana: 40, cd: 9, radius: 70, dur: 5, power: 18, desc: "火球雨持续轰炸一片区域" },
    worms: { name: "石虫破土", kind: "summon", mana: 80, cd: 45, unit: "worm", count: 3, dur: 40, needs: "tower", desc: "召唤三条石虫 40 秒（需控制法塔）" },
    frost: { name: "霜寒旗", kind: "banner", fx: "frost", mana: 25, cd: 12, radius: 90, dur: 12, power: 0.5, vuln: 1.25, desc: "旗下敌军移速攻速减半，受到伤害 +25%" },
    freeze: { name: "冰封", kind: "strike", mana: 40, cd: 9, radius: 60, power: 35, stun: 4, fort: 40, desc: "范围冻结 4 秒" },
    blizzard: { name: "暴风雪", kind: "area", mana: 80, cd: 45, radius: 150, dur: 8, power: 16, slow: 0.5, needs: "tower", desc: "大范围冰暴（需控制法塔）" },
    bloom: { name: "生机旗", kind: "banner", fx: "heal", mana: 25, cd: 12, radius: 100, dur: 14, power: 6.5, burst: 14, desc: "范围更大、时间更长的回血旗：立刻回血 14，之后每秒 6.5" },
    thorns: { name: "荆棘缠绕", kind: "strike", mana: 40, cd: 10, radius: 70, power: 45, stun: 3, fort: 30, desc: "荆棘破土：范围伤害并缠住 3 秒" },
    gale: { name: "落叶飓风", kind: "area", mana: 80, cd: 45, radius: 130, dur: 8, power: 14, slow: 0.6, needs: "tower", desc: "大范围飓风，持续伤害并减速（需控制法塔）" },
    dread: { name: "恐惧旗", kind: "banner", fx: "frost", mana: 25, cd: 12, radius: 90, dur: 12, power: 0.7, vuln: 1.4, desc: "旗下敌军移速攻速 -30%，受到伤害 +40%" },
    plague: { name: "瘟疫", kind: "area", mana: 40, cd: 10, radius: 85, dur: 7, power: 13, desc: "一片毒雾，持续腐蚀范围内的敌人" },
    legion: { name: "亡者军团", kind: "summon", mana: 80, cd: 45, unit: "bone", count: 2, squad: 8, dur: 35, needs: "tower", desc: "召唤两队骸骨兵作战 35 秒（需控制法塔）" },
  };

  // ---- 科技（局内，花金币立刻生效，每项三级） ----
  CS.TECHS = [
    { id: "forge", name: "锻造", desc: "全部部队伤害 +8%/级", cost: [120, 220, 360] },
    { id: "plate", name: "甲胄", desc: "全部部队生命 +8%/级", cost: [120, 220, 360] },
    { id: "roads", name: "驿道", desc: "全部部队移速 +6%/级", cost: [90, 170, 280] },
    { id: "walls", name: "城防", desc: "据点耐久 +15%/级，城防火力 +20%/级", cost: [110, 200, 320] },
    { id: "tax", name: "税制", desc: "金币收入 +10%/级", cost: [140, 260, 420] },
  ];

  // ---- 敕令（局外成长） ----
  CS.EDICTS = [
    { id: "levy", name: "征兵令", max: 2, desc: "所有兵种价格 -10%/级" },
    { id: "armor", name: "铁甲令", max: 3, desc: "部队生命 +8%/级" },
    { id: "blade", name: "利刃令", max: 3, desc: "部队伤害 +7%/级" },
    { id: "lore", name: "法典", max: 2, desc: "法术威力 +20%/级" },
    { id: "haste", name: "咒速", max: 2, desc: "法术冷却 -15%/级" },
    { id: "treasury", name: "国库", max: 2, desc: "开局金币 +60/级" },
    { id: "granary", name: "屯田", max: 1, desc: "部队上限 +1" },
    { id: "masons", name: "工匠", max: 1, desc: "重建快 40%，附属建筑 -20%" },
    { id: "veterans", name: "老兵制", max: 1, desc: "开局己方据点直接 1 级" },
  ];
  CS.EDICT_COST = [1, 2, 3];

  CS.RATING = [
    { name: "完美", pts: 3, color: "#ffd96a" },
    { name: "优秀", pts: 2, color: "#d8e2ef" },
    { name: "完成", pts: 1, color: "#d49a63" },
  ];

  // ---- 地貌（影响地形配色、树木色调和天气） ----
  CS.BIOMES = {
    temperate: {
      name: "温带草原", grass: ["#5fa24a", "#69ad50", "#579647"], speck: ["#7cc060", "#4c8a40"],
      road: ["#5f8f48", "#dba56a", "#f0c48e"], sand: "#e3d08f", water: ["#4f9fd6", "#3f86c2", "#8fd0f2"],
      tint: null, forest: "rgba(40,90,40,0.35)", weather: ["none", "none", "rain"], sea: "#22507a",
    },
    autumn: {
      name: "秋日丘陵", grass: ["#9a9a48", "#a8a24e", "#8a8c42"], speck: ["#c0b060", "#7a7c3a"],
      road: ["#7d7a3c", "#c9955a", "#e2b47e"], sand: "#dcc48a", water: ["#4a8fbe", "#3b78a6", "#8cc4e2"],
      tint: "rgba(222,120,24,0.5)", forest: "rgba(110,70,20,0.35)", weather: ["leaves", "leaves", "rain"], sea: "#234a6a",
    },
    snow: {
      name: "北境雪原", grass: ["#dfe9ee", "#eaf1f5", "#d2dfe7"], speck: ["#ffffff", "#bccdd8"],
      road: ["#b8c6ce", "#a99f93", "#c9c0b4"], sand: "#c9d6dd", water: ["#6fa6c9", "#5a8fb5", "#b6dcf0"],
      tint: "rgba(236,246,255,0.62)", forest: "rgba(90,120,140,0.3)", weather: ["snow", "snow", "none"], sea: "#27486a",
    },
    desert: {
      name: "荒漠绿洲", grass: ["#d9bf7a", "#e3c985", "#cdb26c"], speck: ["#efd99a", "#b99c5c"],
      road: ["#c0a462", "#b58a52", "#cfa670"], sand: "#f0dc9c", water: ["#3aa0b8", "#2e88a0", "#8adbe8"],
      tint: "rgba(170,150,50,0.42)", forest: "rgba(120,100,40,0.3)", weather: ["dust", "none", "none"], sea: "#1f5a70",
    },
  };

  // ---- 大陆征服的地图规格 ----
  CS.MAP_SIZES = [
    { id: "s", name: "小（64×40）", cols: 64, rows: 40, foes: 2 },
    { id: "m", name: "中（96×60）", cols: 96, rows: 60, foes: 3 },
    { id: "l", name: "大（144×90）", cols: 144, rows: 90, foes: 5 },
    { id: "xl", name: "巨（200×125）", cols: 200, rows: 125, foes: 7 },
  ];
  CS.OWNER_IDS = ["p", "a", "b", "c", "d", "e", "f", "g"];
})(typeof window !== "undefined" ? window : globalThis);
