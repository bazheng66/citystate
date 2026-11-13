// 角色精灵：0x72 DungeonTileset II（CC0）里的角色 + 武器，马 / 狼 / 投石车用代码画。
// 每个兵种的每一帧预先合成，全部排进同一张图集画布（脚底中心为锚点），渲染时按 CS.UNIT_PX 缩放。
// 同一张图集 = 同一张纹理：几千个士兵的 drawImage 可以被浏览器合批，不用来回切纹理。
// 动画：run 0-3、idle 0-3、atk 0-1（举起 / 挥下）、hit、dead。
(function (root) {
  "use strict";
  const CS = root.CS;

  // 精灵像素 → 世界像素
  CS.UNIT_PX = 0.8;

  // ---- 0x72 图集坐标（摘自 tile_list_v1.7）----
  const F = {
    knight_m: { idle: [128, 100], run: [192, 100], hit: [256, 100], w: 16, h: 28 },
    knight_f: { idle: [128, 68], run: [192, 68], hit: [256, 68], w: 16, h: 28 },
    elf_m: { idle: [128, 36], run: [192, 36], hit: [256, 36], w: 16, h: 28 },
    wizzard_m: { idle: [128, 164], run: [192, 164], hit: [256, 164], w: 16, h: 28 },
    dwarf_m: { idle: [128, 292], run: [192, 292], hit: [256, 292], w: 16, h: 28 },
    lizard_m: { idle: [128, 228], run: [192, 228], hit: [256, 228], w: 16, h: 28 },
    lizard_f: { idle: [128, 196], run: [192, 196], hit: [256, 196], w: 16, h: 28 },
    orc_warrior: { idle: [368, 177], run: [432, 177], w: 16, h: 23 },
    masked_orc: { idle: [368, 153], run: [432, 153], w: 16, h: 23 },
    orc_shaman: { idle: [368, 201], run: [432, 201], w: 16, h: 23 },
    goblin: { idle: [368, 40], run: [432, 40], w: 16, h: 16 },
    skelet: { idle: [368, 88], run: [432, 88], w: 16, h: 16 },
    chort: { idle: [368, 273], run: [432, 273], w: 16, h: 23 },
    necromancer: { idle: [368, 225], run: [368, 225], w: 16, h: 23 },
    angel: { idle: [368, 304], run: [432, 304], w: 16, h: 16 },
    ogre: { idle: [16, 380], run: [144, 380], w: 32, h: 36 },
    big_demon: { idle: [16, 428], run: [144, 428], w: 32, h: 36 },
    swampy: { idle: [432, 112], run: [432, 112], w: 16, h: 16 },
    muddy: { idle: [368, 112], run: [368, 112], w: 16, h: 16 },
    elf_f: { idle: [128, 4], run: [192, 4], hit: [256, 4], w: 16, h: 28 },
    wizzard_f: { idle: [128, 132], run: [192, 132], hit: [256, 132], w: 16, h: 28 },
    dwarf_f: { idle: [128, 260], run: [192, 260], hit: [256, 260], w: 16, h: 28 },
    wogol: { idle: [368, 249], run: [432, 249], w: 16, h: 23 },
    zombie: { idle: [368, 136], run: [368, 136], w: 16, h: 16 },
    ice_zombie: { idle: [432, 136], run: [432, 136], w: 16, h: 16 },
    imp: { idle: [368, 64], run: [432, 64], w: 16, h: 16 },
    doc: { idle: [368, 345], run: [432, 345], w: 16, h: 23 },
    pumpkin_dude: { idle: [368, 321], run: [432, 321], w: 16, h: 23 },
    big_zombie: { idle: [16, 332], run: [144, 332], w: 32, h: 36 },
  };
  const WPN = {
    knight_sword: [339, 98, 10, 29], regular_sword: [323, 10, 10, 21], waraxe: [324, 168, 12, 23],
    spear: [309, 161, 6, 30], bow: [289, 195, 14, 26], bow_2: [305, 195, 14, 26],
    green_staff: [340, 129, 8, 30], red_staff: [324, 129, 8, 30], axe: [341, 74, 9, 21],
    mace: [339, 39, 10, 24], big_hammer: [291, 26, 10, 37], cleaver: [310, 108, 9, 19],
    hammer: [307, 39, 10, 24], double_axe: [288, 167, 16, 24], rusty_sword: [307, 10, 10, 21],
    lavish_sword: [307, 129, 10, 30], baton: [323, 41, 10, 22], saw_sword: [307, 70, 10, 25],
  };

  // ---- 兵种外观 ----
  // kind: melee / bow / staff / spear；mount: horse / wolf / snowwolf；engine: catapult
  const LOOK = {
    duchy: {
      foot: { ch: "knight_m", wpn: "knight_sword", kind: "melee", shield: true },
      archer: { ch: "elf_m", wpn: "bow", kind: "bow" },
      cav: { ch: "knight_f", wpn: "spear", kind: "spear", mount: "horse" },
      siege: { ch: "dwarf_m", engine: "catapult" },
      mage: { ch: "wizzard_m", wpn: "green_staff", kind: "staff" },
      avatar: { ch: "angel", wpn: "knight_sword", kind: "melee", scale: 2 },
      guard: { ch: "knight_m", wpn: "lavish_sword", kind: "melee", shield: true, scale: 1.3, wscale: 0.6 },
    },
    horde: {
      foot: { ch: "orc_warrior", wpn: "waraxe", kind: "melee", shield: true },
      archer: { ch: "masked_orc", wpn: "bow_2", kind: "bow" },
      cav: { ch: "goblin", wpn: "axe", kind: "melee", mount: "wolf" },
      siege: { ch: "orc_warrior", engine: "catapult" },
      mage: { ch: "orc_shaman", wpn: "red_staff", kind: "staff" },
      worm: { ch: "muddy", scale: 2 },
      guard: { ch: "orc_warrior", wpn: "double_axe", kind: "melee", scale: 1.35, wscale: 0.7 },
    },
    cult: {
      foot: { ch: "lizard_m", wpn: "spear", kind: "spear", shield: true },
      archer: { ch: "skelet", wpn: "bow", kind: "bow" },
      cav: { ch: "chort", wpn: "spear", kind: "spear", mount: "snowwolf" },
      siege: { ch: "lizard_f", engine: "catapult" },
      mage: { ch: "necromancer", wpn: "green_staff", kind: "staff" },
      guard: { ch: "lizard_m", wpn: "mace", kind: "melee", shield: true, scale: 1.3, wscale: 0.7 },
    },
    sylvan: {
      foot: { ch: "dwarf_f", wpn: "hammer", kind: "melee", shield: true },
      archer: { ch: "elf_f", wpn: "bow_2", kind: "bow" },
      cav: { ch: "elf_m", wpn: "spear", kind: "spear", mount: "stag" },
      siege: { ch: "dwarf_m", engine: "catapult" },
      mage: { ch: "wizzard_f", wpn: "green_staff", kind: "staff" },
      guard: { ch: "dwarf_m", wpn: "big_hammer", kind: "melee", scale: 1.3, wscale: 0.62 },
    },
    grave: {
      foot: { ch: "zombie", wpn: "rusty_sword", kind: "melee", shield: true },
      archer: { ch: "imp", wpn: "bow", kind: "bow" },
      cav: { ch: "wogol", wpn: "saw_sword", kind: "melee", mount: "nightmare" },
      siege: { ch: "ice_zombie", engine: "catapult" },
      mage: { ch: "doc", wpn: "red_staff", kind: "staff" },
      guard: { ch: "big_zombie" },
      bone: { ch: "skelet", wpn: "rusty_sword", kind: "melee" },
    },
    wild: {
      ogre: { ch: "ogre", wpn: "big_hammer", kind: "melee", wscale: 0.85 },
      foot: { ch: "pumpkin_dude", wpn: "baton", kind: "melee" },
      archer: { ch: "goblin", wpn: "bow_2", kind: "bow" },
    },
  };
  // 每个势力实际会出现的兵种（只合成用得到的帧）
  const BASE = ["foot", "archer", "cav", "siege", "mage", "guard"];
  const FTYPES = {
    duchy: BASE.concat("avatar"), horde: BASE.concat("worm"), cult: BASE, sylvan: BASE, grave: BASE.concat("bone"),
    wild: ["ogre", "foot", "archer"],
  };
  // 武器相对角色的缩放（原图武器比人还长）
  const WS = { melee: 0.68, spear: 0.62, bow: 0.62, staff: 0.72 };

  function lookOf(fac, type) {
    return (LOOK[fac] && LOOK[fac][type]) || LOOK.duchy[type] || LOOK.wild[type] || LOOK.horde[type] || LOOK.duchy.foot;
  }

  // 合成画布尺寸（精灵像素），锚点 = 脚底中心
  const CW = 56;
  const CH = 52;
  const AX = 28;
  const AY = 46;

  let SHEET = null;
  const atlas = new Map();

  function canvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    g.imageSmoothingEnabled = false;
    return c;
  }

  // 角色帧：anim = idle/run/hit，i = 0..3
  function charFrame(name, anim, i) {
    const f = F[name];
    const src = anim === "hit" ? (f.hit || f.idle) : f[anim] || f.idle;
    const step = anim === "hit" ? 0 : i * f.w;
    return [src[0] + step, src[1], f.w, f.h];
  }

  function drawChar(g, name, anim, i, cx, feetY, scale) {
    const [sx, sy, w, h] = charFrame(name, anim, i);
    const s = scale || 1;
    g.drawImage(SHEET, sx, sy, w, h, Math.round(cx - (w * s) / 2), Math.round(feetY - h * s), w * s, h * s);
  }

  // 武器：绕握把（图片底部中点）旋转
  function drawWeapon(g, key, hx, hy, ang, scale) {
    const [sx, sy, w, h] = WPN[key];
    const s = scale || 1;
    g.save();
    g.translate(hx, hy);
    g.rotate(ang);
    g.drawImage(SHEET, sx, sy, w, h, Math.round(-w * s / 2), Math.round(-h * s + 3 * s), w * s, h * s);
    g.restore();
  }

  function px(g, x, y, w, h, col) { g.fillStyle = col; g.fillRect(x, y, w, h); }

  // ---- 坐骑（像素风，4 帧跑动）----
  const MOUNT_COL = {
    horse: { body: "#e9e2d2", shade: "#b8ad98", mane: "#6b4a2e", hoof: "#3a2a20" },
    wolf: { body: "#7a6655", shade: "#54453a", mane: "#3c3029", hoof: "#2a201a" },
    snowwolf: { body: "#e4eef4", shade: "#a9bfcc", mane: "#7f97a6", hoof: "#4b5a64" },
    stag: { body: "#b9824e", shade: "#8a5c33", mane: "#efe2c4", hoof: "#3a2a20" },
    nightmare: { body: "#3b3350", shade: "#262036", mane: "#b64ad6", hoof: "#15121d" },
  };
  function drawMount(g, kind, cx, feetY, frame, moving, layer) {
    const C = MOUNT_COL[kind];
    const O = "#2b1d14";
    const wolf = kind === "wolf" || kind === "snowwolf";
    const by = feetY - (wolf ? 12 : 14); // 身体顶部
    const x0 = cx - 12;
    const legLen = wolf ? 4 : 6;
    const ly = by + (wolf ? 8 : 8);
    // 跑动：前后腿交替
    const sw = moving ? [[-2, 2], [0, 0], [2, -2], [0, 0]][frame % 4] : [0, 0];
    const lift = moving ? [0, 1, 0, 1][frame % 4] : 0;
    if (layer === "back") {
      px(g, x0 + 5 + sw[1], ly, 3, legLen, O);
      px(g, x0 + 6 + sw[1], ly, 1, legLen - 1, C.shade);
      px(g, x0 + 18 - sw[1], ly, 3, legLen, O);
      px(g, x0 + 19 - sw[1], ly, 1, legLen - 1, C.shade);
      return;
    }
    const b = by - lift;
    // 尾巴
    if (wolf) { px(g, x0 - 1, b + 1, 5, 3, O); px(g, x0, b + 2, 4, 1, C.mane); }
    else { px(g, x0 + 1, b + 1, 3, 8, O); px(g, x0 + 2, b + 2, 1, 6, C.mane); }
    // 身体（圆一点）
    px(g, x0 + 3, b, 18, 9, O);
    px(g, x0 + 2, b + 1, 20, 7, O);
    px(g, x0 + 4, b + 1, 16, 7, C.body);
    px(g, x0 + 3, b + 2, 18, 5, C.body);
    px(g, x0 + 4, b + 6, 16, 2, C.shade);
    if (wolf) {
      // 狼头：低而长，带尖耳
      px(g, x0 + 19, b - 3, 8, 7, O);
      px(g, x0 + 20, b - 2, 6, 5, C.body);
      px(g, x0 + 26, b + 0, 3, 3, O);
      px(g, x0 + 26, b + 1, 2, 1, C.shade);
      px(g, x0 + 20, b - 5, 2, 3, O);
      px(g, x0 + 23, b - 5, 2, 3, O);
      px(g, x0 + 23, b - 1, 1, 1, "#ffd96a");
      px(g, x0 + 18, b - 1, 2, 5, C.mane);
    } else {
      // 马脖子 + 马头
      px(g, x0 + 17, b - 6, 6, 9, O);
      px(g, x0 + 18, b - 5, 4, 8, C.body);
      px(g, x0 + 20, b - 9, 8, 5, O);
      px(g, x0 + 21, b - 8, 6, 3, C.body);
      px(g, x0 + 26, b - 6, 2, 2, C.shade);
      px(g, x0 + 20, b - 11, 2, 3, O);
      px(g, x0 + 23, b - 7, 1, 1, O);
      px(g, x0 + 17, b - 7, 2, 9, C.mane);
      // 马鞍布：势力色由骑手体现，这里画中性红布
      px(g, x0 + 8, b, 7, 4, "#8a2f24");
      px(g, x0 + 8, b + 3, 7, 1, "#5a1d16");
      if (kind === "stag") { // 鹿角
        px(g, x0 + 21, b - 14, 1, 5, C.mane); px(g, x0 + 25, b - 14, 1, 5, C.mane);
        px(g, x0 + 19, b - 13, 2, 1, C.mane); px(g, x0 + 26, b - 13, 2, 1, C.mane);
      } else if (kind === "nightmare") px(g, x0 + 23, b - 7, 2, 1, "#ff5ad6");
    }
    // 近侧腿
    px(g, x0 + 4 - sw[0], ly - lift, 3, legLen + lift, O);
    px(g, x0 + 5 - sw[0], ly - lift, 1, legLen + lift - 1, C.body);
    px(g, x0 + 17 + sw[0], ly - lift, 3, legLen + lift, O);
    px(g, x0 + 18 + sw[0], ly - lift, 1, legLen + lift - 1, C.body);
    px(g, x0 + 4 - sw[0], ly + legLen - 1, 3, 1, C.hoof);
    px(g, x0 + 17 + sw[0], ly + legLen - 1, 3, 1, C.hoof);
  }

  // ---- 投石车 ----
  function drawCatapult(g, cx, feetY, armAng, frame, moving) {
    const O = "#2b1d14";
    const W1 = "#a8743f";
    const W2 = "#7a4f28";
    const x0 = cx - 12;
    const y = feetY - 9;
    // 底座
    px(g, x0, y, 24, 5, O);
    px(g, x0 + 1, y + 1, 22, 3, W1);
    px(g, x0 + 1, y + 3, 22, 1, W2);
    // 轮子（跑动时转）
    for (const wx of [x0 + 4, x0 + 19]) {
      px(g, wx - 3, y + 3, 6, 6, O);
      px(g, wx - 2, y + 4, 4, 4, W2);
      const spoke = moving ? frame % 2 : 0;
      px(g, wx - (spoke ? 0 : 1), y + 5 + (spoke ? -1 : 0), spoke ? 1 : 2, spoke ? 3 : 1, "#d9b47a");
    }
    // 支架
    px(g, x0 + 9, y - 7, 2, 8, O);
    px(g, x0 + 13, y - 7, 2, 8, O);
    px(g, x0 + 10, y - 6, 4, 2, W2);
    // 投臂
    g.save();
    g.translate(x0 + 12, y - 6);
    g.rotate(armAng);
    px(g, -1, -16, 3, 17, O);
    px(g, 0, -15, 1, 15, W1);
    px(g, -3, -19, 7, 4, O);
    px(g, -2, -18, 5, 2, "#8d8a84");
    g.restore();
  }

  // ---- 合成一帧 ----
  function compose(fac, type, anim, i, face) {
    const L = lookOf(fac, type);
    const c = canvas(CW, CH);
    const g = c.getContext("2d");
    if (face < 0) { g.translate(CW, 0); g.scale(-1, 1); }
    const cx = AX;
    const feet = AY;
    const s = L.scale || 1;
    const moving = anim === "run";
    const bodyAnim = anim === "atk" ? "idle" : anim;
    const fi = anim === "atk" ? 0 : i;

    if (L.engine === "catapult") {
      // 操作手站在车后
      const arm = anim === "atk" ? (i === 0 ? -1.1 : 0.55) : -1.1;
      drawChar(g, L.ch, bodyAnim === "hit" ? "hit" : bodyAnim, fi, cx - 15, feet, 1);
      drawCatapult(g, cx + 4, feet, arm, i, moving);
      return c;
    }
    if (L.mount) {
      const by = feet - (L.mount === "horse" ? 9 : 8);
      drawMount(g, L.mount, cx, feet, i, moving, "back");
      // 骑手：只露上半身，下半身被坐骑挡住
      drawChar(g, L.ch, bodyAnim === "hit" ? "hit" : bodyAnim, fi, cx - 1, by, 1);
      drawMount(g, L.mount, cx, feet, i, moving, "front");
      if (L.wpn) {
        const f = F[L.ch];
        const hy = by - Math.round(f.h * 0.35);
        const ang = anim === "atk" ? (i === 0 ? 0.2 : 1.45) : 1.2;
        drawWeapon(g, L.wpn, cx + 3 + (anim === "atk" && i === 1 ? 4 : 0), hy, ang, L.wscale || WS[L.kind] || 0.7);
      }
      return c;
    }

    // 步行单位
    const f = F[L.ch];
    drawChar(g, L.ch, bodyAnim, fi, cx, feet, s);
    if (L.wpn) {
      const hx = cx + 4 * s;
      const hy = feet - Math.round(f.h * s * 0.32);
      let ang = 0.5;
      let dx = 0;
      if (L.kind === "melee") ang = anim === "atk" ? (i === 0 ? -1.2 : 1.9) : 0.55;
      else if (L.kind === "spear") { ang = anim === "atk" ? 1.57 : 0.9; dx = anim === "atk" && i === 1 ? 5 : 0; }
      else if (L.kind === "bow") ang = 0;
      else if (L.kind === "staff") ang = anim === "atk" ? (i === 0 ? -0.4 : 0.6) : 0.15;
      if (moving && L.kind !== "bow") ang += [0, 0.08, 0, -0.08][i % 4];
      drawWeapon(g, L.wpn, hx + dx, hy, ang, s * (L.wscale || WS[L.kind] || 0.7));
      if (L.kind === "bow" && anim === "atk") {
        // 搭箭
        px(g, hx - 4, hy - 6, 9, 1, "#f2ead6");
        px(g, hx + 4, hy - 7, 2, 3, "#cfd5dc");
      }
      if (L.kind === "staff" && anim === "atk") {
        const glow = fac === "horde" ? "#ff8a3a" : fac === "cult" ? "#9ff3ff" : fac === "grave" ? "#c88aff" : fac === "sylvan" ? "#b6f08a" : "#fff2a8";
        px(g, hx + (i ? 7 : 0), hy - 20 * s + (i ? 5 : 0), 3, 3, glow);
      }
    }
    if (L.shield) {
      // 势力色小盾
      const col = CS.FACTIONS[fac] ? CS.FACTIONS[fac].color : "#888";
      const sx = cx - 3 * s;
      const sy = feet - Math.round(f.h * s * 0.42);
      px(g, sx - 1, sy - 1, 6, 7, "#2b1d14");
      px(g, sx, sy, 4, 5, col);
      px(g, sx + 1, sy + 1, 2, 2, "#ffffff55");
    }
    return c;
  }

  function deadFrame(src) {
    // 倒地：旋转 90°、压暗
    const c = canvas(CW, CH);
    const g = c.getContext("2d");
    g.translate(AX, AY - 2);
    g.rotate(Math.PI / 2);
    g.globalAlpha = 0.8;
    g.drawImage(src, -AX, -AY);
    g.globalAlpha = 1;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = "source-atop";
    g.fillStyle = "rgba(40,28,20,0.45)";
    g.fillRect(0, 0, CW, CH);
    return c;
  }

  // 不透明像素的包围盒（用于旗标、面板图标）
  function bbox(c) {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width; let y0 = c.height; let x1 = -1; let y1 = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (d[(y * c.width + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    return x1 < 0 ? { x: 0, y: 0, w: c.width, h: c.height } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  // 图集：每格 CW×CH，每行 ACOLS 格。末尾几格放各归属色的“影子 + 脚环”。
  const ACOLS = 36;
  let atlasCanvas = null;
  const rings = [];
  CS.buildSprites2 = function (sheet) {
    SHEET = sheet;
    atlas.clear();
    const frames = [];
    for (const fac of Object.keys(FTYPES)) {
      for (const type of FTYPES[fac]) {
        for (const face of [1, -1]) {
          const idle0 = compose(fac, type, "idle", 0, face);
          const put = (anim, i, c) => frames.push({ key: fac + type + anim + i + face, c });
          for (let i = 0; i < 4; i++) {
            put("run", i, compose(fac, type, "run", i, face));
            put("idle", i, i ? compose(fac, type, "idle", i, face) : idle0);
          }
          put("atk", 0, compose(fac, type, "atk", 0, face));
          put("atk", 1, compose(fac, type, "atk", 1, face));
          put("hit", 0, compose(fac, type, "hit", 0, face));
          put("dead", 0, deadFrame(idle0));
        }
      }
    }
    const ringCells = CS.PALETTE.length * 2;
    const rows = Math.ceil((frames.length + ringCells) / ACOLS);
    atlasCanvas = canvas(ACOLS * CW, rows * CH);
    const g = atlasCanvas.getContext("2d");
    // 先画到一张草稿画布上，一次读回全部像素来量每格的包围盒；
    // 正式图集只写不读，浏览器才会一直把它当 GPU 纹理用。
    const scratch = document.createElement("canvas");
    scratch.width = atlasCanvas.width;
    scratch.height = atlasCanvas.height;
    const sg = scratch.getContext("2d", { willReadFrequently: true });
    frames.forEach((f, n) => sg.drawImage(f.c, (n % ACOLS) * CW, ((n / ACOLS) | 0) * CH));
    const px = sg.getImageData(0, 0, scratch.width, scratch.height).data;
    const AW = scratch.width;
    frames.forEach((f, n) => {
      const sx = (n % ACOLS) * CW;
      const sy = ((n / ACOLS) | 0) * CH;
      let x0 = CW; let y0 = CH; let x1 = -1; let y1 = -1;
      for (let y = 0; y < CH; y++) {
        let o = ((sy + y) * AW + sx) * 4 + 3;
        for (let x = 0; x < CW; x++, o += 4) {
          if (px[o] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
      }
      const box = x1 < 0 ? { x: 0, y: 0, w: CW, h: CH } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
      atlas.set(f.key, { c: atlasCanvas, sx, sy, w: CW, h: CH, ax: AX, ay: AY, box });
    });
    g.drawImage(scratch, 0, 0);
    // 影子 + 归属色脚环（小 / 大两种）
    rings.length = 0;
    CS.PALETTE.forEach((col, ci) => {
      const pair = [];
      for (let big = 0; big < 2; big++) {
        const n = frames.length + ci * 2 + big;
        const sx = (n % ACOLS) * CW;
        const sy = ((n / ACOLS) | 0) * CH;
        const rw = (big ? 9 : 5) / CS.UNIT_PX;
        g.fillStyle = "rgba(0,0,0,0.27)";
        g.beginPath();
        g.ellipse(sx + CW / 2, sy + CH / 2, rw, rw * 0.42, 0, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = col.color;
        g.globalAlpha = 0.8;
        g.lineWidth = 1.3;
        g.stroke();
        g.globalAlpha = 1;
        pair.push({ c: atlasCanvas, sx, sy, w: CW, h: CH, ax: CW / 2, ay: CH / 2 });
      }
      rings.push(pair);
    });
    CS.atlasInfo = { frames: frames.length, w: atlasCanvas.width, h: atlasCanvas.height };
    return atlas.size;
  };
  CS.ringSprite = (ci, big) => (rings[ci] || rings[8])[big ? 1 : 0];

  CS.unitSprite = function (fac, type, anim, i, face) {
    const f = face < 0 ? -1 : 1;
    return atlas.get(fac + type + anim + i + f) || atlas.get("wild" + type + anim + i + f) || atlas.get("duchy" + type + anim + i + f) || atlas.get("duchyfoot" + anim + i + f);
  };

  // 兼容旧接口：0/1 跑动，2 攻击，3 待机，4 倒地
  CS.sprite = function (fac, type, tier, frame, face) {
    if (frame === 4) return CS.unitSprite(fac, type, "dead", 0, face);
    if (frame === 2) return CS.unitSprite(fac, type, "atk", 1, face);
    if (frame === 3) return CS.unitSprite(fac, type, "idle", 0, face);
    return CS.unitSprite(fac, type, "run", frame * 2, face);
  };
})(typeof window !== "undefined" ? window : globalThis);
