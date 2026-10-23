import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { createPdf } from '../tests/fixtures-documents.ts';

// Synthetic, isolated desktop acceptance. No model or external service calls.
const root=resolve(import.meta.dirname,'..');
const dataDir=await mkdtemp(join(tmpdir(),'law-report-ui-data-'));
const output=await mkdtemp(join(tmpdir(),'law-report-ui-output-'));
const input=join(output,'synthetic-trilingual.pdf');
await writeFile(input,createPdf([['服务合同工程样本','付款期限未明确。 Payment after acceptance.','สัญญาบริการ ข้อมูลสมมติสำหรับทดสอบระบบ'],['服务期限：2026年1月1日至2026年12月31日。','违约责任与争议解决应由法务确认。']]));
const errors=[],requests=[],screenshots=[],exports=[];
let app,page;
const poll=async(read,good,label)=>{const deadline=Date.now()+30000;while(Date.now()<deadline){const value=await read();if(good(value))return value;await new Promise(resolve=>setTimeout(resolve,40));}throw new Error(`Timed out ${label}`);};
const command=(action,payload={})=>page.evaluate(input=>window.contractAssistant.runWorkspaceCommand(input),{action,payload});
const saveTo=path=>app.evaluate(({dialog},path)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:path});},path);
async function openTool(title){await page.getByRole('button',{name:'功能中心',exact:true}).click();await page.getByRole('dialog',{name:'功能中心',exact:true}).getByRole('button').filter({hasText:title}).click();}
async function layout(panel,label){for(const [width,height]of [[1440,900],[760,560],[390,844]]){await app.evaluate(({BrowserWindow},size)=>{const window=BrowserWindow.getAllWindows()[0];window.setMinimumSize(0,500);window.setContentSize(...size);},[width,height]);await page.waitForFunction(size=>innerWidth===size[0]&&innerHeight===size[1],[width,height]);const sizes=await panel.evaluate(node=>({scroll:node.scrollWidth,client:node.clientWidth,document:document.documentElement.scrollWidth,viewport:innerWidth}));assert.ok(sizes.scroll<=sizes.client+1&&sizes.document<=sizes.viewport+1,JSON.stringify(sizes));const path=join(output,`${label}-${width}.png`);await page.screenshot({path});screenshots.push(path);}await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,900));await page.waitForFunction(()=>innerWidth===1440);}
try{
 app=await electron.launch({args:[root],cwd:root,env:{...process.env,LAW_AGENT_DATA_DIR:dataDir}});
 await app.evaluate(({app,BrowserWindow})=>{const isolate=win=>{win.webContents.setBackgroundThrottling(false);win.setFocusable(false);win.hide();};app.on('browser-window-created',(_event,win)=>isolate(win));for(const win of BrowserWindow.getAllWindows())isolate(win);});
 page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/u.test(r.url()))requests.push(r.url());});await page.waitForFunction(()=>Boolean(window.contractAssistant));await page.getByText('正在读取工作空间').waitFor({state:'hidden'});
 await app.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});},input);await page.locator('.import-button').click();
 const state=await poll(()=>page.evaluate(()=>window.contractAssistant.getState()),s=>s.documents.length===1,'PDF import');const sourceId=state.documents[0].id;
 const task=await page.evaluate(documentId=>window.contractAssistant.startReview({documentId,mode:'local',context:{contractType:'service',ourPartyRole:'service_recipient',strictness:'balanced',businessContext:'工程合成样本'}}),sourceId);
 const completed=await poll(()=>page.evaluate(()=>window.contractAssistant.getState()),s=>s.tasks.some(t=>t.id===task.taskId&&t.status==='completed'),'local review');const reviewId=completed.tasks.find(t=>t.id===task.taskId).resultId;
 await page.reload();await page.getByText('正在读取工作空间').waitFor({state:'hidden'});await openTool('报告与工作汇总');const report=page.getByRole('region',{name:'报告与工作汇总',exact:true});await report.getByLabel('报告单位名称',{exact:true}).fill('合成测试单位');await report.getByLabel('报告编制人',{exact:true}).fill('测试法务');await report.getByLabel('报告接收人',{exact:true}).fill('内部管理层');await report.getByRole('button',{name:'保存报告配置',exact:true}).click();await report.getByText('报告个性化配置已保存在本地，历史修订保留。',{exact:true}).waitFor();
 await layout(report,'reporting');
 for(const style of ['risk','management','summary']){
  await report.getByLabel('报告样式',{exact:true}).selectOption(style);
  for(const format of (style==='management'?['docx','pdf','html','markdown','csv']:['pdf'])){
   const path=join(output,`${style}-report.${format==='markdown'?'md':format}`);await saveTo(path);await report.getByLabel('报告导出格式',{exact:true}).selectOption(format);await report.getByRole('button',{name:'导出报告',exact:true}).click();await poll(()=>readFile(path).catch(()=>Buffer.alloc(0)),b=>b.length>30,`export ${style} ${format}`);await report.getByRole('status').filter({hasText:'报告已导出'}).waitFor();const bytes=await readFile(path);if(format==='pdf')assert.equal(bytes.subarray(0,4).toString(),'%PDF');if(format==='docx')assert.equal(bytes.subarray(0,2).toString(),'PK');exports.push(path);
  }
 }
 const snapshot=await command('reporting.query',{scope:'workspace',style:'management'});assert.equal(snapshot.metrics.reviewRounds,1);assert.equal(snapshot.metrics.contracts,1);
 // Hold the native export dialog to exercise the Main-only gap between IPCs.
 await app.evaluate(({dialog})=>{dialog.showSaveDialog=()=>new Promise(resolve=>{globalThis.__lawReleaseSave=resolve;globalThis.__lawSaveWaiting=true;});});
 const held=command('reporting.export',{scope:'current',reviewId,style:'management',format:'pdf'});
 await poll(()=>app.evaluate(()=>globalThis.__lawSaveWaiting),Boolean,'held save dialog');
 await assert.rejects(command('maintenance.backup',{includeKnowledge:false}),/操作运行|操作.*完成/u);
 await app.evaluate(()=>{globalThis.__lawReleaseSave({canceled:true});delete globalThis.__lawReleaseSave;delete globalThis.__lawSaveWaiting;});assert.equal(await held,null);
 const connectionBody={name:'隔离凭据并发测试',enabled:false,type:'mcp',endpoint:'https://example.invalid/mcp'};
 const connection=await command('connections.save',{expectedRevision:0,body:connectionBody,secret:'synthetic-cas-initial'});
 const race=await Promise.allSettled(['A','B'].map(suffix=>command('connections.save',{id:connection.id,expectedRevision:1,body:{...connection.body,name:`并发版本${suffix}`},secret:`synthetic-cas-${suffix}`})));
 assert.equal(race.filter(item=>item.status==='fulfilled').length,1);assert.equal(race.filter(item=>item.status==='rejected').length,1);
 const winner=race.findIndex(item=>item.status==='fulfilled');const expected=`synthetic-cas-${winner===0?'A':'B'}`;
 const encryptionAvailable=await app.evaluate(({safeStorage})=>safeStorage.isAsyncEncryptionAvailable());
 if(encryptionAvailable){const cipher=(await readFile(join(dataDir,'credentials/extensions',connection.id,'model-key.bin'))).toString('base64');const validCredential=await app.evaluate(async({safeStorage},input)=>JSON.parse((await safeStorage.decryptStringAsync(Buffer.from(input.cipher,'base64'))).result).apiKey===input.expected,{cipher,expected});assert.equal(validCredential,true);}
 await report.getByRole('button',{name:'关闭',exact:true}).click();await openTool('扫描件与 PDF 转换');const conversion=page.getByRole('region',{name:'PDF 转换与本机 OCR',exact:true});await conversion.getByLabel('PDF 转换方式',{exact:true}).selectOption('text');await layout(conversion,'conversion');await conversion.getByRole('button',{name:'保存转换配置',exact:true}).click();await conversion.getByText('本机 PDF 转换配置已保存。',{exact:true}).waitFor();
 const converted=join(output,'converted-text.docx');await saveTo(converted);await conversion.getByRole('button',{name:'生成并导入 DOCX',exact:true}).click();const next=await poll(()=>page.evaluate(()=>window.contractAssistant.getState()),s=>s.documents.length===2,'conversion imported');const newId=next.documents.find(d=>d.id!==sourceId).id;const detail=await page.evaluate(id=>window.contractAssistant.getDocument(id),newId);assert.equal(detail.format,'docx');assert.ok(detail.blocks.some(b=>b.text.includes('Payment after acceptance')));assert.ok(detail.blocks.some(b=>b.text.includes('สัญญาบริการ')));assert.equal((await page.evaluate(id=>window.contractAssistant.getDocument(id),sourceId)).reviews[0].id,reviewId);assert.ok((await readFile(converted)).length>0);exports.push(converted);
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);await writeFile(join(output,'manifest.json'),JSON.stringify({dataDir,output,exports,screenshots},null,2));console.log(JSON.stringify({passed:true,isolatedProfile:true,noNetwork:true,reportExports:7,allFormats:true,reportSettingsPersisted:true,maintenanceWaitsForMainExport:true,concurrentCredentialCasPreserved:true,trilingualTextPdfToEditableDocx:true,originalPdfAndReviewPreserved:true,dataDir,output,exports,screenshots},null,2));
}catch(error){if(page&&!page.isClosed()){await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});console.error(await page.locator('body').innerText().catch(()=>''));}throw error;}finally{await app?.close();}
