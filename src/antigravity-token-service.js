"use strict";
const os = require("node:os");
const path = require("node:path");
const { memoScan } = require("./scan-memo");
const { scanFilesIncrementally } = require("./incremental-scan-engine");
const { summarizeUsageEvents, historyFromUsageEvents } = require("./usage-event-summary");
const { readNativeEvents } = require("./antigravity-native-usage");

function isGeminiModel(model) {
  return typeof model === "string" && /(?:^|[^a-z0-9])gemini(?:[^a-z0-9]|$)/i.test(model.trim());
}
function defaultSessionsRoot() {
  return ["antigravity", "antigravity-cli", "antigravity-ide"].map(name => path.join(os.homedir(), ".gemini", name, "brain"));
}
function readEvents(root = defaultSessionsRoot()) {
  return memoScan(JSON.stringify(["antigravity", process.env.HISTORY_ACCUMULATOR_PATH, process.env.AI_QUOTA_USER_DATA_PATH, root]), () => {
    const native = readNativeEvents(root);
    const nativeSessions = new Set(native.events.map(event => event.sessionId));
    // Compatibility for already-settled legacy history only. The text-based
    // estimator is retired; no new estimates or transcript scans are performed.
    const retained = scanFilesIncrementally([], () => [], { namespace: "antigravity", retainDeleted: true });
    const legacy = Object.values(retained).flat().filter(event => isGeminiModel(event.model) && !nativeSessions.has(event.sessionId)).map(event => ({
      ...event, source: "antigravity", output: event.output + (event.reasoning || 0),
      cached: null, reasoningIncluded: true, usageAccuracy: "estimated"
    }));
    return { events: [...native.events, ...legacy], readError: native.readError };
  });
}
function readLocalTokenUsage({ root, ...options } = {}) {
  const { events, readError } = readEvents(root);
  const usage = summarizeUsageEvents(events, { ...options, source: "antigravity" });
  const kinds = new Set(usage.modelUsage.map(model => model.usageAccuracy));
  usage.usageAccuracy = kinds.size > 1 || kinds.has("mixed") ? "mixed" : kinds.values().next().value || "native";
  usage.reasoningIncluded = true;
  usage.readError = readError;
  usage.note = usage.usageAccuracy === "native" ? "Native Antigravity token usage" : "Includes retained legacy estimates";
  return usage;
}
function readTokenHistory({ root, ...options } = {}) {
  return historyFromUsageEvents(readEvents(root).events, options);
}
module.exports = { readLocalTokenUsage, readTokenHistory, isGeminiModel };
