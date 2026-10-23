import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import JSZip from 'jszip';
import { z } from 'zod';
import type { ParsedContract } from '../shared/contracts';
import { defaultConversionSettings, type ConversionPage, type ConversionProgress, type ConversionResult, type ConversionSettings, type ConversionSourceSnapshot, type ConversionStatus, type OcrLanguage } from '../shared/document-conversion';
import type { AppStore } from './storage';
import type { ContractService } from './service';
import type { WorkspaceAssets } from './workspace-assets';
import { DOCUMENT_LIMITS, parseDocx } from './documents';

const languages = ['chi_sim', 'eng', 'tha'] as const;
const settingsSchema = z.object({ languages: z.array(z.enum(languages)).min(1).max(3).refine(value => new Set(value).size === value.length, '不能重复语言'), mode: z.enum(['auto', 'text', 'ocr']), maxPages: z.number().int().min(1).max(100), dpi: z.number().int().min(120).max(240), pageTimeoutSeconds: z.number().int().min(15).max(180), allowPartial: z.boolean() }).strict();
const settingsInput = z.object({ id: z.string().uuid().optional(), expectedRevision: z.number().int().nonnegative(), body: settingsSchema, actorLabel: z.string().trim().min(1).max(80).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)) }).strict();
const downloadInput = z.object({ languages: z.array(z.enum(languages)).min(1).max(3), confirmed: z.literal(true) }).strict();
const conversionInput = z.object({ documentId: z.string().uuid(), settings: settingsSchema.optional(), confirmed: z.literal(true) }).strict();
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const KIND = 'conversion_settings';
const MODEL_BYTES = 30 * 1024 * 1024;
const PIXELS = 20_000_000;
const MAX_CHARACTERS = 1_000_000;
const operationLocks = new WeakMap<WorkspaceAssets, Promise<unknown>>();
const moduleRequire = createRequire(import.meta.url);
const engineVersions = { pdf: `pdfjs-dist@${String(moduleRequire('pdfjs-dist/package.json').version)}`, ocr: `tesseract.js@${String(moduleRequire('tesseract.js/package.json').version)} local-lstm` };
export interface ConversionDeps {
  store: AppStore; service: ContractService; assets: WorkspaceAssets; dataDir: string;
  signal?: AbortSignal; onProgress?: (progress: ConversionProgress) => void;
}
interface OcrEngine { recognize(image: Buffer): Promise<{ text: string; confidence: number | null }>; close(): Promise<void> }
interface PdfRaster { render(pageNumber: number, dpi: number, signal?: AbortSignal): Promise<Buffer>; close(): Promise<void> }
export interface ConversionAdapters { createOcr(): Promise<OcrEngine>; openRaster(): Promise<PdfRaster> }
const aborted = () => new Error('转换已取消，未导入不完整的转换稿。');
function check(signal?: AbortSignal) { if (signal?.aborted) throw aborted(); }
export function normalizeConversionSettings(value: unknown): ConversionSettings { return settingsSchema.parse(value); }
function emit(deps: Pick<ConversionDeps, 'onProgress'>, value: ConversionProgress) { deps.onProgress?.(value); }
function settingsValue(deps: Pick<ConversionDeps, 'assets'>): ConversionStatus['settings'] { const asset = deps.assets.list(KIND)[0]; return asset ? { id: asset.id, revision: asset.revision, body: normalizeConversionSettings(asset.body) } : { id: null, revision: 0, body: defaultConversionSettings() }; }
async function bounded<T>(promise: Promise<T>, milliseconds: number, signal?: AbortSignal, cancel?: () => void | Promise<void>): Promise<T> {
  check(signal);
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error?: unknown, value?: T) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); error ? rejectPromise(error) : resolvePromise(value!); };
    const stop = (error: Error) => { void Promise.resolve(cancel?.()).catch(() => {}); finish(error); };
    const onAbort = () => stop(aborted());
    const timer = setTimeout(() => stop(new Error('单页转换超过时间预算，已停止；请降低 DPI 或拆分文件后重试。')), milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(value => finish(undefined, value), error => finish(error));
    if (signal?.aborted) onAbort();
  });
}
async function modelInfo(dataDir: string, language: OcrLanguage): Promise<ConversionStatus['models'][number]> {
  const path = join(dataDir, 'ocr', 'models', `${language}.traineddata`);
  try {
    const root = await realpath(dataDir); const canonical = await realpath(path); const delta = relative(root, canonical);
    if (!delta || isAbsolute(delta) || delta === '..' || delta.startsWith(`..${sep}`)) throw new Error('OCR 模型已移出本地数据范围。');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1024 || info.size > MODEL_BYTES) return { language, ready: false, byteSize: info.size, sha256: null };
    const bytes = await readFile(path);
    const ready = validModel(bytes);
    return { language, ready, byteSize: bytes.length, sha256: ready ? digest(bytes) : null };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return { language, ready: false, byteSize: 0, sha256: null }; }
}
function validModel(bytes: Buffer) { const components = bytes.length >= 4 ? bytes.readUInt32LE(0) : 0; return bytes.length >= 1024 && bytes.length <= MODEL_BYTES && components > 0 && components < 1000 && components * 8 + 4 < bytes.length; }
async function safeModelDirectory(dataDir: string): Promise<string> {
  const root = await realpath(dataDir); let current = root;
  for (const segment of ['ocr', 'models']) {
    const next = join(current, segment);
    try { const info = await lstat(next); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('OCR 模型目录不能是符号链接或普通文件。'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') await mkdir(next); else throw error; }
    current = await realpath(next); const delta = relative(root, current);
    if (!delta || isAbsolute(delta) || delta === '..' || delta.startsWith(`..${sep}`)) throw new Error('OCR 模型目录不在本地数据范围内。');
  }
  return current;
}
async function downloadModels(deps: ConversionDeps, requested: OcrLanguage[]): Promise<ConversionStatus> {
  const folder = await safeModelDirectory(deps.dataDir);
  for (const [index, language] of [...new Set(requested)].entries()) {
    check(deps.signal); const temporary = join(folder, `.${language}.${randomUUID()}.tmp`);
    const signal = AbortSignal.any([deps.signal ?? new AbortController().signal, AbortSignal.timeout(120_000)]);
    const url = `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/${language}.traineddata`;
    emit(deps, { stage: 'downloading', pageNumber: index + 1, pageCount: requested.length, progress: 0, message: `正在从 Tesseract 官方仓库下载 ${language} 离线语言包，不上传合同。` });
    try {
      const response = await fetch(url, { signal, redirect: 'error' });
      if (!response.ok || !response.body) throw new Error(`OCR 语言包下载失败 HTTP ${response.status}。`);
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > MODEL_BYTES) throw new Error('OCR 语言包超过 30 MiB 上限。');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of response.body) {
        check(deps.signal); size += chunk.length;
        if (size > MODEL_BYTES) throw new Error('OCR 语言包超过 30 MiB 上限。');
        chunks.push(Buffer.from(chunk));
        emit(deps, { stage: 'downloading', pageNumber: index + 1, pageCount: requested.length, progress: declared ? Math.min(1, size / declared) : 0, message: `下载 ${language} ${Math.ceil(size / 1024)} KiB` });
      }
      const bytes = Buffer.concat(chunks, size);
      if (!validModel(bytes)) throw new Error('下载内容不是有效的 Tesseract 语言包，未安装。');
      check(deps.signal); await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      await rename(temporary, join(folder, `${language}.traineddata`));
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  return conversionStatus(deps);
}
async function conversionStatus(deps: Pick<ConversionDeps, 'dataDir' | 'assets'>): Promise<ConversionStatus> { return { modelDirectory: join(deps.dataDir, 'ocr', 'models'), models: await Promise.all(languages.map(language => modelInfo(deps.dataDir, language))), settings: settingsValue(deps) }; }

async function sourceBytes(deps: ConversionDeps, documentId: string): Promise<Buffer> {
  const artifact = deps.store.getDocumentArtifact(documentId);
  if (artifact.format !== 'pdf') throw new Error('仅可从 PDF 原件生成独立的可编辑转换稿。');
  const root = await realpath(deps.dataDir); const candidate = resolve(root, artifact.artifactUri); const delta = relative(root, candidate);
  if (!delta || isAbsolute(delta) || delta === '..' || delta.startsWith(`..${sep}`)) throw new Error('PDF 原件不在受管目录。');
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink() || info.size > DOCUMENT_LIMITS.fileBytes) throw new Error('PDF 原件不可读取或超过 50 MiB 上限。');
  const canonical = await realpath(candidate); const canonicalDelta = relative(root, canonical);
  if (!canonicalDelta || isAbsolute(canonicalDelta) || canonicalDelta === '..' || canonicalDelta.startsWith(`..${sep}`)) throw new Error('PDF 原件已移出受管目录。');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of createReadStream(canonical)) { check(deps.signal); const bytes = Buffer.from(chunk); size += bytes.length; if (size > DOCUMENT_LIMITS.fileBytes) throw new Error('PDF 原件超过 50 MiB 上限。'); chunks.push(bytes); }
  const bytes = Buffer.concat(chunks, size);
  if (bytes.length !== artifact.byteSize || digest(bytes) !== artifact.sha256) throw new Error('PDF 原件与保存版本不一致，请重新导入。');
  return bytes;
}

async function createLocalOcr(dataDir: string, settings: ConversionSettings, signal?: AbortSignal, onProgress?: ConversionDeps['onProgress']): Promise<OcrEngine> {
  const folder = await safeModelDirectory(dataDir);
  for (const language of settings.languages) if (!(await modelInfo(dataDir, language)).ready) throw new Error(`尚未安装 ${language} 离线语言包，请先点击下载；转换过程不会自动联网。`);
  check(signal);
  const { createWorker } = await import('tesseract.js');
  const require = createRequire(import.meta.url);
  const workerPath = require.resolve('tesseract.js/src/worker-script/node/index.js').replace('app.asar/', 'app.asar.unpacked/');
  const corePath = dirname(require.resolve('tesseract.js-core/package.json')).replace('app.asar/', 'app.asar.unpacked/');
  let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
  const creating = createWorker(settings.languages, 1, { langPath: folder, cachePath: folder, gzip: false, cacheMethod: 'none', workerPath, corePath, logger: (value: { status: string; progress: number }) => onProgress?.({ stage: 'recognizing', pageNumber: 0, pageCount: 0, progress: Math.max(0, Math.min(1, value.progress || 0)), message: `本机 OCR ${value.status}` }) });
  creating.then(value => { if (signal?.aborted) void value.terminate(); }).catch(() => {});
  try { worker = await bounded(creating, settings.pageTimeoutSeconds * 1000, signal); }
  catch (error) { void creating.then(value => value.terminate()).catch(() => {}); throw error; }
  return { recognize: async image => { check(signal); const result = await worker!.recognize(image, {}, { text: true }); return { text: result.data.text, confidence: Number.isFinite(result.data.confidence) ? result.data.confidence : null }; }, close: async () => { if (worker) { const current = worker; worker = null; await current.terminate(); } } };
}
async function openLocalRaster(bytes: Buffer): Promise<PdfRaster> {
  const canvasModule = await import('@napi-rs/canvas');
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const key of ['DOMMatrix', 'ImageData', 'Path2D'] as const) if (!globals[key]) globals[key] = canvasModule[key];
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, useSystemFonts: false, enableXfa: false, disableRange: true, disableStream: true, disableAutoFetch: true, maxImageSize: PIXELS, verbosity: 0 });
  let document: Awaited<typeof loading.promise>;
  try { document = await loading.promise; } catch (error) { await loading.destroy().catch(() => {}); throw error; }
  return { render: async (pageNumber, dpi, signal) => {
    check(signal); const page = await document.getPage(pageNumber); const viewport = page.getViewport({ scale: dpi / 72 });
    const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > PIXELS) throw new Error('PDF 单页渲染超过 2000 万像素预算，请降低 DPI 或拆分页幅。');
    const canvas = canvasModule.createCanvas(width, height); const context = canvas.getContext('2d');
    const task = page.render({ canvas: canvas as any, canvasContext: context as any, viewport, background: '#ffffff' });
    const cancel = () => task.cancel(); signal?.addEventListener('abort', cancel, { once: true });
    try { await task.promise; check(signal); return canvas.toBuffer('image/png'); }
    finally { signal?.removeEventListener('abort', cancel); page.cleanup(); canvas.width = 1; canvas.height = 1; }
  }, close: async () => { await loading.destroy(); } };
}

/** A finite, sequential pipeline. Empty or failed pages stay explicitly unread;
 * no OCR output is invented and partial export requires a separate user choice. */
export async function convertPdfContent(input: { sourceDocumentId: string; sourceFileSha256: string; sourceName: string; parsed: ParsedContract; settings: ConversionSettings; models?: ConversionSourceSnapshot['models'] }, adapters: ConversionAdapters, signal?: AbortSignal, onProgress?: ConversionDeps['onProgress']): Promise<ConversionResult> {
  const settings = normalizeConversionSettings(input.settings);
  if (input.parsed.format !== 'pdf' || !input.parsed.pageCount || input.parsed.pageCount > settings.maxPages || input.parsed.pageCount > 100) throw new Error('PDF 页数缺失或超过本次页数预算，请拆分文件或调整设置。');
  const pageCount = input.parsed.pageCount;
  const pages: ConversionPage[] = []; const pageTexts: string[][] = [];
  const warnings = ['此文件是从 PDF 提取或 OCR 识别的独立文字转换稿，原 PDF 保留。未复刻 PDF 版式、表格、签章、手写或既有修订；请逐页校对后审核和修订。', 'OCR 置信度是识别引擎的数值，不能作为法律正确性或完整性的保证。'];
  let raster: PdfRaster | null = null; let ocr: OcrEngine | null = null; let characters = 0; let readable = 0; let sourcePartial = false;
  const progress = (stage: ConversionProgress['stage'], pageNumber: number, progressValue: number, message: string) => onProgress?.({ stage, pageNumber, pageCount, progress: progressValue, message });
  const acquire = async <T extends { close(): Promise<void> }>(factory: () => Promise<T>): Promise<T> => { const creating = factory(); try { return await bounded(creating, settings.pageTimeoutSeconds * 1000, signal); } catch (error) { void creating.then(value => value.close()).catch(() => {}); throw error; } };
  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      check(signal);
      const savedText = input.parsed.blocks.filter(block => block.locator.kind === 'pdf' && block.locator.pageIndex === pageNumber - 1).sort((a, b) => a.ordinal - b.ordinal).map(block => block.text).filter(text => text.trim());
      const savedFailure = input.parsed.warnings.some(warning => warning.includes(`第 ${pageNumber} 页`) && /解析失败|未完成提取/u.test(warning));
      let texts: string[] = []; let method: ConversionPage['method'] = 'unread'; let confidence: number | null = null; const pageWarnings: string[] = [];
      if (settings.mode !== 'ocr' && savedText.length && !(settings.mode === 'auto' && savedFailure)) { texts = savedText; method = 'text'; pageWarnings.push('沿用保存的 PDF 文字层顺序，图片和表格阅读顺序需人工核对。'); if (savedFailure) { if (!settings.allowPartial) throw new Error(`第 ${pageNumber} 页曾发生文字解析失败，请使用 OCR 或明确允许部分结果。`); sourcePartial = true; pageWarnings.push('保存的文字层曾解析失败，本页内容可能不完整。'); warnings.push(`第 ${pageNumber} 页沿用存在解析失败的文字层，内容可能缺失。`); } }
      else if (settings.mode !== 'text') {
        try {
          progress('preparing', pageNumber, 0, `准备第 ${pageNumber}/${pageCount} 页本机 OCR`);
          if (!raster) raster = await acquire(adapters.openRaster);
          if (!ocr) ocr = await acquire(adapters.createOcr);
          progress('rendering', pageNumber, 0, `渲染第 ${pageNumber}/${pageCount} 页`);
          const image = await bounded(raster.render(pageNumber, settings.dpi, signal), settings.pageTimeoutSeconds * 1000, signal, () => raster?.close());
          check(signal); progress('recognizing', pageNumber, 0, `识别第 ${pageNumber}/${pageCount} 页`);
          const result = await bounded(ocr.recognize(image), settings.pageTimeoutSeconds * 1000, signal, () => ocr?.close());
          texts = result.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/gu, '').split(/\r?\n/u).map(text => text.trim()).filter(Boolean);
          confidence = result.confidence;
          if (texts.length) { method = 'ocr'; if (confidence !== null && confidence < 50) pageWarnings.push(`本页 OCR 置信度较低 ${confidence.toFixed(1)}，须重点人工校对。`); }
          else pageWarnings.push('OCR 没有返回可识别文字；可能是空白、签章、图像质量或语言问题，本页未完成文字提取。');
        } catch (error) {
          check(signal);
          if (!settings.allowPartial) throw error;
          pageWarnings.push(`本页 OCR 未完成：${error instanceof Error ? error.message : '识别失败'}`);
          // A timed out or failed worker is not reused on later pages.
          await ocr?.close().catch(() => {}); ocr = null; await raster?.close().catch(() => {}); raster = null;
        }
      } else pageWarnings.push('本页没有保存的文字层，且本次选择不执行 OCR。');
      if (method === 'unread') {
        if (!settings.allowPartial) throw new Error(`第 ${pageNumber} 页未提取到文字，未导出不完整转换稿。可检查原件、启用 OCR，或明确选择允许部分结果。`);
        warnings.push(`第 ${pageNumber} 页未识别，转换稿保留缺页提示，不得视为已覆盖。`);
      } else readable++;
      characters += texts.reduce((sum, text) => sum + text.length, 0);
      if (characters > MAX_CHARACTERS || texts.length > 10000) throw new Error('转换文字超过 100 万字符或单页 10000 行预算，请拆分文件。');
      pageTexts.push(texts);
      pages.push({ pageNumber, method, confidence, textSha256: digest(texts.join('\n')), warnings: pageWarnings });
      progress('recognizing', pageNumber, pageNumber / pageCount, `第 ${pageNumber}/${pageCount} 页${method === 'unread' ? '未识别' : '处理完成'}`);
    }
    check(signal); if (!readable) throw new Error('整份 PDF 未提取到可用文字，未生成可审核的转换稿。');
    const sourceSnapshot: ConversionSourceSnapshot = { sourceDocumentId: input.sourceDocumentId, sourceFileSha256: input.sourceFileSha256, sourceName: input.sourceName, createdAt: new Date().toISOString(), pageCount, pages, settings, engine: { pdf: engineVersions.pdf, ocr: pages.some(page => page.method === 'ocr') ? engineVersions.ocr : null }, models: input.models ?? [] };
    progress('writing', pageCount, 1, '生成保留页码来源的独立 DOCX 转换稿');
    const bytes = await buildConvertedDocx(sourceSnapshot, pageTexts, warnings); check(signal);
    progress('completed', pageCount, 1, '转换稿已生成，等待保存或导入');
    return { docxBase64: bytes.toString('base64'), filename: `${basename(input.sourceName).replace(/\.pdf$/iu, '')} 文字转换稿.docx`, sourceSnapshot, warnings, partial: sourcePartial || pages.some(page => page.method === 'unread') };
  } finally { await ocr?.close().catch(() => {}); await raster?.close().catch(() => {}); }
}

export async function buildConvertedDocx(snapshot: ConversionSourceSnapshot, pageTexts: string[][], warnings: string[]): Promise<Buffer> {
  const esc = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/gu, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'; const xml = (value: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${value}`;
  const paragraph = (text: string, style = 'Normal') => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  const body = [paragraph('PDF 文字转换稿', 'Title'), paragraph(`来源文件 ${snapshot.sourceName}`), paragraph(`来源文档 ${snapshot.sourceDocumentId}    SHA256 ${snapshot.sourceFileSha256}`), paragraph(`转换时间 ${snapshot.createdAt}`), ...warnings.map(text => paragraph(text))];
  snapshot.pages.forEach((page, index) => { body.push(paragraph(`原 PDF 第 ${page.pageNumber} 页`, 'Heading1'), paragraph(`提取方式 ${page.method === 'text' ? '文字层提取' : page.method === 'ocr' ? '本机 OCR' : '未识别'}    置信度 ${page.confidence ?? '不适用'}    文本 SHA256 ${page.textSha256}`), ...page.warnings.map(text => paragraph(text)), ...(pageTexts[index].length ? pageTexts[index].map(text => paragraph(text)) : [paragraph('本页未识别到文字 请对照原 PDF 人工补充')])) ; });
  const zip = new JSZip();
  zip.file('[Content_Types].xml', xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'));
  zip.file('_rels/.rels', xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  zip.file('word/_rels/document.xml.rels', xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'));
  zip.file('word/document.xml', xml(`<w:document xmlns:w="${ns}"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1247" w:right="1134" w:bottom="1247" w:left="1134"/></w:sectPr></w:body></w:document>`));
  const heading = (id: string, size: number) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="140"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="000000"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  zip.file('word/styles.xml', xml(`<w:styles xmlns:w="${ns}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="SimSun" w:cs="Tahoma"/><w:color w:val="000000"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="zh-CN" w:eastAsia="zh-CN" w:bidi="th-TH"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:widowControl/><w:spacing w:after="120" w:line="330" w:lineRule="atLeast"/></w:pPr></w:style>${heading('Title', 36)}${heading('Heading1', 27)}</w:styles>`));
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  const parsed = await parseDocx(bytes);
  const expected = pageTexts.flat().filter(text => text.trim()); const content = parsed.blocks.map(block => block.text);
  if (parsed.partial || expected.some(text => !content.includes(text))) throw new Error('转换稿 DOCX 回读未通过，未导出。');
  return bytes;
}

export async function runConversionCommand(action: string, payload: unknown, deps: ConversionDeps): Promise<unknown> {
  check(deps.signal);
  if (action === 'conversion.status' || action === 'conversion.settings') return conversionStatus(deps);
  if (action === 'conversion.settings.save' || action === 'conversion.save') {
    const input = settingsInput.parse(payload);
    const operation = (operationLocks.get(deps.assets) ?? Promise.resolve()).catch(() => {}).then(async () => { const existing = settingsValue(deps); if (existing.id !== (input.id ?? null) || existing.revision !== input.expectedRevision) throw new Error('转换设置已变化，请刷新后重试。'); await deps.assets.save({ id: input.id, kind: KIND, expectedRevision: input.expectedRevision, body: input.body, actorLabel: input.actorLabel }); return conversionStatus(deps); });
    operationLocks.set(deps.assets, operation.catch(() => {})); return operation;
  }
  if (action === 'conversion.download') { const input = downloadInput.parse(payload); return downloadModels(deps, input.languages); }
  if (action !== 'conversion.convert') throw new Error('未知 PDF 转换操作。');
  const input = conversionInput.parse(payload); const settings = input.settings ?? settingsValue(deps).body; const document = deps.store.getDocument(input.documentId); const bytes = await sourceBytes(deps, input.documentId); check(deps.signal);
  const metadata = document.blocks.map(block => block.locator).filter(locator => locator.kind === 'pdf');
  const artifact = deps.store.getDocumentArtifact(document.id);
  // Read the saved parser page count; missing scan pages have no text blocks.
  const source = deps.store.rows('SELECT parser_snapshot_json FROM document_versions WHERE id=?', [document.id])[0];
  const parser = JSON.parse(String(source.parser_snapshot_json)) as { pageCount?: number };
  const pageCount = parser.pageCount ?? (metadata.length ? Math.max(...metadata.map(locator => locator.pageIndex + 1)) : 0);
  const parsed: ParsedContract = { format: 'pdf', language: document.language, blocks: document.blocks, warnings: document.warnings, partial: document.partial, pageCount };
  const status = await conversionStatus(deps);
  return convertPdfContent({ sourceDocumentId: document.id, sourceFileSha256: artifact.sha256, sourceName: document.name, parsed, settings, models: status.models.filter(model => settings.languages.includes(model.language) && model.ready).map(model => ({ language: model.language, sha256: model.sha256! })) }, { openRaster: () => openLocalRaster(bytes), createOcr: () => createLocalOcr(deps.dataDir, settings, deps.signal, deps.onProgress) }, deps.signal, deps.onProgress);
}
