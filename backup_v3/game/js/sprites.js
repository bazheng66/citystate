// 程序化像素小人（原创）+ Kenney 图块索引
(function (root) {
  "use strict";
  const CS = root.CS;

  const OUT = "#1a120c";
  const C = {
    S: "#f1c59b", s: "#c78d63", M: "#cfd5dc", m: "#7f8894", W: "#9a6534", w: "#5f3b1c",
    H: "#8d5a32", h: "#5d3a1f", B: "#3b2a1f", R: "#efe5cc", O: "#6d7f4c", o: "#4a5833",
    Y: "#ffd45a", y: "#b8892a", Z: "#e9eef5", z: "#9aa7b6", X: "#a3a09a", x: "#6e6a63",
  };

  // ---- 小画布像素工具 ----
  function canvasOf(w, h) {
    if (typeof OffscreenCanvas !== "undefined" && !root.document) return new OffscreenCanvas(w, h);
    const c = root.document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  }

  function pix(w, h, draw) {
    const c = canvasOf(w, h);
    const g = c.getContext("2d");
    const P = (x, y, col) => { if (!col) return; g.fillStyle = col; g.fillRect(x | 0, y | 0, 1, 1); };
    const R = (x, y, ww, hh, col) => { if (!col) return; g.fillStyle = col; g.fillRect(x | 0, y | 0, ww | 0, hh | 0); };
    const Ln = (x0, y0, x1, y1, col) => {
      const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) || 1;
      for (let i = 0; i <= n; i++) P(Math.round(x0 + (x1 - x0) * i / n), Math.round(y0 + (y1 - y0) * i / n), col);
    };
    draw(P, R, Ln, g);
    outline(c, g, w, h);
    return c;
  }

  function outline(c, g, w, h) {
    const img = g.getImageData(0, 0, w, h);
    const d = img.data;
    const solid = (x, y) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 40;
    const add = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (solid(x, y)) continue;
        if (solid(x + 1, y) || solid(x - 1, y) || solid(x, y + 1) || solid(x, y - 1)) add.push(x, y);
      }
    }
    g.fillStyle = OUT;
    for (let i = 0; i < add.length; i += 2) g.fillRect(add[i], add[i + 1], 1, 1);
  }

  // ---- 兵种绘制：frame 0/1 走路，2 攻击，3 站立 ----
  const DRAW = {
    foot(P, R, Ln, k, f) {
      const step = f === 0 ? 1 : f === 1 ? -1 : 0;
      R(6 + step, 14, 2, 3, C.B); R(9 - step, 14, 2, 3, C.B);
      R(5, 8, 7, 6, k.P); R(5, 12, 7, 1, k.p); R(6, 9, 2, 3, k.L);
      R(6, 3, 5, 5, C.S); R(10, 5, 1, 2, C.s);
      R(5, 2, 7, 2, k.T); R(5, 4, 1, 2, k.T); P(10, 4, k.T);
      if (f === 2) { Ln(11, 9, 16, 5, C.M); P(11, 10, C.w); }
      else { Ln(4, 12, 4, 4, C.M); P(4, 13, C.w); P(5, 10, C.S); }
      R(10, 8, 3, 6, k.L); R(11, 9, 1, 4, k.P);
    },
    archer(P, R, Ln, k, f) {
      const step = f === 0 ? 1 : f === 1 ? -1 : 0;
      R(6 + step, 14, 2, 3, C.B); R(9 - step, 14, 2, 3, C.B);
      R(6, 8, 6, 6, k.P); R(6, 12, 6, 1, C.w);
      R(4, 7, 2, 6, C.W); P(4, 6, C.R); P(5, 6, C.R);
      R(6, 3, 5, 5, C.S); R(5, 2, 6, 2, k.p); R(5, 3, 1, 4, k.p); P(11, 3, k.p);
      const pull = f === 2 ? 1 : 0;
      Ln(13, 5, 14, 9, C.W); Ln(14, 9, 13, 13, C.W); Ln(13 - pull * 2, 5, 13 - pull * 2, 13, C.R);
      R(11, 9, 2, 1, C.S);
      if (f === 2) Ln(9, 9, 15, 9, C.R);
    },
    mage(P, R, Ln, k, f) {
      const sway = f === 0 ? 1 : f === 1 ? -1 : 0;
      R(5, 8, 7, 8, k.P); R(4 + sway, 14, 9, 2, k.P); R(7, 8, 3, 8, k.p); R(5, 11, 7, 1, k.L);
      R(6, 4, 5, 4, C.S); R(5, 2, 7, 3, k.p); R(4, 4, 2, 4, k.p); P(8, 1, k.p); P(8, 0, k.p);
      const sx = f === 2 ? 14 : 13;
      Ln(sx, f === 2 ? 3 : 4, 13, 16, C.W); R(sx - 1, f === 2 ? 1 : 2, 3, 3, k.L); P(sx, f === 2 ? 2 : 3, "#ffffff");
      R(11, 9, 2, 2, C.S);
    },
    cav(P, R, Ln, k, f) {
      // 马
      const g1 = f === 0 ? 1 : f === 1 ? -1 : 0;
      R(4, 10, 13, 5, k.horse); R(4, 11, 13, 1, k.horseD);
      R(16, 7, 3, 5, k.horse); R(18, 6, 3, 3, k.horse); P(20, 8, k.horseD); P(18, 5, k.horseD);
      R(3, 10, 2, 4, k.horseD);
      R(5 + g1, 15, 2, 4, k.horseD); R(8 - g1, 15, 2, 4, k.horseD); R(13 + g1, 15, 2, 4, k.horseD); R(15 - g1, 15, 2, 4, k.horseD);
      R(6, 10, 8, 2, k.P); R(6, 12, 8, 1, k.L);
      // 骑手
      R(8, 4, 5, 6, k.P); R(9, 5, 2, 4, k.L);
      R(9, 0, 4, 4, C.S); R(8, -1, 6, 2, k.T); P(8, 1, k.T);
      R(10, 9, 2, 3, C.B);
      if (f === 2) { Ln(12, 6, 23, 4, C.M); P(23, 4, C.Z); }
      else { Ln(7, 9, 21, 2, C.M); P(21, 2, C.Z); }
      R(7, 2, 1, 4, k.L);
    },
    siege(P, R, Ln, k, f) {
      R(3, 13, 18, 3, C.W); R(3, 15, 18, 1, C.w);
      R(4, 15, 4, 4, C.w); R(15, 15, 4, 4, C.w); P(5, 16, C.X); P(16, 16, C.X);
      R(9, 7, 3, 7, C.W); R(8, 7, 5, 1, C.w);
      if (f === 2) { Ln(10, 8, 18, 1, C.W); R(17, 0, 3, 3, C.X); }
      else { Ln(10, 9, 3, 6, C.W); R(1, 4, 3, 3, C.X); }
      R(13, 10, 6, 3, k.P); R(19, 3, 1, 10, C.w); R(20, 3, 3, 3, k.P);
      if (f !== 2) { const b = f === 0 ? 0 : 1; P(6 + b, 17, C.x); P(17 - b, 17, C.x); }
    },
    ogre(P, R, Ln, k, f) {
      const step = f === 0 ? 1 : f === 1 ? -1 : 0;
      R(7 + step, 20, 4, 5, C.o); R(14 - step, 20, 4, 5, C.o);
      R(5, 9, 15, 12, C.O); R(5, 18, 15, 3, C.W); R(7, 11, 11, 6, "#86996a");
      R(8, 3, 9, 7, C.O); R(10, 5, 2, 2, "#ffffff"); R(14, 5, 2, 2, "#ffffff"); P(11, 6, OUT); P(15, 6, OUT); R(11, 8, 5, 1, C.o);
      P(10, 9, C.Z); P(15, 9, C.Z);
      if (f === 2) { R(19, 3, 4, 10, C.W); R(18, 1, 6, 4, C.w); R(20, 12, 2, 4, C.O); }
      else { R(20, 8, 3, 10, C.W); R(19, 15, 5, 5, C.w); R(3, 12, 3, 7, C.O); }
    },
    avatar(P, R, Ln, k, f) {
      const flap = f === 0 ? -2 : f === 1 ? 1 : 0;
      R(1, 6 + flap, 7, 9, C.Z); R(18, 6 + flap, 7, 9, C.Z); R(2, 7 + flap, 5, 7, "#ffffff"); R(19, 7 + flap, 5, 7, "#ffffff");
      R(9, 9, 8, 14, "#f4f1e6"); R(9, 13, 8, 2, C.Y); R(10, 22, 6, 3, C.y);
      R(10, 3, 6, 6, C.S); R(9, 1, 8, 2, C.Y); P(12, 0, C.Y);
      if (f === 2) { Ln(17, 10, 25, 2, C.Y); R(24, 0, 3, 3, "#fff6c2"); }
      else { Ln(17, 18, 23, 8, C.Y); }
    },
    worm(P, R, Ln, k, f) {
      const o = f === 0 ? 0 : f === 1 ? 1 : 2;
      R(1, 18, 24, 6, "#6f5a42"); R(2, 19, 22, 2, "#8a7357");
      R(6, 8 - o, 9, 12, "#8a7357"); R(8, 10 - o, 5, 8, "#a99073");
      R(12, 3 - o * 2, 9, 9, "#8a7357"); R(14, 5 - o * 2, 2, 2, "#ff8a3a"); R(18, 5 - o * 2, 2, 2, "#ff8a3a");
      R(19, 10 - o * 2, 4, 2, C.Z); R(5, 20, 2, 2, C.x); R(19, 21, 3, 2, C.x);
    },
  };
  const SIZE = { foot: [18, 19], archer: [18, 19], mage: [18, 19], cav: [26, 21], siege: [26, 21], ogre: [27, 27], avatar: [28, 27], worm: [28, 26] };
  const OFF = { foot: [1, 1], archer: [1, 1], mage: [1, 1], cav: [1, 2], siege: [1, 1], ogre: [1, 1], avatar: [1, 1], worm: [1, 1] };

  function kit(faction, tier) {
    const f = CS.FACTIONS[faction];
    const trim = tier === 2 ? C.Y : tier === 1 ? C.Z : C.M;
    const horse = faction === "cult" ? "#d9dde3" : faction === "horde" ? "#6e6259" : C.H;
    const horseD = faction === "cult" ? "#9aa3ad" : faction === "horde" ? "#463d36" : C.h;
    return { P: f.color, p: f.dark, L: f.light, T: tier === 0 ? C.m : trim, horse, horseD };
  }

  // 图集：key = faction|type|tier|frame|dir
  const atlas = new Map();
  CS.sprite = function (faction, type, tier, frame, dir) {
    return atlas.get(faction + type + tier + frame + (dir < 0 ? "L" : "R"));
  };

  CS.buildSprites = function () {
    const types = Object.keys(DRAW);
    for (const faction of Object.keys(CS.FACTIONS)) {
      for (const type of types) {
        for (let tier = 0; tier < 3; tier++) {
          const k = kit(faction, tier);
          const [w, h] = SIZE[type];
          const [ox, oy] = OFF[type];
          for (let fr = 0; fr < 5; fr++) {
            let c;
            if (fr < 4) {
              c = pix(w, h, (P, R, Ln) => {
                const P2 = (x, y, col) => P(x + ox, y + oy, col);
                const R2 = (x, y, ww, hh, col) => R(x + ox, y + oy, ww, hh, col);
                const L2 = (a, b, cc, d, col) => Ln(a + ox, b + oy, cc + ox, d + oy, col);
                DRAW[type](P2, R2, L2, k, fr === 3 ? 0 : fr, tier);
                if (tier === 2 && type !== "siege" && type !== "worm") R2(Math.floor(w / 2) - 2, -1 + (type === "cav" ? -1 : 0), 1, 1, C.Y);
              });
            } else {
              // 倒地：旋转 90° 并压暗
              const src = atlas.get(faction + type + tier + "0R");
              c = canvasOf(h, w);
              const g = c.getContext("2d");
              g.translate(h, 0);
              g.rotate(Math.PI / 2);
              g.globalAlpha = 0.75;
              g.drawImage(src.c, 0, 0);
              g.globalCompositeOperation = "source-atop";
              g.fillStyle = "rgba(40,28,20,0.45)";
              g.fillRect(0, 0, w, h);
            }
            atlas.set(faction + type + tier + fr + "R", { c, w: c.width, h: c.height });
            const m = canvasOf(c.width, c.height);
            const g = m.getContext("2d");
            g.translate(c.width, 0);
            g.scale(-1, 1);
            g.drawImage(c, 0, 0);
            atlas.set(faction + type + tier + fr + "L", { c: m, w: c.width, h: c.height });
          }
        }
      }
    }
    return atlas.size;
  };

  // ---- Kenney 中世纪图块（CC0） ----
  CS.KENNEY = {
    grass: [0, 1], sand: 2, dirt: 18, stone: 20, water: [36, 37],
    forest: [57, 75, 56, 74], tree: [58, 59, 60, 61], stump: 62, log: 63,
    rock: [77, 78, 79], rockBig: [80, 81], bush: [82, 100], pebble: [94, 95],
    goldRock: [81, 99], ore: 99,
    town: [51, 113, 116, 114, 52], tower: 33, towerRed: 15, castle: 34, castleBig: 16,
    mine: 50, field: [108, 109, 110, 111], crops: 93, millBase: 53, blades: [71, 89, 107],
    statue: 64, fire: 125, stall: 118, chapel: 32,
  };

  CS.blitTile = function (g, sheet, idx, x, y, w, h) {
    const col = idx % 18;
    const row = Math.floor(idx / 18);
    g.drawImage(sheet, 32 + col * 96, 32 + row * 96, 64, 64, x, y, w, h || w);
  };
})(typeof window !== "undefined" ? window : globalThis);
