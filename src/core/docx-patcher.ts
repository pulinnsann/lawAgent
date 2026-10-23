import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import path from 'node:path';
import { DOCUMENT_LIMITS, inspectDocxZip, parseDocx, readDocxXmlPart } from './documents';

export interface DocxTextPatch {
  id: string;
  blockId: string;
  partName: string;
  structuralPath: string;
  rangeStart: number;
  rangeEnd: number;
  expectedOriginalText: string;
  replacementText: string;
}
export interface DocxEditableTarget {
  partName: string;
  structuralPath: string;
  text: string;
  editable: boolean;
  reason: string | null;
  editMode?: 'paragraph' | 'segments';
  warnings?: string[];
  segments?: DocxEditableSegment[];
}
export interface DocxEditableSegment {
  id: string;
  rangeStart: number;
  rangeEnd: number;
  text: string;
  editable: boolean;
  reason: string | null;
}
export interface DocxEditProtection {
  kind: 'none' | 'readOnly' | 'other' | 'signature';
  canCreateEditableCopy: boolean;
  reason: string | null;
}
export class DocxPatchError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'DocxPatchError'; }
}

const WORD_NAMESPACES = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);
const UNSAFE_CONTEXTS = new Set(['sdt', 'sdtContent', 'customXml', 'hyperlink', 'fldSimple', 'ins', 'del', 'moveTo', 'moveFrom', 'drawing', 'pict', 'object', 'txbxContent', 'altChunk']);
const UNSAFE_PROPERTIES = new Set(['vanish', 'webHidden', 'pPrChange', 'rPrChange']);
const MAX_PATCHES = 200;
const MAX_REPLACEMENT_CHARACTERS = 100_000;
const COMPLEX_REASON = '此段落含修订、字段、链接、隐藏文字、内容控件、换行/制表符或其他复杂结构，本轮不能安全定点写回。';
type RunRecord = { name: string; uri: string; openStart: number; openEnd: number; contentEnd: number; end: number; properties?: { start: number; end: number } };
type TextSpan = { openStart: number; openEnd: number; contentEnd: number; end: number; text: string; start: number; finish: number; name?: string; uri?: string; run?: RunRecord };
type FixedSegment = { kind: 'anchor' | 'break' | 'format'; xmlStart: number; rangeStart: number; rangeEnd: number; text: string; reason: string };
type TargetRecord = { path: string; spans: TextSpan[]; fixed: FixedSegment[]; segmented: boolean; reason: string | null; text: string };
type StoryAnchor = { kind: string; id: string | null; valid: boolean; order: number; record?: TargetRecord; openEnd: number };
type Frame = { name: string; local: string; path: string; counts: Map<string, number>; ns: Record<string, string>; formatting: boolean; unsafe: boolean; target?: TargetRecord; textSpan?: TextSpan; anchor?: StoryAnchor; immutableEmpty?: { openEnd: number }; run?: RunRecord; runProperties?: { run: RunRecord; start: number } };
type ProtectionRemoval = { partName: string; start: number; end: number; xml: string };
type ProtectionState = { public: DocxEditProtection; removal?: ProtectionRemoval };
type Loaded = { zip: JSZip; parsed: Awaited<ReturnType<typeof parseDocx>>; targets: Map<string, TargetRecord>; xml: Map<string, string>; protection: ProtectionState; protectedReason: string | null };
const keyOf = (part: string, locator: string) => `${part}\n${locator}`;
function fail(code: string, message: string): never { throw new DocxPatchError(code, message); }
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let result = value;
  for (let bit = 0; bit < 8; bit++) result = result & 1 ? 0xedb88320 ^ (result >>> 1) : result >>> 1;
  return result >>> 0;
});
/** Import need not decompress every image. Re-serialization does; verify all
 * declared sizes and CRCs with bounded streams before letting ZIP generate run. */
async function verifyEntries(zip: JSZip, metadata: ReturnType<typeof inspectDocxZip>): Promise<void> {
  for (const [name, declared] of metadata) {
    const entry = zip.files[name];
    if (!entry) fail('DOCX_PATCH_INVALID', 'DOCX 包含无法回读的内部部件。');
    await new Promise<void>((resolve, reject) => {
      const stream = entry.nodeStream('nodebuffer'); let size = 0; let crc = 0xffffffff; let settled = false;
      stream.on('data', (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > declared.size || size > DOCUMENT_LIMITS.zipUncompressedBytes) {
          settled = true; stream.pause(); (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
          reject(new DocxPatchError('DOCX_PATCH_INVALID', 'DOCX 部件实际解压体积超过声明或安全上限。')); return;
        }
        for (const byte of chunk) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      });
      stream.on('error', () => { if (!settled) { settled = true; reject(new DocxPatchError('DOCX_PATCH_INVALID', 'DOCX 内部部件无法可靠回读。')); } });
      stream.on('end', () => {
        if (settled) return; settled = true;
        if (size !== declared.size || ((crc ^ 0xffffffff) >>> 0) !== declared.crc32) reject(new DocxPatchError('DOCX_PATCH_INVALID', 'DOCX 内部部件的实际长度或校验和不一致。'));
        else resolve();
      });
    });
    entry.options.compression = declared.compression;
  }
}

function decode(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, entity => {
    if (entity.slice(1, -1) in named) return named[entity.slice(1, -1)];
    const value = entity.startsWith('&#x') ? Number.parseInt(entity.slice(3, -1), 16) : Number.parseInt(entity.slice(2, -1), 10);
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : '\ufffd';
  });
}
function escape(text: string): string { return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
function attributes(token: string): Record<string, string> {
  return Object.fromEntries([...token.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(match => [match[1], decode(match[2] ?? match[3])]));
}
function local(name: string): string { return name.split(':').at(-1)!; }
function namespace(name: string, ns: Record<string, string>): string { return ns[name.includes(':') ? name.split(':')[0] : ''] ?? ''; }
const ANCHOR_TAGS = new Set(['permStart', 'permEnd', 'bookmarkStart', 'bookmarkEnd']);
const ANCHOR_REASON = '权限范围或书签标记无法可靠配对，本段暂不能安全写回。';
function wordAttributes(attrs: Record<string, string>, ns: Record<string, string>, uri: string): Record<string, string> | null {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(attrs)) {
    if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
    if (!name.includes(':') || namespace(name, ns) !== uri || local(name) in output) return null;
    output[local(name)] = value;
  }
  return output;
}
function validateStoryAnchors(anchors: StoryAnchor[]): void {
  if (anchors.some(anchor => !anchor.valid || anchor.id === null)) {
    for (const anchor of anchors) if (anchor.record) anchor.record.reason ??= ANCHOR_REASON;
    return;
  }
  const groups = new Map<string, StoryAnchor[]>();
  for (const anchor of anchors) { const key = `${anchor.kind.startsWith('perm') ? 'perm' : 'bookmark'}:${anchor.id}`; const list = groups.get(key) ?? []; list.push(anchor); groups.set(key, list); }
  for (const group of groups.values()) {
    const start = group.filter(anchor => anchor.kind.endsWith('Start')); const end = group.filter(anchor => anchor.kind.endsWith('End'));
    if (start.length !== 1 || end.length !== 1 || start[0].order >= end[0].order) for (const anchor of group) if (anchor.record) anchor.record.reason ??= ANCHOR_REASON;
  }
}

/** Keep XML spelling and byte content outside changed text spans. Input XML was
 * already checked by the import parser; this scanner only records locations. */
function scan(xml: string): Map<string, TargetRecord> {
  const output = new Map<string, TargetRecord>();
  const root: Frame = { name: '', local: '', path: '', counts: new Map(), ns: {}, formatting: false, unsafe: false };
  const stack: Frame[] = [root]; const anchors: StoryAnchor[] = []; let count = 0; let cursor = 0; let active: TargetRecord | undefined;
  while ((cursor = xml.indexOf('<', cursor)) !== -1) {
    if (++count > 300_000) fail('DOCX_TARGET_UNSUPPORTED', 'DOCX XML 结构过于复杂，暂不能定点写回。');
    const special = xml.startsWith('<!--', cursor) ? '-->' : xml.startsWith('<![CDATA[', cursor) ? ']]>' : xml.startsWith('<?', cursor) ? '?>' : null;
    if (special) {
      if (active && !xml.startsWith('<?', cursor)) active.reason ??= COMPLEX_REASON;
      cursor = xml.indexOf(special, cursor + 2) + special.length; continue;
    }
    let quote = ''; let end = cursor + 1;
    for (; end < xml.length; end++) {
      const character = xml[end];
      if (quote) { if (character === quote) quote = ''; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
    }
    const token = xml.slice(cursor, end + 1);
    if (/^<\//.test(token)) {
      const frame = stack.pop()!;
      if (frame.run) { frame.run.contentEnd = cursor; frame.run.end = end + 1; }
      if (frame.runProperties) frame.runProperties.run.properties = { start: frame.runProperties.start, end: end + 1 };
      if (frame.anchor && xml.slice(frame.anchor.openEnd, cursor).trim()) frame.anchor.valid = false;
      if (frame.immutableEmpty && xml.slice(frame.immutableEmpty.openEnd, cursor).trim() && active) active.reason ??= COMPLEX_REASON;
      if (frame.textSpan && active) {
        const span = frame.textSpan;
        span.contentEnd = cursor; span.end = end + 1;
        const raw = xml.slice(span.openEnd, cursor);
        if (raw.includes('<')) active.reason ??= COMPLEX_REASON;
        span.text = decode(raw); span.start = active.text.length; active.text += span.text; span.finish = active.text.length;
        active.spans.push(span);
      }
      if (frame.target) active = undefined;
      cursor = end + 1; continue;
    }
    const name = /^<\s*([^\s/>]+)/.exec(token)?.[1];
    if (!name) fail('DOCX_TARGET_UNSUPPORTED', 'DOCX XML 标签不能可靠定位。');
    const parent = stack.at(-1)!; const tag = local(name); const attrs = attributes(token);
    const ns = { ...parent.ns };
    for (const [key, value] of Object.entries(attrs)) if (key === 'xmlns') ns[''] = value; else if (key.startsWith('xmlns:')) ns[key.slice(6)] = value;
    const ordinal = (parent.counts.get(name) ?? 0) + 1; parent.counts.set(name, ordinal);
    const locator = `${parent.path}/${name}[${ordinal}]`; const word = WORD_NAMESPACES.has(namespace(name, ns));
    const formatting = parent.formatting || (word && (tag === 'pPr' || tag === 'rPr'));
    const grandparent = stack.at(-2);
    const numberingInsertion = word && tag === 'ins' && parent.local === 'numPr' && grandparent?.local === 'pPr' && parent.formatting
      && namespace(parent.name, parent.ns) === namespace(name, ns) && namespace(grandparent.name, grandparent.ns) === namespace(name, ns);
    const unsafe = parent.unsafe || (word && UNSAFE_CONTEXTS.has(tag) && !numberingInsertion);
    const frame: Frame = { name, local: tag, path: locator, counts: new Map(), ns, formatting, unsafe };
    if (word && tag === 'r' && parent.local === 'p') frame.run = { name, uri: namespace(name, ns), openStart: cursor, openEnd: end + 1, contentEnd: end + 1, end: end + 1 };
    if (word && tag === 'rPr' && parent.run) frame.runProperties = { run: parent.run, start: cursor };
    if (parent.anchor) parent.anchor.valid = false;
    if (tag === 'p' && !active) {
      active = { path: locator, spans: [], fixed: [], segmented: false, text: '', reason: !word || unsafe ? COMPLEX_REASON : null };
      frame.target = active; output.set(locator, active);
    }
    const anchor = ANCHOR_TAGS.has(tag);
    const values = anchor || (word && tag === 'br') ? wordAttributes(attrs, ns, namespace(name, ns)) : null;
    const pageBreak = word && tag === 'br' && parent.local === 'r' && values?.type === 'page' && (!values.clear || ['none', 'left', 'right', 'all'].includes(values.clear));
    if (anchor) {
      const id = values?.id && /^\d{1,20}$/.test(values.id) ? BigInt(values.id).toString() : null;
      frame.anchor = { kind: tag, id, valid: Boolean(word && values && id !== null && (tag !== 'bookmarkStart' || values.name)), order: anchors.length, record: active, openEnd: end + 1 };
      anchors.push(frame.anchor);
      if (active) { active.segmented = true; active.fixed.push({ kind: 'anchor', xmlStart: cursor, rangeStart: active.text.length, rangeEnd: active.text.length, text: '', reason: tag.startsWith('perm') ? '权限范围锚点原样保留，不能直接修改。' : '书签锚点原样保留，不能直接修改。' }); }
    }
    if (active && !frame.target) {
      if (unsafe || (word && UNSAFE_PROPERTIES.has(tag)) || (!word && !formatting)) active.reason ??= COMPLEX_REASON;
      if (!formatting && (!word || (!['r', 't', 'lastRenderedPageBreak'].includes(tag) && !anchor && !pageBreak))) active.reason ??= COMPLEX_REASON;
      if (word && tag === 'r' && parent.local !== 'p') active.reason ??= COMPLEX_REASON;
      if (numberingInsertion) {
        frame.immutableEmpty = { openEnd: end + 1 }; active.segmented = true;
        active.fixed.push({ kind: 'format', xmlStart: cursor, rangeStart: active.text.length, rangeEnd: active.text.length, text: '', reason: '原编号修订记录原样保留，不能直接修改。' });
      }
      if (pageBreak) {
        frame.immutableEmpty = { openEnd: end + 1 }; active.segmented = true;
        active.fixed.push({ kind: 'break', xmlStart: cursor, rangeStart: active.text.length, rangeEnd: active.text.length + 1, text: '\n', reason: '原分页符原样保留，不能新增、删除或移动。' });
        active.text += '\n';
      }
      if (parent.immutableEmpty) active.reason ??= COMPLEX_REASON;
      if (word && tag === 't') {
        if (parent.local !== 'r' || /\/\s*>$/.test(token)) active.reason ??= COMPLEX_REASON;
        else frame.textSpan = { openStart: cursor, openEnd: end + 1, contentEnd: end + 1, end: end + 1, text: '', start: 0, finish: 0, name, uri: namespace(name, ns), run: parent.run };
      }
    }
    if (!/\/\s*>$/.test(token)) stack.push(frame);
    else {
      if (frame.target) active = undefined;
      if (frame.runProperties) frame.runProperties.run.properties = { start: cursor, end: end + 1 };
    }
    cursor = end + 1;
  }
  validateStoryAnchors(anchors);
  return output;
}

const relParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false, trimValues: false, removeNSPrefix: true });
function normalizedPart(owner: string, target: string): string {
  if (!target || target.includes('\\') || target.includes('\0') || /^[a-z][a-z\d+.-]*:/i.test(target)) fail('DOCX_TARGET_UNSUPPORTED', 'DOCX 设置部件的路径不受支持。');
  const resolved = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(owner), target));
  if (resolved === '..' || resolved.startsWith('../')) fail('DOCX_TARGET_UNSUPPORTED', 'DOCX 设置部件路径越界。');
  return resolved;
}
const uncertainProtection = (): ProtectionState => ({ public: { kind: 'other', canCreateEditableCopy: false, reason: '文档的编辑保护设置无法可靠核对，暂不能创建可编辑副本或生成修改稿。' } });
const noProtection = (): ProtectionState => ({ public: { kind: 'none', canCreateEditableCopy: false, reason: null } });
const signatureProtection = (): ProtectionState => ({ public: { kind: 'signature', canCreateEditableCopy: false, reason: '文档包含数字签名，定点修改会使签名失效；请使用经授权的未签名副本。' } });
const onOff = (value: string | undefined): boolean | null => value === undefined || ['0', 'false', 'off'].includes(value) ? false : ['1', 'true', 'on'].includes(value) ? true : null;

/** Locate the single Word settings element with namespace-aware byte offsets.
 * Unknown/nested protection structures are blocked, never guessed or removed. */
function settingsProtection(partName: string, xml: string): ProtectionState {
  type SettingFrame = { name: string; ns: Record<string, string>; protection?: { start: number; openEnd: number; attrs: Record<string, string>; closeStart?: number; end?: number } };
  const stack: SettingFrame[] = []; const protections: NonNullable<SettingFrame['protection']>[] = [];
  let cursor = 0; let roots = 0; let ambiguous = false; let count = 0; let writeProtection = false; let settingsNamespace = '';
  while ((cursor = xml.indexOf('<', cursor)) !== -1) {
    if (++count > 300_000) return uncertainProtection();
    const special = xml.startsWith('<!--', cursor) ? '-->' : xml.startsWith('<![CDATA[', cursor) ? ']]>' : xml.startsWith('<?', cursor) ? '?>' : null;
    if (special) { cursor = xml.indexOf(special, cursor + 2) + special.length; continue; }
    let quote = ''; let end = cursor + 1;
    for (; end < xml.length; end++) {
      const character = xml[end];
      if (quote) { if (character === quote) quote = ''; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
    }
    const token = xml.slice(cursor, end + 1);
    if (/^<\//.test(token)) {
      const frame = stack.pop();
      if (frame?.protection) { frame.protection.closeStart = cursor; frame.protection.end = end + 1; }
      cursor = end + 1; continue;
    }
    const name = /^<\s*([^\s/>]+)/.exec(token)?.[1]; if (!name) return uncertainProtection();
    const attrs = attributes(token); const parent = stack.at(-1); const ns = { ...parent?.ns };
    for (const [key, value] of Object.entries(attrs)) if (key === 'xmlns') ns[''] = value; else if (key.startsWith('xmlns:')) ns[key.slice(6)] = value;
    const word = WORD_NAMESPACES.has(namespace(name, ns)); const tag = local(name);
    if (!parent) { roots++; settingsNamespace = namespace(name, ns); if (!word || tag !== 'settings') ambiguous = true; }
    if (parent?.protection) ambiguous = true;
    if (tag === 'writeProtection') writeProtection = true;
    const frame: SettingFrame = { name, ns };
    if (tag === 'documentProtection') {
      if (!word || namespace(name, ns) !== settingsNamespace || stack.length !== 1 || !parent || local(parent.name) !== 'settings') ambiguous = true;
      const values: Record<string, string> = {};
      for (const [key, value] of Object.entries(attrs)) {
        if (key === 'xmlns' || key.startsWith('xmlns:')) continue;
        // The default namespace applies to elements, never to attributes.
        if (!key.includes(':') || namespace(key, ns) !== settingsNamespace || local(key) in values) ambiguous = true;
        values[local(key)] = value;
      }
      frame.protection = { start: cursor, openEnd: end + 1, attrs: values };
      protections.push(frame.protection);
    }
    if (/\/\s*>$/.test(token)) {
      if (frame.protection) { frame.protection.closeStart = end + 1; frame.protection.end = end + 1; }
    } else stack.push(frame);
    cursor = end + 1;
  }
  if (ambiguous || roots !== 1 || stack.length || protections.length > 1) return uncertainProtection();
  const protection = protections[0]; if (!protection) return noProtection();
  if (protection.end === undefined || protection.closeStart === undefined || xml.slice(protection.openEnd, protection.closeStart).trim()) return uncertainProtection();
  const active = onOff(protection.attrs.enforcement);
  if (active === null) return uncertainProtection();
  if (!active) return noProtection();
  if (protection.attrs.edit !== 'readOnly' || writeProtection || onOff(protection.attrs.formatting) !== false) return { public: { kind: 'other', canCreateEditableCopy: false, reason: '文档启用了其他或组合编辑保护，本轮仅支持经授权的只读合同工作副本。' } };
  return { public: { kind: 'readOnly', canCreateEditableCopy: true, reason: '文档启用了只读编辑限制；经授权后可创建独立的可编辑工作副本，原件保留。' }, removal: { partName, start: protection.start, end: protection.end, xml } };
}

async function inspectProtection(zip: JSZip, metadata: ReturnType<typeof inspectDocxZip>): Promise<ProtectionState> {
  if ([...metadata.keys()].some(part => part.startsWith('_xmlsignatures/'))) return signatureProtection();
  const settings = new Set<string>();
  let uncertain = false;
  for (const part of metadata.keys()) {
    if (!part.endsWith('.rels')) continue;
    const parsed = relParser.parse(await readDocxXmlPart(zip, metadata, part));
    const values = parsed.Relationships?.Relationship;
    for (const value of Array.isArray(values) ? values : values ? [values] : []) {
      if (typeof value.Type === 'string' && /\/digital-signature\//i.test(value.Type)) return signatureProtection();
      if (typeof value.Type !== 'string' || !value.Type.endsWith('/settings')) continue;
      if (value.TargetMode === 'External' || typeof value.Target !== 'string') { uncertain = true; continue; }
      const owner = part === '_rels/.rels' ? '' : path.posix.join(path.posix.dirname(path.posix.dirname(part)), path.posix.basename(part, '.rels'));
      settings.add(normalizedPart(owner, value.Target));
    }
  }
  const types = relParser.parse(await readDocxXmlPart(zip, metadata, '[Content_Types].xml'));
  const declaredTypes = [...[types.Types?.Default].flat(), ...[types.Types?.Override].flat()];
  if (declaredTypes.some(value => value && typeof value.ContentType === 'string' && /digital-signature/i.test(value.ContentType))) return signatureProtection();
  if (metadata.has('word/settings.xml')) settings.add('word/settings.xml');
  if (uncertain || settings.size > 1) return uncertainProtection();
  const part = [...settings][0];
  return part ? settingsProtection(part, await readDocxXmlPart(zip, metadata, part)) : noProtection();
}

async function load(bytes: Buffer): Promise<Loaded> {
  if (!Buffer.isBuffer(bytes) || bytes.length > DOCUMENT_LIMITS.fileBytes) fail('DOCX_PATCH_INVALID', 'DOCX 输入超过文件大小限制或格式无效。');
  const parsed = await parseDocx(bytes); const metadata = inspectDocxZip(bytes);
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false });
  const targets = new Map<string, TargetRecord>(); const xml = new Map<string, string>();
  for (const part of new Set(parsed.blocks.flatMap(block => block.locator.kind === 'docx' ? [block.locator.partName] : []))) {
    const value = await readDocxXmlPart(zip, metadata, part); xml.set(part, value);
    for (const [locator, target] of scan(value)) targets.set(keyOf(part, locator), target);
  }
  const protection = await inspectProtection(zip, metadata);
  return { zip, parsed, targets, xml, protection, protectedReason: protection.public.reason };
}

/** Inspect only; no verifier, salt, password or contract text is exposed. */
export async function inspectDocxEditProtection(bytes: Buffer): Promise<DocxEditProtection> {
  return { ...(await load(bytes)).protection.public };
}

/** Explicit opt-in working-copy operation. The source Buffer and all package
 * parts except the exact active readOnly element stay untouched. */
export async function createDocxEditableCopy(bytes: Buffer): Promise<{ bytes: Buffer; warnings: string[] }> {
  const loaded = await load(bytes); const { public: state, removal } = loaded.protection;
  if (!state.canCreateEditableCopy || state.kind !== 'readOnly' || !removal) fail('DOCX_TARGET_UNSUPPORTED', state.reason ?? '文档没有可移除的活动只读编辑限制，无需创建可编辑工作副本。');
  await verifyEntries(loaded.zip, inspectDocxZip(bytes));
  const entry = loaded.zip.file(removal.partName)!; const original = await entry.async('nodebuffer');
  const xml = removal.xml.slice(0, removal.start) + removal.xml.slice(removal.end);
  loaded.zip.file(removal.partName, encode(xml, original), { date: entry.date, comment: entry.comment, unixPermissions: entry.unixPermissions, dosPermissions: entry.dosPermissions, compression: 'STORE' });
  const result = await loaded.zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  if (result.length > DOCUMENT_LIMITS.fileBytes) fail('DOCX_PATCH_INVALID', '工作副本超过文件大小上限，请缩减文件后重试。');
  const verified = await load(result);
  const comparable = (document: Loaded['parsed']) => JSON.stringify(document.blocks.map(block => ({ kind: block.kind, text: block.text, locator: block.locator })));
  if (verified.protection.public.kind !== 'none' || comparable(loaded.parsed) !== comparable(verified.parsed)) fail('DOCX_PATCH_VERIFICATION_FAILED', '工作副本的全文、定位或保护状态核对失败，未生成可交付文件。');
  return { bytes: result, warnings: ['已仅从工作副本移除只读编辑限制；原件与原审核记录应保留，副本需独立标记。', '原有修订、书签、权限范围、换行及其他复杂内容保持原样；相关段落仍按定点修改边界处理。'] };
}

export async function inspectDocxTargets(bytes: Buffer): Promise<DocxEditableTarget[]> {
  const loaded = await load(bytes);
  return loaded.parsed.blocks.flatMap(block => {
    if (block.locator.kind !== 'docx') return [];
    const record = loaded.targets.get(keyOf(block.locator.partName, block.locator.structuralPath));
    const reason = loaded.protectedReason ?? record?.reason ?? (!record || !record.spans.length || record.text !== block.text ? '此段落的可见文字与原文定位不一致，暂不能安全写回。' : null);
    const segmented = record?.segmented === true;
    const segments: DocxEditableSegment[] = [];
    if (segmented && record) {
      const pieces = [
        ...record.spans.map((span, index) => ({ xmlStart: span.openStart, segment: { id: `text-${index + 1}`, rangeStart: span.start, rangeEnd: span.finish, text: span.text, editable: reason === null && span.text.length > 0, reason: reason ?? (span.text.length ? null : '空文字片段不能作为替换目标。') } })),
        ...record.fixed.map((fixed, index) => ({ xmlStart: fixed.xmlStart, segment: { id: `${fixed.kind}-${index + 1}`, rangeStart: fixed.rangeStart, rangeEnd: fixed.rangeEnd, text: fixed.text, editable: false, reason: fixed.reason } })),
      ];
      pieces.sort((a, b) => a.xmlStart - b.xmlStart);
      segments.push(...pieces.map(piece => piece.segment));
    }
    const editable = reason === null && (!segmented || segments.some(segment => segment.editable));
    return [{ partName: block.locator.partName, structuralPath: block.locator.structuralPath, text: block.text, editable, reason: reason ?? (editable ? null : '此段没有可安全修改的普通文字片段。'),
      editMode: segmented ? 'segments' : 'paragraph', warnings: segmented ? ['本段含原有锚点、分页或编号修订，仅可逐个修改普通文字片段；原有结构与其他片段保留。'] : [], ...(segmented ? { segments } : {}) }];
  });
}

function validBoundary(text: string, index: number): boolean {
  return !(index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index]));
}
function validXmlText(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit < 0x20 || unit === 0xfffe || unit === 0xffff) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function preserveSpace(opening: string): string {
  return /\bxml:space\s*=/.test(opening) ? opening.replace(/\bxml:space\s*=\s*(?:"[^"]*"|'[^']*')/, 'xml:space="preserve"') : opening.replace(/>$/, ' xml:space="preserve">');
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function boundaries(value: string): Set<number> { return new Set([0, value.length, ...[...segmenter.segment(value)].map(item => item.index)]); }
/** A whole-paragraph proposal often changes only a few words. Trim common
 * graphemes so unchanged styled runs stay byte-identical. */
function minimalPatch(patch: DocxTextPatch): DocxTextPatch | null {
  const before = patch.expectedOriginalText; const after = patch.replacementText;
  if (before === after) return null;
  let prefix = 0;
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
  const oldBoundaries = boundaries(before); const newBoundaries = boundaries(after);
  while (prefix && (!oldBoundaries.has(prefix) || !newBoundaries.has(prefix))) prefix--;
  let suffix = 0;
  while (suffix < Math.min(before.length - prefix, after.length - prefix) && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  while (suffix && (!oldBoundaries.has(before.length - suffix) || !newBoundaries.has(after.length - suffix))) suffix--;
  return { ...patch, rangeStart: patch.rangeStart + prefix, rangeEnd: patch.rangeEnd - suffix,
    expectedOriginalText: before.slice(prefix, before.length - suffix), replacementText: after.slice(prefix, after.length - suffix) };
}
function rawOffsets(raw: string): number[] {
  const offsets = [0]; let cursor = 0; let decoded = 0;
  while (cursor < raw.length) {
    const entity = raw[cursor] === '&' ? /^&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/.exec(raw.slice(cursor))?.[0] : undefined;
    const piece = entity ?? String.fromCodePoint(raw.codePointAt(cursor)!);
    const value = entity ? decode(entity) : piece;
    offsets[decoded] = cursor; cursor += piece.length; decoded += value.length; offsets[decoded] = cursor;
  }
  return offsets;
}
function encode(xml: string, original: Buffer): Buffer {
  if (original[0] === 0xff && original[1] === 0xfe) return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
  if (original[0] === 0xfe && original[1] === 0xff) return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(xml, 'utf16le').swap16()]);
  const bytes = Buffer.from(xml, 'utf8');
  return original.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes;
}

export async function applyDocxPatches(bytes: Buffer, patches: DocxTextPatch[]): Promise<{ bytes: Buffer; warnings: string[] }> {
  if (!Array.isArray(patches) || !patches.length || patches.length > MAX_PATCHES) fail('DOCX_PATCH_INVALID', '请选择 1–200 项定点修改。');
  const loaded = await load(bytes);
  if (loaded.protectedReason) fail('DOCX_TARGET_UNSUPPORTED', loaded.protectedReason);
  const grouped = new Map<string, DocxTextPatch[]>(); const ids = new Set<string>(); const warnings = new Set<string>(); const owners = new Map<string, TextSpan>();
  const originalByKey = new Map(loaded.parsed.blocks.map(block => [block.locator.kind === 'docx' ? keyOf(block.locator.partName, block.locator.structuralPath) : '', block.text]));
  const expectedByKey = new Map(originalByKey);
  for (const patch of patches) {
    if (!patch || typeof patch !== 'object' || typeof patch.id !== 'string' || !patch.id || typeof patch.blockId !== 'string' || !patch.blockId || ids.has(patch.id) || typeof patch.partName !== 'string' || typeof patch.structuralPath !== 'string' || !Number.isSafeInteger(patch.rangeStart) || !Number.isSafeInteger(patch.rangeEnd) || patch.rangeStart < 0 || patch.rangeEnd <= patch.rangeStart || typeof patch.expectedOriginalText !== 'string' || typeof patch.replacementText !== 'string' || patch.replacementText.length > MAX_REPLACEMENT_CHARACTERS || !validXmlText(patch.replacementText)) fail('DOCX_PATCH_INVALID', '修改标识、文字或范围无效；本轮不支持新增换行、制表符和控制字符。');
    ids.add(patch.id);
    const key = keyOf(patch.partName, patch.structuralPath); const target = loaded.targets.get(key); const original = originalByKey.get(key);
    if (!target || original === undefined) fail('DOCX_PATCH_STALE', '原文位置已失效，请重新定位并生成修改。');
    if (target.reason || target.text !== original || !target.spans.length) fail('DOCX_TARGET_UNSUPPORTED', target.reason ?? '原文与可编辑文本位置不一致，不能安全写回。');
    if (patch.rangeEnd > original.length || !validBoundary(original, patch.rangeStart) || !validBoundary(original, patch.rangeEnd) || original.slice(patch.rangeStart, patch.rangeEnd) !== patch.expectedOriginalText) fail('DOCX_PATCH_STALE', '原文文字或范围已变化，旧修改不能套用。');
    if (target.segmented) {
      const owner = target.spans.find(span => span.text.length && span.start <= patch.rangeStart && patch.rangeEnd <= span.finish);
      if (!owner) fail('DOCX_TARGET_UNSUPPORTED', '此段仅支持单个普通文字片段内修改；不能跨越片段、权限/书签锚点、分页或修订边界。');
      owners.set(patch.id, owner);
    }
    const group = grouped.get(key) ?? []; group.push(patch); grouped.set(key, group);
  }
  const replacementsByPart = new Map<string, Array<{ start: number; end: number; text: string }>>();
  for (const [key, group] of grouped) {
    group.sort((a, b) => a.rangeStart - b.rangeStart || a.rangeEnd - b.rangeEnd);
    for (let index = 1; index < group.length; index++) if (group[index].rangeStart < group[index - 1].rangeEnd) fail('DOCX_PATCH_CONFLICT', '已采纳修改的范围重复或重叠，请选择其中一项。');
    const target = loaded.targets.get(key)!; const part = group[0].partName; const xml = loaded.xml.get(part)!;
    let expected = target.text;
    for (const patch of [...group].reverse()) expected = expected.slice(0, patch.rangeStart) + patch.replacementText + expected.slice(patch.rangeEnd);
    expectedByKey.set(key, expected);
    const affected = new Map<TextSpan, Array<{ start: number; end: number; text: string }>>();
    for (const originalPatch of group) {
      const patch = minimalPatch(originalPatch); if (!patch) continue;
      // A fragment replacement can minimize to insertion at a shared text
      // boundary. Keep its original authorized owner, even when the previous
      // run has the same visible end offset across an opaque zero-width anchor.
      const owner = owners.get(originalPatch.id); const candidates = owner ? [owner] : target.spans;
      const spans = patch.rangeStart === patch.rangeEnd
        ? [candidates.find(span => span.text.length && span.start <= patch.rangeStart && span.finish >= patch.rangeStart)].filter((span): span is TextSpan => Boolean(span))
        : candidates.filter(span => span.finish > patch.rangeStart && span.start < patch.rangeEnd);
      if (!spans.length) fail('DOCX_PATCH_STALE', '无法将修改范围映射到原文文字节点。');
      if (spans.length > 1) warnings.add('部分修改跨越多个文字片段，新文字继承首个受影响片段的格式；请核对粗体、字体等局部样式。');
      spans.forEach((span, index) => {
        const edits = affected.get(span) ?? [];
        edits.push({ start: Math.max(patch.rangeStart, span.start) - span.start, end: Math.min(patch.rangeEnd, span.finish) - span.start, text: index === 0 ? patch.replacementText : '' }); affected.set(span, edits);
      });
    }
    const changes = replacementsByPart.get(part) ?? [];
    for (const [span, edits] of affected) {
      let value = xml.slice(span.openEnd, span.contentEnd); const offsets = rawOffsets(value);
      for (const edit of edits.sort((a, b) => b.start - a.start)) value = value.slice(0, offsets[edit.start]) + escape(edit.text) + value.slice(offsets[edit.end]);
      changes.push({ start: span.openStart, end: span.contentEnd, text: preserveSpace(xml.slice(span.openStart, span.openEnd)) + value });
    }
    replacementsByPart.set(part, changes);
  }
  await verifyEntries(loaded.zip, inspectDocxZip(bytes));
  for (const [part, changes] of replacementsByPart) {
    let xml = loaded.xml.get(part)!;
    for (const change of changes.sort((a, b) => b.start - a.start)) xml = xml.slice(0, change.start) + change.text + xml.slice(change.end);
    const entry = loaded.zip.file(part)!; const original = await entry.async('nodebuffer');
    loaded.zip.file(part, encode(xml, original), { date: entry.date, comment: entry.comment, unixPermissions: entry.unixPermissions, dosPermissions: entry.dosPermissions, compression: 'STORE' });
  }
  // Preserve each unchanged part's original compression; changed XML uses STORE
  // so we do not create a highly compressible part rejected by import policy.
  const result = await loaded.zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  if (result.length > DOCUMENT_LIMITS.fileBytes) fail('DOCX_PATCH_INVALID', '修改稿超过文件大小上限，请减少修改或拆分合同。');
  const verified = await parseDocx(result);
  const actual = new Map(verified.blocks.flatMap(block => block.locator.kind === 'docx' ? [[keyOf(block.locator.partName, block.locator.structuralPath), block.text] as const] : []));
  for (const [key, expected] of expectedByKey) {
    // Empty paragraphs are kept in OOXML but omitted by the read-only parser.
    if ((expected.trim() ? actual.get(key) : actual.get(key) ?? '') !== (expected.trim() ? expected : '')) fail('DOCX_PATCH_VERIFICATION_FAILED', '修改稿回读与预期不一致，未生成可交付文件。');
    actual.delete(key);
  }
  if (actual.size) fail('DOCX_PATCH_VERIFICATION_FAILED', '修改稿出现非预期的新文本块，已阻止交付。');
  if (loaded.parsed.partial) warnings.add('原文包含未完整解析的内容；未修改部件会保留，修改稿仍需结合原件复核这些内容。');
  return { bytes: result, warnings: [...warnings] };
}

type XmlElementRange = { name: string; uri: string; ns: Record<string, string>; attrs: Record<string, string>; start: number; openEnd: number; closeStart: number; end: number; selfClosing: boolean; parent?: XmlElementRange; children: XmlElementRange[] };
/** Namespace-aware offsets only: never normalize or serialize existing XML. */
function xmlElementRanges(xml: string, inheritedNamespaces: Record<string, string> = {}): XmlElementRange[] {
  const elements: XmlElementRange[] = []; const stack: XmlElementRange[] = []; let cursor = 0;
  while ((cursor = xml.indexOf('<', cursor)) !== -1) {
    if (elements.length > 300_000) fail('DOCX_TARGET_UNSUPPORTED', 'DOCX XML 结构过于复杂，暂不能生成原生修订。');
    const special = xml.startsWith('<!--', cursor) ? '-->' : xml.startsWith('<![CDATA[', cursor) ? ']]>' : xml.startsWith('<?', cursor) ? '?>' : null;
    if (special) { cursor = xml.indexOf(special, cursor + 2) + special.length; continue; }
    let quote = ''; let end = cursor + 1;
    for (; end < xml.length; end++) {
      const character = xml[end];
      if (quote) { if (character === quote) quote = ''; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
    }
    const token = xml.slice(cursor, end + 1);
    if (/^<\//.test(token)) { const element = stack.pop(); if (!element) fail('DOCX_PATCH_INVALID', 'XML 层级不能可靠核对。'); element.closeStart = cursor; element.end = end + 1; cursor = end + 1; continue; }
    const name = /^<\s*([^\s/>]+)/.exec(token)?.[1]; if (!name) fail('DOCX_PATCH_INVALID', 'XML 标签不能可靠核对。');
    const attrs = attributes(token); const parent = stack.at(-1); const ns = { ...(parent?.ns ?? inheritedNamespaces) };
    for (const [key, value] of Object.entries(attrs)) if (key === 'xmlns') ns[''] = value; else if (key.startsWith('xmlns:')) ns[key.slice(6)] = value;
    const element: XmlElementRange = { name, uri: namespace(name, ns), ns, attrs, start: cursor, openEnd: end + 1, closeStart: end + 1, end: end + 1, selfClosing: /\/\s*>$/.test(token), parent, children: [] };
    parent?.children.push(element); elements.push(element); if (!element.selfClosing) stack.push(element);
    cursor = end + 1;
  }
  if (stack.length) fail('DOCX_PATCH_INVALID', 'XML 元素未可靠闭合。');
  return elements;
}
function attributeEscape(value: string): string { return escape(value).replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
function unusedRevisionPrefix(elements: XmlElementRange[]): string {
  const used = new Set<string>();
  for (const element of elements) {
    for (const prefix of Object.keys(element.ns)) used.add(prefix);
    for (const name of [element.name, ...Object.keys(element.attrs)]) if (name.includes(':')) used.add(name.split(':')[0]);
  }
  let prefix = 'lawrev'; for (let n = 2; used.has(prefix); n++) prefix = `lawrev${n}`;
  return prefix;
}
function childName(root: XmlElementRange, child: string): string { return root.name.includes(':') ? `${root.name.split(':')[0]}:${child}` : child; }
function appendXmlChild(xml: string, root: XmlElementRange, content: string, before = root.closeStart): string {
  if (root.selfClosing) return xml.slice(0, root.start) + xml.slice(root.start, root.openEnd).replace(/\/\s*>$/, '>') + content + `</${root.name}>` + xml.slice(root.end);
  return xml.slice(0, before) + content + xml.slice(before);
}
async function writeXmlPart(zip: JSZip, part: string, xml: string): Promise<void> {
  const entry = zip.file(part); const original = entry ? await entry.async('nodebuffer') : Buffer.alloc(0);
  zip.file(part, encode(xml, original), { date: entry?.date, comment: entry?.comment, unixPermissions: entry?.unixPermissions, dosPermissions: entry?.dosPermissions, compression: 'STORE', createFolders: false });
}
const EARLY_SETTINGS = new Set(['writeProtection', 'view', 'zoom', 'removePersonalInformation', 'removeDateAndTime', 'doNotDisplayPageBoundaries', 'displayBackgroundShape', 'printPostScriptOverText', 'printFractionalCharacterWidth', 'printFormsData', 'embedTrueTypeFonts', 'embedSystemFonts', 'saveSubsetFonts', 'saveFormsData', 'mirrorMargins', 'alignBordersAndEdges', 'bordersDoNotSurroundHeader', 'bordersDoNotSurroundFooter', 'gutterAtTop', 'hideSpellingErrors', 'hideGrammaticalErrors', 'activeWritingStyle', 'proofState', 'formsDesign', 'attachedTemplate', 'linkStyles', 'stylePaneFormatFilter', 'stylePaneSortMethod', 'documentType', 'mailMerge']);
/** revisionView controls display only. Actual ins/del markup is created below. */
async function enableRevisionDisplay(loaded: Loaded, sourceMetadata: ReturnType<typeof inspectDocxZip>): Promise<void> {
  const packageRelationships = xmlElementRanges(await readDocxXmlPart(loaded.zip, sourceMetadata, '_rels/.rels'));
  const mains = packageRelationships.filter(element => local(element.name) === 'Relationship' && element.attrs.Type?.endsWith('/officeDocument'));
  if (mains.length !== 1 || mains[0].attrs.TargetMode === 'External' || !mains[0].attrs.Target) fail('DOCX_PATCH_INVALID', '主文档关系不能可靠核对。');
  const mainPart = normalizedPart('', mains[0].attrs.Target); const mainXml = loaded.xml.get(mainPart);
  if (!mainXml) fail('DOCX_PATCH_INVALID', '主文档定位无效。');
  const mainRoot = xmlElementRanges(mainXml)[0];
  if (!WORD_NAMESPACES.has(mainRoot.uri) || local(mainRoot.name) !== 'document') fail('DOCX_TARGET_UNSUPPORTED', '主文档命名空间不能可靠生成原生修订。');
  const uri = mainRoot.uri; const relType = `${uri.startsWith('http://purl.') ? 'http://purl.oclc.org/ooxml/officeDocument/relationships' : 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}/settings`;
  const relPart = path.posix.join(path.posix.dirname(mainPart), '_rels', `${path.posix.basename(mainPart)}.rels`);
  const packageUri = 'http://schemas.openxmlformats.org/package/2006/relationships';
  let relXml = loaded.zip.file(relPart) ? await readDocxXmlPart(loaded.zip, sourceMetadata, relPart) : `<Relationships xmlns="${packageUri}"></Relationships>`;
  const relRoot = xmlElementRanges(relXml)[0];
  if (local(relRoot.name) !== 'Relationships' || relRoot.uri !== packageUri) fail('DOCX_TARGET_UNSUPPORTED', '设置关系不能可靠核对，未生成修订稿。');
  const relations = relRoot.children.filter(element => element.uri === packageUri && local(element.name) === 'Relationship');
  const settingsRelations = relations.filter(element => element.attrs.Type?.endsWith('/settings'));
  if (settingsRelations.length > 1 || settingsRelations.some(element => element.attrs.TargetMode === 'External' || !element.attrs.Target)) fail('DOCX_TARGET_UNSUPPORTED', '设置部件关系存在歧义，未生成修订稿。');
  const settingsPart = settingsRelations[0] ? normalizedPart(mainPart, settingsRelations[0].attrs.Target) : path.posix.join(path.posix.dirname(mainPart), 'settings.xml');
  let settingXml: string;
  if (loaded.zip.file(settingsPart)) {
    settingXml = await readDocxXmlPart(loaded.zip, sourceMetadata, settingsPart);
  } else settingXml = `<w:settings xmlns:w="${uri}"></w:settings>`;
  const settings = xmlElementRanges(settingXml); const root = settings[0];
  if (local(root.name) !== 'settings' || !WORD_NAMESPACES.has(root.uri)) fail('DOCX_TARGET_UNSUPPORTED', '设置命名空间无法可靠核对，未生成修订稿。');
  const views = settings.filter(element => local(element.name) === 'revisionView');
  const displayPrefix = unusedRevisionPrefix(settings);
  if (views.length > 1 || views.some(view => view.parent !== root || view.uri !== root.uri || view.children.length || settingXml.slice(view.openEnd, view.closeStart).trim())) fail('DOCX_TARGET_UNSUPPORTED', '修订显示设置存在歧义，未生成修订稿。');
  if (views[0]) {
    const view = views[0]; let opening = settingXml.slice(view.start, view.openEnd);
    const names = new Set(['insDel', 'markup', 'formatting', 'inkAnnotations']);
    opening = opening.replace(/\s+([\w:.-]+)\s*=\s*(?:"[^"]*"|'[^']*')/g, (match, name: string) => name.includes(':') && namespace(name, view.ns) === root.uri && names.has(local(name)) ? '' : match);
    const prefix = displayPrefix;
    const extra = ` xmlns:${prefix}="${root.uri}" ${[...names].map(name => `${prefix}:${name}="1"`).join(' ')}`;
    opening = opening.replace(/\/?\s*>$/, match => extra + match);
    settingXml = settingXml.slice(0, view.start) + opening + settingXml.slice(view.openEnd);
  } else {
    const view = `<${displayPrefix}:revisionView xmlns:${displayPrefix}="${root.uri}" ${displayPrefix}:markup="1" ${displayPrefix}:insDel="1" ${displayPrefix}:formatting="1" ${displayPrefix}:inkAnnotations="1"/>`;
    const next = root.children.find(element => element.uri !== root.uri || !EARLY_SETTINGS.has(local(element.name)));
    settingXml = appendXmlChild(settingXml, root, view, next?.start ?? root.closeStart);
  }
  await writeXmlPart(loaded.zip, settingsPart, settingXml);
  if (!settingsRelations.length) {
    const used = new Set(relations.map(element => element.attrs.Id)); let id = 'rIdLawRevisionSettings'; for (let n = 2; used.has(id); n++) id = `rIdLawRevisionSettings${n}`;
    relXml = appendXmlChild(relXml, relRoot, `<${childName(relRoot, 'Relationship')} Id="${id}" Type="${relType}" Target="${attributeEscape(path.posix.relative(path.posix.dirname(mainPart), settingsPart))}"/>`);
    await writeXmlPart(loaded.zip, relPart, relXml);
  }
  const typesXml = await readDocxXmlPart(loaded.zip, sourceMetadata, '[Content_Types].xml');
  const typesRoot = xmlElementRanges(typesXml)[0]; const contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml';
  if (local(typesRoot.name) !== 'Types' || typesRoot.uri !== 'http://schemas.openxmlformats.org/package/2006/content-types') fail('DOCX_TARGET_UNSUPPORTED', '内容类型命名空间不能可靠核对。');
  const overrides = typesRoot.children.filter(element => local(element.name) === 'Override' && element.attrs.PartName === `/${settingsPart}`);
  if (overrides.length > 1 || overrides.some(element => element.attrs.ContentType !== contentType)) fail('DOCX_TARGET_UNSUPPORTED', '设置部件类型不能可靠核对，未生成修订稿。');
  if (!overrides.length) await writeXmlPart(loaded.zip, '[Content_Types].xml', appendXmlChild(typesXml, typesRoot, `<${childName(typesRoot, 'Override')} PartName="/${attributeEscape(settingsPart)}" ContentType="${contentType}"/>`));
}

/** Real Word revisions, separate from the unchanged clean-export operation. */
export async function applyDocxTrackedPatches(bytes: Buffer, patches: DocxTextPatch[], metadata: { author: string; date: string }): Promise<{ bytes: Buffer; warnings: string[] }> {
  if (!metadata || typeof metadata.author !== 'string' || !metadata.author.trim() || metadata.author.length > 255 || !validXmlText(metadata.author) || typeof metadata.date !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(metadata.date) || metadata.date.startsWith('0000') || !Number.isFinite(Date.parse(metadata.date)) || new Date(metadata.date).toISOString().slice(0, 19) !== metadata.date.slice(0, 19)) fail('DOCX_PATCH_INVALID', '修订作者或UTC时间无效，未生成修订稿。');
  // Reuse every source/range/overlap/owner/ZIP gate and the authoritative clean
  // result. Nothing in the existing clean-export implementation is changed.
  const clean = await applyDocxPatches(bytes, patches); const loaded = await load(bytes); const metadataZip = inspectDocxZip(bytes);
  await verifyEntries(loaded.zip, metadataZip);
  const used = new Set<string>();
  for (const part of metadataZip.keys()) if (/\.xml$/i.test(part)) {
    for (const element of xmlElementRanges(await readDocxXmlPart(loaded.zip, metadataZip, part))) for (const [name, value] of Object.entries(element.attrs)) {
      if (name.includes(':') && WORD_NAMESPACES.has(namespace(name, element.ns)) && local(name) === 'id') {
        if (!/^[+-]?\d{1,20}$/.test(value)) fail('DOCX_TARGET_UNSUPPORTED', '原有Word标识不能可靠核对，未生成修订稿。');
        used.add(BigInt(value).toString());
      }
    }
  }
  let nextId = 0; const newIds = new Set<string>();
  const allocate = () => { while (used.has(String(nextId))) nextId++; if (nextId > 2147483647) fail('DOCX_PATCH_INVALID', '可用修订编号不足。'); const id = String(nextId++); used.add(id); newIds.add(id); return id; };
  type Edit = { start: number; end: number; text: string };
  const affected = new Map<string, Map<RunRecord, Map<TextSpan, Edit[]>>>();
  for (const originalPatch of patches) {
    const target = loaded.targets.get(keyOf(originalPatch.partName, originalPatch.structuralPath))!; const patch = minimalPatch(originalPatch); if (!patch) continue;
    const owner = target.segmented ? target.spans.find(span => span.text.length && span.start <= originalPatch.rangeStart && originalPatch.rangeEnd <= span.finish) : undefined;
    const candidates = owner ? [owner] : target.spans;
    const spans = patch.rangeStart === patch.rangeEnd ? [candidates.find(span => span.text.length && span.start <= patch.rangeStart && patch.rangeStart <= span.finish)!] : candidates.filter(span => span.finish > patch.rangeStart && span.start < patch.rangeEnd);
    spans.forEach((span, index) => {
      if (!span?.run || span.uri !== span.run.uri || !span.name || span.run.end <= span.run.openEnd) fail('DOCX_TARGET_UNSUPPORTED', '此文字片段的run或命名空间不能安全生成原生修订。');
      const runs = affected.get(originalPatch.partName) ?? new Map(); const texts = runs.get(span.run) ?? new Map(); const edits = texts.get(span) ?? [];
      edits.push({ start: Math.max(patch.rangeStart, span.start) - span.start, end: Math.min(patch.rangeEnd, span.finish) - span.start, text: index === 0 ? patch.replacementText : '' });
      texts.set(span, edits); runs.set(span.run, texts); affected.set(originalPatch.partName, runs);
    });
  }
  if (!affected.size) return { bytes: Buffer.from(bytes), warnings: [...clean.warnings, '未产生文字差异，未增加修订。'] };
  const modified = new Map<string, string>();
  for (const [part, runs] of affected) {
    const xml = loaded.xml.get(part)!; const replacements: Array<{ start: number; end: number; text: string }> = [];
    const revisionPrefix = unusedRevisionPrefix(xmlElementRanges(xml));
    for (const [run, spans] of runs) {
      const runOpening = xml.slice(run.openStart, run.openEnd); const runClosing = xml.slice(run.contentEnd, run.end); const properties = run.properties ? xml.slice(run.properties.start, run.properties.end) : '';
      const bodyStart = run.properties?.end ?? run.openEnd;
      if (run.properties && xml.slice(run.openEnd, run.properties.start).trim()) fail('DOCX_TARGET_UNSUPPORTED', 'run属性顺序不能安全拆分为原生修订。');
      const wrapRun = (content: string) => runOpening + properties + content + runClosing;
      const revision = (kind: 'ins' | 'del', content: string) => `<${revisionPrefix}:${kind} xmlns:${revisionPrefix}="${run.uri}" ${revisionPrefix}:id="${allocate()}" ${revisionPrefix}:author="${attributeEscape(metadata.author)}" ${revisionPrefix}:date="${attributeEscape(metadata.date)}">${wrapRun(content)}</${revisionPrefix}:${kind}>`;
      let result = ''; let cursor = bodyStart;
      for (const [span, edits] of [...spans].sort((a, b) => a[0].openStart - b[0].openStart)) {
        if (span.openStart < bodyStart) fail('DOCX_TARGET_UNSUPPORTED', '文字片段与run属性范围冲突。');
        const preceding = xml.slice(cursor, span.openStart); if (preceding) result += wrapRun(preceding);
        const raw = xml.slice(span.openEnd, span.contentEnd); const offsets = rawOffsets(raw); const opening = preserveSpace(xml.slice(span.openStart, span.openEnd)); const closing = xml.slice(span.contentEnd, span.end);
        const deletedOpening = opening.replace(/^<\s*[^\s/>]+/, `<${span.name!.includes(':') ? span.name!.split(':')[0] + ':' : ''}delText`);
        const deletedClosing = closing.replace(/<\/[^\s>]+/, `</${span.name!.includes(':') ? span.name!.split(':')[0] + ':' : ''}delText`);
        let position = 0;
        for (const edit of edits.sort((a, b) => a.start - b.start || a.end - b.end)) {
          if (edit.start > position) result += wrapRun(opening + raw.slice(offsets[position], offsets[edit.start]) + closing);
          if (edit.end > edit.start) result += revision('del', deletedOpening + raw.slice(offsets[edit.start], offsets[edit.end]) + deletedClosing);
          if (edit.text) result += revision('ins', opening + escape(edit.text) + closing);
          position = edit.end;
        }
        if (position < span.text.length) result += wrapRun(opening + raw.slice(offsets[position]) + closing);
        cursor = span.end;
      }
      const following = xml.slice(cursor, run.contentEnd); if (following) result += wrapRun(following);
      replacements.push({ start: run.openStart, end: run.end, text: result });
    }
    let revised = xml;
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) revised = revised.slice(0, replacement.start) + replacement.text + revised.slice(replacement.end);
    modified.set(part, revised); await writeXmlPart(loaded.zip, part, revised);
  }
  await enableRevisionDisplay(loaded, metadataZip);
  const result = await loaded.zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  if (result.length > DOCUMENT_LIMITS.fileBytes) fail('DOCX_PATCH_INVALID', '原生修订稿超过文件大小上限。');
  const comparable = (document: Loaded['parsed']) => JSON.stringify(document.blocks.map(block => ({ text: block.text, kind: block.kind, locator: block.locator })));
  if (comparable(await parseDocx(result)) !== comparable(await parseDocx(clean.bytes))) fail('DOCX_PATCH_VERIFICATION_FAILED', '修订稿接受新增修订后的文字与清洁稿不一致。');
  // Reject only the IDs generated by this call; old revisions are opaque and
  // keep their original author/date/content, including empty numPr/ins.
  for (const [part, xml] of modified) {
    let rejected = xml; const replacements: Array<{ start: number; end: number; text: string }> = [];
    for (const element of xmlElementRanges(xml)) {
      if (!WORD_NAMESPACES.has(element.uri) || !['ins', 'del'].includes(local(element.name))) continue;
      const id = Object.entries(element.attrs).find(([name]) => name.includes(':') && namespace(name, element.ns) === element.uri && local(name) === 'id')?.[1];
      if (!id || !newIds.has(id)) continue;
      let content = local(element.name) === 'ins' ? '' : xml.slice(element.openEnd, element.closeStart);
      if (content) {
        const textChanges = xmlElementRanges(content, element.ns).filter(child => child.uri === element.uri && local(child.name) === 'delText');
        for (const child of textChanges.sort((a, b) => b.start - a.start)) {
          const name = child.name.includes(':') ? child.name.split(':')[0] + ':t' : 't';
          const restored = content.slice(child.start, child.end).replace(/^<\s*[^\s/>]+/, `<${name}`).replace(/<\/[^\s>]+>$/, `</${name}>`);
          content = content.slice(0, child.start) + restored + content.slice(child.end);
        }
      }
      replacements.push({ start: element.start, end: element.end, text: content });
    }
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) rejected = rejected.slice(0, replacement.start) + replacement.text + rejected.slice(replacement.end);
    await writeXmlPart(loaded.zip, part, rejected);
  }
  const rejected = await loaded.zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  if (comparable(await parseDocx(rejected)) !== comparable(loaded.parsed)) fail('DOCX_PATCH_VERIFICATION_FAILED', '修订稿拒绝新增修订后未还原原文最终文字。');
  return { bytes: result, warnings: [...clean.warnings, '已生成Word原生插入/删除修订；显示方式仍取决于Word或阅读器的修订视图设置。', '原有修订记录保留；接受或拒绝本次新增修订时，请核对作者、时间及全文。'] };
}
