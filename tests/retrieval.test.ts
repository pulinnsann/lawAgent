import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, writeFile, readFile, readdir, symlink, truncate, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { defaultRetrievalConfig, type ContractDetail, type PublicRetrievalConfig, type ReviewContext, type SourceEvidence } from '../src/shared/contracts';
import { FOLDER_LIMITS, extractPageText, hydrateWebEvidence, retrieveContext, retrievalTopics, validateRetrievalConfig } from '../src/core/retrieval';
import { createRetrievalHttp, isPublicAddress, RetrievalError, type PinnedRequest } from '../src/core/retrieval-http';
import { createDocx, createPdf } from './fixtures-documents';

const context: ReviewContext = { contractType: 'service', ourPartyRole: 'service_recipient', strictness: 'balanced', businessContext: '不可外传的客户名称 SecretCompany987；金额99999888' };
const document: ContractDetail = { id: 'doc', name: '不应外发的合同名', format: 'docx', language: 'mixed', byteSize: 100, blockCount: 1,
  importedAt: '2026-10-22T00:00:00Z', warnings: [], partial: false, latestReviewId: null, reviews: [], blocks: [{
    id: 'block', ordinal: 0, kind: 'paragraph', text: 'SecretCompany987 paid 99999888. 付款 payment ชำระเงิน，验收 acceptance ตรวจรับ，违约 liability ความรับผิด。',
    locator: { kind: 'docx', partName: 'word/document.xml', structuralPath: '/p[1]', paragraphId: null },
  }] };
const signal = () => new AbortController().signal;
const keys = { knowledgeApiKey: null, webApiKey: null };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

async function mockService(handler: (request: IncomingMessage, response: ServerResponse, body: any) => void | Promise<void>) {
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    await handler(request, response, body ? JSON.parse(body) : null);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, async close() { const close = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await close; } };
}
function reply(response: ServerResponse, body: unknown, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); }
function webConfig(url: string, provider: 'brave' | 'searxng' = 'searxng'): PublicRetrievalConfig { const config = defaultRetrievalConfig(); config.web = { ...config.web, enabled: true, provider, baseUrl: url, fetchPages: false }; return config; }
function knowledgeConfig(url: string, provider: 'dify' | 'standard' = 'standard'): PublicRetrievalConfig { const config = defaultRetrievalConfig(); config.knowledge.enabled = true; config.knowledge.api = { ...config.knowledge.api, enabled: true, provider, baseUrl: url, collectionId: 'dataset-1' }; return config; }

test('配置规范化、严格URL策略和输出密钥剥离', () => {
  const raw = defaultRetrievalConfig();
  const result = validateRetrievalConfig({ ...raw, knowledge: { ...raw.knowledge, api: { ...raw.knowledge.api, apiKey: 'knowledge-secret' } }, web: { ...raw.web, apiKey: 'web-secret' } });
  assert.equal(result.web.hasApiKey, true); assert.equal(result.knowledge.api.hasApiKey, true);
  assert.ok(!JSON.stringify(result).includes('web-secret')); assert.ok(!JSON.stringify(result).includes('knowledge-secret'));
  for (const url of ['http://example.com/v1','https://user:pw@example.com/v1','https://example.com/v1?key=secret','https://example.com/v1#']) {
    assert.throws(() => validateRetrievalConfig(webConfig(url)), RetrievalError);
  }
  assert.deepEqual(validateRetrievalConfig({ ...raw, web: { ...raw.web, allowedDomains: [] } }).web.allowedDomains, ['gov.cn','npc.gov.cn','court.gov.cn']);
});

test('父通道关闭时允许保留API开启标记和空地址，关闭Brave快照仍可保存且不检索',async()=>{
  const config=defaultRetrievalConfig(); config.knowledge.enabled=false;
  config.knowledge.api={...config.knowledge.api,enabled:true,baseUrl:'',collectionId:''};
  config.web={...config.web,enabled:false,provider:'brave',baseUrl:''};
  const saved=validateRetrievalConfig(config); assert.equal(saved.knowledge.api.baseUrl,''); assert.equal(saved.knowledge.api.enabled,true);
  const result=await retrieveContext(document,context,saved,keys,signal(),()=>{});
  assert.equal(result.knowledgeStatus,'user_disabled'); assert.equal(result.webStatus,'user_disabled'); assert.equal(result.attempts.length,0);
});

test('启用Dify或standard都必须明确集合，空集合在发出请求前拒绝',async t=>{
  let requests=0; const service=await mockService((_request,response)=>{requests++;reply(response,{});}); t.after(()=>service.close());
  for(const provider of ['dify','standard'] as const){
    const config=knowledgeConfig(service.url,provider); config.knowledge.api.collectionId='  ';
    assert.throws(()=>validateRetrievalConfig(config),/明确的集合/);
    await assert.rejects(retrieveContext(document,context,config,keys,signal(),()=>{}),/不允许跨全部知识库/);
  }
  assert.equal(requests,0);
});

test('中英泰只映射为预定义主题，搜索词不含合同/业务原文、公司名或金额', () => {
  const planned = retrievalTopics(document, context);
  assert.match(planned.query, /付款价款/); assert.match(planned.query, /交付验收/);
  assert.equal(planned.webQueries.length, 2);
  assert.deepEqual(planned.webQueries.map(value => value.kind), ['statute','case']);
  for (const value of planned.webQueries) {
    assert.ok(!value.query.includes('SecretCompany987')); assert.ok(!value.query.includes('99999888')); assert.ok(!value.query.includes('paid'));
  }
});

test('资料文件夹只读扫描TXT/MD/DOCX/PDF、保留原文定位且跳过符号链接', async t => {
  const folder = await mkdtemp(join(tmpdir(),'law-retrieval-folder-'));
  const outside = await mkdtemp(join(tmpdir(),'law-retrieval-outside-'));
  t.after(async () => { await rm(folder,{recursive:true,force:true}); await rm(outside,{recursive:true,force:true}); });
  const originals = new Map<string,Buffer>();
  originals.set('制度.txt', Buffer.from('第一行\n合同付款应核对验收条件。'));
  originals.set('guide.md', Buffer.from('# Policy\nContract payment acceptance conditions.'));
  originals.set('条款.docx', await createDocx({ paragraphs: ['合同付款与验收条款。'] }));
  originals.set('policy.pdf', createPdf([['Contract payment and acceptance.']]));
  for (const [name,bytes] of originals) await writeFile(join(folder,name),bytes);
  await writeFile(join(outside,'secret.txt'),'合同 outside-secret-never-read');
  await symlink(join(outside,'secret.txt'),join(folder,'linked.txt'));
  const before = (await readdir(folder)).sort(); const config = defaultRetrievalConfig();
  config.knowledge.enabled = true; config.knowledge.folderPath = folder; config.maxResults = 8;
  const result = await retrieveContext(document, context, config, keys, signal(), () => {});
  assert.equal(result.attempts[0].provider,'folder'); assert.equal(result.attempts[0].status,'complete');
  assert.equal(result.knowledgeStatus,'partial');
  assert.equal(result.evidence.length,4);
  assert.ok(result.attempts[0].warnings.some(warning => warning.includes('符号链接')));
  assert.ok(result.evidence.every(source => source.sourceUri?.startsWith('file:') && source.locator && source.currentness === 'unknown' && source.publishedAt === null && source.excerptSha256 === digest(source.excerpt)));
  assert.ok(!JSON.stringify(result).includes('outside-secret-never-read'));
  assert.deepEqual((await readdir(folder)).sort(),before);
  for (const [name,bytes] of originals) assert.deepEqual(await readFile(join(folder,name)),bytes);
});

test('资料资源上限显式记录缺口，不读取超限文件或链接目录', async t => {
  const folder = await mkdtemp(join(tmpdir(),'law-retrieval-limits-')); t.after(() => rm(folder,{recursive:true,force:true}));
  await writeFile(join(folder,'large.txt'),''); await truncate(join(folder,'large.txt'),FOLDER_LIMITS.fileBytes+1);
  const config = defaultRetrievalConfig(); config.knowledge.enabled = true; config.knowledge.folderPath = folder;
  const result = await retrieveContext(document,context,config,keys,signal(),()=>{});
  assert.equal(result.knowledgeStatus,'partial'); assert.equal(result.evidence.length,0);
  assert.ok(result.attempts[0].warnings.some(warning => warning.includes('跳过')));
});

test('standard真实API先检索后回读，原文不冒充摘要且认证仅在指定端点', async t => {
  const calls: string[] = [];
  const service = await mockService((request,response,body) => {
    calls.push(request.url!); assert.equal(request.headers.authorization,'Bearer test-knowledge-key');
    if (request.url === '/v1/search') { assert.equal(body.queryLanguage,'zh'); assert.deepEqual(body.collectionIds,['dataset-1']);
      reply(response,{status:'complete',candidates:[{externalSourceId:'source-1',fragmentId:'fragment-1',title:'付款制度',snippet:'付款摘要',sourceUri:'https://kb.example.com/doc/1',locator:{page:1},sourceVersion:'v1'}]});
    } else { assert.equal(request.url,'/v1/sources/read'); assert.equal(body.externalSourceId,'source-1'); assert.equal(body.expectedVersion,'v1');
      reply(response,{externalSourceId:'source-1',sourceUri:'https://kb.example.com/doc/1',content:'合同付款须核对约定条件。',contentScope:'fragment',locator:{page:1}}); }
  }); t.after(()=>service.close());
  const result = await retrieveContext(document,context,knowledgeConfig(`${service.url}/v1`),{...keys,knowledgeApiKey:'test-knowledge-key'},signal(),()=>{});
  assert.deepEqual(calls,['/v1/search','/v1/sources/read']); assert.equal(result.knowledgeStatus,'complete');
  assert.equal(result.evidence[0].contentScope,'fragment'); assert.equal(result.evidence[0].excerpt,'合同付款须核对约定条件。');
  assert.ok(!JSON.stringify(result).includes('test-knowledge-key'));
});

test('standard回读失败保留摘要、partial及未核实状态', async t => {
  const service = await mockService((request,response) => {
    if (request.url === '/v1/search') reply(response,{status:'complete',candidates:[{externalSourceId:'source-1',snippet:'合同付款摘要',title:'候选'}]});
    else reply(response,{error:'sensitive server body'},500);
  }); t.after(()=>service.close());
  const result = await retrieveContext(document,context,knowledgeConfig(service.url),keys,signal(),()=>{});
  assert.equal(result.knowledgeStatus,'partial'); assert.equal(result.evidence[0].contentScope,'search_snippet');
  assert.ok(!JSON.stringify(result).includes('sensitive server body'));
});

test('Dify使用正式数据集retrieve协议且原文片段不声称全文', async t => {
  const service = await mockService((request,response,body) => {
    assert.equal(request.url,'/v1/datasets/dataset-1/retrieve'); assert.equal(request.headers.authorization,'Bearer test-dify-key');
    assert.equal(body.retrieval_model.top_k,4); assert.ok(!body.query.includes('SecretCompany987'));
    reply(response,{query:{content:body.query},records:[{segment:{id:'segment-1',document_id:'doc-1',position:2,content:'合同付款必须符合公司内部流程。',document:{id:'doc-1',name:'制度.docx'}}}]});
  }); t.after(()=>service.close());
  const result = await retrieveContext(document,context,knowledgeConfig(`${service.url}/v1`,'dify'),{...keys,knowledgeApiKey:'test-dify-key'},signal(),()=>{});
  assert.equal(result.knowledgeStatus,'complete'); assert.equal(result.attempts[0].provider,'dify');
  assert.equal(result.evidence[0].contentScope,'fragment'); assert.match(result.evidence[0].locator,/segment-1/);
  assert.equal(result.evidence[0].publishedAt,null); assert.equal(result.evidence[0].currentness,'unknown');
});

test('SearXNG两类真实查询、固定主题、真实域名过滤，保留摘要来源', async t => {
  const queries: string[] = [];
  const service = await mockService((request,response) => {
    const url = new URL(request.url!,'http://test'); const query = url.searchParams.get('q')!; queries.push(query);
    assert.equal(request.headers.authorization,'Bearer test-search-key'); assert.equal(url.searchParams.get('language'),'zh-CN');
    assert.ok(query.includes('site:court.gov.cn')); assert.ok(!query.includes('SecretCompany987')); assert.ok(!query.includes('99999888'));
    reply(response,{results:[{title:'官方资料',url:`https://www.court.gov.cn/${query.includes('案例')?'case':'law'}`,content:'合同相关资料摘要'},
      {title:'伪造相似域名',url:'https://court.gov.cn.evil.test/page',content:'不允许'}, {title:'HTTP不允许',url:'http://court.gov.cn/page',content:'不允许'}]});
  }); t.after(()=>service.close());
  const result = await retrieveContext(document,context,webConfig(`${service.url}/search`),{...keys,webApiKey:'test-search-key'},signal(),()=>{});
  assert.equal(queries.length,2); assert.ok(queries.some(query=>query.includes('法律法规'))); assert.ok(queries.some(query=>query.includes('典型案例')));
  assert.equal(result.evidence.length,2); assert.ok(result.evidence.every(source=>source.contentScope==='search_snippet' && source.isOfficial));
  assert.ok(result.evidence.every(source=>source.kind==='commentary'));
  assert.equal(result.webStatus,'partial'); assert.ok(!JSON.stringify(result).includes('test-search-key'));
});

test('SearXNG JSON协议与folder/API同时启用，API失败不取消其他结果', async t => {
  const folder = await mkdtemp(join(tmpdir(),'law-retrieval-concurrent-')); t.after(()=>rm(folder,{recursive:true,force:true}));
  await writeFile(join(folder,'policy.txt'),'合同付款验收制度');
  const service = await mockService((request,response) => {
    const url = new URL(request.url!,'http://test');
    if (url.pathname==='/v1/search') reply(response,{error:'do not show'},503);
    else { assert.equal(url.pathname,'/search'); assert.equal(url.searchParams.get('format'),'json'); reply(response,{results:[{title:'法院案例',url:'https://www.court.gov.cn/case',content:'合同案例摘要'}]}); }
  }); t.after(()=>service.close());
  const config = knowledgeConfig(service.url); config.knowledge.folderPath=folder; config.web={...webConfig(service.url).web};
  const result = await retrieveContext(document,context,config,keys,signal(),()=>{});
  assert.equal(result.attempts.length,4); assert.equal(result.knowledgeStatus,'partial'); assert.equal(result.webStatus,'complete');
  assert.ok(result.attempts.some(attempt=>attempt.provider==='standard' && attempt.status==='failed'));
  assert.ok(result.evidence.some(source=>source.channel==='knowledge')); assert.ok(result.evidence.some(source=>source.channel==='web'));
  assert.ok(result.limitations.some(value=>value.includes('独立来源数量')));
});

test('分支总预算停止连续回读，保留已返回候选并区分timeout与用户取消', async t => {
  let notify!:()=>void; const readStarted=new Promise<void>(resolve=>{notify=resolve;});
  const service=await mockService((request,response)=>{
    if(request.url==='/v1/search') reply(response,{status:'complete',candidates:[1,2,3].map(index=>({externalSourceId:`source-${index}`,title:'资料',snippet:'合同付款摘要'}))});
    else notify();
  }); t.after(()=>service.close());
  t.mock.timers.enable({apis:['setTimeout']});
  const config=knowledgeConfig(service.url); config.timeoutSeconds=5;
  const pending=retrieveContext(document,context,config,keys,signal(),()=>{});
  await readStarted; t.mock.timers.tick(10001);
  const result=await pending;
  assert.equal(result.attempts[0].status,'timeout'); assert.equal(result.knowledgeStatus,'partial');
  assert.equal(result.evidence.length,1); assert.equal(result.evidence[0].contentScope,'search_snippet');
  assert.match(result.attempts[0].error!,/总时间预算/);
});

test('服务返回的警告和片段不能将已知配置密钥回显到bundle', async t=>{
  const key='standard-ephemeral-secret-for-test';
  const service=await mockService((request,response)=>{
    if(request.url==='/v1/search') reply(response,{status:'complete',warnings:[`provider echoed ${key}`],candidates:[{externalSourceId:'one',title:`合同 ${key}`,snippet:`付款摘要 ${key}`,sourceUri:`https://kb.example.com/?q=${key}`}]});
    else reply(response,{error:'failed'},500);
  }); t.after(()=>service.close());
  const result=await retrieveContext(document,context,knowledgeConfig(service.url),{...keys,knowledgeApiKey:key},signal(),()=>{});
  assert.ok(!JSON.stringify(result).includes(key)); assert.equal(result.evidence[0].sourceUri,null);
  assert.equal(result.evidence[0].excerptSha256,digest(result.evidence[0].excerpt));
});

test('取消保留已完成通道及其证据，未完成通道记录cancelled', async t => {
  let notify!:()=>void; const waiting = new Promise<void>(resolve=>{notify=resolve;});
  const folder=await mkdtemp(join(tmpdir(),'law-retrieval-cancel-')); t.after(()=>rm(folder,{recursive:true,force:true}));
  await writeFile(join(folder,'policy.txt'),'合同付款验收制度');
  const service=await mockService(()=>{notify();}); t.after(()=>service.close());
  const config=webConfig(service.url); config.knowledge.enabled=true; config.knowledge.folderPath=folder;
  const controller=new AbortController();
  const pending=retrieveContext(document,context,config,keys,controller.signal,()=>{});
  await waiting; await new Promise(resolve=>setTimeout(resolve,30)); controller.abort();
  const result=await pending;
  assert.ok(result.evidence.some(source=>source.channel==='knowledge'));
  assert.equal(result.knowledgeStatus,'complete'); assert.equal(result.webStatus,'cancelled');
  assert.ok(result.attempts.filter(attempt=>attempt.channel==='web').every(attempt=>attempt.status==='cancelled'));
});

test('未启用通道不伪造attempt，无key的Dify不静默mock', async () => {
  const disabled=await retrieveContext(document,context,defaultRetrievalConfig(),keys,signal(),()=>{});
  assert.equal(disabled.knowledgeStatus,'user_disabled'); assert.equal(disabled.attempts.length,0);
  const config=knowledgeConfig('https://api.dify.ai/v1','dify');
  const result=await retrieveContext(document,context,config,keys,signal(),()=>{});
  assert.equal(result.knowledgeStatus,'failed'); assert.equal(result.evidence.length,0);
});

test('Brave暂缓配置明确拒绝且不发送任何请求', async t=>{
  let requests=0; const service=await mockService((_request,response)=>{requests++;reply(response,{});}); t.after(()=>service.close());
  const config=webConfig(service.url,'brave');
  assert.throws(()=>validateRetrievalConfig(config),/Brave Search 已暂缓，请选择 SearXNG/);
  await assert.rejects(retrieveContext(document,context,config,{...keys,webApiKey:'unused-brave-key'},signal(),()=>{}),/已暂缓/);
  assert.equal(requests,0);
});

test('public IP策略拒绝私网、保留、映射与混合DNS；固定实际连接地址且网页无认证头', async () => {
  for (const address of ['127.0.0.1','10.0.0.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1','2002:7f00:1::']) assert.equal(isPublicAddress(address),false,address);
  assert.equal(isPublicAddress('8.8.8.8'),true);
  let transported: PinnedRequest|null=null; let lookups=0;
  const client=createRetrievalHttp({ resolve:async()=>{lookups++;return[{address:'8.8.8.8',family:4}];},transport:async(_url,input)=>{transported=input;return{body:Buffer.from('正文'),contentType:'text/plain',fetchedAt:'2026-10-22T01:00:00Z'};} });
  await client.page('https://www.court.gov.cn/page',signal(),5);
  assert.equal(lookups,1); assert.ok(transported); assert.equal((transported as PinnedRequest).address.address,'8.8.8.8');
  assert.equal((transported as PinnedRequest).headers.Authorization,undefined); assert.equal((transported as PinnedRequest).headers['X-Subscription-Token'],undefined);
  let called=false; const mixed=createRetrievalHttp({resolve:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}],transport:async()=>{called=true;throw new Error('unreachable');}});
  await assert.rejects(mixed.page('https://example.com',signal(),5),/已阻止/); assert.equal(called,false);
  await assert.rejects(client.page('http://www.court.gov.cn/page',signal(),5),/HTTPS/);
});

test('配置端点HTTP协议真实禁止重定向、限制大小、区分timeout且不回显错误正文', async t => {
  let requestCount=0;
  const server=await mockService((request,response)=>{
    requestCount++;
    if(request.url==='/redirect'){response.writeHead(302,{location:'/secret-target'});response.end();}
    else if(request.url==='/large'){response.writeHead(200,{'Content-Length':3000000});response.end('x');}
    else if(request.url==='/error') reply(response,{error:'private-secret-server-body'},500);
  }); t.after(()=>server.close()); const client=createRetrievalHttp();
  await assert.rejects(client.json(`${server.url}/redirect`,{signal:signal(),timeoutSeconds:1}),/重定向/); assert.equal(requestCount,1);
  await assert.rejects(client.json(`${server.url}/large`,{signal:signal(),timeoutSeconds:1}),/上限/);
  await assert.rejects(client.json(`${server.url}/error`,{signal:signal(),timeoutSeconds:1}),error=>error instanceof RetrievalError && !error.message.includes('private-secret'));
  await assert.rejects(client.json(`${server.url}/wait`,{signal:signal(),timeoutSeconds:0.05}),error=>error instanceof RetrievalError && error.code==='timeout');
});

test('网页解码支持meta GB2312/GBK，移除脚本样式导航，不将无法识别字节作为原文', async () => {
  const body=Buffer.concat([Buffer.from('<html><meta charset="gb2312"><nav>omit-nav</nav><script>alert(1)</script><style>omit-style</style><p>'),Buffer.from([0xba,0xcf,0xcd,0xac]),Buffer.from('</p></html>')]);
  const text=extractPageText({body,contentType:'text/html',fetchedAt:'2026-10-22T01:00:00Z'});
  assert.equal(text,'合同');
  assert.throws(()=>extractPageText({body:Buffer.from([0xff,0xfe,0xff]),contentType:'text/html',fetchedAt:''}),/编码/);
});

test('网页读取失败保留原搜索摘要与hash，成功才更新实际抓取时间及原文范围', async () => {
  const source:SourceEvidence={id:'e',attemptId:'a',channel:'web',kind:'case',title:'案例',sourceUri:'https://www.court.gov.cn/case',locator:'摘要',excerpt:'搜索摘要',excerptSha256:digest('搜索摘要'),contentScope:'search_snippet',retrievedAt:'2026-10-22T00:00:00Z',publishedAt:null,effectiveAt:null,currentness:'unknown',isOfficial:true,warnings:[]};
  assert.equal(await hydrateWebEvidence(source,signal(),5,async()=>{throw new RetrievalError('failed','blocked');}),false);
  assert.equal(source.contentScope,'search_snippet'); assert.equal(source.excerpt,'搜索摘要'); assert.equal(source.excerptSha256,digest('搜索摘要'));
  assert.equal(await hydrateWebEvidence(source,signal(),5,async()=>({body:Buffer.from('<p>原始页面正文</p>'),contentType:'text/html;charset=utf-8',fetchedAt:'2026-10-22T02:00:00Z'})),true);
  assert.equal(source.contentScope,'full_text'); assert.equal(source.retrievedAt,'2026-10-22T02:00:00Z'); assert.equal(source.currentness,'unknown');
});
