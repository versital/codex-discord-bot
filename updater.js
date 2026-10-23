// Installs new bot versions side by side under DATA_DIR/app/versions, from
// GitHub or an uploaded zip. The launcher runs whichever one `current` names.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { extractZip } from './zip.js';

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.DATA_DIR || path.join(homedir(), '.codex-discord-bot');
const APP_ROOT = path.join(DATA_DIR, 'app');
const VERSIONS = path.join(APP_ROOT, 'versions');
const CURRENT = path.join(APP_ROOT, 'current');
const PREVIOUS = path.join(APP_ROOT, 'previous');

export const REPO = process.env.UPDATE_REPO || 'versital/codex-discord-bot';
export const BRANCH = process.env.UPDATE_BRANCH || 'main';
const TOKEN = process.env.UPDATE_TOKEN || '';

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
};

export function runningVersion() {
  try {
    return JSON.parse(readFileSync(path.join(HERE, 'version.json'), 'utf8'));
  } catch {
    return { name: path.basename(HERE), source: 'unknown' };
  }
}

// True when installed with the launcher layout (so updates can switch versions).
export const managed = () => readText(CURRENT) !== '' && process.env.BOT_LAUNCHER === '1';

function githubHeaders() {
  const headers = { 'User-Agent': 'codex-discord-bot', Accept: 'application/vnd.github+json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  return headers;
}

export async function latestCommit() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(BRANCH)}`, { headers: githubHeaders() });
  if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status} for ${REPO}@${BRANCH}`);
  const body = await res.json();
  return {
    sha: body.sha,
    message: (body.commit?.message || '').split('\n')[0],
    date: body.commit?.committer?.date || '',
  };
}

export async function checkForUpdate() {
  const latest = await latestCommit();
  const current = runningVersion();
  return { current, latest, available: current.sha !== latest.sha };
}

async function download(url, file, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
}

export async function installFromGitHub(log = () => {}) {
  const latest = await latestCommit();
  const short = latest.sha.slice(0, 7);
  await mkdir(APP_ROOT, { recursive: true });
  const zip = path.join(APP_ROOT, `download-${Date.now()}.zip`);
  try {
    log(`Downloading ${REPO}@${short}…`);
    await download(`https://api.github.com/repos/${REPO}/zipball/${latest.sha}`, zip, githubHeaders());
    return await installZip(zip, { name: `gh-${short}`, source: 'github', repo: REPO, sha: latest.sha, message: latest.message }, log);
  } finally {
    await rm(zip, { force: true });
  }
}

export async function installFromUrl(url, log = () => {}) {
  await mkdir(APP_ROOT, { recursive: true });
  const zip = path.join(APP_ROOT, `upload-${Date.now()}.zip`);
  try {
    log('Downloading the zip…');
    await download(url, zip);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    return await installZip(zip, { name: `upload-${stamp}`, source: 'upload' }, log);
  } finally {
    await rm(zip, { force: true });
  }
}

function npmCli() {
  const nodeDir = path.dirname(process.execPath);
  return [
    process.env.NPM_CLI,
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Linux
  ].filter(Boolean).find(existsSync);
}

async function installDependencies(dir, log) {
  const lock = readText(path.join(dir, 'package-lock.json'));
  if (lock && lock === readText(path.join(HERE, 'package-lock.json')) && existsSync(path.join(HERE, 'node_modules'))) {
    log('Dependencies unchanged, reusing them…');
    await cp(path.join(HERE, 'node_modules'), path.join(dir, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    return;
  }
  const npm = npmCli();
  if (!npm) throw new Error("can't find npm next to node");
  log('Installing dependencies (can take a minute)…');
  await exec(process.execPath, [npm, lock ? 'ci' : 'install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: dir,
    timeout: 15 * 60 * 1000,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
}

async function installZip(zip, meta, log) {
  const dest = path.join(VERSIONS, meta.name);
  if (path.resolve(dest) === path.resolve(HERE)) throw new Error('that version is already running');
  const staging = `${dest}.partial`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    log('Unpacking…');
    await extractZip(zip, staging, { stripRoot: true, strict: true });
    for (const f of ['bot.js', 'package.json']) {
      if (!existsSync(path.join(staging, f))) throw new Error(`the zip has no ${f}, so it isn't this bot`);
    }
    await installDependencies(staging, log);
    log('Checking the new version loads…');
    await exec(process.execPath, [path.join(staging, 'bot.js'), '--check'], { cwd: staging, timeout: 60000, windowsHide: true });
    meta.installedAt = new Date().toISOString();
    await writeFile(path.join(staging, 'version.json'), JSON.stringify(meta, null, 2));
    await rm(dest, { recursive: true, force: true });
    await rename(staging, dest);
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  const current = readText(CURRENT);
  if (current && current !== meta.name) await writeFile(PREVIOUS, current);
  await writeFile(CURRENT, meta.name);
  await pruneVersions();
  return meta;
}

export async function rollback() {
  const previous = readText(PREVIOUS);
  if (!previous || !existsSync(path.join(VERSIONS, previous, 'bot.js'))) throw new Error('there is no previous version to go back to');
  await writeFile(PREVIOUS, readText(CURRENT));
  await writeFile(CURRENT, previous);
  return previous;
}

async function pruneVersions() {
  const keep = new Set([readText(CURRENT), readText(PREVIOUS), path.basename(HERE)]);
  for (const name of await readdir(VERSIONS)) {
    if (!keep.has(name)) await rm(path.join(VERSIONS, name), { recursive: true, force: true }).catch(() => {});
  }
}
