"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const states = new Map();
// The prefix hash detects in-place rewrites as well as truncation. Only newly
// appended complete lines are decoded and parsed; conversation text is not cached.
function readAppendedEvents(file, parseLine) {
  const stat = fs.statSync(file);
  const buffer = fs.readFileSync(file);
  const prior = states.get(file);
  const prefixLength = prior?.offset || 0;
  const digest = (data) => crypto.createHash("sha256").update(data).digest("hex");
  const reusable = prior && buffer.length >= prefixLength && prior.birthtime === stat.birthtimeMs && digest(buffer.subarray(0, prefixLength)) === prior.hash;
  const state = reusable ? prior : { offset: 0, events: [], parser: { model: null, ids: new Set() }, birthtime: stat.birthtimeMs };
  let end = buffer.lastIndexOf(10) + 1;
  // Accept a valid final JSON record without a trailing newline, but leave an
  // incomplete UTF-8/JSON tail for the next pass.
  if (end < buffer.length) {
    try { JSON.parse(buffer.subarray(end).toString("utf8")); end = buffer.length; } catch {}
  }
  for (const line of buffer.subarray(state.offset, end).toString("utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const event = parseLine(JSON.parse(line), state.parser); if (event) state.events.push(event); } catch {}
  }
  state.offset = end; state.hash = digest(buffer.subarray(0, end)); states.set(file, state);
  // Bound residency independently of the durable ledger.
  if (states.size > 128) states.delete(states.keys().next().value);
  return state.events.slice();
}
module.exports = { readAppendedEvents };
