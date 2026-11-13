const path = require("path");
globalThis.CS = {};
for (const f of ["data", "missions", "map", "sim", "ai"]) require(path.join(__dirname, "../game/js", f + ".js"));
const CS = globalThis.CS;
const facs = process.argv[2] ? process.argv[2].split(",") : CS.CAMPAIGN_ORDER;
const seeds = (process.argv[3] || "1,2,3").split(",").map(Number);
for (const f of facs) CS.CAMPAIGNS[f].forEach((m, i) => {
  const res = [];
  for (const seed of seeds) {
    const w = CS.createWorld({ player: f, layout: CS.LAYOUTS[m.layout], flip: m.flip, diff: m.diff, gold: m.gold, enemies: { a: m.a, b: m.b }, edicts: {}, autoplay: true, seed });
    while (!w.outcome && w.t < 900) { CS.step(w); CS.aiTick(w); w.events.length = 0; }
    res.push((w.outcome || "T")[0] + Math.round(w.t));
  }
  console.log(f + "-" + (i + 1), m.layout, "d" + m.diff, res.join(" "));
});
