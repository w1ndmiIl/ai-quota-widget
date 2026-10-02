"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveRange } = require("../src/usage-report");
const { visibleBounds, chooseDataDirectory } = require("../src/desktop-preferences");
const { readAppendedEvents } = require("../src/append-jsonl");
const { readOpenCodeTokenUsage } = require("../src/opencode-token-service");
const { scanFilesIncrementally, CACHE_VERSION } = require("../src/incremental-scan-engine");
const { summarizeUsageEvents, historyFromUsageEvents } = require("../src/usage-event-summary");
const TokenPricing = require("../src/renderer/token-pricing");
function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bar-improvement-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory;
}
function env(t, key, value) { const old = process.env[key]; process.env[key] = value; t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; }); }
test("invalid successful OpenCode exports preserve the last valid settled events", async (t) => {
  env(t, "AI_QUOTA_USER_DATA_PATH", temp(t)); const now = Date.now(); let invalid = false;
  const runner = async (_binary, args) => args[0] === "session" ? { ok: true, stdout: JSON.stringify([{ id: "one", updated: now+(invalid ? 1000 : 0) }]) }
    : { ok: true, stdout: invalid ? "not json" : JSON.stringify({ messages: [{ info: { role: "assistant", modelID: "gpt-5", time: { created: now }, tokens: { input: 10, output: 2 } } }] }) };
  assert.equal((await readOpenCodeTokenUsage({ runner, binary: "fake", refreshTtl: 0 })).total, 12);
  invalid = true;
  const result = await readOpenCodeTokenUsage({ runner, binary: "fake", refreshTtl: 0 });
  assert.equal(result.total, 12); assert.match(result.readError, /Invalid/);
});
test("custom calendar ranges include the full end day and reject reversed dates", () => {
  const now = new Date(2026, 8, 12, 12).getTime();
  const range = resolveRange({ preset: "custom", start: "2026-09-01", end: "2026-09-03" }, now);
  assert.equal(range.start, new Date(2026,8,1).getTime());
  assert.equal(range.end, new Date(2026,8,4).getTime()-1);
  assert.throws(() => resolveRange({ preset:"custom", start:"2026-09-03",end:"2026-09-01" },now));
  assert.notEqual(resolveRange({preset:"today"},now).start,resolveRange({preset:"24h"},now).start);
});
test("historical ranges exclude later events in totals and charts", () => {
  const now = new Date(2026,8,3).getTime();
  const events = [{ t: now-1000, input:10, output:2,total:12,model:"one" }, {t:now+1000,input:20,output:2,total:22,model:"one"}];
  const usage = summarizeUsageEvents(events,{now,days:1,source:"test"});
  const history = historyFromUsageEvents(events,{now,days:1});
  assert.equal(usage.total,12); assert.equal(Object.values(history.daily).reduce((sum,item)=>sum+item.total,0),12);
});
test("append parsing avoids reparsing old records while handling partial tails and rewrites", (t) => {
  const file = path.join(temp(t),"events.jsonl"); let parsed = 0;
  const parser = (row) => { parsed++; return row; };
  fs.writeFileSync(file,'{"total":1}\n'); assert.equal(readAppendedEvents(file,parser).length,1);
  fs.appendFileSync(file,'{"total":2'); assert.equal(readAppendedEvents(file,parser).length,1); assert.equal(parsed,1);
  fs.appendFileSync(file,'}\n'); assert.equal(readAppendedEvents(file,parser).length,2); assert.equal(parsed,2);
  fs.writeFileSync(file,'{"total":9}\n{"total":2}\n'); assert.equal(readAppendedEvents(file,parser)[0].total,9); assert.equal(parsed,4);
});
test("partitioned ledgers migrate retained legacy records without deleting the original", (t) => {
  const directory=temp(t), file=path.join(directory,"ledger.json"), missing=path.join(directory,"removed.json");
  const legacy={version:CACHE_VERSION,namespaces:{gemini:{files:{[missing]:{mtimeMs:1,size:1,data:[{total:12}]}},lastSweepAt:0}}};
  fs.writeFileSync(file,JSON.stringify(legacy)); env(t,"HISTORY_ACCUMULATOR_PATH",file);env(t,"AI_QUOTA_PARTITION_LEDGER","1");
  const values=scanFilesIncrementally([],()=>[],{namespace:"gemini",retainDeleted:true});
  assert.equal(values[missing][0].total,12);assert.ok(fs.existsSync(path.join(directory,"ledger.gemini.json")));assert.deepEqual(JSON.parse(fs.readFileSync(file)),legacy);
});
test("window restoration clamps removed-monitor positions and oversized zoom", () => {
  const result=visibleBounds({x:4000,y:-1000},[{workArea:{x:0,y:0,width:800,height:600}}],1170,858);
  assert.deepEqual(result,{x:0,y:0,width:800,height:600});
});
test("data storage falls back when the portable location is not a writable directory", (t) => {
  const directory=temp(t),portable=path.join(directory,"blocked"),fallback=path.join(directory,"fallback");fs.writeFileSync(portable,"file");
  assert.deepEqual(chooseDataDirectory(portable,fallback),{directory:fallback,fallback:true});
});
test("unified report keeps totals, models and daily history in the same selected range", async (t) => {
  const directory=temp(t);env(t,process.platform==="win32"?"USERPROFILE":"HOME",directory);env(t,"HISTORY_ACCUMULATOR_PATH",path.join(directory,"ledger.json"));
  const projects=path.join(directory,".claude","projects");fs.mkdirSync(projects,{recursive:true});
  const dates=["2026-08-31","2026-09-01","2026-09-02","2026-09-03","2026-09-10"];
  fs.writeFileSync(path.join(projects,"session.jsonl"),dates.map((date,index)=>JSON.stringify({type:"assistant",timestamp:date+"T12:00:00",message:{id:String(index),model:"custom-model",usage:{input_tokens:10,output_tokens:2}}})).join("\n"));
  const {execute}=require("../src/usage-worker");
  const result=await execute("report",{now:new Date(2026,8,12).getTime(),range:{preset:"custom",start:"2026-09-01",end:"2026-09-03"},sources:["claude"],enableAntigravity:false});
  assert.equal(result.models[0].total,36);
  assert.equal(result.catalog[0].total,60,"Historical model catalog must also include usage after the selected end date");
  assert.equal(Object.values(result.history.daily).reduce((sum,item)=>sum+item.total,0),36);
  const disabled=await execute("report",{range:{preset:"24h"},sources:[],selection:"source:claude",enableAntigravity:false});
  assert.equal(disabled.models.length,0);assert.deepEqual(disabled.history.daily,{});
});
test("daily chart fills missing dates and bounds all-history rendering by month", () => {
  const {series}=require("../src/renderer/report-view");
  const values=series({range:{start:new Date(2026,8,1).getTime(),end:new Date(2026,8,3,23).getTime(),days:3},history:{daily:{"2026-09-01":{total:10},"2026-09-03":{total:20}}}});
  assert.deepEqual(values.map(item=>item.value),[10,0,20]);assert.equal(values[1].x,0.5);
});
