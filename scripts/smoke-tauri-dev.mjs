// Verify the actual default Tauri development command in an isolated workspace.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const folder=await mkdtemp(join(tmpdir(),'law-agent-tauri-dev-'));
const reportPath=join(folder,'result.json');const scriptPath=join(folder,'probe.js');
await writeFile(scriptPath,`(async()=>{const end=Date.now()+60000;while((!window.contractAssistant||!document.querySelector('h1'))&&Date.now()<end)await new Promise(r=>setTimeout(r,20));try{if(!window.contractAssistant)throw new Error('Development bridge did not initialize');const s=await window.contractAssistant.getState();if(s.isPreview||s.storageBackend!=='rust')throw new Error('Expected real native workspace');await window.__TAURI__.core.invoke('desktop_smoke_report',{report:{final:true,passed:true,development:true,origin:location.origin,title:document.querySelector('h1')?.textContent}});}catch(e){await window.__TAURI__.core.invoke('desktop_smoke_report',{report:{final:true,passed:false,error:String(e)}});}})();`);
const child=spawn(process.execPath,[join(root,'scripts/tauri.mjs'),'dev','--no-watch','--features','desktop-smoke'],{cwd:root,env:{...process.env,LAW_AGENT_DATA_DIR:join(folder,'workspace'),LAW_AGENT_SMOKE_SCRIPT:scriptPath,LAW_AGENT_SMOKE_OUTPUT:reportPath},stdio:['ignore','pipe','pipe']});
let diagnostics='';child.stdout.on('data',chunk=>{diagnostics+=chunk;});child.stderr.on('data',chunk=>{diagnostics+=chunk;});
const timer=setTimeout(()=>child.kill('SIGTERM'),180000);
const result=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));});clearTimeout(timer);
await mkdir(join(root,'output'),{recursive:true});await writeFile(join(root,'output/tauri-dev-command.log'),diagnostics);
assert.equal(result.signal,null,'Development app was terminated by a signal');assert.equal(result.code,0,diagnostics.slice(-5000));
const report=JSON.parse(await readFile(reportPath,'utf8'));assert.equal(report.passed,true,JSON.stringify(report));
await writeFile(join(root,'output/tauri-dev-command-result.json'),JSON.stringify({...report,workspace:folder},null,2)+'\n');console.log(JSON.stringify(report));
