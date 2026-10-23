import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { createDocx } from './fixtures-documents';
import { inspectDocxZip, parseDocx, readDocxXmlPart } from '../src/core/documents';
import { applyDocxPatches, applyDocxTrackedPatches, createDocxEditableCopy, DocxPatchError, inspectDocxEditProtection, inspectDocxTargets, type DocxEditableSegment, type DocxEditableTarget, type DocxTextPatch } from '../src/core/docx-patcher';

function patch(target: DocxEditableTarget, replacementText: string, overrides: Partial<DocxTextPatch> = {}): DocxTextPatch {
  return { id: 'change-1', blockId: 'block-1', partName: target.partName, structuralPath: target.structuralPath,
    rangeStart: 0, rangeEnd: target.text.length, expectedOriginalText: target.text, replacementText, ...overrides };
}
async function contents(bytes: Buffer): Promise<Record<string, Buffer>> {
  const zip = await JSZip.loadAsync(bytes); const result: Record<string, Buffer> = {};
  for (const [name, file] of Object.entries(zip.files)) if (!file.dir) result[name] = await file.async('nodebuffer');
  return result;
}
const code = (value: string) => (error: unknown) => error instanceof DocxPatchError && error.code === value;
function segmentPatch(target: DocxEditableTarget, segment: DocxEditableSegment, replacementText: string, id = 'segment-1'): DocxTextPatch {
  return patch(target, replacementText, { id, rangeStart: segment.rangeStart, rangeEnd: segment.rangeEnd, expectedOriginalText: segment.text });
}
const nonTextShape = (xml: string) => xml.replace(/<w:t(?=[\s>])[^>]*>[\s\S]*?<\/w:t>/g, '<w:t/>');

test('三语正文、表格、页眉可以定点修改，未修改部件及样式保留，输入字节不变', async () => {
  const rawBody = '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="336633"/></w:rPr><w:t>中文验收条件</w:t></w:r></w:p>' +
    '<w:tbl><w:tblPr><w:tblW w:w="8000" w:type="dxa"/></w:tblPr><w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>Payment after delivery.</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>ชำระค่าบริการหลังส่งมอบ</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
  const input = await createDocx({ paragraphs: ['保持不变的条款。'], rawBody, header: '合同页眉', footer: 'Page footer', extraFiles: { 'word/media/logo.bin': '\u0001\u0002Unchanged image data', 'word/styles.xml': '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:styleId="Normal"/></w:styles>' } });
  const snapshot = Buffer.from(input); const targets = await inspectDocxTargets(input);
  assert.ok(targets.every(target => target.editable));
  const replacements = new Map([['中文验收条件', '中文书面验收条件'], ['Payment after delivery.', 'Payment after written acceptance.'], ['ชำระค่าบริการหลังส่งมอบ', 'ชำระค่าบริการหลังตรวจรับ'], ['合同页眉', '合同审核页眉']]);
  const edits = targets.filter(target => replacements.has(target.text)).map((target, index) => patch(target, replacements.get(target.text)!, { id: `edit-${index}` }));
  const output = await applyDocxPatches(input, edits);
  const parsed = await parseDocx(output.bytes);
  for (const value of replacements.values()) assert.ok(parsed.blocks.some(block => block.text === value));
  assert.ok(parsed.blocks.some(block => block.kind === 'table_cell' && block.text === 'Payment after written acceptance.'));
  assert.ok(parsed.blocks.some(block => block.kind === 'header' && block.text === '合同审核页眉'));
  assert.ok(parsed.blocks.some(block => block.text === '保持不变的条款。'));
  assert.deepEqual(input, snapshot);
  const before = await contents(input); const after = await contents(output.bytes);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  for (const name of Object.keys(before).filter(name => !['word/document.xml', 'word/header1.xml'].includes(name))) assert.deepEqual(after[name], before[name], name);
  const xml = after['word/document.xml'].toString();
  assert.ok(xml.includes('<w:pPr><w:jc w:val="center"/></w:pPr>'));
  assert.ok(xml.includes('<w:rPr><w:b/><w:color w:val="336633"/></w:rPr>'));
  assert.ok(xml.includes('<w:tblPr><w:tblW w:w="8000" w:type="dxa"/></w:tblPr>'));
});

test('整段proposal缩小到实际差异，未改变的粗体/斜体run逐字保留', async () => {
  const bold = '<w:r><w:rPr><w:b/></w:rPr><w:t>甲方</w:t></w:r>';
  const italic = '<w:r><w:rPr><w:i/></w:rPr><w:t>服务费用。</w:t></w:r>';
  const input = await createDocx({ rawBody: `<w:p>${bold}<w:r><w:t>应支付</w:t></w:r>${italic}</w:p>` });
  const target = (await inspectDocxTargets(input))[0];
  const output = await applyDocxPatches(input, [patch(target, '甲方应在书面验收后支付服务费用。')]);
  const xml = (await contents(output.bytes))['word/document.xml'].toString();
  assert.ok(xml.includes(bold)); assert.ok(xml.includes(italic));
  assert.equal((await parseDocx(output.bytes)).blocks[0].text, '甲方应在书面验收后支付服务费用。');
});

test('跨run替换保留段落与run属性，文字继承首个受影响run并有提示', async () => {
  const input = await createDocx({ rawBody: '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>付款条件：验</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>收后30日。</w:t></w:r></w:p>' });
  const target = (await inspectDocxTargets(input))[0]; const start = target.text.indexOf('验收后30日');
  const result = await applyDocxPatches(input, [patch(target, '书面确认后15日', { rangeStart: start, rangeEnd: start + '验收后30日'.length, expectedOriginalText: '验收后30日' })]);
  assert.equal((await parseDocx(result.bytes)).blocks[0].text, '付款条件：书面确认后15日。');
  assert.ok(result.warnings.some(value => value.includes('首个')));
  const xml = (await contents(result.bytes))['word/document.xml'].toString();
  assert.ok(xml.includes('<w:rPr><w:b/></w:rPr>')); assert.ok(xml.includes('<w:rPr><w:i/></w:rPr>'));
  assert.ok(xml.includes('付款条件：书面确认后15'));
  assert.ok(xml.includes('日。'), 'Unchanged suffix can retain its original run style');
});

test('同段非重叠替换使用原始坐标，多次修改及删除文字回读一致', async () => {
  const input = await createDocx({ paragraphs: ['金额100元，期限30天。', '保留正文。'] });
  const target = (await inspectDocxTargets(input))[0];
  const result = await applyDocxPatches(input, [patch(target, '200', { rangeStart: 2, rangeEnd: 5, expectedOriginalText: '100' }), patch(target, '15', { id: 'change-2', rangeStart: 9, rangeEnd: 11, expectedOriginalText: '30' })]);
  assert.equal((await parseDocx(result.bytes)).blocks[0].text, '金额200元，期限15天。');
  const deleted = await applyDocxPatches(input, [patch(target, '')]);
  assert.deepEqual((await parseDocx(deleted.bytes)).blocks.map(block => block.text), ['保留正文。']);
  assert.ok((await contents(deleted.bytes))['word/document.xml'].toString().includes('<w:p w14:paraId="00000001">'));
});

test('XML实体与首尾空格安全写回，未修改实体拼写不被规范化', async () => {
  const input = await createDocx({ rawBody: '<w:p><w:r><w:t xml:space="preserve">  &#x7532;方 &amp; 乙方 &lt;旧&gt;  </w:t></w:r></w:p>' });
  const target = (await inspectDocxTargets(input))[0]; const start = target.text.indexOf('<旧>');
  const result = await applyDocxPatches(input, [patch(target, '<新&版本>', { rangeStart: start, rangeEnd: start + 3, expectedOriginalText: '<旧>' })]);
  assert.equal((await parseDocx(result.bytes)).blocks[0].text, '  甲方 & 乙方 <新&版本>  ');
  const xml = (await contents(result.bytes))['word/document.xml'].toString();
  assert.ok(xml.includes('&#x7532;方 &amp; 乙方 &lt;新&amp;版本&gt;'));
});

test('UTF16LE与BE、UTF8 BOM保持编码，可处理不同Word命名空间前缀', async () => {
  for (const encoding of ['le', 'be', 'utf8'] as const) {
    const xml = '<?xml version="1.0" encoding="' + (encoding === 'utf8' ? 'UTF-8' : 'UTF-16') + '"?><x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><x:body><x:p><x:r><x:t>甲方支付费用。</x:t></x:r></x:p></x:body></x:document>';
    const body = encoding === 'utf8' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml)]) : Buffer.concat([Buffer.from(encoding === 'le' ? [0xff, 0xfe] : [0xfe, 0xff]), encoding === 'le' ? Buffer.from(xml, 'utf16le') : Buffer.from(xml, 'utf16le').swap16()]);
    const input = await createDocx({ mainXml: body }); const target = (await inspectDocxTargets(input))[0];
    const result = await applyDocxPatches(input, [patch(target, '甲方验收后支付费用。')]);
    assert.equal((await parseDocx(result.bytes)).blocks[0].text, '甲方验收后支付费用。');
    const raw = (await contents(result.bytes))['word/document.xml']; assert.deepEqual(raw.subarray(0, encoding === 'utf8' ? 3 : 2), body.subarray(0, encoding === 'utf8' ? 3 : 2));
  }
});

test('emoji代理对边界与泰文组合字形共同前后缀不会被拆开', async () => {
  const input = await createDocx({ paragraphs: ['甲😀方应付款。', 'ค่าบริการต้องชำระ'] });
  const targets = await inspectDocxTargets(input);
  await assert.rejects(applyDocxPatches(input, [patch(targets[0], 'x', { rangeStart: 2, rangeEnd: 3, expectedOriginalText: targets[0].text.slice(2, 3) })]), code('DOCX_PATCH_STALE'));
  const result = await applyDocxPatches(input, [patch(targets[0], '甲😃方应验收后付款。'), patch(targets[1], 'ค่าสินค้าต้องชำระ', { id: 'thai' })]);
  assert.deepEqual((await parseDocx(result.bytes)).blocks.map(block => block.text), ['甲😃方应验收后付款。', 'ค่าสินค้าต้องชำระ']);
});

test('错误原文、失效定位、重叠和重复修改会阻止写回', async () => {
  const input = await createDocx({ paragraphs: ['付款条件待确认。'] }); const target = (await inspectDocxTargets(input))[0];
  await assert.rejects(applyDocxPatches(input, [patch(target, 'new', { expectedOriginalText: '错误' })]), code('DOCX_PATCH_STALE'));
  await assert.rejects(applyDocxPatches(input, [patch(target, 'new', { structuralPath: '/w:document[1]/w:body[1]/w:p[99]' })]), code('DOCX_PATCH_STALE'));
  await assert.rejects(applyDocxPatches(input, [patch(target, 'A'), patch(target, 'B', { id: 'second' })]), code('DOCX_PATCH_CONFLICT'));
  await assert.rejects(applyDocxPatches(input, [patch(target, 'A'), patch(target, 'B')]), code('DOCX_PATCH_INVALID'));
});

test('新换行/tab、非法XML字符、孤立代理对与空范围明确拒绝', async () => {
  const input = await createDocx({ paragraphs: ['付款条件待确认。'] }); const target = (await inspectDocxTargets(input))[0];
  for (const value of ['新\n段落', '新\r段落', '新\t列', '新\0文字', '\ud800']) await assert.rejects(applyDocxPatches(input, [patch(target, value)]), code('DOCX_PATCH_INVALID'));
  await assert.rejects(applyDocxPatches(input, [patch(target, 'new', { rangeStart: 0, rangeEnd: 0, expectedOriginalText: '' })]), code('DOCX_PATCH_INVALID'));
});

test('复杂段落局部拒绝，不阻止同文档简单段落写回', async () => {
  const cases = [
    '<w:hyperlink><w:r><w:t>linked term</w:t></w:r></w:hyperlink>',
    '<w:ins><w:r><w:t>inserted term</w:t></w:r></w:ins>',
    '<w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden term</w:t></w:r>',
    '<w:r><w:fldChar w:fldCharType="begin"/><w:t>field term</w:t></w:r>',
    '<w:r><w:t>line one</w:t><w:br/><w:t>line two</w:t></w:r>',
    '<w:r><w:t>cell one</w:t><w:tab/><w:t>cell two</w:t></w:r>',
    '<w:r><w:t>image term</w:t><w:drawing/></w:r>',
    '<w:r><w:t><![CDATA[CDATA term]]></w:t></w:r>',
  ];
  for (const body of cases) {
    const input = await createDocx({ paragraphs: ['简单条款'], rawBody: `<w:p>${body}</w:p>` }); const targets = await inspectDocxTargets(input);
    assert.equal(targets[0].editable, true); assert.equal(targets[1].editable, false);
    await assert.rejects(applyDocxPatches(input, [patch(targets[1], 'modified')]), code('DOCX_TARGET_UNSUPPORTED'));
    const result = await applyDocxPatches(input, [patch(targets[0], '已确认的简单条款')]);
    assert.equal((await parseDocx(result.bytes)).blocks[0].text, '已确认的简单条款');
    assert.equal((await parseDocx(result.bytes)).blocks[1].text, targets[1].text);
  }
});

test('内容控件或自定义XML内的简单paragraph也不能绕过局部保护', async () => {
  for (const wrapper of ['sdt', 'customXml']) {
    const input = await createDocx({ paragraphs: ['普通条款'], rawBody: `<w:${wrapper}><w:p><w:r><w:t>bound term</w:t></w:r></w:p></w:${wrapper}>` });
    const targets = await inspectDocxTargets(input); assert.equal(targets[0].editable, true); assert.equal(targets[1].editable, false);
  }
});

test('编辑保护和数字签名不会被绕过，保护关系支持自定义部件位置', async () => {
  const protectedDoc = await createDocx({ paragraphs: ['受保护正文'], extraFiles: {
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="settings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="custom/protection.xml"/></Relationships>',
    'word/custom/protection.xml': '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:documentProtection w:edit="readOnly" w:enforcement="1"/></w:settings>',
  } });
  for (const input of [protectedDoc, await createDocx({ paragraphs: ['数字签名正文'], extraFiles: { '_xmlsignatures/sig1.xml': '<Signature/>' } })]) {
    const targets = await inspectDocxTargets(input); assert.equal(targets[0].editable, false);
    await assert.rejects(applyDocxPatches(input, [patch(targets[0], 'modified')]), code('DOCX_TARGET_UNSUPPORTED'));
  }
});

function changeCentral(bytes: Buffer, name: string, mutate: (value: Buffer, offset: number) => void): Buffer {
  const result = Buffer.from(bytes); let cursor = 0;
  for (;;) {
    cursor = result.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), cursor);
    if (cursor < 0) throw new Error('fixture central record not found');
    const length = result.readUInt16LE(cursor + 28);
    if (result.subarray(cursor + 46, cursor + 46 + length).toString() === name) { mutate(result, cursor); return result; }
    cursor += 46 + length + result.readUInt16LE(cursor + 30) + result.readUInt16LE(cursor + 32);
  }
}

test('未解析的二进制部件也先检查实际体积和CRC，不在重新打包时无界解压', async () => {
  const input = await createDocx({ paragraphs: ['付款条件待确认。'], extraFiles: { 'word/media/opaque.bin': 'x'.repeat(60_000) }, compression: 'DEFLATE' });
  const forgedSize = changeCentral(input, 'word/media/opaque.bin', (value, offset) => value.writeUInt32LE(1, offset + 24));
  const forgedCrc = changeCentral(forgedSize, 'word/media/opaque.bin', (value, offset) => value.writeUInt32LE((value.readUInt32LE(offset + 16) ^ 1) >>> 0, offset + 16));
  for (const bytes of [forgedSize, forgedCrc]) {
    const target = (await inspectDocxTargets(bytes))[0];
    await assert.rejects(applyDocxPatches(bytes, [patch(target, '新的付款条件。')]), code('DOCX_PATCH_INVALID'));
  }
  const small = await createDocx({ paragraphs: ['付款条件待确认。'], extraFiles: { 'word/media/opaque.bin': 'ABCD'.repeat(1000) }, compression: 'STORE' });
  const invalidCrc = changeCentral(small, 'word/media/opaque.bin', (value, offset) => value.writeUInt32LE((value.readUInt32LE(offset + 16) ^ 1) >>> 0, offset + 16));
  const target = (await inspectDocxTargets(invalidCrc))[0];
  await assert.rejects(applyDocxPatches(invalidCrc, [patch(target, '新的付款条件。')]), code('DOCX_PATCH_INVALID'));
});

test('未修改压缩部件保留压缩方式及内容，修改XML使用受支持的STORE', async () => {
  const opaque = Array.from({ length: 1000 }, (_, index) => `${index.toString(36)}-opaque`).join('|');
  const input = await createDocx({ paragraphs: ['付款条件待确认。'], extraFiles: { 'word/media/opaque.bin': opaque }, compression: 'DEFLATE' });
  const target = (await inspectDocxTargets(input))[0];
  const result = await applyDocxPatches(input, [patch(target, '新的付款条件。')]);
  assert.equal(inspectDocxZip(input).get('word/media/opaque.bin')?.compression, 'DEFLATE');
  assert.equal(inspectDocxZip(result.bytes).get('word/media/opaque.bin')?.compression, 'DEFLATE');
  assert.equal(inspectDocxZip(result.bytes).get('word/document.xml')?.compression, 'STORE');
  assert.deepEqual((await contents(input))['word/media/opaque.bin'], (await contents(result.bytes))['word/media/opaque.bin']);
});

const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const readOnlyElement = '<w:documentProtection w:edit="readOnly" w:enforcement="1" w:cryptProviderType="rsaFull" w:hash="synthetic-verifier" w:salt="synthetic-salt"/>';
const settingsXml = (element: string) => `<w:settings xmlns:w="${wordNamespace}">${element}</w:settings>`;

test('只读保护仅在显式工作副本路径移除，原件、三语正文、权限范围和其他部件保持不变', async () => {
  const setting = `<?xml version="1.0"?>${settingsXml(`<w:zoom w:percent="110"/><!--keep-settings-->${readOnlyElement}<w:compat/>`)}`;
  const input = await createDocx({ paragraphs: ['普通中文条款', 'Payment follows acceptance.', 'ชำระเงินภายหลังตรวจรับ'],
    rawBody: '<w:p><w:permStart w:id="7" w:edGrp="everyone"/><w:r><w:t>保留权限范围</w:t></w:r><w:permEnd w:id="7"/></w:p><w:p><w:ins w:id="9"><w:r><w:t>保留未确认修订</w:t></w:r></w:ins></w:p>',
    header: '保留页眉', footer: 'Preserved footer', extraFiles: { 'word/settings.xml': setting, 'docProps/custom.xml': '<Properties>preserved-metadata</Properties>', 'word/media/opaque.bin': 'unchanged-binary-data' }, compression: 'DEFLATE' });
  const snapshot = Buffer.from(input);
  const state = await inspectDocxEditProtection(input);
  assert.deepEqual(Object.keys(state).sort(), ['canCreateEditableCopy', 'kind', 'reason']);
  assert.equal(state.kind, 'readOnly'); assert.equal(state.canCreateEditableCopy, true);
  assert.ok(!JSON.stringify(state).includes('synthetic-verifier')); assert.ok(!JSON.stringify(state).includes('synthetic-salt'));
  const protectedTargets = await inspectDocxTargets(input); assert.ok(protectedTargets.every(target => !target.editable));
  await assert.rejects(applyDocxPatches(input, [patch(protectedTargets[0], '修改后的普通条款')]), code('DOCX_TARGET_UNSUPPORTED'));
  const result = await createDocxEditableCopy(input);
  assert.ok(result.warnings.length); assert.deepEqual(input, snapshot);
  assert.deepEqual(await inspectDocxEditProtection(result.bytes), { kind: 'none', canCreateEditableCopy: false, reason: null });
  const targets = await inspectDocxTargets(result.bytes);
  assert.ok(targets.slice(0, 3).every(target => target.editable));
  assert.equal(targets[3].editable, true); assert.equal(targets[3].editMode, 'segments'); assert.equal(targets[4].editable, false);
  const before = await contents(input); const after = await contents(result.bytes);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  assert.equal(after['word/settings.xml'].toString(), setting.replace(readOnlyElement, ''));
  for (const name of Object.keys(before).filter(name => name !== 'word/settings.xml')) {
    assert.deepEqual(after[name], before[name], name);
    assert.equal(inspectDocxZip(result.bytes).get(name)?.compression, inspectDocxZip(input).get(name)?.compression, name);
  }
  const comparable = (document: Awaited<ReturnType<typeof parseDocx>>) => document.blocks.map(({ kind, text, locator }) => ({ kind, text, locator }));
  assert.deepEqual(comparable(await parseDocx(result.bytes)), comparable(await parseDocx(input)));
  const changed = await applyDocxPatches(result.bytes, [patch(targets[0], '普通中文条款经过书面确认')]);
  assert.equal((await parseDocx(changed.bytes)).blocks[0].text, '普通中文条款经过书面确认');
  assert.deepEqual((await contents(changed.bytes))['word/settings.xml'], after['word/settings.xml']);
});

test('没有活动限制及明确关闭的保护标记不能被工作副本路径误删', async () => {
  const ordinary = await createDocx({ paragraphs: ['普通条款'] });
  assert.deepEqual(await inspectDocxEditProtection(ordinary), { kind: 'none', canCreateEditableCopy: false, reason: null });
  await assert.rejects(createDocxEditableCopy(ordinary), code('DOCX_TARGET_UNSUPPORTED'));
  for (const enforcement of ['', ' w:enforcement="0"', ' w:enforcement="false"', ' w:enforcement="off"']) {
    const input = await createDocx({ paragraphs: ['普通条款'], extraFiles: { 'word/settings.xml': settingsXml(`<w:documentProtection w:edit="readOnly"${enforcement} w:hash="inactive-verifier"/>`) } });
    const original = Buffer.from(input);
    assert.equal((await inspectDocxEditProtection(input)).kind, 'none');
    assert.equal((await inspectDocxTargets(input))[0].editable, true);
    await assert.rejects(createDocxEditableCopy(input), code('DOCX_TARGET_UNSUPPORTED'));
    assert.deepEqual(input, original);
  }
});

test('其他模式、未知保护值、重复或不可靠命名空间始终拒绝工作副本', async () => {
  const cases = [
    settingsXml('<w:documentProtection w:edit="trackedChanges" w:enforcement="1"/>'),
    settingsXml('<w:documentProtection w:edit="forms" w:enforcement="true"/>'),
    settingsXml('<w:documentProtection w:edit="comments" w:enforcement="on"/>'),
    settingsXml('<w:documentProtection w:enforcement="1"/>'),
    settingsXml('<w:documentProtection w:edit="unknown" w:enforcement="1"/>'),
    settingsXml('<w:documentProtection w:edit="readOnly" w:enforcement="unknown"/>'),
    settingsXml('<w:documentProtection w:edit="readOnly" w:enforcement="1" w:formatting="1"/>'),
    settingsXml(`${readOnlyElement}<w:writeProtection w:recommended="1"/>`),
    settingsXml(`${readOnlyElement}${readOnlyElement}`),
    settingsXml(`<w:compat>${readOnlyElement}</w:compat>`),
    settingsXml('<x:documentProtection xmlns:x="urn:unknown" x:edit="readOnly" x:enforcement="1"/>'),
    settingsXml('<w:documentProtection edit="readOnly" enforcement="1"/>'),
    settingsXml('<w:documentProtection xmlns:x="urn:unknown" w:edit="readOnly" x:enforcement="1"/>'),
    settingsXml('<x:documentProtection xmlns:x="http://purl.oclc.org/ooxml/wordprocessingml/main" x:edit="readOnly" x:enforcement="1"/>'),
    settingsXml('<w:documentProtection w:edit="readOnly" w:enforcement="1"><w:compat/></w:documentProtection>'),
    '<x:settings xmlns:x="urn:unknown"><x:documentProtection x:edit="readOnly" x:enforcement="1"/></x:settings>',
  ];
  for (const setting of cases) {
    const input = await createDocx({ paragraphs: ['普通条款'], extraFiles: { 'word/settings.xml': setting } });
    const state = await inspectDocxEditProtection(input);
    assert.equal(state.kind, 'other'); assert.equal(state.canCreateEditableCopy, false);
    assert.equal((await inspectDocxTargets(input))[0].editable, false);
    await assert.rejects(createDocxEditableCopy(input), code('DOCX_TARGET_UNSUPPORTED'));
  }
  const multiple = await createDocx({ paragraphs: ['普通条款'], extraFiles: {
    'word/settings.xml': settingsXml(readOnlyElement),
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="settings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="custom/second-settings.xml"/></Relationships>',
    'word/custom/second-settings.xml': settingsXml(''),
  } });
  assert.equal((await inspectDocxEditProtection(multiple)).kind, 'other');
  await assert.rejects(createDocxEditableCopy(multiple), code('DOCX_TARGET_UNSUPPORTED'));
});

test('标准与Strict Word命名空间支持同命名空间别名前缀和明确活动值', async () => {
  for (const word of [wordNamespace, 'http://purl.oclc.org/ooxml/wordprocessingml/main']) for (const enforcement of ['1', 'true', 'on']) {
    const input = await createDocx({ paragraphs: ['普通条款'], extraFiles: { 'word/settings.xml': `<settings xmlns="${word}" xmlns:a="${word}"><a:documentProtection a:edit="readOnly" a:enforcement="${enforcement}"/></settings>` } });
    assert.equal((await inspectDocxEditProtection(input)).kind, 'readOnly');
    const copy = await createDocxEditableCopy(input);
    assert.equal((await inspectDocxEditProtection(copy.bytes)).kind, 'none');
    assert.equal((await inspectDocxTargets(copy.bytes))[0].editable, true);
  }
});

test('自定义设置路径、UTF16和UTF8 BOM工作副本保留编码和ZIP部件元数据', async () => {
  const body = '<x:documentProtection x:edit="readOnly" x:enforcement="true"></x:documentProtection>';
  for (const encoding of ['le', 'be', 'utf8'] as const) {
    const text = `<?xml version="1.0" encoding="${encoding === 'utf8' ? 'UTF-8' : 'UTF-16'}"?><x:settings xmlns:x="${wordNamespace}"><x:zoom x:percent="90"/>${body}<x:compat/></x:settings>`;
    const encode = (value: string) => encoding === 'utf8' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(value)]) : Buffer.concat([Buffer.from(encoding === 'le' ? [0xff, 0xfe] : [0xfe, 0xff]), encoding === 'le' ? Buffer.from(value, 'utf16le') : Buffer.from(value, 'utf16le').swap16()]);
    const zip = await JSZip.loadAsync(await createDocx({ paragraphs: ['普通条款'], extraFiles: {
      'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="settings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="custom/protection.xml"/></Relationships>',
    } }));
    const date = new Date('2025-01-02T04:06:08Z');
    zip.file('word/custom/protection.xml', encode(text), { date, comment: 'preserved-setting-comment', dosPermissions: 0x20 });
    const input = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE', comment: 'preserved-archive-comment' });
    const result = await createDocxEditableCopy(input); const output = await JSZip.loadAsync(result.bytes);
    assert.deepEqual(await output.file('word/custom/protection.xml')!.async('nodebuffer'), encode(text.replace(body, '')));
    assert.equal((output as JSZip & { comment: string }).comment, 'preserved-archive-comment');
    assert.equal(output.file('word/custom/protection.xml')!.comment, 'preserved-setting-comment');
    assert.equal(output.file('word/custom/protection.xml')!.date.getTime(), date.getTime());
    assert.equal(output.file('word/custom/protection.xml')!.dosPermissions, 0x20);
  }
});

test('数字签名的标准目录、关系或ContentType均不能进入工作副本路径', async () => {
  const base = { paragraphs: ['签名正文'], extraFiles: { 'word/settings.xml': settingsXml(readOnlyElement) } };
  const canonical = await createDocx({ ...base, extraFiles: { ...base.extraFiles, '_xmlsignatures/sig1.xml': '<Signature/>' } });
  const relation = await createDocx({ ...base, extraFiles: { ...base.extraFiles,
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="signature" Type="http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/origin" Target="custom/signatures/origin.xml"/></Relationships>',
    'custom/signatures/origin.xml': '<SignatureOrigin/>',
  } });
  const zip = await JSZip.loadAsync(await createDocx(base));
  zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml')!.async('string')).replace('</Types>', '<Override PartName="/custom/signature.xml" ContentType="application/vnd.openxmlformats-package.digital-signature-xmlsignature+xml"/></Types>'));
  zip.file('custom/signature.xml', '<Signature/>');
  for (const input of [canonical, relation, await zip.generateAsync({ type: 'nodebuffer' })]) {
    assert.equal((await inspectDocxEditProtection(input)).kind, 'signature');
    assert.equal((await inspectDocxTargets(input))[0].editable, false);
    await assert.rejects(createDocxEditableCopy(input), code('DOCX_TARGET_UNSUPPORTED'));
  }
});

test('工作副本仍校验未读取媒体的体积和CRC，并拒绝包加密或复合二进制文件', async () => {
  const input = await createDocx({ paragraphs: ['只读正文'], extraFiles: { 'word/settings.xml': settingsXml(readOnlyElement), 'word/media/opaque.bin': 'opaque-content' } });
  const forgedSize = changeCentral(input, 'word/media/opaque.bin', (value, offset) => value.writeUInt32LE(1, offset + 24));
  const forgedCrc = changeCentral(input, 'word/media/opaque.bin', (value, offset) => value.writeUInt32LE((value.readUInt32LE(offset + 16) ^ 1) >>> 0, offset + 16));
  for (const bytes of [forgedSize, forgedCrc]) await assert.rejects(createDocxEditableCopy(bytes), code('DOCX_PATCH_INVALID'));
  const encrypted = changeCentral(input, 'word/document.xml', (value, offset) => value.writeUInt16LE(value.readUInt16LE(offset + 8) | 1, offset + 8));
  await assert.rejects(createDocxEditableCopy(encrypted), (error: any) => error.code === 'ENCRYPTED_DOCUMENT');
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(32)]);
  await assert.rejects(createDocxEditableCopy(ole), (error: any) => error.code === 'ENCRYPTED_OR_LEGACY_DOCUMENT');
});

test('跨段权限/书签按story配对，零宽锚点及相邻空书签保持原字节', async () => {
  const start = '<w:permStart w:id="1" w:edGrp="everyone"/>'; const end = '<w:permEnd w:id="1"/>';
  const bookmark = '<w:bookmarkStart w:id="2" w:name="agreement"/>'; const bookmarkEnd = '<w:bookmarkEnd w:id="2"/>';
  const emptyBookmark = '<w:bookmarkStart w:id="3" w:name="_GoBack"/><w:bookmarkEnd w:id="3"/>';
  const input = await createDocx({ rawBody:
    `<w:p>${start}<w:r><w:rPr><w:b/></w:rPr><w:t>甲方先履行。</w:t></w:r></w:p>` +
    `<w:p>${bookmark}<w:r><w:t>应确认交付。</w:t></w:r></w:p>` +
    `<w:p>${end}<w:r><w:t>乙方后付款。</w:t></w:r>${bookmarkEnd}${emptyBookmark}</w:p>` });
  const targets = await inspectDocxTargets(input);
  assert.ok(targets.every(target => target.editable && target.editMode === 'segments'));
  assert.ok(targets.flatMap(target => target.segments ?? []).every(segment => /^[A-Za-z0-9_-]{1,160}$/.test(segment.id)));
  assert.ok(targets.flatMap(target => target.segments ?? []).filter(segment => !segment.editable).every(segment => segment.rangeStart === segment.rangeEnd));
  const edits = targets.map((target, index) => { const segment = target.segments!.find(item => item.editable)!; return segmentPatch(target, segment, `${segment.text}书面确认。`, `segment-${index}`); });
  const result = await applyDocxPatches(input, edits);
  const before = (await contents(input))['word/document.xml'].toString(); const after = (await contents(result.bytes))['word/document.xml'].toString();
  assert.equal(nonTextShape(after), nonTextShape(before));
  for (const value of [start, end, bookmark, bookmarkEnd, emptyBookmark]) assert.ok(after.includes(value));
  assert.deepEqual((await inspectDocxTargets(result.bytes)).map(target => target.segments!.map(segment => segment.id)), targets.map(target => target.segments!.map(segment => segment.id)));
});

test('片段模式强制原范围位于单个w:t中，不能跨锚点或多个run伪装整段修改', async () => {
  const input = await createDocx({ rawBody: '<w:p><w:r><w:t>甲方</w:t></w:r><w:permStart w:id="1" w:edGrp="everyone"/><w:r><w:rPr><w:i/></w:rPr><w:t>确认交付</w:t></w:r><w:permEnd w:id="1"/><w:r><w:t>后付款。</w:t></w:r></w:p>' });
  const target = (await inspectDocxTargets(input))[0]; const segment = target.segments!.find(item => item.editable && item.text === '确认交付')!;
  await assert.rejects(applyDocxPatches(input, [patch(target, '甲方书面确认交付后付款。')]), code('DOCX_TARGET_UNSUPPORTED'));
  await assert.rejects(applyDocxPatches(input, [patch(target, '书面确认', { rangeStart: 1, rangeEnd: 4, expectedOriginalText: target.text.slice(1, 4) })]), code('DOCX_TARGET_UNSUPPORTED'));
  const partial = await applyDocxPatches(input, [patch(target, '书面确认', { rangeStart: segment.rangeStart, rangeEnd: segment.rangeStart + 2, expectedOriginalText: '确认' })]);
  assert.equal((await parseDocx(partial.bytes)).blocks[0].text, '甲方书面确认交付后付款。');
  assert.equal(nonTextShape((await contents(partial.bytes))['word/document.xml'].toString()), nonTextShape((await contents(input))['word/document.xml'].toString()));
});

test('片段前后缀化为边界插入时始终写回授权w:t，不越过权限、空书签或分页符', async () => {
  const permissionStart = '<w:permStart w:id="1" w:edGrp="everyone"/>'; const permissionEnd = '<w:permEnd w:id="1"/>';
  const emptyBookmark = '<w:bookmarkStart w:id="2" w:name="_GoBack"/><w:bookmarkEnd w:id="2"/>';
  const pageBreak = '<w:br w:type="page"/>';
  const first = '<w:r><w:rPr><w:b/></w:rPr><w:t>前文</w:t></w:r>';
  const second = '<w:r><w:rPr><w:i/></w:rPr><w:t>目标文字</w:t></w:r>';
  for (const { between, tail } of [{ between: permissionStart, tail: permissionEnd }, { between: emptyBookmark, tail: '' }, { between: `<w:r>${pageBreak}</w:r>`, tail: '' }]) {
    const input = await createDocx({ rawBody: `<w:p>${first}${between}${second}${tail}</w:p>` });
    const target = (await inspectDocxTargets(input))[0]; const texts = target.segments!.filter(segment => segment.editable);
    assert.equal(texts.length, 2);
    const prefixed = await applyDocxPatches(input, [segmentPatch(target, texts[1], `新增${texts[1].text}`)]);
    const prefixXml = (await contents(prefixed.bytes))['word/document.xml'].toString();
    assert.ok(prefixXml.includes(first + between), 'Prefix insertion must not change the preceding bold run or enter an empty bookmark');
    assert.ok(prefixXml.includes('<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">新增目标文字</w:t></w:r>'));
    assert.ok(prefixXml.includes(second.replace('<w:t>', '<w:t xml:space="preserve">').replace('目标文字', '新增目标文字') + tail));
    const suffixed = await applyDocxPatches(input, [segmentPatch(target, texts[0], `${texts[0].text}后缀`)]);
    const suffixXml = (await contents(suffixed.bytes))['word/document.xml'].toString();
    assert.ok(suffixXml.includes('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">前文后缀</w:t></w:r>' + between));
    assert.ok(suffixXml.includes(between + second + tail), 'Suffix insertion must keep the following italic run and anchors unchanged');
    const both = await applyDocxPatches(input, [segmentPatch(target, texts[0], `${texts[0].text}后缀`, 'first'), segmentPatch(target, texts[1], `新增${texts[1].text}`, 'second')]);
    const bothXml = (await contents(both.bytes))['word/document.xml'].toString();
    assert.ok(bothXml.includes('<w:t xml:space="preserve">前文后缀</w:t></w:r>' + between + '<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">新增目标文字</w:t></w:r>' + tail));
    assert.equal(nonTextShape(bothXml), nonTextShape((await contents(input))['word/document.xml'].toString()));
  }
});

test('全story拒绝重复、倒序、未配对或namespace不明的锚点，简单段落仍可修改', async () => {
  const invalid = [
    '<w:permStart w:id="1" w:edGrp="everyone"/>',
    '<w:permStart w:id="1"/><w:permStart w:id="1"/><w:permEnd w:id="1"/>',
    '<w:permStart w:id="01"/><w:permStart w:id="1"/><w:permEnd w:id="1"/>',
    '<w:permEnd w:id="1"/><w:permStart w:id="1"/>',
    '<w:bookmarkStart w:id="1" w:name="term"/><w:bookmarkEnd w:id="2"/>',
    '<w:bookmarkStart w:id="1" w:name="term"/><w:bookmarkEnd w:id="1"/><w:bookmarkEnd w:id="1"/>',
    '<w:bookmarkStart w:name="term"/><w:bookmarkEnd w:id="1"/>',
    '<x:bookmarkStart xmlns:x="urn:unknown" w:id="1" w:name="term"/><w:bookmarkEnd w:id="1"/>',
    '<w:permStart xmlns:x="urn:unknown" x:id="1"/><w:permEnd w:id="1"/>',
    '<w:permStart w:id="1"><w:r/></w:permStart><w:permEnd w:id="1"/>',
  ];
  for (const markers of invalid) {
    const input = await createDocx({ paragraphs: ['普通段落'], rawBody: `<w:p>${markers}<w:r><w:t>不可靠锚点段落</w:t></w:r></w:p>` });
    const targets = await inspectDocxTargets(input);
    assert.equal(targets[0].editable, true); assert.equal(targets[1].editable, false);
    await assert.rejects(applyDocxPatches(input, [patch(targets[1], '不能改写')]), code('DOCX_TARGET_UNSUPPORTED'));
    assert.equal((await parseDocx((await applyDocxPatches(input, [patch(targets[0], '普通段落已确认')])).bytes)).blocks[0].text, '普通段落已确认');
  }
});

test('只放开空编号修订外的文字，原author/date/id子树及格式严格保留', async () => {
  for (const insertion of ['<w:ins w:id="8" w:author="Synthetic Author" w:date="2025-01-01T00:00:00Z"/>', '<w:ins w:id="8" w:author="Synthetic Author" w:date="2025-01-01T00:00:00Z"></w:ins>']) {
    const paragraphProperties = `<w:pPr><w:numPr>${insertion}<w:ilvl w:val="0"/><w:numId w:val="4"/></w:numPr><w:jc w:val="both"/></w:pPr>`;
    const input = await createDocx({ rawBody: `<w:p>${paragraphProperties}<w:r><w:rPr><w:b/></w:rPr><w:t>原编号修订外的文字</w:t></w:r></w:p>` });
    const target = (await inspectDocxTargets(input))[0]; const text = target.segments!.find(item => item.editable)!;
    assert.equal(target.editable, true); assert.equal(target.editMode, 'segments'); assert.ok(target.segments!.some(item => item.id.startsWith('format-') && !item.editable));
    const result = await applyDocxPatches(input, [segmentPatch(target, text, '书面确认的编号段落文字')]);
    const before = (await contents(input))['word/document.xml'].toString(); const after = (await contents(result.bytes))['word/document.xml'].toString();
    assert.ok(after.includes(paragraphProperties)); assert.equal(nonTextShape(after), nonTextShape(before));
  }
  for (const rawBody of [
    '<w:p><w:ins w:id="8"><w:r><w:t>旧作者的插入文字</w:t></w:r></w:ins><w:r><w:t>普通文字</w:t></w:r></w:p>',
    '<w:p><w:pPr><w:numPr><w:ins w:id="8"><w:r><w:t>非空修订</w:t></w:r></w:ins></w:numPr></w:pPr><w:r><w:t>普通文字</w:t></w:r></w:p>',
    '<w:p><w:pPr><x:numPr xmlns:x="urn:unknown"><w:ins w:id="8"/></x:numPr></w:pPr><w:r><w:t>普通文字</w:t></w:r></w:p>',
  ]) {
    const input = await createDocx({ rawBody }); const target = (await inspectDocxTargets(input))[0];
    assert.equal(target.editable, false); await assert.rejects(applyDocxPatches(input, [patch(target, '不得伪造旧修订')]), code('DOCX_TARGET_UNSUPPORTED'));
  }
});

test('分页符作为只读结构片段保留type和clear，只修改其前后文字，不能新增或删除换行', async () => {
  const pageBreak = '<w:br w:type="page" w:clear="all"/>';
  const input = await createDocx({ rawBody: `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>分页前文字</w:t>${pageBreak}<w:t>分页后文字</w:t></w:r></w:p>` });
  const target = (await inspectDocxTargets(input))[0]; const selectable = target.segments!.filter(item => item.editable);
  assert.equal(target.text, '分页前文字\n分页后文字'); assert.equal(target.editMode, 'segments');
  assert.deepEqual(target.segments!.filter(item => !item.editable).map(({ text, rangeStart, rangeEnd }) => ({ text, rangeStart, rangeEnd })), [{ text: '\n', rangeStart: 5, rangeEnd: 6 }]);
  await assert.rejects(applyDocxPatches(input, [patch(target, '删除了分页的文字')]), code('DOCX_TARGET_UNSUPPORTED'));
  await assert.rejects(applyDocxPatches(input, [segmentPatch(target, selectable[0], '新增\n换行')]), code('DOCX_PATCH_INVALID'));
  const result = await applyDocxPatches(input, selectable.map((segment, index) => segmentPatch(target, segment, `${segment.text}已确认`, `side-${index}`)));
  const after = (await contents(result.bytes))['word/document.xml'].toString();
  assert.ok(after.includes(pageBreak)); assert.equal(nonTextShape(after), nonTextShape((await contents(input))['word/document.xml'].toString()));
  assert.equal((await parseDocx(result.bytes)).blocks[0].text, '分页前文字已确认\n分页后文字已确认');
  const deleted = await applyDocxPatches(input, [segmentPatch(target, selectable[0], '')]);
  assert.equal((await parseDocx(deleted.bytes)).blocks[0].text, '\n分页后文字'); assert.ok((await contents(deleted.bytes))['word/document.xml'].toString().includes(pageBreak));
});

test('十五个含权限锚、空书签、编号修订或分页的目标逐个片段修改，其他XML形状与部件不变', async () => {
  const paragraphs = Array.from({ length: 14 }, (_, index) => `<w:p><w:pPr><w:jc w:val="both"/>${index === 7 ? '<w:numPr><w:ins w:id="20" w:author="Synthetic Author" w:date="2025-01-01T00:00:00Z"/><w:numId w:val="1"/></w:numPr>' : ''}</w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>段前${index}</w:t></w:r><w:permStart w:id="${index}" w:edGrp="everyone"/><w:r><w:rPr><w:i/></w:rPr><w:t>待确认${index}</w:t></w:r><w:permEnd w:id="${index}"/><w:r><w:t>段后${index}</w:t></w:r>${index === 9 ? '<w:bookmarkStart w:id="100" w:name="_GoBack"/><w:bookmarkEnd w:id="100"/>' : ''}</w:p>`);
  paragraphs.push('<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>分页前</w:t><w:br w:type="page"/></w:r></w:p>');
  const input = await createDocx({ rawBody: paragraphs.join(''), header: '保留页眉', extraFiles: { 'word/styles.xml': `<w:styles xmlns:w="${wordNamespace}"><w:style w:styleId="Normal"/></w:styles>`, 'word/media/opaque.bin': 'unchanged-media' } });
  const snapshot = Buffer.from(input); const targets = await inspectDocxTargets(input);
  const editableTargets = targets.filter(target => target.editMode === 'segments');
  assert.equal(editableTargets.length, 15); assert.ok(editableTargets.every(target => target.editable));
  const edits = editableTargets.map((target, index) => { const selectable = target.segments!.filter(item => item.editable); const selected = selectable[index % selectable.length]; return segmentPatch(target, selected, `${selected.text}已确认`, `fifteen-${index}`); });
  const result = await applyDocxPatches(input, edits); const before = await contents(input); const after = await contents(result.bytes);
  assert.equal(nonTextShape(after['word/document.xml'].toString()), nonTextShape(before['word/document.xml'].toString()));
  for (const name of Object.keys(before).filter(name => name !== 'word/document.xml')) assert.deepEqual(after[name], before[name], name);
  const parsed = await parseDocx(result.bytes);
  for (const edit of edits) {
    const target = editableTargets.find(item => item.structuralPath === edit.structuralPath)!;
    const changed = parsed.blocks.find(block => block.locator.kind === 'docx' && block.locator.structuralPath === edit.structuralPath)!;
    assert.equal(changed.text, target.text.slice(0, edit.rangeStart) + edit.replacementText + target.text.slice(edit.rangeEnd));
  }
  assert.deepEqual(input, snapshot);
});

const trackingMetadata = { author: '工程测试审核人 & "Reviewer"', date: '2026-10-23T01:02:03.000Z' };
const comparableBlocks = (parsed: Awaited<ReturnType<typeof parseDocx>>) => parsed.blocks.map(({ kind, text, locator }) => ({ kind, text, locator }));
/** Independent test oracle: only the engine's newly emitted lawrev wrappers
 * are settled. Existing source w:ins/w:del fixtures remain opaque. */
async function settleNewRevisions(bytes: Buffer, mode: 'accept' | 'reject', source?: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes); const metadata = inspectDocxZip(bytes);
  const oldPrefixes = new Set<string>();
  if (source) for (const value of Object.values(await contents(source))) for (const match of value.toString().matchAll(/xmlns:(lawrev\d*)\s*=/g)) oldPrefixes.add(match[1]);
  for (const part of metadata.keys()) if (/\.xml$/i.test(part)) {
    const original = await zip.file(part)!.async('nodebuffer'); const xml = await readDocxXmlPart(zip, metadata, part);
    const resolved = xml.replace(/<(lawrev\d*):(ins|del)\b[^>]*>([\s\S]*?)<\/\1:\2>/g, (match, prefix: string, kind: string, content: string) => {
      if (oldPrefixes.has(prefix)) return match;
      if (mode === 'accept') return kind === 'ins' ? content : '';
      return kind === 'ins' ? '' : content.replace(/<(\/?)([A-Za-z_][\w.-]*:)?delText(?=[\s>])/g, '<$1$2t');
    });
    if (resolved === xml) continue;
    const encoded = original[0] === 0xff && original[1] === 0xfe ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(resolved, 'utf16le')]) : original[0] === 0xfe && original[1] === 0xff ? Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(resolved, 'utf16le').swap16()]) : Buffer.from(resolved);
    zip.file(part, encoded, { compression: 'STORE' });
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

test('三语原生修订有真实ins/delText，接受等于clean、拒绝还原原文，其他部件与源Buffer不变', async () => {
  const input = await createDocx({ paragraphs: ['服务完成后付款。', 'Payment follows delivery.', 'ชำระค่าบริการหลังส่งมอบ', '保留正文。'], header: '保留页眉', footer: '保留页脚', extraFiles: { 'docProps/custom.xml': '<Properties>unchanged-properties</Properties>', 'word/media/opaque.bin': 'unchanged-media' }, compression: 'DEFLATE' });
  const snapshot = Buffer.from(input); const targets = await inspectDocxTargets(input);
  const edits = [patch(targets[0], '服务书面验收后付款。'), patch(targets[1], 'Payment follows written acceptance.', { id: 'english' }), patch(targets[2], 'ชำระค่าบริการหลังตรวจรับ', { id: 'thai' })];
  const clean = await applyDocxPatches(input, edits); const tracked = await applyDocxTrackedPatches(input, edits, trackingMetadata);
  const before = await contents(input); const after = await contents(tracked.bytes); const main = after['word/document.xml'].toString();
  assert.match(main, /<lawrev:del\b/); assert.match(main, /<w:delText\b/); assert.match(main, /<lawrev:ins\b/);
  assert.ok(main.includes('lawrev:author="工程测试审核人 &amp; &quot;Reviewer&quot;"')); assert.ok(main.includes(`lawrev:date="${trackingMetadata.date}"`));
  assert.ok(main.includes('服务</w:t>'), 'Unchanged prefix must not be falsely marked as deleted');
  assert.deepEqual(comparableBlocks(await parseDocx(tracked.bytes)), comparableBlocks(await parseDocx(clean.bytes)));
  assert.deepEqual(comparableBlocks(await parseDocx(await settleNewRevisions(tracked.bytes, 'accept'))), comparableBlocks(await parseDocx(clean.bytes)));
  assert.deepEqual(comparableBlocks(await parseDocx(await settleNewRevisions(tracked.bytes, 'reject'))), comparableBlocks(await parseDocx(input)));
  for (const name of Object.keys(before).filter(name => !['word/document.xml', 'word/_rels/document.xml.rels', '[Content_Types].xml'].includes(name))) assert.deepEqual(after[name], before[name], name);
  assert.match(after['word/settings.xml'].toString(), /lawrev:insDel="1"/);
  assert.ok(after['word/_rels/document.xml.rels'].toString().includes('/settings'));
  assert.ok(after['[Content_Types].xml'].toString().includes('wordprocessingml.settings+xml'));
  assert.deepEqual(input, snapshot);
});

test('纯增、纯删、多项和跨run修订保留rPr，旧修订和全包Word:id不碰撞', async () => {
  const oldInsertion = '<w:ins w:id="1" w:author="Old Author" w:date="2020-01-01T00:00:00Z"><w:r><w:t>旧插入记录</w:t></w:r></w:ins>';
  const oldDeletion = '<w:del w:id="2" w:author="Old Author" w:date="2020-01-01T00:00:00Z"><w:r><w:delText>旧删除记录</w:delText></w:r></w:del>';
  const oldNumbering = '<w:ins w:id="3" w:author="Old Author" w:date="2020-01-01T00:00:00Z"/>';
  const input = await createDocx({ rawBody: '<w:p><w:r w:rsidR="01020304"><w:rPr><w:b/></w:rPr><w:t>甲方应在验</w:t></w:r><w:r><w:rPr><w:i/><w:color w:val="336699"/></w:rPr><w:t>收后付款。</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>金额100元，期限30天。</w:t></w:r></w:p>' + `<w:p>${oldInsertion}${oldDeletion}</w:p>` +
    `<w:p><w:pPr><w:numPr>${oldNumbering}<w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>保留编号</w:t></w:r></w:p>`,
    extraFiles: { 'word/comments.xml': `<w:comments xmlns:w="${wordNamespace}"><w:comment w:id="0"><w:p><w:r><w:t>保留评论</w:t></w:r></w:p></w:comment></w:comments>` } });
  const targets = await inspectDocxTargets(input); const number = targets[1];
  const edits = [patch(targets[0], '甲方应在书面确认后付款。'), patch(number, '200', { id: 'amount', rangeStart: 2, rangeEnd: 5, expectedOriginalText: '100' }), patch(number, '', { id: 'delete', rangeStart: 9, rangeEnd: 11, expectedOriginalText: '30' })];
  const tracked = await applyDocxTrackedPatches(input, edits, trackingMetadata); const main = (await contents(tracked.bytes))['word/document.xml'].toString();
  for (const old of [oldInsertion, oldDeletion, oldNumbering]) assert.ok(main.includes(old));
  const ids = [...main.matchAll(/<lawrev:(?:ins|del)\b[^>]*lawrev:id="(\d+)"/g)].map(match => Number(match[1]));
  assert.ok(ids.length >= 4); assert.equal(new Set(ids).size, ids.length); assert.ok(ids.every(id => ![0, 1, 2, 3].includes(id)));
  assert.ok(main.includes('<w:r w:rsidR="01020304"><w:rPr><w:b/></w:rPr><w:delText'));
  assert.ok(main.includes('<w:rPr><w:i/><w:color w:val="336699"/></w:rPr><w:delText'));
  assert.deepEqual(comparableBlocks(await parseDocx(await settleNewRevisions(tracked.bytes, 'accept'))), comparableBlocks(await parseDocx((await applyDocxPatches(input, edits)).bytes)));
  assert.deepEqual(comparableBlocks(await parseDocx(await settleNewRevisions(tracked.bytes, 'reject'))), comparableBlocks(await parseDocx(input)));
  const plain = await createDocx({ paragraphs: ['原文', '保留正文'] }); const target = (await inspectDocxTargets(plain))[0];
  const inserted = await applyDocxTrackedPatches(plain, [patch(target, '新增原文')], trackingMetadata); const insertionXml = (await contents(inserted.bytes))['word/document.xml'].toString();
  assert.match(insertionXml, /<lawrev:ins\b/); assert.doesNotMatch(insertionXml, /<lawrev:del\b/);
  const deleted = await applyDocxTrackedPatches(plain, [patch(target, '')], trackingMetadata); const deletionXml = (await contents(deleted.bytes))['word/document.xml'].toString();
  assert.match(deletionXml, /<lawrev:del\b/); assert.doesNotMatch(deletionXml, /<lawrev:ins\b/);
});

test('片段原生修订固定授权owner，权限/空书签/page br和空编号修订原XML保留', async () => {
  const perm = '<w:permStart w:id="8" w:edGrp="everyone"/>'; const permEnd = '<w:permEnd w:id="8"/>';
  const bookmark = '<w:bookmarkStart w:id="9" w:name="_GoBack"/><w:bookmarkEnd w:id="9"/>'; const pageBreak = '<w:br w:type="page"/>';
  const numbering = '<w:pPr><w:numPr><w:ins w:id="10" w:author="Original" w:date="2020-01-01T00:00:00Z"/><w:numId w:val="1"/></w:numPr></w:pPr>';
  const bold = '<w:r><w:rPr><w:b/></w:rPr><w:t>前文</w:t></w:r>';
  const input = await createDocx({ rawBody: `<w:p>${numbering}${bold}${perm}${bookmark}<w:r><w:rPr><w:i/></w:rPr><w:t>目标文字</w:t>${pageBreak}<w:t>分页后</w:t></w:r>${permEnd}</w:p>` });
  const target = (await inspectDocxTargets(input))[0]; const selected = target.segments!.find(item => item.editable && item.text === '目标文字')!;
  const tracked = await applyDocxTrackedPatches(input, [segmentPatch(target, selected, '新增目标文字')], trackingMetadata); const main = (await contents(tracked.bytes))['word/document.xml'].toString();
  assert.ok(main.includes(numbering + bold + perm + bookmark));
  assert.ok(main.includes(`<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">新增</w:t></w:r></lawrev:ins>`));
  assert.ok(main.includes(pageBreak)); assert.equal((main.match(/<w:br\b/g) ?? []).length, 1);
  assert.ok(main.indexOf(perm) < main.indexOf('<lawrev:ins'));
  assert.deepEqual(comparableBlocks(await parseDocx(await settleNewRevisions(tracked.bytes, 'reject'))), comparableBlocks(await parseDocx(input)));
  await assert.rejects(applyDocxTrackedPatches(input, [patch(target, '不能跨结构')], trackingMetadata), code('DOCX_TARGET_UNSUPPORTED'));
});

test('Strict/Transitional、不同前缀及UTF16 BOM修订可回读，不依赖固定w前缀', async () => {
  for (const uri of [wordNamespace, 'http://purl.oclc.org/ooxml/wordprocessingml/main']) for (const encoding of ['le', 'be', 'utf8'] as const) {
    const xml = `<?xml version="1.0" encoding="${encoding === 'utf8' ? 'UTF-8' : 'UTF-16'}"?><x:document xmlns:x="${uri}"><x:body><x:p><x:r><x:rPr><x:b/></x:rPr><x:t xml:space="preserve">  &#x7532;方付款😀  </x:t></x:r></x:p><x:p><x:r><x:t>保留正文</x:t></x:r></x:p></x:body></x:document>`;
    const raw = encoding === 'utf8' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml)]) : Buffer.concat([Buffer.from(encoding === 'le' ? [0xff, 0xfe] : [0xfe, 0xff]), encoding === 'le' ? Buffer.from(xml, 'utf16le') : Buffer.from(xml, 'utf16le').swap16()]);
    const input = await createDocx({ mainXml: raw }); const target = (await inspectDocxTargets(input))[0];
    const tracked = await applyDocxTrackedPatches(input, [patch(target, '  甲方验收后付款😃  ')], trackingMetadata);
    assert.deepEqual((await contents(tracked.bytes))['word/document.xml'].subarray(0, encoding === 'utf8' ? 3 : 2), raw.subarray(0, encoding === 'utf8' ? 3 : 2));
    assert.deepEqual(comparableBlocks(await parseDocx(await settleNewRevisions(tracked.bytes, 'reject'))), comparableBlocks(await parseDocx(input)));
    const resultXml = await readDocxXmlPart(await JSZip.loadAsync(tracked.bytes), inspectDocxZip(tracked.bytes), 'word/document.xml');
    assert.ok(resultXml.includes('&#x7532;方')); assert.ok(resultXml.includes('<x:delText')); assert.ok(resultXml.includes(`xmlns:lawrev="${uri}"`));
  }
});

test('已有修订显示设置只更改显示属性，其他settings字节与自定义关系保留', async () => {
  const zoom = '<w:zoom w:percent="95"/>'; const compat = '<w:compat><w:useFELayout/></w:compat>';
  const input = await createDocx({ paragraphs: ['付款应经确认。'], extraFiles: {
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="customSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="custom/view.xml"/></Relationships>',
    'word/custom/view.xml': settingsXml(`${zoom}<w:revisionView w:insDel="0" w:markup="false" w:comments="false"/>${compat}`),
  } });
  const target = (await inspectDocxTargets(input))[0]; const output = await applyDocxTrackedPatches(input, [patch(target, '付款应经书面确认。')], trackingMetadata); const before = await contents(input); const after = await contents(output.bytes);
  assert.deepEqual(after['word/_rels/document.xml.rels'], before['word/_rels/document.xml.rels']);
  const settings = after['word/custom/view.xml'].toString(); assert.ok(settings.includes(zoom)); assert.ok(settings.includes(compat)); assert.ok(settings.includes('w:comments="false"'));
  assert.match(settings, /lawrev:insDel="1"/); assert.doesNotMatch(settings, /w:insDel="0"/); assert.equal((settings.match(/revisionView/g) ?? []).length, 1);
  assert.ok(!('word/settings.xml' in after));
});

test('原生修订仍拒旧正文修订目标、保护/签名、非法作者时间及ZIP伪造，不改变clean行为', async () => {
  const ordinary = await createDocx({ paragraphs: ['确认后付款。'] }); const target = (await inspectDocxTargets(ordinary))[0]; const edit = patch(target, '书面确认后付款。');
  for (const metadata of [{ author: '', date: trackingMetadata.date }, { author: 'x\n', date: trackingMetadata.date }, { author: 'x', date: '2026-02-30T00:00:00Z' }, { author: 'x', date: '0000-01-01T00:00:00Z' }, { author: 'x', date: 'yesterday' }]) await assert.rejects(applyDocxTrackedPatches(ordinary, [edit], metadata), code('DOCX_PATCH_INVALID'));
  const old = await createDocx({ rawBody: '<w:p><w:ins w:id="2" w:author="Old"><w:r><w:t>旧正文插入</w:t></w:r></w:ins></w:p>' }); const oldTarget = (await inspectDocxTargets(old))[0];
  await assert.rejects(applyDocxTrackedPatches(old, [patch(oldTarget, '不能套旧作者')], trackingMetadata), code('DOCX_TARGET_UNSUPPORTED'));
  const protectedPackages: Array<Record<string, string>> = [{ 'word/settings.xml': settingsXml(readOnlyElement) }, { '_xmlsignatures/sig1.xml': '<Signature/>' }];
  for (const extraFiles of protectedPackages) {
    const input = await createDocx({ paragraphs: ['确认后付款。'], extraFiles }); const t = (await inspectDocxTargets(input))[0];
    await assert.rejects(applyDocxTrackedPatches(input, [patch(t, '书面确认后付款。')], trackingMetadata), code('DOCX_TARGET_UNSUPPORTED'));
  }
  const media = await createDocx({ paragraphs: ['确认后付款。'], extraFiles: { 'word/media/opaque.bin': 'opaque-content' } });
  const forged = changeCentral(media, 'word/media/opaque.bin', (bytes, offset) => bytes.writeUInt32LE(1, offset + 24)); const t = (await inspectDocxTargets(forged))[0];
  await assert.rejects(applyDocxTrackedPatches(forged, [patch(t, '书面确认后付款。')], trackingMetadata), code('DOCX_PATCH_INVALID'));
  const clean = await applyDocxPatches(ordinary, [edit]); assert.doesNotMatch((await contents(clean.bytes))['word/document.xml'].toString(), /<lawrev:(?:ins|del)\b/); assert.ok(!('word/settings.xml' in await contents(clean.bytes)));
});

test('原生修订前缀不遮蔽源run属性、字体子节点或settings已有命名空间', async () => {
  const rawRun = '<w:r lawrev:source="retained"><w:rPr><lawrev:font lawrev:val="retained-font"/><w:b/></w:rPr><w:t>原文付款。</w:t></w:r>';
  const mainXml = `<w:document xmlns:w="${wordNamespace}" xmlns:lawrev="urn:original-extension" xmlns:lawrev2="urn:second-extension"><w:body><w:p>${rawRun}</w:p></w:body></w:document>`;
  const input = await createDocx({ mainXml, extraFiles: { 'word/settings.xml': `<w:settings xmlns:w="${wordNamespace}" xmlns:lawrev="urn:settings-extension"><lawrev:setting lawrev:value="keep"/></w:settings>` } });
  const target = (await inspectDocxTargets(input))[0]; const result = await applyDocxTrackedPatches(input, [patch(target, '原文书面确认后付款。')], trackingMetadata); const output = await contents(result.bytes);
  const xml = output['word/document.xml'].toString(); const setting = output['word/settings.xml'].toString();
  assert.match(xml, /<lawrev3:ins xmlns:lawrev3=/); assert.doesNotMatch(xml, /xmlns:lawrev="http/);
  assert.ok(xml.includes('lawrev:source="retained"')); assert.ok(xml.includes('<lawrev:font lawrev:val="retained-font"/>'));
  assert.ok(setting.includes('<lawrev:setting lawrev:value="keep"/>')); assert.match(setting, /<lawrev2:revisionView xmlns:lawrev2=/);
  assert.deepEqual(comparableBlocks(await parseDocx(await settleNewRevisions(result.bytes, 'reject', input))), comparableBlocks(await parseDocx(input)));
});

test('正文、页眉、页脚同批修订ID全局唯一，显示关系只连接真实主文档', async () => {
  const input = await createDocx({ paragraphs: ['正文保持格式。'], header: 'Header original', footer: 'Footer original' });
  const targets = await inspectDocxTargets(input);
  const edits = targets.map((target, index) => patch(target, `${target.text} revised`, { id: `story-${index}` }));
  const result = await applyDocxTrackedPatches(input, edits, trackingMetadata); const output = await contents(result.bytes);
  const ids = ['word/document.xml', 'word/header1.xml', 'word/footer1.xml'].flatMap(part => [...output[part].toString().matchAll(/lawrev:id="(\d+)"/g)].map(match => match[1]));
  assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 3);
  assert.ok(output['word/_rels/document.xml.rels'].toString().includes('/settings'));
  assert.ok(!('word/_rels/header1.xml.rels' in output)); assert.ok(!('word/_rels/footer1.xml.rels' in output));
  assert.deepEqual(comparableBlocks(await parseDocx(await settleNewRevisions(result.bytes, 'accept'))), comparableBlocks(await parseDocx((await applyDocxPatches(input, edits)).bytes)));
  assert.deepEqual(comparableBlocks(await parseDocx(await settleNewRevisions(result.bytes, 'reject'))), comparableBlocks(await parseDocx(input)));
});
