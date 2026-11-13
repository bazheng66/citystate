// 地形生成与寻路（无 DOM，可在 Node 中运行）
(function (root) {
  "use strict";
  const CS = root.CS;
  const { COLS, ROWS, TILE } = CS;

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

  // 把布局按需水平镜像，得到实际使用的布局
  function resolveLayout(layout, flip) {
    const fx = (c) => (flip ? COLS - 1 - c : c);
    const out = {
      name: layout.name, seed: layout.seed, forest: layout.forest,
      s: layout.s.map(([t, c, r, o, l]) => [t, fx(c), r, o, l]),
      o: (layout.o || []).map(([c, r, n, g]) => [fx(c), r, n, g]),
    };
    if (layout.river) {
      const rv = Object.assign({}, layout.river);
      if (flip && rv.axis === "v") rv.at = COLS - rv.at - rv.width;
      if (flip && rv.axis === "h") rv.bridges = rv.bridges.map((b) => COLS - 1 - b);
      out.river = rv;
    }
    if (layout.ridge) {
      const rd = Object.assign({}, layout.ridge);
      if (flip && rd.axis === "v") rd.at = COLS - rd.at - rd.width;
      out.ridge = rd;
    }
    if (layout.lake) out.lake = Object.assign({}, layout.lake, { c: fx(layout.lake.c) });
    return out;
  }
  CS.resolveLayout = resolveLayout;

  function buildMap(L) {
    const rand = rng(L.seed * 7919 + 13);
    const grid = new Uint8Array(COLS * ROWS);
    const decor = new Uint8Array(COLS * ROWS); // 0 无，1-6 小装饰
    const idx = (c, r) => r * COLS + c;
    const inside = (c, r) => c >= 0 && r >= 0 && c < COLS && r < ROWS;

    // 树林团块
    const clumps = Math.round(L.forest * 140);
    for (let i = 0; i < clumps; i++) {
      const cc = Math.floor(rand() * COLS);
      const cr = Math.floor(rand() * ROWS);
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
    for (let c = 0; c < COLS; c++) {
      for (const r of [0, ROWS - 1]) if (rand() < 0.45) grid[idx(c, r)] = T.FOREST;
    }
    for (let r = 0; r < ROWS; r++) {
      for (const c of [0, COLS - 1]) if (rand() < 0.45) grid[idx(c, r)] = T.FOREST;
    }

    if (L.river) {
      const rv = L.river;
      if (rv.axis === "v") {
        for (let r = 0; r < ROWS; r++) {
          const wob = Math.round(Math.sin(r / 3.1) * 0.9);
          for (let k = 0; k < rv.width; k++) {
            const c = rv.at + k + wob;
            if (inside(c, r)) grid[idx(c, r)] = rv.bridges.some((b) => r === b || r === b + 1) ? T.BRIDGE : T.WATER;
          }
        }
      } else {
        for (let c = 0; c < COLS; c++) {
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
      for (let r = 0; r < ROWS; r++) {
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
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const d = ((c - lk.c) / lk.rx) ** 2 + ((r - lk.r) / lk.ry) ** 2;
          if (d <= 1 + (rand() - 0.5) * 0.25) grid[idx(c, r)] = T.WATER;
        }
      }
    }

    // 据点、营地周围清空
    const clear = (cc, cr, rad) => {
      for (let r = Math.floor(cr - rad); r <= cr + rad; r++) {
        for (let c = Math.floor(cc - rad); c <= cc + rad; c++) {
          if (!inside(c, r)) continue;
          if (Math.hypot(c - cc, r - cr) <= rad && grid[idx(c, r)] !== T.BRIDGE) {
            grid[idx(c, r)] = grid[idx(c, r)] === T.WATER ? T.BRIDGE : T.GRASS;
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
    for (let guard = 0; guard < 20; guard++) {
      const seen = new Uint8Array(COLS * ROWS);
      const q = [idx(nodes[0][0], nodes[0][1])];
      seen[q[0]] = 1;
      for (let i = 0; i < q.length; i++) {
        const c = q[i] % COLS;
        const r = (q[i] / COLS) | 0;
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
        const c = k % COLS;
        const r = (k / COLS) | 0;
        const d = Math.abs(c - lost[0]) + Math.abs(r - lost[1]);
        if (d < bd) { bd = d; best = [c, r]; }
      }
      carve(lost, best);
    }

    for (let i = 0; i < grid.length; i++) {
      if (grid[i] === T.GRASS && rand() < 0.07) decor[i] = 1 + Math.floor(rand() * 6);
    }

    const blocked = new Uint8Array(COLS * ROWS);
    for (let i = 0; i < grid.length; i++) blocked[i] = passable(grid[i]) ? 0 : 1;
    const map = { grid, decor, blocked, layout: L, roads: [] };
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
    if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return true;
    return map.blocked[r * COLS + c] === 1;
  }
  CS.blockedAt = blockedAt;

  function nearestFree(map, c, r) {
    c = Math.max(0, Math.min(COLS - 1, c));
    r = Math.max(0, Math.min(ROWS - 1, r));
    if (!map.blocked[r * COLS + c]) return [c, r];
    for (let rad = 1; rad < 12; rad++) {
      for (let dr = -rad; dr <= rad; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue;
          const nc = c + dc;
          const nr = r + dr;
          if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
          if (!map.blocked[nr * COLS + nc]) return [nc, nr];
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

  // 8 向 A*，返回平滑后的像素路点
  const heapF = new Float32Array(COLS * ROWS);
  const gScore = new Float32Array(COLS * ROWS);
  const came = new Int32Array(COLS * ROWS);
  const stamp = new Uint32Array(COLS * ROWS);
  const closed = new Uint32Array(COLS * ROWS);
  let gen = 1;
  CS.pathCalls = 0;

  function findPath(map, sx, sy, gx, gy, raw) {
    CS.pathCalls++;
    const [sc, sr] = nearestFree(map, Math.floor(sx / TILE), Math.floor(sy / TILE));
    const [gc, gr] = nearestFree(map, Math.floor(gx / TILE), Math.floor(gy / TILE));
    const start = sr * COLS + sc;
    const goal = gr * COLS + gc;
    gen++;
    const open = [start];
    stamp[start] = gen;
    gScore[start] = 0;
    heapF[start] = 0;
    came[start] = -1;
    const h = (k) => {
      const dc = Math.abs((k % COLS) - gc);
      const dr = Math.abs(((k / COLS) | 0) - gr);
      return (dc + dr) + (1.4142 - 2) * Math.min(dc, dr);
    };
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
      const c = cur % COLS;
      const r = (cur / COLS) | 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dc && !dr) continue;
          const nc = c + dc;
          const nr = r + dr;
          if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
          const k = nr * COLS + nc;
          if (map.blocked[k]) continue;
          if (dc && dr && (map.blocked[r * COLS + nc] || map.blocked[nr * COLS + c])) continue;
          const g = gScore[cur] + (dc && dr ? 1.4142 : 1);
          if (stamp[k] !== gen || g < gScore[k]) {
            stamp[k] = gen;
            gScore[k] = g;
            came[k] = cur;
            heapF[k] = g + h(k);
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
    const pts = cells.map((k) => ({ x: ((k % COLS) + 0.5) * TILE, y: (((k / COLS) | 0) + 0.5) * TILE }));
    if (raw) return pts;
    pts[0] = { x: sx, y: sy };
    const end = { x: gx, y: gy };
    if (!blockedAt(map, gx, gy)) pts[pts.length - 1] = end;
    // 拉直
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !lineClear(map, pts[i].x, pts[i].y, pts[j].x, pts[j].y)) j--;
      out.push(pts[j]);
      i = j;
    }
    out.shift();
    return out;
  }
  CS.findPath = findPath;
})(typeof window !== "undefined" ? window : globalThis);
