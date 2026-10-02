"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { scanFilesIncrementally, getScanMetrics } = require("./incremental-scan-engine");

// Native ModelUsageStats and CortexStepMetadata, checked against local .db
// records. Read only token metadata; never serialize prompts or tool arguments.
function protobufFields(value) {
  const buffer = Buffer.from(value || []);
  const fields = [];
  let offset = 0;
  const varint = () => {
    let number = 0n;
    for (let shift = 0n; shift < 70n && offset < buffer.length; shift += 7n) {
      const byte = buffer[offset++];
      number |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return number;
    }
    throw new Error("Invalid Antigravity protobuf varint");
  };
  while (offset < buffer.length) {
    const tag = Number(varint()), field = tag >>> 3, wire = tag & 7;
    if (!field) throw new Error("Invalid Antigravity protobuf field");
    if (wire === 0) { fields.push({ field, number: varint() }); continue; }
    const length = wire === 2 ? Number(varint()) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > buffer.length) throw new Error("Invalid Antigravity protobuf length");
    fields.push({ field, bytes: buffer.subarray(offset, offset + length) });
    offset += length;
  }
  return fields;
}
const bytes = (fields, field) => fields.find(item => item.field === field)?.bytes;
const text = (fields, field) => bytes(fields, field)?.toString("utf8") || "";
function integer(fields, field) {
  const number = Number(fields.find(item => item.field === field)?.number || 0);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Invalid Antigravity token count");
  return number;
}
function timestamp(value) {
  const fields = protobufFields(value);
  const seconds = integer(fields, 1), nanos = integer(fields, 2);
  return seconds > 0 && nanos < 1e9 ? seconds * 1000 + Math.floor(nanos / 1e6) : null;
}
function stepIndices(fields) {
  const result = [];
  for (const field of fields.filter(item => item.field === 2)) {
    if (field.number !== undefined) result.push(Number(field.number));
    if (field.bytes) {
      // A packed repeated int32 is a sequence of varints without field tags.
      let number = 0, shift = 0;
      for (const byte of field.bytes) {
        number += (byte & 127) * 2 ** shift;
        if (byte & 128) { shift += 7; if (shift > 35) throw new Error("Invalid Antigravity step index"); }
        else { result.push(number); number = shift = 0; }
      }
      if (shift) throw new Error("Invalid Antigravity packed indices");
    }
  }
  return result;
}
function decodeGeneration(row, times, sessionId) {
  const root = protobufFields(row.data);
  const chat = protobufFields(bytes(root, 1));
  const usage = protobufFields(bytes(chat, 4));
  if (!usage.length) return null;
  const model = text(chat, 19) || text(chat, 21);
  if (!/(?:^|[^a-z0-9])gemini(?:[^a-z0-9]|$)/i.test(model)) return null;
  const cached = integer(usage, 5), cacheWrite = integer(usage, 4);
  // Antigravity stores cache hits/writes separately from uncached input.
  const input = integer(usage, 2) + cached + cacheWrite;
  const output = integer(usage, 3); // includes thinking tokens
  if (input + output === 0) return null;
  const reasoning = integer(usage, 9);
  const created = protobufFields(bytes(chat, 9));
  const at = bytes(created, 4) ? timestamp(bytes(created, 4)) : null;
  const indices = stepIndices(root);
  const recorded = indices.map(index => times.get(index)).filter(Number.isFinite);
  const t = at || (recorded.length ? Math.min(...recorded) : null);
  if (!t) throw new Error("Antigravity native usage has no recorded timestamp");
  return { t, model, sessionId, responseId: text(usage, 11) || text(root, 4) || String(row.idx),
    source: "antigravity", input, cached, cacheWrite, output, reasoning, total: input + output,
    reasoningIncluded: true, usageAccuracy: "native" };
}
function readDatabase(file) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; BEGIN");
    const rows = db.prepare("SELECT idx, data FROM gen_metadata ORDER BY idx").iterate();
    const times = new Map();
    for (const row of db.prepare("SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL").iterate()) {
      const metadata = protobufFields(row.metadata);
      const at = bytes(metadata, 1);
      if (at) times.set(row.idx, timestamp(at));
    }
    const sessionId = path.basename(file, ".db"), events = [], seen = new Set();
    for (const row of rows) {
      const event = decodeGeneration(row, times, sessionId);
      if (!event || seen.has(event.responseId)) continue;
      seen.add(event.responseId); events.push(event);
    }
    return events;
  } finally { db.close(); }
}
function walSignature(file) {
  try { const stat = fs.statSync(file + "-wal"); return `${stat.mtimeMs}:${stat.size}`; }
  catch (error) { if (error.code === "ENOENT") return "none"; throw error; }
}
function readNativeEvents(brainRoots) {
  const files = [];
  for (const brain of Array.isArray(brainRoots) ? brainRoots : [brainRoots]) {
    const directory = path.join(path.dirname(brain), "conversations");
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".db")) files.push(path.join(directory, entry.name));
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const parsed = scanFilesIncrementally([...new Set(files)], readDatabase, {
    namespace: "antigravity-native", retainDeleted: true, fileSignature: walSignature
  });
  const events = [], seen = new Set();
  for (const values of Object.values(parsed)) {
    for (const event of values) {
      const key = `${event.sessionId}:${event.responseId}`;
      if (!seen.has(key)) { seen.add(key); events.push(event); }
    }
  }
  const failures = getScanMetrics()["antigravity-native"]?.failures || 0;
  return { events, readError: failures ? `${failures} Antigravity native databases could not be read; using retained data` : null };
}
module.exports = { readNativeEvents, decodeGeneration, protobufFields };
