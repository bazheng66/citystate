// 纯模拟耗时（不渲染）：node tools/simbench.js [士兵数] [地图规格 s/m/l/xl]
// 和页面里的压力测试用同一套设置：全 AI 托管、据点打不坏、兵死了补。
const path = require("path");
globalThis.CS = {};
for (const f of ["data", "missions", "map", "sim", "ai"]) require(path.join(__dirname, "../game/js", f + ".js"));
const CS = globalThis.CS;
const N = +(process.argv[2] || 2000);
const size = CS.MAP_SIZES.find((s) => s.id === (process.argv[3] || "l"));
const foes = Array.from({ length: size.foes }, (_, i) => CS.PLAYABLE[(i + 1) % CS.PLAYABLE.length]);
const layout = CS.genContinent({ cols: size.cols, rows: size.rows, seed: 7, foes, biome: "temperate" });
const enemies = {};
foes.forEach((f, i) => { enemies[CS.OWNER_IDS[i + 1]] = f; });
const w = CS.createWorld({ player: "duchy", layout, diff: 5, gold: 99999, aiGold: 99999, enemies, edicts: {}, autoplay: true, seed: 7, noCap: true, bench: true });
const TYPES = ["foot", "archer", "cav", "foot", "mage", "archer", "siege", "guard"];
let k = 0;
const times = [];
let full = 0;
const t0 = Date.now();
while (full < 300 && Date.now() - t0 < 240000) {
  if (w.soldierCount < N && w.tick % 4 === 0) {
    const per = N - w.soldierCount > 5000 ? 6 : N - w.soldierCount > 600 ? 2 : 1;
    for (const id of ["p"].concat(w.foeIds)) {
      const home = w.structs.filter((s) => s.owner === id && !s.ruined);
      if (!home.length) continue;
      for (let j = 0; j < per; j++) {
        const st = home[(k + j) % home.length];
        const sq = CS.spawnSquad(w, id, TYPES[(k + j) % TYPES.length], (k + j) % 3, st.x + (w.rand() - 0.5) * 60, st.y + st.R + 16);
        const tg = w.structs.filter((s) => s.owner && s.owner !== id).sort((a, c) => Math.hypot(a.x - st.x, a.y - st.y) - Math.hypot(c.x - st.x, c.y - st.y)).slice(0, 3);
        const tgt = tg[Math.floor(w.rand() * tg.length)];
        if (tgt) CS.orderStruct(w, [sq], tgt);
      }
    }
    k++;
  }
  const a = process.hrtime.bigint();
  CS.step(w); CS.aiTick(w); w.events.length = 0;
  if (w.soldierCount >= N * 0.95) { times.push(Number(process.hrtime.bigint() - a) / 1e6); full++; }
}
times.sort((a, b) => a - b);
const avg = times.reduce((a, b) => a + b, 0) / Math.max(1, times.length);
console.log(JSON.stringify({ N, map: size.cols + "x" + size.rows, soldiers: w.soldierCount, squads: w.squads.length, steps: times.length,
  avgStepMs: +avg.toFixed(2), p95StepMs: +(times[Math.floor(times.length * 0.95)] || 0).toFixed(2), realtimeBudgetMs: 33.3, wallS: Math.round((Date.now() - t0) / 1000) }));
