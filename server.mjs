#!/usr/bin/env node
// dsh-plugin-doc-forge — toolkit de documentos por lotes para DeepSeek Harness.
//
// Tools: status, pdf_merge, pdf_split, pdf_rotate, images_to_pdf,
//        pdf_extract_text (pdftotext local si existe), office_to_pdf (LibreOffice si existe).
//
// PDF: pdf-lib va incluido en el bundle (sin red en runtime).
// Reglas: rutas permitidas, nunca sobrescribir, confirm:true para escribir,
// modo read-only (DSH_DOCS_MODE=read-only), auditoría y timeout cooperativo.

import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import {
  existsSync,
  statSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { PDFDocument, degrees } from 'pdf-lib';

const VERSION = '0.1.0';
const PDFLIB_VERSION = '1.17.1';
const MB = 1024 * 1024;

const MAX_INPUT_BYTES = 200 * MB;
const MAX_TOTAL_BYTES = 400 * MB;
const MAX_PAGES = 5000;
const MAX_MERGE_INPUTS = 50;
const MAX_IMAGES = 50;
const MAX_SPLIT_FILES = 200;
const OP_TIMEOUT_MS = 60_000;
const OFFICE_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 8_000;
const RATE_LIMIT = 12;
const RATE_WINDOW_MS = 60_000;
const MAX_TEXT_CHARS = 50_000;
const A4 = [595.28, 841.89];
const LETTER = [612, 792];
const PAGE_MARGIN = 24;

const DSH_HOME = (() => {
  const fromEnv = process.env.DSH_HOME && process.env.DSH_HOME.trim();
  if (fromEnv) return fromEnv;
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, '.dsh');
})();
const CONFIG_FILE = path.join(DSH_HOME, 'doc-forge', 'config.json');
const OUT_DIR = path.join(DSH_HOME, 'cache', 'doc-forge');
const AUDIT_FILE = path.join(OUT_DIR, 'audit.jsonl');
const READ_ONLY = String(process.env.DSH_DOCS_MODE || '').trim().toLowerCase() === 'read-only';

const OFFICE_EXTENSIONS = [
  '.docx', '.doc', '.odt', '.rtf',
  '.xlsx', '.xls', '.ods', '.csv',
  '.pptx', '.ppt', '.odp',
];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'];

function log(message) {
  process.stderr.write(`[docs] ${message}\n`);
}

function audit(entry) {
  try {
    mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    /* auditoría best-effort */
  }
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
}

function sanitizeName(value) {
  const clean = String(value || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean || 'doc';
}

function baseNameNoExt(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function truncate(value, max = 500) {
  const text = String(value || '').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

// ---------------------------------------------------------------- configuración

function loadConfig() {
  let config = {};
  try {
    if (existsSync(CONFIG_FILE)) config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch (error) {
    log(`config inválida en ${CONFIG_FILE}: ${error.message}`);
  }
  const defaultProfile = process.env.USERPROFILE || os.homedir();
  const allowedPaths = Array.isArray(config.allowedPaths) && config.allowedPaths.length > 0
    ? config.allowedPaths.map((value) => path.resolve(String(value)))
    : [path.resolve(defaultProfile)];
  return {
    allowedPaths,
    sofficePath: process.env.DSH_DOCS_SOFFICE
      || (typeof config.sofficePath === 'string' && config.sofficePath.trim())
      || '',
    pdftotextPath: process.env.DSH_DOCS_PDFTOTEXT
      || (typeof config.pdftotextPath === 'string' && config.pdftotextPath.trim())
      || '',
    rateLimit: Number.isInteger(config.rateLimitPerMinute) && config.rateLimitPerMinute > 0
      ? config.rateLimitPerMinute
      : RATE_LIMIT,
    configPath: CONFIG_FILE,
  };
}

function isSameOrInside(rootLower, candidateLower) {
  return candidateLower === rootLower
    || candidateLower.startsWith(`${rootLower}${path.sep}`)
    || candidateLower.startsWith(`${rootLower}/`);
}

function ensureAllowed(config, absolutePath) {
  const normalized = path.resolve(absolutePath);
  const lower = normalized.toLowerCase();
  const allowed = config.allowedPaths.some((root) => isSameOrInside(root.toLowerCase(), lower))
    || isSameOrInside(OUT_DIR.toLowerCase(), lower);
  if (!allowed) {
    throw new Error(
      `ruta no permitida: ${normalized}. Configura allowedPaths en ${CONFIG_FILE} (actual: ${config.allowedPaths.join(', ')})`,
    );
  }
  return normalized;
}

function uniquePath(target) {
  if (!existsSync(target)) return target;
  const ext = path.extname(target);
  const base = target.slice(0, target.length - ext.length);
  for (let index = 1; index < 1000; index++) {
    const candidate = `${base}-${index}${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`no se pudo encontrar un nombre libre para ${target}`);
}

function resolveInput(config, value, { extensions = null, label = 'archivo' } = {}) {
  if (value === undefined || value === null || !String(value).trim()) {
    throw new Error(`falta la ruta de ${label}`);
  }
  const absolute = ensureAllowed(config, path.resolve(String(value).trim()));
  if (!existsSync(absolute)) throw new Error(`${label} no existe: ${absolute}`);
  const stats = statSync(absolute);
  if (!stats.isFile()) throw new Error(`${label} no es un archivo: ${absolute}`);
  if (stats.size === 0) throw new Error(`${label} está vacío: ${absolute}`);
  if (stats.size > MAX_INPUT_BYTES) {
    throw new Error(`${label} pesa ${humanBytes(stats.size)}; el máximo por archivo es ${humanBytes(MAX_INPUT_BYTES)}`);
  }
  if (extensions && !extensions.some((ext) => absolute.toLowerCase().endsWith(ext))) {
    throw new Error(`${label} debe ser ${extensions.join(' o ')}: ${absolute}`);
  }
  return { path: absolute, size: stats.size };
}

function resolveOutput(config, requested, { extension, suffix = '', inputs = [] }) {
  const inputPaths = inputs.map((value) => path.resolve(value).toLowerCase());
  let target;
  if (requested && String(requested).trim()) {
    target = ensureAllowed(config, path.resolve(String(requested).trim()));
    const currentExt = path.extname(target).toLowerCase();
    if (!currentExt) target = `${target}.${extension}`;
    else if (currentExt !== `.${extension}`) {
      throw new Error(`la salida debe tener extensión .${extension}: ${target}`);
    }
  } else {
    mkdirSync(OUT_DIR, { recursive: true });
    const base = inputs.length > 0 ? sanitizeName(baseNameNoExt(inputs[0])) : 'doc-forge';
    target = path.join(OUT_DIR, `${base}${suffix ? `-${suffix}` : ''}-${timestamp()}.${extension}`);
  }
  if (inputPaths.includes(path.resolve(target).toLowerCase())) {
    throw new Error('la salida no puede sobrescribir la entrada');
  }
  const directory = path.dirname(target);
  ensureAllowed(config, directory);
  mkdirSync(directory, { recursive: true });
  return uniquePath(target);
}

function resolveOutputDir(config, requested, inputPath) {
  let directory;
  if (requested && String(requested).trim()) {
    directory = ensureAllowed(config, path.resolve(String(requested).trim()));
  } else {
    mkdirSync(OUT_DIR, { recursive: true });
    directory = path.join(OUT_DIR, `${sanitizeName(baseNameNoExt(inputPath))}-split-${timestamp()}`);
  }
  ensureAllowed(config, directory);
  mkdirSync(directory, { recursive: true });
  return directory;
}

// ---------------------------------------------------------------- procesos

// Ejecuta un binario y devuelve {code, stdout, stderr} aunque termine con error.
// Rechaza solo si no se pudo lanzar (ENOENT) o si agotó el tiempo.
function spawnCapture(executable, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    try {
      child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new Error(`no se pudo ejecutar ${executable}: ${error.message}`));
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignora */ }
      reject(new Error(`${path.basename(executable)} agotó el tiempo (${Math.round(timeoutMs / 1000)} s)`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`no se pudo ejecutar ${executable}: ${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function runProcess(executable, args, timeoutMs = OP_TIMEOUT_MS) {
  const result = await spawnCapture(executable, args, timeoutMs);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(-900);
    throw new Error(`${path.basename(executable)} terminó con código ${result.code}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function uniqueCandidates(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!value) continue;
    const key = String(value).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(String(value).trim());
  }
  return result;
}

async function probeTool(candidates, versionArgs) {
  for (const executable of candidates) {
    try {
      const result = await spawnCapture(executable, versionArgs, PROBE_TIMEOUT_MS);
      const text = `${result.stdout}\n${result.stderr}`.trim();
      const version = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
      return { path: executable, version };
    } catch {
      /* siguiente candidato */
    }
  }
  return null;
}

function sofficeCandidates(config) {
  const isWindows = process.platform === 'win32';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';
  return uniqueCandidates([
    config.sofficePath,
    'soffice',
    'libreoffice',
    isWindows ? path.join(programFiles, 'LibreOffice', 'program', 'soffice.exe') : null,
    isWindows ? path.join(programFilesX86, 'LibreOffice', 'program', 'soffice.exe') : null,
    isWindows && localAppData ? path.join(localAppData, 'Programs', 'LibreOffice', 'program', 'soffice.exe') : null,
    !isWindows ? '/usr/bin/soffice' : null,
    !isWindows ? '/usr/local/bin/soffice' : null,
    !isWindows ? '/snap/bin/libreoffice' : null,
  ]);
}

function pdftotextCandidates(config) {
  const isWindows = process.platform === 'win32';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';
  return uniqueCandidates([
    config.pdftotextPath,
    'pdftotext',
    // Git para Windows incluye poppler/xpdf en mingw64\bin (no está en el PATH por defecto).
    isWindows ? path.join(programFiles, 'Git', 'mingw64', 'bin', 'pdftotext.exe') : null,
    isWindows ? path.join(programFiles, 'Git', 'usr', 'bin', 'pdftotext.exe') : null,
    isWindows ? path.join(programFilesX86, 'Git', 'mingw64', 'bin', 'pdftotext.exe') : null,
    isWindows && localAppData ? path.join(localAppData, 'Programs', 'Git', 'mingw64', 'bin', 'pdftotext.exe') : null,
    !isWindows ? '/usr/bin/pdftotext' : null,
    !isWindows ? '/usr/local/bin/pdftotext' : null,
  ]);
}

async function findSoffice(config) {
  return probeTool(sofficeCandidates(config), ['--version']);
}

async function findPdftotext(config) {
  return probeTool(pdftotextCandidates(config), ['-v']);
}

// ---------------------------------------------------------------- seguridad

function assertWritable(confirm) {
  if (READ_ONLY) {
    throw new Error('modo read-only (DSH_DOCS_MODE=read-only): operaciones de escritura deshabilitadas');
  }
  if (confirm !== true) {
    throw new Error('esta operación escribe archivos: requiere confirm:true y pedido explícito del usuario');
  }
}

const writeTimestamps = [];
function checkWriteRate(config) {
  const limit = config && Number.isInteger(config.rateLimit) ? config.rateLimit : RATE_LIMIT;
  const now = Date.now();
  while (writeTimestamps.length > 0 && now - writeTimestamps[0] > RATE_WINDOW_MS) writeTimestamps.shift();
  if (writeTimestamps.length >= limit) {
    throw new Error(`límite de ${limit} escrituras por minuto alcanzado; espera un momento`);
  }
  writeTimestamps.push(now);
}

function assertBudget(deadline) {
  if (Date.now() > deadline) {
    throw new Error(
      `la operación excedió el tiempo límite (${Math.round(OP_TIMEOUT_MS / 1000)} s). Divide el trabajo en lotes más pequeños.`,
    );
  }
}

function writeOp(tool, runner) {
  return async (args) => {
    try {
      return await runner(args);
    } catch (error) {
      audit({ tool, ok: false, error: truncate(error && error.message ? error.message : String(error)) });
      throw error;
    }
  };
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

// ---------------------------------------------------------------- pdf-lib

async function loadPdf(input, label = 'PDF') {
  let doc;
  try {
    // Copia a Uint8Array limpio: pdf-lib no respeta byteOffset de los Buffer de Node.
    doc = await PDFDocument.load(new Uint8Array(readFileSync(input.path)), { updateMetadata: false });
  } catch (error) {
    const message = truncate(error && error.message ? error.message : String(error), 300);
    if (/encrypt/i.test(message)) {
      throw new Error(`${label} cifrado: ${path.basename(input.path)}. Document Forge no descifra PDFs.`);
    }
    throw new Error(`no se pudo interpretar ${label} (${path.basename(input.path)}): ${message}`);
  }
  const pageCount = doc.getPageCount();
  if (pageCount === 0) throw new Error(`${label} no tiene páginas: ${input.path}`);
  if (pageCount > MAX_PAGES) {
    throw new Error(`${label} tiene ${pageCount} páginas; el máximo por archivo es ${MAX_PAGES}`);
  }
  return doc;
}

function parsePageSpec(spec, pageCount) {
  const text = String(spec || '').trim();
  if (!text) return null;
  const tokens = text.split(',').map((token) => token.trim()).filter(Boolean);
  if (tokens.length === 0) throw new Error('rango de páginas vacío');
  const ranges = tokens.map((token) => {
    const interval = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (interval) {
      const start = Number(interval[1]);
      const end = Number(interval[2]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        throw new Error(`rango de páginas inválido: "${token}" (usa "3" o "1-3")`);
      }
      if (end > pageCount) {
        throw new Error(`rango de páginas fuera de límites: "${token}". El PDF tiene ${pageCount} página(s) (1-${pageCount}).`);
      }
      return { start, end };
    }
    const single = Number(token);
    if (!Number.isInteger(single) || single < 1 || single > pageCount) {
      throw new Error(`página inválida: "${token}". El PDF tiene ${pageCount} página(s) (1-${pageCount}).`);
    }
    return { start: single, end: single };
  });
  return ranges;
}

function rangeLabel(range) {
  return range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`;
}

function rangeToIndices(range) {
  const indices = [];
  for (let page = range.start; page <= range.end; page++) indices.push(page - 1);
  return indices;
}

async function embedImage(doc, data, filePath) {
  // Copia a Uint8Array limpio: pdf-lib usa DataView(buffer) y no respeta el
  // byteOffset de los Buffer de Node (fallaba con JPG leídos del disco).
  const bytes = new Uint8Array(data);
  const isPng = bytes.length > 7 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpeg = bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const lower = filePath.toLowerCase();
  try {
    if (isPng || lower.endsWith('.png')) return await doc.embedPng(bytes);
    if (isJpeg || /\.jpe?g$/.test(lower)) return await doc.embedJpg(bytes);
  } catch (error) {
    throw new Error(`no se pudo incrustar ${path.basename(filePath)}: ${truncate(error.message, 300)}. Usa PNG o JPG válidos.`);
  }
  throw new Error(`formato de imagen no soportado: ${path.basename(filePath)}. Usa PNG o JPG.`);
}

// ---------------------------------------------------------------- MCP

function buildInstructions() {
  const config = loadConfig();
  const lines = [];
  lines.push('Document Forge: toolkit de documentos por lotes para WENDIGO.');
  lines.push('');
  lines.push(`Modo: ${READ_ONLY ? 'read-only (solo lectura)' : 'normal'}.`);
  lines.push(`Rutas permitidas: ${config.allowedPaths.join(', ')}`);
  lines.push(`Salidas por defecto: ${OUT_DIR}`);
  lines.push('');
  lines.push('Herramientas:');
  lines.push('- pdf_merge: une varios PDFs en uno (inputs, output opcional).');
  lines.push('- pdf_split: divide un PDF por rangos ("1-3,4-6") o en una página por archivo.');
  lines.push('- pdf_rotate: rota páginas 90/180/270 grados sin perder el resto.');
  lines.push('- images_to_pdf: convierte PNG/JPG en un PDF (página ajustada, A4 o Letter).');
  lines.push('- pdf_extract_text: extrae texto con pdftotext si está disponible (inline o a .txt).');
  lines.push('- office_to_pdf: convierte DOCX/XLSX/PPTX a PDF con LibreOffice si está instalado.');
  lines.push('- status: binarios detectados, rutas, modo y límites.');
  lines.push('');
  lines.push('Reglas:');
  lines.push('- Para escribir archivos usa confirm:true y hazlo solo si el usuario lo pidió.');
  lines.push('- Nunca sobrescribe originales: si el destino existe crea un nombre único, y la salida jamás puede ser una entrada.');
  lines.push('- Respeta allowedPaths; usa rutas absolutas.');
  lines.push('- Cada operación pesada queda en audit.jsonl.');
  return lines.join('\n');
}

function buildServer() {
  const server = new McpServer(
    { name: 'dsh-plugin-doc-forge', version: VERSION },
    { capabilities: { tools: {} }, instructions: buildInstructions() },
  );

  server.registerTool(
    'status',
    {
      title: 'Estado de Document Forge',
      description: 'Muestra binarios detectados (pdftotext/LibreOffice), rutas permitidas, salida, modo y límites.',
      inputSchema: z.object({}),
    },
    async () => {
      const config = loadConfig();
      const lines = [];
      lines.push('Document Forge — toolkit de documentos (PDF + Office→PDF).');
      lines.push(`Versión ${VERSION} · pdf-lib ${PDFLIB_VERSION} incluido en el bundle (sin red en runtime).`);
      lines.push(`Config: ${config.configPath}${existsSync(config.configPath) ? '' : ' (todavía no existe; se usan valores por defecto)'}`);
      lines.push(`Modo: ${READ_ONLY ? 'read-only (solo lectura; escrituras deshabilitadas)' : 'normal'}`);
      lines.push(`Rutas permitidas: ${config.allowedPaths.join(', ')}`);
      lines.push(`Salidas por defecto: ${OUT_DIR}`);
      lines.push(`Auditoría: ${AUDIT_FILE}`);
      lines.push('');
      let pdftotext = null;
      let soffice = null;
      try {
        [pdftotext, soffice] = await Promise.all([findPdftotext(config), findSoffice(config)]);
      } catch (error) {
        lines.push(`Detección de binarios: error — ${truncate(error.message)}`);
      }
      lines.push(`pdftotext: ${pdftotext
        ? `${pdftotext.path}${pdftotext.version ? ` (${pdftotext.version})` : ''} → pdf_extract_text disponible`
        : 'NO disponible → pdf_extract_text devolverá un error indicando cómo activarla'}`);
      lines.push(`LibreOffice (soffice): ${soffice
        ? `${soffice.path}${soffice.version ? ` (${soffice.version})` : ''} → office_to_pdf disponible`
        : 'NO disponible → office_to_pdf devolverá un error indicando cómo instalarlo'}`);
      lines.push('PDF (merge/split/rotate/images): pdf-lib incluido, no requiere binarios externos.');
      lines.push('');
      lines.push(
        `Límites: ${humanBytes(MAX_INPUT_BYTES)} por archivo · ${humanBytes(MAX_TOTAL_BYTES)} por lote · ${MAX_PAGES} páginas · `
        + `${MAX_MERGE_INPUTS} PDFs por unión · ${MAX_IMAGES} imágenes por PDF · ${MAX_SPLIT_FILES} archivos por división · `
        + `${Math.round(OP_TIMEOUT_MS / 1000)} s por operación (timeout cooperativo) · ${config.rateLimit} escrituras/minuto.`,
      );
      return textResult(lines.join('\n'));
    },
  );

  server.registerTool(
    'pdf_merge',
    {
      title: 'Unir PDFs',
      description: 'Une 2+ PDFs en uno solo, respetando el orden de inputs. No sobrescribe originales.',
      inputSchema: z.object({
        inputs: z.array(z.string().min(3)).min(2).max(MAX_MERGE_INPUTS)
          .describe('Rutas de los PDFs a unir, en orden (dentro de allowedPaths).'),
        output: z.string().min(3).optional().describe('Ruta del PDF de salida (dentro de allowedPaths). Por defecto, caché del plugin.'),
        confirm: z.boolean().optional().describe('true solo si el usuario confirmó escribir archivos.'),
      }),
    },
    writeOp('pdf_merge', async (args) => {
      const config = loadConfig();
      assertWritable(args.confirm);
      checkWriteRate(config);
      const inputs = args.inputs.map((value, index) => resolveInput(config, value, {
        extensions: ['.pdf'],
        label: `PDF ${index + 1}`,
      }));
      const totalBytes = inputs.reduce((sum, item) => sum + item.size, 0);
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error(`los PDFs suman ${humanBytes(totalBytes)}; el máximo por lote es ${humanBytes(MAX_TOTAL_BYTES)}`);
      }
      const output = resolveOutput(config, args.output, {
        extension: 'pdf',
        suffix: 'merged',
        inputs: inputs.map((item) => item.path),
      });
      const merged = await PDFDocument.create();
      const deadline = Date.now() + OP_TIMEOUT_MS;
      let pages = 0;
      for (const input of inputs) {
        assertBudget(deadline);
        const source = await loadPdf(input, 'PDF');
        const copied = await merged.copyPages(source, source.getPageIndices());
        for (const page of copied) merged.addPage(page);
        pages += copied.length;
        if (pages > MAX_PAGES) throw new Error(`la unión superaría el máximo de ${MAX_PAGES} páginas`);
      }
      const bytes = Buffer.from(await merged.save());
      writeFileSync(output, bytes);
      audit({
        tool: 'pdf_merge',
        ok: true,
        inputs: inputs.map((item) => path.basename(item.path)),
        output,
        pages,
        bytes: bytes.length,
      });
      return textResult(`PDF unido: ${pages} páginas de ${inputs.length} archivo(s).\nSalida: ${output} (${humanBytes(bytes.length)})`);
    }),
  );

  server.registerTool(
    'pdf_split',
    {
      title: 'Dividir PDF',
      description: 'Divide un PDF en varios: un archivo por rango ("1-3,4-6") o una página por archivo si no se indican rangos.',
      inputSchema: z.object({
        input: z.string().min(3).describe('PDF de entrada (dentro de allowedPaths).'),
        ranges: z.string().min(1).optional()
          .describe('Rangos separados por comas, 1-based: "1-3,5,7-9". Sin valor: una página por archivo.'),
        outputDir: z.string().min(3).optional().describe('Carpeta de salida (dentro de allowedPaths).'),
        prefix: z.string().min(1).max(120).optional().describe('Prefijo de los nombres de archivo.'),
        confirm: z.boolean().optional().describe('true solo si el usuario confirmó escribir archivos.'),
      }),
    },
    writeOp('pdf_split', async (args) => {
      const config = loadConfig();
      assertWritable(args.confirm);
      checkWriteRate(config);
      const input = resolveInput(config, args.input, { extensions: ['.pdf'], label: 'PDF' });
      const doc = await loadPdf(input, 'PDF');
      const pageCount = doc.getPageCount();
      let ranges;
      if (args.ranges && String(args.ranges).trim()) {
        ranges = parsePageSpec(args.ranges, pageCount);
      } else {
        if (pageCount > MAX_SPLIT_FILES) {
          throw new Error(
            `el PDF tiene ${pageCount} páginas y el máximo de archivos por división es ${MAX_SPLIT_FILES}. `
            + 'Indica "ranges" para agrupar páginas.',
          );
        }
        ranges = Array.from({ length: pageCount }, (_, index) => ({ start: index + 1, end: index + 1 }));
      }
      if (ranges.length > MAX_SPLIT_FILES) {
        throw new Error(`se generarían ${ranges.length} archivos; el máximo es ${MAX_SPLIT_FILES}. Agrupa más páginas por rango.`);
      }
      const outputDir = resolveOutputDir(config, args.outputDir, input.path);
      const prefix = sanitizeName(args.prefix && String(args.prefix).trim() ? args.prefix : baseNameNoExt(input.path));
      const deadline = Date.now() + OP_TIMEOUT_MS;
      const created = [];
      for (const range of ranges) {
        assertBudget(deadline);
        const indices = rangeToIndices(range);
        const part = await PDFDocument.create();
        const copied = await part.copyPages(doc, indices);
        for (const page of copied) part.addPage(page);
        const target = uniquePath(path.join(outputDir, `${prefix}-p${rangeLabel(range)}.pdf`));
        const bytes = Buffer.from(await part.save());
        writeFileSync(target, bytes);
        created.push({ file: target, pages: indices.length, bytes: bytes.length });
      }
      audit({
        tool: 'pdf_split',
        ok: true,
        input: path.basename(input.path),
        outputDir,
        files: created.length,
        ranges: ranges.map(rangeLabel).slice(0, 50),
      });
      const shown = created.slice(0, 40)
        .map((item) => `- ${path.basename(item.file)} (${item.pages} pág., ${humanBytes(item.bytes)})`)
        .join('\n');
      const more = created.length > 40 ? `\n... y ${created.length - 40} archivo(s) más.` : '';
      return textResult(`PDF dividido en ${created.length} archivo(s).\nCarpeta: ${outputDir}\n${shown}${more}`);
    }),
  );

  server.registerTool(
    'pdf_rotate',
    {
      title: 'Rotar páginas de un PDF',
      description: 'Rota 90/180/270 grados (sentido horario) las páginas indicadas o todas, sin modificar el original.',
      inputSchema: z.object({
        input: z.string().min(3).describe('PDF de entrada (dentro de allowedPaths).'),
        degrees: z.union([z.literal(90), z.literal(180), z.literal(270)])
          .describe('Grados en sentido horario: 90, 180 o 270.'),
        pages: z.string().min(1).optional()
          .describe('Páginas a rotar: "1-3,5". Sin valor: todas.'),
        output: z.string().min(3).optional().describe('Ruta del PDF de salida (dentro de allowedPaths).'),
        confirm: z.boolean().optional().describe('true solo si el usuario confirmó escribir archivos.'),
      }),
    },
    writeOp('pdf_rotate', async (args) => {
      const config = loadConfig();
      assertWritable(args.confirm);
      checkWriteRate(config);
      const input = resolveInput(config, args.input, { extensions: ['.pdf'], label: 'PDF' });
      const doc = await loadPdf(input, 'PDF');
      const pageCount = doc.getPageCount();
      const ranges = args.pages && String(args.pages).trim()
        ? parsePageSpec(args.pages, pageCount)
        : [{ start: 1, end: pageCount }];
      const indices = [...new Set(ranges.flatMap(rangeToIndices))];
      const output = resolveOutput(config, args.output, {
        extension: 'pdf',
        suffix: 'rotated',
        inputs: [input.path],
      });
      const deadline = Date.now() + OP_TIMEOUT_MS;
      for (const index of indices) {
        assertBudget(deadline);
        const page = doc.getPage(index);
        page.setRotation(degrees((page.getRotation().angle + args.degrees) % 360));
      }
      const bytes = Buffer.from(await doc.save());
      writeFileSync(output, bytes);
      audit({
        tool: 'pdf_rotate',
        ok: true,
        input: path.basename(input.path),
        output,
        degrees: args.degrees,
        pages: indices.length,
        bytes: bytes.length,
      });
      return textResult(
        `PDF rotado ${args.degrees}° (${indices.length} de ${pageCount} páginas).\n`
        + `Salida: ${output} (${humanBytes(bytes.length)})`,
      );
    }),
  );

  server.registerTool(
    'images_to_pdf',
    {
      title: 'Imágenes a PDF',
      description: 'Convierte una o más imágenes PNG/JPG en un PDF, una página por imagen (ajustada, A4 o Letter).',
      inputSchema: z.object({
        images: z.array(z.string().min(3)).min(1).max(MAX_IMAGES)
          .describe('Rutas de imágenes PNG/JPG en orden (dentro de allowedPaths).'),
        output: z.string().min(3).optional().describe('Ruta del PDF de salida (dentro de allowedPaths).'),
        pageSize: z.enum(['fit', 'a4', 'letter']).optional()
          .describe('fit = página del tamaño de la imagen (por defecto); a4/letter = centrada con margen.'),
        confirm: z.boolean().optional().describe('true solo si el usuario confirmó escribir archivos.'),
      }),
    },
    writeOp('images_to_pdf', async (args) => {
      const config = loadConfig();
      assertWritable(args.confirm);
      checkWriteRate(config);
      const images = args.images.map((value, index) => resolveInput(config, value, {
        extensions: IMAGE_EXTENSIONS,
        label: `imagen ${index + 1}`,
      }));
      const totalBytes = images.reduce((sum, item) => sum + item.size, 0);
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error(`las imágenes suman ${humanBytes(totalBytes)}; el máximo por lote es ${humanBytes(MAX_TOTAL_BYTES)}`);
      }
      const pageSize = args.pageSize || 'fit';
      const output = resolveOutput(config, args.output, {
        extension: 'pdf',
        suffix: 'images',
        inputs: images.map((item) => item.path),
      });
      const doc = await PDFDocument.create();
      const deadline = Date.now() + OP_TIMEOUT_MS;
      for (const image of images) {
        assertBudget(deadline);
        const embedded = await embedImage(doc, readFileSync(image.path), image.path);
        const width = embedded.width;
        const height = embedded.height;
        if (pageSize === 'fit') {
          doc.addPage([width, height]).drawImage(embedded, { x: 0, y: 0, width, height });
          continue;
        }
        const base = pageSize === 'a4' ? A4 : LETTER;
        const landscape = width > height;
        const pageWidth = landscape ? base[1] : base[0];
        const pageHeight = landscape ? base[0] : base[1];
        const scale = Math.min(
          (pageWidth - 2 * PAGE_MARGIN) / width,
          (pageHeight - 2 * PAGE_MARGIN) / height,
        );
        const drawWidth = width * scale;
        const drawHeight = height * scale;
        doc.addPage([pageWidth, pageHeight]).drawImage(embedded, {
          x: (pageWidth - drawWidth) / 2,
          y: (pageHeight - drawHeight) / 2,
          width: drawWidth,
          height: drawHeight,
        });
      }
      const bytes = Buffer.from(await doc.save());
      writeFileSync(output, bytes);
      audit({
        tool: 'images_to_pdf',
        ok: true,
        inputs: images.map((item) => path.basename(item.path)),
        output,
        pages: images.length,
        pageSize,
        bytes: bytes.length,
      });
      return textResult(
        `PDF creado con ${images.length} imagen(es) (página ${pageSize}).\n`
        + `Salida: ${output} (${humanBytes(bytes.length)})`,
      );
    }),
  );

  server.registerTool(
    'pdf_extract_text',
    {
      title: 'Extraer texto de un PDF',
      description: 'Extrae texto con pdftotext (poppler/xpdf) y lo devuelve o lo guarda en .txt. Sin OCR.',
      inputSchema: z.object({
        input: z.string().min(3).describe('PDF de entrada (dentro de allowedPaths).'),
        pages: z.string().min(1).optional()
          .describe('Un rango: "1-3" o "5". Sin valor: todo el PDF.'),
        layout: z.boolean().optional().describe('Conservar el diseño (flag -layout de pdftotext).'),
        output: z.string().min(3).optional()
          .describe('Archivo .txt de salida. Si se omite, el texto se devuelve en la respuesta.'),
        confirm: z.boolean().optional().describe('true solo si el usuario confirmó escribir archivos (solo con output).'),
      }),
    },
    async (args) => {
      const config = loadConfig();
      const input = resolveInput(config, args.input, { extensions: ['.pdf'], label: 'PDF' });
      const doc = await loadPdf(input, 'PDF');
      const pageCount = doc.getPageCount();
      let range = null;
      if (args.pages && String(args.pages).trim()) {
        const ranges = parsePageSpec(args.pages, pageCount);
        if (ranges.length !== 1) {
          throw new Error('pdf_extract_text acepta un solo rango de páginas, por ejemplo "1-3" o "5".');
        }
        range = ranges[0];
      }
      const tool = await findPdftotext(config);
      if (!tool) {
        throw new Error(
          'pdf_extract_text requiere pdftotext (poppler/xpdf) y no está disponible. '
          + 'Instálalo (por ejemplo la build de poppler para Windows o Git for Windows, que incluye pdftotext) '
          + 'o define DSH_DOCS_PDFTOTEXT / config.pdftotextPath con la ruta al ejecutable.',
        );
      }
      const writeMode = Boolean(args.output && String(args.output).trim());
      let output = null;
      if (writeMode) {
        assertWritable(args.confirm);
        checkWriteRate(config);
        output = resolveOutput(config, args.output, {
          extension: 'txt',
          suffix: 'text',
          inputs: [input.path],
        });
      }
      const commandArgs = [];
      if (args.layout) commandArgs.push('-layout');
      if (range) commandArgs.push('-f', String(range.start), '-l', String(range.end));
      commandArgs.push(input.path, output || '-');
      try {
        const result = await runProcess(tool.path, commandArgs, OP_TIMEOUT_MS);
        const text = output ? readFileSync(output, 'utf8') : result.stdout;
        const chars = text.length;
        const scope = range ? rangeLabel(range) : 'todo el PDF';
        if (writeMode) {
          audit({
            tool: 'pdf_extract_text',
            ok: true,
            input: path.basename(input.path),
            output,
            chars,
            pages: scope,
          });
          return textResult(`Texto extraído (${chars} caracteres, ${scope}).\nSalida: ${output}`);
        }
        if (!text.trim()) {
          return textResult(
            `No se encontró texto en ${path.basename(input.path)} (${scope}). `
            + 'Puede ser un PDF escaneado; Document Forge no hace OCR.',
          );
        }
        const clipped = text.length > MAX_TEXT_CHARS
          ? `${text.slice(0, MAX_TEXT_CHARS)}\n...[recortado; ${text.length} caracteres en total]`
          : text;
        return textResult(`Texto de ${path.basename(input.path)} (${scope}; ${chars} caracteres):\n\n${clipped}`);
      } catch (error) {
        if (writeMode && output) {
          try { rmSync(output, { force: true }); } catch { /* ignora */ }
          audit({ tool: 'pdf_extract_text', ok: false, input: path.basename(input.path), error: truncate(error.message) });
        }
        throw error;
      }
    },
  );

  server.registerTool(
    'office_to_pdf',
    {
      title: 'Office a PDF',
      description: 'Convierte DOCX/DOC/ODT/RTF/XLSX/XLS/ODS/CSV/PPTX/PPT/ODP a PDF con LibreOffice local (soffice).',
      inputSchema: z.object({
        input: z.string().min(3).describe('Documento de entrada (dentro de allowedPaths).'),
        output: z.string().min(3).optional().describe('Ruta del PDF de salida (dentro de allowedPaths).'),
        confirm: z.boolean().optional().describe('true solo si el usuario confirmó escribir archivos.'),
      }),
    },
    writeOp('office_to_pdf', async (args) => {
      const config = loadConfig();
      assertWritable(args.confirm);
      checkWriteRate(config);
      const input = resolveInput(config, args.input, {
        extensions: OFFICE_EXTENSIONS,
        label: 'documento',
      });
      const office = await findSoffice(config);
      if (!office) {
        throw new Error(
          'office_to_pdf requiere LibreOffice (soffice) y no se detectó. '
          + 'Instálalo (winget install TheDocumentFoundation.LibreOffice) o define DSH_DOCS_SOFFICE / '
          + 'config.sofficePath con la ruta a soffice.exe.',
        );
      }
      const output = resolveOutput(config, args.output, {
        extension: 'pdf',
        suffix: 'office',
        inputs: [input.path],
      });
      const workDir = path.join(os.tmpdir(), `doc-forge-office-${timestamp()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
      const profileDir = path.join(workDir, 'profile');
      mkdirSync(profileDir, { recursive: true });
      let runError = null;
      try {
        const profileUrl = `file:///${profileDir.replace(/\\/g, '/')}`;
        try {
          await runProcess(office.path, [
            '--headless',
            '--norestore',
            '--nolockcheck',
            `-env:UserInstallation=${profileUrl}`,
            '--convert-to',
            'pdf',
            '--outdir',
            workDir,
            input.path,
          ], OFFICE_TIMEOUT_MS);
        } catch (error) {
          runError = error;
        }
        const produced = [];
        for (const entry of readdirSafe(workDir)) {
          if (entry.toLowerCase().endsWith('.pdf')) produced.push(path.join(workDir, entry));
        }
        if (produced.length === 0) {
          throw runError || new Error('LibreOffice no generó ningún PDF (¿está cerrado el archivo en Word/Excel?)');
        }
        const bytes = Buffer.from(readFileSync(produced[0]));
        if (bytes.length === 0) throw new Error('LibreOffice generó un PDF vacío');
        writeFileSync(output, bytes);
        audit({
          tool: 'office_to_pdf',
          ok: true,
          input: path.basename(input.path),
          output,
          soffice: office.path,
          bytes: bytes.length,
        });
        return textResult(
          `Documento convertido a PDF: ${path.basename(input.path)} → ${output} (${humanBytes(bytes.length)})`,
        );
      } finally {
        try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignora */ }
      }
    }),
  );

  return server;
}

function readdirSafe(directory) {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

try {
  mkdirSync(OUT_DIR, { recursive: true });
} catch {
  /* ignora */
}

log(`modo ${READ_ONLY ? 'read-only' : 'normal'} · allowedPaths: ${loadConfig().allowedPaths.join(', ')}`);
log('pdf-lib incluido en el bundle; pdftotext y soffice se detectan en runtime');

serveStdio(buildServer, { onerror: (error) => log(`serveStdio: ${error.message}`) });

process.on('uncaughtException', (error) => log(`excepción no atrapada: ${error.message}`));
process.on('unhandledRejection', (error) => log(`rechazo no manejado: ${error && error.message ? error.message : String(error)}`));
