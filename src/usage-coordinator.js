"use strict";

const { enabledLocalSources } = require("./app-config-store");

const CURRENT_CACHE_TTL = 15_000;
const HISTORY_CACHE_TTL = 60_000;
const CUMULATIVE_CACHE_TTL = 5 * 60_000;

class UsageCoordinator {
  constructor({ workerClient, getConfig }) {
    this.workerClient = workerClient;
    this.getConfig = getConfig;
    this.clearCaches();
  }

  enabledLocalSources() {
    return enabledLocalSources(this.getConfig());
  }

  clearCaches() {
    this.generation = (this.generation || 0) + 1;
    this.cachedLocalUsage = null;
    this.cachedAntigravityUsage = null;
    this.lastLocalUsageTime = 0;
    this.lastAntigravityUsageTime = 0;
    this.historyCache = new Map();
    this.cumulativeCache = new Map();
    this.historyPending = new Map();
    this.cumulativePending = new Map();
  }

  async readLocalUsage(now = Date.now(), onProgress) {
    if (this.cachedLocalUsage && now - this.lastLocalUsageTime < CURRENT_CACHE_TTL) {
      return { ...this.cachedLocalUsage, fromCache: true };
    }
    const generation = this.generation;
    const value = await this.workerClient.request("localUsage", { sources: this.enabledLocalSources() }, (value) => {
      if (generation === this.generation) onProgress?.(value);
    });
    if (generation === this.generation) {
      this.cachedLocalUsage = value;
      this.lastLocalUsageTime = Date.now();
    }
    return value;
  }

  async readAntigravityUsage(now = Date.now()) {
    if (this.cachedAntigravityUsage && now - this.lastAntigravityUsageTime < CURRENT_CACHE_TTL) {
      return { ...this.cachedAntigravityUsage, fromCache: true };
    }
    const generation = this.generation;
    const value = await this.workerClient.request("antigravityUsage");
    if (generation === this.generation) {
      this.cachedAntigravityUsage = value;
      this.lastAntigravityUsageTime = Date.now();
    }
    return value;
  }

  readHistory(kind, model, sourceFilter = null) {
    const key = `${kind}:${sourceFilter || "all"}:${model}`;
    const cached = this.historyCache.get(key);
    if (cached && Date.now() - cached.at < HISTORY_CACHE_TTL) return Promise.resolve(cached.value);
    if (this.historyPending.has(key)) return this.historyPending.get(key);

    const operation = kind === "antigravity" ? "antigravityHistory" : "localHistory";
    const sources = sourceFilter ? [sourceFilter] : this.enabledLocalSources();
    const generation = this.generation;
    let pending;
    pending = this.workerClient.request(operation, { model, source: sourceFilter, sources, days: 45 })
      .then((value) => {
        if (generation === this.generation) this.historyCache.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => {
        if (this.historyPending.get(key) === pending) this.historyPending.delete(key);
      });
    this.historyPending.set(key, pending);
    return pending;
  }

  readCumulative(selection) {
    const key = selection || "all";
    const cached = this.cumulativeCache.get(key);
    if (cached && Date.now() - cached.at < CUMULATIVE_CACHE_TTL) return Promise.resolve(cached.value);
    if (this.cumulativePending.has(key)) return this.cumulativePending.get(key);

    const config = this.getConfig();
    const generation = this.generation;
    let pending;
    pending = this.workerClient.request("cumulative", {
      selection: key,
      enableCodex: config.enableCodex,
      enableClaudeCode: config.enableClaudeCode,
      enableOpenCode: config.enableOpenCode,
      enableGeminiCli: config.enableGeminiCli,
      enableCline: config.enableCline,
      enableAntigravity: config.enableAntigravity
    })
      .then((value) => {
        if (generation === this.generation) this.cumulativeCache.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => {
        if (this.cumulativePending.get(key) === pending) this.cumulativePending.delete(key);
      });
    this.cumulativePending.set(key, pending);
    return pending;
  }

  stop(force = false) {
    return this.workerClient.stop(force);
  }
}

module.exports = {
  CURRENT_CACHE_TTL,
  CUMULATIVE_CACHE_TTL,
  HISTORY_CACHE_TTL,
  UsageCoordinator
};
