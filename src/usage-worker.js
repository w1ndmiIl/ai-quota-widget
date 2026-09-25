"use strict";

const { parentPort } = require("node:worker_threads");
if (parentPort) process.env.AI_QUOTA_PARTITION_LEDGER = "1";
const { configureScanCache } = require("./scan-memo");
const { resolveRange } = require("./usage-report");
const TokenPricing = require("./renderer/token-pricing");
configureScanCache(15_000);
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

function readOpenCodeUsageWithModelCatalog(payload = {}, onProgress) {
  return readOpenCodeTokenUsage({ ...payload, days: payload.days || 1, catalogDays: null, onProgress });
}

function localSources(payload = {}) {
  return Array.isArray(payload.sources) ? payload.sources : ["codex", "claude", "opencode", "gemini", "cline"];
}

async function readCombinedLocalUsage(payload = {}, onProgress) {
  const sources = localSources(payload);
  const usages = [];
  const sessionSources = sources.filter((source) => source === "codex" || source === "claude");
  if (sessionSources.length) usages.push(readUsageWithModelCatalog(readLocalTokenUsage, { ...payload, sources: sessionSources, eventCacheTtl: 15_000 }));
  if (sources.includes("gemini")) usages.push(readUsageWithModelCatalog(readGeminiTokenUsage, payload));
  if (sources.includes("cline")) usages.push(readUsageWithModelCatalog(readClineTokenUsage, payload));
  const metrics = require("./incremental-scan-engine").getScanMetrics();
  for (const usage of usages) {
    const namespace = usage.source === "localSessions" ? "codex-and-claude" : usage.source;
    if (metrics[namespace]?.failures) usage.readError = `${namespace}: ${metrics[namespace].failures} session files could not be read; using retained data`;
  }
  if (sources.includes("opencode")) usages.push(await readOpenCodeUsageWithModelCatalog(payload,
    (usage) => onProgress?.(mergeUsageSummaries([...usages, usage]))));
  return mergeUsageSummaries(usages);
}

async function readCombinedLocalHistory(payload = {}) {
  const sources = localSources(payload);
  const histories = [];
  const sessionSources = sources.filter((source) => source === "codex" || source === "claude");
  if (sessionSources.length) histories.push(readTokenHistory({ ...payload, source: sessionSources, eventCacheTtl: 15_000 }));
  for (const source of sources) {
    if (source === "opencode") histories.push(await readOpenCodeTokenHistory(payload));
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
    , readError: usages.map((usage) => usage?.readError).filter(Boolean).join("; ") || null,
    partial: usages.some((usage) => usage?.partial)
    , sourceErrors: Object.fromEntries(usages.filter((usage) => usage?.readError).map((usage) => [usage.source, usage.readError]))
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

async function readCumulative({ selection = "all", model, source = null, enableCodex = true, enableClaudeCode = true, enableOpenCode = true, enableGeminiCli = true, enableCline = true, enableAntigravity = true }) {
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
  const sessionSources = [];
  if (enableCodex && wantsCodex) sessionSources.push("codex");
  if (enableClaudeCode && wantsClaude) sessionSources.push("claude");
  if (sessionSources.length) addUsage(readLocalTokenUsage({ days: 9999, sources: sessionSources, eventCacheTtl: 15_000 }), true);
  if (enableOpenCode && wantsOpenCode) addUsage(await readOpenCodeTokenUsage({ days: null, catalogDays: null }), true, "opencode");
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

async function readReport(payload) {
  const range = resolveRange(payload.range, payload.now);
  const options = { now: range.end, days: range.days, sources: localSources(payload), hours: Math.min(24, range.days * 24) };
  const usages = [await readCombinedLocalUsage(options)];
  const histories = [await readCombinedLocalHistory({ ...options, model: "all", skipRefresh: true })];
  if (payload.enableAntigravity) {
    const usage = readAntigravityUsage({ ...options, catalogDays: null });
    usage.modelUsage = (usage.modelUsage || []).map((model) => ({ ...model, source: "antigravity" }));
    usage.modelCatalog = (usage.modelCatalog || []).map((model) => ({ ...model, source: "antigravity" }));
    usages.push(usage);
    histories.push(readAntigravityHistory({ ...options, model: "all" }));
  }
  const models = usages.flatMap((usage) => usage?.modelUsage || []).sort((a,b) => b.total-a.total);
  const catalog = usages.flatMap((usage) => usage?.modelCatalog || usage?.modelUsage || []).sort((a,b) => b.total-a.total);
  for (const model of models) {
    const override = payload.priceOverrides?.[model.model];
    if (!override || ["input", "cached", "cacheWrite", "output"].some((key) => !Number.isFinite(override[key]) || override[key] < 0)) continue;
    const cost = TokenPricing.estimateUsageCost(model, model.model, undefined, override);
    Object.assign(model, { estimatedUsd: cost.usd, estimatedMaxUsd: cost.maxUsd, pricedTokens: cost.tokens, unpricedTokens: 0, unknownModels: [], variableModels: [], pricingSettled: true, customPrice: true });
  }
  const selected = parseSelection(payload.selection || "all");
  const selectedModels = models.filter((model) => (!selected.source || model.source === selected.source || selected.source === "antigravity" && !model.source) && (selected.model === "all" || model.model === selected.model));
  let history;
  if (!selected.source && selected.model === "all") history = mergeHistories(histories);
  else if (selected.source === "antigravity") history = payload.enableAntigravity ? readAntigravityHistory({ ...options, model: selected.model }) : { daily: {}, hourly: [] };
  else history = await readCombinedLocalHistory({ ...options, sources: selected.source ? options.sources.filter((source) => source === selected.source) : options.sources, model: selected.model, skipRefresh: true });
  let contextHistory = history;
  if (["24h", "today"].includes(range.preset)) {
    const contextOptions = { ...options, days: 45, model: selected.model, sources: selected.source ? options.sources.filter((source) => source === selected.source) : options.sources, skipRefresh: true };
    const contexts = [await readCombinedLocalHistory(contextOptions)];
    if (payload.enableAntigravity && (!selected.source || selected.source === "antigravity")) contexts.push(readAntigravityHistory(contextOptions));
    contextHistory = mergeHistories(contexts);
  }
  return { range, models: selectedModels, catalog, history, contextHistory, readError: usages.map((usage) => usage?.readError).filter(Boolean).join("; "), partial: usages.some((usage) => usage?.partial) };
}

function execute(operation, payload = {}, onProgress) {
  switch (operation) {
    case "cancel": require("./opencode-token-service").cancelReads(); return true;
    case "metrics": return require("./incremental-scan-engine").getScanMetrics();
    case "report": return readReport(payload);
    case "invalidate":
      configureScanCache(0); configureScanCache(15_000);
      require("./token-usage-service").invalidateEventCache();
      require("./opencode-token-service").invalidateCache(); return true;
    case "localUsage":
      return readCombinedLocalUsage(payload, onProgress);
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

parentPort?.on("message", async ({ id, operation, payload }) => {
  try {
    const result = await execute(operation, payload, (progress) => parentPort.postMessage({ id, progress }));
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: error?.message || String(error) });
  }
});

module.exports = { execute };
