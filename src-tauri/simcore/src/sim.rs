//! 每个模拟步做的事。逐函数对应 sim.js 的后半部分（step / updateSquad / actUnit / separate / …）。

use crate::data::*;
use crate::jsmath::JsMath;
use crate::world::*;
use std::collections::VecDeque;
use std::time::Instant;

// 城的箭塔射程 / 守军出击半径
const SHOT_R: f64 = 112.0;
const SORTIE_R: f64 = 122.0;

fn lerp_angle(a: f64, b: f64, k: f64) -> f64 {
    let pi = std::f64::consts::PI;
    let mut d = b - a;
    while d > pi {
        d -= pi * 2.0;
    }
    while d < -pi {
        d += pi * 2.0;
    }
    a + d * k
}

impl World {
    pub fn step(&mut self) {
        let dt = self.d.step;
        let t0 = Instant::now();
        // 上一步腾出来的士兵槽位，从这一步开始才允许复用（这之前旧引用还可能读它的位置）
        self.free.append(&mut self.free_pending);
        self.t += dt;
        self.tick += 1;
        self.rebuild_hash();
        self.apply_effects(dt);
        for k in 0..self.order.len() {
            let sq = self.order[k];
            self.update_squad(sq, dt);
        }
        self.separate();
        for si in 0..self.structs.len() {
            self.update_struct(si as u32, dt);
        }
        self.update_projectiles(dt);
        if self.tick % 30 == 0 {
            self.every_second();
        }
        // 清理：死掉的士兵移出部队，空了的部队移出列表
        let mut emptied = false;
        for k in 0..self.order.len() {
            let sq = self.order[k] as usize;
            let mut units = std::mem::take(&mut self.squads[sq].units);
            let before = units.len();
            units.retain(|&ui| {
                if self.units[ui as usize].dead {
                    self.free_pending.push(ui);
                    false
                } else {
                    true
                }
            });
            if units.len() != before && units.is_empty() {
                emptied = true;
            }
            self.squads[sq].units = units;
        }
        if emptied {
            let mut order = std::mem::take(&mut self.order);
            order.retain(|&sq| {
                if self.squads[sq as usize].units.is_empty() {
                    self.squads[sq as usize].live = false;
                    self.sq_free.push(sq);
                    false
                } else {
                    true
                }
            });
            self.order = order;
            for si in 0..self.structs.len() {
                let mut g = std::mem::take(&mut self.structs[si].garrison);
                g.retain(|&sq| self.squads[sq as usize].live && !self.squads[sq as usize].units.is_empty());
                self.structs[si].garrison = g;
            }
            self.recount();
        }
        self.perf_sim = self.perf_sim * 0.95 + t0.elapsed().as_secs_f64() * 1000.0 * 0.05;
    }

    fn rebuild_hash(&mut self) {
        let hc = self.hc as i32;
        let hr = self.hr as i32;
        for cell in self.hash.iter_mut() {
            cell.clear();
        }
        let mut n = 0u32;
        for k in 0..self.order.len() {
            let sq = &self.squads[self.order[k] as usize];
            if sq.inside.is_some() {
                continue;
            }
            for &ui in &sq.units {
                let u = &mut self.units[ui as usize];
                u.px = u.x;
                u.py = u.y;
                u.lust = false;
                u.frost_slow = 1.0;
                u.vuln = 1.0;
                if u.dead {
                    continue;
                }
                let cx = ((u.x / CELL) as i32).max(0).min(hc - 1);
                let cy = ((u.y / CELL) as i32).max(0).min(hr - 1);
                self.hash[(cy * hc + cx) as usize].push(ui);
                n += 1;
            }
        }
        self.soldier_count = n;
    }

    fn apply_effects(&mut self, dt: f64) {
        let mut list = std::mem::take(&mut self.scratch);
        for e in 0..self.effects.len() {
            let (key, kind, owner, x, y, r, pow) = { let ef = &self.effects[e]; (ef.key, ef.kind, ef.owner, ef.x, ef.y, ef.r, ef.pow) };
            let sp = self.d.spells[key].clone();
            self.in_radius(x, y, r, &mut list);
            for &ui in &list {
                let friend = self.units[ui as usize].owner == owner;
                if sp.fx == FX_HEAL && friend {
                    let u = &mut self.units[ui as usize];
                    u.hp = u.max.min(u.hp + sp.power * pow * dt);
                } else if sp.fx == FX_LUST && friend {
                    self.units[ui as usize].lust = true;
                } else if sp.fx == FX_FROST && !friend {
                    let u = &mut self.units[ui as usize];
                    u.frost_slow = u.frost_slow.min(sp.power);
                    u.vuln = sp.vuln;
                } else if kind == KIND_AREA && !friend {
                    self.hurt_unit(ui, sp.power * pow * dt, DMG_MAGIC, 0.0);
                    if sp.slow != 0.0 {
                        let u = &mut self.units[ui as usize];
                        u.frost_slow = u.frost_slow.min(sp.slow);
                    }
                }
            }
            if kind == KIND_AREA {
                for si in 0..self.structs.len() {
                    let s = &self.structs[si];
                    if (s.x - x).jhypot(s.y - y) < r + s.r {
                        self.hurt_struct(si as u32, owner);
                    }
                }
            }
        }
        self.scratch = list;
        let t = self.t;
        self.effects.retain(|ef| ef.until > t);
    }

    /// 以队伍中心为原点、朝向为前方的阵位，直接写到士兵的 fx/fy；返回最大掉队距离
    fn formation(&mut self, sq: u32) -> f64 {
        let (n, sp, heading, x, y) = {
            let q = &self.squads[sq as usize];
            let st = self.stats[q.st as usize].as_ref().unwrap();
            let sp = if st.big || q.typ == self.ids.siege { 26.0 } else if q.typ == self.ids.cav { 18.0 } else if q.typ == self.ids.guard { 16.0 } else { 11.0 };
            (q.units.len(), sp, q.heading, q.x, q.y)
        };
        let cols = ((n as f64 * 1.6).sqrt().ceil() as usize).max(1);
        let ch = heading.jcos();
        let sh = heading.jsin();
        let mut lag: f64 = 0.0;
        for k in 0..n {
            let ui = self.squads[sq as usize].units[k];
            let u = &mut self.units[ui as usize];
            let row = k / cols;
            let col = k - row * cols;
            let in_row = cols.min(n - row * cols);
            let lat = (col as f64 - (in_row as f64 - 1.0) / 2.0) * sp;
            let back = row as f64 * sp;
            u.fx = x - ch * back - sh * lat;
            u.fy = y - sh * back + ch * lat;
            let dx = u.x - u.fx;
            let dy = u.y - u.fy;
            let d2 = dx * dx + dy * dy;
            if d2 > lag {
                lag = d2;
            }
        }
        lag.sqrt()
    }

    fn update_squad(&mut self, sq: u32, dt: f64) {
        let s = sq as usize;
        if self.squads[s].inside.is_some() {
            return;
        }
        if self.squads[s].until != 0.0 && self.t > self.squads[s].until {
            for k in 0..self.squads[s].units.len() {
                let ui = self.squads[s].units[k] as usize;
                if !self.units[ui].dead {
                    self.units[ui].dead = true;
                    let (x, y) = (self.units[ui].x, self.units[ui].y);
                    self.fx(FX_POOF, 0, x, y, 0.0, 0.6);
                }
            }
            return;
        }
        let st = self.st(self.squads[s].st);
        let owner = self.squads[s].owner;
        self.squads[s].scan -= dt;
        if self.squads[s].scan <= 0.0 {
            self.squads[s].scan = 0.2;
            let (qx, qy) = (self.squads[s].x, self.squads[s].y);
            let mut cx = qx;
            let mut cy = qy;
            let mut radius = st.aggro;
            let guard_home = match (self.squads[s].order, self.squads[s].home) {
                (Order::Guard, Home::Pos(hx, hy)) => Some((hx, hy)),
                _ => None,
            };
            if let Some((hx, hy)) = guard_home {
                cx = hx;
                cy = hy;
                radius = 110.0;
            }
            let mut e = self.nearest_hostile(cx, cy, owner, radius);
            // 近战只和走得到的敌人交战（隔着树林/河就不追）
            if let Some(ei) = e {
                if st.proj == 0 && !self.line_clear(qx, qy, self.units[ei as usize].x, self.units[ei as usize].y) {
                    e = None;
                }
            }
            self.squads[s].engaged = e.map(|i| self.unit_ref(i)).unwrap_or(Tgt::None);
            if let Some((hx, hy)) = guard_home {
                if (qx - hx).jhypot(qy - hy) > 170.0 {
                    self.squads[s].engaged = Tgt::None;
                }
            }
        }
        if self.squads[s].engaged != Tgt::None && self.live_unit(self.squads[s].engaged).is_none() {
            self.squads[s].engaged = Tgt::None;
        }
        let was_fighting = self.squads[s].fighting;
        self.squads[s].fighting = self.squads[s].engaged != Tgt::None;
        if self.squads[s].fighting {
            self.squads[s].quiet_t = 0.0;
        }

        let mut siege_target: Option<u32> = None;
        if self.squads[s].order == Order::Attack && self.squads[s].target.is_some() {
            let ti = self.squads[s].target.unwrap();
            let (tx, ty, tr, towner, truined) = { let ts = &self.structs[ti as usize]; (ts.x, ts.y, ts.r, ts.owner, ts.ruined) };
            if truined {
                self.squads[s].order = Order::Rebuild;
                self.set_path(sq, tx, ty);
            } else if towner == owner {
                self.squads[s].order = Order::Enter;
                self.set_path(sq, tx, ty);
            } else {
                let (qx, qy) = (self.squads[s].x, self.squads[s].y);
                let d = (tx - qx).jhypot(ty - qy);
                // 滞回：进入攻城状态后，离开更远才退出，避免在边界来回切换
                let slack = if self.squads[s].sieging == Some(ti) { 120.0 } else { 50.0 };
                if d < tr + st.range + slack && (st.proj != 0 || self.line_clear(qx, qy, tx + (qx - tx) / d * tr, ty + (qy - ty) / d * tr)) {
                    siege_target = Some(ti);
                    self.squads[s].sieging = Some(ti);
                } else {
                    self.squads[s].sieging = None;
                }
            }
        } else {
            self.squads[s].sieging = None;
        }

        if self.squads[s].fighting || siege_target.is_some() {
            let mut cx = 0.0;
            let mut cy = 0.0;
            let mut n = 0.0;
            for k in 0..self.squads[s].units.len() {
                let ui = self.squads[s].units[k];
                if self.units[ui as usize].dead {
                    continue;
                }
                self.act_unit(sq, &st, ui, dt, siege_target);
                cx += self.units[ui as usize].x;
                cy += self.units[ui as usize].y;
                n += 1.0;
            }
            if n > 0.0 {
                self.squads[s].x = cx / n;
                self.squads[s].y = cy / n;
            }
            return;
        }

        if was_fighting && !self.squads[s].fighting {
            // 打完仗：原路线第一个路点还能直接走到就沿用，省一次 A*
            let (qx, qy) = (self.squads[s].x, self.squads[s].y);
            let front = self.squads[s].path.front().copied();
            let keep = match front {
                Some((px, py)) => self.line_clear(qx, qy, px, py),
                None => false,
            };
            if keep {
                // 继续原路线
            } else if let Some((gx, gy)) = self.squads[s].goal {
                self.set_path(sq, gx, gy);
            } else if let (Order::Guard, Home::Pos(hx, hy)) = (self.squads[s].order, self.squads[s].home) {
                self.set_path(sq, hx, hy);
            } else {
                // 原地重新整队
                let mut cx = 0.0;
                let mut cy = 0.0;
                let mut n = 0.0;
                for &ui in &self.squads[s].units {
                    cx += self.units[ui as usize].x;
                    cy += self.units[ui as usize].y;
                    n += 1.0;
                }
                if n > 0.0 {
                    self.squads[s].x = cx / n;
                    self.squads[s].y = cy / n;
                }
            }
        }

        // 行军
        let mut slow: f64 = 1.0;
        let mut lust = false;
        for &ui in &self.squads[s].units {
            let u = &self.units[ui as usize];
            slow = slow.min(u.frost_slow * if u.slow_t > 0.0 { 1.0 - u.slow_a } else { 1.0 });
            if u.lust {
                lust = true;
            }
        }
        if lust && slow >= 1.0 {
            slow = self.d.spells[self.ids.lust].haste;
        }
        let lag = self.formation(sq);
        if let Some(&(px, py)) = self.squads[s].path.front() {
            // 等掉队的人
            let pace = if lag > 30.0 { 0.35 } else if lag > 18.0 { 0.75 } else { 1.0 };
            let q = &mut self.squads[s];
            let d = (px - q.x).jhypot(py - q.y);
            let step_len = st.speed * slow * pace * dt;
            q.heading = lerp_angle(q.heading, (py - q.y).jatan2(px - q.x), 0.25);
            if d <= step_len {
                q.x = px;
                q.y = py;
                q.path.pop_front();
            } else {
                q.x += ((px - q.x) / d) * step_len;
                q.y += ((py - q.y) / d) * step_len;
            }
        } else {
            self.arrive(sq, &st);
        }
        // 士兵跟随阵位
        self.formation(sq);
        let fspeed = st.speed * 1.15 * slow;
        for k in 0..self.squads[s].units.len() {
            let ui = self.squads[s].units[k];
            if self.units[ui as usize].stun <= 0.0 {
                let (fx, fy) = (self.units[ui as usize].fx, self.units[ui as usize].fy);
                self.move_unit_to(ui, fx, fy, fspeed, dt, 2.0);
            }
            let u = &mut self.units[ui as usize];
            if u.stun > 0.0 {
                u.stun -= dt;
            }
            if u.slow_t > 0.0 {
                u.slow_t -= dt;
            } else {
                u.slow_a = 0.0;
            }
            if u.hit_t > 0.0 {
                u.hit_t -= dt;
            }
            if u.atk > 0.0 {
                u.atk -= dt;
            }
            u.cd -= dt;
        }
    }

    fn arrive(&mut self, sq: u32, st: &Stats) {
        let s = sq as usize;
        let owner = self.squads[s].owner;
        let order = self.squads[s].order;
        let target = self.squads[s].target;
        let step = self.d.step;
        if let (Order::Enter, Some(ti)) = (order, target) {
            let (tx, ty, tr, towner, truined) = { let ts = &self.structs[ti as usize]; (ts.x, ts.y, ts.r, ts.owner, ts.ruined) };
            if towner != owner || truined {
                self.order_struct(&[sq], ti);
                return;
            }
            if (tx - self.squads[s].x).jhypot(ty - self.squads[s].y) < tr + 24.0 {
                if !self.enter_struct(sq, ti) {
                    self.squads[s].order = Order::Idle;
                    self.squads[s].target = None;
                } else {
                    self.ev(EV_ENTER, owner, 0, tx, ty, 0.0);
                }
            } else {
                self.set_path(sq, tx, ty);
            }
        } else if let (Order::Rebuild, Some(ti)) = (order, target) {
            let (tx, ty, tr, towner, truined) = { let ts = &self.structs[ti as usize]; (ts.x, ts.y, ts.r, ts.owner, ts.ruined) };
            if !truined {
                if towner == owner {
                    self.squads[s].order = Order::Enter;
                    self.set_path(sq, tx, ty);
                } else {
                    self.order_struct(&[sq], ti);
                }
                return;
            }
            if (tx - self.squads[s].x).jhypot(ty - self.squads[s].y) > tr + 20.0 {
                self.set_path(sq, tx, ty);
                return;
            }
            // 别人正在修：等对方被赶走
            let rb = self.structs[ti as usize].rebuilder;
            if rb != NONE && rb != owner {
                let busy = self.order.iter().any(|&o| {
                    let q = &self.squads[o as usize];
                    q.owner == rb && q.order == Order::Rebuild && q.target == Some(ti) && !q.units.is_empty()
                });
                if busy {
                    return;
                }
            }
            let n = self.squads[s].units.len() as f64;
            let ts = &mut self.structs[ti as usize];
            ts.rebuilder = owner;
            ts.rebuild += n * 4.5 * 1.0 * step * if st.summon { 0.0 } else { 1.0 };
            if ts.rebuild >= ts.max_hp * 0.45 {
                self.capture_struct(ti, sq);
            }
        } else if let (Order::Attack, Some(ti)) = (order, target) {
            // 路走完了还没到射程：直接朝城走
            let (tx, ty, tr, towner, truined) = { let ts = &self.structs[ti as usize]; (ts.x, ts.y, ts.r, ts.owner, ts.ruined) };
            if truined || towner == owner {
                self.order_struct(&[sq], ti);
                return;
            }
            let (qx, qy) = (self.squads[s].x, self.squads[s].y);
            let d = (tx - qx).jhypot(ty - qy);
            if d > tr + st.range + 40.0 {
                self.set_path(sq, tx + (qx - tx) / d * (tr + 10.0), ty + (qy - ty) / d * (tr + 10.0));
            }
        } else if order == Order::Move {
            self.squads[s].order = Order::Idle;
            self.squads[s].goal = None;
        } else if order == Order::Defend {
            let hi = match self.squads[s].home {
                Home::Struct(h) => Some(h),
                _ => None,
            };
            let ok = hi.map(|h| self.structs[h as usize].owner == owner && !self.structs[h as usize].ruined).unwrap_or(false);
            if !ok {
                self.squads[s].order = Order::Idle;
                self.squads[s].home = Home::None;
                return;
            }
            let hi = hi.unwrap();
            self.squads[s].quiet_t += step;
            if self.squads[s].quiet_t > 2.5 {
                let (hx, hy, hr) = { let h = &self.structs[hi as usize]; (h.x, h.y, h.r) };
                if (hx - self.squads[s].x).jhypot(hy - self.squads[s].y) < hr + 24.0 {
                    self.enter_struct(sq, hi);
                } else {
                    self.set_path(sq, hx, hy);
                }
            }
        } else if let (Order::Guard, Home::Pos(hx, hy)) = (order, self.squads[s].home) {
            if (hx - self.squads[s].x).jhypot(hy - self.squads[s].y) > 12.0 {
                self.set_path(sq, hx, hy);
            }
            for k in 0..self.squads[s].units.len() {
                let u = &mut self.units[self.squads[s].units[k] as usize];
                u.hp = u.max.min(u.hp + 6.0 * step);
            }
        }
    }

    fn capture_struct(&mut self, ti: u32, sq: u32) {
        let owner = self.squads[sq as usize].owner;
        let typ = self.structs[ti as usize].typ;
        let max_hp = self.struct_max_hp(typ, 0, owner);
        let (x, y, id) = {
            let ts = &mut self.structs[ti as usize];
            ts.ruined = false;
            ts.owner = owner;
            ts.max_hp = max_hp;
            ts.hp = max_hp * 0.45;
            ts.rebuild = 0.0;
            ts.rebuilder = NONE;
            (ts.x, ts.y, ts.id)
        };
        self.ev(EV_CAPTURE, owner, 0, x, y, id as f64);
        // 修好的部队自动进驻
        for k in 0..self.order.len() {
            let o = self.order[k];
            let q = &self.squads[o as usize];
            if q.owner == owner && q.order == Order::Rebuild && q.target == Some(ti) && !q.units.is_empty() {
                self.enter_struct(o, ti);
            }
        }
        self.recount();
    }

    fn act_unit(&mut self, sq: u32, st: &Stats, ui: u32, dt: f64, siege_target: Option<u32>) {
        let u_i = ui as usize;
        if self.units[u_i].stun > 0.0 {
            self.units[u_i].stun -= dt;
            return;
        }
        let lust_power = self.d.spells[self.ids.lust].power;
        let slow;
        {
            let u = &mut self.units[u_i];
            if u.slow_t > 0.0 {
                u.slow_t -= dt;
            } else {
                u.slow_a = 0.0;
            }
            if u.hit_t > 0.0 {
                u.hit_t -= dt;
            }
            if u.atk > 0.0 {
                u.atk -= dt;
            }
            slow = u.frost_slow * if u.slow_t > 0.0 { 1.0 - u.slow_a } else { 1.0 };
            u.cd -= dt * slow * if u.lust { lust_power } else { 1.0 };
            u.retarget -= dt;
        }
        let owner = self.units[u_i].owner;
        // 目标失效（死了、过了重选时间、据点已经成了废墟或自己人的）就重新找
        let stale = match self.units[u_i].tgt {
            Tgt::None => true,
            Tgt::Unit(..) => self.live_unit(self.units[u_i].tgt).is_none(),
            Tgt::Struct(si) => {
                let ts = &self.structs[si as usize];
                ts.ruined || ts.owner == owner
            }
        };
        if stale || self.units[u_i].retarget <= 0.0 {
            self.units[u_i].retarget = 0.35 + self.rng.next() * 0.15;
            let look = (st.range + 50.0).max(80.0);
            let (ux, uy) = (self.units[u_i].x, self.units[u_i].y);
            let mut t = self.nearest_hostile(ux, uy, owner, look).map(|i| self.unit_ref(i)).unwrap_or(Tgt::None);
            if let Tgt::Unit(ti, _) = t {
                if st.proj == 0 && !self.line_clear(ux, uy, self.units[ti as usize].x, self.units[ti as usize].y) {
                    t = Tgt::None;
                }
            }
            if t == Tgt::None {
                let e = self.squads[sq as usize].engaged;
                if self.live_unit(e).is_some() {
                    t = e;
                }
            }
            if t == Tgt::None {
                if let Some(si) = siege_target {
                    t = Tgt::Struct(si);
                }
            }
            self.units[u_i].tgt = t;
        }
        let tgt = self.units[u_i].tgt;
        let (tx, ty, tr, is_struct) = match tgt {
            Tgt::None => {
                self.units[u_i].run = 0.0;
                return;
            }
            Tgt::Unit(ti, _) => (self.units[ti as usize].x, self.units[ti as usize].y, 0.0, false),
            Tgt::Struct(si) => (self.structs[si as usize].x, self.structs[si as usize].y, self.structs[si as usize].r, true),
        };
        let (ux, uy) = (self.units[u_i].x, self.units[u_i].y);
        let dx = tx - ux;
        let dy = ty - uy;
        let d = dx.jhypot(dy) - if is_struct { tr } else { 4.0 };
        if dx.abs() > 0.5 {
            self.units[u_i].face = if dx > 0.0 { 1 } else { -1 };
        }
        let reach = st.range + if st.proj != 0 { 0.0 } else { 3.0 };
        if d > reach {
            // 接近
            let (mx, my) = if is_struct { (tx - (dx / (d + tr)) * (tr + reach * 0.7), ty - (dy / (d + tr)) * (tr + reach * 0.7)) } else { (tx, ty) };
            self.move_unit_to(ui, mx, my, st.speed * slow, dt, 0.0);
            self.units[u_i].run += dt;
            return;
        }
        if st.min_range != 0.0 && d < st.min_range && !is_struct {
            self.move_unit_to(ui, ux - dx, uy - dy, st.speed * slow, dt, 0.0);
            return;
        }
        if self.units[u_i].cd > 0.0 {
            return;
        }
        self.units[u_i].cd = st.cd * (0.92 + self.rng.next() * 0.16);
        self.units[u_i].atk = 0.22;
        let mut dmg = st.dmg;
        if st.charge != 0.0 && self.units[u_i].run > 0.8 {
            dmg *= st.charge;
            self.fx(FX_CHARGE, 0, tx, ty - 10.0, 0.0, 0.5);
        }
        self.units[u_i].run = 0.0;
        if owner != 0 && self.owners[owner as usize].ai && owner != self.n_owner {
            dmg *= 0.92;
        }
        let lust = self.units[u_i].lust;
        let typ = self.squads[sq as usize].typ;
        if st.proj != 0 {
            let dist = dx.jhypot(dy);
            let speed = if st.proj == 2 { 150.0 } else if st.proj == 3 { 260.0 } else { 330.0 };
            let faction = self.owners[owner as usize].faction as u8;
            self.proj.push(Proj {
                k: st.proj - 1,
                owner,
                x: ux,
                y: uy - 6.0,
                sx: ux,
                sy: uy - 6.0,
                tx,
                ty,
                tgt: if is_struct { Tgt::None } else { tgt },
                st: if let Tgt::Struct(si) = tgt { Some(si) } else { None },
                t: 0.0,
                dur: (dist / speed).max(0.15),
                dmg,
                typ: st.dmg_type,
                splash: st.splash,
                slow_hit: st.slow_hit,
                lust,
                faction,
                done: false,
            });
            self.ev(EV_SHOOT, NONE, st.proj - 1, ux, uy, 0.0);
        } else {
            match tgt {
                Tgt::Struct(si) => self.hurt_struct(si, owner),
                Tgt::Unit(ti, _) => {
                    self.hurt_unit(ti, dmg, st.dmg_type, st.slow_hit);
                    if st.splash != 0.0 {
                        let mut list = std::mem::take(&mut self.scratch);
                        self.in_radius(tx, ty, st.splash, &mut list);
                        for &oi in &list {
                            if oi != ti && self.units[oi as usize].owner != owner {
                                self.hurt_unit(oi, dmg * 0.5, st.dmg_type, st.slow_hit);
                            }
                        }
                        self.scratch = list;
                    }
                }
                Tgt::None => {}
            }
            self.ev(EV_HIT, NONE, typ, tx, ty, 0.0);
        }
        if st.heal_aura != 0.0 {
            let mut list = std::mem::take(&mut self.scratch);
            self.in_radius(ux, uy, 60.0, &mut list);
            for &oi in &list {
                let o = &mut self.units[oi as usize];
                if o.owner == owner {
                    o.hp = o.max.min(o.hp + st.heal_aura);
                }
            }
            self.scratch = list;
        }
    }

    fn move_unit_to(&mut self, ui: u32, mut tx: f64, mut ty: f64, speed: f64, dt: f64, mut eps: f64) {
        let u_i = ui as usize;
        let t = self.t;
        // 被地形挡住的士兵：走自己的小路径绕过去
        if self.units[u_i].path.is_some() {
            let u = &mut self.units[u_i];
            let expired = u.path_t < t || u.path.as_ref().map(|p| p.is_empty()).unwrap_or(true);
            if expired {
                u.path = None;
            } else {
                let (x, y) = (u.x, u.y);
                let p = u.path.as_mut().unwrap();
                let (px, py) = p[0];
                if (px - x).jhypot(py - y) < 6.0 {
                    p.pop_front();
                }
                if let Some(&(nx, ny)) = p.front() {
                    tx = nx;
                    ty = ny;
                    eps = 0.0;
                } else {
                    u.path = None;
                }
            }
        }
        let (ox, oy) = (self.units[u_i].x, self.units[u_i].y);
        let dx = tx - ox;
        let dy = ty - oy;
        let d = dx.jhypot(dy);
        if d <= eps {
            let u = &mut self.units[u_i];
            u.moving = false;
            u.blocked = 0;
            return;
        }
        let s = d.min(speed * dt);
        let nx = ox + (dx / d) * s;
        let ny = oy + (dy / d) * s;
        let (mut cx, mut cy) = (ox, oy);
        if !self.blocked_at(nx, ny) {
            cx = nx;
            cy = ny;
        } else if !self.blocked_at(nx, oy) {
            cx = nx;
        } else if !self.blocked_at(ox, ny) {
            cy = ny;
        }
        self.units[u_i].x = cx;
        self.units[u_i].y = cy;
        let moved = (cx - ox).abs() + (cy - oy).abs();
        if moved < s * 0.3 && d > 20.0 {
            self.units[u_i].blocked += 1;
            if self.units[u_i].blocked > 8 && self.units[u_i].path.is_none() {
                self.units[u_i].blocked = 0;
                if let Some(p) = self.find_path(cx, cy, tx, ty) {
                    if !p.is_empty() {
                        self.units[u_i].path = Some(VecDeque::from(p));
                        self.units[u_i].path_t = t + 3.0;
                    }
                }
            }
        } else {
            self.units[u_i].blocked = 0;
        }
        let u = &mut self.units[u_i];
        if dx.abs() > 1.0 {
            u.face = if dx > 0.0 { 1 } else { -1 };
        }
        u.moving = true;
        u.step += s * 0.35;
    }

    /// 同格内推开，避免叠成一个点
    fn separate(&mut self) {
        let hash = std::mem::take(&mut self.hash);
        for cell in &hash {
            let n = cell.len();
            for i in 0..n {
                let ai = cell[i] as usize;
                for j in (i + 1)..n {
                    let bi = cell[j] as usize;
                    let (ax, ay, arad) = { let a = &self.units[ai]; (a.x, a.y, a.rad) };
                    let (bx, by, brad) = { let b = &self.units[bi]; (b.x, b.y, b.rad) };
                    let dx = bx - ax;
                    let dy = by - ay;
                    let rr = if arad > brad { arad } else { brad };
                    let d2 = dx * dx + dy * dy;
                    if d2 >= rr * rr || d2 == 0.0 {
                        continue;
                    }
                    let d = d2.sqrt();
                    let push = (rr - d) * 0.5;
                    let ux = dx / d;
                    let uy = dy / d;
                    if !self.blocked_at(ax - ux * push, ay - uy * push) {
                        let a = &mut self.units[ai];
                        a.x -= ux * push;
                        a.y -= uy * push;
                    }
                    if !self.blocked_at(bx + ux * push, by + uy * push) {
                        let b = &mut self.units[bi];
                        b.x += ux * push;
                        b.y += uy * push;
                    }
                }
            }
        }
        self.hash = hash;
    }

    fn update_struct(&mut self, si: u32, dt: f64) {
        let s = si as usize;
        if self.structs[s].hit_flash > 0.0 {
            self.structs[s].hit_flash -= dt;
        }
        if self.structs[s].ruined || self.structs[s].owner == NONE {
            return;
        }
        let owner = self.structs[s].owner;
        let (x, y, r) = (self.structs[s].x, self.structs[s].y, self.structs[s].r);
        // 训练
        if !self.structs[s].queue.is_empty() {
            self.structs[s].queue[0].t += dt;
            let q = self.structs[s].queue[0];
            if q.t >= q.total {
                self.structs[s].queue.remove(0);
                let sq = self.spawn_squad(owner, q.typ, q.tier, x, y + r + 14.0, 0);
                // 出生后站到据点两侧（让开下方的建造木牌），一侧排满就排另一侧
                let spot = self.stand_spot(si);
                self.set_path(sq, spot.0, spot.1);
                self.squads[sq as usize].order = Order::Move;
                let id = self.squads[sq as usize].id;
                self.ev(EV_SPAWN, owner, 0, x, y, id as f64);
                self.recount();
            }
        }
        // 守军出击 / 箭塔
        self.structs[s].shot_cd -= dt;
        let typ = self.structs[s].typ;
        let (shot, shot_cd, shot_r0) = { let sd = &self.d.structs[typ]; (sd.shot, sd.shot_cd, sd.shot_r) };
        let watch = self.structs[s].addons.contains(&self.ids.watch);
        let shot_r = (if shot_r0 != 0.0 { shot_r0 } else { SHOT_R }) + if watch { 30.0 } else { 0.0 };
        let threat = if self.structs[s].shot_cd <= 0.0 || !self.structs[s].garrison.is_empty() { self.nearest_hostile(x, y, owner, SORTIE_R.max(shot_r)) } else { None };
        if let Some(th) = threat {
            if !self.structs[s].garrison.is_empty() {
                let g = self.structs[s].garrison.clone();
                let tref = self.unit_ref(th);
                for sq in g {
                    self.exit_struct(sq);
                    let q = &mut self.squads[sq as usize];
                    q.order = Order::Defend;
                    q.home = Home::Struct(si);
                    q.quiet_t = 0.0;
                    q.engaged = tref;
                    q.scan = 0.0;
                }
                self.ev(EV_SORTIE, owner, 0, x, y, 0.0);
            }
        }
        if self.structs[s].shot_cd <= 0.0 {
            self.structs[s].shot_cd = if shot_cd != 0.0 { shot_cd } else { 1.4 };
            if let Some(th) = threat {
                let (thx, thy) = (self.units[th as usize].x, self.units[th as usize].y);
                if (thx - x).jhypot(thy - y) < shot_r {
                    let walls = self.owners[owner as usize].tech[self.ids.walls] as f64;
                    let dmg = shot * (1.0 + 0.5 * self.structs[s].level as f64) * (if watch { 2.0 } else { 1.0 }) * (1.0 + 0.2 * walls);
                    let faction = self.owners[owner as usize].faction as u8;
                    let tref = self.unit_ref(th);
                    self.proj.push(Proj { k: 0, owner, x, y: y - r, sx: x, sy: y - r, tx: thx, ty: thy, tgt: tref, st: None, t: 0.0, dur: 0.35, dmg, typ: DMG_PIERCE, splash: 0.0, slow_hit: 0.0, lust: false, faction, done: false });
                }
            }
        }
        // 回血
        let t = self.t;
        let st = &mut self.structs[s];
        if t - st.last_hit > 6.0 {
            st.hp = st.max_hp.min(st.hp + 4.0 * dt * (1.0 + st.level as f64 * 0.5));
        }
        for gi in 0..self.structs[s].garrison.len() {
            let sq = self.structs[s].garrison[gi] as usize;
            for k in 0..self.squads[sq].units.len() {
                let u = &mut self.units[self.squads[sq].units[k] as usize];
                u.hp = u.max.min(u.hp + 5.0 * dt);
            }
        }
    }

    fn update_projectiles(&mut self, dt: f64) {
        let mut list = std::mem::take(&mut self.scratch);
        for pi in 0..self.proj.len() {
            let live = self.live_unit(self.proj[pi].tgt);
            let p = &mut self.proj[pi];
            p.t += dt;
            if let Some(ti) = live {
                if p.k != 1 {
                    p.tx = self.units[ti as usize].x;
                    p.ty = self.units[ti as usize].y;
                }
            }
            let k = (p.t / p.dur).min(1.0);
            p.x = p.sx + (p.tx - p.sx) * k;
            p.y = p.sy + (p.ty - p.sy) * k;
            if k < 1.0 {
                continue;
            }
            p.done = true;
            let (tx, ty, splash, owner, dmg, typ, slow_hit, kk, faction, pst) = (p.tx, p.ty, p.splash, p.owner, p.dmg, p.typ, p.slow_hit, p.k, p.faction, p.st);
            if splash != 0.0 {
                self.in_radius(tx, ty, splash, &mut list);
                for &oi in &list {
                    let o = &self.units[oi as usize];
                    if o.owner == owner {
                        continue;
                    }
                    let near = (o.x - tx).jhypot(o.y - ty) / splash;
                    self.hurt_unit(oi, dmg * (1.0 - near * 0.5), typ, slow_hit);
                }
                for si in 0..self.structs.len() {
                    let s = &self.structs[si];
                    if (s.x - tx).jhypot(s.y - ty) < s.r + splash {
                        self.hurt_struct(si as u32, owner);
                    }
                }
                self.fx(if kk == 1 { FX_BOOM } else { FX_BURST }, faction + 1, tx, ty, splash, 0.5);
                self.ev(EV_IMPACT, NONE, kk, tx, ty, 0.0);
            } else if let Some(si) = pst {
                self.hurt_struct(si, owner);
            } else if let Some(ti) = live {
                self.hurt_unit(ti, dmg, typ, slow_hit);
            }
        }
        self.scratch = list;
        self.proj.retain(|p| !p.done);
    }

    fn every_second(&mut self) {
        // 收入
        for si in 0..self.structs.len() {
            let st = &self.structs[si];
            if st.owner == NONE || st.ruined {
                continue;
            }
            let def = &self.d.structs[st.typ];
            let mut g = def.gold;
            let mut m = def.mana;
            for &a in &st.addons {
                if a == 0 {
                    continue;
                }
                let ad = &self.d.addons[a as usize - 1];
                if ad.has_income {
                    g += ad.inc_gold;
                    m += ad.inc_mana;
                }
            }
            let cap = self.d.mana_cap;
            let tax = self.ids.tax;
            let o = &mut self.owners[st.owner as usize];
            o.gold += g * o.income * (1.0 + 0.1 * o.tech[tax] as f64);
            o.mana = cap.min(o.mana + m * o.income);
        }
        let (cap, base) = (self.d.mana_cap, self.d.mana_base);
        let mut ids = vec![0u8];
        ids.extend_from_slice(&self.foe_ids);
        for id in ids {
            let o = &mut self.owners[id as usize];
            if o.alive && o.structs > 0 {
                o.mana = cap.min(o.mana + base * if o.ai { o.income } else { 1.0 });
            }
        }
        // 宝箱
        let mut list = std::mem::take(&mut self.scratch);
        for ci in 0..self.chests.len() {
            if self.chests[ci].taken {
                continue;
            }
            let (cx, cy, gold) = (self.chests[ci].x, self.chests[ci].y, self.chests[ci].gold);
            let n_owner = self.n_owner;
            let guarded = self.order.iter().any(|&o| {
                let q = &self.squads[o as usize];
                q.owner == n_owner && !q.units.is_empty() && (q.x - cx).jhypot(q.y - cy) < 150.0
            });
            if guarded {
                continue;
            }
            self.in_radius(cx, cy, 34.0, &mut list);
            let taker = list.iter().map(|&ui| self.units[ui as usize].owner).find(|&o| o != n_owner);
            if let Some(tk) = taker {
                self.chests[ci].taken = true;
                self.owners[tk as usize].gold += gold;
                self.ev(EV_CHEST, tk, 0, cx, cy, gold);
            }
        }
        self.scratch = list;
        // 兜底：行军中 4 秒没挪窝就从队伍重心重新寻路
        for k in 0..self.order.len() {
            let sq = self.order[k];
            let s = sq as usize;
            if self.squads[s].inside.is_some() || self.squads[s].fighting || self.squads[s].units.is_empty() {
                self.squads[s].stuck = 0;
                continue;
            }
            let (qx, qy) = (self.squads[s].x, self.squads[s].y);
            let moved = match self.squads[s].last {
                None => true,
                Some((lx, ly)) => (qx - lx).jhypot(qy - ly) > 4.0,
            };
            self.squads[s].last = Some((qx, qy));
            let wants = !self.squads[s].path.is_empty() || self.squads[s].order == Order::Attack;
            if !wants || moved || self.squads[s].sieging.is_some() {
                self.squads[s].stuck = 0;
                continue;
            }
            self.squads[s].stuck += 1;
            if self.squads[s].stuck >= 4 {
                self.squads[s].stuck = 0;
                let mut cx = 0.0;
                let mut cy = 0.0;
                for &ui in &self.squads[s].units {
                    cx += self.units[ui as usize].x;
                    cy += self.units[ui as usize].y;
                }
                let n = self.squads[s].units.len() as f64;
                self.squads[s].x = cx / n;
                self.squads[s].y = cy / n;
                if let Some(ti) = self.squads[s].target {
                    let (tx, ty) = (self.structs[ti as usize].x, self.structs[ti as usize].y);
                    self.set_path(sq, tx, ty);
                } else if let Some((gx, gy)) = self.squads[s].goal {
                    self.set_path(sq, gx, gy);
                }
            }
        }
        // 防守部队离家超过范围就回
        for k in 0..self.order.len() {
            let sq = self.order[k];
            let s = sq as usize;
            if self.squads[s].order != Order::Defend || self.squads[s].fighting {
                continue;
            }
            if let Home::Struct(hi) = self.squads[s].home {
                let (hx, hy) = (self.structs[hi as usize].x, self.structs[hi as usize].y);
                if (hx - self.squads[s].x).jhypot(hy - self.squads[s].y) > 40.0 && self.squads[s].path.is_empty() {
                    self.set_path(sq, hx, hy);
                }
            }
        }
        self.recount();
        // 压力测试不判胜负
    }
}
