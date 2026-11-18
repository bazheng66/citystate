//! 无界面跑 Rust 版模拟，用来和 JS 版对拍（tools/rustcheck.js 调用）。
//!   simcheck <init.json> <步数> [--series] [--snap 输出文件] [--exact]
use simcore::World;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("用法：simcheck <init.json> <步数> [--series] [--snap 文件]");
        std::process::exit(2);
    }
    let steps: u32 = args[2].parse().expect("步数");
    let series = args.iter().any(|a| a == "--series");
    if args.iter().any(|a| a == "--exact") {
        simcore::jsmath::TEST_TRIG.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    let snap = args.iter().position(|a| a == "--snap").and_then(|i| args.get(i + 1)).cloned();
    let text = std::fs::read_to_string(&args[1]).expect("读不到初始化文件");
    let init: serde_json::Value = serde_json::from_str(&text).expect("初始化文件不是合法 JSON");
    let t0 = Instant::now();
    let mut w = World::new(&init).expect("建世界失败");
    let init_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let n = w.bench.n as f64;
    let mut ev = [0u64; 18];
    let mut times: Vec<f64> = Vec::new();
    let mut peak = 0u32;
    for i in 0..steps {
        let a = Instant::now();
        w.bench_spawn();
        w.step();
        w.ai_tick();
        let ms = a.elapsed().as_secs_f64() * 1000.0;
        for e in &w.events {
            ev[e.e as usize] += 1;
        }
        peak = peak.max(w.soldier_count);
        if w.soldier_count as f64 >= n * 0.95 {
            times.push(ms);
        }
        if series && w.tick % 30 == 0 {
            let gold: f64 = w.owners.iter().map(|o| o.gold).sum();
            let fighting = w.order.iter().filter(|&&q| w.squads[q as usize].fighting).count();
            let inside = w.order.iter().filter(|&&q| w.squads[q as usize].inside.is_some()).count();
            let owned = w.structs.iter().filter(|s| !s.ruined).count();
            println!("S {} {} {} {} {} {} {} {} {} {} {} {} {:.0}", w.tick, w.soldier_count, w.order.len(), w.proj.len(), w.effects.len(), fighting, inside, owned, ev[0], ev[1], ev[2], ev[5], gold);
        }
        if i + 1 < steps || snap.is_none() {
            w.events.clear();
            w.new_fx.clear();
        }
    }
    if let Some(path) = snap {
        let buf = w.encode_snapshot(0.0);
        std::fs::write(&path, &buf).expect("写快照失败");
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let avg = times.iter().sum::<f64>() / times.len().max(1) as f64;
    let p95 = times.get((times.len() as f64 * 0.95) as usize).copied().unwrap_or(0.0);
    println!(
        "R {{\"soldiers\":{},\"peak\":{},\"squads\":{},\"steps\":{},\"fullSteps\":{},\"avgStepMs\":{:.3},\"p95StepMs\":{:.3},\"initMs\":{:.1},\"pathCalls\":{},\"tick\":{}}}",
        w.soldier_count, peak, w.order.len(), steps, times.len(), avg, p95, init_ms, w.path_calls, w.tick
    );
}
