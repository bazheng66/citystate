// 比较 Rust 版数学函数（src-tauri/simcore/src/jsmath.rs）和 V8 的结果是否逐位相同。
//   node tools/mathcheck.js [样本数]
const path = require("path");
const { execFileSync } = require("child_process");
globalThis.CS = {};
for (const f of ["data", "map"]) require(path.join(__dirname, "../game/js", f + ".js"));
const n = +(process.argv[2] || 200000);
const out = execFileSync(path.join(__dirname, "..", "src-tauri", "target", "release", "mathcheck.exe"), [String(n)], { maxBuffer: 1 << 28 }).toString().split("\n");
const r = globalThis.CS.rng(12345);
const dv = new DataView(new ArrayBuffer(8));
const bits = (v) => { dv.setFloat64(0, v); return dv.getBigUint64(0).toString(16).padStart(16, "0"); };
const diff = { hypot: 0, sin: 0, cos: 0, atan2: 0 };
for (let i = 0; i < n; i++) {
  const a = (r() - 0.5) * 4000; const b = (r() - 0.5) * 4000; const ang = (r() - 0.5) * 20;
  const [h, s, c, t] = out[i].trim().split(" ");
  if (h !== bits(Math.hypot(a, b))) diff.hypot++;
  if (s !== bits(Math.sin(ang))) diff.sin++;
  if (c !== bits(Math.cos(ang))) diff.cos++;
  if (t !== bits(Math.atan2(a, b))) diff.atan2++;
}
console.log(JSON.stringify({ samples: n, node: process.version, v8: process.versions.v8, mismatches: diff }));
