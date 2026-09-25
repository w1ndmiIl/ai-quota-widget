"use strict";

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, globalShortcut, screen, dialog, clipboard, Notification, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { chooseDataDirectory, visibleBounds, quotaNotices } = require("./desktop-preferences");
const { sourceHealth } = require("./source-health");
const { resolveRange, serializeReport } = require("./usage-report");
const { loadAppConfig, normalizeAppConfig, persistAppConfig, sourceConfigChanged } = require("./app-config-store");
const { AntigravityQuotaService } = require("./antigravity-quota-service");
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


app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});


// Configure portable userData directory inside project folder (D drive) instead of C drive
const appDir = app.isPackaged ? path.dirname(app.getPath("exe")) : app.getAppPath();
const dataLocation = chooseDataDirectory(path.join(appDir, ".userdata"), app.getPath("userData"));
const userDataPath = dataLocation.directory;
app.setPath("userData", userDataPath);
process.env.AI_QUOTA_USER_DATA_PATH = userDataPath;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

const NORMAL_SIZE = { width: 760, height: 540 };
const COMPACT_SIZE = { width: 336, height: 72 };

const configPath = path.join(userDataPath, "config.json");
let appConfig = loadAppConfig(configPath);
const snapshotStore = new DashboardSnapshotStore({ userDataPath, getConfig: () => appConfig });
const usageWorkerClient = new UsageWorkerClient(path.join(__dirname, "usage-worker.js"));
const usageCoordinator = new UsageCoordinator({ workerClient: usageWorkerClient, getConfig: () => appConfig });

const codex = new CodexService();
const antigravityQuota = new AntigravityQuotaService({ userDataPath });
let mainWindow = null;
let tray = null;
let isQuitting = false;
let isCompact = false;
let registeredHotkeys = {};
let backgroundIdleTimer = null;
let antigravityQuotaTimer = null;
const BACKGROUND_IDLE_MS = 30_000;
const ANTIGRAVITY_QUOTA_REFRESH_MS = 5 * 60_000;

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
    antigravityQuota.dispose();
    usageCoordinator.stop(true);
  }, BACKGROUND_IDLE_MS);
  backgroundIdleTimer.unref?.();
}

function toggleAlwaysOnTop() {
  if (!mainWindow) return false;
  const pinned = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(pinned);
  appConfig = { ...appConfig, pinned };
  persistAppConfig(configPath, appConfig);
  mainWindow.webContents.send("window:pinnedChanged", pinned);
  return pinned;
}

function hotkeyRegistrations(hotkeys) {
  return [
    [hotkeys.togglePanel, toggleMainPanel],
    [hotkeys.toggleCompact, () => resizeWindow(!isCompact)],
    [hotkeys.refresh, () => refreshAndPush({ allowAntigravityStart: true }).catch(() => {})],
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
    ...visibleBounds(appConfig.windowBounds, screen.getAllDisplays(), NORMAL_SIZE.width, NORMAL_SIZE.height),
    minWidth: COMPACT_SIZE.width,
    minHeight: COMPACT_SIZE.height,
    frame: false,
    resizable: false,
    alwaysOnTop: appConfig.pinned !== false,
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

  mainWindow.webContents.setZoomFactor(1);
  let boundsTimer;
  mainWindow.on("move", () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (isQuitting) return;
      appConfig = { ...appConfig, windowBounds: mainWindow.getBounds() };
      try { persistAppConfig(configPath, appConfig); } catch (error) { console.error(error); }
    }, 300);
  });
  if (process.argv.includes("--smoke-test")) {
    mainWindow.webContents.once("did-finish-load", async () => {
      try {
        await mainWindow.webContents.executeJavaScript('new Promise((resolve, reject) => { let attempts = 0; const timer = setInterval(() => { if (initialDataReady && currentReport) { clearInterval(timer); resolve(true); } else if (++attempts > 100) { clearInterval(timer); reject(new Error("Renderer startup timed out")); } }, 50); })');
        fs.writeFileSync(path.join(userDataPath, "smoke-result.json"), JSON.stringify({ ok: true, version: app.getVersion(), electron: process.versions.electron }));
      } catch (error) { fs.writeFileSync(path.join(userDataPath, "smoke-result.json"), JSON.stringify({ ok: false, error: error.message })); }
      app.quit();
    });
  }
  mainWindow.webContents.on("did-finish-load", () => mainWindow?.webContents.send("window:pinnedChanged", mainWindow.isAlwaysOnTop()));
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
      { label: "刷新数据", click: () => refreshAndPush({ allowAntigravityStart: true }).catch(() => {}) },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
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


const initialResetCreditsSnapshot = snapshotStore.getCached();
let cachedResetCredits = initialResetCreditsSnapshot?.resetCredits ?? null;
let lastResetCreditsTime = cachedResetCredits ? Number(initialResetCreditsSnapshot?.updatedAt) || 0 : 0;
let resetCreditsPending = null;
const RESET_CREDITS_CACHE_TTL = 5 * 60_000;
let snapshotInFlight = null;

async function readCachedResetCredits() {
  const now = Date.now();
  if (now - lastResetCreditsTime < RESET_CREDITS_CACHE_TTL) {
    return cachedResetCredits;
  }
  if (resetCreditsPending) return resetCreditsPending;
  // Back off after both success and failure. The endpoint is auxiliary and may
  // rate-limit rapid refreshes; keep any last known valid card data meanwhile.
  lastResetCreditsTime = now;
  resetCreditsPending = readResetCredits()
    .then((credits) => {
      cachedResetCredits = credits;
      if (isQuitting || !appConfig.enableCodex) return credits;
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

async function readSnapshot({ allowAntigravityStart = false, includeTokens = !isCompact } = {}) {
  const config = appConfig;
  const generation = usageCoordinator.generation;
  const current = () => !isQuitting && generation === usageCoordinator.generation;
  const initial = snapshotStore.getCached() || {};
  let snapshot = {
    ...initial,
    quota: config.enableCodex ? initial.quota || codex.getCachedQuota() : null,
    resetCredits: config.enableCodex ? cachedResetCredits : null,
    antigravityQuota: config.enableAntigravity ? initial.antigravityQuota || antigravityQuota.getCachedQuota() : null,
    localTokenUsage: usageCoordinator.enabledLocalSources().length ? initial.localTokenUsage || null : null,
    antigravityTokenUsage: config.enableAntigravity ? initial.antigravityTokenUsage || null : null,
    config, error: null, errors: [], refreshing: true
  };
  const failures = new Map();
  const commit = (patch, source, complete = false) => {
    if (!current()) return;
    // Merge against the latest snapshot so auxiliary updates cannot be overwritten.
    snapshot = { ...snapshot, ...snapshotStore.getCached(), ...patch, config,
      stale: false, refreshing: !complete, error: failures.get("quota") || null,
      errors: [...failures.values()], sourceErrors: Object.fromEntries(failures), updatedAt: Date.now() };
    if (source) snapshot.sourceUpdatedAt = { ...snapshot.sourceUpdatedAt, [source]: Date.now() };
    if (snapshot.quota?.tokenStats && snapshot.quota.tokenStats.total == null && snapshot.localTokenUsage?.total != null) {
      snapshot.quota = { ...snapshot.quota, tokenStats: {
        ...snapshot.quota?.tokenStats, ...snapshot.localTokenUsage,
        accountUsageError: snapshot.quota?.tokenStats?.error ?? null, error: null
      } };
    }
    snapshotStore.save(snapshot);
    if (!complete) mainWindow?.webContents.send("quota:updated", snapshot);
  };
  const read = async (field, reader) => {
    try {
      const value = await reader();
      if (value?.readError) failures.set(field, value.readError);
      if (value != null) commit({ [field]: value }, value?.readError || value?.partial || value?.fromCache ? null : field);
    } catch (error) {
      failures.set(field, error?.message || String(error));
      commit({});
    }
  };
  const tasks = [];
  if (config.enableCodex) {
    readCachedResetCredits().catch(() => {});
    tasks.push(read("quota", () => codex.readQuota()));
  }
  if (config.enableAntigravity) {
    tasks.push(read("antigravityQuota", () => antigravityQuota.readQuota({
      allowStart: allowAntigravityStart, force: allowAntigravityStart
    })));
    if (includeTokens) tasks.push(read("antigravityTokenUsage", () => usageCoordinator.readAntigravityUsage()));
  }
  if (includeTokens && usageCoordinator.enabledLocalSources().length) {
    tasks.push(read("localTokenUsage", () => usageCoordinator.readLocalUsage(Date.now(),
      (value) => commit({ localTokenUsage: value }))));
  }
  await Promise.all(tasks);
  if (!current()) return { superseded: true };
  commit({ resetCredits: config.enableCodex ? cachedResetCredits : null }, null, true);
  return snapshot;
}

async function readSnapshotOnce({ allowAntigravityStart = false } = {}) {
  if (allowAntigravityStart && !snapshotInFlight) { usageCoordinator.clearCaches(); usageCoordinator.stop(true); }
  const key = usageCoordinator.generation + ":" + isCompact;
  const existing = snapshotInFlight;
  if (existing && existing.key === key) {
    if (!allowAntigravityStart || existing.allowStart) return existing.promise;
    try { await existing.promise; } catch {}
    return readSnapshotOnce({ allowAntigravityStart });
  }
  const flight = { key, allowStart: allowAntigravityStart };
  snapshotInFlight = flight;
  flight.promise = readSnapshot({ allowAntigravityStart }).finally(() => {
    if (snapshotInFlight === flight) snapshotInFlight = null;
  });
  return flight.promise;
}

function startAntigravityQuotaRefresh() {
  if (antigravityQuotaTimer) return;
  antigravityQuotaTimer = setInterval(() => {
    refreshRunningAntigravityQuota().catch(() => {});
  }, ANTIGRAVITY_QUOTA_REFRESH_MS);
  antigravityQuotaTimer.unref?.();
}

async function refreshRunningAntigravityQuota() {
  if (!appConfig.enableAntigravity) return null;
  const generation = usageCoordinator.generation;
  const previous = antigravityQuota.getCachedQuota();
  const next = await antigravityQuota.readQuota({ allowStart: false, force: true });
  if (isQuitting || generation !== usageCoordinator.generation) return null;
  if (!next || next.updatedAt === previous?.updatedAt) return previous;

  const cached = snapshotStore.getCached();
  if (cached) {
    const snapshot = { ...cached, antigravityQuota: next, stale: false, updatedAt: Date.now() };
    snapshotStore.save(snapshot);
    mainWindow?.webContents.send("quota:updated", snapshot);
  }
  return next;
}

async function refreshAndPush(options = {}) {
  const snapshot = await readSnapshotOnce(options);
  if (!snapshot.superseded) mainWindow?.webContents.send("quota:updated", snapshot);
  return snapshot;
}

function resizeWindow(compact) {
  if (!mainWindow) {
    return false;
  }
  const zoom = 1;
  const baseSize = compact ? COMPACT_SIZE : NORMAL_SIZE;
  const size = { width: Math.round(baseSize.width * zoom), height: Math.round(baseSize.height * zoom) };
  mainWindow.webContents.setZoomFactor(zoom);
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  }
  mainWindow.setMinimumSize(size.width, size.height);
  mainWindow.setMaximumSize(size.width, size.height);
  const bounds = visibleBounds(mainWindow.getBounds(), screen.getAllDisplays(), size.width, size.height);
  mainWindow.setMinimumSize(Math.min(COMPACT_SIZE.width, bounds.width), Math.min(COMPACT_SIZE.height, bounds.height));
  mainWindow.setBounds(bounds, false);
  mainWindow.setContentSize(bounds.width, bounds.height);
  isCompact = Boolean(compact);
  mainWindow.webContents.send("window:compactChanged", isCompact);
  return isCompact;
}

async function readUsageReport(options) {
  resolveRange(options.range);
  const sources = usageCoordinator.enabledLocalSources();
  const selection = typeof options.selection === "string" ? options.selection : "all";
  if (options.force) await usageWorkerClient.request("invalidate");
  const generation = usageCoordinator.generation;
  const report = await usageWorkerClient.request("report", { range: options.range, selection, sources, enableAntigravity: appConfig.enableAntigravity, priceOverrides: {} });
  if (generation !== usageCoordinator.generation) throw new Error("Settings changed; retry the report");
  return report;
}

let noticeState = {};
const noticeStatePath = path.join(userDataPath, "notification-state.json");
try { noticeState = JSON.parse(fs.readFileSync(noticeStatePath, "utf8")); } catch {}
function publishNotices(snapshot) {
  if (!app.isReady() || snapshot.error || snapshot.stale) return;
  const before = JSON.stringify(noticeState);
  const notices = quotaNotices(snapshot, appConfig.notifications, noticeState);
  if (before !== JSON.stringify(noticeState)) {
    try { require("./atomic-json").writeJson(noticeStatePath, noticeState); } catch (error) { console.error(error); }
  }
  for (const item of notices) {
    const english = appConfig.language === "en";
    new Notification({ title: "AI_bar", body: english
      ? item.source + " " + item.window + (item.kind === "low" ? " quota low: " : " quota recovered: ") + item.remaining + "%"
      : item.source + " " + item.window + (item.kind === "low" ? " 额度偏低：" : " 额度已恢复：") + item.remaining + "%" }).show();
  }
}

app.whenReady().then(() => {
  ipcMain.handle("pricing:open", (_event, url) => {
    if (!["https://openai.com/api/pricing/", "https://www.anthropic.com/pricing", "https://ai.google.dev/gemini-api/docs/pricing", "https://api-docs.deepseek.com/quick_start/pricing"].includes(url)) throw new Error("Unknown pricing source");
    return shell.openExternal(url);
  });
  ipcMain.handle("sources:retry", async (_event, source) => {
    if (![...usageCoordinator.enabledLocalSources(), ...(appConfig.enableAntigravity ? ["antigravity"] : [])].includes(source)) throw new Error("Source disabled");
    await usageWorkerClient.request("invalidate");
    const result = await usageWorkerClient.request(source === "antigravity" ? "antigravityUsage" : "localUsage", { sources: [source], refreshTtl: 0 });
    const cached = snapshotStore.getCached();
    if (cached) {
      const sourceErrors = { ...cached.sourceErrors };
      if (result.readError) sourceErrors[source] = result.readError; else delete sourceErrors[source];
      snapshotStore.save({ ...cached, sourceErrors, sourceUpdatedAt: { ...cached.sourceUpdatedAt, ...(!result.readError ? { [source]: Date.now() } : {}) } });
    }
    return result;
  });
  for (const event of ["display-removed", "display-metrics-changed"]) screen.on(event, () => { if (mainWindow) resizeWindow(isCompact); });
  ipcMain.handle("sources:health", async () => {
    const metrics = await usageWorkerClient.request("metrics");
    return { dataDirectory: userDataPath, fallback: dataLocation.fallback, version: app.getVersion(), sources: sourceHealth(appConfig, snapshotStore.getCached(), { ...metrics, codex: metrics["codex-and-claude"], claude: metrics["codex-and-claude"] }) };
  });
  ipcMain.handle("diagnostics:copy", () => { clipboard.writeText(JSON.stringify({ version: app.getVersion(), sources: sourceHealth(appConfig, snapshotStore.getCached()) }, null, 2)); return true; });
  ipcMain.handle("preferences:update", (_event, preferences) => {
    const zoom = Math.max(0.8, Math.min(1.3, Number(preferences.zoom) || 1));
    appConfig = normalizeAppConfig({ ...appConfig, zoom, notifications: preferences.notifications, priceOverrides: preferences.priceOverrides, language: preferences.language });
    persistAppConfig(configPath, appConfig); if (mainWindow) resizeWindow(isCompact); return appConfig;
  });
  ipcMain.handle("tokens:report", (_event, options = {}) => readUsageReport(options));
  ipcMain.handle("report:export", async (_event, options = {}) => {
    if (!["csv", "json"].includes(options.format)) throw new Error("Invalid export format");
    const report = await readUsageReport(options);
    const result = await dialog.showSaveDialog(mainWindow, { defaultPath: "AI_bar-usage." + options.format, filters: [{ name: options.format.toUpperCase(), extensions: [options.format] }] });
    if (result.canceled || !result.filePath) return false;
    await fs.promises.writeFile(result.filePath, serializeReport(report, options.format), "utf8"); return true;
  });
  ipcMain.handle("quota:cached", () => snapshotStore.getCached());
  // The invoking renderer already receives the returned snapshot; broadcasting
  // it as well would render every refresh twice.
  ipcMain.handle("quota:refresh", (_event, options) => readSnapshotOnce({
    allowAntigravityStart: options?.manual === true
  }));
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
    if (!appConfig.enableAntigravity) {
      antigravityQuota.dispose();
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
    if (isQuitting || !appConfig.enableCodex) return;
    const cached = snapshotStore.getCached() || {};
    const snapshot = {
      ...cached,
      quota,
      config: appConfig,
      stale: false,
      error: null,
      errors: [],
      updatedAt: Date.now()
    };
    snapshotStore.save(snapshot);
    mainWindow?.webContents.send("quota:updated", snapshot);
  });

  // Pre-warm only when the source is enabled; disabled sources must stay cold.
  if (appConfig.enableCodex) codex.ensureStarted().catch(() => {});

  createWindow();
  resizeWindow(isCompact);
  createTray();
  registerGlobalShortcuts(appConfig.hotkeys);
  startAntigravityQuotaRefresh();
});

let shutdownComplete = false;
app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (isQuitting) return;
  isQuitting = true;
  globalShortcut.unregisterAll();
  codex.dispose();
  antigravityQuota.dispose();
  if (antigravityQuotaTimer) clearInterval(antigravityQuotaTimer);
  antigravityQuotaTimer = null;
  cancelBackgroundIdle();
  usageCoordinator.stop(true);
  let timeout;
  Promise.race([
    snapshotStore.flush(),
    new Promise((resolve) => { timeout = setTimeout(resolve, 2_000); })
  ]).catch((error) => console.error("Snapshot flush failed during shutdown", error)).finally(() => {
    clearTimeout(timeout);
    shutdownComplete = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
