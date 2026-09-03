"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { sourceConfigMatches } = require("./app-config-store");

class DashboardSnapshotStore {
  constructor({ userDataPath, getConfig }) {
    this.userDataPath = userDataPath;
    this.snapshotPath = path.join(userDataPath, "dashboard_snapshot.json");
    this.getConfig = getConfig;
    this.cached = this.load();
    this.savePending = Promise.resolve();
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
    const serialized = JSON.stringify(this.cached);
    this.savePending = this.savePending
      .then(() => fs.promises.mkdir(this.userDataPath, { recursive: true }))
      .then(() => fs.promises.writeFile(this.snapshotPath, serialized, "utf8"))
      .catch(() => {});
  }

  flush() {
    return this.savePending;
  }
}

module.exports = { DashboardSnapshotStore };
