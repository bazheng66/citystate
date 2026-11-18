// 模拟快照：把一个模拟步结束时“画面需要的全部状态”打包成一段二进制（无 DOM）。
// 模拟不在主线程跑的时候（Web Worker 或 Tauri 的 Rust 线程），主线程每步拿一份快照，
// 用 apply() 还原成和本地模拟同样形状的对象，渲染层一行都不用改。
//
// 格式：全部按 4 字节一个字对齐，小端；每个字要么是 f32 要么是 u32（位域）。
//   头部 16 字 | 归属方 ×6 | 据点 ×10 | 部队 ×8 | 士兵 ×6 | 飞行物 ×9 | 法术区域 ×6 | 新特效 ×6 | 新事件 ×4 | 宝箱 ×1
// Rust 那边的编码器（src-tauri/simcore/src/snapshot.rs）必须和这里逐字对应。
(function (root) {
  "use strict";
  const CS = root.CS;
  const S = (CS.snap = {});

  S.MAGIC = 0x31535343; // "CSS1"
  S.HEAD = 16; S.OWNER = 6; S.STRUCT = 10; S.SQUAD = 8; S.UNIT = 6; S.PROJ = 9; S.EFFECT = 6; S.FX = 6; S.EVENT = 4; S.CHEST = 1;
  S.UNIT_TYPES = Object.keys(CS.UNITS);
  S.SPELL_KEYS = Object.keys(CS.SPELLS);
  S.ADDON_KINDS = Object.keys(CS.ADDONS);
  S.TECH_IDS = CS.TECHS.map((t) => t.id);
  S.FACTIONS = Object.keys(CS.FACTIONS);
  S.PROJ_KINDS = ["arrow", "stone", "bolt"];
  S.FX_KINDS = ["cast", "charge", "poof", "boom", "burst"]; // 16 以上 = 16 + 法术序号
  S.EVENTS = ["die", "hit", "shoot", "impact", "spawn", "cast", "queue", "build", "upgrade", "tech", "enter", "sortie", "capture", "chest", "ruin", "eliminated", "win", "lose"];
  const idxOf = (list) => { const m = {}; list.forEach((k, i) => { m[k] = i; }); return m; };
  const UT = idxOf(S.UNIT_TYPES);
  const SK = idxOf(S.SPELL_KEYS);
  const AK = idxOf(S.ADDON_KINDS);
  const TK = idxOf(S.TECH_IDS);
  const FK = idxOf(S.FACTIONS);
  const PK = idxOf(S.PROJ_KINDS);
  const XK = idxOf(S.FX_KINDS);
  const EK = idxOf(S.EVENTS);

  S.ownerList = (world) => world.ownerList || (world.ownerList = ["p"].concat(world.foeIds, ["n"]));

  // ---------- 编码（Worker 里用；Node 里也用来和 Rust 的输出对拍） ----------
  // pend: { fx: [新特效…], ev: [新事件…], stepMs, waitMs }
  S.encode = function (world, pend) {
    const owners = S.ownerList(world);
    const OI = idxOf(owners);
    let nUnits = 0;
    for (const sq of world.squads) if (!sq.inside) nUnits += sq.units.length;
    const nSq = world.squads.length;
    const fx = pend.fx;
    const ev = pend.ev;
    const words = S.HEAD + owners.length * S.OWNER + world.structs.length * S.STRUCT + nSq * S.SQUAD + nUnits * S.UNIT +
      world.proj.length * S.PROJ + world.effects.length * S.EFFECT + fx.length * S.FX + ev.length * S.EVENT + world.chests.length * S.CHEST;
    const buf = new ArrayBuffer(words * 4);
    const F = new Float32Array(buf);
    const U = new Uint32Array(buf);
    U[0] = S.MAGIC; U[1] = world.tick; F[2] = world.t; U[3] = world.soldierCount; U[4] = nSq; U[5] = nUnits;
    U[6] = world.structs.length; U[7] = world.proj.length; U[8] = world.effects.length; U[9] = fx.length; U[10] = ev.length;
    U[11] = owners.length; U[12] = world.chests.length; F[13] = world.perf.sim; F[14] = pend.stepMs || 0; F[15] = pend.waitMs || 0;
    let p = S.HEAD;
    for (const id of owners) {
      const o = world.owners[id];
      F[p] = o.gold; F[p + 1] = o.mana; U[p + 2] = o.supply; U[p + 3] = o.used;
      U[p + 4] = (o.structs & 0xfff) | ((o.towers & 0x3f) << 12) | (o.alive ? 1 << 20 : 0);
      let tech = 0;
      S.TECH_IDS.forEach((t, i) => { tech |= ((o.tech[t] || 0) & 3) << (i * 2); });
      U[p + 5] = tech;
      p += S.OWNER;
    }
    for (const st of world.structs) {
      let addons = 0;
      for (let i = 0; i < 3; i++) addons |= (st.addons[i] ? AK[st.addons[i]] + 1 : 0) << (i * 3);
      U[p] = st.id;
      U[p + 1] = (st.owner ? OI[st.owner] + 1 : 0) | (st.level << 4) | (st.ruined ? 1 << 6 : 0) | (addons << 8) |
        ((st.rebuilder ? OI[st.rebuilder] + 1 : 0) << 20) | (Math.min(3, st.queue.length) << 24);
      F[p + 2] = st.hp; F[p + 3] = st.maxHp; F[p + 4] = st.rebuild; F[p + 5] = st.lastHit; F[p + 6] = Math.max(0, st.hitFlash);
      const q = st.queue[0];
      U[p + 7] = q ? UT[q.type] | (q.tier << 8) : 0;
      F[p + 8] = q ? q.t : 0; F[p + 9] = q ? q.total : 0;
      p += S.STRUCT;
    }
    let up = p + nSq * S.SQUAD;
    for (const sq of world.squads) {
      const us = sq.units;
      let hp = 0; let max = 0;
      for (let i = 0; i < us.length; i++) { const u = us[i]; hp += u.hp > 0 ? u.hp : 0; max += u.max; }
      U[p] = sq.id;
      U[p + 1] = OI[sq.owner] | (UT[sq.type] << 4) | (sq.tier << 8) | (sq.fighting ? 1 << 10 : 0);
      U[p + 2] = sq.inside || 0; U[p + 3] = us.length; F[p + 4] = sq.x; F[p + 5] = sq.y; F[p + 6] = hp; F[p + 7] = max;
      p += S.SQUAD;
      if (sq.inside) continue;
      for (let i = 0; i < us.length; i++) {
        const u = us[i];
        F[up] = u.x; F[up + 1] = u.y; F[up + 2] = u.px; F[up + 3] = u.py; F[up + 4] = u.step;
        const atk = u.atk > 0 ? Math.min(255, Math.round((u.atk / 0.22) * 255)) : 0;
        const hit = u.hitT > 0 ? Math.min(255, Math.round((u.hitT / 0.12) * 255)) : 0;
        const flags = (u.face > 0 ? 1 : 0) | (u.moving ? 2 : 0) | (u.stun > 0 ? 4 : 0) | (u.slowT > 0 ? 8 : 0) | (u.lust ? 16 : 0) | (u.frostSlow < 1 ? 32 : 0);
        U[up + 5] = atk | (hit << 8) | ((u.i & 255) << 16) | (flags << 24);
        up += S.UNIT;
      }
    }
    p = up;
    for (const pr of world.proj) {
      F[p] = pr.x; F[p + 1] = pr.y; F[p + 2] = pr.sx; F[p + 3] = pr.sy; F[p + 4] = pr.tx; F[p + 5] = pr.ty; F[p + 6] = pr.t; F[p + 7] = pr.dur;
      U[p + 8] = PK[pr.k] | (FK[pr.faction] << 8);
      p += S.PROJ;
    }
    for (const ef of world.effects) {
      U[p] = SK[ef.key] | (OI[ef.owner] << 8) | ((ef.kind === "area" ? 1 : 0) << 16);
      F[p + 1] = ef.x; F[p + 2] = ef.y; F[p + 3] = ef.r; F[p + 4] = ef.start; F[p + 5] = ef.until;
      p += S.EFFECT;
    }
    for (const f of fx) {
      const k = XK[f.k] !== undefined ? XK[f.k] : 16 + SK[f.k];
      U[p] = k | ((f.faction ? FK[f.faction] + 1 : 0) << 8);
      F[p + 1] = f.x; F[p + 2] = f.y; F[p + 3] = f.r || 0; F[p + 4] = f.t; F[p + 5] = f.life;
      p += S.FX;
    }
    for (const e of ev) {
      let sub = 0;
      let extra = 0;
      if (e.e === "die" || e.e === "hit") sub = UT[e.type] || 0;
      else if (e.e === "shoot" || e.e === "impact") sub = PK[e.k] || 0;
      else if (e.e === "cast") sub = SK[e.key];
      else if (e.e === "tech") sub = TK[e.id];
      if (e.e === "capture" || e.e === "ruin" || e.e === "spawn") extra = e.id || 0;
      else if (e.e === "chest") extra = e.gold;
      U[p] = EK[e.e] | ((e.owner ? OI[e.owner] + 1 : 0) << 8) | (sub << 16) | (e.face > 0 ? 1 << 24 : 0);
      F[p + 1] = e.x || 0; F[p + 2] = e.y || 0; F[p + 3] = extra;
      p += S.EVENT;
    }
    for (const c of world.chests) { U[p] = c.taken ? 1 : 0; p += S.CHEST; }
    return buf;
  };

  // ---------- 解码（主线程）：把快照还原进 world ----------
  // world 是用同样的参数在主线程建出来的“镜像世界”：地图、据点、归属方都在，只有部队由快照覆盖。
  const NO_PATH = [];
  S.apply = function (world, buf) {
    const F = new Float32Array(buf);
    const U = new Uint32Array(buf);
    if (U[0] !== S.MAGIC) throw new Error("快照格式不对");
    const owners = S.ownerList(world);
    const m = world.mirror || (world.mirror = { squads: new Map(), gen: 0, pool: [] });
    const gen = ++m.gen;
    world.tick = U[1]; world.t = F[2]; world.soldierCount = U[3];
    const nSq = U[4]; const nUnits = U[5]; const nSt = U[6]; const nProj = U[7]; const nEf = U[8]; const nFx = U[9]; const nEv = U[10];
    const nOw = U[11]; const nCh = U[12];
    world.perf.sim = F[13];
    let p = S.HEAD;
    for (let i = 0; i < nOw; i++) {
      const o = world.owners[owners[i]];
      o.gold = F[p]; o.mana = F[p + 1]; o.supply = U[p + 2]; o.used = U[p + 3];
      const k = U[p + 4];
      o.structs = k & 0xfff; o.towers = (k >> 12) & 0x3f; o.alive = !!(k & (1 << 20));
      const tech = U[p + 5];
      if (tech !== o.techBits) {
        // 科技升级会改兵种数值：清掉这一家的数值缓存，下面给它的部队重新取
        o.techBits = tech;
        S.TECH_IDS.forEach((t, j) => { const lv = (tech >> (j * 2)) & 3; if (lv) o.tech[t] = lv; });
        for (const key of Array.from(world.statCache.keys())) if (key.startsWith(o.id + ":")) world.statCache.delete(key);
        o.statGen = (o.statGen || 0) + 1;
      }
      p += S.OWNER;
    }
    for (let i = 0; i < nSt; i++) {
      const st = world.structMap.get(U[p]);
      const k = U[p + 1];
      const oi = k & 15;
      st.owner = oi ? owners[oi - 1] : null;
      st.level = (k >> 4) & 3;
      st.ruined = !!(k & 64);
      const ad = (k >> 8) & 0x1ff;
      for (let j = 0; j < 3; j++) { const a = (ad >> (j * 3)) & 7; st.addons[j] = a ? S.ADDON_KINDS[a - 1] : null; }
      const rb = (k >> 20) & 15;
      st.rebuilder = rb ? owners[rb - 1] : null;
      st.hp = F[p + 2]; st.maxHp = F[p + 3]; st.rebuild = F[p + 4]; st.lastHit = F[p + 5]; st.hitFlash = F[p + 6];
      const ql = (k >> 24) & 3;
      st.queue.length = ql;
      if (ql) {
        const q = st.queue[0] || (st.queue[0] = {});
        q.type = S.UNIT_TYPES[U[p + 7] & 255]; q.tier = (U[p + 7] >> 8) & 3; q.t = F[p + 8]; q.total = F[p + 9];
        for (let j = 1; j < ql; j++) if (!st.queue[j]) st.queue[j] = { type: q.type, tier: q.tier, t: 0, total: q.total };
      }
      st.garrison.length = 0;
      p += S.STRUCT;
    }
    const squads = world.squads;
    squads.length = nSq;
    let up = p + nSq * S.SQUAD;
    const pool = m.pool;
    for (let i = 0; i < nSq; i++) {
      const id = U[p];
      const k = U[p + 1];
      let sq = m.squads.get(id);
      const owner = owners[k & 15];
      if (!sq) {
        sq = { id, owner, type: S.UNIT_TYPES[(k >> 4) & 15], tier: (k >> 8) & 3, st: null, statGen: -1, x: 0, y: 0, units: [], inside: null, sel: false, path: NO_PATH, order: "idle", fighting: false, tagX: null, tagY: null };
        m.squads.set(id, sq);
      }
      const o = world.owners[owner];
      if (sq.statGen !== (o.statGen || 0)) { sq.st = CS.stats(world, owner, sq.type, sq.tier); sq.statGen = o.statGen || 0; }
      sq.gen = gen;
      sq.fighting = !!(k & 1024);
      const inside = U[p + 2];
      const n = U[p + 3];
      sq.x = F[p + 4]; sq.y = F[p + 5];
      const us = sq.units;
      // 士兵对象放回池里再按需取用，不反复分配
      while (us.length > n) pool.push(us.pop());
      while (us.length < n) us.push(pool.pop() || { sq: null, x: 0, y: 0, px: 0, py: 0, hp: 0, max: 0, face: 1, atk: 0, hitT: 0, moving: false, dead: false, stun: 0, step: 0, slowT: 0, lust: false, i: 0, frostSlow: 1 });
      const hp = n ? F[p + 6] / n : 0;
      const max = n ? F[p + 7] / n : 0;
      if (inside) {
        sq.inside = inside;
        const st = world.structMap.get(inside);
        if (st) st.garrison.push(sq);
        for (let j = 0; j < n; j++) { const u = us[j]; u.sq = sq; u.x = u.px = sq.x; u.y = u.py = sq.y; u.hp = hp; u.max = max; u.dead = false; }
      } else {
        sq.inside = null;
        for (let j = 0; j < n; j++) {
          const u = us[j];
          const b = U[up + 5];
          const fl = b >>> 24;
          u.sq = sq; u.x = F[up]; u.y = F[up + 1]; u.px = F[up + 2]; u.py = F[up + 3]; u.step = F[up + 4];
          u.atk = ((b & 255) / 255) * 0.22; u.hitT = (((b >> 8) & 255) / 255) * 0.12; u.i = (b >> 16) & 255;
          u.face = fl & 1 ? 1 : -1; u.moving = !!(fl & 2); u.stun = fl & 4 ? 1 : 0; u.slowT = fl & 8 ? 1 : 0; u.lust = !!(fl & 16); u.frostSlow = fl & 32 ? 0.5 : 1;
          u.hp = hp; u.max = max; u.dead = false;
          up += S.UNIT;
        }
      }
      squads[i] = sq;
      p += S.SQUAD;
    }
    // 已经不在快照里的部队：偶尔清一次表
    if (m.squads.size > nSq * 1.3 + 64) for (const [id, sq] of m.squads) if (sq.gen !== gen) { for (const u of sq.units) pool.push(u); sq.units.length = 0; m.squads.delete(id); }
    if (pool.length > 60000) pool.length = 60000;
    p = up;
    const proj = world.proj;
    for (let i = 0; i < nProj; i++) {
      const pr = proj[i] || (proj[i] = {});
      pr.x = F[p]; pr.y = F[p + 1]; pr.sx = F[p + 2]; pr.sy = F[p + 3]; pr.tx = F[p + 4]; pr.ty = F[p + 5]; pr.t = F[p + 6]; pr.dur = F[p + 7];
      pr.k = S.PROJ_KINDS[U[p + 8] & 255]; pr.faction = S.FACTIONS[(U[p + 8] >> 8) & 255];
      p += S.PROJ;
    }
    proj.length = nProj;
    const efs = world.effects;
    for (let i = 0; i < nEf; i++) {
      const ef = efs[i] || (efs[i] = {});
      const k = U[p];
      ef.key = S.SPELL_KEYS[k & 255]; ef.owner = owners[(k >> 8) & 255]; ef.kind = (k >> 16) & 1 ? "area" : "banner";
      ef.x = F[p + 1]; ef.y = F[p + 2]; ef.r = F[p + 3]; ef.start = F[p + 4]; ef.until = F[p + 5];
      p += S.EFFECT;
    }
    efs.length = nEf;
    // 特效和事件是“自上次快照以来新增的”：追加，由主线程自己按寿命清理
    let j = 0;
    for (let i = 0; i < world.fx.length; i++) { const f = world.fx[i]; if (world.t - f.t < f.life) world.fx[j++] = f; }
    world.fx.length = j;
    for (let i = 0; i < nFx; i++) {
      const k = U[p] & 255;
      const fa = (U[p] >> 8) & 255;
      world.fx.push({ k: k >= 16 ? S.SPELL_KEYS[k - 16] : S.FX_KINDS[k], faction: fa ? S.FACTIONS[fa - 1] : undefined, x: F[p + 1], y: F[p + 2], r: F[p + 3], t: F[p + 4], life: F[p + 5] });
      p += S.FX;
    }
    for (let i = 0; i < nEv; i++) {
      const k = U[p];
      const e = S.EVENTS[k & 255];
      const oi = (k >> 8) & 255;
      const sub = (k >> 16) & 255;
      const ev = { e, owner: oi ? owners[oi - 1] : undefined, x: F[p + 1], y: F[p + 2] };
      if (e === "die" || e === "hit") ev.type = S.UNIT_TYPES[sub];
      else if (e === "shoot" || e === "impact") ev.k = S.PROJ_KINDS[sub];
      else if (e === "cast") ev.key = S.SPELL_KEYS[sub];
      else if (e === "tech") ev.id = S.TECH_IDS[sub];
      else if (e === "chest") ev.gold = F[p + 3];
      else if (e === "capture" || e === "ruin" || e === "spawn") ev.id = F[p + 3];
      if (e === "die") {
        world.corpses.push({ x: ev.x, y: ev.y, owner: ev.owner, type: ev.type, t: world.t, face: k & (1 << 24) ? 1 : -1 });
      }
      world.events.push(ev);
      p += S.EVENT;
    }
    if (world.corpses.length > 400) world.corpses.splice(0, world.corpses.length - 400);
    for (let i = 0; i < nCh; i++) { world.chests[i].taken = !!U[p]; p += S.CHEST; }
    return { bytes: buf.byteLength, units: nUnits, squads: nSq, events: nEv, stepMs: F[14], waitMs: F[15] };
  };
})(typeof window !== "undefined" ? window : globalThis);
