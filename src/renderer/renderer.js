"use strict";

const { buildMergedModels, getTokenForModel, parseModelSelection } = window.ModelUsage;
const { createModalController, nextRovingIndex } = window.UiInteractions;

const elements = {
  shell: document.getElementById("shell"),
  updatedAt: document.getElementById("updatedAt"),
  appStatus: document.getElementById("appStatus"),
  compactButton: document.getElementById("compactButton"),
  compactIcon: document.getElementById("compactIcon"),
  refreshButton: document.getElementById("refreshButton"),
  quotaModeToggle: document.getElementById("quotaModeToggle"),
  quotaModeCodex: document.getElementById("quotaModeCodex"),
  quotaModeAntigravity: document.getElementById("quotaModeAntigravity"),
  pinButton: document.getElementById("pinButton"),
  closeButton: document.getElementById("closeButton"),
  quotaSide: document.getElementById("quotaSide"),
  quotaRing: document.getElementById("quotaRing"),
  shortRingTrack: document.getElementById("shortRingTrack"),
  shortRingArc: document.getElementById("shortRingArc"),
  longRingTrack: document.getElementById("longRingTrack"),
  longRingArc: document.getElementById("longRingArc"),
  ringShortValue: document.getElementById("ringShortValue"),
  ringLongValue: document.getElementById("ringLongValue"),
  ringShortLabel: document.getElementById("ringShortLabel"),
  ringLongLabel: document.getElementById("ringLongLabel"),
  ringShort: document.getElementById("ringShort"),
  ringLong: document.getElementById("ringLong"),
  shortMetric: document.getElementById("shortMetric"),
  longMetric: document.getElementById("longMetric"),
  shortLabel: document.getElementById("shortLabel"),
  shortValue: document.getElementById("shortValue"),
  shortBar: document.getElementById("shortBar"),
  shortReset: document.getElementById("shortReset"),
  shortResetCompact: document.getElementById("shortResetCompact"),
  longLabel: document.getElementById("longLabel"),
  longValue: document.getElementById("longValue"),
  longBar: document.getElementById("longBar"),
  longReset: document.getElementById("longReset"),
  longResetCompact: document.getElementById("longResetCompact"),
  resetRow: document.getElementById("resetRow"),
  resetCount: document.getElementById("resetCount"),
  resetExpiry: document.getElementById("resetExpiry"),
  resetDialog: document.getElementById("resetDialog"),
  resetDialogClose: document.getElementById("resetDialogClose"),
  resetDialogSummary: document.getElementById("resetDialogSummary"),
  resetDialogList: document.getElementById("resetDialogList"),
  tokenCardTitle: document.getElementById("tokenCardTitle"),
  totalTokens: document.getElementById("totalTokens"),
  inputTokens: document.getElementById("inputTokens"),
  cachedTokens: document.getElementById("cachedTokens"),
  outputTokens: document.getElementById("outputTokens"),
  inputLabel: document.getElementById("inputLabel"),
  cachedLabel: document.getElementById("cachedLabel"),
  outputLabel: document.getElementById("outputLabel"),
  tokenCost: document.getElementById("tokenCost"),
  tokenValueBox: document.getElementById("tokenValueBox"),
  tokenValueLabel: document.getElementById("tokenValueLabel"),
  tokenValue: document.getElementById("tokenValue"),
  inputSegment: document.getElementById("inputSegment"),
  cacheSegment: document.getElementById("cacheSegment"),
  outputSegment: document.getElementById("outputSegment"),
  cacheHitRate: document.getElementById("cacheHitRate"),
  hitDelta: document.getElementById("hitDelta"),
  hitSummary: document.getElementById("hitSummary"),
  trend24Summary: document.getElementById("trend24Summary"),
  trend7Summary: document.getElementById("trend7Summary"),
  trendDelta: document.getElementById("trendDelta"),
  trendTotal: document.getElementById("trendTotal"),
  trendAverage: document.getElementById("trendAverage"),
  hitTrendLabel: document.getElementById("hitTrendLabel"),
  hitHeatmap: document.getElementById("hitHeatmap"),
  heatTooltip: document.getElementById("heatTooltip"),
  heatDateStart: document.getElementById("heatDateStart"),
  heatDateEnd: document.getElementById("heatDateEnd"),
  tokenRangeToggle: document.getElementById("tokenRangeToggle"),
  tokenCardBody: document.getElementById("tokenCardBody")
};

const modalController = createModalController({ background: elements.shell });

let isCompact = localStorage.getItem("compact") === "1";
let tokenRange = localStorage.getItem("tokenRange") || "24h";
let quotaMode = localStorage.getItem("quotaMode") === "antigravity" ? "antigravity" : "codex";
let isRefreshing = false;
let focusedCard = null;
let lastSnapshot = null;
let selectedModel = "all";
let tokenRenderGeneration = 0;
const chartSeries = new Map();
const HISTORY_VERSION = "2";
const DEFAULT_HOTKEYS = Object.freeze({
  togglePanel: "Ctrl+Shift+Space",
  toggleCompact: "Ctrl+Shift+M",
  refresh: "",
  togglePin: ""
});
let history = readHistory();
let mergedModels = [];
let selectableModelSources = new Set();
let latestResetCredits = [];
let initialDataReady = false;
const MODEL_SOURCES = [
  { key: "codex", label: "Codex" },
  { key: "claude", label: "Claude Code" },
  { key: "opencode", label: "OpenCode" },
  { key: "gemini", label: "Gemini CLI" },
  { key: "cline", label: "Cline" },
  { key: "antigravity", label: "Antigravity" }
];
const expandedModelSources = new Set(MODEL_SOURCES.map((source) => source.key));
let historyRenderTimer = null;
let historyRenderInFlight = false;
let historyRenderQueued = false;
let historyRenderQueuedImmediate = false;
let lastHistoryRenderAt = 0;
let historyRenderingEnabled = false;
const HISTORY_RENDER_INTERVAL = 60_000;
const modelMeasureCanvas = document.createElement("canvas");
let modelMenuSignature = "";
let toggleSliderFrame = null;
let chartTooltipFrame = null;
let pendingChartTooltip = null;

function modelSourceLabel(source) {
  return MODEL_SOURCES.find((item) => item.key === source)?.label || source;
}

elements.closeButton.addEventListener("click", () => window.aiQuota.quitWindow());
elements.compactButton.addEventListener("click", () => setCompact(!isCompact));
elements.refreshButton.addEventListener("click", () => refresh({ manual: true }));
elements.resetRow.addEventListener("click", (event) => {
  event.stopPropagation();
  openResetDialog();
});
elements.resetRow.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  openResetDialog();
});
elements.resetDialogClose.addEventListener("click", closeResetDialog);
elements.resetDialog.querySelector(".reset-dialog-backdrop").addEventListener("click", closeResetDialog);
elements.pinButton.addEventListener("click", async () => {
  const pinned = await window.aiQuota.toggleAlwaysOnTop();
  applyPinnedState(pinned);
});
elements.shell.addEventListener("click", (event) => {
  if (focusedCard && !event.target.closest(".is-focused")) {
    clearCardFocus();
    return;
  }
  if (event.target === elements.shell || event.target.classList.contains("panel")) {
    refresh({ manual: true });
  }
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModelPicker({ restoreFocus: true });
  if (event.key === "Escape") clearCardFocus();
});

window.aiQuota.onUpdated(render);
window.aiQuota.onCompactChanged((compact) => applyCompactState(compact));
window.aiQuota.onPinnedChanged((pinned) => applyPinnedState(pinned));
setInterval(() => {
  if (!document.hidden) refresh();
}, 5 * 60_000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (!lastSnapshot?.updatedAt || Date.now() - lastSnapshot.updatedAt > 60_000) refresh();
  scheduleHistoryRender(true);
});

async function loadInitialData() {
  try {
    const cached = await window.aiQuota.readCached();
    if (cached && (!lastSnapshot?.updatedAt || cached.updatedAt >= lastSnapshot.updatedAt)) render(cached);
  } catch {}

  try {
    await refresh();
  } finally {
    initialDataReady = true;
    if (tokenRange === "cumulative" && lastSnapshot) {
      const tokenData = getTokenForModel(lastSnapshot, selectedModel);
      await renderTokenStats(tokenData, mergedModels, ++tokenRenderGeneration);
    }
    historyRenderingEnabled = true;
    const renderWhenIdle = () => scheduleHistoryRender(true);
    if (window.requestIdleCallback) window.requestIdleCallback(renderWhenIdle, { timeout: 2_000 });
    else setTimeout(renderWhenIdle, 250);
  }
}

async function setupSettings() {
  const panel = document.getElementById("settingsPanel");
  const langSelect = document.getElementById("langSelect");
  const themeSelect = document.getElementById("themeSelect");
  const cfgCodex = document.getElementById("cfgCodex");
  const cfgClaudeCode = document.getElementById("cfgClaudeCode");
  const cfgOpenCode = document.getElementById("cfgOpenCode");
  const cfgGeminiCli = document.getElementById("cfgGeminiCli");
  const cfgCline = document.getElementById("cfgCline");
  const cfgAntigravity = document.getElementById("cfgAntigravity");
  const settingsStatus = document.getElementById("settingsStatus");
  const settingsSave = document.getElementById("settingsSave");
  const settingsCancel = document.getElementById("settingsCancel");
  const settingsBody = panel.querySelector(".settings-body");
  const hotkeyInputs = {
    togglePanel: document.getElementById("hotkeyTogglePanel"),
    toggleCompact: document.getElementById("hotkeyToggleCompact"),
    refresh: document.getElementById("hotkeyRefresh"),
    togglePin: document.getElementById("hotkeyTogglePin")
  };

  let config = { enableCodex: true, enableClaudeCode: true, enableOpenCode: true, enableGeminiCli: true, enableCline: true, enableAntigravity: true, hotkeys: { ...DEFAULT_HOTKEYS } };
  try {
    const mainConfig = await window.aiQuota.readSettings();
    if (mainConfig) {
      config = { ...config, ...mainConfig };
    }
  } catch (e) {
    console.error("Failed to read settings from main process", e);
  }

  const setChoiceValue = (group, value) => {
    const choices = [...group.querySelectorAll(".setting-choice")];
    const selected = choices.find((choice) => choice.dataset.value === value) || choices[0];
    group.dataset.value = selected?.dataset.value || "";
    for (const choice of choices) {
      const active = choice === selected;
      choice.classList.toggle("active", active);
      choice.setAttribute("aria-checked", String(active));
      choice.tabIndex = active ? 0 : -1;
    }
  };
  const bindChoiceGroup = (group) => {
    const choices = [...group.querySelectorAll(".setting-choice")];
    for (const choice of choices) {
      choice.addEventListener("click", () => setChoiceValue(group, choice.dataset.value));
      choice.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const current = Math.max(0, choices.indexOf(choice));
        const next = event.key === "Home" ? 0
          : event.key === "End" ? choices.length - 1
            : (current + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + choices.length) % choices.length;
        setChoiceValue(group, choices[next].dataset.value);
        choices[next].focus();
      });
    }
  };
  bindChoiceGroup(langSelect);
  bindChoiceGroup(themeSelect);

  applyConfigEffects(config);
  document.body.classList.toggle("no-codex", !config.enableCodex);

  setChoiceValue(langSelect, localStorage.getItem("lang") || "zh");
  setChoiceValue(themeSelect, localStorage.getItem("theme") || "light");
  applyTheme(themeSelect.dataset.value);
  applyLang(langSelect.dataset.value);

  const normalizeHotkeys = (hotkeys) => {
    const source = hotkeys && typeof hotkeys === "object" ? hotkeys : {};
    const value = (key) => source[key] === "" ? "" : (typeof source[key] === "string" ? source[key] : DEFAULT_HOTKEYS[key]);
    return Object.fromEntries(Object.keys(DEFAULT_HOTKEYS).map((key) => [key, value(key)]));
  };
  const setHotkeyValues = (hotkeys) => {
    const values = normalizeHotkeys(hotkeys);
    for (const [key, input] of Object.entries(hotkeyInputs)) input.value = values[key];
  };
  const showSettingsStatus = (message = "", type = "") => {
    settingsStatus.textContent = message;
    settingsStatus.className = `settings-status${type ? ` ${type}` : ""}`;
  };
  const acceleratorFromEvent = (event) => {
    if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return null;
    const keys = {
      " ": "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
      Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Delete: "Delete"
    };
    const key = keys[event.key] || (event.key.length === 1 ? event.key.toUpperCase() : event.key);
    const modifiers = [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Super"].filter(Boolean);
    return modifiers.length && key ? [...modifiers, key].join("+") : null;
  };

  setHotkeyValues(config.hotkeys);
  for (const input of Object.values(hotkeyInputs)) {
    input.addEventListener("focus", () => input.select());
    input.addEventListener("keydown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        input.value = "";
        input.blur();
        showSettingsStatus();
        return;
      }
      const accelerator = acceleratorFromEvent(event);
      if (!accelerator) {
        showSettingsStatus(t("hotkeyModifierRequired"), "fail");
        return;
      }
      input.value = accelerator;
      showSettingsStatus();
    });
  }
  const clearHotkey = (key) => {
    hotkeyInputs[key].value = "";
    showSettingsStatus();
  };
  document.getElementById("hotkeyTogglePanelClear").addEventListener("click", () => clearHotkey("togglePanel"));
  document.getElementById("hotkeyToggleCompactClear").addEventListener("click", () => clearHotkey("toggleCompact"));
  document.getElementById("hotkeyRefreshClear").addEventListener("click", () => clearHotkey("refresh"));
  document.getElementById("hotkeyTogglePinClear").addEventListener("click", () => clearHotkey("togglePin"));
  document.getElementById("hotkeyRestoreDefaults").addEventListener("click", () => {
    setHotkeyValues(DEFAULT_HOTKEYS);
    showSettingsStatus();
  });

  // Open settings
  document.getElementById("settingsButton").addEventListener("click", () => {
    setChoiceValue(langSelect, localStorage.getItem("lang") || "zh");
    setChoiceValue(themeSelect, localStorage.getItem("theme") || "light");
    cfgCodex.checked = config.enableCodex;
    cfgClaudeCode.checked = config.enableClaudeCode;
    cfgOpenCode.checked = config.enableOpenCode;
    cfgGeminiCli.checked = config.enableGeminiCli;
    cfgCline.checked = config.enableCline;
    cfgAntigravity.checked = config.enableAntigravity;
    setHotkeyValues(config.hotkeys);
    showSettingsStatus();
    settingsBody.scrollTop = 0;

    closeModelPicker();
    clearCardFocus();
    modalController.open(panel, {
      initialFocus: document.getElementById("settingsClose"),
      returnFocus: document.getElementById("settingsButton")
    });
  });

  // Close
  function closeSettings() {
    modalController.close(panel);
  }
  document.getElementById("settingsClose").addEventListener("click", closeSettings);
  settingsCancel.addEventListener("click", closeSettings);
  panel.querySelector(".settings-backdrop").addEventListener("click", closeSettings);

  // Save
  settingsSave.addEventListener("click", async () => {
    const lang = langSelect.dataset.value;
    const theme = themeSelect.dataset.value;

    const newConfig = {
      enableCodex: cfgCodex.checked,
      enableClaudeCode: cfgClaudeCode.checked,
      enableOpenCode: cfgOpenCode.checked,
      enableGeminiCli: cfgGeminiCli.checked,
      enableCline: cfgCline.checked,
      enableAntigravity: cfgAntigravity.checked,
      hotkeys: {
        togglePanel: hotkeyInputs.togglePanel.value.trim(),
        toggleCompact: hotkeyInputs.toggleCompact.value.trim(),
        refresh: hotkeyInputs.refresh.value.trim(),
        togglePin: hotkeyInputs.togglePin.value.trim()
      }
    };

    settingsSave.disabled = true;
    showSettingsStatus(t("settingsSaving"), "checking");
    try {
      const result = await window.aiQuota.saveSettings(newConfig);
      if (!result?.ok) {
        const message = result?.code === "duplicate" ? t("hotkeyDuplicate")
          : result?.code === "writeFailed" ? t("settingsWriteFailed")
            : t("hotkeyUnavailable", result?.accelerator || "");
        showSettingsStatus(message, "fail");
        return;
      }
      config = { ...config, ...newConfig, hotkeys: result.hotkeys };
      localStorage.setItem("lang", lang);
      localStorage.setItem("theme", theme);
      applyTheme(theme);
      applyLang(lang);
      setHotkeyValues(config.hotkeys);
      applyConfigEffects(config);
      document.body.classList.toggle("no-codex", !config.enableCodex);
    } catch (e) {
      console.error(e);
      showSettingsStatus(t("hotkeySaveFailed"), "fail");
      return;
    } finally {
      settingsSave.disabled = false;
    }

    closeSettings();
  });

}

function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.theme = theme === "dark" ? "dark" : "light";
  root.style.colorScheme = root.dataset.theme;
}

const I18N = {
  zh: {
    quotaOverview: "额度概览",
    quotaOverviewHint: "完整视图中点击查看详情；紧凑视图中点击刷新",
    quotaOverviewAria: "额度概览，点击放大",
    quotaModeAria: "选择额度来源",
    quotaModeCodex: "显示 Codex 额度",
    quotaModeAntigravity: "显示 Antigravity 额度",
    antigravityQuotaOverview: "Antigravity 额度",
    antigravityQuotaOverviewAria: "Antigravity Gemini 额度，点击放大",
    quotaRingAria: "额度分层圆环",
    resetRowAria: "重置卡，点击查看全部卡片",
    tokenAnalysis: "Token 分析",
    cardExpandAria: (title) => `${title}，点击放大`,
    resetSub: "恢复 5小时与周限额",
    trendTitle: "Token 消耗趋势",
    heatTitle: "每日Token消耗",
    hitRate: "命中率分析",
    token24h: "近 24h Token",
    cumulativeToken: "累计 Token",
    cumulative: "累计",
    localSession: "本地会话",
    apiData: "接口数据",
    estimated: "估算",
    tokenInput: "输入",
    tokenCache: "缓存",
    tokenOutput: "输出",
    tokenValue: "API 估值",
    tokenValueHint: "按标准文本 API 公开价格估算；不含长上下文、区域、工具调用及缓存存储附加费，不代表订阅实际账单。",
    tokenValuePartial: (models) => `仅包含已识别模型；未计价：${models}`,
    tokenValueUnavailable: "当前模型没有可用的公开 API 单价。",
    refreshTip: "手动刷新",
    refreshing: "正在刷新数据",
    refreshComplete: "数据已更新",
    pinTip: "置顶",
    unpinTip: "取消置顶",
    compactTip: "切换紧凑视图",
    expandTip: "展开完整视图",
    closeTip: "关闭",
    settingsTitle: "设置",
    settingsSubtitle: "界面、数据源与快捷键",
    appearanceSectionTitle: "外观",
    appearanceSectionHint: "调整界面语言和明暗主题",
    langLabel: "语言 / Language",
    themeLabel: "主题",
    themeLight: "亮色",
    themeDark: "暗色",
    saveBtn: "保存",
    cancelBtn: "取消",
    settingsClose: "关闭设置",
    allModels: "全部模型",
    sourceAll: "全部",
    allSources: "全部来源",
    unknownModel: "未知模型",
    modelPickerAria: "选择统计模型",
    modelExpanderAria: (source) => `展开或收起 ${source} 模型`,
    sourceSectionTitle: "启用的数据源",
    sourceSectionHint: "只读取需要汇总的本地来源",
    labelCodex: "OpenAI Codex 额度与日志",
    labelClaudeCode: "Claude Code 本地日志",
    labelOpenCode: "OpenCode 本地会话",
    labelGeminiCli: "Gemini CLI 本地会话",
    labelCline: "Cline 本地日志",
    labelAntigravity: "Antigravity 额度与会话估算",
    hotkeySectionTitle: "快捷键",
    hotkeyHint: "点击输入框后按下组合键；留空可关闭对应快捷键。",
    hotkeyTogglePanel: "显示 / 隐藏主面板",
    hotkeyToggleCompact: "切换紧凑模式",
    hotkeyRefresh: "刷新数据",
    hotkeyTogglePin: "切换置顶",
    hotkeyClear: "清除",
    hotkeyRestoreDefaults: "恢复默认",
    hotkeyUnset: "未设置",
    hotkeyModifierRequired: "请至少按住一个修饰键。",
    hotkeyDuplicate: "不同操作不能使用同一组合键。",
    hotkeyUnavailable: (key) => `${key || "该组合键"}已被其他程序占用或无效。`,
    hotkeySaveFailed: "快捷键保存失败。",
    settingsSaving: "正在保存…",
    settingsWriteFailed: "配置文件写入失败，请检查目录权限。",
    noData: "无数据",
    uncomputable: "无法分析",
    waitingData: "等待数据",
    refreshFailed: "读取失败",
    expireUnknown: "到期未知",
    resetCards: "重置卡",
    shortLabel: "5小时",
    weekLabel: "周限额",
    remaining: "剩余",
    unlimited: "无限制",
    low: "低",
    high: "高",
    hitExcellent: "优秀",
    hitGood: "良好",
    hitNormal: "一般",
    hitLow: "偏低",
    trend24Summary: "数据积累中",
    trend7Summary: "日消耗",
    trendHover: "悬浮曲线查看数值",
    trendRange: "24 小时 / 7 天",
    trend24Label: "近 24 小时",
    trend7Label: "近 7 天",
    recent30Days: "最近 30 天",
    heatmapAria: "最近 42 天每日 Token 消耗，使用方向键浏览",
    heatCellAria: (date, value) => `${date}，${value}`,
    collapseHint: "再次点击或按 Esc 返回",
    hoursAgo: (hours) => `${hours}h 前`,
    now: "现在",
    sevenDayAverage: (value) => `7d 平均 ${value}`,
    hitSummaryExcellent: "上下文复用极佳，输入成本被大幅削减。",
    hitSummaryGood: "上下文复用良好，有显著的成本节省效果。",
    hitSummaryMid: "缓存有贡献，仍可继续稳定提示词结构。",
    hitSummaryLow: "缓存复用偏少，长上下文任务成本更容易上升。",
    shellTitle: "点击空白处刷新",
    resetCount: (n) => `${n} 张`,
    resetCard: "重置卡",
    noResetCredits: "暂无重置卡",
    closeResetCards: "关闭重置卡列表",
    grantedAt: "获得时间",
    expiresAt: "到期时间",
    unknownTime: "未知",
    available: "可用",
    used: "已使用",
    expired: "已过期",
    unknownStatus: "未知状态",
  },
  en: {
    quotaOverview: "Quota Overview",
    quotaOverviewHint: "Click for details in the full view; click to refresh in compact view",
    quotaOverviewAria: "Quota overview, click to expand",
    quotaModeAria: "Select quota source",
    quotaModeCodex: "Show Codex quota",
    quotaModeAntigravity: "Show Antigravity quota",
    antigravityQuotaOverview: "Antigravity Quota",
    antigravityQuotaOverviewAria: "Antigravity Gemini quota, click to expand",
    quotaRingAria: "Layered quota rings",
    resetRowAria: "Reset cards, click to view all",
    tokenAnalysis: "Token Analysis",
    cardExpandAria: (title) => `${title}, click to expand`,
    resetSub: "5h + weekly reset",
    trendTitle: "Token Trend",
    heatTitle: "Daily Token Usage",
    hitRate: "Cache Hit Rate",
    token24h: "24h Tokens",
    cumulativeToken: "Cumulative Tokens",
    cumulative: "Cumulative",
    localSession: "Local Sessions",
    apiData: "API Data",
    estimated: "Estimate",
    tokenInput: "Input",
    tokenCache: "Cache",
    tokenOutput: "Output",
    tokenValue: "API value",
    tokenValueHint: "Estimated from public standard text API prices; excludes long-context, regional, tool, and cache-storage surcharges, and is not your subscription bill.",
    tokenValuePartial: (models) => `Known models only; not priced: ${models}`,
    tokenValueUnavailable: "No public API price is available for the current model.",
    refreshTip: "Refresh",
    refreshing: "Refreshing data",
    refreshComplete: "Data updated",
    pinTip: "Pin",
    unpinTip: "Unpin",
    compactTip: "Compact view",
    expandTip: "Expand view",
    closeTip: "Close",
    settingsTitle: "Settings",
    settingsSubtitle: "Appearance, sources, and shortcuts",
    appearanceSectionTitle: "Appearance",
    appearanceSectionHint: "Choose the interface language and color theme",
    langLabel: "Language",
    themeLabel: "Theme",
    themeLight: "Light",
    themeDark: "Dark",
    saveBtn: "Save",
    cancelBtn: "Cancel",
    settingsClose: "Close settings",
    allModels: "All Models",
    sourceAll: "All",
    allSources: "All Sources",
    unknownModel: "Unknown",
    modelPickerAria: "Select usage model",
    modelExpanderAria: (source) => `Expand or collapse ${source} models`,
    sourceSectionTitle: "Data Sources",
    sourceSectionHint: "Only read the local sources you want to include",
    labelCodex: "OpenAI Codex Quota & Logs",
    labelClaudeCode: "Claude Code Local Logs",
    labelOpenCode: "OpenCode Local Sessions",
    labelGeminiCli: "Gemini CLI Local Sessions",
    labelCline: "Cline Local Logs",
    labelAntigravity: "Antigravity Quota & Session Estimates",
    hotkeySectionTitle: "Shortcuts",
    hotkeyHint: "Click an input, then press a key combination. Leave it empty to disable that shortcut.",
    hotkeyTogglePanel: "Show / hide main panel",
    hotkeyToggleCompact: "Toggle compact mode",
    hotkeyRefresh: "Refresh data",
    hotkeyTogglePin: "Toggle always on top",
    hotkeyClear: "Clear",
    hotkeyRestoreDefaults: "Restore defaults",
    hotkeyUnset: "Not set",
    hotkeyModifierRequired: "Use at least one modifier key.",
    hotkeyDuplicate: "Different actions cannot use the same key combination.",
    hotkeyUnavailable: (key) => `${key || "This shortcut"} is unavailable or already used by another application.`,
    hotkeySaveFailed: "Failed to save shortcuts.",
    settingsSaving: "Saving…",
    settingsWriteFailed: "Failed to write the configuration file. Check the folder permissions.",
    noData: "No data",
    uncomputable: "N/A",
    waitingData: "Waiting",
    refreshFailed: "Refresh failed",
    expireUnknown: "Unknown",
    resetCards: "Resets",
    shortLabel: "5 Hours",
    weekLabel: "Weekly",
    remaining: "Remaining",
    unlimited: "Unlimited",
    low: "Low",
    high: "High",
    hitExcellent: "Excellent",
    hitGood: "Good",
    hitNormal: "Average",
    hitLow: "Low",
    trend24Summary: "Accumulating",
    trend7Summary: "Daily",
    trendHover: "Hover to see values",
    trendRange: "24 Hours / 7 Days",
    trend24Label: "Last 24 Hours",
    trend7Label: "Last 7 Days",
    recent30Days: "Last 30 Days",
    heatmapAria: "Daily token usage for the last 42 days; use arrow keys to browse",
    heatCellAria: (date, value) => `${date}, ${value}`,
    collapseHint: "Click again or press Esc to return",
    hoursAgo: (hours) => `${hours}h ago`,
    now: "Now",
    sevenDayAverage: (value) => `7d avg ${value}`,
    hitSummaryExcellent: "Outstanding cache reuse, significantly slashing input costs.",
    hitSummaryGood: "Strong context reuse keeps input costs low.",
    hitSummaryMid: "Cache helps, consider stabilizing prompt structure.",
    hitSummaryLow: "Low cache reuse may increase costs on long-context tasks.",
    shellTitle: "Click to refresh",
    resetCount: (n) => `${n} cards`,
    resetCard: "Reset card",
    noResetCredits: "No reset cards",
    closeResetCards: "Close reset-card list",
    grantedAt: "Granted",
    expiresAt: "Expires",
    unknownTime: "Unknown",
    available: "Available",
    used: "Used",
    expired: "Expired",
    unknownStatus: "Unknown status",
  }
};
let i18n = I18N.zh;

// Startup helpers render translated labels, so they must run after i18n exists.
setupSettings();
setupModelSelect();
setupQuotaModeToggle();
setupExpandableCards();
setupRingLayers();
renderBar(elements.shortBar, 0, "gray");
renderBar(elements.longBar, 0, "gray");
applyPinnedState(true);
applyCompactState(isCompact);
if (isCompact) window.aiQuota.setCompact(true);
setupTokenRangeToggle();
generateAndSaveTrayIcon();
loadInitialData();

function t(key, ...args) {
  let val = i18n[key];
  if (typeof val === "function") return val(...args);
  return val !== undefined ? val : key;
}

function applyLang(lang) {
  try {
    i18n = I18N[lang] || I18N.zh;
    document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
    const set = (id, key) => { const el = document.getElementById(id); if (el) el.textContent = t(key); };
    const setAttribute = (id, name, value) => {
      const el = document.getElementById(id);
      if (el) el.setAttribute(name, value);
    };
    const setTitleAndAria = (id, key) => {
      const value = t(key);
      setAttribute(id, "title", value);
      setAttribute(id, "aria-label", value);
    };
    const setExpandableCard = (id, key) => {
      const title = t(key);
      setAttribute(id, "data-expand-title", title);
      setAttribute(id, "aria-label", t("cardExpandAria", title));
    };

    setAttribute("shell", "title", t("shellTitle"));
    setTitleAndAria("refreshButton", "refreshTip");
    setAttribute("quotaModeToggle", "aria-label", t("quotaModeAria"));
    setTitleAndAria("quotaModeCodex", "quotaModeCodex");
    setTitleAndAria("quotaModeAntigravity", "quotaModeAntigravity");
    setTitleAndAria("settingsButton", "settingsTitle");
    setTitleAndAria("closeButton", "closeTip");
    setAttribute("quotaSide", "data-expand-title", t("quotaOverview"));
    setAttribute("quotaSide", "title", t("quotaOverviewHint"));
    setAttribute("quotaSide", "aria-label", t("quotaOverviewAria"));
    setAttribute("quotaRingChart", "aria-label", t("quotaRingAria"));
    set("remainingLabel", "remaining");
    set("resetSub", "resetSub");
    set("resetRowTitle", "resetCards");
    setAttribute("resetRow", "data-expand-title", t("resetCards"));
    setAttribute("resetRow", "aria-label", t("resetRowAria"));
    setAttribute("tokenAnalysis", "aria-label", t("tokenAnalysis"));
    setExpandableCard("totalTokenCard", "token24h");
    setExpandableCard("hitRateCard", "hitRate");
    setExpandableCard("trendCard", "trendTitle");
    setExpandableCard("heatCard", "heatTitle");
    set("cumulativeRangeButton", "cumulative");
    set("hitRateTitle", "hitRate");
    set("trendTitle", "trendTitle");
    set("trendDelta", "trendRange");
    set("trend24Label", "trend24Label");
    set("trend7Label", "trend7Label");
    set("trend24Summary", "trend24Summary");
    set("trend7Summary", "trend7Summary");
    set("trendAverage", "trendHover");
    set("heatTitle", "heatTitle");
    set("hitTrendLabel", "recent30Days");
    set("heatLow", "low");
    set("heatHigh", "high");
    setAttribute("hitHeatmap", "aria-label", t("heatmapAria"));
    setAttribute("trend24Chart", "aria-label", `${t("trend24Label")} Token`);
    setAttribute("trend7Chart", "aria-label", `${t("trend7Label")} Token`);
    set("langLabel", "langLabel");
    set("themeLabel", "themeLabel");
    set("settingsSubtitle", "settingsSubtitle");
    set("appearanceSectionTitle", "appearanceSectionTitle");
    set("appearanceSectionHint", "appearanceSectionHint");
    set("settingsSave", "saveBtn");
    set("settingsCancel", "cancelBtn");
    set("settingsTitle", "settingsTitle");
    setAttribute("settingsCard", "aria-label", t("settingsTitle"));
    setTitleAndAria("settingsClose", "settingsClose");
    set("shortLabel", "shortLabel");
    set("longLabel", "weekLabel");
    set("tokenValueLabel", "tokenValue");
    set("themeChoiceLight", "themeLight");
    set("themeChoiceDark", "themeDark");
    set("resetDialogTitle", "resetCards");
    set("resetDialogSummary", "noResetCredits");
    setTitleAndAria("resetDialogClose", "closeResetCards");
    set("sourceSectionTitle", "sourceSectionTitle");
    set("sourceSectionHint", "sourceSectionHint");
    set("labelCodex", "labelCodex");
    set("labelClaudeCode", "labelClaudeCode");
    set("labelOpenCode", "labelOpenCode");
    set("labelGeminiCli", "labelGeminiCli");
    set("labelCline", "labelCline");
    set("labelAntigravity", "labelAntigravity");
    set("hotkeySectionTitle", "hotkeySectionTitle");
    set("hotkeyHint", "hotkeyHint");
    set("hotkeyTogglePanelLabel", "hotkeyTogglePanel");
    set("hotkeyToggleCompactLabel", "hotkeyToggleCompact");
    set("hotkeyRefreshLabel", "hotkeyRefresh");
    set("hotkeyTogglePinLabel", "hotkeyTogglePin");
    set("hotkeyTogglePanelClear", "hotkeyClear");
    set("hotkeyToggleCompactClear", "hotkeyClear");
    set("hotkeyRefreshClear", "hotkeyClear");
    set("hotkeyTogglePinClear", "hotkeyClear");
    set("hotkeyRestoreDefaults", "hotkeyRestoreDefaults");
    const hotkeyAria = {
      hotkeyTogglePanel: "hotkeyTogglePanel",
      hotkeyToggleCompact: "hotkeyToggleCompact",
      hotkeyRefresh: "hotkeyRefresh",
      hotkeyTogglePin: "hotkeyTogglePin"
    };
    document.querySelectorAll(".hotkey-input").forEach((input) => {
      input.placeholder = t("hotkeyUnset");
      input.setAttribute("aria-label", t(hotkeyAria[input.id]));
    });
    document.querySelectorAll(".hotkey-clear-button").forEach((button) => {
      button.setAttribute("aria-label", t("hotkeyClear"));
    });
    if (elements.modelPickerTrigger) {
      elements.modelPickerTrigger.setAttribute("aria-label", t("modelPickerAria"));
    }
    document.querySelectorAll(".interactive-card[data-expand-title]:not(#resetRow)").forEach((card) => {
      card.dataset.collapseHint = t("collapseHint");
    });
    applyPinnedState(elements.pinButton.classList.contains("active"));
    applyCompactState(isCompact);
    if (lastSnapshot) render(lastSnapshot);
    else syncModelSelect(mergedModels);
  } catch(e) { /* don't crash on i18n */ }
}

async function refresh({ manual = false } = {}) {
  if (isRefreshing) {
    return;
  }
  isRefreshing = true;
  document.body.classList.add("refreshing");
  elements.shell.setAttribute("aria-busy", "true");
  elements.refreshButton.disabled = true;
  elements.refreshButton.setAttribute("aria-label", t("refreshing"));
  elements.appStatus.textContent = t("refreshing");
  try {
    render(await window.aiQuota.refresh({ manual }));
    elements.appStatus.textContent = t("refreshComplete");
  } catch (error) {
    console.error("Failed to refresh dashboard", error);
    elements.appStatus.textContent = t("refreshFailed");
  } finally {
    isRefreshing = false;
    document.body.classList.remove("refreshing");
    elements.shell.setAttribute("aria-busy", "false");
    elements.refreshButton.disabled = false;
    elements.refreshButton.setAttribute("aria-label", t("refreshTip"));
  }
}

function applyConfigEffects(config) {
  if (!config) return;
  const btn = elements.compactButton || document.getElementById("compactButton");
  if (!config.enableCodex && !config.enableAntigravity) {
    if (btn) btn.style.display = "none";
    if (isCompact) {
      setCompact(false);
    }
  } else {
    if (btn) btn.style.display = "";
  }
  elements.quotaModeToggle.hidden = !(config.enableCodex && config.enableAntigravity);
  const availableMode = !config.enableCodex && config.enableAntigravity
    ? "antigravity"
    : config.enableCodex ? quotaMode : "codex";
  setQuotaMode(availableMode, { persist: false, render: false });
}

function setupQuotaModeToggle() {
  elements.quotaModeToggle.querySelectorAll(".quota-mode-button").forEach((button) => {
    button.addEventListener("click", () => setQuotaMode(button.dataset.mode));
  });
  setQuotaMode(quotaMode, { persist: false, render: false });
}

function setQuotaMode(mode, { persist = true, render = true } = {}) {
  const config = lastSnapshot?.config;
  let next = mode === "antigravity" ? "antigravity" : "codex";
  if (next === "antigravity" && config && !config.enableAntigravity) next = "codex";
  if (next === "codex" && config && !config.enableCodex && config.enableAntigravity) next = "antigravity";
  quotaMode = next;
  if (persist) localStorage.setItem("quotaMode", quotaMode);
  elements.quotaModeToggle.classList.toggle("antigravity", quotaMode === "antigravity");
  for (const button of [elements.quotaModeCodex, elements.quotaModeAntigravity]) {
    const active = button.dataset.mode === quotaMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  }
  if (render && lastSnapshot) renderQuotaContext(lastSnapshot);
}

async function setCompact(compact) {
  applyCompactState(compact);
  await window.aiQuota.setCompact(compact);
}

function applyCompactState(compact) {
  clearCardFocus();
  isCompact = Boolean(compact);
  localStorage.setItem("compact", isCompact ? "1" : "0");
  document.body.classList.toggle("compact", isCompact);
  elements.compactButton.title = isCompact ? t("expandTip") : t("compactTip");
  elements.compactButton.setAttribute("aria-label", isCompact ? t("expandTip") : t("compactTip"));
  elements.compactButton.setAttribute("aria-pressed", String(isCompact));
  elements.compactIcon.setAttribute(
    "d",
    isCompact ? "M9 3H3v6M15 3h6v6M21 15v6h-6M3 15v6h6" : "M6 7h12v10H6z"
  );
}

function applyPinnedState(pinned) {
  elements.pinButton.classList.toggle("active", Boolean(pinned));
  elements.pinButton.title = pinned ? t("unpinTip") : t("pinTip");
  elements.pinButton.setAttribute("aria-label", elements.pinButton.title);
  elements.pinButton.setAttribute("aria-pressed", String(Boolean(pinned)));
}


function render(snapshot) {
  try {
    lastSnapshot = snapshot;
    if (snapshot?.config) {
      applyConfigEffects(snapshot.config);
      document.body.classList.toggle("no-codex", !snapshot.config.enableCodex && !snapshot.config.enableAntigravity);
    }
    const quota = snapshot?.quota;
    elements.updatedAt.textContent = snapshot?.error ? t("refreshFailed") : formatTime(snapshot?.updatedAt ?? Date.now());
    elements.updatedAt.classList.toggle("error", Boolean(snapshot?.error));
    elements.updatedAt.title = snapshot?.error ?? "";

    mergedModels = buildMergedModels(snapshot);
    selectableModelSources = new Set(mergedModels.map((model) => model.source).filter(Boolean));
    if (snapshot?.config?.enableAntigravity && (snapshot?.antigravityQuota || snapshot?.antigravityTokenUsage)) {
      selectableModelSources.add("antigravity");
    }
    const tokenData = getTokenForModel(snapshot, selectedModel);
    renderTokenStats(tokenData, mergedModels, ++tokenRenderGeneration);
    renderQuotaContext(snapshot);

    if (!snapshot?.stale) recordHistory(quota);
    scheduleHistoryRender();
  } catch (e) {
    elements.updatedAt.textContent = "ERR:" + (e.message || "").slice(0, 30);
    elements.updatedAt.classList.add("error");
  }
}

function setupTokenRangeToggle() {
  const toggle = elements.tokenRangeToggle;
  if (!toggle) return;
  const buttons = toggle.querySelectorAll(".range-btn");
  
  buttons.forEach((btn) => {
    const range = btn.dataset.range;
    if (range === tokenRange) {
      btn.classList.add("active");
      btn.setAttribute("aria-pressed", "true");
    } else {
      btn.classList.remove("active");
      btn.setAttribute("aria-pressed", "false");
    }
  });

  setTimeout(updateToggleSlider, 100);
  window.addEventListener("resize", scheduleToggleSliderUpdate);

  buttons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const range = btn.dataset.range;
      if (range === tokenRange) return;
      const renderId = ++tokenRenderGeneration;

      tokenRange = range;
      localStorage.setItem("tokenRange", range);

      buttons.forEach((b) => {
        const active = b === btn;
        b.classList.toggle("active", active);
        b.setAttribute("aria-pressed", String(active));
      });
      
      updateToggleSlider();

      elements.tokenCardBody.classList.add("switching");
      await new Promise((resolve) => setTimeout(resolve, 220));

      if (lastSnapshot && renderId === tokenRenderGeneration) {
        const tokenData = getTokenForModel(lastSnapshot, selectedModel);
        await renderTokenStats(tokenData, mergedModels, renderId);
      }

      if (renderId === tokenRenderGeneration) {
        elements.tokenCardBody.classList.remove("switching");
      }
    });
  });
}

function updateToggleSlider() {
  const toggle = elements.tokenRangeToggle;
  if (!toggle) return;
  const activeBtn = toggle.querySelector(".range-btn.active");
  const slider = toggle.querySelector(".range-slider");
  if (slider && activeBtn) {
    slider.style.width = `${activeBtn.offsetWidth}px`;
    slider.style.transform = `translateX(${activeBtn.offsetLeft}px)`;
  }
}

function scheduleToggleSliderUpdate() {
  if (toggleSliderFrame) return;
  toggleSliderFrame = requestAnimationFrame(() => {
    toggleSliderFrame = null;
    updateToggleSlider();
  });
}


function setupModelSelect() {
  const picker = document.createElement("div");
  const trigger = document.createElement("button");
  const label = document.createElement("span");
  const arrow = document.createElement("i");
  const menu = document.createElement("div");
  picker.className = "model-picker";
  trigger.className = "model-picker-trigger";
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", t("modelPickerAria"));
  label.className = "model-picker-label";
  arrow.className = "model-picker-arrow";
  menu.className = "model-picker-menu";
  menu.id = "modelPickerMenu";
  menu.setAttribute("role", "listbox");
  trigger.setAttribute("aria-controls", menu.id);
  trigger.append(label, arrow);
  picker.append(trigger, menu);
  elements.tokenCost.remove();
  document.querySelector(".window-actions").prepend(picker);
  elements.modelPicker = picker;
  elements.modelPickerTrigger = trigger;
  elements.modelPickerLabel = label;
  elements.modelPickerMenu = menu;

  trigger.addEventListener("click", () => {
    picker.classList.contains("open") ? closeModelPicker() : openModelPicker();
  });
  trigger.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const focus = event.key === "ArrowUp" || event.key === "End"
      ? "last"
      : event.key === "Home" ? "first" : "selected";
    openModelPicker({ focus });
  });
  menu.addEventListener("keydown", handleModelPickerKeydown);
  document.addEventListener("pointerdown", (event) => {
    if (!picker.contains(event.target)) closeModelPicker();
  });
}

function syncModelSelect(modelUsage) {
  const models = Array.isArray(modelUsage) ? modelUsage : [];
  const modelKeys = models.map((m) => m.sourceModel || m.model);
  const sourceKeys = [...selectableModelSources];
  const allowed = new Set(["all", ...modelKeys, ...sourceKeys.map((source) => `source:${source}`)]);
  if (!allowed.has(selectedModel)) selectedModel = "all";
  const nextSignature = JSON.stringify([
    currentLocale(),
    selectedModel,
    sourceKeys,
    models.map((item) => [item.source, item.sourceModel || item.model, item.model])
  ]);
  if (nextSignature === modelMenuSignature) return;
  modelMenuSignature = nextSignature;
  updateModelPickerWidth(models);
  elements.modelPickerMenu.replaceChildren();
  const allOption = buildModelOption({ model: "all", label: t("allModels"), kind: "all" });
  elements.modelPickerMenu.append(allOption);
  for (const source of MODEL_SOURCES) {
    const sourceModels = models.filter((item) => item.source === source.key);
    if (!selectableModelSources.has(source.key)) continue;
    const group = document.createElement("div");
    group.className = "model-picker-group";
    group.setAttribute("role", "group");
    const sourceRow = document.createElement("div");
    sourceRow.className = "model-picker-source-row";
    const sourceOption = buildModelOption({
      model: `source:${source.key}`,
      label: `${source.label} · ${t("sourceAll")}`,
      source: source.key,
      kind: "source"
    });
    sourceRow.append(sourceOption);
    group.append(sourceRow);
    if (sourceModels.length) {
      const expander = document.createElement("button");
      expander.type = "button";
      expander.className = "model-picker-expander";
      expander.tabIndex = -1;
      expander.setAttribute("aria-label", t("modelExpanderAria", source.label));
      const modelList = document.createElement("div");
      modelList.className = "model-picker-models";
      const updateExpandedState = () => {
        const expanded = expandedModelSources.has(source.key);
        modelList.hidden = !expanded;
        expander.setAttribute("aria-expanded", String(expanded));
        expander.textContent = expanded ? "▾" : "▸";
      };
      expander.addEventListener("click", (event) => {
        event.stopPropagation();
        expandedModelSources.has(source.key)
          ? expandedModelSources.delete(source.key)
          : expandedModelSources.add(source.key);
        updateExpandedState();
      });
      sourceRow.append(expander);
      for (const item of sourceModels) {
        modelList.append(buildModelOption({
          model: item.sourceModel || item.model,
          label: item.model === "unknown" ? t("unknownModel") : item.model,
          source: source.key,
          kind: "model",
          total: item.total
        }));
      }
      group.append(modelList);
      updateExpandedState();
    }
    elements.modelPickerMenu.append(group);
  }
  const parsed = parseModelSelection(selectedModel);
  const sel = models.find((m) => (m.sourceModel || m.model) === selectedModel);
  elements.modelPickerLabel.textContent = parsed.kind === "all"
    ? t("allModels")
    : parsed.kind === "source"
      ? `${modelSourceLabel(parsed.source)} · ${t("sourceAll")}`
      : (sel?.model || parsed.model || selectedModel);
}

function updateModelPickerWidth(models) {
  if (!elements.modelPickerTrigger || !elements.modelPicker) return;
  const context = modelMeasureCanvas.getContext("2d");
  if (!context) return;
  context.font = getComputedStyle(elements.modelPickerTrigger).font;
  const labels = [
    t("allModels"),
    ...MODEL_SOURCES.map((source) => `${source.label} · ${t("sourceAll")}`),
    ...models.map((item) => item.model === "unknown" ? t("unknownModel") : item.model)
  ];
  const longest = Math.max(...labels.map((label) => context.measureText(label).width), 0);
  const width = Math.min(250, Math.max(205, Math.ceil(longest + 102)));
  elements.modelPicker.style.width = `${width}px`;
}

function buildModelOption(item) {
  const option = document.createElement("button");
  option.type = "button";
  option.className = "model-picker-option";
  if (item.kind === "source") option.classList.add("model-picker-source");
  if (item.kind === "model") option.classList.add("model-picker-model");
  option.setAttribute("role", "option");
  option.setAttribute("aria-selected", String(item.model === selectedModel));
  option.classList.toggle("selected", item.model === selectedModel);
  option.tabIndex = -1;
  const label = document.createElement("span");
  label.className = "model-picker-option-label";
  label.textContent = item.label || item.model;
  option.append(label);
  if (item.kind === "model" && Number.isFinite(item.total)) {
    const usage = document.createElement("small");
    usage.className = "model-picker-usage";
    usage.textContent = formatToken(item.total);
    option.append(usage);
    option.title = `${label.textContent} · ${usage.textContent} Token`;
  }
  if (item.source) option.dataset.source = item.source;
  option.addEventListener("click", () => {
    selectedModel = item.model;
    closeModelPicker({ restoreFocus: true });
    syncModelSelect(mergedModels);
    if (lastSnapshot) {
      const data = getTokenForModel(lastSnapshot, selectedModel);
      renderTokenStats(data, mergedModels, ++tokenRenderGeneration);
    }
    scheduleHistoryRender(true);
  });
  return option;
}

function sourceLabel(stats) {
  if (!stats) return t("noData");
  const suffix = tokenRange === "cumulative" ? ` · ${t("cumulative")}` : "";
  if (stats.source === "codex") return "Codex" + suffix;
  if (stats.source === "claude") return "Claude Code" + suffix;
  if (stats.source === "opencode") return "OpenCode" + suffix;
  if (stats.source === "gemini") return "Gemini CLI" + suffix;
  if (stats.source === "cline") return "Cline" + suffix;
  if (stats.source === "antigravity") return `Antigravity · ${t("estimated")}${suffix}`;
  if (stats.source === "merged") return t("allSources") + suffix;
  return (stats.source === "localSessions" || stats.source === "localModel" ? t("localSession") : t("apiData")) + suffix;
}

function visibleModelPickerItems() {
  if (!elements.modelPickerMenu) return [];
  return [...elements.modelPickerMenu.querySelectorAll(".model-picker-option, .model-picker-expander")]
    .filter((item) => !item.closest("[hidden]"));
}

function focusModelPickerItem(target = "selected") {
  const items = visibleModelPickerItems();
  if (!items.length) return;
  const selected = items.find((item) => item.classList.contains("selected"));
  const item = target === "last" ? items.at(-1) : target === "first" ? items[0] : selected || items[0];
  item.focus({ preventScroll: true });
  item.scrollIntoView({ block: "nearest" });
}

function handleModelPickerKeydown(event) {
  const items = visibleModelPickerItems();
  const current = items.indexOf(document.activeElement);
  if (event.key === "Escape") {
    event.preventDefault();
    closeModelPicker({ restoreFocus: true });
    return;
  }
  if (event.key === "Tab") {
    closeModelPicker();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const key = event.key === "ArrowDown" ? "ArrowRight" : event.key === "ArrowUp" ? "ArrowLeft" : event.key;
  const next = nextRovingIndex(current < 0 ? 0 : current, items.length, key);
  items[next]?.focus({ preventScroll: true });
  items[next]?.scrollIntoView({ block: "nearest" });
}

function openModelPicker({ focus = null } = {}) {
  elements.modelPicker.classList.add("open");
  elements.modelPickerTrigger.setAttribute("aria-expanded", "true");
  if (focus) requestAnimationFrame(() => focusModelPickerItem(focus));
}

function closeModelPicker({ restoreFocus = false } = {}) {
  if (!elements.modelPicker) return;
  elements.modelPicker.classList.remove("open");
  elements.modelPickerTrigger.setAttribute("aria-expanded", "false");
  if (restoreFocus) elements.modelPickerTrigger.focus({ preventScroll: true });
}

function localizedQuotaLabel(quotaWindow, fallbackLabel) {
  if (quotaWindow?.durationMins === 300) return t("shortLabel");
  if (quotaWindow?.durationMins === 10080) return t("weekLabel");
  return quotaWindow?.label || fallbackLabel;
}

function renderWindow(prefix, quotaWindow, fallbackLabel, hideWhenMissing = true, options = {}) {
  const unlimited = options.unlimitedWhenMissing && !quotaWindow;
  const metric = elements[`${prefix}Metric`];
  if (metric) metric.hidden = hideWhenMissing && !quotaWindow && !unlimited;
  const percent = unlimited ? 100 : quotaWindow?.remainingPercent;
  const tone = toneForPercent(percent);
  elements[`${prefix}Label`].textContent = localizedQuotaLabel(quotaWindow, fallbackLabel);
  elements[`${prefix}Value`].textContent = unlimited ? "∞" : percent == null ? "--%" : `${percent}%`;
  elements[`${prefix}Reset`].textContent = unlimited
    ? t("unlimited")
    : quotaWindow?.resetsAt ? formatDateTime(quotaWindow.resetsAt) : t("waitingData");
  elements[`${prefix}ResetCompact`].textContent = unlimited
    ? "∞"
    : quotaWindow?.resetsAt ? formatCompactDate(quotaWindow.resetsAt) : "--";
  renderBar(elements[`${prefix}Bar`], percent, tone);
}

function renderRing(windows, hasQuota) {
  const shortWindow = windows?.ringShortWindow;
  const longWindow = windows?.ringLongWindow;
  const short = shortWindow?.remainingPercent;
  const long = longWindow?.remainingPercent;
  const hasShort = Boolean(shortWindow) || !hasQuota;
  const hasLong = Boolean(longWindow) || !hasQuota;
  elements.shortRingTrack.style.display = hasShort ? "" : "none";
  elements.shortRingArc.style.display = hasShort ? "" : "none";
  elements.longRingTrack.style.display = hasLong ? "" : "none";
  elements.longRingArc.style.display = hasLong ? "" : "none";
  elements.ringShortValue.hidden = !hasShort;
  elements.ringLongValue.hidden = !hasLong;
  elements.ringShort.textContent = short == null ? "--%" : `${short}%`;
  elements.ringLong.textContent = long == null ? "--%" : `${long}%`;
  elements.ringShortLabel.textContent = compactWindowLabel(shortWindow, "5h");
  elements.ringLongLabel.textContent = compactWindowLabel(longWindow, t("weekLabel"));
  elements.shortResetCompact.textContent = shortWindow?.resetsAt ? formatCompactDate(shortWindow.resetsAt) : "--";
  elements.longResetCompact.textContent = longWindow?.resetsAt ? formatCompactDate(longWindow.resetsAt) : "--";
  elements.shortRingArc.style.strokeDasharray = `${clamp(short ?? 0)} 100`;
  elements.longRingArc.style.strokeDasharray = `${clamp(long ?? 0)} 100`;
  elements.shortRingArc.setAttribute("aria-label", `${elements.ringShortLabel.textContent} ${t("remaining")} ${short ?? "--"}%`);
  elements.longRingArc.setAttribute("aria-label", `${elements.ringLongLabel.textContent} ${t("remaining")} ${long ?? "--"}%`);
}

function getDisplayWindows(quota) {
  const shortWindow = quota?.shortWindow ?? null;
  const longWindow = quota?.longWindow ?? null;
  return {
    shortWindow,
    longWindow,
    ringShortWindow: shortWindow ?? longWindow,
    ringLongWindow: shortWindow ? longWindow : null
  };
}

function compactWindowLabel(window, fallback) {
  const minutes = window?.durationMins;
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "7d";
  return window?.label || fallback;
}

function renderResetCredits(resetCredits, resetCard) {
  if (Array.isArray(resetCredits?.credits)) {
    latestResetCredits = [...resetCredits.credits].sort(compareResetExpiry);
  }
  const normalizedCardCount = normalizeResetCount(resetCard?.count);
  const hasResetCard = Boolean(resetCard && (resetCard.unlimited || normalizedCardCount != null));
  const normalizedCreditCount = normalizeResetCount(resetCredits?.availableCount);
  const hasResetCredits = Boolean(resetCredits && (
    Array.isArray(resetCredits.credits) || normalizedCreditCount != null
  ));
  const hasResetData = hasResetCard || hasResetCredits;
  elements.resetRow.hidden = !hasResetData;
  if (!hasResetData) {
    if (modalController.isOpen(elements.resetDialog)) closeResetDialog();
    return;
  }
  const availableCredits = latestResetCredits.filter((credit) => credit.status === "available");
  const reportedCount = normalizedCreditCount ?? normalizedCardCount;
  const availableCount = reportedCount ?? availableCredits.length;
  const nearest = (availableCredits.length ? availableCredits : latestResetCredits)[0];
  const expiresAt = nearest?.expiresAt ?? resetCard?.expiresAt;
  elements.resetCount.textContent = t("resetCount", availableCount);
  elements.resetExpiry.textContent = expiresAt ? formatDateTime(expiresAt) : t("expireUnknown");
}

function renderQuotaContext(snapshot) {
  const antigravityMode = quotaMode === "antigravity";
  const quota = antigravityMode ? snapshot?.antigravityQuota : snapshot?.quota;
  const title = antigravityMode ? t("antigravityQuotaOverview") : t("quotaOverview");
  const aria = antigravityMode ? t("antigravityQuotaOverviewAria") : t("quotaOverviewAria");
  elements.quotaSide.dataset.expandTitle = title;
  elements.quotaSide.setAttribute("aria-label", aria);

  const windows = getDisplayWindows(quota);
  renderWindow(
    "short",
    windows.shortWindow,
    t("shortLabel"),
    Boolean(quota),
    { unlimitedWhenMissing: !antigravityMode && Boolean(quota?.longWindow && !quota?.shortWindow) }
  );
  renderWindow("long", windows.longWindow, t("weekLabel"), Boolean(quota));
  renderRing(windows, Boolean(quota));

  if (antigravityMode) {
    elements.resetRow.hidden = true;
    if (modalController.isOpen(elements.resetDialog)) closeResetDialog();
  } else {
    renderResetCredits(snapshot?.resetCredits, quota?.resetCard);
  }
}

function normalizeResetCount(value) {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function openResetDialog() {
  clearCardFocus();
  closeModelPicker();
  renderResetDialog();
  elements.resetRow.setAttribute("aria-expanded", "true");
  modalController.open(elements.resetDialog, {
    initialFocus: elements.resetDialogClose,
    returnFocus: elements.resetRow,
    onClose: () => elements.resetRow.setAttribute("aria-expanded", "false")
  });
}

function closeResetDialog() {
  modalController.close(elements.resetDialog);
}

function renderResetDialog() {
  const cards = [...latestResetCredits].sort(compareResetExpiry);
  const availableCount = cards.filter((card) => card.status === "available").length;
  elements.resetDialogList.replaceChildren();
  elements.resetDialogSummary.textContent = cards.length ? `${t("available")} ${availableCount} · ${t("resetCount", cards.length)}` : t("noResetCredits");
  if (!cards.length) {
    const empty = document.createElement("p");
    empty.className = "reset-dialog-empty";
    empty.textContent = t("noResetCredits");
    elements.resetDialogList.append(empty);
    return;
  }
  for (const card of cards) {
    const item = document.createElement("article");
    item.className = "reset-credit-item";
    const head = document.createElement("div");
    const title = document.createElement("strong");
    const status = document.createElement("span");
    title.textContent = card.title || t("resetCard");
    status.textContent = resetStatusLabel(card.status);
    status.className = `reset-credit-status ${card.status === "available" ? "available" : "inactive"}`;
    head.append(title, status);
    const detail = document.createElement("p");
    detail.textContent = `${t("grantedAt")}：${card.grantedAt ? formatDateTime(card.grantedAt) : t("unknownTime")}\n${t("expiresAt")}：${card.expiresAt ? formatDateTime(card.expiresAt) : t("expireUnknown")}`;
    item.append(head, detail);
    elements.resetDialogList.append(item);
  }
}

function compareResetExpiry(a, b) {
  return (a.expiresAt ?? Number.POSITIVE_INFINITY) - (b.expiresAt ?? Number.POSITIVE_INFINITY);
}

function resetStatusLabel(status) {
  if (status === "available") return t("available");
  if (status === "used") return t("used");
  if (status === "expired") return t("expired");
  return status || t("unknownStatus");
}

async function renderTokenStats(stats, modelUsage, renderId) {
  if (renderId !== tokenRenderGeneration) return;
  syncModelSelect(modelUsage);

  let displayStats = stats;
  let titleText = t("token24h");

  if (tokenRange === "cumulative") {
    titleText = t("cumulativeToken");
    if (!initialDataReady) {
      displayStats = null;
    } else {
      try {
        const cumStats = await window.aiQuota.readCumulativeTokens(selectedModel);
        if (renderId !== tokenRenderGeneration) return;
        if (cumStats) {
          displayStats = {
            ...cumStats,
            source: parseModelSelection(selectedModel).source || (selectedModel === "all" ? "merged" : null),
            cacheHitRate: cumStats.cacheHitRate ?? ((cumStats.cached == null || cumStats.input === 0) ? null : Math.round((cumStats.cached / cumStats.input) * 100))
          };
        }
      } catch (e) {
        console.error(e);
      }
    }
  } else {
    if (renderId !== tokenRenderGeneration) return;
    const selectedUsage = selectedModel === "all" ? null : modelUsage?.find((item) => item.currentUsage && (item.sourceModel || item.model) === selectedModel);
    if (selectedUsage) {
      displayStats = {
        ...stats,
        ...selectedUsage,
        source: selectedUsage.source || "localModel",
        cacheHitRate: (selectedUsage.cached == null || selectedUsage.input === 0) ? null : Math.round((selectedUsage.cached / selectedUsage.input) * 100)
      };
    }
  }

  elements.tokenCardTitle.textContent = titleText;
  stats = displayStats;

  const hasTokenData =
    typeof stats?.input === "number" ||
    typeof stats?.cached === "number" ||
    typeof stats?.output === "number" ||
    typeof stats?.total === "number";
  const input = stats?.input ?? 0;
  const cached = stats?.cached ?? 0;
  const output = stats?.output ?? 0;
  const total = stats?.total ?? input + cached + output;
  const hitRate = stats?.cacheHitRate;

  elements.totalTokens.textContent = hasTokenData ? formatToken(total) : "--";
  elements.inputTokens.textContent = typeof stats?.input === "number" ? formatToken(input) : "--";
  elements.cachedTokens.textContent = typeof stats?.cached === "number" ? formatToken(cached) : "--";
  elements.outputTokens.textContent = typeof stats?.output === "number" ? formatToken(output) : "--";
  elements.inputLabel.textContent = t("tokenInput");
  elements.cachedLabel.textContent = t("tokenCache");
  elements.outputLabel.textContent = t("tokenOutput");
  elements.tokenCost.textContent = hasTokenData
    ? sourceLabel(stats)
    : stats?.error
      ? t("refreshFailed")
      : t("noData");
  renderTokenValue(stats, hasTokenData);
  if (hitRate == null) {
    elements.cacheHitRate.classList.add("text-label");
    elements.cacheHitRate.textContent = t("uncomputable");
  } else {
    elements.cacheHitRate.classList.remove("text-label");
    elements.cacheHitRate.textContent = `${hitRate}%`;
  }
  elements.hitDelta.textContent = hitRate == null
    ? t("noData")
    : hitRate >= 85
      ? t("hitExcellent")
      : hitRate >= 60
        ? t("hitGood")
        : hitRate >= 30
          ? t("hitNormal")
          : t("hitLow");
  elements.hitSummary.textContent = hitRate == null
    ? (stats?.error ? `account/usage/read: ${shortError(stats.error)}` : t("noData"))
    : hitSummary(hitRate);

  const uncachedInput = Math.max(0, input - cached);
  const knownTotal = Math.max(1, input + output);
  elements.inputSegment.style.width = hasTokenData ? `${(uncachedInput / knownTotal) * 100}%` : "0%";
  elements.cacheSegment.style.width = hasTokenData ? `${(cached / knownTotal) * 100}%` : "0%";
  elements.outputSegment.style.width = hasTokenData ? `${(output / knownTotal) * 100}%` : "0%";
}

function renderTokenValue(stats, hasTokenData) {
  elements.tokenValueLabel.textContent = t("tokenValue");
  const estimate = hasTokenData ? window.TokenPricing?.estimateTokenCost(stats) : null;
  if (!estimate?.pricedModels) {
    elements.tokenValue.textContent = "--";
    elements.tokenValueBox.classList.add("unavailable");
    elements.tokenValueBox.title = hasTokenData ? t("tokenValueUnavailable") : t("noData");
    return;
  }

  const formattedValue = window.TokenPricing.formatUsd(estimate.usd);
  elements.tokenValue.textContent = `≈ ${formattedValue}${estimate.complete ? "" : "+"}`;
  elements.tokenValueBox.classList.remove("unavailable");
  elements.tokenValueBox.title = estimate.complete
    ? t("tokenValueHint")
    : `${t("tokenValueHint")} ${t("tokenValuePartial", estimate.unknownModels.join(", "))}`;
}

function renderBar(bar, percent, tone) {
  bar.className = tone;
  bar.style.width = `${percent ?? 0}%`;
}

function recordHistory(quota) {
  const short = quota?.shortWindow?.remainingPercent;
  const long = quota?.longWindow?.remainingPercent;
  const token = quota?.tokenStats?.total;
  const hit = quota?.tokenStats?.cacheHitRate;
  if (short == null && long == null && token == null && hit == null) {
    return;
  }
  const last = history.at(-1);
  const now = Date.now();
  const entry = { t: now, short, long, token, hit };
  if (last && now - last.t < 60_000) {
    history[history.length - 1] = entry;
  } else {
    history.push(entry);
  }
  history = history.slice(-288);
  localStorage.setItem("quotaHistory", JSON.stringify(history));
}

function scheduleHistoryRender(immediate = false) {
  if (!historyRenderingEnabled) return;
  if (document.hidden) return;
  if (historyRenderInFlight) {
    historyRenderQueued = true;
    historyRenderQueuedImmediate ||= immediate;
    return;
  }

  const delay = immediate ? 0 : Math.max(0, HISTORY_RENDER_INTERVAL - (Date.now() - lastHistoryRenderAt));
  if (historyRenderTimer) {
    if (!immediate) return;
    clearTimeout(historyRenderTimer);
  }
  historyRenderTimer = setTimeout(async () => {
    historyRenderTimer = null;
    if (document.hidden) return;
    historyRenderInFlight = true;
    try {
      await renderHistory();
      lastHistoryRenderAt = Date.now();
    } finally {
      historyRenderInFlight = false;
      if (historyRenderQueued) {
        const queuedImmediate = historyRenderQueuedImmediate;
        historyRenderQueued = false;
        historyRenderQueuedImmediate = false;
        scheduleHistoryRender(queuedImmediate);
      }
    }
  }, delay);
}

async function renderHistory() {
  const modelForRender = selectedModel;
  let daily = {};
  let hourly = [];

  if (modelForRender === "all") {
    try {
      const [codexData, agData] = await Promise.allSettled([
        window.aiQuota.readTokenHistory("all"),
        window.aiQuota.readAntigravityHistory("all")
      ]);
      daily = mergeDailyMaps(
        codexData.status === "fulfilled" ? codexData.value.daily : {},
        agData.status === "fulfilled" ? agData.value.daily : {}
      );
      hourly = mergeHourlyBuckets(
        codexData.status === "fulfilled" ? codexData.value.hourly : [],
        agData.status === "fulfilled" ? agData.value.hourly : []
      );
    } catch {
      daily = {};
      hourly = [];
    }
  } else {
    const selection = parseModelSelection(modelForRender);
    try {
      let historyData;
      if (selection.source === "antigravity") {
        historyData = await window.aiQuota.readAntigravityHistory(selection.model);
      } else {
        historyData = await window.aiQuota.readTokenHistory(selection.model, selection.source);
      }
      daily = historyData.daily;
      hourly = historyData.hourly;
    } catch {
      daily = {};
      hourly = [];
    }
  }

  if (modelForRender !== selectedModel) return;
  renderTrendWithData(daily, hourly);
  renderHeatmapWithData(daily);
}

function mergeDailyMaps(...maps) {
  const result = {};
  for (const map of maps) {
    for (const [key, val] of Object.entries(map)) {
      if (!result[key]) result[key] = { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 };
      result[key].input += val.input || 0;
      result[key].cached += val.cached || 0;
      result[key].output += val.output || 0;
      result[key].reasoning += val.reasoning || 0;
      result[key].total += val.total || 0;
    }
  }
  return result;
}

function mergeHourlyBuckets(...bucketArrays) {
  const maxLen = Math.max(...bucketArrays.map((a) => a.length), 0);
  if (maxLen === 0) return [];
  // Use the bucket array with the most entries as the base, or create new
  const base = bucketArrays.find((a) => a.length === maxLen) || [];
  const result = base.map((b) => ({ ...b }));
  for (const buckets of bucketArrays) {
    if (buckets === base) continue;
    for (let i = 0; i < Math.min(result.length, buckets.length); i++) {
      result[i].input += buckets[i].input || 0;
      result[i].cached += buckets[i].cached || 0;
      result[i].output += buckets[i].output || 0;
      result[i].reasoning += buckets[i].reasoning || 0;
      result[i].total += buckets[i].total || 0;
    }
  }
  return result;
}

function renderTrendWithData(daily, hourly) {
  const now = Date.now();
  const recent = (Array.isArray(hourly) ? hourly : []).map((entry, index, values) => ({
    value: entry.total ?? 0,
    x: values.length <= 1 ? 1 : index / (values.length - 1),
    label: formatHourMinute(entry.t),
    fullLabel: `${formatDateTime(entry.t)}–${formatHourMinute(entry.t + 60 * 60_000)}`
  }));
  renderTokenChart("24", recent, [
    { x: 0, label: t("hoursAgo", 24) },
    { x: 0.5, label: t("hoursAgo", 12) },
    { x: 1, label: t("now") }
  ]);

  const today = new Date(now);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dayData = daily[key] || { input: 0, cached: 0, output: 0, total: 0 };
    days.push({ value: dayData.total ?? 0, x: (6 - i) / 6, label: formatMonthDay(d), fullLabel: key });
  }
  renderTokenChart("7", days, [days[0], days[3], days[6]].map((day) => ({ x: day.x, label: day.label })));

  const current24 = recent.reduce((sum, hour) => sum + hour.value, 0);
  const weekTotal = days.reduce((sum, day) => sum + day.value, 0);
  elements.trend24Summary.textContent = recent.length ? `∑ ${formatToken(current24)}` : t("trend24Summary");
  elements.trend7Summary.textContent = `∑ ${formatToken(weekTotal)}`;
  elements.trendDelta.textContent = t("trendRange");
  elements.trendTotal.textContent = `24h ${formatToken(current24)} · 7d ${formatToken(weekTotal)}`;
  elements.trendAverage.textContent = t("sevenDayAverage", formatToken(Math.round(weekTotal / 7)));
}

function renderHeatmapWithData(daily) {
  const today = new Date();
  const days = [];
  for (let i = 41; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dayData = daily[key];
    days.push({ date: key, token: dayData?.total ?? null, d });
  }

  const tokenValues = days.map((item) => item.token).filter((v) => typeof v === "number");
  const maxToken = Math.max(1, ...tokenValues);

  const fragment = document.createDocumentFragment();
  days.forEach((day, index) => {
    const cell = document.createElement("span");
    cell.style.opacity = day.token == null ? "0.1" : String(0.2 + (Math.min(day.token, maxToken) / maxToken) * 0.8);
    cell.dataset.date = day.date;
    cell.dataset.day = String(day.d.getDate());
    cell.dataset.token = day.token == null ? "" : formatToken(day.token);
    cell.dataset.label = `${day.d.getMonth() + 1}/${day.d.getDate()}`;
    const valueLabel = day.token == null ? t("noData") : `${formatToken(day.token)} Token`;
    cell.setAttribute("role", "gridcell");
    cell.setAttribute("aria-label", t("heatCellAria", day.date, valueLabel));
    cell.tabIndex = index === days.length - 1 ? 0 : -1;
    fragment.append(cell);
  });
  elements.hitHeatmap.replaceChildren(fragment);

  const lastToken = tokenValues.at(-1);
  elements.hitTrendLabel.textContent = lastToken == null ? t("noData") : formatToken(lastToken);
  elements.heatDateStart.textContent = formatMonthDay(days[0].d);
  elements.heatDateEnd.textContent = formatMonthDay(days[days.length - 1].d);
}

function setupHeatmapTooltip() {
  const heatmap = elements.hitHeatmap;
  heatmap.addEventListener("pointerover", (event) => showHeatmapTooltip(event.target.closest("span")));
  heatmap.addEventListener("pointerout", (event) => {
    if (event.target.closest("span")) hideHeatmapTooltip();
  });
  heatmap.addEventListener("focusin", (event) => showHeatmapTooltip(event.target.closest("span")));
  heatmap.addEventListener("focusout", (event) => {
    if (!heatmap.contains(event.relatedTarget)) hideHeatmapTooltip();
  });
  heatmap.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const cells = [...heatmap.querySelectorAll("span")];
    const current = cells.indexOf(document.activeElement);
    const next = nextRovingIndex(current < 0 ? cells.length - 1 : current, cells.length, event.key, 6);
    if (next < 0) return;
    event.preventDefault();
    cells.forEach((cell, index) => { cell.tabIndex = index === next ? 0 : -1; });
    cells[next].focus({ preventScroll: true });
  });
}

function showHeatmapTooltip(cell) {
  if (!cell) return;
  const tip = elements.heatTooltip;
  const label = cell.dataset.label;
  const token = cell.dataset.token;
  tip.textContent = token ? `${label} · ${token}` : `${label} · ${t("noData")}`;
  const wrapRect = elements.hitHeatmap.parentElement.getBoundingClientRect();
  const cellRect = cell.getBoundingClientRect();
  tip.style.left = `${cellRect.left - wrapRect.left + cellRect.width / 2}px`;
  tip.style.bottom = `${wrapRect.bottom - cellRect.top + 6}px`;
  tip.classList.add("visible");
}

function hideHeatmapTooltip() {
  elements.heatTooltip.classList.remove("visible");
}
setupHeatmapTooltip();
setupTrendTooltips();

function shortError(error) {
  if (!error) {
    return "";
  }
  return String(error).replace(/^Error:\s*/, "").slice(0, 90);
}

function renderTokenChart(key, series, xTicks) {
  const plot = { left: 48, right: 408, top: 8, bottom: 88 };
  const maxValue = Math.max(1, ...series.map((item) => item.value));
  const points = series.map((item) => ({
    ...item,
    px: plot.left + item.x * (plot.right - plot.left),
    py: plot.bottom - (item.value / maxValue) * (plot.bottom - plot.top)
  }));
  const linePath = points.length
    ? points.map((point, index) => `${index ? "L" : "M"} ${point.px.toFixed(1)} ${point.py.toFixed(1)}`).join(" ")
    : "";
  const areaPath = points.length
    ? `${linePath} L ${points.at(-1).px.toFixed(1)} ${plot.bottom} L ${points[0].px.toFixed(1)} ${plot.bottom} Z`
    : "";

  document.getElementById(`trend${key}Line`).setAttribute("d", linePath);
  document.getElementById(`trend${key}Area`).setAttribute("d", areaPath);
  document.getElementById(`trend${key}Axes`).innerHTML = buildChartAxes(maxValue, xTicks, plot);
  chartSeries.set(key, { points, plot });
}

function buildChartAxes(maxValue, xTicks, plot) {
  const mid = maxValue / 2;
  const horizontal = [plot.top, (plot.top + plot.bottom) / 2, plot.bottom]
    .map((y) => `<path d="M${plot.left} ${y}H${plot.right}" />`)
    .join("");
  const yLabels = [
    { y: plot.top + 3, value: maxValue },
    { y: (plot.top + plot.bottom) / 2 + 3, value: mid },
    { y: plot.bottom + 3, value: 0 }
  ].map(({ y, value }) => `<text x="43" y="${y}" text-anchor="end">${formatToken(value)}</text>`).join("");
  const xLabels = xTicks.map((tick, index) => {
    const x = plot.left + tick.x * (plot.right - plot.left);
    const anchor = index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle";
    return `<text x="${x}" y="106" text-anchor="${anchor}">${tick.label}</text>`;
  }).join("");
  return `${horizontal}<path class="axis-line" d="M${plot.left} ${plot.top}V${plot.bottom}H${plot.right}" />${yLabels}${xLabels}`;
}

function setupTrendTooltips() {
  document.querySelectorAll(".chart-hit").forEach((hit) => {
    const key = hit.dataset.chart;
    hit.addEventListener("pointermove", (event) => scheduleChartTooltip(key, event));
    hit.addEventListener("pointerleave", () => hideChartTooltip(key));
  });
}

function scheduleChartTooltip(key, event) {
  pendingChartTooltip = { key, clientX: event.clientX, clientY: event.clientY };
  if (chartTooltipFrame) return;
  chartTooltipFrame = requestAnimationFrame(() => {
    chartTooltipFrame = null;
    const pending = pendingChartTooltip;
    pendingChartTooltip = null;
    if (pending) showChartTooltip(pending.key, pending);
  });
}

function showChartTooltip(key, event) {
  const state = chartSeries.get(key);
  if (!state?.points.length) return;
  const svg = document.getElementById(`trend${key}Chart`);
  const rect = svg.getBoundingClientRect();
  const svgX = ((event.clientX - rect.left) / rect.width) * 420;
  const point = state.points.reduce((closest, candidate) =>
    Math.abs(candidate.px - svgX) < Math.abs(closest.px - svgX) ? candidate : closest
  );
  const cursor = document.getElementById(`trend${key}Cursor`);
  const dot = document.getElementById(`trend${key}Point`);
  cursor.setAttribute("x1", point.px);
  cursor.setAttribute("x2", point.px);
  dot.setAttribute("cx", point.px);
  dot.setAttribute("cy", point.py);
  cursor.classList.add("visible");
  dot.classList.add("visible");

  const tooltip = document.getElementById(`trend${key}Tooltip`);
  const shell = tooltip.parentElement.getBoundingClientRect();
  tooltip.textContent = `${point.fullLabel} · ${formatToken(point.value)} Token`;
  tooltip.style.left = `${Math.max(72, Math.min(shell.width - 72, event.clientX - shell.left))}px`;
  tooltip.style.top = `${Math.max(4, event.clientY - shell.top - 34)}px`;
  tooltip.classList.add("visible");
}

function hideChartTooltip(key) {
  if (pendingChartTooltip?.key === key) pendingChartTooltip = null;
  if (chartTooltipFrame) {
    cancelAnimationFrame(chartTooltipFrame);
    chartTooltipFrame = null;
  }
  document.getElementById(`trend${key}Cursor`).classList.remove("visible");
  document.getElementById(`trend${key}Point`).classList.remove("visible");
  document.getElementById(`trend${key}Tooltip`).classList.remove("visible");
}

function setupRingLayers() {
  const layers = [
    [[elements.shortRingTrack, elements.shortRingArc], "short"],
    [[elements.longRingTrack, elements.longRingArc], "long"]
  ];
  for (const [targets, key] of layers) {
    for (const target of targets) target.addEventListener("pointerenter", () => setRingLayer(key));
    targets[1].addEventListener("focus", () => setRingLayer(key));
  }
  elements.quotaRing.addEventListener("pointerleave", () => setRingLayer(null));
  elements.quotaRing.addEventListener("focusout", (event) => {
    if (!elements.quotaRing.contains(event.relatedTarget)) setRingLayer(null);
  });
}

function setRingLayer(key) {
  elements.quotaRing.classList.toggle("ring-focus-short", key === "short");
  elements.quotaRing.classList.toggle("ring-focus-long", key === "long");
}

function activateWithKeyboard(event) {
  if (event.target !== event.currentTarget) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  if (isCompact && event.currentTarget === elements.quotaSide) {
    refresh({ manual: true });
    return;
  }
  toggleCardFocus(event.currentTarget.closest(".interactive-card"));
}

function setupExpandableCards() {
  document.querySelectorAll(".interactive-card[data-expand-title]:not(#resetRow)").forEach((card) => {
    card.setAttribute("aria-expanded", "false");
    card.addEventListener("click", (event) => {
      if (focusedCard === card) {
        event.stopPropagation();
        toggleCardFocus(card);
        return;
      }
      if (isCompact && card === elements.quotaSide) {
        event.stopPropagation();
        refresh({ manual: true });
        return;
      }
      if (event.target.closest("button, input, select, a, [role=button], .reset-row, .detail-target, .chart-shell, .hit-heatmap")) return;
      event.stopPropagation();
      toggleCardFocus(card);
    });
    card.addEventListener("keydown", activateWithKeyboard);
  });
}

function toggleCardFocus(card) {
  if (isCompact || !card) return;
  if (focusedCard === card) {
    clearCardFocus();
    return;
  }
  clearCardFocus();
  focusedCard = card;
  card.classList.add("is-focused");
  document.querySelector(".panel").classList.add("focus-mode");
  card.setAttribute("aria-expanded", "true");
}

function clearCardFocus() {
  if (!focusedCard) return;
  focusedCard.classList.remove("is-focused");
  focusedCard.setAttribute("aria-expanded", "false");
  document.querySelector(".panel").classList.remove("focus-mode");
  focusedCard = null;
}

function readHistory() {
  try {
    if (localStorage.getItem("quotaHistoryVersion") !== HISTORY_VERSION) {
      localStorage.setItem("quotaHistoryVersion", HISTORY_VERSION);
      localStorage.removeItem("quotaHistory");
      return [];
    }
    const value = JSON.parse(localStorage.getItem("quotaHistory") || "[]");
    return Array.isArray(value) ? value.slice(-288) : [];
  } catch {
    return [];
  }
}

function toneForPercent(percent) {
  if (percent == null) {
    return "gray";
  }
  if (percent < 20) {
    return "red";
  }
  if (percent < 50) {
    return "yellow";
  }
  return "green";
}

function hitSummary(hitRate) {
  if (hitRate >= 85) return t("hitSummaryExcellent");
  if (hitRate >= 60) return t("hitSummaryGood");
  if (hitRate >= 30) return t("hitSummaryMid");
  return t("hitSummaryLow");
}

function formatToken(value) {
  if (value == null || Number.isNaN(value)) {
    return "--";
  }
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return `${trimNumber(value / 1_000_000)}M`;
  }
  if (abs >= 1_000) {
    return `${trimNumber(value / 1_000)}K`;
  }
  return String(Math.round(value));
}

function trimNumber(value) {
  return value.toFixed(value >= 10 ? 1 : 2).replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1");
}

function clamp(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat(currentLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(timestamp);
}

function formatHourMinute(timestamp) {
  return new Intl.DateTimeFormat(currentLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(timestamp);
}

function formatDateTime(timestamp) {
  return new Intl.DateTimeFormat(currentLocale(), {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(timestamp);
}

function formatCompactDate(timestamp) {
  return new Intl.DateTimeFormat(currentLocale(), {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(timestamp);
}

function formatMonthDay(date) {
  return new Intl.DateTimeFormat(currentLocale(), { month: "numeric", day: "numeric" }).format(date);
}

function currentLocale() {
  return document.documentElement.lang === "en" ? "en-US" : "zh-CN";
}

function generateAndSaveTrayIcon() {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext("2d");
    
    const grad = ctx.createLinearGradient(0, 0, 16, 16);
    grad.addColorStop(0, "#6757e7");
    grad.addColorStop(1, "#53c987");
    
    ctx.fillStyle = grad;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(0, 0, 16, 16, 4.5);
    } else {
      ctx.rect(0, 0, 16, 16);
    }
    ctx.fill();
    
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(8, 8, 2.2, 0, Math.PI * 2);
    ctx.fill();
    
    const iconDataUrl = canvas.toDataURL("image/png");
    window.aiQuota.saveTrayIcon(iconDataUrl);
  } catch (e) {
    console.error("Failed to generate tray icon:", e);
  }
}
