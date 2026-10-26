import { isUtf8 } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import type { BackendFrame, DesktopHost, DesktopRuntime, ParentFrame } from './types';

// Bounded private pipe messages. This is not an HTTP or WebView filesystem API.
export const MAX_FRAME_BYTES = 64 * 1024 ** 2;
const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/u);
const parentFrame = z.discriminatedUnion('type', [
  z.object({type:z.literal('invoke'),id,name:z.string().min(1).max(100),payload:z.unknown().optional()}).strict(),
  z.object({type:z.literal('hostResponse'),id,data:z.unknown().optional(),error:z.string().max(4096).optional()}).strict(),
  z.object({type:z.literal('shutdown'),id}).strict(),
]);

/** Decode byte-fragmented UTF-8 JSON lines without accepting unbounded input. */
export class FrameDecoder {
  private parts: Buffer[] = [];
  private bytes = 0;
  constructor(private onFrame: (frame: ParentFrame) => void, private limit = MAX_FRAME_BYTES) {}
  push(chunk: Buffer): void {
    let offset=0;
    while(offset<chunk.length){
      const newline=chunk.indexOf(10,offset);
      const end=newline<0?chunk.length:newline;
      const piece=chunk.subarray(offset,end);
      this.bytes+=piece.length;
      if(this.bytes>this.limit)throw new Error('Desktop pipe frame exceeds its byte limit.');
      if(piece.length)this.parts.push(piece);
      if(this.parts.length>4096)this.parts=[Buffer.concat(this.parts,this.bytes)];
      if(newline<0)return;
      const bytes=Buffer.concat(this.parts,this.bytes);
      if(!isUtf8(bytes))throw new Error('Invalid desktop pipe UTF-8.');
      const raw=bytes.toString('utf8');
      this.parts=[];this.bytes=0;
      if(!raw.trim())throw new Error('Empty desktop pipe frame.');
      let parsed:unknown;
      try{parsed=JSON.parse(raw);}catch{throw new Error('Invalid desktop pipe JSON.');}
      const validated=parentFrame.safeParse(parsed);
      if(!validated.success)throw new Error('Invalid desktop pipe envelope.');
      this.onFrame(validated.data);
      offset=newline+1;
    }
  }
  finish(): void { if(this.bytes)throw new Error('Truncated desktop pipe frame.'); }
}

export interface ProtocolSession {
  done: Promise<void>;
  close(): Promise<void>;
}

/** Every privileged request travels only on the inherited anonymous pipe. */
export function startDesktopProtocol(input: Readable, output: Writable, create: (host: DesktopHost)=>Promise<DesktopRuntime>, options: {hostTimeoutMs?:number;maxInFlight?:number;onFatal?:(error:Error)=>void} = {}): ProtocolSession {
  let runtime: DesktopRuntime | undefined;
  let stopping = false;
  let closed = false;
  let writeQueue = Promise.resolve();
  let queuedBytes = 0;
  const inFlight=new Set<Promise<void>>();
  const hostPending=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  const invokeIds=new Set<string>();
  let settleDone!:()=>void;
  const done=new Promise<void>(resolve=>{settleDone=resolve;});
  const write=(frame:BackendFrame):Promise<void>=>{
    let bytes:Buffer;
    try{bytes=Buffer.from(`${JSON.stringify(frame)}\n`);}catch{return Promise.reject(new Error('Desktop response cannot be serialized.'));}
    if(bytes.length>MAX_FRAME_BYTES+1)return Promise.reject(new Error('Desktop response exceeds its byte limit.'));
    if(queuedBytes+bytes.length>MAX_FRAME_BYTES*2)return Promise.reject(new Error('Desktop response queue is full.'));
    queuedBytes+=bytes.length;
    const next=writeQueue.then(()=>new Promise<void>((resolve,reject)=>{if(closed||output.destroyed){reject(new Error('Desktop output is closed.'));return;}output.write(bytes,error=>error?reject(error):resolve());}));
    writeQueue=next.catch(()=>{});
    return next.finally(()=>{queuedBytes-=bytes.length;});
  };
  const host:DesktopHost={
    call<T>(operation:string,payload:unknown):Promise<T>{
      if(stopping||closed||hostPending.size>=32)return Promise.reject(new Error('Native desktop request queue unavailable.'));
      const requestId=randomUUID();
      return new Promise<T>((resolve,reject)=>{
        const timer=setTimeout(()=>{hostPending.delete(requestId);reject(new Error('Native desktop request timed out.'));},options.hostTimeoutMs??(operation.startsWith('credential')?1900:30*60*1000));
        hostPending.set(requestId,{resolve,reject,timer});
        void write({type:'host',id:requestId,operation,payload}).catch(error=>{clearTimeout(timer);hostPending.delete(requestId);reject(error);});
      });
    },
    emitTask(task){void write({type:'task',task}).catch(fail);},
    emitShutdownProgress(phase){void write({type:'shutdownProgress',phase}).catch(fail);},
  };
  const ready=Promise.resolve().then(()=>create(host)).then(value=>{runtime=value;return write({type:'ready',protocol:1});});
  const rejectHostRequests=()=>{for(const request of hostPending.values()){clearTimeout(request.timer);request.reject(new Error('Desktop connection closed.'));}hostPending.clear();};
  let runtimeClosing:Promise<void>|null=null;
  const closeRuntime=()=>runtimeClosing??=ready.then(()=>runtime?.close());
  let closing:Promise<void>|null=null;
  const close=()=>closing??=(async()=>{
    stopping=true;
    rejectHostRequests();
    try{await closeRuntime();await Promise.allSettled([...inFlight]);await writeQueue;}
    finally{
      closed=true;
      rejectHostRequests();
      input.removeListener('data',onData);input.removeListener('end',onEnd);input.removeListener('error',fail);output.removeListener('error',fail);settleDone();
    }
  })();
  function fail(error:Error):void {
    if(closed)return;
    options.onFatal?.(error);
    stopping=true;
    // Never echo a malformed frame: it may contain credentials or contract text.
    void write({type:'fatal',error:'Desktop backend communication failed.'}).catch(()=>{});
    void close().catch(()=>{});
  }
  const dispatch=(frame:ParentFrame)=>{
    if(frame.type==='hostResponse'){
      const request=hostPending.get(frame.id);if(!request)return;
      clearTimeout(request.timer);hostPending.delete(frame.id);frame.error?request.reject(new Error(frame.error)):request.resolve(frame.data);return;
    }
    if(frame.type==='shutdown'){
      stopping=true;
      rejectHostRequests();
      const operation=(async()=>{await ready;if(runtime?.isMaintenanceBusy?.())await write({type:'shutdownDeferred',id:frame.id,reason:'maintenance'});await closeRuntime();await Promise.allSettled([...inFlight]);await write({type:'shutdownComplete',id:frame.id});await close();})();
      void operation.catch(fail);return;
    }
    if(stopping){void write({type:'response',id:frame.id,data:{ok:false,error:'Desktop backend is shutting down.'}}).catch(fail);return;}
    if(invokeIds.has(frame.id)){fail(new Error('Duplicate desktop request identifier.'));return;}
    if(inFlight.size>=(options.maxInFlight??32)){void write({type:'response',id:frame.id,data:{ok:false,error:'Too many desktop requests are running.'}}).catch(fail);return;}
    invokeIds.add(frame.id);
    const operation=(async()=>{
      await ready;
      const data=stopping?{ok:false as const,error:'Desktop backend is shutting down.'}:await runtime!.invoke({name:frame.name,payload:frame.payload});
      await write({type:'response',id:frame.id,data});
    })();
    inFlight.add(operation);
    void operation.catch(async()=>{await write({type:'response',id:frame.id,data:{ok:false,error:'Desktop backend operation failed.'}}).catch(fail);}).finally(()=>{invokeIds.delete(frame.id);inFlight.delete(operation);});
  };
  const decoder=new FrameDecoder(dispatch);
  function onData(chunk:Buffer|string):void {try{decoder.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));}catch(error){fail(error instanceof Error?error:new Error('Pipe failure.'));}}
  function onEnd():void {try{decoder.finish();}catch(error){options.onFatal?.(error as Error);}void close().catch(fail);}
  input.on('data',onData);input.once('end',onEnd);input.once('error',fail);output.on('error',fail);
  void ready.catch(fail);
  return{done,close};
}
