"use strict";
(function (root) {
  const labels = {
    zh: { range: "统计范围", "24h": "滚动 24 小时", today: "今天", "7d": "近 7 天", "30d": "近 30 天", all: "全部历史", custom: "自定义", start: "开始日期", end: "结束日期", apply: "应用", back: "返回", invalid: "请选择有效的起止日期", error: "暂未更新，仍显示已有数据" },
    en: { range: "Date range", "24h": "Last 24 hours", today: "Today", "7d": "Last 7 days", "30d": "Last 30 days", all: "All history", custom: "Custom", start: "Start date", end: "End date", apply: "Apply", back: "Back", invalid: "Choose valid start and end dates", error: "Keeping previously loaded data" }
  };
  function create({ onReport, selection, isPaused }) {
    if (!root.aiQuota.readReport) return null;
    const text = (key) => labels[document.documentElement.lang === "en" ? "en" : "zh"][key] || key;
    let range = { preset: localStorage.getItem("tokenRange") === "cumulative" ? "all" : "24h" };
    try { const stored = JSON.parse(localStorage.getItem("dashboardRange")); if (stored && ["24h","today","7d","30d","all","custom"].includes(stored.preset)) range = stored; } catch {}
    let report = null, pending = null, queued = false, queuedForce = false, generation = 0, lastAt = 0, lastKey = "", sourceKey = "";
    const picker = document.getElementById("tokenRangeToggle");
    picker.className = "token-range-toggle range-picker";
    picker.replaceChildren();
    const trigger = document.createElement("button"); trigger.type = "button"; trigger.id = "rangePickerTrigger"; trigger.className = "range-picker-trigger";
    trigger.setAttribute("aria-haspopup", "listbox"); trigger.setAttribute("aria-controls", "rangeOptions"); trigger.setAttribute("aria-expanded", "false");
    const menu = document.createElement("div"); menu.className = "model-picker-menu range-picker-menu"; menu.hidden = true;
    const options = document.createElement("div"); options.id = "rangeOptions"; options.setAttribute("role", "listbox");
    const form = document.createElement("form"); form.className = "range-custom"; form.hidden = true;
    const fields = {};
    for (const key of ["start", "end"]) {
      const label = document.createElement("label"); const caption = document.createElement("span"); caption.dataset.word = key;
      const input = document.createElement("input"); input.type = "date"; input.id = key === "start" ? "rangeStart" : "rangeEnd"; input.required = true; input.value = range[key] || "";
      label.append(caption, input); form.append(label); fields[key] = input;
    }
    const error = document.createElement("span"); error.className = "range-error"; error.setAttribute("role", "status");
    const actions = document.createElement("div"); actions.className = "range-actions";
    const back = document.createElement("button"); back.type = "button"; back.dataset.word = "back";
    const apply = document.createElement("button"); apply.type = "submit"; apply.id = "rangeApply"; apply.dataset.word = "apply";
    actions.append(back, apply); form.append(error, actions); menu.append(options, form); picker.append(trigger, menu);
    function close(restoreFocus = false) { picker.classList.remove("open"); menu.hidden = true; trigger.setAttribute("aria-expanded", "false"); document.getElementById("totalTokenCard").classList.remove("range-open"); if (restoreFocus) trigger.focus(); }
    function open() { menu.hidden = false; options.hidden = false; form.hidden = true; picker.classList.add("open"); document.getElementById("totalTokenCard").classList.add("range-open"); trigger.setAttribute("aria-expanded", "true"); }
    function choose(next) { range = next; localStorage.setItem("dashboardRange", JSON.stringify(range)); generation++; lastAt = 0; updateLanguage(); close(true); refresh(); }
    for (const key of ["24h","today","7d","30d","all","custom"]) {
      const option = document.createElement("button"); option.type = "button"; option.className = "model-picker-option range-option"; option.dataset.range = key; option.setAttribute("role", "option");
      option.onclick = (event) => { event.stopPropagation(); if (key === "custom") { options.hidden = true; form.hidden = false; error.textContent = ""; fields.start.focus(); } else choose({ preset: key }); };
      options.append(option);
    }
    trigger.onclick = (event) => { event.stopPropagation(); menu.hidden ? open() : close(); };
    // Keep clicks on the popup (including padding and custom-date labels)
    // inside the control rather than activating its expandable parent card.
    picker.addEventListener("click", (event) => event.stopPropagation());
    picker.addEventListener("pointerdown", (event) => {
      if (!event.target.closest("button, input, select, textarea, label")) event.preventDefault();
    });
    trigger.onkeydown = (event) => { if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); open(); const list = [...options.children]; (list.find((item) => item.dataset.range === range.preset) || list[0]).focus(); } };
    menu.onkeydown = (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
      if (form.hidden && ["Enter", " "].includes(event.key)) {
        const option = event.target.closest(".range-option");
        if (option) { event.preventDefault(); event.stopPropagation(); option.click(); }
        return;
      }
      if (!form.hidden || !["ArrowDown","ArrowUp","Home","End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); const list = [...options.children]; const index = list.indexOf(document.activeElement);
      list[event.key === "Home" ? 0 : event.key === "End" ? list.length-1 : (index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length].focus();
    };
    picker.addEventListener("focusout", (event) => {
      if (event.relatedTarget && picker.contains(event.relatedTarget)) return;
      // Native focus transitions may temporarily expose BODY as activeElement.
      // Wait until focus has settled before deciding this was an outside click.
      setTimeout(() => { if (!picker.contains(document.activeElement)) close(); }, 0);
    });
    document.addEventListener("pointerdown", (event) => { if (!picker.contains(event.target)) close(); });
    back.onclick = () => { options.hidden = false; form.hidden = true; options.lastElementChild.focus(); };
    form.onsubmit = (event) => { event.preventDefault(); if (!fields.start.value || !fields.end.value || fields.start.value > fields.end.value || new Date(fields.start.value + "T00:00:00").getTime() > Date.now()) { error.textContent = text("invalid"); return; } choose({ preset: "custom", start: fields.start.value, end: fields.end.value }); };
    function updateLanguage() {
      trigger.textContent = text("range") + " · " + (range.preset === "24h" ? "24h" : text(range.preset));
      trigger.title = text("range") + ": " + text(range.preset); trigger.setAttribute("aria-label", trigger.title); options.setAttribute("aria-label", text("range"));
      for (const option of options.children) { option.textContent = text(option.dataset.range); option.classList.toggle("selected", option.dataset.range === range.preset); option.setAttribute("aria-selected", String(option.dataset.range === range.preset)); }
      for (const element of form.querySelectorAll("[data-word]")) element.textContent = text(element.dataset.word);
      if (report && !isPaused()) onReport(report, text(range.preset));
    }
    async function refresh({ force = false } = {}) {
      if (isPaused()) return;
      const key = JSON.stringify([range, selection()]);
      if (!force && key === lastKey && Date.now()-lastAt < 60000) return report;
      if (pending) { queued = true; queuedForce ||= force; if (force) generation++; return pending; }
      const version = generation, requestedSelection = selection(), requestedRange = { ...range };
      trigger.setAttribute("aria-busy", "true");
      pending = root.aiQuota.readReport({ range: requestedRange, selection: requestedSelection, force }).then((value) => {
        if (version !== generation || requestedSelection !== selection() || JSON.stringify(requestedRange) !== JSON.stringify(range)) { queued = true; return; }
        report = value; lastAt = Date.now(); lastKey = key;
        trigger.title = text("range") + ": " + text(range.preset) + (range.preset === "custom" ? " (" + range.start + " – " + range.end + ")" : "");
        if (!isPaused()) onReport(value, text(range.preset));
        if (value.partial) { lastAt = 0; setTimeout(() => refresh(), 3000); }
        return value;
      }).catch(() => { trigger.title = text("error"); }).finally(() => { pending = null; trigger.removeAttribute("aria-busy"); if (queued) { const nextForce = queuedForce; queued = queuedForce = false; lastAt = 0; refresh({ force: nextForce }); } });
      return pending;
    }
    updateLanguage();
    return { active: true, text, refresh, updateLanguage, invalidate: () => { generation++; lastAt = 0; }, updateSnapshot(snapshot) {
      const next = JSON.stringify(["enableCodex","enableClaudeCode","enableOpenCode","enableGeminiCli","enableCline","enableAntigravity"].map((key) => snapshot?.config?.[key]));
      if (sourceKey !== next) { sourceKey = next; generation++; lastAt = 0; }
    } };
  }
  root.DashboardControls = { create };
})(window);
