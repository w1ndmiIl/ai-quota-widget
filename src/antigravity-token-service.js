"use strict";
const { memoScan } = require("./scan-memo");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { scanFilesIncrementally } = require("./incremental-scan-engine");
const { addSettledUsageCost } = require("./usage-cost-settlement");

// Antigravity stores sessions under ~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl
// These files contain conversation steps but NO token counts — we estimate from text content.
// Rough heuristic: ~4 chars per token for code-heavy English, ~2.5 for mixed Chinese/English.

const CHARS_PER_TOKEN = 2.8; // mixed-language estimate including code and Chinese

function readLocalTokenUsage({ now = Date.now(), days = 1, catalogDays = days, root = defaultSessionsRoot() } = {}) {
  const since = now - days * 24 * 60 * 60 * 1000;
  const catalogSince = catalogDays == null
    ? 0
    : now - Math.max(days, catalogDays) * 24 * 60 * 60 * 1000;
  const catalogEvents = readRecentEvents({ since: catalogSince, root }).filter((event) => event.t <= now);
  const events = catalogEvents.filter((event) => event.t >= since);
  const modelCatalog = catalogDays == null || catalogDays > days ? summarizeModelUsage(catalogEvents) : summarizeModelUsage(events);

  if (!events.length) {
    return {
      source: "antigravity",
      input: null,
      cached: null,
      output: null,
      reasoning: null,
      total: null,
      cacheHitRate: null,
      modelUsage: [],
      modelCatalog,
      sessions: 0,
      note: "Token counts estimated from text content (no native token data)",
      error: null
    };
  }

  const totals = events.reduce(
    (acc, e) => {
      acc.input += e.input;
      acc.output += e.output;
      acc.reasoning += e.reasoning;
      acc.total += e.total;
      return acc;
    },
    { input: 0, output: 0, reasoning: 0, total: 0 }
  );

  const modelUsage = summarizeModelUsage(events);
  const sessionIds = new Set(events.map((e) => e.sessionId).filter(Boolean));

  return {
    source: "antigravity",
    input: totals.input,
    cached: 0,
    output: totals.output,
    reasoning: totals.reasoning,
    total: totals.total,
    cacheHitRate: null,
    modelUsage,
    modelCatalog,
    sessions: sessionIds.size,
    note: "Token counts estimated from text content",
    error: null
  };
}

function readDailyTokenHistory({ now = Date.now(), days = 30, root = defaultSessionsRoot(), model = "all" } = {}) {
  const since = now - days * 24 * 60 * 60 * 1000;
  const dailyMap = {};
  const events = readRecentEvents({ since, root }).filter((e) => e.t <= now && matchesModel(e, model));
  for (const event of events) {
    addUsage(dailyMap, localDateKey(event.t), event);
  }
  return dailyMap;
}

function readHourlyTokenHistory({ now = Date.now(), hours = 24, root = defaultSessionsRoot(), model = "all" } = {}) {
  const hourMs = 60 * 60 * 1000;
  const since = now - hours * hourMs;
  const currentHour = Math.floor(now / hourMs) * hourMs;
  const firstHour = Math.floor(since / hourMs) * hourMs;
  const bucketCount = Math.floor((currentHour - firstHour) / hourMs) + 1;
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    t: firstHour + index * hourMs,
    input: 0,
    cached: 0,
    output: 0,
    reasoning: 0,
    total: 0
  }));
  const events = readRecentEvents({ since, root }).filter((e) => e.t <= now && matchesModel(e, model));
  for (const event of events) {
    const index = Math.floor((event.t - firstHour) / hourMs);
    if (index >= 0 && index < buckets.length) addUsageToBucket(buckets[index], event);
  }
  return buckets;
}

function readTokenHistory({ now = Date.now(), days = 45, hours = 24, root = defaultSessionsRoot(), model = "all" } = {}) {
  const dayMs = 24 * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;
  const dailySince = now - days * dayMs;
  const hourlySince = now - hours * hourMs;
  const events = readRecentEvents({ since: dailySince, root }).filter((event) => event.t <= now);

  const dailyMap = {};
  for (const event of events.filter((e) => matchesModel(e, model))) {
    addUsage(dailyMap, localDateKey(event.t), event);
  }

  const currentHour = Math.floor(now / hourMs) * hourMs;
  const firstHour = Math.floor(hourlySince / hourMs) * hourMs;
  const bucketCount = Math.floor((currentHour - firstHour) / hourMs) + 1;
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    t: firstHour + index * hourMs,
    input: 0,
    cached: 0,
    output: 0,
    reasoning: 0,
    total: 0
  }));

  for (const event of events) {
    if (event.t >= hourlySince && matchesModel(event, model)) {
      const index = Math.floor((event.t - firstHour) / hourMs);
      if (index >= 0 && index < buckets.length) addUsageToBucket(buckets[index], event);
    }
  }

  return { daily: dailyMap, hourly: buckets };
}

// --- Internal helpers ---

function readRecentEvents({ since, root }) {
  return memoScan(JSON.stringify(["antigravity", process.env.HISTORY_ACCUMULATOR_PATH, process.env.AI_QUOTA_USER_DATA_PATH, root]), () => scanRecentEvents({ since: 0, root })).filter((event) => event.t >= since);
}

function scanRecentEvents({ since, root }) {
  const roots = Array.isArray(root) ? root : [root];
  const transcriptPaths = [];
  
  for (const baseDir of roots) {
    if (!fs.existsSync(baseDir)) continue;
    let brainDirs = [];
    try {
      brainDirs = fs.readdirSync(baseDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(baseDir, e.name));
    } catch {
      continue;
    }
    for (const brainDir of brainDirs) {
      const transcriptPath = path.join(brainDir, ".system_generated", "logs", "transcript.jsonl");
      if (fs.existsSync(transcriptPath)) {
        transcriptPaths.push(transcriptPath);
      }
    }
  }

  // 增量扫描
  const allParsedData = scanFilesIncrementally(transcriptPaths, (filePath) => {
    const fileEvents = [];
    const sessionId = path.basename(path.dirname(path.dirname(path.dirname(filePath)))); // brainDir
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    let currentModel = "unknown";
    let runningInputChars = 35000;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const step = JSON.parse(line);
        currentModel = extractModel(step) || currentModel;
        const t = Date.parse(step.created_at);

        if (step.type === "PLANNER_RESPONSE") {
          let outputChars = 0;
          let reasoningChars = 0;

          if (step.thinking) {
            reasoningChars += step.thinking.length;
          }
          if (step.tool_calls) {
            outputChars += JSON.stringify(step.tool_calls).length;
          }
          if (step.content && typeof step.content === "string") {
            outputChars += step.content.length;
          }

          if (Number.isFinite(t) && isGeminiModel(currentModel)) {
            const inputTokens = Math.round(runningInputChars / CHARS_PER_TOKEN);
            const outputTokens = Math.round(outputChars / CHARS_PER_TOKEN);
            const reasoningTokens = Math.round(reasoningChars / CHARS_PER_TOKEN);

            fileEvents.push({
              t,
              model: currentModel,
              sessionId,
              input: inputTokens,
              output: outputTokens,
              reasoning: reasoningTokens,
              cached: null,
              total: inputTokens + outputTokens + reasoningTokens
            });
          }

          runningInputChars += (outputChars + reasoningChars);
        } else {
          if (step.content && typeof step.content === "string") {
            runningInputChars += step.content.length;
          }
        }
      } catch {
        // ignore
      }
    }
    return fileEvents;
  }, { namespace: "antigravity", retainDeleted: true });

  const events = [];
  for (const fileEvents of Object.values(allParsedData)) {
    for (const ev of fileEvents) {
      // Retained caches may contain older third-party events. Enforce the
      // Gemini-only product policy again when materializing cached history.
      if (ev.t >= since && isGeminiModel(ev.model)) {
        events.push(ev);
      }
    }
  }

  return events;
}

function extractModel(step) {
  if (step.type === "USER_INPUT" && typeof step.content === "string") {
    const settingsBlock = step.content.match(/<USER_SETTINGS_CHANGE>([\s\S]*?)(?:<\/USER_SETTINGS_CHANGE>|$)/i)?.[1] || "";
    const settingsChangeMatch = settingsBlock.match(
      /Model Selection`?\s+from\s+[\s\S]+?\s+to\s+([\s\S]+?)(?:\.\s+(?=[A-Z\u4e00-\u9fa5])|$)/i
    );
    if (settingsChangeMatch) return settingsChangeMatch[1].trim().replace(/\.$/, "");
  }
  if (typeof step.model === "string" && step.model.trim()) return step.model.trim();
  return null;
}

function isGeminiModel(model) {
  return typeof model === "string" && /(?:^|[^a-z0-9])gemini(?:[^a-z0-9]|$)/i.test(model.trim());
}

function summarizeModelUsage(events) {
  const models = new Map();
  for (const event of events) {
    const model = event.model || "unknown";
    if (!models.has(model)) {
      models.set(model, { model, input: 0, cached: null, output: 0, reasoning: 0, total: 0 });
    }
    const bucket = models.get(model);
    addUsageToBucket(bucket, event);
    addSettledUsageCost(bucket, { ...event, source: "antigravity" }, model);
  }
  return [...models.values()].sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));
}

function addUsage(map, key, usage) {
  if (!map[key]) map[key] = { input: 0, cached: null, output: 0, reasoning: 0, total: 0 };
  addUsageToBucket(map[key], usage);
}

function addUsageToBucket(bucket, usage) {
  bucket.input += usage.input;
  bucket.output += usage.output;
  bucket.reasoning += usage.reasoning || 0;
  if (usage.cached !== null && usage.cached !== undefined) {
    bucket.cached = (bucket.cached || 0) + usage.cached;
  }
  bucket.total += usage.total || usage.input + usage.output + (usage.reasoning || 0);
}

function matchesModel(event, model) {
  return model === "all" || (event.model ?? "unknown") === model;
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function defaultSessionsRoot() {
  return path.join(os.homedir(), ".gemini", "antigravity", "brain");
}

module.exports = {
  readLocalTokenUsage,
  readDailyTokenHistory,
  readHourlyTokenHistory,
  readTokenHistory,
  extractModel,
  isGeminiModel
};
