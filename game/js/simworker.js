// Web Worker 后端：同一份 sim.js / ai.js 搬到工作线程里按实时节奏跑，主线程每步来取一份快照。
// 这是“Rust 后端”的对照组：同样离开了主线程、同样要传快照，但算的还是 JS，也不经过 Tauri。
"use strict";
self.CS = {};
importScripts("data.js", "missions.js", "map.js", "sim.js", "ai.js", "benchcore.js", "snap.js");
const CS = self.CS;

let world = null;
let bench = null;
let running = false;
let acc = 0;
let last = 0;
const waiting = []; // 主线程在等的请求：各自开始等的时刻（流水线时会有好几个）
const pend = { fx: [], ev: [], stepMs: 0, waitMs: 0 };

function collect() {
  const ev = world.events;
  for (let i = 0; i < ev.length && pend.ev.length < 20000; i++) pend.ev.push(ev[i]);
  ev.length = 0;
  for (const f of world.fx) if (!f._s) { f._s = 1; if (pend.fx.length < 2000) pend.fx.push(f); }
}

function reply(waitMs) {
  pend.waitMs = waitMs;
  const buf = CS.snap.encode(world, pend);
  pend.fx.length = 0;
  pend.ev.length = 0;
  self.postMessage({ type: "snap", buf }, [buf]);
}

function loop() {
  if (!running) return;
  const now = performance.now();
  acc += Math.min(250, now - last) / 1000;
  last = now;
  let n = 0;
  while (acc >= CS.STEP && n < 10) {
    const t0 = performance.now();
    CS.benchSpawn(world, bench);
    CS.step(world);
    CS.aiTick(world);
    collect();
    pend.stepMs = performance.now() - t0;
    acc -= CS.STEP;
    n++;
  }
  if (n === 10) acc = 0;
  if (n && waiting.length) reply(performance.now() - waiting.shift()); // 每算完一批步只回一份，和 Rust 后端一样
  setTimeout(loop, Math.max(0, (CS.STEP - acc) * 1000 - 0.5));
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") {
    world = CS.benchWorld(m.cfg);
    bench = { n: m.cfg.n, k: 0, done: false };
    running = true;
    acc = 0;
    last = performance.now();
    loop();
  } else if (m.type === "req") {
    // 和 Rust 后端同一个约定：收到请求后，等下一个模拟步算完再回（不回“已经算好的旧一步”）
    waiting.push(performance.now());
  } else if (m.type === "stop") {
    running = false;
  }
};
