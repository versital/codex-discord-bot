// Small JSON-file database: per-user settings, chats, usage, and which Discord
// message belongs to which Codex chat. Transcripts are kept as JSONL files.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MAX_MESSAGES = 5000;

const empty = () => ({ users: {}, chats: {}, messages: {}, usage: {}, meta: { dead: [] } });

export class Store {
  constructor(dir) {
    this.file = path.join(dir, 'state.json');
    this.transcriptDir = path.join(dir, 'transcripts');
    mkdirSync(this.transcriptDir, { recursive: true });
    this.data = empty();
    if (existsSync(this.file)) {
      try {
        this.data = { ...empty(), ...JSON.parse(readFileSync(this.file, 'utf8')) };
        this.data.meta.dead ??= [];
      } catch (err) {
        console.error(`state.json is unreadable (${err.message}); starting fresh`);
        renameSync(this.file, `${this.file}.broken-${Date.now()}`);
      }
    }
    this.timer = null;
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 1000);
    this.timer.unref?.();
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
  }

  user(id) {
    return (this.data.users[id] ??= {});
  }

  usage(id) {
    return (this.data.usage[id] ??= { requests: 0, input: 0, cached: 0, output: 0, day: '', dayRequests: 0 });
  }

  // One chat list per user per server ("dm" for DMs).
  chats(key) {
    return (this.data.chats[key] ??= { active: null, list: [] });
  }

  // Keeps the newest `max` chats; older ones are queued for cleanup.
  trimChats(key, max) {
    const chats = this.chats(key);
    for (const c of chats.list.slice(max)) this.data.meta.dead.push(c.id);
    chats.list = chats.list.slice(0, max);
  }

  removeChat(key, id) {
    const chats = this.chats(key);
    chats.list = chats.list.filter((c) => c.id !== id);
    if (chats.active === id) chats.active = null;
    this.data.meta.dead.push(id);
  }

  mapMessage(messageId, value) {
    this.data.messages[messageId] = value;
    const ids = Object.keys(this.data.messages);
    if (ids.length > MAX_MESSAGES) {
      // Snowflake ids sort by time, so this drops the oldest.
      ids.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      for (const id of ids.slice(0, ids.length - MAX_MESSAGES)) delete this.data.messages[id];
    }
  }

  message(id) {
    return this.data.messages[id];
  }

  transcriptFile(threadId) {
    return path.join(this.transcriptDir, `${String(threadId).replace(/[^\w-]/g, '')}.jsonl`);
  }

  appendTranscript(threadId, entry) {
    appendFileSync(this.transcriptFile(threadId), `${JSON.stringify({ t: Date.now(), ...entry })}\n`);
  }

  readTranscript(threadId) {
    let text = '';
    try {
      text = readFileSync(this.transcriptFile(threadId), 'utf8');
    } catch {
      return [];
    }
    return text.split('\n').filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  }

  // Marks chats not used within maxAgeMs for cleanup.
  expireChats(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    for (const chats of Object.values(this.data.chats)) {
      for (const c of chats.list) if (c.updated < cutoff) this.data.meta.dead.push(c.id);
      chats.list = chats.list.filter((c) => c.updated >= cutoff);
      if (chats.active && !chats.list.some((c) => c.id === chats.active)) chats.active = null;
    }
    this.save();
  }

  // Returns (and forgets) the ids of chats whose files should be deleted.
  takeDeadChats() {
    const ids = [...new Set(this.data.meta.dead)];
    for (const id of ids) rmSync(this.transcriptFile(id), { force: true });
    this.data.meta.dead = [];
    this.save();
    return ids;
  }

  forgetUser(userId) {
    delete this.data.users[userId];
    delete this.data.usage[userId];
    for (const key of Object.keys(this.data.chats)) {
      if (!key.startsWith(`${userId}:`)) continue;
      for (const c of this.data.chats[key].list) this.data.meta.dead.push(c.id);
      delete this.data.chats[key];
    }
    for (const [id, m] of Object.entries(this.data.messages)) {
      if (m.userId === userId) delete this.data.messages[id];
    }
    this.save();
  }
}
