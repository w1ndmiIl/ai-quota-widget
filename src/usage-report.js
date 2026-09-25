"use strict";
const DAY = 86400000;
function resolveRange(range = {}, now = Date.now()) {
  const preset = range.preset || "24h";
  let end = now, start;
  if (preset === "custom") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(range.start || "") || !/^\d{4}-\d{2}-\d{2}$/.test(range.end || "")) throw new Error("Invalid dates");
    start = new Date(`${range.start}T00:00:00`).getTime();
    const last = new Date(`${range.end}T00:00:00`); last.setDate(last.getDate() + 1);
    const validDate = (text) => { const date = new Date(`${text}T00:00:00`); return Number.isFinite(date.getTime()) && `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}` === text; };
    if (!validDate(range.start) || !validDate(range.end)) throw new Error("Invalid dates");
    end = Math.min(now, last.getTime() - 1);
  } else if (preset === "today") start = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();
  else if (preset === "all") start = 0;
  else if (["24h", "7d", "30d"].includes(preset)) start = now - ({ "24h": 1, "7d": 7, "30d": 30 }[preset] * DAY);
  else throw new Error("Invalid date range");
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error("Invalid date range");
  return { preset, start, end, days: Math.max(1, end - start) / DAY };
}
function serializeReport(report, format) {
  if (format === "json") return JSON.stringify(report, null, 2);
  if (format !== "csv") throw new Error("Unsupported export format");
  const escape = (value) => {
    let text = String(value ?? "");
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const columns = ["rangeStart", "rangeEnd", "source", "model", "input", "cached", "cacheWrite", "output", "reasoning", "total", "estimatedUsd"];
  return "\uFEFF" + [columns.join(","), ...(report.models || []).map((model) => columns.map((key) => escape(key === "rangeStart" ? new Date(report.range.start).toISOString() : key === "rangeEnd" ? new Date(report.range.end).toISOString() : model[key])).join(","))].join("\r\n");
}
module.exports = { resolveRange, serializeReport };
