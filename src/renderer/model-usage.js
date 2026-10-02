"use strict";

(function exposeModelUsage(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ModelUsage = api;
})(typeof window === "undefined" ? null : window, () => {

  function isAllowedSourceModel(source, model) {
    return source !== "antigravity"
      || (typeof model === "string" && /(?:^|[^a-z0-9])gemini(?:[^a-z0-9]|$)/i.test(model));
  }

  function parseModelSelection(selection) {
    if (selection === "all") return { kind: "all", source: null, model: "all" };
    if (selection.startsWith("source:")) return { kind: "source", source: selection.slice(7), model: "all" };
    const separator = selection.indexOf(":");
    if (separator > 0) {
      return { kind: "model", source: selection.slice(0, separator), model: selection.slice(separator + 1) || "all" };
    }
    return { kind: "model", source: null, model: selection };
  }

  function mergeTokenItems(items, source) {
    if (!Array.isArray(items)) return null;
    items = items.filter(item => isAllowedSourceModel(item.source || source, item.model));
    if (!items.length) return null;
    const sum = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
    let hasData = false;
    let cacheKnown = true;
    let cacheInput = 0;
    let cacheRead = 0;
    for (const item of items) {
      if (item?.total == null) continue;
      hasData = true;
      sum.input += item.input || 0;
      sum.cached += item.cached || 0;
      sum.cacheWrite += item.cacheWrite || 0;
      sum.output += item.output || 0;
      sum.reasoning += item.reasoning || 0;
      sum.total += item.total || 0;
      if (item.source !== "antigravity" || item.usageAccuracy === "native") {
        if (item.cached == null) cacheKnown = false;
        else {
          cacheInput += item.input || 0;
          cacheRead += item.cached || 0;
        }
      }
    }
    if (!hasData) return null;
    return {
      ...sum,
      cached: cacheKnown ? sum.cached : null,
      source,
      usageAccuracy: items.every(item => item.usageAccuracy === "native") ? "native"
        : items.some(item => item.usageAccuracy === "native") ? "mixed" : "estimated",
      cacheHitRate: cacheKnown && cacheInput > 0 ? Math.round((cacheRead / cacheInput) * 100) : null,
      modelUsage: items
    };
  }

  return Object.freeze({ mergeTokenItems, parseModelSelection });
});
