"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { scanFilesIncrementally, getCachePath } = require("./incremental-scan-engine");
const { readAppendedEvents } = require("./append-jsonl");
const { addSettledUsageCost } = require("./usage-cost-settlement");
let recentEventCache = null;

function readLocalTokenUsage({ now = Date.now(), days = 1, catalogDays = days, root = defaultSessionsRoot(), sources = null, eventCacheTtl = 0 } = {}) {
  const since = now - days * 24 * 60 * 60 * 1000;
  const catalogSince = catalogDays == null
    ? 0
    : now - Math.max(days, catalogDays) * 24 * 60 * 60 * 1000;
  const recent = readRecentUsageEvents({ since: catalogSince, root, eventCacheTtl });
  const sessions = new Set(recent.events.map((event) => event.file));
  const eventFiles = new Set(recent.events.map((usage) => usage.file));
  const allUsages = [
    ...recent.events,
    ...recent.fallbacks.filter((usage) => !eventFiles.has(usage.file))
  ];
  const catalogUsages = Array.isArray(sources)
    ? allUsages.filter((usage) => usage.t <= now && sources.includes(usage.source))
    : allUsages.filter((usage) => usage.t <= now);
  const usages = catalogUsages.filter((usage) => usage.t >= since);

  const totals = usages.reduce(
    (acc, item) => {
      acc.input += item.input;
      acc.cached += item.cached;
      acc.cacheWrite += item.cacheWrite || 0;
      acc.output += item.output;
      acc.reasoning += item.reasoning;
      acc.total += item.total || item.input + item.output + item.reasoning;
      return acc;
    },
    { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 }
  );
  const modelUsage = summarizeModelUsage(usages);
  const modelCatalog = catalogDays == null || catalogDays > days ? summarizeModelUsage(catalogUsages) : modelUsage;

  if (!usages.length) {
    return {
      source: "localSessions",
      input: null,
      cached: null,
      cacheWrite: null,
      output: null,
      reasoning: null,
      total: null,
      cacheHitRate: null,
      modelUsage: [],
      modelCatalog,
      sessions: 0,
      error: "No local Codex session usage found"
    };
  }

  return {
    source: "localSessions",
    input: totals.input,
    cached: totals.cached,
    cacheWrite: totals.cacheWrite,
    output: totals.output,
    reasoning: totals.reasoning,
    total: totals.total,
    cacheHitRate: Math.round((totals.cached / Math.max(1, totals.input)) * 100),
    modelUsage,
    modelCatalog,
    sessions: new Set(usages.map((usage) => usage.file)).size || sessions.size,
    since
  };
}

function readDailyTokenHistory({ now = Date.now(), days = 30, root = defaultSessionsRoot(), model = "all", source = null } = {}) {
  const since = now - days * 24 * 60 * 60 * 1000;
  const dailyMap = {};
  const recent = readRecentUsageEvents({ since, root });
  for (const event of recent.events.filter((event) => matchesModel(event, model, source))) {
    addUsage(dailyMap, localDateKey(event.t), event);
  }
  for (const fallback of recent.fallbacks.filter((fallback) => matchesModel(fallback, model, source))) {
    addUsage(dailyMap, localDateKey(fallback.t), fallback);
  }
  return dailyMap;
}

function readHourlyTokenHistory({ now = Date.now(), hours = 24, root = defaultSessionsRoot(), model = "all", source = null } = {}) {
  const hourMs = 60 * 60 * 1000;
  const since = now - hours * hourMs;
  const currentHour = Math.floor(now / hourMs) * hourMs;
  const firstHour = Math.floor(since / hourMs) * hourMs;
  const bucketCount = Math.floor((currentHour - firstHour) / hourMs) + 1;
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    t: firstHour + index * hourMs,
    input: 0,
    cached: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: 0
  }));
  const recent = readRecentUsageEvents({ since, root });
  for (const event of recent.events.filter((event) => matchesModel(event, model, source))) {
    const index = Math.floor((event.t - firstHour) / hourMs);
    if (index >= 0 && index < buckets.length) addUsageToBucket(buckets[index], event);
  }
  for (const fallback of recent.fallbacks.filter((fallback) => matchesModel(fallback, model, source))) {
    const index = Math.floor((fallback.t - firstHour) / hourMs);
    if (index >= 0 && index < buckets.length) addUsageToBucket(buckets[index], fallback);
  }
  return buckets;
}

function readRecentUsageEvents({ since, root, eventCacheTtl = 0 }) {
  const key = JSON.stringify([getCachePath(), root]);
  if (eventCacheTtl > 0 && recentEventCache?.key === key && Date.now() - recentEventCache.at < eventCacheTtl) {
    return filterRecentEvents(recentEventCache.value, since);
  }
  const requestedSince = since;
  if (eventCacheTtl > 0) since = 0;
  const fileEntries = listJsonlFiles(root);
  const filePaths = fileEntries.map(({ file }) => file);
  const sourceByFile = new Map(fileEntries.map(({ file, source }) => [file, source]));
  const allParsedData = scanFilesIncrementally(filePaths, (file) => {
    const source = sourceByFile.get(file);
    const allFileEvents = readUsageEvents(file, sourceByFile.get(file));
    let fallback = null;
    if (!allFileEvents.length) {
      const latest = readLatestUsage(file);
      fallback = latest ? {
        ...latest,
        t: Math.floor(safeStat(file)?.mtimeMs ?? 0),
        ...(source ? { source } : {})
      } : null;
    }
    return { events: allFileEvents, fallback };
  }, { namespace: "codex-and-claude", retainDeleted: true });

  const events = [];
  const fallbacks = [];
  const seenEvents = new Set();
  const seenFallbacks = new Set();

  for (const [file, data] of Object.entries(allParsedData)) {
    if (data.events && data.events.length) {
      for (const ev of data.events) {
        if (ev.t >= since) {
          const signature = usageEventSignature(file, ev);
          if (seenEvents.has(signature)) continue;
          seenEvents.add(signature);
          events.push({ file, ...ev });
        }
      }
    } else if (data.fallback) {
      const stat = safeStat(file);
      const mtimeMs = stat?.mtimeMs ?? 0;
      const fallbackTime = mtimeMs || data.fallback.t || 0;
      if (fallbackTime >= since) {
        const source = data.fallback.source ?? sourceByFile.get(file);
        const fallback = { file, t: fallbackTime, model: "unknown", ...(source ? { source } : {}), ...data.fallback };
        const signature = usageEventSignature(file, fallback);
        if (seenFallbacks.has(signature)) continue;
        seenFallbacks.add(signature);
        fallbacks.push(fallback);
      }
    }
  }

  const value = { events, fallbacks };
  if (eventCacheTtl > 0) recentEventCache = { key, at: Date.now(), value };
  else recentEventCache = null;
  return filterRecentEvents(value, requestedSince);
}

function filterRecentEvents(value, since) {
  return {
    events: value.events.filter((event) => event.t >= since),
    fallbacks: value.fallbacks.filter((event) => event.t >= since)
  };
}

function usageEventSignature(file, event) {
  const session = path.basename(file, path.extname(file));
  return [
    event.source || "",
    session,
    event.t || 0,
    event.model || "unknown",
    event.input || 0,
    event.cached || 0,
    event.cacheWrite || 0,
    event.output || 0,
    event.reasoning || 0,
    event.total || 0
  ].join("\u0000");
}

function matchesModel(usage, model, source = null) {
  const modelMatches = model === "all" || (usage.model ?? "unknown") === model;
  const sourceMatches = Array.isArray(source) ? source.includes(usage.source) : !source || source === "all" || usage.source === source;
  return modelMatches && sourceMatches;
}

function readUsageEvents(file, source = null) {
  return readAppendedEvents(file, (item, state) => {
    state.model = readModelName(item) ?? state.model;
    const timestamp = Date.parse(item?.timestamp);
    const usage = item?.payload?.info?.last_token_usage ?? item?.message?.usage;
    const id = item?.message?.id;
    if (!Number.isFinite(timestamp) || !usage || id && state.ids.has(id)) return null;
    if (id) state.ids.add(id);
    return { t: timestamp, model: state.model ?? "unknown", ...(source ? { source } : {}), ...normalizeUsage(usage) };
  });
}

function summarizeModelUsage(usages) {
  const models = new Map();
  for (const usage of usages) {
    const model = usage.model || "unknown";
    const source = usage.source || "";
    const key = `${source}\u0000${model}`;
    if (!models.has(key)) {
      models.set(key, { model, ...(source ? { source } : {}), input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 });
    }
    const bucket = models.get(key);
    addUsageToBucket(bucket, usage);
    addSettledUsageCost(bucket, usage, model);
  }
  return [...models.values()].sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));
}

function readModelName(item) {
  const model = item?.message?.model ?? item?.payload?.model ?? item?.payload?.info?.model ?? item?.payload?.collaboration_mode?.settings?.model;
  return typeof model === "string" && model.trim() ? model.trim() : null;
}

function addUsage(map, key, usage) {
  if (!map[key]) map[key] = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
  addUsageToBucket(map[key], usage);
}

function addUsageToBucket(bucket, usage) {
  bucket.input += usage.input;
  bucket.cached += usage.cached;
  bucket.cacheWrite = (bucket.cacheWrite || 0) + (usage.cacheWrite || 0);
  bucket.output += usage.output;
  bucket.reasoning += usage.reasoning || 0;
  bucket.total += usage.total || usage.input + usage.output + (usage.reasoning || 0);
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function readLatestUsage(file) {
  let latest = null;
  const content = fs.readFileSync(file, "utf8");
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const item = JSON.parse(line);
      const usage = item?.payload?.info?.total_token_usage ?? item?.payload?.info?.last_token_usage ?? item?.message?.usage;
      if (usage) {
        latest = normalizeUsage(usage);
      }
    } catch {
      // Ignore partial or non-JSON lines.
    }
  }
  return latest;
}

function normalizeUsage(usage) {
  const cached = readNumber(usage.cached_input_tokens ?? usage.cache_read_input_tokens, 0);
  const cacheWrite = readNumber(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens, 0);
  let input = readNumber(usage.input_tokens, 0);
  if (usage.cache_read_input_tokens !== undefined || usage.cacheReadInputTokens !== undefined) {
    input = input + cached;
  }
  if (usage.cache_creation_input_tokens !== undefined || usage.cacheCreationInputTokens !== undefined) {
    input = input + cacheWrite;
  }
  const output = readNumber(usage.output_tokens, 0);
  const reasoning = readNumber(usage.reasoning_output_tokens, 0);
  const total = readNumber(usage.total_tokens, input + output + reasoning);
  return { input, cached, cacheWrite, output, reasoning, total };
}

function listJsonlFiles(root) {
  const result = [];
  const roots = (Array.isArray(root) ? root : [root])
    .filter((item) => item && fs.existsSync(item))
    .map((item) => ({ path: item, source: sourceForRoot(item) }));
  const stack = [...roots];
  while (stack.length) {
    const { path: dir, source } = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push({ path: file, source });
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        result.push({ file, source });
      }
    }
  }
  return result;
}

function sourceForRoot(root) {
  const normalized = path.normalize(root).toLowerCase();
  if (normalized.includes(path.normalize(path.join(".claude", "projects")).toLowerCase())) return "claude";
  if (normalized.includes(path.normalize(".codex").toLowerCase())) return "codex";
  return null;
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function readNumber(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function readTokenHistory({ now = Date.now(), days = 45, hours = 24, root = defaultSessionsRoot(), model = "all", source = null, eventCacheTtl = 0 } = {}) {
  const dayMs = 24 * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;
  const dailySince = now - days * dayMs;
  const hourlySince = now - hours * hourMs;
  const rawRecent = readRecentUsageEvents({ since: dailySince, root, eventCacheTtl });
  const recent = { events: rawRecent.events.filter((event) => event.t <= now), fallbacks: rawRecent.fallbacks.filter((event) => event.t <= now) };

  const dailyMap = {};
  for (const event of recent.events.filter((event) => matchesModel(event, model, source))) {
    addUsage(dailyMap, localDateKey(event.t), event);
  }
  for (const fallback of recent.fallbacks.filter((fallback) => matchesModel(fallback, model, source))) {
    addUsage(dailyMap, localDateKey(fallback.t), fallback);
  }

  const currentHour = Math.floor(now / hourMs) * hourMs;
  const firstHour = Math.floor(hourlySince / hourMs) * hourMs;
  const bucketCount = Math.floor((currentHour - firstHour) / hourMs) + 1;
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    t: firstHour + index * hourMs,
    input: 0,
    cached: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: 0
  }));

  for (const event of recent.events) {
    if (event.t >= hourlySince && matchesModel(event, model, source)) {
      const index = Math.floor((event.t - firstHour) / hourMs);
      if (index >= 0 && index < buckets.length) addUsageToBucket(buckets[index], event);
    }
  }
  for (const fallback of recent.fallbacks) {
    if (fallback.t >= hourlySince && matchesModel(fallback, model, source)) {
      const index = Math.floor((fallback.t - firstHour) / hourMs);
      if (index >= 0 && index < buckets.length) addUsageToBucket(buckets[index], fallback);
    }
  }

  return { daily: dailyMap, hourly: buckets };
}

function defaultSessionsRoot() {
  return [
    path.join(os.homedir(), ".codex", "sessions"),
    path.join(os.homedir(), ".codex", "archived_sessions"),
    path.join(os.homedir(), ".claude", "projects")
  ];
}

module.exports = {
  invalidateEventCache: () => { recentEventCache = null; },
  readLocalTokenUsage,
  readLatestUsage,
  readUsageEvents,
  normalizeUsage,
  readDailyTokenHistory,
  readHourlyTokenHistory,
  readTokenHistory
};
