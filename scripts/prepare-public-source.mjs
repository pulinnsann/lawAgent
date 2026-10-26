import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, join, sep } from 'node:path';

// Explicit source allowlist. Running this command never uploads or commits files.
const root=resolve(import.meta.dirname,'..');
const rootFiles=['.gitignore','.npmrc','LICENSE','README.md','CHANGELOG.md','CONTRIBUTING.md','THIRD_PARTY_NOTICES.md','package.json','package-lock.json','tsconfig.json','electron.vite.config.ts','vite.preview.config.ts','Cargo.toml','Cargo.lock','vite.desktop.config.ts','vite.tauri.config.ts','assets/desktop-icon.svg','native/law-desktop/Cargo.toml','native/law-desktop/build.rs','native/law-desktop/tauri.conf.json','native/law-core/Cargo.toml','native/law-node/Cargo.toml','native/law-node/build.rs'];
const roots=['src','tests','scripts','.github','docs/en','native/law-core/src','native/law-node/src','native/law-node/tests','native/law-desktop/src','native/law-desktop/platform','native/law-desktop/capabilities'];
const extensions=new Set(['ts','tsx','mjs','json','css','html','sql','md','yml','yaml','svg','rs','toml','cjs','m']);
const licensedFontHashes = new Map([
 ['native/law-desktop/platform/fonts/NotoSansThai-Regular.ttf','404ddfb5ed0aaa6b6ec8a85700d682978992062d67da93903967b56cbd9a4acc'],
 ['native/law-desktop/platform/fonts/NotoSansThai-Bold.ttf','2b67cfb22337a868c6c85709e648ea30c79e0a7c530a5fc169a73d3f461d7c52'],
]);
const forbidden=/(?:^|\/)(?:node_modules|target|\.local|out|output|release|credentials|remote-cache|local-knowledge|backups|recovery|contract-purge|\.git)(?:\/|$)|\.(?:docx?|pdf|sqlite(?:[-.].*)?|db(?:[-.].*)?|p12|pfx|pem|key|traineddata(?:\.gz)?)$/iu;
const files=[];
async function add(path){
 const info=await lstat(path);const name=relative(root,path).split(sep).join('/');
 if(info.isSymbolicLink())throw new Error(`Symlink is not allowed in the public source snapshot: ${name}`);
 if(info.isDirectory()){for(const child of (await readdir(path)).sort())await add(join(path,child));return;}
 if(!info.isFile()||forbidden.test(name))throw new Error(`Unexpected public source path: ${name}`);
 if(!rootFiles.includes(name)&&!licensedFontHashes.has(name)&&!name.endsWith('/fonts/OFL.txt')&&!extensions.has(name.split('.').at(-1)))throw new Error(`Review unrecognized source type: ${name}`);
 if(info.size>2*1024*1024)throw new Error(`Review oversized source file: ${name}`);
 const bytes=await readFile(path);const content=bytes.toString('utf8');
 if(licensedFontHashes.has(name)) { if(createHash('sha256').update(bytes).digest('hex')!==licensedFontHashes.get(name))throw new Error(`Unexpected licensed font contents: ${name}`); }
 else if(!Buffer.from(content,'utf8').equals(bytes)||bytes.includes(0))throw new Error(`Non-UTF-8 source file: ${name}`);
 const checks=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u, /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{25,}/u, /\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}/u, /\bAKIA[A-Z0-9]{16}\b/u, /\/Users\/mr\.zhai\//u];
 if(!licensedFontHashes.has(name)&&checks.some(check=>check.test(content)))throw new Error(`Potential private material needs review in: ${name}`);
 files.push({path:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),gitBlobSha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')});
}
for(const name of rootFiles)await add(join(root,name));
for(const name of roots)await add(join(root,name));
files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
if(new Set(files.map(file=>file.path)).size!==files.length)throw new Error('Duplicate source path.');
const destination=join(root,'output/public-source');await mkdir(destination,{recursive:true});
const manifest={format:'law-agent-public-source-v1',version:JSON.parse(await readFile(join(root,'package.json'),'utf8')).version,repository:'pulinnsann/lawAgent',createdAt:new Date().toISOString(),documentationLanguage:'en',files,totalBytes:files.reduce((sum,file)=>sum+file.bytes,0),customerDataIncluded:false,uploaded:false};
await writeFile(join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({files:files.length,totalBytes:manifest.totalBytes,manifest:'output/public-source/manifest.json',uploaded:false}));
