"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aiQuota", {
  sourceHealth: () => ipcRenderer.invoke("sources:health"),
  retrySource: (source) => ipcRenderer.invoke("sources:retry", source),
  copyDiagnostics: () => ipcRenderer.invoke("diagnostics:copy"),
  readReport: (options) => ipcRenderer.invoke("tokens:report", options),
  exportReport: (options) => ipcRenderer.invoke("report:export", options),
  savePreferences: (preferences) => ipcRenderer.invoke("preferences:update", preferences),
  openPricing: (url) => ipcRenderer.invoke("pricing:open", url),
  readCached: () => ipcRenderer.invoke("quota:cached"),
  refresh: (options) => ipcRenderer.invoke("quota:refresh", options),
  toggleAlwaysOnTop: () => ipcRenderer.invoke("window:toggleAlwaysOnTop"),
  quitWindow: () => ipcRenderer.invoke("window:quit"),
  setCompact: (compact) => ipcRenderer.invoke("window:setCompact", compact),
  readTokenHistory: (model, source) => ipcRenderer.invoke("tokens:history", model, source),
  readAntigravityHistory: (model) => ipcRenderer.invoke("antigravity:history", model),
  readCumulativeTokens: (model) => ipcRenderer.invoke("tokens:cumulative", model),
  saveTrayIcon: (dataUrl) => ipcRenderer.send("tray:saveIcon", dataUrl),
  readSettings: () => ipcRenderer.invoke("settings:read"),
  saveSettings: (config) => ipcRenderer.invoke("settings:update", config),
  onCompactChanged: (callback) => {
    const listener = (_event, compact) => callback(Boolean(compact));
    ipcRenderer.on("window:compactChanged", listener);
    return () => ipcRenderer.off("window:compactChanged", listener);
  },
  onPinnedChanged: (callback) => {
    const listener = (_event, pinned) => callback(Boolean(pinned));
    ipcRenderer.on("window:pinnedChanged", listener);
    return () => ipcRenderer.off("window:pinnedChanged", listener);
  },
  onUpdated: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("quota:updated", listener);
    return () => ipcRenderer.off("quota:updated", listener);
  }
});
