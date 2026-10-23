// Keeps the bot running. The bot lives in DATA_DIR/app/versions/<name>;
// `current` says which one. Exit code 75 from the bot means "restart now"
// (after an update). If a freshly updated version keeps crashing before it
// ever connects, the launcher switches back to the previous version.
//
//   node launcher.js           run the bot
//   node launcher.js update    install the latest version from GitHub, then exit
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATA_DIR = process.env.DATA_DIR || path.join(homedir(), '.codex-discord-bot');
const APP_ROOT = path.join(DATA_DIR, 'app');
const CURRENT = path.join(APP_ROOT, 'current');
const PREVIOUS = path.join(APP_ROOT, 'previous');
const RESTART_CODE = 75;

const readText = (file) => {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
};

function log(msg) {
  const line = `${new Date().toISOString()} LAUNCHER ${msg}`;
  console.log(line);
  if (process.env.LOG_FILE) {
    try { appendFileSync(process.env.LOG_FILE, `${line}\n`); } catch {}
  }
}

function currentApp() {
  const name = readText(CURRENT);
  const dir = path.join(APP_ROOT, 'versions', name);
  if (!name || !existsSync(path.join(dir, 'bot.js'))) throw new Error(`no bot installed (expected ${CURRENT}); re-run the installer`);
  return { name, dir };
}

// Only roll back a version that never connected (no .healthy marker), and
// only once, so a problem that isn't the version's fault (like a bad token)
// doesn't flip between versions forever.
let rolledBack = false;
function rollbackIfBroken(app) {
  const previous = readText(PREVIOUS);
  if (rolledBack || existsSync(path.join(app.dir, '.healthy'))) return false;
  rolledBack = true;
  if (!previous || !existsSync(path.join(APP_ROOT, 'versions', previous, 'bot.js'))) return false;
  writeFileSync(CURRENT, previous);
  writeFileSync(PREVIOUS, app.name);
  log(`${app.name} keeps crashing; switched back to ${previous}`);
  return true;
}

if (process.argv[2] === 'update') {
  const { dir } = currentApp();
  const updater = await import(pathToFileURL(path.join(dir, 'updater.js')).href);
  const meta = await updater.installFromGitHub(log);
  log(`installed ${meta.name}; restart the bot to use it`);
  process.exit(0);
}

let child = null;
let stopping = false;
let quickCrashes = 0;

function start() {
  let app;
  try {
    app = currentApp();
  } catch (err) {
    log(err.message);
    setTimeout(start, 30000);
    return;
  }
  const startedAt = Date.now();
  log(`starting ${app.name}`);
  child = spawn(process.execPath, [path.join(app.dir, 'bot.js')], {
    cwd: app.dir,
    env: { ...process.env, BOT_LAUNCHER: '1', DATA_DIR },
    // The IPC channel lets the bot notice if the launcher is killed.
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) process.exit(0);
    if (code === RESTART_CODE) {
      quickCrashes = 0;
      start();
      return;
    }
    quickCrashes = Date.now() - startedAt < 60000 ? quickCrashes + 1 : 0;
    if (quickCrashes >= 3 && rollbackIfBroken(app)) quickCrashes = 0;
    const delay = Math.min(60000, 5000 * Math.max(1, quickCrashes));
    log(`bot exited (${signal || code}); restarting in ${delay / 1000}s`);
    setTimeout(start, delay);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    if (!child) process.exit(0);
    child.kill(sig);
    setTimeout(() => process.exit(0), 10000).unref();
  });
}

start();
