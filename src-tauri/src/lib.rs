use tauri::{WebviewUrl, WebviewWindowBuilder};

// 窗口在这里创建（而不是写在 tauri.conf.json 里），这样对比实验可以用环境变量控制：
//   CS_URL    让外壳加载外部地址（跑旧版基线时用，默认加载内嵌的 game/index.html）
//   CS_QUERY  传给页面的参数串，页面从 window.__CS_QUERY 读取（等价于 location.search）
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
