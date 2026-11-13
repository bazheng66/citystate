// Canvas 2D 渲染 v3：相机（平移 / 缩放）+ 分块烘焙地形（三级 LOD）+ 视锥裁剪
// + 按 y 排序的实体 + 粒子 / 昼夜光照 / 天气 / 云影 / 战争迷雾 + 小地图。
// CS.RF 是渲染开关，压力测试做消融对比时逐项关掉。
(function (root) {
  "use strict";
  const CS = root.CS;
  const { TILE, T } = CS;

  const R = (CS.render = {});
  let canvas = null;
  let ctx = null;
  let dpr = 1;
  let vw = 2; // 画布像素
  let vh = 2;
  let uk = 1; // 屏幕空间（横幅、暂停遮罩）用的缩放：按 800×500 的逻辑尺寸排版
  let SW = 800;
  let SH = 500;
  let W = CS.W; // 当前地图的世界尺寸
  let H = CS.H;
  let curWorld = null;
  // 相机：x / y 是视野中心（世界坐标），z 是每个世界像素对应多少画布像素；t* 是缓动目标
  const cam = (R.cam = { x: 400, y: 250, z: 1, tx: 400, ty: 250, tz: 1, minZ: 0.3, maxZ: 5, fitZ: 1 });
  let vx0 = 0; // 视野范围（世界坐标）
  let vy0 = 0;
  let vx1 = 0;
  let vy1 = 0;
  const drawList = [];
  const pool = [];
  const byY = (a, b) => a.y - b.y;
  const US = 1.3;
  const RF = (CS.RF = { shadow: 1, unit: 1, tags: 1, corpses: 1, light: 1, particles: 1, weather: 1, clouds: 1, fog: 1, water: 1, lod: 1 });
  const FS = (R.stats = { units: 0, structs: 0, chunks: 0, baked: 0, particles: 0, chunkMP: 0 });
  CS.UNIT_SCALE = US;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const ownCol = (world, id) => { const o = id ? world.owners[id] : null; return o ? o.col : CS.PALETTE[8]; };

  R.init = function (cv) {
    canvas = cv;
    ctx = cv.getContext("2d", { alpha: false });
  };

  // ---------- 相机 ----------
  R.resize = function (cssW, cssH, ratio) {
    dpr = ratio || 1;
    canvas.width = Math.max(2, Math.round(cssW * dpr));
    canvas.height = Math.max(2, Math.round(cssH * dpr));
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    vw = canvas.width;
    vh = canvas.height;
    uk = Math.min(vw / 800, vh / 500);
    SW = vw / uk;
    SH = vh / uk;
    vignette = null;
    if (curWorld) limits();
  };
  function limits() {
    cam.fitZ = Math.min(vw / W, vh / H);
    cam.minZ = cam.fitZ;
    cam.maxZ = Math.max(cam.fitZ * 1.01, dpr * 3.2);
    cam.tz = clamp(cam.tz, cam.minZ, cam.maxZ);
    cam.z = clamp(cam.z, cam.minZ, cam.maxZ);
    clampTarget();
  }
  function clampTarget() {
    const hw = vw / 2 / cam.tz;
    const hh = vh / 2 / cam.tz;
    cam.tx = hw * 2 >= W ? W / 2 : clamp(cam.tx, hw, W - hw);
    cam.ty = hh * 2 >= H ? H / 2 : clamp(cam.ty, hh, H - hh);
  }
  R.setWorld = function (world) {
    curWorld = world;
    W = world.W;
    H = world.H;
    chunks.clear();
    chunkPx = 0;
    FS.baked = 0;
    warm = true;
    mmBase = null;
    fog = null;
    pn = 0;
    lastT = world.t;
    tintCache.clear();
    const B = CS.BIOMES[world.map.biome] || CS.BIOMES.temperate;
    world.weather = B.weather[Math.floor(CS.hash2(world.layout.seed, 3, 77) * B.weather.length)];
    limits();
    const home = world.structs.find((s) => s.owner === "p") || world.structs[0];
    cam.tz = cam.z = W <= 900 ? cam.fitZ : clamp(dpr * 1.5, cam.minZ, cam.maxZ);
    cam.tx = home ? home.x : W / 2;
    cam.ty = home ? home.y - 10 : H / 2;
    clampTarget();
    cam.x = cam.tx;
    cam.y = cam.ty;
  };
  R.camUpdate = function (dtMs) {
    const a = 1 - Math.pow(0.0015, Math.min(100, dtMs) / 260);
    cam.tz = clamp(cam.tz, cam.minZ, cam.maxZ);
    clampTarget();
    cam.z += (cam.tz - cam.z) * a;
    cam.x += (cam.tx - cam.x) * a;
    cam.y += (cam.ty - cam.y) * a;
    if (Math.abs(cam.tz - cam.z) < cam.tz * 0.0008) cam.z = cam.tz;
  };
  R.screenToWorld = (cx, cy) => ({ x: cam.x + (cx * dpr - vw / 2) / cam.z, y: cam.y + (cy * dpr - vh / 2) / cam.z });
  R.worldToScreen = (x, y) => ({ x: ((x - cam.x) * cam.z + vw / 2) / dpr, y: ((y - cam.y) * cam.z + vh / 2) / dpr });
  // 平移：dx / dy 是 CSS 像素；now=true 时立刻到位（拖动地图时不要缓动）
  R.pan = function (dxCss, dyCss, now) {
    cam.tx += (dxCss * dpr) / cam.z;
    cam.ty += (dyCss * dpr) / cam.z;
    clampTarget();
    if (now) { cam.x = cam.tx; cam.y = cam.ty; }
  };
  // 以鼠标所在位置为锚点缩放
  R.zoomAt = function (f, cx, cy) {
    const px = cx * dpr - vw / 2;
    const py = cy * dpr - vh / 2;
    const wx = cam.tx + px / cam.tz;
    const wy = cam.ty + py / cam.tz;
    const z2 = clamp(cam.tz * f, cam.minZ, cam.maxZ);
    cam.tx = wx - px / z2;
    cam.ty = wy - py / z2;
    cam.tz = z2;
    clampTarget();
  };
  R.center = function (x, y, now) {
    cam.tx = x;
    cam.ty = y;
    clampTarget();
    if (now) { cam.x = cam.tx; cam.y = cam.ty; }
  };
  R.setZoom = function (zCss, now) {
    cam.tz = clamp(zCss * dpr, cam.minZ, cam.maxZ);
    clampTarget();
    if (now) { cam.z = cam.tz; cam.x = cam.tx; cam.y = cam.ty; }
  };
  R.zoomCss = () => cam.z / dpr;
  R.fitCss = () => cam.fitZ / dpr;
  // 拉远时旗标按比例放大，保证还能点得中
  R.tagScale = () => clamp(1.05 / (cam.z / dpr), 1, 2.8);
  R.inView = (x, y, m) => x > vx0 - m && x < vx1 + m && y > vy0 - m && y < vy1 + m;
  R.scale = () => cam.z;
  R.invalidate = () => { chunks.clear(); chunkPx = 0; warm = true; };

  let shakeAmt = 0;
  let shakeT = 0;
  R.shake = function (n) {
    const now = performance.now();
    const left = shakeAmt * Math.max(0, 1 - (now - shakeT) / 380);
    shakeAmt = Math.max(left, n);
    shakeT = now;
  };

  // ---------- 地形：按 512 世界像素分块烘焙，三级分辨率 ----------
  const CHUNK = 512;
  const chunks = new Map();
  let chunkPx = 0;
  let frameNo = 0;
  let warm = true; // 换地图后的第一帧：把看得见的块一次烘焙完，避免开局闪色块
  const CHUNK_BUDGET = 44e6; // 缓存的画布像素上限（约 176MB 显存 / 内存）
  const lodFor = (z) => (z > 1.45 ? 2 : z > 0.72 ? 1 : 0.5);
  const tintCache = new Map();
  // 按地貌给树木 / 灌木上色的图块副本
  function tileset(biome) {
    const B = CS.BIOMES[biome];
    if (!B || !B.tint) return CS.IMG.town;
    let c = tintCache.get(biome);
    if (c) return c;
    c = document.createElement("canvas");
    c.width = CS.IMG.town.width;
    c.height = CS.IMG.town.height;
    const g = c.getContext("2d");
    g.drawImage(CS.IMG.town, 0, 0);
    g.globalCompositeOperation = "source-atop";
    g.fillStyle = B.tint;
    g.fillRect(0, 0, c.width, c.height);
    tintCache.set(biome, c);
    return c;
  }
  function px(g, x, y, w, h, col) { g.fillStyle = col; g.fillRect(x, y, w, h); }

  function bakeChunk(lod, cx, cy) {
    const map = curWorld.map;
    const cols = map.cols;
    const rows = map.rows;
    const B = CS.BIOMES[map.biome] || CS.BIOMES.temperate;
    const seed = map.layout.seed | 0;
    const size = CHUNK * lod;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const g = c.getContext("2d");
    g.setTransform(lod, 0, 0, lod, -cx * CHUNK * lod, -cy * CHUNK * lod);
    g.imageSmoothingEnabled = false;
    const img = tileset(map.biome);
    const tile = (i, x, y) => g.drawImage(img, (i % 12) * 16, ((i / 12) | 0) * 16, 16, 16, Math.round(x), Math.round(y), 16, 16);
    const detail = lod >= 1;
    const c0 = Math.max(0, Math.floor((cx * CHUNK) / TILE) - 2);
    const c1 = Math.min(cols - 1, Math.ceil(((cx + 1) * CHUNK) / TILE) + 2);
    const r0 = Math.max(0, Math.floor((cy * CHUNK) / TILE) - 3);
    const r1 = Math.min(rows - 1, Math.ceil(((cy + 1) * CHUNK) / TILE) + 2);
    const edge = map.layout.gen ? T.WATER : T.GRASS;
    const at = (cc, rr) => (cc < 0 || rr < 0 || cc >= cols || rr >= rows ? edge : map.grid[rr * cols + cc]);
    const wet = (v) => v === T.WATER || v === T.BRIDGE;
    const h = (cc, rr, s) => CS.hash2(cc, rr, seed + s);
    const OUT = "#3f2631";

    // 1. 地面：低频噪声分三种深浅，再撒草尖和碎花
    for (let r = r0; r <= r1; r++) {
      for (let cc = c0; cc <= c1; cc++) {
        const x = cc * TILE;
        const y = r * TILE;
        const n = CS.fbm(cc / 5, r / 5, seed + 900);
        g.fillStyle = B.grass[n < 0.43 ? 2 : n < 0.6 ? 0 : 1];
        g.fillRect(x, y, TILE, TILE);
        if (!detail) continue;
        for (let i = 0; i < 3; i++) {
          const k = h(cc, r, 10 + i);
          px(g, x + Math.floor(h(cc, r, 20 + i) * 18), y + Math.floor(h(cc, r, 30 + i) * 18), k < 0.5 ? 2 : 1, k < 0.5 ? 1 : 2, B.speck[k < 0.55 ? 0 : 1]);
        }
      }
    }
    // 2. 土路：外描边 + 土色 + 浅色中线
    const strokeRoads = (width, color) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.lineCap = "round";
      g.lineJoin = "round";
      const x0 = cx * CHUNK - 40;
      const y0 = cy * CHUNK - 40;
      const x1 = (cx + 1) * CHUNK + 40;
      const y1 = (cy + 1) * CHUNK + 40;
      for (const road of map.roads) {
        // 路的包围盒不碰这一块就跳过
        if (!road.bb) {
          let ax = Infinity; let ay = Infinity; let bx = -Infinity; let by = -Infinity;
          for (const p of road) { if (p.x < ax) ax = p.x; if (p.x > bx) bx = p.x; if (p.y < ay) ay = p.y; if (p.y > by) by = p.y; }
          road.bb = [ax, ay, bx, by];
        }
        if (road.bb[2] < x0 || road.bb[0] > x1 || road.bb[3] < y0 || road.bb[1] > y1) continue;
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
    strokeRoads(13, B.road[0]);
    strokeRoads(10, B.road[1]);
    if (detail) strokeRoads(3, B.road[2]);

    // 3. 水：深浅两色 + 沙岸 + 浪花线
    for (let r = r0; r <= r1; r++) {
      for (let cc = c0; cc <= c1; cc++) {
        if (!wet(at(cc, r))) continue;
        const x = cc * TILE;
        const y = r * TILE;
        const n = wet(at(cc, r - 1));
        const s = wet(at(cc, r + 1));
        const w = wet(at(cc - 1, r));
        const e = wet(at(cc + 1, r));
        const deep = n && s && w && e && wet(at(cc - 1, r - 1)) && wet(at(cc + 1, r + 1)) && wet(at(cc + 1, r - 1)) && wet(at(cc - 1, r + 1));
        g.fillStyle = deep ? B.water[1] : B.water[0];
        g.fillRect(x, y, TILE, TILE);
        if (!n) { px(g, x, y, TILE, 4, B.sand); px(g, x, y + 4, TILE, 1, B.water[2]); px(g, x, y - 1, TILE, 1, "rgba(40,30,20,0.35)"); }
        if (!s) { px(g, x, y + TILE - 3, TILE, 3, B.sand); px(g, x, y + TILE - 4, TILE, 1, B.water[2]); }
        if (!w) { px(g, x, y, 3, TILE, B.sand); px(g, x + 3, y, 1, TILE, B.water[2]); }
        if (!e) { px(g, x + TILE - 3, y, 3, TILE, B.sand); px(g, x + TILE - 4, y, 1, TILE, B.water[2]); }
        if (detail && h(cc, r, 41) < 0.35) px(g, x + 3 + Math.floor(h(cc, r, 42) * 10), y + 5 + Math.floor(h(cc, r, 43) * 10), 5, 1, B.water[2]);
      }
    }
    // 4. 桥
    for (let r = r0; r <= r1; r++) {
      for (let cc = c0; cc <= c1; cc++) {
        if (at(cc, r) !== T.BRIDGE) continue;
        const x = cc * TILE;
        const y = r * TILE;
        const vertical = at(cc - 1, r) === T.WATER || at(cc + 1, r) === T.WATER;
        px(g, x, y, TILE, TILE, OUT);
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
    // 5. 草地小装饰：灌木、嫩芽、蘑菇、野花
    if (detail) {
      for (let r = r0; r <= r1; r++) {
        for (let cc = c0; cc <= c1; cc++) {
          if (at(cc, r) !== T.GRASS) continue;
          const d = map.decor[r * cols + cc];
          const x = cc * TILE;
          const y = r * TILE;
          if (d && h(cc, r, 50) < 0.5) tile([5, 17, 29, 17, 5, 29][d - 1], x + Math.floor(h(cc, r, 51) * 6) - 2, y + Math.floor(h(cc, r, 52) * 6) - 4);
          else if (h(cc, r, 53) < 0.09) {
            const fx = x + 3 + Math.floor(h(cc, r, 54) * 12);
            const fy = y + 3 + Math.floor(h(cc, r, 55) * 12);
            const col = ["#fff6d0", "#ffd24a", "#ff9ec4", "#c8e6ff"][Math.floor(h(cc, r, 56) * 4)];
            px(g, fx, fy - 1, 1, 3, col); px(g, fx - 1, fy, 3, 1, col); px(g, fx, fy, 1, 1, "#e08a2a");
          }
        }
      }
    }
    // 6. 岩石：成片的岩地画成带高光的石块
    for (let r = r0; r <= r1; r++) {
      for (let cc = c0; cc <= c1; cc++) {
        if (at(cc, r) !== T.ROCK) continue;
        px(g, cc * TILE, r * TILE + 6, TILE, TILE - 4, "rgba(60,60,70,0.28)");
      }
    }
    for (let r = r0; r <= r1; r++) {
      for (let cc = c0; cc <= c1; cc++) {
        if (at(cc, r) !== T.ROCK) continue;
        const n = 1 + (h(cc, r, 60) < 0.45 ? 1 : 0);
        for (let i = 0; i < n; i++) {
          const w = 10 + Math.floor(h(cc, r, 61 + i) * 9);
          const hh = 8 + Math.floor(h(cc, r, 63 + i) * 8);
          const x = cc * TILE + Math.floor(h(cc, r, 65 + i) * (TILE - w + 4)) - 2;
          const y = r * TILE + TILE - hh - Math.floor(h(cc, r, 67 + i) * 6);
          px(g, x - 1, y + 2, w + 2, hh - 1, OUT);
          px(g, x + 1, y - 1, w - 2, 4, OUT);
          px(g, x, y + 2, w, hh - 3, "#8f98aa");
          px(g, x + 2, y, w - 4, 3, "#b4bccb");
          px(g, x + 1, y + 2, Math.max(2, (w / 2) | 0), 2, "#cfd6e2");
          px(g, x + ((w * 0.6) | 0), y + 3, (w * 0.4) | 0, hh - 4, "#6f7787");
          if (map.biome === "snow") px(g, x + 2, y - 1, w - 4, 2, "#f4fbff");
        }
      }
    }
    // 7. 树林：先铺林下阴影，再从上到下种树（高树 = 上下两块图块）
    for (let r = r0; r <= r1; r++) {
      for (let cc = c0; cc <= c1; cc++) {
        if (at(cc, r) !== T.FOREST) continue;
        px(g, cc * TILE - 1, r * TILE + 3, TILE + 2, TILE, B.forest);
      }
    }
    const orangeP = map.biome === "autumn" ? 0.8 : map.biome === "temperate" ? 0.07 : 0;
    for (let r = r0; r <= r1; r++) {
      for (let cc = c0; cc <= c1; cc++) {
        if (at(cc, r) !== T.FOREST) continue;
        const n = 1 + (h(cc, r, 70) < 0.55 ? 1 : 0);
        for (let i = 0; i < n; i++) {
          const x = cc * TILE + Math.floor(h(cc, r, 71 + i) * 10) - 3;
          const y = r * TILE + Math.floor(h(cc, r, 73 + i) * 8) - 6;
          const orange = h(cc, r, 75 + i) < orangeP;
          g.fillStyle = "rgba(20,40,20,0.3)";
          g.beginPath();
          g.ellipse(x + 8, y + 16, 7, 3, 0, 0, Math.PI * 2);
          g.fill();
          if (h(cc, r, 77 + i) < 0.6) { tile(orange ? 3 : 4, x, y - 16); tile(orange ? 15 : 16, x, y); }
          else tile(orange ? 27 : 28, x, y);
        }
      }
    }
    return { c, used: frameNo, fresh: true };
  }

  function drawTerrain(tx, ty) {
    const z = cam.z;
    const lod = lodFor(z);
    let budget = warm ? 999 : lod === 2 ? 2 : lod === 1 ? 4 : 10;
    const cx0 = Math.max(0, Math.floor(vx0 / CHUNK));
    const cy0 = Math.max(0, Math.floor(vy0 / CHUNK));
    const cx1 = Math.min(Math.ceil(W / CHUNK) - 1, Math.floor(vx1 / CHUNK));
    const cy1 = Math.min(Math.ceil(H / CHUNK) - 1, Math.floor(vy1 / CHUNK));
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "low";
    let n = 0;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = lod + ":" + cx + ":" + cy;
        let ch = chunks.get(key);
        if (!ch && budget > 0) {
          ch = bakeChunk(lod, cx, cy);
          chunks.set(key, ch);
          chunkPx += ch.c.width * ch.c.height;
          FS.baked++;
          budget--;
        }
        // 这一帧来不及烘焙：先用别的分辨率顶一下
        if (!ch) ch = chunks.get("1:" + cx + ":" + cy) || chunks.get("0.5:" + cx + ":" + cy) || chunks.get("2:" + cx + ":" + cy);
        if (!ch) continue;
        ch.used = frameNo;
        const dx0 = Math.round(cx * CHUNK * z) + tx;
        const dy0 = Math.round(cy * CHUNK * z) + ty;
        const dx1 = Math.round((cx + 1) * CHUNK * z) + tx;
        const dy1 = Math.round((cy + 1) * CHUNK * z) + ty;
        ctx.drawImage(ch.c, 0, 0, ch.c.width, ch.c.height, dx0, dy0, dx1 - dx0, dy1 - dy0);
        n++;
      }
    }
    warm = false;
    FS.chunks = n;
    // 超出预算就丢掉最久没用的块
    if (chunkPx > CHUNK_BUDGET) {
      const old = Array.from(chunks.entries()).filter(([, ch]) => ch.used < frameNo).sort((a, b) => a[1].used - b[1].used);
      for (const [key, ch] of old) {
        if (chunkPx <= CHUNK_BUDGET * 0.8) break;
        chunkPx -= ch.c.width * ch.c.height;
        ch.c.width = ch.c.height = 0; // 立刻释放显存
        chunks.delete(key);
      }
    }
    FS.chunkMP = +(chunkPx / 1e6).toFixed(1);
  }

  // 水面波光：只给看得见的水格画几道会动的亮线
  function drawWater(world, t) {
    const map = world.map;
    const cols = map.cols;
    const B = CS.BIOMES[map.biome] || CS.BIOMES.temperate;
    const c0 = Math.max(0, Math.floor(vx0 / TILE));
    const c1 = Math.min(cols - 1, Math.floor(vx1 / TILE));
    const r0 = Math.max(0, Math.floor(vy0 / TILE));
    const r1 = Math.min(map.rows - 1, Math.floor(vy1 / TILE));
    ctx.fillStyle = B.water[2];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (map.grid[r * cols + c] !== T.WATER) continue;
        const k = CS.hash2(c, r, 5);
        if (k > 0.22) continue;
        const ph = (t * 0.45 + k * 31) % 1;
        const a = Math.sin(ph * Math.PI);
        if (a < 0.15) continue;
        ctx.globalAlpha = a * 0.8;
        ctx.fillRect(c * TILE + 2 + ph * 9, r * TILE + 4 + ((k * 97) % 1) * 11, 6, 1);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---------- 粒子（纯视觉，不进模拟）----------
  const PMAX = 4000;
  const P = {
    x: new Float32Array(PMAX), y: new Float32Array(PMAX), vx: new Float32Array(PMAX), vy: new Float32Array(PMAX),
    life: new Float32Array(PMAX), max: new Float32Array(PMAX), size: new Float32Array(PMAX), g: new Float32Array(PMAX), col: new Uint8Array(PMAX),
  };
  let pn = 0;
  let lastT = 0;
  const PCOL = ["#fff2b0", "#ffd24a", "#ff9a3a", "#e5482f", "#b02a20", "#7a6a58", "#b8ab98", "#e9e2d2", "#5a5550", "#3a3632",
    "#bff59c", "#9fdc7c", "#a9e6ff", "#eefbff", "#c88aff", "#ffffff", "#8a5a32", "#c48a4e", "#6fbf5a", "#e0a92a"];
  const KIND = {
    spark: { cols: [0, 1, 15], n: 3, sp: 46, life: 0.28, size: 1.6, g: 60, up: 20 },
    blood: { cols: [3, 4], n: 4, sp: 34, life: 0.45, size: 1.8, g: 160, up: 40 },
    dust: { cols: [5, 6], n: 2, sp: 12, life: 0.7, size: 2.6, g: -8, up: 6 },
    debris: { cols: [5, 8, 16, 6], n: 10, sp: 70, life: 0.8, size: 2.4, g: 220, up: 80 },
    smoke: { cols: [8, 9, 5], n: 5, sp: 10, life: 1.6, size: 4, g: -22, up: 14 },
    ember: { cols: [1, 2, 3], n: 1, sp: 14, life: 1.1, size: 1.5, g: -40, up: 20 },
    star: { cols: [0, 1, 15], n: 14, sp: 60, life: 0.9, size: 2, g: 60, up: 70 },
    heal: { cols: [10, 11], n: 8, sp: 20, life: 0.9, size: 2, g: -30, up: 20 },
    ice: { cols: [12, 13], n: 12, sp: 60, life: 0.7, size: 2, g: 120, up: 50 },
    magic: { cols: [14, 13, 15], n: 6, sp: 40, life: 0.5, size: 1.8, g: 0, up: 10 },
    leaf: { cols: [18, 19, 11], n: 10, sp: 50, life: 1.0, size: 2, g: 30, up: 40 },
    fire: { cols: [1, 2, 3, 0], n: 10, sp: 55, life: 0.6, size: 2.4, g: -50, up: 40 },
    gold: { cols: [1, 0, 19], n: 12, sp: 50, life: 0.9, size: 2, g: 150, up: 90 },
  };
  // 在世界坐标 (x, y) 处喷一把粒子；看不见的地方直接不喷
  R.burst = function (kind, x, y, mult) {
    if (!RF.particles) return;
    if (x < vx0 - 30 || x > vx1 + 30 || y < vy0 - 30 || y > vy1 + 30) return;
    if (cam.z / dpr < 0.5) return; // 拉到最远时粒子比一个像素还小
    const K = KIND[kind];
    if (!K) return;
    const n = Math.max(1, Math.round(K.n * (mult || 1)));
    for (let i = 0; i < n; i++) {
      if (pn >= PMAX) return;
      const a = Math.random() * Math.PI * 2;
      const sp = K.sp * (0.35 + Math.random() * 0.65);
      const k = pn++;
      P.x[k] = x + (Math.random() - 0.5) * 4;
      P.y[k] = y + (Math.random() - 0.5) * 3;
      P.vx[k] = Math.cos(a) * sp;
      P.vy[k] = Math.sin(a) * sp * 0.6 - K.up * Math.random();
      P.life[k] = P.max[k] = K.life * (0.6 + Math.random() * 0.6);
      P.size[k] = K.size * (0.7 + Math.random() * 0.6);
      P.g[k] = K.g;
      P.col[k] = K.cols[(Math.random() * K.cols.length) | 0];
    }
  };
  function drawParticles(dt) {
    let last = -1;
    let lastA = 1;
    for (let i = 0; i < pn; i++) {
      P.life[i] -= dt;
      if (P.life[i] <= 0) {
        // 用最后一个补位
        const j = --pn;
        P.x[i] = P.x[j]; P.y[i] = P.y[j]; P.vx[i] = P.vx[j]; P.vy[i] = P.vy[j];
        P.life[i] = P.life[j]; P.max[i] = P.max[j]; P.size[i] = P.size[j]; P.g[i] = P.g[j]; P.col[i] = P.col[j];
        i--;
        continue;
      }
      P.vy[i] += P.g[i] * dt;
      P.x[i] += P.vx[i] * dt;
      P.y[i] += P.vy[i] * dt;
      const x = P.x[i];
      const y = P.y[i];
      if (x < vx0 || x > vx1 || y < vy0 || y > vy1) continue;
      const a = P.life[i] / P.max[i] > 0.45 ? 1 : P.life[i] / P.max[i] > 0.2 ? 0.6 : 0.3;
      if (a !== lastA) { ctx.globalAlpha = a; lastA = a; }
      if (P.col[i] !== last) { last = P.col[i]; ctx.fillStyle = PCOL[last]; }
      const s = P.size[i];
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
    FS.particles = pn;
  }

  // ---------- 战争迷雾 ----------
  // 40px 一格：vis = 现在看得见，seen = 曾经看见过。画的时候把小画布双线性放大，边缘自然是软的。
  let fog = null;
  const FOG_CELL = 40;
  function fogInit(world) {
    const cw = Math.ceil(W / FOG_CELL);
    const ch = Math.ceil(H / FOG_CELL);
    const c = document.createElement("canvas");
    c.width = cw;
    c.height = ch;
    const g = c.getContext("2d");
    const img = g.createImageData(cw, ch);
    for (let i = 0; i < cw * ch; i++) { img.data[i * 4] = 8; img.data[i * 4 + 1] = 10; img.data[i * 4 + 2] = 18; img.data[i * 4 + 3] = 238; }
    fog = { cw, ch, c, g, img, vis: new Uint8Array(cw * ch), seen: new Uint8Array(cw * ch), a: new Float32Array(cw * ch).fill(0.93), tick: 0 };
    void world;
  }
  function fogStamp(x, y, rad) {
    const F = fog;
    const c0 = Math.max(0, Math.floor((x - rad) / FOG_CELL));
    const c1 = Math.min(F.cw - 1, Math.floor((x + rad) / FOG_CELL));
    const r0 = Math.max(0, Math.floor((y - rad) / FOG_CELL));
    const r1 = Math.min(F.ch - 1, Math.floor((y + rad) / FOG_CELL));
    const r2 = rad * rad;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const dx = (c + 0.5) * FOG_CELL - x;
        const dy = (r + 0.5) * FOG_CELL - y;
        if (dx * dx + dy * dy <= r2) { F.vis[r * F.cw + c] = 1; F.seen[r * F.cw + c] = 1; }
      }
    }
  }
  function fogUpdate(world) {
    if (!fog) fogInit(world);
    const F = fog;
    F.vis.fill(0);
    for (const st of world.structs) if (st.owner === "p" && !st.ruined) fogStamp(st.x, st.y, 250);
    for (const sq of world.squads) {
      if (sq.owner !== "p" || sq.inside || !sq.units.length) continue;
      fogStamp(sq.x, sq.y, sq.st.proj ? 200 : 170);
    }
    const d = F.img.data;
    for (let i = 0; i < F.vis.length; i++) {
      const target = F.vis[i] ? 0 : F.seen[i] ? 0.5 : 0.93;
      F.a[i] += (target - F.a[i]) * 0.45;
      d[i * 4 + 3] = (F.a[i] * 255) | 0;
    }
    F.g.putImageData(F.img, 0, 0);
  }
  let fogOn = false;
  // 这个位置现在看得见吗（没开迷雾时永远为真）
  R.visible = function (x, y) {
    if (!fogOn || !fog) return true;
    const c = Math.floor(x / FOG_CELL);
    const r = Math.floor(y / FOG_CELL);
    if (c < 0 || r < 0 || c >= fog.cw || r >= fog.ch) return false;
    return fog.vis[r * fog.cw + c] === 1;
  };
  R.seen = function (x, y) {
    if (!fogOn || !fog) return true;
    const c = Math.floor(x / FOG_CELL);
    const r = Math.floor(y / FOG_CELL);
    if (c < 0 || r < 0 || c >= fog.cw || r >= fog.ch) return false;
    return fog.seen[r * fog.cw + c] === 1;
  };

  // ---------- 昼夜与光照 ----------
  const DAY = [255, 255, 255, 0];
  const DUSK = [255, 204, 158, 0.3];
  const NIGHT = [112, 130, 196, 1];
  const DAWN = [255, 214, 192, 0.3];
  const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k];
  // 一昼夜 260 秒：白天占一半多，黄昏和黎明各有一段过渡
  function daylight(t) {
    const p = (t / 260 + 0.1) % 1;
    if (p < 0.52) return DAY;
    if (p < 0.6) return mix(DAY, DUSK, (p - 0.52) / 0.08);
    if (p < 0.68) return mix(DUSK, NIGHT, (p - 0.6) / 0.08);
    if (p < 0.88) return NIGHT;
    if (p < 0.94) return mix(NIGHT, DAWN, (p - 0.88) / 0.06);
    return mix(DAWN, DAY, (p - 0.94) / 0.06);
  }
  R.daylight = daylight;
  const glows = new Map();
  function glow(rgb) {
    let c = glows.get(rgb);
    if (c) return c;
    c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    const gr = g.createRadialGradient(64, 64, 2, 64, 64, 64);
    gr.addColorStop(0, "rgba(" + rgb + ",0.62)");
    gr.addColorStop(0.35, "rgba(" + rgb + ",0.26)");
    gr.addColorStop(1, "rgba(" + rgb + ",0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 128);
    glows.set(rgb, c);
    return c;
  }
  const hexRgb = (hex) => parseInt(hex.slice(1, 3), 16) + "," + parseInt(hex.slice(3, 5), 16) + "," + parseInt(hex.slice(5, 7), 16);
  function light(rgb, x, y, r) {
    if (x < vx0 - r || x > vx1 + r || y < vy0 - r || y > vy1 + r) return;
    ctx.drawImage(glow(rgb), x - r, y - r * 0.8, r * 2, r * 1.6);
  }
  function drawLighting(world, t, L) {
    const dark = L[3];
    // 整屏正片叠底：把画面染成黄昏 / 夜色
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = "rgb(" + (L[0] | 0) + "," + (L[1] | 0) + "," + (L[2] | 0) + ")";
    ctx.fillRect(0, 0, vw, vh);
    // 灯火：加色叠在夜色上
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = Math.min(1, dark * 0.95);
    setWorldTransform();
    for (const st of world.structs) {
      if (st.ruined || !st.owner) continue;
      if (fogOn && !R.seen(st.x, st.y)) continue;
      const fl = 1 + Math.sin(t * 7 + st.id) * 0.04;
      light("255,186,104", st.x, st.y - 12, (st.R + 78) * fl);
      if (st.type === "tower") light(hexRgb(ownCol(world, st.owner).light), st.x, st.y - CS.artTop(st) - 6, 46);
      for (let i = 0; i < 3; i++) {
        if (st.addons[i] === "obelisk") light("150,200,255", st.x + CS.SLOT_OFFSETS[i][0], st.y + CS.SLOT_OFFSETS[i][1] - 14, 30);
        else if (st.addons[i]) light("255,186,104", st.x + CS.SLOT_OFFSETS[i][0], st.y + CS.SLOT_OFFSETS[i][1] - 6, 26);
      }
      if (st.hp < st.maxHp * 0.3) light("255,120,50", st.x - 12, st.y - 14, 60 + Math.sin(t * 13 + st.id) * 8);
    }
    for (const ef of world.effects) {
      const fac = CS.FACTIONS[world.owners[ef.owner].faction];
      light(ef.key === "fire" ? "255,130,50" : hexRgb(fac.light), ef.x, ef.y, ef.r * 1.1);
    }
    for (const p of world.proj) if (p.k === "bolt") light("200,220,255", p.x, p.y - 4, 18);
    for (const f of world.fx) if (f.k === "smite" || f.k === "advent") light("255,245,190", f.x, f.y - 20, 120);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  // 云影：几团很淡的深色椭圆慢慢飘过
  let cloudImg = null;
  function drawClouds(world, t, dark) {
    if (!cloudImg) {
      cloudImg = document.createElement("canvas");
      cloudImg.width = cloudImg.height = 128;
      const g = cloudImg.getContext("2d");
      const gr = g.createRadialGradient(64, 64, 6, 64, 64, 64);
      gr.addColorStop(0, "rgba(14,22,44,0.5)");
      gr.addColorStop(0.6, "rgba(14,22,44,0.26)");
      gr.addColorStop(1, "rgba(14,22,44,0)");
      g.fillStyle = gr;
      g.fillRect(0, 0, 128, 128);
    }
    const n = Math.max(3, Math.round((W * H) / 700000));
    ctx.globalAlpha = 0.34 * (1 - dark * 0.8);
    const seed = world.layout.seed | 0;
    for (let i = 0; i < n; i++) {
      const sz = 320 + CS.hash2(i, 1, seed) * 360;
      const span = W + sz * 2;
      const x = ((CS.hash2(i, 2, seed) * span + t * (7 + CS.hash2(i, 3, seed) * 9)) % span) - sz;
      const y = CS.hash2(i, 4, seed) * H;
      if (x + sz < vx0 || x - sz > vx1 || y + sz * 0.6 < vy0 || y - sz * 0.6 > vy1) continue;
      ctx.drawImage(cloudImg, x - sz, y - sz * 0.55, sz * 2, sz * 1.1);
    }
    ctx.globalAlpha = 1;
  }

  // 天气：屏幕空间，位置直接由时间算出来，不存状态
  function drawWeather(world, t) {
    const kind = world.weather;
    if (!kind || kind === "none") return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const n = kind === "rain" ? 150 : kind === "snow" ? 170 : 70;
    const u = dpr;
    if (kind === "rain") {
      ctx.fillStyle = "rgba(30,50,84,0.1)";
      ctx.fillRect(0, 0, vw, vh);
      ctx.strokeStyle = "rgba(200,225,255,0.4)";
      ctx.lineWidth = u;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const sp = 900 + CS.hash2(i, 9, 1) * 500;
        const y = ((CS.hash2(i, 7, 1) * vh + t * sp * u) % (vh + 40)) - 20;
        const x = ((CS.hash2(i, 8, 1) * vw - t * sp * 0.22 * u) % vw + vw) % vw;
        ctx.moveTo(x, y);
        ctx.lineTo(x - 3 * u, y + 13 * u);
      }
      ctx.stroke();
      return;
    }
    for (let i = 0; i < n; i++) {
      const h1 = CS.hash2(i, 7, 2);
      const h2 = CS.hash2(i, 8, 2);
      const h3 = CS.hash2(i, 9, 2);
      if (kind === "snow") {
        const y = ((h1 * vh + t * (38 + h3 * 40) * u) % (vh + 10)) - 5;
        const x = ((h2 * vw + Math.sin(t * 0.8 + i) * 18 * u + t * 12 * u) % vw + vw) % vw;
        ctx.fillStyle = h3 < 0.5 ? "rgba(255,255,255,0.85)" : "rgba(235,245,255,0.55)";
        const s = (1.4 + h3 * 1.6) * u;
        ctx.fillRect(x, y, s, s);
      } else if (kind === "leaves") {
        const y = ((h1 * vh + t * (30 + h3 * 30) * u) % (vh + 10)) - 5;
        const x = ((h2 * vw + t * (40 + h3 * 30) * u + Math.sin(t * 1.5 + i) * 24 * u) % vw + vw) % vw;
        ctx.fillStyle = ["rgba(232,150,40,0.85)", "rgba(214,90,40,0.8)", "rgba(240,200,80,0.8)"][i % 3];
        const s = (2 + h3 * 2) * u;
        ctx.fillRect(x, y, s, s * (0.5 + 0.5 * Math.abs(Math.sin(t * 3 + i))));
      } else {
        const x = ((h2 * vw + t * (160 + h3 * 120) * u) % (vw + 60)) - 30;
        const y = h1 * vh + Math.sin(t + i) * 8 * u;
        ctx.fillStyle = "rgba(240,220,160,0.22)";
        ctx.fillRect(x, y, (14 + h3 * 22) * u, u);
      }
    }
  }

  let vignette = null;
  function drawVignette() {
    if (!vignette) {
      vignette = document.createElement("canvas");
      vignette.width = Math.max(2, vw >> 2);
      vignette.height = Math.max(2, vh >> 2);
      const g = vignette.getContext("2d");
      const w = vignette.width;
      const h = vignette.height;
      const gr = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.42, w / 2, h / 2, Math.hypot(w, h) * 0.56);
      gr.addColorStop(0, "rgba(8,6,3,0)");
      gr.addColorStop(1, "rgba(8,6,3,0.5)");
      g.fillStyle = gr;
      g.fillRect(0, 0, w, h);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(vignette, 0, 0, vw, vh);
  }

  let wtx = 0;
  let wty = 0;
  function setWorldTransform() { ctx.setTransform(cam.z, 0, 0, cam.z, wtx, wty); }

  // ---------- 主绘制 ----------
  R.draw = function (world, alpha, view) {
    if (!ctx || !world) return;
    if (curWorld !== world) R.setWorld(world);
    frameNo++;
    const nowMs = view.now || 0;
    const t = world.t;
    const z = cam.z;
    const zc = z / dpr;
    const lod = !RF.lod ? 0 : zc < 0.5 ? 2 : zc < 0.85 ? 1 : 0;
    const ts = R.tagScale();
    const dt = clamp(t - lastT, 0, 0.1);
    lastT = t;
    fogOn = !!(world.opts.fog && RF.fog);
    // 震屏：天罚、投石落地时晃一下
    const sh = shakeAmt * Math.max(0, 1 - (nowMs - shakeT) / 380);
    wtx = Math.round(vw / 2 - cam.x * z) + (sh ? Math.round((Math.random() - 0.5) * sh * 2 * z) : 0);
    wty = Math.round(vh / 2 - cam.y * z) + (sh ? Math.round((Math.random() - 0.5) * sh * 2 * z) : 0);
    vx0 = -wtx / z;
    vy0 = -wty / z;
    vx1 = vx0 + vw / z;
    vy1 = vy0 + vh / z;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    const B = CS.BIOMES[world.map.biome] || CS.BIOMES.temperate;
    ctx.fillStyle = world.layout.gen ? B.water[1] : "#0f0b07";
    ctx.fillRect(0, 0, vw, vh);
    drawTerrain(wtx, wty);
    setWorldTransform();
    ctx.imageSmoothingEnabled = false;
    if (RF.water && zc >= 0.7) drawWater(world, t);
    if (fogOn && frameNo % 6 === 0 || fogOn && !fog) fogUpdate(world);

    // 尸体
    if (RF.corpses && lod < 2) {
      const UP = CS.UNIT_PX;
      for (const c of world.corpses) {
        const age = t - c.t;
        if (age > 10 || c.x < vx0 - 30 || c.x > vx1 + 30 || c.y < vy0 - 30 || c.y > vy1 + 30) continue;
        if (fogOn && !R.visible(c.x, c.y)) continue;
        const s = CS.unitSprite(world.owners[c.owner].faction, c.type, "dead", 0, c.face);
        if (!s) continue;
        ctx.globalAlpha = Math.max(0, Math.min(0.85, (10 - age) / 4));
        ctx.drawImage(s.c, s.sx, s.sy, s.w, s.h, c.x - s.ax * UP, c.y - s.ay * UP, s.w * UP, s.h * UP);
      }
      ctx.globalAlpha = 1;
    }

    // 法术地面效果
    for (const ef of world.effects) {
      if (ef.x < vx0 - ef.r - 60 || ef.x > vx1 + ef.r + 60 || ef.y < vy0 - ef.r - 60 || ef.y > vy1 + ef.r + 60) continue;
      if (fogOn && !R.visible(ef.x, ef.y)) continue;
      drawEffect(ef, t, world);
    }

    // 选中圈 & 指令
    for (const sq of world.squads) {
      if (!sq.sel || sq.inside) continue;
      const r = squadRadius(sq) + Math.sin(nowMs / 160) * 0.8;
      ctx.strokeStyle = "rgba(255,230,140,0.9)";
      ctx.lineWidth = 1.5 * Math.max(1, ts * 0.7);
      ctx.beginPath();
      ctx.ellipse(sq.x, sq.y + 4, r, r * 0.6, 0, 0, Math.PI * 2);
      ctx.stroke();
      if (sq.path.length) {
        ctx.setLineDash([3, 4]);
        ctx.lineDashOffset = -(nowMs / 60) % 7;
        ctx.strokeStyle = "rgba(255,230,140,0.5)";
        ctx.beginPath();
        ctx.moveTo(sq.x, sq.y);
        for (const p of sq.path) ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
      }
    }
    if (view.hoverStruct && view.hoverStruct !== view.selStruct) {
      const st = view.hoverStruct;
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(st.x, st.y + 10, st.R + 14, (st.R + 14) * 0.55, 0, 0, Math.PI * 2);
      ctx.stroke();
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

    // 实体：裁剪到视野内，按 y 排序（对象池，避免每帧分配）
    let dn = 0;
    const put = (y, kind, o, x, fac, sq, i, a) => {
      let d = pool[dn];
      if (!d) d = pool[dn] = {};
      d.y = y; d.kind = kind; d.o = o; d.x = x; d.fac = fac; d.sq = sq; d.i = i; d.a = a;
      drawList[dn++] = d;
    };
    let ns = 0;
    for (const st of world.structs) {
      if (st.x < vx0 - 110 || st.x > vx1 + 110 || st.y < vy0 - 90 || st.y > vy1 + 130) continue;
      if (fogOn && !R.seen(st.x, st.y)) continue;
      ns++;
      put(st.y + st.R * 0.4, 0, st);
      if (lod < 2) for (let i = 0; i < 3; i++) put(st.y + CS.SLOT_OFFSETS[i][1], 1, st, 0, null, null, i, st.addons[i]);
    }
    FS.structs = ns;
    for (const c of world.chests) if (!c.taken && R.inView(c.x, c.y, 20) && (!fogOn || R.seen(c.x, c.y))) put(c.y, 2, c);
    let nu = 0;
    if (lod < 2) {
      for (const sq of world.squads) {
        if (sq.inside) continue;
        if (sq.x < vx0 - 160 || sq.x > vx1 + 160 || sq.y < vy0 - 160 || sq.y > vy1 + 160) continue;
        if (fogOn && sq.owner !== "p" && !R.visible(sq.x, sq.y)) continue;
        const o = world.owners[sq.owner];
        for (const u of sq.units) {
          if (u.dead) continue;
          const ux = u.px + (u.x - u.px) * alpha;
          const uy = u.py + (u.y - u.py) * alpha;
          if (ux < vx0 - 30 || ux > vx1 + 30 || uy < vy0 - 10 || uy > vy1 + 40) continue;
          put(uy, 3, u, ux, o.faction, sq, o.ci);
          nu++;
        }
      }
    }
    drawList.length = dn;
    drawList.sort(byY);
    for (let di = 0; di < dn; di++) {
      const d = drawList[di];
      if (d.kind === 3) drawUnit(d, t, lod);
      else if (d.kind === 0) drawStruct(d.o, world, view);
      else if (d.kind === 1) drawAddon(d.o, d.i, d.a, world, view);
      else drawChest(d.o, t);
    }
    if (lod === 2) {
      // 拉到最远：士兵画成归属色的小方点
      const s = Math.max(3, 2.4 / zc);
      for (const sq of world.squads) {
        if (sq.inside) continue;
        if (sq.x < vx0 - 160 || sq.x > vx1 + 160 || sq.y < vy0 - 160 || sq.y > vy1 + 160) continue;
        if (fogOn && sq.owner !== "p" && !R.visible(sq.x, sq.y)) continue;
        ctx.fillStyle = world.owners[sq.owner].col.color;
        for (const u of sq.units) {
          if (u.dead) continue;
          ctx.fillRect(u.px + (u.x - u.px) * alpha - s / 2, u.py + (u.y - u.py) * alpha - s, s, s);
          nu++;
        }
      }
    }
    FS.units = nu;

    // 飞行物、特效、粒子
    for (const p of world.proj) {
      if (p.x < vx0 - 40 || p.x > vx1 + 40 || p.y < vy0 - 60 || p.y > vy1 + 40) continue;
      if (fogOn && !R.visible(p.x, p.y)) continue;
      drawProj(p);
    }
    for (const f of world.fx) {
      if (f.x < vx0 - 280 || f.x > vx1 + 280 || f.y < vy0 - 100 || f.y > vy1 + 280) continue;
      if (fogOn && !R.visible(f.x, f.y)) continue;
      drawFx(f, t);
    }
    if (RF.particles) drawParticles(dt);

    const L = RF.light && world.opts.dayNight !== false ? daylight(t) : DAY;
    if (RF.clouds && L[3] < 0.9) drawClouds(world, t, L[3]);
    if (fogOn && fog) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(fog.c, 0, 0, fog.cw, fog.ch, 0, 0, fog.cw * FOG_CELL, fog.ch * FOG_CELL);
      ctx.imageSmoothingEnabled = false;
    }
    if (L !== DAY) { drawLighting(world, t, L); setWorldTransform(); }

    // 部队旗标与血条（在光照之后画，夜里也看得清）
    if (RF.tags) {
      for (const sq of world.squads) {
        if (sq.inside || !sq.units.length) continue;
        if (sq.x < vx0 - 60 || sq.x > vx1 + 60 || sq.y < vy0 - 40 || sq.y > vy1 + 90) { sq.tagX = null; continue; }
        if (fogOn && sq.owner !== "p" && !R.visible(sq.x, sq.y)) continue;
        drawSquadTag(sq, world, lod, ts);
      }
    }
    for (const st of world.structs) {
      if (st.x < vx0 - 80 || st.x > vx1 + 80 || st.y < vy0 - 40 || st.y > vy1 + 150) {
        if (st.owner === "p") for (const g of st.garrison) g.tagX = null;
        continue;
      }
      if (fogOn && st.owner !== "p" && !R.visible(st.x, st.y)) continue;
      drawStructBars(st, world, lod);
    }

    // 指令标记
    for (const m of view.markers) {
      const age = (view.now - m.t) / 600;
      if (age > 1) continue;
      ctx.strokeStyle = m.color;
      ctx.globalAlpha = 1 - age;
      ctx.lineWidth = 2 * ts;
      ctx.beginPath();
      ctx.ellipse(m.x, m.y, (6 + age * 12) * ts, (6 + age * 12) * 0.6 * ts, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // 框选
    if (view.box) {
      const b = view.box;
      ctx.fillStyle = "rgba(255,230,140,0.08)";
      ctx.strokeStyle = "rgba(255,230,140,0.85)";
      ctx.lineWidth = 1 * ts;
      ctx.fillRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      ctx.strokeRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    }
    if (view.flagLine) drawDragPreview(view.flagLine, view.now, ts);
    // 受攻击警报
    for (const st of world.structs) {
      if (st.owner !== "p" || st.ruined || world.t - st.lastHit > 2 || !R.inView(st.x, st.y, 120)) continue;
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
      ctx.setLineDash([6, 5]);
      ctx.lineDashOffset = -(nowMs / 50) % 11;
      ctx.beginPath();
      ctx.ellipse(view.mouse.x, view.mouse.y, r, r * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }
    if (RF.weather) drawWeather(world, t);
    drawVignette();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };

  // ---------- 小地图 ----------
  let mmBase = null;
  function minimapBase(world) {
    const map = world.map;
    const B = CS.BIOMES[map.biome] || CS.BIOMES.temperate;
    const c = document.createElement("canvas");
    c.width = map.cols;
    c.height = map.rows;
    const g = c.getContext("2d");
    const img = g.createImageData(map.cols, map.rows);
    const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    const cg = rgb(B.grass[0]);
    const cw = rgb(B.water[0]);
    const cf = map.biome === "autumn" ? [176, 110, 40] : map.biome === "snow" ? [150, 180, 170] : [52, 120, 60];
    const cr = [128, 134, 150];
    const cb = [196, 138, 78];
    for (let i = 0; i < map.grid.length; i++) {
      const v = map.grid[i];
      const col = v === T.WATER ? cw : v === T.FOREST ? cf : v === T.ROCK ? cr : v === T.BRIDGE ? cb : cg;
      img.data[i * 4] = col[0]; img.data[i * 4 + 1] = col[1]; img.data[i * 4 + 2] = col[2]; img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  }
  R.mapThumb = (map) => minimapBase({ map });
  R.drawMinimap = function (cv, world, nowMs) {
    if (!world) return;
    if (!mmBase) mmBase = minimapBase(world);
    const g = cv.getContext("2d");
    const w = cv.width;
    const h = cv.height;
    const k = w / W;
    g.imageSmoothingEnabled = false;
    g.drawImage(mmBase, 0, 0, w, h);
    const fogged = !!(world.opts.fog && RF.fog) && fog;
    if (fogged) { g.imageSmoothingEnabled = true; g.drawImage(fog.c, 0, 0, w, h); }
    const u = Math.max(1, w / 220);
    for (const sq of world.squads) {
      if (sq.inside || !sq.units.length) continue;
      if (fogged && sq.owner !== "p" && !R.visible(sq.x, sq.y)) continue;
      g.fillStyle = world.owners[sq.owner].col.light;
      g.fillRect(sq.x * k - u, sq.y * k - u, 2 * u, 2 * u);
    }
    for (const st of world.structs) {
      if (fogged && !R.seen(st.x, st.y)) continue;
      const s = (st.type === "castle" ? 4 : 3) * u;
      g.fillStyle = "#1a120c";
      g.fillRect(st.x * k - s - u, st.y * k - s - u, s * 2 + 2 * u, s * 2 + 2 * u);
      g.fillStyle = st.ruined ? "#6b635a" : ownCol(world, st.owner).color;
      g.fillRect(st.x * k - s, st.y * k - s, s * 2, s * 2);
      if (st.owner === "p" && !st.ruined && world.t - st.lastHit < 2 && (nowMs / 300) % 2 < 1) {
        g.strokeStyle = "#ff5040";
        g.lineWidth = 2 * u;
        g.strokeRect(st.x * k - s - 3 * u, st.y * k - s - 3 * u, s * 2 + 6 * u, s * 2 + 6 * u);
      }
    }
    g.strokeStyle = "rgba(255,255,255,0.9)";
    g.lineWidth = Math.max(1, u);
    g.strokeRect(Math.max(0, vx0) * k + 0.5, Math.max(0, vy0) * k + 0.5, (Math.min(W, vx1) - Math.max(0, vx0)) * k - 1, (Math.min(H, vy1) - Math.max(0, vy0)) * k - 1);
  };

  // ---------- 士兵 ----------
  function drawUnit(d, t, lod) {
    const u = d.o;
    const sq = d.sq;
    const UP = CS.UNIT_PX;
    let s;
    if (u.atk > 0) s = CS.unitSprite(d.fac, sq.type, "atk", u.atk > 0.13 ? 0 : 1, u.face);
    else if (u.hitT > 0.06) s = CS.unitSprite(d.fac, sq.type, "hit", 0, u.face);
    else if (u.moving) s = CS.unitSprite(d.fac, sq.type, "run", Math.floor(u.step / 2.6) % 4, u.face);
    else s = CS.unitSprite(d.fac, sq.type, "idle", Math.floor(t * 6 + u.i * 1.7) % 4, u.face);
    if (!s) return;
    const sw = s.w * UP;
    const sh = s.h * UP;
    const lunge = u.atk > 0 && !sq.st.proj ? Math.sin((0.22 - u.atk) / 0.22 * Math.PI) * 2 * u.face : 0;
    const x = d.x - s.ax * UP + lunge;
    const y = d.y - s.ay * UP;
    if (RF.shadow && lod === 0) {
      // 影子 + 归属色脚环：和士兵同一张图集，同色的人一眼能认出是一伙的
      const r = CS.ringSprite(d.i, sq.st.wide || sq.st.big);
      ctx.drawImage(r.c, r.sx, r.sy, r.w, r.h, d.x - r.ax * UP, d.y + 0.5 - r.ay * UP, r.w * UP, r.h * UP);
    }
    if (!RF.unit) return;
    ctx.drawImage(s.c, s.sx, s.sy, s.w, s.h, x, y, sw, sh);
    if (u.hitT > 0) {
      ctx.globalAlpha = Math.min(0.6, u.hitT * 5);
      ctx.globalCompositeOperation = "lighter";
      ctx.drawImage(s.c, s.sx, s.sy, s.w, s.h, x, y, sw, sh);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }
    if (lod) return;
    const top = y + s.box.y * UP;
    if (u.stun > 0) {
      // 冻成冰块 / 被荆棘缠住
      const bx = x + s.box.x * UP - 1;
      const bw = s.box.w * UP + 2;
      const bh = s.box.h * UP + 2;
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
    // 骑兵和投石车跑起来带一点尘土
    if (u.moving && sq.st.wide && Math.random() < 0.05) R.burst("dust", d.x - u.face * 6, d.y, 0.5);
  }

  function drawSquadTag(sq, world, lod, ts) {
    const o = world.owners[sq.owner];
    const col = o.col;
    const hp = CS.squadHp(sq);
    let top = Infinity;
    for (const u of sq.units) if (u.y < top) top = u.y;
    const lift = sq.st.big ? 42 : sq.st.wide ? 34 : 27;
    const x = sq.x;
    const full = sq.st.hp * sq.units.length > 0 ? hp.hp / (sq.st.hp * Math.max(sq.units.length, sq.st.size)) : 0;
    if (sq.owner !== "p") {
      sq.tagX = null;
      if (lod === 2) return;
      // 敌方 / 中立：只画一条细血条
      const r = squadRadius(sq);
      const y = top - lift + 6;
      const w = Math.max(16, Math.min(30, r * 1.6));
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(Math.round(x - w / 2) - 1, Math.round(y) - 1, w + 2, 4);
      ctx.fillStyle = full > 0.5 ? col.light : full > 0.25 ? "#f0c060" : "#ff6a5a";
      ctx.fillRect(Math.round(x - w / 2), Math.round(y), Math.max(0, Math.round(w * Math.min(1, full))), 2);
      return;
    }
    // 己方：头顶一面圆形旗标，按住它拖到目的地
    const r = 9 * ts;
    const by = top - lift - 4 - (r - 9);
    ctx.strokeStyle = "rgba(40,26,14,0.8)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, by + r - 1);
    ctx.lineTo(x, top - 10);
    ctx.stroke();
    drawBadge(x, by, r, sq, o.faction, col, full, sq.sel);
    sq.tagX = x;
    sq.tagY = by;
  }

  // 屏幕空间的横幅与遮罩：按 800×500 的逻辑尺寸排版，再整体缩放到画布
  R.banner = function (text, sub, a) {
    ctx.setTransform(uk, 0, 0, uk, 0, 0);
    ctx.globalAlpha = Math.max(0, Math.min(1, a));
    const gr = ctx.createLinearGradient(0, 0, SW, 0);
    gr.addColorStop(0, "rgba(20,12,6,0)");
    gr.addColorStop(0.2, "rgba(20,12,6,0.78)");
    gr.addColorStop(0.8, "rgba(20,12,6,0.78)");
    gr.addColorStop(1, "rgba(20,12,6,0)");
    ctx.fillStyle = gr;
    ctx.fillRect(0, SH * 0.34, SW, 96);
    ctx.fillStyle = "rgba(255,217,106,0.5)";
    ctx.fillRect(SW * 0.25, SH * 0.34, SW * 0.5, 1);
    ctx.fillRect(SW * 0.25, SH * 0.34 + 95, SW * 0.5, 1);
    ctx.textAlign = "center";
    ctx.font = "bold 30px Microsoft YaHei, sans-serif";
    ctx.fillStyle = "#ffe2a0";
    ctx.fillText(text, SW / 2, SH * 0.34 + 44);
    ctx.font = "16px Microsoft YaHei, sans-serif";
    ctx.fillStyle = "#d9c49a";
    ctx.fillText(sub, SW / 2, SH * 0.34 + 76);
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };

  R.overlay = function (text) {
    ctx.setTransform(uk, 0, 0, uk, 0, 0);
    ctx.fillStyle = "rgba(8,5,2,0.45)";
    ctx.fillRect(0, 0, SW, SH);
    ctx.font = "bold 44px Microsoft YaHei, sans-serif";
    ctx.textAlign = "center";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "#2a1608";
    ctx.strokeText(text, SW / 2, SH / 2);
    ctx.fillStyle = "#ffe2a0";
    ctx.fillText(text, SW / 2, SH / 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };

  function squadRadius(sq) {
    if (sq.st.big) return 18;
    return 10 + Math.sqrt(sq.units.length) * (sq.st.wide ? 9 : 5);
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
      ctx.drawImage(s.c, s.sx + b.x, s.sy + b.y, b.w, b.h, x - b.w * k2 / 2, y - b.h * k2 / 2, b.w * k2, b.h * k2);
    }
    // 人数
    if (sq.units.length > 1) {
      ctx.font = "bold " + Math.round(r * 0.8) + "px sans-serif";
      ctx.textAlign = "center";
      ctx.lineWidth = 2.2 * (r / 9);
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
  function drawDragPreview(f, now, ts) {
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
    ctx.font = "bold " + Math.round(12 * ts) + "px Microsoft YaHei, sans-serif";
    const tw = ctx.measureText(f.label).width;
    const lx = Math.max(vx0 + tw / 2 + 6, Math.min(vx1 - tw / 2 - 6, f.x1));
    const ly = Math.max(vy0 + 20 * ts, f.y1 - 22 * ts);
    ctx.fillStyle = "rgba(20,12,6,0.82)";
    ctx.fillRect(lx - tw / 2 - 6, ly - 13 * ts, tw + 12, 18 * ts);
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
  const ART_TOP = { town: [64, 74, 74], tower: [72, 88, 104], castle: [52, 76, 92], village: [58, 66, 66], fort: [78, 78, 94] };
  CS.ART_TOP = ART_TOP;
  const artTop = (st) => (st.ruined ? 40 : ART_TOP[st.type][st.level]);
  CS.artTop = artTop;

  function drawStruct(st, world, view) {
    const t = world.t;
    const x = st.x;
    const y = st.y;
    const owner = st.owner ? world.owners[st.owner] : null;
    const fac = owner ? owner.col : null;
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
    } else if (st.type === "village") {
      // 村庄：一间红瓦房，升级后多一间灰瓦房、草垛和篱笆
      if (lv >= 1) tgrid(HOUSE_GREY2, x + 2, base - 8 - 64);
      tgrid(HOUSE_RED2, x - 26, base - 64);
      if (lv >= 2) { tt(93, x + 16, base - 14); tgrid([[80, 81, 82]], x - 30, base - 4); }
    } else if (st.type === "fort") {
      // 要塞：一段带门的城墙，后面立一座高塔楼
      const keep = lv >= 2 ? [[102, 102], [103, 103], [126, 126], [125, 125]] : [[102, 102], [103, 103], [126, 126]];
      tgrid(keep, x - 16, base - 30 - keep.length * TT);
      tgrid([[99, 100, 100, 101], [126, 111, 112, 126], [125, 123, 124, 125]], x - 32, base - 48);
    } else {
      // 城堡：两侧塔楼 + 城墙 + 城门；1 级起后面加主楼，2 级塔楼加高
      if (lv >= 1) tgrid(lv >= 2 ? [[52, 53, 54], [64, 65, 66], [76, 77, 79], [88, 88, 88]] : HOUSE_GREY3, x - 24, base - 32 - 64 + (lv >= 2 ? 0 : 8));
      const towerRows = lv >= 2 ? [[102], [103], [126], [125], [126]] : [[102], [103], [126], [125]];
      tgrid(towerRows, x - 48, base - towerRows.length * TT);
      tgrid(towerRows, x + 32, base - towerRows.length * TT);
      tgrid([[99, 100, 100, 101], [126, 111, 112, 126], [125, 123, 124, 125]], x - 32, base - 48);
    }
    if (st.hitFlash > 0) {
      // 受击闪光
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = Math.min(0.35, st.hitFlash * 3);
      ctx.fillStyle = "#ffe2b0";
      ctx.beginPath();
      ctx.ellipse(x, y - 16, st.R + 12, 30, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      if (Math.random() < 0.25) R.burst("debris", x + (Math.random() - 0.5) * st.R * 1.6, y - 8 - Math.random() * 20, 0.3);
    }
    // 旗帜
    if (fac) {
      const top = y - artTop(st);
      const fx = st.type === "castle" ? x - 41 : st.type === "tower" ? x + 10 : st.type === "fort" ? x - 1 : st.type === "village" ? x - 20 : x - 12;
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
      if (st.hp < st.maxHp * 0.3) {
        drawFire(x - 12, y - 8, t, st.id);
        if (Math.random() < 0.3) R.burst("ember", x - 12 + (Math.random() - 0.5) * 10, y - 16, 1);
      }
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
    } else if (a === "watch") {
      // 箭楼：木架 + 平台 + 归属色小旗
      const col = ownCol(world, st.owner);
      ctx.fillStyle = "#2b1d14";
      ctx.fillRect(x - 8, y - 22, 3, 26); ctx.fillRect(x + 5, y - 22, 3, 26);
      ctx.fillRect(x - 11, y - 26, 22, 7);
      ctx.fillRect(x - 9, y - 6, 18, 3);
      ctx.fillStyle = "#a8743f";
      ctx.fillRect(x - 7, y - 21, 1, 24); ctx.fillRect(x + 6, y - 21, 1, 24);
      ctx.fillRect(x - 10, y - 25, 20, 5);
      ctx.fillStyle = "#7a4f28";
      ctx.fillRect(x - 10, y - 22, 20, 2);
      ctx.fillRect(x - 8, y - 5, 16, 1);
      ctx.fillStyle = "#2b1d14";
      ctx.fillRect(x - 10, y - 30, 3, 5); ctx.fillRect(x - 2, y - 30, 3, 5); ctx.fillRect(x + 6, y - 30, 3, 5);
      ctx.fillStyle = "#c9965a";
      ctx.fillRect(x - 9, y - 29, 1, 4); ctx.fillRect(x - 1, y - 29, 1, 4); ctx.fillRect(x + 7, y - 29, 1, 4);
      ctx.fillStyle = "#3a2616";
      ctx.fillRect(x, y - 40, 1, 11);
      ctx.fillStyle = col.color;
      ctx.fillRect(x + 1, y - 40 + Math.round(Math.sin(t * 5 + st.id)), 6, 4);
    } else if (a === "obelisk") {
      const fac = ownCol(world, st.owner);
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
    const fac = ownCol(world, st.owner);
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
        if (sp.fx === "heal") {
          const y = py0 - ph * 24;
          dot(px0 - 1, y - 3, 2, 6, "#bff59c");
          dot(px0 - 3, y - 1, 6, 2, "#bff59c");
        } else if (sp.fx === "lust") {
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
      const icon = sp.fx === "heal" ? "#bff59c" : sp.fx === "lust" ? "#ffb08a" : "#eefbff";
      dot(bx + 10, by - 34, 3, 9, icon);
      dot(bx + 7, by - 31, 9, 3, icon);
    } else if (ef.key === "plague" || ef.key === "gale") {
      // 瘟疫：绿雾里冒泡；飓风：一圈旋转的落叶
      const pl = ef.key === "plague";
      ctx.globalAlpha = 0.22 * fade;
      ctx.fillStyle = pl ? "#7fd04a" : "#f0d27a";
      ctx.beginPath();
      ctx.ellipse(ef.x, ef.y, ef.r, ef.r * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.55 * fade;
      ctx.strokeStyle = pl ? "#c8ff8a" : "#fff0b0";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(ef.x, ef.y, ef.r * 0.62, ef.r * 0.43, pl ? 0 : t * 1.6, 0, Math.PI * (pl ? 2 : 1.3));
      ctx.stroke();
      ctx.globalAlpha = fade;
      for (let i = 0; i < 30; i++) {
        const seed = i * 41.3 + seedBase;
        const ph = (t * (pl ? 0.5 : 1.2) + (seed % 1)) % 1;
        const a = seed * 2.4 + (pl ? 0 : t * 2);
        const rr = ((seed * 5.7) % 1) * ef.r * 0.95;
        const px0 = ef.x + Math.cos(a) * rr;
        const py0 = ef.y + Math.sin(a) * rr * 0.7;
        if (pl) dot(px0, py0 - ph * 22, 3, 3, ph < 0.5 ? "#b9f27a" : "rgba(150,220,90,0.5)");
        else dot(px0, py0 - 10 - Math.sin(ph * 6.28) * 8, 3, 2, i % 2 ? "#e8a02a" : "#d0622a");
      }
      ctx.globalAlpha = 1;
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
      if (age < 0.15) { ctx.globalAlpha = (0.15 - age) * 3; ctx.fillStyle = "#fffbe0"; ctx.fillRect(vx0, vy0, vx1 - vx0, vy1 - vy0); ctx.globalAlpha = a; }
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
    } else if (f.k === "freeze" || f.k === "thorns") {
      // 冰面 + 一圈冰刺破土（荆棘换成绿色）
      const th = f.k === "thorns";
      ctx.globalAlpha = 1 - age;
      ctx.fillStyle = th ? "rgba(120,170,70,0.4)" : "rgba(190,240,255,0.45)";
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
        dot(sx2 - 2, sy2 - h, 4, h, th ? "#5f9a3a" : "#a9e6ff");
        dot(sx2 - 1, sy2 - h, 1, h, th ? "#b6e07a" : "#f2fcff");
      }
      ctx.globalAlpha = 1;
    } else if (f.k === "advent" || f.k === "worms" || f.k === "legion") {
      // 传送门：双环 + 光柱 / 土浪
      const col = f.k === "advent" ? "#fff2b0" : f.k === "legion" ? "#c88aff" : "#c49a62";
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
