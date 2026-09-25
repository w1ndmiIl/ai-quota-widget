"use strict";
const { memoScan } = require("./scan-memo");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { scanFilesIncrementally } = require("./incremental-scan-engine");
const {
  finiteNumber,
  historyFromUsageEvents,
  numericTimestamp,
  summarizeUsageEvents
} = require("./usage-event-summary");

function readClineTokenUsage(options = {}) {
  const events = readClineEvents({ roots: options.roots });
  return summarizeUsageEvents(events, {
    ...options,
    source: "cline",
    emptyError: "No local Cline session usage found"
  });
}

function readClineTokenHistory(options = {}) {
  return historyFromUsageEvents(readClineEvents({ roots: options.roots }), options);
}

function readClineEvents(options) {
  return memoScan(JSON.stringify(["readClineEvents", process.env.HISTORY_ACCUMULATOR_PATH, process.env.AI_QUOTA_USER_DATA_PATH, options]), () => scanreadClineEvents(options));
}

function scanreadClineEvents({ roots = defaultClineRoots() } = {}) {
  const files = listClineMessageFiles(roots);
  const parsed = scanFilesIncrementally(files, readClineMessageFile, { namespace: "cline", retainDeleted: true });
  const events = [];
  const seen = new Set();
  for (const [file, fileEvents] of Object.entries(parsed)) {
    const session = path.basename(path.dirname(file));
    for (const event of fileEvents || []) {
      const signature = `${session}\u0000${event.t}\u0000${event.input}\u0000${event.cached}\u0000${event.cacheWrite}\u0000${event.output}\u0000${event.model}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      events.push({ file, session, ...event });
    }
  }
  return events;
}

function readClineMessageFile(file) {
  let rows;
  try {
    rows = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("Invalid Cline message JSON");
  }
  if (!Array.isArray(rows)) return [];
  const fallbackModel = readTaskModel(path.dirname(file));
  const events = [];
  for (const row of rows) {
    if (row?.type !== "say" || row?.say !== "api_req_started") continue;
    const details = parseDetails(row.text);
    const tokensIn = finiteNumber(details.tokensIn ?? details.inputTokens);
    const tokensOut = finiteNumber(details.tokensOut ?? details.outputTokens);
    const cacheRead = finiteNumber(details.cacheReads ?? details.cacheReadTokens);
    const cacheWrite = finiteNumber(details.cacheWrites ?? details.cacheWriteTokens);
    if (tokensIn + tokensOut + cacheRead + cacheWrite <= 0) continue;
    const timestamp = numericTimestamp(row.ts ?? row.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    const input = tokensIn + cacheRead + cacheWrite;
    events.push({
      t: timestamp,
      model: firstText(details.modelId, details.model, details.apiModelId, fallbackModel) || "unknown",
      input,
      cached: cacheRead,
      cacheWrite,
      output: tokensOut,
      reasoning: 0,
      total: input + tokensOut
    });
  }
  return events;
}

function parseDetails(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function readTaskModel(taskDir) {
  for (const name of ["task_metadata.json", "metadata.json"]) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(taskDir, name), "utf8"));
      const model = findModelValue(value);
      if (model) return model;
    } catch {}
  }
  return null;
}

function findModelValue(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return null;
  for (const key of ["modelId", "model", "apiModelId", "selectedModelId"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  for (const child of Object.values(value)) {
    const found = findModelValue(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function firstText(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || null;
}

function listClineMessageFiles(roots) {
  const files = [];
  const seenDirs = new Set();
  const stack = (Array.isArray(roots) ? roots : [roots]).filter(Boolean);
  while (stack.length) {
    const dir = stack.pop();
    const normalized = path.resolve(dir).toLowerCase();
    if (seenDirs.has(normalized) || !fs.existsSync(dir)) continue;
    seenDirs.add(normalized);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const item = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(item);
      else if (entry.isFile() && entry.name === "ui_messages.json") files.push(item);
    }
  }
  return [...new Set(files.map((file) => path.resolve(file)))];
}

function defaultClineRoots() {
  const configured = process.env.AI_QUOTA_CLINE_ROOTS;
  if (configured) return configured.split(path.delimiter).filter(Boolean);
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const editorNames = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"];
  return [
    path.join(home, ".cline", "data"),
    path.join(home, ".vscode-server", "data", "User", "globalStorage", "saoudrizwan.claude-dev", "tasks"),
    ...editorNames.map((name) => path.join(appData, name, "User", "globalStorage", "saoudrizwan.claude-dev", "tasks"))
  ];
}

module.exports = {
  defaultClineRoots,
  listClineMessageFiles,
  readClineMessageFile,
  readClineTokenHistory,
  readClineTokenUsage
};
