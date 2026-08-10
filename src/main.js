"use strict";

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, globalShortcut } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { loadAppConfig, normalizeAppConfig, persistAppConfig, sourceConfigChanged } = require("./app-config-store");
const { CodexService } = require("./codex-service");
const { DashboardSnapshotStore } = require("./dashboard-snapshot-store");
const { readResetCredits } = require("./reset-credits-service");
const { normalizeHotkeys, findDuplicateHotkey } = require("./hotkey-config");
const { UsageCoordinator } = require("./usage-coordinator");
const { UsageWorkerClient } = require("./usage-worker-client");

// This lightweight dashboard has no WebGL/video workload. Software compositing avoids
// keeping a large GPU helper process resident while it waits in the tray.
app.disableHardwareAcceleration();

// These features are not used by the dashboard and can keep background helpers resident.
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("disable-speech-api");
app.commandLine.appendSwitch("disable-webrtc");

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});


// Configure portable userData directory inside project folder (D drive) instead of C drive
const appDir = app.isPackaged ? path.dirname(app.getPath("exe")) : app.getAppPath();
const userDataPath = path.join(appDir, ".userdata");
app.setPath("userData", userDataPath);
process.env.AI_QUOTA_USER_DATA_PATH = userDataPath;

const NORMAL_SIZE = { width: 760, height: 540 };
const COMPACT_SIZE = { width: 336, height: 72 };

const configPath = path.join(userDataPath, "config.json");
let appConfig = loadAppConfig(configPath);
const snapshotStore = new DashboardSnapshotStore({ userDataPath, getConfig: () => appConfig });
const usageWorkerClient = new UsageWorkerClient(path.join(__dirname, "usage-worker.js"));
const usageCoordinator = new UsageCoordinator({ workerClient: usageWorkerClient, getConfig: () => appConfig });

const codex = new CodexService();
let mainWindow = null;
let tray = null;
let isQuitting = false;
let isCompact = false;
let registeredHotkeys = {};
let backgroundIdleTimer = null;
const BACKGROUND_IDLE_MS = 30_000;

function toggleMainPanel() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  if (mainWindow.isVisible()) {
    mainWindow.hide();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

function cancelBackgroundIdle() {
  if (!backgroundIdleTimer) return;
  clearTimeout(backgroundIdleTimer);
  backgroundIdleTimer = null;
}

function scheduleBackgroundIdle() {
  cancelBackgroundIdle();
  backgroundIdleTimer = setTimeout(() => {
    backgroundIdleTimer = null;
    if (mainWindow?.isVisible()) return;
    codex.dispose();
    usageCoordinator.stop();
  }, BACKGROUND_IDLE_MS);
  backgroundIdleTimer.unref?.();
}

function toggleAlwaysOnTop() {
  if (!mainWindow) return false;
  const pinned = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(pinned);
  mainWindow.webContents.send("window:pinnedChanged", pinned);
  return pinned;
}

function hotkeyRegistrations(hotkeys) {
  return [
    [hotkeys.togglePanel, toggleMainPanel],
    [hotkeys.toggleCompact, () => resizeWindow(!isCompact)],
    [hotkeys.refresh, () => refreshAndPush().catch(() => {})],
    [hotkeys.togglePin, toggleAlwaysOnTop]
  ].filter(([accelerator]) => accelerator);
}

function registerGlobalShortcuts(rawHotkeys) {
  const hotkeys = normalizeHotkeys(rawHotkeys);
  const duplicate = findDuplicateHotkey(hotkeys);
  if (duplicate) return { ok: false, code: "duplicate", accelerator: duplicate };
  if (JSON.stringify(hotkeys) === JSON.stringify(registeredHotkeys)) {
    return { ok: true, hotkeys };
  }

  const previousHotkeys = registeredHotkeys;
  const registrations = hotkeyRegistrations(hotkeys);

  globalShortcut.unregisterAll();
  for (const [accelerator, handler] of registrations) {
    try {
      if (globalShortcut.register(accelerator, handler)) continue;
    } catch {}
    globalShortcut.unregisterAll();
    for (const [previous, previousHandler] of hotkeyRegistrations(previousHotkeys)) {
      try { globalShortcut.register(previous, previousHandler); } catch {}
    }
    return { ok: false, code: "unavailable", accelerator };
  }
  registeredHotkeys = hotkeys;
  return { ok: true, hotkeys };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...NORMAL_SIZE,
    minWidth: COMPACT_SIZE.width,
    minHeight: COMPACT_SIZE.height,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    transparent: true,
    skipTaskbar: true, // Hide application from Dock / Windows Taskbar
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("show", () => {
    cancelBackgroundIdle();
    if (appConfig.enableCodex) codex.ensureStarted().catch(() => {});
  });
  mainWindow.on("hide", scheduleBackgroundIdle);
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide(); // Hide the window instead of quitting when closed
    }
  });
}

function createTray() {
  const iconPath = path.join(app.getPath("userData"), "tray_icon.png");
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("AI 额度");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示 / 隐藏", click: toggleMainPanel },
      { label: "切换紧凑模式", click: () => resizeWindow(!isCompact) },
      { label: "切换置顶", click: toggleAlwaysOnTop },
      { label: "刷新数据", click: () => refreshAndPush().catch(() => {}) },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );

  // Toggle show/hide when tray icon is clicked
  tray.on("click", () => {
    toggleMainPanel();
  });
}


let cachedResetCredits = null;
let lastResetCreditsTime = 0;
let resetCreditsPending = null;
const RESET_CREDITS_CACHE_TTL = 5 * 60_000;
let snapshotInFlight = null;

async function readCachedResetCredits() {
  if (cachedResetCredits && Date.now() - lastResetCreditsTime < RESET_CREDITS_CACHE_TTL) {
    return cachedResetCredits;
  }
  if (resetCreditsPending) return resetCreditsPending;
  resetCreditsPending = readResetCredits()
    .then((credits) => {
      cachedResetCredits = credits;
      lastResetCreditsTime = Date.now();
      const cached = snapshotStore.getCached();
      if (cached) {
        const snapshot = { ...cached, resetCredits: credits, stale: false, updatedAt: Date.now() };
        snapshotStore.save(snapshot);
        mainWindow?.webContents.send("quota:updated", snapshot);
      }
      return credits;
    })
    .finally(() => {
      resetCreditsPending = null;
    });
  return resetCreditsPending;
}

async function readSnapshot() {
  const errors = [];
  let quota = null;
  let resetCredits = null;
  let localTokenUsage = null;
  let antigravityTokenUsage = null;
  let quotaError = null;

  const now = Date.now();
  const tokenUsageResults = Promise.allSettled([
    appConfig.enableAntigravity ? usageCoordinator.readAntigravityUsage(now) : Promise.resolve(null),
    usageCoordinator.enabledLocalSources().length ? usageCoordinator.readLocalUsage(now) : Promise.resolve(null)
  ]);

  if (appConfig.enableCodex) {
    quota = codex.getCachedQuota();
    // Reset-card data is auxiliary. Refresh it independently so a slow network
    // request cannot hold back quota and local token data on the first paint.
    readCachedResetCredits().catch(() => {});
    const quotaResult = await Promise.resolve(codex.readQuota()).then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason })
    );

    if (quotaResult.status === "fulfilled") {
      quota = quotaResult.value;
    } else {
      errors.push(quotaResult.reason.message);
      quotaError = quotaResult.reason.message;
    }
  }

  // Parse local logs in a worker so a large transcript cannot block Electron's main loop.
  const [antigravityResult, localResult] = await tokenUsageResults;
  resetCredits = cachedResetCredits;
  if (antigravityResult.status === "fulfilled") {
    antigravityTokenUsage = antigravityResult.value;
  } else {
    errors.push(antigravityResult.reason.message);
  }
  if (localResult.status === "fulfilled") {
    localTokenUsage = localResult.value;
    if (quota?.tokenStats && quota.tokenStats.total == null && localTokenUsage?.total != null) {
      quota = {
        ...quota,
        tokenStats: {
          ...quota.tokenStats,
          ...localTokenUsage,
          accountUsageError: quota.tokenStats.error ?? null,
          error: null
        }
      };
    }
  } else {
    errors.push(localResult.reason.message);
  }

  const snapshot = {
    quota,
    resetCredits,
    localTokenUsage,
    antigravityTokenUsage,
    config: appConfig,
    // 重置卡和本地统计是辅助信息；它们失败时不能把一份成功的额度读数标成“刷新失败”。
    error: quotaError,
    errors,
    updatedAt: Date.now()
  };
  snapshotStore.save(snapshot);
  return snapshot;
}

function readSnapshotOnce() {
  if (!snapshotInFlight) {
    snapshotInFlight = readSnapshot().finally(() => {
      snapshotInFlight = null;
    });
  }
  return snapshotInFlight;
}

async function refreshAndPush() {
  const snapshot = await readSnapshotOnce();
  mainWindow?.webContents.send("quota:updated", snapshot);
  return snapshot;
}

function resizeWindow(compact) {
  if (!mainWindow) {
    return false;
  }
  const size = compact ? COMPACT_SIZE : NORMAL_SIZE;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  }
  mainWindow.setMinimumSize(size.width, size.height);
  mainWindow.setMaximumSize(size.width, size.height);
  const bounds = mainWindow.getBounds();
  mainWindow.setBounds({ x: bounds.x, y: bounds.y, width: size.width, height: size.height }, false);
  mainWindow.setContentSize(size.width, size.height);
  isCompact = Boolean(compact);
  mainWindow.webContents.send("window:compactChanged", isCompact);
  return isCompact;
}

app.whenReady().then(() => {
  ipcMain.handle("quota:cached", () => snapshotStore.getCached());
  // The invoking renderer already receives the returned snapshot; broadcasting
  // it as well would render every refresh twice.
  ipcMain.handle("quota:refresh", readSnapshotOnce);
  ipcMain.handle("window:toggleAlwaysOnTop", toggleAlwaysOnTop);
  ipcMain.handle("window:quit", () => {
    mainWindow?.hide();
    return true;
  });
  ipcMain.handle("window:setCompact", (_event, compact) => resizeWindow(Boolean(compact)));
  ipcMain.handle("tokens:history", async (_event, model, sourceFilter) => {
    try {
      if (sourceFilter === "codex" && !appConfig.enableCodex) return { daily: {}, hourly: [] };
      if (sourceFilter === "claude" && !appConfig.enableClaudeCode) return { daily: {}, hourly: [] };
      if (sourceFilter === "opencode" && !appConfig.enableOpenCode) return { daily: {}, hourly: [] };
      if (sourceFilter === "gemini" && !appConfig.enableGeminiCli) return { daily: {}, hourly: [] };
      if (sourceFilter === "cline" && !appConfig.enableCline) return { daily: {}, hourly: [] };
      if (!sourceFilter && !usageCoordinator.enabledLocalSources().length) return { daily: {}, hourly: [] };
      return await usageCoordinator.readHistory("local", model, sourceFilter);
    } catch {
      return { daily: {}, hourly: [] };
    }
  });
  ipcMain.handle("antigravity:history", async (_event, model) => {
    try {
      if (!appConfig.enableAntigravity) return { daily: {}, hourly: [] };
      return await usageCoordinator.readHistory("antigravity", model);
    } catch {
      return { daily: {}, hourly: [] };
    }
  });
  ipcMain.handle("tokens:cumulative", async (_event, selection) => {
    try {
      return await usageCoordinator.readCumulative(selection);
    } catch {
      return null;
    }
  });
  ipcMain.handle("settings:read", () => appConfig);
  ipcMain.handle("settings:update", (_event, newConfig) => {
    const previousConfig = appConfig;
    const nextConfig = normalizeAppConfig({ ...appConfig, ...newConfig });
    const shortcutResult = registerGlobalShortcuts(nextConfig.hotkeys);
    if (!shortcutResult.ok) return shortcutResult;
    const persistedConfig = { ...nextConfig, hotkeys: shortcutResult.hotkeys };
    try {
      persistAppConfig(configPath, persistedConfig);
    } catch (error) {
      registerGlobalShortcuts(previousConfig.hotkeys);
      return { ok: false, code: "writeFailed", error: error?.message || String(error) };
    }

    const sourcesChanged = sourceConfigChanged(previousConfig, persistedConfig);
    appConfig = persistedConfig;
    if (!appConfig.enableCodex) {
      codex.dispose();
    }
    if (sourcesChanged) {
      usageCoordinator.clearCaches();
      refreshAndPush().catch(() => {});
    }
    return { ok: true, hotkeys: appConfig.hotkeys };
  });
  ipcMain.on("tray:saveIcon", (_event, dataUrl) => {
    try {
      const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
      const iconPath = path.join(app.getPath("userData"), "tray_icon.png");
      if (!fs.existsSync(iconPath)) {
        fs.mkdirSync(app.getPath("userData"), { recursive: true });
        fs.writeFileSync(iconPath, base64Data, "base64");
      }
      tray?.setImage(iconPath);
    } catch (e) {
      console.error("Failed to save tray icon:", e);
    }
  });

  codex.on("quota-updated", (quota) => {
    const cached = snapshotStore.getCached() || {};
    mainWindow?.webContents.send("quota:updated", {
      ...cached,
      quota,
      config: appConfig,
      stale: false,
      error: null,
      errors: [],
      updatedAt: Date.now()
    });
  });

  // Pre-warm only when the source is enabled; disabled sources must stay cold.
  if (appConfig.enableCodex) codex.ensureStarted().catch(() => {});

  createWindow();
  createTray();
  registerGlobalShortcuts(appConfig.hotkeys);
});

app.on("before-quit", () => {
  isQuitting = true;
  globalShortcut.unregisterAll();
  codex.dispose();
  cancelBackgroundIdle();
  usageCoordinator.stop(true);
});

app.on("window-all-closed", () => {
  app.quit();
});
