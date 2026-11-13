// 城邦演武（改造前基线）—— 规则数据
// 据点争夺类即时战略：三方势力、城镇/法塔/城堡、
// 附属建筑（金矿/方尖碑/农场）、摧毁后进驻重建、法术与敕令。
// 数值、地图与美术均为原创。
(function (root) {
  "use strict";
  const CS = root.CS || (root.CS = {});

  CS.TILE = 20; // 一屏看全的小地图：格子缩小，小人和城在屏幕上就显得大
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
    wild: {
      name: "荒野", short: "荒野",
      color: "#8c7a5a", dark: "#4f4431", light: "#d6c7a5",
      spells: [],
    },
  };

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
      armor: "mounted", dmgType: "cleave", gold: 80, train: 7, aggro: 110, charge: 2.6, key: "E",
      tip: "冲锋第一击 ×2.6。专杀弓手和投石车，撞上步兵阵会吃亏。",
    },
    siege: {
      name: "投石车", size: 2, hp: 95, dmg: 42, cd: 4.2, range: 165, minRange: 34, speed: 18,
      armor: "machine", dmgType: "siege", gold: 105, train: 9, aggro: 180, proj: "stone", splash: 24, key: "R",
      tip: "射程最远，砸城墙 ×3.2。打人很差，要有人护着。",
    },
    mage: {
      name: "法师", size: 3, hp: 37, dmg: 14.5, cd: 2.0, range: 92, speed: 29,
      armor: "light", dmgType: "magic", gold: 90, train: 7, aggro: 125, proj: "bolt", splash: 14, key: "T",
      tip: "魔法溅射，无视护甲。只能在法塔训练。",
    },
    ogre: {
      name: "食人魔", size: 1, hp: 520, dmg: 30, cd: 2.0, range: 15, speed: 26,
      armor: "beast", dmgType: "normal", gold: 0, train: 0, aggro: 120, splash: 18,
    },
    avatar: {
      name: "圣使", size: 1, hp: 700, dmg: 26, cd: 1.0, range: 16, speed: 46,
      armor: "beast", dmgType: "magic", gold: 0, train: 0, aggro: 140, splash: 26, summon: true,
    },
    worm: {
      name: "石虫", size: 1, hp: 300, dmg: 22, cd: 1.2, range: 14, speed: 42,
      armor: "beast", dmgType: "cleave", gold: 0, train: 0, aggro: 140, splash: 14, summon: true,
    },
  };
  CS.RECRUITABLE = ["foot", "archer", "cav", "siege", "mage"];

  // 各势力的兵种特色（乘法修正）
  CS.FACTION_UNIT = {
    duchy: {
      foot: { name: "盾卫", resist: { pierce: 0.7 } },
      archer: { name: "长弓手", range: 1.08 },
      cav: { name: "圣殿骑士", hp: 1.1 },
      siege: { name: "配重投石机" },
      mage: { name: "牧师", healAura: 2.2 },
    },
    horde: {
      foot: { name: "狂战士", dmg: 1.3, hp: 0.9 },
      archer: { name: "猎手", cd: 0.9 },
      cav: { name: "狼骑", speed: 1.15 },
      siege: { name: "破城锤车", dmg: 1.15, range: 0.85 },
      mage: { name: "火萨满", splash: 1.6 },
    },
    cult: {
      foot: { name: "冰卫", hp: 0.85, gold: 0.8 },
      archer: { name: "冰弩手", slowHit: 0.35 },
      cav: { name: "雪狼骑", speed: 1.05, slowHit: 0.25 },
      siege: { name: "冰锥投掷器" },
      mage: { name: "冰巫", slowHit: 0.5, dmg: 1.1 },
    },
    wild: {},
  };

  CS.TIER = [
    { name: "", hp: 1, dmg: 1 },
    { name: "老兵", hp: 1.3, dmg: 1.25 },
    { name: "精锐", hp: 1.65, dmg: 1.5 },
  ];

  // ---- 据点 ----
  CS.STRUCTS = {
    town: {
      name: "城镇", hp: 650, gold: 1.25, mana: 0, supply: 3, radius: 30,
      recruit: ["foot", "archer"], upgrade: [150, 300], shot: 5,
    },
    tower: {
      name: "法塔", hp: 520, gold: 0.45, mana: 0.9, supply: 2, radius: 26,
      recruit: ["foot", "mage"], upgrade: [160, 320], shot: 7,
    },
    castle: {
      name: "城堡", hp: 1250, gold: 1.7, mana: 0.2, supply: 4, radius: 36,
      recruit: ["foot", "archer", "cav", "siege"], upgrade: [200, 400], shot: 6,
    },
  };
  CS.SLOT_OFFSETS = [[-54, 34], [0, 58], [54, 34]];
  CS.ADDONS = {
    mine: { name: "金矿", gold: 75, desc: "+0.85 金/秒", income: { gold: 0.85 } },
    obelisk: { name: "方尖碑", gold: 75, desc: "+0.55 法力/秒", income: { mana: 0.55 } },
    farm: { name: "农场", gold: 60, desc: "+2 部队上限", supply: 2 },
  };
  CS.GARRISON_MAX = 4;
  CS.MANA_CAP = 150;
  CS.MANA_BASE = 0.8; // 每秒基础法力（原来几乎没有，法术常年放不出来）

  // ---- 法术 ----
  CS.SPELLS = {
    heal: { name: "圣疗旗", kind: "banner", mana: 25, cd: 12, radius: 90, dur: 12, power: 8, burst: 22, desc: "插下立刻回血 22，之后旗下友军每秒回血 8" },
    smite: { name: "天罚", kind: "strike", mana: 40, cd: 9, radius: 46, power: 110, stun: 0.8, fort: 260, desc: "神光砸下：重伤并击晕，对城墙伤害极高" },
    advent: { name: "圣使降临", kind: "summon", mana: 80, cd: 45, unit: "avatar", count: 1, dur: 40, needs: "tower", desc: "召唤圣使作战 40 秒（需控制法塔）" },
    lust: { name: "嗜血旗", kind: "banner", mana: 25, cd: 12, radius: 90, dur: 12, power: 1.6, haste: 1.3, desc: "旗下友军攻速 ×1.6、移速 ×1.3，攻城 ×1.6" },
    fire: { name: "烈焰雨", kind: "area", mana: 40, cd: 9, radius: 70, dur: 5, power: 18, desc: "火球雨持续轰炸一片区域" },
    worms: { name: "石虫破土", kind: "summon", mana: 80, cd: 45, unit: "worm", count: 3, dur: 40, needs: "tower", desc: "召唤三条石虫 40 秒（需控制法塔）" },
    frost: { name: "霜寒旗", kind: "banner", mana: 25, cd: 12, radius: 90, dur: 12, power: 0.5, vuln: 1.25, desc: "旗下敌军移速攻速减半，受到伤害 +25%" },
    freeze: { name: "冰封", kind: "strike", mana: 40, cd: 9, radius: 60, power: 35, stun: 4, fort: 40, desc: "范围冻结 4 秒" },
    blizzard: { name: "暴风雪", kind: "area", mana: 80, cd: 45, radius: 150, dur: 8, power: 16, slow: 0.5, needs: "tower", desc: "大范围冰暴（需控制法塔）" },
  };


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
})(typeof window !== "undefined" ? window : globalThis);
