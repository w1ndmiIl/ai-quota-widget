"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveRange, serializeReport } = require("../src/usage-report");
const { visibleBounds, chooseDataDirectory, quotaNotices } = require("../src/desktop-preferences");
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
test("CSV exports quote model identifiers and neutralize spreadsheet formulas", () => {
  const report = {range:{start:0,end:1000},models:[{source:"test",model:'=SUM(1,2)',total:12}]};
  const csv = serializeReport(report,"csv"); assert.ok(csv.includes('"\'=SUM(1,2)"')); assert.deepEqual(JSON.parse(serializeReport(report,"json")),report);
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
test("quota notifications deduplicate low warnings, report recovery, and honor quiet hours", () => {
  const state={},settings={enabled:true,threshold:10};const snapshot=(remaining)=>({quota:{shortWindow:{remainingPercent:remaining}}});
  assert.equal(quotaNotices(snapshot(8),settings,state).length,1);assert.equal(quotaNotices(snapshot(7),settings,state).length,0);
  assert.equal(quotaNotices(snapshot(90),settings,state)[0].kind,"recovered");
  assert.equal(quotaNotices(snapshot(8),{...settings,quiet:true},state,new Date(2026,8,12,23).getTime()).length,0);
});
test("custom prices apply all token components without modifying input usage", () => {
  const usage={input:100,cached:20,cacheWrite:10,output:5};
  const price=TokenPricing.estimateUsageCost(usage,"custom-model",undefined,{input:1,cached:0.5,cacheWrite:2,output:3});
  assert.equal(price.usd,0.000115);assert.equal(usage.input,100);
});
test("unified report keeps totals, models and daily history in the same selected range", async (t) => {
  const directory=temp(t);env(t,process.platform==="win32"?"USERPROFILE":"HOME",directory);env(t,"HISTORY_ACCUMULATOR_PATH",path.join(directory,"ledger.json"));
  const projects=path.join(directory,".claude","projects");fs.mkdirSync(projects,{recursive:true});
  const dates=["2026-08-31","2026-09-01","2026-09-02","2026-09-03","2026-09-10"];
  fs.writeFileSync(path.join(projects,"session.jsonl"),dates.map((date,index)=>JSON.stringify({type:"assistant",timestamp:date+"T12:00:00",message:{id:String(index),model:"custom-model",usage:{input_tokens:10,output_tokens:2}}})).join("\n"));
  const {execute}=require("../src/usage-worker");
  const result=await execute("report",{now:new Date(2026,8,12).getTime(),range:{preset:"custom",start:"2026-09-01",end:"2026-09-03"},sources:["claude"],enableAntigravity:false,priceOverrides:{"custom-model":{input:1,cached:0,cacheWrite:0,output:2}}});
  assert.equal(result.models[0].total,36);assert.equal(result.models[0].customPrice,true);
  assert.equal(result.catalog[0].total,48,"Historical model catalog must not be limited to the selected range");
  assert.equal(Object.values(result.history.daily).reduce((sum,item)=>sum+item.total,0),36);
  const disabled=await execute("report",{range:{preset:"24h"},sources:[],selection:"source:claude",enableAntigravity:false});
  assert.equal(disabled.models.length,0);assert.deepEqual(disabled.history.daily,{});
});
test("daily chart fills missing dates and bounds all-history rendering by month", () => {
  const {series}=require("../src/renderer/report-view");
  const values=series({range:{start:new Date(2026,8,1).getTime(),end:new Date(2026,8,3,23).getTime(),days:3},history:{daily:{"2026-09-01":{total:10},"2026-09-03":{total:20}}}});
  assert.deepEqual(values.map(item=>item.value),[10,0,20]);assert.equal(values[1].x,0.5);
});
