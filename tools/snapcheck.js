// 快照编解码自测：本地跑一段模拟 → encode → apply 到镜像世界 → 逐项比对。
//   node tools/snapcheck.js [士兵数] [步数]
const path = require("path");
globalThis.CS = {};
for (const f of ["data", "missions", "map", "sim", "ai", "benchcore", "snap"]) require(path.join(__dirname, "../game/js", f + ".js"));
const CS = globalThis.CS;
const N = +(process.argv[2] || 3000);
const STEPS = +(process.argv[3] || 600);
const cfg = { n: N, map: "l", seed: 7 };
const w = CS.benchWorld(cfg);
const mirror = CS.benchWorld(cfg);
const b = { n: N, k: 0, done: false };
const pend = { fx: [], ev: [], stepMs: 0, waitMs: 0 };
let bad = 0;
const near = (a, c, eps) => Math.abs(a - c) <= (eps || 1e-3) * Math.max(1, Math.abs(a));
const check = (ok, msg) => { if (!ok && bad++ < 12) console.log("  不一致：" + msg); };
let bytes = 0; let encMs = 0; let decMs = 0; let rounds = 0; let evs = 0;
for (let i = 0; i < STEPS; i++) {
  CS.benchSpawn(w, b); CS.step(w); CS.aiTick(w);
  for (const e of w.events) pend.ev.push(e);
  w.events.length = 0;
  for (const f of w.fx) if (!f._s) { f._s = 1; pend.fx.push(f); }
  if (i % 3 !== 2) continue; // 每三步取一次快照，顺带验证“事件攒几步再发”
  let t0 = process.hrtime.bigint();
  const buf = CS.snap.encode(w, pend);
  encMs += Number(process.hrtime.bigint() - t0) / 1e6;
  const nEv = pend.ev.length; const nFx = pend.fx.length;
  pend.ev.length = 0; pend.fx.length = 0;
  mirror.events.length = 0;
  t0 = process.hrtime.bigint();
  const info = CS.snap.apply(mirror, buf);
  decMs += Number(process.hrtime.bigint() - t0) / 1e6;
  bytes += info.bytes; rounds++; evs += nEv;
  check(mirror.tick === w.tick && near(mirror.t, w.t), "tick/t");
  check(mirror.soldierCount === w.soldierCount, "soldierCount");
  check(mirror.squads.length === w.squads.length, "部队数 " + mirror.squads.length + " vs " + w.squads.length);
  check(mirror.events.length === nEv, "事件数");
  check(mirror.proj.length === w.proj.length && mirror.effects.length === w.effects.length, "飞行物/法术区域数");
  for (let k = 0; k < w.squads.length; k++) {
    const a = w.squads[k]; const m = mirror.squads[k];
    if (!m) break;
    check(a.id === m.id && a.owner === m.owner && a.type === m.type && a.tier === m.tier, "部队身份 " + a.id);
    check((a.inside || null) === (m.inside || null), "inside " + a.id);
    check(a.units.length === m.units.length, "人数 " + a.id);
    check(near(a.x, m.x) && near(a.y, m.y), "部队位置 " + a.id);
    const ha = CS.squadHp(a); const hm = CS.squadHp(m);
    check(near(ha.hp, hm.hp, 1e-3) && near(ha.max, hm.max, 1e-3), "血量 " + a.id + " " + ha.hp + " vs " + hm.hp);
    check(near(a.st.hp, m.st.hp, 1e-6), "数值表 hp " + a.id);
    if (a.inside) continue;
    for (let j = 0; j < a.units.length; j++) {
      const u = a.units[j]; const v = m.units[j];
      check(near(u.x, v.x) && near(u.y, v.y) && near(u.px, v.px) && near(u.py, v.py), "士兵位置");
      check((u.face > 0) === (v.face > 0) && !!u.moving === !!v.moving && (u.atk > 0.13) === (v.atk > 0.13) && (u.stun > 0) === (v.stun > 0) && !!u.lust === !!v.lust, "士兵状态");
    }
  }
  for (const st of w.structs) {
    const m = mirror.structMap.get(st.id);
    check(st.owner === m.owner && st.level === m.level && st.ruined === m.ruined && near(st.hp, m.hp) && st.garrison.length === m.garrison.length && st.queue.length === m.queue.length && String(st.addons) === String(m.addons), "据点 " + st.id);
  }
  for (const id of Object.keys(w.owners)) {
    const a = w.owners[id]; const m = mirror.owners[id];
    check(near(a.gold, m.gold, 1e-4) && a.supply === m.supply && a.used === m.used && JSON.stringify(a.tech) === JSON.stringify(m.tech), "归属方 " + id);
  }
  for (let k = 0; k < w.proj.length; k++) check(w.proj[k].k === mirror.proj[k].k && near(w.proj[k].x, mirror.proj[k].x), "飞行物");
}
console.log(JSON.stringify({ soldiers: w.soldierCount, squads: w.squads.length, rounds, avgKB: +(bytes / rounds / 1024).toFixed(1), avgEvents: Math.round(evs / rounds), encodeMs: +(encMs / rounds).toFixed(3), applyMs: +(decMs / rounds).toFixed(3), mismatches: bad }));
process.exit(bad ? 1 : 0);
