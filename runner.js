// Runs one Codex turn (`codex exec`, or `codex exec resume` for an existing
// chat) and reports progress from its --json event stream.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const IS_WINDOWS = process.platform === 'win32';
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Prefer the Codex bundled in node_modules; run its JS launcher with our own
// node so Windows doesn't need the codex.cmd shim.
const CODEX_BIN = process.env.CODEX_BIN
  || [path.join(HERE, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')].find(existsSync)
  || 'codex';

// By default Codex may write only inside its working folder (each request's
// private outbox, whose files get sent to the user) and nowhere else: not the
// temp folders, and no network. FILE_OUTPUT=false makes it fully read-only.
const WRITABLE_OUTBOX = process.env.FILE_OUTPUT !== 'false';
const SANDBOX_ARGS = WRITABLE_OUTBOX
  ? [
    '-c', 'sandbox_mode="workspace-write"',
    '-c', 'sandbox_workspace_write.network_access=false',
    '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
  ]
  : ['-c', 'sandbox_mode="read-only"'];
export const canWriteFiles = WRITABLE_OUTBOX;

// Codex features a Discord bot doesn't need; turning them off trims startup.
const DISABLED_FEATURES = (process.env.CODEX_DISABLE_FEATURES ?? 'apps,plugins,hooks,skill_search')
  .split(',').map((s) => s.trim()).filter(Boolean);

export class StoppedError extends Error {
  constructor() { super('stopped'); }
}
export class TimeoutError extends Error {
  constructor() { super('timed out'); }
}
// The old chat couldn't be reopened (e.g. its session file was cleaned up).
export class ResumeError extends Error {}

export function codexSpawn(args, options = {}) {
  const [cmd, cmdArgs] = CODEX_BIN.endsWith('.js')
    ? [process.execPath, [CODEX_BIN, ...args]]
    : [CODEX_BIN, args];
  return spawn(cmd, cmdArgs, { windowsHide: true, ...options });
}

export function killTree(child, signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (IS_WINDOWS) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    return;
  }
  try {
    process.kill(-child.pid, signal); // whole process group (spawned detached)
  } catch {
    child.kill(signal);
  }
}

// Runs a short codex subcommand and returns its stdout.
export function codexOutput(args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = codexSpawn(args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const timer = setTimeout(() => killTree(child, 'SIGKILL'), timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`codex ${args.join(' ')} exited with code ${code}`));
    });
  });
}

// `"/bin/bash" -lc 'ls -la'` -> `ls -la`
function shortCommand(cmd = '') {
  const m = cmd.match(/\s-(?:l?c|Command)\s+(['"])([\s\S]*)\1\s*$/);
  return (m ? m[2] : cmd).replace(/\s+/g, ' ').trim();
}

// TOML basic strings use the same escapes as JSON.
const toml = (s) => JSON.stringify(s);

/**
 * Options:
 *   prompt, cwd, outFile, timeoutMs   required
 *   threadId       resume this chat instead of starting a new one
 *   images         image paths to attach
 *   model, effort  blank = Codex default
 *   thinking       ask for reasoning summaries
 *   fast           use the faster (more expensive) service tier
 *   instructions   developer instructions for a new chat
 *   signal         AbortSignal to stop the run
 *   onEvent        progress callback: { kind: 'command' | 'reasoning' | 'message' | 'search', ... }
 * Resolves to { text, threadId, reasoning: string[], usage }.
 */
export function runCodex(o) {
  const args = o.threadId ? ['exec', 'resume'] : ['exec'];
  args.push(
    '--json',
    '--skip-git-repo-check',
    '--output-last-message', o.outFile,
    ...SANDBOX_ARGS,
    '-c', 'approval_policy="never"',
    '-c', `model_reasoning_summary=${toml(o.thinking ? 'detailed' : 'none')}`,
  );
  for (const feature of DISABLED_FEATURES) args.push('--disable', feature);
  if (!o.threadId) args.push('--color', 'never', '--cd', o.cwd);
  if (o.model) args.push('--model', o.model);
  if (o.effort) args.push('-c', `model_reasoning_effort=${toml(o.effort)}`);
  if (o.fast) args.push('-c', 'service_tier="priority"');
  if (o.instructions && !o.threadId) args.push('-c', `developer_instructions=${toml(o.instructions)}`);
  for (const img of o.images || []) args.push(`--image=${img}`);
  args.push('--');
  if (o.threadId) args.push(o.threadId);
  args.push('-'); // read the prompt from stdin

  return new Promise((resolve, reject) => {
    const child = codexSpawn(args, {
      cwd: o.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !IS_WINDOWS, // own process group, so stopping kills everything Codex started
    });

    const result = { threadId: o.threadId || null, reasoning: [], usage: null, text: '' };
    let lastMessage = '';
    let failure = '';
    let sawThread = false;
    let stderr = '';
    let reason = null;
    const emit = (event) => {
      try { o.onEvent?.(event); } catch {}
    };

    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      const item = ev.item || {};
      switch (ev.type) {
        case 'thread.started':
          sawThread = true;
          result.threadId = ev.thread_id;
          break;
        case 'turn.completed':
          result.usage = ev.usage || null;
          break;
        case 'turn.failed':
          failure = ev.error?.message || 'turn failed';
          break;
        case 'error':
          failure = ev.message || 'error';
          break;
        case 'item.started':
          if (item.type === 'command_execution') emit({ kind: 'command', command: shortCommand(item.command) });
          else if (item.type === 'web_search') emit({ kind: 'search' });
          break;
        case 'item.completed':
          if (item.type === 'reasoning' && item.text) {
            result.reasoning.push(item.text);
            emit({ kind: 'reasoning', text: item.text });
          } else if (item.type === 'agent_message' && item.text) {
            lastMessage = item.text;
            emit({ kind: 'message', text: item.text });
          }
          break;
      }
    });

    const stop = (why) => {
      if (reason) return;
      reason = why;
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), 5000).unref();
    };
    const timer = setTimeout(() => stop('timeout'), o.timeoutMs);
    const onAbort = () => stop('stopped');
    if (o.signal?.aborted) onAbort();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
    };

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
    child.on('close', async (code) => {
      cleanup();
      if (reason === 'stopped') return reject(new StoppedError());
      if (reason === 'timeout') return reject(new TimeoutError());
      const text = (await readFile(o.outFile, 'utf8').catch(() => '')).trim() || lastMessage.trim();
      // A turn can finish with no text, e.g. when Codex only generated an
      // image; the caller decides whether that's an error.
      const finished = code === 0 && result.usage && !failure;
      if (!text && !finished) {
        const msg = failure || stderr.trim() || `codex exited with code ${code}`;
        if (o.threadId && !sawThread) return reject(new ResumeError(msg));
        return reject(new Error(msg));
      }
      result.text = text;
      resolve(result);
    });

    child.stdin.on('error', () => {});
    child.stdin.end(o.prompt);
  });
}
