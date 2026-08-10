"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { nextRovingIndex } = require("../src/renderer/ui-interactions");

test("moves keyboard focus through linear and grid controls without escaping bounds", () => {
  assert.equal(nextRovingIndex(0, 6, "ArrowLeft"), 0);
  assert.equal(nextRovingIndex(0, 6, "ArrowRight"), 1);
  assert.equal(nextRovingIndex(4, 6, "Home"), 0);
  assert.equal(nextRovingIndex(1, 6, "End"), 5);
  assert.equal(nextRovingIndex(7, 42, "ArrowUp", 6), 1);
  assert.equal(nextRovingIndex(37, 42, "ArrowDown", 6), 41);
  assert.equal(nextRovingIndex(0, 0, "ArrowRight"), -1);
});

test("keeps modal, live-status, model-picker and heatmap interaction helpers wired", () => {
  const root = path.join(__dirname, "..", "src", "renderer");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "renderer.js"), "utf8");
  const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");

  assert.ok(html.indexOf('src="./ui-interactions.js"') < html.indexOf('src="./renderer.js"'));
  assert.match(html, /id="appStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="settingsPanel"[^>]*aria-hidden="true" inert/);
  assert.match(html, /id="resetDialog"[^>]*aria-hidden="true" inert/);
  assert.match(html, /id="hitHeatmap"[^>]*role="grid"/);
  assert.match(renderer, /createModalController\(\{ background: elements\.shell \}\)/);
  assert.match(renderer, /handleModelPickerKeydown/);
  assert.match(renderer, /setupExpandableCards\(\)/);
  assert.match(renderer, /nextRovingIndex\(current < 0 \? cells\.length - 1 : current, cells\.length, event\.key, 6\)/);
  assert.match(styles, /\.interactive-card \{[\s\S]*?cursor: zoom-in;/);
  assert.match(styles, /content: attr\(data-collapse-hint\);/);
  assert.doesNotMatch(styles, /\.quota-side \.reset-row \{\s*border-color:/);
  assert.match(styles, /\.quota-side \.reset-row:hover \{\s*border-color: rgba\(103, 87, 231, 0\.18\);/);
});
