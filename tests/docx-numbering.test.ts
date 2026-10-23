import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocx } from '../src/core/documents';
import { AppStore } from '../src/core/storage';
import type { ChangeProposal } from '../src/shared/changes';
import type { ReviewResult, ReviewTask, ReviewContext } from '../src/shared/contracts';
import { runProgramChecks } from '../src/core/program-checks';
import { createDocx, escapeXml } from './fixtures-documents';
const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const paragraph = (text: string, numId = 1, level = 0, extra = '') => `<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>${extra}</w:pPr><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>`;
const lvl = (level = 0, format = 'decimal', text = '%1.', start = 1, extra = '') => `<w:lvl w:ilvl="${level}"><w:start w:val="${start}"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${escapeXml(text)}"/>${extra}</w:lvl>`;
async function fixture(body: string, definitions: string, styles = '') {
  return createDocx({ rawBody: body, extraFiles: {
    'word/numbering.xml': `<w:numbering xmlns:w="${ns}">${definitions}</w:numbering>`,
    'word/styles.xml': `<w:styles xmlns:w="${ns}">${styles}</w:styles>`,
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="n" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
  } });
}
const definition = (levels: string, extra = '') => `<w:abstractNum w:abstractNumId="0">${levels}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/>${extra}</w:num>`;

test('直接自动编号的起点、独立实例和 startOverride 还原为元数据，不拼入原文', async () => {
  const defs = definition(lvl(0, 'decimal', 'Article %1', 3)) + '<w:num w:numId="2"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="10"/></w:lvlOverride></w:num>';
  const parsed = await parseDocx(await fixture(paragraph('服务范围') + paragraph('付款事项') + paragraph('独立编号', 2) + paragraph('验收事项'), defs));
  assert.deepEqual(parsed.blocks.map(block => block.numberingLabel), ['Article 3', 'Article 4', 'Article 10', 'Article 5']); assert.deepEqual(parsed.blocks.map(block => block.text), ['服务范围', '付款事项', '独立编号', '验收事项']); assert.equal(parsed.partial, false);
  const escaped = await parseDocx(await fixture(paragraph('内容'),definition(lvl(0,'decimal','Article %1 & related')))); assert.equal(escaped.blocks[0].numberingLabel,'Article 1 & related');
});

test('多级父编号、默认子级重启与 lvlRestart 零持续计数具有确定顺序', async () => {
  const body = paragraph('第一组') + paragraph('第一项',1,1) + paragraph('第二项',1,1) + paragraph('第二组') + paragraph('第三项',1,1);
  const restarted = await parseDocx(await fixture(body, definition(lvl(0,'decimal','%1.',2) + lvl(1,'lowerLetter','%1.%2)',1)))); assert.deepEqual(restarted.blocks.map(block => block.numberingLabel), ['2.','2.a)','2.b)','3.','3.a)']);
  const continuous = await parseDocx(await fixture(body, definition(lvl(0,'decimal','%1.',2) + lvl(1,'decimalZero','%1.%2',1,'<w:lvlRestart w:val="0"/>')))); assert.deepEqual(continuous.blocks.map(block => block.numberingLabel), ['2.','2.01','2.02','3.','3.03']);
});

test('中文计数、罗马数、完整 levelOverride 和 legal 编号格式不会混淆', async () => {
  const chinese = await parseDocx(await fixture(paragraph('条款内容') + paragraph('下一条款'), definition(lvl(0,'chineseCounting','第%1条',10)))); assert.deepEqual(chinese.blocks.map(block => block.numberingLabel), ['第十条','第十一条']);
  const override = '<w:lvlOverride w:ilvl="0">' + lvl(0,'upperRoman','%1)',4) + '</w:lvlOverride>';
  const roman = await parseDocx(await fixture(paragraph('条款内容') + paragraph('下一条款'), definition(lvl(),override))); assert.deepEqual(roman.blocks.map(block => block.numberingLabel), ['IV)','V)']);
  const legal = await parseDocx(await fixture(paragraph('父条款') + paragraph('子条款',1,1), definition(lvl(0,'upperLetter','%1.',2) + lvl(1,'lowerRoman','%1.%2',3,'<w:isLgl/>')))); assert.deepEqual(legal.blocks.map(block => block.numberingLabel), ['B.','2.3']);
});

test('样式 basedOn 和 abstract level 的 pStyle 绑定支持继承，并尊重直接 numId 零停用', async () => {
  const styles = '<w:style w:type="paragraph" w:styleId="Base"><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Child"><w:basedOn w:val="Base"/></w:style>';
  const styled = (text: string, direct = '') => `<w:p><w:pPr><w:pStyle w:val="Child"/>${direct}</w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const body = paragraph('总条款') + styled('子条款') + styled('无编号正文','<w:numPr><w:numId w:val="0"/></w:numPr>') + styled('下一子条款');
  const parsed = await parseDocx(await fixture(body,definition(lvl(0,'decimal','%1.',1) + lvl(1,'decimal','%1.%2',1,'<w:pStyle w:val="Base"/>')),styles)); assert.equal(parsed.partial,false); assert.deepEqual(parsed.blocks.map(block => block.numberingLabel),['1.','1.1',undefined,'1.2']);
});

test('空编号段落仍推进计数，已删除段落不参与当前显示编号', async () => {
  const parsed = await parseDocx(await fixture(paragraph('首条') + paragraph('') + '<w:del>'+paragraph('旧条款')+'</w:del>' + paragraph('末条'),definition(lvl()))); assert.deepEqual(parsed.blocks.map(block => block.text),['首条','末条']); assert.deepEqual(parsed.blocks.map(block => block.numberingLabel),['1.','3.']); assert.equal(parsed.partial,true);
});

test('缺失、冲突、链接样式和不支持编号明确标部分解析，不臆造条号', async () => {
  for (const defs of [definition(lvl(0,'bullet','•',1)), definition('<w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>'), definition(lvl()+lvl()), definition(lvl(0,'decimal','%2.')), '<w:abstractNum w:abstractNumId="0"><w:numStyleLink w:val="Linked"/>'+lvl()+'</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>', definition(lvl())+'<w:num w:numId="1"><w:abstractNumId w:val="8"/></w:num>']) {
    const parsed = await parseDocx(await fixture(paragraph('条款文字'),defs)); assert.equal(parsed.partial,true); assert.equal(parsed.blocks[0].numberingLabel,undefined); assert.ok(parsed.warnings.some(item=>item.includes('自动编号'))); assert.equal(parsed.blocks[0].text,'条款文字');
  }
  const missing=await parseDocx(await createDocx({rawBody:paragraph('无编号部件')})); assert.equal(missing.partial,true); assert.equal(missing.blocks[0].numberingLabel,undefined);
});

test('样式环、父级缺失与未知名字空间不会产生可靠条号',async()=>{
  const styles='<w:style w:type="paragraph" w:styleId="A"><w:basedOn w:val="B"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="B"><w:basedOn w:val="A"/></w:style>';
  const cycle=await parseDocx(await fixture('<w:p><w:pPr><w:pStyle w:val="A"/></w:pPr><w:r><w:t>条款</w:t></w:r></w:p>',definition(lvl()),styles));assert.equal(cycle.partial,true);assert.equal(cycle.blocks[0].numberingLabel,undefined);
  const noParent=await parseDocx(await fixture(paragraph('子条款',1,1),definition(lvl()+lvl(1,'decimal','%1.%2',1))));assert.equal(noParent.partial,true);assert.equal(noParent.blocks[0].numberingLabel,undefined);
  const wrongNamespace = await parseDocx(await createDocx({ rawBody: paragraph('条款文字'), extraFiles: { 'word/numbering.xml':'<w:numbering xmlns:w="urn:unknown">'+definition(lvl())+'</w:numbering>', 'word/_rels/document.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="n" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>' } })); assert.equal(wrongNamespace.partial,true); assert.equal(wrongNamespace.blocks[0].numberingLabel,undefined);
  const foreignProps = await parseDocx(await fixture(paragraph('普通正文').replace('<w:numPr>','<w:numPr xmlns:w="urn:unknown">'),definition(lvl()))); assert.equal(foreignProps.blocks[0].numberingLabel,undefined);
});

test('程序条款引用使用真实自动条号，存储和修改稿版本保留标签而原文字及哈希不变',async()=>{
  const bytes=await fixture(paragraph('交付条款')+paragraph('付款条款')+'<w:p><w:r><w:t>按本合同第二条履行。</w:t></w:r></w:p>',definition(lvl(0,'chineseCounting','第%1条',1)));const parsed=await parseDocx(bytes);const checks=runProgramChecks({blocks:parsed.blocks,partial:parsed.partial},{checks:{amounts:false,dates:false,references:true},thresholds:{maxPrepaymentPercent:null,maxPaymentDays:null}});assert.ok(!checks.issues.some(item=>item.title.includes('条款引用')));
  const folder=await mkdtemp(join(tmpdir(),'law-numbering-store-'));let store=await AppStore.open(folder);const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');try{
    const id=randomUUID();const doc=await store.addDocument(id,'合成自动编号.docx',`documents/${id}/original.docx`,bytes.length,hash(bytes),parsed);assert.equal(doc.blocks[1].numberingLabel,'第二条');assert.deepEqual(doc.blocks[1].locator,parsed.blocks[1].locator);const row=store.rows('SELECT original_text,text_sha256,locator_json FROM document_blocks WHERE id=?',[doc.blocks[1].id])[0];assert.equal(row.original_text,'付款条款');assert.equal(row.text_sha256,hash('付款条款'));assert.equal(JSON.parse(String(row.locator_json)).numberingLabel,'第二条');
    const context:ReviewContext={contractType:'service',ourPartyRole:'service_recipient',strictness:'balanced',businessContext:'合成工程样本'};const task:ReviewTask={id:randomUUID(),documentId:id,status:'queued',stage:'工程测试',startedAt:new Date().toISOString(),finishedAt:null,resultId:null,error:null};const runId=await store.createTask(task,context,'local',null,null);const review:ReviewResult={id:randomUUID(),documentId:id,createdAt:new Date().toISOString(),mode:'local',modelId:null,summary:'合成审核',context,findings:[],coverage:{reviewedBlockIds:doc.blocks.map(b=>b.id),totalBlockCount:doc.blocks.length,knowledgeStatus:'user_disabled',webStatus:'user_disabled',limitations:[]},inputTokens:null,outputTokens:null,elapsedMs:0};await store.saveReview(review,runId);
    const block=doc.blocks[1],proposal:ChangeProposal={id:randomUUID(),reviewId:review.id,documentId:id,findingId:null,blockId:block.id,rangeStart:0,rangeEnd:block.text.length,originalText:block.text,replacementText:'修订付款条款',sourceFileSha256:hash(bytes),originalTextSha256:hash(block.text),status:'proposed',explanation:'工程修订',warnings:[],modelId:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};await store.saveChangeProposal(proposal,0);await store.decideChangeProposal(review.id,proposal.id,'accepted',1);
    const revisedBytes=await fixture(paragraph('交付条款')+paragraph('修订付款条款')+'<w:p><w:r><w:t>按本合同第二条履行。</w:t></w:r></w:p>',definition(lvl(0,'chineseCounting','第%1条',1))),revised=await parseDocx(revisedBytes),newId=randomUUID();await store.addChangeExport({id:randomUUID(),reviewId:review.id,expectedRevision:2,documentId:newId,artifactUri:`documents/${newId}/modified.docx`,sha256:hash(revisedBytes),byteSize:revisedBytes.length,parsed:revised,proposals:store.getChangeProposals(review.id),changeList:'合成清单'});assert.equal(store.getDocument(newId).blocks[1].numberingLabel,'第二条');assert.equal(store.getDocument(newId).blocks[1].text,'修订付款条款');await store.close();store=await AppStore.open(folder);assert.equal(store.getDocument(id).blocks[1].numberingLabel,'第二条');assert.equal(store.getDocument(newId).blocks[1].numberingLabel,'第二条');
  }finally{await store.close();await rm(folder,{recursive:true,force:true});}
});
