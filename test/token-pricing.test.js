"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CURRENT_PRICING_EFFECTIVE_AT,
  findModelPrice,
  estimateUsageCost,
  estimateTokenCost,
  formatUsd
} = require("../src/renderer/token-pricing");
const { addSettledUsageCost } = require("../src/usage-cost-settlement");

test("calculates uncached input, cached input and output with the model's rates", () => {
  const result = estimateUsageCost({ input: 1_000_000, cached: 600_000, output: 100_000 }, "gpt-5.6-terra");
  assert.equal(result.usd, 2.12);
});

test("uses the cache-write rate when session logs expose cache creation tokens", () => {
  const result = estimateUsageCost({ input: 1_000_000, cached: 0, cacheWrite: 400_000, output: 0 }, "claude-sonnet-4-6");
  assert.equal(result.usd, 3.3);
});

test("matches provider model IDs and friendly Antigravity names", () => {
  assert.equal(findModelPrice("gpt-5.6-sol").label, "GPT-5.6 Sol");
  assert.equal(findModelPrice("gpt-daybreak-blue-latest").label, "GPT-5.6 Sol");
  assert.deepEqual(
    [findModelPrice("gpt-5.6-cyber").input, findModelPrice("gpt-daybreak-red-latest").cached, findModelPrice("daybreak-red-latest").output],
    [12.5, 1.25, 75]
  );
  assert.deepEqual(
    [findModelPrice("gpt-5.6-sol").input, findModelPrice("gpt-5.6-sol").cached, findModelPrice("gpt-5.6-sol").output],
    [4, 0.4, 20]
  );
  assert.deepEqual(
    [findModelPrice("gpt-5.6-luna").input, findModelPrice("gpt-5.6-luna").cached, findModelPrice("gpt-5.6-luna").output],
    [0.2, 0.02, 1.2]
  );
  assert.equal(findModelPrice("gpt-5.1-codex-mini").input, 0.25);
  assert.equal(findModelPrice("Claude Sonnet 4.6 (Thinking)").label, "Claude Sonnet 4.x");
  assert.equal(findModelPrice("Claude Opus 5").label, "Claude Opus 5");
  assert.deepEqual(
    [findModelPrice("Claude Fable 5.1").input, findModelPrice("claude-mythos-5-1").cached, findModelPrice("Claude Fable 5.1").output],
    [10, 0.25, 50]
  );
  assert.equal(findModelPrice("Claude Fable 5.1").cacheWrite, 12.5);
  assert.deepEqual(
    [findModelPrice("Gemini 3.8 Flash (High)").input, findModelPrice("gemini-3.7-flash").cached, findModelPrice("gemini-3.8-flash").output],
    [0.75, 0.075, 3.75]
  );
  assert.equal(findModelPrice("gemini-3.6-flash").output, 3.75);
  assert.equal(findModelPrice("gemini-3.5-flash-lite").input, 0.3);
  assert.equal(findModelPrice("deepseek-v4-pro", Number.NaN).cached, 0.044);
  assert.equal(findModelPrice("deepseek-v4-flash-vision-exp", Number.NaN).label, "DeepSeek V4 Flash Vision Experimental");
});

test("does not apply newly released model prices before availability", () => {
  assert.equal(findModelPrice("claude-fable-5-1", Date.parse("2026-08-31T23:59:59Z")), null);
  assert.equal(findModelPrice("gemini-3.8-flash", Date.parse("2026-09-01T23:59:59Z")), null);
  assert.equal(findModelPrice("gemini-3.7-flash", Date.parse("2026-08-13T00:00:00Z")).output, 3.75);
  assert.equal(findModelPrice("gpt-5.6-cyber", Date.parse("2026-09-02T23:59:59Z")), null);
});

test("adds per-model values and reports an honest partial estimate", () => {
  const result = estimateTokenCost({
    modelUsage: [
      { model: "gpt-5.6-luna", input: 1_000_000, cached: 0, output: 0 },
      { model: "private-model", input: 500_000, cached: 0, output: 0 }
    ]
  });
  assert.equal(result.usd, 0.2);
  assert.equal(result.complete, false);
  assert.deepEqual(result.unknownModels, ["private-model"]);
});

test("uses the conservative peak price when a DeepSeek timestamp is unavailable", () => {
  const result = estimateTokenCost({
    modelUsage: [{ model: "deepseek-v4-pro", input: 1_000_000, cached: 0, output: 1_000_000 }]
  });
  assert.equal(result.pricedModels, 1);
  assert.equal(result.usd, 5.28);
  assert.equal(result.maxUsd, 5.28);
  assert.deepEqual(result.unknownModels, []);
});

test("settles timestamped DeepSeek usage to the exact official peak or off-peak rate", () => {
  const offPeak = Date.parse("2026-08-29T02:00:00Z"); // Saturday
  const peak = Date.parse("2026-08-31T02:00:00Z"); // Monday, 01:00-04:00 UTC peak window
  const usage = { model: "deepseek-v4-pro", input: 1_000_000, cached: 0, output: 1_000_000 };
  const offPeakCost = estimateUsageCost(usage, usage.model, offPeak);
  const peakCost = estimateUsageCost(usage, usage.model, peak);
  assert.equal(offPeakCost.usd, 2.64);
  assert.equal(offPeakCost.maxUsd, 2.64);
  assert.equal(peakCost.usd, 5.28);
  assert.equal(peakCost.maxUsd, 5.28);
});

test("locks previously settled tokens to the price active when they were recorded", () => {
  const bucket = { model: "gpt-5.6-sol", source: "codex", input: 2_000_000, output: 0, reasoning: 0 };
  addSettledUsageCost(bucket, {
    t: CURRENT_PRICING_EFFECTIVE_AT - 1,
    source: "codex",
    model: "gpt-5.6-sol",
    input: 1_000_000,
    output: 0
  });
  addSettledUsageCost(bucket, {
    t: CURRENT_PRICING_EFFECTIVE_AT + 1,
    source: "codex",
    model: "gpt-5.6-sol",
    input: 1_000_000,
    output: 0
  });

  assert.equal(bucket.estimatedUsd, 9);
  assert.equal(estimateTokenCost({ modelUsage: [bucket] }).usd, 9);
  assert.equal(findModelPrice("gpt-5.6-sol", CURRENT_PRICING_EFFECTIVE_AT - 1).input, 5);
  assert.equal(findModelPrice("gpt-5.6-sol", CURRENT_PRICING_EFFECTIVE_AT + 1).input, 4);
  assert.equal(findModelPrice("gemini-3.6-flash", CURRENT_PRICING_EFFECTIVE_AT - 1), null);
  assert.equal(findModelPrice("deepseek-v4-pro", CURRENT_PRICING_EFFECTIVE_AT - 1), null);
});

test("bills separately estimated Antigravity reasoning as output", () => {
  const result = estimateUsageCost({
    source: "antigravity",
    input: 0,
    output: 100_000,
    reasoning: 50_000
  }, "gemini-3.5-flash");
  assert.equal(result.usd, 1.35);
});

test("formats small and regular USD values without hiding non-zero usage", () => {
  assert.equal(formatUsd(12.345), "$12.35");
  assert.equal(formatUsd(0.00421), "$0.0042");
  assert.equal(formatUsd(0.00001), "<$0.0001");
});
