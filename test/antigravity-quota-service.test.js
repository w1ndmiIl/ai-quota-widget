"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AntigravityQuotaService, decodeGrpcWebJson, discoverAntigravityConnection, encodeGrpcWebJson, normalizeAntigravityQuota } = require("../src/antigravity-quota-service");
function payload(short = 0.75, weekly = 0.5) {
  return { groups: [
    { displayName: "Gemini Models", buckets: [
      { bucketId: "gemini-weekly", window: "weekly", remainingFraction: weekly, resetTime: "2026-10-05T10:00:00Z" },
      { bucketId: "gemini-5h", window: "5h", remainingFraction: short, resetTime: "2026-10-01T10:00:00Z" }
    ] },
    { displayName: "Claude and GPT", buckets: [{ bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.1 }] }
  ] };
}
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-cloud-quota-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
test("discovers the latest already-running Antigravity loopback service", t => {
  const mainLogPath = path.join(temporary(t), "main.log");
  fs.writeFileSync(mainLogPath, [
    "Spawning: language_server --csrf_token 11111111-1111-4111-8111-111111111111",
    "Local: https://127.0.0.1:41000/",
    "Spawning: language_server --csrf_token 22222222-2222-4222-8222-222222222222",
    "Local: https://127.0.0.1:42000/"
  ].join("\n"));
  assert.deepEqual(discoverAntigravityConnection({ mainLogPath }), { port: 42000, csrfToken: "22222222-2222-4222-8222-222222222222" });
});
test("normalizes actual grouped cloud and local quota while excluding third-party models", () => {
  const body = { response: payload(1, 0.93849975) };
  assert.deepEqual(decodeGrpcWebJson(encodeGrpcWebJson(body)), body);
  const snapshot = normalizeAntigravityQuota(body, 123);
  assert.equal(snapshot.shortWindow.remainingPercent, 100);
  assert.equal(snapshot.longWindow.remainingPercent, 94);
  assert.equal(snapshot.updatedAt, 123);
});
test("cloud reads work with no installed or running Antigravity process and coalesce refreshes", async t => {
  let resolve, calls = 0, local = 0;
  const gate = new Promise(done => { resolve = done; });
  const service = new AntigravityQuotaService({ userDataPath: temporary(t), mainLogPath: "missing",
    requestDirectQuota: async () => { calls++; return gate; }, requestQuotaSummary: () => { local++; }, now: () => 1000 });
  const first = service.readQuota({ force: true }), second = service.readQuota({ force: true });
  resolve(payload(0.8, 0.6));
  const [one, two] = await Promise.all([first, second]);
  assert.deepEqual(one, two); assert.equal(calls, 1); assert.equal(local, 0);
  assert.equal(one.transport, "oauth"); assert.equal(one.shortWindow.remainingPercent, 80);
  assert.equal((await service.readQuota()).fromCache, true); assert.equal(calls, 1);
});
test("failed remote and local reads retain the valid quota, original timestamp and a visible error", async t => {
  let fail = false;
  const dir = temporary(t);
  const service = new AntigravityQuotaService({ userDataPath: dir, mainLogPath: path.join(dir, "missing"), now: () => 2000,
    requestDirectQuota: async () => { if (fail) throw new Error("OAuth expired"); return payload(0.6, 0.4); } });
  const first = await service.readQuota({ force: true }); fail = true;
  const cached = await service.readQuota({ force: true });
  assert.equal(cached.shortWindow.remainingPercent, 60); assert.equal(cached.updatedAt, first.updatedAt);
  assert.equal(cached.fromCache, true); assert.equal(cached.readError, "OAuth expired");
  const persisted = JSON.parse(fs.readFileSync(service.cachePath));
  assert.equal(persisted.readError, undefined); assert.equal(persisted.shortWindow.remainingPercent, 60);
});
test("remote failure may reuse a running local service, without any startup fallback", async t => {
  const mainLogPath = path.join(temporary(t), "main.log");
  fs.writeFileSync(mainLogPath, "Spawning: language_server --csrf_token 33333333-3333-4333-8333-333333333333\nLocal: https://127.0.0.1:43000/");
  let connection;
  const service = new AntigravityQuotaService({ mainLogPath, userDataPath: temporary(t),
    requestDirectQuota: async () => { throw new Error("network unavailable"); },
    requestQuotaSummary: async value => { connection = value; return payload(0.7, 0.5); } });
  const snapshot = await service.readQuota({ force: true });
  assert.equal(snapshot.transport, "local"); assert.equal(connection.port, 43000);
});
test("availability-only and malformed quota responses cannot become measured 100%", () => {
  assert.throws(() => normalizeAntigravityQuota({ models: { gemini: { quotaInfo: { remainingFraction: 1 } } } }));
  for (const fraction of [null, "", false, -0.1, 1.1]) assert.throws(() => normalizeAntigravityQuota(payload(fraction, fraction)));
  const zero = normalizeAntigravityQuota(payload(0, 0)); assert.equal(zero.shortWindow.remainingPercent, 0);
  const tagged = payload(); tagged.groups[0].buckets[0] = { ...tagged.groups[0].buckets[0], remainingFraction: undefined, remaining: { case: "remainingFraction", value: 0.45 } };
  assert.equal(normalizeAntigravityQuota(tagged).longWindow.remainingPercent, 45);
});
