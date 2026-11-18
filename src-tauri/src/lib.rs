use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Response;
use tauri::{State, WebviewUrl, WebviewWindowBuilder};

// ---------------------------------------------------------------------------
// 模拟后端：战斗模拟（simcore，game/js/sim.js 的 Rust 移植）跑在一个原生线程里，
// 页面每个模拟步经 IPC 取一份二进制快照去画。这是外壳“除了开窗口之外”真正干活的地方，
// 也是对比实验里 Tauri 独有的那条路径：Rust 计算 + Rust↔JS 传数据。
// ---------------------------------------------------------------------------

struct Shared {
    /// 已编码、还没被取走的快照，按模拟步先后排队
    queue: VecDeque<Vec<u8>>,
    running: bool,
    /// 每次 sim_start 加一，旧线程发现代数变了就退出
    epoch: u64,
    /// 正在等快照的请求数。页面一次只挂一个请求时，这就是“页面在等下一步”；
    /// 页面同时挂几个（流水线）时，模拟线程每算完一步就编码一份，直到排队的份数够分
    waiters: u32,
}

struct SimState {
    shared: Arc<(Mutex<Shared>, Condvar)>,
}

/// 建世界并启动模拟线程。init 是页面用 CS.benchInit() 导出的规则表 + 地图 + 开局参数。
#[tauri::command(async)]
fn sim_start(state: State<'_, SimState>, init: serde_json::Value) -> Result<(), String> {
    let mut world = simcore::World::new(&init)?;
    let shared = state.shared.clone();
    let epoch = {
        let mut s = shared.0.lock().unwrap();
        s.epoch += 1;
        s.running = true;
        s.queue.clear();
        s.epoch
    };
    std::thread::Builder::new()
        .name("sim".into())
        .spawn(move || {
            let step = world.d.step;
            let mut acc = 0.0f64;
            let mut last = Instant::now();
            let mut step_ms = 0.0f64;
            loop {
                {
                    let s = shared.0.lock().unwrap();
                    if !s.running || s.epoch != epoch {
                        break;
                    }
                }
                // 和页面主循环同样的固定步长：按实时累积，落后时一次最多追 10 步
                let now = Instant::now();
                acc += now.duration_since(last).as_secs_f64().min(0.25);
                last = now;
                let mut n = 0;
                while acc >= step && n < 10 {
                    let t0 = Instant::now();
                    world.bench_spawn();
                    world.step();
                    world.ai_tick();
                    step_ms = t0.elapsed().as_secs_f64() * 1000.0;
                    acc -= step;
                    n += 1;
                }
                if n == 10 {
                    acc = 0.0;
                }
                if n > 0 {
                    // 只有有人在等、而且排队的份数还不够分时才编码；没人取的步，事件和特效攒在 world 里，下次一起带走。
                    // 每份快照只交给一个请求，所以事件不会重复也不会丢
                    let mut s = shared.0.lock().unwrap();
                    if (s.waiters as usize) > s.queue.len() {
                        let buf = world.encode_snapshot(step_ms);
                        s.queue.push_back(buf);
                        shared.1.notify_all();
                    }
                }
                let wait = (step - acc).max(0.0);
                if wait > 0.0005 {
                    std::thread::sleep(Duration::from_secs_f64(wait - 0.0005));
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 取下一份快照：排队里有就直接拿最早的一份，没有就阻塞到模拟线程算完下一步（最多等 250ms），以二进制响应返回。
/// 超时或模拟已停时返回空响应，页面会再问一次。页面可以同时挂多个请求（流水线），每份快照只交给其中一个。
#[tauri::command(async)]
fn sim_snap(state: State<'_, SimState>, after: u32) -> Response {
    let _ = after;
    let (lock, cv) = &*state.shared;
    let t0 = Instant::now();
    let mut s = lock.lock().unwrap();
    if !s.running {
        return Response::new(Vec::new());
    }
    s.waiters += 1;
    let (mut s, _) = cv.wait_timeout_while(s, Duration::from_millis(250), |s| s.queue.is_empty() && s.running).unwrap();
    s.waiters -= 1;
    match s.queue.pop_front() {
        Some(mut buf) => {
            // 头部第 15 个字：这次请求等了多久（页面用“往返时间 − 等待时间”算出纯传输耗时）
            let wait = (t0.elapsed().as_secs_f64() * 1000.0) as f32;
            let off = simcore::snapshot::WAIT_MS_OFFSET;
            buf[off..off + 4].copy_from_slice(&wait.to_le_bytes());
            Response::new(buf)
        }
        None => Response::new(Vec::new()),
    }
}

#[tauri::command]
fn sim_stop(state: State<'_, SimState>) {
    let (lock, cv) = &*state.shared;
    let mut s = lock.lock().unwrap();
    s.running = false;
    s.queue.clear();
    cv.notify_all();
}

// ---------------------------------------------------------------------------
// IPC 基准：不带任何模拟，只测“一段数据过一次 Rust↔JS 边界要多久”
// ---------------------------------------------------------------------------

/// 返回 size 字节的二进制（走二进制响应，页面拿到的是 ArrayBuffer）
#[tauri::command(async)]
fn ipc_blob(size: usize) -> Response {
    let mut v = vec![0u8; size.min(64 << 20)];
    for (i, b) in v.iter_mut().enumerate() {
        *b = i as u8;
    }
    Response::new(v)
}

/// 返回 n 个数的 JSON 数组（走默认的 JSON 序列化，页面要 JSON.parse）
#[tauri::command(async)]
fn ipc_json(n: usize) -> Vec<f32> {
    (0..n.min(16 << 20)).map(|i| i as f32 * 0.5).collect()
}

/// 页面 → Rust：收一段二进制，返回收到的字节数
#[tauri::command(async)]
fn ipc_sink(request: tauri::ipc::Request<'_>) -> usize {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.len(),
        tauri::ipc::InvokeBody::Json(v) => v.to_string().len(),
    }
}

// 窗口在这里创建（而不是写在 tauri.conf.json 里），这样对比实验可以用环境变量控制：
//   CS_URL    让外壳加载外部地址（跑旧版基线时用，默认加载内嵌的 game/index.html）
//   CS_QUERY  传给页面的参数串，页面从 window.__CS_QUERY 读取（等价于 location.search）
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SimState { shared: Arc::new((Mutex::new(Shared { queue: VecDeque::new(), running: false, epoch: 0, waiters: 0 }), Condvar::new())) })
        .invoke_handler(tauri::generate_handler![sim_start, sim_snap, sim_stop, ipc_blob, ipc_json, ipc_sink])
        .setup(|app| {
            let url = match std::env::var("CS_URL") {
                Ok(u) if !u.is_empty() => {
                    WebviewUrl::External(u.parse::<tauri::Url>().expect("CS_URL 不是合法地址"))
                }
                _ => WebviewUrl::App("index.html".into()),
            };
            let query: String = std::env::var("CS_QUERY")
                .unwrap_or_default()
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || "=&:/.,_-%?".contains(*c))
                .collect();
            let mut builder = WebviewWindowBuilder::new(app, "main", url)
                .title("城邦演武")
                .inner_size(1360.0, 900.0)
                .min_inner_size(1024.0, 680.0)
                .center();
            if !query.is_empty() {
                builder = builder
                    .initialization_script(&format!("window.__CS_QUERY = \"{}\";", query));
            }
            builder.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
