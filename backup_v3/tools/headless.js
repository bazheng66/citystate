// node tools/headless.js [faction] [index|all] [maxSeconds]
const path = require("path");
globalThis.CS = {};
for (const f of ["data", "missions", "map", "sim", "ai"]) require(path.join(__dirname, "../game/js", f + ".js"));
const CS = globalThis.CS;
function run(faction, idx, maxT, edicts) {
  const m = CS.CAMPAIGNS[faction][idx];
  const w = CS.createWorld({ player: faction, layout: CS.LAYOUTS[m.layout], flip: m.flip, diff: m.diff, gold: m.gold,
    enemies: { a: m.a, b: m.b }, edicts: edicts || {}, autoplay: true });
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
  const own = (id) => w.structs.filter((s) => s.owner === id && !s.ruined).length;
  return { id: faction + "-" + (idx + 1), layout: m.layout, outcome: w.outcome || "timeout", t: Math.round(w.t),
    structs: { p: own("p"), a: own("a"), b: own("b"), ruin: w.structs.filter((s) => s.ruined).length },
    peakSoldiers: peak, avgStepMs: +((Date.now() - t0) / steps).toFixed(3), worstStepMs: +worst.toFixed(2),
    kills: w.stats.kills, lost: w.stats.lost, gold: Math.round(w.owners.p.gold), paths: CS.pathCalls };
}
const [fac = "duchy", which = "all", maxT = "900"] = process.argv.slice(2);
const facs = fac === "all" ? CS.CAMPAIGN_ORDER : [fac];
for (const f of facs) {
  const list = which === "all" ? CS.CAMPAIGNS[f].map((_, i) => i) : [Number(which) - 1];
  for (const i of list) console.log(JSON.stringify(run(f, i, Number(maxT))));
}
