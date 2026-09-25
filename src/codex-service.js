"use strict";

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { normalizeCodexQuota } = require("./quota-normalizer");
const { writeJson } = require("./atomic-json");

class CodexService extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.initialized = null;
    this.nextId = 1;
    this.pending = new Map();
    this.cacheFilePath = path.join(
      process.env.AI_QUOTA_USER_DATA_PATH || path.join(process.env.USERPROFILE || process.env.HOME || "", ".ai-quota-widget"),
      "codex_quota_cache.json"
    );
    this.legacyCacheFilePath = path.join(
      process.env.USERPROFILE || process.env.HOME || "",
      ".gemini",
      "antigravity",
      "quota_cache.json"
    );
    this.lastSnapshot = this.loadCache();
    this.lastError = null;
  }

  loadCache() {
    for (const filePath of [this.cacheFilePath, this.legacyCacheFilePath]) {
      try {
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, "utf8");
          return JSON.parse(content);
        }
      } catch (e) {
        // Ignore a malformed cache and try the next location.
      }
    }
    return null;
  }

  saveCache(snapshot) {
    try {
      if (!snapshot) return;
      const dir = path.dirname(this.cacheFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      writeJson(this.cacheFilePath, snapshot);
    } catch (e) {}
  }

  async readQuota() {
    await this.ensureStarted();
    // 额度是首屏必需数据；令可选的 token 统计并行读取，避免它拖慢刷新。
    const [rateLimits, usageResult] = await Promise.all([
      this.request("account/rateLimits/read"),
      this.request("account/usage/read", undefined, 1500).then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error: error.message })
      )
    ]);
    const response = rateLimits;
    const usage = usageResult.value;
    const usageError = usageResult.error;
    const snapshot = normalizeCodexQuota({ ...response, accountUsage: usage, usageError });
    if (!snapshot) {
      throw new Error("Codex rate-limit response did not contain quota data");
    }

    this.lastSnapshot = snapshot;
    this.saveCache(snapshot);
    this.lastError = null;
    return this.lastSnapshot;
  }

  getCachedQuota() {
    return this.lastSnapshot;
  }

  getLastError() {
    return this.lastError;
  }

  dispose() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex app-server stopped"));
    }
    this.pending.clear();
    const process = this.process;
    this.process = null;
    this.initialized = null;
    process?.kill();
  }

  async ensureStarted() {
    if (this.initialized) {
      return this.initialized;
    }

    this.initialized = new Promise((resolve, reject) => {
      const command = findCodexCommand();
      const process = spawn(command, ["app-server"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
      this.process = process;

      const stderrLines = [];
      const rl = readline.createInterface({ input: process.stdout });
      rl.on("line", (line) => this.handleLine(line));

      process.stderr.on("data", (chunk) => {
        const line = chunk.toString("utf8").trim();
        if (line) {
          stderrLines.push(line);
        }
      });

      process.on("error", (error) => {
        if (this.process !== process) return;
        this.lastError = error.message;
        this.initialized = null;
        reject(error);
      });

      process.on("exit", (code) => {
        if (this.process !== process) return;
        const message = `Codex app-server exited${code === null ? "" : ` with code ${code}`}`;
        this.lastError = stderrLines.at(-1) || message;
        this.process = null;
        this.initialized = null;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error(this.lastError));
        }
        this.pending.clear();
      });

      this.request("initialize", {
        clientInfo: {
          name: "ai_quota_widget",
          title: "AI Quota Widget",
          version: require("../package.json").version
        },
        capabilities: {
          experimentalApi: true
        }
      })
        .then(() => {
          this.notify("initialized", {});
          resolve();
        })
        .catch((error) => {
          if (this.process === process) {
            this.lastError = error.message;
            this.initialized = null;
          }
          reject(error);
        });
    });

    return this.initialized;
  }

  request(method, params, timeoutMs = 10000) {
    if (!this.process) {
      return Promise.reject(new Error("Codex app-server is not running"));
    }

    const id = this.nextId++;
    const payload = params === undefined ? { method, id, params: undefined } : { method, id, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method, params) {
    if (this.process) {
      this.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
    }
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (message.method === "account/rateLimits/updated") {
      const params = message.params ?? {};
      const snapshot = normalizeCodexQuota({
        ...params,
        accountUsage: this.lastSnapshot?.accountUsage ?? null,
        usageError: this.lastSnapshot?.usageError ?? null
      });

      if (!snapshot) {
        return;
      }

      this.lastSnapshot = snapshot;
      this.saveCache(snapshot);
      this.emit("quota-updated", snapshot);
    }
  }
}

function findCodexCommand() {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) {
    return process.env.CODEX_BIN;
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const binDir = path.join(localAppData, "OpenAI", "Codex", "bin");
    try {
      const candidates = fs
        .readdirSync(binDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(binDir, entry.name, "codex.exe"))
        .filter((candidate) => fs.existsSync(candidate))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (candidates[0]) {
        return candidates[0];
      }
    } catch {
      // Fall through to PATH lookup.
    }
  }

  return process.platform === "win32" ? "codex.exe" : "codex";
}

module.exports = {
  CodexService,
  findCodexCommand
};
