"use strict";

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const QUOTA_RPC_PATH = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const CACHE_TTL_MS = 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

class AntigravityQuotaService {
  constructor(options = {}) {
    const userDataPath = options.userDataPath
      || process.env.AI_QUOTA_USER_DATA_PATH
      || path.join(os.homedir(), ".ai-quota-widget");
    this.mainLogPath = options.mainLogPath || defaultMainLogPath();
    this.languageServerPath = options.languageServerPath || defaultLanguageServerPath();
    this.cachePath = options.cachePath || path.join(userDataPath, "antigravity_quota_cache.json");
    this.requestQuotaSummary = options.requestQuotaSummary || requestQuotaSummary;
    this.spawnLanguageServer = options.spawnLanguageServer || spawn;
    this.now = options.now || Date.now;
    this.lastSnapshot = this.loadCache();
    this.lastReadAt = 0;
    this.pending = null;
    this.pendingAllowsStart = false;
    this.temporaryProcess = null;
  }

  getCachedQuota() {
    return this.lastSnapshot;
  }

  async readQuota({ allowStart = false, force = false } = {}) {
    const now = this.now();
    if (!force && this.lastSnapshot && now - this.lastReadAt < CACHE_TTL_MS) return this.lastSnapshot;
    if (this.pending) {
      if (!allowStart || this.pendingAllowsStart) return this.pending;
      try { await this.pending; } catch {}
    }

    this.pendingAllowsStart = allowStart;
    this.pending = this.readFreshQuota(now, { allowStart }).finally(() => {
      this.pending = null;
      this.pendingAllowsStart = false;
    });
    return this.pending;
  }

  async readFreshQuota(now, { allowStart }) {
    let payload;
    try {
      const connection = discoverAntigravityConnection({ mainLogPath: this.mainLogPath });
      payload = await this.requestQuotaSummary({ ...connection, timeoutMs: 1500 });
    } catch (error) {
      if (!allowStart) {
        if (this.lastSnapshot) return this.lastSnapshot;
        throw new Error("Antigravity is not running; click refresh to update its quota", { cause: error });
      }
      payload = await this.readWithTemporaryServer();
    }

    const snapshot = normalizeAntigravityQuota(payload, now);
    this.lastSnapshot = snapshot;
    this.lastReadAt = now;
    this.saveCache(snapshot);
    return snapshot;
  }

  readWithTemporaryServer() {
    if (!fs.existsSync(this.languageServerPath)) {
      return Promise.reject(new Error("Antigravity is not installed"));
    }

    const csrfToken = crypto.randomUUID();
    const process = this.spawnLanguageServer(this.languageServerPath, temporaryServerArgs(csrfToken), {
      cwd: path.dirname(this.languageServerPath),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.temporaryProcess = process;

    return new Promise((resolve, reject) => {
      let settled = false;
      let quotaReadStarted = false;
      let output = "";
      const timeout = setTimeout(() => finish(new Error("Antigravity background quota service timed out")), 15_000);
      timeout.unref?.();

      const finish = (error, payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (this.temporaryProcess === process) this.temporaryProcess = null;
        try { process.kill(); } catch {}
        error ? reject(error) : resolve(payload);
      };

      const inspectOutput = (chunk) => {
        if (quotaReadStarted) return;
        output = (output + chunk.toString("utf8")).slice(-30_000);
        const match = output.match(/listening on \w+ port at (\d+) for HTTPS/i);
        if (!match) return;
        quotaReadStarted = true;
        requestQuotaWithRetry(this.requestQuotaSummary, {
          port: Number(match[1]),
          csrfToken
        }).then((payload) => finish(null, payload), finish);
      };

      process.stdout?.on("data", inspectOutput);
      process.stderr?.on("data", inspectOutput);
      process.once("error", finish);
      process.once("exit", (code) => {
        if (!settled) finish(new Error(`Antigravity background quota service exited (${code ?? "unknown"})`));
      });
    });
  }

  dispose() {
    const process = this.temporaryProcess;
    this.temporaryProcess = null;
    try { process?.kill(); } catch {}
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

function defaultLanguageServerPath() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "Programs", "Antigravity", "resources", "bin", "language_server.exe");
}

function temporaryServerArgs(csrfToken) {
  return [
    "--standalone",
    "--override_ide_name", "antigravity",
    "--subclient_type", "hub",
    "--override_user_agent_name", "antigravity",
    "--https_server_port", "0",
    "--csrf_token", csrfToken,
    "--app_data_dir", "antigravity",
    "--api_server_url", "https://generativelanguage.googleapis.com",
    "--cloud_code_endpoint", "https://daily-cloudcode-pa.googleapis.com"
  ];
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

async function requestQuotaWithRetry(request, connection) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await request({ ...connection, timeoutMs: 3000 });
    } catch (error) {
      lastError = error;
      if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }
  throw lastError;
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
  const fraction = Number(bucket?.remainingFraction);
  if (!Number.isFinite(fraction)) return null;
  const remainingPercent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
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
  requestQuotaSummary,
  temporaryServerArgs
};
