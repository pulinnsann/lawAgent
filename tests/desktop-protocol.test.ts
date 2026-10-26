import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { FrameDecoder, startDesktopProtocol } from '../src/desktop/protocol';
import type { BackendFrame, DesktopHost } from '../src/desktop/types';

const tick = () => new Promise<void>(resolve=>setImmediate(resolve));
function pipes() {
  const input=new PassThrough();const output=new PassThrough();const frames:BackendFrame[]=[];let text='';
  output.on('data',chunk=>{text+=chunk.toString('utf8');let end:number;while((end=text.indexOf('\n'))>=0){frames.push(JSON.parse(text.slice(0,end)));text=text.slice(end+1);}});
  const send=(value:unknown)=>input.write(`${JSON.stringify(value)}\n`);
  return{input,output,frames,send};
}
async function until(predicate:()=>boolean):Promise<void>{for(let n=0;n<100;n++){if(predicate())return;await tick();}assert.fail('Expected desktop protocol event.');}

test('desktop pipe handles fragmented multilingual UTF-8 and rejects invalid or oversized envelopes',()=>{
  const frames:unknown[]=[];const decoder=new FrameDecoder(frame=>frames.push(frame));
  const bytes=Buffer.from(`${JSON.stringify({type:'invoke',id:'a',name:'searchKnowledge',payload:{query:'合同 ไทย 😀'}})}\n`);
  for(const value of bytes)decoder.push(Buffer.from([value]));decoder.finish();
  assert.equal((frames[0] as any).payload.query,'合同 ไทย 😀');
  assert.throws(()=>new FrameDecoder(()=>{},10).push(Buffer.from('x'.repeat(11))),/byte limit/u);
  assert.throws(()=>new FrameDecoder(()=>{}).push(Buffer.from('{"type":"invoke","id":"a","name":"bad","extra":true}\n')),/envelope/u);
  assert.throws(()=>{const partial=new FrameDecoder(()=>{});partial.push(Buffer.from('{'));partial.finish();},/Truncated/u);
  assert.throws(()=>new FrameDecoder(()=>{}).push(Buffer.from([255,10])),/UTF-8/u);
});

test('native host replies and cancellation remain live while an invoke awaits a dialog',async()=>{
  const p=pipes();let host!:DesktopHost;let closed=0;
  const session=startDesktopProtocol(p.input,p.output,async value=>{host=value;return{
    invoke:async envelope=>{
      const name=(envelope as any).name;
      return{ok:true,data:name==='dialog'?await host.call('showOpenDialog',{title:'Import'}):'cancelled'};
    },close:async()=>{closed++;},
  };});
  try{
    await until(()=>p.frames.some(frame=>frame.type==='ready'));
    p.send({type:'invoke',id:'a',name:'dialog'});
    await until(()=>p.frames.some(frame=>frame.type==='host'));
    p.send({type:'invoke',id:'b',name:'cancelReview'});
    await until(()=>p.frames.some(frame=>frame.type==='response'&&frame.id==='b'));
    const request=p.frames.find(frame=>frame.type==='host')! as Extract<BackendFrame,{type:'host'}>;
    p.send({type:'hostResponse',id:request.id,data:{canceled:true,filePaths:[]}});
    await until(()=>p.frames.some(frame=>frame.type==='response'&&frame.id==='a'));
    assert.deepEqual(p.frames.find(frame=>frame.type==='response'&&frame.id==='a'),{type:'response',id:'a',data:{ok:true,data:{canceled:true,filePaths:[]}}});
    p.send({type:'shutdown',id:'closing'});await session.done;
    assert.equal(closed,1);assert.ok(p.frames.some(frame=>frame.type==='shutdownComplete'&&frame.id==='closing'));
  }finally{await session.close();p.input.destroy();p.output.destroy();}
});

test('parent EOF cancels pending native dialogs, drains the invocation and closes storage',async()=>{
  const p=pipes();let closed=false;
  const session=startDesktopProtocol(p.input,p.output,async host=>({
    invoke:async()=>{try{return{ok:true,data:await host.call('showOpenDialog',{})};}catch{return{ok:false,error:'cancelled'};}},
    close:async()=>{closed=true;},
  }));
  await until(()=>p.frames.some(frame=>frame.type==='ready'));
  p.send({type:'invoke',id:'a',name:'importContract'});
  await until(()=>p.frames.some(frame=>frame.type==='host'));
  p.input.end();await session.done;assert.equal(closed,true);
  assert.ok(p.frames.some(frame=>frame.type==='response'&&frame.id==='a'));
  p.output.destroy();
});

test('invalid frames fail closed without echoing secret-bearing input',async()=>{
  const p=pipes();let closed=false;
  const session=startDesktopProtocol(p.input,p.output,async()=>({invoke:async()=>{assert.fail('Invalid input reached dispatch.');},close:async()=>{closed=true;}}));
  await until(()=>p.frames.some(frame=>frame.type==='ready'));
  p.input.write('{"secret":"do-not-echo"}\n');await session.done;
  assert.equal(closed,true);assert.ok(!JSON.stringify(p.frames).includes('do-not-echo'));
  p.input.destroy();p.output.destroy();
});

test('critical maintenance defers shutdown acknowledgement until its atomic work finishes',async()=>{
  const p=pipes();let release!:()=>void;const maintenance=new Promise<void>(resolve=>{release=resolve;});let closed=false;
  const session=startDesktopProtocol(p.input,p.output,async()=>({invoke:async()=>({ok:true,data:null}),isMaintenanceBusy:()=>true,close:async()=>{await maintenance;closed=true;}}));
  await until(()=>p.frames.some(frame=>frame.type==='ready'));
  p.send({type:'shutdown',id:'maintenance-shutdown'});
  await until(()=>p.frames.some(frame=>frame.type==='shutdownDeferred'));
  assert.equal(closed,false);assert.ok(!p.frames.some(frame=>frame.type==='shutdownComplete'));
  release();await session.done;
  assert.equal(closed,true);assert.ok(p.frames.some(frame=>frame.type==='shutdownComplete'&&frame.id==='maintenance-shutdown'));
  p.input.destroy();p.output.destroy();
});

test('a native host rejection becomes a bounded command result and the next command remains usable',async()=>{
  const p=pipes();
  const session=startDesktopProtocol(p.input,p.output,async host=>({invoke:async envelope=>{try{return{ok:true,data:(envelope as any).name==='credentials'?await host.call('credentialDecrypt',{base64:'synthetic'}):'still-ready'};}catch{return{ok:false,error:'System credential service unavailable.'};}},close:async()=>{}}));
  await until(()=>p.frames.some(frame=>frame.type==='ready'));
  p.send({type:'invoke',id:'a',name:'credentials'});await until(()=>p.frames.some(frame=>frame.type==='host'));
  const request=p.frames.find(frame=>frame.type==='host') as Extract<BackendFrame,{type:'host'}>;
  p.send({type:'hostResponse',id:request.id,error:'Native keyring unavailable.'});await until(()=>p.frames.some(frame=>frame.type==='response'&&frame.id==='a'));
  p.send({type:'invoke',id:'b',name:'getState'});await until(()=>p.frames.some(frame=>frame.type==='response'&&frame.id==='b'));
  assert.deepEqual(p.frames.find(frame=>frame.type==='response'&&frame.id==='b'),{type:'response',id:'b',data:{ok:true,data:'still-ready'}});
  await session.close();p.input.destroy();p.output.destroy();
});

test('closing during startup rejects already queued commands before they can start work',async()=>{
 for(let iteration=0;iteration<5;iteration++){
  const p=pipes();let release!:()=>void;const startup=new Promise<void>(resolve=>{release=resolve;});let invokes=0;let closes=0;
  const session=startDesktopProtocol(p.input,p.output,async()=>{await startup;return{invoke:async()=>{invokes++;return{ok:true,data:null};},close:async()=>{closes++;}};});
  p.send({type:'invoke',id:'queued',name:'loadSample'});
  const closing=session.close();release();await closing;
  assert.equal(invokes,0);assert.equal(closes,1);assert.ok(p.frames.some(frame=>frame.type==='response'&&frame.id==='queued'&&frame.data?.ok===false));
  p.input.destroy();p.output.destroy();
 }
});
