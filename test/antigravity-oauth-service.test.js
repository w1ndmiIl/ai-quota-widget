"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AntigravityOAuthService, QUOTA_URL, TOKEN_URL, normalizeCredentials, discoverOAuthClients } = require("../src/antigravity-oauth-service");
const now = Date.parse("2026-10-01T04:00:00Z");
function credential(access = "original", expired = false) {
  return { token: { access_token: access, refresh_token: "private-refresh+&%", expiry: new Date(now + (expired ? -1000 : 3600000)).toISOString() }, id_token: "test" };
}
const body = { groups: [] };
const goodClient = { clientId: "client", clientSecret: "private-client" };
test("uses existing valid Windows sign-in directly with the cached project", async () => {
  const calls = [];
  const service = new AntigravityOAuthService({ readCredentials: async () => credential(), now: () => now, getProject: () => "own-project",
    readClient: () => { throw new Error("No client scan should be necessary"); },
    request: async (url, options) => { calls.push({ url, options }); return body; } });
  assert.equal(await service.readQuota(), body);
  assert.deepEqual(calls, [{ url: QUOTA_URL, options: { token: "original", body: { project: "own-project" } } }]);
});
test("expired sign-in renews once, discovers the matching client, and reuses the in-memory token", async () => {
  const calls = [], failed = { statusCode: 400, oauthError: "invalid_client" };
  const service = new AntigravityOAuthService({ readCredentials: async () => credential("original", true), now: () => now, getProject: () => null,
    readClient: async () => [{ ...goodClient, clientSecret: "wrong" }, goodClient], request: async (url, options) => {
      calls.push({ url, options });
      if (url === TOKEN_URL) { if (options.form.client_secret === "wrong") throw failed; return { access_token: "renewed", expires_in: 3600 }; }
      assert.equal(options.token, "renewed"); return body;
    } });
  await service.readQuota(); await service.readQuota();
  assert.equal(calls.filter(call => call.url === TOKEN_URL).length, 2);
  assert.equal(calls.at(-1).options.token, "renewed");
  assert.equal(calls[1].options.form.refresh_token, "private-refresh+&%", "Literal characters must reach form encoding intact");
});
test("a 401 retries quota once with renewed sign-in, while 403 does not refresh", async () => {
  let quotaCalls = 0, renewals = 0;
  const service = new AntigravityOAuthService({ readCredentials: async () => credential(), now: () => now, getProject: () => null,
    readClient: async () => [goodClient], request: async url => {
      if (url === TOKEN_URL) { renewals++; return { access_token: "renewed", expires_in: 3600 }; }
      if (++quotaCalls === 1) throw { statusCode: 401 };
      return body;
    } });
  assert.equal(await service.readQuota(), body); assert.equal(quotaCalls, 2); assert.equal(renewals, 1);
  service.request = async () => { throw { statusCode: 403 }; };
  await assert.rejects(service.readQuota(), error => error.statusCode === 403); assert.equal(renewals, 1);
});
test("account changes cannot reuse the previous account's refreshed token or client", async () => {
  let current = credential("account-one", true);
  const tokens = [];
  const service = new AntigravityOAuthService({ readCredentials: async () => current, now: () => now, getProject: () => null,
    readClient: async () => [goodClient], request: async (url, options) => {
      if (url === TOKEN_URL) return { access_token: "renewed-one", expires_in: 3600 };
      tokens.push(options.token); return body;
    } });
  await service.readQuota(); current = credential("account-two"); await service.readQuota();
  assert.deepEqual(tokens, ["renewed-one", "account-two"]); assert.equal(service.refreshed, null); assert.equal(service.client, null);
});
test("revoked sign-in errors are sanitized and do not try additional client secrets", async () => {
  let attempts = 0;
  const service = new AntigravityOAuthService({ readCredentials: async () => credential("original", true), now: () => now,
    readClient: async () => [goodClient, goodClient], request: async () => {
      attempts++; const error = new Error("private-refresh+&%"); error.oauthError = "invalid_grant"; throw error;
    } });
  await assert.rejects(service.readQuota(), error => /sign in again/.test(error.message) && !error.message.includes("private-refresh"));
  assert.equal(attempts, 1);
  assert.throws(() => normalizeCredentials({ token: {} }), /access token/);
});
test("OAuth client discovery streams an installed artifact and matches the sign-in audience without running it", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-oauth-client-")), prior = process.env.PATH;
  process.env.PATH = dir;
  t.after(() => { process.env.PATH = prior; fs.rmSync(dir, { recursive: true, force: true }); });
  const audience = "123-example.apps.googleusercontent.com", secret = "GOCSPX-" + "a".repeat(28);
  const bytes = Buffer.concat([Buffer.alloc(65520, 0), Buffer.from(audience + "\0" + secret)]);
  fs.writeFileSync(path.join(dir, "agy.exe"), bytes);
  const idToken = "head." + Buffer.from(JSON.stringify({ aud: audience })).toString("base64url") + ".sig";
  assert.deepEqual(await discoverOAuthClients({ idToken }), [{ clientId: audience, clientSecret: secret }]);
  await assert.rejects(discoverOAuthClients({ idToken: "invalid" }), /identity is unavailable/);
});
