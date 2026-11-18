//! 和 V8 对齐的几个数学函数。
//!
//! 加减乘除和开方在 IEEE 754 下两边天然一致；会差最后一位的是 hypot 和三角函数。
//! hypot 按 V8 的实现重写（先除以最大值再做 Kahan 求和），三角函数用 fdlibm 系的 libm。
//! 目的：让 Rust 版和 JS 版尽量逐步一致，对拍时能直接比数，而不只是“统计上差不多”。

use std::sync::atomic::{AtomicBool, Ordering};

/// 对拍用：打开后 sin / cos 换成下面这个只用加减乘除的简单实现（tools/rustcheck.js --exact 在 JS 那边换成同一个），
/// 这样两边没有任何“最后一位”的差别，能验证逻辑移植是否逐步等价。正常运行不开。
pub static TEST_TRIG: AtomicBool = AtomicBool::new(false);

const TWO_PI: f64 = 6.283185307179586;
const HALF_PI: f64 = 1.5707963267948966;

pub fn xsin(x: f64) -> f64 {
    let y = x - (x / TWO_PI + 0.5).floor() * TWO_PI;
    let y2 = y * y;
    let mut term = y;
    let mut sum = y;
    let mut k = 1.0;
    while k < 12.0 {
        term = -term * y2 / ((2.0 * k) * (2.0 * k + 1.0));
        sum += term;
        k += 1.0;
    }
    sum
}

pub trait JsMath {
    fn jhypot(self, other: f64) -> f64;
    fn jsin(self) -> f64;
    fn jcos(self) -> f64;
    fn jatan2(self, x: f64) -> f64;
}

impl JsMath for f64 {
    #[inline]
    fn jhypot(self, other: f64) -> f64 {
        let a = self.abs();
        let b = other.abs();
        let max = if b > a { b } else { a };
        if max == 0.0 {
            return 0.0;
        }
        let mut sum = 0.0;
        let mut comp = 0.0;
        for v in [a, b] {
            let n = v / max;
            let summand = n * n - comp;
            let prel = sum + summand;
            comp = (prel - sum) - summand;
            sum = prel;
        }
        sum.sqrt() * max
    }
    #[inline]
    fn jsin(self) -> f64 {
        if TEST_TRIG.load(Ordering::Relaxed) { xsin(self) } else { libm::sin(self) }
    }
    #[inline]
    fn jcos(self) -> f64 {
        if TEST_TRIG.load(Ordering::Relaxed) { xsin(self + HALF_PI) } else { libm::cos(self) }
    }
    #[inline]
    fn jatan2(self, x: f64) -> f64 {
        libm::atan2(self, x)
    }
}
