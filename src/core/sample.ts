import JSZip from 'jszip';

export async function createSampleContract(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const paragraphs = ['服务采购合同（虚构演示样例）', '本合同仅用于软件流程演示，不可作为交易模板。', '甲方（采购方）：示例制造有限公司。乙方（服务方）：示例技术服务有限公司。', '第一条 服务内容：乙方向甲方提供设备维护服务，具体范围由双方另行商定。', '第二条 费用及付款：服务费用为人民币100,000元，甲方应在签署后3日内支付全部费用。', '第三条 服务期限：自2026年11月1日起至2027年10月31日止。', '第四条 验收：乙方完成服务后视为验收合格。', '第五条 责任：乙方不承担任何间接损失，已收费用不予退还。', 'English note: acceptance criteria and remedies require confirmation.', 'ข้อความภาษาไทย: ตัวอย่างนี้ใช้เพื่อสาธิตระบบเท่านั้น'];
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(t => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join('')}<w:sectPr/></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}
