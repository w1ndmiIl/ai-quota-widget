"use strict";

(function exposeTokenPricing(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TokenPricing = api;
})(typeof globalThis === "object" ? globalThis : null, () => {
  const MILLION = 1_000_000;
  const CURRENT_PRICING_EFFECTIVE_AT = Date.parse("2026-08-26T23:20:52+08:00");

  // Standard text API prices in USD per 1M tokens, verified 2026-09-03.
  // Request-level surcharges (long context, regional routing, tools and cache
  // storage) cannot be inferred from local session logs and are not included.
  const MODEL_PRICES = [
    price("GPT-5.6 Cyber", /^(?:gpt-5\.6-cyber|gpt-daybreak-red-latest|daybreak-red-latest)$/, 12.5, 1.25, 75, {
      availableSince: "2026-09-03T00:00:00Z"
    }),
    price("GPT-5.6 Sol", /^(?:gpt-5\.6(?:-sol)?(?:-\d{4}-\d{2}-\d{2})?|gpt-daybreak-blue-latest|daybreak-blue-latest)$/, 4, 0.4, 20),
    price("GPT-5.6 Terra", /^gpt-5\.6-terra(?:-\d{4}-\d{2}-\d{2})?$/, 2, 0.2, 12),
    price("GPT-5.6 Luna", /^gpt-5\.6-luna(?:-\d{4}-\d{2}-\d{2})?$/, 0.2, 0.02, 1.2),
    price("GPT-5.5 Pro", /^gpt-5\.5-pro(?:-\d{4}-\d{2}-\d{2})?$/, 30, 30, 180),
    price("GPT-5.5", /^gpt-5\.5(?:-\d{4}-\d{2}-\d{2})?$/, 5, 0.5, 30),
    price("GPT-5.4 Pro", /^gpt-5\.4-pro(?:-\d{4}-\d{2}-\d{2})?$/, 30, 30, 180),
    price("GPT-5.4 mini", /^gpt-5\.4-mini(?:-\d{4}-\d{2}-\d{2})?$/, 0.75, 0.075, 4.5),
    price("GPT-5.4 nano", /^gpt-5\.4-nano(?:-\d{4}-\d{2}-\d{2})?$/, 0.2, 0.02, 1.25),
    price("GPT-5.4", /^gpt-5\.4(?:-\d{4}-\d{2}-\d{2})?$/, 2.5, 0.25, 15),
    price("GPT-5.3 Codex", /^gpt-5\.3-(?:codex|chat-latest)$/, 1.75, 0.175, 14),
    price("GPT-5.2", /^gpt-5\.2(?:-codex|-chat-latest)?$/, 1.75, 0.175, 14),
    price("GPT-5.1 Codex mini", /^gpt-5\.1-codex-mini$/, 0.25, 0.025, 2),
    price("GPT-5.1", /^gpt-5\.1(?:-codex(?:-max)?|-chat-latest)?$/, 1.25, 0.125, 10),
    price("Codex mini", /^codex-mini-latest$/, 1.5, 0.375, 6),
    price("GPT-5 mini", /^gpt-5-mini(?:-\d{4}-\d{2}-\d{2})?$/, 0.25, 0.025, 2),
    price("GPT-5 nano", /^gpt-5-nano(?:-\d{4}-\d{2}-\d{2})?$/, 0.05, 0.005, 0.4),
    price("GPT-5", /^gpt-5(?:-codex|-chat-latest|-\d{4}-\d{2}-\d{2})?$/, 1.25, 0.125, 10),
    price("GPT-4.1 mini", /^gpt-4\.1-mini(?:-\d{4}-\d{2}-\d{2})?$/, 0.4, 0.1, 1.6),
    price("GPT-4.1 nano", /^gpt-4\.1-nano(?:-\d{4}-\d{2}-\d{2})?$/, 0.1, 0.025, 0.4),
    price("GPT-4.1", /^gpt-4\.1(?:-\d{4}-\d{2}-\d{2})?$/, 2, 0.5, 8),
    price("GPT-4o mini", /^gpt-4o-mini(?:-\d{4}-\d{2}-\d{2})?$/, 0.15, 0.075, 0.6),
    price("GPT-4o", /^gpt-4o(?:-\d{4}-\d{2}-\d{2})?$/, 2.5, 1.25, 10),

    price("Claude Fable 5.1", /claude-fable-5[-.]1(?:\b|-)/, 10, 0.25, 50, {
      availableSince: "2026-09-01T00:00:00Z"
    }),
    price("Claude Mythos 5.1", /claude-mythos-5[-.]1(?:\b|-)/, 10, 0.25, 50, {
      availableSince: "2026-09-01T00:00:00Z"
    }),
    price("Claude Fable 5", /claude-fable-5(?:\b|-)/, 10, 1, 50),
    price("Claude Mythos 5", /claude-mythos(?:-preview)?-5(?:\b|-)/, 10, 1, 50),
    price("Claude Opus 5", /claude-opus-5(?:\b|-)/, 5, 0.5, 25),
    price("Claude Opus 4.5+", /claude-opus-4[-.](?:5|6|7|8)(?:\b|-)/, 5, 0.5, 25),
    price("Claude Opus 4\/4.1", /claude-opus-4(?:[-.]1)?(?:\b|-)/, 15, 1.5, 75),
    price("Claude Sonnet 5", /claude-sonnet-5(?:\b|-)/, 2, 0.2, 10),
    price("Claude Sonnet 4.x", /claude-sonnet-4(?:[-.][0-9])?(?:\b|-)/, 3, 0.3, 15),
    price("Claude Haiku 4.5", /claude-haiku-4[-.]5(?:\b|-)/, 1, 0.1, 5),
    price("Claude 3.5 Sonnet", /claude-(?:3[-.]5-sonnet|sonnet-3[-.]5)(?:\b|-)/, 3, 0.3, 15),
    price("Claude 3.5 Haiku", /claude-(?:3[-.]5-haiku|haiku-3[-.]5)(?:\b|-)/, 0.8, 0.08, 4),
    price("Claude 3 Opus", /claude-(?:3-opus|opus-3)(?:\b|-)/, 15, 1.5, 75),
    price("Claude 3 Haiku", /claude-(?:3-haiku|haiku-3)(?:\b|-)/, 0.25, 0.03, 1.25),

    price("Gemini 3.8 Flash", /gemini-3[-.]8-flash(?:\b|-)/, 0.75, 0.075, 3.75, {
      availableSince: "2026-09-02T00:00:00Z"
    }),
    price("Gemini 3.7 Flash", /gemini-3[-.]7-flash(?:\b|-)/, 0.75, 0.075, 3.75, {
      availableSince: "2026-08-13T00:00:00Z"
    }),
    price("Gemini 3.6 Flash", /gemini-3[-.]6-flash(?:\b|-)/, 0.75, 0.075, 3.75),
    price("Gemini 3.5 Flash-Lite", /gemini-3[-.]5-flash-lite(?:\b|-)/, 0.3, 0.03, 2.5),
    price("Gemini 3.5 Flash", /gemini-3[-.]5-flash(?:\b|-)/, 1.5, 0.15, 9),
    price("Gemini 3.1 Pro", /gemini-3[-.]1-pro(?:-preview)?(?:\b|-)/, 2, 0.2, 12),
    price("Gemini 3.1 Flash-Lite", /gemini-3[-.]1-flash-lite(?:\b|-)/, 0.25, 0.025, 1.5),
    price("Gemini 3 Flash", /gemini-3-flash(?:-preview)?(?:\b|-)/, 0.5, 0.05, 3),
    price("Gemini 2.5 Pro", /gemini-2[-.]5-pro(?:\b|-)/, 1.25, 0.125, 10),
    price("Gemini 2.5 Flash-Lite", /gemini-2[-.]5-flash-lite(?:\b|-)/, 0.1, 0.01, 0.4),
    price("Gemini 2.5 Flash", /gemini-2[-.]5-flash(?:\b|-)/, 0.3, 0.03, 2.5),

    price("DeepSeek V4 Pro", /deepseek-v4-pro(?:\b|-)/, 0.66, 0.022, 1.98, {
      maxInput: 1.32,
      maxCached: 0.044,
      maxOutput: 3.96,
      timeOfDay: "deepseek"
    }),
    price("DeepSeek V4 Flash Vision Experimental", /deepseek-v4-flash-vision-exp(?:\b|-)/, 0.22, 0.007, 0.66, {
      maxInput: 0.44,
      maxCached: 0.014,
      maxOutput: 1.32,
      timeOfDay: "deepseek",
      availableSince: "2026-08-26T00:00:00Z"
    }),
    price("DeepSeek V4 Flash", /deepseek-v4-flash(?:\b|-)/, 0.22, 0.007, 0.66, {
      maxInput: 0.44,
      maxCached: 0.014,
      maxOutput: 1.32,
      timeOfDay: "deepseek"
    })
  ];

  const LEGACY_PRICE_OVERRIDES = [
    price("GPT-5.6 Sol", /^gpt-5\.6(?:-sol)?(?:-\d{4}-\d{2}-\d{2})?$/, 5, 0.5, 30),
    price("GPT-5.6 Terra", /^gpt-5\.6-terra(?:-\d{4}-\d{2}-\d{2})?$/, 2.5, 0.25, 15),
    price("GPT-5.6 Luna", /^gpt-5\.6-luna(?:-\d{4}-\d{2}-\d{2})?$/, 1, 0.1, 6)
  ];
  const LEGACY_UNPRICED_PATTERNS = [
    /claude-opus-5(?:\b|-)/,
    /gemini-3[-.]6-flash(?:\b|-)/,
    /gemini-3[-.]5-flash-lite(?:\b|-)/,
    /deepseek-v4-(?:pro|flash)(?:\b|-)/
  ];

  function price(label, pattern, input, cached, output, {
    maxInput = input,
    maxCached = cached,
    maxOutput = output,
    timeOfDay = null,
    availableSince = null
  } = {}) {
    const cacheWrite = /^(?:Claude|GPT-5\.6)/.test(label) ? input * 1.25 : input;
    const maxCacheWrite = /^(?:Claude|GPT-5\.6)/.test(label) ? maxInput * 1.25 : maxInput;
    return Object.freeze({
      label,
      pattern,
      input,
      cached,
      cacheWrite,
      output,
      maxInput,
      maxCached,
      maxCacheWrite,
      maxOutput,
      timeOfDay,
      availableSince: availableSince ? Date.parse(availableSince) : null
    });
  }

  function normalizeModelName(model) {
    return String(model || "")
      .trim()
      .toLowerCase()
      .replace(/^models\//, "")
      .replace(/^anthropic[.:/]/, "")
      .replace(/[_\s]+/g, "-");
  }

  function findModelPrice(model, at) {
    const normalized = normalizeModelName(model);
    if (!normalized || normalized === "unknown") return null;
    const timestamp = Number(at);
    if (Number.isFinite(timestamp) && timestamp < CURRENT_PRICING_EFFECTIVE_AT) {
      if (LEGACY_UNPRICED_PATTERNS.some((pattern) => pattern.test(normalized))) return null;
      const legacy = LEGACY_PRICE_OVERRIDES.find((item) => item.pattern.test(normalized));
      if (legacy) return legacy;
    }
    const current = MODEL_PRICES.find((item) => item.pattern.test(normalized)) || null;
    if (current?.availableSince && Number.isFinite(timestamp) && timestamp < current.availableSince) return null;
    return resolveTimeOfDayPrice(current, timestamp);
  }

  function resolveTimeOfDayPrice(modelPrice, timestamp) {
    if (!modelPrice?.timeOfDay) return modelPrice;
    const useMaximum = !Number.isFinite(timestamp)
      || (modelPrice.timeOfDay === "deepseek" && isDeepSeekPeak(timestamp));
    const input = useMaximum ? modelPrice.maxInput : modelPrice.input;
    const cached = useMaximum ? modelPrice.maxCached : modelPrice.cached;
    const cacheWrite = useMaximum ? modelPrice.maxCacheWrite : modelPrice.cacheWrite;
    const output = useMaximum ? modelPrice.maxOutput : modelPrice.output;
    return Object.freeze({
      ...modelPrice,
      input,
      cached,
      cacheWrite,
      output,
      maxInput: input,
      maxCached: cached,
      maxCacheWrite: cacheWrite,
      maxOutput: output
    });
  }

  function isDeepSeekPeak(timestamp) {
    const date = new Date(timestamp);
    const day = date.getUTCDay();
    const hour = date.getUTCHours();
    return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
  }

  function estimateUsageCost(usage, model = usage?.model, at = usage?.t) {
    const modelPrice = findModelPrice(model, at);
    if (!modelPrice) return null;

    const input = tokenNumber(usage?.input);
    const cached = Math.min(input, tokenNumber(usage?.cached));
    const cacheWrite = Math.min(Math.max(0, input - cached), tokenNumber(usage?.cacheWrite));
    const uncached = Math.max(0, input - cached - cacheWrite);
    const reasoning = usage?.source === "antigravity" ? tokenNumber(usage?.reasoning) : 0;
    const output = tokenNumber(usage?.output) + reasoning;
    const usd = calculateUsd({
      uncached,
      cached,
      cacheWrite,
      output,
      inputRate: modelPrice.input,
      cachedRate: modelPrice.cached,
      cacheWriteRate: modelPrice.cacheWrite,
      outputRate: modelPrice.output
    });
    const maxUsd = calculateUsd({
      uncached,
      cached,
      cacheWrite,
      output,
      inputRate: modelPrice.maxInput,
      cachedRate: modelPrice.maxCached,
      cacheWriteRate: modelPrice.maxCacheWrite,
      outputRate: modelPrice.maxOutput
    });

    return {
      usd,
      maxUsd,
      variablePricing: maxUsd > usd,
      model: modelPrice.label,
      input,
      cached,
      cacheWrite,
      output,
      tokens: input + output
    };
  }

  function calculateUsd({ uncached, cached, cacheWrite, output, inputRate, cachedRate, cacheWriteRate, outputRate }) {
    return (
      uncached * inputRate
      + cached * cachedRate
      + cacheWrite * cacheWriteRate
      + output * outputRate
    ) / MILLION;
  }

  function estimateTokenCost(stats, fallbackModel = stats?.model) {
    if (!stats) return emptyEstimate();
    const items = Array.isArray(stats.modelUsage) && stats.modelUsage.length
      ? stats.modelUsage
      : [{ ...stats, model: fallbackModel }];
    const result = emptyEstimate();

    for (const item of items) {
      const model = item?.model || fallbackModel || "unknown";
      if (item?.pricingSettled) {
        const tokens = usageTokenCount(item);
        result.totalTokens += tokens;
        result.usd += tokenNumber(item.estimatedUsd);
        result.maxUsd += tokenNumber(item.estimatedMaxUsd ?? item.estimatedUsd);
        result.pricedTokens += tokenNumber(item.pricedTokens);
        result.pricedModels += item.pricedTokens > 0 ? 1 : 0;
        for (const unknown of item.unknownModels || []) {
          if (!result.unknownModels.includes(unknown)) result.unknownModels.push(unknown);
        }
        for (const variable of item.variableModels || []) {
          if (!result.variableModels.includes(variable)) result.variableModels.push(variable);
        }
        continue;
      }
      const cost = estimateUsageCost(item, model);
      const tokens = usageTokenCount(item);
      result.totalTokens += tokens;
      if (!cost) {
        if (tokens > 0 && !result.unknownModels.includes(model)) result.unknownModels.push(model);
        continue;
      }
      result.usd += cost.usd;
      result.maxUsd += cost.maxUsd;
      if (cost.variablePricing && !result.variableModels.includes(model)) result.variableModels.push(model);
      result.pricedTokens += tokens;
      result.pricedModels += 1;
    }

    result.complete = result.pricedModels > 0 && result.unknownModels.length === 0;
    return result;
  }

  function emptyEstimate() {
    return {
      usd: 0,
      maxUsd: 0,
      pricedModels: 0,
      pricedTokens: 0,
      totalTokens: 0,
      unknownModels: [],
      variableModels: [],
      complete: false
    };
  }

  function usageTokenCount(usage) {
    const input = tokenNumber(usage?.input);
    const output = tokenNumber(usage?.output);
    const reasoning = usage?.source === "antigravity" ? tokenNumber(usage?.reasoning) : 0;
    return input + output + reasoning;
  }

  function tokenNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function formatUsd(value) {
    if (!Number.isFinite(value) || value < 0) return "--";
    if (value === 0) return "$0.00";
    if (value < 0.0001) return "<$0.0001";
    const digits = value < 0.01 ? 4 : value < 1 ? 3 : 2;
    return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  }

  return Object.freeze({
    CURRENT_PRICING_EFFECTIVE_AT,
    findModelPrice,
    estimateUsageCost,
    estimateTokenCost,
    formatUsd
  });
});
