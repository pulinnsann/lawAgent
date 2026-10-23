import JSZip from 'jszip';

export function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

/** 测试专用合法 OOXML 包，不向产品导入任何测试示例。 */
export async function createDocx(options: {
  paragraphs?: string[];
  rawBody?: string;
  header?: string;
  footer?: string;
  mainXml?: string | Buffer;
  extraFiles?: Record<string, string>;
  compression?: 'STORE' | 'DEFLATE';
} = {}): Promise<Buffer> {
  const zip = new JSZip();
  const relationships: string[] = [];
  const section: string[] = [];
  const overrides = ['<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'];
  for (const kind of ['header', 'footer'] as const) {
    if (options[kind] === undefined) continue;
    relationships.push(`<Relationship Id="rId${kind}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="${kind}1.xml"/>`);
    section.push(`<w:${kind}Reference w:type="default" r:id="rId${kind}"/>`);
    zip.file(`word/${kind}1.xml`, `<?xml version="1.0" encoding="UTF-8"?><w:${kind === 'header' ? 'hdr' : 'ftr'} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>${escapeXml(options[kind]!)}</w:t></w:r></w:p></w:${kind === 'header' ? 'hdr' : 'ftr'}>`);
    overrides.push(`<Override PartName="/word/${kind}1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml"/>`);
  }
  const paragraphs = (options.paragraphs ?? []).map((text, index) => `<w:p w14:paraId="${String(index + 1).padStart(8, '0')}"><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`).join('');
  zip.file('word/document.xml', options.mainXml ?? `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body>${paragraphs}${options.rawBody ?? ''}<w:sectPr>${section.join('')}</w:sectPr></w:body></w:document>`);
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.join('')}</Types>`);
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  if (relationships.length) zip.file('word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join('')}</Relationships>`);
  for (const [name, text] of Object.entries(options.extraFiles ?? {})) zip.file(name, text);
  return zip.generateAsync({ type: 'nodebuffer', compression: options.compression ?? 'STORE' });
}

/** 构造有 xref、Unicode ToUnicode CMap 与页面坐标的真实 PDF；null 页面是图片扫描页。 */
export function createPdf(pages: Array<string[] | null>, rotation = 0): Buffer {
  const objects: string[] = [];
  const allocate = (): number => { objects.push(''); return objects.length; };
  const set = (id: number, body: string): void => { objects[id - 1] = body; };
  const catalogId = allocate(); const pagesId = allocate(); const fontId = allocate();
  const cidFontId = allocate(); const descriptorId = allocate(); const cmapId = allocate(); const imageId = allocate();
  const characters = [...new Set(pages.flatMap(page => page ?? []).flatMap(text => [...text]))];
  const codes = new Map(characters.map((character, index) => [character, index + 1]));
  const utf16Hex = (text: string): string => {
    const buffer = Buffer.from(text, 'utf16le');
    return Buffer.from(buffer).swap16().toString('hex').toUpperCase();
  };
  const mappings = characters.map(character => `<${codes.get(character)!.toString(16).padStart(4, '0')}> <${utf16Hex(character)}>`);
  const groups: string[] = [];
  for (let i = 0; i < mappings.length; i += 100) {
    const group = mappings.slice(i, i + 100);
    groups.push(`${group.length} beginbfchar\n${group.join('\n')}\nendbfchar`);
  }
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /ContractTest def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${groups.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  set(cmapId, `<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`);
  set(descriptorId, '<< /Type /FontDescriptor /FontName /ContractTest /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>');
  set(cidFontId, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ContractTest /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptorId} 0 R /DW 500 /CIDToGIDMap /Identity >>`);
  set(fontId, `<< /Type /Font /Subtype /Type0 /BaseFont /ContractTest /Encoding /Identity-H /DescendantFonts [${cidFontId} 0 R] /ToUnicode ${cmapId} 0 R >>`);
  const image = 'FF0000>';
  set(imageId, `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${image.length} >>\nstream\n${image}\nendstream`);
  const pageIds: number[] = [];
  for (const page of pages) {
    const pageId = allocate(); const contentId = allocate(); pageIds.push(pageId);
    const content = page === null ? 'q 200 0 0 200 40 500 cm /Im0 Do Q' : page.map((line, index) => `BT /F1 12 Tf 1 0 0 1 40 ${750 - index * 24} Tm <${[...line].map(character => codes.get(character)!.toString(16).padStart(4, '0')).join('')}> Tj ET`).join('\n');
    set(contentId, `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Rotate ${rotation} /Resources << /Font << /F1 ${fontId} 0 R >> /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`);
  }
  set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  set(pagesId, `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`);
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
