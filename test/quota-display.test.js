"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
function harness() {
  const source = fs.readFileSync(path.join(__dirname, "../src/renderer/renderer.js"), "utf8");
  const node = () => ({ style: {}, hidden: false, setAttribute(name, value) { this[name] = value; } });
  const elements = Object.fromEntries(["shortRingTrack", "shortRingArc", "longRingTrack", "longRingArc", "ringShortValue", "ringLongValue", "ringShort", "ringLong", "ringShortLabel", "ringLongLabel", "shortResetCompact", "longResetCompact", "shortMetric", "shortLabel", "shortValue", "shortReset", "shortBar"].map(key => [key, node()]));
  const context = vm.createContext({ elements, t: key => ({ shortLabel: "5h limit", weekLabel: "Weekly", remaining: "Remaining", unlimited: "Unlimited", waitingData: "Waiting" })[key], clamp: value => value, formatCompactDate: value => String(value), formatDateTime: value => String(value), toneForPercent: () => "", renderBar: () => {} });
  vm.runInContext(source.slice(source.indexOf("function renderWindow("), source.indexOf("function renderResetCredits(")), context);
  return context;
}
test("a lone weekly quota keeps its slot and displays infinity for the absent 5h limit", () => {
  const ui = harness();
  const quota = { shortWindow: null, longWindow: { durationMins: 10080, remainingPercent: 25 } };
  ui.renderRing(ui.getDisplayWindows(quota), true);
  assert.equal(ui.elements.ringShort.textContent, "∞");
  assert.equal(ui.elements.ringShortLabel.textContent, "5h limit");
  assert.equal(ui.elements.ringLong.textContent, "25%");
  assert.equal(ui.elements.ringLongLabel.textContent, "Weekly");
  assert.equal(ui.elements.ringShortValue.hidden, false);
  assert.equal(ui.elements.ringLongValue.hidden, false);
  assert.equal(ui.elements.longRingArc.style.strokeDasharray, "25 100");
  ui.renderWindow("short", null, "5h limit", true);
  assert.equal(ui.elements.shortValue.textContent, "∞");
  assert.equal(ui.elements.shortReset.textContent, "∞");
  assert.equal(quota.shortWindow, null, "The infinity presentation must not modify reported quota data");
});
test("two windows and zero remaining use their own ring, including a missing weekly window", () => {
  const ui = harness();
  ui.renderRing(ui.getDisplayWindows({ shortWindow: { remainingPercent: 0 }, longWindow: { remainingPercent: 60 } }), true);
  assert.equal(ui.elements.ringShort.textContent, "0%");
  assert.equal(ui.elements.ringLong.textContent, "60%");
  ui.renderRing(ui.getDisplayWindows({ shortWindow: { remainingPercent: 80 }, longWindow: null }), true);
  assert.equal(ui.elements.ringShort.textContent, "80%");
  assert.equal(ui.elements.ringLong.textContent, "∞");
  assert.equal(ui.elements.ringLongLabel.textContent, "Weekly");
});
test("a missing entire response and an unknown reported value continue to show waiting data", () => {
  const ui = harness();
  ui.renderRing(ui.getDisplayWindows(null), false);
  assert.equal(ui.elements.ringShort.textContent, "--%");
  assert.equal(ui.elements.ringLong.textContent, "--%");
  ui.renderWindow("short", null, "5h limit", false);
  assert.equal(ui.elements.shortValue.textContent, "--%");
  assert.equal(ui.elements.shortReset.textContent, "Waiting");
  ui.renderRing(ui.getDisplayWindows({ shortWindow: { remainingPercent: null }, longWindow: { remainingPercent: 0 } }), true);
  assert.equal(ui.elements.ringShort.textContent, "--%");
  assert.equal(ui.elements.ringLong.textContent, "0%");
});
