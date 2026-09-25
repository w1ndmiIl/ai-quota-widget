"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { mergeLedgers, saveRecoveredLedger } = require("../src/data-recovery");
const { scanFilesIncrementally } = require("../src/incremental-scan-engine");
const event = (t,total) => ({ t, total, input:total, output:0, reasoning:0, sessionId:"session", model:"Gemini 3.5 Flash (High)" });
test("recovery preserves missing settled events and is idempotent", () => {
  const old = { version:4, namespaces:{antigravity:{files:{file:{mtimeMs:1,size:1,data:[event(1,10),event(2,20)]}}}} };
  const current = { version:4, namespaces:{antigravity:{files:{file:{mtimeMs:2,size:2,data:[event(2,20),event(3,30)]}}}} };
  const merged = mergeLedgers([old,current]);
  assert.equal(merged.namespaces.antigravity.files.file.data.reduce((sum,item)=>sum+item.total,0),60);
  assert.equal(merged.namespaces.antigravity.files.file.recoveredEvents.length,1);
  assert.deepEqual(mergeLedgers([merged,old,current]),merged);
});
test("rescanning a changed transcript retains recovered history exactly once", (t) => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"ai-bar-recovery-"));
  const file=path.join(directory,"session.jsonl");fs.writeFileSync(file,"changed");
  const ledger={version:4,namespaces:{antigravity:{files:{[file]:{mtimeMs:1,size:1,data:[event(1,10)],recoveredEvents:[event(1,10)]}}}}};
  saveRecoveredLedger(directory,ledger);
  const previous=process.env.HISTORY_ACCUMULATOR_PATH;
  process.env.HISTORY_ACCUMULATOR_PATH=path.join(directory,"history_accumulator.json");
  t.after(()=>{if(previous===undefined)delete process.env.HISTORY_ACCUMULATOR_PATH;else process.env.HISTORY_ACCUMULATOR_PATH=previous;fs.rmSync(directory,{recursive:true,force:true});});
  const read=()=>scanFilesIncrementally([file],()=>[event(2,20)],{namespace:"antigravity",retainDeleted:true});
  assert.equal(read()[file].reduce((sum,item)=>sum+item.total,0),30);
  assert.equal(read()[file].length,2);
});
