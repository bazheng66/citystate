/// 和 game/js/map.js 里的 rng() 完全一致（mulberry32），保证两边的随机数序列逐个相同。
pub struct Rng {
    a: u32,
}

impl Rng {
    pub fn new(seed: u32) -> Self {
        Rng { a: seed }
    }

    #[inline]
    pub fn next(&mut self) -> f64 {
        self.a = self.a.wrapping_add(0x6d2b_79f5);
        let a = self.a;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}
