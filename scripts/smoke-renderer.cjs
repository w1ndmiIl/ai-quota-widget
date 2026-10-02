"use strict";
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const project = path.resolve(__dirname, "..");
const source = process.env.AI_BAR_SMOKE_APP_DIR || project;
const output = path.join(project, ".cache"); fs.mkdirSync(output, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(output, "ui-smoke-")));
process.env.AI_QUOTA_USER_DATA_PATH = app.getPath("userData");
app.disableHardwareAcceleration();
const config = { enableCodex: true, enableClaudeCode: true, enableOpenCode: false, enableGeminiCli: false, enableCline: false, enableAntigravity: true };
const counts = { reports: 0 };
let total = 12;
const model = () => ({ model: "claude-sonnet-4-6", source: "claude", input: total-2, output: 2, cached: 0, total });
const snapshot = () => ({ config, quota: { shortWindow: { remainingPercent: 80, usedPercent: 20, resetsAt: Date.now()+3600000 }, longWindow: { remainingPercent: 60, usedPercent: 40, resetsAt: Date.now()+86400000 } }, localTokenUsage: { total, modelUsage: [model()] }, updatedAt: Date.now() });
const { resolveRange } = require("../src/usage-report");
let latestOptions;
function report(options) {
  latestOptions = options; const range = resolveRange(options.range);
  const date = new Date(range.end);const key = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  const currentHour = Math.floor(range.end / 3600000) * 3600000;
  const hourly = Array.from({length:25},(_,index)=>({t:currentHour-(24-index)*3600000,total:index===20?Math.round(total*0.8):index===24?total-Math.round(total*0.8):0}));
  return { range, models:[model()],catalog:[model()],history:{ daily:{[key]:{total}},hourly } };
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  let win;
  try {
    // Check the SQLite dependency in Electron using isolated test data.
    const { DatabaseSync } = require("node:sqlite");
    const root = path.join(app.getPath("userData"), "brain");
    const conversations = path.join(app.getPath("userData"), "conversations");
    fs.mkdirSync(conversations, { recursive: true });
    const db = new DatabaseSync(path.join(conversations, "runtime-check.db"));
    db.exec("CREATE TABLE gen_metadata(idx INTEGER, data BLOB); CREATE TABLE steps(idx INTEGER, metadata BLOB)");
    db.close();
    const native = require(path.join(source, "src/antigravity-token-service.js")).readLocalTokenUsage({ root });
    assert.equal(native.readError, null);
    ipcMain.handle("quota:cached",()=>snapshot());ipcMain.handle("quota:refresh",()=>snapshot());
    ipcMain.handle("settings:read",()=>config);
    ipcMain.handle("window:setCompact",(_event,value)=>{ win.setContentSize(value?336:760,value?72:540);win.webContents.send("window:compactChanged",value);return true; });
    ipcMain.handle("tokens:report",(_event,options)=>{ counts.reports++;return report(options); });
    const errors=[];
    win=new BrowserWindow({show:false,width:760,height:540,webPreferences:{preload:path.join(source,"src/preload.js"),backgroundThrottling:false,offscreen:true}});
    win.webContents.on("console-message",(event)=>{ if(event.level===3||event.level==="error") errors.push(event.message); });
    await win.loadFile(path.join(source,"src/renderer/index.html"));
    const evaluate=(code)=>win.webContents.executeJavaScript(code).catch(error=>{console.error("Failed UI step:",code);throw error;});
    const captureRing = async filename => {
      const rect = await evaluate('(() => { const r=document.getElementById("quotaRing").getBoundingClientRect();return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}; })()');
      fs.writeFileSync(path.join(output, filename), (await win.webContents.capturePage(rect)).toPNG());
    };
    const clickWithMouse = async (selector) => {
      const point = await evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
      win.webContents.sendInputEvent({type:"mouseMove",...point});
      await pause(250);
      win.webContents.sendInputEvent({type:"mouseDown",button:"left",clickCount:1,...point});
      await pause(30);
      win.webContents.sendInputEvent({type:"mouseUp",button:"left",clickCount:1,...point});
      await pause(100);
    };
    for(let i=0;i<100&&!await evaluate("Boolean(currentReport)");i++) await pause(50);
    assert.ok(await evaluate("Boolean(currentReport)"),"Report did not load");
    assert.equal(await evaluate("elements.totalTokens.textContent"),"12");
    // Keep the semantic slots stable when the server reports only a weekly limit.
    await evaluate('renderQuotaContext({quota:{shortWindow:null,longWindow:{durationMins:10080,remainingPercent:25}},config:lastSnapshot.config})');
    assert.equal(await evaluate('elements.ringShort.textContent'),"∞");
    assert.equal(await evaluate('elements.ringShortLabel.textContent'),"5h限额");
    assert.equal(await evaluate('elements.ringLong.textContent'),"25%");
    assert.equal(await evaluate('elements.ringLongLabel.textContent'),"周限额");
    assert.equal(await evaluate('elements.shortValue.textContent'),"∞");
    assert.equal(await evaluate('elements.shortReset.textContent'),"∞");
    await pause(650);fs.writeFileSync(path.join(output,"ui-weekly-only.png"),(await win.webContents.capturePage()).toPNG());
    await captureRing("ui-ring-weekly-only.png");
    await evaluate('setQuotaMode("antigravity");renderQuotaContext({antigravityQuota:{shortWindow:{durationMins:300,remainingPercent:100},longWindow:{durationMins:10080,remainingPercent:96}},config:lastSnapshot.config})');
    assert.equal(await evaluate('elements.ringShort.textContent'),"100%");
    assert.equal(await evaluate('elements.ringLong.textContent'),"96%");
    assert.equal(await evaluate('elements.ringShortLabel.textContent'),"5h限额");
    assert.equal(await evaluate('elements.ringLongLabel.textContent'),"周限额");
    await pause(650);fs.writeFileSync(path.join(output,"ui-quota-labels.png"),(await win.webContents.capturePage()).toPNG());
    await captureRing("ui-ring-quota-labels.png");
    // Keep the longest quota row clear of the inner circle at both UI languages.
    for (const language of ["zh", "en"]) {
      await evaluate(`applyLang(${JSON.stringify(language)});setQuotaMode("antigravity");renderQuotaContext({antigravityQuota:{shortWindow:{remainingPercent:100},longWindow:{remainingPercent:96}},config:lastSnapshot.config})`);
      const clearance = await evaluate('(() => { const c=document.querySelector(".ring-core").getBoundingClientRect();const r=elements.ringShortValue.getBoundingClientRect();return {left:r.left-c.left,right:c.right-r.right}; })()');
      assert.ok(clearance.left >= 5 && clearance.right >= 5, `${language} quota row crowding: ${JSON.stringify(clearance)}`);
    }
    await evaluate('applyLang("zh")');
    await evaluate('setQuotaMode("codex");renderQuotaContext(lastSnapshot)');
    await evaluate('renderQuotaContext({...lastSnapshot,resetCredits:{availableCount:2,credits:[{status:"available",expiresAt:Date.now()+3600000}]}})');
    const quotaBounds = await evaluate('(() => { const card=elements.resetRow.getBoundingClientRect(),side=elements.quotaSide.getBoundingClientRect();return {cardBottom:card.bottom,sideBottom:side.bottom,hidden:elements.resetRow.hidden}; })()');
    assert.ok(!quotaBounds.hidden && quotaBounds.cardBottom <= quotaBounds.sideBottom-4, "Quota ring displaced the reset card: " + JSON.stringify(quotaBounds));
    await evaluate('renderQuotaContext(lastSnapshot)');
    assert.ok(await evaluate('document.getElementById("totalTokenCard").getBoundingClientRect().width > 150'));
    assert.equal(await evaluate('document.querySelector(".analysis-toolbar,.dashboard-dialog,.model-search,.model-favorites,#exportButton,#preferencesButton,#sourceHealthButton")'),null);
    assert.equal(await evaluate('document.getElementById("rangePickerTrigger").tagName'),"BUTTON");
    await evaluate('document.getElementById("rangePickerTrigger").click()');await pause(80);
    assert.equal(await evaluate('document.querySelector(".range-picker-menu").hidden'),false);
    assert.ok(await evaluate('document.querySelector(".range-picker-menu").getBoundingClientRect().bottom < innerHeight'));
    await pause(300);fs.writeFileSync(path.join(output,"ui-range-picker.png"),(await win.webContents.capturePage()).toPNG());
    await evaluate('document.getElementById("rangePickerTrigger").click()');
    await clickWithMouse('#rangePickerTrigger');
    await clickWithMouse('.range-option[data-range="today"]');
    assert.equal(await evaluate('Boolean(focusedCard)'),false,"Mouse selection expanded the token card");
    assert.equal(latestOptions.range.preset,"today","Mouse selection did not change the range");
    for (const preset of ["24h","7d","30d","all"]) {
      await clickWithMouse('#rangePickerTrigger');
      await clickWithMouse(`.range-option[data-range="${preset}"]`);
      assert.equal(await evaluate('Boolean(focusedCard)'),false,`${preset} expanded the card`);
      assert.equal(latestOptions.range.preset,preset);
    }
    await evaluate('document.getElementById("rangePickerTrigger").focus();document.getElementById("rangePickerTrigger").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}))');
    await evaluate('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Home",bubbles:true}))');
    await evaluate('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))');await pause(100);
    assert.equal(await evaluate('Boolean(focusedCard)'),false,"Keyboard selection expanded the card");
    assert.equal(latestOptions.range.preset,"24h");
    // Expanding the card itself still works; using its range control must not
    // collapse it or activate the card again.
    await evaluate('document.getElementById("totalTokenCard").click()');await pause(300);
    assert.equal(await evaluate('focusedCard===document.getElementById("totalTokenCard")'),true);
    await clickWithMouse('#rangePickerTrigger');
    await clickWithMouse('.range-option[data-range="today"]');
    assert.equal(await evaluate('focusedCard===document.getElementById("totalTokenCard")'),true,"Range control collapsed expanded card");
    await evaluate('clearCardFocus()');await pause(300);
    await evaluate('document.getElementById("rangePickerTrigger").click()');
    await evaluate('[...document.querySelectorAll(".range-option")].find(option=>option.dataset.range==="7d").click()');await pause(100);
    assert.equal(latestOptions.range.preset,"7d");
    await clickWithMouse('#rangePickerTrigger');
    await clickWithMouse('.range-option[data-range="custom"]');
    assert.equal(await evaluate('Boolean(focusedCard)'),false,"Custom-range option expanded the card");
    await evaluate('document.getElementById("rangeStart").value="2026-09-01";document.getElementById("rangeEnd").value="2026-09-03"');
    await clickWithMouse('#rangeApply');
    assert.equal(await evaluate('Boolean(focusedCard)'),false,"Custom-range apply expanded the card");
    assert.equal(latestOptions.range.start,"2026-09-01");
    await evaluate('document.getElementById("rangePickerTrigger").click();[...document.querySelectorAll(".range-option")].find(option=>option.dataset.range==="all").click()');await pause(100);
    assert.ok(await evaluate('elements.hitHeatmap.children.length <= 42'),"All-history range overflowed the original heatmap layout");
    total=12000;await evaluate('dashboardControls.invalidate();dashboardControls.refresh()');await pause(100);
    assert.equal(await evaluate('document.querySelector(".model-picker-usage").textContent'),"12K");
    await evaluate('elements.hitHeatmap.children[0].focus();renderHeatmapWithData(currentReport.history.daily,currentReport.range)');
    assert.equal(await evaluate('document.activeElement.getAttribute("role")'),"gridcell");
    await evaluate('setCompact(true)');await pause(50);const before=counts.reports;
    await pause(300);fs.writeFileSync(path.join(output,"ui-compact.png"),(await win.webContents.capturePage()).toPNG());
    await evaluate('dashboardControls.invalidate();dashboardControls.refresh();scheduleHistoryRender(true)');await pause(100);assert.equal(counts.reports,before);
    await evaluate('setCompact(false)');await pause(150);assert.ok(counts.reports>before);
    await evaluate('document.getElementById("rangePickerTrigger").click();[...document.querySelectorAll(".range-option")].find(option=>option.dataset.range==="7d").click();applyLang("en")');await pause(50);assert.ok(await evaluate('document.getElementById("rangePickerTrigger").textContent.includes("Date range")'));
    await pause(300);fs.writeFileSync(path.join(output,"ui-en-overview.png"),(await win.webContents.capturePage()).toPNG());
    await evaluate('setCompact(true)');await pause(300);fs.writeFileSync(path.join(output,"ui-en-compact.png"),(await win.webContents.capturePage()).toPNG());
    await evaluate('setCompact(false)');await pause(100);
    await evaluate('document.getElementById("rangePickerTrigger").click()');await pause(300);
    fs.writeFileSync(path.join(output,"ui-en-range-picker.png"),(await win.webContents.capturePage()).toPNG());
    await evaluate('document.getElementById("rangePickerTrigger").click()');
    await evaluate('document.getElementById("rangePickerTrigger").click();[...document.querySelectorAll(".range-option")].find(option=>option.dataset.range==="24h").click();applyLang("zh")');await pause(120);
    assert.equal(await evaluate('document.getElementById("trend7Chart").closest(".trend-panel").hidden'),false);
    assert.ok(await evaluate('document.getElementById("trendCard").getBoundingClientRect().height < 300'),"Original compact chart layout was not restored");
    await pause(400);fs.writeFileSync(path.join(output,"ui-overview.png"),(await win.webContents.capturePage()).toPNG());
    await evaluate('applyTheme("dark")');await pause(300);fs.writeFileSync(path.join(output,"ui-dark.png"),(await win.webContents.capturePage()).toPNG());
    await evaluate('applyTheme("light");document.getElementById("settingsButton").click()');await pause(350);
    assert.equal(await evaluate('document.getElementById("settingsPanel").classList.contains("open")'),true);
    fs.writeFileSync(path.join(output,"ui-settings.png"),(await win.webContents.capturePage()).toPNG());
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({smoke:"passed",electron:process.versions.electron,counts}));app.exit(0);
  } catch(error) {console.error(error);win?.destroy();app.exit(1);}
});
