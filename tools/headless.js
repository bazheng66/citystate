// 无头跑一局：node tools/headless.js <势力|all> <关卡|all> [最长秒数]
//           node tools/headless.js conquest <s|m|l|xl> [种子] [最长秒数]   AI 全托管的大陆征服
const path = require("path");
globalThis.CS = {};
for (const f of ["data", "missions", "map", "sim", "ai"]) require(path.join(__dirname, "../game/js", f + ".js"));
const CS = globalThis.CS;

function loop(w, maxT) {
  const t0 = Date.now();
  let peak = 0, steps = 0, worst = 0;
  while (!w.outcome && w.t < maxT) {
    const a = process.hrtime.bigint();
    CS.step(w); CS.aiTick(w);
    const ms = Number(process.hrtime.bigint() - a) / 1e6;
    worst = Math.max(worst, ms); steps++;
    peak = Math.max(peak, w.soldierCount);
    w.events.length = 0;
  }
  const own = {};
  for (const id of ["p"].concat(w.foeIds, ["n"])) own[id] = w.structs.filter((s) => s.owner === id && !s.ruined).length;
  own.ruin = w.structs.filter((s) => s.ruined).length;
  return { outcome: w.outcome || "timeout", t: Math.round(w.t), structs: own, peakSoldiers: peak,
    avgStepMs: +((Date.now() - t0) / steps).toFixed(3), worstStepMs: +worst.toFixed(2),
    kills: w.stats.kills, lost: w.stats.lost, gold: Math.round(w.owners.p.gold), paths: CS.pathCalls };
}
function run(faction, idx, maxT) {
  const m = CS.CAMPAIGNS[faction][idx];
  const enemies = { a: m.a }; if (m.b) enemies.b = m.b;
  const w = CS.createWorld({ player: faction, layout: CS.LAYOUTS[m.layout], flip: m.flip, diff: m.diff, gold: m.gold, enemies, edicts: {}, autoplay: true, seed: 1 });
  return Object.assign({ id: faction + "-" + (idx + 1), layout: m.layout }, loop(w, maxT));
}
function conquest(sizeId, seed, maxT) {
  const size = CS.MAP_SIZES.find((s) => s.id === sizeId) || CS.MAP_SIZES[1];
  const pool = CS.PLAYABLE.slice(1);
  const foes = Array.from({ length: size.foes }, (_, i) => pool[i % pool.length]);
  const t0 = Date.now();
  const layout = CS.genContinent({ cols: size.cols, rows: size.rows, seed, foes, biome: "temperate" });
  const enemies = {};
  foes.forEach((f, i) => { enemies[CS.OWNER_IDS[i + 1]] = f; });
  const w = CS.createWorld({ player: "duchy", layout, diff: 3, gold: 260, enemies, edicts: {}, autoplay: true, seed, noCap: true });
  const genMs = Date.now() - t0;
  const grid = w.map.grid; const cnt = [0, 0, 0, 0, 0];
  for (const v of grid) cnt[v]++;
  return Object.assign({ id: "conquest-" + sizeId + "-" + seed, map: w.map.cols + "x" + w.map.rows, sites: w.structs.length, camps: w.chests.length, roads: w.map.roads.length, genMs,
    terrain: { grass: cnt[0], forest: cnt[1], rock: cnt[2], water: cnt[3], bridge: cnt[4] } }, loop(w, maxT));
}
const [fac = "duchy", which = "all", a3, a4] = process.argv.slice(2);
if (fac === "conquest") console.log(JSON.stringify(conquest(which === "all" ? "m" : which, Number(a3 || 7), Number(a4 || 900))));
else {
  const facs = fac === "all" ? CS.CAMPAIGN_ORDER : [fac];
  for (const f of facs) {
    const list = which === "all" ? CS.CAMPAIGNS[f].map((_, i) => i) : [Number(which) - 1];
    for (const i of list) console.log(JSON.stringify(run(f, i, Number(a3 || 900))));
  }
}
