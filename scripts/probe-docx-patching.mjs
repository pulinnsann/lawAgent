import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import JSZip from 'jszip';
import { createDocx, escapeXml } from '../tests/fixtures-documents.ts';
import { applyDocxPatches, inspectDocxTargets } from '../src/core/docx-patcher.ts';

// Deterministic, entirely synthetic OOXML fixture. No models, client files or
// desktop configuration are read. Run with node --import tsx.
const folder = resolve(import.meta.dirname, '../output/docx-patching');
await mkdir(folder, { recursive: true });
const texts = {
  zh: '甲方应在收到发票后30日内支付服务费用。',
  en: 'The Customer shall pay the service fee within 30 days after receipt of the invoice.',
  th: 'ผู้ซื้อจะชำระค่าบริการภายใน 30 วันหลังได้รับใบแจ้งหนี้',
  table: '交付后付款，验收条件另行确认。',
};
const replacements = {
  zh: '甲方应在书面验收合格并收到发票后15日内支付服务费用。',
  en: 'The Customer shall pay the service fee within 15 days after written acceptance and receipt of the invoice.',
  th: 'ผู้ซื้อจะชำระค่าบริการภายใน 15 วันหลังตรวจรับเป็นลายลักษณ์อักษรและได้รับใบแจ้งหนี้',
  table: '书面验收合格并收到发票后付款。',
};
const t = text => `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
const p = (text, style = 'Normal') => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${t(text)}</w:p>`;
const cell = (text, header = false) => `<w:tc><w:tcPr><w:tcW w:w="4500" w:type="dxa"/>${header ? '<w:shd w:fill="EEF3EE"/>' : ''}<w:tcMar><w:top w:w="100" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar></w:tcPr>${p(text)}</w:tc>`;
const rawBody = p('合同定点修改验证', 'Title') + p('Targeted DOCX patch validation', 'Subtitle') +
  p('中英泰正文与表格 / Chinese, English and Thai', 'Heading1') +
  `<w:p><w:pPr><w:spacing w:after="180"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>甲方</w:t></w:r>${t('应在收到发票后30日内支付')}<w:r><w:rPr><w:i/></w:rPr><w:t>服务费用。</w:t></w:r></w:p>` +
  p(texts.en) + p(texts.th) + p('表格条款 / Table clauses', 'Heading1') +
  '<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="CBD5CB"/><w:left w:val="single" w:sz="4" w:color="CBD5CB"/><w:bottom w:val="single" w:sz="4" w:color="CBD5CB"/><w:right w:val="single" w:sz="4" w:color="CBD5CB"/><w:insideH w:val="single" w:sz="4" w:color="CBD5CB"/><w:insideV w:val="single" w:sz="4" w:color="CBD5CB"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid>' +
  `<w:tr><w:trPr><w:tblHeader/></w:trPr>${cell('事项 / Item', true)}${cell('约定 / Terms', true)}</w:tr>` +
  `<w:tr>${cell('付款与验收 / Payment and acceptance')}${cell(texts.table)}</w:tr>` +
  `<w:tr>${cell('保密 / Confidentiality')}${cell('Keep this clause unchanged. รักษาข้อความเดิม')}</w:tr></w:tbl>` +
  p('其他条款保持不变。Other terms remain unchanged. ข้อกำหนดอื่นคงเดิม');
let original = await createDocx({ rawBody, header: '合同工作台 / Contract workspace', footer: 'DOCX engineering validation', extraFiles: { 'customXml/unchanged.xml': '<fixture>Original metadata stays unchanged.</fixture>' } });
const zip = await JSZip.loadAsync(original);
let main = await zip.file('word/document.xml').async('string');
main = main.replace('</w:sectPr>', '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567"/></w:sectPr>');
zip.file('word/document.xml', main);
zip.file('word/styles.xml', '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Noto Sans CJK SC" w:cs="Noto Sans Thai"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-CN" w:bidi="th-TH"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="180" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="260"/></w:pPr><w:rPr><w:sz w:val="24"/><w:color w:val="526652"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="180" w:after="140"/></w:pPr><w:rPr><w:b/><w:sz w:val="25"/></w:rPr></w:style></w:styles>');
zip.file('[Content_Types].xml', (await zip.file('[Content_Types].xml').async('string')).replace('</Types>', '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'));
zip.file('word/_rels/document.xml.rels', (await zip.file('word/_rels/document.xml.rels').async('string')).replace('</Relationships>', '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'));
original = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
const targets = await inspectDocxTargets(original);
const patches = Object.entries(texts).map(([key, text], index) => {
  const target = targets.find(item => item.text === text); assert.ok(target?.editable, key);
  return { id: `probe-${index}`, blockId: `block-${index}`, partName: target.partName, structuralPath: target.structuralPath, rangeStart: 0, rangeEnd: text.length, expectedOriginalText: text, replacementText: replacements[key] };
});
const output = await applyDocxPatches(original, patches);
const updated = await inspectDocxTargets(output.bytes);
for (const value of Object.values(replacements)) assert.ok(updated.some(item => item.text === value));
const beforeZip = await JSZip.loadAsync(original); const afterZip = await JSZip.loadAsync(output.bytes);
const preservedParts = [];
for (const [name, file] of Object.entries(beforeZip.files)) if (!file.dir && name !== 'word/document.xml') {
  assert.deepEqual(await afterZip.file(name).async('nodebuffer'), await file.async('nodebuffer')); preservedParts.push(name);
}
await assert.rejects(applyDocxPatches(original, [patches[0], { ...patches[0], id: 'overlap' }]), error => error.code === 'DOCX_PATCH_CONFLICT');
await assert.rejects(applyDocxPatches(original, [{ ...patches[0], expectedOriginalText: 'stale text' }]), error => error.code === 'DOCX_PATCH_STALE');
await writeFile(join(folder, 'original.docx'), original);
await writeFile(join(folder, 'modified.docx'), output.bytes);
const sha = value => createHash('sha256').update(value).digest('hex');
const manifest = { passed: true, syntheticFixtureOnly: true, originalSha256: sha(original), modifiedSha256: sha(output.bytes), changes: patches.map(item => ({ partName: item.partName, structuralPath: item.structuralPath, before: item.expectedOriginalText, after: item.replacementText })), preservedParts, warnings: output.warnings, original: join(folder, 'original.docx'), modified: join(folder, 'modified.docx'), visualQa: 'pending-render' };
await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
