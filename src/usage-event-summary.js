"use strict";

const { addSettledUsageCost } = require("./usage-cost-settlement");

function summarizeUsageEvents(events, {
  now = Date.now(),
  days = 1,
  catalogDays = days,
  source,
  emptyError = "No local session usage found"
} = {}) {
  const dayMs = 24 * 60 * 60 * 1000;
  const since = days == null ? 0 : now - days * dayMs;
  const catalogSince = catalogDays == null ? 0 : now - Math.max(days, catalogDays) * dayMs;
  const catalogEvents = events.filter((event) => event.t >= catalogSince && event.t <= now);
  const currentEvents = catalogEvents.filter((event) => event.t >= since);
  const modelUsage = summarizeModels(currentEvents, source);
  const modelCatalog = days == null || catalogDays == null || catalogDays > days
    ? summarizeModels(catalogEvents, source)
    : modelUsage;

  if (!currentEvents.length) {
    return {
      source,
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
      error: emptyError
    };
  }

  const totals = currentEvents.reduce((sum, event) => addUsage(sum, event), emptyTotals());
  return {
    source,
    ...totals,
    cacheHitRate: totals.input > 0 ? Math.round((totals.cached / totals.input) * 100) : null,
    modelUsage,
    modelCatalog,
    sessions: new Set(currentEvents.map((event) => event.session || event.file).filter(Boolean)).size,
    since
  };
}

function historyFromUsageEvents(events, {
  now = Date.now(),
  days = 45,
  hours = 24,
  model = "all"
} = {}) {
  const dayMs = 24 * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;
  const dailySince = now - days * dayMs;
  const hourlySince = now - hours * hourMs;
  const filtered = events.filter((event) => event.t >= dailySince && event.t <= now && matchesModel(event, model));
  const daily = {};

  for (const event of filtered) {
    const key = localDateKey(event.t);
    if (!daily[key]) daily[key] = emptyTotals();
    addUsage(daily[key], event);
  }

  const currentHour = Math.floor(now / hourMs) * hourMs;
  const firstHour = Math.floor(hourlySince / hourMs) * hourMs;
  const count = Math.floor((currentHour - firstHour) / hourMs) + 1;
  const hourly = Array.from({ length: count }, (_, index) => ({
    t: firstHour + index * hourMs,
    ...emptyTotals()
  }));
  for (const event of filtered) {
    if (event.t < hourlySince) continue;
    const index = Math.floor((event.t - firstHour) / hourMs);
    if (index >= 0 && index < hourly.length) addUsage(hourly[index], event);
  }
  return { daily, hourly };
}

function summarizeModels(events, source) {
  const models = new Map();
  for (const event of events) {
    const model = event.model || "unknown";
    if (!models.has(model)) models.set(model, { model, source, ...emptyTotals() });
    const bucket = models.get(model);
    addUsage(bucket, event);
    addSettledUsageCost(bucket, { ...event, source: event.source || source }, model);
  }
  return [...models.values()].sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));
}

function addUsage(target, usage) {
  target.input += usage.input || 0;
  target.cached += usage.cached || 0;
  target.cacheWrite += usage.cacheWrite || 0;
  target.output += usage.output || 0;
  target.reasoning += usage.reasoning || 0;
  target.total += usage.total || (usage.input || 0) + (usage.output || 0) + (usage.reasoning || 0);
  return target;
}

function emptyTotals() {
  return { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
}

function matchesModel(event, model) {
  return model === "all" || (event.model || "unknown") === model;
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function numericTimestamp(value, fallback = null) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numericTimestamp(numeric, fallback);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function finiteNumber(value, fallback = 0) {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : fallback;
}

module.exports = {
  finiteNumber,
  historyFromUsageEvents,
  numericTimestamp,
  summarizeUsageEvents
};
