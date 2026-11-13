// 战斗模拟（无 DOM）。固定步长 1/30 秒，逐个士兵计算。
(function (root) {
  "use strict";
  const CS = root.CS;
  const { TILE, UNITS, STRUCTS, DMG, SPELLS, ADDONS } = CS;

  const CELL = 48;
  // 城的箭塔射程 / 守军出击半径：地图缩小后跟着收一点，免得城的火力覆盖半张图
  const SHOT_R = 112;
  const SORTIE_R = 122;

  // ---------- 世界创建 ----------
  function createWorld(opts) {
    // opts: { player, edicts, enemies:{a,b,…}, layout, flip, diff, gold, autoplay, seed, aiGold, noCap, fog, bench }
    const L = CS.resolveLayout(opts.layout, opts.flip);
    const map = CS.buildMap(L);
    const diff = Object.assign({}, CS.DIFF[opts.diff || 0]);
    if (opts.noCap) diff.army = 0;
    const ed = opts.edicts || {};
    const hc = Math.ceil(map.W / CELL);
    const hr = Math.ceil(map.H / CELL);
    const world = {
      t: 0, tick: 0, map, layout: L, diff, opts, W: map.W, H: map.H, hc, hr,
      owners: {}, foeIds: [], structs: [], structMap: new Map(), squads: [], proj: [], effects: [], corpses: [], fx: [], chests: [],
      events: [], nextId: 1, outcome: null, stats: { kills: 0, lost: 0, captured: 0, spent: 0 },
      hash: Array.from({ length: hc * hr }, () => []),
      soldierCount: 0, statCache: new Map(),
      perf: { sim: 0 },
    };
    world.rand = CS.rng((opts.seed || 1) * 7777 + (L.seed || 0));
    // 归属色：优先用势力本色，撞色了就顺延到色板里下一个空位
    const usedCol = new Set();
    const mk = (id, faction, ai) => {
      let ci = CS.FACTION_CI[faction];
      if (faction !== "wild") {
        if (usedCol.has(ci)) { ci = 0; while (usedCol.has(ci)) ci++; }
        usedCol.add(ci);
      }
      world.owners[id] = {
        id, faction, ai, neutral: faction === "wild", ci, col: CS.PALETTE[ci] || CS.PALETTE[8],
        gold: 0, mana: 0, supply: 0, used: 0, cds: {}, income: 1,
        edicts: ai ? {} : ed, tech: {}, alive: true, structs: 0, towers: 0,
      };
    };
    mk("p", opts.player, !!opts.autoplay);
    for (const id of CS.OWNER_IDS) {
      if (id === "p" || !opts.enemies[id]) continue;
      mk(id, opts.enemies[id], true);
      world.foeIds.push(id);
    }
    mk("n", "wild", true);
    const P = world.owners.p;
    P.gold = (opts.gold || 200) + 60 * (ed.treasury || 0);
    P.mana = 60;
    for (const id of world.foeIds) {
      const o = world.owners[id];
      o.gold = opts.aiGold != null ? opts.aiGold : diff.gold;
      o.mana = 40;
      o.income = diff.income;
    }

    for (const [type, c, r, own, lvl] of L.s) {
      const owner = !own || own === "-" ? null : world.owners[own] ? own : "a";
      let level = lvl || 0;
      if (owner === "p" && ed.veterans) level = Math.max(level, 1);
      const st = makeStruct(world, type, (c + 0.5) * TILE, (r + 0.5) * TILE, owner, level);
      world.structs.push(st);
      world.structMap.set(st.id, st);
    }
    for (const [c, r, n, gold] of L.o) {
      const x = (c + 0.5) * TILE;
      const y = (r + 0.5) * TILE;
      world.chests.push({ id: world.nextId++, x: x + 18, y: y - 10, gold, taken: false });
      const sq = spawnSquad(world, "n", "ogre", 0, x - 8, y + 6, n);
      sq.home = { x: x - 8, y: y + 6 };
      sq.order = "guard";
    }
    // 开局每座有归属的据点带一队步兵驻守
    for (const st of world.structs) {
      if (!st.owner) continue;
      const sq = spawnSquad(world, st.owner, "foot", st.level, st.x, st.y + st.R + 12);
      enterStruct(world, sq, st);
    }
    // 敌方据点再多一队远程
    for (const st of world.structs) {
      if (!st.owner || st.owner === "p" || st.owner === "n") continue;
      if ((opts.diff || 0) >= 3 || st.type === "castle") {
        const rec = STRUCTS[st.type].recruit;
        const sq = spawnSquad(world, st.owner, rec.includes("archer") ? "archer" : rec.includes("mage") ? "mage" : "foot", st.level, st.x, st.y + st.R + 12);
        enterStruct(world, sq, st);
      }
    }
    recount(world);
    return world;
  }
  CS.createWorld = createWorld;

  function makeStruct(world, type, x, y, owner, level) {
    const def = STRUCTS[type];
    const maxHp = structMaxHp(world, type, level, owner);
    return {
      id: world.nextId++, type, x, y, R: def.radius, owner, level,
      maxHp, hp: owner ? maxHp : 0, ruined: !owner, rebuild: 0, rebuilder: null,
      addons: [null, null, null], queue: [], garrison: [], shotCd: 1, quiet: 0, lastHit: -99, rally: null,
      hitFlash: 0,
    };
  }

  // ---------- 数值 ----------
  function stats(world, ownerId, type, tier) {
    const key = ownerId + ":" + type + ":" + tier;
    let s = world.statCache.get(key);
    if (s) return s;
    const owner = world.owners[ownerId];
    const base = UNITS[type];
    const fm = (CS.FACTION_UNIT[owner.faction] || {})[type] || {};
    const T = CS.TIER[tier] || CS.TIER[0];
    const ed = owner.edicts || {};
    const tech = owner.tech || {};
    s = {
      world, type, tier,
      name: (T.name ? T.name : "") + (fm.name || base.name),
      size: base.size,
      hp: base.hp * (fm.hp || 1) * T.hp * (1 + 0.08 * (ed.armor || 0)) * (1 + 0.08 * (tech.plate || 0)),
      dmg: base.dmg * (fm.dmg || 1) * T.dmg * (1 + 0.07 * (ed.blade || 0)) * (1 + 0.08 * (tech.forge || 0)),
      cd: base.cd * (fm.cd || 1),
      range: base.range * (fm.range || 1),
      minRange: base.minRange || 0,
      speed: base.speed * (fm.speed || 1) * (1 + 0.06 * (tech.roads || 0)),
      armor: base.armor, dmgType: base.dmgType, proj: base.proj,
      splash: (base.splash || 0) * (fm.splash || 1),
      charge: base.charge || 0, aggro: base.aggro,
      resist: fm.resist || null, slowHit: fm.slowHit || 0, healAura: fm.healAura || 0,
      gold: Math.round(base.gold * (fm.gold || 1) * (1 + 0.35 * tier) * (1 - 0.1 * (ed.levy || 0))),
      train: base.train * (1 + 0.2 * tier),
      summon: !!base.summon, big: !!base.big, wide: !!base.wide,
    };
    world.statCache.set(key, s);
    return s;
  }
  CS.stats = stats;

  function structMaxHp(world, type, level, ownerId) {
    const o = ownerId ? world.owners[ownerId] : null;
    return STRUCTS[type].hp * (1 + 0.4 * level) * (1 + 0.15 * ((o && o.tech.walls) || 0));
  }

  // 科技：花金币立刻生效，已有的部队和据点也吃到加成
  function research(world, ownerId, id) {
    const o = world.owners[ownerId];
    const tech = CS.TECHS.find((t) => t.id === id);
    if (!o || !tech) return "未知科技";
    const lv = o.tech[id] || 0;
    if (lv >= tech.cost.length) return "已经满级";
    if (o.gold < tech.cost[lv]) return "金币不够";
    o.gold -= tech.cost[lv];
    if (ownerId === "p") world.stats.spent += tech.cost[lv];
    o.tech[id] = lv + 1;
    for (const key of Array.from(world.statCache.keys())) if (key.startsWith(ownerId + ":")) world.statCache.delete(key);
    for (const sq of world.squads) {
      if (sq.owner !== ownerId) continue;
      const ns = stats(world, ownerId, sq.type, sq.tier);
      const k = ns.hp / sq.st.hp;
      for (const u of sq.units) { u.hp *= k; u.max *= k; }
      sq.st = ns;
    }
    if (id === "walls") {
      for (const st of world.structs) {
        if (st.owner !== ownerId || st.ruined) continue;
        const old = st.maxHp;
        st.maxHp = structMaxHp(world, st.type, st.level, ownerId);
        st.hp += st.maxHp - old;
      }
    }
    world.events.push({ e: "tech", owner: ownerId, id });
    return null;
  }
  CS.research = research;

  function hostile(a, b) { return a !== b; }

  // ---------- 部队 ----------
  function spawnSquad(world, owner, type, tier, x, y, count) {
    const st = stats(world, owner, type, tier);
    const n = count || st.size;
    const sq = {
      id: world.nextId++, owner, type, tier, st,
      x, y, heading: Math.PI / 2, path: [], goal: null, order: "idle", target: null,
      inside: null, fighting: false, scan: world.rand() * 0.2, engaged: null,
      units: [], sel: false, home: null, quietT: 0, until: 0, stuck: 0,
    };
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = n > 1 ? 6 + (i % 3) * 3 : 0;
      const sx = x + Math.cos(a) * rr;
      const sy = y + Math.sin(a) * rr;
      sq.units.push({
        sq, owner, x: sx, y: sy, px: sx, py: sy, hp: st.hp, max: st.hp, cd: world.rand() * st.cd,
        tgt: null, retarget: world.rand() * 0.3, face: 1, run: 0, atk: 0, dead: false,
        slowT: 0, slowA: 0, stun: 0, i, moving: false, lust: false, frostSlow: 1, step: world.rand() * 6,
        blocked: 0, path: null, pathT: 0,
        rad: st.big ? 15 : st.wide ? 11 : 7, fx: sx, fy: sy,
      });
    }
    world.squads.push(sq);
    return sq;
  }
  CS.spawnSquad = spawnSquad;

  function formation(sq) {
    // 以队伍中心为原点、朝向为前方的阵位，直接写到士兵的 fx/fy；返回最大掉队距离
    const units = sq.units;
    const n = units.length;
    const sp = sq.st.big || sq.type === "siege" ? 26 : sq.type === "cav" ? 18 : sq.type === "guard" ? 16 : 11;
    const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.6)));
    const ch = Math.cos(sq.heading);
    const sh = Math.sin(sq.heading);
    let lag = 0;
    for (let k = 0; k < n; k++) {
      const u = units[k];
      const row = (k / cols) | 0;
      const col = k - row * cols;
      const inRow = Math.min(cols, n - row * cols);
      const lat = (col - (inRow - 1) / 2) * sp;
      const back = row * sp;
      u.fx = sq.x - ch * back - sh * lat;
      u.fy = sq.y - sh * back + ch * lat;
      const dx = u.x - u.fx;
      const dy = u.y - u.fy;
      const d2 = dx * dx + dy * dy;
      if (d2 > lag) lag = d2;
    }
    return Math.sqrt(lag);
  }

  // ---------- 空间哈希 ----------
  function rebuildHash(world) {
    const HC = world.hc;
    const HR = world.hr;
    for (const cell of world.hash) cell.length = 0;
    let n = 0;
    for (const sq of world.squads) {
      if (sq.inside) continue;
      for (const u of sq.units) {
        u.px = u.x; u.py = u.y;
        u.lust = false; u.frostSlow = 1; u.vuln = 1;
        if (u.dead) continue;
        const cx = Math.min(HC - 1, Math.max(0, (u.x / CELL) | 0));
        const cy = Math.min(HR - 1, Math.max(0, (u.y / CELL) | 0));
        world.hash[cy * HC + cx].push(u);
        n++;
      }
    }
    world.soldierCount = n;
  }

  function nearestHostile(world, x, y, owner, radius) {
    const HC = world.hc;
    const HR = world.hr;
    let best = null;
    let bd = radius * radius;
    const x0 = Math.max(0, ((x - radius) / CELL) | 0);
    const x1 = Math.min(HC - 1, ((x + radius) / CELL) | 0);
    const y0 = Math.max(0, ((y - radius) / CELL) | 0);
    const y1 = Math.min(HR - 1, ((y + radius) / CELL) | 0);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const cell = world.hash[cy * HC + cx];
        for (let i = 0; i < cell.length; i++) {
          const o = cell[i];
          if (o.owner === owner || o.dead) continue;
          const dx = o.x - x;
          const dy = o.y - y;
          const d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = o; }
        }
      }
    }
    return best;
  }
  CS.nearestHostile = nearestHostile;

  function forEachInRadius(world, x, y, radius, fn) {
    const HC = world.hc;
    const HR = world.hr;
    const x0 = Math.max(0, ((x - radius) / CELL) | 0);
    const x1 = Math.min(HC - 1, ((x + radius) / CELL) | 0);
    const y0 = Math.max(0, ((y - radius) / CELL) | 0);
    const y1 = Math.min(HR - 1, ((y + radius) / CELL) | 0);
    const r2 = radius * radius;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const cell = world.hash[cy * HC + cx];
        for (let i = 0; i < cell.length; i++) {
          const o = cell[i];
          if (o.dead) continue;
          const dx = o.x - x;
          const dy = o.y - y;
          if (dx * dx + dy * dy <= r2) fn(o);
        }
      }
    }
  }
  CS.forEachInRadius = forEachInRadius;

  // ---------- 伤害 ----------
  function hurtUnit(world, u, amount, type, src) {
    if (u.dead) return;
    const st = u.sq.st;
    let m = DMG[type][st.armor];
    if (st.resist && st.resist[type]) m *= st.resist[type];
    u.hp -= Math.max(0.5, amount * m * (u.vuln || 1));
    u.hitT = 0.12;
    if (src && src.slowHit) { u.slowT = 1.6; u.slowA = Math.max(u.slowA, src.slowHit); }
    if (u.hp <= 0) killUnit(world, u, src);
  }

  function killUnit(world, u, src) {
    u.dead = true;
    u.hp = 0;
    world.corpses.push({ x: u.x, y: u.y, owner: u.owner, type: u.sq.type, t: world.t, face: u.face });
    if (world.corpses.length > 400) world.corpses.splice(0, world.corpses.length - 400);
    if (u.owner === "p") world.stats.lost++;
    else if (src && src.owner === "p") world.stats.kills++;
    world.events.push({ e: "die", x: u.x, y: u.y, type: u.sq.type, owner: u.owner });
  }

  function hurtStruct(world, st, amount, type, srcOwner, fortMult) {
    if (st.ruined || !st.owner || st.owner === srcOwner) return;
    // 压力测试里据点打不坏，战斗才能一直持续下去
    if (world.opts.bench) { st.lastHit = world.t; st.hitFlash = 0.12; return; }
    const dmg = amount * DMG[type].fort * (fortMult || 1);
    st.hp -= dmg;
    st.lastHit = world.t;
    st.hitFlash = 0.12;
    if (st.hp <= 0) ruinStruct(world, st, srcOwner);
  }
  CS.hurtStruct = hurtStruct;

  function ruinStruct(world, st, by) {
    const was = st.owner;
    st.hp = 0;
    st.ruined = true;
    st.owner = null;
    st.level = 0;
    st.maxHp = STRUCTS[st.type].hp;
    st.addons = [null, null, null];
    st.queue = [];
    st.rebuild = 0;
    st.rebuilder = null;
    st.rally = null;
    // 守军被赶出来
    for (const sq of st.garrison) {
      sq.inside = null;
      placeAround(sq, st);
      sq.order = "idle";
      sq.home = null;
    }
    st.garrison = [];
    world.events.push({ e: "ruin", x: st.x, y: st.y, owner: was, by, id: st.id });
  }

  // 城两侧的待命位：左右各三格，避开木牌
  function standSpot(world, st) {
    const spots = [];
    for (const side of [1, -1]) for (const dy of [-6, 16, -28]) spots.push({ x: st.x + side * (st.R + 46), y: st.y + dy });
    let best = spots[0];
    let bn = Infinity;
    for (const sp of spots) {
      let n = 0;
      for (const q of world.squads) if (q.owner === st.owner && !q.inside && Math.hypot(q.x - sp.x, q.y - sp.y) < 18) n++;
      if (CS.blockedAt(world.map, sp.x, sp.y)) n += 5;
      if (n < bn) { bn = n; best = sp; }
    }
    return best;
  }

  function placeAround(sq, st) {
    let k = 0;
    for (const u of sq.units) {
      if (u.dead) continue;
      const a = k * 2.4 + sq.id;
      const r = st.R + 8 + (k % 3) * 6;
      u.x = u.px = st.x + Math.cos(a) * r;
      u.y = u.py = st.y + Math.sin(a) * r * 0.7 + 10;
      k++;
    }
    sq.x = st.x + (sq.id % 2 ? 1 : -1) * (st.R + 20);
    sq.y = st.y + 6;
    sq.path = [];
  }

  function enterStruct(world, sq, st) {
    if (st.garrison.length >= CS.GARRISON_MAX) return false;
    sq.inside = st.id;
    sq.path = [];
    sq.goal = null;
    sq.order = "garrison";
    sq.fighting = false;
    sq.sel = false;
    sq.home = st.id;
    sq.x = st.x;
    sq.y = st.y;
    for (const u of sq.units) { u.x = u.px = st.x; u.y = u.py = st.y; u.tgt = null; }
    st.garrison.push(sq);
    return true;
  }
  CS.enterStruct = enterStruct;

  function exitStruct(world, sq) {
    const st = structById(world, sq.inside);
    sq.inside = null;
    if (st) {
      st.garrison = st.garrison.filter((g) => g !== sq);
      placeAround(sq, st);
    }
  }

  function structById(world, id) {
    return world.structMap.get(id) || null;
  }
  CS.structById = structById;

  // ---------- 命令 ----------
  function setPath(world, sq, gx, gy) {
    sq.goal = { x: gx, y: gy };
    const p = CS.findPath(world.map, sq.x, sq.y, gx, gy);
    sq.path = p || [];
    if (sq.path.length) sq.heading = Math.atan2(sq.path[0].y - sq.y, sq.path[0].x - sq.x);
  }

  function orderMove(world, squads, x, y) {
    const list = squads.filter((s) => s.units.length);
    const cols = Math.ceil(Math.sqrt(list.length));
    list.forEach((sq, i) => {
      if (sq.inside) exitStruct(world, sq);
      const ox = ((i % cols) - (cols - 1) / 2) * 34;
      const oy = (Math.floor(i / cols) - (Math.ceil(list.length / cols) - 1) / 2) * 30;
      sq.order = "move";
      sq.target = null;
      sq.home = null;
      setPath(world, sq, x + ox, y + oy);
    });
  }
  CS.orderMove = orderMove;

  function orderStruct(world, squads, st) {
    squads.forEach((sq, i) => {
      if (!sq.units.length) return;
      if (sq.inside === st.id) return;
      if (sq.inside) exitStruct(world, sq);
      sq.target = st.id;
      sq.home = null;
      if (st.owner === sq.owner && !st.ruined) sq.order = "enter";
      else if (st.ruined) sq.order = "rebuild";
      else sq.order = "attack";
      const a = Math.atan2(sq.y - st.y, sq.x - st.x) + (i - (squads.length - 1) / 2) * 0.35;
      const dist = sq.order === "attack" ? Math.max(st.R + 4, Math.min(sq.st.range * 0.9 + st.R, st.R + 160)) : 6;
      setPath(world, sq, st.x + Math.cos(a) * dist, st.y + Math.sin(a) * dist * 0.85);
    });
  }
  CS.orderStruct = orderStruct;

  function release(world, st) {
    const out = st.garrison.slice();
    for (const sq of out) {
      exitStruct(world, sq);
      sq.order = "idle";
    }
    return out;
  }
  CS.release = release;

  // ---------- 经济 ----------
  function recount(world) {
    for (const o of Object.values(world.owners)) {
      o.supply = (o.edicts.granary || 0);
      o.used = 0;
      o.towers = 0;
      o.structs = 0;
    }
    for (const st of world.structs) {
      if (!st.owner || st.ruined) continue;
      const o = world.owners[st.owner];
      o.supply += STRUCTS[st.type].supply;
      o.structs++;
      if (st.type === "tower") o.towers++;
      for (const a of st.addons) if (a && ADDONS[a].supply) o.supply += ADDONS[a].supply;
      o.used += st.queue.length;
    }
    for (const sq of world.squads) {
      if (sq.st.summon || sq.owner === "n" || !sq.units.length) continue;
      world.owners[sq.owner].used++;
    }
    // 电脑对手的部队上限按难度封顶，随时间缓慢放宽（按节奏出兵）
    for (const id of world.foeIds) {
      const o = world.owners[id];
      if (o && o.ai && world.diff.army) o.supply = Math.min(o.supply, world.diff.army + Math.floor(world.t / 150));
    }
  }
  CS.recount = recount;

  function canRecruit(world, ownerId, st, type) {
    const o = world.owners[ownerId];
    if (!st || st.owner !== ownerId || st.ruined) return "据点不可用";
    if (!STRUCTS[st.type].recruit.includes(type)) return "这里不能训练";
    if (UNITS[type].req && st.level < UNITS[type].req) return "需要 " + UNITS[type].req + " 级据点";
    const s = stats(world, ownerId, type, st.level);
    if (st.queue.length >= 3) return "队列已满";
    if (o.used >= o.supply) return "部队上限已满（建农场或占据点）";
    if (o.gold < s.gold) return "金币不够";
    return null;
  }
  CS.canRecruit = canRecruit;

  function recruit(world, ownerId, st, type) {
    const why = canRecruit(world, ownerId, st, type);
    if (why) return why;
    const s = stats(world, ownerId, type, st.level);
    world.owners[ownerId].gold -= s.gold;
    if (ownerId === "p") world.stats.spent += s.gold;
    st.queue.push({ type, tier: st.level, t: 0, total: s.train });
    recount(world);
    world.events.push({ e: "queue", owner: ownerId, x: st.x, y: st.y });
    return null;
  }
  CS.recruit = recruit;

  function upgradeCost(st) {
    const up = STRUCTS[st.type].upgrade;
    return st.level < up.length ? up[st.level] : null;
  }
  CS.upgradeCost = upgradeCost;

  function upgrade(world, ownerId, st) {
    const cost = upgradeCost(st);
    const o = world.owners[ownerId];
    if (st.owner !== ownerId || st.ruined || cost == null) return "无法升级";
    if (o.gold < cost) return "金币不够";
    o.gold -= cost;
    const old = st.maxHp;
    st.level++;
    st.maxHp = structMaxHp(world, st.type, st.level, ownerId);
    st.hp += st.maxHp - old;
    world.events.push({ e: "upgrade", owner: ownerId, x: st.x, y: st.y });
    return null;
  }
  CS.upgrade = upgrade;

  function addonCost(world, ownerId, kind) {
    const o = world.owners[ownerId];
    return Math.round(ADDONS[kind].gold * ((o.edicts.masons || 0) ? 0.8 : 1));
  }
  CS.addonCost = addonCost;

  function build(world, ownerId, st, slot, kind) {
    const o = world.owners[ownerId];
    const cost = addonCost(world, ownerId, kind);
    if (st.owner !== ownerId || st.ruined || st.addons[slot]) return "无法建造";
    if (o.gold < cost) return "金币不够";
    o.gold -= cost;
    st.addons[slot] = kind;
    recount(world);
    world.events.push({ e: "build", owner: ownerId, x: st.x + CS.SLOT_OFFSETS[slot][0], y: st.y + CS.SLOT_OFFSETS[slot][1] });
    return null;
  }
  CS.build = build;

  // ---------- 法术 ----------
  function spellCd(o, key) {
    return SPELLS[key].cd * (1 - 0.15 * (o.edicts.haste || 0));
  }
  function canCast(world, ownerId, key) {
    const o = world.owners[ownerId];
    const sp = SPELLS[key];
    if ((o.cds[key] || 0) > world.t) return "冷却中";
    if (sp.needs === "tower" && !o.towers) return "需要控制一座法塔";
    if (o.mana < sp.mana) return "法力不够";
    return null;
  }
  CS.canCast = canCast;

  function cast(world, ownerId, key, x, y) {
    const why = canCast(world, ownerId, key);
    if (why) return why;
    const o = world.owners[ownerId];
    const sp = SPELLS[key];
    const pow = 1 + 0.2 * (o.edicts.lore || 0);
    o.mana -= sp.mana;
    o.cds[key] = world.t + spellCd(o, key);
    world.events.push({ e: "cast", key, owner: ownerId, x, y });
    world.fx.push({ k: "cast", x, y, r: sp.radius || 50, t: world.t, life: 0.7, faction: o.faction });
    if (sp.burst) {
      forEachInRadius(world, x, y, sp.radius, (u) => { if (u.owner === ownerId) u.hp = Math.min(u.max, u.hp + sp.burst * pow); });
    }
    if (sp.kind === "banner" || sp.kind === "area") {
      world.effects.push({ key, kind: sp.kind, owner: ownerId, x, y, r: sp.radius, until: world.t + sp.dur, start: world.t, pow, tickT: 0 });
    } else if (sp.kind === "strike") {
      world.fx.push({ k: key, x, y, r: sp.radius, t: world.t, life: 0.9 });
      forEachInRadius(world, x, y, sp.radius, (u) => {
        if (u.owner === ownerId) return;
        hurtUnit(world, u, sp.power * pow, "magic", { owner: ownerId });
        if (sp.stun) u.stun = Math.max(u.stun, sp.stun);
      });
      for (const st of world.structs) {
        if (Math.hypot(st.x - x, st.y - y) < sp.radius + st.R) hurtStruct(world, st, sp.fort * pow / DMG.magic.fort, "magic", ownerId);
      }
    } else if (sp.kind === "summon") {
      for (let i = 0; i < sp.count; i++) {
        const sq = spawnSquad(world, ownerId, sp.unit, 0, x + (i - (sp.count - 1) / 2) * 30, y, sp.squad || 1);
        sq.until = world.t + sp.dur;
        sq.order = "idle";
        for (const u of sq.units) { u.hp *= pow; u.max *= pow; }
      }
      world.fx.push({ k: key, x, y, r: 40, t: world.t, life: 1.2 });
    }
    return null;
  }
  CS.cast = cast;

  // ---------- 主循环 ----------
  function step(world) {
    const dt = CS.STEP;
    const t0 = now();
    world.t += dt;
    world.tick++;
    rebuildHash(world);
    applyEffects(world, dt);
    for (const sq of world.squads) updateSquad(world, sq, dt);
    separate(world);
    for (const st of world.structs) updateStruct(world, st, dt);
    updateProjectiles(world, dt);
    if (world.tick % 30 === 0) everySecond(world);
    // 清理
    let emptied = false;
    for (const sq of world.squads) {
      const us = sq.units;
      let j = 0;
      for (let i = 0; i < us.length; i++) if (!us[i].dead) us[j++] = us[i];
      if (j !== us.length) { us.length = j; if (!j) emptied = true; }
    }
    if (emptied) {
      world.squads = world.squads.filter((sq) => sq.units.length > 0);
      for (const st of world.structs) st.garrison = st.garrison.filter((g) => g.units.length > 0);
      recount(world);
    }
    world.fx = world.fx.filter((f) => world.t - f.t < f.life);
    world.perf.sim = world.perf.sim * 0.95 + (now() - t0) * 0.05;
  }
  CS.step = step;

  const now = typeof performance !== "undefined" ? () => performance.now() : () => Date.now();

  function applyEffects(world, dt) {
    for (const ef of world.effects) {
      const sp = SPELLS[ef.key];
      forEachInRadius(world, ef.x, ef.y, ef.r, (u) => {
        const friend = u.owner === ef.owner;
        if (sp.fx === "heal" && friend) u.hp = Math.min(u.max, u.hp + sp.power * ef.pow * dt);
        else if (sp.fx === "lust" && friend) u.lust = true;
        else if (sp.fx === "frost" && !friend) { u.frostSlow = Math.min(u.frostSlow, sp.power); u.vuln = sp.vuln; }
        else if (ef.kind === "area" && !friend) {
          hurtUnit(world, u, sp.power * ef.pow * dt, "magic", { owner: ef.owner });
          if (sp.slow) u.frostSlow = Math.min(u.frostSlow, sp.slow);
        }
      });
      if (ef.kind === "area") {
        for (const st of world.structs) {
          if (Math.hypot(st.x - ef.x, st.y - ef.y) < ef.r + st.R) hurtStruct(world, st, sp.power * ef.pow * dt * 0.6, "magic", ef.owner);
        }
      }
    }
    world.effects = world.effects.filter((ef) => ef.until > world.t);
  }

  function updateSquad(world, sq, dt) {
    if (sq.inside) return;
    if (sq.until && world.t > sq.until) {
      for (const u of sq.units) if (!u.dead) { u.dead = true; world.fx.push({ k: "poof", x: u.x, y: u.y, t: world.t, life: 0.6 }); }
      return;
    }
    const st = sq.st;
    sq.scan -= dt;
    if (sq.scan <= 0) {
      sq.scan = 0.2;
      let cx = sq.x;
      let cy = sq.y;
      let radius = st.aggro;
      if (sq.order === "guard" && sq.home) { cx = sq.home.x; cy = sq.home.y; radius = 110; }
      let e = nearestHostile(world, cx, cy, sq.owner, radius);
      // 近战只和走得到的敌人交战（隔着树林/河就不追）
      if (e && !st.proj && !CS.lineClear(world.map, sq.x, sq.y, e.x, e.y)) e = null;
      sq.engaged = e;
      if (sq.order === "guard" && sq.home && Math.hypot(sq.x - sq.home.x, sq.y - sq.home.y) > 170) sq.engaged = null;
    }
    if (sq.engaged && sq.engaged.dead) sq.engaged = null;
    const wasFighting = sq.fighting;
    sq.fighting = !!sq.engaged;
    if (sq.fighting) sq.quietT = 0;

    let siegeTarget = null;
    if (sq.order === "attack" && sq.target != null) {
      const ts = structById(world, sq.target);
      if (!ts) { sq.order = "idle"; }
      else if (ts.ruined) { sq.order = "rebuild"; setPath(world, sq, ts.x, ts.y); }
      else if (ts.owner === sq.owner) { sq.order = "enter"; setPath(world, sq, ts.x, ts.y); }
      else {
        const d = Math.hypot(ts.x - sq.x, ts.y - sq.y);
        // 滞回：进入攻城状态后，离开更远才退出，避免在边界来回切换
        if (d < ts.R + st.range + (sq.sieging === ts.id ? 120 : 50) && (st.proj || CS.lineClear(world.map, sq.x, sq.y, ts.x + (sq.x - ts.x) / d * ts.R, ts.y + (sq.y - ts.y) / d * ts.R))) { siegeTarget = ts; sq.sieging = ts.id; }
        else sq.sieging = null;
      }
    } else sq.sieging = null;

    if (sq.fighting || siegeTarget) {
      let cx = 0;
      let cy = 0;
      let n = 0;
      for (const u of sq.units) {
        if (u.dead) continue;
        actUnit(world, sq, u, dt, siegeTarget);
        cx += u.x; cy += u.y; n++;
      }
      if (n) { sq.x = cx / n; sq.y = cy / n; }
      if (sq.fighting) return;
      if (siegeTarget) return;
    }

    if (wasFighting && !sq.fighting) {
      // 打完仗：原路线第一个路点还能直接走到就沿用，省一次 A*
      if (sq.path.length && CS.lineClear(world.map, sq.x, sq.y, sq.path[0].x, sq.path[0].y)) { /* 继续原路线 */ }
      else if (sq.goal) setPath(world, sq, sq.goal.x, sq.goal.y);
      else if (sq.order === "guard" && sq.home) setPath(world, sq, sq.home.x, sq.home.y);
      else { // 原地重新整队
        let cx = 0; let cy = 0; let n = 0;
        for (const u of sq.units) { cx += u.x; cy += u.y; n++; }
        if (n) { sq.x = cx / n; sq.y = cy / n; }
      }
    }

    // 行军
    let slow = 1;
    let lust = false;
    for (const u of sq.units) { slow = Math.min(slow, u.frostSlow * (u.slowT > 0 ? 1 - u.slowA : 1)); if (u.lust) lust = true; }
    if (lust && slow >= 1) slow = SPELLS.lust.haste;
    const lag = formation(sq);
    if (sq.path.length) {
      // 等掉队的人
      const pace = lag > 30 ? 0.35 : lag > 18 ? 0.75 : 1;
      const p = sq.path[0];
      const d = Math.hypot(p.x - sq.x, p.y - sq.y);
      const stepLen = st.speed * slow * pace * dt;
      sq.heading = lerpAngle(sq.heading, Math.atan2(p.y - sq.y, p.x - sq.x), 0.25);
      if (d <= stepLen) { sq.x = p.x; sq.y = p.y; sq.path.shift(); }
      else { sq.x += ((p.x - sq.x) / d) * stepLen; sq.y += ((p.y - sq.y) / d) * stepLen; }
    } else {
      arrive(world, sq);
    }
    // 士兵跟随阵位
    formation(sq);
    const fspeed = st.speed * 1.15 * slow;
    for (const u of sq.units) {
      if (u.stun <= 0) moveUnitTo(world, u, u.fx, u.fy, fspeed, dt, 2);
      if (u.stun > 0) u.stun -= dt;
      if (u.slowT > 0) u.slowT -= dt; else u.slowA = 0;
      if (u.hitT > 0) u.hitT -= dt;
      if (u.atk > 0) u.atk -= dt;
      u.cd -= dt;
    }
  }

  function arrive(world, sq) {
    const ts = sq.target != null ? structById(world, sq.target) : null;
    if (sq.order === "enter" && ts) {
      if (ts.owner !== sq.owner || ts.ruined) { orderStruct(world, [sq], ts); return; }
      if (Math.hypot(ts.x - sq.x, ts.y - sq.y) < ts.R + 24) {
        if (!enterStruct(world, sq, ts)) { sq.order = "idle"; sq.target = null; }
        else world.events.push({ e: "enter", owner: sq.owner, x: ts.x, y: ts.y });
      } else setPath(world, sq, ts.x, ts.y);
    } else if (sq.order === "rebuild" && ts) {
      if (!ts.ruined) {
        if (ts.owner === sq.owner) { sq.order = "enter"; setPath(world, sq, ts.x, ts.y); }
        else orderStruct(world, [sq], ts);
        return;
      }
      if (Math.hypot(ts.x - sq.x, ts.y - sq.y) > ts.R + 20) { setPath(world, sq, ts.x, ts.y); return; }
      // 别人正在修：等对方被赶走
      if (ts.rebuilder && ts.rebuilder !== sq.owner && world.squads.some((o) => o.owner === ts.rebuilder && o.order === "rebuild" && o.target === ts.id && o.units.length)) return;
      ts.rebuilder = sq.owner;
      const masons = world.owners[sq.owner].edicts.masons ? 1.4 : 1;
      ts.rebuild += sq.units.length * 4.5 * masons * CS.STEP * (sq.st.summon ? 0 : 1);
      if (ts.rebuild >= ts.maxHp * 0.45) captureStruct(world, ts, sq);
    } else if (sq.order === "attack" && ts) {
      // 路走完了还没到射程：直接朝城走
      if (ts.ruined || ts.owner === sq.owner) { orderStruct(world, [sq], ts); return; }
      const d = Math.hypot(ts.x - sq.x, ts.y - sq.y);
      if (d > ts.R + st0(sq).range + 40) setPath(world, sq, ts.x + (sq.x - ts.x) / d * (ts.R + 10), ts.y + (sq.y - ts.y) / d * (ts.R + 10));
    } else if (sq.order === "move") {
      sq.order = "idle";
      sq.goal = null;
    } else if (sq.order === "defend") {
      const home = structById(world, sq.home);
      if (!home || home.owner !== sq.owner || home.ruined) { sq.order = "idle"; sq.home = null; return; }
      sq.quietT += CS.STEP;
      if (sq.quietT > 2.5) {
        if (Math.hypot(home.x - sq.x, home.y - sq.y) < home.R + 24) { enterStruct(world, sq, home); }
        else setPath(world, sq, home.x, home.y);
      }
    } else if (sq.order === "guard" && sq.home) {
      if (Math.hypot(sq.home.x - sq.x, sq.home.y - sq.y) > 12) setPath(world, sq, sq.home.x, sq.home.y);
      for (const u of sq.units) u.hp = Math.min(u.max, u.hp + 6 * CS.STEP);
    }
  }

  function st0(sq) { return sq.st; }

  function captureStruct(world, ts, sq) {
    ts.ruined = false;
    ts.owner = sq.owner;
    ts.maxHp = structMaxHp(world, ts.type, 0, sq.owner);
    ts.hp = ts.maxHp * 0.45;
    ts.rebuild = 0;
    ts.rebuilder = null;
    world.events.push({ e: "capture", owner: sq.owner, x: ts.x, y: ts.y, id: ts.id });
    if (sq.owner === "p") world.stats.captured++;
    // 修好的部队自动进驻
    for (const o of world.squads) {
      if (o.owner === sq.owner && o.order === "rebuild" && o.target === ts.id && o.units.length) enterStruct(world, o, ts);
    }
    recount(world);
  }

  function actUnit(world, sq, u, dt, siegeTarget) {
    const st = sq.st;
    if (u.stun > 0) { u.stun -= dt; return; }
    if (u.slowT > 0) u.slowT -= dt; else u.slowA = 0;
    if (u.hitT > 0) u.hitT -= dt;
    if (u.atk > 0) u.atk -= dt;
    const slow = u.frostSlow * (u.slowT > 0 ? 1 - u.slowA : 1);
    u.cd -= dt * slow * (u.lust ? SPELLS.lust.power : 1);
    u.retarget -= dt;
    if (!u.tgt || u.tgt.dead || u.retarget <= 0 || (u.tgt.ruined !== undefined && (u.tgt.ruined || u.tgt.owner === u.owner))) {
      u.retarget = 0.35 + world.rand() * 0.15;
      const look = Math.max(st.range + 50, 80);
      let t = nearestHostile(world, u.x, u.y, u.owner, look);
      if (t && !st.proj && !CS.lineClear(world.map, u.x, u.y, t.x, t.y)) t = null;
      if (!t && sq.engaged && !sq.engaged.dead) t = sq.engaged;
      if (!t && siegeTarget) t = siegeTarget;
      u.tgt = t;
    }
    const t = u.tgt;
    if (!t) { u.run = 0; return; }
    const isStruct = t.R !== undefined;
    const dx = t.x - u.x;
    const dy = t.y - u.y;
    const d = Math.hypot(dx, dy) - (isStruct ? t.R : 4);
    if (Math.abs(dx) > 0.5) u.face = dx > 0 ? 1 : -1;
    const reach = st.range + (st.proj ? 0 : 3);
    if (d > reach) {
      // 接近
      const tx = isStruct ? t.x - (dx / (d + t.R)) * (t.R + reach * 0.7) : t.x;
      const ty = isStruct ? t.y - (dy / (d + t.R)) * (t.R + reach * 0.7) : t.y;
      moveUnitTo(world, u, tx, ty, st.speed * slow, dt, 0);
      u.run += dt;
      return;
    }
    if (st.minRange && d < st.minRange && !isStruct) {
      moveUnitTo(world, u, u.x - dx, u.y - dy, st.speed * slow, dt, 0);
      return;
    }
    if (u.cd > 0) return;
    u.cd = st.cd * (0.92 + world.rand() * 0.16);
    u.atk = 0.22;
    let dmg = st.dmg;
    if (st.charge && u.run > 0.8) {
      dmg *= st.charge;
      world.fx.push({ k: "charge", x: t.x, y: t.y - 10, t: world.t, life: 0.5 });
    }
    u.run = 0;
    if (u.owner !== "p" && world.owners[u.owner].ai && u.owner !== "n") dmg *= 0.92;
    const src = { owner: u.owner, slowHit: st.slowHit };
    if (st.proj) {
      const dist = Math.hypot(dx, dy);
      const speed = st.proj === "stone" ? 150 : st.proj === "bolt" ? 260 : 330;
      world.proj.push({
        k: st.proj, owner: u.owner, x: u.x, y: u.y - 6, sx: u.x, sy: u.y - 6,
        tx: t.x, ty: t.y, tgt: isStruct ? null : t, st: isStruct ? t : null,
        t: 0, dur: Math.max(0.15, dist / speed), dmg, type: st.dmgType, splash: st.splash, src,
        lust: u.lust, faction: world.owners[u.owner].faction,
      });
      world.events.push({ e: "shoot", k: st.proj, x: u.x, y: u.y });
    } else {
      if (isStruct) hurtStruct(world, t, dmg, st.dmgType, u.owner, u.lust ? 1.6 : 1);
      else {
        hurtUnit(world, t, dmg, st.dmgType, src);
        if (st.splash) {
          forEachInRadius(world, t.x, t.y, st.splash, (o) => { if (o !== t && o.owner !== u.owner) hurtUnit(world, o, dmg * 0.5, st.dmgType, src); });
        }
      }
      world.events.push({ e: "hit", x: t.x, y: t.y, type: sq.type });
    }
    if (st.healAura) {
      forEachInRadius(world, u.x, u.y, 60, (o) => { if (o.owner === u.owner) o.hp = Math.min(o.max, o.hp + st.healAura); });
    }
  }

  function moveUnitTo(world, u, tx, ty, speed, dt, eps) {
    // 被地形挡住的士兵：走自己的小路径绕过去
    if (u.path) {
      if (u.pathT < world.t || !u.path.length) u.path = null;
      else {
        const p = u.path[0];
        if (Math.hypot(p.x - u.x, p.y - u.y) < 6) u.path.shift();
        if (u.path.length) { tx = u.path[0].x; ty = u.path[0].y; eps = 0; }
        else u.path = null;
      }
    }
    const dx = tx - u.x;
    const dy = ty - u.y;
    const d = Math.hypot(dx, dy);
    if (d <= eps) { u.moving = false; u.blocked = 0; return; }
    const s = Math.min(d, speed * dt);
    const nx = u.x + (dx / d) * s;
    const ny = u.y + (dy / d) * s;
    const map = world.map;
    const ox = u.x;
    const oy = u.y;
    if (!CS.blockedAt(map, nx, ny)) { u.x = nx; u.y = ny; }
    else if (!CS.blockedAt(map, nx, u.y)) u.x = nx;
    else if (!CS.blockedAt(map, u.x, ny)) u.y = ny;
    const moved = Math.abs(u.x - ox) + Math.abs(u.y - oy);
    if (moved < s * 0.3 && d > 20) {
      if (++u.blocked > 8 && !u.path) {
        u.blocked = 0;
        const p = CS.findPath(map, u.x, u.y, tx, ty);
        if (p && p.length) { u.path = p; u.pathT = world.t + 3; }
      }
    } else u.blocked = 0;
    if (Math.abs(dx) > 1) u.face = dx > 0 ? 1 : -1;
    u.moving = true;
    u.step += s * 0.35;
  }

  function separate(world) {
    // 同格内推开，避免叠成一个点
    for (const cell of world.hash) {
      const n = cell.length;
      for (let i = 0; i < n; i++) {
        const a = cell[i];
        for (let j = i + 1; j < n; j++) {
          const b = cell[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const rr = a.rad > b.rad ? a.rad : b.rad;
          const d2 = dx * dx + dy * dy;
          if (d2 >= rr * rr || d2 === 0) continue;
          const d = Math.sqrt(d2);
          const push = (rr - d) * 0.5;
          const ux = dx / d;
          const uy = dy / d;
          if (!CS.blockedAt(world.map, a.x - ux * push, a.y - uy * push)) { a.x -= ux * push; a.y -= uy * push; }
          if (!CS.blockedAt(world.map, b.x + ux * push, b.y + uy * push)) { b.x += ux * push; b.y += uy * push; }
        }
      }
    }
  }

  function updateStruct(world, st, dt) {
    if (st.hitFlash > 0) st.hitFlash -= dt;
    if (st.ruined || !st.owner) return;
    // 训练
    if (st.queue.length) {
      const q = st.queue[0];
      q.t += dt;
      if (q.t >= q.total) {
        st.queue.shift();
        const sq = spawnSquad(world, st.owner, q.type, q.tier, st.x, st.y + st.R + 14);
        sq.order = "idle";
        if (st.rally) { sq.order = "move"; setPath(world, sq, st.rally.x, st.rally.y); }
        else {
          // 出生后站到据点两侧（让开下方的建造木牌），一侧排满就排另一侧
          const spot = standSpot(world, st);
          setPath(world, sq, spot.x, spot.y);
          sq.order = "move";
        }
        world.events.push({ e: "spawn", owner: st.owner, x: st.x, y: st.y, id: sq.id });
        recount(world);
      }
    }
    // 守军出击 / 箭塔
    st.shotCd -= dt;
    const sdef = STRUCTS[st.type];
    const watch = st.addons.indexOf("watch") >= 0;
    const shotR = (sdef.shotR || SHOT_R) + (watch ? 30 : 0);
    const threat = st.shotCd <= 0 || st.garrison.length ? nearestHostile(world, st.x, st.y, st.owner, Math.max(SORTIE_R, shotR)) : null;
    if (threat && st.garrison.length) {
      for (const sq of st.garrison.slice()) {
        exitStruct(world, sq);
        sq.order = "defend";
        sq.home = st.id;
        sq.quietT = 0;
        sq.engaged = threat;
        sq.scan = 0;
      }
      world.events.push({ e: "sortie", owner: st.owner, x: st.x, y: st.y });
    }
    if (st.shotCd <= 0) {
      st.shotCd = sdef.shotCd || 1.4;
      if (threat && Math.hypot(threat.x - st.x, threat.y - st.y) < shotR) {
        const dmg = sdef.shot * (1 + 0.5 * st.level) * (watch ? 2 : 1) * (1 + 0.2 * (world.owners[st.owner].tech.walls || 0));
        world.proj.push({
          k: "arrow", owner: st.owner, x: st.x, y: st.y - st.R, sx: st.x, sy: st.y - st.R,
          tx: threat.x, ty: threat.y, tgt: threat, st: null, t: 0, dur: 0.35, dmg, type: "pierce", splash: 0,
          src: { owner: st.owner }, faction: world.owners[st.owner].faction,
        });
      }
    }
    // 回血
    if (world.t - st.lastHit > 6) st.hp = Math.min(st.maxHp, st.hp + 4 * dt * (1 + st.level * 0.5));
    for (const sq of st.garrison) for (const u of sq.units) u.hp = Math.min(u.max, u.hp + 5 * dt);
    // 防守中的部队离家太远就回来
  }

  function updateProjectiles(world, dt) {
    for (const p of world.proj) {
      p.t += dt;
      if (p.tgt && !p.tgt.dead && p.k !== "stone") { p.tx = p.tgt.x; p.ty = p.tgt.y; }
      const k = Math.min(1, p.t / p.dur);
      p.x = p.sx + (p.tx - p.sx) * k;
      p.y = p.sy + (p.ty - p.sy) * k;
      if (k < 1) continue;
      p.done = true;
      if (p.splash) {
        forEachInRadius(world, p.tx, p.ty, p.splash, (o) => {
          if (o.owner === p.owner) return;
          const near = Math.hypot(o.x - p.tx, o.y - p.ty) / p.splash;
          hurtUnit(world, o, p.dmg * (1 - near * 0.5), p.type, p.src);
        });
        for (const st of world.structs) {
          if (Math.hypot(st.x - p.tx, st.y - p.ty) < st.R + p.splash) hurtStruct(world, st, p.dmg, p.type, p.owner, p.lust ? 1.6 : 1);
        }
        world.fx.push({ k: p.k === "stone" ? "boom" : "burst", x: p.tx, y: p.ty, r: p.splash, t: world.t, life: 0.5, faction: p.faction });
        world.events.push({ e: "impact", k: p.k, x: p.tx, y: p.ty });
      } else if (p.st) {
        hurtStruct(world, p.st, p.dmg, p.type, p.owner, p.lust ? 1.6 : 1);
      } else if (p.tgt && !p.tgt.dead) {
        hurtUnit(world, p.tgt, p.dmg, p.type, p.src);
      }
    }
    world.proj = world.proj.filter((p) => !p.done);
  }

  function everySecond(world) {
    // 收入
    for (const st of world.structs) {
      if (!st.owner || st.ruined) continue;
      const o = world.owners[st.owner];
      const def = STRUCTS[st.type];
      let g = def.gold;
      let m = def.mana;
      for (const a of st.addons) {
        if (!a) continue;
        const inc = ADDONS[a].income;
        if (inc) { g += inc.gold || 0; m += inc.mana || 0; }
      }
      o.gold += g * o.income * (1 + 0.1 * (o.tech.tax || 0));
      o.mana = Math.min(CS.MANA_CAP, o.mana + m * o.income);
    }
    for (const id of ["p"].concat(world.foeIds)) {
      const o = world.owners[id];
      if (o && o.alive !== false && o.structs > 0) o.mana = Math.min(CS.MANA_CAP, o.mana + CS.MANA_BASE * (o.ai ? o.income : 1));
    }
    // 宝箱
    for (const c of world.chests) {
      if (c.taken) continue;
      const guarded = world.squads.some((sq) => sq.owner === "n" && sq.units.length && Math.hypot(sq.x - c.x, sq.y - c.y) < 150);
      if (guarded) continue;
      let taker = null;
      forEachInRadius(world, c.x, c.y, 34, (u) => { if (u.owner !== "n" && !taker) taker = u.owner; });
      if (taker) {
        c.taken = true;
        world.owners[taker].gold += c.gold;
        world.events.push({ e: "chest", owner: taker, x: c.x, y: c.y, gold: c.gold });
      }
    }
    // 兜底：行军中 4 秒没挪窝就从队伍重心重新寻路
    for (const sq of world.squads) {
      if (sq.inside || sq.fighting || !sq.units.length) { sq.stuck = 0; continue; }
      const moved = sq.lastX == null || Math.hypot(sq.x - sq.lastX, sq.y - sq.lastY) > 4;
      sq.lastX = sq.x; sq.lastY = sq.y;
      const wants = sq.path.length > 0 || sq.order === "attack";
      if (!wants || moved || sq.sieging) { sq.stuck = 0; continue; }
      if (++sq.stuck >= 4) {
        sq.stuck = 0;
        let cx = 0; let cy = 0;
        for (const u of sq.units) { cx += u.x; cy += u.y; }
        sq.x = cx / sq.units.length; sq.y = cy / sq.units.length;
        const ts = sq.target != null ? structById(world, sq.target) : null;
        if (ts) setPath(world, sq, ts.x, ts.y); else if (sq.goal) setPath(world, sq, sq.goal.x, sq.goal.y);
      }
    }
    // 防守部队离家超过范围就回
    for (const sq of world.squads) {
      if (sq.order !== "defend" || sq.fighting) continue;
      const home = structById(world, sq.home);
      if (home && Math.hypot(home.x - sq.x, home.y - sq.y) > 40 && !sq.path.length) setPath(world, sq, home.x, home.y);
    }
    recount(world);
    checkOutcome(world);
  }

  function checkOutcome(world) {
    if (world.outcome || world.opts.bench) return;
    const alive = (id) => world.structs.some((s) => s.owner === id && !s.ruined) ||
      world.squads.some((q) => q.owner === id && q.units.length && !q.st.summon && q.order === "rebuild");
    for (const id of world.foeIds) {
      const o = world.owners[id];
      if (!o || !o.alive) continue;
      if (!world.structs.some((s) => s.owner === id && !s.ruined)) {
        o.alive = false;
        world.events.push({ e: "eliminated", owner: id });
        // 失去所有据点的残兵溃散
        for (const sq of world.squads) if (sq.owner === id) for (const u of sq.units) if (!u.dead) { u.dead = true; world.fx.push({ k: "poof", x: u.x, y: u.y, t: world.t, life: 0.6 }); }
      }
    }
    const foesLeft = world.foeIds.some((id) => world.owners[id] && world.owners[id].alive);
    if (!foesLeft) { world.outcome = "win"; world.events.push({ e: "win" }); return; }
    const pHas = alive("p") || world.squads.some((q) => q.owner === "p" && q.units.length && !q.st.summon);
    if (!pHas) { world.outcome = "lose"; world.events.push({ e: "lose" }); }
  }

  function lerpAngle(a, b, k) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * k;
  }

  CS.squadHp = function (sq) {
    let hp = 0;
    let max = 0;
    for (const u of sq.units) { hp += Math.max(0, u.hp); max += u.max; }
    return { hp, max: Math.max(max, sq.st.hp * sq.st.size * 0.0001), n: sq.units.length };
  };
})(typeof window !== "undefined" ? window : globalThis);
