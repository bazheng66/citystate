//! 城邦演武战斗模拟的 Rust 移植。
//!
//! 逐函数对应 game/js/sim.js、ai.js 和 map.js 里的寻路部分：同样的固定步长、同样的空间哈希、
//! 同样的随机数发生器、同样的求值顺序。目的不是“写一个更快的算法”，而是“同一个算法换一种语言、
//! 换一个线程”，这样和 JS 版对比时，差别只来自语言和线程，不来自算法。
//!
//! 只覆盖压力测试会走到的路径（据点打不坏、全部归属由 AI 托管、敕令全为 0）。

pub mod data;
pub mod rng;
pub mod jsmath;
pub mod world;
mod path;
mod sim;
mod ai;
pub mod snapshot;

pub use world::World;
