const path = require("path");
globalThis.CS = {};
for (const f of ["data", "missions", "map", "sim", "ai"]) require(path.join(__dirname, "../game/js", f + ".js"));
const N = +(process.argv[2] || 2000);
const w = CS.createWorld({ player: "duchy", layout: CS.LAYOUTS.finale, diff: 5, gold: 99999, enemies: { a: "horde", b: "cult" }, edicts: {}, autoplay: true, seed: 5 });
for (const st of w.structs) { st.maxHp *= 6; st.hp *= 6; }
for (const o of Object.values(w.owners)) o.gold = 99999;
const types = ["foot", "archer", "cav", "foot", "mage", "archer", "siege"];
let k = 0, times = [];
const t0 = Date.now();
while (w.t < 90) {
  if (w.soldierCount < N && w.tick % 6 === 0) for (const id of ["p","a","b"]) {
    const home = w.structs.filter((s) => s.owner === id && !s.ruined); if (!home.length) continue;
    const st = home[k % home.length]; const sq = CS.spawnSquad(w, id, types[k % types.length], k % 3, st.x + (w.rand()-0.5)*40, st.y + st.R + 16); k++;
    const foes = w.structs.filter((s) => s.owner && s.owner !== id); CS.orderStruct(w, [sq], foes[k % foes.length]);
  }
  const a = process.hrtime.bigint(); CS.step(w); CS.aiTick(w); w.events.length = 0;
  if (w.t > 30) times.push(Number(process.hrtime.bigint() - a) / 1e6);
}
times.sort((a,b)=>a-b);
console.log(JSON.stringify({ N, peak: w.soldierCount, avg: +(times.reduce((a,b)=>a+b,0)/times.length).toFixed(3), p95: +times[Math.floor(times.length*0.95)].toFixed(3), wall: Date.now()-t0, paths: CS.pathCalls }));
