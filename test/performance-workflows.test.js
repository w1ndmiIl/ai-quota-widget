"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { DashboardSnapshotStore } = require("../src/dashboard-snapshot-store");
const { readLocalTokenUsage, readTokenHistory } = require("../src/token-usage-service");
const { readOpenCodeTokenUsage, readOpenCodeTokenHistory } = require("../src/opencode-token-service");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function temporary(t, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-workflows-"));
  if (env) {
    const old = process.env[env];
    process.env[env] = env === "HISTORY_ACCUMULATOR_PATH" ? path.join(dir, "ledger.json") : dir;
    t.after(() => { if (old === undefined) delete process.env[env]; else process.env[env] = old; });
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("reuses one log enumeration across current, history and cumulative views without changing totals", (t) => {
  const dir = temporary(t, "HISTORY_ACCUMULATOR_PATH");
  const roots = [path.join(dir, ".codex", "sessions"), path.join(dir, ".claude", "projects")];
  const now = Date.now();
  for (const root of roots) fs.mkdirSync(root, { recursive: true });
  for (let i = 0; i < 100; i++) {
    fs.writeFileSync(path.join(roots[1], `${i}.jsonl`), JSON.stringify({
      type: "assistant", timestamp: new Date(now).toISOString(),
      message: { id: `msg-${i}`, model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 2 } }
    }));
  }
  const options = { now: now + 1000, root: roots, sources: ["codex", "claude"], catalogDays: null };
  const baselineUsage = readLocalTokenUsage(options);
  const baselineHistory = readTokenHistory({ ...options, source: options.sources });
  const readdir = fs.readdirSync;
  let enumerations = 0;
  t.mock.method(fs, "readdirSync", (...args) => { enumerations++; return readdir(...args); });
  assert.deepEqual(readLocalTokenUsage({ ...options, eventCacheTtl: 15_000 }), baselineUsage);
  const firstEnumerations = enumerations;
  assert.ok(firstEnumerations > 0);
  assert.deepEqual(readTokenHistory({ ...options, source: options.sources, eventCacheTtl: 15_000 }), baselineHistory);
  assert.equal(readLocalTokenUsage({ ...options, days: 9999, eventCacheTtl: 15_000 }).total, baselineUsage.total);
  assert.equal(enumerations, firstEnumerations);
  assert.equal(baselineUsage.total, 1200);
  // Explicit uncached reads see new data and invalidate the shared event snapshot.
  fs.writeFileSync(path.join(roots[1], "extra.jsonl"), JSON.stringify({ type: "assistant", timestamp: new Date(now).toISOString(),
    message: { id: "extra", model: "claude-sonnet-4-6", usage: { input_tokens: 7, output_tokens: 1 } } }));
  assert.equal(readLocalTokenUsage(options).total, 1208);
  assert.equal(readLocalTokenUsage({ ...options, eventCacheTtl: 15_000 }).total, 1208);
});

test("OpenCode shares asynchronous exports, serves cached progress, and reuses the session list", async (t) => {
  temporary(t, "AI_QUOTA_USER_DATA_PATH");
  const now = Date.now();
  const exporting = deferred();
  const started = deferred();
  const calls = [];
  const runner = async (_binary, args) => {
    calls.push(args[0]);
    if (args[0] === "session") return { ok: true, stdout: JSON.stringify([{ id: "one", updated: now }]) };
    started.resolve();
    await exporting.promise;
    return { ok: true, stdout: JSON.stringify({ messages: [{ info: { role: "assistant", modelID: "gpt-5",
      time: { created: now }, tokens: { input: 10, output: 2 } } }] }) };
  };
  const progress = [];
  const options = { binary: "fake", runner, now: now + 1000 };
  const first = readOpenCodeTokenUsage({ ...options, onProgress: (value) => progress.push(value) });
  await started.promise;
  const second = readOpenCodeTokenHistory(options);
  assert.equal(progress.length, 1);
  // Another worker message/event-loop turn remains runnable during a slow export.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["session", "export"]);
  exporting.resolve();
  assert.equal((await first).total, 12);
  assert.equal(Object.values((await second).daily)[0].total, 12);
  assert.equal((await readOpenCodeTokenUsage(options)).total, 12);
  assert.deepEqual(calls, ["session", "export"]);
  const retained = await readOpenCodeTokenUsage({ ...options, refreshTtl: 0,
    runner: async () => ({ ok: false, stdout: "" }) });
  assert.equal(retained.total, 12);
});

test("OpenCode publishes bounded batches before the final session completes", async (t) => {
  temporary(t, "AI_QUOTA_USER_DATA_PATH");
  const now = Date.now();
  const last = deferred();
  const startedLast = deferred();
  const progress = [];
  let exports = 0;
  const runner = async (_binary, args) => {
    if (args[0] === "session") return { ok: true, stdout: JSON.stringify(Array.from({ length: 21 }, (_, i) => ({ id: String(i), updated: now }))) };
    exports++;
    if (exports === 21) { startedLast.resolve(); await last.promise; }
    return { ok: true, stdout: JSON.stringify({ messages: [{ info: { role: "assistant", modelID: "gpt-5",
      time: { created: now }, tokens: { input: 1, output: 1 } } }] }) };
  };
  const pending = readOpenCodeTokenUsage({ binary: "fake", runner, now: now + 1000, onProgress: (value) => progress.push(value) });
  assert.equal((await pending).partial, true);
  const sameBatch = await readOpenCodeTokenHistory({ binary: "fake", runner, now: now + 1000, skipRefresh: true });
  assert.equal(Object.values(sameBatch.daily).reduce((sum,day)=>sum+day.total,0),40);
  assert.equal(exports,20);
  const continuation = readOpenCodeTokenUsage({ binary: "fake", runner, now: now + 1000, refreshTtl: 0 });
  await startedLast.promise;
  assert.equal(progress.at(-1).total, 40);
  last.resolve();
  assert.equal((await continuation).total, 42);
});

test("snapshot writes coalesce bursts and drain the latest update received during a write", async (t) => {
  const dir = temporary(t);
  const gate = deferred();
  const writing = deferred();
  const writes = [];
  const io = { ...fs.promises, async writeFile(file, data, encoding) {
    writes.push(JSON.parse(data).updatedAt);
    if (writes.length === 1) { writing.resolve(); await gate.promise; }
    return fs.promises.writeFile(file, data, encoding);
  } };
  const store = new DashboardSnapshotStore({ userDataPath: dir, getConfig: () => ({}), io });
  const save = (updatedAt) => store.save({ quota: { total: 1 }, updatedAt });
  save(1); save(2); save(3);
  await writing.promise;
  save(4); save(5);
  gate.resolve();
  await store.flush();
  assert.deepEqual(writes, [3, 5]);
  assert.equal(JSON.parse(fs.readFileSync(store.snapshotPath, "utf8")).updatedAt, 5);
  assert.deepEqual(fs.readdirSync(dir), ["dashboard_snapshot.json"]);
});

test("a failed atomic snapshot replacement preserves the previous file and a later save recovers", async (t) => {
  const dir = temporary(t);
  let fail = false;
  const io = { ...fs.promises, async rename(...args) {
    if (fail) throw new Error("disk unavailable");
    return fs.promises.rename(...args);
  } };
  t.mock.method(console, "error", () => {});
  const store = new DashboardSnapshotStore({ userDataPath: dir, getConfig: () => ({}), io });
  store.save({ quota: { total: 1 } });
  await store.flush();
  fail = true;
  store.save({ quota: { total: 2 } });
  await assert.rejects(store.flush(), /disk unavailable/);
  assert.equal(JSON.parse(fs.readFileSync(store.snapshotPath, "utf8")).quota.total, 1);
  assert.deepEqual(fs.readdirSync(dir), ["dashboard_snapshot.json"]);
  fail = false;
  store.save({ quota: { total: 3 } });
  await store.flush();
  assert.equal(JSON.parse(fs.readFileSync(store.snapshotPath, "utf8")).quota.total, 3);
});

function snapshotHarness() {
  const source = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const published = [];
  let cached = null;
  const context = vm.createContext({
    appConfig: { enableCodex: true, enableAntigravity: false },
    isCompact: false, isQuitting: false, snapshotInFlight: null, cachedResetCredits: null,
    codex: { getCachedQuota: () => null, readQuota: async () => ({ total: 1 }) },
    usageCoordinator: { generation: 1, clearCaches() { this.generation++; }, stop() {}, enabledLocalSources: () => ["claude"], readLocalUsage: async () => ({ total: 12 }) },
    snapshotStore: { getCached: () => cached, save: (value) => { cached = value; } },
    mainWindow: { webContents: { send: (_channel, value) => published.push(value) } },
    publishNotices() {},
    readCachedResetCredits: async () => null
  });
  vm.runInContext(source.slice(source.indexOf("async function readSnapshot({"), source.indexOf("function startAntigravityQuotaRefresh()")), context);
  return { context, published, get cached() { return cached; } };
}

test("fast token data is published before slow quota, and failed sources keep the last valid result", async () => {
  const h = snapshotHarness();
  const quota = deferred();
  h.context.codex.readQuota = () => quota.promise;
  const pending = h.context.readSnapshot();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.published.at(-1).localTokenUsage.total, 12);
  assert.equal(h.published.at(-1).refreshing, true);
  quota.resolve({ total: 50 });
  assert.equal((await pending).quota.total, 50);
  h.context.codex.readQuota = async () => { throw new Error("offline"); };
  const failed = await h.context.readSnapshot();
  assert.equal(failed.quota.total, 50);
  assert.equal(failed.error, "offline");
  assert.equal(failed.refreshing, false);
});

test("superseded source requests cannot publish into new settings", async () => {
  const h = snapshotHarness();
  const quota = deferred();
  h.context.codex.readQuota = () => quota.promise;
  const pending = h.context.readSnapshot();
  await new Promise((resolve) => setImmediate(resolve));
  h.context.usageCoordinator.generation++;
  const count = h.published.length;
  quota.resolve({ total: 999 });
  assert.equal((await pending).superseded, true);
  assert.equal(h.published.length, count);
});

test("compact refresh reads quota only and an expanded refresh restores token collection", async () => {
  const h = snapshotHarness();
  let reads = 0;
  h.context.usageCoordinator.readLocalUsage = async () => { reads++; return { total: 12 }; };
  h.context.isCompact = true;
  await h.context.readSnapshotOnce();
  assert.equal(reads, 0);
  h.context.isCompact = false;
  await h.context.readSnapshotOnce();
  assert.equal(reads, 1);
});

test("concurrent manual upgrades share one follow-up snapshot", async () => {
  const h = snapshotHarness();
  const firstQuota = deferred();
  let calls = 0;
  h.context.codex.readQuota = () => ++calls === 1 ? firstQuota.promise : Promise.resolve({ total: 2 });
  const automatic = h.context.readSnapshotOnce();
  const first = h.context.readSnapshotOnce({ allowAntigravityStart: true });
  const second = h.context.readSnapshotOnce({ allowAntigravityStart: true });
  firstQuota.resolve({ total: 1 });
  await Promise.all([automatic, first, second]);
  assert.equal(calls, 2);
});

test("history polling stops in compact/hidden mode and drops an invisible in-flight render", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/renderer/renderer.js"), "utf8");
  const timers = new Map();
  let timerId = 0;
  let reads = 0;
  let renders = 0;
  const history = deferred();
  const context = vm.createContext({
    isCompact: true, document: { hidden: false }, historyRenderingEnabled: true,
    historyRenderTimer: null, historyRenderInFlight: false, historyRenderQueued: false,
    historyRenderQueuedImmediate: false, lastHistoryRenderAt: 0, HISTORY_RENDER_INTERVAL: 60_000,
    dashboardControls: null, selectedModel: "claude:one", parseModelSelection: () => ({ source: "claude", model: "one" }),
    window: { aiQuota: { readTokenHistory: () => { reads++; return history.promise; } } },
    renderTrendWithData: () => { renders++; }, renderHeatmapWithData: () => { renders++; },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id)
  });
  vm.runInContext(source.slice(source.indexOf("function cancelHistoryRender()"), source.indexOf("function mergeDailyMaps(")), context);
  context.scheduleHistoryRender(true);
  assert.equal(timers.size, 0);
  context.isCompact = false;
  context.scheduleHistoryRender(true);
  let scheduled = [...timers.values()][0];
  timers.clear();
  const pending = scheduled.callback();
  assert.equal(reads, 1);
  context.isCompact = true;
  context.cancelHistoryRender();
  history.resolve({ daily: {}, hourly: [] });
  await pending;
  assert.equal(renders, 0);
  assert.equal(timers.size, 0);
  context.isCompact = false;
  context.scheduleHistoryRender(true);
  scheduled = [...timers.values()][0];
  timers.clear();
  await scheduled.callback();
  assert.equal(renders, 2);
  assert.ok([...timers.values()][0].delay > 59_000);
  context.document.hidden = true;
  context.cancelHistoryRender();
  context.scheduleHistoryRender(true);
  assert.equal(timers.size, 0);
});

test("normal shutdown waits for pending snapshots and ignores repeated quit requests", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const flush = deferred();
  let quitHandler;
  let quits = 0;
  let flushes = 0;
  let prevented = 0;
  const context = vm.createContext({
    app: { on: (_name, handler) => { quitHandler = handler; }, quit: () => { quits++; } },
    isQuitting: false, globalShortcut: { unregisterAll() {} }, codex: { dispose() {} },
    antigravityQuota: { dispose() {} }, antigravityQuotaTimer: null, cancelBackgroundIdle() {},
    usageCoordinator: { stop() {} },
    snapshotStore: { flush: () => { flushes++; return flush.promise; } },
    setTimeout, clearTimeout, clearInterval, console
  });
  vm.runInContext(source.slice(source.indexOf("let shutdownComplete = false;"), source.indexOf('app.on("window-all-closed"')), context);
  const event = { preventDefault: () => { prevented++; } };
  quitHandler(event);
  quitHandler(event);
  assert.equal(flushes, 1);
  assert.equal(quits, 0);
  assert.equal(prevented, 2);
  flush.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quits, 1);
  quitHandler(event);
  assert.equal(prevented, 2);
});
