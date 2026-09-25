"use strict";
const fs = require("node:fs");
const path = require("node:path");
function chooseDataDirectory(portable, fallback) {
  for (const directory of [portable, fallback]) {
    try {
      fs.mkdirSync(directory, { recursive: true });
      const probe = path.join(directory, `.write-test-${process.pid}`);
      fs.writeFileSync(probe, ""); fs.unlinkSync(probe);
      if (directory !== portable) {
        try {
          for (const name of fs.readdirSync(portable)) {
            if (!/^(?:config|dashboard_snapshot|codex_quota_cache|opencode_usage_cache|notification-state|history_accumulator(?:\.[a-z0-9_-]+)?)\.json$/i.test(name)) continue;
            const target = path.join(directory,name);
            if (!fs.existsSync(target)) fs.copyFileSync(path.join(portable,name),target);
          }
        } catch {}
      }
      return { directory, fallback: directory !== portable };
    } catch {}
  }
  throw new Error("No writable data directory. Choose a writable installation folder.");
}
function visibleBounds(saved, displays, width, height) {
  const areas = displays.map((display) => display.workArea);
  const area = areas.find((area) => saved && saved.x < area.x + area.width && saved.x + width > area.x && saved.y < area.y + area.height && saved.y + height > area.y) || areas[0];
  width = Math.min(width, area.width); height = Math.min(height, area.height);
  return { width, height, x: Math.round(Math.max(area.x, Math.min(Number.isFinite(saved?.x) ? saved.x : area.x + (area.width-width)/2, area.x + area.width-width))),
    y: Math.round(Math.max(area.y, Math.min(Number.isFinite(saved?.y) ? saved.y : area.y + (area.height-height)/2, area.y + area.height-height))) };
}
function quotaNotices(snapshot, preferences, state, now = Date.now()) {
  if (!preferences?.enabled) return [];
  const hour = new Date(now).getHours();
  const start = Number(preferences.quietStart ?? 22), end = Number(preferences.quietEnd ?? 8);
  const quiet = preferences.quiet && (start < end ? hour >= start && hour < end : hour >= start || hour < end);
  const messages = [];
  for (const [source, quota] of [["Codex", snapshot.quota], ["Antigravity", snapshot.antigravityQuota]]) {
    for (const [window, value] of [["5h", quota?.shortWindow], ["weekly", quota?.longWindow]]) {
      const remaining = value?.remainingPercent;
      if (!Number.isFinite(remaining)) continue;
      const key = `${source}:${window}`;
      const previous = state[key];
      const low = remaining <= (preferences.threshold ?? 10);
      const kind = low && !previous?.notifiedLow ? "low" : previous?.low && previous.notifiedLow && !low ? "recovered" : null;
      state[key] = { low, remaining, notifiedLow: low && (previous?.notifiedLow || Boolean(kind && !quiet)) };
      if (kind && !quiet) messages.push({ source, window, kind, remaining });
    }
  }
  return messages;
}
module.exports = { chooseDataDirectory, visibleBounds, quotaNotices };
