// Zip reading/extraction (pure JS, so it works the same on Linux and Windows).
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import yauzl from 'yauzl';

const openZip = promisify(yauzl.open);

const isDir = (entry) => entry.fileName.endsWith('/');

// Calls onEntry for each entry in turn. yauzl rejects absolute and "../"
// paths itself and checks real sizes against the declared ones.
async function eachEntry(file, onEntry) {
  const zf = await openZip(file, { lazyEntries: true });
  return new Promise((resolve, reject) => {
    zf.on('entry', async (entry) => {
      try {
        await onEntry(entry, zf);
        zf.readEntry();
      } catch (err) {
        zf.close();
        reject(err);
      }
    });
    zf.on('end', resolve);
    zf.on('error', reject);
    zf.readEntry();
  });
}

export async function listZip(file) {
  const entries = [];
  await eachEntry(file, async (entry) => {
    entries.push({ name: entry.fileName, size: entry.uncompressedSize, dir: isDir(entry) });
  });
  return entries;
}

/**
 * Extracts `file` into `dest`.
 *   stripRoot: drop a single top-level folder (GitHub zips have one)
 *   strict:    fail on any entry that can't be written, instead of skipping it
 */
export async function extractZip(file, dest, { stripRoot = false, strict = false } = {}) {
  dest = path.resolve(dest);
  let root = '';
  if (stripRoot) {
    const names = (await listZip(file)).map((e) => e.name);
    const first = names[0]?.split('/')[0];
    if (first && names.every((n) => n.startsWith(`${first}/`))) root = `${first}/`;
  }
  let skipped = 0;
  await eachEntry(file, async (entry, zf) => {
    const rel = entry.fileName.slice(root.length);
    if (!rel) return;
    const target = path.join(dest, rel);
    if (!target.startsWith(dest + path.sep)) return;
    if (isDir(entry)) {
      await mkdir(target, { recursive: true });
      return;
    }
    try {
      await mkdir(path.dirname(target), { recursive: true });
      const stream = await promisify(zf.openReadStream.bind(zf))(entry);
      await pipeline(stream, createWriteStream(target));
    } catch (err) {
      if (strict) throw new Error(`couldn't extract ${rel}: ${err.message}`);
      skipped++; // encrypted entry, or a name this OS can't store
    }
  });
  return { skipped };
}
