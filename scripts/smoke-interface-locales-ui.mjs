import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { createDocx } from '../tests/fixtures-documents.ts';
import { translate, INTERFACE_LOCALE_STORAGE_KEY } from '../src/renderer/src/i18n.tsx';

const root=resolve(import.meta.dirname,'..'),dataDir=await mkdtemp(join(tmpdir(),'law-interface-locale-'));
const artifacts=join(root,'output/playwright/interface-locales');await mkdir(artifacts,{recursive:true});
const original=['合成三语界面测试合同','甲方应在验收后30日内支付100元人民币。','The buyer shall pay CNY 100 within 30 days after acceptance.','ผู้ซื้อต้องชำระเงิน 100 บาทภายใน 30 วันหลังตรวจรับ'];
const source=join(dataDir,'synthetic-user-source-中国合同.docx');await writeFile(source,await createDocx({paragraphs:original}));
const errors=[],requests=[],layouts=[],screenshots=[],panels=[];let app,page,locale='zh';
const t=(key,params)=>translate(locale,key,params);
const command=(action,payload={})=>page.evaluate(input=>window.contractAssistant.runWorkspaceCommand(input),{action,payload});
async function poll(read,accept,label){const until=Date.now()+25000;while(Date.now()<until){const value=await read();if(accept(value))return value;await new Promise(r=>setTimeout(r,40));}throw new Error(`Timeout: ${label}`);}
async function dimensions(width){await app.evaluate(({BrowserWindow},value)=>{const win=BrowserWindow.getAllWindows()[0];win.setMinimumSize(0,0);win.setContentSize(value,900);},width);await page.waitForFunction(value=>innerWidth===value,width);}
async function layout(panel,name,capture=false){for(const width of[1440,760,390]){await dimensions(width);const value=await panel.evaluate(node=>({scroll:node.scrollWidth,client:node.clientWidth,document:document.documentElement.scrollWidth,viewport:innerWidth}));const internal=await panel.evaluate(node=>[node,...node.querySelectorAll('*')].filter(element=>element instanceof HTMLElement&&!['PRE','TEXTAREA','INPUT','SELECT'].includes(element.tagName)&&['auto','scroll'].includes(getComputedStyle(element).overflowX)&&element.clientWidth>0&&element.scrollWidth>element.clientWidth+1).map(element=>({tag:element.tagName,class:element.className,scroll:element.scrollWidth,client:element.clientWidth})));layouts.push({locale,name,width,...value,internal});assert.ok(value.scroll<=value.client+1&&value.document<=value.viewport+1,`${locale}/${name}/${width}: ${JSON.stringify(value)}`);assert.deepEqual(internal,[],`${locale}/${name}/${width}: internal horizontal scroll`);if(capture&&(width===1440||width===390)){const file=join(artifacts,`${locale}-${name}-${width}.png`);await page.screenshot({path:file,animations:'disabled'});screenshots.push(file);}}await dimensions(1440);}
async function setLocale(next){await page.locator('.interface-language select').selectOption(next);locale=next;await poll(()=>page.locator('html').getAttribute('lang'),value=>value===(locale==='zh'?'zh-CN':locale),'html language');assert.equal(await page.evaluate(key=>localStorage.getItem(key),INTERFACE_LOCALE_STORAGE_KEY),locale);}
async function openTool(name){await dimensions(1440);await page.getByRole('button',{name:t('功能中心'),exact:true}).click();const menu=page.getByRole('dialog',{name:t('功能中心'),exact:true});await menu.getByRole('button').filter({hasText:t(name)}).click();}
const tools=[
 ['合同、项目与参考译文','.document-workspace','关闭合同管理'],
 ['审核资料与核验','.review-completion-panel','关闭'],
 ['双／三语条款对齐','.clause-alignment-panel','关闭条款对齐'],
 ['模型运行与用量','.model-runtime-panel','关闭模型运行配置'],
 ['报告与工作汇总','.reporting-panel','关闭'],
 ['经验、模板与人工意见','.library-panel','关闭资料库'],
 ['专业检索与远端知识库','.connections-panel','关闭远端连接'],
 ['扫描件与 PDF 转换','.conversion-panel','关闭'],
 ['数据备份与恢复','.maintenance-panel','关闭数据管理'],
];
try{
 app=await electron.launch({args:[root],cwd:root,env:{...process.env,LAW_AGENT_DATA_DIR:dataDir,ELECTRON_RENDERER_URL:''},timeout:30000});await app.evaluate(({app,BrowserWindow})=>{const isolate=win=>{win.webContents.setBackgroundThrottling(false);win.setFocusable(false);win.hide();};app.on('browser-window-created',(_event,win)=>isolate(win));BrowserWindow.getAllWindows().forEach(isolate);});
 page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^https?:/.test(request.url()))requests.push(request.url());});await page.waitForFunction(()=>Boolean(window.contractAssistant));await page.getByText('正在读取工作空间').waitFor({state:'hidden'});assert.equal(await page.locator('.interface-language select').inputValue(),'zh');
 await app.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});},source);await page.locator('.import-button').click();const state=await poll(()=>page.evaluate(()=>window.contractAssistant.getState()),value=>value.documents.length===1,'import');const id=state.documents[0].id;await page.getByRole('button',{name:t('本地规则检查'),exact:true}).click();await poll(()=>page.evaluate(()=>window.contractAssistant.getState()),value=>value.tasks[0]?.status==='completed','local review');const before=await page.evaluate(id=>window.contractAssistant.getDocument(id),id);
 for(const language of['zh','en','th']){
  await setLocale(language);await layout(page.locator('.app-shell'),'workspace',true);
  for(const[name,selector,close]of tools){await openTool(name);const panel=page.locator(selector);await panel.waitFor();await layout(panel,name.replaceAll(/[／、与 ]/g,'-'),['报告与工作汇总','经验、模板与人工意见'].includes(name));panels.push({locale,name});
   if(name==='经验、模板与人工意见'){for(const tab of['企业模板起草','人工审核意见','顾问与样本回归']){await panel.getByRole('button',{name:t(tab),exact:true}).click();await layout(panel,tab,false);}}
   await panel.getByRole('button',{name:t(close),exact:true}).click();await panel.waitFor({state:'hidden'});
  }
  await page.getByRole('button',{name:t('环境与知识库配置'),exact:true}).click();const setup=page.locator('.setup-wizard-panel');await setup.waitFor();await layout(setup,'setup',true);await setup.getByRole('button',{name:t('检查并初始化环境'),exact:true}).click();await setup.locator('.environment-report').waitFor();await poll(()=>setup.getByRole('button',{name:t('检查并初始化环境'),exact:true}).isEnabled(),Boolean,'environment checks');assert.equal(await setup.locator('.environment-check strong').filter({hasText:t('内置运行环境')}).count(),1);await setup.getByRole('button',{name:t('关闭环境与知识库配置'),exact:true}).click();
  await page.locator('.topbar-settings').click();const model=page.locator('.model-settings-panel');await model.waitFor();await layout(model,'model-settings',false);await model.getByRole('button',{name:t('关闭模型设置'),exact:true}).click();
 }
 await setLocale('en');await openTool('报告与工作汇总');const report=page.locator('.reporting-panel');await poll(()=>report.getByLabel(t('报告语言'),{exact:true}).isEnabled(),Boolean,'report settings loaded');assert.equal(await report.getByLabel(t('报告语言'),{exact:true}).inputValue(),'zh');const user='用户自定义 UNIT <b>ไม่แปล</b>';await report.getByLabel(t('报告单位名称'),{exact:true}).fill(user);await report.getByLabel(t('报告语言'),{exact:true}).selectOption('en');await setLocale('th');assert.equal(await report.getByLabel(t('报告语言'),{exact:true}).inputValue(),'en');assert.equal(await report.getByLabel(t('报告单位名称'),{exact:true}).inputValue(),user);await report.getByRole('button',{name:t('关闭'),exact:true}).click();await report.getByRole('button',{name:t('关闭'),exact:true}).click();await report.waitFor({state:'hidden'});
 const after=await page.evaluate(id=>window.contractAssistant.getDocument(id),id);assert.deepEqual(after.blocks,before.blocks);assert.deepEqual(after.reviews,before.reviews);assert.equal((await command('modelRuntime.ledger.list',{limit:50})).length,0);assert.deepEqual(requests,[]);assert.deepEqual(errors,[]);
 await page.reload();await page.locator('.interface-language select').waitFor();assert.equal(await page.locator('.interface-language select').inputValue(),'th');assert.equal(await page.locator('html').getAttribute('lang'),'th');
 const result={passed:true,version:'0.3.0',noCustomerData:true,noModelCalls:true,noNetworkRequests:true,allNineToolsInThreeLocales:panels,layouts,screenshots,interfacePreferencePersists:true,htmlLangUpdates:true,reportLanguageIndependent:true,userFieldsAndOriginalReviewUnchanged:true,errors,dataDir};await writeFile(join(artifacts,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(error){if(page&&!page.isClosed()){await page.screenshot({path:join(artifacts,'failure.png')}).catch(()=>{});console.error(await page.locator('body').innerText().catch(()=>''));}throw error;}finally{await app?.close();}
