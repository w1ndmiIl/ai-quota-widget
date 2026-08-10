"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  enabledLocalSources,
  loadAppConfig,
  persistAppConfig,
  sourceConfigChanged
} = require("../src/app-config-store");
const { DashboardSnapshotStore } = require("../src/dashboard-snapshot-store");
const { UsageCoordinator } = require("../src/usage-coordinator");
const { DEFAULT_WORKER_IDLE_MS, UsageWorkerClient } = require("../src/usage-worker-client");
const ModelUsage = require("../src/renderer/model-usage");

test("loads legacy settings through centralized defaults and persists updates", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ enableCodex: false, hotkeys: { refresh: "Ctrl+R" } }), "utf8");

  const config = loadAppConfig(configPath);
  assert.equal(config.enableCodex, false);
  assert.equal(config.enableOpenCode, true);
  assert.equal(config.enableGeminiCli, true);
  assert.equal(config.hotkeys.refresh, "Ctrl+R");
  assert.deepEqual(enabledLocalSources(config), ["claude", "opencode", "gemini", "cline"]);

  persistAppConfig(configPath, { ...config, enableCline: false });
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).enableCline, false);
  assert.equal(sourceConfigChanged(config, { ...config, enableCline: false }), true);
});

test("invalidates cached dashboard snapshots when enabled sources change", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-snapshot-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let config = loadAppConfig(path.join(dir, "missing.json"));
  const store = new DashboardSnapshotStore({ userDataPath: dir, getConfig: () => config });
  store.save({ quota: { shortWindow: {} }, updatedAt: 1 });
  await store.flush();
  assert.equal(store.getCached().stale, true);
  config = { ...config, enableOpenCode: false };
  assert.equal(store.getCached(), null);
});

test("reuses the usage worker across the one-minute history cadence", async () => {
  let created = 0;
  let terminated = 0;
  class FakeWorker extends EventEmitter {
    unref() {}
    postMessage(message) {
      queueMicrotask(() => this.emit("message", { id: message.id, result: message.operation }));
    }
    terminate() {
      terminated += 1;
      return Promise.resolve();
    }
  }
  const client = new UsageWorkerClient("unused", {
    createWorker: () => {
      created += 1;
      return new FakeWorker();
    }
  });

  assert.ok(DEFAULT_WORKER_IDLE_MS > 60_000);
  assert.equal(await client.request("first"), "first");
  assert.equal(await client.request("second"), "second");
  assert.equal(created, 1);
  assert.equal(client.spawnCount, 1);
  assert.equal(client.stop(true), true);
  assert.equal(terminated, 1);
});

test("coalesces identical history work in the usage coordinator", async () => {
  const calls = [];
  let resolveHistory;
  const workerClient = {
    request(operation, payload) {
      calls.push({ operation, payload });
      if (operation === "localHistory") {
        return new Promise((resolve) => { resolveHistory = resolve; });
      }
      return Promise.resolve({ total: 1 });
    },
    stop() { return true; }
  };
  const config = loadAppConfig("missing-config.json");
  const coordinator = new UsageCoordinator({ workerClient, getConfig: () => config });
  const first = coordinator.readHistory("local", "all");
  const second = coordinator.readHistory("local", "all");
  assert.strictEqual(first, second);
  assert.equal(calls.length, 1);
  resolveHistory({ daily: {}, hourly: [] });
  await first;
  await coordinator.readHistory("local", "all");
  assert.equal(calls.length, 1);
});

test("does not let stale worker results overwrite caches after source changes", async () => {
  const resolvers = [];
  const workerClient = {
    request() {
      return new Promise((resolve) => resolvers.push(resolve));
    },
    stop() { return true; }
  };
  const config = loadAppConfig("missing-config.json");
  const coordinator = new UsageCoordinator({ workerClient, getConfig: () => config });
  const stale = coordinator.readHistory("local", "all");
  coordinator.clearCaches();
  const fresh = coordinator.readHistory("local", "all");
  assert.equal(resolvers.length, 2);

  resolvers[0]({ daily: { stale: { total: 1 } }, hourly: [] });
  await stale;
  assert.strictEqual(coordinator.readHistory("local", "all"), fresh);
  resolvers[1]({ daily: { fresh: { total: 2 } }, hourly: [] });
  await fresh;
  assert.deepEqual((await coordinator.readHistory("local", "all")).daily, { fresh: { total: 2 } });
});

test("keeps renderer model aggregation behavior in a pure module", () => {
  const snapshot = {
    localTokenUsage: {
      total: 30,
      input: 20,
      cached: 5,
      cacheWrite: 0,
      output: 10,
      reasoning: 0,
      modelUsage: [{ model: "gpt-5", source: "codex", input: 20, cached: 5, output: 10, total: 30 }],
      modelCatalog: [{ model: "gpt-5", source: "codex", input: 100, cached: 20, output: 30, total: 130 }]
    },
    antigravityTokenUsage: { total: 7, input: 5, cached: null, output: 2, reasoning: 0, modelUsage: [] }
  };
  const models = ModelUsage.buildMergedModels(snapshot);
  assert.equal(models.length, 1);
  assert.equal(models[0].currentUsage, true);
  assert.equal(ModelUsage.getTokenForModel(snapshot, "codex:gpt-5").total, 30);
  assert.equal(ModelUsage.getTokenForModel(snapshot, "all").total, 37);
});
