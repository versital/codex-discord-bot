// Downloads Discord attachments into a job folder and turns them into
// something Codex can use: image inputs, readable files, or extracted text.
import { execFile } from 'node:child_process';
import { mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { extractZip, listZip } from './zip.js';

const exec = promisify(execFile);
const MB = 1024 * 1024;

export const limits = {
  maxFiles: Number(process.env.MAX_ATTACHMENTS || 10),
  maxFileBytes: Number(process.env.MAX_FILE_MB || 25) * MB,
  maxTotalBytes: Number(process.env.MAX_TOTAL_MB || 50) * MB,
  maxZipBytes: Number(process.env.MAX_ZIP_UNPACKED_MB || 100) * MB,
  maxZipEntries: Number(process.env.MAX_ZIP_FILES || 1000),
  maxImages: Number(process.env.MAX_IMAGES || 12),
  videoFrames: Number(process.env.VIDEO_FRAMES || 6),
  pdfImagePages: Number(process.env.PDF_IMAGE_PAGES || 4),
};

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.gif']);
const AUDIO = new Set(['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.flac', '.aac', '.opus', '.wma']);

const tools = {};

export async function detectTools() {
  const checks = {
    pdftotext: ['-v'],
    pdftoppm: ['-v'],
    ffmpeg: ['-version'],
    ffprobe: ['-version'],
  };
  for (const [name, args] of Object.entries(checks)) {
    // Some of these exit non-zero for -v; only "not found" means missing.
    tools[name] = await exec(name, args, { timeout: 10000 }).then(() => true, (e) => e.code !== 'ENOENT');
  }
  return tools;
}

const run = (cmd, args, timeout = 60000) => exec(cmd, args, { timeout, maxBuffer: 10 * MB, windowsHide: true });

const fmtBytes = (n) => (n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

function safeName(name, used) {
  const base = name.replace(/[^\w.-]/g, '_').replace(/^\.+/, '') || 'file';
  let candidate = base;
  for (let i = 1; used.has(candidate.toLowerCase()); i++) candidate = `${i}_${base}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > limits.maxFileBytes) throw new Error('too large');
  await writeFile(file, buf);
  return buf.length;
}

async function isText(file) {
  const fh = await open(file);
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(8192), 0, 8192, 0);
    return !buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}

/**
 * Saves attachments into `dir` and returns:
 *   images: file paths to pass to `codex exec --image`
 *   notes:  one line per attachment describing what Codex can find in `dir`
 */
export async function prepareAttachments(attachments, dir) {
  await mkdir(dir, { recursive: true });
  const images = [];
  const notes = [];
  const used = new Set();
  const addImage = (p) => (images.length < limits.maxImages ? (images.push(p), true) : false);
  let total = 0;

  for (const [i, att] of attachments.entries()) {
    const label = att.name || 'file';
    if (i >= limits.maxFiles) {
      notes.push(`${label}: skipped (more than ${limits.maxFiles} attachments)`);
      continue;
    }
    if (att.size > limits.maxFileBytes || total + att.size > limits.maxTotalBytes) {
      notes.push(`${label}: skipped (too large)`);
      continue;
    }
    total += att.size;

    const name = safeName(label, used);
    const ext = path.extname(name).toLowerCase();
    const type = att.contentType || '';
    if (AUDIO.has(ext) || type.startsWith('audio/')) {
      notes.push(`${name}: audio file, not supported (ignored)`);
      continue;
    }

    const file = path.join(dir, name);
    try {
      const size = await download(att.url, file);
      notes.push(await handle({ file, name, ext, type, size, dir, used, addImage }));
    } catch (err) {
      notes.push(`${name}: could not be processed (${err.message})`);
    }
  }
  return { images, notes };
}

async function handle(f) {
  if (IMAGE.has(f.ext)) {
    return f.addImage(f.file)
      ? `${f.name}: image (attached to this message)`
      : `${f.name}: image (not attached, too many images)`;
  }
  if (VIDEO.has(f.ext) || f.type.startsWith('video/')) return videoFrames(f);
  if (f.type.startsWith('image/')) return convertImage(f);
  if (f.ext === '.pdf') return pdf(f);
  if (f.ext === '.zip') return zip(f);
  if (await isText(f.file)) return `${f.name}: text file, ${fmtBytes(f.size)}`;
  return `${f.name}: binary file (${f.type || 'unknown type'}, ${fmtBytes(f.size)})`;
}

// Other image formats (bmp, tiff, heic...): convert to PNG if ffmpeg can.
async function convertImage(f) {
  if (!tools.ffmpeg) return `${f.name}: image in an unsupported format (${f.type})`;
  const out = path.join(f.dir, safeName(`${f.name}.png`, f.used));
  await run('ffmpeg', ['-v', 'error', '-i', f.file, '-frames:v', '1', out]);
  return f.addImage(out)
    ? `${f.name}: image (converted to PNG and attached)`
    : `${f.name}: image (not attached, too many images)`;
}

async function videoFrames(f) {
  if (!tools.ffmpeg || !tools.ffprobe) return `${f.name}: video (ffmpeg is not installed, so it can't be viewed)`;
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f.file]);
  const duration = parseFloat(stdout) || 0;
  const n = limits.videoFrames;
  const framesDir = path.join(f.dir, safeName(`${f.name}_frames`, f.used));
  await mkdir(framesDir);
  await run('ffmpeg', [
    '-v', 'error', '-i', f.file,
    '-vf', `fps=${duration > 0 ? n / duration : 1},scale=w='trunc(min(1280,iw)/2)*2':h=-2`,
    '-frames:v', String(n),
    path.join(framesDir, 'frame_%02d.jpg'),
  ], 120000);
  let attached = 0;
  for (const frame of (await readdir(framesDir)).sort()) {
    if (f.addImage(path.join(framesDir, frame))) attached++;
  }
  const length = duration ? `${duration.toFixed(1)}s` : 'unknown length';
  return `${f.name}: video, ${length}. ${attached} evenly spaced still frames are attached as images, in order (no audio)`;
}

async function pdf(f) {
  if (!tools.pdftotext) return `${f.name}: PDF (pdftotext is not installed, so it can't be read)`;
  const txtName = safeName(`${f.name}.txt`, f.used);
  const txt = path.join(f.dir, txtName);
  await run('pdftotext', ['-layout', f.file, txt]);
  const text = await readFile(txt, 'utf8');
  if (text.replace(/\s/g, '').length > 50) return `${f.name}: PDF, its text is extracted to ${txtName}`;

  // No text layer: probably a scan, so look at the first pages instead.
  if (!tools.pdftoppm) return `${f.name}: PDF with no extractable text`;
  const pagesDir = path.join(f.dir, safeName(`${f.name}_pages`, f.used));
  await mkdir(pagesDir);
  await run('pdftoppm', ['-png', '-r', '100', '-f', '1', '-l', String(limits.pdfImagePages), f.file, path.join(pagesDir, 'page')], 120000);
  let attached = 0;
  for (const page of (await readdir(pagesDir)).sort()) {
    if (f.addImage(path.join(pagesDir, page))) attached++;
  }
  return `${f.name}: scanned PDF with no text layer. The first ${attached} page(s) are attached as images`;
}

async function zip(f) {
  const files = (await listZip(f.file)).filter((e) => !e.dir);
  const count = files.length;
  const bytes = files.reduce((sum, e) => sum + e.size, 0);
  if (bytes > limits.maxZipBytes || count > limits.maxZipEntries) {
    return `${f.name}: zip too big to unpack (${count} files, ${fmtBytes(bytes)})`;
  }
  const destName = safeName(`${f.name}_unzipped`, f.used);
  const { skipped } = await extractZip(f.file, path.join(f.dir, destName));
  const note = skipped ? ` (${skipped} couldn't be extracted)` : '';
  return `${f.name}: zip with ${count} files (${fmtBytes(bytes)}), unpacked into ${destName}/${note}`;
}
