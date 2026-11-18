//! 打印一串确定性输入下 hypot / sin / cos / atan2 的结果位，给 tools/mathcheck.js 和 V8 逐个比对。
use simcore::jsmath::JsMath;
use simcore::rng::Rng;

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(200000);
    let mut r = Rng::new(12345);
    let mut out = String::with_capacity(n * 70);
    for _ in 0..n {
        let a = (r.next() - 0.5) * 4000.0;
        let b = (r.next() - 0.5) * 4000.0;
        let ang = (r.next() - 0.5) * 20.0;
        out.push_str(&format!("{:016x} {:016x} {:016x} {:016x}\n", a.jhypot(b).to_bits(), ang.jsin().to_bits(), ang.jcos().to_bits(), a.jatan2(b).to_bits()));
    }
    print!("{}", out);
}
