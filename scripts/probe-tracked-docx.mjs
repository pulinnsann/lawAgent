import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import JSZip from 'jszip';
import { createDocx, escapeXml } from '../tests/fixtures-documents.ts';
import { applyDocxPatches, applyDocxTrackedPatches, inspectDocxTargets } from '../src/core/docx-patcher.ts';
import { parseDocx } from '../src/core/documents.ts';

// Entirely synthetic, local-only verification. Never reads models, credentials,
// desktop settings or user contracts. Run after the task's artifact marker.
const folder = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(), 'law-agent-tracked-docx-'));
const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const metadata = { author: 'Contract Workspace Test', date: '2026-10-23T01:02:03.000Z' };
const run = (text, properties = '') => `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
const paragraph = (text, style = 'Normal') => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${run(text)}</w:p>`;
const originalTexts = ['甲方应在收到发票后30日内支付服务费用。', 'The Customer shall pay within 30 days after receipt of the invoice.', 'ผู้ซื้อจะชำระค่าบริการภายใน 30 วันหลังได้รับใบแจ้งหนี้', '交付后付款。'];
const revisedTexts = ['甲方应在书面验收合格并收到发票后15日内支付服务费用。', 'The Customer shall pay within 15 days after written acceptance and receipt of the invoice.', 'ผู้ซื้อจะชำระค่าบริการภายใน 15 วันหลังตรวจรับเป็นลายลักษณ์อักษรและได้รับใบแจ้งหนี้', '书面验收后付款。'];
const cell = text => `<w:tc><w:tcPr><w:tcW w:w="4500" w:type="dxa"/><w:tcMar><w:top w:w="100" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar></w:tcPr>${paragraph(text)}</w:tc>`;
const oldNumbering = '<w:ins w:id="1" w:author="Original Reviewer" w:date="2020-01-01T00:00:00Z"/>';
const permission = '<w:permStart w:id="0" w:edGrp="everyone"/>';
const permissionEnd = '<w:permEnd w:id="0"/>';
const bookmark = '<w:bookmarkStart w:id="2" w:name="_GoBack"/><w:bookmarkEnd w:id="2"/>';
const pageBreak = '<w:br w:type="page"/>';
const oldRevision = '<w:ins w:id="50" w:author="Original Reviewer" w:date="2020-01-01T00:00:00Z"><w:r><w:t>历史插入记录保持不变。</w:t></w:r></w:ins><w:del w:id="51" w:author="Original Reviewer" w:date="2020-01-01T00:00:00Z"><w:r><w:delText>历史删除记录保持不变。</w:delText></w:r></w:del>';
const body = paragraph('Word native revisions validation', 'Title') + paragraph('三语合同修订技术验证 仅供工程测试', 'Heading1') +
  `<w:p>${run('甲方', '<w:b/>')}${run('应在收到发票后30日内支付')}${run('服务费用。', '<w:i/>')}</w:p>` +
  `<w:p>${run('The Customer', '<w:b/>')}${run(' shall pay within 30 days after receipt of the invoice.')}</w:p>` + paragraph(originalTexts[2]) +
  paragraph('Table and protected structural anchors', 'Heading1') +
  '<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D9D9D9"/><w:left w:val="single" w:sz="4" w:color="D9D9D9"/><w:bottom w:val="single" w:sz="4" w:color="D9D9D9"/><w:right w:val="single" w:sz="4" w:color="D9D9D9"/><w:insideH w:val="single" w:sz="4" w:color="D9D9D9"/><w:insideV w:val="single" w:sz="4" w:color="D9D9D9"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid>' + `<w:tr>${cell('付款与验收 Payment')}${cell(originalTexts[3])}</w:tr></w:tbl>` +
  `<w:p><w:pPr><w:numPr>${oldNumbering}</w:numPr></w:pPr>${run('权限前文字 ', '<w:b/>')}${permission}${bookmark}${run('待确认片段', '<w:i/>')}${permissionEnd}${run(' 权限后文字')}</w:p>` +
  `<w:p>${run('分页前文字') }<w:r>${pageBreak}</w:r></w:p>` + paragraph('Original revisions remain untouched', 'Heading1') +
  `<w:p>${oldRevision}</w:p>` + paragraph('Keep the rest unchanged. 其他内容保持不变。 ข้อกำหนดอื่นคงเดิม');
let original = await createDocx({ rawBody: body, header: 'Synthetic contract workspace', footer: 'Engineering verification only', extraFiles: { 'customXml/unchanged.xml': '<fixture>Unchanged metadata</fixture>' } });
const zip = await JSZip.loadAsync(original);
zip.file('word/document.xml', (await zip.file('word/document.xml').async('string')).replace('</w:sectPr>', '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567"/></w:sectPr>'));
zip.file('word/styles.xml', `<w:styles xmlns:w="${word}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Noto Sans CJK SC" w:cs="Noto Sans Thai"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-CN" w:bidi="th-TH"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="180" w:after="140"/></w:pPr><w:rPr><w:b/><w:sz w:val="25"/></w:rPr></w:style></w:styles>`);
zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml').async('string')).replace('</Types>', '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'));
zip.file('word/_rels/document.xml.rels', (await zip.file('word/_rels/document.xml.rels').async('string')).replace('</Relationships>', '<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'));
original = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
const targets = await inspectDocxTargets(original);
const patches = originalTexts.map((text, index) => { const target = targets.find(item => item.text === text); assert.ok(target?.editable); return { id: `probe-${index}`, blockId: `block-${index}`, partName: target.partName, structuralPath: target.structuralPath, rangeStart: 0, rangeEnd: text.length, expectedOriginalText: text, replacementText: revisedTexts[index] }; });
for (const [text, replacement] of [['待确认片段', '已书面确认片段'], ['分页前文字', '原分页前文字已确认']]) {
  const target = targets.find(item => item.segments?.some(segment => segment.editable && segment.text === text)); const segment = target?.segments.find(item => item.editable && item.text === text); assert.ok(target && segment);
  patches.push({ id: `probe-${patches.length}`, blockId: `block-${patches.length}`, partName: target.partName, structuralPath: target.structuralPath, rangeStart: segment.rangeStart, rangeEnd: segment.rangeEnd, expectedOriginalText: segment.text, replacementText: replacement });
}
const clean = await applyDocxPatches(original, patches); const tracked = await applyDocxTrackedPatches(original, patches, metadata);
const finalZip = await JSZip.loadAsync(tracked.bytes); const trackedMain = await finalZip.file('word/document.xml').async('string');
for (const value of [oldNumbering, permission, permissionEnd, bookmark, pageBreak, oldRevision]) assert.ok(trackedMain.includes(value));
async function settle(mode) {
  const settled = await JSZip.loadAsync(tracked.bytes);
  for (const part of ['word/document.xml', 'word/header1.xml', 'word/footer1.xml']) {
    const file = settled.file(part); if (!file) continue;
    const xml = await file.async('string');
    const resolved = xml.replace(/<(lawrev\d*):(ins|del)\b[^>]*>([\s\S]*?)<\/\1:\2>/g, (_, prefix, kind, content) => mode === 'accept' ? kind === 'ins' ? content : '' : kind === 'ins' ? '' : content.replace(/<(\/?)([A-Za-z_][\w.-]*:)?delText(?=[\s>])/g, '<$1$2t'));
    settled.file(part, resolved, { compression: 'STORE' });
  }
  return settled.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}
const accepted = await settle('accept'); const rejected = await settle('reject');
const blockText = async bytes => (await parseDocx(bytes)).blocks.map(block => block.text);
assert.deepEqual(await blockText(accepted), await blockText(clean.bytes)); assert.deepEqual(await blockText(rejected), await blockText(original));
for (const [name, bytes] of Object.entries({ original, clean: clean.bytes, tracked: tracked.bytes, accepted, rejected })) await writeFile(join(folder, `${name}.docx`), bytes);
const manifest = { passed: true, syntheticFixtureOnly: true, folder, patches: patches.length, newInsertions: (trackedMain.match(/<lawrev\d*:ins\b/g) ?? []).length, newDeletions: (trackedMain.match(/<lawrev\d*:del\b/g) ?? []).length, oldRevisionRawPreserved: true, anchorsAndPageBreakPreserved: true, acceptedMatchesClean: true, rejectedMatchesOriginal: true, visualQa: 'pending-render', files: ['original.docx', 'clean.docx', 'tracked.docx', 'accepted.docx', 'rejected.docx'] };
await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
