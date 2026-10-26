import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { verifyReleaseResources } from './verify-release-resources.mjs';
const args=process.argv.slice(2);
const directory=resolve(args[0]??'.local/tauri-runtime');
const output=args[1]?resolve(args[1]):null;
const manifest=JSON.parse(await readFile(join(directory,'runtime-manifest.json'),'utf8'));
if(manifest.format!=='law-agent-tauri-runtime-v1'||manifest.platform!==process.platform||manifest.arch!==process.arch)throw new Error('Runtime does not match this build target.');
for(const file of manifest.files){
 const path=join(directory,file.path);const delta=relative(directory,path);
 if(isAbsolute(delta)||delta==='..'||delta.startsWith(`..${process.platform==='win32'?'\\':'/'}`))throw new Error('Manifest path escaped the runtime directory.');
 const bytes=await readFile(path);
 if(bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error(`Runtime resource failed integrity verification: ${file.path}`);
 if(/(?:^|\/)electron(?:\/|$)|Chromium\.framework|app\.asar/iu.test(file.path))throw new Error('An Electron resource was unexpectedly included.');
}
const result=await verifyReleaseResources({root:directory,nativeRoot:join(directory,'native'),platform:process.platform,arch:process.arch,resources:null,runtime:true});
result.format='law-agent-tauri-release-resources-v1';result.stage='bundled-flat-runtime';result.manifestFiles=manifest.files.length;result.electronBundled=false;
if(output){await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n');}
console.log(JSON.stringify({passed:true,files:manifest.files.length,engines:result.runtime,electronBundled:false}));
