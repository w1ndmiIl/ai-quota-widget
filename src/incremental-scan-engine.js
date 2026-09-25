"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// Bump this whenever the parsed event format or parsing rules change.
const CACHE_VERSION = 4;
const SWEEP_INTERVAL_MS = 5 * 60_000;
let memoryCache = null;
let memoryCachePath = null;
let memoryCacheSignature = null;
const scanMetrics = {};
function namespacePath(namespace) {
  const file = getCachePath();
  return process.env.AI_QUOTA_PARTITION_LEDGER === "1" && namespace
    ? file.replace(/\.json$/, `.${namespace.replace(/[^a-z0-9-]/gi, "_")}.json`) : file;
}

function getCachePath() {
  if (process.env.HISTORY_ACCUMULATOR_PATH) {
    return process.env.HISTORY_ACCUMULATOR_PATH;
  }

  const userDataPath = process.env.AI_QUOTA_USER_DATA_PATH;
  if (userDataPath) {
    return path.join(userDataPath, "history_accumulator.json");
  }

  // Fallback for direct Node usage outside the Electron main process.
  return path.join(os.homedir(), ".gemini", "antigravity", "history_accumulator.json");
}

function emptyCache() {
  return { version: CACHE_VERSION, namespaces: {} };
}

function loadCache(namespace) {
  const cachePath = namespacePath(namespace);
  try {
    const stat = fs.statSync(cachePath);
    const signature = `${stat.mtimeMs}:${stat.size}`;
    if (memoryCache && memoryCachePath === cachePath && memoryCacheSignature === signature) {
      return memoryCache;
    }

    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (cache?.version === CACHE_VERSION && cache.namespaces && typeof cache.namespaces === "object") {
      memoryCache = cache;
      memoryCachePath = cachePath;
      memoryCacheSignature = signature;
      return cache;
    }
    console.warn("Ignoring incompatible history accumulator cache");
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (cachePath !== getCachePath()) {
        try {
          const legacy = JSON.parse(fs.readFileSync(getCachePath(), "utf8"));
          if (legacy.version === CACHE_VERSION && legacy.namespaces?.[namespace]) {
            const migrated = { version: CACHE_VERSION, namespaces: { [namespace]: legacy.namespaces[namespace] } };
            saveCache(migrated, namespace); return migrated;
          }
        } catch {}
      }
      if (memoryCachePath !== cachePath || memoryCacheSignature !== null) {
        memoryCache = emptyCache();
        memoryCachePath = cachePath;
        memoryCacheSignature = null;
      }
      return memoryCache;
    }
    console.error("Failed to load history accumulator cache", error);
  }
  memoryCache = emptyCache();
  memoryCachePath = cachePath;
  memoryCacheSignature = null;
  return memoryCache;
}

function saveCache(cache, namespace) {
  const cachePath = namespacePath(namespace);
  const dir = path.dirname(cachePath);
  const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temporaryPath, JSON.stringify(cache), "utf8");
    fs.renameSync(temporaryPath, cachePath);
    const stat = fs.statSync(cachePath);
    memoryCache = cache;
    memoryCachePath = cachePath;
    memoryCacheSignature = `${stat.mtimeMs}:${stat.size}`;
  } catch (error) {
    console.error("Failed to save history accumulator cache", error);
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Ignore failed temporary-file cleanup.
    }
  }
}

function getNamespace(cache, namespace) {
  const existing = cache.namespaces[namespace];
  if (existing?.files && typeof existing.files === "object") {
    return existing;
  }

  const state = { files: {}, lastSweepAt: 0 };
  cache.namespaces[namespace] = state;
  return state;
}

function sweepDeletedFiles(state, retainDeleted) {
  let dirty = false;
  for (const cachedFile of Object.keys(state.files)) {
    const cachedItem = state.files[cachedFile];
    if (fs.existsSync(cachedFile)) {
      if (cachedItem.deletedAt) {
        delete cachedItem.deletedAt;
        dirty = true;
      }
    } else if (retainDeleted) {
      if (!cachedItem.deletedAt) {
        cachedItem.deletedAt = Date.now();
        dirty = true;
      }
    } else {
      delete state.files[cachedFile];
      dirty = true;
    }
  }
  state.lastSweepAt = Date.now();
  return dirty;
}

function scanFilesIncrementally(filePaths, parseFile, {
  namespace = "default",
  retainDeleted = false,
  retainLastValid = retainDeleted
} = {}) {
  const started = Date.now();
  let parsed = 0;
  let failures = 0;
  const cache = loadCache(namespace);
  const state = getNamespace(cache, namespace);
  let dirty = false;

  for (const filePath of filePaths) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      failures++;
      continue;
    }

    const { mtimeMs, size } = stat;
    const cachedItem = state.files[filePath];
    if (cachedItem && cachedItem.mtimeMs === mtimeMs && cachedItem.size === size) {
      if (cachedItem.deletedAt) {
        delete cachedItem.deletedAt;
        dirty = true;
      }
      continue;
    }

    try {
      let data = parseFile(filePath);
      const recoveredEvents = cachedItem?.recoveredEvents;
      if (namespace === "antigravity" && Array.isArray(data) && Array.isArray(recoveredEvents)) {
        const key = (event) => JSON.stringify([event.sessionId,event.t,event.model,event.output,event.reasoning]);
        const known = new Set(data.map(key));
        data = [...data,...recoveredEvents.filter((event) => !known.has(key(event)))].sort((a,b)=>a.t-b.t);
      }
      state.files[filePath] = { mtimeMs, size, data, ...(recoveredEvents ? { recoveredEvents } : {}) };
      parsed++;
      dirty = true;
    } catch (error) {
      failures++;
      console.error(`Failed to parse file: ${filePath}`, error);
      // A changed file must never silently fall back to an older parsed result.
      if (cachedItem && !retainLastValid) {
        delete state.files[filePath];
        dirty = true;
      }
    }
  }

  const now = Date.now();
  if (!filePaths.length || now - (state.lastSweepAt || 0) >= SWEEP_INTERVAL_MS) {
    dirty = sweepDeletedFiles(state, retainDeleted) || dirty;
  }

  if (dirty) saveCache(cache, namespace);
  scanMetrics[namespace] = { files: filePaths.length, parsed, reused: filePaths.length - parsed, failures, elapsedMs: Date.now()-started, at: Date.now() };

  const result = {};
  const resultPaths = retainDeleted ? Object.keys(state.files) : filePaths;
  for (const filePath of resultPaths) {
    const cachedItem = state.files[filePath];
    if (cachedItem) result[filePath] = cachedItem.data;
  }
  return result;
}

module.exports = {
  CACHE_VERSION,
  scanFilesIncrementally,
  getCachePath
  , getScanMetrics: () => ({ ...scanMetrics })
};
