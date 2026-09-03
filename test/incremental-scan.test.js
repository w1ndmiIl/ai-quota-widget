"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { CACHE_VERSION, scanFilesIncrementally, getCachePath } = require("../src/incremental-scan-engine");

test("incremental scanning system", async (t) => {
  const tmpDir = path.join(os.tmpdir(), `ai-quota-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const cachePath = path.join(tmpDir, "history_accumulator_test.json");
  process.env.HISTORY_ACCUMULATOR_PATH = cachePath;

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.HISTORY_ACCUMULATOR_PATH;
  });

  await t.test("parses a new file and reuses its unchanged result", () => {
    const testFile = path.join(tmpDir, "test1.jsonl");
    fs.writeFileSync(testFile, "line1\nline2", "utf8");
    let parseCount = 0;

    const parse = () => {
      parseCount++;
      return { parsed: true, lines: 2 };
    };
    assert.deepStrictEqual(scanFilesIncrementally([testFile], parse)[testFile], { parsed: true, lines: 2 });
    assert.deepStrictEqual(scanFilesIncrementally([testFile], parse)[testFile], { parsed: true, lines: 2 });
    assert.strictEqual(parseCount, 1);
  });

  await t.test("invalidates old cache schemas after parser changes", () => {
    const testFile = path.join(tmpDir, "schema.jsonl");
    fs.writeFileSync(testFile, "line", "utf8");
    fs.writeFileSync(cachePath, JSON.stringify({ version: CACHE_VERSION - 1, namespaces: {} }), "utf8");
    let parseCount = 0;

    const warn = console.warn;
    console.warn = () => {};
    try {
      scanFilesIncrementally([testFile], () => {
        parseCount++;
        return { current: true };
      });
    } finally {
      console.warn = warn;
    }

    assert.strictEqual(parseCount, 1);
    assert.strictEqual(JSON.parse(fs.readFileSync(cachePath, "utf8")).version, CACHE_VERSION);
  });

  await t.test("does not serve stale data when a changed file fails to parse", () => {
    const testFile = path.join(tmpDir, "parse-error.jsonl");
    fs.writeFileSync(testFile, "first", "utf8");
    scanFilesIncrementally([testFile], () => ({ value: "old" }));
    fs.writeFileSync(testFile, "changed", "utf8");

    const error = console.error;
    console.error = () => {};
    let result;
    try {
      result = scanFilesIncrementally([testFile], () => {
        throw new Error("incomplete JSONL");
      });
    } finally {
      console.error = error;
    }

    assert.deepStrictEqual(result, {});
  });

  await t.test("keeps independent data-source namespaces isolated", () => {
    const first = path.join(tmpDir, "first.jsonl");
    const second = path.join(tmpDir, "second.jsonl");
    fs.writeFileSync(first, "first", "utf8");
    fs.writeFileSync(second, "second", "utf8");
    scanFilesIncrementally([first], () => ({ source: "first" }), { namespace: "first" });
    scanFilesIncrementally([second], () => ({ source: "second" }), { namespace: "second" });
    fs.unlinkSync(first);
    scanFilesIncrementally([], () => {}, { namespace: "first" });

    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    assert.deepStrictEqual(cache.namespaces.first.files, {});
    assert.ok(cache.namespaces.second.files[second]);
  });

  await t.test("sweeps deleted files from the active namespace", () => {
    const testFile = path.join(tmpDir, "deleted.jsonl");
    fs.writeFileSync(testFile, "line", "utf8");
    scanFilesIncrementally([testFile], () => ({ parsed: true }), { namespace: "deleted" });
    fs.unlinkSync(testFile);
    assert.deepStrictEqual(scanFilesIncrementally([], () => {}, { namespace: "deleted" }), {});

    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    assert.deepStrictEqual(cache.namespaces.deleted.files, {});
  });

  await t.test("retains settled data after source files are deleted", () => {
    const testFile = path.join(tmpDir, "durable.jsonl");
    fs.writeFileSync(testFile, "settled", "utf8");
    const options = { namespace: "durable", retainDeleted: true };
    scanFilesIncrementally([testFile], () => ({ total: 42 }), options);
    fs.unlinkSync(testFile);

    assert.deepStrictEqual(scanFilesIncrementally([], () => {}, options), {
      [testFile]: { total: 42 }
    });
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    assert.equal(cache.namespaces.durable.files[testFile].data.total, 42);
    assert.ok(cache.namespaces.durable.files[testFile].deletedAt > 0);
  });

  await t.test("replaces rather than double-counts a changed durable file", () => {
    const testFile = path.join(tmpDir, "durable-update.jsonl");
    const options = { namespace: "durable-update", retainDeleted: true };
    fs.writeFileSync(testFile, "first", "utf8");
    scanFilesIncrementally([testFile], () => ({ total: 10 }), options);
    fs.writeFileSync(testFile, "second-version", "utf8");
    assert.deepStrictEqual(scanFilesIncrementally([testFile], () => ({ total: 25 }), options), {
      [testFile]: { total: 25 }
    });
  });

  await t.test("keeps the last settled result while a durable file is temporarily invalid", () => {
    const testFile = path.join(tmpDir, "durable-invalid.jsonl");
    const options = { namespace: "durable-invalid", retainDeleted: true };
    fs.writeFileSync(testFile, "valid", "utf8");
    scanFilesIncrementally([testFile], () => ({ total: 18 }), options);
    fs.writeFileSync(testFile, "partial", "utf8");
    const error = console.error;
    console.error = () => {};
    try {
      assert.deepStrictEqual(scanFilesIncrementally([testFile], () => {
        throw new Error("partial write");
      }, options), { [testFile]: { total: 18 } });
    } finally {
      console.error = error;
    }
  });
});

test("uses the application user-data directory when supplied", (t) => {
  const previous = process.env.AI_QUOTA_USER_DATA_PATH;
  const dir = path.join(os.tmpdir(), `ai-quota-user-data-${Date.now()}`);
  delete process.env.HISTORY_ACCUMULATOR_PATH;
  process.env.AI_QUOTA_USER_DATA_PATH = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.AI_QUOTA_USER_DATA_PATH;
    else process.env.AI_QUOTA_USER_DATA_PATH = previous;
  });

  assert.strictEqual(getCachePath(), path.join(dir, "history_accumulator.json"));
});
