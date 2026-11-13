const path = require("path");
globalThis.CS = {};
for (const f of ["data", "missions", "map", "sim", "ai"]) require(path.join(__dirname, "../game/js", f + ".js"));
const CS = globalThis.CS;
let total = 0; const samples = [];
for (const seed of [1,2,3]) for (const f of CS.CAMPAIGN_ORDER) CS.CAMPAIGNS[f].forEach((m, i) => {
  const w = CS.createWorld({ player: f, layout: CS.LAYOUTS[m.layout], flip: m.flip, diff: m.diff, gold: m.gold, enemies: { a: m.a, b: m.b }, edicts: {}, autoplay: true, seed });
  const track = new Map();
  while (!w.outcome && w.t < 600) {
    CS.step(w); CS.aiTick(w); w.events.length = 0;
    if (w.tick % 30) continue;
    for (const sq of w.squads) {
      if (sq.inside || sq.fighting) { track.delete(sq.id); continue; }
      const ts = sq.target != null ? CS.structById(w, sq.target) : null;
      const near = ts && Math.hypot(ts.x - sq.x, ts.y - sq.y) < ts.R + sq.st.range + 50;
      const moving = !near && (sq.path.length > 0 || sq.order === "rebuild" || sq.order === "enter" || sq.order === "attack");
      const tr = track.get(sq.id) || { x: sq.x, y: sq.y, n: 0 };
      if (moving && Math.hypot(tr.x - sq.x, tr.y - sq.y) < 3) tr.n++; else { tr.n = 0; tr.x = sq.x; tr.y = sq.y; }
      track.set(sq.id, tr);
      if (tr.n === 6) { total++; if (samples.length < 25) samples.push([seed, f + (i + 1), Math.round(w.t), sq.owner, sq.type, sq.order, sq.path.length, Math.round(sq.x), Math.round(sq.y), sq.target, sq.units.length, sq.engaged ? 1 : 0, sq.path[0] ? Math.round(Math.hypot(sq.path[0].x-sq.x, sq.path[0].y-sq.y)) : -1, CS.blockedAt(w.map, sq.x, sq.y), Math.round(Math.max(...sq.units.map(u=>Math.hypot(u.x-sq.x,u.y-sq.y)))), ts && Math.round(Math.hypot(ts.x-sq.x,ts.y-sq.y)), sq.goal && [Math.round(sq.goal.x),Math.round(sq.goal.y)]]); }
    }
  }
});
console.log("stuck events", total); for (const s of samples) console.log(JSON.stringify(s));
