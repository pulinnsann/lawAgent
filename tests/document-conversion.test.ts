import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertPdfContent, normalizeConversionSettings, runConversionCommand, type ConversionAdapters } from '../src/core/document-conversion';
import { defaultConversionSettings, type ConversionResult, type ConversionStatus } from '../src/shared/document-conversion';
import { AppStore } from '../src/core/storage';
import { ContractService } from '../src/core/service';
import { WorkspaceAssets } from '../src/core/workspace-assets';
import { parseDocx } from '../src/core/documents';
import type { ParsedContract } from '../src/shared/contracts';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const parsed = (texts: Array<string | null>): ParsedContract => ({ format: 'pdf', language: 'mixed', blocks: texts.flatMap((text, index) => text ? [{ id: randomUUID(), ordinal: index, kind: 'paragraph' as const, text, locator: { kind: 'pdf' as const, pageIndex: index, pageWidth: 595, pageHeight: 842, boxes: [] } }] : []), warnings: [], pageCount: texts.length, partial: texts.some(text => !text) });
const input = (texts: Array<string | null>) => ({ sourceDocumentId: randomUUID(), sourceFileSha256: 'a'.repeat(64), sourceName: '工程PDF.pdf', parsed: parsed(texts), settings: defaultConversionSettings() });
const noOcr: ConversionAdapters = { createOcr: async () => { throw new Error('OCR should not run'); }, openRaster: async () => { throw new Error('raster should not run'); } };
async function fixture(texts: Array<string | null> = ['文本工程验证']) {
  const dir = await mkdtemp(join(tmpdir(), 'law-conversion-')); const store = await AppStore.open(dir); const service = new ContractService(store, dir); const assets = new WorkspaceAssets(store); const documentId = randomUUID();
  const folder = join(dir, 'documents', documentId); await mkdir(folder, { recursive: true }); const bytes = Buffer.from('%PDF-1.4\nsynthetic managed source metadata only');
  const file = join(folder, 'original.pdf'); await writeFile(file, bytes);
  const document = await store.addDocument(documentId, '合成源.pdf', `documents/${documentId}/original.pdf`, bytes.length, sha(bytes), parsed(texts));
  return { store, service, assets, dataDir: dir, document, file, bytes, close: async () => { await service.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('转换设置严格校验语言 页数 DPI 时间和未知字段', () => {
  assert.deepEqual(normalizeConversionSettings(defaultConversionSettings()), defaultConversionSettings());
  for (const extra of [{ languages: [] }, { languages: ['chi_sim', 'chi_sim'] }, { languages: ['jpn'] }, { mode: 'cloud' }, { maxPages: 101 }, { maxPages: 0 }, { dpi: 300 }, { pageTimeoutSeconds: 0 }, { endpoint: 'https://invalid' }]) assert.throws(() => normalizeConversionSettings({ ...defaultConversionSettings(), ...extra }));
});

test('文字 PDF 生成独立可编辑 DOCX 含原页码 SHA 和中英泰原文且不启动 OCR', async () => {
  const value = input(['中文工程付款条款。English terms. ข้อกำหนดภาษาไทย', '第二页条款。']); const original = JSON.stringify(value); const progress: string[] = [];
  const result = await convertPdfContent(value, noOcr, undefined, item => progress.push(item.stage));
  assert.equal(result.partial, false); assert.equal(result.sourceSnapshot.pages.length, 2); assert.ok(result.sourceSnapshot.pages.every(page => page.method === 'text')); assert.equal(result.sourceSnapshot.engine.ocr, null);
  assert.equal(result.sourceSnapshot.sourceFileSha256, value.sourceFileSha256); assert.ok(result.filename.endsWith('.docx')); assert.ok(progress.includes('completed'));
  const roundtrip = await parseDocx(Buffer.from(result.docxBase64, 'base64')); const text = roundtrip.blocks.map(block => block.text).join('\n');
  assert.ok(text.includes('原 PDF 第 1 页')); assert.ok(text.includes('原 PDF 第 2 页')); assert.ok(text.includes('ข้อกำหนดภาษาไทย')); assert.ok(text.includes(value.sourceFileSha256)); assert.ok(text.includes('未复刻 PDF 版式'));
  assert.equal(JSON.stringify(value), original);
});

test('扫描页按顺序本机渲染识别并保存置信度，工作器仅创建一个并释放', async () => {
  let created = 0, opened = 0, closed = 0, rasterClosed = 0; const rendered: number[] = []; let calls = 0;
  const adapters: ConversionAdapters = { openRaster: async () => { opened++; return { render: async page => { rendered.push(page); return Buffer.from(`page${page}`); }, close: async () => { rasterClosed++; } }; }, createOcr: async () => { created++; return { recognize: async () => ({ text: ++calls === 1 ? '合成扫描第一页\n中文 English ไทย' : '合成扫描第二页', confidence: calls === 1 ? 95 : 35 }), close: async () => { closed++; } }; } };
  const result = await convertPdfContent(input([null, null]), adapters);
  assert.deepEqual(rendered, [1, 2]); assert.equal(created, 1); assert.equal(opened, 1); assert.equal(closed, 1); assert.equal(rasterClosed, 1);
  assert.equal(result.sourceSnapshot.pages[0].confidence, 95); assert.equal(result.sourceSnapshot.pages[1].confidence, 35); assert.ok(result.sourceSnapshot.pages[1].warnings.some(value => value.includes('置信度较低'))); assert.equal(result.partial, false); assert.ok(result.sourceSnapshot.engine.ocr?.startsWith('tesseract.js@')); assert.ok(result.sourceSnapshot.engine.pdf.startsWith('pdfjs-dist@'));
});

test('未识别页默认阻断，显式部分结果保留缺页提示，整份空白始终不装作成功', async () => {
  const empty: ConversionAdapters = { openRaster: async () => ({ render: async () => Buffer.from('image'), close: async () => {} }), createOcr: async () => ({ recognize: async () => ({ text: '  \n ', confidence: 0 }), close: async () => {} }) };
  await assert.rejects(convertPdfContent(input(['第一页面', null]), empty), /第 2 页未提取/);
  const value = input(['第一页已有文字', null]); value.settings.allowPartial = true;
  const result = await convertPdfContent(value, empty); assert.equal(result.partial, true); assert.equal(result.sourceSnapshot.pages[1].method, 'unread');
  const text = (await parseDocx(Buffer.from(result.docxBase64, 'base64'))).blocks.map(block => block.text).join('\n'); assert.ok(text.includes('本页未识别到文字')); assert.ok(result.warnings.some(value => value.includes('第 2 页未识别')));
  const allEmpty = input([null]); allEmpty.settings.allowPartial = true;
  await assert.rejects(convertPdfContent(allEmpty, empty), /整份 PDF 未提取/);
  const textOnly = input([null]); textOnly.settings.mode = 'text'; await assert.rejects(convertPdfContent(textOnly, noOcr), /第 1 页未提取/);
  const incompleteLayer = input(['残留部分文字']); incompleteLayer.settings.mode = 'text'; incompleteLayer.parsed.partial = true; incompleteLayer.parsed.warnings = ['第 1 页文字解析失败，该页内容未完成提取。'];
  await assert.rejects(convertPdfContent(incompleteLayer, noOcr), /曾发生文字解析失败/);
  incompleteLayer.settings.allowPartial = true; const incomplete = await convertPdfContent(incompleteLayer, noOcr); assert.equal(incomplete.partial, true); assert.ok(incomplete.sourceSnapshot.pages[0].warnings.some(value => value.includes('可能不完整')));
});

test('页数 字符预算及取消终止转换并释放 OCR 不输出半份 DOCX', async () => {
  const limit = input(['one', 'two']); limit.settings.maxPages = 1; await assert.rejects(convertPdfContent(limit, noOcr), /页数预算/);
  await assert.rejects(convertPdfContent(input(['x'.repeat(1_000_001)]), noOcr), /100 万字符/);
  const controller = new AbortController(); let closeCalls = 0; let reached!: () => void; const recognizing = new Promise<void>(resolve => { reached = resolve; });
  const adapters: ConversionAdapters = { openRaster: async () => ({ render: async () => Buffer.from('image'), close: async () => {} }), createOcr: async () => ({ recognize: async () => { reached(); return new Promise(() => {}); }, close: async () => { closeCalls++; } }) };
  const running = convertPdfContent(input([null]), adapters, controller.signal); await recognizing; controller.abort(); await assert.rejects(running, /已取消/); assert.ok(closeCalls >= 1);
  let release!: (value: Awaited<ReturnType<ConversionAdapters['createOcr']>>) => void; let lateClosed = 0; let opening!: () => void; const started = new Promise<void>(resolve => { opening = resolve; }); const late = new AbortController();
  const waiting = convertPdfContent(input([null]), { openRaster: adapters.openRaster, createOcr: () => { opening(); return new Promise(resolve => { release = resolve; }); } }, late.signal); await started; late.abort(); await assert.rejects(waiting, /已取消/); release({ recognize: async () => ({ text: 'late', confidence: 90 }), close: async () => { lateClosed++; } }); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(lateClosed, 1);
});

test('仅status和保存设置不下载模型，配置CAS可靠，篡改原PDF哈希会阻止转换', async () => {
  const f = await fixture(); const previous = globalThis.fetch; let requests = 0; globalThis.fetch = async () => { requests++; throw new Error('network forbidden in test'); };
  try {
    const first = await runConversionCommand('conversion.status', {}, f) as ConversionStatus;
    assert.ok(first.models.every(model => !model.ready)); assert.equal(requests, 0); assert.equal(first.settings.revision, 0);
    const attempts = await Promise.allSettled([1, 2].map(() => runConversionCommand('conversion.settings.save', { expectedRevision: 0, body: defaultConversionSettings(), actorLabel: '合成标签' }, f)));
    assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1); assert.equal(attempts.filter(item => item.status === 'rejected').length, 1);
    const converted = await runConversionCommand('conversion.convert', { documentId: f.document.id, confirmed: true }, f) as ConversionResult; assert.equal(converted.partial, false); assert.equal(requests, 0); assert.deepEqual(await readFile(f.file), f.bytes);
    await writeFile(f.file, Buffer.from('%PDF modified')); await assert.rejects(runConversionCommand('conversion.convert', { documentId: f.document.id, confirmed: true }, f), /不一致/);
    await assert.rejects(runConversionCommand('conversion.download', { languages: ['eng'] }, f)); assert.equal(requests, 0);
    await assert.rejects(runConversionCommand('conversion.unknown', {}, f), /未知/);
  } finally { globalThis.fetch = previous; await f.close(); }
});

test('语言包只从固定官方地址显式下载且检验体积格式，失败无临时文件', async () => {
  const f = await fixture(); const previous = globalThis.fetch; const requests: string[] = []; const model = Buffer.alloc(2048); model.writeUInt32LE(24, 0);
  globalThis.fetch = async target => { requests.push(String(target)); return new Response(model, { headers: { 'content-length': String(model.length) } }); };
  try {
    const result = await runConversionCommand('conversion.download', { languages: ['eng'], confirmed: true }, f) as ConversionStatus;
    assert.deepEqual(requests, ['https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/eng.traineddata']);
    assert.equal(result.models.find(item => item.language === 'eng')!.ready, true); assert.equal(result.models.find(item => item.language === 'eng')!.sha256, sha(model));
    globalThis.fetch = async () => new Response('<html>not traineddata</html>'); await assert.rejects(runConversionCommand('conversion.download', { languages: ['tha'], confirmed: true }, f), /不是有效/);
    globalThis.fetch = async () => new Response('short', { headers: { 'content-length': String(40 * 1024 * 1024) } }); await assert.rejects(runConversionCommand('conversion.download', { languages: ['tha'], confirmed: true }, f), /30 MiB/);
    assert.deepEqual(await readdir(join(f.dataDir, 'ocr', 'models')), ['eng.traineddata']);
  } finally { globalThis.fetch = previous; await f.close(); }
});

test('受管PDF和模型目录不能通过符号链接越出数据目录', async () => {
  const f = await fixture(); const outside = await mkdtemp(join(tmpdir(), 'law-ocr-outside-'));
  try {
    await rm(f.file); const file = join(outside, 'outside.pdf'); await writeFile(file, f.bytes); await symlink(file, f.file);
    await assert.rejects(runConversionCommand('conversion.convert', { documentId: f.document.id, confirmed: true }, f), /不可读取/);
    await symlink(outside, join(f.dataDir, 'ocr'));
    await assert.rejects(runConversionCommand('conversion.download', { languages: ['eng'], confirmed: true }, f), /符号链接/);
    assert.deepEqual(await readdir(outside), ['outside.pdf']);
  } finally { await f.close(); await rm(outside, { recursive: true, force: true }); }
});
