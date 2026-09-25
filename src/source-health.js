"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
function sourceLocations() {
  const home = os.homedir();
  return {
    codex: [path.join(home, ".codex", "sessions"), path.join(home, ".codex", "archived_sessions")],
    claude: [path.join(home, ".claude", "projects")],
    opencode: [process.env.OPENCODE_BIN || path.join(home, ".local", "share", "opencode")],
    gemini: [path.join(home, ".gemini", "tmp")],
    cline: [path.join(process.env.APPDATA || home, "Code", "User", "globalStorage", "saoudrizwan.claude-dev"), path.join(home, ".cline", "data")],
    antigravity: [path.join(home, ".gemini", "antigravity", "brain")]
  };
}
function sourceHealth(config, snapshot, metrics = {}) {
  const keys = { codex: "enableCodex", claude: "enableClaudeCode", opencode: "enableOpenCode", gemini: "enableGeminiCli", cline: "enableCline", antigravity: "enableAntigravity" };
  return Object.entries(sourceLocations()).map(([source, locations]) => {
    const field = source === "antigravity" ? "antigravityTokenUsage" : "localTokenUsage";
    const quotaError = source === "codex" ? snapshot?.sourceErrors?.quota : source === "antigravity" ? snapshot?.sourceErrors?.antigravityQuota : null;
    const error = quotaError || snapshot?.sourceErrors?.[source] || snapshot?.[field]?.sourceErrors?.[source] || (["codex","claude"].includes(source) && snapshot?.[field]?.sourceErrors?.localSessions) || (!snapshot?.[field]?.sourceErrors && snapshot?.sourceErrors?.[field]);
    const lastSuccess = snapshot?.sourceUpdatedAt?.[source] || snapshot?.sourceUpdatedAt?.[field] || null;
    const roots = locations.map((location) => {
      try { fs.accessSync(location, fs.constants.R_OK); return { path: location, readable: true }; }
      catch (error) { return { path: location, readable: false, reason: error.code }; }
    });
    const status = !config[keys[source]] ? "disabled" : error ? "error" : lastSuccess ? (Date.now()-lastSuccess > 6*60000 ? "cached" : "ready") : roots.some((root) => root.readable) ? "waiting" : "missing";
    return { source, status, roots, lastSuccess, error: error || null, metrics: metrics[source] || null };
  });
}
module.exports = { sourceHealth, sourceLocations };
