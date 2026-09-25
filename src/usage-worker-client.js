"use strict";

const { Worker } = require("node:worker_threads");

// History refreshes once per minute while visible. Keep the worker alive just
// beyond that cadence so normal refreshes reuse its loaded modules and caches.
const DEFAULT_WORKER_IDLE_MS = 75_000;

class UsageWorkerClient {
  constructor(workerPath, {
    idleMs = DEFAULT_WORKER_IDLE_MS,
    createWorker = (filename) => new Worker(filename)
  } = {}) {
    this.workerPath = workerPath;
    this.idleMs = idleMs;
    this.createWorker = createWorker;
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
    this.idleTimer = null;
    this.spawnCount = 0;
  }

  request(operation, payload = {}, onProgress) {
    const worker = this.getWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      worker.postMessage({ id, operation, payload });
    });
  }

  getWorker() {
    this.cancelIdle();
    if (this.worker) return this.worker;

    const worker = this.createWorker(this.workerPath);
    this.spawnCount += 1;
    worker.unref?.();
    worker.on("message", ({ id, result, error, progress }) => {
      const pending = this.pending.get(id);
      if (!pending) return;
      if (progress !== undefined) {
        pending.onProgress?.(progress);
        return;
      }
      this.pending.delete(id);
      if (error) pending.reject(new Error(error));
      else pending.resolve(result);
      this.scheduleIdle();
    });
    worker.on("error", (error) => {
      if (this.worker === worker) this.reset(error);
    });
    worker.on("exit", (code) => {
      if (this.worker === worker) this.reset(new Error(`Usage worker exited with code ${code}`));
    });
    this.worker = worker;
    return worker;
  }

  scheduleIdle() {
    if (!this.worker || this.pending.size || this.idleTimer) return;
    const worker = this.worker;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.worker !== worker || this.pending.size) return;
      this.worker = null;
      worker.terminate();
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  cancelIdle() {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  stop(force = false) {
    this.cancelIdle();
    if (!this.worker || (this.pending.size && !force)) return false;
    const worker = this.worker;
    this.worker = null;
    if (force && this.pending.size) {
      worker.postMessage({ id: 0, operation: "cancel" });
      setTimeout(() => worker.terminate(), 150).unref?.();
    } else worker.terminate();
    if (force) this.rejectPending(new Error("Usage worker stopped"));
    return true;
  }

  reset(error) {
    this.worker = null;
    this.cancelIdle();
    this.rejectPending(error);
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

module.exports = {
  DEFAULT_WORKER_IDLE_MS,
  UsageWorkerClient
};
