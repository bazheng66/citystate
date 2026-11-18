//! 世界状态与“建世界 / 下命令 / 经济 / 法术”这些基础操作。对应 sim.js 的前半部分。
//!
//! JS 里对象之间互相引用（士兵 → 目标士兵、飞行物 → 目标……），这里改成下标：
//! 士兵放在一个大数组里（空位复用），引用带一个“代数”，槽位被新士兵占用后旧引用自动失效，
//! 效果等同于 JS 里“那个对象已经 dead 了”。

use crate::data::*;
use crate::jsmath::JsMath;
use crate::path::PathBuf;
use crate::rng::Rng;
use serde_json::Value;
use std::collections::VecDeque;

pub const CELL: f64 = 48.0;
pub const NONE: u8 = 255;

// 事件编号：和 game/js/snap.js 的 S.EVENTS 顺序一致
pub const EV_DIE: u8 = 0;
pub const EV_HIT: u8 = 1;
pub const EV_SHOOT: u8 = 2;
pub const EV_IMPACT: u8 = 3;
pub const EV_SPAWN: u8 = 4;
pub const EV_CAST: u8 = 5;
pub const EV_QUEUE: u8 = 6;
pub const EV_BUILD: u8 = 7;
pub const EV_UPGRADE: u8 = 8;
pub const EV_TECH: u8 = 9;
pub const EV_ENTER: u8 = 10;
pub const EV_SORTIE: u8 = 11;
pub const EV_CAPTURE: u8 = 12;
pub const EV_CHEST: u8 = 13;
// 特效编号：和 S.FX_KINDS 一致；16 以上 = 16 + 法术序号
pub const FX_CAST: u8 = 0;
pub const FX_CHARGE: u8 = 1;
pub const FX_POOF: u8 = 2;
pub const FX_BOOM: u8 = 3;
pub const FX_BURST: u8 = 4;

#[derive(Clone, Copy, PartialEq)]
pub enum Tgt {
    None,
    /// (槽位, 代数)
    Unit(u32, u32),
    /// 据点下标
    Struct(u32),
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Order {
    Idle,
    Move,
    Attack,
    Enter,
    Rebuild,
    Garrison,
    Guard,
    Defend,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Home {
    None,
    Pos(f64, f64),
    Struct(u32),
}

/// 某一家、某个兵种、某个等级的实际数值（sim.js 的 stats()）
#[derive(Clone, Copy, Default)]
pub struct Stats {
    pub typ: u8,
    pub size: usize,
    pub hp: f64,
    pub dmg: f64,
    pub cd: f64,
    pub range: f64,
    pub min_range: f64,
    pub speed: f64,
    pub armor: usize,
    pub dmg_type: usize,
    pub proj: u8,
    pub splash: f64,
    pub charge: f64,
    pub aggro: f64,
    pub has_resist: bool,
    pub resist: [f64; 5],
    pub slow_hit: f64,
    pub heal_aura: f64,
    pub gold: f64,
    pub train: f64,
    pub summon: bool,
    pub big: bool,
    pub wide: bool,
}

pub struct Unit {
    pub gen: u32,
    pub owner: u8,
    pub typ: u8,
    /// 数值表下标
    pub st: u32,
    pub x: f64,
    pub y: f64,
    pub px: f64,
    pub py: f64,
    pub hp: f64,
    pub max: f64,
    pub cd: f64,
    pub tgt: Tgt,
    pub retarget: f64,
    pub face: i8,
    pub run: f64,
    pub atk: f64,
    pub dead: bool,
    pub slow_t: f64,
    pub slow_a: f64,
    pub stun: f64,
    pub i: u32,
    pub moving: bool,
    pub lust: bool,
    pub frost_slow: f64,
    pub vuln: f64,
    pub step: f64,
    pub blocked: u32,
    pub path: Option<VecDeque<(f64, f64)>>,
    pub path_t: f64,
    pub rad: f64,
    pub fx: f64,
    pub fy: f64,
    pub hit_t: f64,
}

pub struct Squad {
    pub live: bool,
    pub id: u32,
    pub owner: u8,
    pub typ: u8,
    pub tier: u8,
    pub st: u32,
    pub x: f64,
    pub y: f64,
    pub heading: f64,
    pub path: VecDeque<(f64, f64)>,
    pub goal: Option<(f64, f64)>,
    pub order: Order,
    pub target: Option<u32>,
    pub inside: Option<u32>,
    pub fighting: bool,
    pub scan: f64,
    pub engaged: Tgt,
    pub units: Vec<u32>,
    pub home: Home,
    pub quiet_t: f64,
    pub until: f64,
    pub stuck: u32,
    pub sieging: Option<u32>,
    pub last: Option<(f64, f64)>,
    pub wave_id: Option<u32>,
}

#[derive(Clone, Copy)]
pub struct QItem {
    pub typ: u8,
    pub tier: u8,
    pub t: f64,
    pub total: f64,
}

pub struct Struct {
    pub id: u32,
    pub typ: usize,
    pub x: f64,
    pub y: f64,
    pub r: f64,
    pub owner: u8,
    pub level: u32,
    pub max_hp: f64,
    pub hp: f64,
    pub ruined: bool,
    pub rebuild: f64,
    pub rebuilder: u8,
    /// 0 = 空，其余 = 附属建筑序号 + 1
    pub addons: [u8; 3],
    pub queue: Vec<QItem>,
    pub garrison: Vec<u32>,
    pub shot_cd: f64,
    pub last_hit: f64,
    pub hit_flash: f64,
}

pub struct Owner {
    pub faction: usize,
    pub ai: bool,
    pub neutral: bool,
    pub gold: f64,
    pub mana: f64,
    pub supply: f64,
    pub used: f64,
    pub cds: Vec<f64>,
    pub income: f64,
    pub tech: Vec<u32>,
    pub alive: bool,
    pub structs: u32,
    pub towers: u32,
    pub ai_t: f64,
    pub attacking: Option<u32>,
    pub wave: u32,
}

pub struct Proj {
    pub k: u8,
    pub owner: u8,
    pub x: f64,
    pub y: f64,
    pub sx: f64,
    pub sy: f64,
    pub tx: f64,
    pub ty: f64,
    pub tgt: Tgt,
    pub st: Option<u32>,
    pub t: f64,
    pub dur: f64,
    pub dmg: f64,
    pub typ: usize,
    pub splash: f64,
    pub slow_hit: f64,
    pub lust: bool,
    pub faction: u8,
    pub done: bool,
}

pub struct Effect {
    pub key: usize,
    pub kind: u8,
    pub owner: u8,
    pub x: f64,
    pub y: f64,
    pub r: f64,
    pub until: f64,
    pub start: f64,
    pub pow: f64,
}

pub struct Chest {
    pub x: f64,
    pub y: f64,
    pub gold: f64,
    pub taken: bool,
}

#[derive(Clone, Copy)]
pub struct Ev {
    pub e: u8,
    pub owner: u8,
    pub sub: u8,
    pub face: bool,
    pub x: f32,
    pub y: f32,
    pub extra: f32,
}

#[derive(Clone, Copy)]
pub struct Fx {
    pub k: u8,
    /// 0 = 无，其余 = 势力序号 + 1
    pub faction: u8,
    pub x: f32,
    pub y: f32,
    pub r: f32,
    pub t: f32,
    pub life: f32,
}

pub struct Bench {
    pub n: u32,
    pub k: usize,
    pub types: Vec<u8>,
}

/// 用得到名字的那几个兵种 / 据点 / 附属建筑 / 科技的下标
#[derive(Default)]
pub struct Ids {
    pub foot: u8,
    pub archer: u8,
    pub cav: u8,
    pub siege: u8,
    pub mage: u8,
    pub guard: u8,
    pub ogre: u8,
    pub castle: usize,
    pub tower: usize,
    pub mine: u8,
    pub obelisk: u8,
    pub farm: u8,
    pub watch: u8,
    pub forge: usize,
    pub plate: usize,
    pub roads: usize,
    pub walls: usize,
    pub tax: usize,
    pub lust: usize,
    pub smite: Option<usize>,
}

pub struct World {
    pub d: Data,
    pub ids: Ids,
    pub t: f64,
    pub tick: u32,
    pub cols: usize,
    pub rows: usize,
    pub blocked: Vec<u8>,
    pub w: f64,
    pub h: f64,
    pub hc: usize,
    pub hr: usize,
    pub hash: Vec<Vec<u32>>,
    pub owners: Vec<Owner>,
    pub foe_ids: Vec<u8>,
    pub n_owner: u8,
    pub structs: Vec<Struct>,
    pub units: Vec<Unit>,
    pub free: Vec<u32>,
    pub free_pending: Vec<u32>,
    pub squads: Vec<Squad>,
    pub sq_free: Vec<u32>,
    /// 部队的遍历顺序（对应 JS 的 world.squads 数组）
    pub order: Vec<u32>,
    pub proj: Vec<Proj>,
    pub effects: Vec<Effect>,
    pub chests: Vec<Chest>,
    pub events: Vec<Ev>,
    pub new_fx: Vec<Fx>,
    pub next_id: u32,
    pub rng: Rng,
    pub stats: Vec<Option<Stats>>,
    pub soldier_count: u32,
    pub perf_sim: f64,
    pub path_calls: u64,
    pub(crate) pbuf: PathBuf,
    pub(crate) scratch: Vec<u32>,
    pub bench: Bench,
}

fn name_idx(list: &[String], name: &str) -> usize {
    index_of(list, name).unwrap_or(0)
}

impl World {
    /// sim.js 的 createWorld + benchcore.js 的 benchWorld：同样的创建顺序、同样的随机数消耗顺序
    pub fn new(init: &Value) -> Result<World, String> {
        let d = Data::from_json(init)?;
        let cols = init["cols"].as_u64().ok_or("缺 cols")? as usize;
        let rows = init["rows"].as_u64().ok_or("缺 rows")? as usize;
        let blocked: Vec<u8> = init["blocked"].as_array().ok_or("缺 blocked")?.iter().map(|v| v.as_u64().unwrap_or(0) as u8).collect();
        if blocked.len() != cols * rows {
            return Err("blocked 的长度和地图尺寸对不上".into());
        }
        let opts = &init["opts"];
        let layout = &init["layout"];
        let w = cols as f64 * d.tile;
        let h = rows as f64 * d.tile;
        let hc = (w / CELL).ceil() as usize;
        let hr = (h / CELL).ceil() as usize;

        let ids = Ids {
            foot: name_idx(&d.unit_types, "foot") as u8,
            archer: name_idx(&d.unit_types, "archer") as u8,
            cav: name_idx(&d.unit_types, "cav") as u8,
            siege: name_idx(&d.unit_types, "siege") as u8,
            mage: name_idx(&d.unit_types, "mage") as u8,
            guard: name_idx(&d.unit_types, "guard") as u8,
            ogre: name_idx(&d.unit_types, "ogre") as u8,
            castle: name_idx(&d.struct_types, "castle"),
            tower: name_idx(&d.struct_types, "tower"),
            mine: name_idx(&d.addon_kinds, "mine") as u8 + 1,
            obelisk: name_idx(&d.addon_kinds, "obelisk") as u8 + 1,
            farm: name_idx(&d.addon_kinds, "farm") as u8 + 1,
            watch: name_idx(&d.addon_kinds, "watch") as u8 + 1,
            forge: name_idx(&d.tech_ids, "forge"),
            plate: name_idx(&d.tech_ids, "plate"),
            roads: name_idx(&d.tech_ids, "roads"),
            walls: name_idx(&d.tech_ids, "walls"),
            tax: name_idx(&d.tech_ids, "tax"),
            lust: name_idx(&d.spell_keys, "lust"),
            smite: index_of(&d.spell_keys, "smite"),
        };

        // 归属方：玩家、各个对手（按 OWNER_IDS 的顺序）、中立
        let mut owner_names: Vec<String> = vec!["p".into()];
        let mut owners: Vec<Owner> = Vec::new();
        let n_spells = d.spell_keys.len();
        let n_tech = d.tech_ids.len();
        let mk = |faction: &str, ai: bool, d: &Data| Owner {
            faction: name_idx(&d.factions, faction),
            ai,
            neutral: faction == "wild",
            gold: 0.0,
            mana: 0.0,
            supply: 0.0,
            used: 0.0,
            cds: vec![0.0; n_spells],
            income: 1.0,
            tech: vec![0; n_tech],
            alive: true,
            structs: 0,
            towers: 0,
            ai_t: 0.0,
            attacking: None,
            wave: 0,
        };
        owners.push(mk(opts["player"].as_str().unwrap_or("duchy"), true, &d));
        let mut foe_ids = Vec::new();
        for id in d.owner_ids.clone() {
            if id == "p" {
                continue;
            }
            if let Some(f) = opts["enemies"].get(&id).and_then(|v| v.as_str()) {
                owners.push(mk(f, true, &d));
                foe_ids.push((owners.len() - 1) as u8);
                owner_names.push(id);
            }
        }
        owners.push(mk("wild", true, &d));
        owner_names.push("n".into());
        let n_owner = (owners.len() - 1) as u8;

        let mut diff = d.diff.clone();
        if opts["noCap"].as_bool().unwrap_or(false) {
            diff.army = 0.0;
        }
        owners[0].gold = opts["gold"].as_f64().unwrap_or(200.0);
        owners[0].mana = 60.0;
        for &i in &foe_ids {
            let o = &mut owners[i as usize];
            o.gold = opts["aiGold"].as_f64().unwrap_or(diff.gold);
            o.mana = 40.0;
            o.income = diff.income;
        }

        let seed = opts["seed"].as_f64().unwrap_or(1.0);
        let seed = if seed == 0.0 { 1.0 } else { seed };
        let lseed = layout["seed"].as_f64().unwrap_or(0.0);
        let n_stats = owners.len() * d.unit_types.len() * 3;
        let bench_types = init["bench"]["types"].as_array().map(|a| a.iter().map(|t| name_idx(&d.unit_types, t.as_str().unwrap_or("foot")) as u8).collect()).unwrap_or_default();

        let mut d = d;
        d.diff = diff;
        let mut world = World {
            ids,
            t: 0.0,
            tick: 0,
            cols,
            rows,
            blocked,
            w,
            h,
            hc,
            hr,
            hash: vec![Vec::new(); hc * hr],
            owners,
            foe_ids,
            n_owner,
            structs: Vec::new(),
            units: Vec::new(),
            free: Vec::new(),
            free_pending: Vec::new(),
            squads: Vec::new(),
            sq_free: Vec::new(),
            order: Vec::new(),
            proj: Vec::new(),
            effects: Vec::new(),
            chests: Vec::new(),
            events: Vec::new(),
            new_fx: Vec::new(),
            next_id: 1,
            rng: Rng::new((seed * 7777.0 + lseed) as i64 as u32),
            stats: vec![None; n_stats],
            soldier_count: 0,
            perf_sim: 0.0,
            path_calls: 0,
            pbuf: PathBuf::new(cols * rows),
            scratch: Vec::new(),
            bench: Bench { n: init["bench"]["n"].as_u64().unwrap_or(0) as u32, k: 0, types: bench_types },
            d,
        };

        let tile = world.d.tile;
        // 据点
        for s in layout["s"].as_array().ok_or("缺 layout.s")? {
            let typ = name_idx(&world.d.struct_types, s[0].as_str().unwrap_or("town"));
            let c = s[1].as_f64().unwrap_or(0.0);
            let r = s[2].as_f64().unwrap_or(0.0);
            let own = s[3].as_str().unwrap_or("-");
            let owner = if own.is_empty() || own == "-" {
                NONE
            } else {
                // 布局里写了但这一局没有的归属方，归给 a
                owner_names.iter().position(|n| n == own).unwrap_or(1) as u8
            };
            let level = s[4].as_f64().unwrap_or(0.0) as u32;
            let st = world.make_struct(typ, (c + 0.5) * tile, (r + 0.5) * tile, owner, level);
            world.structs.push(st);
        }
        // 野怪营地：一个宝箱 + 一队食人魔
        if let Some(camps) = layout["o"].as_array() {
            for o in camps {
                let x = (o[0].as_f64().unwrap_or(0.0) + 0.5) * tile;
                let y = (o[1].as_f64().unwrap_or(0.0) + 0.5) * tile;
                let n = o[2].as_f64().unwrap_or(1.0) as usize;
                world.next_id += 1; // 宝箱占一个编号
                world.chests.push(Chest { x: x + 18.0, y: y - 10.0, gold: o[3].as_f64().unwrap_or(0.0), taken: false });
                let ogre = world.ids.ogre;
                let sq = world.spawn_squad(n_owner, ogre, 0, x - 8.0, y + 6.0, n);
                let q = &mut world.squads[sq as usize];
                q.home = Home::Pos(x - 8.0, y + 6.0);
                q.order = Order::Guard;
            }
        }
        // 开局每座有归属的据点带一队步兵驻守
        for si in 0..world.structs.len() {
            let (owner, level, x, y, r) = { let s = &world.structs[si]; (s.owner, s.level, s.x, s.y, s.r) };
            if owner == NONE {
                continue;
            }
            let foot = world.ids.foot;
            let sq = world.spawn_squad(owner, foot, level as u8, x, y + r + 12.0, 0);
            world.enter_struct(sq, si as u32);
        }
        // 敌方据点再多一队远程
        let diff_index = opts["diffIndex"].as_f64().unwrap_or(0.0);
        for si in 0..world.structs.len() {
            let (owner, level, x, y, r, typ) = { let s = &world.structs[si]; (s.owner, s.level, s.x, s.y, s.r, s.typ) };
            if owner == NONE || owner == 0 || owner == n_owner {
                continue;
            }
            if diff_index >= 3.0 || typ == world.ids.castle {
                let rec = &world.d.structs[typ].recruit;
                let t = if rec.contains(&(world.ids.archer as usize)) { world.ids.archer } else if rec.contains(&(world.ids.mage as usize)) { world.ids.mage } else { world.ids.foot };
                let sq = world.spawn_squad(owner, t, level as u8, x, y + r + 12.0, 0);
                world.enter_struct(sq, si as u32);
            }
        }
        world.recount();
        let mana = init["bench"]["mana"].as_f64().unwrap_or(150.0);
        for o in world.owners.iter_mut() {
            o.mana = mana;
        }
        Ok(world)
    }

    fn make_struct(&mut self, typ: usize, x: f64, y: f64, owner: u8, level: u32) -> Struct {
        let max_hp = self.struct_max_hp(typ, level, owner);
        let id = self.next_id;
        self.next_id += 1;
        Struct {
            id,
            typ,
            x,
            y,
            r: self.d.structs[typ].radius,
            owner,
            level,
            max_hp,
            hp: if owner != NONE { max_hp } else { 0.0 },
            ruined: owner == NONE,
            rebuild: 0.0,
            rebuilder: NONE,
            addons: [0; 3],
            queue: Vec::new(),
            garrison: Vec::new(),
            shot_cd: 1.0,
            last_hit: -99.0,
            hit_flash: 0.0,
        }
    }

    pub fn struct_max_hp(&self, typ: usize, level: u32, owner: u8) -> f64 {
        let walls = if owner != NONE { self.owners[owner as usize].tech[self.ids.walls] } else { 0 };
        self.d.structs[typ].hp * (1.0 + 0.4 * level as f64) * (1.0 + 0.15 * walls as f64)
    }

    // ---------- 数值 ----------
    #[inline]
    pub fn stat_idx(&self, owner: u8, typ: u8, tier: u8) -> u32 {
        ((owner as usize * self.d.unit_types.len() + typ as usize) * 3 + tier as usize) as u32
    }

    fn compute_stats(&self, owner: u8, typ: u8, tier: u8) -> Stats {
        let o = &self.owners[owner as usize];
        let base = &self.d.units[typ as usize];
        let fm = &self.d.fac_unit[o.faction][typ as usize];
        let t = self.d.tier.get(tier as usize).copied().unwrap_or(self.d.tier[0]);
        let tierf = tier as f64;
        // 压力测试里敕令全为 0，所以敕令那几项系数都是 1
        Stats {
            typ,
            size: base.size,
            hp: base.hp * fm.hp * t.0 * 1.0 * (1.0 + 0.08 * o.tech[self.ids.plate] as f64),
            dmg: base.dmg * fm.dmg * t.1 * 1.0 * (1.0 + 0.08 * o.tech[self.ids.forge] as f64),
            cd: base.cd * fm.cd,
            range: base.range * fm.range,
            min_range: base.min_range,
            speed: base.speed * fm.speed * (1.0 + 0.06 * o.tech[self.ids.roads] as f64),
            armor: base.armor,
            dmg_type: base.dmg_type,
            proj: base.proj,
            splash: base.splash * fm.splash,
            charge: base.charge,
            aggro: base.aggro,
            has_resist: fm.resist.is_some(),
            resist: fm.resist.unwrap_or([0.0; 5]),
            slow_hit: fm.slow_hit,
            heal_aura: fm.heal_aura,
            gold: (base.gold * fm.gold * (1.0 + 0.35 * tierf) * 1.0 + 0.5).floor(),
            train: base.train * (1.0 + 0.2 * tierf),
            summon: base.summon,
            big: base.big,
            wide: base.wide,
        }
    }

    pub fn stats(&mut self, owner: u8, typ: u8, tier: u8) -> u32 {
        let i = self.stat_idx(owner, typ, tier);
        if self.stats[i as usize].is_none() {
            self.stats[i as usize] = Some(self.compute_stats(owner, typ, tier));
        }
        i
    }

    #[inline]
    pub fn st(&self, i: u32) -> Stats {
        self.stats[i as usize].unwrap_or_default()
    }

    // ---------- 士兵 / 部队的存取 ----------
    #[inline]
    pub fn unit_ref(&self, i: u32) -> Tgt {
        Tgt::Unit(i, self.units[i as usize].gen)
    }

    /// 引用还指向“那个士兵”吗（可能已经死了，但槽位还没被别人占用）
    #[inline]
    pub fn same_unit(&self, t: Tgt) -> Option<u32> {
        match t {
            Tgt::Unit(i, g) if self.units[i as usize].gen == g => Some(i),
            _ => None,
        }
    }

    /// 引用指向一个活着的士兵
    #[inline]
    pub fn live_unit(&self, t: Tgt) -> Option<u32> {
        self.same_unit(t).filter(|&i| !self.units[i as usize].dead)
    }

    fn alloc_unit(&mut self, u: Unit) -> u32 {
        if let Some(i) = self.free.pop() {
            let gen = self.units[i as usize].gen.wrapping_add(1);
            self.units[i as usize] = u;
            self.units[i as usize].gen = gen;
            i
        } else {
            self.units.push(u);
            (self.units.len() - 1) as u32
        }
    }

    pub fn spawn_squad(&mut self, owner: u8, typ: u8, tier: u8, x: f64, y: f64, count: usize) -> u32 {
        let sti = self.stats(owner, typ, tier);
        let st = self.st(sti);
        let n = if count > 0 { count } else { st.size };
        let id = self.next_id;
        self.next_id += 1;
        let scan = self.rng.next() * 0.2;
        let mut units = Vec::with_capacity(n);
        for i in 0..n {
            let a = (i as f64 / n as f64) * std::f64::consts::PI * 2.0;
            let rr = if n > 1 { 6.0 + (i % 3) as f64 * 3.0 } else { 0.0 };
            let sx = x + a.jcos() * rr;
            let sy = y + a.jsin() * rr;
            let cd = self.rng.next() * st.cd;
            let retarget = self.rng.next() * 0.3;
            let step = self.rng.next() * 6.0;
            let u = Unit {
                gen: 0,
                owner,
                typ,
                st: sti,
                x: sx,
                y: sy,
                px: sx,
                py: sy,
                hp: st.hp,
                max: st.hp,
                cd,
                tgt: Tgt::None,
                retarget,
                face: 1,
                run: 0.0,
                atk: 0.0,
                dead: false,
                slow_t: 0.0,
                slow_a: 0.0,
                stun: 0.0,
                i: i as u32,
                moving: false,
                lust: false,
                frost_slow: 1.0,
                vuln: 1.0,
                step,
                blocked: 0,
                path: None,
                path_t: 0.0,
                rad: if st.big { 15.0 } else if st.wide { 11.0 } else { 7.0 },
                fx: sx,
                fy: sy,
                hit_t: 0.0,
            };
            units.push(self.alloc_unit(u));
        }
        let sq = Squad {
            live: true,
            id,
            owner,
            typ,
            tier,
            st: sti,
            x,
            y,
            heading: std::f64::consts::PI / 2.0,
            path: VecDeque::new(),
            goal: None,
            order: Order::Idle,
            target: None,
            inside: None,
            fighting: false,
            scan,
            engaged: Tgt::None,
            units,
            home: Home::None,
            quiet_t: 0.0,
            until: 0.0,
            stuck: 0,
            sieging: None,
            last: None,
            wave_id: None,
        };
        let slot = if let Some(i) = self.sq_free.pop() {
            self.squads[i as usize] = sq;
            i
        } else {
            self.squads.push(sq);
            (self.squads.len() - 1) as u32
        };
        self.order.push(slot);
        slot
    }

    // ---------- 地形 ----------
    #[inline]
    pub fn blocked_at(&self, x: f64, y: f64) -> bool {
        let c = (x / self.d.tile).floor();
        let r = (y / self.d.tile).floor();
        if c < 0.0 || r < 0.0 || c >= self.cols as f64 || r >= self.rows as f64 {
            return true;
        }
        self.blocked[r as usize * self.cols + c as usize] == 1
    }

    pub fn line_clear(&self, x0: f64, y0: f64, x1: f64, y1: f64) -> bool {
        let d = (x1 - x0).jhypot(y1 - y0);
        let n = (d / 8.0).ceil() as i64;
        for i in 1..=n {
            let t = i as f64 / n as f64;
            let x = x0 + (x1 - x0) * t;
            let y = y0 + (y1 - y0) * t;
            if self.blocked_at(x, y) || self.blocked_at(x + 6.0, y) || self.blocked_at(x - 6.0, y) || self.blocked_at(x, y + 6.0) || self.blocked_at(x, y - 6.0) {
                return false;
            }
        }
        true
    }

    // ---------- 空间哈希查询 ----------
    pub fn nearest_hostile(&self, x: f64, y: f64, owner: u8, radius: f64) -> Option<u32> {
        let hc = self.hc as i32;
        let hr = self.hr as i32;
        let mut best = None;
        let mut bd = radius * radius;
        let x0 = (((x - radius) / CELL) as i32).max(0);
        let x1 = (((x + radius) / CELL) as i32).min(hc - 1);
        let y0 = (((y - radius) / CELL) as i32).max(0);
        let y1 = (((y + radius) / CELL) as i32).min(hr - 1);
        for cy in y0..=y1 {
            for cx in x0..=x1 {
                for &i in &self.hash[(cy * hc + cx) as usize] {
                    let o = &self.units[i as usize];
                    if o.owner == owner || o.dead {
                        continue;
                    }
                    let dx = o.x - x;
                    let dy = o.y - y;
                    let d = dx * dx + dy * dy;
                    if d < bd {
                        bd = d;
                        best = Some(i);
                    }
                }
            }
        }
        best
    }

    /// 半径内所有活着的士兵，写进 out（对应 JS 的 forEachInRadius；回调只改被访问的那个士兵，
    /// 所以先收集再处理和边遍历边处理结果一样）
    pub fn in_radius(&self, x: f64, y: f64, radius: f64, out: &mut Vec<u32>) {
        out.clear();
        let hc = self.hc as i32;
        let hr = self.hr as i32;
        let x0 = (((x - radius) / CELL) as i32).max(0);
        let x1 = (((x + radius) / CELL) as i32).min(hc - 1);
        let y0 = (((y - radius) / CELL) as i32).max(0);
        let y1 = (((y + radius) / CELL) as i32).min(hr - 1);
        let r2 = radius * radius;
        for cy in y0..=y1 {
            for cx in x0..=x1 {
                for &i in &self.hash[(cy * hc + cx) as usize] {
                    let o = &self.units[i as usize];
                    if o.dead {
                        continue;
                    }
                    let dx = o.x - x;
                    let dy = o.y - y;
                    if dx * dx + dy * dy <= r2 {
                        out.push(i);
                    }
                }
            }
        }
    }

    // ---------- 事件 / 特效 ----------
    #[inline]
    pub fn ev(&mut self, e: u8, owner: u8, sub: u8, x: f64, y: f64, extra: f64) {
        if self.events.len() < 20000 {
            self.events.push(Ev { e, owner, sub, face: false, x: x as f32, y: y as f32, extra: extra as f32 });
        }
    }

    #[inline]
    pub fn fx(&mut self, k: u8, faction: u8, x: f64, y: f64, r: f64, life: f64) {
        if self.new_fx.len() < 2000 {
            self.new_fx.push(Fx { k, faction, x: x as f32, y: y as f32, r: r as f32, t: self.t as f32, life: life as f32 });
        }
    }

    // ---------- 伤害 ----------
    pub fn hurt_unit(&mut self, ui: u32, amount: f64, dtype: usize, slow_hit: f64) {
        let (armor, has_resist, resist) = {
            let u = &self.units[ui as usize];
            if u.dead {
                return;
            }
            let st = self.stats[u.st as usize].as_ref().unwrap();
            (st.armor, st.has_resist, st.resist[dtype])
        };
        let mut m = self.d.dmg[dtype][armor];
        if has_resist && resist != 0.0 {
            m *= resist;
        }
        let u = &mut self.units[ui as usize];
        u.hp -= (amount * m * u.vuln).max(0.5);
        u.hit_t = 0.12;
        if slow_hit != 0.0 {
            u.slow_t = 1.6;
            u.slow_a = u.slow_a.max(slow_hit);
        }
        if u.hp <= 0.0 {
            self.kill_unit(ui);
        }
    }

    fn kill_unit(&mut self, ui: u32) {
        let u = &mut self.units[ui as usize];
        u.dead = true;
        u.hp = 0.0;
        let (x, y, typ, owner, face) = (u.x, u.y, u.typ, u.owner, u.face);
        if self.events.len() < 20000 {
            self.events.push(Ev { e: EV_DIE, owner, sub: typ, face: face > 0, x: x as f32, y: y as f32, extra: 0.0 });
        }
    }

    /// 压力测试里据点打不坏：只记“刚挨过打”
    pub fn hurt_struct(&mut self, si: u32, src_owner: u8) {
        let t = self.t;
        let st = &mut self.structs[si as usize];
        if st.ruined || st.owner == NONE || st.owner == src_owner {
            return;
        }
        st.last_hit = t;
        st.hit_flash = 0.12;
    }

    // ---------- 进出据点 ----------
    /// 城两侧的待命位：左右各三格，挑人最少的
    pub fn stand_spot(&self, si: u32) -> (f64, f64) {
        let st = &self.structs[si as usize];
        let mut best = (0.0, 0.0);
        let mut bn = f64::INFINITY;
        let mut first = true;
        for side in [1.0, -1.0] {
            for dy in [-6.0, 16.0, -28.0] {
                let sp = (st.x + side * (st.r + 46.0), st.y + dy);
                if first {
                    best = sp;
                    first = false;
                }
                let mut n = 0.0;
                for &qi in &self.order {
                    let q = &self.squads[qi as usize];
                    if q.owner == st.owner && q.inside.is_none() && (q.x - sp.0).jhypot(q.y - sp.1) < 18.0 {
                        n += 1.0;
                    }
                }
                if self.blocked_at(sp.0, sp.1) {
                    n += 5.0;
                }
                if n < bn {
                    bn = n;
                    best = sp;
                }
            }
        }
        best
    }

    fn place_around(&mut self, sq: u32, si: u32) {
        let (sx, sy, sr) = { let s = &self.structs[si as usize]; (s.x, s.y, s.r) };
        let id = self.squads[sq as usize].id;
        let mut k = 0usize;
        for j in 0..self.squads[sq as usize].units.len() {
            let ui = self.squads[sq as usize].units[j];
            let u = &mut self.units[ui as usize];
            if u.dead {
                continue;
            }
            let a = k as f64 * 2.4 + id as f64;
            let r = sr + 8.0 + (k % 3) as f64 * 6.0;
            u.x = sx + a.jcos() * r;
            u.px = u.x;
            u.y = sy + a.jsin() * r * 0.7 + 10.0;
            u.py = u.y;
            k += 1;
        }
        let q = &mut self.squads[sq as usize];
        q.x = sx + (if id % 2 != 0 { 1.0 } else { -1.0 }) * (sr + 20.0);
        q.y = sy + 6.0;
        q.path.clear();
    }

    pub fn enter_struct(&mut self, sq: u32, si: u32) -> bool {
        if self.structs[si as usize].garrison.len() >= self.d.garrison_max {
            return false;
        }
        let (sx, sy) = { let s = &self.structs[si as usize]; (s.x, s.y) };
        {
            let q = &mut self.squads[sq as usize];
            q.inside = Some(si);
            q.path.clear();
            q.goal = None;
            q.order = Order::Garrison;
            q.fighting = false;
            q.home = Home::Struct(si);
            q.x = sx;
            q.y = sy;
        }
        for j in 0..self.squads[sq as usize].units.len() {
            let ui = self.squads[sq as usize].units[j];
            let u = &mut self.units[ui as usize];
            u.x = sx;
            u.px = sx;
            u.y = sy;
            u.py = sy;
            u.tgt = Tgt::None;
        }
        self.structs[si as usize].garrison.push(sq);
        true
    }

    pub fn exit_struct(&mut self, sq: u32) {
        if let Some(si) = self.squads[sq as usize].inside.take() {
            self.structs[si as usize].garrison.retain(|&g| g != sq);
            self.place_around(sq, si);
        }
    }

    // ---------- 命令 ----------
    pub fn set_path(&mut self, sq: u32, gx: f64, gy: f64) {
        let (x, y) = { let q = &self.squads[sq as usize]; (q.x, q.y) };
        let p = self.find_path(x, y, gx, gy);
        let q = &mut self.squads[sq as usize];
        q.goal = Some((gx, gy));
        q.path = p.map(VecDeque::from).unwrap_or_default();
        if let Some(&(px, py)) = q.path.front() {
            q.heading = (py - q.y).jatan2(px - q.x);
        }
    }

    pub fn order_move(&mut self, squads: &[u32], x: f64, y: f64) {
        let list: Vec<u32> = squads.iter().copied().filter(|&s| !self.squads[s as usize].units.is_empty()).collect();
        let len = list.len() as f64;
        let cols = len.sqrt().ceil();
        for (i, &sq) in list.iter().enumerate() {
            if self.squads[sq as usize].inside.is_some() {
                self.exit_struct(sq);
            }
            let i = i as f64;
            let ox = ((i % cols) - (cols - 1.0) / 2.0) * 34.0;
            let oy = ((i / cols).floor() - ((len / cols).ceil() - 1.0) / 2.0) * 30.0;
            let q = &mut self.squads[sq as usize];
            q.order = Order::Move;
            q.target = None;
            q.home = Home::None;
            self.set_path(sq, x + ox, y + oy);
        }
    }

    pub fn order_struct(&mut self, squads: &[u32], si: u32) {
        let len = squads.len() as f64;
        for (i, &sq) in squads.iter().enumerate() {
            if self.squads[sq as usize].units.is_empty() || self.squads[sq as usize].inside == Some(si) {
                continue;
            }
            if self.squads[sq as usize].inside.is_some() {
                self.exit_struct(sq);
            }
            let (sx, sy, sr, sowner, sruined) = { let s = &self.structs[si as usize]; (s.x, s.y, s.r, s.owner, s.ruined) };
            let range = self.st(self.squads[sq as usize].st).range;
            let q = &mut self.squads[sq as usize];
            q.target = Some(si);
            q.home = Home::None;
            q.order = if sowner == q.owner && !sruined { Order::Enter } else if sruined { Order::Rebuild } else { Order::Attack };
            let a = (q.y - sy).jatan2(q.x - sx) + (i as f64 - (len - 1.0) / 2.0) * 0.35;
            let dist = if q.order == Order::Attack { (sr + 4.0).max((range * 0.9 + sr).min(sr + 160.0)) } else { 6.0 };
            self.set_path(sq, sx + a.jcos() * dist, sy + a.jsin() * dist * 0.85);
        }
    }

    // ---------- 经济 ----------
    pub fn recount(&mut self) {
        for o in self.owners.iter_mut() {
            o.supply = 0.0;
            o.used = 0.0;
            o.towers = 0;
            o.structs = 0;
        }
        for st in &self.structs {
            if st.owner == NONE || st.ruined {
                continue;
            }
            let o = &mut self.owners[st.owner as usize];
            o.supply += self.d.structs[st.typ].supply;
            o.structs += 1;
            if st.typ == self.ids.tower {
                o.towers += 1;
            }
            for &a in &st.addons {
                if a != 0 {
                    o.supply += self.d.addons[a as usize - 1].supply;
                }
            }
            o.used += st.queue.len() as f64;
        }
        for &qi in &self.order {
            let q = &self.squads[qi as usize];
            if q.owner == self.n_owner || q.units.is_empty() || self.stats[q.st as usize].map(|s| s.summon).unwrap_or(false) {
                continue;
            }
            self.owners[q.owner as usize].used += 1.0;
        }
        // 电脑对手的部队上限按难度封顶（压力测试里 army = 0，不封顶）
        if self.d.diff.army != 0.0 {
            let cap = self.d.diff.army + (self.t / 150.0).floor();
            for &id in &self.foe_ids {
                let o = &mut self.owners[id as usize];
                if o.ai {
                    o.supply = o.supply.min(cap);
                }
            }
        }
    }

    pub fn can_recruit(&mut self, owner: u8, si: u32, typ: u8) -> bool {
        let (sowner, ruined, styp, level, qlen) = { let s = &self.structs[si as usize]; (s.owner, s.ruined, s.typ, s.level, s.queue.len()) };
        if sowner != owner || ruined {
            return false;
        }
        if !self.d.structs[styp].recruit.contains(&(typ as usize)) {
            return false;
        }
        let req = self.d.units[typ as usize].req;
        if req != 0 && level < req {
            return false;
        }
        let s = self.stats(owner, typ, level as u8);
        let gold = self.st(s).gold;
        let o = &self.owners[owner as usize];
        qlen < 3 && o.used < o.supply && o.gold >= gold
    }

    pub fn recruit(&mut self, owner: u8, si: u32, typ: u8) -> bool {
        if !self.can_recruit(owner, si, typ) {
            return false;
        }
        let level = self.structs[si as usize].level as u8;
        let sti = self.stats(owner, typ, level);
        let s = self.st(sti);
        self.owners[owner as usize].gold -= s.gold;
        self.structs[si as usize].queue.push(QItem { typ, tier: level, t: 0.0, total: s.train });
        self.recount();
        let (x, y) = (self.structs[si as usize].x, self.structs[si as usize].y);
        self.ev(EV_QUEUE, owner, 0, x, y, 0.0);
        true
    }

    pub fn upgrade_cost(&self, si: u32) -> Option<f64> {
        let st = &self.structs[si as usize];
        self.d.structs[st.typ].upgrade.get(st.level as usize).copied()
    }

    pub fn upgrade(&mut self, owner: u8, si: u32) -> bool {
        let cost = match self.upgrade_cost(si) {
            Some(c) => c,
            None => return false,
        };
        let (sowner, ruined) = (self.structs[si as usize].owner, self.structs[si as usize].ruined);
        if sowner != owner || ruined || self.owners[owner as usize].gold < cost {
            return false;
        }
        self.owners[owner as usize].gold -= cost;
        let (typ, level) = (self.structs[si as usize].typ, self.structs[si as usize].level + 1);
        let max_hp = self.struct_max_hp(typ, level, owner);
        let st = &mut self.structs[si as usize];
        let old = st.max_hp;
        st.level = level;
        st.max_hp = max_hp;
        st.hp += max_hp - old;
        let (x, y) = (st.x, st.y);
        self.ev(EV_UPGRADE, owner, 0, x, y, 0.0);
        true
    }

    pub fn addon_cost(&self, kind: u8) -> f64 {
        (self.d.addons[kind as usize - 1].gold + 0.5).floor()
    }

    pub fn build(&mut self, owner: u8, si: u32, slot: usize, kind: u8) -> bool {
        let cost = self.addon_cost(kind);
        let st = &self.structs[si as usize];
        if st.owner != owner || st.ruined || st.addons[slot] != 0 || self.owners[owner as usize].gold < cost {
            return false;
        }
        self.owners[owner as usize].gold -= cost;
        self.structs[si as usize].addons[slot] = kind;
        self.recount();
        let (x, y) = (self.structs[si as usize].x + self.d.slot_offsets[slot].0, self.structs[si as usize].y + self.d.slot_offsets[slot].1);
        self.ev(EV_BUILD, owner, 0, x, y, 0.0);
        true
    }

    /// 科技：花金币立刻生效，已有的部队和据点也吃到加成
    pub fn research(&mut self, owner: u8, tech: usize) -> bool {
        let lv = self.owners[owner as usize].tech[tech] as usize;
        let cost = match self.d.tech_cost[tech].get(lv) {
            Some(&c) => c,
            None => return false,
        };
        if self.owners[owner as usize].gold < cost {
            return false;
        }
        self.owners[owner as usize].gold -= cost;
        self.owners[owner as usize].tech[tech] = lv as u32 + 1;
        // 这一家的数值表整体重算；已有部队按新旧生命值之比缩放
        let nt = self.d.unit_types.len();
        let base = owner as usize * nt * 3;
        let old: Vec<Option<f64>> = (0..nt * 3).map(|k| self.stats[base + k].map(|s| s.hp)).collect();
        for k in 0..nt * 3 {
            if self.stats[base + k].is_some() {
                self.stats[base + k] = Some(self.compute_stats(owner, (k / 3) as u8, (k % 3) as u8));
            }
        }
        for qi in 0..self.order.len() {
            let sq = self.order[qi] as usize;
            if self.squads[sq].owner != owner {
                continue;
            }
            let sti = self.squads[sq].st as usize;
            let k = match (self.stats[sti], old[sti - base]) {
                (Some(ns), Some(oh)) => ns.hp / oh,
                _ => 1.0,
            };
            for j in 0..self.squads[sq].units.len() {
                let u = &mut self.units[self.squads[sq].units[j] as usize];
                u.hp *= k;
                u.max *= k;
            }
        }
        if tech == self.ids.walls {
            for si in 0..self.structs.len() {
                if self.structs[si].owner != owner || self.structs[si].ruined {
                    continue;
                }
                let max_hp = self.struct_max_hp(self.structs[si].typ, self.structs[si].level, owner);
                let st = &mut self.structs[si];
                let old = st.max_hp;
                st.max_hp = max_hp;
                st.hp += max_hp - old;
            }
        }
        self.ev(EV_TECH, owner, tech as u8, 0.0, 0.0, 0.0);
        true
    }

    // ---------- 法术 ----------
    pub fn can_cast(&self, owner: u8, key: usize) -> bool {
        let o = &self.owners[owner as usize];
        let sp = &self.d.spells[key];
        !(o.cds[key] > self.t) && !(sp.needs_tower && o.towers == 0) && o.mana >= sp.mana
    }

    pub fn cast(&mut self, owner: u8, key: usize, x: f64, y: f64) -> bool {
        if !self.can_cast(owner, key) {
            return false;
        }
        let sp = self.d.spells[key].clone();
        let pow = 1.0;
        let faction = self.owners[owner as usize].faction as u8;
        {
            let t = self.t;
            let o = &mut self.owners[owner as usize];
            o.mana -= sp.mana;
            o.cds[key] = t + sp.cd;
        }
        self.ev(EV_CAST, owner, key as u8, x, y, 0.0);
        self.fx(FX_CAST, faction + 1, x, y, if sp.radius != 0.0 { sp.radius } else { 50.0 }, 0.7);
        let mut list = std::mem::take(&mut self.scratch);
        if sp.burst != 0.0 {
            self.in_radius(x, y, sp.radius, &mut list);
            for &ui in &list {
                let u = &mut self.units[ui as usize];
                if u.owner == owner {
                    u.hp = u.max.min(u.hp + sp.burst * pow);
                }
            }
        }
        if sp.kind == KIND_BANNER || sp.kind == KIND_AREA {
            self.effects.push(Effect { key, kind: sp.kind, owner, x, y, r: sp.radius, until: self.t + sp.dur, start: self.t, pow });
        } else if sp.kind == KIND_STRIKE {
            self.fx(16 + key as u8, 0, x, y, sp.radius, 0.9);
            self.in_radius(x, y, sp.radius, &mut list);
            for &ui in &list {
                if self.units[ui as usize].owner == owner {
                    continue;
                }
                self.hurt_unit(ui, sp.power * pow, DMG_MAGIC, 0.0);
                if sp.stun != 0.0 {
                    let u = &mut self.units[ui as usize];
                    u.stun = u.stun.max(sp.stun);
                }
            }
            for si in 0..self.structs.len() {
                let s = &self.structs[si];
                if (s.x - x).jhypot(s.y - y) < sp.radius + s.r {
                    self.hurt_struct(si as u32, owner);
                }
            }
        } else {
            for i in 0..sp.count {
                let sx = x + (i as f64 - (sp.count as f64 - 1.0) / 2.0) * 30.0;
                let sq = self.spawn_squad(owner, sp.unit as u8, 0, sx, y, if sp.squad > 0 { sp.squad } else { 1 });
                let q = &mut self.squads[sq as usize];
                q.until = self.t + sp.dur;
                q.order = Order::Idle;
            }
            self.fx(16 + key as u8, 0, x, y, 40.0, 1.2);
        }
        self.scratch = list;
        true
    }
}
