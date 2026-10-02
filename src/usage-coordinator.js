"use strict";

const { enabledLocalSources } = require("./app-config-store");

const CURRENT_CACHE_TTL = 15_000;



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

  stop(force = false) {
    return this.workerClient.stop(force);
  }
}

module.exports = {
  CURRENT_CACHE_TTL,


  UsageCoordinator
};
