import { access, readdir, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
const executable=process.platform==='win32'?'cargo.exe':'cargo';
let cargo=process.env.LAW_AGENT_CARGO;
let rustc=process.env.RUSTC;
if(!cargo){const candidate=join(homedir(),'.cargo/bin',executable);try{await access(candidate);cargo=candidate;}catch{}}
if(!cargo){for(const name of (await readdir(join(homedir(),'.rustup/toolchains')).catch(()=>[])).filter(name=>name.startsWith('stable')).sort()) { const candidate=join(homedir(),'.rustup/toolchains',name,'bin',executable);try{await access(candidate);cargo=candidate;rustc??=join(dirname(candidate),process.platform==='win32'?'rustc.exe':'rustc');break;}catch{} }}
const cache=process.env.LAW_AGENT_CARGO_CACHE??join(root,'.local/rust-cargo');
const target=process.env.LAW_AGENT_CARGO_TARGET??join(root,'.local/rust-target');
await mkdir(cache,{recursive:true});await mkdir(target,{recursive:true});
const env={...process.env,CARGO_HOME:cache,CARGO_TARGET_DIR:target,CSC_IDENTITY_AUTO_DISCOVERY:'false'};
if(cargo)env.PATH=`${dirname(cargo)}${process.platform==='win32'?';':':'}${process.env.PATH??''}`;
if(rustc){env.RUSTC=rustc;env.RUSTDOC=join(dirname(rustc),process.platform==='win32'?'rustdoc.exe':'rustdoc');}
const args=process.argv.slice(2);if(!args.length)args.push('dev');
const child=spawn(process.execPath,[join(root,'node_modules/@tauri-apps/cli/tauri.js'),...args],{cwd:join(root,'native/law-desktop'),env,stdio:'inherit',shell:false});
child.on('error',error=>{console.error(`Tauri launch failed: ${error.message}`);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
