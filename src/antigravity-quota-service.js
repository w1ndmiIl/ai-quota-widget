"use strict";

const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { AntigravityOAuthService } = require("./antigravity-oauth-service");

const QUOTA_RPC_PATH = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const CACHE_TTL_MS = 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

class AntigravityQuotaService {
  constructor(options = {}) {
    const userDataPath = options.userDataPath
      || process.env.AI_QUOTA_USER_DATA_PATH
      || path.join(os.homedir(), ".ai-quota-widget");
    this.mainLogPath = options.mainLogPath || defaultMainLogPath();
    this.cachePath = options.cachePath || path.join(userDataPath, "antigravity_quota_cache.json");
    this.requestQuotaSummary = options.requestQuotaSummary || requestQuotaSummary;
    this.oauth = new AntigravityOAuthService(options.oauthOptions);
    this.requestDirectQuota = options.requestDirectQuota || (() => this.oauth.readQuota());
    this.now = options.now || Date.now;
    this.lastSnapshot = this.loadCache();
    this.lastReadAt = 0;
    this.pending = null;
  }

  getCachedQuota() {
    return this.lastSnapshot;
  }

  async readQuota({ force = false } = {}) {
    const now = this.now();
    if (!force && this.lastSnapshot && now - this.lastReadAt < CACHE_TTL_MS) return { ...this.lastSnapshot, fromCache: true };
    if (this.pending) return this.pending;

    this.pending = this.readFreshQuota().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  async readFreshQuota() {
    let snapshot, directError;
    try {
      snapshot = { ...normalizeAntigravityQuota(await this.requestDirectQuota(), this.now()), transport: "oauth" };
    } catch (error) {
      directError = error;
    }
    if (!snapshot) {
      try {
        const connection = discoverAntigravityConnection({ mainLogPath: this.mainLogPath });
        const payload = await this.requestQuotaSummary({ ...connection, timeoutMs: 1500 });
        snapshot = { ...normalizeAntigravityQuota(payload, this.now()), transport: "local" };
      } catch {
        if (this.lastSnapshot) return { ...this.lastSnapshot, fromCache: true, readError: directError.message };
        throw directError;
      }
    }

    this.lastSnapshot = snapshot;
    this.lastReadAt = this.now();
    this.saveCache(snapshot);
    return snapshot;
  }

  dispose() {
    this.oauth.refreshed = this.oauth.client = this.oauth.originalAccessToken = null;
  }

  loadCache() {
    try {
      const snapshot = JSON.parse(fs.readFileSync(this.cachePath, "utf8"));
      return snapshot?.source === "antigravity" ? snapshot : null;
    } catch {
      return null;
    }
  }

  saveCache(snapshot) {
    const temporaryPath = `${this.cachePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(temporaryPath, JSON.stringify(snapshot), "utf8");
      fs.renameSync(temporaryPath, this.cachePath);
    } catch {
      try { fs.rmSync(temporaryPath, { force: true }); } catch {}
    }
  }
}

function defaultMainLogPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "Antigravity", "logs", "main.log");
}

function discoverAntigravityConnection({ mainLogPath = defaultMainLogPath() } = {}) {
  let content;
  try {
    content = fs.readFileSync(mainLogPath, "utf8");
  } catch {
    throw new Error("Antigravity local service log is unavailable");
  }

  const token = lastCapture(content, /--csrf_token\s+([0-9a-f]{8}-[0-9a-f-]{27,})/gi);
  const portText = lastCapture(
    content,
    /(?:Reloading all windows with URL:|Local:\s+)\s*https:\/\/127\.0\.0\.1:(\d{1,5})\//gi
  );
  const port = Number(portText);
  if (!token || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Antigravity local quota service was not discovered");
  }
  return { port, csrfToken: token };
}

function lastCapture(content, pattern) {
  let value = null;
  for (const match of content.matchAll(pattern)) value = match[1];
  return value;
}

function encodeGrpcWebJson(value = {}) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(payload.length + 5);
  frame[0] = 0;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

function decodeGrpcWebJson(buffer) {
  let offset = 0;
  while (offset + 5 <= buffer.length) {
    const flags = buffer[offset];
    const length = buffer.readUInt32BE(offset + 1);
    offset += 5;
    if (length > MAX_RESPONSE_BYTES || offset + length > buffer.length) {
      throw new Error("Invalid Antigravity quota response frame");
    }
    const payload = buffer.subarray(offset, offset + length);
    offset += length;
    if ((flags & 0x80) === 0) return JSON.parse(payload.toString("utf8"));
  }
  throw new Error("Antigravity quota response did not contain data");
}

function requestQuotaSummary({ port, csrfToken, timeoutMs = 5000 }) {
  const body = encodeGrpcWebJson({});
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: "127.0.0.1",
      port,
      path: QUOTA_RPC_PATH,
      method: "POST",
      rejectUnauthorized: false,
      headers: {
        "content-type": "application/grpc-web+json",
        "content-length": body.length,
        "x-codeium-csrf-token": csrfToken,
        "x-grpc-web": "1",
        "x-user-agent": "CONNECT_ES_USER_AGENT"
      }
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(new Error("Antigravity quota response was too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Antigravity quota request failed (${response.statusCode || "unknown"})`));
          return;
        }
        try {
          resolve(decodeGrpcWebJson(Buffer.concat(chunks)));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Antigravity quota request timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

function normalizeAntigravityQuota(payload, updatedAt = Date.now()) {
  const groups = payload?.response?.groups ?? payload?.groups;
  if (!Array.isArray(groups)) throw new Error("Antigravity quota response did not contain groups");

  // Stable Gemini bucket IDs keep third-party Claude/GPT quotas out even when
  // Antigravity localizes or renames the display labels.
  const gemini = groups.find((group) => Array.isArray(group?.buckets)
    && group.buckets.some((bucket) => /^gemini-/i.test(bucket?.bucketId || "")));
  const buckets = gemini?.buckets || [];
  const shortWindow = normalizeBucket(buckets.find((bucket) => bucket.window === "5h"), 300, "5小时");
  const longWindow = normalizeBucket(buckets.find((bucket) => bucket.window === "weekly"), 10080, "周限额");
  if (!shortWindow && !longWindow) throw new Error("Antigravity Gemini quota was unavailable");

  return { source: "antigravity", group: "gemini", shortWindow, longWindow, updatedAt };
}

function normalizeBucket(bucket, durationMins, label) {
  if (bucket?.disabled === true) return null;
  const raw = bucket?.remainingFraction ?? bucket?.remaining?.remainingFraction
    ?? (bucket?.remaining?.case === "remainingFraction" ? bucket.remaining.value : null);
  if (raw == null || typeof raw === "boolean" || typeof raw === "string" && !raw.trim()) return null;
  const fraction = Number(raw);
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) return null;
  const remainingPercent = Math.round(fraction * 100);
  const resetsAt = Date.parse(bucket?.resetTime);
  return {
    label,
    durationMins,
    sourceKey: bucket.bucketId || null,
    remainingPercent,
    usedPercent: 100 - remainingPercent,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null
  };
}

module.exports = {
  AntigravityQuotaService,
  CACHE_TTL_MS,
  QUOTA_RPC_PATH,
  decodeGrpcWebJson,
  discoverAntigravityConnection,
  encodeGrpcWebJson,
  normalizeAntigravityQuota,
  requestQuotaSummary
};
