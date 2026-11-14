// 启动、主循环、压力测试
(function (root) {
  "use strict";
  const CS = root.CS;
  const UI = CS.ui;
  const M = (CS.main = {});
  const R = CS.render;
  const $ = (s) => document.querySelector(s);

  // 参数：浏览器里来自地址栏；Tauri / Electron 外壳也可以通过 window.__CS_QUERY 注入
  const Q = new URLSearchParams(root.__CS_QUERY || location.search);
  M.query = Q;
  M.errors = [];
  root.addEventListener("error", (e) => { M.errors.push(String(e.message || e)); });
  root.addEventListener("unhandledrejection", (e) => { M.errors.push("promise: " + String(e.reason)); });

  let acc = 0;
  let last = 0;
  let frameAvg = 16.7;
  let renderAvg = 0;
  let simFrame = 0;
  let fps = 60;
  let hudT = 0;
  let mmT = 0;

  // 图块：Kenney Tiny Town（建筑 / 树木）、0x72 DungeonTileset II（角色）
  const dungeon = new Image();
  const town = new Image();
  CS.IMG = { dungeon, town };
  let pending = 2;
  for (const [img, src] of [[dungeon, "assets/dungeon2/sheet.png"], [town, "assets/tinytown/tilemap_packed.png"]]) {
    img.onload = () => { if (--pending === 0) boot(); };
    img.onerror = () => { document.body.innerHTML = "<p style='padding:40px'>图块加载失败：" + src + "</p>"; };
    img.src = src;
  }

  M.shell = () => (navigator.userAgent.includes("Electron") ? "Electron" : (root.__TAURI_INTERNALS__ || root.__TAURI__ || Q.get("shell") === "tauri") ? "Tauri" : "Browser");

  function post(payload) {
    const url = Q.get("report");
    if (!url) return;
    payload.run = Q.get("run") || "";
    payload.shell = M.shell();
    try { fetch(url, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(payload) }).catch(() => {}); } catch (e) { /* 没有上报地址就算了 */ }
  }

  function boot() {
    const t0 = performance.now();
    CS.buildSprites2(dungeon);
    M.atlasMs = performance.now() - t0;
    R.init($("#view"));
    const st = CS.save.load().settings;
    CS.audio.setVolume(st.vol);
    CS.audio.setMuted(st.muted);
    CS.audio.music.enabled = st.music !== false;
    UI.perf = st.perf;
    UI.applyGfx(st);
    root.addEventListener("resize", M.fit);
    // 对比实验：把窗口内容区调到指定大小（浏览器 --app 窗口用）
    const win = (Q.get("win") || "").split("x").map(Number);
    if (win.length === 2 && win[0] && win[1]) {
      try { root.resizeTo(win[0] + (root.outerWidth - root.innerWidth), win[1] + (root.outerHeight - root.innerHeight)); } catch (e) { /* 普通标签页不允许调整 */ }
    }
    for (const kv of (Q.get("rf") || "").split(",").filter(Boolean)) {
      const [k, v] = kv.split(":");
      if (k in CS.RF) CS.RF[k] = Number(v);
    }
    if (Q.get("bench")) {
      M.startBench({
        n: Number(Q.get("bench")) || 2000, map: Q.get("map") || "l", secs: Number(Q.get("secs")) || 30,
        cam: Q.get("cam") || "tour", fog: Q.get("fog") === "1", seed: Number(Q.get("seed")) || 7,
      });
    } else if (Q.get("mission")) {
      const [f, i] = Q.get("mission").split("-");
      if (Q.get("unlock")) CS.save.get().settings.unlockAll = true;
      UI.startMission(f, Number(i) - 1);
      if (Q.get("auto")) UI.world.owners.p.ai = true;
      if (Q.get("speed")) UI.speed = Number(Q.get("speed"));
    } else if (Q.get("conquest")) {
      UI.startConquest({ faction: Q.get("fac") || "duchy", size: Q.get("conquest"), seed: Number(Q.get("seed")) || 7, biome: Q.get("biome") || "temperate", diff: 1, fog: Q.get("fog") !== "0" });
      if (Q.get("auto")) UI.world.owners.p.ai = true;
      if (Q.get("speed")) UI.speed = Number(Q.get("speed"));
    } else UI.show("title");
    requestAnimationFrame(loop);
    document.body.dataset.ready = "1";
    post({ event: "ready", bootMs: +performance.now().toFixed(1), atlasMs: +M.atlasMs.toFixed(1) });
  }

  M.fit = function () {
    const stage = $("#stage");
    if (!stage || stage.offsetParent === null) return;
    R.resize(stage.clientWidth, stage.clientHeight, Math.min(2, root.devicePixelRatio || 1));
    M.fitMinimap();
  };
  // 小地图：按地图长宽比定尺寸；一屏能看全的小地图不需要它
  M.fitMinimap = function () {
    const w = UI.world;
    const wrap = $("#mmwrap");
    if (!w || w.W <= 900) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const mm = $("#minimap");
    const cssW = 220;
    const cssH = Math.round((cssW * w.H) / w.W);
    const d = Math.min(2, root.devicePixelRatio || 1);
    mm.style.width = cssW + "px";
    mm.style.height = cssH + "px";
    mm.width = Math.round(cssW * d);
    mm.height = Math.round(cssH * d);
    mmT = 0;
  };
  M.resetClock = function () { acc = 0; last = performance.now(); };

  function loop(now) {
    requestAnimationFrame(loop);
    const dtMs = Math.min(250, now - (last || now));
    last = now;
    frameAvg = frameAvg * 0.92 + dtMs * 0.08;
    fps = 1000 / Math.max(1, frameAvg);
    const w = UI.world;
    if (UI.screen === "title") { drawTitle(now); CS.audio.musicPlay(true); return; }
    if (UI.screen !== "game") CS.audio.musicPlay(false);
    if (UI.screen !== "game" || !w) return;
    // 相机：方向键平移 + 缓动
    if (UI.bench && UI.bench.phase === "measure") benchCamera(now);
    else {
      const K = UI.keys;
      const dx = (K.arrowright ? 1 : 0) - (K.arrowleft ? 1 : 0);
      const dy = (K.arrowdown ? 1 : 0) - (K.arrowup ? 1 : 0);
      if (dx || dy) R.pan(dx * dtMs * 0.9, dy * dtMs * 0.9);
    }
    R.camUpdate(dtMs);
    // 模拟
    const s0 = performance.now();
    if (!UI.paused && !w.outcome) {
      acc += (dtMs / 1000) * UI.speed;
      let n = 0;
      while (acc >= CS.STEP && n < 10) {
        if (UI.bench) benchSpawn(w);
        CS.step(w);
        CS.aiTick(w);
        acc -= CS.STEP;
        n++;
      }
      if (n === 10) acc = 0;
    }
    const s1 = performance.now();
    simFrame = simFrame * 0.9 + (s1 - s0) * 0.1;
    UI.consumeEvents(w);
    // 渲染
    UI.now = now;
    R.draw(w, UI.paused || w.outcome ? 1 : Math.min(1, acc / CS.STEP), {
      markers: UI.markers, now, selStruct: UI.selStruct, hoverStruct: UI.hoverStruct, hoverSlot: UI.hoverSlot, box: UI.box,
      aim: UI.aim, aimOk: UI.aimOk, mouse: UI.mouse, flagLine: UI.flagLine,
    });
    if (UI.paused && !UI.modalOpen() && !w.outcome) R.overlay("暂停");
    if (UI.banner) {
      const age = (now - UI.banner.t) / 1000;
      if (age > 4) UI.banner = null;
      else R.banner(UI.banner.text, UI.banner.sub, age < 0.4 ? age / 0.4 : age > 3.2 ? (4 - age) / 0.8 : 1);
    }
    mmT -= dtMs;
    if (mmT <= 0 && !$("#mmwrap").hidden) { mmT = 120; R.drawMinimap($("#minimap"), w, now); }
    CS.audio.musicPlay(!UI.paused && !w.outcome);
    const r1 = performance.now();
    renderAvg = renderAvg * 0.9 + (r1 - s1) * 0.1;
    if (UI.markers.length > 20) UI.markers.splice(0, UI.markers.length - 20);
    hudT -= dtMs;
    if (hudT <= 0 || UI.lastPanel === "" || UI.lastSpells === "") { hudT = 100; UI.lastPanel = UI.lastSpells = "ok"; UI.updateHud(); }
    if (UI.bench) benchFrame(now, dtMs, s1 - s0, r1 - s1);
    const perf = $("#perf");
    if (UI.perf || UI.bench) {
      perf.hidden = false;
      const F = R.stats;
      const mem = performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(0) + "MB" : "n/a";
      perf.textContent = `FPS ${fps.toFixed(0)}  帧 ${frameAvg.toFixed(1)}ms  [${M.shell()}]\n模拟 ${simFrame.toFixed(2)}ms/帧 (${w.perf.sim.toFixed(3)}ms/步)\n渲染 ${renderAvg.toFixed(2)}ms\n士兵 ${w.soldierCount}（画出 ${F.units}）  部队 ${w.squads.length}  飞行物 ${w.proj.length}\n据点 ${w.structs.length}（画出 ${F.structs}）  粒子 ${F.particles}\n地形块 ${F.chunks} 可见 / 累计烘焙 ${F.baked} / 缓存 ${F.chunkMP}MP\n地图 ${w.map.cols}×${w.map.rows}  缩放 ${R.zoomCss().toFixed(2)}  画布 ${$("#view").width}×${$("#view").height}\nJS 堆 ${mem}${UI.bench ? "\n" + benchStatus() : ""}`;
    } else if (!perf.hidden) perf.hidden = true;
  }

  // ---------- 标题动画 ----------
  let titleOn = false;
  M.titleAnim = (on) => { titleOn = on; };
  function drawTitle(now) {
    if (!titleOn) return;
    const c = $("#title-canvas");
    const g = c.getContext("2d");
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, c.width, c.height);
    const t = now / 1000;
    const grd = g.createLinearGradient(0, 96, 0, 200);
    grd.addColorStop(0, "rgba(62,120,52,0)");
    grd.addColorStop(0.25, "rgba(62,120,52,0.9)");
    grd.addColorStop(1, "rgba(30,60,24,0)");
    g.fillStyle = grd;
    g.fillRect(0, 96, c.width, 104);
    g.fillStyle = "rgba(201,160,102,0.75)";
    g.fillRect(0, 150, c.width, 10);
    const facs = CS.PLAYABLE;
    const types = ["foot", "archer", "cav", "mage", "guard", "siege"];
    // 远处的城：Tiny Town 图块，放大 1.5 倍
    const tg = (rows, x, y) => {
      for (let r = 0; r < rows.length; r++) for (let c2 = 0; c2 < rows[r].length; c2++) {
        const i = rows[r][c2];
        if (i == null) continue;
        g.drawImage(town, (i % 12) * 16, ((i / 12) | 0) * 16, 16, 16, x + c2 * 24, y + r * 24, 24, 24);
      }
    };
    tg([[48, 50], [60, 62], [76, 79], [88, 88], [89, 88]], 110, 30);
    tg([[102, null, null, null, null, 102], [103, 99, 100, 100, 101, 103], [126, 126, 111, 112, 126, 126], [125, 125, 123, 124, 125, 125]], 250, 54);
    tg([[52, 53, 54], [64, 65, 66], [72, 73, 75], [84, 85, 84]], 470, 54);
    for (let i = 0; i < 25; i++) {
      const fac = facs[i % facs.length];
      const type = types[i % types.length];
      const dir = i % 2 ? 1 : -1;
      const speed = type === "cav" ? 60 : 30;
      const x = ((i * 97 + t * speed * dir) % 760 + 760) % 760 - 60;
      const y = 142 + (i % 3) * 16;
      const s = CS.unitSprite(fac, type, "run", Math.floor(t * 8 + i) % 4, dir);
      const k = 1.5;
      g.drawImage(s.c, s.sx, s.sy, s.w, s.h, Math.round(x - s.ax * k), Math.round(y - s.ay * k), s.w * k, s.h * k);
    }
  }

  // ---------- 压力测试 ----------
  // cfg: { n 目标士兵数, map 地图规格(s/m/l/xl), secs 测量秒数, cam 相机脚本(tour/overview/close/static), fog, seed }
  // 所有归属都由 AI 托管，据点打不坏，兵死了会补，所以负载能稳定维持到测完。
  const TYPES = ["foot", "archer", "cav", "foot", "mage", "archer", "siege", "guard"];
  M.startBench = function (cfg) {
    cfg = Object.assign({ n: 2000, map: "l", secs: 30, cam: "tour", fog: false, seed: 7 }, cfg);
    const size = CS.MAP_SIZES.find((s) => s.id === cfg.map) || CS.MAP_SIZES[2];
    const foes = Array.from({ length: size.foes }, (_, i) => CS.PLAYABLE[(i + 1) % CS.PLAYABLE.length]);
    const layout = CS.genContinent({ cols: size.cols, rows: size.rows, seed: cfg.seed, foes, biome: cfg.biome || "temperate", name: "压力测试" });
    const enemies = {};
    foes.forEach((f, i) => { enemies[CS.OWNER_IDS[i + 1]] = f; });
    const world = CS.createWorld({
      player: "duchy", layout, diff: 5, gold: 99999, aiGold: 99999, enemies, edicts: {}, autoplay: true,
      seed: cfg.seed, noCap: true, bench: true, fog: !!cfg.fog, dayNight: true,
    });
    for (const o of Object.values(world.owners)) o.mana = 150;
    UI.bench = {
      cfg, n: cfg.n, t0: 0, frames: [], sim: [], render: [], phaseOf: [], peak: 0, phase: "ramp", start: performance.now(), done: false,
      k: 0, timeline: [], winT: 0, winN: 0, winMs: 0, heap0: 0, chunks0: 0, soldierSum: 0, partSum: 0, unitSum: 0,
    };
    UI.missionDef = null;
    UI.conqDef = null;
    UI.tutorial = -1;
    UI.beginWorld(world, `压力测试 · ${size.name} · 目标 ${cfg.n} 兵`);
    UI.speed = 1;
  };

  // 每 4 个模拟步给各家补一批兵，直到达到目标数量（按模拟步数走，各外壳里完全一致）
  function benchSpawn(w) {
    const b = UI.bench;
    if (b.done || w.soldierCount >= b.n || w.tick % 4 !== 0) return;
    const gap = b.n - w.soldierCount;
    const per = gap > 5000 ? 6 : gap > 600 ? 2 : 1; // 离目标还远就多补几队，上万兵的档位不用等太久
    for (const id of ["p"].concat(w.foeIds)) {
      const home = w.structs.filter((s) => s.owner === id && !s.ruined);
      if (!home.length) continue;
      for (let j = 0; j < per; j++) {
        const st = home[(b.k + j) % home.length];
        const type = TYPES[(b.k + j) % TYPES.length];
        const sq = CS.spawnSquad(w, id, type, (b.k + j) % 3, st.x + (w.rand() - 0.5) * 60, st.y + st.R + 16);
        // 目标：离这座城最近的三座敌城里随机一座
        const foes = w.structs.filter((s) => s.owner && s.owner !== id).sort((a, c) => Math.hypot(a.x - st.x, a.y - st.y) - Math.hypot(c.x - st.x, c.y - st.y)).slice(0, 3);
        const tgt = foes[Math.floor(w.rand() * foes.length)];
        if (tgt) CS.orderStruct(w, [sq], tgt);
      }
    }
    b.k++;
  }

  const PHASES = ["close", "zoomout", "overview", "mid"];
  function benchPhase(u, mode) {
    if (mode === "overview") return 2;
    if (mode === "close" || mode === "static") return 0;
    return u < 0.35 ? 0 : u < 0.45 ? 1 : u < 0.72 ? 2 : 3;
  }
  // 相机脚本：近景沿 8 字形巡游（不停地烘焙新地形块）→ 拉远 → 全图俯瞰（所有兵都在屏幕里）→ 中景
  function benchCamera(now) {
    const b = UI.bench;
    const w = UI.world;
    const u = Math.min(1, (now - b.t0) / (b.cfg.secs * 1000));
    const mode = b.cfg.cam;
    const ph = benchPhase(u, mode);
    const fit = R.fitCss();
    if (mode === "static") return;
    if (ph === 0) {
      const a = (mode === "close" ? u : u / 0.35) * Math.PI * 2;
      R.setZoom(1.5, true);
      R.center(w.W / 2 + Math.sin(a) * w.W * 0.36, w.H / 2 + Math.sin(a * 2) * w.H * 0.3, true);
    } else if (ph === 1) {
      const k = (u - 0.35) / 0.1;
      R.setZoom(1.5 * Math.pow(fit / 1.5, k), true);
      R.center(w.W / 2, w.H / 2, true);
    } else if (ph === 2) {
      R.setZoom(fit, true);
      R.center(w.W / 2, w.H / 2, true);
    } else {
      const a = ((u - 0.72) / 0.28) * Math.PI * 2;
      R.setZoom(Math.max(fit, 0.8), true);
      R.center(w.W / 2 + Math.cos(a) * w.W * 0.25, w.H / 2 + Math.sin(a) * w.H * 0.2, true);
    }
  }

  function benchFrame(now, dtMs, simMs, renMs) {
    const b = UI.bench;
    const w = UI.world;
    if (b.done) return;
    b.peak = Math.max(b.peak, w.soldierCount);
    if (b.phase === "ramp" && (w.soldierCount >= b.n * 0.95 || now - b.start > 240000)) {
      b.phase = "measure";
      b.t0 = now;
      b.tick0 = w.tick;
      b.winT = now;
      b.heap0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
      b.chunks0 = R.stats.baked;
    }
    if (b.phase !== "measure") return;
    const u = (now - b.t0) / (b.cfg.secs * 1000);
    b.frames.push(dtMs);
    b.sim.push(simMs);
    b.render.push(renMs);
    b.phaseOf.push(benchPhase(u, b.cfg.cam));
    b.soldierSum += w.soldierCount;
    b.partSum += R.stats.particles;
    b.unitSum += R.stats.units;
    b.winN++;
    b.winMs = Math.max(b.winMs, dtMs);
    // 每 5 秒记一个点，长时间测试看有没有越跑越慢、内存越涨越高
    if (now - b.winT >= 5000) {
      b.timeline.push({
        t: Math.round((now - b.t0) / 1000), fps: +((b.winN * 1000) / (now - b.winT)).toFixed(1), worstMs: +b.winMs.toFixed(1),
        soldiers: w.soldierCount, heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
      });
      b.winT = now;
      b.winN = 0;
      b.winMs = 0;
    }
    if (u >= 1) finishBench();
  }

  function benchStatus() {
    const b = UI.bench;
    if (b.done) return "测试完成";
    if (b.phase === "ramp") return `投放中… ${UI.world.soldierCount}/${b.n}`;
    return `测量中 ${((performance.now() - b.t0) / 1000).toFixed(0)}/${b.cfg.secs} 秒`;
  }

  function gpuName() {
    try {
      const gl = document.createElement("canvas").getContext("webgl");
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } catch (e) { return "unknown"; }
  }
  function pct(arr, p) {
    const s = Array.from(arr).sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0;
  }
  function avg(arr) { let s = 0; for (const v of arr) s += v; return s / Math.max(1, arr.length); }

  function finishBench() {
    const b = UI.bench;
    b.done = true;
    const n = b.frames.length;
    const phases = {};
    PHASES.forEach((name, i) => {
      const fr = b.frames.filter((_, k) => b.phaseOf[k] === i);
      if (!fr.length) return;
      phases[name] = {
        avgFps: +(1000 / avg(fr)).toFixed(1), low1Fps: +(1000 / pct(fr, 0.99)).toFixed(1),
        renderMs: +avg(b.render.filter((_, k) => b.phaseOf[k] === i)).toFixed(2), frames: fr.length,
      };
    });
    const heap1 = performance.memory ? performance.memory.usedJSHeapSize : 0;
    const res = {
      version: CS.VERSION, shell: M.shell(), target: b.n, map: UI.world.map.cols + "x" + UI.world.map.rows, cam: b.cfg.cam, secs: b.cfg.secs,
      peakSoldiers: b.peak, avgSoldiers: Math.round(b.soldierSum / n), avgDrawnUnits: Math.round(b.unitSum / n), avgParticles: Math.round(b.partSum / n),
      structs: UI.world.structs.length, squads: UI.world.squads.length, frames: n,
      avgFps: +(1000 / avg(b.frames)).toFixed(1),
      p50FrameMs: +pct(b.frames, 0.5).toFixed(2), p95FrameMs: +pct(b.frames, 0.95).toFixed(2), p99FrameMs: +pct(b.frames, 0.99).toFixed(2),
      maxFrameMs: +Math.max.apply(null, b.frames).toFixed(1),
      low1Fps: +(1000 / pct(b.frames, 0.99)).toFixed(1),
      over33: b.frames.filter((f) => f > 33.4).length, over50: b.frames.filter((f) => f > 50).length, over100: b.frames.filter((f) => f > 100).length,
      avgSimMs: +avg(b.sim).toFixed(3), p95SimMs: +pct(b.sim, 0.95).toFixed(2),
      // 模拟跑了多少步 ÷ 实时应该跑的步数：低于 1 说明主线程已经跟不上 30 步/秒，游戏在变慢
      simSpeed: +((UI.world.tick - b.tick0) / (((performance.now() - b.t0) / 1000) * 30)).toFixed(3),
      avgRenderMs: +avg(b.render).toFixed(3), p95RenderMs: +pct(b.render, 0.95).toFixed(2),
      phases, timeline: b.timeline,
      chunksBaked: R.stats.baked - b.chunks0, chunkCacheMP: R.stats.chunkMP,
      heapStartMB: +(b.heap0 / 1048576).toFixed(1), heapEndMB: +(heap1 / 1048576).toFixed(1),
      errors: M.errors.slice(0, 5), errorCount: M.errors.length,
      canvas: $("#view").width + "x" + $("#view").height, dpr: root.devicePixelRatio, rf: Object.assign({}, CS.RF),
      atlas: CS.atlasInfo, gpu: gpuName(), ua: navigator.userAgent,
    };
    root.__bench = res;
    document.body.dataset.bench = JSON.stringify(res);
    post({ event: "bench", res });
    UI.paused = true;
    const ph = Object.entries(phases).map(([k, v]) => `<tr><td>${{ close: "近景巡游", zoomout: "拉远过程", overview: "全图俯瞰", mid: "中景" }[k]}</td><td>${v.avgFps} FPS · 1% Low ${v.low1Fps} · 渲染 ${v.renderMs} ms</td></tr>`).join("");
    $("#modal-card").className = "card wide";
    $("#modal-card").innerHTML = `<h2>压力测试结果</h2>
      <table>
        <tr><td>运行环境</td><td>${res.shell} · 地图 ${res.map} · ${res.structs} 座据点</td></tr>
        <tr><td>士兵（平均 / 峰值）</td><td>${res.avgSoldiers} / ${res.peakSoldiers}</td></tr>
        <tr><td>平均 FPS</td><td>${res.avgFps}</td></tr>
        <tr><td>1% Low FPS</td><td>${res.low1Fps}</td></tr>
        <tr><td>帧时间 P50 / P95 / P99 / 最大</td><td>${res.p50FrameMs} / ${res.p95FrameMs} / ${res.p99FrameMs} / ${res.maxFrameMs} ms</td></tr>
        <tr><td>卡顿帧 &gt;33 / &gt;50 / &gt;100 ms</td><td>${res.over33} / ${res.over50} / ${res.over100}（共 ${res.frames} 帧）</td></tr>
        <tr><td>模拟耗时（每帧）</td><td>${res.avgSimMs} ms（P95 ${res.p95SimMs}）· 模拟速度 ${Math.round(res.simSpeed * 100)}% 实时</td></tr>
        <tr><td>渲染耗时（每帧，JS 侧）</td><td>${res.avgRenderMs} ms（P95 ${res.p95RenderMs}）</td></tr>
        ${ph}
        <tr><td>地形块烘焙 / 缓存</td><td>${res.chunksBaked} 块 / ${res.chunkCacheMP} MP</td></tr>
        <tr><td>JS 堆 起 → 止</td><td>${res.heapStartMB} → ${res.heapEndMB} MB</td></tr>
        <tr><td>脚本错误</td><td>${res.errorCount}</td></tr>
        <tr><td>画布</td><td>${res.canvas} @ dpr ${res.dpr}</td></tr>
      </table>
      <p class="muted" style="font-size:12px;word-break:break-all">${res.ua}</p>
      <div class="btns"><button data-m="retry">再测一次</button><button data-m="map">返回标题</button></div>`;
    $("#modal").hidden = false;
  }
})(typeof window !== "undefined" ? window : globalThis);
