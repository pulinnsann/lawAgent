import { isAbsolute } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createDesktopRuntime } from './runtime';
import { startDesktopProtocol } from './protocol';
import { DiagnosticLog, classifyDiagnosticError } from '../main/diagnostic-log';
import { APP_VERSION } from '../shared/app-version';

// Stdout belongs exclusively to the private parent pipe.
console.log = console.info = console.debug = (..._values: unknown[]) => { process.stderr.write('Desktop backend diagnostic.\n'); };
const dataDir=process.env.LAW_AGENT_DATA_DIR;
if(!dataDir||!isAbsolute(dataDir))throw new Error('LAW_AGENT_DATA_DIR must select an absolute workspace directory.');
await mkdir(dataDir,{recursive:true,mode:0o700});
const diagnosticLog=await DiagnosticLog.open(dataDir,{appVersion:APP_VERSION,platform:process.platform,arch:process.arch,nodeVersion:process.versions.node,runtime:'tauri'});
process.on('uncaughtExceptionMonitor',error=>{diagnosticLog.record({event:'backend.uncaught_exception',...classifyDiagnosticError(error)});void diagnosticLog.flush();});
const session=startDesktopProtocol(process.stdin,process.stdout,host=>createDesktopRuntime(host,{dataDir,diagnosticLog}),{onDiagnostic:event=>diagnosticLog.record({event}),onFatal:error=>{diagnosticLog.record({event:'protocol.failed',...classifyDiagnosticError(error)});process.stderr.write('Desktop backend communication failed.\n');process.exitCode=1;}});
// Maintenance may copy large datasets; shutdown waits for publication/rollback.
const stop=()=>{
  void session.close().catch(()=>{process.exitCode=1;});
};
process.once('SIGTERM',stop);process.once('SIGINT',stop);
void session.done.finally(async()=>{await diagnosticLog.close();process.stdin.pause();process.stdin.destroy();});
