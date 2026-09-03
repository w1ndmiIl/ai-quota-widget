"use strict";

const { parentPort } = require("node:worker_threads");
const {
  readLocalTokenUsage,
  readTokenHistory
} = require("./token-usage-service");
const {
  readLocalTokenUsage: readAntigravityUsage,
  readTokenHistory: readAntigravityHistory
} = require("./antigravity-token-service");
const {
  readClineTokenHistory,
  readClineTokenUsage
} = require("./cline-token-service");
const {
  readGeminiTokenHistory,
  readGeminiTokenUsage
} = require("./gemini-token-service");
const {
  readOpenCodeTokenHistory,
  readOpenCodeTokenUsage
} = require("./opencode-token-service");

function readUsageWithModelCatalog(reader, payload = {}) {
  return reader({ ...payload, catalogDays: null });
}

function readOpenCodeUsageWithModelCatalog(payload = {}) {
  return readOpenCodeTokenUsage({ days: payload.days || 1, catalogDays: null });
}

function localSources(payload = {}) {
  return Array.isArray(payload.sources) ? payload.sources : ["codex", "claude", "opencode", "gemini", "cline"];
}

function readCombinedLocalUsage(payload = {}) {
  const sources = localSources(payload);
  const usages = [];
  const sessionSources = sources.filter((source) => source === "codex" || source === "claude");
  if (sessionSources.length) usages.push(readUsageWithModelCatalog(readLocalTokenUsage, { ...payload, sources: sessionSources }));
  if (sources.includes("opencode")) usages.push(readOpenCodeUsageWithModelCatalog(payload));
  if (sources.includes("gemini")) usages.push(readUsageWithModelCatalog(readGeminiTokenUsage, payload));
  if (sources.includes("cline")) usages.push(readUsageWithModelCatalog(readClineTokenUsage, payload));
  return mergeUsageSummaries(usages);
}

function readCombinedLocalHistory(payload = {}) {
  const sources = localSources(payload);
  const histories = [];
  for (const source of sources) {
    if (source === "codex" || source === "claude") histories.push(readTokenHistory({ ...payload, source }));
    if (source === "opencode") histories.push(readOpenCodeTokenHistory(payload));
    if (source === "gemini") histories.push(readGeminiTokenHistory(payload));
    if (source === "cline") histories.push(readClineTokenHistory(payload));
  }
  return mergeHistories(histories);
}

function mergeUsageSummaries(usages) {
  const sum = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
  const modelUsage = [];
  const modelCatalog = [];
  let sessions = 0;
  let hasData = false;
  for (const usage of usages) {
    modelUsage.push(...(usage?.modelUsage || []));
    modelCatalog.push(...(usage?.modelCatalog || []));
    if (usage?.total == null) continue;
    hasData = true;
    sum.input += usage.input || 0;
    sum.cached += usage.cached || 0;
    sum.cacheWrite += usage.cacheWrite || 0;
    sum.output += usage.output || 0;
    sum.reasoning += usage.reasoning || 0;
    sum.total += usage.total || 0;
    sessions += usage.sessions || 0;
  }
  return {
    source: "localSessions",
    input: hasData ? sum.input : null,
    cached: hasData ? sum.cached : null,
    cacheWrite: hasData ? sum.cacheWrite : null,
    output: hasData ? sum.output : null,
    reasoning: hasData ? sum.reasoning : null,
    total: hasData ? sum.total : null,
    cacheHitRate: hasData && sum.input > 0 ? Math.round((sum.cached / sum.input) * 100) : null,
    modelUsage: sortAndDeduplicateModels(modelUsage),
    modelCatalog: sortAndDeduplicateModels(modelCatalog),
    modelCatalogRange: "all",
    sessions,
    error: hasData ? null : "No enabled local agent usage found"
  };
}

function sortAndDeduplicateModels(items) {
  const models = new Map();
  for (const item of items) {
    const key = `${item.source || ""}\u0000${item.model || "unknown"}`;
    if (!models.has(key)) models.set(key, item);
  }
  return [...models.values()].sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));
}

function mergeHistories(histories) {
  const daily = {};
  const hourlyByTime = new Map();
  const add = (target, usage) => {
    target.input += usage.input || 0;
    target.cached += usage.cached || 0;
    target.cacheWrite = (target.cacheWrite || 0) + (usage.cacheWrite || 0);
    target.output += usage.output || 0;
    target.reasoning += usage.reasoning || 0;
    target.total += usage.total || 0;
  };
  for (const history of histories) {
    for (const [day, usage] of Object.entries(history?.daily || {})) {
      if (!daily[day]) daily[day] = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
      add(daily[day], usage);
    }
    for (const usage of history?.hourly || []) {
      if (!hourlyByTime.has(usage.t)) hourlyByTime.set(usage.t, { t: usage.t, input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 });
      add(hourlyByTime.get(usage.t), usage);
    }
  }
  return { daily, hourly: [...hourlyByTime.values()].sort((a, b) => a.t - b.t) };
}

function parseSelection(selection = "all") {
  if (selection === "all") return { source: null, model: "all" };
  if (selection.startsWith("source:")) return { source: selection.slice("source:".length), model: "all" };
  const separator = selection.indexOf(":");
  if (separator > 0) {
    return { source: selection.slice(0, separator), model: selection.slice(separator + 1) || "all" };
  }
  return { source: null, model: selection };
}

function readCumulative({ selection = "all", model, source = null, enableCodex = true, enableClaudeCode = true, enableOpenCode = true, enableGeminiCli = true, enableCline = true, enableAntigravity = true }) {
  const selected = selection !== "all" || model == null
    ? parseSelection(selection)
    : { model, source };
  const sum = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
  const modelUsage = [];
  let cacheInput = 0;
  let cacheKnown = false;
  const addUsage = (usage, hasCacheData, defaultSource) => {
    const items = selected.model === "all"
      ? usage?.modelUsage || []
      : (usage?.modelUsage || []).filter((item) => item.model === selected.model);
    for (const item of items) {
      const value = { ...item, source: item.source || defaultSource };
      modelUsage.push(value);
      sum.input += value.input || 0;
      sum.cacheWrite += value.cacheWrite || 0;
      sum.output += value.output || 0;
      sum.reasoning += value.reasoning || 0;
      sum.total += value.total || 0;
      if (hasCacheData) {
        cacheKnown = true;
        cacheInput += value.input || 0;
        sum.cached += value.cached || 0;
      }
    }
  };

  const wantsAntigravity = !selected.source || selected.source === "antigravity";
  const wantsCodex = !selected.source || selected.source === "codex";
  const wantsClaude = !selected.source || selected.source === "claude";
  const wantsOpenCode = !selected.source || selected.source === "opencode";
  const wantsGemini = !selected.source || selected.source === "gemini";
  const wantsCline = !selected.source || selected.source === "cline";
  if (enableCodex && wantsCodex) addUsage(readLocalTokenUsage({ days: 9999, sources: ["codex"] }), true, "codex");
  if (enableClaudeCode && wantsClaude) addUsage(readLocalTokenUsage({ days: 9999, sources: ["claude"] }), true, "claude");
  if (enableOpenCode && wantsOpenCode) addUsage(readOpenCodeTokenUsage({ days: null, catalogDays: null }), true, "opencode");
  if (enableGeminiCli && wantsGemini) addUsage(readGeminiTokenUsage({ days: 9999 }), true, "gemini");
  if (enableCline && wantsCline) addUsage(readClineTokenUsage({ days: 9999 }), true, "cline");
  if (enableAntigravity && wantsAntigravity) addUsage(readAntigravityUsage({ days: 9999 }), false, "antigravity");
  return {
    ...sum,
    cached: cacheKnown ? sum.cached : null,
    cacheHitRate: cacheKnown && cacheInput > 0 ? Math.round((sum.cached / cacheInput) * 100) : null,
    modelUsage
  };
}

function execute(operation, payload = {}) {
  switch (operation) {
    case "localUsage":
      return readCombinedLocalUsage(payload);
    case "antigravityUsage":
      return readUsageWithModelCatalog(readAntigravityUsage);
    case "localHistory":
      return readCombinedLocalHistory(payload);
    case "antigravityHistory":
      return readAntigravityHistory(payload);
    case "cumulative":
      return readCumulative(payload);
    default:
      throw new Error(`Unknown usage worker operation: ${operation}`);
  }
}

parentPort.on("message", ({ id, operation, payload }) => {
  try {
    parentPort.postMessage({ id, result: execute(operation, payload) });
  } catch (error) {
    parentPort.postMessage({ id, error: error?.message || String(error) });
  }
});
