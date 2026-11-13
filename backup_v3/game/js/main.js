// 启动、主循环、压力测试
(function (root) {
  "use strict";
  const CS = root.CS;
  const UI = CS.ui;
  const M = (CS.main = {});
  const $ = (s) => document.querySelector(s);

  const sheet = new Image();
  let acc = 0;
  let last = 0;
  let frameAvg = 16.7;
  let renderAvg = 0;
  let simFrame = 0;
  let fps = 60;
  let hudT = 0;
  const frameTimes = [];

  // 图块：Kenney RTS Medieval（旧地形，部分特效）、Kenney Tiny Town（建筑 / 地形）、0x72 DungeonTileset II（角色）
  const dungeon = new Image();
  const town = new Image();
  CS.IMG = { kenney: sheet, dungeon, town };
  let pending = 3;
  for (const [img, src] of [[sheet, "assets/medieval/medieval_tilesheet.png"], [dungeon, "assets/dungeon2/sheet.png"], [town, "assets/tinytown/tilemap_packed.png"]]) {
    img.onload = () => { if (--pending === 0) boot(); };
    img.onerror = () => { document.body.innerHTML = "<p style='padding:40px'>图块加载失败：" + src + "</p>"; };
    img.src = src;
  }

  function boot() {
    CS.buildSprites2(dungeon);
    CS.render.init($("#view"), sheet);
    const st = CS.save.load().settings;
    CS.audio.setVolume(st.vol);
    CS.audio.setMuted(st.muted);
    CS.audio.music.enabled = st.music !== false;
    UI.perf = st.perf;
    window.addEventListener("resize", M.fit);
    const q = new URLSearchParams(location.search);
    if (q.get("bench")) M.startBench(Number(q.get("bench")) || 1000);
    else if (q.get("mission")) {
      const [f, i] = q.get("mission").split("-");
      if (q.get("unlock")) CS.save.get().settings.unlockAll = true;
      UI.startMission(f, Number(i) - 1);
      if (q.get("auto")) UI.world.owners.p.ai = true;
      if (q.get("speed")) UI.speed = Number(q.get("speed"));
    } else UI.show("title");
    requestAnimationFrame(loop);
    document.body.dataset.ready = "1";
  }

  M.fit = function () {
    const stage = $("#stage");
    if (!stage || stage.offsetParent === null) return;
    CS.render.resize(stage.clientWidth, stage.clientHeight, Math.min(2, window.devicePixelRatio || 1));
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
    // 模拟
    const s0 = performance.now();
    if (!UI.paused && !w.outcome) {
      acc += (dtMs / 1000) * UI.speed;
      let n = 0;
      while (acc >= CS.STEP && n < 10) {
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
    UI.selStructRef = UI.selStruct;
    CS.render.draw(w, UI.paused || w.outcome ? 1 : Math.min(1, acc / CS.STEP), {
      markers: UI.markers, now, selStruct: UI.selStruct, hoverSlot: UI.hoverSlot, box: UI.box,
      aim: UI.aim, aimOk: UI.aimOk, mouse: UI.mouse, flagLine: UI.flagLine,
    });
    if (UI.paused && !UI.modalOpen() && !w.outcome) CS.render.overlay("暂停");
    if (UI.banner) {
      const age = (now - UI.banner.t) / 1000;
      if (age > 4) UI.banner = null;
      else CS.render.banner(UI.banner.text, UI.banner.sub, age < 0.4 ? age / 0.4 : age > 3.2 ? (4 - age) / 0.8 : 1);
    }
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
      perf.textContent = `FPS ${fps.toFixed(0)}  帧 ${frameAvg.toFixed(1)}ms\n模拟 ${simFrame.toFixed(2)}ms/帧 (${w.perf.sim.toFixed(3)}ms/步)\n渲染 ${renderAvg.toFixed(2)}ms\n士兵 ${w.soldierCount}  部队 ${w.squads.length}  飞行物 ${w.proj.length}\n画布 ${$("#view").width}×${$("#view").height}${UI.bench ? "\n" + benchStatus() : ""}`;
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
    const facs = ["duchy", "horde", "cult"];
    const types = ["foot", "archer", "cav", "mage", "foot", "siege"];
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
    for (let i = 0; i < 18; i++) {
      const fac = facs[i % 3];
      const type = types[i % types.length];
      const dir = i % 2 ? 1 : -1;
      const speed = type === "cav" ? 60 : 30;
      const x = ((i * 97 + t * speed * dir) % 760 + 760) % 760 - 60;
      const y = 142 + (i % 3) * 16;
      const s = CS.unitSprite(fac, type, "run", Math.floor(t * 8 + i) % 4, dir);
      const k = 1.5;
      g.drawImage(s.c, Math.round(x - s.ax * k), Math.round(y - s.ay * k), s.w * k, s.h * k);
    }
  }

  // ---------- 压力测试 ----------
  M.startBench = function (n) {
    const world = CS.createWorld({
      player: "duchy", layout: CS.LAYOUTS.finale, flip: false, diff: 5, gold: 99999,
      enemies: { a: "horde", b: "cult" }, edicts: {}, autoplay: true,
    });
    for (const st of world.structs) { st.maxHp *= 6; st.hp *= 6; }
    for (const o of Object.values(world.owners)) { o.gold = 99999; o.mana = 150; }
    world.owners.p.ai = true;
    UI.bench = { n, t0: 0, frames: [], sim: [], render: [], peak: 0, phase: "ramp", start: performance.now(), done: false };
    UI.missionDef = null;
    UI.tutorial = -1;
    UI.beginWorld(world, `压力测试 · 目标 ${n} 兵`);
    UI.speed = 1;
  };

  function benchFrame(now, dtMs, simMs, renMs) {
    const b = UI.bench;
    const w = UI.world;
    if (b.done) return;
    // 投放兵力：四方轮流，直到达到目标
    if (w.soldierCount < b.n && w.tick % 6 === 0) {
      const owners = ["p", "a", "b"];
      const types = ["foot", "archer", "cav", "foot", "mage", "archer", "siege"];
      for (const id of owners) {
        const home = w.structs.filter((s) => s.owner === id && !s.ruined);
        if (!home.length) continue;
        const st = home[(w.tick / 6 | 0) % home.length];
        const type = types[(w.tick / 6 | 0) % types.length];
        const sq = CS.spawnSquad(w, id, type, (w.tick / 6 | 0) % 3, st.x + (Math.random() - 0.5) * 40, st.y + st.R + 16);
        const foes = w.structs.filter((s) => s.owner && s.owner !== id);
        const tgt = foes[Math.floor(Math.random() * foes.length)];
        if (tgt) CS.orderStruct(w, [sq], tgt);
      }
    }
    b.peak = Math.max(b.peak, w.soldierCount);
    if (b.phase === "ramp" && (w.soldierCount >= b.n * 0.95 || now - b.start > 20000)) { b.phase = "measure"; b.t0 = now; }
    if (b.phase === "measure") {
      b.frames.push(dtMs);
      b.sim.push(simMs);
      b.render.push(renMs);
      if (now - b.t0 > 30000) finishBench();
    }
  }

  function benchStatus() {
    const b = UI.bench;
    if (b.done) return "测试完成";
    if (b.phase === "ramp") return `投放中… ${UI.world.soldierCount}/${b.n}`;
    return `测量中 ${((performance.now() - b.t0) / 1000).toFixed(0)}/30 秒`;
  }

  function pct(arr, p) {
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0;
  }
  function avg(arr) { return arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length); }

  function finishBench() {
    const b = UI.bench;
    b.done = true;
    const res = {
      target: b.n, peakSoldiers: b.peak, frames: b.frames.length,
      avgFps: +(1000 / avg(b.frames)).toFixed(1),
      p95FrameMs: +pct(b.frames, 0.95).toFixed(2), p99FrameMs: +pct(b.frames, 0.99).toFixed(2),
      low1Fps: +(1000 / pct(b.frames, 0.99)).toFixed(1),
      avgSimMs: +avg(b.sim).toFixed(3), avgRenderMs: +avg(b.render).toFixed(3), p95RenderMs: +pct(b.render, 0.95).toFixed(2),
      canvas: $("#view").width + "x" + $("#view").height, dpr: window.devicePixelRatio,
      shell: navigator.userAgent.includes("Electron") ? "Electron" : (window.__TAURI_INTERNALS__ || window.__TAURI__) ? "Tauri" : "Browser",
      ua: navigator.userAgent,
    };
    window.__bench = res;
    document.body.dataset.bench = JSON.stringify(res);
    UI.paused = true;
    $("#modal-card").innerHTML = `<h2>压力测试结果</h2>
      <table>
        <tr><td>运行环境</td><td>${res.shell}</td></tr>
        <tr><td>峰值士兵</td><td>${res.peakSoldiers}</td></tr>
        <tr><td>平均 FPS</td><td>${res.avgFps}</td></tr>
        <tr><td>1% Low FPS</td><td>${res.low1Fps}</td></tr>
        <tr><td>帧时间 P95 / P99</td><td>${res.p95FrameMs} / ${res.p99FrameMs} ms</td></tr>
        <tr><td>模拟耗时（每帧）</td><td>${res.avgSimMs} ms</td></tr>
        <tr><td>渲染耗时 平均 / P95</td><td>${res.avgRenderMs} / ${res.p95RenderMs} ms</td></tr>
        <tr><td>画布</td><td>${res.canvas} @ dpr ${res.dpr}</td></tr>
      </table>
      <p class="muted" style="font-size:12px;word-break:break-all">${res.ua}</p>
      <div class="btns"><button data-m="retry">再测一次</button><button data-m="map">返回标题</button></div>`;
    $("#modal").hidden = false;
  }
})(typeof window !== "undefined" ? window : globalThis);
