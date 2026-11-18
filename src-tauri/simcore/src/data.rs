//! 规则表：从页面导出的初始化数据（game/js/benchcore.js 的 benchInit）里读出来，
//! 所以数值只有 game/js/data.js 一份，不会两边各写一套。

use serde_json::Value;

pub const DMG_TYPES: [&str; 5] = ["normal", "pierce", "cleave", "siege", "magic"];
pub const ARMORS: [&str; 6] = ["light", "heavy", "mounted", "machine", "beast", "fort"];
pub const PROJ_KINDS: [&str; 3] = ["arrow", "stone", "bolt"];
pub const ARMOR_FORT: usize = 5;
pub const DMG_MAGIC: usize = 4;
pub const DMG_PIERCE: usize = 1;

#[derive(Clone, Default)]
pub struct UnitDef {
    pub size: usize,
    pub hp: f64,
    pub dmg: f64,
    pub cd: f64,
    pub range: f64,
    pub min_range: f64,
    pub speed: f64,
    pub armor: usize,
    pub dmg_type: usize,
    pub gold: f64,
    pub train: f64,
    pub aggro: f64,
    /// 0 = 近战，1 arrow，2 stone，3 bolt
    pub proj: u8,
    pub splash: f64,
    pub charge: f64,
    pub req: u32,
    pub summon: bool,
    pub big: bool,
    pub wide: bool,
}

#[derive(Clone)]
pub struct FacUnit {
    pub hp: f64,
    pub dmg: f64,
    pub cd: f64,
    pub range: f64,
    pub speed: f64,
    pub splash: f64,
    pub gold: f64,
    pub resist: Option<[f64; 5]>,
    pub slow_hit: f64,
    pub heal_aura: f64,
}

impl Default for FacUnit {
    fn default() -> Self {
        FacUnit { hp: 1.0, dmg: 1.0, cd: 1.0, range: 1.0, speed: 1.0, splash: 1.0, gold: 1.0, resist: None, slow_hit: 0.0, heal_aura: 0.0 }
    }
}

#[derive(Clone, Default)]
pub struct StructDef {
    pub hp: f64,
    pub gold: f64,
    pub mana: f64,
    pub supply: f64,
    pub radius: f64,
    pub recruit: Vec<usize>,
    pub upgrade: Vec<f64>,
    pub shot: f64,
    pub shot_cd: f64,
    pub shot_r: f64,
}

#[derive(Clone, Default)]
pub struct AddonDef {
    pub gold: f64,
    pub inc_gold: f64,
    pub inc_mana: f64,
    pub has_income: bool,
    pub supply: f64,
}

pub const KIND_BANNER: u8 = 0;
pub const KIND_STRIKE: u8 = 1;
pub const KIND_AREA: u8 = 2;
pub const KIND_SUMMON: u8 = 3;
pub const FX_NONE: u8 = 0;
pub const FX_HEAL: u8 = 1;
pub const FX_LUST: u8 = 2;
pub const FX_FROST: u8 = 3;

#[derive(Clone, Default)]
pub struct SpellDef {
    pub kind: u8,
    pub fx: u8,
    pub mana: f64,
    pub cd: f64,
    pub radius: f64,
    pub dur: f64,
    pub power: f64,
    pub burst: f64,
    pub stun: f64,
    pub fort: f64,
    pub haste: f64,
    pub vuln: f64,
    pub slow: f64,
    pub unit: usize,
    pub count: usize,
    pub squad: usize,
    pub needs_tower: bool,
}

#[derive(Clone, Default)]
pub struct Diff {
    pub army: f64,
    pub start: f64,
    pub wave: f64,
    pub income: f64,
    pub think: f64,
    pub gold: f64,
}

pub struct Data {
    pub tile: f64,
    pub step: f64,
    pub mapk: f64,
    pub garrison_max: usize,
    pub mana_cap: f64,
    pub mana_base: f64,
    pub unit_types: Vec<String>,
    pub struct_types: Vec<String>,
    pub addon_kinds: Vec<String>,
    pub spell_keys: Vec<String>,
    pub tech_ids: Vec<String>,
    pub factions: Vec<String>,
    pub owner_ids: Vec<String>,
    pub units: Vec<UnitDef>,
    /// [势力][兵种]
    pub fac_unit: Vec<Vec<FacUnit>>,
    pub tier: Vec<(f64, f64)>,
    pub structs: Vec<StructDef>,
    pub addons: Vec<AddonDef>,
    pub spells: Vec<SpellDef>,
    pub tech_cost: Vec<Vec<f64>>,
    /// [伤害类型][护甲]
    pub dmg: [[f64; 6]; 5],
    pub faction_spells: Vec<Vec<usize>>,
    pub diff: Diff,
    pub slot_offsets: [(f64, f64); 3],
}

fn num(v: &Value, k: &str, d: f64) -> f64 {
    v.get(k).and_then(|x| x.as_f64()).unwrap_or(d)
}
fn flag(v: &Value, k: &str) -> bool {
    v.get(k).and_then(|x| x.as_bool()).unwrap_or(false)
}
fn strs(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().map(|s| s.as_str().unwrap_or("").to_string()).collect()).unwrap_or_default()
}
pub fn index_of(list: &[String], name: &str) -> Option<usize> {
    list.iter().position(|s| s == name)
}
fn index_in(list: &[&str], name: &str) -> usize {
    list.iter().position(|s| *s == name).unwrap_or(0)
}

impl Data {
    pub fn from_json(init: &Value) -> Result<Data, String> {
        let c = init.get("consts").ok_or("缺 consts")?;
        let unit_types = strs(&init["unitTypes"]);
        let struct_types = strs(&init["structTypes"]);
        let addon_kinds = strs(&init["addonKinds"]);
        let spell_keys = strs(&init["spellKeys"]);
        let tech_ids = strs(&init["techIds"]);
        let factions = strs(&init["factions"]);
        let owner_ids = strs(&init["ownerIds"]);
        if unit_types.is_empty() || struct_types.is_empty() {
            return Err("规则表是空的".into());
        }

        let units: Vec<UnitDef> = unit_types
            .iter()
            .map(|t| {
                let u = &init["UNITS"][t.as_str()];
                UnitDef {
                    size: num(u, "size", 1.0) as usize,
                    hp: num(u, "hp", 1.0),
                    dmg: num(u, "dmg", 0.0),
                    cd: num(u, "cd", 1.0),
                    range: num(u, "range", 0.0),
                    min_range: num(u, "minRange", 0.0),
                    speed: num(u, "speed", 0.0),
                    armor: index_in(&ARMORS, u["armor"].as_str().unwrap_or("light")),
                    dmg_type: index_in(&DMG_TYPES, u["dmgType"].as_str().unwrap_or("normal")),
                    gold: num(u, "gold", 0.0),
                    train: num(u, "train", 0.0),
                    aggro: num(u, "aggro", 0.0),
                    proj: u.get("proj").and_then(|p| p.as_str()).map(|p| index_in(&PROJ_KINDS, p) as u8 + 1).unwrap_or(0),
                    splash: num(u, "splash", 0.0),
                    charge: num(u, "charge", 0.0),
                    req: num(u, "req", 0.0) as u32,
                    summon: flag(u, "summon"),
                    big: flag(u, "big"),
                    wide: flag(u, "wide"),
                }
            })
            .collect();

        let fac_unit: Vec<Vec<FacUnit>> = factions
            .iter()
            .map(|f| {
                unit_types
                    .iter()
                    .map(|t| {
                        let m = &init["FACTION_UNIT"][f.as_str()][t.as_str()];
                        if !m.is_object() {
                            return FacUnit::default();
                        }
                        let resist = m.get("resist").and_then(|r| r.as_object()).map(|r| {
                            let mut a = [0.0; 5];
                            for (k, v) in r {
                                a[index_in(&DMG_TYPES, k)] = v.as_f64().unwrap_or(0.0);
                            }
                            a
                        });
                        FacUnit {
                            hp: num(m, "hp", 1.0),
                            dmg: num(m, "dmg", 1.0),
                            cd: num(m, "cd", 1.0),
                            range: num(m, "range", 1.0),
                            speed: num(m, "speed", 1.0),
                            splash: num(m, "splash", 1.0),
                            gold: num(m, "gold", 1.0),
                            resist,
                            slow_hit: num(m, "slowHit", 0.0),
                            heal_aura: num(m, "healAura", 0.0),
                        }
                    })
                    .collect()
            })
            .collect();

        let tier = init["TIER"].as_array().ok_or("缺 TIER")?.iter().map(|t| (num(t, "hp", 1.0), num(t, "dmg", 1.0))).collect();

        let structs = struct_types
            .iter()
            .map(|t| {
                let s = &init["STRUCTS"][t.as_str()];
                StructDef {
                    hp: num(s, "hp", 1.0),
                    gold: num(s, "gold", 0.0),
                    mana: num(s, "mana", 0.0),
                    supply: num(s, "supply", 0.0),
                    radius: num(s, "radius", 20.0),
                    recruit: strs(&s["recruit"]).iter().filter_map(|r| index_of(&unit_types, r)).collect(),
                    upgrade: s["upgrade"].as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect()).unwrap_or_default(),
                    shot: num(s, "shot", 0.0),
                    shot_cd: num(s, "shotCd", 0.0),
                    shot_r: num(s, "shotR", 0.0),
                }
            })
            .collect();

        let addons = addon_kinds
            .iter()
            .map(|k| {
                let a = &init["ADDONS"][k.as_str()];
                let inc = &a["income"];
                AddonDef { gold: num(a, "gold", 0.0), inc_gold: num(inc, "gold", 0.0), inc_mana: num(inc, "mana", 0.0), has_income: inc.is_object(), supply: num(a, "supply", 0.0) }
            })
            .collect();

        let spells = spell_keys
            .iter()
            .map(|k| {
                let s = &init["SPELLS"][k.as_str()];
                SpellDef {
                    kind: match s["kind"].as_str().unwrap_or("") {
                        "banner" => KIND_BANNER,
                        "strike" => KIND_STRIKE,
                        "area" => KIND_AREA,
                        _ => KIND_SUMMON,
                    },
                    fx: match s.get("fx").and_then(|f| f.as_str()).unwrap_or("") {
                        "heal" => FX_HEAL,
                        "lust" => FX_LUST,
                        "frost" => FX_FROST,
                        _ => FX_NONE,
                    },
                    mana: num(s, "mana", 0.0),
                    cd: num(s, "cd", 0.0),
                    radius: num(s, "radius", 0.0),
                    dur: num(s, "dur", 0.0),
                    power: num(s, "power", 0.0),
                    burst: num(s, "burst", 0.0),
                    stun: num(s, "stun", 0.0),
                    fort: num(s, "fort", 0.0),
                    haste: num(s, "haste", 0.0),
                    vuln: num(s, "vuln", 0.0),
                    slow: num(s, "slow", 0.0),
                    unit: s.get("unit").and_then(|u| u.as_str()).and_then(|u| index_of(&unit_types, u)).unwrap_or(0),
                    count: num(s, "count", 0.0) as usize,
                    squad: num(s, "squad", 0.0) as usize,
                    needs_tower: s.get("needs").and_then(|n| n.as_str()) == Some("tower"),
                }
            })
            .collect();

        let tech_cost = tech_ids
            .iter()
            .map(|id| {
                init["TECHS"]
                    .as_array()
                    .and_then(|a| a.iter().find(|t| t["id"].as_str() == Some(id.as_str())))
                    .and_then(|t| t["cost"].as_array())
                    .map(|c| c.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect())
                    .unwrap_or_default()
            })
            .collect();

        let mut dmg = [[1.0; 6]; 5];
        for (i, dt) in DMG_TYPES.iter().enumerate() {
            for (j, ar) in ARMORS.iter().enumerate() {
                dmg[i][j] = num(&init["DMG"][*dt], ar, 1.0);
            }
        }

        let faction_spells = factions.iter().map(|f| strs(&init["factionSpells"][f.as_str()]).iter().filter_map(|k| index_of(&spell_keys, k)).collect()).collect();

        let d = &init["diff"];
        let diff = Diff { army: num(d, "army", 0.0), start: num(d, "start", 0.0), wave: num(d, "wave", 0.0), income: num(d, "income", 1.0), think: num(d, "think", 1.0), gold: num(d, "gold", 0.0) };

        Ok(Data {
            tile: num(c, "TILE", 20.0),
            step: num(c, "STEP", 1.0 / 30.0),
            mapk: num(c, "MAPK", 0.625),
            garrison_max: num(c, "GARRISON_MAX", 4.0) as usize,
            mana_cap: num(c, "MANA_CAP", 150.0),
            mana_base: num(c, "MANA_BASE", 0.8),
            unit_types,
            struct_types,
            addon_kinds,
            spell_keys,
            tech_ids,
            factions,
            owner_ids,
            units,
            fac_unit,
            tier,
            structs,
            addons,
            spells,
            tech_cost,
            dmg,
            faction_spells,
            diff,
            // CS.SLOT_OFFSETS：附属建筑相对据点的位置，只用来给“建造”事件定坐标
            slot_offsets: [(-54.0, 34.0), (0.0, 58.0), (54.0, 34.0)],
        })
    }
}
