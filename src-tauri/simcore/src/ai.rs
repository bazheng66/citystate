//! 电脑对手（game/js/ai.js）和压力测试的补兵（game/js/benchcore.js 的 benchSpawn）。

use crate::data::*;
use crate::jsmath::JsMath;
use crate::world::*;

/// ai.js 的 LIKES：各势力对兵种的偏好，顺序 foot / archer / cav / siege / mage / guard
fn likes(faction: &str) -> [f64; 6] {
    match faction {
        "duchy" => [1.2, 1.15, 1.0, 1.0, 1.0, 1.1],
        "horde" => [1.15, 0.85, 1.3, 1.1, 0.9, 1.1],
        "cult" => [0.9, 1.2, 0.9, 1.0, 1.35, 0.9],
        "sylvan" => [0.95, 1.35, 1.2, 0.9, 1.05, 0.9],
        "grave" => [1.35, 0.95, 0.95, 1.0, 1.15, 1.2],
        _ => [1.0; 6],
    }
}

impl World {
    /// 把兵种下标映射到 0..6（foot / archer / cav / siege / mage / guard），其余返回 None
    fn mix_slot(&self, typ: u8) -> Option<usize> {
        let i = &self.ids;
        if typ == i.foot {
            Some(0)
        } else if typ == i.archer {
            Some(1)
        } else if typ == i.cav {
            Some(2)
        } else if typ == i.siege {
            Some(3)
        } else if typ == i.mage {
            Some(4)
        } else if typ == i.guard {
            Some(5)
        } else {
            None
        }
    }

    fn busy(&self, sq: u32) -> bool {
        let q = &self.squads[sq as usize];
        q.order == Order::Rebuild || q.order == Order::Attack || q.order == Order::Enter || q.fighting
    }

    pub fn ai_tick(&mut self) {
        if self.tick % 30 != 15 {
            return;
        }
        for id in 0..self.owners.len() {
            if self.owners[id].ai && !self.owners[id].neutral {
                self.think(id as u8);
            }
        }
    }

    fn think(&mut self, id: u8) {
        let o_i = id as usize;
        if !self.owners[o_i].alive || self.owners[o_i].neutral {
            return;
        }
        self.owners[o_i].ai_t -= 1.0;
        if self.owners[o_i].ai_t > 0.0 {
            return;
        }
        let think = if id == 0 { 1.0 } else { self.d.diff.think };
        self.owners[o_i].ai_t = ((think * 2.0 + 0.5).floor()).max(1.0);
        let dk = self.d.mapk;
        let n_owner = self.n_owner;
        let mine: Vec<u32> = (0..self.structs.len() as u32).filter(|&s| self.structs[s as usize].owner == id && !self.structs[s as usize].ruined).collect();
        let field: Vec<u32> = self
            .order
            .iter()
            .copied()
            .filter(|&q| {
                let sq = &self.squads[q as usize];
                sq.owner == id && sq.inside.is_none() && !sq.units.is_empty() && !self.stats[sq.st as usize].map(|s| s.summon).unwrap_or(false)
            })
            .collect();
        let hostile_strong = self.structs.iter().any(|s| s.owner != NONE && s.owner != id && !s.ruined && (s.typ == self.ids.castle || s.level > 0));
        let mut list = std::mem::take(&mut self.scratch);

        // 1. 防守
        for &si in &mine {
            let (sx, sy, sr) = { let s = &self.structs[si as usize]; (s.x, s.y, s.r) };
            self.in_radius(sx, sy, 220.0 * dk, &mut list);
            let threat = list.iter().filter(|&&u| { let o = self.units[u as usize].owner; o != id && o != n_owner }).count();
            if threat >= 3 {
                for &q in &field {
                    if self.squads[q as usize].order == Order::Attack && self.squads[q as usize].target.is_some() && self.rng.next() < 0.6 {
                        continue;
                    }
                    let sq = &self.squads[q as usize];
                    if (sq.x - sx).jhypot(sq.y - sy) < 520.0 * dk && !sq.fighting && sq.order != Order::Rebuild {
                        let ox = (self.rng.next() - 0.5) * 40.0;
                        self.order_move(&[q], sx + ox, sy + sr + 20.0);
                        self.squads[q as usize].order = Order::Move;
                    }
                }
            }
        }

        // 2. 经营
        if self.t > 15.0 && !mine.is_empty() {
            let mut mines = 0.0;
            let mut obel = 0;
            let mut watches = 0;
            for &si in &mine {
                let st = &self.structs[si as usize];
                if st.addons.contains(&self.ids.watch) {
                    watches += 1;
                }
                for &a in &st.addons {
                    if a == self.ids.mine {
                        mines += 1.0;
                    }
                    if a == self.ids.obelisk {
                        obel += 1;
                    }
                }
            }
            if let Some(&slot_st) = mine.iter().find(|&&s| self.structs[s as usize].addons.contains(&0)) {
                let o = &self.owners[o_i];
                let mut kind = self.ids.mine;
                if o.used >= o.supply - 1.0 {
                    kind = self.ids.farm;
                } else if o.towers > 0 && obel < 1 {
                    kind = self.ids.obelisk;
                } else if mines >= mine.len() as f64 * 1.5 {
                    kind = if self.rng.next() < 0.4 { self.ids.farm } else if self.rng.next() < 0.5 { self.ids.obelisk } else { self.ids.watch };
                }
                if kind == self.ids.watch && (self.structs[slot_st as usize].addons.contains(&self.ids.watch) || watches >= 2) {
                    kind = self.ids.farm;
                }
                let cost = self.addon_cost(kind);
                if self.owners[o_i].gold > cost + 50.0 {
                    let slot = self.structs[slot_st as usize].addons.iter().position(|&a| a == 0).unwrap();
                    self.build(id, slot_st, slot, kind);
                }
            }
            if self.t > 80.0 {
                // 能升级的据点里城堡优先（稳定排序：同类保持原顺序）
                let ups: Vec<u32> = mine.iter().copied().filter(|&s| self.upgrade_cost(s).is_some()).collect();
                let up = ups.iter().copied().find(|&s| self.structs[s as usize].typ == self.ids.castle).or(ups.first().copied());
                if let Some(up) = up {
                    let o = &self.owners[o_i];
                    if o.gold > self.upgrade_cost(up).unwrap() * 1.7 && o.used >= o.supply - 1.0 {
                        self.upgrade(id, up);
                    }
                }
            }
            // 钱多了就研究科技
            if self.t > 150.0 && self.owners[o_i].gold > 420.0 {
                let o = &self.owners[o_i];
                let open: Vec<usize> = (0..self.d.tech_ids.len())
                    .filter(|&t| {
                        let lv = o.tech[t] as usize;
                        lv < self.d.tech_cost[t].len() && o.gold > self.d.tech_cost[t][lv] * 1.8
                    })
                    .collect();
                if !open.is_empty() {
                    let pick = open[(self.rng.next() * open.len() as f64).floor() as usize];
                    self.research(id, pick);
                }
            }
        }

        // 3. 征兵
        let mut enemy_mix = [0.0f64; 6];
        let mut own_mix = [0.0f64; 6];
        for &q in &self.order {
            let sq = &self.squads[q as usize];
            if let Some(m) = self.mix_slot(sq.typ) {
                if sq.owner != id && sq.owner != n_owner {
                    enemy_mix[m] += sq.units.len() as f64;
                }
                if sq.owner == id {
                    own_mix[m] += 1.0;
                }
            }
        }
        let lk = likes(&self.d.factions[self.owners[o_i].faction]);
        for &si in &mine {
            if self.owners[o_i].used >= self.owners[o_i].supply {
                break;
            }
            if !self.structs[si as usize].queue.is_empty() {
                continue;
            }
            let opts = self.d.structs[self.structs[si as usize].typ].recruit.clone();
            let level = self.structs[si as usize].level;
            let mut best: Option<(u8, usize)> = None;
            let mut bw = -1.0;
            for t in opts {
                let req = self.d.units[t].req;
                if req != 0 && level < req {
                    continue;
                }
                let m = match self.mix_slot(t as u8) {
                    Some(m) => m,
                    None => continue,
                };
                let mut w = [3.0, 2.6, 1.6, 0.7, 2.2, 1.7][m];
                match m {
                    5 => w += enemy_mix[0] * 0.05 + if self.owners[o_i].gold > 300.0 { 0.8 } else { 0.0 },
                    0 => w += enemy_mix[2] * 0.12,
                    1 => w += enemy_mix[0] * 0.1,
                    2 => w += (enemy_mix[1] + enemy_mix[3] * 2.0) * 0.12 + if self.t > 60.0 { 0.6 } else { 0.0 },
                    3 => w += if hostile_strong { 1.4 } else { 0.2 },
                    _ => {}
                }
                if m == 3 && own_mix[3] >= 2.0 {
                    w = 0.1;
                }
                w *= lk[m];
                w /= 1.0 + own_mix[m] * 0.35;
                w *= 0.8 + self.rng.next() * 0.4;
                if w > bw {
                    bw = w;
                    best = Some((t as u8, m));
                }
            }
            if let Some((t, m)) = best {
                if self.recruit(id, si, t) {
                    own_mix[m] += 1.0;
                }
            }
        }

        // 4. 进攻波次
        if self.t > (if id == 0 { 25.0 } else { self.d.diff.start }) {
            if let Some(tgt) = self.owners[o_i].attacking {
                let done = self.structs[tgt as usize].owner == id && !self.structs[tgt as usize].ruined;
                let wave = self.owners[o_i].wave;
                let army: Vec<u32> = field.iter().copied().filter(|&q| self.squads[q as usize].wave_id == Some(wave)).collect();
                if done || army.is_empty() {
                    self.owners[o_i].attacking = None;
                } else {
                    for q in army {
                        let sq = &self.squads[q as usize];
                        if sq.order == Order::Idle || (sq.order == Order::Move && sq.path.is_empty()) {
                            self.order_struct(&[q], tgt);
                        }
                    }
                }
            }
            if self.owners[o_i].attacking.is_none() {
                let idle: Vec<u32> = field
                    .iter()
                    .copied()
                    .filter(|&q| {
                        let sq = &self.squads[q as usize];
                        !self.busy(q) && (sq.order == Order::Idle || sq.order == Order::Defend || (sq.order == Order::Move && sq.path.is_empty()))
                    })
                    .collect();
                let o = &self.owners[o_i];
                let wave_need = (if id == 0 { 3.0 } else { self.d.diff.wave }) + (self.t / 200.0).floor();
                let capped = o.used >= o.supply && o.gold > 120.0;
                if idle.len() as f64 >= wave_need || (capped && idle.len() >= 2) {
                    let mut cx = 0.0;
                    let mut cy = 0.0;
                    for &q in &idle {
                        cx += self.squads[q as usize].x;
                        cy += self.squads[q as usize].y;
                    }
                    cx /= idle.len() as f64;
                    cy /= idle.len() as f64;
                    let mut best: Option<u32> = None;
                    let mut bs = f64::INFINITY;
                    for (si, s) in self.structs.iter().enumerate() {
                        if s.owner == id {
                            continue;
                        }
                        let mut score = (s.x - cx).jhypot(s.y - cy);
                        if s.ruined {
                            score -= 120.0 * dk;
                        } else {
                            score += s.hp / 6.0 + s.garrison.len() as f64 * 90.0;
                        }
                        if score < bs {
                            bs = score;
                            best = Some(si as u32);
                        }
                    }
                    if let Some(b) = best {
                        self.owners[o_i].wave += 1;
                        self.owners[o_i].attacking = Some(b);
                        let wave = self.owners[o_i].wave;
                        for &q in &idle {
                            self.squads[q as usize].wave_id = Some(wave);
                        }
                        self.order_struct(&idle, b);
                    }
                }
            }
        }

        // 5. 顺手修附近的废墟
        for si in 0..self.structs.len() as u32 {
            if !self.structs[si as usize].ruined {
                continue;
            }
            let taken = self.order.iter().any(|&q| {
                let sq = &self.squads[q as usize];
                sq.owner == id && sq.target == Some(si) && sq.order == Order::Rebuild
            });
            if taken {
                continue;
            }
            let (sx, sy) = (self.structs[si as usize].x, self.structs[si as usize].y);
            let near = mine.iter().any(|&m| (self.structs[m as usize].x - sx).jhypot(self.structs[m as usize].y - sy) < 420.0 * dk);
            if !near {
                continue;
            }
            let pick = field.iter().copied().find(|&f| {
                let sq = &self.squads[f as usize];
                !self.busy(f) && sq.wave_id.is_none() && (sq.x - sx).jhypot(sq.y - sy) < 500.0 * dk
            });
            if let Some(q) = pick {
                self.order_struct(&[q], si);
            }
        }

        // 6. 宝箱
        for ci in 0..self.chests.len() {
            if self.chests[ci].taken {
                continue;
            }
            let (cx, cy) = (self.chests[ci].x, self.chests[ci].y);
            let guarded = self.order.iter().any(|&q| {
                let sq = &self.squads[q as usize];
                sq.owner == n_owner && (sq.x - cx).jhypot(sq.y - cy) < 150.0
            });
            if guarded {
                continue;
            }
            let pick = field.iter().copied().find(|&f| !self.busy(f) && (self.squads[f as usize].x - cx).jhypot(self.squads[f as usize].y - cy) < 600.0 * dk);
            if let Some(q) = pick {
                self.order_move(&[q], cx, cy);
            }
        }
        // 托管玩家时：兵多了顺手清食人魔
        if id == 0 && self.t > 120.0 {
            let ogre = self.order.iter().copied().find(|&q| self.squads[q as usize].owner == n_owner && self.squads[q as usize].typ == self.ids.ogre);
            let idle: Vec<u32> = field.iter().copied().filter(|&q| !self.busy(q) && self.squads[q as usize].wave_id.is_none()).collect();
            if let Some(og) = ogre {
                if idle.len() >= 3 {
                    let (ox, oy) = (self.squads[og as usize].x, self.squads[og as usize].y);
                    self.order_move(&idle[0..3], ox, oy);
                }
            }
        }

        // 7. 法术
        self.scratch = list;
        self.cast_spells(id, &field);
    }

    fn cast_spells(&mut self, id: u8, field: &[u32]) {
        let o_i = id as usize;
        let keys = self.d.faction_spells[self.owners[o_i].faction].clone();
        if keys.is_empty() {
            return;
        }
        let dk = self.d.mapk;
        // JS 里只看 engaged 是不是空，不管它是否刚死；这里用“还指向同一个士兵”来对应
        let fight = field.iter().copied().find(|&q| self.squads[q as usize].fighting && self.same_unit(self.squads[q as usize].engaged).is_some());
        let f = match fight {
            Some(f) => f,
            None => {
                // 攻城时：天罚砸墙
                let sieging = field.iter().copied().find(|&q| self.squads[q as usize].order == Order::Attack && self.squads[q as usize].target.is_some());
                if let (Some(sq), Some(smite)) = (sieging, self.ids.smite) {
                    if keys.contains(&smite) {
                        let si = self.squads[sq as usize].target.unwrap();
                        let st = &self.structs[si as usize];
                        let (sx, sy) = (st.x, st.y);
                        if !st.ruined && st.hp > 200.0 && (sx - self.squads[sq as usize].x).jhypot(sy - self.squads[sq as usize].y) < 260.0 * dk && self.can_cast(id, smite) {
                            self.cast(id, smite, sx, sy);
                        }
                    }
                }
                return;
            }
        };
        let e = self.same_unit(self.squads[f as usize].engaged).unwrap();
        let (ex, ey) = (self.units[e as usize].x, self.units[e as usize].y);
        let (fx, fy) = (self.squads[f as usize].x, self.squads[f as usize].y);
        let mut list = std::mem::take(&mut self.scratch);
        self.in_radius(ex, ey, 70.0, &mut list);
        let foes = list.iter().filter(|&&u| self.units[u as usize].owner != id).count() as f64;
        let friends = list.iter().filter(|&&u| self.units[u as usize].owner == id).count() as f64;
        self.scratch = list;
        if keys.len() < 3 {
            return;
        }
        let (banner, strike, ult) = (keys[0], keys[1], keys[2]);
        let mana = self.owners[o_i].mana;
        if mana >= 100.0 && self.can_cast(id, ult) && foes >= 8.0 {
            self.cast(id, ult, ex, ey);
            return;
        }
        if foes >= 5.0 && friends * 1.2 < foes + 6.0 && self.can_cast(id, strike) {
            // 打击类法术避开自己人
            if self.d.spells[strike].kind == KIND_STRIKE || friends < 4.0 {
                self.cast(id, strike, ex, ey);
                return;
            }
        }
        if friends >= 8.0 && mana >= 60.0 && self.can_cast(id, banner) {
            if self.d.spells[banner].fx == FX_FROST {
                self.cast(id, banner, ex, ey);
            } else {
                self.cast(id, banner, (fx + ex) / 2.0, (fy + ey) / 2.0);
            }
        }
    }

    /// 每 4 个模拟步给各家补一批兵，直到达到目标数量
    pub fn bench_spawn(&mut self) {
        if self.soldier_count >= self.bench.n || self.tick % 4 != 0 || self.bench.types.is_empty() {
            return;
        }
        let gap = self.bench.n - self.soldier_count;
        let per = if gap > 5000 { 6 } else if gap > 600 { 2 } else { 1 };
        let k = self.bench.k;
        let mut ids = vec![0u8];
        ids.extend_from_slice(&self.foe_ids);
        for id in ids {
            let home: Vec<u32> = (0..self.structs.len() as u32).filter(|&s| self.structs[s as usize].owner == id && !self.structs[s as usize].ruined).collect();
            if home.is_empty() {
                continue;
            }
            for j in 0..per {
                let si = home[(k + j) % home.len()];
                let typ = self.bench.types[(k + j) % self.bench.types.len()];
                let (sx, sy, sr) = { let s = &self.structs[si as usize]; (s.x, s.y, s.r) };
                let ox = (self.rng.next() - 0.5) * 60.0;
                let sq = self.spawn_squad(id, typ, ((k + j) % 3) as u8, sx + ox, sy + sr + 16.0, 0);
                // 目标：离这座城最近的三座敌城里随机一座
                let mut foes: Vec<(u32, f64)> = self
                    .structs
                    .iter()
                    .enumerate()
                    .filter(|(_, s)| s.owner != NONE && s.owner != id)
                    .map(|(i, s)| (i as u32, (s.x - sx).jhypot(s.y - sy)))
                    .collect();
                foes.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
                foes.truncate(3);
                let pick = (self.rng.next() * foes.len() as f64).floor() as usize;
                if let Some(&(tgt, _)) = foes.get(pick) {
                    self.order_struct(&[sq], tgt);
                }
            }
        }
        self.bench.k += 1;
    }
}
