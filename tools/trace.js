// node tools/trace.js faction index [seed] —— 打印据点易手的时间线，用来查平衡问题
const path = require("path");
globalThis.CS = {};
for (const f of ["data", "missions", "map", "sim", "ai"]) require(path.join(__dirname, "../game/js", f + ".js"));
const CS = globalThis.CS;
const [fac, idx, seed = "1"] = process.argv.slice(2);
const m = CS.CAMPAIGNS[fac][Number(idx) - 1];
const w = CS.createWorld({ player: fac, layout: CS.LAYOUTS[m.layout], flip: m.flip, diff: m.diff, gold: m.gold, enemies: { a: m.a, b: m.b }, edicts: {}, autoplay: true, seed: Number(seed) });
let next = 30;
const army = (id) => w.squads.filter((q) => q.owner === id && q.units.length).reduce((s, q) => s + q.units.length, 0);
while (!w.outcome && w.t < 900) {
  CS.step(w); CS.aiTick(w);
  for (const ev of w.events) if (ev.e === "ruin" || ev.e === "capture") console.log(Math.round(w.t), ev.e, "by", ev.by || ev.owner, "from", ev.owner, "@", Math.round(ev.x), Math.round(ev.y));
  w.events.length = 0;
  if (w.t >= next) {
    next += 60;
    console.log(Math.round(w.t), "gold p/a", Math.round(w.owners.p.gold), Math.round(w.owners.a.gold), "supply p", w.owners.p.used + "/" + w.owners.p.supply, "a", w.owners.a.used + "/" + w.owners.a.supply, "men p/a", army("p"), army("a"));
  }
}
console.log("outcome", w.outcome, Math.round(w.t));
