import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { ContractBlock, Language, ParsedContract } from '../shared/contracts';
import { createDocxNumbering } from './docx-numbering';

/** 工程暂定资源上限，可经真实合同样本评测后调整；不是产品承诺或法律标准。 */
export const DOCUMENT_LIMITS = Object.freeze({
  fileBytes: 50 * 1024 * 1024,
  pdfPages: 100,
  zipEntries: 2048,
  zipUncompressedBytes: 100 * 1024 * 1024,
  zipCompressionRatio: 200,
  xmlPartBytes: 8 * 1024 * 1024,
  xmlDepth: 100,
  blocks: 20_000,
  textCharacters: 2_000_000,
});

export class DocumentParseError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'DocumentParseError';
  }
}

const languageWarning = '语言检测基于中文、拉丁和泰文字符比例；拉丁文字暂按英文识别，结果需人工确认。';

/** 字符脚本启发式，不是语言模型；不能区分英文与其他拉丁文字，也不推断适用法律。 */
export function detectLanguage(text: string): Language {
  const counts = { zh: 0, en: 0, th: 0 };
  for (const character of text) {
    if (/\p{Script=Han}/u.test(character)) counts.zh += 1;
    else if (/\p{Script=Thai}/u.test(character) && /\p{Letter}/u.test(character)) counts.th += 1;
    else if (/\p{Script=Latin}/u.test(character) && /\p{Letter}/u.test(character)) counts.en += 1;
  }
  const entries = Object.entries(counts) as Array<['zh' | 'en' | 'th', number]>;
  entries.sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (!total) return 'unknown';
  if (entries.filter(([, count]) => count >= 4 && count / total >= 0.15).length > 1) return 'mixed';
  return entries[0][0];
}

export async function parseContract(filePath: string): Promise<ParsedContract> {
  const extension = path.extname(filePath).toLowerCase();
  if (extension !== '.docx' && extension !== '.pdf') {
    throw new DocumentParseError('UNSUPPORTED_FORMAT', '仅支持 .docx 和 .pdf；旧版 .doc 请先另存为 .docx。');
  }
  const bytes = await readLimitedFile(filePath);
  if (!bytes.length) throw new DocumentParseError('EMPTY_DOCUMENT', '文件为空，没有可审核的合同文字。');
  if (extension === '.docx') return parseDocx(bytes);
  return parsePdf(bytes);
}

async function readLimitedFile(filePath: string): Promise<Buffer> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new DocumentParseError('DOCUMENT_UNREADABLE', '请选择可读取的合同文件。');
    if (info.size > DOCUMENT_LIMITS.fileBytes) throw limitError('输入文件超过暂定的 50 MB 上限。');
    let size = 0;
    const chunks: Buffer[] = [];
    // 流式读取也检查尺寸，防止文件在 stat 之后增长而绕过上限。
    for await (const chunk of createReadStream(filePath)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > DOCUMENT_LIMITS.fileBytes) throw limitError('输入文件超过暂定的 50 MB 上限。');
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof DocumentParseError) throw error;
    throw new DocumentParseError('DOCUMENT_UNREADABLE', '无法读取合同文件，请确认文件存在且有读取权限。');
  }
}

function limitError(message: string): DocumentParseError {
  return new DocumentParseError('DOCUMENT_LIMIT_EXCEEDED', message);
}

type ZipEntryMetadata = { size: number; crc32: number; compression: 'STORE' | 'DEFLATE' };

/** 解压前读取 ZIP 中央目录；拒绝加密、路径穿越、重复名称、ZIP64 及异常资源声明。 */
function inspectZip(bytes: Buffer): Map<string, ZipEntryMetadata> {
  if (bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    throw new DocumentParseError('ENCRYPTED_OR_LEGACY_DOCUMENT', '检测到复合二进制 Office 文件，可能是加密文档或旧版 .doc；请解密并另存为 .docx。');
  }
  let end = -1;
  for (let cursor = bytes.length - 22; cursor >= Math.max(0, bytes.length - 22 - 65_535); cursor -= 1) {
    if (bytes.readUInt32LE(cursor) === 0x06054b50 && cursor + 22 + bytes.readUInt16LE(cursor + 20) === bytes.length) {
      end = cursor;
      break;
    }
  }
  if (end < 0) throw new DocumentParseError('DOCUMENT_CORRUPT', 'DOCX 的 ZIP 目录缺失或损坏。');
  const count = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralOffset = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count) {
    throw new DocumentParseError('UNSUPPORTED_FORMAT', '不支持分卷 DOCX/ZIP。');
  }
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw limitError('不支持 ZIP64 DOCX；请缩减文件后重试。');
  }
  if (!count || count > DOCUMENT_LIMITS.zipEntries) throw limitError('DOCX 内部文件数量为空或超过暂定上限。');
  if (centralOffset + centralSize > end) throw new DocumentParseError('DOCUMENT_CORRUPT', 'DOCX 中央目录范围无效。');
  const entries = new Map<string, ZipEntryMetadata>();
  let cursor = centralOffset;
  let totalSize = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > centralOffset + centralSize || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new DocumentParseError('DOCUMENT_CORRUPT', 'DOCX 内部文件目录损坏。');
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28);
    const extraSize = bytes.readUInt16LE(cursor + 30);
    const commentSize = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameSize + extraSize + commentSize;
    if (next > centralOffset + centralSize) throw new DocumentParseError('DOCUMENT_CORRUPT', 'DOCX 内部文件名称或附加数据越界。');
    if (flags & 1) throw new DocumentParseError('ENCRYPTED_DOCUMENT', 'DOCX 内含加密 ZIP 项，请先解密文件。');
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) throw limitError('不支持 ZIP64 DOCX。');
    if (method !== 0 && method !== 8) throw new DocumentParseError('UNSUPPORTED_FORMAT', 'DOCX 使用了不支持的 ZIP 压缩方式。');
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameSize).toString('utf8');
    if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..')) {
      throw new DocumentParseError('UNSAFE_DOCUMENT', 'DOCX 内部包含不安全的文件路径。');
    }
    if (entries.has(name)) throw new DocumentParseError('UNSAFE_DOCUMENT', 'DOCX 内部存在重复文件名称。');
    if (localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new DocumentParseError('DOCUMENT_CORRUPT', 'DOCX 内部文件头无效。');
    }
    const dataOffset = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
    if (dataOffset + compressedSize > centralOffset) throw new DocumentParseError('DOCUMENT_CORRUPT', 'DOCX 压缩内容越界。');
    totalSize += size;
    if (totalSize > DOCUMENT_LIMITS.zipUncompressedBytes || size > Math.max(1, compressedSize) * DOCUMENT_LIMITS.zipCompressionRatio) {
      throw limitError('DOCX 解压体积或压缩比超过暂定安全上限。');
    }
    entries.set(name, { size, crc32: bytes.readUInt32LE(cursor + 16), compression: method === 8 ? 'DEFLATE' : 'STORE' });
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize) throw new DocumentParseError('DOCUMENT_CORRUPT', 'DOCX 中央目录记录数量不一致。');
  return entries;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let result = value;
  for (let bit = 0; bit < 8; bit += 1) result = result & 1 ? 0xedb88320 ^ (result >>> 1) : result >>> 1;
  return result >>> 0;
});

async function readXmlPart(zip: JSZip, metadata: Map<string, ZipEntryMetadata>, partName: string): Promise<string> {
  const entry = zip.file(partName);
  const declared = metadata.get(partName);
  if (!entry || !declared) throw new DocumentParseError('DOCUMENT_CORRUPT', `DOCX 缺少必需部件：${partName}。`);
  if (declared.size > DOCUMENT_LIMITS.xmlPartBytes) throw limitError('DOCX 的 XML 部件超过暂定的 8 MB 上限。');
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const stream = entry.nodeStream('nodebuffer');
    const chunks: Buffer[] = [];
    let size = 0;
    let crc = 0xffffffff;
    let settled = false;
    stream.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > DOCUMENT_LIMITS.xmlPartBytes || size > declared.size) {
        settled = true;
        stream.pause();
        (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        reject(limitError('DOCX XML 实际解压体积超过声明或安全上限。'));
        return;
      }
      for (const byte of chunk) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      chunks.push(chunk);
    });
    stream.on('error', () => {
      if (!settled) {
        settled = true;
        reject(new DocumentParseError('DOCUMENT_CORRUPT', 'DOCX XML 部件解压失败。'));
      }
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      if (size !== declared.size || ((crc ^ 0xffffffff) >>> 0) !== declared.crc32) {
        reject(new DocumentParseError('DOCUMENT_CORRUPT', 'DOCX XML 部件长度或校验和无效。'));
      } else resolve(Buffer.concat(chunks, size));
    });
  });
  // OOXML 通常为 UTF-8；同时接受带 BOM 的 UTF-16，避免忽略编码后绕过声明检查。
  let xml: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) xml = bytes.subarray(2).toString('utf16le');
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    if (bytes.length % 2) throw new DocumentParseError('DOCUMENT_CORRUPT', 'DOCX XML 编码损坏。');
    xml = Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  } else xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  validateXmlSafety(xml);
  return xml;
}

function validateXmlSafety(xml: string): void {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new DocumentParseError('UNSAFE_DOCUMENT', 'DOCX XML 包含不允许的 DTD 或实体声明。');
  }
  let cursor = 0;
  let depth = 0;
  while ((cursor = xml.indexOf('<', cursor)) !== -1) {
    const special = xml.startsWith('<!--', cursor) ? '-->' : xml.startsWith('<![CDATA[', cursor) ? ']]>' : xml.startsWith('<?', cursor) ? '?>' : null;
    if (special) {
      const end = xml.indexOf(special, cursor + 2);
      if (end < 0) throw new DocumentParseError('DOCUMENT_CORRUPT', 'DOCX XML 注释或声明未闭合。');
      cursor = end + special.length;
      continue;
    }
    let quote = '';
    let end = cursor + 1;
    for (; end < xml.length; end += 1) {
      const character = xml[end];
      if (quote) { if (character === quote) quote = ''; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
    }
    if (end === xml.length) throw new DocumentParseError('DOCUMENT_CORRUPT', 'DOCX XML 标签未闭合。');
    const tag = xml.slice(cursor + 1, end).trim();
    if (tag.startsWith('/')) depth -= 1;
    else if (!tag.endsWith('/')) depth += 1;
    if (depth > DOCUMENT_LIMITS.xmlDepth) throw limitError('DOCX XML 嵌套深度超过暂定安全上限。');
    cursor = end + 1;
  }
  if (XMLValidator.validate(xml) !== true) throw new DocumentParseError('DOCUMENT_CORRUPT', 'DOCX XML 结构无效。');
}

type XmlNode = { [key: string]: XmlNode[] | Record<string, string> | string };
const xmlParser = new XMLParser({
  preserveOrder: true, ignoreAttributes: false, trimValues: false,
  parseTagValue: false, parseAttributeValue: false, processEntities: false, cdataPropName: '#cdata',
});
function parseXml(xml: string): XmlNode[] { return xmlParser.parse(xml) as XmlNode[]; }
function tagOf(node: XmlNode): string | null { return Object.keys(node).find(key => key !== ':@' && key !== '#text' && !key.startsWith('?')) ?? null; }
function localName(tag: string): string { return tag.replace(/^@_/, '').split(':').at(-1) ?? tag; }
function childrenOf(node: XmlNode, tag: string): XmlNode[] { return Array.isArray(node[tag]) ? node[tag] as XmlNode[] : []; }
function attribute(node: XmlNode, name: string): string | null {
  const attributes = node[':@'];
  if (!attributes || typeof attributes === 'string' || Array.isArray(attributes)) return null;
  const key = Object.keys(attributes).find(key => localName(key) === name);
  return key ? decodeXmlText(String(attributes[key])) : null;
}
function decodeXmlText(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, entity => {
    const names: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (entity in names) return names[entity];
    const value = entity.startsWith('&#x') ? Number.parseInt(entity.slice(3, -1), 16) : Number.parseInt(entity.slice(2, -1), 10);
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : '\ufffd';
  });
}

function relationships(nodes: XmlNode[]): Array<{ id: string; type: string; target: string; external: boolean }> {
  const result: Array<{ id: string; type: string; target: string; external: boolean }> = [];
  const walk = (items: XmlNode[]): void => {
    for (const node of items) {
      const tag = tagOf(node);
      if (!tag) continue;
      if (localName(tag) === 'Relationship') {
        const id = attribute(node, 'Id'); const type = attribute(node, 'Type'); const target = attribute(node, 'Target');
        if (id && type && target) result.push({ id, type, target, external: attribute(node, 'TargetMode') === 'External' });
      }
      walk(childrenOf(node, tag));
    }
  };
  walk(nodes);
  return result;
}

function resolvePart(basePart: string, target: string): string {
  if (target.includes('\\') || target.includes('\0') || /^[a-z][a-z\d+.-]*:/i.test(target)) {
    throw new DocumentParseError('UNSAFE_DOCUMENT', 'DOCX 部件引用包含外部地址或不安全路径。');
  }
  const resolved = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(basePart), target));
  if (resolved === '..' || resolved.startsWith('../')) throw new DocumentParseError('UNSAFE_DOCUMENT', 'DOCX 部件引用越出文件范围。');
  return resolved;
}

async function parseDocx(bytes: Buffer): Promise<ParsedContract> {
  try {
    const metadata = inspectZip(bytes);
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false });
    const rootRelationships = relationships(parseXml(await readXmlPart(zip, metadata, '_rels/.rels')));
    const mainRelationship = rootRelationships.find(item => item.type.endsWith('/officeDocument'));
    if (!mainRelationship || mainRelationship.external) throw new DocumentParseError('DOCUMENT_CORRUPT', 'DOCX 缺少有效的主文档关系。');
    const mainPart = resolvePart('', mainRelationship.target);
    const contentTypes = parseXml(await readXmlPart(zip, metadata, '[Content_Types].xml'));
    let mainType: string | null = null;
    for (const node of contentTypes) {
      const tag = tagOf(node);
      if (!tag) continue;
      for (const override of childrenOf(node, tag)) {
        const childTag = tagOf(override);
        if (childTag && localName(childTag) === 'Override' && attribute(override, 'PartName') === `/${mainPart}`) mainType = attribute(override, 'ContentType');
      }
    }
    if (mainType !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml') {
      throw new DocumentParseError('UNSUPPORTED_FORMAT', '文件不是受支持的 DOCX 主文档，或包含宏/其他 Office 文档类型。');
    }
    const mainNodes = parseXml(await readXmlPart(zip, metadata, mainPart));
    const root = mainNodes.find(node => { const tag = tagOf(node); return tag && localName(tag) === 'document'; });
    const rootTag = root && tagOf(root);
    const body = root && rootTag && childrenOf(root, rootTag).find(node => { const tag = tagOf(node); return tag && localName(tag) === 'body'; });
    if (!root || !rootTag || !body) throw new DocumentParseError('DOCUMENT_CORRUPT', 'DOCX 主文档缺少 document/body 结构。');
    const blocks: ContractBlock[] = [];
    const warnings = new Set<string>([languageWarning]);
    let partial = false;
    let textCharacters = 0;
    const relatedIds = new Map<string, 'header' | 'footer'>();
    const warn = (message: string): void => { warnings.add(message); partial = true; };
    const relsPart = path.posix.join(path.posix.dirname(mainPart), '_rels', `${path.posix.basename(mainPart)}.rels`);
    const mainRels = zip.file(relsPart) ? relationships(parseXml(await readXmlPart(zip, metadata, relsPart))) : [];
    const loadRelated = async (kind: 'numbering' | 'styles'): Promise<XmlNode[] | null> => {
      const matches = mainRels.filter(item => item.type.endsWith(`/${kind}`));
      if (!matches.length) return null;
      if (matches.length !== 1 || matches[0].external) { warn('自动编号或样式关系缺失、重复或引用外部部件，相关条款编号需人工核对。'); return null; }
      const part = resolvePart(mainPart, matches[0].target);
      if (!zip.file(part)) { warn('自动编号或样式部件缺失，相关条款编号需人工核对。'); return null; }
      return parseXml(await readXmlPart(zip, metadata, part));
    };
    const numbering = createDocxNumbering({ numbering: await loadRelated('numbering'), styles: await loadRelated('styles'), main: mainNodes, warn });
    const paragraphText = (nodes: XmlNode[]): string => {
      let result = '';
      for (const node of nodes) {
        const tag = tagOf(node);
        if (!tag) continue;
        const local = localName(tag);
        if (local === 'del' || local === 'moveFrom' || local === 'delText' || local === 'instrText' || local === 'drawing' || local === 'pict' || local === 'object' || local === 'txbxContent') continue;
        if (local === 't') result += childrenOf(node, tag).map(child => {
          if (typeof child['#text'] === 'string') return decodeXmlText(child['#text']);
          const cdata = child['#cdata'];
          return Array.isArray(cdata) ? cdata.map(segment => typeof segment['#text'] === 'string' ? segment['#text'] : '').join('') : '';
        }).join('');
        else if (local === 'tab') result += '\t';
        else if (local === 'br' || local === 'cr') result += '\n';
        else if (local === 'noBreakHyphen') result += '\u2011';
        else if (local === 'softHyphen') result += '\u00ad';
        else result += paragraphText(childrenOf(node, tag));
      }
      return result;
    };
    const inspectNodes = (nodes: XmlNode[]): void => {
      for (const node of nodes) {
        const tag = tagOf(node);
        if (!tag) continue;
        const local = localName(tag);
        if (local === 'headerReference' || local === 'footerReference') {
          const id = attribute(node, 'id');
          if (id) relatedIds.set(id, local === 'headerReference' ? 'header' : 'footer');
        }
        if (['drawing', 'object', 'pict', 'txbxContent', 'altChunk'].includes(local)) warn('文档包含图片、图形、文本框或嵌入内容；该内容未完成文字识别，OCR 尚未实现。');
        if (['del', 'ins', 'moveFrom', 'moveTo'].includes(local)) warn('文档包含修订标记；正文按新增文字保留、删除文字排除提取，请核对最终签署版本。');
        if (local === 'vanish') warn('文档包含隐藏文字标记，提取结果需要核对文字可见性。');
        if (['footnoteReference', 'endnoteReference', 'sym'].includes(local)) warn('文档包含脚注、尾注或特殊符号，相关内容需人工核对。');
        inspectNodes(childrenOf(node, tag));
      }
    };
    const walk = (nodes: XmlNode[], parentPath: string, partName: string, context: ContractBlock['kind']): void => {
      const counts = new Map<string, number>();
      for (const node of nodes) {
        const tag = tagOf(node);
        if (!tag) continue;
        const ordinal = (counts.get(tag) ?? 0) + 1;
        counts.set(tag, ordinal);
        const locatorPath = `${parentPath}/${tag}[${ordinal}]`;
        const local = localName(tag);
        if (local === 'del' || local === 'moveFrom' || local === 'drawing' || local === 'object' || local === 'pict' || local === 'txbxContent' || local === 'altChunk') continue;
        if (local === 'p') {
          const text = paragraphText(childrenOf(node, tag));
          const numberingLabel = numbering.label(childrenOf(node, tag), partName === mainPart);
          if (text.trim()) {
            textCharacters += text.length;
            if (blocks.length >= DOCUMENT_LIMITS.blocks || textCharacters > DOCUMENT_LIMITS.textCharacters) throw limitError('DOCX 文字块数量或文字总量超过暂定上限。');
            blocks.push({ id: randomUUID(), ordinal: blocks.length, kind: context, text, ...(numberingLabel ? { numberingLabel } : {}),
              locator: { kind: 'docx', partName, structuralPath: locatorPath, paragraphId: attribute(node, 'paraId') } });
          }
        } else walk(childrenOf(node, tag), locatorPath, partName, local === 'tc' && context === 'paragraph' ? 'table_cell' : context);
      }
    };
    inspectNodes(mainNodes);
    walk(mainNodes, '', mainPart, 'paragraph');
    if (!blocks.length) throw new DocumentParseError('EMPTY_DOCUMENT', 'DOCX 正文没有可提取的合同文字；图片和扫描内容需要 OCR，本版尚未实现。');
    if (relatedIds.size) {
      const rels = mainRels;
      const parsed = new Set<string>();
      for (const [id, kind] of relatedIds) {
        const relationship = rels.find(item => item.id === id && item.type.endsWith(`/${kind}`));
        if (!relationship || relationship.external) { warn('部分页眉或页脚引用缺失/为外部引用，未完成提取。'); continue; }
        const partName = resolvePart(mainPart, relationship.target);
        if (parsed.has(partName)) continue;
        if (!zip.file(partName)) { warn('部分页眉或页脚部件缺失，未完成提取。'); continue; }
        const nodes = parseXml(await readXmlPart(zip, metadata, partName));
        inspectNodes(nodes);
        walk(nodes, '', partName, kind);
        parsed.add(partName);
      }
    }
    return { format: 'docx', language: detectLanguage(blocks.map(block => block.text).join('\n')), blocks, warnings: [...warnings], pageCount: null, partial };
  } catch (error) {
    if (error instanceof DocumentParseError) throw error;
    throw new DocumentParseError('DOCUMENT_CORRUPT', 'DOCX 损坏、编码无效或无法解析，请用 Word 检查后重新保存。');
  }
}

// The write-back pipeline reuses exactly the same package/CRC/XML checks as
// import. These helpers do not grant access to files outside the supplied ZIP.
export { parseDocx, inspectZip as inspectDocxZip, readXmlPart as readDocxXmlPart };

async function parsePdf(bytes: Buffer): Promise<ParsedContract> {
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new DocumentParseError('DOCUMENT_CORRUPT', 'PDF 文件头无效。');
  const { getDocument, Util } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false,
    useSystemFonts: false, disableFontFace: true, enableXfa: false, stopAtErrors: true,
    disableRange: true, disableStream: true, disableAutoFetch: true, maxImageSize: 0, verbosity: 0 });
  try {
    const document = await loadingTask.promise;
    if (document.numPages > DOCUMENT_LIMITS.pdfPages) throw limitError('PDF 超过暂定的 100 页上限。');
    const blocks: ContractBlock[] = [];
    const warnings = [languageWarning, 'PDF 文字提取不能保证还原多栏、复杂表格或绘图的阅读顺序；图片内容未进行 OCR。'];
    let partial = false;
    let textCharacters = 0;
    for (let pageIndex = 0; pageIndex < document.numPages; pageIndex += 1) {
      const before = blocks.length;
      try {
        const page = await document.getPage(pageIndex + 1);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent({ disableNormalization: true });
        let line: { text: string; boxes: Array<{ x: number; y: number; width: number; height: number }>; baseline: number; height: number } | null = null;
        const flush = (): void => {
          if (line?.text.trim()) {
            textCharacters += line.text.length;
            if (blocks.length >= DOCUMENT_LIMITS.blocks || textCharacters > DOCUMENT_LIMITS.textCharacters) throw limitError('PDF 文字块数量或文字总量超过暂定上限。');
            blocks.push({ id: randomUUID(), ordinal: blocks.length, kind: 'paragraph', text: line.text,
              locator: { kind: 'pdf', pageIndex, pageWidth: viewport.width, pageHeight: viewport.height, boxes: line.boxes } });
          }
          line = null;
        };
        for (const item of content.items) {
          if (!('str' in item)) continue;
          const transform = Util.transform(viewport.transform, item.transform);
          const height = Math.max(1, Math.hypot(transform[2], transform[3]));
          const horizontalLength = Math.max(0.0001, Math.hypot(transform[0], transform[1]));
          const scale = Math.hypot(viewport.transform[0], viewport.transform[1]);
          const width = Math.abs(item.width * scale);
          const style = content.styles[item.fontName];
          const ascent = typeof style?.ascent === 'number' ? style.ascent : 0.8;
          const descent = typeof style?.descent === 'number' ? style.descent : -0.2;
          const ux = transform[0] / horizontalLength * width;
          const uy = transform[1] / horizontalLength * width;
          const corners = [
            [transform[4] + transform[2] * ascent, transform[5] + transform[3] * ascent],
            [transform[4] + transform[2] * descent, transform[5] + transform[3] * descent],
            [transform[4] + ux + transform[2] * ascent, transform[5] + uy + transform[3] * ascent],
            [transform[4] + ux + transform[2] * descent, transform[5] + uy + transform[3] * descent],
          ];
          const left = Math.max(0, Math.min(viewport.width, ...corners.map(corner => corner[0])));
          const top = Math.max(0, Math.min(viewport.height, ...corners.map(corner => corner[1])));
          const right = Math.max(left, Math.min(viewport.width, Math.max(...corners.map(corner => corner[0]))));
          const bottom = Math.max(top, Math.min(viewport.height, Math.max(...corners.map(corner => corner[1]))));
          const box = { x: left, y: top, width: right - left, height: bottom - top };
          if (line && Math.abs(line.baseline - transform[5]) > Math.max(2, Math.min(line.height, height) * 0.45)) flush();
          if (!line) line = { text: '', boxes: [], baseline: transform[5], height };
          const previous = line.boxes.at(-1);
          if (previous && box.x - previous.x - previous.width > height * 0.15 && /[\p{Script=Latin}\p{Number}]$/u.test(line.text) && /^[\p{Script=Latin}\p{Number}]/u.test(item.str)) line.text += ' ';
          line.text += item.str;
          if (item.str) line.boxes.push(box);
          if (item.hasEOL) flush();
        }
        flush();
        page.cleanup();
        if (blocks.length === before) {
          partial = true;
          warnings.push(`第 ${pageIndex + 1} 页没有可提取文字，可能为扫描页或空白页；OCR 尚未实现，该页未完成审核准备。`);
        }
      } catch (error) {
        if (error instanceof DocumentParseError) throw error;
        partial = true;
        warnings.push(`第 ${pageIndex + 1} 页文字解析失败，该页内容未完成提取。`);
      }
    }
    if (!blocks.length) warnings.push('整份 PDF 没有可审核文字；必须先提供文字版或完成 OCR，不能启动合同审核。');
    return { format: 'pdf', language: detectLanguage(blocks.map(block => block.text).join('\n')), blocks, warnings, pageCount: document.numPages, partial };
  } catch (error) {
    if (error instanceof DocumentParseError) throw error;
    if (error instanceof Error && error.name === 'PasswordException') throw new DocumentParseError('ENCRYPTED_DOCUMENT', 'PDF 已加密或需要密码，请解密后再导入。');
    throw new DocumentParseError('DOCUMENT_CORRUPT', 'PDF 损坏或无法解析，请检查原文件。');
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}
