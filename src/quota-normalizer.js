"use strict";

function normalizeCodexQuota(response) {
  const snapshot = response?.rateLimitsByLimitId?.codex ?? response?.rateLimits;
  if (!snapshot) {
    return null;
  }

  const windows = normalizeRateLimitWindows(snapshot);
  const shortWindow = windows.short;
  const longWindow = windows.long;
  const quotaCard = normalizeQuotaCard(snapshot, shortWindow, longWindow);
  const resetCard = normalizeResetCard(snapshot);
  const tokenStats = normalizeTokenStats(snapshot, response?.accountUsage, shortWindow, longWindow, response?.usageError);

  return {
    shortWindow,
    longWindow,
    quotaCard,
    resetCard,
    tokenStats,
    accountUsage: response?.accountUsage ?? null,
    usageError: response?.usageError ?? null,
    credits: snapshot.credits ?? null,
    planType: snapshot.planType ?? null,
    rawLimitName: snapshot.limitName ?? snapshot.limitId ?? null
  };
}

function normalizeWindow(window, fallbackLabel, sourceKey = null) {
  if (!window) {
    return null;
  }

  const durationMins = readNumber(firstValue(
    window.windowDurationMins,
    window.durationMins,
    window.durationMinutes,
    window.window_duration_mins
  ), null);
  const reportedUsed = readNumber(firstValue(window.usedPercent, window.used_percent), null);
  const reportedRemaining = readNumber(firstValue(window.remainingPercent, window.remaining_percent), null);
  const usedPercent = reportedUsed == null
    ? reportedRemaining == null ? null : clamp(100 - reportedRemaining)
    : clamp(reportedUsed);
  const remainingPercent = reportedRemaining == null
    ? usedPercent == null ? null : clamp(100 - usedPercent)
    : clamp(reportedRemaining);
  return {
    label: labelForDuration(durationMins, fallbackLabel),
    durationMins,
    sourceKey,
    usedPercent,
    remainingPercent,
    resetsAt: normalizeTimestamp(window.resetsAt),
    tokenLimit: readNumber(firstValue(window.tokenLimit, window.limit, window.maxTokens), null),
    tokensUsed: readNumber(firstValue(window.tokensUsed, window.used, window.usedTokens), null)
  };
}

function normalizeRateLimitWindows(snapshot) {
  const candidates = [
    ["primary", normalizeWindow(snapshot.primary, "5小时", "primary")],
    ["secondary", normalizeWindow(snapshot.secondary, "周限额", "secondary")]
  ].filter(([, window]) => window);

  if (!candidates.length) {
    return { short: null, long: null };
  }

  const short = candidates.find(([, window]) => window.durationMins != null && window.durationMins < 24 * 60);
  const long = candidates.find(([, window]) => window.durationMins != null && window.durationMins >= 24 * 60);
  if (short || long) {
    return {
      short: short?.[1] ?? null,
      long: long?.[1] ?? null
    };
  }

  // Older app-server payloads did not always include a duration. Keep the
  // historical primary/secondary interpretation for those responses.
  return {
    short: candidates[0]?.[1] ?? null,
    long: candidates[1]?.[1] ?? null
  };
}

function normalizeQuotaCard(snapshot, shortWindow, longWindow) {
  const individual = snapshot.individualLimit;
  if (individual) {
    const reportedRemaining = readNumber(individual.remainingPercent, null);
    const reportedUsed = readNumber(individual.usedPercent, null);
    const remainingPercent = reportedRemaining == null
      ? reportedUsed == null ? null : clamp(100 - reportedUsed)
      : clamp(reportedRemaining);
    return {
      title: snapshot.limitName ?? "Codex 额度卡",
      limit: readNumber(individual.limit, individual.limit ?? null),
      used: readNumber(individual.used, individual.used ?? null),
      remainingPercent,
      usedPercent: remainingPercent == null ? null : clamp(100 - remainingPercent),
      expiresAt: normalizeTimestamp(individual.resetsAt),
      source: "individualLimit"
    };
  }

  const expiry = firstTimestamp(snapshot.expiresAt, snapshot.expiry, snapshot.expires_at);
  if (expiry) {
    return {
      title: snapshot.limitName ?? "Codex 额度卡",
      limit: null,
      used: null,
      remainingPercent: null,
      usedPercent: null,
      expiresAt: expiry,
      source: "snapshot"
    };
  }

  const fallbackWindow = longWindow ?? shortWindow;
  if (!fallbackWindow) {
    return null;
  }

  return {
    title: "Codex 额度卡",
    limit: null,
    used: null,
    remainingPercent: fallbackWindow.remainingPercent,
    usedPercent: fallbackWindow.usedPercent,
    expiresAt: fallbackWindow.resetsAt,
    source: fallbackWindow.sourceKey || (fallbackWindow === longWindow ? "secondary" : "primary")
  };
}

function normalizeResetCard(snapshot) {
  const credits = snapshot.credits;
  const countValue = firstValue(
    snapshot.resetCount,
    snapshot.resetsRemaining,
    snapshot.resetCredits,
    snapshot.reset_card_count,
    credits?.resetCount,
    credits?.reset_count,
    credits?.availableCount,
    credits?.available_count
  );
  const expiresAt = firstTimestamp(
    credits?.resetExpiresAt,
    credits?.reset_expires_at,
    credits?.resetAt,
    credits?.reset_at,
    snapshot.resetCardExpiresAt,
    snapshot.resetExpiresAt
  );
  const count = readNonNegativeInteger(countValue);
  const unlimited = Boolean(snapshot.resetUnlimited ?? credits?.resetUnlimited);

  if (count == null && !unlimited && !expiresAt) {
    return null;
  }

  return {
    hasCredits: unlimited || count != null,
    unlimited,
    count,
    countLabel: unlimited ? "无限" : count == null ? "--" : String(count),
    expiresAt,
    source: credits && countValue != null ? "credits" : "snapshot"
  };
}

function readNonNegativeInteger(value) {
  const number = readNumber(value, NaN);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function normalizeTokenStats(snapshot, accountUsage, shortWindow, longWindow, usageError) {
  const tokenUsage = firstValue(
    accountUsage,
    accountUsage?.usage,
    accountUsage?.tokenUsage,
    accountUsage?.token_usage,
    accountUsage?.summary,
    snapshot.tokenUsage,
    snapshot.tokens,
    snapshot.usage,
    snapshot.usageSummary,
    snapshot.quotaUsage
  );
  const scanned = scanUsageNumbers(tokenUsage);
  const input = readNumber(
    firstValue(
      tokenUsage?.input,
      tokenUsage?.inputTokens,
      tokenUsage?.input_tokens,
      tokenUsage?.promptTokens,
      tokenUsage?.prompt_tokens,
      tokenUsage?.uncachedInputTokens,
      tokenUsage?.uncached_input_tokens,
      snapshot.inputTokens,
      snapshot.promptTokens,
      scanned.input
    ),
    null
  );
  const cached = readNumber(
    firstValue(
      tokenUsage?.cached,
      tokenUsage?.cachedTokens,
      tokenUsage?.cached_tokens,
      tokenUsage?.cacheReadInputTokens,
      tokenUsage?.cache_read_input_tokens,
      tokenUsage?.cachedInputTokens,
      tokenUsage?.cached_input_tokens,
      snapshot.cachedTokens,
      snapshot.cacheReadInputTokens,
      scanned.cached
    ),
    null
  );
  const output = readNumber(
    firstValue(
      tokenUsage?.output,
      tokenUsage?.outputTokens,
      tokenUsage?.output_tokens,
      tokenUsage?.completionTokens,
      tokenUsage?.completion_tokens,
      snapshot.outputTokens,
      snapshot.completionTokens,
      scanned.output
    ),
    null
  );
  const total = readNumber(
    firstValue(
      tokenUsage?.total,
      tokenUsage?.totalTokens,
      tokenUsage?.total_tokens,
      tokenUsage?.tokensUsed,
      tokenUsage?.tokens_used,
      snapshot.totalTokens,
      snapshot.tokensUsed,
      scanned.total,
      longWindow?.tokensUsed,
      shortWindow?.tokensUsed
    ),
    sumKnown(input, cached, output)
  );
  const cacheHitRate = readNumber(
    firstValue(tokenUsage?.cacheHitRate, tokenUsage?.cache_hit_rate, tokenUsage?.hitRate, snapshot.cacheHitRate),
    deriveCacheHitRate(input, cached)
  );
  const limit = readNumber(
    firstValue(tokenUsage?.limit, tokenUsage?.tokenLimit, tokenUsage?.token_limit, snapshot.tokenLimit, longWindow?.tokenLimit, shortWindow?.tokenLimit),
    null
  );
  const source = accountUsage ? "account/usage/read" : tokenUsage ? "rateLimits" : total == null ? "none" : "window";

  return {
    input,
    cached,
    output,
    total,
    limit,
    cacheHitRate: cacheHitRate == null ? null : clamp(cacheHitRate),
    source,
    error: usageError ?? null
  };
}

function deriveCacheHitRate(input, cached) {
  if (!input && !cached) {
    return null;
  }
  const denominator = cached > input ? input + cached : input;
  return Math.round((cached / Math.max(1, denominator)) * 100);
}

function scanUsageNumbers(value, depth = 0, acc = { input: null, cached: null, output: null, total: null }) {
  if (!value || typeof value !== "object" || depth > 5) {
    return acc;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (typeof item === "number" || (typeof item === "string" && item.trim() !== "")) {
      const number = readNumber(item, null);
      if (number == null) {
        continue;
      }
      if (normalized.includes("cache") && normalized.includes("token")) {
        acc.cached ??= number;
      } else if ((normalized.includes("input") || normalized.includes("prompt")) && normalized.includes("token")) {
        acc.input ??= number;
      } else if ((normalized.includes("output") || normalized.includes("completion")) && normalized.includes("token")) {
        acc.output ??= number;
      } else if (normalized.includes("total") && normalized.includes("token")) {
        acc.total ??= number;
      }
      continue;
    }
    if (item && typeof item === "object") {
      scanUsageNumbers(item, depth + 1, acc);
    }
  }
  return acc;
}

function labelForDuration(minutes, fallback) {
  if (!minutes) {
    return fallback;
  }
  if (minutes < 60) {
    return `${minutes}分钟`;
  }
  if (minutes < 60 * 24) {
    const hours = minutes / 60;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}小时`;
  }
  if (minutes % (60 * 24 * 7) === 0) {
    return "周限额";
  }
  const days = minutes / (60 * 24);
  return `${Number.isInteger(days) ? days : days.toFixed(1)}天`;
}

function firstTimestamp(...values) {
  for (const value of values) {
    const timestamp = normalizeTimestamp(value);
    if (timestamp) {
      return timestamp;
    }
  }
  return null;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function normalizeTimestamp(value) {
  const timestamp = readNumber(value, NaN);
  if (!Number.isFinite(timestamp) && typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}

function readNumber(value, fallback) {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function sumKnown(...values) {
  const numbers = values.filter((value) => typeof value === "number");
  return numbers.length ? numbers.reduce((total, value) => total + value, 0) : null;
}

function clamp(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

module.exports = {
  normalizeCodexQuota,
  normalizeWindow,
  normalizeTokenStats,
  labelForDuration,
  normalizeTimestamp
};
