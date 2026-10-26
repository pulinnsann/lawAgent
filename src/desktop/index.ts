import { isAbsolute } from 'node:path';
import { createDesktopRuntime } from './runtime';
import { startDesktopProtocol } from './protocol';

// Stdout belongs exclusively to the private parent pipe.
console.log = console.info = console.debug = (..._values: unknown[]) => { process.stderr.write('Desktop backend diagnostic.\n'); };
const dataDir=process.env.LAW_AGENT_DATA_DIR;
if(!dataDir||!isAbsolute(dataDir))throw new Error('LAW_AGENT_DATA_DIR must select an absolute workspace directory.');
const session=startDesktopProtocol(process.stdin,process.stdout,host=>createDesktopRuntime(host,{dataDir}),{onFatal:()=>{process.stderr.write('Desktop backend communication failed.\n');process.exitCode=1;}});
// Maintenance may copy large datasets; shutdown waits for publication/rollback.
const stop=()=>{
  void session.close().catch(()=>{process.exitCode=1;});
};
process.once('SIGTERM',stop);process.once('SIGINT',stop);
void session.done.finally(()=>{process.stdin.pause();process.stdin.destroy();});
