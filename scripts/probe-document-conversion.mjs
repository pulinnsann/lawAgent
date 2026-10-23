import { createCanvas } from '@napi-rs/canvas';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { AppStore } from '../src/core/storage.ts';
import { ContractService } from '../src/core/service.ts';
import { WorkspaceAssets } from '../src/core/workspace-assets.ts';
import { runConversionCommand } from '../src/core/document-conversion.ts';
import { defaultConversionSettings } from '../src/shared/document-conversion.ts';
import { parseDocx } from '../src/core/documents.ts';

// This probe intentionally downloads only the public English recognition model
// into its isolated synthetic data directory. No customer document/config/API.
const folder = resolve('output/conversion'); await mkdir(folder, { recursive: true });
const canvas = createCanvas(1800, 800); const context = canvas.getContext('2d');
context.fillStyle = '#ffffff'; context.fillRect(0, 0, 1800, 800); context.fillStyle = '#000000'; context.font = '64px Arial';
context.fillText('SYNTHETIC CONTRACT', 120, 180); context.fillText('Total amount 100 USD', 120, 320); context.fillText('Payment after written acceptance', 120, 460); context.fillText('Engineering sample only', 120, 600);
const image = resolve(folder, 'synthetic-scanned-page.png'); await writeFile(image, canvas.toBuffer('image/png'));
const source = resolve(folder, 'synthetic-image-only.pdf');
const python = process.env.LAW_PROBE_PYTHON ?? 'python3';
await promisify(execFile)(python, ['-c', 'from reportlab.pdfgen import canvas\nimport sys\nc=canvas.Canvas(sys.argv[2],pagesize=(900,400))\nc.drawImage(sys.argv[1],0,0,width=900,height=400)\nc.showPage()\nc.save()\n', image, source]);
const dataDir = resolve(folder, 'isolated-probe-data'); const store = await AppStore.open(dataDir); const service = new ContractService(store, dataDir); const assets = new WorkspaceAssets(store);
try {
  const document = await service.importFile(source);
  if (document.blocks.length) throw new Error('Synthetic input must be image-only PDF.');
  const deps = { store, service, assets, dataDir, onProgress: event => { if (event.stage !== 'recognizing' || event.pageNumber > 0) console.log(event.message); } };
  const status = await runConversionCommand('conversion.status', {}, deps);
  if (!status.models.find(model => model.language === 'eng')?.ready) await runConversionCommand('conversion.download', { languages: ['eng'], confirmed: true }, deps);
  const result = await runConversionCommand('conversion.convert', { documentId: document.id, settings: { ...defaultConversionSettings(), languages: ['eng'], mode: 'ocr', dpi: 180, maxPages: 2 }, confirmed: true }, deps);
  const bytes = Buffer.from(result.docxBase64, 'base64'); const output = resolve(folder, 'synthetic-ocr-converted.docx'); await writeFile(output, bytes);
  const text = (await parseDocx(bytes)).blocks.map(block => block.text).join('\n');
  if (!/SYNTHETIC CONTRACT/iu.test(text) || !/100 USD/iu.test(text) || result.partial || result.sourceSnapshot.pages[0].method !== 'ocr') throw new Error(`Native OCR technical probe failed: ${text}`);
  await writeFile(resolve(folder, 'synthetic-ocr-result.json'), JSON.stringify({ sourceSnapshot: result.sourceSnapshot, warnings: result.warnings, text }, null, 2));
  console.log(JSON.stringify({ output, method: result.sourceSnapshot.pages[0].method, confidence: result.sourceSnapshot.pages[0].confidence, sourceBytesPreserved: (await readFile(source)).length > 0 }));
} finally { await service.close(); }
