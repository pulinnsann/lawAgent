import { access, mkdir, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root=resolve(import.meta.dirname,'..');
const executable=process.platform==='win32'?'cargo.exe':'cargo';
let cargo=process.env.LAW_AGENT_CARGO??null;
let rustc=process.env.RUSTC;
if(!cargo){
 const conventional=join(homedir(),'.cargo','bin',executable);
 try{await access(conventional);cargo=conventional;}catch{}
}
if(!cargo){
 const directory=join(homedir(),'.rustup','toolchains');
 const candidates=await readdir(directory).catch(()=>[]);
 for(const name of candidates.filter(name=>name.startsWith('stable')).sort()){
  const candidate=join(directory,name,'bin',executable);
  try{await access(candidate);cargo=candidate;rustc??=join(dirname(candidate),process.platform==='win32'?'rustc.exe':'rustc');break;}catch{}
 }
}
cargo??=executable;
const args=process.argv.slice(2);
if(!args.length)args.push('test','--workspace','--locked');
const cache=process.env.LAW_AGENT_CARGO_CACHE??join(root,'.local','rust-cargo');
const target=process.env.LAW_AGENT_CARGO_TARGET??join(root,'.local','rust-target');
await mkdir(cache,{recursive:true});await mkdir(target,{recursive:true});
const env={...process.env,CARGO_HOME:cache,CARGO_TARGET_DIR:target};
if(rustc){env.RUSTC=rustc;env.RUSTDOC=join(dirname(rustc),process.platform==='win32'?'rustdoc.exe':'rustdoc');}
const child=spawn(cargo,args,{cwd:root,env,stdio:'inherit',shell:false});
child.on('error',error=>{console.error(`Rust toolchain unavailable: ${error.message}. Install stable Rust or set LAW_AGENT_CARGO.`);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
