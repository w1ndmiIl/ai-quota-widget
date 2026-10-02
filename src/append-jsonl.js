"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const states = new Map();
const CHUNK_BYTES = 256 * 1024;
// The prefix hash detects in-place rewrites as well as truncation. Only newly
// appended complete lines are decoded and parsed; conversation text is not cached.
// Read buffers are bounded by one chunk plus the largest record, not the whole log.
function readAppendedEvents(file, parseLine) {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    const prior = states.get(file);
    let hash = crypto.createHash("sha256");
    let committedHash = hash.copy();
    let prefixTail = [];
    let prefixTailBytes = 0;
    let position = 0;
    let reusable = false;
    if (prior && stat.size >= prior.offset && prior.birthtime === stat.birthtimeMs) {
      while (position < prior.offset) {
        const boundary = position < prior.lineStart ? prior.lineStart : prior.offset;
        const length = fs.readSync(fd, buffer, 0, Math.min(buffer.length, boundary - position), position);
        if (!length) break;
        hash.update(buffer.subarray(0, length));
        if (position >= prior.lineStart) { prefixTail.push(Buffer.from(buffer.subarray(0, length))); prefixTailBytes += length; }
        position += length;
        if (position === prior.lineStart) committedHash = hash.copy();
      }
      reusable = position === prior.offset && hash.copy().digest("hex") === prior.hash;
    }
    const state = reusable ? prior : { offset: 0, lineStart: 0, events: [], parser: { model: null, ids: new Set() }, birthtime: stat.birthtimeMs };
    if (!reusable) { position = 0; hash = crypto.createHash("sha256"); committedHash = hash.copy(); prefixTail = []; prefixTailBytes = 0; }
    state.offset = state.lineStart;
    let parts = [];
    let partBytes = 0;
    const parseRecord = (segment) => {
      const bytes = parts.length ? Buffer.concat([...parts, segment], partBytes + segment.length) : segment;
      parts = []; partBytes = 0;
      let item;
      try { item = JSON.parse(bytes.toString("utf8")); } catch { return false; }
      try { const event = parseLine(item, state.parser); if (event) state.events.push(event); } catch {}
      return true;
    };
    while (position < stat.size) {
      const length = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (!length) break;
      const chunk = buffer.subarray(0, length);
      const lastNewline = chunk.lastIndexOf(10);
      if (lastNewline >= 0) {
        hash.update(chunk.subarray(0, lastNewline + 1));
        committedHash = hash.copy();
        state.offset = position + lastNewline + 1;
        state.lineStart = state.offset;
        prefixTail = []; prefixTailBytes = 0;
        hash.update(chunk.subarray(lastNewline + 1));
      } else hash.update(chunk);
      let start = 0;
      for (let newline = chunk.indexOf(10); newline >= 0; newline = chunk.indexOf(10, start)) {
        parseRecord(chunk.subarray(start, newline));
        start = newline + 1;
      }
      if (start < length) { const tail = Buffer.from(chunk.subarray(start)); parts.push(tail); partBytes += tail.length; }
      position += length;
    }
    // Decode a split UTF-8 record only after collecting all its bytes. A valid
    // final record needs no newline; an incomplete tail stays uncommitted.
    let completeTail = false;
    if (prefixTailBytes) {
      // An already accepted EOF record may be followed by more bytes before a
      // newline arrives. Validate the complete physical line before accepting
      // another unterminated record from just the appended suffix.
      try { JSON.parse(Buffer.concat([...prefixTail, ...parts], prefixTailBytes + partBytes).toString("utf8")); completeTail = true; } catch {}
      if (completeTail) parseRecord(Buffer.alloc(0));
    } else if (partBytes) completeTail = parseRecord(Buffer.alloc(0));
    if (completeTail) { state.offset = position; committedHash = hash; }
    state.hash = committedHash.digest("hex");
    states.set(file, state);
    // Bound residency independently of the durable ledger.
    if (states.size > 128) states.delete(states.keys().next().value);
    return state.events.slice();
  } finally {
    fs.closeSync(fd);
  }
}
module.exports = { readAppendedEvents };
