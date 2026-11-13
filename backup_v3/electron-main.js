const { app, BrowserWindow, Menu } = require("electron");
const path = require("path");

const gameDir = app.isPackaged
  ? path.join(process.resourcesPath, "game")
  : path.join(__dirname, "..", "game");

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
    },
  });
  win.loadFile(path.join(gameDir, "index.html"));
});

app.on("window-all-closed", () => app.quit());
