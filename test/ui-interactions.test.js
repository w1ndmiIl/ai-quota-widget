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
  assert.match(html, /id="settingsSubtitle"/);
  assert.match(html, /id="appearanceSectionTitle"/);
  assert.match(html, /id="sourceSectionHint"/);
  assert.match(html, /class="setting-source-grid"/);
  assert.match(html, /class="hotkey-grid"/);
  assert.match(html, /id="settingsCancel"/);
  assert.match(html, /id="langSelect"[^>]*role="radiogroup"/);
  assert.match(html, /id="themeSelect"[^>]*role="radiogroup"/);
  assert.match(html, /id="themeChoiceLight"[^>]*role="radio"/);
  assert.doesNotMatch(html, /<select id="(?:lang|theme)Select"/);
  assert.match(renderer, /createModalController\(\{ background: elements\.shell \}\)/);
  assert.match(renderer, /settingsCancel\.addEventListener\("click", closeSettings\)/);
  assert.match(renderer, /settingsBody\.scrollTop = 0/);
  assert.match(renderer, /set\("settingsSubtitle", "settingsSubtitle"\)/);
  assert.match(renderer, /const setChoiceValue = \(group, value\) =>/);
  assert.match(renderer, /choice\.setAttribute\("aria-checked", String\(active\)\)/);
  assert.match(renderer, /const lang = langSelect\.dataset\.value/);
  assert.match(renderer, /handleModelPickerKeydown/);
  assert.match(renderer, /setupExpandableCards\(\)/);
  assert.match(renderer, /nextRovingIndex\(current < 0 \? cells\.length - 1 : current, cells\.length, event\.key, 6\)/);
  assert.match(styles, /\.interactive-card \{[\s\S]*?cursor: zoom-in;/);
  assert.match(styles, /content: attr\(data-collapse-hint\);/);
  assert.doesNotMatch(styles, /\.quota-side \.reset-row \{\s*border-color:/);
  assert.match(styles, /\.quota-side \.reset-row:hover \{\s*border-color: rgba\(103, 87, 231, 0\.18\);/);
  assert.match(styles, /\.settings-card \{[\s\S]*?width: min\(560px, calc\(100vw - 28px\)\);/);
  assert.match(styles, /\.settings-body \{[\s\S]*?overflow-x: hidden;/);
  assert.match(styles, /\.setting-source-grid,[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(styles, /\.setting-checkbox-row input\[type="checkbox"\] \{[\s\S]*?appearance: none;/);
  assert.match(styles, /\.setting-choice-group \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(styles, /\.setting-choice\.active \{[\s\S]*?background: rgba\(255, 255, 255, 0\.96\);/);
  assert.match(styles, /\.quota-side \.reset-row \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 72px;/);
  assert.match(styles, /\.ring \{[\s\S]*?background: rgba\(255, 255, 255, 0\.54\);[\s\S]*?box-shadow: 0 12px 28px/);
  assert.match(styles, /\.ring-track-outer,[\s\S]*?\.ring-arc-short \{\s*stroke-width: 10;/);
  assert.match(styles, /@keyframes ring-float/);
  assert.match(styles, /\.ring-core \{[\s\S]*?align-content: center;[\s\S]*?gap: 8px;/);
  assert.match(styles, /\.ring-core span \{[\s\S]*?align-items: baseline;[\s\S]*?font-variant-numeric: tabular-nums;/);
  assert.match(renderer, /resetSub: "恢复 5小时与周限额"/);
  assert.match(styles, /\.model-picker-models \{[\s\S]*?max-height: 90px;[\s\S]*?overflow-y: auto;/);
  assert.match(styles, /\.model-picker-models::-webkit-scrollbar \{\s*width: 5px;/);
});
