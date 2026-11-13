// 地形生成与寻路（无 DOM，可在 Node 中运行）
// 地图尺寸不再是全局常量：每张地图自带 cols / rows / W / H。
(function (root) {
  "use strict";
  const CS = root.CS;
  const { TILE } = CS;

  const T = { GRASS: 0, FOREST: 1, ROCK: 2, WATER: 3, BRIDGE: 4 };
  CS.T = T;

  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  CS.rng = rng;

  // 按格子坐标取确定性随机数（分块烘焙地形时，同一格在任何块里结果都一样）
  function hash2(x, y, s) {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  CS.hash2 = hash2;

  function vnoise(x, y, s) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    let fx = x - xi;
    let fy = y - yi;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = hash2(xi, yi, s);
    const b = hash2(xi + 1, yi, s);
    const c = hash2(xi, yi + 1, s);
    const d = hash2(xi + 1, yi + 1, s);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
  function fbm(x, y, s) { return vnoise(x, y, s) * 0.65 + vnoise(x * 2.1, y * 2.1, s + 7) * 0.35; }
  CS.fbm = fbm;
  const smooth = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

  // 把布局按需水平镜像，得到实际使用的布局
  function resolveLayout(layout, flip) {
    const cols = layout.cols || CS.COLS;
    const rows = layout.rows || CS.ROWS;
    const fx = (c) => (flip ? cols - 1 - c : c);
    const out = {
      name: layout.name, seed: layout.seed, forest: layout.forest, cols, rows,
      gen: !!layout.gen, biome: layout.biome || "temperate",
      s: layout.s.map(([t, c, r, o, l]) => [t, fx(c), r, o, l]),
      o: (layout.o || []).map(([c, r, n, g]) => [fx(c), r, n, g]),
    };
    if (layout.river) {
      const rv = Object.assign({}, layout.river);
      if (flip && rv.axis === "v") rv.at = cols - rv.at - rv.width;
      if (flip && rv.axis === "h") rv.bridges = rv.bridges.map((b) => cols - 1 - b);
      out.river = rv;
    }
    if (layout.ridge) {
      const rd = Object.assign({}, layout.ridge);
      if (flip && rd.axis === "v") rd.at = cols - rd.at - rd.width;
      out.ridge = rd;
    }
    if (layout.lake) out.lake = Object.assign({}, layout.lake, { c: fx(layout.lake.c) });
    return out;
  }
  CS.resolveLayout = resolveLayout;

  // ---------- 程序生成的大陆 ----------
  // 噪声高度图：四周是海，内陆有湖、山脊和成片的树林
  function terrainGrid(cols, rows, seed) {
    const grid = new Uint8Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const nx = ((c + 0.5) / cols) * 2 - 1;
        const ny = ((r + 0.5) / rows) * 2 - 1;
        const edge = Math.max(Math.abs(nx), Math.abs(ny));
        const coast = smooth(0.8, 1.0, edge + (vnoise(c / 6, r / 6, seed + 31) - 0.5) * 0.12);
        const h = fbm(c / 15, r / 15, seed) - coast * 0.8;
        let v = T.GRASS;
        if (h < 0.29) v = T.WATER;
        else if (fbm(c / 11, r / 11, seed + 202) > 0.715 && h > 0.4) v = T.ROCK;
        else if (fbm(c / 9, r / 9, seed + 101) > 0.635) v = T.FOREST;
        grid[r * cols + c] = v;
      }
    }
    return grid;
  }

  // opts: { cols, rows, seed, foes: [势力…], biome }
  // 返回和战役布局同一格式的对象：s = 据点 [类型, 列, 行, 归属, 等级]，o = 野怪营地
  function genContinent(opts) {
    const cols = opts.cols;
    const rows = opts.rows;
    const seed = opts.seed || 1;
    const grid = terrainGrid(cols, rows, seed);
    const rand = rng(seed * 9973 + 5);
    const wet = (c, r, rad) => {
      let n = 0;
      for (let y = r - rad; y <= r + rad; y++) for (let x = c - rad; x <= c + rad; x++) {
        if (x < 0 || y < 0 || x >= cols || y >= rows || grid[y * cols + x] === T.WATER) n++;
      }
      return n;
    };
    const maxSites = Math.round((cols * rows) / 190);
    const sites = [];
    for (let tries = 0; tries < 9000 && sites.length < maxSites; tries++) {
      const c = 5 + Math.floor(rand() * (cols - 10));
      const r = 8 + Math.floor(rand() * (rows - 14));
      if (wet(c, r, 3) > 6) continue;
      if (sites.some((s) => Math.hypot(s[0] - c, (s[1] - r) * 1.2) < 12)) continue;
      sites.push([c, r]);
    }
    // 各家都城：最远点采样，保证彼此离得开
    const ids = CS.OWNER_IDS.slice(0, 1 + opts.foes.length);
    const caps = [];
    let first = 0;
    let fd = Infinity;
    sites.forEach((s, i) => { const d = Math.hypot(s[0] - cols * 0.18, s[1] - rows * 0.55); if (d < fd) { fd = d; first = i; } });
    caps.push(first);
    while (caps.length < ids.length && caps.length < sites.length) {
      let best = -1;
      let bd = -1;
      sites.forEach((s, i) => {
        if (caps.includes(i)) return;
        let d = Infinity;
        for (const k of caps) d = Math.min(d, Math.hypot(s[0] - sites[k][0], s[1] - sites[k][1]));
        if (d > bd) { bd = d; best = i; }
      });
      caps.push(best);
    }
    const taken = new Map();
    caps.forEach((si, k) => taken.set(si, ["castle", ids[k], 0]));
    caps.forEach((si, k) => {
      let best = -1;
      let bd = Infinity;
      sites.forEach((s, i) => {
        if (taken.has(i)) return;
        const d = Math.hypot(s[0] - sites[si][0], s[1] - sites[si][1]);
        if (d < bd) { bd = d; best = i; }
      });
      if (best >= 0) taken.set(best, ["town", ids[k], 0]);
    });
    const s = sites.map(([c, r], i) => {
      if (taken.has(i)) { const [t, o, l] = taken.get(i); return [t, c, r, o, l]; }
      const k = rand();
      const type = k < 0.28 ? "village" : k < 0.58 ? "town" : k < 0.8 ? "tower" : k < 0.92 ? "fort" : "castle";
      const own = rand() < 0.45 ? "n" : "-";
      return [type, c, r, own, own === "n" && rand() < 0.15 ? 1 : 0];
    });
    // 野怪营地：离所有据点远一点的空地
    const camps = [];
    const want = Math.max(1, Math.round(sites.length / 7));
    for (let tries = 0; tries < 4000 && camps.length < want; tries++) {
      const c = 5 + Math.floor(rand() * (cols - 10));
      const r = 5 + Math.floor(rand() * (rows - 10));
      if (wet(c, r, 2) > 2) continue;
      if (sites.some((q) => Math.hypot(q[0] - c, q[1] - r) < 7)) continue;
      if (camps.some((q) => Math.hypot(q[0] - c, q[1] - r) < 10)) continue;
      const n = 1 + Math.floor(rand() * 3);
      camps.push([c, r, n, 150 + n * 70]);
    }
    return { name: opts.name || "大陆 #" + seed, seed, cols, rows, gen: true, biome: opts.biome || "temperate", forest: 0, s, o: camps };
  }
  CS.genContinent = genContinent;

  function buildMap(L) {
    const cols = L.cols || CS.COLS;
    const rows = L.rows || CS.ROWS;
    const n = cols * rows;
    const rand = rng(L.seed * 7919 + 13);
    const grid = L.gen ? terrainGrid(cols, rows, L.seed) : new Uint8Array(n);
    const decor = new Uint8Array(n); // 0 无，1-6 小装饰
    const idx = (c, r) => r * cols + c;
    const inside = (c, r) => c >= 0 && r >= 0 && c < cols && r < rows;

    if (!L.gen) {
      // 树林团块
      const clumps = Math.round(L.forest * 140);
      for (let i = 0; i < clumps; i++) {
        const cc = Math.floor(rand() * cols);
        const cr = Math.floor(rand() * rows);
        const rad = 1 + rand() * 2.2;
        const kind = rand() < 0.16 ? T.ROCK : T.FOREST;
        for (let r = Math.floor(cr - rad); r <= cr + rad; r++) {
          for (let c = Math.floor(cc - rad); c <= cc + rad; c++) {
            if (!inside(c, r)) continue;
            const d = Math.hypot(c - cc, r - cr);
            if (d <= rad && rand() < 1.15 - d / rad * 0.6) grid[idx(c, r)] = kind;
          }
        }
      }
      // 边缘多一些树，看着像地图边界
      for (let c = 0; c < cols; c++) {
        for (const r of [0, rows - 1]) if (rand() < 0.45) grid[idx(c, r)] = T.FOREST;
      }
      for (let r = 0; r < rows; r++) {
        for (const c of [0, cols - 1]) if (rand() < 0.45) grid[idx(c, r)] = T.FOREST;
      }
      if (L.river) {
        const rv = L.river;
        if (rv.axis === "v") {
          for (let r = 0; r < rows; r++) {
            const wob = Math.round(Math.sin(r / 3.1) * 0.9);
            for (let k = 0; k < rv.width; k++) {
              const c = rv.at + k + wob;
              if (inside(c, r)) grid[idx(c, r)] = rv.bridges.some((b) => r === b || r === b + 1) ? T.BRIDGE : T.WATER;
            }
          }
        } else {
          for (let c = 0; c < cols; c++) {
            const wob = Math.round(Math.sin(c / 3.3) * 0.9);
            for (let k = 0; k < rv.width; k++) {
              const r = rv.at + k + wob;
              if (inside(c, r)) grid[idx(c, r)] = rv.bridges.some((b) => c === b || c === b + 1) ? T.BRIDGE : T.WATER;
            }
          }
        }
      }
      if (L.ridge) {
        const rd = L.ridge;
        for (let r = 0; r < rows; r++) {
          if (rd.gaps.some((g) => Math.abs(r - g) <= 1)) continue;
          const wob = Math.round(Math.sin(r / 2.3) * 1.1);
          for (let k = -1; k < rd.width + 1; k++) {
            const c = rd.at + k + wob;
            if (!inside(c, r)) continue;
            if (k >= 0 && k < rd.width) grid[idx(c, r)] = T.ROCK;
            else if (rand() < 0.5) grid[idx(c, r)] = T.ROCK;
          }
        }
      }
      if (L.lake) {
        const lk = L.lake;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const d = ((c - lk.c) / lk.rx) ** 2 + ((r - lk.r) / lk.ry) ** 2;
            if (d <= 1 + (rand() - 0.5) * 0.25) grid[idx(c, r)] = T.WATER;
          }
        }
      }
    }

    // 据点、营地周围清空
    const clear = (cc, cr, rad) => {
      for (let r = Math.floor(cr - rad); r <= cr + rad; r++) {
        for (let c = Math.floor(cc - rad); c <= cc + rad; c++) {
          if (!inside(c, r)) continue;
          if (Math.hypot(c - cc, r - cr) <= rad && grid[idx(c, r)] !== T.BRIDGE) {
            grid[idx(c, r)] = grid[idx(c, r)] === T.WATER && !L.gen ? T.BRIDGE : T.GRASS;
          }
        }
      }
    };
    for (const s of L.s) clear(s[1], s[2] + 0.6, 3.9);
    for (const o of L.o) clear(o[0], o[1], 2.6);

    // 连通性：所有据点必须能互相走到
    const nodes = L.s.map((s) => [s[1], s[2]]).concat(L.o.map((o) => [o[0], o[1]]));
    const passable = (v) => v === T.GRASS || v === T.BRIDGE;
    const carve = (a, b) => {
      let [c, r] = a;
      const [gc, gr] = b;
      while (c !== gc || r !== gr) {
        const dc = Math.sign(gc - c);
        const dr = Math.sign(gr - r);
        if (Math.abs(gc - c) >= Math.abs(gr - r)) c += dc; else r += dr;
        for (const [ec, er] of [[c, r], [c + 1, r], [c, r + 1]]) {
          if (!inside(ec, er)) continue;
          const v = grid[idx(ec, er)];
          if (v === T.WATER) grid[idx(ec, er)] = T.BRIDGE;
          else if (!passable(v)) grid[idx(ec, er)] = T.GRASS;
        }
      }
    };
    const seen = new Uint8Array(n);
    for (let guard = 0; guard < nodes.length + 20; guard++) {
      seen.fill(0);
      const q = [idx(nodes[0][0], nodes[0][1])];
      seen[q[0]] = 1;
      for (let i = 0; i < q.length; i++) {
        const c = q[i] % cols;
        const r = (q[i] / cols) | 0;
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nc = c + dc;
          const nr = r + dr;
          if (!inside(nc, nr)) continue;
          const k = idx(nc, nr);
          if (!seen[k] && passable(grid[k])) { seen[k] = 1; q.push(k); }
        }
      }
      const lost = nodes.find(([c, r]) => !seen[idx(c, r)]);
      if (!lost) break;
      // 连到最近的已连通点
      let best = null;
      let bd = Infinity;
      for (const k of q) {
        const c = k % cols;
        const r = (k / cols) | 0;
        const d = Math.abs(c - lost[0]) + Math.abs(r - lost[1]);
        if (d < bd) { bd = d; best = [c, r]; }
      }
      carve(lost, best);
    }

    for (let i = 0; i < n; i++) {
      if (grid[i] === T.GRASS && rand() < 0.07) decor[i] = 1 + Math.floor(rand() * 6);
    }

    const blocked = new Uint8Array(n);
    for (let i = 0; i < n; i++) blocked[i] = passable(grid[i]) ? 0 : 1;
    const map = { grid, decor, blocked, layout: L, roads: [], cols, rows, W: cols * TILE, H: rows * TILE, biome: L.biome || "temperate" };
    map.roads = planRoads(map, L);
    return map;
  }
  CS.buildMap = buildMap;

  function planRoads(map, L) {
    // 每个据点连向最近的两个据点，用于画土路（纯装饰）
    const pts = L.s.map((s) => [s[1], s[2] + 1]);
    const roads = [];
    const done = new Set();
    for (let i = 0; i < pts.length; i++) {
      const order = pts.map((p, j) => [j, Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1])]).filter(([j]) => j !== i).sort((a, b) => a[1] - b[1]);
      for (const [j] of order.slice(0, 2)) {
        const key = Math.min(i, j) + "-" + Math.max(i, j);
        if (done.has(key)) continue;
        done.add(key);
        const path = findPath(map, (pts[i][0] + 0.5) * TILE, (pts[i][1] + 0.5) * TILE, (pts[j][0] + 0.5) * TILE, (pts[j][1] + 0.5) * TILE, true);
        if (path && path.length > 1) roads.push(path);
      }
    }
    return roads;
  }

  function blockedAt(map, x, y) {
    const c = Math.floor(x / TILE);
    const r = Math.floor(y / TILE);
    if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return true;
    return map.blocked[r * map.cols + c] === 1;
  }
  CS.blockedAt = blockedAt;

  function nearestFree(map, c, r) {
    const cols = map.cols;
    const rows = map.rows;
    c = Math.max(0, Math.min(cols - 1, c));
    r = Math.max(0, Math.min(rows - 1, r));
    if (!map.blocked[r * cols + c]) return [c, r];
    for (let rad = 1; rad < 16; rad++) {
      for (let dr = -rad; dr <= rad; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue;
          const nc = c + dc;
          const nr = r + dr;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          if (!map.blocked[nr * cols + nc]) return [nc, nr];
        }
      }
    }
    return [c, r];
  }
  CS.nearestFree = nearestFree;

  function lineClear(map, x0, y0, x1, y1) {
    const d = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.ceil(d / 8);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      if (blockedAt(map, x, y) || blockedAt(map, x + 6, y) || blockedAt(map, x - 6, y) || blockedAt(map, x, y + 6) || blockedAt(map, x, y - 6)) return false;
    }
    return true;
  }
  CS.lineClear = lineClear;

  // 8 向 A*，返回平滑后的像素路点。临时数组按最大地图分配一次。
  let cap = 0;
  let heapF = null;
  let gScore = null;
  let came = null;
  let stamp = null;
  let closed = null;
  let gen = 1;
  CS.pathCalls = 0;
  function ensure(n) {
    if (n <= cap) return;
    cap = n;
    heapF = new Float32Array(n);
    gScore = new Float32Array(n);
    came = new Int32Array(n);
    stamp = new Uint32Array(n);
    closed = new Uint32Array(n);
    gen = 1;
  }

  function findPath(map, sx, sy, gx, gy, raw) {
    CS.pathCalls++;
    const cols = map.cols;
    const rows = map.rows;
    ensure(cols * rows);
    const [sc, sr] = nearestFree(map, Math.floor(sx / TILE), Math.floor(sy / TILE));
    const [gc, gr] = nearestFree(map, Math.floor(gx / TILE), Math.floor(gy / TILE));
    const start = sr * cols + sc;
    const goal = gr * cols + gc;
    gen++;
    const open = [start];
    stamp[start] = gen;
    gScore[start] = 0;
    heapF[start] = 0;
    came[start] = -1;
    const blocked = map.blocked;
    let found = start === goal;
    while (open.length && !found) {
      // 二叉堆
      const cur = open[0];
      const last = open.pop();
      if (open.length) {
        open[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if (l < open.length && heapF[open[l]] < heapF[open[m]]) m = l;
          if (r < open.length && heapF[open[r]] < heapF[open[m]]) m = r;
          if (m === i) break;
          const t = open[i]; open[i] = open[m]; open[m] = t; i = m;
        }
      }
      if (closed[cur] === gen) continue;
      closed[cur] = gen;
      if (cur === goal) { found = true; break; }
      const c = cur % cols;
      const r = (cur / cols) | 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dc && !dr) continue;
          const nc = c + dc;
          const nr = r + dr;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const k = nr * cols + nc;
          if (blocked[k]) continue;
          if (dc && dr && (blocked[r * cols + nc] || blocked[nr * cols + c])) continue;
          const g = gScore[cur] + (dc && dr ? 1.4142 : 1);
          if (stamp[k] !== gen || g < gScore[k]) {
            stamp[k] = gen;
            gScore[k] = g;
            came[k] = cur;
            const hc = Math.abs(nc - gc);
            const hr = Math.abs(nr - gr);
            // 启发值略微放大：大地图上少展开很多格，路线只差一点点
            heapF[k] = g + ((hc + hr) + (1.4142 - 2) * Math.min(hc, hr)) * 1.08;
            open.push(k);
            let i = open.length - 1;
            while (i > 0) {
              const p = (i - 1) >> 1;
              if (heapF[open[p]] <= heapF[open[i]]) break;
              const t = open[i]; open[i] = open[p]; open[p] = t; i = p;
            }
          }
        }
      }
    }
    if (!found) return null;
    const cells = [];
    for (let k = goal; k !== -1; k = came[k]) cells.push(k);
    cells.reverse();
    const pts = cells.map((k) => ({ x: ((k % cols) + 0.5) * TILE, y: (((k / cols) | 0) + 0.5) * TILE }));
    if (raw) return pts;
    pts[0] = { x: sx, y: sy };
    const end = { x: gx, y: gy };
    if (!blockedAt(map, gx, gy)) pts[pts.length - 1] = end;
    // 拉直（每次最多往前看 40 个路点，长路径不会退化成平方复杂度）
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = Math.min(pts.length - 1, i + 40);
      while (j > i + 1 && !lineClear(map, pts[i].x, pts[i].y, pts[j].x, pts[j].y)) j--;
      out.push(pts[j]);
      i = j;
    }
    out.shift();
    return out;
  }
  CS.findPath = findPath;
})(typeof window !== "undefined" ? window : globalThis);
