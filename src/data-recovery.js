"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { writeJson } = require("./atomic-json");

function mergeLedgers(ledgers) {
  const merged = { version: 4, namespaces: {} };
  for (const ledger of ledgers) {
    if (ledger?.version !== 4 || !ledger.namespaces) throw new Error("Unsupported history ledger; original preserved");
    for (const [namespace, state] of Object.entries(ledger.namespaces)) {
      const target = merged.namespaces[namespace] ||= { files: {}, lastSweepAt: 0 };
      for (const [file, item] of Object.entries(state.files || {})) {
        if (!item || item.data == null) continue;
        const previous = target.files[file];
        if (namespace === "antigravity" && Array.isArray(previous?.data) && Array.isArray(item.data)) {
          const newer = Number(item.mtimeMs || 0) >= Number(previous.mtimeMs || 0) ? item : previous;
          const older = newer === item ? previous : item;
          const key = (event) => JSON.stringify([event.sessionId,event.t,event.model,event.output,event.reasoning]);
          const known = new Set(newer.data.map(key));
          const recovered = new Map([...(previous.recoveredEvents || []), ...(item.recoveredEvents || []), ...older.data.filter((event) => /gemini/i.test(event.model || "") && !known.has(key(event)))].map((event) => [key(event),event]));
          const extras = [...recovered.values()];
          target.files[file] = { ...newer, recoveredEvents: extras, data: [...newer.data,...extras.filter((event) => !known.has(key(event)))].sort((a,b)=>a.t-b.t) };
        } else if (!previous || Number(item.mtimeMs || 0) >= Number(previous.mtimeMs || 0)) target.files[file] = item;
      }
    }
  }
  return merged;
}

function readLedgers(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((file) => /^history_accumulator(?:\.[a-z0-9_-]+)?\.json$/i.test(file))
    .map((file) => JSON.parse(fs.readFileSync(path.join(directory,file),"utf8")));
}

function saveRecoveredLedger(directory, ledger) {
  writeJson(path.join(directory,"history_accumulator.json"),ledger);
  for (const [namespace,state] of Object.entries(ledger.namespaces)) {
    writeJson(path.join(directory,`history_accumulator.${namespace.replace(/[^a-z0-9-]/gi,"_")}.json`),{version:4,namespaces:{[namespace]:state}});
  }
}

module.exports = { mergeLedgers, readLedgers, saveRecoveredLedger };
