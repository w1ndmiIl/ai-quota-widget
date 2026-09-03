"use strict";

(function exposeModelUsage(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ModelUsage = api;
})(typeof window === "undefined" ? null : window, () => {
  const KNOWN_SOURCES = new Set(["codex", "claude", "opencode", "gemini", "cline", "antigravity"]);

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

  function buildMergedModels(snapshot) {
    const currentKeys = new Set();
    const markCurrentModels = (list, defaultSource) => {
      if (!Array.isArray(list)) return;
      for (const item of list) {
        const source = item.source || defaultSource;
        if (!isAllowedSourceModel(source, item.model)) continue;
        currentKeys.add(`${source}:${item.model}`);
      }
    };
    markCurrentModels(snapshot?.localTokenUsage?.modelUsage, "codex");
    markCurrentModels(snapshot?.quota?.tokenStats?.modelUsage, "codex");
    markCurrentModels(snapshot?.antigravityTokenUsage?.modelUsage, "antigravity");

    const allModels = [];
    const addModels = (list, defaultSource) => {
      if (!Array.isArray(list)) return;
      for (const item of list) {
        const source = item.source || defaultSource;
        if (!isAllowedSourceModel(source, item.model)) continue;
        const sourceModel = `${source}:${item.model}`;
        const total = Number(item.total);
        if (!Number.isFinite(total) || total <= 0) continue;
        allModels.push({
          ...item,
          source,
          currentUsage: currentKeys.has(sourceModel),
          sourceModel,
          displayLabel: item.model
        });
      }
    };

    // Catalogs cover the complete retained history and therefore provide the
    // correct ranking totals. Current usage is only a fallback for sources
    // without a catalog, so a one-day total cannot overwrite the full rank.
    addModels(snapshot?.localTokenUsage?.modelCatalog, "codex");
    addModels(snapshot?.antigravityTokenUsage?.modelCatalog, "antigravity");
    addModels(snapshot?.localTokenUsage?.modelUsage, "codex");
    addModels(snapshot?.quota?.tokenStats?.modelUsage, "codex");
    addModels(snapshot?.antigravityTokenUsage?.modelUsage, "antigravity");

    const seen = new Set();
    return allModels.filter((item) => {
      if (seen.has(item.sourceModel)) return false;
      seen.add(item.sourceModel);
      return true;
    }).sort((a, b) => b.total - a.total || a.source.localeCompare(b.source) || a.model.localeCompare(b.model));
  }

  function getTokenForModel(snapshot, modelKey) {
    const selection = parseModelSelection(modelKey);
    if (selection.kind === "all") return mergeAllTokens(snapshot);
    if (selection.kind === "source") return mergeSourceTokens(snapshot, selection.source);
    if (selection.source === "antigravity") {
      return getSourceModelData(snapshot?.antigravityTokenUsage, null, selection.model, "antigravity");
    }
    if (KNOWN_SOURCES.has(selection.source)) {
      const fallback = selection.source === "codex" ? snapshot?.quota?.tokenStats : null;
      return getSourceModelData(snapshot?.localTokenUsage, fallback, selection.model, selection.source);
    }
    return mergeAllTokens(snapshot);
  }

  function getSourceModelData(primary, fallback, model, source) {
    const modelData = primary?.modelUsage?.find((item) => item.model === model && (!item.source || item.source === source))
      || fallback?.modelUsage?.find((item) => item.model === model && (!item.source || item.source === source));
    if (!modelData) return null;
    return {
      ...modelData,
      source,
      cacheHitRate: modelData.cached == null || modelData.input === 0
        ? null
        : Math.round((modelData.cached / modelData.input) * 100)
    };
  }

  function mergeSourceTokens(snapshot, source) {
    if (source === "antigravity") {
      return mergeTokenItems(
        snapshot?.antigravityTokenUsage?.modelUsage?.filter((item) => isAllowedSourceModel(source, item.model)),
        source
      );
    }
    const localModels = (snapshot?.localTokenUsage?.modelUsage || [])
      .filter((item) => !item.source || item.source === source);
    const merged = mergeTokenItems(localModels, source);
    if (merged) return merged;
    if (source === "codex" && snapshot?.quota?.tokenStats?.total != null) {
      return { ...snapshot.quota.tokenStats, source: "codex" };
    }
    return null;
  }

  function mergeTokenItems(items, source) {
    if (!Array.isArray(items) || !items.length) return null;
    const sum = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
    let hasData = false;
    let cacheKnown = true;
    for (const item of items) {
      if (item?.total == null) continue;
      hasData = true;
      sum.input += item.input || 0;
      sum.cached += item.cached || 0;
      sum.cacheWrite += item.cacheWrite || 0;
      sum.output += item.output || 0;
      sum.reasoning += item.reasoning || 0;
      sum.total += item.total || 0;
      if (item.cached == null) cacheKnown = false;
    }
    if (!hasData) return null;
    return {
      ...sum,
      cached: cacheKnown ? sum.cached : null,
      source,
      cacheHitRate: cacheKnown && sum.input > 0 ? Math.round((sum.cached / sum.input) * 100) : null,
      modelUsage: items
    };
  }

  function mergeAllTokens(snapshot) {
    const sum = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
    let hasData = false;
    let hitRateInput = 0;
    let hitRateCached = 0;
    const add = (source, isAntigravity = false) => {
      if (source?.total == null) return;
      hasData = true;
      for (const key of Object.keys(sum)) sum[key] += source[key] || 0;
      if (!isAntigravity && source.cached != null) {
        hitRateInput += source.input || 0;
        hitRateCached += source.cached || 0;
      }
    };

    const quotaStats = snapshot?.quota?.tokenStats;
    const localUsage = snapshot?.localTokenUsage;
    if (localUsage?.total != null) add(localUsage);
    else if (quotaStats?.total != null) add(quotaStats);
    add(mergeSourceTokens(snapshot, "antigravity"), true);
    if (!hasData) return null;
    return {
      source: "merged",
      ...sum,
      cacheHitRate: hitRateInput > 0 ? Math.round((hitRateCached / hitRateInput) * 100) : null,
      modelUsage: currentModelUsage(snapshot),
      sessions: null
    };
  }

  function currentModelUsage(snapshot) {
    const models = [];
    const seen = new Set();
    const add = (items, defaultSource) => {
      for (const item of items || []) {
        const source = item.source || defaultSource;
        if (!isAllowedSourceModel(source, item.model)) continue;
        const key = `${source}:${item.model}`;
        if (seen.has(key)) continue;
        seen.add(key);
        models.push({ ...item, source });
      }
    };
    add(snapshot?.localTokenUsage?.modelUsage, "codex");
    add(snapshot?.quota?.tokenStats?.modelUsage, "codex");
    add(snapshot?.antigravityTokenUsage?.modelUsage, "antigravity");
    return models;
  }

  return Object.freeze({
    buildMergedModels,
    currentModelUsage,
    getSourceModelData,
    getTokenForModel,
    mergeAllTokens,
    mergeSourceTokens,
    mergeTokenItems,
    parseModelSelection
  });
});
