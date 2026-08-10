"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_HOTKEYS, normalizeHotkeys } = require("./hotkey-config");

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
    stored = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") console.error("Failed to load app config", error);
  }
  return normalizeAppConfig(stored);
}

function normalizeAppConfig(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...DEFAULT_APP_CONFIG,
    ...source,
    hotkeys: normalizeHotkeys(source.hotkeys ?? DEFAULT_HOTKEYS)
  };
}

function persistAppConfig(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
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
