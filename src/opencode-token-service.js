"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  finiteNumber,
  historyFromUsageEvents,
  numericTimestamp,
  summarizeUsageEvents
} = require("./usage-event-summary");

const exportCache = new Map();
let discoveredBinary;
let exportCacheLoadedPath;

function readOpenCodeTokenUsage(options = {}) {
  const now = options.now || Date.now();
  const days = Object.hasOwn(options, "days") && options.days == null ? null : options.days || 1;
  const catalogDays = Object.hasOwn(options, "catalogDays") ? options.catalogDays : days;
  const since = days == null || catalogDays == null
    ? 0
    : now - Math.max(days, catalogDays) * 24 * 60 * 60 * 1000;
  const events = readOpenCodeEvents({
    since,
    runner: options.runner,
    binary: options.binary
  });
  return summarizeUsageEvents(events, {
    ...options,
    now,
    days,
    catalogDays,
    source: "opencode",
    emptyError: "No local OpenCode session usage found"
  });
}

function readOpenCodeStatsUsage({ days = 1, runner = runOpenCode, binary } = {}) {
  const executable = binary || findOpenCodeBinary();
  if (!executable && runner === runOpenCode) return emptyStatsUsage();
  const args = ["stats"];
  if (days !== null) args.push("--days", String(days));
  args.push("--models");
  const result = runner(executable, args);
  if (!result?.ok) return emptyStatsUsage();
  return parseStatsOutput(result.stdout);
}

function readOpenCodeTokenHistory(options = {}) {
  const now = options.now || Date.now();
  const days = options.days || 45;
  const events = readOpenCodeEvents({
    since: now - days * 24 * 60 * 60 * 1000,
    runner: options.runner,
    binary: options.binary
  });
  return historyFromUsageEvents(events, { ...options, now, days });
}

function readOpenCodeEvents({ since = 0, runner = runOpenCode, binary } = {}) {
  loadExportCache();
  const executable = binary || findOpenCodeBinary();
  const listResult = !executable && runner === runOpenCode
    ? { ok: false, stdout: "" }
    : runner(executable, ["session", "list", "--format", "json"]);
  const sessions = (listResult?.ok ? parseSessionList(listResult.stdout) : [])
    .filter((session) => numericTimestamp(session.updated, 0) >= since)
    .sort((a, b) => numericTimestamp(a.updated, 0) - numericTimestamp(b.updated, 0));
  let cacheChanged = false;
  for (const session of sessions) {
    const updated = numericTimestamp(session.updated, 0);
    const cacheKey = session.id;
    let cached = exportCache.get(cacheKey);
    if (!cached || cached.updated !== updated) {
      const exported = runner(executable, ["export", session.id, "--sanitize"]);
      if (!exported?.ok) continue;
      cached = { updated, events: parseSessionExport(exported.stdout, session) };
      exportCache.set(cacheKey, cached);
      cacheChanged = true;
    }
  }
  if (cacheChanged) saveExportCache();
  const events = [];
  const seen = new Set();
  for (const cached of exportCache.values()) {
    for (const event of cached.events || []) {
      if (event.t < since) continue;
      const signature = [
        event.session || "",
        event.t || 0,
        event.model || "unknown",
        event.input || 0,
        event.cached || 0,
        event.cacheWrite || 0,
        event.output || 0,
        event.reasoning || 0,
        event.total || 0
      ].join("\u0000");
      if (seen.has(signature)) continue;
      seen.add(signature);
      events.push(event);
    }
  }
  return events;
}

function loadExportCache() {
  const cachePath = openCodeCachePath();
  if (exportCacheLoadedPath === cachePath) return;
  exportCache.clear();
  exportCacheLoadedPath = cachePath;
  if (!cachePath) return;
  try {
    const value = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (value?.version !== 1 || !value.sessions || typeof value.sessions !== "object") return;
    for (const [id, cached] of Object.entries(value.sessions)) {
      if (Number.isFinite(cached?.updated) && Array.isArray(cached.events)) exportCache.set(id, cached);
    }
  } catch {}
}

function saveExportCache() {
  const cachePath = openCodeCachePath();
  if (!cachePath) return;
  const temporary = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, sessions: Object.fromEntries(exportCache) }), "utf8");
    fs.renameSync(temporary, cachePath);
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function openCodeCachePath() {
  const userData = process.env.AI_QUOTA_USER_DATA_PATH;
  return userData ? path.join(userData, "opencode_usage_cache.json") : null;
}

function parseSessionList(stdout) {
  const value = parseJsonOutput(stdout, "[", "]");
  return Array.isArray(value)
    ? value.filter((session) => typeof session?.id === "string" && session.id.trim())
    : [];
}

function parseSessionExport(stdout, session = {}) {
  const value = parseJsonOutput(stdout, "{", "}");
  if (!value || !Array.isArray(value.messages)) return [];
  const events = [];
  const seen = new Set();
  for (const message of value.messages) {
    const info = message?.info;
    if (info?.role !== "assistant" || !info.tokens) continue;
    if (info.id && seen.has(info.id)) continue;
    if (info.id) seen.add(info.id);
    const cacheRead = finiteNumber(info.tokens.cache?.read);
    const cacheWrite = finiteNumber(info.tokens.cache?.write);
    const rawInput = finiteNumber(info.tokens.input);
    const output = finiteNumber(info.tokens.output);
    const reasoning = finiteNumber(info.tokens.reasoning);
    const input = rawInput + cacheRead + cacheWrite;
    const total = input + output + reasoning;
    if (total <= 0) continue;
    const timestamp = numericTimestamp(info.time?.completed ?? info.time?.created, numericTimestamp(session.updated, Date.now()));
    const provider = textValue(info.providerID);
    const model = textValue(info.modelID) || "unknown";
    events.push({
      t: timestamp,
      session: session.id || value.info?.id,
      model: provider ? `${provider}/${model}` : model,
      input,
      cached: cacheRead,
      cacheWrite,
      output,
      reasoning,
      total
    });
  }
  return events;
}

function parseStatsOutput(stdout) {
  if (typeof stdout !== "string") return emptyStatsUsage();
  const lines = stdout.replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "").split(/\r?\n/);
  const totals = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
  const modelUsage = [];
  let sessions = 0;
  let section = "";
  let currentModel = null;
  let current = null;
  const finishModel = () => {
    if (!currentModel || !current) return;
    current.input += current.cached + current.cacheWrite;
    current.total = current.input + current.output;
    modelUsage.push({ model: currentModel, source: "opencode", ...current });
    currentModel = null;
    current = null;
  };

  for (const rawLine of lines) {
    const content = rawLine.startsWith("│") && rawLine.endsWith("│") ? rawLine.slice(1, -1).trim() : "";
    if (content === "OVERVIEW") { section = "overview"; continue; }
    if (content === "COST & TOKENS") { section = "tokens"; continue; }
    if (content === "MODEL USAGE") { section = "models"; continue; }
    if (content === "TOOL USAGE") { finishModel(); section = "tools"; continue; }
    if (!content || rawLine.startsWith("├") || rawLine.startsWith("┌") || rawLine.startsWith("└")) continue;
    const row = splitStatsRow(content);
    if (section === "overview" && row?.label === "Sessions") sessions = parseCompactNumber(row.value);
    if (section === "tokens" && row) {
      if (row.label === "Input") totals.input = parseCompactNumber(row.value);
      if (row.label === "Output") totals.output = parseCompactNumber(row.value);
      if (row.label === "Cache Read") totals.cached = parseCompactNumber(row.value);
      if (row.label === "Cache Write") totals.cacheWrite = parseCompactNumber(row.value);
    }
    if (section === "models") {
      const modelRow = splitStatsRow(content, true);
      if (!modelRow) {
        finishModel();
        currentModel = content;
        current = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
      } else if (current) {
        if (modelRow.label === "Input Tokens") current.input = parseCompactNumber(modelRow.value);
        if (modelRow.label === "Output Tokens") current.output = parseCompactNumber(modelRow.value);
        if (modelRow.label === "Cache Read") current.cached = parseCompactNumber(modelRow.value);
        if (modelRow.label === "Cache Write") current.cacheWrite = parseCompactNumber(modelRow.value);
      }
    }
  }
  finishModel();
  if (modelUsage.length) {
    totals.input = modelUsage.reduce((sum, item) => sum + item.input, 0);
    totals.cached = modelUsage.reduce((sum, item) => sum + item.cached, 0);
    totals.cacheWrite = modelUsage.reduce((sum, item) => sum + item.cacheWrite, 0);
    totals.output = modelUsage.reduce((sum, item) => sum + item.output, 0);
  } else {
    totals.input += totals.cached + totals.cacheWrite;
  }
  totals.total = totals.input + totals.output;
  if (totals.total <= 0 && !modelUsage.length) return emptyStatsUsage();
  return {
    source: "opencode",
    ...totals,
    cacheHitRate: totals.input > 0 ? Math.round((totals.cached / totals.input) * 100) : null,
    modelUsage: modelUsage.sort((a, b) => b.total - a.total || a.model.localeCompare(b.model)),
    modelCatalog: modelUsage,
    sessions,
    error: null
  };
}

function splitStatsRow(content, modelSection = false) {
  const labels = modelSection
    ? ["Input Tokens", "Output Tokens", "Cache Read", "Cache Write", "Messages", "Cost"]
    : ["Avg Tokens/Session", "Median Tokens/Session", "Avg Cost/Day", "Total Cost", "Cache Read", "Cache Write", "Sessions", "Messages", "Days", "Input", "Output"];
  const label = labels.find((candidate) => content.startsWith(candidate) && /\s/.test(content[candidate.length] || ""));
  if (!label) return null;
  return { label, value: content.slice(label.length).trim() };
}

function parseCompactNumber(value) {
  const match = String(value).replace(/,/g, "").trim().match(/^(-?\d+(?:\.\d+)?)([KMB])?$/i);
  if (!match) return 0;
  const scales = { K: 1_000, M: 1_000_000, B: 1_000_000_000 };
  return Math.round(Number(match[1]) * (scales[(match[2] || "").toUpperCase()] || 1));
}

function emptyStatsUsage() {
  return {
    source: "opencode",
    input: null,
    cached: null,
    cacheWrite: null,
    output: null,
    reasoning: null,
    total: null,
    cacheHitRate: null,
    modelUsage: [],
    modelCatalog: [],
    sessions: 0,
    error: "No local OpenCode session usage found"
  };
}

function parseJsonOutput(stdout, open, close) {
  if (typeof stdout !== "string") return null;
  const start = stdout.indexOf(open);
  const end = stdout.lastIndexOf(close);
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
}

function runOpenCode(binary, args) {
  if (!binary) return { ok: false, stdout: "", stderr: "OpenCode CLI not found" };
  const options = {
    cwd: os.homedir(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1", CI: "1" }
  };
  let result;
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(binary)) {
    const command = [binary, ...args].map(quoteCmdArgument).join(" ");
    result = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], options);
  } else {
    result = spawnSync(binary, args, options);
  }
  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || ""
  };
}

function findOpenCodeBinary() {
  if (discoveredBinary !== undefined) return discoveredBinary;
  const home = os.homedir();
  const candidates = [
    process.env.OPENCODE_BIN,
    process.platform === "win32" ? path.join(home, ".opencode", "bin", "opencode.exe") : path.join(home, ".opencode", "bin", "opencode"),
    process.platform === "win32" ? path.join(home, ".bun", "bin", "opencode.exe") : path.join(home, ".local", "bin", "opencode"),
    process.platform === "win32" && process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "opencode.cmd") : null,
    process.platform === "win32" && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "opencode.exe") : null,
    process.platform === "win32" ? path.join(home, "scoop", "shims", "opencode.exe") : null
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      discoveredBinary = candidate;
      return discoveredBinary;
    }
  }
  const locator = process.platform === "win32"
    ? spawnSync("where.exe", ["opencode"], { encoding: "utf8", windowsHide: true })
    : spawnSync("which", ["opencode"], { encoding: "utf8" });
  discoveredBinary = locator.status === 0
    ? locator.stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean) || null
    : null;
  return discoveredBinary;
}

function quoteCmdArgument(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function textValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

module.exports = {
  findOpenCodeBinary,
  parseSessionExport,
  parseSessionList,
  parseStatsOutput,
  readOpenCodeStatsUsage,
  readOpenCodeTokenHistory,
  readOpenCodeTokenUsage
};
