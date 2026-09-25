"use strict";

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const testCachePath = path.join(os.tmpdir(), `ai-quota-test-norm-${Date.now()}-${process.pid}.json`);
process.env.HISTORY_ACCUMULATOR_PATH = testCachePath;

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  labelForDuration,
  normalizeCodexQuota,
  normalizeTimestamp
} = require("../src/quota-normalizer");
const { normalizeResetCredits } = require("../src/reset-credits-service");
const {
  normalizeUsage,
  readLatestUsage,
  readDailyTokenHistory,
  readHourlyTokenHistory
} = require("../src/token-usage-service");
const { CodexService } = require("../src/codex-service");
const {
  extractModel,
  isGeminiModel,
  readLocalTokenUsage: readAntigravityTokenUsage
} = require("../src/antigravity-token-service");

test.beforeEach(() => fs.rmSync(testCachePath, { force: true }));
test.after(() => fs.rmSync(testCachePath, { force: true }));

test("keeps the server-reported remaining quota before a future reset", async () => {
  const service = new CodexService();
  const futureReset = Date.now() + 60 * 60_000;
  service.ensureStarted = async () => {};
  service.request = async (method) => {
    if (method === "account/rateLimits/read") {
      return {
        rateLimits: {
          primary: { usedPercent: 34, windowDurationMins: 300, resetsAt: futureReset },
          secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: futureReset }
        }
      };
    }
    return {};
  };

  const snapshot = await service.readQuota();
  assert.equal(snapshot.shortWindow.remainingPercent, 66);
  assert.equal(snapshot.longWindow.remainingPercent, 80);
});

test("accepts rateLimitsByLimitId quota update notifications", () => {
  const service = new CodexService();
  service.saveCache = () => {};
  service.handleLine(JSON.stringify({
    method: "account/rateLimits/updated",
    params: {
      rateLimitsByLimitId: {
        codex: {
          primary: {
            remainingPercent: 100,
            windowDurationMins: 10080,
            resetsAt: 1800600000
          }
        }
      }
    }
  }));

  assert.equal(service.getCachedQuota().shortWindow, null);
  assert.equal(service.getCachedQuota().longWindow.remainingPercent, 100);
});

test("normalizes Codex rate limit windows and quota card expiry", () => {
  const snapshot = normalizeCodexQuota({
    rateLimitsByLimitId: {
      codex: {
        limitName: "Codex Pro",
        primary: {
          usedPercent: 22.4,
          windowDurationMins: 300,
          resetsAt: 1800000000
        },
        secondary: {
          usedPercent: 76,
          windowDurationMins: 10080,
          resetsAt: 1800300000000
        },
        individualLimit: {
          limit: "1000",
          used: "300",
          remainingPercent: 70,
          resetsAt: 1800400000
        },
        planType: "pro"
      }
    }
  });

  assert.equal(snapshot.shortWindow.label, "5小时");
  assert.equal(snapshot.shortWindow.remainingPercent, 78);
  assert.equal(snapshot.longWindow.label, "周限额");
  assert.equal(snapshot.longWindow.remainingPercent, 24);
  assert.equal(snapshot.quotaCard.title, "Codex Pro");
  assert.equal(snapshot.quotaCard.remainingPercent, 70);
  assert.equal(snapshot.quotaCard.expiresAt, 1800400000000);
  assert.equal(snapshot.planType, "pro");
});

test("falls back to rateLimits and derives quota card from weekly reset", () => {
  const snapshot = normalizeCodexQuota({
    rateLimits: {
      primary: {
        usedPercent: 10,
        windowDurationMins: 300,
        resetsAt: 1800000000
      },
      secondary: {
        usedPercent: 35,
        windowDurationMins: 10080,
        resetsAt: 1800600000
      }
    }
  });

  assert.equal(snapshot.quotaCard.source, "secondary");
  assert.equal(snapshot.quotaCard.remainingPercent, 65);
  assert.equal(snapshot.quotaCard.expiresAt, 1800600000000);
});

test("treats a lone weekly window as the long quota after the 5-hour limit is removed", () => {
  const snapshot = normalizeCodexQuota({
    rateLimits: {
      primary: {
        remainingPercent: 88,
        windowDurationMins: 10080,
        resetsAt: 1800600000
      }
    }
  });

  assert.equal(snapshot.shortWindow, null);
  assert.equal(snapshot.longWindow.label, "周限额");
  assert.equal(snapshot.longWindow.remainingPercent, 88);
  assert.equal(snapshot.quotaCard.source, "primary");
  assert.equal(snapshot.quotaCard.remainingPercent, 88);
});

test("normalizes token statistics from several common payload fields", () => {
  const snapshot = normalizeCodexQuota({
    rateLimits: {
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1800000000 },
      usage: {
        inputTokens: 1_000,
        cachedTokens: 3_000,
        outputTokens: 500
      }
    }
  });

  assert.equal(snapshot.tokenStats.input, 1000);
  assert.equal(snapshot.tokenStats.cached, 3000);
  assert.equal(snapshot.tokenStats.output, 500);
  assert.equal(snapshot.tokenStats.total, 4500);
  assert.equal(snapshot.tokenStats.cacheHitRate, 75);
});

test("normalizes token statistics from account usage response", () => {
  const snapshot = normalizeCodexQuota({
    rateLimits: {
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1800000000 }
    },
    accountUsage: {
      current_period: {
        input_tokens: 2_000,
        cache_read_input_tokens: 1_500,
        output_tokens: 700
      }
    }
  });

  assert.equal(snapshot.tokenStats.input, 2000);
  assert.equal(snapshot.tokenStats.cached, 1500);
  assert.equal(snapshot.tokenStats.output, 700);
  assert.equal(snapshot.tokenStats.total, 4200);
  assert.equal(snapshot.tokenStats.cacheHitRate, 75);
  assert.equal(snapshot.tokenStats.source, "account/usage/read");
});

test("keeps token usage errors visible without breaking quota", () => {
  const snapshot = normalizeCodexQuota({
    rateLimits: {
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1800000000 }
    },
    usageError: "codex account authentication required to read token usage"
  });

  assert.equal(snapshot.shortWindow.remainingPercent, 90);
  assert.equal(snapshot.tokenStats.error, "codex account authentication required to read token usage");
});

test("does not treat account credit balances as reset-card counts", () => {
  const snapshot = normalizeCodexQuota({
    rateLimits: {
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1800000000 },
      credits: {
        hasCredits: true,
        unlimited: false,
        balance: "1999.0860232500",
        expires_at: "2026-08-01T00:00:00Z"
      }
    }
  });

  assert.equal(snapshot.resetCard, null);
});

test("normalizes explicit reset-card count fields", () => {
  const snapshot = normalizeCodexQuota({
    rateLimits: {
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1800000000 },
      resetCount: "2",
      resetCardExpiresAt: "2026-08-01T00:00:00Z"
    }
  });

  assert.equal(snapshot.resetCard.count, 2);
  assert.equal(snapshot.resetCard.countLabel, "2");
  assert.equal(snapshot.resetCard.expiresAt, Date.parse("2026-08-01T00:00:00Z"));
});

test("normalizes and sorts wham reset credits response by expiry", () => {
  const snapshot = normalizeResetCredits({
    available_count: 2,
    credits: [
      {
        status: "available",
        title: "Full reset (Weekly + 5 hr)",
        granted_at: "2026-07-01T20:05:28Z",
        expires_at: "2026-07-31T20:05:28Z"
      },
      {
        status: "available",
        title: "Second reset",
        granted_at: "2026-07-02T20:05:28Z",
        expires_at: "2026-07-20T20:05:28Z"
      }
    ]
  });

  assert.equal(snapshot.availableCount, 2);
  assert.equal(snapshot.credits[0].title, "Second reset");
  assert.equal(snapshot.credits[0].status, "available");
  assert.equal(snapshot.credits[1].grantedAt, Date.parse("2026-07-01T20:05:28Z"));
  assert.equal(snapshot.credits[1].expiresAt, Date.parse("2026-07-31T20:05:28Z"));
});

test("falls back to the real available-card list when a reset count is malformed", () => {
  const snapshot = normalizeResetCredits({
    available_count: "1999.0860232500",
    credits: [{ status: "available", title: "Full reset" }]
  });

  assert.equal(snapshot.availableCount, 1);
});

test("reads local Codex session token usage", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-usage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: "event_msg", payload: { msg: "ignore" } }),
      JSON.stringify({
        type: "turn_context",
        payload: {
          info: {
            total_token_usage: {
              input_tokens: 120,
              cached_input_tokens: 80,
              output_tokens: 40,
              reasoning_output_tokens: 10,
              total_tokens: 250
            }
          }
        }
      })
    ].join("\n"),
    "utf8"
  );

  assert.deepEqual(readLatestUsage(file), {
    input: 120,
    cached: 80,
    cacheWrite: 0,
    output: 40,
    reasoning: 10,
    total: 250
  });
  assert.equal(normalizeUsage({ input_tokens: "1", output_tokens: "2" }).total, 3);
});

test("calculates cache hit rate from the cached portion of input tokens", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-cache-rate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: "turn_context",
      payload: {
        info: {
          total_token_usage: {
            input_tokens: 1_000,
            cached_input_tokens: 750,
            output_tokens: 100,
            total_tokens: 1_100
          }
        }
      }
    }),
    "utf8"
  );

  const { readLocalTokenUsage } = require("../src/token-usage-service");
  const usage = readLocalTokenUsage({ root: dir });
  assert.equal(usage.cacheHitRate, 75);
});

test("a slightly future Windows file timestamp does not hide untimestamped usage", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-mtime-"));
  const previousCache = process.env.HISTORY_ACCUMULATOR_PATH;
  process.env.HISTORY_ACCUMULATOR_PATH = path.join(dir, "ledger.json");
  t.after(() => {
    if (previousCache === undefined) delete process.env.HISTORY_ACCUMULATOR_PATH;
    else process.env.HISTORY_ACCUMULATOR_PATH = previousCache;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, JSON.stringify({ payload: { info: { total_token_usage: {
    input_tokens: 100, cached_input_tokens: 75, output_tokens: 20, total_tokens: 120
  } } } }));
  const now = Date.now();
  const future = new Date(now + 1_000);
  fs.utimesSync(file, future, future);
  const { readLocalTokenUsage } = require("../src/token-usage-service");
  assert.equal(readLocalTokenUsage({ root: dir, now }).cacheHitRate, 75);
  assert.equal(readLocalTokenUsage({ root: dir, now: now - 86_400_000 }).total, null);
});

test("groups token increments by event time instead of file modification time", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-daily-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const eventTime = Date.parse("2026-07-10T12:15:00Z");
  const file = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(file, JSON.stringify({
    timestamp: new Date(eventTime).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 900,
          cached_input_tokens: 700,
          output_tokens: 100,
          total_tokens: 1_000
        }
      }
    }
  }), "utf8");

  const date = new Date(eventTime);
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const daily = readDailyTokenHistory({ now: eventTime + 2 * 60 * 60_000, root: dir });
  const hourly = readHourlyTokenHistory({ now: eventTime + 30 * 60_000, root: dir });
  assert.equal(daily[key].total, 1_000);
  assert.equal(hourly.reduce((sum, bucket) => sum + bucket.total, 0), 1_000);
});

test("groups local token usage by the model active when each event was recorded", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { readLocalTokenUsage } = require("../src/token-usage-service");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-model-usage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.parse("2026-07-11T12:00:00Z");
  const event = (model, total) => [
    { timestamp: new Date(now).toISOString(), type: "turn_context", payload: { model } },
    { timestamp: new Date(now + 1).toISOString(), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: total, total_tokens: total } } } }
  ];
  fs.writeFileSync(path.join(dir, "rollout.jsonl"), [...event("gpt-5.6-terra", 120), ...event("gpt-5.5-mini", 80)].map(JSON.stringify).join("\n"));

  const usage = readLocalTokenUsage({ now: now + 60_000, root: dir });
  assert.deepEqual(usage.modelUsage.map(({ model, total }) => ({ model, total })), [
    { model: "gpt-5.6-terra", total: 120 },
    { model: "gpt-5.5-mini", total: 80 }
  ]);
  const daily = readDailyTokenHistory({ now: now + 60_000, root: dir, model: "gpt-5.5-mini" });
  const hourly = readHourlyTokenHistory({ now: now + 60_000, root: dir, model: "gpt-5.5-mini" });
  const date = new Date(now);
  const dayKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  assert.equal(daily[dayKey].total, 80);
  assert.equal(hourly.reduce((sum, bucket) => sum + bucket.total, 0), 80);
});

test("builds current usage and the complete model catalog from one read", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { readLocalTokenUsage } = require("../src/token-usage-service");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-model-catalog-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.parse("2026-07-11T12:00:00Z");
  const old = now - 10 * 24 * 60 * 60_000;
  const rows = [
    { timestamp: new Date(old).toISOString(), payload: { model: "old-model" } },
    { timestamp: new Date(old + 1).toISOString(), payload: { info: { last_token_usage: { input_tokens: 80, total_tokens: 80 } } } },
    { timestamp: new Date(now).toISOString(), payload: { model: "current-model" } },
    { timestamp: new Date(now + 1).toISOString(), payload: { info: { last_token_usage: { input_tokens: 120, total_tokens: 120 } } } }
  ];
  fs.writeFileSync(path.join(dir, "rollout.jsonl"), rows.map(JSON.stringify).join("\n"));

  const usage = readLocalTokenUsage({ now: now + 60_000, days: 1, catalogDays: null, root: dir });
  assert.deepEqual(usage.modelUsage.map(({ model, total }) => ({ model, total })), [
    { model: "current-model", total: 120 }
  ]);
  assert.deepEqual(usage.modelCatalog.map(({ model, total }) => ({ model, total })), [
    { model: "current-model", total: 120 },
    { model: "old-model", total: 80 }
  ]);
});

test("keeps Codex and Claude model usage in separate source groups", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { readLocalTokenUsage, readTokenHistory } = require("../src/token-usage-service");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-source-usage-"));
  const codexRoot = path.join(dir, ".codex", "sessions");
  const claudeRoot = path.join(dir, ".claude", "projects");
  fs.mkdirSync(codexRoot, { recursive: true });
  fs.mkdirSync(claudeRoot, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const now = Date.parse("2026-07-11T12:00:00Z");
  const codexFile = [
    { timestamp: new Date(now).toISOString(), payload: { model: "gpt-5.6-sol" } },
    { timestamp: new Date(now + 1).toISOString(), payload: { info: { last_token_usage: { input_tokens: 100, total_tokens: 100 } } } }
  ];
  const claudeFile = [
    { timestamp: new Date(now).toISOString(), message: { model: "claude-opus-4", usage: { input_tokens: 60, output_tokens: 20 } } }
  ];
  fs.writeFileSync(path.join(codexRoot, "codex.jsonl"), codexFile.map(JSON.stringify).join("\n"));
  fs.writeFileSync(path.join(claudeRoot, "claude.jsonl"), claudeFile.map(JSON.stringify).join("\n"));

  const usage = readLocalTokenUsage({ now: now + 60_000, root: [codexRoot, claudeRoot] });
  assert.deepEqual(usage.modelUsage.map(({ source, model, total }) => ({ source, model, total })), [
    { source: "codex", model: "gpt-5.6-sol", total: 100 },
    { source: "claude", model: "claude-opus-4", total: 80 }
  ]);
  const claudeHistory = readTokenHistory({ now: now + 60_000, root: [codexRoot, claudeRoot], source: "claude" });
  assert.equal(Object.values(claudeHistory.daily)[0].total, 80);
});

test("keeps settled Claude usage after Claude removes the transcript", (t) => {
  const { readLocalTokenUsage } = require("../src/token-usage-service");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-claude-ledger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const projects = path.join(dir, ".claude", "projects");
  const project = path.join(projects, "project-1");
  fs.mkdirSync(project, { recursive: true });
  const transcript = path.join(project, "session-1.jsonl");
  const now = Date.parse("2026-08-20T12:00:00Z");
  fs.writeFileSync(transcript, JSON.stringify({
    timestamp: new Date(now).toISOString(),
    message: {
      id: "message-1",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 100, output_tokens: 25 }
    }
  }), "utf8");

  const options = { now: now + 1_000, days: 1, catalogDays: null, root: [projects], sources: ["claude"] };
  const first = readLocalTokenUsage(options);
  assert.equal(first.total, 125);
  assert.equal(first.modelCatalog[0].model, "claude-sonnet-4-6");
  fs.rmSync(transcript, { force: true });

  const retained = readLocalTokenUsage(options);
  assert.equal(retained.total, 125);
  assert.equal(retained.modelCatalog[0].source, "claude");
});

test("formats duration labels", () => {
  assert.equal(labelForDuration(45, "fallback"), "45分钟");
  assert.equal(labelForDuration(90, "fallback"), "1.5小时");
  assert.equal(labelForDuration(10080, "fallback"), "周限额");
  assert.equal(labelForDuration(null, "fallback"), "fallback");
});

test("normalizes second and millisecond timestamps", () => {
  assert.equal(normalizeTimestamp(1800000000), 1800000000000);
  assert.equal(normalizeTimestamp(1800000000000), 1800000000000);
  assert.equal(normalizeTimestamp(null), null);
});

test("only extracts Antigravity models from explicit settings changes", () => {
  assert.equal(
    extractModel({
      type: "USER_INPUT",
      content: "make MULTIPLE non-contiguous edits to `d:\\DevApps\\skill_store\\static\\index.css`."
    }),
    null
  );
  assert.equal(
    extractModel({
      type: "USER_INPUT",
      content: "<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Claude Opus 4.6 (Thinking). No need to comment on this change."
    }),
    "Claude Opus 4.6 (Thinking)"
  );
  assert.equal(
    extractModel({
      type: "USER_INPUT",
      content: "<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.5 Flash (High)."
    }),
    "Gemini 3.5 Flash (High)"
  );
  assert.equal(
    extractModel({
      type: "USER_INPUT",
      content: "<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 3.5 Flash (High) to Claude Opus 4.6 (Thinking)."
    }),
    "Claude Opus 4.6 (Thinking)"
  );
  assert.equal(isGeminiModel("Gemini 3.5 Flash (High)"), true);
  assert.equal(isGeminiModel("google/gemini-2.5-pro"), true);
  assert.equal(isGeminiModel("Claude Opus 4.6 (Thinking)"), false);
});

test("counts only Gemini models from Antigravity sessions", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-antigravity-gemini-only-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logs = path.join(dir, "brain-1", ".system_generated", "logs");
  fs.mkdirSync(logs, { recursive: true });
  const now = Date.parse("2026-08-20T12:00:00Z");
  const modelChange = (from, to, offset) => ({
    type: "USER_INPUT",
    created_at: new Date(now + offset).toISOString(),
    content: `<USER_SETTINGS_CHANGE>\nThe user changed setting \`Model Selection\` from ${from} to ${to}.`
  });
  const response = (content, offset) => ({
    type: "PLANNER_RESPONSE",
    created_at: new Date(now + offset).toISOString(),
    content
  });
  fs.writeFileSync(path.join(logs, "transcript.jsonl"), [
    modelChange("None", "Gemini 3.5 Flash (High)", 0),
    response("gemini response", 1),
    modelChange("Gemini 3.5 Flash (High)", "Claude Opus 4.6 (Thinking)", 2),
    response("external response", 3)
  ].map(JSON.stringify).join("\n"), "utf8");

  const usage = readAntigravityTokenUsage({ now: now + 1_000, days: 1, catalogDays: null, root: [dir] });
  assert.deepEqual(usage.modelUsage.map((item) => item.model), ["Gemini 3.5 Flash (High)"]);
  assert.equal(usage.sessions, 1);
});

test("keeps settled Antigravity usage after its session directory is removed", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-antigravity-ledger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const session = path.join(dir, "brain-1");
  const logs = path.join(session, ".system_generated", "logs");
  fs.mkdirSync(logs, { recursive: true });
  const transcript = path.join(logs, "transcript.jsonl");
  const now = Date.parse("2026-08-20T12:00:00Z");
  fs.writeFileSync(transcript, [
    JSON.stringify({
      type: "USER_INPUT",
      created_at: new Date(now).toISOString(),
      content: "<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.5 Flash (High)."
    }),
    JSON.stringify({
      type: "PLANNER_RESPONSE",
      created_at: new Date(now + 1).toISOString(),
      content: "done"
    })
  ].join("\n"), "utf8");

  const options = { now: now + 1_000, days: 1, catalogDays: null, root: [dir] };
  const first = readAntigravityTokenUsage(options);
  assert.ok(first.total > 0);
  assert.equal(first.modelCatalog[0].model, "Gemini 3.5 Flash (High)");
  fs.rmSync(session, { recursive: true, force: true });

  const retained = readAntigravityTokenUsage(options);
  assert.equal(retained.total, first.total);
  assert.equal(retained.modelCatalog[0].model, "Gemini 3.5 Flash (High)");
});

test("reads Claude Code projects session log with message.model, message.usage and deduplicates", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { readLocalTokenUsage } = require("../src/token-usage-service");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-code-usage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.parse("2026-07-11T12:00:00Z");
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        timestamp: new Date(now).toISOString(),
        message: {
          id: "msg-1",
          model: "deepseek-v4-pro",
          usage: {
            input_tokens: 100,
            output_tokens: 20
          }
        }
      }),
      JSON.stringify({
        timestamp: new Date(now + 1).toISOString(),
        message: {
          id: "msg-1",
          model: "deepseek-v4-pro",
          usage: {
            input_tokens: 100,
            output_tokens: 20
          }
        }
      }),
      JSON.stringify({
        timestamp: new Date(now + 2).toISOString(),
        message: {
          id: "msg-2",
          model: "deepseek-v4-pro",
          usage: {
            input_tokens: 200,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 100,
            output_tokens: 30
          }
        }
      })
    ].join("\n"),
    "utf8"
  );

  const usage = readLocalTokenUsage({ now: now + 60_000, root: dir });
  assert.equal(usage.input, 900); // 100 + (200 + 500 cache read + 100 cache write)
  assert.equal(usage.cached, 500);
  assert.equal(usage.cacheWrite, 100);
  assert.equal(usage.output, 50);
  assert.equal(usage.total, 950);
  assert.deepEqual(usage.modelUsage.map(({ model, input, cached, cacheWrite, output, reasoning, total }) => ({
    model, input, cached, cacheWrite, output, reasoning, total
  })), [
    { model: "deepseek-v4-pro", input: 900, cached: 500, cacheWrite: 100, output: 50, reasoning: 0, total: 950 }
  ]);
  assert.equal(usage.modelUsage[0].pricingSettled, true);
});

test.after(() => {
  try {
    if (fs.existsSync(testCachePath)) {
      fs.unlinkSync(testCachePath);
    }
  } catch {}
});
