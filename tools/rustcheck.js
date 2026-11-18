// Rust 移植对拍：同一份初始化数据，JS 版（game/js/sim.js）和 Rust 版（src-tauri/simcore）各跑同样的步数，
// 逐秒比较士兵数 / 部队数 / 飞行物 / 交战部队 / 累计事件数，最后把 Rust 的快照交给 JS 的解码器验证格式。
//   node tools/rustcheck.js [士兵数] [步数] [地图规格] [--exact]
// --exact：两边的 sin / cos 临时换成同一个只用加减乘除的实现，消掉“最后一位”的差别，验证逻辑是否逐步等价。
// 先编译：cargo build --release --manifest-path src-tauri/Cargo.toml -p simcore --bin simcheck
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
globalThis.CS = {};
for (const f of ["data", "missions", "map", "sim", "ai", "benchcore", "snap"]) require(path.join(__dirname, "../game/js", f + ".js"));
const CS = globalThis.CS;
const EXACT = process.argv.includes("--exact");
if (EXACT) {
  const TWO_PI = 6.283185307179586;
  const xsin = (x) => {
    const y = x - Math.floor(x / TWO_PI + 0.5) * TWO_PI;
    const y2 = y * y;
    let term = y; let sum = y;
    for (let k = 1; k < 12; k++) { term = -term * y2 / ((2 * k) * (2 * k + 1)); sum += term; }
    return sum;
  };
  Math.sin = xsin;
  Math.cos = (x) => xsin(x + 1.5707963267948966);
}
const N = +(process.argv[2] || 3000);
const STEPS = +(process.argv[3] || 900);
const cfg = { n: N, map: process.argv[4] || "l", seed: 7 };
const tmp = path.join(__dirname, "..", "bench", "tmp");
fs.mkdirSync(tmp, { recursive: true });
const initFile = path.join(tmp, `init-${N}.json`);
const snapFile = path.join(tmp, `rust-${N}.snap`);
fs.writeFileSync(initFile, JSON.stringify(CS.benchInit(cfg)));

// ---- JS ----
const w = CS.benchWorld(cfg);
const b = { n: N, k: 0, done: false };
const ev = {};
const js = [];
const times = [];
for (let i = 0; i < STEPS; i++) {
  const a = process.hrtime.bigint();
  CS.benchSpawn(w, b); CS.step(w); CS.aiTick(w);
  const ms = Number(process.hrtime.bigint() - a) / 1e6;
  for (const e of w.events) ev[e.e] = (ev[e.e] || 0) + 1;
  w.events.length = 0;
  if (w.soldierCount >= N * 0.95) times.push(ms);
  if (w.tick % 30 === 0) {
    js.push([w.tick, w.soldierCount, w.squads.length, w.proj.length, w.effects.length, w.squads.filter((q) => q.fighting).length, w.squads.filter((q) => q.inside).length,
      w.structs.filter((s) => !s.ruined).length, ev.die || 0, ev.hit || 0, ev.shoot || 0, ev.cast || 0, Math.round(Object.values(w.owners).reduce((s, o) => s + o.gold, 0))]);
  }
}
times.sort((x, y) => x - y);
const jsAvg = times.reduce((x, y) => x + y, 0) / Math.max(1, times.length);

// ---- Rust ----
const exe = path.join(__dirname, "..", "src-tauri", "target", "release", "simcheck.exe");
const out = execFileSync(exe, [initFile, String(STEPS), "--series", "--snap", snapFile].concat(EXACT ? ["--exact"] : []), { maxBuffer: 1 << 26 }).toString().split(/\r?\n/);
const rs = out.filter((l) => l.startsWith("S ")).map((l) => l.slice(2).split(" ").map(Number));
const R = JSON.parse(out.find((l) => l.startsWith("R ")).slice(2));

// ---- 比较 ----
const cols = ["tick", "士兵", "部队", "飞行物", "法术区", "交战部队", "驻守部队", "完好据点", "阵亡(累计)", "近战命中(累计)", "射击(累计)", "施法(累计)", "金币合计"];
let firstDiff = null;
const maxRel = new Array(cols.length).fill(0);
for (let i = 0; i < Math.min(js.length, rs.length); i++) {
  for (let k = 1; k < cols.length; k++) {
    const a = js[i][k]; const c = rs[i][k];
    if (a !== c && !firstDiff) firstDiff = { sec: i + 1, col: cols[k], js: a, rust: c };
    const rel = Math.abs(a - c) / Math.max(20, Math.abs(a));
    if (rel > maxRel[k]) maxRel[k] = rel;
  }
}
const show = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120].filter((s) => s <= js.length);
console.log("每列：JS / Rust");
console.log(["秒"].concat(cols.slice(1, 12)).join(" | "));
for (const s of show) console.log([s].concat(cols.slice(1, 12).map((_, k) => js[s - 1][k + 1] + " / " + rs[s - 1][k + 1])).join(" | "));
console.log("第一处不同：" + (firstDiff ? `第 ${firstDiff.sec} 秒 ${firstDiff.col} JS ${firstDiff.js} Rust ${firstDiff.rust}` : "无（逐秒完全一致）"));
console.log("各列最大相对偏差：" + cols.slice(1).map((c, k) => c + " " + (maxRel[k + 1] * 100).toFixed(1) + "%").join("，"));

// ---- Rust 快照 → JS 解码 ----
const raw = fs.readFileSync(snapFile);
const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const mirror = CS.benchWorld(cfg);
const info = CS.snap.apply(mirror, buf);
let bad = 0;
let units = 0;
for (const sq of mirror.squads) {
  if (!sq.st || !CS.UNITS[sq.type] || !mirror.owners[sq.owner]) bad++;
  if (sq.inside) { if (!mirror.structMap.get(sq.inside)) bad++; continue; }
  for (const u of sq.units) { units++; if (!(u.x >= 0 && u.x <= mirror.W && u.y >= 0 && u.y <= mirror.H) || !(u.hp > 0)) bad++; }
}
console.log(JSON.stringify({
  target: N, steps: STEPS, exactTrig: EXACT, identical: !firstDiff,
  js: { soldiers: w.soldierCount, squads: w.squads.length, avgStepMs: +jsAvg.toFixed(3), p95StepMs: +(times[Math.floor(times.length * 0.95)] || 0).toFixed(3) },
  rust: { soldiers: R.soldiers, squads: R.squads, avgStepMs: R.avgStepMs, p95StepMs: R.p95StepMs, initMs: R.initMs },
  speedup: +(jsAvg / R.avgStepMs).toFixed(2),
  snapshot: { bytes: info.bytes, decodedUnits: units, headerSoldiers: mirror.soldierCount, squads: mirror.squads.length, events: info.events, badRecords: bad },
}));
