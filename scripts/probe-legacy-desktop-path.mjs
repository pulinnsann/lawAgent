import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import * as asar from '@electron/asar';

// Probe a cloned, closed Electron distribution. The original application entry
// is never loaded, and the probe never opens its reported default workspace.
if(process.platform!=='darwin')throw new Error('This packaged identity probe currently supports macOS.');
const execute=promisify(execFile);
const root=resolve(import.meta.dirname,'..');
const source=resolve(process.argv[2]??join(root,'output/native-business-package-unsigned/mac-arm64/合同工作台.app'));
const temporary=await mkdtemp(join(tmpdir(),'law-agent-path-probe-'));
const clone=join(temporary,'LegacyIdentity.app');
const staging=join(temporary,'probe-source');
try{
 const originalPlist=await readFile(join(source,'Contents/Info.plist'));
 const metadata=JSON.parse(asar.extractFile(join(source,'Contents/Resources/app.asar'),'package.json').toString('utf8'));
 await execute('/bin/cp',['-cR',source,clone]);
 await mkdir(join(staging,'out/main'),{recursive:true});
 await writeFile(join(staging,'package.json'),JSON.stringify(metadata));
 const probeData=join(temporary,'isolated-user-data');await mkdir(probeData,{recursive:true});
 await writeFile(join(staging,'out/main/index.js'),`import { app } from 'electron';\nimport { join } from 'node:path';\nconst before = { isPackaged: app.isPackaged, name: app.getName(), userData: app.getPath('userData'), appData: app.getPath('appData') };\napp.setPath('userData', process.env.LAW_AGENT_PATH_PROBE_DATA);\napp.setPath('sessionData', join(process.env.LAW_AGENT_PATH_PROBE_DATA, 'chromium'));\napp.setName('合同工作台');\nprocess.stdout.write('LAW_AGENT_PATH_PROBE=' + JSON.stringify({before, isolatedAfter: app.getPath('userData')}) + '\\n');\nprocess.exit(0);\n`);
 const targetAsar=join(clone,'Contents/Resources/app.asar');await rm(targetAsar);await asar.createPackage(staging,targetAsar);
 const header=asar.getRawHeader(targetAsar);const integrity=createHash('sha256').update(header.headerString).digest('hex');
 // Preserve all identity fields; only the cloned archive's integrity is updated.
 const plist=join(clone,'Contents/Info.plist');
 await execute('/usr/libexec/PlistBuddy',['-c',`Set :ElectronAsarIntegrity:Resources/app.asar:hash ${integrity}`,plist]);
 const {stdout:executable}=await execute('/usr/libexec/PlistBuddy',['-c','Print :CFBundleExecutable',plist]);
 const {stdout,stderr}=await execute(join(clone,'Contents/MacOS',executable.trim()),[],{env:{...process.env,LAW_AGENT_PATH_PROBE_DATA:probeData},timeout:20_000,maxBuffer:1024**2});
 const line=stdout.split('\n').find(value=>value.startsWith('LAW_AGENT_PATH_PROBE='));if(!line)throw new Error(`Probe did not return its isolated identity. ${stderr.slice(0,500)}`);
 const result=JSON.parse(line.slice('LAW_AGENT_PATH_PROBE='.length));
 if(!result.before.isPackaged||result.isolatedAfter!==probeData)throw new Error('Probe did not retain packaged identity and isolate the runtime.');
 if(!(await readFile(join(source,'Contents/Info.plist'))).equals(originalPlist))throw new Error('Original bundle identity changed.');
 const report={...result,packageName:metadata.name,packageProductName:metadata.productName??null,method:'Cloned packaged app; replaced only its entry archive; read default path before setting an isolated userData/sessionData path; no original main, Core worker, database or keychain loaded.'};
 const output=join(root,'output/tauri-legacy-path-probe.json');await mkdir(join(root,'output'),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
}finally{await rm(temporary,{recursive:true,force:true});}
