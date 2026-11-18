// 压力测试的建世界与补兵逻辑（无 DOM）。
// 主线程、Web Worker（simworker.js）和 Node 工具共用同一份，保证三处跑的是同一场仗；
// Rust 后端拿 benchInit() 导出的数据在自己那边重建同一个世界。
(function (root) {
  "use strict";
  const CS = root.CS;

  const TYPES = ["foot", "archer", "cav", "foot", "mage", "archer", "siege", "guard"];
  CS.BENCH_TYPES = TYPES;

  // cfg: { n 目标士兵数, map 地图规格(s/m/l/xl), seed, fog, biome }
  CS.benchSetup = function (cfg) {
    const size = CS.MAP_SIZES.find((s) => s.id === cfg.map) || CS.MAP_SIZES[2];
    const foes = Array.from({ length: size.foes }, (_, i) => CS.PLAYABLE[(i + 1) % CS.PLAYABLE.length]);
    const layout = CS.genContinent({ cols: size.cols, rows: size.rows, seed: cfg.seed, foes, biome: cfg.biome || "temperate", name: "压力测试" });
    const enemies = {};
    foes.forEach((f, i) => { enemies[CS.OWNER_IDS[i + 1]] = f; });
    const opts = {
      player: "duchy", layout, diff: 5, gold: 99999, aiGold: 99999, enemies, edicts: {}, autoplay: true,
      seed: cfg.seed, noCap: true, bench: true, fog: !!cfg.fog, dayNight: true,
    };
    return { size, opts };
  };

  CS.benchWorld = function (cfg) {
    const { size, opts } = CS.benchSetup(cfg);
    const world = CS.createWorld(opts);
    for (const o of Object.values(world.owners)) o.mana = 150;
    world.benchSize = size;
    return world;
  };

  // 每 4 个模拟步给各家补一批兵，直到达到目标数量（按模拟步数走，各外壳里完全一致）
  // b: { n 目标, k 计数器, done }
  CS.benchSpawn = function (w, b) {
    if (b.done || w.soldierCount >= b.n || w.tick % 4 !== 0) return;
    const gap = b.n - w.soldierCount;
    const per = gap > 5000 ? 6 : gap > 600 ? 2 : 1; // 离目标还远就多补几队，上万兵的档位不用等太久
    for (const id of ["p"].concat(w.foeIds)) {
      const home = w.structs.filter((s) => s.owner === id && !s.ruined);
      if (!home.length) continue;
      for (let j = 0; j < per; j++) {
        const st = home[(b.k + j) % home.length];
        const type = TYPES[(b.k + j) % TYPES.length];
        const sq = CS.spawnSquad(w, id, type, (b.k + j) % 3, st.x + (w.rand() - 0.5) * 60, st.y + st.R + 16);
        // 目标：离这座城最近的三座敌城里随机一座
        const foes = w.structs.filter((s) => s.owner && s.owner !== id).sort((a, c) => Math.hypot(a.x - st.x, a.y - st.y) - Math.hypot(c.x - st.x, c.y - st.y)).slice(0, 3);
        const tgt = foes[Math.floor(w.rand() * foes.length)];
        if (tgt) CS.orderStruct(w, [sq], tgt);
      }
    }
    b.k++;
  };

  // 导出给 Rust 后端的初始化数据：规则表 + 地图通行格 + 据点布局 + 开局参数。
  // Rust 那边按同样的顺序建世界、用同一个随机数发生器，所以开局完全一致。
  CS.benchInit = function (cfg) {
    const { opts } = CS.benchSetup(cfg);
    const L = CS.resolveLayout(opts.layout, false);
    const map = CS.buildMap(L);
    const spells = {};
    for (const [k, f] of Object.entries(CS.FACTIONS)) spells[k] = f.spells;
    return {
      consts: { TILE: CS.TILE, STEP: CS.STEP, MAPK: CS.MAPK, GARRISON_MAX: CS.GARRISON_MAX, MANA_CAP: CS.MANA_CAP, MANA_BASE: CS.MANA_BASE },
      unitTypes: Object.keys(CS.UNITS), structTypes: Object.keys(CS.STRUCTS), addonKinds: Object.keys(CS.ADDONS),
      spellKeys: Object.keys(CS.SPELLS), techIds: CS.TECHS.map((t) => t.id), factions: Object.keys(CS.FACTIONS),
      ownerIds: CS.OWNER_IDS,
      UNITS: CS.UNITS, FACTION_UNIT: CS.FACTION_UNIT, TIER: CS.TIER, STRUCTS: CS.STRUCTS, ADDONS: CS.ADDONS, SPELLS: CS.SPELLS,
      TECHS: CS.TECHS, DMG: CS.DMG, factionSpells: spells, diff: CS.DIFF[opts.diff],
      cols: map.cols, rows: map.rows, blocked: Array.from(map.blocked),
      layout: { seed: L.seed, s: L.s, o: L.o },
      opts: { player: opts.player, enemies: opts.enemies, diffIndex: opts.diff, gold: opts.gold, aiGold: opts.aiGold, noCap: true, bench: true, seed: opts.seed },
      bench: { n: cfg.n, types: TYPES, mana: 150 },
    };
  };
})(typeof window !== "undefined" ? window : globalThis);
