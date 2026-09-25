"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  readClineTokenHistory,
  readClineTokenUsage
} = require("../src/cline-token-service");
const {
  readGeminiTokenHistory,
  readGeminiTokenUsage
} = require("../src/gemini-token-service");
const {
  parseSessionExport,
  parseSessionList,
  parseStatsOutput,
  readOpenCodeTokenUsage
} = require("../src/opencode-token-service");

test("reads and deduplicates Cline token events across migrated task roots", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-cline-"));
  const previousCachePath = process.env.HISTORY_ACCUMULATOR_PATH;
  process.env.HISTORY_ACCUMULATOR_PATH = path.join(dir, "history-cache.json");
  t.after(() => {
    if (previousCachePath === undefined) delete process.env.HISTORY_ACCUMULATOR_PATH;
    else process.env.HISTORY_ACCUMULATOR_PATH = previousCachePath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const now = Date.parse("2026-08-10T12:00:00Z");
  const event = {
    type: "say",
    say: "api_req_started",
    ts: now,
    text: JSON.stringify({ tokensIn: 100, tokensOut: 30, cacheReads: 20, cacheWrites: 10 })
  };
  const roots = [path.join(dir, "old"), path.join(dir, "new")];
  for (const root of roots) {
    const task = path.join(root, "task-1");
    fs.mkdirSync(task, { recursive: true });
    fs.writeFileSync(path.join(task, "ui_messages.json"), JSON.stringify([event]), "utf8");
    fs.writeFileSync(path.join(task, "task_metadata.json"), JSON.stringify({ api: { modelId: "anthropic/claude-sonnet-4-6" } }), "utf8");
  }

  const usage = readClineTokenUsage({ now: now + 60_000, roots });
  assert.equal(usage.input, 130);
  assert.equal(usage.cached, 20);
  assert.equal(usage.cacheWrite, 10);
  assert.equal(usage.output, 30);
  assert.equal(usage.total, 160);
  assert.equal(usage.sessions, 1);
  assert.deepEqual(usage.modelUsage.map(({ model, source, input, cached, cacheWrite, output, reasoning, total }) => ({
    model, source, input, cached, cacheWrite, output, reasoning, total
  })), [{
    model: "anthropic/claude-sonnet-4-6",
    source: "cline",
    input: 130,
    cached: 20,
    cacheWrite: 10,
    output: 30,
    reasoning: 0,
    total: 160
  }]);
  assert.equal(usage.modelUsage[0].pricingSettled, true);
  assert.ok(usage.modelUsage[0].estimatedUsd > 0);
  const history = readClineTokenHistory({ now: now + 60_000, roots, model: "anthropic/claude-sonnet-4-6" });
  assert.equal(Object.values(history.daily)[0].total, 160);
  assert.equal(history.hourly.reduce((sum, item) => sum + item.total, 0), 160);
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  const retained = readClineTokenUsage({ now: now + 60_000, roots });
  assert.equal(retained.total, 160);
  assert.equal(retained.modelUsage[0].model, "anthropic/claude-sonnet-4-6");
});

test("reads Gemini CLI session token summaries without loading transcript content", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-gemini-"));
  const previousCachePath = process.env.HISTORY_ACCUMULATOR_PATH;
  process.env.HISTORY_ACCUMULATOR_PATH = path.join(dir, "history-cache.json");
  t.after(() => {
    if (previousCachePath === undefined) delete process.env.HISTORY_ACCUMULATOR_PATH;
    else process.env.HISTORY_ACCUMULATOR_PATH = previousCachePath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const now = Date.parse("2026-08-10T12:00:00Z");
  const chats = path.join(dir, "project-hash", "chats");
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(path.join(chats, "session-123.json"), JSON.stringify({
    sessionId: "session-123",
    projectHash: "project-hash",
    startTime: new Date(now - 60_000).toISOString(),
    lastUpdated: new Date(now).toISOString(),
    messages: [{
      id: "response-1",
      timestamp: new Date(now).toISOString(),
      type: "gemini",
      content: [{ text: "private transcript text" }],
      model: "gemini-2.5-pro",
      tokens: { input: 100, output: 30, cached: 40, thoughts: 10, tool: 5, total: 145 }
    }]
  }), "utf8");

  const usage = readGeminiTokenUsage({ now: now + 1_000, roots: [dir] });
  assert.equal(usage.input, 100);
  assert.equal(usage.cached, 40);
  assert.equal(usage.output, 35);
  assert.equal(usage.reasoning, 10);
  assert.equal(usage.total, 145);
  assert.equal(usage.cacheHitRate, 40);
  assert.equal(usage.sessions, 1);
  assert.deepEqual(usage.modelUsage.map(({ model, source, input, cached, cacheWrite, output, reasoning, total }) => ({
    model, source, input, cached, cacheWrite, output, reasoning, total
  })), [{
    model: "gemini-2.5-pro",
    source: "gemini",
    input: 100,
    cached: 40,
    cacheWrite: 0,
    output: 35,
    reasoning: 10,
    total: 145
  }]);
  assert.equal(usage.modelUsage[0].pricingSettled, true);
  assert.ok(usage.modelUsage[0].estimatedUsd > 0);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "history-cache.json"), "utf8"), /private transcript text/);
  const history = readGeminiTokenHistory({ now: now + 1_000, roots: [dir], model: "gemini-2.5-pro" });
  assert.equal(Object.values(history.daily)[0].total, 145);
  fs.rmSync(path.join(dir, "project-hash"), { recursive: true, force: true });
  const retained = readGeminiTokenUsage({ now: now + 1_000, roots: [dir] });
  assert.equal(retained.total, 145);
  assert.equal(retained.modelUsage[0].model, "gemini-2.5-pro");
});

test("parses OpenCode session lists and exact exported assistant usage", () => {
  const updated = Date.parse("2026-08-10T11:00:00Z");
  assert.deepEqual(parseSessionList(`log line\n${JSON.stringify([{ id: "ses_1", updated }])}`), [{ id: "ses_1", updated }]);
  const exported = {
    info: { id: "ses_1" },
    messages: [{
      info: {
        id: "msg_1",
        role: "assistant",
        providerID: "anthropic",
        modelID: "claude-sonnet-4-6",
        time: { completed: updated },
        tokens: { input: 100, output: 30, reasoning: 5, cache: { read: 20, write: 10 } }
      },
      parts: []
    }]
  };
  assert.deepEqual(parseSessionExport(JSON.stringify(exported), { id: "ses_1", updated }), [{
    t: updated,
    session: "ses_1",
    model: "anthropic/claude-sonnet-4-6",
    input: 130,
    cached: 20,
    cacheWrite: 10,
    output: 30,
    reasoning: 5,
    total: 165
  }]);
});

test("reads OpenCode usage through its read-only session export commands", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-opencode-"));
  const previousUserData = process.env.AI_QUOTA_USER_DATA_PATH;
  process.env.AI_QUOTA_USER_DATA_PATH = dir;
  t.after(() => {
    if (previousUserData === undefined) delete process.env.AI_QUOTA_USER_DATA_PATH;
    else process.env.AI_QUOTA_USER_DATA_PATH = previousUserData;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const now = Date.parse("2026-08-10T12:00:00Z");
  const calls = [];
  let sessionExists = true;
  const runner = (_binary, args) => {
    calls.push(args);
    if (args[0] === "session") {
      return { ok: true, stdout: JSON.stringify(sessionExists ? [{ id: "ses_1", updated: now }] : []) };
    }
    return {
      ok: true,
      stdout: JSON.stringify({
        info: { id: "ses_1" },
        messages: [{
          info: { id: "msg_1", role: "assistant", modelID: "gpt-5", time: { created: now }, tokens: { input: 50, output: 10, cache: { read: 5, write: 0 } } },
          parts: [{ type: "text", text: "private transcript text" }]
        }]
      })
    };
  };
  const usage = await readOpenCodeTokenUsage({ now: now + 1_000, binary: "opencode-test", runner });
  assert.equal(usage.total, 65);
  assert.equal(usage.sessions, 1);
  assert.deepEqual(calls, [
    ["session", "list", "--format", "json"],
    ["export", "ses_1", "--sanitize"]
  ]);
  const cache = fs.readFileSync(path.join(dir, "opencode_usage_cache.json"), "utf8");
  assert.doesNotMatch(cache, /private transcript text/);
  sessionExists = false;
  const retained = await readOpenCodeTokenUsage({ now: now + 1_000, binary: "opencode-test", runner, refreshTtl: 0 });
  assert.equal(retained.total, 65);
  assert.equal(retained.sessions, 1);
  assert.deepEqual(calls.at(-1), ["session", "list", "--format", "json"]);
});

test("parses official OpenCode stats output for fast dashboard totals", () => {
  const output = [
    "┌────────────────────────────────────────────────────────┐",
    "│ OVERVIEW │",
    "├────────────────────────────────────────────────────────┤",
    "│Sessions                                              2 │",
    "└────────────────────────────────────────────────────────┘",
    "│ COST & TOKENS │",
    "│Input                                              1.2K │",
    "│Output                                              200 │",
    "│Cache Read                                          300 │",
    "│Cache Write                                         100 │",
    "│ MODEL USAGE │",
    "│ anthropic/claude-sonnet-4-6                           │",
    "│ Messages                                              3 │",
    "│ Input Tokens                                       1.2K │",
    "│ Output Tokens                                       200 │",
    "│ Cache Read                                          300 │",
    "│ Cache Write                                         100 │",
    "└────────────────────────────────────────────────────────┘"
  ].join("\n");
  const usage = parseStatsOutput(output);
  assert.equal(usage.sessions, 2);
  assert.equal(usage.input, 1_600);
  assert.equal(usage.total, 1_800);
  assert.deepEqual(usage.modelUsage.map(({ model, source, input, cached, cacheWrite, output, reasoning, total }) => ({
    model, source, input, cached, cacheWrite, output, reasoning, total
  })), [{
    model: "anthropic/claude-sonnet-4-6",
    source: "opencode",
    input: 1_600,
    cached: 300,
    cacheWrite: 100,
    output: 200,
    reasoning: 0,
    total: 1_800
  }]);
});
