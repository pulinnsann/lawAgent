import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
export async function generateNativeNotices(destination) {
  const {stdout}=await promisify(execFile)(process.execPath,[join(root,'scripts/native-core.mjs'),'metadata','--format-version','1','--locked'],{cwd:root,maxBuffer:32*1024**2});
  const metadata=JSON.parse(stdout);
  const sections=['# Native dependency notices','Generated from the locked Cargo dependency graph. Platform-specific dependencies may not be present in every binary. System frameworks and WebView runtimes retain their platform licenses.'];
  for(const pkg of metadata.packages.filter(pkg=>pkg.source).sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version))) {
    sections.push(`## ${pkg.name} ${pkg.version}`,`License expression: ${pkg.license??'See upstream source'}\n\nSource: ${pkg.repository??`https://crates.io/crates/${pkg.name}/${pkg.version}`}`);
    const folder=dirname(pkg.manifest_path);
    const files=(await readdir(folder,{withFileTypes:true})).filter(file=>file.isFile()&&/^(?:licen[cs]e|copying|notice)(?:[-_.].*)?$/iu.test(file.name)).map(file=>file.name);
    if(pkg.license_file&&!files.includes(pkg.license_file)&&!pkg.license_file.includes('..'))files.push(pkg.license_file);
    for(const file of files.sort()) {const text=await readFile(join(folder,file),'utf8');if(Buffer.byteLength(text)>1024**2)throw new Error('Oversized native license file.');sections.push(`### ${file}\n\n\x60\x60\x60text\n${text.trim()}\n\x60\x60\x60`);}
  }
  await mkdir(dirname(destination),{recursive:true});await writeFile(destination,sections.join('\n\n')+'\n');
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename))await generateNativeNotices(resolve(process.argv[2]??'.local/native-licenses.md'));
