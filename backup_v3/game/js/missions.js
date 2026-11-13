// 战役与地图布局（原创）。坐标为格子（40×25，每格 32px）。
(function (root) {
  "use strict";
  const CS = root.CS;

  // s: [类型, 列, 行, 归属, 等级]  归属: p 玩家 / a 敌一 / b 敌二 / - 废墟
  // o: 食人魔营地 [列, 行, 数量, 宝箱金币]
  CS.LAYOUTS = {
    first: {
      name: "边境初阵", seed: 11, forest: 0.1,
      s: [["town", 7, 12, "p", 0], ["town", 32, 12, "a", 0], ["town", 20, 19, "-", 0]],
      o: [[20, 5, 1, 160]],
    },
    twin: {
      name: "双城", seed: 23, forest: 0.13,
      s: [["castle", 6, 13, "p", 0], ["town", 31, 6, "a", 0], ["tower", 32, 19, "a", 0], ["town", 19, 12, "-", 0]],
      o: [[18, 21, 2, 220]],
    },
    river: {
      name: "河谷", seed: 37, forest: 0.12,
      river: { axis: "v", at: 20, width: 2, bridges: [5, 12, 20] },
      s: [["castle", 6, 12, "p", 0], ["town", 9, 20, "p", 0], ["castle", 33, 12, "a", 0], ["town", 31, 4, "a", 0], ["tower", 13, 4, "-", 0]],
      o: [[27, 21, 2, 240]],
    },
    triad: {
      name: "三方会战", seed: 41, forest: 0.12,
      s: [["castle", 6, 20, "p", 0], ["castle", 33, 20, "a", 0], ["castle", 20, 4, "b", 0],
        ["town", 20, 15, "-", 0], ["tower", 11, 9, "-", 0], ["tower", 29, 9, "-", 0]],
      o: [[5, 6, 2, 220], [35, 6, 2, 220]],
    },
    siege: {
      name: "围城", seed: 53, forest: 0.1,
      s: [["town", 6, 5, "p", 1], ["town", 6, 19, "p", 1], ["tower", 12, 12, "-", 0], ["town", 17, 21, "-", 0],
        ["castle", 31, 12, "a", 2], ["tower", 35, 4, "a", 0], ["tower", 35, 20, "a", 0]],
      o: [[20, 12, 2, 260]],
    },
    pass: {
      name: "山口", seed: 67, forest: 0.08,
      ridge: { axis: "v", at: 18, width: 2, gaps: [3, 12, 21] },
      s: [["castle", 6, 12, "p", 0], ["town", 11, 4, "-", 0], ["town", 26, 5, "a", 0], ["town", 26, 19, "a", 0], ["castle", 35, 12, "a", 1]],
      o: [[11, 20, 2, 240]],
    },
    lake: {
      name: "湖心", seed: 79, forest: 0.1,
      lake: { c: 20, r: 12, rx: 6, ry: 4 },
      s: [["castle", 5, 4, "p", 0], ["town", 12, 19, "-", 0], ["tower", 20, 3, "-", 0],
        ["castle", 34, 21, "a", 0], ["tower", 21, 21, "a", 0], ["town", 34, 4, "b", 0], ["town", 28, 12, "b", 0]],
      o: [[6, 13, 2, 260]],
    },
    throne: {
      name: "王座之前", seed: 83, forest: 0.11,
      s: [["castle", 5, 12, "p", 1], ["town", 10, 4, "p", 0], ["tower", 10, 20, "p", 0],
        ["castle", 34, 6, "a", 2], ["castle", 34, 18, "a", 2], ["tower", 26, 12, "a", 1], ["town", 19, 4, "-", 0], ["town", 19, 20, "-", 0]],
      o: [[19, 12, 3, 360]],
    },
    finale: {
      name: "统一之战", seed: 97, forest: 0.1,
      river: { axis: "h", at: 12, width: 2, bridges: [6, 20, 33] },
      s: [["castle", 4, 18, "p", 1], ["town", 10, 21, "p", 0], ["castle", 35, 5, "a", 2], ["town", 28, 3, "a", 1],
        ["castle", 35, 20, "b", 2], ["tower", 27, 21, "b", 1], ["castle", 19, 5, "-", 0], ["tower", 12, 6, "-", 0]],
      o: [[20, 18, 3, 360], [4, 4, 2, 260]],
    },
  };

  // 难度：AI 首次进攻时间、每波兵力、AI 收入倍率、出兵间隔
  CS.DIFF = [
    { army: 4, start: 95, wave: 2, income: 0.7, think: 1.7, gold: 100 },
    { army: 5, start: 80, wave: 3, income: 0.8, think: 1.5, gold: 130 },
    { army: 6, start: 70, wave: 3, income: 0.9, think: 1.4, gold: 160 },
    { army: 6, start: 60, wave: 3, income: 1.0, think: 1.25, gold: 190 },
    { army: 7, start: 52, wave: 4, income: 1.08, think: 1.15, gold: 220 },
    { army: 8, start: 45, wave: 4, income: 1.15, think: 1.05, gold: 250 },
  ];

  CS.CAMPAIGNS = {
    duchy: [
      { layout: "first", a: "horde", diff: 0, gold: 200, brief: "部落斥候越过了边境。夺下东边的城镇，顺手把南边那片废墟修起来。" },
      { layout: "twin", a: "horde", diff: 1, gold: 220, brief: "两座敌城一镇一塔。先修中间的废镇，多一份收入再打。" },
      { layout: "river", a: "cult", diff: 1, gold: 240, brief: "教团扼守河谷，桥只有三座。用投石车啃掉对面城堡。" },
      { layout: "triad", a: "horde", b: "cult", diff: 2, gold: 260, brief: "部落与教团在这里互相撕咬。等他们两败俱伤，再出手。" },
      { layout: "pass", a: "cult", diff: 3, gold: 260, brief: "山脊只有三道口子。守住口子，攒够兵再穿过去。" },
      { layout: "throne", a: "horde", diff: 4, gold: 300, brief: "部落王庭就在眼前，两座二级城堡。拿下王座。" },
    ],
    horde: [
      { layout: "first", a: "duchy", diff: 0, flip: true, gold: 200, brief: "公国的城镇软得像黄油。冲过去。" },
      { layout: "twin", a: "cult", diff: 1, flip: true, gold: 220, brief: "教团的法塔会冻住你的人。先砍法塔。" },
      { layout: "siege", a: "duchy", diff: 2, gold: 240, brief: "公国的二级城堡很硬。嗜血旗下的破城锤车能砸开它。" },
      { layout: "lake", a: "cult", b: "duchy", diff: 3, gold: 260, brief: "湖两岸都是敌人。别让他们联手。" },
      { layout: "pass", a: "duchy", diff: 3, flip: true, gold: 260, brief: "穿过山口，赶在公国援军之前。" },
      { layout: "finale", a: "duchy", b: "cult", diff: 5, gold: 320, brief: "最后一战。踏平两座首都。" },
    ],
    cult: [
      { layout: "first", a: "duchy", diff: 1, flip: true, gold: 200, brief: "冰谷的第一步。教团的人很脆，靠法术打。" },
      { layout: "river", a: "horde", diff: 2, flip: true, gold: 240, brief: "部落狼骑会从桥上冲过来。冰封桥口。" },
      { layout: "siege", a: "horde", diff: 2, flip: true, gold: 250, brief: "围攻部落的二级城堡。暴风雪需要一座法塔。" },
      { layout: "lake", a: "duchy", b: "horde", diff: 2, flip: true, gold: 260, brief: "湖心三方混战，抢先修好法塔。" },
      { layout: "throne", a: "duchy", diff: 4, flip: true, gold: 300, brief: "公国的王座。圣使会来，留好冰封。" },
      { layout: "finale", a: "horde", b: "duchy", diff: 4, flip: true, gold: 320, brief: "冰封整个大陆。" },
    ],
  };
  CS.CAMPAIGN_ORDER = ["duchy", "horde", "cult"];
  // 解锁：完成前一个战役第 2 关即开放下一个战役
  CS.UNLOCK_AT = 2;
  CS.PAR = [330, 480]; // 完美 / 优秀 的时间线（秒）

  CS.missionId = (faction, idx) => faction + "-" + (idx + 1);
})(typeof window !== "undefined" ? window : globalThis);
