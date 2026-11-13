// 电脑对手（也可托管玩家一方，用于自动化平衡测试）
(function (root) {
  "use strict";
  const CS = root.CS;
  const { STRUCTS, SPELLS } = CS;
  const D = (v) => v * CS.MAPK; // 地图距离

  const LIKES = {
    duchy: { foot: 1.2, archer: 1.15, cav: 1, siege: 1, mage: 1, guard: 1.1 },
    horde: { foot: 1.15, archer: 0.85, cav: 1.3, siege: 1.1, mage: 0.9, guard: 1.1 },
    cult: { foot: 0.9, archer: 1.2, cav: 0.9, siege: 1, mage: 1.35, guard: 0.9 },
    sylvan: { foot: 0.95, archer: 1.35, cav: 1.2, siege: 0.9, mage: 1.05, guard: 0.9 },
    grave: { foot: 1.35, archer: 0.95, cav: 0.95, siege: 1, mage: 1.15, guard: 1.2 },
    wild: {},
  };

  function think(world, id) {
    const o = world.owners[id];
    if (!o || !o.alive || o.neutral) return;
    o.aiT = (o.aiT || 0) - 1;
    if (o.aiT > 0) return;
    o.aiT = Math.max(1, Math.round((id === "p" ? 1 : world.diff.think) * 2));
    const rand = world.rand;
    const mine = world.structs.filter((s) => s.owner === id && !s.ruined);
    const field = world.squads.filter((q) => q.owner === id && !q.inside && q.units.length && !q.st.summon);
    const busy = (q) => q.order === "rebuild" || q.order === "attack" || q.order === "enter" || q.fighting;
    const hostileStructs = world.structs.filter((s) => s.owner && s.owner !== id && !s.ruined);

    // 1. 防守
    for (const st of mine) {
      let threat = 0;
      CS.forEachInRadius(world, st.x, st.y, D(220), (u) => { if (u.owner !== id && u.owner !== "n") threat++; });
      if (threat >= 3) {
        for (const q of field) {
          if (q.order === "attack" && q.target != null && rand() < 0.6) continue;
          if (Math.hypot(q.x - st.x, q.y - st.y) < D(520) && !q.fighting && q.order !== "rebuild") {
            CS.orderMove(world, [q], st.x + (rand() - 0.5) * 40, st.y + st.R + 20);
            q.order = "move";
          }
        }
      }
    }

    // 2. 经营
    if (world.t > 15 && mine.length) {
      let mines = 0;
      let obel = 0;
      let watches = 0;
      for (const st of mine) if (st.addons.indexOf("watch") >= 0) watches++;
      for (const st of mine) for (const a of st.addons) { if (a === "mine") mines++; if (a === "obelisk") obel++; }
      const slotSt = mine.find((s) => s.addons.some((a) => !a));
      if (slotSt) {
        let kind = "mine";
        if (o.used >= o.supply - 1) kind = "farm";
        else if (o.towers && obel < 1) kind = "obelisk";
        else if (mines >= mine.length * 1.5) kind = rand() < 0.4 ? "farm" : rand() < 0.5 ? "obelisk" : "watch";
        if (kind === "watch" && (slotSt.addons.indexOf("watch") >= 0 || watches >= 2)) kind = "farm";
        const cost = CS.addonCost(world, id, kind);
        if (o.gold > cost + 50) CS.build(world, id, slotSt, slotSt.addons.findIndex((a) => !a), kind);
      }
      if (world.t > 80) {
        const up = mine.filter((s) => CS.upgradeCost(s) != null).sort((a, b) => (b.type === "castle") - (a.type === "castle"))[0];
        if (up && o.gold > CS.upgradeCost(up) * 1.7 && o.used >= o.supply - 1) CS.upgrade(world, id, up);
      }
      // 钱多了就研究科技
      if (world.t > 150 && o.gold > 420) {
        const open = CS.TECHS.filter((t) => (o.tech[t.id] || 0) < t.cost.length && o.gold > t.cost[o.tech[t.id] || 0] * 1.8);
        if (open.length) CS.research(world, id, open[Math.floor(rand() * open.length)].id);
      }
    }

    // 3. 征兵
    const enemyMix = { foot: 0, archer: 0, cav: 0, siege: 0, mage: 0, guard: 0 };
    for (const q of world.squads) if (q.owner !== id && q.owner !== "n" && enemyMix[q.type] !== undefined) enemyMix[q.type] += q.units.length;
    const ownMix = { foot: 0, archer: 0, cav: 0, siege: 0, mage: 0, guard: 0 };
    for (const q of world.squads) if (q.owner === id && ownMix[q.type] !== undefined) ownMix[q.type]++;
    const likes = LIKES[o.faction] || {};
    for (const st of mine) {
      if (o.used >= o.supply) break;
      if (st.queue.length >= 1) continue;
      const opts = STRUCTS[st.type].recruit;
      let best = null;
      let bw = -1;
      for (const t of opts) {
        if (CS.UNITS[t].req && st.level < CS.UNITS[t].req) continue;
        let w = { foot: 3, archer: 2.6, cav: 1.6, siege: 0.7, mage: 2.2, guard: 1.7 }[t];
        if (t === "guard") w += enemyMix.foot * 0.05 + (o.gold > 300 ? 0.8 : 0);
        if (t === "foot") w += enemyMix.cav * 0.12;
        if (t === "archer") w += enemyMix.foot * 0.1;
        if (t === "cav") w += (enemyMix.archer + enemyMix.siege * 2) * 0.12 + (world.t > 60 ? 0.6 : 0);
        if (t === "siege") w += hostileStructs.some((s) => s.type === "castle" || s.level > 0) ? 1.4 : 0.2;
        if (t === "siege" && ownMix.siege >= 2) w = 0.1;
        w *= likes[t] || 1;
        w /= 1 + ownMix[t] * 0.35;
        w *= 0.8 + rand() * 0.4;
        if (w > bw) { bw = w; best = t; }
      }
      if (best && !CS.canRecruit(world, id, st, best)) { CS.recruit(world, id, st, best); ownMix[best]++; }
    }

    // 4. 进攻波次
    if (world.t > (id === "p" ? 25 : world.diff.start)) {
      if (o.attacking != null) {
        const tgt = CS.structById(world, o.attacking);
        const done = !tgt || (tgt.owner === id && !tgt.ruined);
        const army = field.filter((q) => q.waveId === o.wave);
        if (done || army.length === 0) { o.attacking = null; }
        else {
          for (const q of army) {
            if (q.order === "idle" || q.order === "move" && !q.path.length) CS.orderStruct(world, [q], tgt);
          }
        }
      }
      if (o.attacking == null) {
        const idle = field.filter((q) => !busy(q) && (q.order === "idle" || q.order === "defend" || (q.order === "move" && !q.path.length)));
        const waveNeed = (id === "p" ? 3 : world.diff.wave) + Math.floor(world.t / 200);
        const capped = o.used >= o.supply && o.gold > 120;
        if (idle.length >= waveNeed || (capped && idle.length >= 2)) {
          let cx = 0; let cy = 0;
          for (const q of idle) { cx += q.x; cy += q.y; }
          cx /= idle.length; cy /= idle.length;
          const cands = world.structs.filter((s) => s.owner !== id);
          let best = null;
          let bs = Infinity;
          for (const s of cands) {
            let score = Math.hypot(s.x - cx, s.y - cy);
            if (s.ruined) score -= D(120);
            else score += s.hp / 6 + s.garrison.length * 90;
            // 别打已经有人在修的废墟以外的远处
            if (score < bs) { bs = score; best = s; }
          }
          if (best) {
            o.wave = (o.wave || 0) + 1;
            o.attacking = best.id;
            for (const q of idle) { q.waveId = o.wave; }
            CS.orderStruct(world, idle, best);
          }
        }
      }
    }

    // 5. 顺手修附近的废墟
    for (const st of world.structs) {
      if (!st.ruined) continue;
      if (world.squads.some((q) => q.owner === id && q.target === st.id && q.order === "rebuild")) continue;
      const near = mine.some((m) => Math.hypot(m.x - st.x, m.y - st.y) < D(420));
      if (!near) continue;
      const q = field.find((f) => !busy(f) && f.waveId == null && Math.hypot(f.x - st.x, f.y - st.y) < D(500));
      if (q) CS.orderStruct(world, [q], st);
    }

    // 6. 宝箱
    for (const c of world.chests) {
      if (c.taken) continue;
      const guarded = world.squads.some((q) => q.owner === "n" && Math.hypot(q.x - c.x, q.y - c.y) < 150);
      if (guarded) continue;
      const q = field.find((f) => !busy(f) && Math.hypot(f.x - c.x, f.y - c.y) < D(600));
      if (q) { CS.orderMove(world, [q], c.x, c.y); }
    }
    // 托管玩家时：兵多了顺手清食人魔
    if (id === "p" && world.t > 120) {
      const ogre = world.squads.find((q) => q.owner === "n" && q.type === "ogre");
      const idle = field.filter((q) => !busy(q) && q.waveId == null);
      if (ogre && idle.length >= 3) CS.orderMove(world, idle.slice(0, 3), ogre.x, ogre.y);
    }

    // 7. 法术
    castSpells(world, id, o, field);
  }
  CS.aiThink = think;

  function castSpells(world, id, o, field) {
    const keys = CS.FACTIONS[o.faction].spells;
    if (!keys || !keys.length) return;
    const fights = field.filter((q) => q.fighting && q.engaged);
    if (!fights.length) {
      // 攻城时：天罚砸墙
      const sieging = field.find((q) => q.order === "attack" && q.target != null);
      if (sieging && keys.includes("smite")) {
        const st = CS.structById(world, sieging.target);
        if (st && !st.ruined && st.hp > 200 && Math.hypot(st.x - sieging.x, st.y - sieging.y) < D(260) && !CS.canCast(world, id, "smite")) CS.cast(world, id, "smite", st.x, st.y);
      }
      return;
    }
    const f = fights[0];
    const e = f.engaged;
    let foes = 0;
    CS.forEachInRadius(world, e.x, e.y, 70, (u) => { if (u.owner !== id) foes++; });
    let friends = 0;
    CS.forEachInRadius(world, e.x, e.y, 70, (u) => { if (u.owner === id) friends++; });
    const [banner, strike, ult] = keys;
    if (o.mana >= 100 && !CS.canCast(world, id, ult) && foes >= 8) { CS.cast(world, id, ult, e.x, e.y); return; }
    if (foes >= 5 && friends * 1.2 < foes + 6 && !CS.canCast(world, id, strike)) {
      // 打击类法术避开自己人
      const sp = SPELLS[strike];
      if (sp.kind === "strike" || friends < 4) { CS.cast(world, id, strike, e.x, e.y); return; }
    }
    if (friends >= 8 && o.mana >= 60 && !CS.canCast(world, id, banner)) {
      if (SPELLS[banner].fx === "frost") CS.cast(world, id, banner, e.x, e.y);
      else CS.cast(world, id, banner, (f.x + e.x) / 2, (f.y + e.y) / 2);
    }
  }

  CS.aiTick = function (world) {
    if (world.tick % 30 !== 15) return;
    for (const id of Object.keys(world.owners)) {
      const o = world.owners[id];
      if (o.ai && !o.neutral) think(world, id);
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
