"use strict";

const TokenPricing = require("./renderer/token-pricing");

function addSettledUsageCost(target, usage, model = usage?.model) {
  target.pricingSettled = true;
  target.estimatedUsd = finite(target.estimatedUsd);
  target.estimatedMaxUsd = finite(target.estimatedMaxUsd);
  target.pricedTokens = finite(target.pricedTokens);
  target.unpricedTokens = finite(target.unpricedTokens);
  target.unknownModels ||= [];
  target.variableModels ||= [];

  const normalizedUsage = usage?.source
    ? usage
    : { ...usage, source: target.source };
  const tokens = usageTokenCount(normalizedUsage);
  const cost = TokenPricing.estimateUsageCost(normalizedUsage, model, usage?.t);
  if (!cost) {
    target.unpricedTokens += tokens;
    if (tokens > 0 && model && !target.unknownModels.includes(model)) target.unknownModels.push(model);
    return target;
  }

  target.estimatedUsd += cost.usd;
  target.estimatedMaxUsd += cost.maxUsd;
  target.pricedTokens += tokens;
  if (cost.variablePricing && !target.variableModels.includes(model)) target.variableModels.push(model);
  return target;
}

function usageTokenCount(usage) {
  const input = finite(usage?.input);
  const output = finite(usage?.output);
  const reasoning = usage?.source === "antigravity" ? finite(usage?.reasoning) : 0;
  return input + output + reasoning;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

module.exports = { addSettledUsageCost };
