// Prueba end-to-end de dsh-plugin-doc-forge (sin red).
//
// Genera PDFs, imágenes y un DOCX de prueba, ejecuta todas las tools contra el
// servidor MCP real y verifica archivos, seguridad, read-only y auditoría.
// Termina imprimiendo "OK" solo si todo pasó.
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, '..');
const tmpDir = path.join(packageDir, 'test', 'tmp');
const serverEntry = process.env.DOCS_SERVER
  ? path.resolve(process.env.DOCS_SERVER)
  : path.join(packageDir, 'server.mjs');

rmSync(tmpDir, { recursive: true, force: true });
const dshHome = path.join(tmpDir, 'dsh-home');
const configDir = path.join(dshHome, 'doc-forge');
mkdirSync(configDir, { recursive: true });
writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
  allowedPaths: [tmpDir],
  sofficePath: '',
  pdftotextPath: '',
  rateLimitPerMinute: 100,
  note: 'config de test local',
}, null, 2) + '\n', 'utf8');

let passed = 0;
const skipped = [];
function pass(name) {
  passed++;
  console.log(`PASS ${name}`);
}
function expect(name, condition, detail = '') {
  if (condition) {
    pass(name);
    return;
  }
  console.error(`FALLO: ${name}${detail ? ` — ${detail}` : ''}`);
  process.exit(1);
}

function textOf(result) {
  return (result.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return { result, text: textOf(result), isError: result.isError === true };
}

function makeClient(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      SystemRoot: process.env.SystemRoot || 'C:\\Windows',
      PATH: process.env.PATH,
      USERPROFILE: process.env.USERPROFILE,
      HOME: process.env.HOME || process.env.USERPROFILE,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      DSH_HOME: dshHome,
      ...extraEnv,
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  const client = new Client(
    { name: 'doc-forge-test', version: '1.0.0' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } },
  );
  return client.connect(transport).then(() => ({ client, transport }));
}

// ---------------------------------------------------------------- fixtures

async function makeTestPdf(file, pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of pages) {
    const page = doc.addPage([spec.width, spec.height]);
    page.drawText(spec.label, { x: 24, y: spec.height - 40, size: 18, font });
    page.drawText('Document Forge test', { x: 24, y: spec.height - 68, size: 11, font });
  }
  writeFileSync(file, await doc.save());
}

function findBundledPython() {
  const candidates = [
    process.env.DOC_FORGE_PYTHON,
    process.env.DOCS_PYTHON,
    path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null;
}

function findExecutable(name) {
  try {
    const finder = process.platform === 'win32' ? 'where.exe' : 'which';
    const output = execFileSync(finder, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
  } catch {
    return null;
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function solidPng(width, height, rgb) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = [];
  for (let y = 0; y < height; y++) {
    raw.push(0);
    for (let x = 0; x < width; x++) raw.push(rgb[0], rgb[1], rgb[2]);
  }
  const idat = zlib.deflateSync(Buffer.from(raw));
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

function python(raw) {
  const file = path.join(tmpDir, `script-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.py`);
  writeFileSync(file, raw, 'utf8');
  return file;
}

// ---------------------------------------------------------------- fixtures reales

const aPdf = path.join(tmpDir, 'a.pdf');
const bPdf = path.join(tmpDir, 'b.pdf');
await makeTestPdf(aPdf, [
  { width: 200, height: 300, label: 'A1' },
  { width: 300, height: 200, label: 'A2' },
  { width: 150, height: 150, label: 'A3' },
]);
await makeTestPdf(bPdf, [
  { width: 400, height: 100, label: 'B1' },
  { width: 250, height: 250, label: 'B2' },
]);
console.log(`fixtures PDF: a.pdf (3 págs, ${statSync(aPdf).size} B), b.pdf (2 págs, ${statSync(bPdf).size} B)`);

const pythonExe = findBundledPython();
const imageFiles = [];
if (pythonExe) {
  const pngPath = path.join(tmpDir, 'rojo.png');
  const jpgPath = path.join(tmpDir, 'azul.jpg');
  try {
    const script = python([
      'from PIL import Image',
      `Image.new('RGB', (320, 200), (190, 30, 30)).save(r'${pngPath.replace(/\\/g, '/')}')`,
      `Image.new('RGB', (200, 320), (30, 30, 190)).save(r'${jpgPath.replace(/\\/g, '/')}', quality=90)`,
    ].join('\n'));
    execFileSync(pythonExe, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (existsSync(pngPath) && existsSync(jpgPath)) imageFiles.push(pngPath, jpgPath);
  } catch (error) {
    console.error('aviso: Pillow no generó las imágenes:', String(error.stderr || error.message).slice(0, 200));
  }
}
if (imageFiles.length === 0) {
  const ffmpeg = findExecutable('ffmpeg');
  const pngPath = path.join(tmpDir, 'rojo.png');
  const jpgPath = path.join(tmpDir, 'azul.jpg');
  if (ffmpeg) {
    try {
      execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=0xBE1E1E:s=320x200', '-frames:v', '1', '-pix_fmt', 'rgb24', pngPath], { stdio: 'ignore' });
      execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=0x1E1EBE:s=200x320', '-frames:v', '1', '-q:v', '3', jpgPath], { stdio: 'ignore' });
      if (existsSync(pngPath)) imageFiles.push(pngPath);
      if (existsSync(jpgPath)) imageFiles.push(jpgPath);
    } catch {
      /* fallback a PNG generado a mano */
    }
  }
  if (imageFiles.length === 0) {
    const pngPath = path.join(tmpDir, 'rojo.png');
    writeFileSync(pngPath, solidPng(320, 200, [190, 30, 30]));
    imageFiles.push(pngPath);
    skipped.push('JPG de prueba (sin Python/Pillow ni ffmpeg)');
  }
}
console.log('imágenes de prueba:', imageFiles.map((file) => path.basename(file)).join(', '));

const docxPath = path.join(tmpDir, 'muestra.docx');
let docxReal = false;
if (pythonExe) {
  try {
    const script = python([
      'from docx import Document',
      'doc = Document()',
      "doc.add_heading('Document Forge', 0)",
      "doc.add_paragraph('Prueba local de conversion Office a PDF.')",
      `doc.save(r'${docxPath.replace(/\\/g, '/')}')`,
    ].join('\n'));
    execFileSync(pythonExe, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    docxReal = existsSync(docxPath) && statSync(docxPath).size > 0;
  } catch (error) {
    console.error('aviso: python-docx no generó el DOCX:', String(error.stderr || error.message).slice(0, 200));
  }
}
if (!docxReal) {
  writeFileSync(docxPath, Buffer.from('PK\x03\x04 docx de prueba sin python-docx'));
  skipped.push('DOCX real (sin python-docx)');
}
console.log(`DOCX de prueba: ${docxReal ? 'real (python-docx)' : 'placeholder'}`);

// ---------------------------------------------------------------- servidor normal

const { client, transport } = await makeClient();

const toolList = await client.listTools();
const toolNames = toolList.tools.map((tool) => tool.name).sort();
console.log('tools:', toolNames.join(', '));
for (const expected of ['status', 'pdf_merge', 'pdf_split', 'pdf_rotate', 'images_to_pdf', 'pdf_extract_text', 'office_to_pdf']) {
  expect(`tool ${expected} registrada`, toolNames.includes(expected), toolNames.join(','));
}

const status = await call(client, 'status', {});
console.log('--- status ---');
console.log(status.text);
expect('status responde sin error', !status.isError, status.text.slice(0, 200));
expect('status informa pdf-lib 1.17.1', /pdf-lib 1\.17\.1/.test(status.text));
expect('status informa rutas permitidas', /Rutas permitidas:/.test(status.text));
const hasPdftotext = !/pdftotext: NO disponible/.test(status.text);
const hasSoffice = !/LibreOffice \(soffice\): NO disponible/.test(status.text);
console.log(`detección: pdftotext=${hasPdftotext} · LibreOffice=${hasSoffice}`);

// --- merge
const mergedPath = path.join(tmpDir, 'merged.pdf');
const merge = await call(client, 'pdf_merge', { inputs: [aPdf, bPdf], output: mergedPath, confirm: true });
expect('pdf_merge responde', !merge.isError && merge.text.includes('5 páginas'), merge.text);
const mergedDoc = await PDFDocument.load(readFileSync(mergedPath));
expect('merged.pdf tiene 5 páginas', mergedDoc.getPageCount() === 5, String(mergedDoc.getPageCount()));
const mergedWidths = mergedDoc.getPages().map((page) => Math.round(page.getWidth()));
expect(
  'pdf_merge conserva orden y tamaños',
  JSON.stringify(mergedWidths) === JSON.stringify([200, 300, 150, 400, 250]),
  JSON.stringify(mergedWidths),
);

const mergeNoConfirm = await call(client, 'pdf_merge', { inputs: [aPdf, bPdf] });
expect('pdf_merge sin confirm falla con confirm:true', mergeNoConfirm.isError && /confirm:true/.test(mergeNoConfirm.text), mergeNoConfirm.text);

const outsidePath = path.join(process.env.SystemRoot || 'C:\\Windows', 'notepad.exe');
const mergeOutside = await call(client, 'pdf_merge', { inputs: [aPdf, outsidePath], confirm: true });
expect('ruta fuera de allowedPaths rechazada', mergeOutside.isError && /no permitida/.test(mergeOutside.text), mergeOutside.text);

const mergeMissing = await call(client, 'pdf_merge', { inputs: [aPdf, path.join(tmpDir, 'no-existe.pdf')], confirm: true });
expect('archivo inexistente rechazado', mergeMissing.isError && /no existe/.test(mergeMissing.text), mergeMissing.text);

const mergeAgain = await call(client, 'pdf_merge', { inputs: [aPdf, bPdf], output: mergedPath, confirm: true });
expect(
  'nunca sobrescribe: crea merged-1.pdf',
  mergeAgain.text.includes('merged-1.pdf') && existsSync(path.join(tmpDir, 'merged-1.pdf')),
  mergeAgain.text,
);

// --- split por rangos
const splitDir = path.join(tmpDir, 'split-ranges');
const split = await call(client, 'pdf_split', { input: aPdf, ranges: '1-2,3', outputDir: splitDir, prefix: 'parte', confirm: true });
expect('pdf_split responde', !split.isError && split.text.includes('2 archivo'), split.text);
const splitFiles = readdirSync(splitDir).sort();
expect('pdf_split genera 2 PDFs', splitFiles.length === 2, splitFiles.join(','));
const partTwo = await PDFDocument.load(readFileSync(path.join(splitDir, 'parte-p1-2.pdf')));
const partOne = await PDFDocument.load(readFileSync(path.join(splitDir, 'parte-p3.pdf')));
expect('pdf_split: rango 1-2 tiene 2 páginas', partTwo.getPageCount() === 2, String(partTwo.getPageCount()));
expect('pdf_split: rango 3 tiene 1 página', partOne.getPageCount() === 1, String(partOne.getPageCount()));

// --- split por defecto (una página por archivo)
const eachDir = path.join(tmpDir, 'split-each');
const splitEach = await call(client, 'pdf_split', { input: bPdf, outputDir: eachDir, confirm: true });
expect('pdf_split sin ranges responde', !splitEach.isError && splitEach.text.includes('2 archivo'), splitEach.text);
const eachFiles = readdirSync(eachDir).sort();
expect('pdf_split por página genera 2 PDFs', eachFiles.length === 2, eachFiles.join(','));
const eachPages = await Promise.all(eachFiles.map(async (file) => (await PDFDocument.load(readFileSync(path.join(eachDir, file)))).getPageCount()));
expect('pdf_split por página: 1 página cada uno', eachPages.every((count) => count === 1), JSON.stringify(eachPages));

// --- rotate
const rotatedPath = path.join(tmpDir, 'rotated.pdf');
const rotate = await call(client, 'pdf_rotate', { input: aPdf, degrees: 90, pages: '1,3', output: rotatedPath, confirm: true });
expect('pdf_rotate responde', !rotate.isError && rotate.text.includes('2 de 3'), rotate.text);
const rotatedDoc = await PDFDocument.load(readFileSync(rotatedPath));
const rotations = rotatedDoc.getPages().map((page) => page.getRotation().angle);
expect('pdf_rotate aplica 90° a páginas 1 y 3', JSON.stringify(rotations) === JSON.stringify([90, 0, 90]), JSON.stringify(rotations));
const rotatedWidths = rotatedDoc.getPages().map((page) => Math.round(page.getWidth()));
expect(
  'pdf_rotate no altera tamaños de página',
  JSON.stringify(rotatedWidths) === JSON.stringify([200, 300, 150]),
  JSON.stringify(rotatedWidths),
);

const rotateNoConfirm = await call(client, 'pdf_rotate', { input: aPdf, degrees: 180 });
expect('pdf_rotate sin confirm falla', rotateNoConfirm.isError && /confirm:true/.test(rotateNoConfirm.text), rotateNoConfirm.text);

// --- imágenes a PDF
const imagesPdf = path.join(tmpDir, 'images.pdf');
const images = await call(client, 'images_to_pdf', { images: imageFiles, output: imagesPdf, pageSize: 'fit', confirm: true });
expect('images_to_pdf responde', !images.isError && !images.isError, images.text);
const imagesDoc = await PDFDocument.load(readFileSync(imagesPdf));
expect('images_to_pdf: una página por imagen', imagesDoc.getPageCount() === imageFiles.length, String(imagesDoc.getPageCount()));
const expectedImageSizes = imageFiles.map((file) => (path.basename(file) === 'azul.jpg' ? [200, 320] : [320, 200]));
const imagePageSizes = imagesDoc.getPages().map((page) => [Math.round(page.getWidth()), Math.round(page.getHeight())]);
expect(
  'images_to_pdf: páginas del tamaño de la imagen',
  JSON.stringify(imagePageSizes) === JSON.stringify(expectedImageSizes),
  JSON.stringify(imagePageSizes),
);

const a4Pdf = path.join(tmpDir, 'images-a4.pdf');
const imagesA4 = await call(client, 'images_to_pdf', { images: [imageFiles[0]], output: a4Pdf, pageSize: 'a4', confirm: true });
expect('images_to_pdf A4 responde', !imagesA4.isError, imagesA4.text);
const a4Doc = await PDFDocument.load(readFileSync(a4Pdf));
const a4Page = [a4Doc.getPage(0).getWidth(), a4Doc.getPage(0).getHeight()].map((value) => Math.round(value));
expect('images_to_pdf A4: página apaisada 842x595', JSON.stringify(a4Page) === JSON.stringify([842, 595]), JSON.stringify(a4Page));

// --- extracción de texto
if (hasPdftotext) {
  const extract = await call(client, 'pdf_extract_text', { input: aPdf });
  expect(
    'pdf_extract_text inline devuelve texto',
    !extract.isError && extract.text.includes('A1') && extract.text.includes('A3'),
    extract.text.slice(0, 300),
  );
  const extractPage = await call(client, 'pdf_extract_text', { input: aPdf, pages: '2' });
  expect(
    'pdf_extract_text con rango devuelve solo esa página',
    !extractPage.isError && extractPage.text.includes('A2') && !extractPage.text.includes('A1'),
    extractPage.text.slice(0, 300),
  );
  const txtPath = path.join(tmpDir, 'texto.txt');
  const extractFile = await call(client, 'pdf_extract_text', { input: aPdf, pages: '1-2', layout: true, output: txtPath, confirm: true });
  expect('pdf_extract_text escribe .txt', !extractFile.isError && existsSync(txtPath), extractFile.text);
  const txt = readFileSync(txtPath, 'utf8');
  expect('el .txt contiene A1 y A2, no A3', txt.includes('A1') && txt.includes('A2') && !txt.includes('A3'), txt.slice(0, 200));
  const extractNoConfirm = await call(client, 'pdf_extract_text', { input: aPdf, output: path.join(tmpDir, 'sin-confirm.txt') });
  expect('pdf_extract_text con output exige confirm:true', extractNoConfirm.isError && /confirm:true/.test(extractNoConfirm.text), extractNoConfirm.text);
} else {
  skipped.push('pdf_extract_text (pdftotext no disponible en este equipo)');
  const extract = await call(client, 'pdf_extract_text', { input: aPdf });
  expect('pdf_extract_text explica que falta pdftotext', extract.isError && /pdftotext/.test(extract.text), extract.text);
}

// --- Office a PDF
if (hasSoffice && docxReal) {
  const officePath = path.join(tmpDir, 'muestra-oficina.pdf');
  const office = await call(client, 'office_to_pdf', { input: docxPath, output: officePath, confirm: true });
  expect('office_to_pdf convierte DOCX', !office.isError && existsSync(officePath), office.text);
  const officeDoc = await PDFDocument.load(readFileSync(officePath));
  expect('office_to_pdf genera un PDF con páginas', officeDoc.getPageCount() > 0, String(officeDoc.getPageCount()));
} else if (hasSoffice) {
  skipped.push('office_to_pdf con DOCX real (sin python-docx)');
} else {
  const office = await call(client, 'office_to_pdf', { input: docxPath, confirm: true });
  expect(
    'office_to_pdf informa que falta LibreOffice',
    office.isError && /LibreOffice/.test(office.text),
    office.text,
  );
}

await client.close();
try { await transport.close?.(); } catch { /* ya cerrado */ }

// ---------------------------------------------------------------- read-only

const { client: roClient, transport: roTransport } = await makeClient({ DSH_DOCS_MODE: 'read-only' });
const roStatus = await call(roClient, 'status', {});
expect('read-only: status indica el modo', /read-only/.test(roStatus.text), roStatus.text.slice(0, 300));
const roMerge = await call(roClient, 'pdf_merge', { inputs: [aPdf, bPdf], output: path.join(tmpDir, 'ro.pdf'), confirm: true });
expect('read-only: pdf_merge bloqueado', roMerge.isError && /read-only/.test(roMerge.text), roMerge.text);
if (hasPdftotext) {
  const roExtract = await call(roClient, 'pdf_extract_text', { input: aPdf });
  expect('read-only: pdf_extract_text inline permitido', !roExtract.isError && roExtract.text.includes('A1'), roExtract.text.slice(0, 300));
} else {
  skipped.push('read-only: pdf_extract_text inline (sin pdftotext)');
}
await roClient.close();
try { await roTransport.close?.(); } catch { /* ya cerrado */ }

// ---------------------------------------------------------------- auditoría

const auditFile = path.join(dshHome, 'cache', 'doc-forge', 'audit.jsonl');
expect('audit.jsonl existe', existsSync(auditFile), auditFile);
const auditLines = readFileSync(auditFile, 'utf8').trim().split(/\r?\n/).filter(Boolean);
const auditEntries = auditLines.map((line) => JSON.parse(line));
expect('auditoría tiene entradas JSON válidas', auditEntries.length >= 8, String(auditEntries.length));
for (const tool of ['pdf_merge', 'pdf_split', 'pdf_rotate', 'images_to_pdf']) {
  expect(`auditoría registra ${tool}`, auditEntries.some((entry) => entry.tool === tool && entry.ok === true));
}
expect('auditoría registra fallos (confirm)', auditEntries.some((entry) => entry.tool === 'pdf_merge' && entry.ok === false));
expect('auditoría registra salidas con ruta', auditEntries.some((entry) => entry.tool === 'pdf_merge' && typeof entry.output === 'string' && entry.output.endsWith('.pdf')));
if (hasPdftotext) expect('auditoría registra pdf_extract_text', auditEntries.some((entry) => entry.tool === 'pdf_extract_text' && entry.ok === true));

// ---------------------------------------------------------------- resultado

console.log(`\n${passed} comprobaciones PASS.`);
if (skipped.length > 0) console.log(`omitidas: ${skipped.join(' · ')}`);
console.log('OK');
