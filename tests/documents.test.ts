import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DOCUMENT_LIMITS, DocumentParseError, detectLanguage, parseContract } from '../src/core/documents';
import { createDocx, createPdf } from './fixtures-documents';

async function withFile<T>(extension: string, contents: Buffer | string, callback: (file: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'law-documents-'));
  const file = path.join(folder, `contract${extension}`);
  try {
    await writeFile(file, contents);
    return await callback(file);
  } finally { await rm(folder, { recursive: true, force: true }); }
}

function hasCode(code: string): (error: unknown) => boolean {
  return error => error instanceof DocumentParseError && error.code === code;
}

test('language heuristic identifies Chinese, English, Thai, mixed and unknown text', () => {
  assert.equal(detectLanguage('甲方应当按照合同约定支付服务费用'), 'zh');
  assert.equal(detectLanguage('The customer shall pay the service fee'), 'en');
  assert.equal(detectLanguage('ผู้ซื้อจะต้องชำระค่าบริการตามสัญญา'), 'th');
  assert.equal(detectLanguage('甲方应当按照合同约定支付费用 The customer shall pay the service fee ผู้ซื้อจะต้องชำระค่าบริการ'), 'mixed');
  assert.equal(detectLanguage('12345 / % 2026-10-22'), 'unknown');
});

test('DOCX extracts original trilingual paragraphs, table cells and linked headers/footers with OOXML locators', async () => {
  const paragraphs = ['  甲方 & 乙方 <合同>  ', 'The service fee is 00123.00 USD.', 'ผู้ซื้อจะต้องชำระค่าบริการตามสัญญา'];
  const buffer = await createDocx({ paragraphs, header: '合同页眉', footer: 'Contract footer', rawBody: '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>验收条件</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Acceptance criteria</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' });
  await withFile('.docx', buffer, async file => {
    const parsed = await parseContract(file);
    assert.equal(parsed.format, 'docx');
    assert.equal(parsed.language, 'mixed');
    assert.equal(parsed.partial, false);
    assert.equal(parsed.pageCount, null);
    assert.deepEqual(parsed.blocks.slice(0, 3).map(block => block.text), paragraphs);
    assert.deepEqual(parsed.blocks.filter(block => block.kind === 'table_cell').map(block => block.text), ['验收条件', 'Acceptance criteria']);
    const header = parsed.blocks.find(block => block.kind === 'header');
    assert.equal(header?.text, '合同页眉');
    assert.ok(header?.locator.kind === 'docx' && header.locator.partName === 'word/header1.xml');
    assert.equal(parsed.blocks.find(block => block.kind === 'footer')?.text, 'Contract footer');
    const first = parsed.blocks[0];
    assert.ok(first.locator.kind === 'docx');
    if (first.locator.kind !== 'docx') throw new Error('not docx');
    assert.equal(first.locator.paragraphId, '00000001');
    assert.equal(first.locator.structuralPath, '/w:document[1]/w:body[1]/w:p[1]');
    assert.ok(parsed.blocks.find(block => block.kind === 'table_cell')?.locator.kind === 'docx');
    assert.equal(new Set(parsed.blocks.map(block => block.id)).size, parsed.blocks.length);
    assert.deepEqual(parsed.blocks.map(block => block.ordinal), parsed.blocks.map((_, index) => index));
    assert.ok(parsed.warnings.some(warning => warning.includes('语言检测')));
  });
});

test('DOCX preserves tabs, breaks, numeric strings and built-in XML entities without processing declarations', async () => {
  const buffer = await createDocx({ rawBody: '<w:p><w:r><w:t>00123 &amp; A</w:t><w:tab/><w:t>泰文</w:t><w:br/><w:t>&#x0E01;&#3586;</w:t></w:r></w:p>' });
  await withFile('.docx', buffer, async file => {
    assert.equal((await parseContract(file)).blocks[0].text, '00123 & A\t泰文\nกข');
  });
});

test('DOCX preserves literal CDATA text rather than decoding its entity-looking strings', async () => {
  const buffer = await createDocx({ rawBody: '<w:p><w:r><w:t><![CDATA[&amp; literal <tag> ภาษาไทย]]></w:t></w:r></w:p>' });
  await withFile('.docx', buffer, async file => {
    assert.equal((await parseContract(file)).blocks[0].text, '&amp; literal <tag> ภาษาไทย');
  });
});

test('DOCX marks unsupported image content and revisions as partial, excluding deleted text', async () => {
  const buffer = await createDocx({ rawBody: '<w:p><w:del><w:r><w:delText>deleted</w:delText></w:r></w:del><w:ins><w:r><w:t>current term</w:t></w:r></w:ins><w:r><w:drawing/></w:r></w:p>' });
  await withFile('.docx', buffer, async file => {
    const parsed = await parseContract(file);
    assert.equal(parsed.partial, true);
    assert.equal(parsed.blocks[0].text, 'current term');
    assert.ok(parsed.warnings.some(warning => warning.includes('OCR 尚未实现')));
    assert.ok(parsed.warnings.some(warning => warning.includes('修订标记')));
  });
});

test('DOCX rejects DTD and external entity declarations, including UTF-16 XML', async () => {
  const xml = '<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&xxe;</w:t></w:r></w:p></w:body></w:document>';
  for (const mainXml of [xml, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')])]) {
    await withFile('.docx', await createDocx({ mainXml }), file => assert.rejects(parseContract(file), hasCode('UNSAFE_DOCUMENT')));
  }
});

test('DOCX rejects corrupted packages, malformed XML, empty documents and unsupported .doc', async () => {
  await withFile('.docx', 'not a zip', file => assert.rejects(parseContract(file), hasCode('DOCUMENT_CORRUPT')));
  await withFile('.docx', await createDocx({ mainXml: '<w:document><w:body></w:document>' }), file => assert.rejects(parseContract(file), hasCode('DOCUMENT_CORRUPT')));
  await withFile('.docx', await createDocx(), file => assert.rejects(parseContract(file), hasCode('EMPTY_DOCUMENT')));
  await withFile('.docx', await createDocx({ header: 'Header only' }), file => assert.rejects(parseContract(file), hasCode('EMPTY_DOCUMENT')));
  await withFile('.doc', 'legacy', file => assert.rejects(parseContract(file), hasCode('UNSUPPORTED_FORMAT')));
});

test('DOCX rejects path traversal entries and forged XML uncompressed sizes', async () => {
  const traversal = await createDocx({ paragraphs: ['Contract'], extraFiles: { '../outside.xml': 'unsafe' } });
  await withFile('.docx', traversal, file => assert.rejects(parseContract(file), hasCode('UNSAFE_DOCUMENT')));
  const forged = Buffer.from(await createDocx({ paragraphs: ['Contract'] }));
  let cursor = 0;
  for (;;) {
    cursor = forged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), cursor);
    if (cursor === -1) throw new Error('fixture central directory missing');
    const nameSize = forged.readUInt16LE(cursor + 28);
    const name = forged.subarray(cursor + 46, cursor + 46 + nameSize).toString();
    if (name === 'word/document.xml') { forged.writeUInt32LE(1, cursor + 24); break; }
    cursor += 46 + nameSize + forged.readUInt16LE(cursor + 30) + forged.readUInt16LE(cursor + 32);
  }
  await withFile('.docx', forged, file => assert.rejects(parseContract(file), hasCode('DOCUMENT_LIMIT_EXCEEDED')));
});

test('DOCX rejects encrypted ZIP entries, compound encrypted Office and suspicious expansion', async () => {
  const encryptedZip = Buffer.from(await createDocx({ paragraphs: ['Contract'] }));
  const central = encryptedZip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  encryptedZip.writeUInt16LE(encryptedZip.readUInt16LE(central + 8) | 1, central + 8);
  await withFile('.docx', encryptedZip, file => assert.rejects(parseContract(file), hasCode('ENCRYPTED_DOCUMENT')));
  await withFile('.docx', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), file => assert.rejects(parseContract(file), hasCode('ENCRYPTED_OR_LEGACY_DOCUMENT')));
  const bomb = await createDocx({ paragraphs: ['Contract'], extraFiles: { 'word/unused.xml': 'A'.repeat(200_000) }, compression: 'DEFLATE' });
  await withFile('.docx', bomb, file => assert.rejects(parseContract(file), hasCode('DOCUMENT_LIMIT_EXCEEDED')));
});

test('input file size limit rejects a sparse oversized file before reading it', async () => {
  await withFile('.docx', '', async file => {
    await truncate(file, DOCUMENT_LIMITS.fileBytes + 1);
    await assert.rejects(parseContract(file), hasCode('DOCUMENT_LIMIT_EXCEEDED'));
  });
});

test('PDF extracts real trilingual text and normalized top-left page coordinates across pages', async () => {
  const lines = ['合同付款与验收条件', 'The customer shall pay the service fee.', 'ผู้ซื้อจะต้องชำระค่าบริการตามสัญญา'];
  await withFile('.pdf', createPdf([lines, ['Second page']]), async file => {
    const parsed = await parseContract(file);
    assert.equal(parsed.format, 'pdf');
    assert.equal(parsed.pageCount, 2);
    assert.equal(parsed.language, 'mixed');
    assert.equal(parsed.partial, false);
    assert.deepEqual(parsed.blocks.map(block => block.text), [...lines, 'Second page']);
    const first = parsed.blocks[0].locator;
    assert.equal(first.kind, 'pdf');
    if (first.kind !== 'pdf') throw new Error('not pdf');
    assert.equal(first.pageIndex, 0);
    assert.equal(first.pageWidth, 612);
    assert.equal(first.pageHeight, 792);
    assert.equal(first.boxes[0].x, 40);
    assert.ok(first.boxes[0].y > 20 && first.boxes[0].y < 50, 'y is measured from page top, not PDF bottom');
    assert.ok(first.boxes[0].width > 0 && first.boxes[0].height > 0);
    const last = parsed.blocks.at(-1)!.locator;
    assert.ok(last.kind === 'pdf' && last.pageIndex === 1);
  });
});

test('rotated PDF reports rotated viewport dimensions and bounded text boxes', async () => {
  await withFile('.pdf', createPdf([['Rotated contract']], 90), async file => {
    const parsed = await parseContract(file);
    assert.equal(parsed.blocks[0].text, 'Rotated contract');
    const locator = parsed.blocks[0].locator;
    assert.ok(locator.kind === 'pdf');
    if (locator.kind !== 'pdf') throw new Error('not pdf');
    assert.equal(locator.pageWidth, 792);
    assert.equal(locator.pageHeight, 612);
    assert.ok(locator.boxes.every(box => box.x >= 0 && box.y >= 0 && box.x + box.width <= locator.pageWidth && box.y + box.height <= locator.pageHeight));
  });
});

test('mixed and fully scanned PDFs expose missing text coverage without pretending OCR exists', async () => {
  await withFile('.pdf', createPdf([['Readable contract'], null]), async file => {
    const parsed = await parseContract(file);
    assert.equal(parsed.partial, true);
    assert.equal(parsed.blocks.length, 1);
    assert.ok(parsed.warnings.some(warning => warning.includes('第 2 页') && warning.includes('OCR 尚未实现')));
  });
  await withFile('.pdf', createPdf([null]), async file => {
    const parsed = await parseContract(file);
    assert.equal(parsed.partial, true);
    assert.equal(parsed.blocks.length, 0);
    assert.equal(parsed.language, 'unknown');
    assert.ok(parsed.warnings.some(warning => warning.includes('不能启动合同审核')));
  });
});

test('PDF rejects invalid content and page counts beyond engineering limit', async () => {
  await withFile('.pdf', 'not a pdf', file => assert.rejects(parseContract(file), hasCode('DOCUMENT_CORRUPT')));
  await withFile('.pdf', '%PDF-1.7\ninvalid', file => assert.rejects(parseContract(file), hasCode('DOCUMENT_CORRUPT')));
  await withFile('.pdf', createPdf(Array.from({ length: DOCUMENT_LIMITS.pdfPages + 1 }, () => ['Page'])), file => assert.rejects(parseContract(file), hasCode('DOCUMENT_LIMIT_EXCEEDED')));
});
