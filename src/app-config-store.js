"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_HOTKEYS, normalizeHotkeys } = require("./hotkey-config");
const { writeJson } = require("./atomic-json");

const SOURCE_CONFIG_KEYS = Object.freeze([
  "enableCodex",
  "enableClaudeCode",
  "enableOpenCode",
  "enableGeminiCli",
  "enableCline",
  "enableAntigravity"
]);

const DEFAULT_APP_CONFIG = Object.freeze({
  enableCodex: true,
  enableClaudeCode: true,
  enableOpenCode: true,
  enableGeminiCli: true,
  enableCline: true,
  enableAntigravity: true,
  hotkeys: DEFAULT_HOTKEYS
});

function loadAppConfig(configPath) {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code !== "ENOENT") console.error("Failed to load app config", error);
  }
  return normalizeAppConfig(stored);
}

function normalizeAppConfig(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const config = {
    ...DEFAULT_APP_CONFIG,
    ...source,
    hotkeys: normalizeHotkeys(source.hotkeys ?? DEFAULT_HOTKEYS)
  };
  for (const key of SOURCE_CONFIG_KEYS) if (typeof config[key] !== "boolean") config[key] = DEFAULT_APP_CONFIG[key];
  config.zoom = Math.max(0.8, Math.min(1.3, Number(config.zoom) || 1));
  const notifications = config.notifications || {};
  config.notifications = { enabled: notifications.enabled === true, quiet: notifications.quiet === true, threshold: Math.max(1, Math.min(99, Number(notifications.threshold) || 10)) };
  config.priceOverrides = Object.fromEntries(Object.entries(config.priceOverrides || {}).filter(([model, price]) => model.trim() && ["input","cached","cacheWrite","output"].every((key) => Number.isFinite(price?.[key]) && price[key] >= 0)).slice(0,256));
  return config;
}

function persistAppConfig(configPath, config) {
  writeJson(configPath, config);
}

function enabledLocalSources(config) {
  return [
    config.enableCodex ? "codex" : null,
    config.enableClaudeCode ? "claude" : null,
    config.enableOpenCode ? "opencode" : null,
    config.enableGeminiCli ? "gemini" : null,
    config.enableCline ? "cline" : null
  ].filter(Boolean);
}

function sourceConfigChanged(previous, next) {
  return SOURCE_CONFIG_KEYS.some((key) => previous?.[key] !== next?.[key]);
}

function sourceConfigMatches(snapshot, config) {
  return SOURCE_CONFIG_KEYS.every((key) => snapshot?.config?.[key] === config?.[key]);
}

module.exports = {
  DEFAULT_APP_CONFIG,
  SOURCE_CONFIG_KEYS,
  enabledLocalSources,
  loadAppConfig,
  normalizeAppConfig,
  persistAppConfig,
  sourceConfigChanged,
  sourceConfigMatches
};
