"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { sourceConfigMatches } = require("./app-config-store");

class DashboardSnapshotStore {
  constructor({ userDataPath, getConfig, io = fs.promises }) {
    this.userDataPath = userDataPath;
    this.snapshotPath = path.join(userDataPath, "dashboard_snapshot.json");
    this.getConfig = getConfig;
    this.io = io;
    this.cached = this.load();
    this.savePending = null;
    this.nextSnapshot = null;
    this.lastSaveError = null;
    this.writeId = 0;
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.snapshotPath, "utf8"));
    } catch {
      return null;
    }
  }

  getCached() {
    const config = this.getConfig();
    if (!this.cached || !sourceConfigMatches(this.cached, config)) return null;
    return { ...this.cached, config, stale: true };
  }

  save(snapshot) {
    if (!snapshot || (!snapshot.quota && !snapshot.antigravityQuota && !snapshot.localTokenUsage && !snapshot.antigravityTokenUsage)) return;
    this.cached = { ...snapshot, config: this.getConfig(), error: null, errors: [] };
    this.nextSnapshot = this.cached;
    if (!this.savePending) {
      this.savePending = Promise.resolve().then(() => this.drain()).finally(() => {
        this.savePending = null;
      });
    }
  }

  async drain() {
    while (this.nextSnapshot) {
      const snapshot = this.nextSnapshot;
      this.nextSnapshot = null;
      const temporary = `${this.snapshotPath}.${process.pid}.${++this.writeId}.tmp`;
      try {
        await this.io.mkdir(this.userDataPath, { recursive: true });
        await this.io.writeFile(temporary, JSON.stringify(snapshot), "utf8");
        await this.io.rename(temporary, this.snapshotPath);
        this.lastSaveError = null;
      } catch (error) {
        this.lastSaveError = error;
        console.error("Failed to save dashboard snapshot", error);
        try { await this.io.rm(temporary, { force: true }); } catch {}
      }
    }
  }

  async flush() {
    while (this.savePending) await this.savePending;
    if (this.lastSaveError) throw this.lastSaveError;
  }
}

module.exports = { DashboardSnapshotStore };
