"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const {
  AntigravityQuotaService,
  decodeGrpcWebJson,
  discoverAntigravityConnection,
  encodeGrpcWebJson,
  normalizeAntigravityQuota,
  temporaryServerArgs
} = require("../src/antigravity-quota-service");

function quotaPayload(short = 0.75, weekly = 0.5) {
  return { response: { groups: [
    { displayName: "Gemini Models", buckets: [
      { bucketId: "gemini-weekly", window: "weekly", remainingFraction: weekly, resetTime: "2026-09-05T10:17:16Z" },
      { bucketId: "gemini-5h", window: "5h", remainingFraction: short, resetTime: "2026-09-03T14:59:23Z" }
    ] },
    { displayName: "Claude and GPT models", buckets: [
      { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.1 },
      { bucketId: "3p-5h", window: "5h", remainingFraction: 0.2 }
    ] }
  ] } };
}

test("discovers the latest running Antigravity loopback service", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-antigravity-quota-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mainLogPath = path.join(dir, "main.log");
  fs.writeFileSync(mainLogPath, [
    "Spawning: language_server --csrf_token 11111111-1111-4111-8111-111111111111",
    "[Auto-Restart] Port changed! Reloading all windows with URL: https://127.0.0.1:41000/",
    "Spawning: language_server --csrf_token 22222222-2222-4222-8222-222222222222",
    "Local: https://127.0.0.1:42000/"
  ].join("\n"), "utf8");

  assert.deepEqual(discoverAntigravityConnection({ mainLogPath }), {
    port: 42000,
    csrfToken: "22222222-2222-4222-8222-222222222222"
  });
});

test("decodes grpc-web JSON and keeps only the Gemini quota group", () => {
  const payload = quotaPayload(1, 0.93849975);
  assert.deepEqual(decodeGrpcWebJson(encodeGrpcWebJson(payload)), payload);
  const snapshot = normalizeAntigravityQuota(payload, 123);
  assert.equal(snapshot.shortWindow.remainingPercent, 100);
  assert.equal(snapshot.longWindow.remainingPercent, 94);
  assert.equal(snapshot.updatedAt, 123);
});

test("starts a hidden short-lived Antigravity service when the GUI is closed", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-antigravity-headless-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const languageServerPath = path.join(dir, "language_server.exe");
  fs.writeFileSync(languageServerPath, "test", "utf8");
  let child;
  let spawnCalls = 0;
  let kills = 0;
  let requestedConnection;
  const spawnLanguageServer = (_executable, args, options) => {
    spawnCalls += 1;
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { kills += 1; };
    child.args = args;
    child.options = options;
    return child;
  };
  const service = new AntigravityQuotaService({
    userDataPath: dir,
    mainLogPath: path.join(dir, "missing.log"),
    languageServerPath,
    spawnLanguageServer,
    requestQuotaSummary: async (connection) => {
      requestedConnection = connection;
      return quotaPayload();
    },
    now: () => 1000
  });

  const first = service.readQuota({ allowStart: true, force: true });
  const second = service.readQuota({ allowStart: true, force: true });
  child.stderr.write("Language server listening on random port at 54321 for HTTPS (gRPC)\n");
  const [snapshot, duplicateSnapshot] = await Promise.all([first, second]);

  assert.equal(spawnCalls, 1);
  assert.deepEqual(duplicateSnapshot, snapshot);
  assert.equal(kills, 1);
  assert.equal(child.options.windowsHide, true);
  assert.ok(temporaryServerArgs("csrf").includes("antigravity"));
  assert.equal(requestedConnection.port, 54321);
  assert.equal(snapshot.shortWindow.remainingPercent, 75);
  assert.equal(snapshot.longWindow.remainingPercent, 50);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "antigravity_quota_cache.json"), "utf8")).source, "antigravity");
});

test("keeps cached quota without starting Antigravity during automatic refresh", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-antigravity-auto-cache-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cachePath = path.join(dir, "antigravity_quota_cache.json");
  fs.writeFileSync(cachePath, JSON.stringify({
    source: "antigravity",
    group: "gemini",
    shortWindow: { remainingPercent: 60 },
    longWindow: { remainingPercent: 40 },
    updatedAt: 500
  }), "utf8");
  let spawnCalls = 0;
  const service = new AntigravityQuotaService({
    cachePath,
    mainLogPath: path.join(dir, "missing.log"),
    languageServerPath: path.join(dir, "language_server.exe"),
    spawnLanguageServer: () => { spawnCalls += 1; }
  });

  const snapshot = await service.readQuota({ allowStart: false, force: true });
  assert.equal(snapshot.shortWindow.remainingPercent, 60);
  assert.equal(snapshot.updatedAt, 500);
  assert.equal(spawnCalls, 0);
});

test("automatic refresh reads an already-running Antigravity service", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-antigravity-auto-live-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mainLogPath = path.join(dir, "main.log");
  fs.writeFileSync(mainLogPath, [
    "Spawning: language_server --csrf_token 33333333-3333-4333-8333-333333333333",
    "Local: https://127.0.0.1:43000/"
  ].join("\n"), "utf8");
  let spawnCalls = 0;
  let requestedConnection;
  const service = new AntigravityQuotaService({
    userDataPath: dir,
    mainLogPath,
    languageServerPath: path.join(dir, "missing.exe"),
    spawnLanguageServer: () => { spawnCalls += 1; },
    requestQuotaSummary: async (connection) => {
      requestedConnection = connection;
      return quotaPayload(0.8, 0.6);
    },
    now: () => 2000
  });

  const snapshot = await service.readQuota({ allowStart: false, force: true });
  assert.equal(requestedConnection.port, 43000);
  assert.equal(snapshot.shortWindow.remainingPercent, 80);
  assert.equal(snapshot.longWindow.remainingPercent, 60);
  assert.equal(spawnCalls, 0);
});
