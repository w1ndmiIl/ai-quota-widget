"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {DatabaseSync}=require("node:sqlite");
const {readLocalTokenUsage,readTokenHistory}=require("../src/antigravity-token-service");
const {estimateTokenCost}=require("../src/renderer/token-pricing");
const {mergeTokenItems}=require("../src/renderer/model-usage");
const at=Date.parse("2026-10-01T02:00:00Z");
function varint(value){let n=BigInt(value);const bytes=[];do{const b=Number(n&127n);n>>=7n;bytes.push(b|(n?128:0));}while(n);return Buffer.from(bytes);}
function number(field,value){return Buffer.concat([varint(field*8),varint(value)]);}
function data(field,value){const bytes=typeof value==="string"?Buffer.from(value):value;return Buffer.concat([varint(field*8+2),varint(bytes.length),bytes]);}
function generation(id,model="gemini-3.8-flash",step=0){return Buffer.concat([
  data(1,Buffer.concat([data(4,Buffer.concat([number(1,1318),number(2,100),number(3,10),number(4,5),number(5,20),number(9,4),number(10,6),data(11,id)])),data(19,model)])),
  data(2,varint(step)),data(4,"generation-"+id)
]);}
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"ai-bar-native-")),root=path.join(dir,"brain"),conversations=path.join(dir,"conversations"),file=path.join(conversations,"one.db");
  fs.mkdirSync(root);fs.mkdirSync(conversations);
  const previous=process.env.HISTORY_ACCUMULATOR_PATH;process.env.HISTORY_ACCUMULATOR_PATH=path.join(dir,"ledger.json");
  t.after(()=>{if(previous===undefined)delete process.env.HISTORY_ACCUMULATOR_PATH;else process.env.HISTORY_ACCUMULATOR_PATH=previous;fs.rmSync(dir,{recursive:true,force:true});});
  const db=new DatabaseSync(file);db.exec("PRAGMA journal_mode=WAL; CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB); CREATE TABLE steps(idx INTEGER PRIMARY KEY,metadata BLOB)");
  db.prepare("INSERT INTO steps VALUES(0,?)").run(data(1,Buffer.concat([number(1,at/1000),number(2,123000000)])));
  db.prepare("INSERT INTO gen_metadata VALUES(0,?)").run(generation("request-1"));
  const options={root,now:at+1000,catalogDays:null};
  return {dir,root,file,db,options,close(){db.close();}};
}
test("reads actual SQLite counts, cache components and step timestamps without double-billing thinking",t=>{
  const f=fixture(t);try{
    f.db.prepare("INSERT INTO gen_metadata VALUES(1,?)").run(generation("request-1"));
    f.db.prepare("INSERT INTO gen_metadata VALUES(2,?)").run(generation("claude-request","claude-opus-5-5"));
    const usage=readLocalTokenUsage(f.options);
    assert.equal(usage.usageAccuracy,"native");assert.equal(usage.total,135);assert.equal(usage.input,125);assert.equal(usage.output,10);assert.equal(usage.reasoning,4);
    assert.equal(usage.cached,20);assert.equal(usage.cacheWrite,5);assert.equal(usage.modelUsage.length,1);assert.equal(usage.readError,null);
    assert.ok(Math.abs(estimateTokenCost(usage).usd-0.00011775)<1e-12);
    const report=readTokenHistory(f.options);
    assert.equal(Object.values(report.daily)[0].total,135);
    assert.equal(report.hourly.find(hour=>hour.total).t,Math.floor(at/3600000)*3600000);
    assert.equal(mergeTokenItems(usage.modelUsage,"antigravity").cacheHitRate,16);
  }finally{f.close();}
});
test("detects committed WAL-only changes and preserves native records after database removal",t=>{
  const f=fixture(t);let closed=false;try{
    assert.equal(readLocalTokenUsage(f.options).total,135);
    const stat=fs.statSync(f.file);
    f.db.prepare("INSERT INTO gen_metadata VALUES(1,?)").run(generation("request-2"));
    assert.equal(fs.statSync(f.file).mtimeMs,stat.mtimeMs,"The main database must stay unchanged for this regression");
    assert.equal(readLocalTokenUsage(f.options).total,270);
    f.close();closed=true;fs.unlinkSync(f.file);
    assert.equal(readLocalTokenUsage(f.options).total,270);
  }finally{if(!closed)f.close();}
});
test("native sessions replace legacy estimates; unmatched settled history survives without scanning text",t=>{
  const f=fixture(t);try{
    const legacy=sessionId=>({t:at,sessionId,model:"Gemini 3.8 Flash",input:100,output:10,reasoning:5,total:115,cached:null});
    readLocalTokenUsage(f.options);
    const ledger=JSON.parse(fs.readFileSync(process.env.HISTORY_ACCUMULATOR_PATH,"utf8"));
    ledger.namespaces.antigravity={files:{removed:{mtimeMs:0,size:0,data:[legacy("one"),legacy("old-session")]}},lastSweepAt:0};
    fs.writeFileSync(process.env.HISTORY_ACCUMULATOR_PATH,JSON.stringify(ledger));
    const usage=readLocalTokenUsage(f.options);
    assert.equal(usage.total,250);assert.equal(usage.usageAccuracy,"mixed");
    assert.equal(usage.modelUsage.filter(model=>model.usageAccuracy==="native")[0].total,135);
    assert.equal(usage.output,25,"Legacy thinking joins output once");
  }finally{f.close();}
});
test("malformed native metadata preserves the last valid settled counts and reports the failure",t=>{
  const f=fixture(t);const prior=console.error;try{
    assert.equal(readLocalTokenUsage(f.options).total,135);console.error=()=>{};
    f.db.prepare("UPDATE gen_metadata SET data=? WHERE idx=0").run(Buffer.from([10,99]));
    const usage=readLocalTokenUsage(f.options);
    assert.equal(usage.total,135);assert.match(usage.readError,/native databases could not be read/);
  }finally{console.error=prior;f.close();}
});
