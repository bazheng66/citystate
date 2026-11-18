//! 8 向 A*，对应 game/js/map.js 的 findPath / nearestFree。
//! JS 里 gScore 和堆的键是 Float32Array，这里同样用 f32 存，保证展开顺序和选出的路线一致。

use crate::world::World;

pub(crate) struct PathBuf {
    heap_f: Vec<f32>,
    g_score: Vec<f32>,
    came: Vec<i32>,
    stamp: Vec<u32>,
    closed: Vec<u32>,
    gen: u32,
    open: Vec<u32>,
}

impl PathBuf {
    pub fn new(n: usize) -> Self {
        PathBuf { heap_f: vec![0.0; n], g_score: vec![0.0; n], came: vec![0; n], stamp: vec![0; n], closed: vec![0; n], gen: 1, open: Vec::new() }
    }
}

impl World {
    fn nearest_free(&self, c: i64, r: i64) -> (i64, i64) {
        let cols = self.cols as i64;
        let rows = self.rows as i64;
        let c = c.clamp(0, cols - 1);
        let r = r.clamp(0, rows - 1);
        if self.blocked[(r * cols + c) as usize] == 0 {
            return (c, r);
        }
        for rad in 1..16i64 {
            for dr in -rad..=rad {
                for dc in -rad..=rad {
                    if dc.abs().max(dr.abs()) != rad {
                        continue;
                    }
                    let nc = c + dc;
                    let nr = r + dr;
                    if nc < 0 || nr < 0 || nc >= cols || nr >= rows {
                        continue;
                    }
                    if self.blocked[(nr * cols + nc) as usize] == 0 {
                        return (nc, nr);
                    }
                }
            }
        }
        (c, r)
    }

    /// 返回拉直后的像素路点；找不到路返回 None
    pub fn find_path(&mut self, sx: f64, sy: f64, gx: f64, gy: f64) -> Option<Vec<(f64, f64)>> {
        self.path_calls += 1;
        let cols = self.cols as i64;
        let rows = self.rows as i64;
        let tile = self.d.tile;
        let (sc, sr) = self.nearest_free((sx / tile).floor() as i64, (sy / tile).floor() as i64);
        let (gc, gr) = self.nearest_free((gx / tile).floor() as i64, (gy / tile).floor() as i64);
        let start = (sr * cols + sc) as usize;
        let goal = (gr * cols + gc) as usize;
        let mut pb = std::mem::replace(&mut self.pbuf, PathBuf::new(0));
        pb.gen += 1;
        let gen = pb.gen;
        pb.open.clear();
        pb.open.push(start as u32);
        pb.stamp[start] = gen;
        pb.g_score[start] = 0.0;
        pb.heap_f[start] = 0.0;
        pb.came[start] = -1;
        let mut found = start == goal;
        while !pb.open.is_empty() && !found {
            // 二叉堆：取出堆顶
            let cur = pb.open[0] as usize;
            let last = pb.open.pop().unwrap();
            if !pb.open.is_empty() {
                pb.open[0] = last;
                let mut i = 0usize;
                loop {
                    let l = i * 2 + 1;
                    let r = l + 1;
                    let mut m = i;
                    if l < pb.open.len() && pb.heap_f[pb.open[l] as usize] < pb.heap_f[pb.open[m] as usize] {
                        m = l;
                    }
                    if r < pb.open.len() && pb.heap_f[pb.open[r] as usize] < pb.heap_f[pb.open[m] as usize] {
                        m = r;
                    }
                    if m == i {
                        break;
                    }
                    pb.open.swap(i, m);
                    i = m;
                }
            }
            if pb.closed[cur] == gen {
                continue;
            }
            pb.closed[cur] = gen;
            if cur == goal {
                found = true;
                break;
            }
            let c = cur as i64 % cols;
            let r = cur as i64 / cols;
            for dr in -1..=1i64 {
                for dc in -1..=1i64 {
                    if dc == 0 && dr == 0 {
                        continue;
                    }
                    let nc = c + dc;
                    let nr = r + dr;
                    if nc < 0 || nr < 0 || nc >= cols || nr >= rows {
                        continue;
                    }
                    let k = (nr * cols + nc) as usize;
                    if self.blocked[k] != 0 {
                        continue;
                    }
                    let diag = dc != 0 && dr != 0;
                    if diag && (self.blocked[(r * cols + nc) as usize] != 0 || self.blocked[(nr * cols + c) as usize] != 0) {
                        continue;
                    }
                    let g = pb.g_score[cur] as f64 + if diag { 1.4142 } else { 1.0 };
                    if pb.stamp[k] != gen || g < pb.g_score[k] as f64 {
                        pb.stamp[k] = gen;
                        pb.g_score[k] = g as f32;
                        pb.came[k] = cur as i32;
                        let hc = (nc - gc).abs() as f64;
                        let hr = (nr - gr).abs() as f64;
                        // 启发值略微放大：大地图上少展开很多格，路线只差一点点
                        pb.heap_f[k] = (g + ((hc + hr) + (1.4142 - 2.0) * hc.min(hr)) * 1.08) as f32;
                        pb.open.push(k as u32);
                        let mut i = pb.open.len() - 1;
                        while i > 0 {
                            let p = (i - 1) >> 1;
                            if pb.heap_f[pb.open[p] as usize] <= pb.heap_f[pb.open[i] as usize] {
                                break;
                            }
                            pb.open.swap(i, p);
                            i = p;
                        }
                    }
                }
            }
        }
        if !found {
            self.pbuf = pb;
            return None;
        }
        let mut cells = Vec::new();
        let mut k = goal as i32;
        while k != -1 {
            cells.push(k as i64);
            k = pb.came[k as usize];
        }
        self.pbuf = pb;
        cells.reverse();
        let mut pts: Vec<(f64, f64)> = cells.iter().map(|&k| (((k % cols) as f64 + 0.5) * tile, ((k / cols) as f64 + 0.5) * tile)).collect();
        pts[0] = (sx, sy);
        if !self.blocked_at(gx, gy) {
            let n = pts.len();
            pts[n - 1] = (gx, gy);
        }
        // 拉直（每次最多往前看 40 个路点）
        let mut out = Vec::new();
        let mut i = 0usize;
        while i < pts.len() - 1 {
            let mut j = (pts.len() - 1).min(i + 40);
            while j > i + 1 && !self.line_clear(pts[i].0, pts[i].1, pts[j].0, pts[j].1) {
                j -= 1;
            }
            out.push(pts[j]);
            i = j;
        }
        Some(out)
    }
}
