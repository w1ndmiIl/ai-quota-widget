"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { readUsageEvents, normalizeUsage, readLocalTokenUsage } = require("../src/token-usage-service");
const { CACHE_VERSION, scanFilesIncrementally } = require("../src/incremental-scan-engine");
const { mergeTokenItems } = require("../src/renderer/model-usage");
const { series } = require("../src/renderer/report-view");
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-audit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prior = process.env.HISTORY_ACCUMULATOR_PATH;
  process.env.HISTORY_ACCUMULATOR_PATH = path.join(dir, "ledger.json");
  t.after(() => { if (prior === undefined) delete process.env.HISTORY_ACCUMULATOR_PATH; else process.env.HISTORY_ACCUMULATOR_PATH = prior; });
  return dir;
}
function codexEvent(at, last, total) {
  return JSON.stringify({ timestamp: at, payload: { type: "token_count", info: {
    last_token_usage: { input_tokens: last, output_tokens: 2, total_tokens: last + 2 },
    total_token_usage: { input_tokens: total, output_tokens: 4, total_tokens: total + 4 }
  } } }) + "\n";
}
test("Codex repeated cumulative notifications are counted once, including append refreshes", (t) => {
  const file = path.join(temporary(t), "session.jsonl");
  fs.writeFileSync(file, codexEvent("2026-10-01T01:00:00Z", 10, 10));
  assert.equal(readUsageEvents(file).length, 1);
  fs.appendFileSync(file, codexEvent("2026-10-01T01:00:01Z", 10, 10));
  fs.appendFileSync(file, codexEvent("2026-10-01T01:00:02Z", 10, 20));
  const events = readUsageEvents(file);
  assert.equal(events.length, 2, "An identical last usage with increased cumulative tokens is a new request");
  assert.equal(events.reduce((sum, event) => sum + event.total, 0), 24);
  assert.equal(normalizeUsage({ input_tokens: 10, output_tokens: 8, reasoning_output_tokens: 5 }).total, 18);
});
test("parser upgrades reparse unchanged live files and keep removed settled history", (t) => {
  const dir = temporary(t), file = path.join(dir, "session.jsonl"), removed = path.join(dir, "removed.jsonl");
  fs.writeFileSync(file, codexEvent("2026-10-01T01:00:00Z", 10, 10) + codexEvent("2026-10-01T01:00:01Z", 10, 10));
  const stat = fs.statSync(file);
  const previous = { t: Date.parse("2026-10-01T01:00:00Z"), input: 10, cached: 0, output: 2, reasoning: 0, total: 12, model: "gpt-5" };
  fs.writeFileSync(process.env.HISTORY_ACCUMULATOR_PATH, JSON.stringify({ version: CACHE_VERSION, namespaces: { "codex-and-claude": { files: {
    [file]: { mtimeMs: stat.mtimeMs, size: stat.size, data: { events: [previous, previous] } },
    [removed]: { mtimeMs: 1, size: 1, data: { events: [{ ...previous, total: 50 }] } }
  }, lastSweepAt: 0 } } }));
  const usage = readLocalTokenUsage({ root: dir, now: Date.parse("2026-10-01T02:00:00Z") });
  assert.equal(usage.total, 62);
  const saved = JSON.parse(fs.readFileSync(process.env.HISTORY_ACCUMULATOR_PATH));
  assert.equal(saved.namespaces["codex-and-claude"].files[file].parserVersion, 1);
  assert.equal(saved.namespaces["codex-and-claude"].files[removed].data.events[0].total, 50);
  let reads = 0;
  scanFilesIncrementally([file], () => { reads++; }, { namespace: "codex-and-claude", retainDeleted: true, parserVersion: 1 });
  assert.equal(reads, 0, "The migration must not disable unchanged-file reuse");
});
test("estimated Antigravity input does not dilute native cache hit rates", () => {
  const local = { model: "gpt-6-sol", source: "codex", input: 100, cached: 80, output: 10, total: 110 };
  const estimated = { model: "gemini-3.8-flash", source: "antigravity", input: 900, cached: 0, output: 20, total: 920 };
  assert.equal(mergeTokenItems([local, estimated], "merged").cacheHitRate, 80);
  assert.equal(mergeTokenItems([estimated], "merged").cacheHitRate, null);
  assert.equal(mergeTokenItems([local, estimated], "merged").total, 1030);
});
test("manual reports reject a source change during invalidation before collecting disabled sources", async () => {
  let resolve, reports = 0;
  const invalidation = new Promise(done => { resolve = done; });
  const context = vm.createContext({ resolveRange() {}, appConfig: { enableAntigravity: false },
    usageCoordinator: { generation: 1, enabledLocalSources: () => ["codex"] },
    usageWorkerClient: { request(operation) { if (operation === "invalidate") return invalidation; reports++; return Promise.resolve({}); } }
  });
  const source = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  vm.runInContext(source.slice(source.indexOf("async function readUsageReport("), source.indexOf("app.whenReady().then", source.indexOf("async function readUsageReport("))), context);
  const pending = context.readUsageReport({ force: true });
  context.usageCoordinator.generation++;
  resolve();
  await assert.rejects(pending, /Settings changed/);
  assert.equal(reports, 0);
});
test("empty all-history reports render no artificial decades of chart points", () => {
  assert.deepEqual(series({ range: { preset: "all", days: 20000, start: 0, end: Date.now() }, history: { daily: {}, hourly: [] } }), []);
});
