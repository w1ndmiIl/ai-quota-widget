"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readAppendedEvents } = require("../src/append-jsonl");

function temporaryFile(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-append-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "session.jsonl");
}

test("large logs parse split records and UTF-8 without whole-file reads", (t) => {
  const file = temporaryFile(t);
  const body = "a".repeat(256 * 1024 - 10) + "中🙂" + "b".repeat(256 * 1024);
  fs.writeFileSync(file, JSON.stringify({ body, total: 3 }) + "\r\n" + JSON.stringify({ total: 7 }) + "\n");
  const originalRead = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (target, ...args) => {
    assert.notEqual(target, file, "Session logs must not be buffered in full");
    return originalRead(target, ...args);
  });
  let records = 0;
  const parser = (item) => { records++; if (item.body) assert.equal(item.body, body); return { total: item.total }; };
  assert.deepEqual(readAppendedEvents(file, parser), [{ total: 3 }, { total: 7 }]);
  fs.appendFileSync(file, '{"total":11}\n');
  assert.deepEqual(readAppendedEvents(file, parser), [{ total: 3 }, { total: 7 }, { total: 11 }]);
  assert.equal(records, 3);
});

test("full prefix validation detects same-size middle rewrites with unchanged timestamps", (t) => {
  const file = temporaryFile(t);
  const padding = " ".repeat(300 * 1024) + "\n";
  fs.writeFileSync(file, padding + '{"total":1}\n' + padding);
  const parser = (item) => item;
  assert.deepEqual(readAppendedEvents(file, parser), [{ total: 1 }]);
  const stat = fs.statSync(file);
  const fd = fs.openSync(file, "r+");
  try { fs.writeSync(fd, Buffer.from('{"total":9}'), 0, 11, Buffer.byteLength(padding)); }
  finally { fs.closeSync(fd); }
  fs.utimesSync(file, stat.atime, stat.mtime);
  assert.deepEqual(readAppendedEvents(file, parser), [{ total: 9 }]);
});

test("incomplete UTF-8 tails remain pending and valid final records need no newline", (t) => {
  const file = temporaryFile(t);
  const record = Buffer.from(JSON.stringify({ label: "中🙂", total: 5 }));
  const split = record.indexOf(Buffer.from("🙂")) + 2;
  let records = 0;
  const parser = (item) => { records++; return item; };
  fs.writeFileSync(file, Buffer.concat([Buffer.from('{"total":1}\n'), record.subarray(0, split)]));
  assert.deepEqual(readAppendedEvents(file, parser), [{ total: 1 }]);
  assert.deepEqual(readAppendedEvents(file, parser), [{ total: 1 }]);
  fs.appendFileSync(file, record.subarray(split));
  assert.deepEqual(readAppendedEvents(file, parser), [{ total: 1 }, { label: "中🙂", total: 5 }]);
  fs.appendFileSync(file, '\n{"total":9}\n');
  assert.deepEqual(readAppendedEvents(file, parser), [{ total: 1 }, { label: "中🙂", total: 5 }, { total: 9 }]);
  assert.equal(records, 3);
});

test("truncation and replacement reset parser state while invalid complete lines are skipped", (t) => {
  const file = temporaryFile(t);
  const parser = (item, state) => {
    if (state.ids.has(item.id)) return null;
    state.ids.add(item.id);
    return { id: item.id, total: item.total };
  };
  fs.writeFileSync(file, '{"id":1,"total":10}\nmalformed\n{"id":1,"total":10}\n');
  assert.deepEqual(readAppendedEvents(file, parser), [{ id: 1, total: 10 }]);
  fs.writeFileSync(file, '{"id":1,"total":2}\n');
  assert.deepEqual(readAppendedEvents(file, parser), [{ id: 1, total: 2 }]);
  fs.unlinkSync(file);
  fs.writeFileSync(file, '{"id":1,"total":9}\n');
  assert.deepEqual(readAppendedEvents(file, parser), [{ id: 1, total: 9 }]);
});

test("an unterminated accepted record cannot turn a concatenated invalid EOF into another record", (t) => {
  const file = temporaryFile(t);
  const parser = (item) => item;
  fs.writeFileSync(file, '{"total":1}');
  assert.deepEqual(readAppendedEvents(file, parser), [{ total: 1 }]);
  assert.deepEqual(readAppendedEvents(file, parser), [{ total: 1 }]);
  fs.appendFileSync(file, '{"total":2}');
  assert.deepEqual(readAppendedEvents(file, parser), [{ total: 1 }]);
  fs.appendFileSync(file, '\n{"total":3}\n');
  assert.deepEqual(readAppendedEvents(file, parser), [{ total: 1 }, { total: 3 }]);
});
