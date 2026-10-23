import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron } from 'playwright';

const executablePath=process.argv[2];
if(!executablePath)throw new Error('Pass the packaged application executable path.');
const dataDir=await mkdtemp(join(tmpdir(),'law-packaged-smoke-'));
const errors=[];let app;let diagnostics='';
try{
 app=await electron.launch({executablePath:resolve(executablePath),args:[],env:{...process.env,LAW_AGENT_DATA_DIR:dataDir},timeout:30000});
 app.process().stderr?.on('data',data=>{diagnostics=(diagnostics+data.toString()).slice(-12000);});
 await app.evaluate(({app,BrowserWindow,dialog})=>{dialog.showErrorBox=(title,message)=>console.error('PACKAGED_STARTUP_ERROR',title,message);const isolate=window=>{window.webContents.setBackgroundThrottling(false);window.setFocusable(false);window.hide();};app.on('browser-window-created',(_event,window)=>isolate(window));for(const window of BrowserWindow.getAllWindows())isolate(window);});
 const page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));await page.waitForFunction(()=>Boolean(window.contractAssistant));
 const initial=await page.evaluate(()=>window.contractAssistant.getState());assert.equal(initial.documents.length,0);assert.equal(initial.tasks.length,0);const expectedVersion=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;assert.equal(initial.appVersion,expectedVersion);
 const document=await page.evaluate(()=>window.contractAssistant.loadSample());assert.equal(document.format,'docx');assert.ok(document.blocks.length>0);
 const task=await page.evaluate(documentId=>window.contractAssistant.startReview({documentId,mode:'local',context:{contractType:'service',ourPartyRole:'service_recipient',strictness:'balanced',businessContext:'Packaged engineering sample'}}),document.id);
 const deadline=Date.now()+20000;let completed=false;
 while(Date.now()<deadline){const state=await page.evaluate(()=>window.contractAssistant.getState());const current=state.tasks.find(item=>item.id===task.taskId);if(current?.status==='failed')throw new Error(current.error);if(current?.status==='completed'){completed=true;break;}await new Promise(resolve=>setTimeout(resolve,30));}
 assert.equal(completed,true,'Local review must reach completed');
 const maintenance=await page.evaluate(()=>window.contractAssistant.runWorkspaceCommand({action:'maintenance.status'}));assert.equal(maintenance.documentCount,1,JSON.stringify(maintenance));assert.equal(maintenance.reportCount,1,JSON.stringify(maintenance));assert.ok(maintenance.dataDir.includes('law-packaged-smoke-'));
 await page.reload();await page.getByText('正在读取工作空间').waitFor({state:'hidden'});await page.getByRole('button',{name:'功能中心',exact:true}).click();const menu=page.getByRole('dialog',{name:'功能中心',exact:true});for(const name of ['合同、项目与参考译文','审核资料与核验','模型运行与用量','双／三语条款对齐','报告与工作汇总','经验、模板与人工意见','专业检索与远端知识库','扫描件与 PDF 转换','数据备份与恢复'])assert.ok(await menu.getByRole('button').filter({hasText:name}).isVisible());
 assert.deepEqual(errors,[]);
 const report={passed:true,version:initial.appVersion,executablePath:resolve(executablePath),isolatedDataDir:dataDir,initiallyEmpty:true,localSampleImportAndReview:true,functionCenterEntries:9,noRealModels:true,customerDataRead:false,pageErrors:errors};
 if(process.argv[3]){const output=resolve(process.argv[3]);await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');}console.log(JSON.stringify(report,null,2));
}catch(error){console.error(diagnostics);if(app)console.error(await app.evaluate(({app,BrowserWindow})=>({ready:app.isReady(),windows:BrowserWindow.getAllWindows().length})).catch(()=>({closed:true})));throw error;}finally{await app?.close();}
