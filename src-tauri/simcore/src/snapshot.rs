//! 快照编码：把一个模拟步结束时画面需要的状态打包成二进制。
//! 格式和 game/js/snap.js 的 encode() 逐字对应（主线程用同一个 apply() 解码两种后端的快照）。
//!   头部 16 字 | 归属方 ×6 | 据点 ×10 | 部队 ×8 | 士兵 ×6 | 飞行物 ×9 | 法术区域 ×6 | 新特效 ×6 | 新事件 ×4 | 宝箱 ×1

use crate::data::KIND_AREA;
use crate::world::*;

pub const MAGIC: u32 = 0x3153_5343; // "CSS1"
/// 头部第 15 个字（从 0 数）是“这次请求在后端等了多久”，由取快照的一方在发出前填
pub const WAIT_MS_OFFSET: usize = 15 * 4;

#[inline]
fn f(v: f64) -> u32 {
    (v as f32).to_bits()
}

impl World {
    /// 编码并清空“自上次快照以来”的事件和特效
    pub fn encode_snapshot(&mut self, step_ms: f64) -> Vec<u8> {
        let n_sq = self.order.len();
        let mut n_units = 0usize;
        for &q in &self.order {
            let sq = &self.squads[q as usize];
            if sq.inside.is_none() {
                n_units += sq.units.len();
            }
        }
        let words = 16 + self.owners.len() * 6 + self.structs.len() * 10 + n_sq * 8 + n_units * 6 + self.proj.len() * 9 + self.effects.len() * 6 + self.new_fx.len() * 6 + self.events.len() * 4 + self.chests.len();
        let mut w: Vec<u32> = Vec::with_capacity(words);
        w.extend_from_slice(&[
            MAGIC,
            self.tick,
            f(self.t),
            self.soldier_count,
            n_sq as u32,
            n_units as u32,
            self.structs.len() as u32,
            self.proj.len() as u32,
            self.effects.len() as u32,
            self.new_fx.len() as u32,
            self.events.len() as u32,
            self.owners.len() as u32,
            self.chests.len() as u32,
            f(self.perf_sim),
            f(step_ms),
            0,
        ]);
        for o in &self.owners {
            let mut tech = 0u32;
            for (i, &lv) in o.tech.iter().enumerate() {
                tech |= (lv & 3) << (i * 2);
            }
            w.extend_from_slice(&[f(o.gold), f(o.mana), o.supply as u32, o.used as u32, (o.structs & 0xfff) | ((o.towers & 0x3f) << 12) | ((o.alive as u32) << 20), tech]);
        }
        for st in &self.structs {
            let mut addons = 0u32;
            for i in 0..3 {
                addons |= (st.addons[i] as u32) << (i * 3);
            }
            let own = if st.owner == NONE { 0 } else { st.owner as u32 + 1 };
            let rb = if st.rebuilder == NONE { 0 } else { st.rebuilder as u32 + 1 };
            let q = st.queue.first();
            w.extend_from_slice(&[
                st.id,
                own | (st.level << 4) | ((st.ruined as u32) << 6) | (addons << 8) | (rb << 20) | ((st.queue.len().min(3) as u32) << 24),
                f(st.hp),
                f(st.max_hp),
                f(st.rebuild),
                f(st.last_hit),
                f(st.hit_flash.max(0.0)),
                q.map(|q| q.typ as u32 | ((q.tier as u32) << 8)).unwrap_or(0),
                f(q.map(|q| q.t).unwrap_or(0.0)),
                f(q.map(|q| q.total).unwrap_or(0.0)),
            ]);
        }
        for &q in &self.order {
            let sq = &self.squads[q as usize];
            let mut hp = 0.0;
            let mut max = 0.0;
            for &ui in &sq.units {
                let u = &self.units[ui as usize];
                hp += if u.hp > 0.0 { u.hp } else { 0.0 };
                max += u.max;
            }
            w.extend_from_slice(&[
                sq.id,
                sq.owner as u32 | ((sq.typ as u32) << 4) | ((sq.tier as u32) << 8) | ((sq.fighting as u32) << 10),
                sq.inside.map(|si| self.structs[si as usize].id).unwrap_or(0),
                sq.units.len() as u32,
                f(sq.x),
                f(sq.y),
                f(hp),
                f(max),
            ]);
        }
        for &q in &self.order {
            let sq = &self.squads[q as usize];
            if sq.inside.is_some() {
                continue;
            }
            for &ui in &sq.units {
                let u = &self.units[ui as usize];
                let atk = if u.atk > 0.0 { ((u.atk / 0.22) * 255.0).round().min(255.0) as u32 } else { 0 };
                let hit = if u.hit_t > 0.0 { ((u.hit_t / 0.12) * 255.0).round().min(255.0) as u32 } else { 0 };
                let flags = (u.face > 0) as u32 | ((u.moving as u32) << 1) | (((u.stun > 0.0) as u32) << 2) | (((u.slow_t > 0.0) as u32) << 3) | ((u.lust as u32) << 4) | (((u.frost_slow < 1.0) as u32) << 5);
                w.extend_from_slice(&[f(u.x), f(u.y), f(u.px), f(u.py), f(u.step), atk | (hit << 8) | ((u.i & 255) << 16) | (flags << 24)]);
            }
        }
        for p in &self.proj {
            w.extend_from_slice(&[f(p.x), f(p.y), f(p.sx), f(p.sy), f(p.tx), f(p.ty), f(p.t), f(p.dur), p.k as u32 | ((p.faction as u32) << 8)]);
        }
        for ef in &self.effects {
            w.extend_from_slice(&[ef.key as u32 | ((ef.owner as u32) << 8) | (((ef.kind == KIND_AREA) as u32) << 16), f(ef.x), f(ef.y), f(ef.r), f(ef.start), f(ef.until)]);
        }
        for x in &self.new_fx {
            w.extend_from_slice(&[x.k as u32 | ((x.faction as u32) << 8), x.x.to_bits(), x.y.to_bits(), x.r.to_bits(), x.t.to_bits(), x.life.to_bits()]);
        }
        for e in &self.events {
            let own = if e.owner == NONE { 0 } else { e.owner as u32 + 1 };
            w.extend_from_slice(&[e.e as u32 | (own << 8) | ((e.sub as u32) << 16) | ((e.face as u32) << 24), e.x.to_bits(), e.y.to_bits(), e.extra.to_bits()]);
        }
        for c in &self.chests {
            w.push(c.taken as u32);
        }
        self.new_fx.clear();
        self.events.clear();
        debug_assert_eq!(w.len(), words);
        let mut out = Vec::with_capacity(w.len() * 4);
        for v in w {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out
    }
}
