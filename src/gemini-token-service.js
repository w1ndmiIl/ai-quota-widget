"use strict";

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

function readGeminiTokenUsage(options = {}) {
  return summarizeUsageEvents(readGeminiEvents({ roots: options.roots }), {
    ...options,
    source: "gemini",
    emptyError: "No local Gemini CLI session usage found"
  });
}

function readGeminiTokenHistory(options = {}) {
  return historyFromUsageEvents(readGeminiEvents({ roots: options.roots }), options);
}

function readGeminiEvents({ roots = defaultGeminiRoots() } = {}) {
  const files = listGeminiSessionFiles(roots);
  const parsed = scanFilesIncrementally(files, readGeminiSessionFile, { namespace: "gemini", retainDeleted: true });
  const events = [];
  const seen = new Set();
  for (const [file, fileEvents] of Object.entries(parsed)) {
    for (const event of fileEvents || []) {
      const signature = `${event.session}\u0000${event.message}\u0000${event.t}\u0000${event.model}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      events.push({ file, ...event });
    }
  }
  return events;
}

function readGeminiSessionFile(file) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("Invalid Gemini session JSON");
  }
  if (!record || !Array.isArray(record.messages)) return [];
  const session = text(record.sessionId) || path.basename(file, path.extname(file));
  const fallbackTime = numericTimestamp(record.lastUpdated ?? record.startTime);
  const events = [];

  for (let index = 0; index < record.messages.length; index += 1) {
    const message = record.messages[index];
    if (!message || message.type !== "gemini" || !message.tokens) continue;
    const usage = normalizeGeminiTokens(message.tokens);
    if (usage.total <= 0) continue;
    const timestamp = numericTimestamp(message.timestamp, fallbackTime);
    if (!Number.isFinite(timestamp)) continue;
    events.push({
      t: timestamp,
      session,
      message: text(message.id) || String(index),
      model: text(message.model) || "gemini",
      ...usage
    });
  }
  return events;
}

function normalizeGeminiTokens(tokens) {
  const input = finiteNumber(tokens.input ?? tokens.promptTokenCount ?? tokens.inputTokens);
  const cached = finiteNumber(tokens.cached ?? tokens.cachedContentTokenCount ?? tokens.cachedTokens);
  const output = finiteNumber(tokens.output ?? tokens.candidatesTokenCount ?? tokens.outputTokens);
  const reasoning = finiteNumber(tokens.thoughts ?? tokens.thoughtsTokenCount ?? tokens.reasoningTokens);
  const tool = finiteNumber(tokens.tool ?? tokens.toolUsePromptTokenCount ?? tokens.toolTokens);
  const components = input + output + reasoning + tool;
  const reportedTotal = finiteNumber(tokens.total ?? tokens.totalTokenCount ?? tokens.totalTokens);
  return {
    input,
    cached,
    cacheWrite: 0,
    output: output + tool,
    reasoning,
    total: Math.max(reportedTotal, components)
  };
}

function listGeminiSessionFiles(roots) {
  const files = [];
  const seenDirs = new Set();
  const stack = (Array.isArray(roots) ? roots : [roots]).filter(Boolean).map((dir) => ({ dir, depth: 0 }));
  while (stack.length) {
    const { dir, depth } = stack.pop();
    const normalized = path.resolve(dir).toLowerCase();
    if (seenDirs.has(normalized) || !fs.existsSync(dir)) continue;
    seenDirs.add(normalized);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const isChatsDirectory = path.basename(dir).toLowerCase() === "chats";
    for (const entry of entries) {
      const item = path.join(dir, entry.name);
      if (entry.isDirectory() && !isChatsDirectory && depth < 2) {
        stack.push({ dir: item, depth: depth + 1 });
      } else if (
        entry.isFile()
        && /^session-.*\.json$/i.test(entry.name)
        && isChatsDirectory
      ) {
        files.push(item);
      }
    }
  }
  return [...new Set(files.map((file) => path.resolve(file)))];
}

function defaultGeminiRoots() {
  const configured = process.env.AI_QUOTA_GEMINI_ROOTS;
  if (configured) return configured.split(path.delimiter).filter(Boolean);
  return [path.join(os.homedir(), ".gemini", "tmp")];
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

module.exports = {
  defaultGeminiRoots,
  listGeminiSessionFiles,
  normalizeGeminiTokens,
  readGeminiSessionFile,
  readGeminiTokenHistory,
  readGeminiTokenUsage
};
