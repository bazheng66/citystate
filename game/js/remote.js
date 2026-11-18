// 远端模拟的主线程一侧：模拟在别处跑（Web Worker 或 Tauri 的 Rust 线程），这里每帧取最新快照还原进镜像世界。
//   sim=worker  同一份 JS 模拟放进 Web Worker，快照用 postMessage 转移（零拷贝）
//   sim=rust    模拟由 Rust 重写、跑在外壳的原生线程里，快照经 Tauri IPC（invoke，二进制响应）取回
//   sim=rustp   同上，但页面同时挂 3 个请求（流水线），用来看 IPC 延迟能不能靠并发藏起来；sim=workerp 是 Worker 的同款对照
// 前两种后端用同一种“一问一答”的节奏：主线程发请求，后端等到下一个模拟步算完就回一份快照。
// rustp 时后端每算完一步就编一份排队，每份只交给一个请求，所以事件不重复也不丢；回来的顺序可能乱，按步号排好再还原。
(function (root) {
  "use strict";
  const CS = root.CS;
  const R = (CS.remote = { active: false, kind: "main" });

  let tr = null;
  let world = null;
  let inFlight = 0;
  let depth = 1;
  let pending = [];
  let lastTick = -1;
  let applyAt = 0;
  let stopped = true;
  let S = null;

  function workerTransport(cfg) {
    const wk = new Worker("js/simworker.js");
    const res = []; // 按发出顺序排队：Worker 按收到请求的顺序回
    wk.onmessage = (e) => { if (e.data.type === "snap" && res.length) res.shift()(e.data.buf); };
    wk.onerror = (e) => { CS.main.errors.push("worker: " + (e.message || e)); };
    wk.postMessage({ type: "init", cfg });
    return {
      request() { return new Promise((r) => { res.push(r); wk.postMessage({ type: "req" }); }); },
      stop() { wk.terminate(); },
    };
  }

  function rustTransport(cfg) {
    const T = root.__TAURI_INTERNALS__;
    if (!T || !T.invoke) throw new Error("sim=rust 只能在 Tauri 外壳里用");
    const t0 = performance.now();
    const ready = T.invoke("sim_start", { init: CS.benchInit(cfg) }).then(() => { R.initMs = performance.now() - t0; });
    return {
      request(tick) { return ready.then(() => T.invoke("sim_snap", { after: tick })); },
      stop() { T.invoke("sim_stop").catch(() => {}); },
    };
  }

  R.start = function (kind, cfg, w) {
    R.stop();
    world = w;
    w.remote = kind;
    R.kind = kind;
    R.active = true;
    stopped = false;
    inFlight = 0;
    depth = kind === "rustp" || kind === "workerp" ? 3 : 1;
    pending = [];
    lastTick = -1;
    applyAt = 0;
    S = R.stats = { snaps: 0, bytes: 0, transit: [], decode: [], stepMs: 0, wait: 0, events: 0, late: 0, on: false };
    tr = kind === "rust" || kind === "rustp" ? rustTransport(cfg) : workerTransport(cfg);
  };

  R.stop = function () {
    if (tr) tr.stop();
    tr = null;
    stopped = true;
    R.active = false;
  };

  // 每帧调用一次：有新快照就还原，然后（如果没有请求在路上）再要下一份。
  // 返回 { alpha: 两步之间的插值系数, syncMs: 这一帧花在还原快照上的时间 }
  R.pump = function (now) {
    let syncMs = 0;
    if (pending.length) {
      if (pending.length > 1) pending.sort((a, b) => a.tick - b.tick);
      const t0 = performance.now();
      for (const p of pending) {
        // 比已经画上去的那一步还旧（流水线里晚到的）：状态不能倒退，整份丢掉
        if (p.tick <= lastTick) { if (S.on) S.late++; continue; }
        const info = CS.snap.apply(world, p.buf);
        lastTick = p.tick;
        if (S.on) {
          S.snaps++;
          S.bytes += info.bytes;
          S.events += info.events;
          S.stepMs += info.stepMs;
          S.wait += info.waitMs;
          S.transit.push(Math.max(0, p.rt - info.waitMs)); // 往返时间里扣掉后端“等下一步算完”的那段，剩下的是传输
        }
      }
      syncMs = performance.now() - t0;
      if (S.on) S.decode.push(syncMs);
      applyAt = now;
      pending = [];
    }
    while (inFlight < depth && !stopped) {
      inFlight++;
      const s = performance.now();
      tr.request(world.tick).then((buf) => {
        inFlight--;
        if (buf && buf.byteLength) pending.push({ buf, rt: performance.now() - s, tick: new Uint32Array(buf, 0, 2)[1] });
      }).catch((err) => { inFlight--; CS.main.errors.push("remote: " + String(err)); });
    }
    return { alpha: applyAt ? Math.min(1, (now - applyAt) / (CS.STEP * 1000)) : 1, syncMs };
  };

  R.summary = function () {
    if (!S || !S.snaps) return null;
    const avg = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0; };
    return {
      // 画面每秒拿到几份新快照：传输太慢时后端照样按实时算，但页面更新跟不上 30 次/秒
      snaps: S.snaps, snapHz: S.onAt ? +((S.snaps * 1000) / (performance.now() - S.onAt)).toFixed(1) : null, avgBytes: Math.round(S.bytes / S.snaps), avgEvents: Math.round(S.events / S.snaps),
      backendStepMs: +(S.stepMs / S.snaps).toFixed(3),
      transitMs: +avg(S.transit).toFixed(3), transitP95Ms: +pct(S.transit, 0.95).toFixed(3), transitMaxMs: +Math.max.apply(null, S.transit).toFixed(2),
      decodeMs: +avg(S.decode).toFixed(3), decodeP95Ms: +pct(S.decode, 0.95).toFixed(3),
      late: S.late, depth,
      initMs: R.initMs ? +R.initMs.toFixed(1) : null,
    };
  };
})(typeof window !== "undefined" ? window : globalThis);
