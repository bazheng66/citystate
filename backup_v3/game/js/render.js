// Canvas 2D 渲染：烘焙地形 + 按 y 排序的实体 + 特效 + 界面叠层
(function (root) {
  "use strict";
  const CS = root.CS;
  const { W, H, TILE, COLS, ROWS, T, KENNEY: K } = CS;

  const R = (CS.render = {});
  let sheet = null;
  let canvas = null;
  let ctx = null;
  let k = 1;
  let baked = null;
  let bakedFor = null;
  const drawList = [];
  const pool = [];
  const byY = (a, b) => a.y - b.y;
  let shadowImg = null;
  function shadowSprite() {
    if (shadowImg) return shadowImg;
    shadowImg = document.createElement("canvas");
    shadowImg.width = 32; shadowImg.height = 8;
    const g = shadowImg.getContext("2d");
    g.fillStyle = "rgba(0,0,0,0.24)";
    g.beginPath(); g.ellipse(16, 4, 15, 3.6, 0, 0, Math.PI * 2); g.fill();
    return shadowImg;
  }
  const US = 1.3; // 士兵绘制放大倍数
  const RF = (CS.RF = { shadow: 1, unit: 1, tags: 1, corpses: 1, round: 0, noscale: 0 });
  CS.UNIT_SCALE = US;

  R.init = function (cv, img) {
    canvas = cv;
    ctx = cv.getContext("2d");
    sheet = img;
  };

  R.resize = function (cssW, cssH, dpr) {
    const fit = Math.min(cssW / W, cssH / H);
    const scale = fit * dpr;
    canvas.width = Math.round(W * scale);
    canvas.height = Math.round(H * scale);
    canvas.style.width = Math.round(W * fit) + "px";
    canvas.style.height = Math.round(H * fit) + "px";
    k = canvas.width / W;
    bakedFor = null;
    return fit;
  };
  R.scale = () => k;

  function rnd(seed) { return CS.rng(seed); }

  // ---------- 地形烘焙（Kenney Tiny Town 像素风）----------
  function bake(world) {
    const map = world.map;
    const c = document.createElement("canvas");
    c.width = canvas.width;
    c.height = canvas.height;
    const g = c.getContext("2d");
    g.setTransform(k, 0, 0, k, 0, 0);
    g.imageSmoothingEnabled = false;
    const rand = rnd(world.layout.seed * 31 + 7);
    const at = (cc, rr) => (cc < 0 || rr < 0 || cc >= COLS || rr >= ROWS ? T.GRASS : map.grid[rr * COLS + cc]);
    const OUT = "#3f2631";

    // 草地：16px 图块平铺，少量草丛和小花
    for (let y = 0; y < H; y += 16) {
      for (let x = 0; x < W; x += 16) {
        const r = rand();
        tt(r < 0.12 ? 1 : r < 0.15 ? 2 : 0, x, y, g);
      }
    }
    // 土路：外描边 + 土色 + 浅色中线
    const strokeRoads = (width, color) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.lineCap = "round";
      g.lineJoin = "round";
      for (const road of map.roads) {
        g.beginPath();
        g.moveTo(road[0].x, road[0].y);
        for (let i = 1; i < road.length - 1; i++) {
          const mx = (road[i].x + road[i + 1].x) / 2;
          const my = (road[i].y + road[i + 1].y) / 2;
          g.quadraticCurveTo(road[i].x, road[i].y, mx, my);
        }
        const last = road[road.length - 1];
        g.lineTo(last.x, last.y);
        g.stroke();
      }
    };
    strokeRoads(13, "#5f9d4f");
    strokeRoads(10, "#eaa56c");
    strokeRoads(3, "#f3c08e");

    // 水：深色描边 + 水面 + 波光
    for (let r = 0; r < ROWS; r++) {
      for (let cc = 0; cc < COLS; cc++) {
        const v = at(cc, r);
        if (v !== T.WATER && v !== T.BRIDGE) continue;
        g.fillStyle = OUT;
        g.fillRect(cc * TILE - 2, r * TILE - 2, TILE + 4, TILE + 4);
      }
    }
    for (let r = 0; r < ROWS; r++) {
      for (let cc = 0; cc < COLS; cc++) {
        const v = at(cc, r);
        if (v !== T.WATER && v !== T.BRIDGE) continue;
        const x = cc * TILE;
        const y = r * TILE;
        g.fillStyle = "#4f9fd6";
        g.fillRect(x, y, TILE, TILE);
        g.fillStyle = "#6fb9e6";
        g.fillRect(x, y + TILE - 6, TILE, 3);
        g.fillStyle = "#c9ecff";
        if (rand() < 0.5) g.fillRect(x + Math.floor(rand() * 12) + 2, y + Math.floor(rand() * 12) + 2, 4, 1);
      }
    }
    // 桥
    for (let r = 0; r < ROWS; r++) {
      for (let cc = 0; cc < COLS; cc++) {
        if (at(cc, r) !== T.BRIDGE) continue;
        const x = cc * TILE;
        const y = r * TILE;
        const vertical = at(cc, r - 1) === T.BRIDGE || at(cc, r + 1) === T.BRIDGE ? (at(cc - 1, r) === T.WATER || at(cc + 1, r) === T.WATER) : false;
        g.fillStyle = OUT;
        g.fillRect(x, y, TILE, TILE);
        g.fillStyle = "#c48a4e";
        for (let i = 0; i < 4; i++) {
          if (vertical) g.fillRect(x + 1, y + i * 5 + 1, TILE - 2, 4);
          else g.fillRect(x + i * 5 + 1, y + 1, 4, TILE - 2);
        }
        g.fillStyle = "#8a5a32";
        if (vertical) { g.fillRect(x, y, 2, TILE); g.fillRect(x + TILE - 2, y, 2, TILE); }
        else { g.fillRect(x, y, TILE, 2); g.fillRect(x, y + TILE - 2, TILE, 2); }
      }
    }
    // 小装饰：草丛、蘑菇、嫩芽
    for (let r = 0; r < ROWS; r++) {
      for (let cc = 0; cc < COLS; cc++) {
        const d = map.decor[r * COLS + cc];
        if (!d || rand() < 0.55) continue;
        const id = [0, 5, 17, 29, 5, 17, 2][d];
        tt(id, cc * TILE + Math.floor(rand() * 6) - 2, r * TILE + Math.floor(rand() * 6) - 4, g);
      }
    }
    // 岩石：像素风石块
    for (let r = 0; r < ROWS; r++) {
      for (let cc = 0; cc < COLS; cc++) {
        if (at(cc, r) !== T.ROCK) continue;
        tt(43, cc * TILE + 2, r * TILE + 2, g);
        const n = 1 + Math.floor(rand() * 2);
        for (let i = 0; i < n; i++) {
          const w = 8 + Math.floor(rand() * 6);
          const h = 6 + Math.floor(rand() * 4);
          const x = cc * TILE + Math.floor(rand() * (TILE - w));
          const y = r * TILE + Math.floor(rand() * (TILE - h)) - 2;
          g.fillStyle = OUT;
          g.fillRect(x - 1, y - 1, w + 2, h + 2);
          g.fillStyle = "#9aa3b5";
          g.fillRect(x, y, w, h);
          g.fillStyle = "#c3cad6";
          g.fillRect(x + 1, y + 1, w - 3, 2);
          g.fillStyle = "#6f7787";
          g.fillRect(x, y + h - 2, w, 2);
        }
      }
    }
    // 树林：按行从上到下撒树，保证遮挡正确
    const trees = [4, 16, 28, 4, 16, 3, 15];
    for (let r = 0; r < ROWS; r++) {
      for (let cc = 0; cc < COLS; cc++) {
        if (at(cc, r) !== T.FOREST) continue;
        g.fillStyle = "rgba(40,90,40,0.35)";
        g.fillRect(cc * TILE - 1, r * TILE + 3, TILE + 2, TILE);
      }
    }
    for (let r = 0; r < ROWS; r++) {
      for (let cc = 0; cc < COLS; cc++) {
        if (at(cc, r) !== T.FOREST) continue;
        const n = 1 + Math.floor(rand() * 2);
        for (let i = 0; i < n; i++) {
          const id = trees[Math.floor(rand() * trees.length)];
          tt(id, cc * TILE + Math.floor(rand() * 8) - 2, r * TILE + Math.floor(rand() * 6) - 8, g);
        }
      }
    }
    // 暗角
    const vg = g.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, H * 0.95);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(10,20,5,0.35)");
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);
    baked = c;
    bakedFor = world;
  }
  R.invalidate = () => { bakedFor = null; };
  let shakeAmt = 0;
  let shakeT = 0;
  R.shake = function (n) {
    const now = performance.now();
    const left = shakeAmt * Math.max(0, 1 - (now - shakeT) / 380);
    shakeAmt = Math.max(left, n);
    shakeT = now;
  };

  // ---------- 主绘制 ----------
  R.draw = function (world, alpha, view) {
    if (!sheet || !world) return;
    if (bakedFor !== world) bake(world);
    // 震屏：天罚、投石落地时晃一下
    const nowMs = view.now || 0;
    const sh = shakeAmt * Math.max(0, 1 - (nowMs - shakeT) / 380);
    const sx = sh ? Math.round((Math.random() - 0.5) * sh * 2 * k) : 0;
    const sy = sh ? Math.round((Math.random() - 0.5) * sh * 2 * k) : 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (sh) { ctx.fillStyle = "#1c1209"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    ctx.drawImage(baked, sx, sy);
    ctx.setTransform(k, 0, 0, k, sx, sy);
    ctx.imageSmoothingEnabled = false;
    const t = world.t;

    // 尸体
    if (RF.corpses) for (const c of world.corpses) {
      const age = t - c.t;
      if (age > 10) continue;
      const fac = world.owners[c.owner].faction;
      const s = CS.sprite(fac, c.type, 0, 4, c.face);
      if (!s) continue;
      ctx.globalAlpha = Math.max(0, Math.min(0.85, (10 - age) / 4));
      ctx.drawImage(s.c, c.x - s.ax * CS.UNIT_PX, c.y - s.ay * CS.UNIT_PX, s.w * CS.UNIT_PX, s.h * CS.UNIT_PX);
    }
    ctx.globalAlpha = 1;

    // 法术地面效果
    for (const ef of world.effects) drawEffect(ef, t, world);

    // 选中圈 & 指令
    for (const sq of world.squads) {
      if (!sq.sel || sq.inside) continue;
      const r = squadRadius(sq);
      ctx.strokeStyle = "rgba(255,230,140,0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(sq.x, sq.y + 4, r, r * 0.6, 0, 0, Math.PI * 2);
      ctx.stroke();
      if (sq.path.length) {
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = "rgba(255,230,140,0.45)";
        ctx.beginPath();
        ctx.moveTo(sq.x, sq.y);
        for (const p of sq.path) ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if (view.selStruct) {
      const st = view.selStruct;
      ctx.strokeStyle = "rgba(255,230,140,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(st.x, st.y + 10, st.R + 14, (st.R + 14) * 0.55, 0, 0, Math.PI * 2);
      ctx.stroke();
      if (st.rally) {
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(st.x, st.y);
        ctx.lineTo(st.rally.x, st.rally.y);
        ctx.stroke();
        ctx.setLineDash([]);
        drawFlagIcon(st.rally.x, st.rally.y, "#ffd96a");
      }
    }

    // 实体排序（对象池，避免每帧分配）
    let dn = 0;
    const put = (y, kind, o, x, fac, sq, i, a) => {
      let d = pool[dn];
      if (!d) d = pool[dn] = {};
      d.y = y; d.kind = kind; d.o = o; d.x = x; d.fac = fac; d.sq = sq; d.i = i; d.a = a; d.facCol = a;
      drawList[dn++] = d;
    };
    for (const st of world.structs) {
      put(st.y + st.R * 0.4, 0, st);
      for (let i = 0; i < 3; i++) put(st.y + CS.SLOT_OFFSETS[i][1], 1, st, 0, null, null, i, st.addons[i]);
    }
    for (const c of world.chests) if (!c.taken) put(c.y, 2, c);
    for (const sq of world.squads) {
      if (sq.inside) continue;
      const fac = world.owners[sq.owner].faction;
      for (const u of sq.units) {
        if (u.dead) continue;
        put(u.py + (u.y - u.py) * alpha, 3, u, u.px + (u.x - u.px) * alpha, fac, sq, 0, CS.FACTIONS[fac].color);
      }
    }
    drawList.length = dn;
    drawList.sort(byY);
    for (let di = 0; di < dn; di++) {
      const d = drawList[di];
      if (d.kind === 0) drawStruct(d.o, world, view);
      else if (d.kind === 1) drawAddon(d.o, d.i, d.a, world, view);
      else if (d.kind === 2) drawChest(d.o, t);
      else drawUnit(d, t);
    }

    // 飞行物
    for (const p of world.proj) drawProj(p);
    // 特效
    for (const f of world.fx) drawFx(f, t);

    // 部队旗标与血条
    if (RF.tags) for (const sq of world.squads) {
      if (sq.inside || !sq.units.length) continue;
      drawSquadTag(sq, world, view);
    }
    for (const st of world.structs) drawStructBars(st, world);

    // 指令标记
    for (const m of view.markers) {
      const age = (view.now - m.t) / 600;
      if (age > 1) continue;
      ctx.strokeStyle = m.color;
      ctx.globalAlpha = 1 - age;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(m.x, m.y, 6 + age * 12, (6 + age * 12) * 0.6, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // 框选
    if (view.box) {
      const b = view.box;
      ctx.fillStyle = "rgba(255,230,140,0.08)";
      ctx.strokeStyle = "rgba(255,230,140,0.85)";
      ctx.lineWidth = 1;
      ctx.fillRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      ctx.strokeRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    }
    if (view.flagLine) drawDragPreview(view.flagLine, view.now);
    // 受攻击警报
    for (const st of world.structs) {
      if (st.owner !== "p" || st.ruined || world.t - st.lastHit > 2) continue;
      const ph = (view.now / 700) % 1;
      ctx.strokeStyle = `rgba(255,80,60,${0.9 * (1 - ph)})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(st.x, st.y + 8, st.R + 10 + ph * 30, (st.R + 10 + ph * 30) * 0.55, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    // 法术瞄准
    if (view.aim && view.mouse) {
      const sp = CS.SPELLS[view.aim];
      const r = sp.radius || 40;
      ctx.strokeStyle = view.aimOk ? "rgba(180,220,255,0.95)" : "rgba(255,120,100,0.9)";
      ctx.fillStyle = view.aimOk ? "rgba(180,220,255,0.12)" : "rgba(255,120,100,0.1)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(view.mouse.x, view.mouse.y, r, r * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  };

  R.banner = function (text, sub, a) {
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.globalAlpha = Math.max(0, Math.min(1, a));
    const gr = ctx.createLinearGradient(0, 0, W, 0);
    gr.addColorStop(0, "rgba(20,12,6,0)");
    gr.addColorStop(0.2, "rgba(20,12,6,0.78)");
    gr.addColorStop(0.8, "rgba(20,12,6,0.78)");
    gr.addColorStop(1, "rgba(20,12,6,0)");
    ctx.fillStyle = gr;
    ctx.fillRect(0, H * 0.36, W, 96);
    ctx.textAlign = "center";
    ctx.font = "bold 30px Microsoft YaHei, sans-serif";
    ctx.fillStyle = "#ffe2a0";
    ctx.fillText(text, W / 2, H * 0.36 + 44);
    ctx.font = "16px Microsoft YaHei, sans-serif";
    ctx.fillStyle = "#d9c49a";
    ctx.fillText(sub, W / 2, H * 0.36 + 76);
    ctx.globalAlpha = 1;
  };

  R.overlay = function (text) {
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.fillStyle = "rgba(8,5,2,0.45)";
    ctx.fillRect(0, 0, W, H);
    ctx.font = "bold 44px Microsoft YaHei, sans-serif";
    ctx.textAlign = "center";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "#2a1608";
    ctx.strokeText(text, W / 2, H / 2);
    ctx.fillStyle = "#ffe2a0";
    ctx.fillText(text, W / 2, H / 2);
  };

  function squadRadius(sq) {
    if (sq.type === "ogre" || sq.st.summon) return 18;
    return 10 + Math.sqrt(sq.units.length) * (sq.type === "cav" || sq.type === "siege" ? 9 : 5);
  }

  function drawUnit(d, t) {
    const u = d.o;
    const sq = d.sq;
    const P = CS.UNIT_PX;
    let s;
    if (u.atk > 0) s = CS.unitSprite(d.fac, sq.type, "atk", u.atk > 0.13 ? 0 : 1, u.face);
    else if (u.hitT > 0.06) s = CS.unitSprite(d.fac, sq.type, "hit", 0, u.face);
    else if (u.moving) s = CS.unitSprite(d.fac, sq.type, "run", Math.floor(u.step / 2.6) % 4, u.face);
    else s = CS.unitSprite(d.fac, sq.type, "idle", Math.floor(t * 6 + u.i * 1.7) % 4, u.face);
    if (!s) return;
    const sw = s.w * P;
    const sh = s.h * P;
    const lunge = u.atk > 0 && !sq.st.proj ? Math.sin((0.22 - u.atk) / 0.22 * Math.PI) * 2 * u.face : 0;
    const x = d.x - s.ax * P + lunge;
    const y = d.y - s.ay * P;
    const big = sq.type === "cav" || sq.type === "siege" || sq.type === "ogre" || sq.st.summon;
    if (RF.shadow) {
      // 势力色脚环 + 影子：同色的人一眼能认出是一伙的
      const rw = big ? 9 : 5;
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.beginPath();
      ctx.ellipse(d.x, d.y + 0.5, rw, rw * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = d.facCol;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (!RF.unit) return;
    ctx.drawImage(s.c, x, y, sw, sh);
    const top = y + s.box.y * P;
    if (u.hitT > 0) {
      ctx.globalAlpha = Math.min(0.6, u.hitT * 5);
      ctx.globalCompositeOperation = "lighter";
      ctx.drawImage(s.c, x, y, sw, sh);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }
    if (u.stun > 0) {
      // 冻成冰块
      const bx = x + s.box.x * P - 1;
      const bw = s.box.w * P + 2;
      const bh = s.box.h * P + 2;
      ctx.fillStyle = "rgba(63,38,49,0.8)";
      ctx.fillRect(bx - 1, top - 2, bw + 2, bh + 2);
      ctx.fillStyle = "rgba(160,225,255,0.55)";
      ctx.fillRect(bx, top - 1, bw, bh);
      ctx.fillStyle = "rgba(240,252,255,0.85)";
      ctx.fillRect(bx + 1, top, 2, bh - 3);
      ctx.fillRect(bx + 1, top, bw - 3, 1);
    }
    // 老兵 / 精锐：头顶小金标
    for (let i = 0; i < sq.tier; i++) {
      ctx.fillStyle = "#ffd96a";
      ctx.fillRect(d.x - 2.5 + i * 3, top - 3, 2, 2);
    }
    if (u.frostSlow < 1 || u.slowT > 0) {
      ctx.fillStyle = "rgba(160,220,255,0.85)";
      ctx.fillRect(d.x - 2, top - 6, 4, 2);
    }
    if (u.lust) {
      ctx.fillStyle = "rgba(255,90,60,0.9)";
      ctx.fillRect(d.x - 2, top - 6, 4, 2);
    }
  }

  function drawSquadTag(sq, world, view) {
    const facId = world.owners[sq.owner].faction;
    const fac = CS.FACTIONS[facId];
    const hp = CS.squadHp(sq);
    let top = Infinity;
    for (const u of sq.units) top = Math.min(top, u.y);
    const lift = sq.type === "cav" || sq.type === "siege" ? 34 : sq.type === "ogre" || sq.st.summon ? 42 : 27;
    const x = sq.x;
    const full = sq.st.hp * sq.units.length > 0 ? hp.hp / (sq.st.hp * Math.max(sq.units.length, sq.st.size)) : 0;
    if (sq.owner !== "p") {
      // 敌方 / 中立：只画一条细血条
      const r = squadRadius(sq);
      const y = top - lift + 6;
      const w = Math.max(16, Math.min(30, r * 1.6));
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(Math.round(x - w / 2) - 1, Math.round(y) - 1, w + 2, 4);
      ctx.fillStyle = full > 0.5 ? fac.light : full > 0.25 ? "#f0c060" : "#ff6a5a";
      ctx.fillRect(Math.round(x - w / 2), Math.round(y), Math.max(0, Math.round(w * Math.min(1, full))), 2);
      sq.tagX = null;
      return;
    }
    // 己方：头顶一面圆形旗标，按住它拖到目的地
    const by = top - lift - 4;
    ctx.strokeStyle = "rgba(40,26,14,0.8)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, by + 8);
    ctx.lineTo(x, top - 10);
    ctx.stroke();
    drawBadge(x, by, 9, sq, facId, fac, full, sq.sel);
    sq.tagX = x;
    sq.tagY = by;
  }

  // 圆形旗标：兵种小像 + 人数 + 一圈血量
  function drawBadge(x, y, r, sq, facId, fac, full, hot) {
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.ellipse(x + 1, y + 2, r + 1, r + 1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = hot ? "#5a3d14" : "#2a1b0d";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = hot ? "#ffd96a" : fac.color;
    ctx.stroke();
    // 血量弧
    const f = Math.max(0, Math.min(1, full));
    ctx.strokeStyle = f > 0.5 ? "#9be36a" : f > 0.25 ? "#f0c060" : "#ff6a5a";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(x, y, r + 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * f);
    ctx.stroke();
    // 兵种小像
    const s = CS.unitSprite(facId, sq.type, "idle", 0, 1);
    if (s) {
      const b = s.box;
      const k2 = (r * 1.7) / Math.max(b.w, b.h);
      ctx.drawImage(s.c, b.x, b.y, b.w, b.h, x - b.w * k2 / 2, y - b.h * k2 / 2, b.w * k2, b.h * k2);
    }
    // 人数
    if (sq.units.length > 1) {
      ctx.font = "bold 7px sans-serif";
      ctx.textAlign = "center";
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = "#1a0f06";
      ctx.strokeText(sq.units.length, x + r * 0.75, y + r + 1);
      ctx.fillStyle = "#fff6d8";
      ctx.fillText(sq.units.length, x + r * 0.75, y + r + 1);
    }
    // 老兵 / 精锐小星
    for (let i = 0; i < sq.tier; i++) {
      ctx.fillStyle = "#ffd96a";
      ctx.fillRect(x - r + i * 3.5, y - r - 1, 2.5, 2.5);
    }
  }

  // 拖旗时：虚线指向目标，目标城描边，并写明“进攻 / 占领 / 进驻 / 移动”
  function drawDragPreview(f, now) {
    ctx.strokeStyle = f.color;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.lineDashOffset = -((now / 40) % 11);
    for (const p of f.from) {
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(f.x1, f.y1);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.globalAlpha = 1;
    if (f.st) {
      const st = f.st;
      ctx.strokeStyle = f.color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.ellipse(st.x, st.y + 10, st.R + 16, (st.R + 16) * 0.55, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else drawFlagIcon(f.x1, f.y1, f.color);
    ctx.font = "bold 12px Microsoft YaHei, sans-serif";
    const tw = ctx.measureText(f.label).width;
    const lx = Math.max(tw / 2 + 6, Math.min(W - tw / 2 - 6, f.x1));
    const ly = Math.max(20, f.y1 - 22);
    ctx.fillStyle = "rgba(20,12,6,0.82)";
    ctx.fillRect(lx - tw / 2 - 6, ly - 13, tw + 12, 18);
    ctx.fillStyle = f.color;
    ctx.textAlign = "center";
    ctx.fillText(f.label, lx, ly);
  }

  function drawFlagIcon(x, y, col) {
    ctx.fillStyle = "#3a2616";
    ctx.fillRect(x, y - 12, 1.5, 13);
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(x + 1.5, y - 12);
    ctx.lineTo(x + 10, y - 9);
    ctx.lineTo(x + 1.5, y - 6);
    ctx.fill();
  }

  function shadow(x, y, rx, ry) {
    ctx.fillStyle = "rgba(20,30,10,0.28)";
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---------- 建筑：Kenney Tiny Town（CC0）16px 图块拼装 ----------
  const TT = 16;
  function tt(i, x, y, g) {
    (g || ctx).drawImage(CS.IMG.town, (i % 12) * 16, ((i / 12) | 0) * 16, 16, 16, Math.round(x), Math.round(y), TT, TT);
  }
  function tgrid(rows, x, y, g) {
    for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r].length; c++) if (rows[r][c] != null) tt(rows[r][c], x + c * TT, y + r * TT, g);
  }
  const HOUSE_RED3 = [[52, 53, 54], [64, 65, 66], [72, 73, 75], [84, 85, 84]];
  const HOUSE_RED2 = [[52, 54], [64, 66], [72, 75], [87, 84]];
  const HOUSE_GREY2 = [[48, 50], [60, 62], [76, 79], [88, 89]];
  const HOUSE_GREY3 = [[48, 49, 50], [60, 61, 62], [76, 77, 79], [88, 90, 88]];
  // 建筑顶部离据点中心的高度（血条、旗帜、点击范围都按它算），按等级
  const ART_TOP = { town: [64, 74, 74], tower: [72, 88, 104], castle: [52, 76, 92] };
  CS.ART_TOP = ART_TOP;
  const artTop = (st) => (st.ruined ? 40 : ART_TOP[st.type][st.level]);
  CS.artTop = artTop;

  function drawStruct(st, world, view) {
    const t = world.t;
    const x = st.x;
    const y = st.y;
    const owner = st.owner ? world.owners[st.owner] : null;
    const fac = owner ? CS.FACTIONS[owner.faction] : null;
    ctx.imageSmoothingEnabled = false;
    // 地基：一块夯土地 + 势力色描边
    shadow(x, y + 15, st.R + 16, (st.R + 16) * 0.38);
    ctx.fillStyle = st.ruined ? "rgba(90,70,50,0.55)" : "rgba(214,160,104,0.75)";
    ctx.beginPath();
    ctx.ellipse(x, y + 13, st.R + 12, (st.R + 12) * 0.36, 0, 0, Math.PI * 2);
    ctx.fill();
    if (fac) {
      ctx.strokeStyle = fac.color;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(x, y + 13, st.R + 13, (st.R + 13) * 0.36, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (st.ruined) { drawRuin(st, t); return; }
    if (st.hitFlash > 0) ctx.filter = "brightness(1.35)";
    const base = y + 16; // 建筑底边
    const lv = st.level;
    if (st.type === "town") {
      if (lv >= 1) tgrid(HOUSE_GREY2, x - 4, base - 10 - 64);
      tgrid(HOUSE_RED2, x + 6, base - 6 - 64);
      tgrid(HOUSE_RED3, x - 38, base - 64);
      if (lv >= 2) {
        tt(92, x + 22, base - 26); tt(104, x + 22, base - 16); // 水井
        tgrid([[80, 81, 82]], x - 40, base - 6);
      }
    } else if (st.type === "tower") {
      // 石砌法塔：越升级越高
      const rows = [[48, 50], [60, 62]];
      const body = 2 + lv;
      for (let i = 0; i < body; i++) rows.push(i === body - 1 ? [89, 88] : i % 2 ? [88, 88] : [76, 79]);
      tgrid(rows, x - 16, base - rows.length * TT);
      const topY = base - rows.length * TT;
      // 法球
      const glow = 0.6 + Math.sin(t * 3) * 0.25;
      const cy = topY - 8 - Math.sin(t * 2) * 2;
      const col = fac ? fac.light : "#ffffff";
      const gr = ctx.createRadialGradient(x, cy, 1, x, cy, 16);
      gr.addColorStop(0, col);
      gr.addColorStop(1, "rgba(255,255,255,0)");
      ctx.globalAlpha = glow;
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.arc(x, cy, 16, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#2b1d14";
      ctx.fillRect(x - 3, cy - 3, 6, 6);
      ctx.fillStyle = col;
      ctx.fillRect(x - 2, cy - 2, 4, 4);
    } else {
      // 城堡：两侧塔楼 + 城墙 + 城门；1 级起后面加主楼，2 级塔楼加高
      if (lv >= 1) tgrid(lv >= 2 ? [[52, 53, 54], [64, 65, 66], [76, 77, 79], [88, 88, 88]] : HOUSE_GREY3, x - 24, base - 32 - 64 + (lv >= 2 ? 0 : 8));
      const towerRows = lv >= 2 ? [[102], [103], [126], [125], [126]] : [[102], [103], [126], [125]];
      tgrid(towerRows, x - 48, base - towerRows.length * TT);
      tgrid(towerRows, x + 32, base - towerRows.length * TT);
      tgrid([[99, 100, 100, 101], [126, 111, 112, 126], [125, 123, 124, 125]], x - 32, base - 48);
    }
    ctx.filter = "none";
    // 旗帜
    if (fac) {
      const top = y - artTop(st);
      const fx = st.type === "castle" ? x - 41 : st.type === "tower" ? x + 10 : x - 12;
      const fy = st.type === "castle" ? y - (lv >= 2 ? 92 : 76) + 10 : top - 6;
      ctx.fillStyle = "#3a2616";
      ctx.fillRect(fx, fy, 2, 20);
      ctx.fillStyle = fac.color;
      const wave = Math.sin(t * 4 + st.id) * 1.5;
      ctx.beginPath();
      ctx.moveTo(fx + 2, fy);
      ctx.quadraticCurveTo(fx + 9, fy + 2 + wave, fx + 16, fy + 3);
      ctx.quadraticCurveTo(fx + 9, fy + 5 - wave, fx + 2, fy + 9);
      ctx.fill();
      ctx.fillStyle = fac.light;
      ctx.fillRect(fx + 4, fy + 3, 3, 3);
      if (st.type === "castle") {
        // 另一座塔也插旗
        const gx = x + 40;
        ctx.fillStyle = "#3a2616";
        ctx.fillRect(gx, fy, 2, 20);
        ctx.fillStyle = fac.color;
        ctx.beginPath();
        ctx.moveTo(gx + 2, fy);
        ctx.quadraticCurveTo(gx + 9, fy + 2 - wave, gx + 16, fy + 3);
        ctx.quadraticCurveTo(gx + 9, fy + 5 + wave, gx + 2, fy + 9);
        ctx.fill();
      }
    }
    // 受损冒烟 / 起火
    if (st.hp < st.maxHp * 0.5) {
      const n = st.hp < st.maxHp * 0.25 ? 3 : 1;
      const top = y - artTop(st) + 20;
      for (let i = 0; i < n; i++) {
        const ph = (t * 0.7 + i * 0.37 + st.id * 0.13) % 1;
        ctx.fillStyle = `rgba(60,55,50,${0.5 * (1 - ph)})`;
        const sx = Math.round(x - 14 + i * 14 + Math.sin(ph * 6) * 3);
        const sy = Math.round(top - ph * 34);
        const r = Math.round(3 + ph * 7);
        ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
      }
      if (st.hp < st.maxHp * 0.3) drawFire(x - 12, y - 8, t, st.id);
    }
  }

  // 像素火苗
  function drawFire(x, y, t, seed) {
    const f = Math.floor(t * 10 + seed) % 3;
    const h = [9, 11, 8][f];
    ctx.fillStyle = "#2b1d14";
    ctx.fillRect(x - 4, y - h - 1, 9, h + 2);
    ctx.fillStyle = "#e5482f";
    ctx.fillRect(x - 3, y - h, 7, h);
    ctx.fillStyle = "#f7a531";
    ctx.fillRect(x - 2, y - h + 3, 5, h - 3);
    ctx.fillStyle = "#ffe68a";
    ctx.fillRect(x - 1, y - h + 6, 3, h - 6);
  }

  function drawRuin(st, t) {
    const x = st.x;
    const y = st.y;
    // 残垣：几块断墙 + 碎石
    ctx.globalAlpha = 0.9;
    tt(126, x - 30, y - 10); tt(125, x - 30, y - 26);
    tt(126, x + 14, y - 4);
    tt(99, x - 14, y - 2); tt(101, x + 2, y + 2);
    ctx.globalAlpha = 1;
    tt(43, x - 8, y - 4); tt(43, x - 24, y + 4); tt(43, x + 10, y + 8);
    ctx.fillStyle = "rgba(30,20,12,0.35)";
    ctx.fillRect(x - 30, y - 26, 16, 32);
    if (st.rebuild > 0) {
      // 脚手架
      const p = st.rebuild / (st.maxHp * 0.45);
      const h = 10 + p * 40;
      ctx.fillStyle = "#2b1d14";
      for (const sx of [-22, 20]) ctx.fillRect(x + sx - 1, y + 8 - h, 4, h);
      for (const yy of [0.35, 0.7, 1]) ctx.fillRect(x - 24, y + 8 - h * yy - 1, 48, 4);
      ctx.fillStyle = "#c48a4e";
      for (const sx of [-22, 20]) ctx.fillRect(x + sx, y + 8 - h, 2, h);
      for (const yy of [0.35, 0.7, 1]) ctx.fillRect(x - 23, y + 8 - h * yy, 46, 2);
    } else {
      const ph = (t * 0.5 + st.id * 0.2) % 1;
      ctx.fillStyle = `rgba(80,75,70,${0.4 * (1 - ph)})`;
      const r = Math.round(3 + ph * 6);
      ctx.fillRect(Math.round(x + 4 - r), Math.round(y - 14 - ph * 26 - r), r * 2, r * 2);
    }
  }

  function drawAddon(st, i, a, world, view) {
    const [ox, oy] = CS.SLOT_OFFSETS[i];
    const x = Math.round(st.x + ox);
    const y = Math.round(st.y + oy);
    const t = world.t;
    ctx.imageSmoothingEnabled = false;
    if (!a) {
      if (st.owner === "p" && !st.ruined) {
        // 空地木牌
        const hover = view.hoverSlot && view.hoverSlot.st === st && view.hoverSlot.i === i;
        ctx.fillStyle = "rgba(90,60,30,0.25)";
        ctx.beginPath();
        ctx.ellipse(x, y + 4, 12, 5, 0, 0, Math.PI * 2);
        ctx.fill();
        if (hover) ctx.filter = "brightness(1.35)";
        tt(83, x - 8, y - 14);
        ctx.filter = "none";
        const bob = Math.round(Math.sin(t * 3 + i) * 1.5);
        ctx.fillStyle = "#2b1d14";
        ctx.fillRect(x - 4, y - 25 + bob, 9, 9);
        ctx.fillStyle = hover ? "#fff2b0" : "#ffd96a";
        ctx.fillRect(x - 3, y - 24 + bob, 7, 7);
        ctx.fillStyle = "#2b1d14";
        ctx.fillRect(x, y - 23 + bob, 1, 5);
        ctx.fillRect(x - 2, y - 21 + bob, 5, 1);
      }
      return;
    }
    shadow(x, y + 6, 15, 5);
    if (a === "mine") {
      // 矿坑：碎石堆 + 金块 + 镐
      tt(43, x - 16, y - 10); tt(43, x, y - 10);
      ctx.fillStyle = "#2b1d14";
      ctx.fillRect(x - 9, y - 12, 18, 8);
      ctx.fillStyle = "#4a4038";
      ctx.fillRect(x - 8, y - 11, 16, 6);
      const gl = (Math.sin(t * 3 + st.id) + 1) / 2;
      ctx.fillStyle = "#f2c25c";
      ctx.fillRect(x - 5, y - 9, 3, 2); ctx.fillRect(x + 2, y - 8, 2, 2);
      ctx.fillStyle = `rgba(255,245,190,${0.4 + gl * 0.6})`;
      ctx.fillRect(x - 4, y - 10, 1, 1);
      tt(115, x + 4, y - 22);
      tt(107, x - 20, y - 14);
    } else if (a === "farm") {
      // 农田：两块地 + 庄稼 + 草垛
      tt(40, x - 16, y - 8); tt(41, x, y - 8);
      for (let r = 0; r < 3; r++) {
        ctx.fillStyle = "#2b1d14";
        ctx.fillRect(x - 14, y - 5 + r * 4, 28, 3);
        ctx.fillStyle = r % 2 ? "#e9cf72" : "#8fc65a";
        ctx.fillRect(x - 13, y - 5 + r * 4, 26, 2);
      }
      tt(93, x + 10, y - 18);
      tt(94, x - 22, y - 16);
    } else if (a === "obelisk") {
      const fac = st.owner ? CS.FACTIONS[world.owners[st.owner].faction] : CS.FACTIONS.wild;
      ctx.fillStyle = "#2b1d14";
      ctx.fillRect(x - 6, y - 26, 12, 30);
      ctx.fillRect(x - 9, y + 1, 18, 5);
      ctx.fillStyle = "#a9b2c0";
      ctx.fillRect(x - 5, y - 24, 10, 27);
      ctx.fillStyle = "#7d8696";
      ctx.fillRect(x + 1, y - 24, 4, 27);
      ctx.fillStyle = "#c4cbd6";
      ctx.fillRect(x - 3, y - 28, 6, 4);
      ctx.fillStyle = "#8d96a6";
      ctx.fillRect(x - 8, y + 2, 16, 3);
      ctx.globalAlpha = 0.55 + Math.sin(t * 3 + st.id) * 0.35;
      ctx.fillStyle = fac.light;
      ctx.fillRect(x - 1, y - 20, 2, 3);
      ctx.fillRect(x - 1, y - 14, 2, 3);
      ctx.fillRect(x - 1, y - 8, 2, 3);
      ctx.globalAlpha = 1;
    }
  }

  function drawChest(c, t) {
    const x = Math.round(c.x);
    const y = Math.round(c.y);
    shadow(x, y + 4, 9, 3);
    ctx.fillStyle = "#6b3f1d";
    ctx.fillRect(x - 8, y - 8, 16, 11);
    ctx.fillStyle = "#9a5d2c";
    ctx.fillRect(x - 7, y - 7, 14, 4);
    ctx.fillStyle = "#e8b84a";
    ctx.fillRect(x - 8, y - 4, 16, 2);
    ctx.fillRect(x - 1, y - 5, 3, 4);
    const gl = (Math.sin(t * 3) + 1) / 2;
    ctx.fillStyle = `rgba(255,230,120,${0.3 + gl * 0.5})`;
    ctx.fillRect(x + 4 + gl * 2, y - 12 - gl * 2, 2, 2);
  }

  function drawStructBars(st, world) {
    const x = st.x;
    const top = st.y - artTop(st) - 22;
    const w = 44;
    if (st.ruined) {
      if (st.rebuild > 0) {
        const p = st.rebuild / (st.maxHp * 0.45);
        bar(x - w / 2, top + 22, w, 4, p, "#e8c06a");
      }
      return;
    }
    const fac = CS.FACTIONS[world.owners[st.owner].faction];
    bar(x - w / 2, top + 22, w, 4, st.hp / st.maxHp, fac.light);
    // 等级星与守军
    ctx.fillStyle = "#ffd96a";
    for (let i = 0; i < st.level; i++) ctx.fillRect(x - w / 2 + i * 5, top + 16, 3, 3);
    if (st.owner === "p") {
      // 守军旗标排在城头，可直接拖出去
      const n = st.garrison.length;
      for (let i = 0; i < n; i++) {
        const sq = st.garrison[i];
        const bx = x + (i - (n - 1) / 2) * 17;
        const by = top + 4;
        const full = sq.st.hp * sq.units.length > 0 ? CS.squadHp(sq).hp / (sq.st.hp * Math.max(sq.units.length, sq.st.size)) : 0;
        drawBadge(bx, by, 7, sq, world.owners.p.faction, fac, full, false);
        sq.tagX = bx;
        sq.tagY = by;
      }
    } else {
      for (let i = 0; i < st.garrison.length; i++) {
        ctx.fillStyle = "#1a120c";
        ctx.fillRect(x + w / 2 - 4 - i * 5 - 1, top + 15, 5, 5);
        ctx.fillStyle = fac.light;
        ctx.fillRect(x + w / 2 - 4 - i * 5, top + 16, 3, 3);
      }
    }
    if (st.queue.length) {
      const q = st.queue[0];
      bar(x - w / 2, top + 28, w, 2, q.t / q.total, "#ffe7a8");
    }
  }

  function bar(x, y, w, h, p, col) {
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, w + 2, h + 2);
    ctx.fillStyle = col;
    ctx.fillRect(Math.round(x), Math.round(y), Math.max(0, Math.round(w * Math.max(0, Math.min(1, p)))), h);
  }

  function drawProj(p) {
    const k01 = Math.min(1, p.t / p.dur);
    const arc = p.k === "stone" ? 46 : p.k === "arrow" ? 14 : 4;
    const lift = Math.sin(k01 * Math.PI) * arc * Math.min(1, p.dur * 2);
    const x = p.x;
    const y = p.y - lift;
    if (p.k === "arrow") {
      const vx = p.tx - p.sx;
      const vy = p.ty - p.sy - arc * Math.cos(k01 * Math.PI) * 2;
      const l = Math.hypot(vx, vy) || 1;
      ctx.strokeStyle = "#3a2616";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - (vx / l) * 6, y - (vy / l) * 6);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.fillStyle = "#e8e0cc";
      ctx.fillRect(x - 0.5, y - 0.5, 1.5, 1.5);
    } else if (p.k === "stone") {
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, 3, 1.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#8c8780";
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#b8b3ab";
      ctx.fillRect(x - 1.5, y - 1.5, 1.5, 1.5);
    } else {
      const fac = CS.FACTIONS[p.faction] || CS.FACTIONS.wild;
      ctx.fillStyle = fac.light;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 小像素块
  function dot(x, y, w, h, col) { ctx.fillStyle = col; ctx.fillRect(Math.round(x), Math.round(y), w, h); }

  function drawEffect(ef, t, world) {
    const sp = CS.SPELLS[ef.key];
    const life = (ef.until - t) / sp.dur;
    const age = t - ef.start;
    const fade = Math.max(0, Math.min(1, life * 4, age * 5));
    const fac = CS.FACTIONS[world.owners[ef.owner].faction];
    const seedBase = ef.start * 13;
    if (ef.kind === "banner") {
      // 地面光圈 + 向外扩散的脉冲
      const pulse = 0.5 + Math.sin(t * 4) * 0.5;
      ctx.globalAlpha = (0.12 + pulse * 0.06) * fade;
      ctx.fillStyle = fac.color;
      ctx.beginPath();
      ctx.ellipse(ef.x, ef.y, ef.r, ef.r * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.75 * fade;
      ctx.strokeStyle = fac.light;
      ctx.setLineDash([5, 5]);
      ctx.lineDashOffset = -t * 20;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
      const ring = (t * 0.6) % 1;
      const pr = ef.r * (0.2 + ring * 0.8);
      ctx.globalAlpha = 0.5 * fade * (1 - ring);
      ctx.beginPath();
      ctx.ellipse(ef.x, ef.y, pr, pr * 0.7, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = fade;
      // 粒子：治疗十字 / 嗜血火星 / 霜花
      for (let i = 0; i < 16; i++) {
        const seed = i * 97.13 + seedBase;
        const ph = (t * 0.7 + (seed % 1)) % 1;
        const a = seed * 2.4;
        const rr = ((seed * 7.7) % 1) * ef.r * 0.9;
        const px0 = ef.x + Math.cos(a) * rr;
        const py0 = ef.y + Math.sin(a) * rr * 0.7;
        if (ef.key === "heal") {
          const y = py0 - ph * 24;
          dot(px0 - 1, y - 3, 2, 6, "#bff59c");
          dot(px0 - 3, y - 1, 6, 2, "#bff59c");
        } else if (ef.key === "lust") {
          dot(px0, py0 - ph * 30, 2, 2, ph < 0.5 ? "#ffd27a" : "#ff6a3a");
        } else {
          const y = py0 - 24 + ph * 28;
          dot(px0 - 1, y, 3, 1, "#eefbff");
          dot(px0, y - 1, 1, 3, "#eefbff");
        }
      }
      ctx.globalAlpha = 1;
      // 大旗（像素风）
      const bx = Math.round(ef.x);
      const by = Math.round(ef.y);
      dot(bx - 1, by - 40, 4, 42, "#3f2631");
      dot(bx, by - 39, 2, 40, "#8a5a32");
      dot(bx - 2, by - 43, 6, 4, "#ffd96a");
      const w = Math.round(Math.sin(t * 5) * 1.5);
      dot(bx + 2, by - 38, 20, 16 + w, "#3f2631");
      dot(bx + 3, by - 37, 18, 14 + w, fac.color);
      dot(bx + 3, by - 37, 18, 2, fac.light);
      const icon = ef.key === "heal" ? "#bff59c" : ef.key === "lust" ? "#ffb08a" : "#eefbff";
      dot(bx + 10, by - 34, 3, 9, icon);
      dot(bx + 7, by - 31, 9, 3, icon);
    } else if (ef.key === "fire") {
      // 焦土 + 火球雨
      ctx.globalAlpha = 0.22 * fade;
      ctx.fillStyle = "#ff6a2a";
      ctx.beginPath();
      ctx.ellipse(ef.x, ef.y, ef.r, ef.r * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.4 * fade;
      ctx.fillStyle = "#3a1a0a";
      ctx.beginPath();
      ctx.ellipse(ef.x, ef.y, ef.r * 0.7, ef.r * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = fade;
      for (let i = 0; i < 12; i++) {
        const seed = i * 53.71 + seedBase;
        const ph = (t * 1.3 + (seed % 1)) % 1;
        const a = seed * 2.4;
        const rr = ((seed * 3.3) % 1) * ef.r * 0.85;
        const gx = ef.x + Math.cos(a) * rr;
        const gy = ef.y + Math.sin(a) * rr * 0.7;
        if (ph < 0.6) {
          const k2 = ph / 0.6;
          const fx = gx + 30 * (1 - k2);
          const fy = gy - 90 * (1 - k2);
          dot(fx + 4, fy - 6, 2, 2, "rgba(255,140,40,0.5)");
          dot(fx + 2, fy - 3, 3, 3, "rgba(255,170,60,0.7)");
          dot(fx - 2, fy - 2, 5, 5, "#3f2631");
          dot(fx - 1, fy - 1, 3, 3, "#ffe68a");
        } else {
          const k2 = (ph - 0.6) / 0.4;
          const r = 3 + k2 * 9;
          ctx.globalAlpha = fade * (1 - k2);
          dot(gx - r, gy - r * 0.6, r * 2, r * 1.2, "#ff7a2a");
          dot(gx - r * 0.5, gy - r * 0.4, r, r * 0.7, "#ffe68a");
          ctx.globalAlpha = fade;
        }
      }
      ctx.globalAlpha = 1;
    } else {
      // 暴风雪：白色地面 + 旋涡 + 斜飞的雪
      ctx.globalAlpha = 0.25 * fade;
      ctx.fillStyle = "#e6f6ff";
      ctx.beginPath();
      ctx.ellipse(ef.x, ef.y, ef.r, ef.r * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.6 * fade;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(ef.x, ef.y, ef.r * 0.6, ef.r * 0.42, t * 0.8, 0, Math.PI * 1.2);
      ctx.stroke();
      ctx.globalAlpha = fade;
      for (let i = 0; i < 46; i++) {
        const seed = i * 31.7 + seedBase;
        const ph = (t * 1.1 + (seed % 1)) % 1;
        const a = seed * 2.4;
        const rr = ((seed * 7.7) % 1) * ef.r;
        const px0 = ef.x + Math.cos(a) * rr;
        const py0 = ef.y + Math.sin(a) * rr * 0.7;
        const x = px0 - 18 + ph * 36;
        const y = py0 - 26 + ph * 30;
        dot(x, y, 3, 1, "rgba(250,254,255,0.9)");
        dot(x - 3, y - 1, 3, 1, "rgba(250,254,255,0.35)");
      }
      ctx.globalAlpha = 1;
    }
  }

  function drawFx(f, t) {
    const age = (t - f.t) / f.life;
    if (age < 0 || age > 1) return;
    if (f.k === "boom") {
      ctx.fillStyle = `rgba(120,100,80,${0.5 * (1 - age)})`;
      ctx.beginPath();
      ctx.ellipse(f.x, f.y, f.r * (0.5 + age), f.r * (0.3 + age * 0.5), 0, 0, Math.PI * 2);
      ctx.fill();
      for (let i = 0; i < 6; i++) {
        const a = i * 1.05;
        ctx.fillStyle = "#7a6a58";
        ctx.fillRect(f.x + Math.cos(a) * age * 18, f.y - Math.sin(age * Math.PI) * 10 + Math.sin(a) * age * 8, 2, 2);
      }
    } else if (f.k === "burst") {
      const fac = CS.FACTIONS[f.faction] || CS.FACTIONS.wild;
      ctx.globalAlpha = 1 - age;
      ctx.strokeStyle = fac.light;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(f.x, f.y, f.r * age + 2, (f.r * age + 2) * 0.7, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (f.k === "smite") {
      // 光柱 + 白闪 + 冲击波 + 碎屑
      const a = 1 - age;
      ctx.globalAlpha = a;
      const w = 26 * (1 - age * 0.7);
      const gr = ctx.createLinearGradient(f.x, f.y - 260, f.x, f.y);
      gr.addColorStop(0, "rgba(255,250,210,0)");
      gr.addColorStop(1, "rgba(255,245,190,1)");
      ctx.fillStyle = gr;
      ctx.fillRect(f.x - w / 2, f.y - 260, w, 260);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillRect(f.x - w / 5, f.y - 260, w / 2.5, 260);
      if (age < 0.15) { ctx.globalAlpha = (0.15 - age) * 3; ctx.fillStyle = "#fffbe0"; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = a; }
      ctx.strokeStyle = "#fff2a8";
      ctx.lineWidth = 3 * a + 1;
      ctx.beginPath();
      ctx.ellipse(f.x, f.y, f.r * (0.3 + age * 1.4), f.r * 0.6 * (0.3 + age * 1.4), 0, 0, Math.PI * 2);
      ctx.stroke();
      for (let i = 0; i < 12; i++) {
        const an = i * 0.52;
        dot(f.x + Math.cos(an) * age * 46, f.y - Math.sin(age * Math.PI) * 18 + Math.sin(an) * age * 22, 3, 3, i % 2 ? "#fff2a8" : "#ffd96a");
      }
      ctx.globalAlpha = 1;
    } else if (f.k === "freeze") {
      // 冰面 + 一圈冰刺破土
      ctx.globalAlpha = 1 - age;
      ctx.fillStyle = "rgba(190,240,255,0.45)";
      ctx.beginPath();
      ctx.ellipse(f.x, f.y, f.r, f.r * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
      const grow = Math.min(1, age * 4);
      for (let i = 0; i < 14; i++) {
        const an = i * 0.449 + 0.2;
        const rr = f.r * (0.35 + (i % 3) * 0.25);
        const sx2 = f.x + Math.cos(an) * rr;
        const sy2 = f.y + Math.sin(an) * rr * 0.7;
        const h = Math.round((8 + (i % 4) * 4) * grow);
        dot(sx2 - 3, sy2 - h - 1, 6, h + 1, "#3f2631");
        dot(sx2 - 2, sy2 - h, 4, h, "#a9e6ff");
        dot(sx2 - 1, sy2 - h, 1, h, "#f2fcff");
      }
      ctx.globalAlpha = 1;
    } else if (f.k === "advent" || f.k === "worms") {
      // 传送门：双环 + 光柱 / 土浪
      const col = f.k === "advent" ? "#fff2b0" : "#c49a62";
      ctx.globalAlpha = 1 - age;
      ctx.strokeStyle = col;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(f.x, f.y, 10 + age * 50, (10 + age * 50) * 0.6, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(f.x, f.y, 30 - age * 20, (30 - age * 20) * 0.6, -t * 3, 0, Math.PI * 1.5);
      ctx.stroke();
      if (f.k === "advent") {
        ctx.fillStyle = "rgba(255,250,215,0.55)";
        ctx.fillRect(f.x - 14 * (1 - age), f.y - 220, 28 * (1 - age), 220);
      }
      for (let i = 0; i < 10; i++) dot(f.x + Math.cos(i * 0.63) * 34 * age, f.y - age * 30 - (i % 3) * 6, 2, 2, col);
      ctx.globalAlpha = 1;
    } else if (f.k === "cast") {
      // 施法符文圈
      const fac = CS.FACTIONS[f.faction] || CS.FACTIONS.wild;
      ctx.globalAlpha = 1 - age;
      ctx.strokeStyle = fac.light;
      ctx.lineWidth = 2;
      const r = f.r * (0.4 + age * 0.7);
      ctx.beginPath();
      ctx.ellipse(f.x, f.y, r, r * 0.7, 0, 0, Math.PI * 2);
      ctx.stroke();
      for (let i = 0; i < 6; i++) {
        const an = i * 1.047 + age * 2;
        dot(f.x + Math.cos(an) * r - 2, f.y + Math.sin(an) * r * 0.7 - 2, 4, 4, fac.light);
      }
      ctx.globalAlpha = 1;
    } else if (f.k === "poof") {
      ctx.fillStyle = `rgba(230,230,230,${0.6 * (1 - age)})`;
      ctx.beginPath();
      ctx.arc(f.x, f.y - 6 - age * 8, 3 + age * 6, 0, Math.PI * 2);
      ctx.fill();
    } else if (f.k === "charge") {
      ctx.fillStyle = `rgba(255,224,138,${1 - age})`;
      ctx.font = "bold 8px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("冲锋!", f.x, f.y - age * 10);
    } else if (f.k === "text") {
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.lineWidth = 3;
      ctx.strokeStyle = `rgba(30,20,10,${1 - age})`;
      ctx.strokeText(f.text, f.x, f.y - age * 20);
      ctx.fillStyle = f.color || "#ffe28a";
      ctx.globalAlpha = 1 - age;
      ctx.fillText(f.text, f.x, f.y - age * 20);
      ctx.globalAlpha = 1;
    } else if (f.k === "build") {
      ctx.strokeStyle = `rgba(255,230,140,${1 - age})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(f.x, f.y, 10 + age * 30, (10 + age * 30) * 0.6, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
})(typeof window !== "undefined" ? window : globalThis);
