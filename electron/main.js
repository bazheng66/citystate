const { app, BrowserWindow, Menu } = require("electron");
const path = require("path");

const gameDir = app.isPackaged
  ? path.join(process.resourcesPath, "game")
  : path.join(__dirname, "..", "game");

// 对比实验用的环境变量，含义与 Tauri 外壳一致：
//   CS_URL   加载外部地址（跑旧版基线）    CS_QUERY  传给页面的参数串
//   CS_GAME  指定页面目录（默认 ../game）  CS_FLAGS  追加的 Chromium 开关，逗号分隔
const URL_OVERRIDE = process.env.CS_URL || "";
const QUERY = (process.env.CS_QUERY || "").replace(/^\?/, "");
for (const f of (process.env.CS_FLAGS || "").split(",").filter(Boolean)) {
  const [k, v] = f.replace(/^--/, "").split("=");
  app.commandLine.appendSwitch(k, v);
}

Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    useContentSize: true,
    center: true,
    title: "城邦演武",
    backgroundColor: "#140e09",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  if (URL_OVERRIDE) win.loadURL(URL_OVERRIDE);
  else win.loadFile(path.join(process.env.CS_GAME || gameDir, "index.html"), QUERY ? { search: QUERY } : undefined);
});

app.on("window-all-closed", () => app.quit());
