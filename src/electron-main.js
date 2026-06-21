import { app, BrowserWindow, clipboard, Menu, nativeImage, shell, Tray } from "electron";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

let tray = null;
let server = null;
let setupWindow = null;
let dashboardWindow = null;
let port = 8787;
let startLiquidStatsServer = null;

const instanceLock = app.requestSingleInstanceLock();
if (!instanceLock) {
  app.quit();
}

app.setName("UsageView");

app.whenReady().then(async () => {
  const dataDir = join(app.getPath("userData"), "data");
  mkdirSync(dataDir, { recursive: true });
  process.env.LIQUID_STATS_DATA_DIR = dataDir;
  process.env.PORT = String(await firstFreePort(8787, 8799));
  ({ startLiquidStatsServer } = await import("./server.js"));

  const started = await startLiquidStatsServer({ port: Number(process.env.PORT), host: "0.0.0.0" });
  server = started.server;
  port = started.port;

  createTray();
  openSetup();
});

app.on("second-instance", () => {
  openSetup();
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.on("before-quit", () => {
  if (server) server.close();
});

function createTray() {
  const icon = nativeImage.createFromPath(resolve(app.getAppPath(), "assets", "app-icon.ico"));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("UsageView");
  tray.setContextMenu(buildMenu());
  tray.on("double-click", openSetup);
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: "Open Dashboard", click: openDashboard },
    { label: "Open Setup", click: openSetup },
    { label: "Copy Display URL", click: copyDisplayUrl },
    { type: "separator" },
    { label: "Restart", click: restartServer },
    { label: "Quit", click: () => app.quit() },
  ]);
}

function localUrl(path = "") {
  return `http://127.0.0.1:${port}${path}`;
}

function openDashboard() {
  dashboardWindow = openAppWindow(dashboardWindow, {
    title: "UsageView Dashboard",
    url: localUrl("/"),
    width: 760,
    height: 560,
    minWidth: 360,
    minHeight: 420,
  });
}

function openSetup() {
  setupWindow = openAppWindow(setupWindow, {
    title: "UsageView Setup",
    url: localUrl("/setup"),
    width: 760,
    height: 760,
    minWidth: 420,
    minHeight: 540,
  });
}

function openAppWindow(existing, options) {
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }

  const icon = resolve(app.getAppPath(), "assets", "app-icon.ico");
  const win = new BrowserWindow({
    title: options.title,
    width: options.width,
    height: options.height,
    minWidth: options.minWidth,
    minHeight: options.minHeight,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#030304",
    icon,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(localUrl("/"))) return;
    event.preventDefault();
    shell.openExternal(url);
  });
  win.on("closed", () => {
    if (win === setupWindow) setupWindow = null;
    if (win === dashboardWindow) dashboardWindow = null;
  });
  win.loadURL(options.url);
  return win;
}

async function copyDisplayUrl() {
  try {
    const response = await fetch(localUrl("/api/setup/status"));
    const status = await response.json();
    clipboard.writeText(status.networkUrls?.[0]?.keyedUrl || localUrl("/"));
  } catch {
    clipboard.writeText(localUrl("/"));
  }
}

async function restartServer() {
  if (server) {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
  const started = await startLiquidStatsServer({ port, host: "0.0.0.0" });
  server = started.server;
  tray?.setContextMenu(buildMenu());
  setupWindow?.loadURL(localUrl("/setup"));
  dashboardWindow?.loadURL(localUrl("/"));
}

function firstFreePort(start, end) {
  const check = (candidate) =>
    new Promise((resolveCheck) => {
      const tester = createServer();
      tester.once("error", () => resolveCheck(false));
      tester.once("listening", () => tester.close(() => resolveCheck(true)));
      tester.listen(candidate, "127.0.0.1");
    });

  return (async () => {
    for (let candidate = start; candidate <= end; candidate += 1) {
      if (await check(candidate)) return candidate;
    }
    return start;
  })();
}
