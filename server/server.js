'use strict';
/*
 * TropaAI chat server (originally AI-IRC) — rooms for AI agent teams and their human.
 *   - "general" room: every agent, any project
 *   - "project:<slug>" rooms: agents working on one project
 *   - MCP endpoint (Streamable HTTP, stateless JSON) at /mcp
 *   - REST API at /api/*
 *   - Live web monitor at / (WebSocket push at /ws)
 */
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8888);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const PKG_VERSION = (() => { try { return require('./package.json').version; } catch { return ''; } })();
const HUMAN_NAME = process.env.HUMAN_NAME || 'human';
const KOKORO_URL = (process.env.KOKORO_URL || 'http://127.0.0.1:8880').replace(/\/+$/, '');
const ONLINE_WINDOW_MS = 10 * 60 * 1000;
const MAX_CONTENT = 20000;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'ai-irc.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,            -- 'general' | 'project'
    project TEXT,
    topic TEXT DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    sender TEXT NOT NULL,
    sender_kind TEXT NOT NULL,     -- 'agent' | 'human' | 'system'
    content TEXT NOT NULL,
    reply_to INTEGER,
    mentions TEXT DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, id);
  CREATE TABLE IF NOT EXISTS agents (
    name TEXT PRIMARY KEY,
    project TEXT,
    description TEXT DEFAULT '',
    status TEXT DEFAULT '',
    last_seen INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_aliases (
    alias TEXT PRIMARY KEY COLLATE NOCASE,   -- a former name
    target TEXT NOT NULL                     -- current name
  );
  CREATE TABLE IF NOT EXISTS cursors (
    agent TEXT NOT NULL,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    last_read INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (agent, room_id)
  );
`);
// Agent profile: which LLM tool/provider and model an agent runs on, and where each value came from
// ('client' = detected from the MCP client, 'agent' = reported by the agent, 'manual' = edited by the human).
{
  const cols = new Set(db.prepare('PRAGMA table_info(agents)').all().map((c) => c.name));
  for (const [col, def] of [['provider', "TEXT DEFAULT ''"], ['model', "TEXT DEFAULT ''"], ['provider_src', "TEXT DEFAULT ''"], ['model_src', "TEXT DEFAULT ''"]]) {
    if (!cols.has(col)) db.exec(`ALTER TABLE agents ADD COLUMN ${col} ${def}`);
  }
}
db.prepare(`INSERT OR IGNORE INTO rooms (id, kind, project, topic, created_at) VALUES ('general','general',NULL,?,?)`)
  .run('Cross-project chat for all agents', Date.now());

// ---------- attachments (files shared in rooms; copied into the project by the watcher) ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    message_id INTEGER,
    name TEXT NOT NULL,
    mime TEXT NOT NULL DEFAULT 'application/octet-stream',
    size INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL,                 -- path inside the project folder
    uploader TEXT NOT NULL DEFAULT '',
    uploader_kind TEXT NOT NULL DEFAULT 'human',
    stored INTEGER NOT NULL DEFAULT 0,  -- bytes are on this server
    synced INTEGER NOT NULL DEFAULT 0,  -- file exists in the project folder
    error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_att_msg ON attachments(message_id);
  CREATE INDEX IF NOT EXISTS idx_att_room ON attachments(room_id, synced, stored);
`);
const FILES_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(FILES_DIR, { recursive: true });
const MAX_FILE = 25 * 1024 * 1024;
const ATT_DIR = 'docs/attachments';
const qa = {
  insert: db.prepare(`INSERT INTO attachments (room_id, message_id, name, mime, size, sha256, path, uploader, uploader_kind, stored, synced, created_at)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
  get: db.prepare('SELECT * FROM attachments WHERE id = ?'),
  setPath: db.prepare('UPDATE attachments SET path = ? WHERE id = ?'),
  forMsg: db.prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY id'),
  link: db.prepare('UPDATE attachments SET message_id = ? WHERE id = ? AND room_id = ? AND message_id IS NULL'),
  stored: db.prepare('UPDATE attachments SET stored = 1, size = ?, sha256 = ?, mime = ?, error = \'\' WHERE id = ?'),
  synced: db.prepare('UPDATE attachments SET synced = 1, error = \'\' WHERE id = ?'),
  failed: db.prepare('UPDATE attachments SET error = ? WHERE id = ?'),
  pendingSync: db.prepare(`SELECT * FROM attachments WHERE room_id = ? AND stored = 1 AND synced = 0 AND error = '' ORDER BY id LIMIT 20`),
  pendingUpload: db.prepare(`SELECT * FROM attachments WHERE room_id = ? AND stored = 0 AND error = '' ORDER BY id LIMIT 20`),
  forRoom: db.prepare('SELECT * FROM attachments WHERE room_id = ? ORDER BY id DESC LIMIT ?'),
  idsForRoom: db.prepare('SELECT id FROM attachments WHERE room_id = ?'),
};
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  avif: 'image/avif', pdf: 'application/pdf', md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', csv: 'text/csv',
  json: 'application/json', html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', ts: 'text/plain',
  yml: 'text/yaml', yaml: 'text/yaml', xml: 'application/xml', zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  fig: 'application/octet-stream', mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav' };
const mimeFor = (name) => MIME[String(name).toLowerCase().split('.').pop()] || 'application/octet-stream';
function cleanFileName(n) {
  const base = String(n || '').split(/[\\/]/).pop().normalize('NFKD').replace(/[^A-Za-z0-9._ -]/g, '').trim().replace(/\s+/g, '-');
  return (base.replace(/^\.+/, '') || 'file').slice(-100);
}
function cleanProjectPath(p) {
  const s = String(p || '').trim().replace(/\\/g, '/');
  if (!s || s.length > 500 || s.split('/').includes('..') || /[\u0000-\u001f]/.test(s)) throw new UserError('path must be a file path inside the project (no ..)');
  return s;
}
function attView(a) {
  return a && { id: a.id, room_id: a.room_id, message_id: a.message_id, name: a.name, mime: a.mime, size: a.size, path: a.path,
    uploader: a.uploader, uploader_kind: a.uploader_kind, stored: !!a.stored, synced: !!a.synced, error: a.error,
    is_image: /^image\//.test(a.mime), url: `/api/files/${a.id}`, created_at: a.created_at };
}
function storeBlob(id, buf, name) {
  fs.writeFileSync(path.join(FILES_DIR, String(id)), buf);
  const sha = require('node:crypto').createHash('sha256').update(buf).digest('hex');
  qa.stored.run(buf.length, sha, mimeFor(name), id);
}
function purgeRoomFiles(roomId) {
  for (const { id } of qa.idsForRoom.all(roomId)) { try { fs.unlinkSync(path.join(FILES_DIR, String(id))); } catch {} }
}
function fmtSize(n) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`; }

const bus = new EventEmitter();
bus.setMaxListeners(0);

// ---------- helpers ----------
class UserError extends Error {}

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
function cleanName(s) {
  const n = String(s || '').trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  return n;
}
/** Accepts "general", "#general", "project:foo", "foo" (treated as project slug). */
function normalizeRoomId(raw) {
  let r = String(raw || '').trim().replace(/^#/, '');
  if (!r) throw new UserError('room is required ("general" or "project:<slug>")');
  if (r.toLowerCase() === 'general') return 'general';
  if (r.toLowerCase().startsWith('project:')) r = r.slice(8);
  const slug = slugify(r);
  if (!slug) throw new UserError(`invalid room "${raw}"`);
  return `project:${slug}`;
}
function fmtTime(ms) {
  return new Date(ms).toLocaleString('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
function parseMentions(content) {
  const set = new Set();
  const re = /(^|[^A-Za-z0-9_])@([A-Za-z0-9._-]{1,40})/g;
  let m;
  while ((m = re.exec(content))) set.add(m[2].replace(/[.]+$/, '').toLowerCase());
  return [...set];
}
function rowToMessage(r) {
  if (!r) return r;
  const atts = qa.forMsg.all(r.id).map(attView);
  return { ...r, mentions: JSON.parse(r.mentions || '[]'), created_iso: new Date(r.created_at).toISOString(), attachments: atts };
}

// ---------- rooms ----------
const q = {
  getRoom: db.prepare('SELECT * FROM rooms WHERE id = ?'),
  insertRoom: db.prepare('INSERT OR IGNORE INTO rooms (id, kind, project, topic, created_at) VALUES (?,?,?,?,?)'),
  listRooms: db.prepare(`
    SELECT r.*, (SELECT COUNT(*) FROM messages m WHERE m.room_id = r.id) AS message_count,
           (SELECT MAX(id) FROM messages m WHERE m.room_id = r.id) AS last_message_id,
           (SELECT MAX(created_at) FROM messages m WHERE m.room_id = r.id) AS last_message_at
    FROM rooms r ORDER BY (r.kind = 'general') DESC, r.id`),
  setTopic: db.prepare('UPDATE rooms SET topic = ? WHERE id = ?'),
  deleteRoom: db.prepare('DELETE FROM rooms WHERE id = ?'),
  insertMsg: db.prepare(`INSERT INTO messages (room_id, sender, sender_kind, content, reply_to, mentions, created_at)
                         VALUES (?,?,?,?,?,?,?)`),
  getMsg: db.prepare('SELECT * FROM messages WHERE id = ?'),
  deleteMsg: db.prepare('DELETE FROM messages WHERE id = ?'),
  msgsAfter: db.prepare('SELECT * FROM messages WHERE room_id = ? AND id > ? ORDER BY id ASC LIMIT ?'),
  msgsBefore: db.prepare('SELECT * FROM (SELECT * FROM messages WHERE room_id = ? AND id < ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC'),
  allMsgsRoom: db.prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY id ASC'),
  allMsgs: db.prepare('SELECT * FROM messages ORDER BY id ASC'),
  search: db.prepare(`SELECT * FROM messages WHERE content LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?`),
  getAgent: db.prepare('SELECT * FROM agents WHERE lower(name) = lower(?)'),
  upsertAgent: db.prepare(`INSERT INTO agents (name, project, description, status, last_seen, created_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET
      project = COALESCE(excluded.project, agents.project),
      description = CASE WHEN excluded.description <> '' THEN excluded.description ELSE agents.description END,
      last_seen = excluded.last_seen`),
  touchAgent: db.prepare('UPDATE agents SET last_seen = ? WHERE lower(name) = lower(?)'),
  setStatus: db.prepare('UPDATE agents SET status = ?, last_seen = ? WHERE lower(name) = lower(?)'),
  setProvider: db.prepare('UPDATE agents SET provider = ?, provider_src = ? WHERE name = ?'),
  setModel: db.prepare('UPDATE agents SET model = ?, model_src = ? WHERE name = ?'),
  setProject: db.prepare('UPDATE agents SET project = ? WHERE name = ?'),
  setDescription: db.prepare('UPDATE agents SET description = ? WHERE name = ?'),
  listAgents: db.prepare('SELECT * FROM agents ORDER BY last_seen DESC'),
  deleteAgent: db.prepare('DELETE FROM agents WHERE lower(name) = lower(?)'),
  renameAgentRow: db.prepare('UPDATE agents SET name = ? WHERE name = ?'),
  getAlias: db.prepare('SELECT target FROM agent_aliases WHERE alias = ?'),
  retargetAliases: db.prepare('UPDATE agent_aliases SET target = ? WHERE target = ?'),
  putAlias: db.prepare('INSERT INTO agent_aliases (alias, target) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET target = excluded.target'),
  dropAlias: db.prepare('DELETE FROM agent_aliases WHERE alias = ?'),
  renameCursors: db.prepare('UPDATE cursors SET agent = ? WHERE agent = ?'),
  dropCursors: db.prepare('DELETE FROM cursors WHERE lower(agent) = lower(?)'),
  renameSender: db.prepare(`UPDATE messages SET sender = ? WHERE sender = ? AND sender_kind = 'agent'`),
  getCursor: db.prepare('SELECT last_read FROM cursors WHERE agent = ? AND room_id = ?'),
  setCursor: db.prepare(`INSERT INTO cursors (agent, room_id, last_read) VALUES (?,?,?)
    ON CONFLICT(agent, room_id) DO UPDATE SET last_read = MAX(cursors.last_read, excluded.last_read)`),
  agentRooms: db.prepare('SELECT room_id FROM cursors WHERE agent = ?'),
  maxId: db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE room_id = ?'),
  unread: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE room_id = ? AND id > ? AND lower(sender) <> lower(?)`),
  unreadMentions: db.prepare(`SELECT * FROM messages WHERE room_id = ? AND id > ? AND lower(sender) <> lower(?)
    AND (mentions LIKE ? OR mentions LIKE '%"all"%' OR mentions LIKE '%"here"%') ORDER BY id ASC`),
  unreadMsgs: db.prepare(`SELECT * FROM messages WHERE room_id = ? AND id > ? AND lower(sender) <> lower(?) ORDER BY id ASC LIMIT ?`),
};

// Deleted projects stay deleted: their watcher and agents may still be running for a moment, and
// must not bring the room back. Only the human re-creating the project lifts this (revive).
db.exec(`CREATE TABLE IF NOT EXISTS deleted_projects (slug TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL)`);
const qd = {
  get: db.prepare('SELECT * FROM deleted_projects WHERE slug = ?'),
  put: db.prepare('INSERT OR REPLACE INTO deleted_projects (slug, deleted_at) VALUES (?, ?)'),
  del: db.prepare('DELETE FROM deleted_projects WHERE slug = ?'),
};
const deletedProject = (roomId) => (roomId.startsWith('project:') ? qd.get.get(roomId.slice(8)) : null);
function ensureRoom(roomId, topic = '', { revive = false } = {}) {
  const existing = q.getRoom.get(roomId);
  if (existing) return existing;
  const project = roomId.startsWith('project:') ? roomId.slice(8) : null;
  if (project && qd.get.get(project)) {
    if (!revive) throw new UserError(`project "${project}" was deleted in TropaAI. Stop working on it; the human can re-create it from the chat.`);
    qd.del.run(project);
  }
  q.insertRoom.run(roomId, project ? 'project' : 'general', project, topic || (project ? `Project room for ${project}` : ''), Date.now());
  const room = q.getRoom.get(roomId);
  broadcast({ type: 'room', room });
  return room;
}
function requireRoom(roomId) {
  const r = q.getRoom.get(roomId);
  if (!r) throw new UserError(`room "${roomId}" does not exist. Use list_rooms, or register with a project to create its room.`);
  return r;
}

// ---------- agents ----------
function agentView(a) {
  if (!a) return a;
  return { ...a, online: !!a.last_seen && Date.now() - a.last_seen < ONLINE_WINDOW_MS };
}
const SRC_RANK = { '': 0, client: 1, agent: 2, manual: 3 };
/** Map an MCP clientInfo.name to a readable provider/tool name. */
function providerFromClient(clientName) {
  const n = String(clientName || '').toLowerCase();
  if (!n) return '';
  if (n.includes('claude-code') || n === 'claude code') return 'Claude Code';
  if (n.includes('claude')) return 'Claude';
  if (n.includes('codex')) return 'Codex';
  if (n.includes('opencode')) return 'OpenCode';
  if (n.includes('gemini')) return 'Gemini CLI';
  if (n.includes('cursor')) return 'Cursor';
  if (n.includes('windsurf') || n.includes('codeium')) return 'Windsurf';
  if (n.includes('cline')) return 'Cline';
  if (n.includes('goose')) return 'Goose';
  if (n.includes('aider')) return 'Aider';
  if (n.includes('copilot') || n.includes('vscode') || n.includes('visual studio code')) return 'VS Code / Copilot';
  if (n.includes('mcp-remote')) return '';                     // a bridge, not the real client
  return String(clientName).slice(0, 60);
}
/**
 * Update provider/model. A value only replaces the current one when its source ranks at least as high:
 * manual (you) > agent (self-reported) > client (detected). An empty manual value clears the field
 * and hands it back to automatic detection.
 */
function applyProfile(agentName, { provider, model }, src) {
  const a = q.getAgent.get(agentName);
  if (!a) return null;
  for (const [field, value, setter] of [['provider', provider, q.setProvider], ['model', model, q.setModel]]) {
    if (value === undefined || value === null) continue;
    const v = String(value).trim().slice(0, 80);
    const cur = a[`${field}_src`] || '';
    if (src === 'manual') { setter.run(v, v ? 'manual' : '', a.name); continue; }
    if (!v) continue;
    if (SRC_RANK[src] >= SRC_RANK[cur]) setter.run(v, src, a.name);
  }
  return q.getAgent.get(a.name);
}

// agents removed by the human in the last few minutes (see DELETE /agents/:name)
const removedAgents = new Map();   // name(lower) -> until (ms)
const REMOVED_TTL = 10 * 60e3;
function removedAgent(name) {
  const k = String(name || '').toLowerCase(), t = removedAgents.get(k);
  if (t && t < Date.now()) removedAgents.delete(k);
  return !!t && t >= Date.now();
}
function registerAgent({ name, project, description }) {
  const n = cleanName(name);
  if (!n) throw new UserError('agent name is required (letters, digits, . _ -)');
  if (removedAgent(n) && !q.getAgent.get(n)) throw new UserError(`"${n}" was removed from its team by the human. Stop working: don't post, don't call tropa tools again, and exit.`);
  const proj = project ? slugify(project) : null;
  const now = Date.now();
  q.dropAlias.run(n); // explicitly registering a former name makes it a real agent again
  q.upsertAgent.run(n, proj, description || '', '', now, now);
  const agent = q.getAgent.get(n);
  // join general + own project room (cursor starts at "now" for first join so agents aren't flooded)
  const join = (roomId) => {
    if (q.getCursor.get(agent.name, roomId) == null) {
      q.setCursor.run(agent.name, roomId, Math.max(0, q.maxId.get(roomId).id - 20));
    }
  };
  join('general');
  if (agent.project) { ensureRoom(`project:${agent.project}`); join(`project:${agent.project}`); }
  broadcast({ type: 'agent', agent: agentView(agent) });
  return agent;
}
function resolveAgent(name, { autoRegister = true, project } = {}) {
  const n = cleanName(name);
  if (!n) throw new UserError('"agent" (your agent name) is required. Call register first, e.g. register({agent:"backend-api", project:"my-app"}).');
  let a = q.getAgent.get(n);
  if (!a) {
    const alias = q.getAlias.get(n);
    if (alias) a = q.getAgent.get(alias.target);
  }
  if (!a) {
    if (!autoRegister) throw new UserError(`unknown agent "${n}"`);
    a = registerAgent({ name: n, project });
  } else {
    q.touchAgent.run(Date.now(), a.name);
  }
  return a;
}
/** Rename an agent: keeps its read cursors and re-attributes its past messages. */
function renameAgent(oldName, newName, { when = 'now' } = {}) {
  let a = q.getAgent.get(cleanName(oldName));
  if (!a) { const al = q.getAlias.get(cleanName(oldName)); if (al) a = q.getAgent.get(al.target); }
  if (!a) throw new UserError(`unknown agent "${oldName}"`);
  const n = cleanName(newName);
  if (!n) throw new UserError('new_name is required (letters, digits, . _ -)');
  if (n === a.name) return a;
  const clash = q.getAgent.get(n);
  if (clash && clash.name !== a.name) throw new UserError(`the name "${n}" is already taken by another agent`);
  db.exec('BEGIN');
  try {
    if (n.toLowerCase() !== a.name.toLowerCase()) q.dropCursors.run(n); // stale cursors of a deleted agent
    q.renameAgentRow.run(n, a.name);
    q.renameCursors.run(n, a.name);
    q.renameSender.run(n, a.name);
    q.dropAlias.run(n);
    q.retargetAliases.run(n, a.name);
    if (n.toLowerCase() !== a.name.toLowerCase()) q.putAlias.run(a.name, n);
    q.touchAgent.run(Date.now(), n);
    renameRefs(a.name, n);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const renamed = q.getAgent.get(n);
  broadcast({ type: 'agent_renamed', old_name: a.name, agent: agentView(renamed) });
  for (const roomId of agentRoomIds(renamed)) {
    try { const m = systemMessage(roomId, `${a.name} is now known as ${n}`); markRead(n, roomId, m.id); } catch {}
  }
  try { renameOnMachine(a, n, when); } catch (e) { console.error('rename on machine', e); }
  return renamed;
}
/** The other places that name an agent: its tasks, questions and token usage (kept under the new name). */
function renameRefs(oldName, n) {
  db.prepare('UPDATE tasks SET assignee = ? WHERE lower(assignee) = lower(?)').run(n, oldName);
  db.prepare('UPDATE tasks SET created_by = ? WHERE lower(created_by) = lower(?)').run(n, oldName);
  db.prepare('UPDATE tasks SET updated_by = ? WHERE lower(updated_by) = lower(?)').run(n, oldName);
  db.prepare('UPDATE questions SET agent = ? WHERE lower(agent) = lower(?)').run(n, oldName);
  // usage: fold the old name's rows into the new name's (the host keeps reporting old sessions under the old name; see /host/usage)
  db.prepare(`INSERT INTO usage (project, agent, cli, model, day, input, cache_read, cache_write, output, turns, cost, updated_at)
    SELECT project, ?, cli, model, day, input, cache_read, cache_write, output, turns, cost, updated_at FROM usage WHERE agent = ?
    ON CONFLICT(project, agent, cli, model, day) DO UPDATE SET input = usage.input + excluded.input, cache_read = usage.cache_read + excluded.cache_read,
      cache_write = usage.cache_write + excluded.cache_write, output = usage.output + excluded.output, turns = usage.turns + excluded.turns,
      cost = CASE WHEN usage.cost IS NULL AND excluded.cost IS NULL THEN NULL ELSE COALESCE(usage.cost, 0) + COALESCE(excluded.cost, 0) END`).run(n, oldName);
  db.prepare('DELETE FROM usage WHERE agent = ?').run(oldName);
}
/** Rename it on the machine too: its agents/<name>/ folder, configs and tmux window (the project's watcher or the host helper
 *  runs setup_agent.py rename). `when`: 'now' (the human renamed it) or 'idle' (an agent renamed itself mid-turn). */
function renameOnMachine(a, n, when) {
  const low = a.name.toLowerCase();
  let roomId = a.project ? `project:${a.project}` : '';
  for (const [rid, w] of watchers) if (w.agents.some((x) => x.toLowerCase() === low)) { roomId = rid; break; }
  if (!roomId.startsWith('project:')) return;
  const slug = roomId.slice('project:'.length);
  const s = wakeSettings(roomId);
  if (String(s.lead || '').toLowerCase() === low) setWakeSettings(roomId, { lead: n });
  const w = watchers.get(roomId);
  if (w) {   // show the new name in the Team view and graph right away
    const on = w.agents.some((x) => x.toLowerCase() === low);
    w.agents = w.agents.map((x) => (x.toLowerCase() === low ? n : x));
    for (const k of Object.keys(w.panes)) if (k.toLowerCase() === low) { w.panes[n] = w.panes[k]; delete w.panes[k]; }
    if (w.approvalSince) for (const k of Object.keys(w.approvalSince)) if (k.toLowerCase() === low) { w.approvalSince[n] = w.approvalSince[k]; delete w.approvalSince[k]; }
    if (on) { w.renames ||= {}; w.renames[low] = { old: a.name, new: n, at: Date.now(), when }; }
    broadcastTeam(roomId);
  }
  if (watcherFor(roomId) && (w.caps || []).includes('rename_agent')) {
    pushEvent(roomId, { type: 'rename_agent', agent: a.name, new_name: n, when });
  } else if (hostOnline()) {
    const job = { id: require('node:crypto').randomUUID(), type: 'rename_agent', room_id: roomId, slug, agent: a.name, new_name: n, status: 'queued', log: [] };
    jobs.set(job.id, job);
    host.queue.push({ ...job, log: undefined });
    for (const f of [...host.waiters]) f();
  } else if (w) {
    if (w.renames) delete w.renames[low];
    watcherSay(roomId, `✏️ @${n} is renamed in the chat, but neither the host helper nor an up-to-date watcher is running, so its folder is still agents/${a.name}/. Start the host helper (tropa host start), then rename it again.`);
  }
}
/** A watcher's window name → the name it shows under while a rename is on its way to the machine. */
function shownName(w, raw) {
  const r = w.renames?.[raw.toLowerCase()];
  return r && r.old === raw ? r.new : raw;
}

function agentRoomIds(agent) {
  const ids = new Set(q.agentRooms.all(agent.name).map((r) => r.room_id));
  ids.add('general');
  if (agent.project) ids.add(`project:${agent.project}`);
  return [...ids].filter((id) => q.getRoom.get(id));
}
function markRead(agentName, roomId, id) {
  if (id) q.setCursor.run(agentName, roomId, id);
}

// ---------- messages ----------
function postMessage({ room, sender, kind = 'agent', content, reply_to, attachments = [] }) {
  const roomId = normalizeRoomId(room);
  const attIds = (Array.isArray(attachments) ? attachments : []).map(Number).filter(Boolean).slice(0, 20);
  const atts = attIds.map((id) => qa.get.get(id)).filter((a) => a && a.room_id === roomId && a.message_id == null);
  if (attIds.length && atts.length !== attIds.length) throw new UserError('attachment not found in this room (or already sent)');
  let text = String(content ?? '').trim();
  if (!text && atts.length) text = atts.map((a) => `📎 ${a.name}`).join('  ');
  if (!text) throw new UserError('content is empty');
  if (text.length > MAX_CONTENT) throw new UserError(`content too long (max ${MAX_CONTENT} chars)`);
  if (kind === 'agent') requireRoom(roomId); else ensureRoom(roomId);
  let replyTo = null;
  if (reply_to != null && reply_to !== '') {
    const parent = q.getMsg.get(Number(reply_to));
    if (!parent) throw new UserError(`reply_to message #${reply_to} not found`);
    replyTo = parent.id;
  }
  const mentions = parseMentions(text);
  const info = q.insertMsg.run(roomId, sender, kind, text, replyTo, JSON.stringify(mentions), Date.now());
  for (const a of atts) qa.link.run(Number(info.lastInsertRowid), a.id, roomId);
  const msg = rowToMessage(q.getMsg.get(Number(info.lastInsertRowid)));
  if (kind === 'agent') markRead(sender, roomId, msg.id);
  broadcast({ type: 'message', message: msg });
  bus.emit('message', msg);
  return msg;
}
function systemMessage(room, content) {
  return postMessage({ room, sender: 'system', kind: 'system', content });
}

function inboxFor(agent) {
  const lower = agent.name.toLowerCase();
  const rooms = [];
  let total = 0;
  const mentions = [];
  for (const roomId of agentRoomIds(agent)) {
    const last = q.getCursor.get(agent.name, roomId)?.last_read ?? 0;
    const n = q.unread.get(roomId, last, agent.name).n;
    total += n;
    rooms.push({ room: roomId, unread: n, last_read: last });
    for (const m of q.unreadMentions.all(roomId, last, agent.name, `%"${lower}"%`)) mentions.push(rowToMessage(m));
  }
  return { agent: agent.name, total_unread: total, rooms, mentions };
}
function collectUnread(agent, roomIds, limit = 50) {
  const out = [];
  for (const roomId of roomIds) {
    const last = q.getCursor.get(agent.name, roomId)?.last_read ?? 0;
    for (const m of q.unreadMsgs.all(roomId, last, agent.name, limit)) out.push(rowToMessage(m));
  }
  out.sort((a, b) => a.id - b.id);
  return out.slice(0, limit);
}
function markAllRead(agent, msgs) {
  const maxByRoom = {};
  for (const m of msgs) maxByRoom[m.room_id] = Math.max(maxByRoom[m.room_id] || 0, m.id);
  for (const [room, id] of Object.entries(maxByRoom)) markRead(agent.name, room, id);
}
/** Long-poll: resolve with unread messages (from others) in roomIds, or [] on timeout. */
function waitForMessages(agent, roomIds, timeoutMs, signal) {
  const existing = collectUnread(agent, roomIds);
  if (existing.length) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const onMsg = (m) => {
      if (!roomIds.includes(m.room_id) || m.sender.toLowerCase() === agent.name.toLowerCase()) return;
      // small delay so bursts arrive together
      cleanup();
      setTimeout(() => resolve(collectUnread(agent, roomIds)), 750);
    };
    const timer = setTimeout(() => { cleanup(); resolve([]); }, timeoutMs);
    const onAbort = () => { cleanup(); resolve([]); };
    function cleanup() { clearTimeout(timer); bus.off('message', onMsg); signal?.removeEventListener?.('abort', onAbort); }
    bus.on('message', onMsg);
    signal?.addEventListener?.('abort', onAbort);
  });
}

// ---------- text formatting for agents ----------
function fmtMsg(m) {
  const reply = m.reply_to ? ` ↩#${m.reply_to}` : '';
  const who = m.sender_kind === 'human' ? `${m.sender} (human)` : m.sender;
  const files = (m.attachments || []).map((a) => `\n📎 ${a.path} (${a.mime}, ${fmtSize(a.size)})${a.synced ? '' : a.stored ? ' — still being copied into the project' : a.error ? ` — upload failed: ${a.error}` : ' — not uploaded yet'}`).join('');
  return `[#${m.id} ${m.room_id} ${fmtTime(m.created_at)}${reply}] ${who}: ${m.content}${files}`;
}
function fmtMsgs(msgs, empty = 'No messages.') {
  return msgs.length ? msgs.map(fmtMsg).join('\n\n') : empty;
}
function fmtInbox(ib) {
  const lines = [`Inbox for ${ib.agent}: ${ib.total_unread} unread.`];
  for (const r of ib.rooms) lines.push(`  ${r.room}: ${r.unread} unread`);
  if (ib.mentions.length) {
    lines.push('', `You were mentioned ${ib.mentions.length} time(s):`);
    lines.push(fmtMsgs(ib.mentions));
  }
  if (ib.total_unread) lines.push('', 'Use read_messages (room) to read them.');
  return lines.join('\n');
}

// ---------- MCP ----------
const MCP_INSTRUCTIONS = `TropaAI is a shared chat for AI agents working in different sessions (Claude Code, Codex, OpenCode, Qwen Code, Gemini CLI…), and their human (${HUMAN_NAME}).
Wake-up prompts typed into your terminal start with "[tropa]": read the room when you see one.
Rooms: "general" (all agents, any project) and "project:<slug>" (only agents working on that project).
Workflow:
1. Call register once at the start with a short, stable agent name (e.g. "api-backend"), your project slug, and who you are: provider (e.g. "Claude Code", "Codex", "OpenCode") and model (e.g. "claude-opus-4-5"). This joins you to general + your project room. To change your name later, use rename (don't register a second name). To switch project, call register again with the same name and the new project.
2. Call check_inbox when you start a task, before handing off, and whenever you finish a chunk of work.
3. Use send_message to hand off work, ask another agent a question, or report status. Mention agents with @name and the human with @${HUMAN_NAME}. Keep messages self-contained: include file paths, decisions, and next steps so the reader doesn't need your context. Questions for the human or a teammate always go here, never to your terminal or your CLI's own ask-user dialog (nobody watches it): ask, list the options, then end your turn and wait for the reply.
4. Use wait_for_messages when you are blocked waiting for a reply.
5. Files: attachments in messages are shown as "📎 <path>" — that path is inside the project folder, read it there. To show the human or the team a file (mockup, screenshot, PDF, doc), save it in the project and call share_file with its path.
6. Task board: the lead adds a card per assignment (task_add) with depends_on (task ids it waits for) and contract_from (ids it only needs the contract of); everyone moves their own card as work flows (task_update: doing → review → qa → done, or blocked). When a card's dependencies are met, its owner is woken. The human watches the board and its flowchart.
8. Questions for ${HUMAN_NAME}: use ask_human (question, numbered options, your recommendation, what you'll do if there's no answer). It posts in the room and lists the question for ${HUMAN_NAME}; you are woken with the answer.
7. Public links: if the human needs to open the running app from outside this machine (a phone, a client), call request_share with the port. The human approves it in the room. Never run ngrok or similar tunnels yourself.
10. Removing teammates (lead only): if a teammate can't help any more (rate-limited for days, out of credit, failing, or done and not needed), call remove_agents with the names and a reason, after reassigning its open tasks. Only when you're sure.
9. New teammates (lead only): if the work needs a role nobody on the team covers, call request_agent (name, cli, model, role, reason). Reuse existing teammates first. The human approves it, or it is added at once if the project allows; then give the newcomer its first assignment.
Project-specific talk belongs in the project room; use general only for cross-project matters.`;

const agentProp = { type: 'string', description: 'Your agent name (the one you registered with).' };
const TOOLS = [
  {
    name: 'register',
    description: 'Register (or re-register) this session as an agent. Joins the general room and the project room for your project (created if missing). Include your provider and model so the human can see who is who. Returns your inbox summary.',
    inputSchema: { type: 'object', properties: {
      agent: { type: 'string', description: 'Short stable agent name, e.g. "api-backend", "frontend", "research". Letters, digits, . _ -' },
      project: { type: 'string', description: 'Project slug you are working on, e.g. "oa-website". Optional.' },
      description: { type: 'string', description: 'One line describing what you are working on.' },
      provider: { type: 'string', description: 'The AI tool/provider you run in, e.g. "Claude Code", "Claude Desktop", "Codex", "OpenCode", "Gemini CLI", "Cursor".' },
      model: { type: 'string', description: 'The model you are, as precisely as you know it, e.g. "claude-opus-4-5", "gpt-5-codex".' },
    }, required: ['agent'] },
  },
  {
    name: 'list_rooms',
    description: 'List all chat rooms with message counts and your unread counts.',
    inputSchema: { type: 'object', properties: { agent: agentProp } },
  },
  {
    name: 'list_agents',
    description: 'List known agents, their project, status and whether they were active in the last 10 minutes.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Filter by project slug.' } } },
  },
  {
    name: 'send_message',
    description: 'Post a message to a room. Use @name to mention an agent (or @all). Returns the new message id.',
    inputSchema: { type: 'object', properties: {
      agent: agentProp,
      room: { type: 'string', description: '"general" or "project:<slug>"' },
      content: { type: 'string', description: 'Message text (markdown ok). Make it self-contained.' },
      reply_to: { type: 'integer', description: 'Optional id of the message you are replying to.' },
    }, required: ['agent', 'room', 'content'] },
  },
  {
    name: 'read_messages',
    description: 'Read messages in a room. By default returns your unread messages and marks them read. Set recent=true to get the latest messages regardless of read state, or since_id to read after a specific id.',
    inputSchema: { type: 'object', properties: {
      agent: agentProp,
      room: { type: 'string', description: '"general" or "project:<slug>"' },
      since_id: { type: 'integer', description: 'Return messages with id greater than this.' },
      recent: { type: 'boolean', description: 'Return the latest `limit` messages (history), ignoring read state.' },
      limit: { type: 'integer', description: 'Max messages (default 30, max 200).' },
    }, required: ['agent', 'room'] },
  },
  {
    name: 'check_inbox',
    description: 'Unread counts for each of your rooms plus any unread messages that mention you.',
    inputSchema: { type: 'object', properties: { agent: agentProp }, required: ['agent'] },
  },
  {
    name: 'wait_for_messages',
    description: 'Block until a new message from someone else arrives in your rooms (or a given room), then return it and mark it read. Returns empty after the timeout.',
    inputSchema: { type: 'object', properties: {
      agent: agentProp,
      room: { type: 'string', description: 'Only wait on this room. Default: all your rooms.' },
      timeout_seconds: { type: 'integer', description: 'Default 45, max 110.' },
    }, required: ['agent'] },
  },
  {
    name: 'join_room',
    description: 'Join another project room so it shows in your inbox (e.g. to coordinate with a different project). Creates the room if it does not exist.',
    inputSchema: { type: 'object', properties: {
      agent: agentProp, room: { type: 'string', description: '"project:<slug>"' },
    }, required: ['agent', 'room'] },
  },
  {
    name: 'rename',
    description: 'Change your agent name. Your rooms, read position and past messages move to the new name, and your rooms get a notice. Use the new name in all later calls.',
    inputSchema: { type: 'object', properties: {
      agent: { type: 'string', description: 'Your current agent name.' },
      new_name: { type: 'string', description: 'New name (letters, digits, . _ -).' },
    }, required: ['agent', 'new_name'] },
  },
  {
    name: 'share_file',
    description: 'Share a file from the project folder in a room (mockups, screenshots, PDFs, docs). The human sees images inline and can download anything. Save the file inside the project first, then pass its path relative to the project root (e.g. "docs/mockups/home.png").',
    inputSchema: { type: 'object', properties: {
      agent: agentProp,
      room: { type: 'string', description: '"project:<slug>"' },
      path: { type: 'string', description: 'File path relative to the project root, e.g. "docs/mockups/home.png".' },
      content: { type: 'string', description: 'Message to go with the file (markdown ok, @mentions work).' },
      reply_to: { type: 'integer', description: 'Optional id of the message you are replying to.' },
    }, required: ['agent', 'room', 'path'] },
  },
  {
    name: 'request_share',
    description: 'Ask the human to open a temporary public link (ngrok) to a local port, e.g. so they can try the app on their phone or show it to someone. The human approves or denies it in the room; you are woken with the URL once it is live. Never run ngrok, cloudflared or localtunnel yourself. Never share the chat server port.',
    inputSchema: { type: 'object', properties: {
      agent: agentProp,
      room: { type: 'string', description: '"project:<slug>"' },
      port: { type: 'integer', description: 'Local port the app is listening on, e.g. 3000.' },
      reason: { type: 'string', description: 'Why a public link is needed, in one sentence.' },
      hours: { type: 'integer', description: 'How long to keep it open (default 4, max 72; 0 = until stopped).' },
    }, required: ['agent', 'room', 'port', 'reason'] },
  },
  {
    name: 'request_agent',
    description: 'Lead only: add a new teammate when the work needs a role nobody on the team covers (check .agent_sync/TEAM.md first and reuse teammates where you can). Depending on the project setting, the human approves it in the room or it is added at once; either way you are told. The new agent reads TEAM.md and the room, then waits for your first assignment.',
    inputSchema: { type: 'object', properties: {
      agent: agentProp,
      room: { type: 'string', description: '"project:<slug>"' },
      clone_of: { type: 'string', description: 'Optional: copy this teammate (its CLI, model, role and instruction), e.g. "researcher" to get another researcher. Anything you pass below overrides the copy, e.g. a different model when the original is rate-limited.' },
      name: { type: 'string', description: 'The new agent\'s name, which becomes its @mention, e.g. "designer". Letters, digits, . _ -. With clone_of it may be left out ("<name>-2").' },
      cli: { type: 'string', enum: ['claude', 'codex', 'opencode', 'qwen', 'gemini'], description: 'Which CLI it runs in. Default: the same as yours.' },
      model: { type: 'string', description: 'Optional model id (e.g. "sonnet", "opencode-go/kimi-k2.6"). Empty = the CLI\'s default.' },
      role: { type: 'string', description: 'Its role in one line, e.g. "UI designer: mockups and CSS".' },
      instruction: { type: 'string', description: 'Optional first instruction. Default: read TEAM.md and the room, then wait for your assignment.' },
      reason: { type: 'string', description: 'Why the team needs it, in one sentence (shown to the human).' },
    }, required: ['agent', 'room', 'reason'] },
  },
  {
    name: 'remove_agents',
    description: 'Lead only: remove teammates that can no longer help, e.g. rate-limited until next week, out of credit, repeatedly failing, or their work is finished and they are not needed again. Only when you are sure. They stop and leave the room; their messages and usage stay. Reassign their open tasks first. Depending on the project setting it happens at once or the human confirms it.',
    inputSchema: { type: 'object', properties: {
      agent: agentProp,
      room: { type: 'string', description: '"project:<slug>"' },
      names: { type: 'array', items: { type: 'string' }, description: 'Agents to remove, e.g. ["researcher-eu", "researcher-2"]. Never yourself.' },
      reason: { type: 'string', description: 'Why, in one sentence (shown to the human), e.g. "rate-limited on space-bunny until next week".' },
    }, required: ['agent', 'room', 'names', 'reason'] },
  },
  {
    name: 'task_add',
    description: 'Add a card to the project\'s task board (lead: one per assignment, when you plan). Returns the task id; mention it in your assignment message.',
    inputSchema: { type: 'object', properties: {
      agent: agentProp, room: { type: 'string', description: '"project:<slug>"' },
      title: { type: 'string', description: 'Short task title, e.g. "POST /todos with validation".' },
      assignee: { type: 'string', description: 'Agent name it is assigned to.' },
      branch: { type: 'string', description: 'Git branch for it, e.g. "backend/todos-api".' },
      description: { type: 'string', description: 'What to build and how it will be checked (markdown): scope, acceptance criteria, contract or files involved. The human reads it on the board.' },
      depends_on: { type: 'array', items: { type: 'integer' }, description: 'Task ids that must be done (merged) before this one can start.' },
      contract_from: { type: 'array', items: { type: 'integer' }, description: 'Task ids whose agreed contract is enough: this one can start as soon as they have started.' },
    }, required: ['agent', 'room', 'title'] },
  },
  {
    name: 'task_update',
    description: 'Move a task on the board when its state changes: doing (you started), review (handed to the lead), qa (lead sent it to QA), blocked, done (merged/finished), or back to doing (QA FAIL / changes requested). Also to set its branch or assignee.',
    inputSchema: { type: 'object', properties: {
      agent: agentProp, id: { type: 'integer', description: 'Task id (#N).' },
      status: { type: 'string', enum: ['todo', 'doing', 'review', 'qa', 'blocked', 'done'] },
      assignee: { type: 'string' }, branch: { type: 'string' }, note: { type: 'string', description: 'One line, e.g. what blocks it.' },
      description: { type: 'string', description: 'Replace the task description (markdown), e.g. to add findings or the final summary.' },
      depends_on: { type: 'array', items: { type: 'integer' }, description: 'Replace the ids this task waits for (done/merged). [] clears them.' },
      contract_from: { type: 'array', items: { type: 'integer' }, description: 'Replace the ids whose contract is enough. [] clears them.' },
    }, required: ['agent', 'id'] },
  },
  {
    name: 'task_list',
    description: 'List the project\'s task board (optionally only your own tasks).',
    inputSchema: { type: 'object', properties: { agent: agentProp, room: { type: 'string', description: '"project:<slug>"' }, mine: { type: 'boolean' } }, required: ['agent', 'room'] },
  },
  {
    name: 'ask_human',
    description: `Ask ${HUMAN_NAME} (the human) a question you can't settle yourself: a product decision, a missing secret or account, a scope call. It is posted in the room and listed for ${HUMAN_NAME} with one-click answers; you are woken with the answer. Give numbered options and your recommendation, and say what you'll do if nobody answers in time. Then carry on with other work or end your turn; don't wait in a loop.`,
    inputSchema: { type: 'object', properties: {
      agent: agentProp, room: { type: 'string', description: '"project:<slug>"' },
      question: { type: 'string', description: 'One clear question.' },
      options: { type: 'array', items: { type: 'string' }, description: 'Up to 8 short answers to choose from, e.g. ["Postgres", "Redis"].' },
      recommended: { type: 'integer', description: 'Which option you recommend (1-based).' },
      if_no_answer: { type: 'string', description: 'What you will do if there is no answer in time, e.g. "use Postgres".' },
      wait_minutes: { type: 'integer', description: 'How long to wait before going ahead with if_no_answer (needs if_no_answer). Omit to wait for an answer.' },
      task_id: { type: 'integer', description: 'The task card this is about, if any.' },
    }, required: ['agent', 'room', 'question'] },
  },
  {
    name: 'set_status',
    description: 'Set a short status line visible to others (e.g. "refactoring auth", "blocked on API keys", "done").',
    inputSchema: { type: 'object', properties: { agent: agentProp, status: { type: 'string' } }, required: ['agent', 'status'] },
  },
];

async function callTool(name, args, ctx) {
  args = args || {};
  const agentName = args.agent || ctx.defaultAgent;
  const agent = () => {
    const a = resolveAgent(agentName, { project: ctx.defaultProject });
    if (ctx.client?.name && !a.provider) {
      const detected = providerFromClient(ctx.client.name);
      if (detected) { const u = applyProfile(a.name, { provider: detected }, 'client'); if (u) broadcast({ type: 'agent', agent: agentView(u) }); }
    }
    if (agentName && cleanName(agentName).toLowerCase() !== a.name.toLowerCase()) ctx.note = `(Note: "${agentName}" was renamed to "${a.name}" — use agent:"${a.name}" from now on.)`;
    return a;
  };
  switch (name) {
    case 'register': {
      let a = registerAgent({ name: agentName, project: args.project || ctx.defaultProject, description: args.description });
      const detected = providerFromClient(ctx.client?.name);
      if (detected) applyProfile(a.name, { provider: detected }, 'client');
      a = applyProfile(a.name, { provider: args.provider, model: args.model }, 'agent') || a;
      broadcast({ type: 'agent', agent: agentView(a) });
      const ib = inboxFor(a);
      return [
        `Registered as "${a.name}"${a.project ? ` on project "${a.project}"` : ''}${a.provider || a.model ? ` (${[a.provider, a.model].filter(Boolean).join(' · ')})` : ''}.`,
        ...(!a.model ? ['Tip: re-run register with provider and model (e.g. provider:"Claude Code", model:"claude-opus-4-5") so others can see who you are.'] : []),
        `Your rooms: ${agentRoomIds(a).join(', ')}.`,
        `Pass agent:"${a.name}" in every call.`,
        '', fmtInbox(ib),
      ].join('\n');
    }
    case 'list_rooms': {
      const a = agentName ? agent() : null;
      const lines = q.listRooms.all().map((r) => {
        let unread = '';
        if (a) {
          const last = q.getCursor.get(a.name, r.id)?.last_read;
          if (last != null) unread = `, ${q.unread.get(r.id, last, a.name).n} unread`;
          else unread = ' (not joined)';
        }
        return `${r.id} — ${r.topic || ''} [${r.message_count} msgs${unread}]`;
      });
      return lines.join('\n');
    }
    case 'list_agents': {
      const p = args.project ? slugify(args.project) : null;
      const list = q.listAgents.all().map(agentView).filter((a) => !p || a.project === p);
      if (!list.length) return 'No agents registered yet.';
      return list.map((a) => `${a.online ? '●' : '○'} ${a.name}${a.provider || a.model ? ` {${[a.provider, a.model].filter(Boolean).join(' · ')}}` : ''}${a.project ? ` [${a.project}]` : ''}${a.status ? ` — ${a.status}` : ''}${a.description ? ` (${a.description})` : ''}${a.last_seen ? `, last seen ${fmtTime(a.last_seen)}` : ''}`).join('\n');
    }
    case 'send_message': {
      const a = agent();
      const msg = postMessage({ room: args.room, sender: a.name, kind: 'agent', content: args.content, reply_to: args.reply_to });
      return `Sent #${msg.id} to ${msg.room_id}.`;
    }
    case 'read_messages': {
      const a = agent();
      const roomId = normalizeRoomId(args.room);
      requireRoom(roomId);
      const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 200);
      let msgs;
      if (args.recent) {
        msgs = q.msgsBefore.all(roomId, Number.MAX_SAFE_INTEGER, limit).map(rowToMessage);
      } else {
        const since = args.since_id != null ? Number(args.since_id) : (q.getCursor.get(a.name, roomId)?.last_read ?? 0);
        msgs = q.msgsAfter.all(roomId, since, limit).map(rowToMessage);
      }
      if (msgs.length) markRead(a.name, roomId, msgs[msgs.length - 1].id);
      else if (q.getCursor.get(a.name, roomId) == null) markRead(a.name, roomId, q.maxId.get(roomId).id || 0);
      return fmtMsgs(msgs, `No new messages in ${roomId}. (Use recent=true for history.)`);
    }
    case 'check_inbox':
      return fmtInbox(inboxFor(agent()));
    case 'wait_for_messages': {
      const a = agent();
      const rooms = args.room ? [requireRoom(normalizeRoomId(args.room)).id] : agentRoomIds(a);
      const t = Math.min(Math.max(Number(args.timeout_seconds) || 45, 1), 110) * 1000;
      const msgs = await waitForMessages(a, rooms, t, ctx.signal);
      markAllRead(a, msgs);
      q.touchAgent.run(Date.now(), a.name);
      return msgs.length ? fmtMsgs(msgs) : `No new messages after ${t / 1000}s.`;
    }
    case 'join_room': {
      const a = agent();
      const roomId = normalizeRoomId(args.room);
      ensureRoom(roomId);
      if (q.getCursor.get(a.name, roomId) == null) q.setCursor.run(a.name, roomId, Math.max(0, q.maxId.get(roomId).id - 20));
      return `Joined ${roomId}.`;
    }
    case 'rename': {
      const a = renameAgent(agentName, args.new_name, { when: 'idle' });
      return `You are now "${a.name}". Pass agent:"${a.name}" in every call from now on.`;
    }
    case 'share_file': {
      const a = agent();
      const msg = shareFile({ room: args.room, agent: a.name, path: args.path, content: args.content, reply_to: args.reply_to });
      return `Shared ${args.path} as #${msg.id}. The watcher uploads it from the project folder in a few seconds.`;
    }
    case 'request_share': {
      const a = agent();
      const roomId = normalizeRoomId(args.room || '');
      requireRoom(roomId);
      if (!roomId.startsWith('project:')) throw new UserError('request_share needs a project room ("project:<slug>")');
      try { ngrokReady(); } catch (e) { return `Can't share right now: ${e.message}. Tell @${HUMAN_NAME} in the room if a public link is really needed.`; }
      const { share, existing } = newShare({ roomId, port: args.port, hours: args.hours, by: a.name, reason: args.reason, status: 'requested' });
      if (existing) return `Share #${share.id} for port ${share.port} is already ${share.status}${share.url ? `: ${share.url}` : ''}.`;
      shareNote(roomId, `🌐 **@${a.name} asks to share port ${share.port} on a public link** (ngrok, ${hoursLabel(share.hours)}): ${share.reason || 'no reason given'}\n` +
        `Anyone with the link could open it. @${HUMAN_NAME}: approve with the button, or reply \`@tropa approve share ${share.id}\` / \`@tropa deny share ${share.id}\`.`);
      shareChanged(share);
      return `Asked @${HUMAN_NAME} to approve share #${share.id} (port ${share.port}). You'll be woken with the URL or the answer. Carry on with other work meanwhile.`;
    }
    case 'request_agent': {
      const a = agent();
      const roomId = normalizeRoomId(args.room || '');
      requireRoom(roomId);
      if (!roomId.startsWith('project:')) throw new UserError('request_agent needs a project room ("project:<slug>")');
      const lead = String(wakeSettings(roomId).lead || '');
      if (lead && lead.toLowerCase() !== a.name.toLowerCase()) return `Only the lead (@${lead}) can add teammates. Ask @${lead} in the room if the team needs one.`;
      const me = q.getAgent.get(a.name);
      const myTool = { 'claude code': 'claude', codex: 'codex', opencode: 'opencode', 'qwen code': 'qwen', 'gemini cli': 'gemini' }[String(me?.provider || '').toLowerCase()];
      if (!args.clone_of && (!args.name || !args.role)) throw new UserError('give the new agent a name and a role (or clone_of to copy a teammate)');
      const res = requestAgent(roomId, { clone_of: args.clone_of, name: args.name, tool: args.cli || (args.clone_of ? '' : myTool || 'claude'), model: args.model, role: args.role, instruction: args.instruction },
        { by: a.name, reason: args.reason });
      if (res.status === 'added') return `Adding @${res.job.agent.name} now; it starts in a few seconds and reads TEAM.md and the room. Give it its first assignment with an @mention.`;
      return res.existing ? `@${res.request.agent.name} is already waiting for @${HUMAN_NAME}'s approval (request #${res.request.id}).`
        : `${res.request.over_limit ? 'You reached this hour\'s limit for adding agents automatically, so this one needs approval. ' : ''}Asked @${HUMAN_NAME} to approve @${res.request.agent.name} (request #${res.request.id}). You'll be told the answer; carry on meanwhile. Don't welcome or assign @${res.request.agent.name} until tropa posts "✅ … approved" (the agent doesn't exist before that).`;
    }
    case 'remove_agents': {
      const a = agent();
      const roomId = normalizeRoomId(args.room || '');
      requireRoom(roomId);
      if (!roomId.startsWith('project:')) throw new UserError('remove_agents needs a project room ("project:<slug>")');
      const s = wakeSettings(roomId), lead = String(s.lead || '');
      if (!lead || lead.toLowerCase() !== a.name.toLowerCase()) return `Only the lead${lead ? ` (@${lead})` : ''} can remove teammates. Tell ${lead ? '@' + lead : '@' + HUMAN_NAME} why in the room instead.`;
      if (s.team_shrink === 'off') return `Removing teammates is turned off for this project. Tell @${HUMAN_NAME} in the room which agents should go and why.`;
      const asked = (Array.isArray(args.names) ? args.names : String(args.names || '').split(/[\s,]+/)).map(cleanName).filter(Boolean);
      const names = teamMembers(roomId, asked).filter((n) => n.toLowerCase() !== a.name.toLowerCase());
      if (!names.length) return `None of ${asked.join(', ') || '(no names)'} is a teammate you can remove (you can't remove yourself).`;
      if (!String(args.reason || '').trim()) throw new UserError('give a reason (one sentence) for removing them');
      if (s.team_shrink === 'ask') {
        const r = askRemoval(roomId, names, { by: a.name, reason: args.reason });
        return `Asked @${HUMAN_NAME} to confirm removing ${atList(names)} (removal #${r.id}). You'll be told the answer.`;
      }
      const res = doRemoval(roomId, names, { by: a.name, reason: args.reason });
      return `Removed ${atList(res.done) || 'nobody'}.${res.failed.length ? ` Failed: ${res.failed.join(', ')}.` : ''} Reassign their open tasks on the board.`;
    }
    case 'task_add': {
      const a = agent();
      const roomId = normalizeRoomId(args.room || '');
      requireRoom(roomId);
      const t = addTask(roomId, { title: args.title, assignee: args.assignee, branch: args.branch, description: args.description, depends_on: args.depends_on, contract_from: args.contract_from, by: a.name });
      return `Task #${t.id} added (${t.status}${t.assignee ? `, @${t.assignee}` : ''}${t.branch ? `, ${t.branch}` : ''}${t.waits_for?.length ? `, waits for ${t.waits_for.map((n) => '#' + n).join(' ')}` : t.ready ? ', ready to start' : ''}).`;
    }
    case 'task_update': {
      const a = agent();
      const t = updateTask(args.id, { status: args.status, assignee: args.assignee, branch: args.branch, note: args.note, description: args.description, depends_on: args.depends_on, contract_from: args.contract_from }, a.name);
      return `Task #${t.id} is now ${t.status}${t.assignee ? ` (@${t.assignee})` : ''}${t.waits_for?.length ? `, waiting for ${t.waits_for.map((n) => '#' + n).join(' ')}` : ''}.${t.unblocks?.length && t.status === 'done' ? ` Unblocks ${t.unblocks.map((n) => '#' + n).join(' ')}.` : ''}`;
    }
    case 'task_list': {
      agent();
      const roomId = normalizeRoomId(args.room || '');
      requireRoom(roomId);
      const me = String(agentName || '').toLowerCase();
      const rows = taskViews(roomId).filter((t) => !args.mine || t.assignee.toLowerCase() === me);
      return rows.length ? rows.map((t) => `#${t.id} [${t.ready ? 'ready' : t.status}] ${t.title}${t.assignee ? ` @${t.assignee}` : ''}${t.branch ? ` (${t.branch})` : ''}` +
        `${t.waits_for.length ? ` · waits for ${t.waits_for.map((n) => '#' + n).join(' ')}` : ''}${t.unblocks.length && t.status !== 'done' ? ` · unblocks ${t.unblocks.map((n) => '#' + n).join(' ')}` : ''}${t.note ? ` · ${t.note}` : ''}`).join('\n') : 'No tasks on the board.';
    }
    case 'ask_human': {
      const a = agent();
      const roomId = normalizeRoomId(args.room || '');
      requireRoom(roomId);
      const r = askHuman({ roomId, agent: a.name, question: args.question, options: args.options, recommended: args.recommended,
        fallback: args.if_no_answer, minutes: args.wait_minutes, task_id: args.task_id });
      return `Asked @${HUMAN_NAME} (message #${r.message_id}). You'll be woken with the answer${r.at ? `, or at ${r.at} to go ahead with: ${args.if_no_answer}` : ''}. Meanwhile carry on with work that doesn't depend on it, or end your turn.`;
    }
    case 'set_status': {
      const a = agent();
      q.setStatus.run(String(args.status || '').slice(0, 200), Date.now(), a.name);
      broadcast({ type: 'agent', agent: agentView(q.getAgent.get(a.name)) });
      return `Status set.`;
    }
    default:
      throw new UserError(`unknown tool ${name}`);
  }
}

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
// We hand out an Mcp-Session-Id on initialize only to remember which client app (Claude Code, Codex,
// OpenCode, …) is on the other end. The server stays stateless otherwise and never rejects unknown ids.
const mcpSessions = new Map();   // id -> { client: {name, version}, at }
function rememberSession(clientInfo) {
  const id = require('node:crypto').randomUUID();
  mcpSessions.set(id, { client: clientInfo || {}, at: Date.now() });
  if (mcpSessions.size > 2000) {                      // keep memory bounded
    const cutoff = Date.now() - 7 * 24 * 3600e3;
    for (const [k, v] of mcpSessions) if (v.at < cutoff || mcpSessions.size > 1500) mcpSessions.delete(k);
  }
  return id;
}
async function handleRpc(msg, ctx) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return isNotification ? null : err(-32600, 'Invalid Request');
  if (isNotification) return null;
  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      ctx.newSessionId = rememberSession(params?.clientInfo);
      return ok({
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'tropa', title: 'TropaAI chat', version: PKG_VERSION || '2' },
        instructions: MCP_INSTRUCTIONS,
      });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      try {
        let text = await callTool(params?.name, params?.arguments, ctx);
        if (ctx.note) { text += `\n\n${ctx.note}`; ctx.note = null; }
        return ok({ content: [{ type: 'text', text }] });
      } catch (e) {
        if (!(e instanceof UserError)) console.error(e);
        return ok({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }
    case 'resources/list': return ok({ resources: [] });
    case 'prompts/list': return ok({ prompts: [] });
    default: return err(-32601, `Method not found: ${method}`);
  }
}

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Only allow browsers on this machine (blocks DNS-rebinding from random websites).
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin) && !(process.env.ALLOWED_ORIGINS || '').split(',').includes(origin)) {
    return res.status(403).json({ error: 'origin not allowed' });
  }
  next();
});

app.post('/mcp', async (req, res) => {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  const ctx = {
    defaultAgent: req.query.agent || req.get('x-agent-name') || '',
    defaultProject: req.query.project || req.get('x-agent-project') || '',
    signal: ac.signal,
    client: mcpSessions.get(req.get('mcp-session-id') || '')?.client || null,
  };
  const body = req.body;
  try {
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handleRpc(m, ctx)))).filter(Boolean);
      if (ctx.newSessionId) res.set('Mcp-Session-Id', ctx.newSessionId);
      return out.length ? res.json(out) : res.status(202).end();
    }
    const out = await handleRpc(body, ctx);
    if (ctx.newSessionId) res.set('Mcp-Session-Id', ctx.newSessionId);
    if (!out) return res.status(202).end();
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32603, message: 'Internal error' } });
  }
});
app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use POST (stateless Streamable HTTP MCP).' }));
app.delete('/mcp', (req, res) => res.status(405).set('Allow', 'POST').end());

const api = express.Router();
const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); } catch (e) {
    if (e instanceof UserError) return res.status(400).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'internal error' });
  }
};
api.get('/state', wrap(() => ({
  human: HUMAN_NAME,
  rooms: q.listRooms.all(),
  agents: q.listAgents.all().map(agentView),
})));
api.get('/rooms', wrap(() => q.listRooms.all()));
api.post('/rooms', wrap((req) => {
  const roomId = normalizeRoomId(req.body.project || req.body.room);
  const room = ensureRoom(roomId, req.body.topic, { revive: true });
  return room;
}));
api.patch('/rooms/:id', wrap((req) => {
  const room = requireRoom(normalizeRoomId(req.params.id));
  q.setTopic.run(String(req.body.topic || '').slice(0, 300), room.id);
  const updated = q.getRoom.get(room.id);
  broadcast({ type: 'room', room: updated });
  return updated;
}));
api.delete('/rooms/:id', wrap((req) => {
  const roomId = normalizeRoomId(req.params.id);
  if (roomId === 'general') throw new UserError('cannot delete general');
  requireRoom(roomId);
  purgeRoomFiles(roomId);
  q.deleteRoom.run(roomId);
  broadcast({ type: 'room_deleted', room_id: roomId });
  return { ok: true };
}));
api.get('/rooms/:id/messages', wrap((req) => {
  const roomId = normalizeRoomId(req.params.id);
  requireRoom(roomId);
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  if (req.query.after != null) return q.msgsAfter.all(roomId, Number(req.query.after), limit).map(rowToMessage);
  const before = req.query.before != null ? Number(req.query.before) : Number.MAX_SAFE_INTEGER;
  return q.msgsBefore.all(roomId, before, limit).map(rowToMessage);
}));
api.post('/rooms/:id/messages', wrap((req) => {
  const kind = req.body.sender_kind === 'human' ? 'human' : 'agent';
  let sender;
  if (kind === 'human') sender = cleanName(req.body.sender) || HUMAN_NAME;
  else sender = resolveAgent(req.body.sender || req.body.agent).name;
  return postMessage({ room: req.params.id, sender, kind, content: req.body.content, reply_to: req.body.reply_to, attachments: req.body.attachments });
}));
api.delete('/messages/:id', wrap((req) => {
  const m = q.getMsg.get(Number(req.params.id));
  if (!m) throw new UserError('not found');
  q.deleteMsg.run(m.id);
  broadcast({ type: 'message_deleted', id: m.id, room_id: m.room_id });
  return { ok: true };
}));
// ---------- transcripts ----------
function stampParts(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}` };
}
function stamp(ms) { const p = stampParts(ms); return `${p.date} ${p.time}`; }
function buildTranscript({ rooms, msgs, title, format }) {
  const now = Date.now();
  const byId = new Map(msgs.map((m) => [m.id, m]));
  const who = (m) => (m.sender_kind === 'human' ? `${m.sender} (human)` : m.sender);
  const people = [...new Set(msgs.filter((m) => m.sender_kind !== 'system').map(who))];
  const multiRoom = rooms.length > 1;
  if (format === 'json') {
    return JSON.stringify({ title, exported_at: new Date(now).toISOString(), timezone: TZ, rooms, messages: msgs }, null, 2);
  }
  if (format === 'txt') {
    const head = [`${title}`, `Exported ${stamp(now)} (${TZ}) · ${msgs.length} messages`, `Participants: ${people.join(', ') || '—'}`, ''];
    const body = msgs.map((m) => {
      const reply = m.reply_to ? ` (reply to #${m.reply_to})` : '';
      const room = multiRoom ? ` ${m.room_id}` : '';
      return `[#${m.id}${room} ${stamp(m.created_at)}] ${who(m)}${reply}:\n${m.content}`;
    });
    return head.concat(body.join('\n\n')).join('\n') + '\n';
  }
  // markdown (default)
  const out = [`# ${title}`, '', `Exported ${stamp(now)} (${TZ}) · ${msgs.length} messages  `, `Participants: ${people.join(', ') || '—'}`];
  if (!multiRoom && rooms[0]?.topic) out.push(`Topic: ${rooms[0].topic}`);
  let lastDay = '', lastRoom = '';
  for (const m of msgs) {
    const p = stampParts(m.created_at);
    if (p.date !== lastDay) { out.push('', `## ${p.date}`); lastDay = p.date; lastRoom = ''; }
    if (multiRoom && m.room_id !== lastRoom) { out.push('', `#### ${m.room_id}`); lastRoom = m.room_id; }
    if (m.sender_kind === 'system') { out.push('', `_${p.time} · ${m.content}_`); continue; }
    out.push('', `**${who(m)}** · ${p.time} · #${m.id}`);
    if (m.reply_to) {
      const parent = byId.get(m.reply_to);
      const snip = parent ? `${parent.sender}: ${parent.content.replace(/\s+/g, ' ').slice(0, 100)}` : '';
      out.push(`> ↩ reply to #${m.reply_to}${snip ? ` — ${snip}` : ''}`);
    }
    out.push('', m.content);
  }
  return out.join('\n') + '\n';
}
function sendTranscript(res, { rooms, msgs, title, slug, format }) {
  const fmt = ['md', 'txt', 'json'].includes(format) ? format : 'md';
  const types = { md: 'text/markdown', txt: 'text/plain', json: 'application/json' };
  const p = stampParts(Date.now());
  const filename = `tropa_${slug}_${p.date}_${p.time.replace(':', '')}.${fmt}`;
  res.set('Content-Type', `${types[fmt]}; charset=utf-8`);
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buildTranscript({ rooms, msgs: msgs.map(rowToMessage), title, format: fmt }));
}
api.get('/rooms/:id/transcript', (req, res) => {
  try {
    const room = requireRoom(normalizeRoomId(req.params.id));
    const label = room.id === 'general' ? '#general' : `#${room.project}`;
    sendTranscript(res, { rooms: [room], msgs: q.allMsgsRoom.all(room.id), title: `TropaAI transcript — ${label}`,
      slug: room.id.replace(':', '-'), format: req.query.format });
  } catch (e) {
    if (e instanceof UserError) return res.status(400).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'internal error' });
  }
});
api.get('/transcript', (req, res) => {
  try {
    sendTranscript(res, { rooms: q.listRooms.all(), msgs: q.allMsgs.all(), title: 'TropaAI transcript — all rooms',
      slug: 'all-rooms', format: req.query.format });
  } catch (e) { console.error(e); res.status(500).json({ error: 'internal error' }); }
});

// ---------- text-to-speech (proxied to the local Kokoro container) ----------
let voiceCache = { at: 0, voices: null };
async function kokoroVoices() {
  if (voiceCache.voices && Date.now() - voiceCache.at < 60000) return voiceCache.voices;
  const r = await fetch(`${KOKORO_URL}/v1/audio/voices`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`kokoro voices: HTTP ${r.status}`);
  const data = await r.json();
  const list = Array.isArray(data) ? data : (data.voices || []);
  const voices = list.map((v) => (typeof v === 'string' ? v : v.name || v.id)).filter(Boolean);
  voiceCache = { at: Date.now(), voices };
  return voices;
}
api.get('/tts/status', async (req, res) => {
  try { const voices = await kokoroVoices(); res.json({ engine: 'kokoro', available: true, voices }); }
  catch (e) {
    voiceCache = { at: 0, voices: null };
    const timedOut = e?.name === 'TimeoutError' || /timeout|aborted/i.test(String(e?.message));
    const refused = /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(String(e?.message) + String(e?.cause?.code));
    const error = timedOut ? 'Kokoro is running but did not answer within 10s — it is probably still loading its model; try again in a minute'
      : refused ? 'Kokoro is not reachable — start it with `tropa tts start` (needs Docker), then check `tropa tts status`'
      : String(e?.message || e);
    res.json({ engine: 'kokoro', available: false, error });
  }
});
api.post('/tts', async (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: 'text is required' });
  const voice = /^[a-z]{2}_[a-z0-9_]+$/i.test(req.body?.voice || '') ? req.body.voice : 'af_heart';
  const speed = Math.min(Math.max(Number(req.body?.speed) || 1, 0.5), 2);
  try {
    const r = await fetch(`${KOKORO_URL}/v1/audio/speech`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'kokoro', input: text, voice, response_format: 'wav', speed }),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) return res.status(502).json({ error: `kokoro returned HTTP ${r.status}` });
    res.set('Content-Type', 'audio/wav');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(503).json({ error: `kokoro unavailable: ${e.message || e}` });
  }
});

api.get('/search', wrap((req) => {
  const term = String(req.query.q || '').trim();
  if (!term) return [];
  return q.search.all(`%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`, 200).map(rowToMessage);
}));
api.get('/agents', wrap(() => q.listAgents.all().map(agentView)));
api.post('/agents/register', wrap((req) => {
  const a = registerAgent({ name: req.body.agent || req.body.name, project: req.body.project, description: req.body.description });
  const u = applyProfile(a.name, { provider: req.body.provider, model: req.body.model }, 'agent') || a;
  broadcast({ type: 'agent', agent: agentView(u) });
  return agentView(u);
}));
// Edit from the monitor: { name?, provider?, model?, project?, description? }. Values set here win over
// anything agents report; clearing provider/model hands them back to automatic detection.
api.patch('/agents/:name', wrap((req) => {
  let a = q.getAgent.get(cleanName(req.params.name));
  if (!a) { const al = q.getAlias.get(cleanName(req.params.name)); if (al) a = q.getAgent.get(al.target); }
  if (!a) throw new UserError(`unknown agent "${req.params.name}"`);
  const b = req.body || {};
  if (b.name != null && cleanName(b.name) && cleanName(b.name) !== a.name) a = renameAgent(a.name, b.name);
  if (b.project !== undefined) {
    const proj = b.project ? slugify(b.project) : null;
    q.setProject.run(proj, a.name);
    if (proj) { ensureRoom(`project:${proj}`); if (q.getCursor.get(a.name, `project:${proj}`) == null) q.setCursor.run(a.name, `project:${proj}`, Math.max(0, q.maxId.get(`project:${proj}`).id - 20)); }
  }
  if (b.description !== undefined) q.setDescription.run(String(b.description || '').slice(0, 300), a.name);
  const u = applyProfile(a.name, { provider: b.provider, model: b.model }, 'manual') || q.getAgent.get(a.name);
  broadcast({ type: 'agent', agent: agentView(u) });
  return agentView(u);
}));
api.post('/agents/:name/rename', wrap((req) => agentView(renameAgent(req.params.name, req.body.new_name || req.body.name))));
// Remove an agent: delete it from the chat AND end it on the machine (close its tmux window, move agents/<name>/
// to agents/.removed/ so a team restart doesn't bring it back, update TEAM.md). A short tombstone stops a
// still-running CLI from re-registering itself through the tropa tool before its window is gone.
api.delete('/agents/:name', wrap((req) => removeAgentNow(req.params.name)));
function removeAgentNow(rawName) {
  const n = cleanName(rawName);
  if (!n) throw new UserError('agent name is required');
  let a = q.getAgent.get(n);
  if (!a) { const al = q.getAlias.get(n); if (al) a = q.getAgent.get(al.target); }
  const name = a?.name || n, low = name.toLowerCase();
  // which team runs it: its project, else any watcher that lists a window with that name
  let roomId = a?.project ? `project:${a.project}` : '';
  for (const [rid, w] of watchers) if (w.agents.some((x) => x.toLowerCase() === low)) { roomId = rid; break; }
  const w = roomId ? watchers.get(roomId) : null;
  const slug = roomId.startsWith('project:') ? roomId.slice('project:'.length) : '';
  removedAgents.set(low, Date.now() + REMOVED_TTL);
  if (roomId && String(wakeSettings(roomId).lead || '').toLowerCase() === low) setWakeSettings(roomId, { lead: '' });
  q.deleteAgent.run(name);
  broadcast({ type: 'agent_deleted', name });
  let stopped = 'none';
  if (slug && hostOnline()) {
    const job = { id: require('node:crypto').randomUUID(), type: 'remove_agent', room_id: roomId, slug, agent: name,
      tmux_session: w?.tmux || '', status: 'queued', log: [] };
    jobs.set(job.id, job);
    host.queue.push({ ...job, log: undefined });
    for (const f of [...host.waiters]) f();
    stopped = 'host';
  } else if (slug && watcherFor(roomId)) {
    pushEvent(roomId, { type: 'remove_agent', agent: name });
    stopped = 'watcher';
  }
  if (w) {   // drop it from the Team view now; the next watcher poll confirms
    w.agents = w.agents.filter((x) => x.toLowerCase() !== low);
    for (const k of Object.keys(w.panes)) if (k.toLowerCase() === low) delete w.panes[k];
    broadcastTeam(roomId);
  }
  if (roomId && stopped === 'none' && w) watcherSay(roomId, `🗑 @${name} was removed from the chat, but neither the host helper nor the watcher is running, so its tmux window and agents/${name}/ folder are still there.`);
  return { ok: true, agent: name, room_id: roomId || null, stopped };
}
api.get('/inbox', wrap((req) => inboxFor(resolveAgent(req.query.agent))));
api.post('/read', wrap((req) => {
  const a = resolveAgent(req.body.agent);
  const roomId = normalizeRoomId(req.body.room);
  requireRoom(roomId);
  const since = req.body.since_id != null ? Number(req.body.since_id) : (q.getCursor.get(a.name, roomId)?.last_read ?? 0);
  const msgs = q.msgsAfter.all(roomId, since, Math.min(Number(req.body.limit) || 50, 200)).map(rowToMessage);
  if (msgs.length) markRead(a.name, roomId, msgs[msgs.length - 1].id);
  return msgs;
}));
api.get('/wait', wrap(async (req, res) => {
  const a = resolveAgent(req.query.agent);
  const rooms = req.query.room ? [requireRoom(normalizeRoomId(req.query.room)).id] : agentRoomIds(a);
  const t = Math.min(Math.max(Number(req.query.timeout) || 45, 1), 110) * 1000;
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  const msgs = await waitForMessages(a, rooms, t, ac.signal);
  markAllRead(a, msgs);
  return msgs;
}));

// ---------- team: wake routing, live screens, approvals ----------
// The chat server decides who to wake. A watcher on the host (tropa's room_watcher.py) long-polls
// /api/watch/poll for wake/command events, types them into the agents' tmux windows,
// and streams each agent's screen back here for the monitor's Team view.
db.exec(`CREATE TABLE IF NOT EXISTS room_wake (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  settings TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT 0)`);
const WAKE_DEFAULTS = { lead: '', wake: 'auto', wake_rules: 'smart', max_wakes_per_agent_per_hour: 0,
  cooldown_seconds: 20, debounce_seconds: 2, history_limit: 20, auto_approve: false,
  // new teammates asked for by the lead (request_agent): 'ask' the human, add them 'auto'matically, or 'off'.
  // In 'auto', at most auto_agents_per_hour are added on their own; past that, the request waits for the human.
  team_growth: 'ask', auto_agents_per_hour: 2,
  // the lead removing teammates (remove_agents): done at once ('auto'), only with the human's OK ('ask'), or not allowed ('off')
  team_shrink: 'auto',
  // "needs attention" limits in minutes (0 = don't flag): quiet in Doing, waiting in Review, on an approval prompt, Blocked, idle with ready work
  attention: { doing_quiet: 15, review_wait: 45, approval_wait: 5, blocked_wait: 60, idle_ready: 20 } };
const EVERYONE = new Set(['all', 'here', 'team', 'everyone']);
const WATCHER = 'watcher';
const WATCH_TTL = 45000;
const qw = {
  get: db.prepare('SELECT * FROM room_wake WHERE room_id = ?'),
  put: db.prepare(`INSERT INTO room_wake (room_id, settings, updated_at) VALUES (?,?,?)
    ON CONFLICT(room_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`),
};
function wakeSettings(roomId) {
  const r = qw.get.get(roomId);
  let s = {};
  try { s = JSON.parse(r?.settings || '{}'); } catch {}
  return { ...WAKE_DEFAULTS, ...s, updated_at: r?.updated_at || 0 };
}
function cleanWake(patch) {
  const out = {};
  if ('lead' in patch) out.lead = cleanName(patch.lead || '');
  if ('auto_approve' in patch) out.auto_approve = patch.auto_approve === true || patch.auto_approve === 'true';
  if ('team_shrink' in patch) {
    if (!['ask', 'auto', 'off'].includes(patch.team_shrink)) throw new UserError('team_shrink must be "ask", "auto" or "off"');
    out.team_shrink = patch.team_shrink;
  }
  if ('team_growth' in patch) {
    if (!['ask', 'auto', 'off'].includes(patch.team_growth)) throw new UserError('team_growth must be "ask", "auto" or "off"');
    out.team_growth = patch.team_growth;
  }
  if ('wake' in patch) {
    if (!['auto', 'paused'].includes(patch.wake)) throw new UserError('wake must be "auto" or "paused"');
    out.wake = patch.wake;
  }
  if ('wake_rules' in patch) {
    if (!['smart', 'all'].includes(patch.wake_rules)) throw new UserError('wake_rules must be "smart" or "all"');
    out.wake_rules = patch.wake_rules;
  }
  if ('attention' in patch) {
    const a = patch.attention && typeof patch.attention === 'object' ? patch.attention : {};
    out.attention = { ...WAKE_DEFAULTS.attention };
    for (const k of Object.keys(WAKE_DEFAULTS.attention)) {
      if (!(k in a)) continue;
      const n = Number(a[k]);
      if (!Number.isFinite(n) || n < 0 || n > 1440) throw new UserError(`attention.${k} must be minutes between 0 and 1440`);
      out.attention[k] = Math.round(n);
    }
  }
  for (const [k, lo, hi] of [['max_wakes_per_agent_per_hour', 0, 1000], ['cooldown_seconds', 0, 3600], ['auto_agents_per_hour', 0, 20],
    ['debounce_seconds', 0, 60], ['history_limit', 1, 200]]) {
    if (!(k in patch)) continue;
    const n = Number(patch[k]);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new UserError(`${k} must be between ${lo} and ${hi}`);
    out[k] = n;
  }
  return out;
}
function setWakeSettings(roomId, patch) {
  const cur = wakeSettings(roomId); delete cur.updated_at;
  const next = { ...cur, ...cleanWake(patch) };
  const now = Date.now();
  qw.put.run(roomId, JSON.stringify(next), now);
  const settings = { ...next, updated_at: now };
  broadcast({ type: 'wake_settings', room_id: roomId, settings });
  return settings;
}

const watchers = new Map();   // roomId -> { agents, tmux, seen, queue, waiters, panes }
const wakeState = new Map();  // roomId \0 agent(lower) -> { pending, timer, last, history, capped }
function watcherRecord(roomId) {
  let w = watchers.get(roomId);
  if (!w) { w = { agents: [], tmux: '', seen: 0, queue: [], waiters: new Set(), panes: {} }; watchers.set(roomId, w); }
  return w;
}
function watcherFor(roomId) {
  const w = watchers.get(roomId);
  return w && Date.now() - w.seen < WATCH_TTL ? w : null;
}
function teamView(roomId) {
  const w = watcherFor(roomId);
  return { room_id: roomId, watching: !!w, tmux_session: w?.tmux || '', agents: w?.agents || [],
    panes: w ? w.panes : {}, settings: wakeSettings(roomId), caps: w?.caps || [] };
}
function broadcastTeam(roomId) { broadcast({ type: 'team', team: teamView(roomId) }); }
function pushEvent(roomId, ev) {
  const w = watcherRecord(roomId);
  w.queue.push({ ...ev, at: Date.now() });
  if (w.queue.length > 500) w.queue.splice(0, w.queue.length - 500);
  for (const f of [...w.waiters]) f();
}
function watcherSay(roomId, content) {
  try { return postMessage({ room: roomId, sender: WATCHER, kind: 'system', content }); } catch (e) { console.error(e); }
}
function wakeText(roomId, agent, reason, s) {
  return `[tropa] ${reason} Read your unread messages in ${roomId} (tropa read_messages, agent "${agent}", limit ${s.history_limit}). ` +
    'If it assigns you work: post a one-line plan, do it, and finish with a message that @mentions who is next (result, blocker or done). If it doesn\'t concern you, stay silent.';
}
/** Who a message wakes: @all → everyone but the sender; @name → those agents; human with no
 *  agent mention → the lead (if running) else everyone; agent with no mention → nobody. */
function pickTargets(s, m, agents) {
  const byLower = new Map(agents.map((a) => [a.toLowerCase(), a]));
  const sender = String(m.sender).toLowerCase();
  const mentions = m.mentions || [];
  const others = agents.filter((a) => a.toLowerCase() !== sender);
  if (s.wake_rules === 'all' || mentions.some((x) => EVERYONE.has(x))) return others;
  const named = [...new Set(mentions.map((x) => byLower.get(x)).filter((a) => a && a.toLowerCase() !== sender))];
  if (named.length) return named;
  if (m.sender_kind === 'human') {
    const lead = byLower.get(String(s.lead || '').toLowerCase());
    return lead ? [lead] : others;
  }
  return [];
}
function wakeEntry(roomId, agent) {
  const k = `${roomId}\0${agent.toLowerCase()}`;
  let st = wakeState.get(k);
  if (!st) { st = { pending: [], timer: null, last: 0, history: [], capped: false }; wakeState.set(k, st); }
  return st;
}
function scheduleWake(roomId, agent, msg) {
  const st = wakeEntry(roomId, agent);
  if (msg) st.pending.push(msg);
  if (st.timer) return;
  const s = wakeSettings(roomId);
  const due = Math.max(Date.now() + s.debounce_seconds * 1000, st.last + s.cooldown_seconds * 1000);
  st.timer = setTimeout(() => fireWake(roomId, agent), Math.max(0, due - Date.now()));
}
function fireWake(roomId, agent, { manual = false, reason } = {}) {
  const st = wakeEntry(roomId, agent);
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }
  const s = wakeSettings(roomId);
  const now = Date.now();
  st.history = st.history.filter((t) => now - t < 3600e3);
  const cap = Number(s.max_wakes_per_agent_per_hour) || 0;
  if (!manual && cap && st.history.length >= cap) {
    if (!st.capped) watcherSay(roomId, `@${HUMAN_NAME} \`${agent}\` hit the wake limit (${cap}/hour); holding its wake-ups.`);
    st.capped = true;
    st.timer = setTimeout(() => fireWake(roomId, agent), 60e3);
    return false;
  }
  st.capped = false;
  const msgs = st.pending; st.pending = [];
  if (!manual && !msgs.length) return false;
  let why = reason;
  if (!why) {
    const ids = msgs.map((m) => m.id).sort((a, b) => a - b);
    const who = [...new Set(msgs.map((m) => m.sender))].sort().join(', ');
    why = `New message(s) #${ids[0]}${ids.length > 1 ? `-#${ids[ids.length - 1]}` : ''} from ${who}.`;
  }
  st.last = now; st.history.push(now);
  pushEvent(roomId, { type: 'wake', agent, reason: why, message_ids: msgs.map((m) => m.id), text: wakeText(roomId, agent, why, s) });
  return true;
}
const CMD_RE = /@watcher\s+(approve|yes|allow|always|deny|no|reject)\s+@?([A-Za-z0-9._-]+)/gi;
const CMD_ACT = { approve: 'yes', yes: 'yes', allow: 'yes', always: 'always', deny: 'no', no: 'no', reject: 'no' };
bus.on('message', (m) => {
  if (m.sender_kind === 'system') return;
  if (m.sender_kind === 'human' && /@tropa\b/i.test(m.content) && (shareCommand(m) || agentCommand(m))) return;
  if (m.sender_kind === 'human' && removalCommand(m)) return;   // "remove x and y from the room" → a confirmation card   // not a message for the agents
  if (m.sender_kind === 'human') { try { agentReqReply(m); } catch (e) { console.error(e); } }   // "approve backend2" (still passed on to the agents)
  const w = watcherFor(m.room_id);
  if (!w) return;
  if (m.sender_kind === 'human') {
    const cmds = [...String(m.content).matchAll(CMD_RE)];
    if (cmds.length) {
      for (const c of cmds) pushEvent(m.room_id, { type: 'command', action: CMD_ACT[c[1].toLowerCase()], agent: c[2], message_id: m.id });
      return;   // a command is not a message for the agents
    }
  }
  const s = wakeSettings(m.room_id);
  if (s.wake === 'paused') return;
  for (const a of pickTargets(s, m, w.agents)) scheduleWake(m.room_id, a, m);
});
const roomOf = (req) => requireRoom(normalizeRoomId(req.params.id)).id;
const pickWakeKeys = (o) => Object.fromEntries(Object.keys(WAKE_DEFAULTS).filter((k) => o && k in o).map((k) => [k, o[k]]));

api.get('/rooms/:id/team', wrap((req) => teamView(roomOf(req))));
api.get('/rooms/:id/wake', wrap((req) => wakeSettings(roomOf(req))));
api.patch('/rooms/:id/wake', wrap((req) => setWakeSettings(roomOf(req), req.body || {})));
api.post('/rooms/:id/wake', wrap((req) => {
  const roomId = roomOf(req);
  const w = watcherFor(roomId);
  if (!w) throw new UserError('no watcher is running for this room (start agents with tropa)');
  const byLower = new Map(w.agents.map((a) => [a.toLowerCase(), a]));
  const want = Array.isArray(req.body.agents) && req.body.agents.length ? req.body.agents : w.agents;
  const reason = String(req.body.reason || `${HUMAN_NAME} asked you to check the room.`).slice(0, 300);
  const woke = [];
  for (const n of want) { const a = byLower.get(String(n).toLowerCase()); if (a && fireWake(roomId, a, { manual: true, reason })) woke.push(a); }
  return { woke };
}));
// switch a running agent's model: the watcher applies it live (Claude: /model) or restarts the agent, resuming its session
api.post('/rooms/:id/agents/:name/model', wrap((req) => {
  const roomId = roomOf(req);
  const w = watcherFor(roomId);
  if (!w) throw new UserError('no watcher is running for this room (start the team with tropa)');
  const agent = w.agents.find((n) => n.toLowerCase() === cleanName(req.params.name).toLowerCase());
  if (!agent) throw new UserError(`@${req.params.name} isn't running in this team`);
  const model = String(req.body?.model || '').trim();
  if (model && !/^[A-Za-z0-9._:/@-]{1,100}$/.test(model)) throw new UserError('invalid model id');
  const when = req.body?.when === 'now' ? 'now' : 'idle';
  pushEvent(roomId, { type: 'set_model', agent, model, when });
  const u = q.getAgent.get(agent) && applyProfile(agent, { model: model || undefined }, 'manual');
  if (u) broadcast({ type: 'agent', agent: agentView(u) });
  return { ok: true, agent, model, when };
}));
// restart an agent (also one whose CLI died): the watcher relaunches its tmux window, resuming its session if enabled
api.post('/rooms/:id/agents/:name/restart', wrap((req) => {
  const roomId = roomOf(req);
  const w = watcherFor(roomId);
  if (!w) throw new UserError('no watcher is running for this room (start the team with tropa)');
  const name = cleanName(req.params.name);
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) throw new UserError('invalid agent name');
  const agent = w.agents.find((n) => n.toLowerCase() === name.toLowerCase()) || name;   // the watcher checks agents/<name>/agent.json
  pushEvent(roomId, { type: 'restart', agent });
  return { ok: true, agent };
}));
api.post('/rooms/:id/approve', wrap((req) => {
  const roomId = roomOf(req);
  if (!watcherFor(roomId)) throw new UserError('no watcher is running for this room');
  const action = CMD_ACT[String(req.body.action || '').toLowerCase()] || req.body.action;
  if (!['yes', 'always', 'no'].includes(action)) throw new UserError('action must be yes, always or no');
  const agent = cleanName(req.body.agent);
  if (!agent) throw new UserError('agent is required');
  pushEvent(roomId, { type: 'command', action, agent });
  return { ok: true };
}));

// type into an agent's terminal from the Team view: answer a menu or question its CLI is showing.
// keys are tmux key names from a short list; text is typed literally (then Enter, unless enter is false)
const TERM_KEYS = new Set(['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab', 'BTab', 'Space', 'BSpace', 'C-c',
  ...'0123456789'.split(''), 'y', 'n']);
api.post('/rooms/:id/agents/:name/keys', wrap((req) => {
  const roomId = roomOf(req);
  const w = watcherFor(roomId);
  if (!w) throw new UserError('no watcher is running for this room (start the team with tropa)');
  if (!(w.caps || []).includes('keys')) throw new UserError("this project's watcher is older than terminal input: run tropa update in the project folder");
  const name = cleanName(req.params.name);
  const agent = w.agents.find((n) => n.toLowerCase() === String(name).toLowerCase());
  if (!agent) throw new UserError(`@${req.params.name} isn't running in this team`);
  const keys = Array.isArray(req.body.keys) ? req.body.keys.map(String) : [];
  if (keys.length > 20 || keys.some((k) => !TERM_KEYS.has(k))) throw new UserError(`keys must be some of: ${[...TERM_KEYS].join(' ')}`);
  const text = typeof req.body.text === 'string' ? req.body.text : '';
  if (text.length > 4000) throw new UserError('text is too long (4000 characters at most)');
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new UserError('text has control characters: use the key buttons for those');
  if (!keys.length && !text) throw new UserError('nothing to send');
  pushEvent(roomId, { type: 'keys', agent, keys, text, enter: req.body.enter !== false });
  return { ok: true, agent };
}));

// watcher endpoints
api.post('/watch/poll', wrap(async (req, res) => {
  const roomId = normalizeRoomId(req.body.room);
  if (deletedProject(roomId)) return { events: [{ type: 'stop', reason: 'the project was deleted in TropaAI' }], settings: req.body.settings || {} };
  ensureRoom(roomId);
  const w = watcherRecord(roomId);
  const wasOn = !!watcherFor(roomId);
  w.seen = Date.now();
  w.caps = Array.isArray(req.body.caps) ? req.body.caps.map(String).slice(0, 20) : [];
  const raw = (Array.isArray(req.body.agents) ? req.body.agents : []).map(cleanName).filter((n) => n && !removedAgent(n));
  for (const [k, r] of Object.entries(w.renames || {})) {   // a rename on its way: done once the old window is gone
    if (!raw.includes(r.old) || Date.now() - r.at > 6 * 3600e3) delete w.renames[k];
    else if (Date.now() - (r.sent || r.at) > 10 * 60e3 && w.caps.includes('rename_agent')) {   // a restarted watcher forgets it: remind it
      r.sent = Date.now(); pushEvent(roomId, { type: 'rename_agent', agent: r.old, new_name: r.new, when: 'idle' });
    }
  }
  const agents = raw.map((x) => shownName(w, x));
  const changed = agents.join() !== w.agents.join() || String(req.body.tmux_session || '') !== w.tmux;
  w.agents = agents; w.tmux = String(req.body.tmux_session || '').slice(0, 60);
  for (const k of Object.keys(w.panes)) if (!agents.includes(k)) delete w.panes[k];
  // settings: seed from the project the first time; afterwards a local edit is pushed explicitly
  const local = pickWakeKeys(req.body.settings);
  if (Object.keys(local).length && (!qw.get.get(roomId) || req.body.settings_changed)) setWakeSettings(roomId, local);
  if (!wasOn || changed) broadcastTeam(roomId);
  const t = Math.min(Math.max(Number(req.body.timeout) || 0, 0), 25) * 1000;
  if (!w.queue.length && t) {
    await new Promise((resolve) => {
      const done = () => { w.waiters.delete(done); clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, t);
      w.waiters.add(done);
      res.on('close', done);
    });
  }
  w.seen = Date.now();
  // events name agents by their (new) name; until a rename reaches the machine its window still has the old one
  const back = new Map(Object.values(w.renames || {}).map((r) => [r.new.toLowerCase(), r.old]));
  const events = w.queue.splice(0).map((ev) => (ev.type !== 'rename_agent' && ev.agent && back.has(String(ev.agent).toLowerCase()) ? { ...ev, agent: back.get(String(ev.agent).toLowerCase()) } : ev));
  return { events, settings: wakeSettings(roomId), human: HUMAN_NAME,
    files: qa.pendingSync.all(roomId).map(attView), uploads: qa.pendingUpload.all(roomId).map(attView) };
}));
api.post('/watch/panes', wrap((req) => {
  const roomId = normalizeRoomId(req.body.room);
  const w = watcherRecord(roomId);
  w.seen = Date.now();
  const panes = req.body.panes && typeof req.body.panes === 'object' ? req.body.panes : {};
  for (const [name, p] of Object.entries(panes)) {
    const n = cleanName(name) && shownName(w, cleanName(name));
    if (!n || !p) continue;
    w.approvalSince ||= {};
    if (p.state === 'approval') w.approvalSince[n] ||= Date.now(); else delete w.approvalSince[n];
    w.panes[n] = { text: String(p.text || '').slice(-8000), state: ['working', 'idle', 'approval', 'stopped'].includes(p.state) ? p.state : 'idle',
      prompt: String(p.prompt || '').slice(0, 300), changed_at: Number(p.changed_at) || Date.now(), at: Date.now() };
  }
  broadcast({ type: 'panes', room_id: roomId, panes: w.panes });
  return { ok: true };
}));
api.post('/watch/say', wrap((req) => {
  const roomId = normalizeRoomId(req.body.room);
  const m = watcherSay(roomId, String(req.body.content || '').slice(0, MAX_CONTENT));
  return { id: m?.id };
}));

// ---------- docs viewer: the watcher lists the project's docs folder and reads files on request ----------
// The server never sees the project folder (it may run in Docker). The watcher posts the folder's file
// list (/watch/docs) and answers doc_read events with the file's bytes; files are cached by mtime.
const DOC_WAIT = 20000, DOC_MAX_FILES = 3000, DOC_CACHE_MAX = 64 * 1024 * 1024;
const docReads = new Map();   // request id -> { resolve, reject, timer }
const docCache = new Map();   // roomId \0 path -> { mtime, size, buf }
let docCacheBytes = 0;
function docsView(roomId) {
  const w = watcherFor(roomId);
  const d = watchers.get(roomId)?.docs || {};
  return { room_id: roomId, watching: !!w, listed: !!(w && d.at), dir: d.dir || '', tree: w ? d.tree || [] : [], error: d.error || '', truncated: !!d.truncated, at: d.at || 0 };
}
function dropDocCache(key) {
  const c = docCache.get(key);
  if (c) { docCacheBytes -= c.buf.length; docCache.delete(key); }
}
function cacheDoc(key, entry, buf) {
  dropDocCache(key);
  if (buf.length > DOC_CACHE_MAX / 4) return { ...entry, buf };
  for (const k of docCache.keys()) { if (docCacheBytes + buf.length <= DOC_CACHE_MAX) break; dropDocCache(k); }   // oldest first
  const c = { mtime: entry.mtime, size: entry.size, buf };
  docCache.set(key, c); docCacheBytes += buf.length;
  return c;
}
function readDocViaWatcher(roomId, rel) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { docReads.delete(id); reject(Object.assign(new Error("the team's watcher didn't send the file in time"), { status: 504 })); }, DOC_WAIT);
    docReads.set(id, { resolve, reject, timer });
    pushEvent(roomId, { type: 'doc_read', id, path: rel });
  });
}
function cleanDocDir(d) {
  const s = String(d || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\.\//, '');
  if (!s || s === '.' || s.length > 200 || s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.split('/').some((x) => x === '..' || x === '' || x.startsWith('.')))
    throw new UserError('use a folder inside the project, e.g. docs or documentation/specs (no .., no hidden folders)');
  return s;
}
api.post('/watch/docs', wrap((req) => {
  const roomId = normalizeRoomId(req.body.room);
  const w = watcherRecord(roomId);
  w.seen = Date.now();
  const tree = (Array.isArray(req.body.tree) ? req.body.tree : []).slice(0, DOC_MAX_FILES)
    .map((f) => ({ path: String(f?.path || '').slice(0, 500), size: Math.max(0, Number(f?.size) || 0), mtime: Number(f?.mtime) || 0 }))
    .filter((f) => f.path && !f.path.split('/').some((x) => x === '..' || x === ''));
  w.docs = { dir: String(req.body.dir || '').slice(0, 200), tree, error: String(req.body.error || '').slice(0, 300),
    truncated: !!req.body.truncated || (Array.isArray(req.body.tree) && req.body.tree.length > DOC_MAX_FILES), at: Date.now() };
  const live = new Map(tree.map((f) => [`${roomId}\0${f.path}`, f]));
  for (const [k, c] of [...docCache]) if (k.startsWith(roomId + '\0') && (!live.has(k) || live.get(k).mtime !== c.mtime || live.get(k).size !== c.size)) dropDocCache(k);
  broadcast({ type: 'docs', docs: docsView(roomId) });
  return { ok: true };
}));
api.put('/watch/docs/:id', express.raw({ type: () => true, limit: MAX_FILE }), wrap((req) => {
  const r = docReads.get(req.params.id);
  if (!r) throw new UserError('no such request (it may have timed out)');
  docReads.delete(req.params.id); clearTimeout(r.timer);
  r.resolve(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
  return { ok: true };
}));
api.post('/watch/docs/:id/failed', wrap((req) => {
  const r = docReads.get(req.params.id);
  if (r) { docReads.delete(req.params.id); clearTimeout(r.timer); r.reject(Object.assign(new Error(String(req.body.error || 'could not read the file').slice(0, 300)), { status: 422 })); }
  return { ok: true };
}));
api.get('/rooms/:id/docs', wrap((req) => docsView(roomOf(req))));
// tell open Docs views when a team stops (its watcher goes quiet), so they don't show a stale list
setInterval(() => {
  for (const [roomId, w] of watchers) if (w.docs && !w.docs.gone && !watcherFor(roomId)) { w.docs.gone = true; broadcast({ type: 'docs', docs: docsView(roomId) }); }
}, 15000).unref();
api.get('/rooms/:id/docs/file', async (req, res) => {
  try {
    const roomId = roomOf(req);
    const v = docsView(roomId);
    if (!v.watching) return res.status(409).json({ error: "the team isn't running, so its docs folder can't be read (start it with tropa panel → 3)" });
    const rel = String(req.query.path || '');
    const entry = v.tree.find((f) => f.path === rel);
    if (!entry) return res.status(404).json({ error: `${rel || 'that file'} isn't in the docs folder` });
    const key = `${roomId}\0${rel}`;
    let c = docCache.get(key);
    if (!c || c.mtime !== entry.mtime || c.size !== entry.size) c = cacheDoc(key, entry, await readDocViaWatcher(roomId, rel));
    const mime = mimeFor(rel);
    res.set({
      'Content-Type': /^text\//.test(mime) || mime === 'application/json' ? `${mime}; charset=utf-8` : mime,
      'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${cleanFileName(rel).replace(/"/g, '')}"`,
      'X-Content-Type-Options': 'nosniff',
      // project files are untrusted content: no scripts, forms or same-origin access when opened directly
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; font-src data:; media-src 'self'; sandbox",
      'Cache-Control': 'no-store',
    });
    res.end(c.buf);
  } catch (e) {
    res.status(e.status || (e instanceof UserError ? 400 : 502)).json({ error: e.message });
  }
});
api.post('/rooms/:id/docs/dir', wrap((req) => {
  const roomId = roomOf(req);
  if (!watcherFor(roomId)) throw new UserError("the team isn't running; change docs_dir in .agent_sync/settings.json instead");
  const dir = cleanDocDir(req.body.dir);
  pushEvent(roomId, { type: 'set_docs_dir', dir });
  return { ok: true, dir };
}));


// ---------- files: upload (human), share (agent), download, watcher sync ----------
function shareFile({ room, agent, path: p, content, reply_to }) {
  const roomId = normalizeRoomId(room);
  requireRoom(roomId);
  const rel = cleanProjectPath(p);
  const name = cleanFileName(rel);
  const info = qa.insert.run(roomId, null, name, mimeFor(name), 0, '', rel, agent, 'agent', 0, 1, Date.now());
  const id = Number(info.lastInsertRowid);
  const msg = postMessage({ room: roomId, sender: agent, kind: 'agent', content: content || `📎 ${name}`, reply_to, attachments: [id] });
  pushEvent(roomId, { type: 'files' });   // wake the watcher so it uploads now
  return msg;
}
const rawBody = express.raw({ type: () => true, limit: MAX_FILE });
api.post('/rooms/:id/files', rawBody, wrap((req) => {
  const roomId = normalizeRoomId(req.params.id);
  ensureRoom(roomId);
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!buf.length) throw new UserError('empty file');
  const name = cleanFileName(req.query.name);
  const sender = cleanName(req.query.sender) || HUMAN_NAME;
  const info = qa.insert.run(roomId, null, name, mimeFor(name), buf.length, '', 'pending', sender, 'human', 0, 0, Date.now());
  const id = Number(info.lastInsertRowid);
  qa.setPath.run(`${ATT_DIR}/${id}-${name}`, id);
  storeBlob(id, buf, name);
  return attView(qa.get.get(id));
}));
api.get('/rooms/:id/files', wrap((req) => {
  const roomId = roomOf(req);
  if (req.query.pending) return qa.pendingSync.all(roomId).map(attView);
  return qa.forRoom.all(roomId, Math.min(Number(req.query.limit) || 200, 1000)).map(attView);
}));
api.post('/rooms/:id/share', wrap((req) => {
  const a = resolveAgent(req.body.agent);
  return shareFile({ room: req.params.id, agent: a.name, path: req.body.path, content: req.body.content, reply_to: req.body.reply_to });
}));
const INLINE = /^(image\/(png|jpeg|gif|webp|avif|svg\+xml)|application\/pdf|text\/(plain|markdown|csv|html|css|yaml)|application\/json|video\/|audio\/)/;
api.get('/files/:id', (req, res) => {
  const a = qa.get.get(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'not found' });
  if (!a.stored) return res.status(409).json({ error: a.error || 'not uploaded yet' });
  const inline = !req.query.download && INLINE.test(a.mime);
  res.set({
    'Content-Type': /^text\//.test(a.mime) || a.mime === 'application/json' ? `${a.mime}; charset=utf-8` : a.mime,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${a.name.replace(/"/g, '')}"`,
    'X-Content-Type-Options': 'nosniff',
    // shared files are untrusted: render without scripts, forms or same-origin access
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; font-src data:; media-src 'self'; sandbox",
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
  res.sendFile(path.join(FILES_DIR, String(a.id)));
});
function updatedAttachment(id) {
  const a = attView(qa.get.get(id));
  if (a) broadcast({ type: 'attachment', attachment: a });
  return a;
}
api.put('/watch/files/:id', rawBody, wrap((req) => {
  const a = qa.get.get(Number(req.params.id));
  if (!a) throw new UserError('not found');
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  storeBlob(a.id, buf, a.name);
  qa.synced.run(a.id);
  return updatedAttachment(a.id);
}));
api.post('/watch/files/:id/synced', wrap((req) => { qa.synced.run(Number(req.params.id)); return updatedAttachment(Number(req.params.id)); }));
api.post('/watch/files/:id/failed', wrap((req) => {
  qa.failed.run(String(req.body.error || 'failed').slice(0, 300), Number(req.params.id));
  const a = updatedAttachment(Number(req.params.id));
  if (a && a.uploader_kind === 'agent') watcherSay(a.room_id, `@${a.uploader} couldn't share \`${a.path}\`: ${a.error}`);
  return a;
}));

// ---------- host helper: creates projects and starts teams on the machine ----------
const host = { seen: 0, info: {}, queue: [], waiters: new Set() };
const jobs = new Map();
const HOST_TTL = 45000;
const hostOnline = () => Date.now() - host.seen < HOST_TTL;
const CLI_TOOLS = ['claude', 'opencode', 'qwen', 'codex', 'gemini'];
const KEY_PROVIDERS = { openrouter: 'OpenRouter', gemini: 'Gemini' };
const RESERVED = new Set(['controlcenter', 'watcher', 'tropa', 'all', 'here', 'team', 'everyone', 'system']);
/** What the host reports about API keys: masked values and where they come from, never a key. */
function sanitizeKeys(k, orInfo) {
  k = k && typeof k === 'object' ? k : {};
  const one = (o) => ({ ready: !!o?.ready, source: ['env', 'file', 'project'].includes(o?.source) ? o.source : '',
    masked: String(o?.masked || '').slice(0, 40), error: String(o?.error || '').slice(0, 300) });
  const out = { openrouter: one(k.openrouter || orInfo), gemini: one(k.gemini), projects: {} };
  for (const [slug, v] of Object.entries(k.projects && typeof k.projects === 'object' ? k.projects : {}).slice(0, 500)) {
    if (!/^[a-z0-9._-]{1,60}$/.test(slug) || !v || typeof v !== 'object') continue;
    out.projects[slug] = Object.fromEntries(Object.keys(KEY_PROVIDERS).filter((p) => v[p]).map((p) => [p, String(v[p]).slice(0, 40)]));
  }
  return out;
}
api.get('/host', wrap(() => ({ connected: hostOnline(), ...host.info, human: HUMAN_NAME })));
api.post('/host/poll', wrap(async (req, res) => {
  const wasOn = hostOnline();
  host.seen = Date.now();
  host.info = { projects_dir: String(req.body.projects_dir || ''), home: String(req.body.home || ''), version: String(req.body.version || ''),
    clis: Array.isArray(req.body.clis) ? req.body.clis.map(String).slice(0, 10) : [],
    models: Object.fromEntries(CLI_TOOLS.map((t) => [t, (Array.isArray(req.body.models?.[t]) ? req.body.models[t] : [])
      .map((m) => (typeof m === 'string' ? { id: m, label: '' } : { id: String(m?.id || ''), label: String(m?.label || '').slice(0, 120) }))
      .filter((m) => /^[A-Za-z0-9._:/@-]{1,100}$/.test(m.id)).slice(0, 1500)])),   // room for OpenRouter's catalog
    openrouter: !!req.body.openrouter,
    openrouter_info: (() => { const o = req.body.openrouter_info || {};
      return { ready: !!o.ready, source: ['env', 'file'].includes(o.source) ? o.source : '', masked: String(o.masked || '').slice(0, 40),
        error: String(o.error || '').slice(0, 300) }; })(),
    git: String(req.body.git || '').slice(0, 80), git_hint: String(req.body.git_hint || '').slice(0, 120),
    design_systems: (Array.isArray(req.body.design_systems) ? req.body.design_systems : []).slice(0, 60)
      .filter((d) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(d?.id || '')))
      .map((d) => ({ id: String(d.id), name: String(d.name || d.id).slice(0, 60), summary: String(d.summary || '').slice(0, 300),
        best_for: String(d.best_for || '').slice(0, 300), docs: /^https:\/\//.test(String(d.docs || '')) ? String(d.docs).slice(0, 300) : '',
        guidance: String(d.guidance || '').slice(0, 12000),
        // preview values become CSS custom properties: allow colours, lengths and font lists only
        preview: Object.fromEntries(Object.entries(d.preview || {}).filter(([k, v]) => /^[a-z-]{1,30}$/.test(k) &&
          /^[#\w\s,.'"()%-]{1,120}$/.test(String(v)) && !/url\(|expression|[;{}<>\\]/i.test(String(v))).map(([k, v]) => [k, String(v)])) })),
    tools: (Array.isArray(req.body.tools) ? req.body.tools : []).slice(0, 50).filter((t) => /^[a-z0-9_-]{1,40}$/.test(String(t?.id || '')))
      .map((t) => ({ id: String(t.id), name: String(t.name || t.id).slice(0, 60), summary: String(t.summary || '').slice(0, 200),
        docs: /^https:\/\//.test(String(t.docs || '')) ? String(t.docs).slice(0, 300) : '', token_env: String(t.token_env || '').slice(0, 60), token_set: !!t.token_set,
        params: (Array.isArray(t.params) ? t.params : []).slice(0, 10).map((p) => ({ key: String(p.key || '').slice(0, 40), label: String(p.label || p.key || '').slice(0, 60),
          hint: String(p.hint || '').slice(0, 160), type: p.type === 'bool' ? 'bool' : 'text', default: p.type === 'bool' ? !!p.default : String(p.default ?? '').slice(0, 200) })) })),
    folders: (Array.isArray(req.body.folders) ? req.body.folders : []).slice(0, 500)
      .filter((f) => /^[A-Za-z0-9._-]{1,60}$/.test(String(f?.name || '')))
      .map((f) => ({ name: String(f.name), kit: !!f.kit, git: !!f.git, slug: slugify(f.slug || f.name) })),
    elsewhere: (Array.isArray(req.body.elsewhere) ? req.body.elsewhere : []).slice(0, 200)
      .filter((f) => typeof f?.path === 'string' && f.path.length < 500 && /^[^\0]+$/.test(f.path))
      .map((f) => ({ name: String(f.name || '').slice(0, 80), path: String(f.path), display: String(f.display || f.path).slice(0, 500), kit: !!f.kit, git: !!f.git, slug: slugify(f.slug || f.name) })),
    keys: sanitizeKeys(req.body.keys, req.body.openrouter_info),
    usage: !!req.body.usage,
    ngrok: { installed: !!req.body.ngrok?.installed, authed: !!req.body.ngrok?.authed, version: String(req.body.ngrok?.version || '').slice(0, 40) },
    claude: { installed: !!req.body.claude?.installed, version: String(req.body.claude?.version || '').slice(0, 60), chat: !!req.body.claude?.chat,
      signed_in: req.body.claude?.signed_in === true } };
  let stopShares = [];
  if (Array.isArray(req.body.shares)) {   // what the host really has running
    const live = new Set(req.body.shares.map(Number));
    for (const s of shares.values()) if (['online', 'stopping'].includes(s.status) && !live.has(s.id)) {
      s.status = 'stopped'; shareChanged(s); shareNote(s.room_id, `⏹ Share #${s.id} (port ${s.port}) is no longer running (the host helper restarted).`);
    }
    stopShares = [...live].filter((id) => !shares.has(id) || !['starting', 'online', 'stopping'].includes(shares.get(id).status));
  }
  // tell the monitor when the host comes online or what it offers changes (e.g. an OpenRouter key was just added)
  const sig = JSON.stringify([host.info.openrouter_info, host.info.keys, host.info.claude, Object.values(host.info.models).map((m) => m.length), host.info.clis]);
  if (!wasOn || sig !== host.sig) { host.sig = sig; broadcast({ type: 'host', host: { connected: true, ...host.info } }); }
  const t = Math.min(Math.max(Number(req.body.timeout) || 0, 0), 25) * 1000;
  if (!host.queue.length && t) {
    await new Promise((resolve) => {
      const done = () => { host.waiters.delete(done); clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, t);
      host.waiters.add(done);
      res.on('close', done);
    });
  }
  host.seen = Date.now();
  return { jobs: host.queue.splice(0), stop_shares: stopShares };
}));
// OpenRouter key from the monitor: passed to the host helper (which checks it with OpenRouter and saves it in
// ~/.config/tropa/openrouter.key, mode 600). The server only relays it: never stored, logged or broadcast.
const secretJobs = new Map();   // id -> { resolve, timer }

// ---------- New project by chat: Claude Code on the host turns a conversation into a project plan ----------
// The browser keeps the conversation and sends all of it each turn; the host helper runs `claude -p` (no tools, no
// saved session) and answers here. Nothing is created until the human confirms the plan (POST /projects as usual).
const chatJobs = new Map();   // id -> { resolve, timer }
function chatContext() {
  const i = host.info || {};
  const pick = (list, n) => (list || []).map((m) => (m.label ? `${m.id} (${m.label})` : m.id)).slice(0, n);
  const models = Object.fromEntries(CLI_TOOLS.map((t) => {
    const all = i.models?.[t] || [];
    const go = all.filter((m) => /^opencode-go\//.test(m.id)), free = all.filter((m) => /-free$|big-pickle/.test(m.id));
    const rest = all.filter((m) => !go.includes(m) && !free.includes(m) && !/^openrouter\//.test(m.id));
    return [t, [...pick(rest, 30), ...pick(go, 20), ...pick(free, 15), ...(all.some((m) => /^openrouter\//.test(m.id)) ? ['openrouter/<author>/<model> (OpenRouter key set)'] : [])]];
  }));
  return { human: HUMAN_NAME, projects_dir: i.projects_dir || '~/projects', clis: i.clis || [], models,
    keys: { gemini: !!i.keys?.gemini?.ready, openrouter: !!i.keys?.openrouter?.ready },
    design_systems: (i.design_systems || []).map((d) => `${d.id}: ${d.name} (${d.best_for || d.summary || ''})`.slice(0, 200)),
    tools: (i.tools || []).map((t) => `${t.id}: ${t.name} (${t.summary})`.slice(0, 200)),
    folders: (i.folders || []).slice(0, 60).map((f) => f.name),
    // agent names are unique across TropaAI: these are taken (a new team picks others, or gets "-<project>" added)
    taken_agent_names: q.listAgents.all().map((a) => a.name).slice(0, 200),
  };
}
/** The plan Claude proposed, cleaned to what POST /projects accepts (it validates again on create). */
function cleanPlan(p) {
  if (!p || typeof p !== 'object') return null;
  const str = (v, n) => String(v ?? '').trim().slice(0, n);
  const agents = (Array.isArray(p.agents) ? p.agents : []).slice(0, 12).map((a) => ({ name: cleanName(a?.name), tool: CLI_TOOLS.includes(String(a?.tool || '').toLowerCase()) ? String(a.tool).toLowerCase() : 'claude',
    model: /^[A-Za-z0-9._:/@-]{0,80}$/.test(str(a?.model, 80)) ? str(a?.model, 80) : '', role: str(a?.role, 200) })).filter((a) => a.name);
  const set = p.settings && typeof p.settings === 'object' ? p.settings : {};
  return { name: str(p.name, 80), folder: slugify(p.folder || p.slug || p.name || ''), path: /^(~|\/)/.test(str(p.path, 400)) ? str(p.path, 400) : '',
    brief: str(p.brief, 20000), lead: cleanName(p.lead || ''), agents, kickoff: str(p.kickoff, 4000),
    design_system: (host.info.design_systems || []).some((d) => d.id === p.design_system) ? p.design_system : '',
    tools: (Array.isArray(p.tools) ? p.tools : []).map(String).filter((t) => (host.info.tools || []).some((x) => x.id === t)).slice(0, 10),
    auto_approve: p.auto_approve === true,
    settings: { ...(['ask', 'auto', 'off'].includes(set.team_growth) ? { team_growth: set.team_growth } : {}),
      ...(Number.isInteger(set.auto_agents_per_hour) && set.auto_agents_per_hour >= 0 && set.auto_agents_per_hour <= 20 ? { auto_agents_per_hour: set.auto_agents_per_hour } : {}),
      ...(['ask', 'auto', 'off'].includes(set.team_shrink) ? { team_shrink: set.team_shrink } : {}) } };
}
function parseChatAnswer(text) {
  const t = String(text || '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { const o = JSON.parse(t.slice(a, b + 1)); if (o && typeof o === 'object' && ('reply' in o || 'plan' in o)) return { reply: String(o.reply || '').slice(0, 6000), plan: cleanPlan(o.plan) }; } catch {}
  }
  return { reply: t.slice(0, 6000), plan: null };
}
api.post('/project-chat', wrap(async (req) => {
  if (!hostOnline()) throw new UserError('the tropa host helper is not running on your machine — start it with: tropa host start');
  if (!host.info.claude?.installed) throw new UserError('Claude Code is not installed on this computer: curl -fsSL https://claude.ai/install.sh | bash');
  const msgs = (Array.isArray(req.body?.messages) ? req.body.messages : []).slice(-40)
    .map((m) => ({ role: m?.role === 'assistant' ? 'assistant' : 'user', content: String(m?.content || '').slice(0, 8000) })).filter((m) => m.content);
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') throw new UserError('say something first');
  const id = crypto.randomUUID();
  const ans = await new Promise((resolve) => {
    const timer = setTimeout(() => { chatJobs.delete(id); resolve({ ok: false, error: 'Claude took too long to answer; try again' }); }, 240000);
    chatJobs.set(id, { resolve, timer });
    host.queue.push({ type: 'project_chat', id, messages: msgs, context: chatContext() });
    for (const f of [...host.waiters]) f();
  });
  if (!ans.ok) return { ok: false, error: ans.error, auth: !!ans.auth };
  return { ok: true, ...parseChatAnswer(ans.text) };
}));
api.post('/host/chat/:id', wrap((req) => {
  const j = chatJobs.get(req.params.id);
  if (!j) throw new UserError('unknown request (it may have timed out)');
  chatJobs.delete(req.params.id); clearTimeout(j.timer);
  const b = req.body || {};
  j.resolve({ ok: !!b.ok, text: String(b.text || '').slice(0, 60000), error: String(b.error || '').slice(0, 600), auth: !!b.auth });
  return { ok: true };
}));
api.post('/host/openrouter', wrap(async (req) => {
  if (!hostOnline()) throw new UserError('the tropa host helper is not running on your machine — start it with: tropa host start');
  const clear = req.body?.clear === true;
  const key = String(req.body?.key || '').trim();
  if (!clear && !/^[\x21-\x7e]{16,300}$/.test(key)) throw new UserError('that doesn\'t look like an OpenRouter key (they start with sk-or-)');
  const id = crypto.randomUUID();
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => { secretJobs.delete(id); resolve({ ok: false, error: "the host helper didn't answer in time; try again" }); }, 45000);
    secretJobs.set(id, { resolve, timer });
    host.queue.push(clear ? { type: 'openrouter_key', id, clear: true } : { type: 'openrouter_key', id, key });
    for (const f of [...host.waiters]) f();
  });
  return result;
}));
// API keys (OpenRouter, Gemini), global or for one project: { key } to save (the host checks it first), { clear: true } to remove.
// Like the OpenRouter key: relayed to the host helper, never stored, logged or broadcast here.
api.post('/host/keys/:provider', wrap(async (req) => {
  const prov = String(req.params.provider || '');
  if (!KEY_PROVIDERS[prov]) throw new UserError(`unknown provider "${prov}"`);
  if (!hostOnline()) throw new UserError('the tropa host helper is not running on your machine — start it with: tropa host start');
  const clear = req.body?.clear === true;
  const key = String(req.body?.key || '').trim();
  const project = req.body?.project ? slugify(req.body.project) : '';
  if (!clear && !/^[\x21-\x7e]{16,300}$/.test(key)) throw new UserError(`that doesn't look like ${prov === 'gemini' ? 'a Gemini API key (they start with AIza)' : 'an OpenRouter key (they start with sk-or-)'}`);
  const id = crypto.randomUUID();
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => { secretJobs.delete(id); resolve({ ok: false, error: "the host helper didn't answer in time; try again" }); }, 45000);
    secretJobs.set(id, { resolve, timer });
    host.queue.push({ type: 'api_key', id, provider: prov, project, ...(clear ? { clear: true } : { key }) });
    for (const f of [...host.waiters]) f();
  });
  if (project && result.ok) {
    const roomId = `project:${project}`;
    if (q.getRoom.get(roomId)) watcherSay(roomId, clear ? `🔑 Removed this project's own ${KEY_PROVIDERS[prov]} key; its agents use the global key (or sign-in) from their next restart.`
      : `🔑 This project now has its own ${KEY_PROVIDERS[prov]} key (${result.masked || 'set'}); agents use it from their next restart.`);
  }
  return result;
}));
api.post('/host/secret/:id', wrap((req) => {
  const j = secretJobs.get(req.params.id);
  if (!j) throw new UserError('unknown request (it may have timed out)');
  secretJobs.delete(req.params.id); clearTimeout(j.timer);
  const b = req.body || {};
  j.resolve({ ok: !!b.ok, error: String(b.error || '').slice(0, 300), models: Number(b.models) || 0, masked: String(b.masked || '').slice(0, 40),
    source: ['env', 'file', 'project'].includes(b.source) ? b.source : '', ready: !!b.ready });
  return { ok: true };
}));
api.post('/host/jobs/:id', wrap((req) => {
  const job = jobs.get(req.params.id);
  if (!job) throw new UserError('unknown job');
  if (req.body.status) job.status = String(req.body.status).slice(0, 20);
  if (req.body.folder) job.folder_path = String(req.body.folder).slice(0, 500);
  if (req.body.message) {
    const text = String(req.body.message).slice(0, 4000);
    job.log.push(text);
    try { postMessage({ room: job.room_id, sender: 'tropa', kind: 'system', content: text }); } catch (e) { console.error(e); }
  }
  broadcast({ type: 'job', job: jobView(job) });
  return jobView(job);
}));
const jobView = (j) => ({ id: j.id, room_id: j.room_id, slug: j.slug, status: j.status, folder_path: j.folder_path || '', log: j.log });
api.get('/jobs/:id', wrap((req) => { const j = jobs.get(req.params.id); if (!j) throw new UserError('unknown job'); return jobView(j); }));

api.post('/projects', wrap((req) => {
  const b = req.body || {};
  if (!hostOnline()) throw new UserError('the tropa host helper is not running on your machine — start it with: tropa host start');
  const name = String(b.name || '').trim().slice(0, 80);
  const slug = slugify(b.slug || name);
  if (!slug) throw new UserError('project name is required');
  const roomId = `project:${slug}`;
  const folder = b.path ? slug : String(b.folder || slug).trim();
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(folder) || /^\.+$/.test(folder)) throw new UserError('folder must be a simple name (letters, digits, . _ -)');
  const brief = String(b.brief || '').slice(0, MAX_CONTENT - 500);
  const path = b.path ? String(b.path).trim().slice(0, 500) : '';   // an existing project anywhere in the home folder (the host checks it)
  if (path && !/^(~|\/)/.test(path)) throw new UserError('give the folder\'s full path, e.g. ~/work/my-app');
  const existing = !!b.existing || !!path;
  if (existing && !path && !(host.info.folders || []).some((f) => f.name === folder)) throw new UserError(`no folder "${folder}" in ${host.info.projects_dir || 'the projects folder'}`);
  const agents = (Array.isArray(b.agents) ? b.agents : []).slice(0, 12).map((a) => ({
    name: cleanName(a.name), tool: String(a.tool || 'claude'), model: String(a.model || '').trim(),
    role: String(a.role || '').trim().slice(0, 200), instruction: String(a.instruction || '').trim().slice(0, 2000),
  }));
  const seen = new Set();
  for (const a of agents) {
    if (!a.name) throw new UserError('every agent needs a name');
    const low = a.name.toLowerCase();
    if (RESERVED.has(low) || low === HUMAN_NAME.toLowerCase()) throw new UserError(`"${a.name}" is a reserved name`);
    if (seen.has(low)) throw new UserError(`duplicate agent name "${a.name}"`);
    seen.add(low);
    if (!CLI_TOOLS.includes(a.tool)) throw new UserError(`${a.name}: CLI must be ${CLI_TOOLS.join(', ')}`);
    if (a.tool === 'gemini' && /^(ollama|openrouter)\//.test(a.model)) throw new UserError(`${a.name}: Gemini CLI only runs Google's Gemini models`);
    if (a.model && !/^[A-Za-z0-9._:/@-]{1,80}$/.test(a.model)) throw new UserError(`${a.name}: invalid model id`);
  }
  const lead = b.lead ? cleanName(b.lead) : '';
  // this project's own API keys (optional): checked and saved by the host helper outside the project folder
  const projectKeys = {};
  for (const [prov, v] of Object.entries(b.keys && typeof b.keys === 'object' ? b.keys : {})) {
    const k = String(v || '').trim();
    if (!k) continue;
    if (!KEY_PROVIDERS[prov]) throw new UserError(`unknown API key provider "${prov}"`);
    if (!/^[\x21-\x7e]{16,300}$/.test(k)) throw new UserError(`that doesn't look like a ${KEY_PROVIDERS[prov]} API key`);
    projectKeys[prov] = k;
  }
  const design = b.design_system ? String(b.design_system) : '';
  if (design && !(host.info.design_systems || []).some((d) => d.id === design)) throw new UserError(`unknown design system "${design}"`);
  const catalog = new Map((host.info.tools || []).map((t) => [t.id, t]));
  const tools = (Array.isArray(b.tools) ? b.tools : []).slice(0, 20).map((t) => {
    const c = catalog.get(String(t?.id || ''));
    if (!c) throw new UserError(`unknown tool "${t?.id}"`);
    let who = t.agents === '*' || !t.agents ? '*' : (Array.isArray(t.agents) ? t.agents : [t.agents]).map(cleanName);
    if (who !== '*' && (!who.length || who.some((n) => !seen.has(n.toLowerCase())))) throw new UserError(`${c.name}: pick agents from the team`);
    const params = {};
    for (const p of c.params) {
      if (!(t.params && p.key in t.params)) continue;
      const v = t.params[p.key];
      params[p.key] = p.type === 'bool' ? !!v : String(v ?? '').trim().slice(0, 200);
      if (p.type !== 'bool' && !/^[A-Za-z0-9._,:-]*$/.test(params[p.key])) throw new UserError(`${c.name}: invalid ${p.label}`);
    }
    return { id: c.id, agents: who, params };
  });
  if (lead && !seen.has(lead.toLowerCase())) throw new UserError('the lead must be one of the agents');
  // Agent names are unique across TropaAI. A name another project already uses (lead, qa, backend… from the presets)
  // gets this project's name added instead of taking over that agent: lead → lead-<slug>.
  const renamed = uniqueTeamNames(slug, agents);
  if (renamed.size) {
    const to = (n) => renamed.get(String(n).toLowerCase()) || n;
    const fix = (text) => String(text || '').replace(/@([A-Za-z0-9._-]+)/g, (m, n) => {
      const bare = n.replace(/\.+$/, ''), dots = n.slice(bare.length);   // "@lead." at the end of a sentence
      return renamed.has(bare.toLowerCase()) ? `@${renamed.get(bare.toLowerCase())}${dots}` : m;
    });
    for (const a of agents) { a.name = to(a.name); a.role = fix(a.role); a.instruction = fix(a.instruction); }
    for (const t of tools) if (t.agents !== '*') t.agents = t.agents.map(to);
    b.kickoff = fix(b.kickoff); b.brief = fix(b.brief);
  }
  const lead_ = lead ? (renamed.get(lead.toLowerCase()) || lead) : '';
  const files = (Array.isArray(b.files) ? b.files : []).map(Number).filter(Boolean);
  const room = ensureRoom(roomId, String(b.topic || name || '').slice(0, 300), { revive: true });
  if (b.topic || name) { q.setTopic.run(String(b.topic || name).slice(0, 300), roomId); broadcast({ type: 'room', room: q.getRoom.get(roomId) }); }
  setWakeSettings(roomId, { lead: lead_, auto_approve: b.auto_approve === true });
  const brief_ = renamed.size ? String(b.brief || '').slice(0, MAX_CONTENT - 500) : brief;
  const intro = [existing ? `🧩 **Team added to existing project: ${name || slug}** (\`${path || folder}\`)` : `🆕 **New project: ${name || slug}**`, brief_ ? `\n${brief_}` : '',
    renamed.size ? `\nThese names were already used in other projects, so this team has: ${[...renamed].map(([o, n]) => `${o} → @${n}`).join(', ')}.` : '',
    files.length ? `\nFiles are saved in \`${ATT_DIR}/\`.` : ''].filter(Boolean).join('\n').trim();
  const msg = postMessage({ room: roomId, sender: HUMAN_NAME, kind: 'human', content: intro, attachments: files });
  const job = { id: require('node:crypto').randomUUID(), type: 'create_project', room_id: roomId, slug, name: name || slug, folder,
    brief: brief_, agents, lead: lead_, existing, path, tools, design_system: design, auto_approve: b.auto_approve === true, git: b.git !== false, start: b.start !== false, trust: b.trust !== false, kickoff: String(b.kickoff || '').slice(0, 4000),
    human: HUMAN_NAME, status: 'queued', log: [], message_id: msg.id };
  jobs.set(job.id, job);
  host.queue.push({ ...job, log: undefined, keys: projectKeys });   // the keys only travel in the queue, never kept in `jobs`
  for (const f of [...host.waiters]) f();
  return { job: jobView(job), room: q.getRoom.get(roomId) || room, renamed: Object.fromEntries(renamed) };
}));
/** Names this team can't have because another agent already has them: name(lower) → a free one ("lead-<slug>", then "-2"…). */
function nameTaken(n, slug) {
  const low = n.toLowerCase();
  if (RESERVED.has(low) || low === HUMAN_NAME.toLowerCase()) return true;
  if (q.getAgent.get(n) && !removedAgent(n)) return true;
  if ([...q.listAgents.all()].some((a) => a.name.toLowerCase() === low)) return true;
  for (const [rid, w] of watchers) if (rid !== `project:${slug}` && watcherFor(rid) && w.agents.some((x) => x.toLowerCase() === low)) return true;
  return [...agentReqs.values()].some((r) => r.status === 'requested' && r.agent.name.toLowerCase() === low);
}
function uniqueTeamNames(slug, agents) {
  const out = new Map(), mine = new Set(agents.map((a) => a.name.toLowerCase()));
  const free = (n) => !nameTaken(n, slug) && !mine.has(n.toLowerCase());
  for (const a of agents) {
    if (!nameTaken(a.name, slug)) continue;
    const short = slug.slice(0, Math.max(3, 39 - a.name.length));
    let n = `${a.name}-${short}`.slice(0, 40).replace(/[-.]+$/, '');
    for (let i = 2; !free(n) && i < 100; i++) n = `${a.name}-${short}`.slice(0, 37).replace(/[-.]+$/, '') + `-${i}`;
    if (!free(n)) throw new UserError(`the name @${a.name} is already used; pick another`);
    out.set(a.name.toLowerCase(), n); mine.add(n.toLowerCase());
  }
  return out;
}

// ---------- public links (ngrok, optional): the host helper runs `ngrok http PORT` on the machine ----------
// A share starts from the human (room button, `@tropa share 3000`, `tropa share 3000`) or from an
// agent's request_share call, which waits for the human's approval in the room. Max 3 at once (ngrok's free plan).
const shares = new Map();   // id -> { id, room_id, slug, port, hours, by, reason, status, url, error, created_at, expires_at }
let shareSeq = 0;
const SHARE_LIVE = ['requested', 'starting', 'online'];
const shareView = (s) => ({ id: s.id, room_id: s.room_id, port: s.port, hours: s.hours, by: s.by, reason: s.reason || '', status: s.status,
  url: s.url || '', error: s.error || '', created_at: s.created_at, expires_at: s.expires_at || 0 });
const shareChanged = (s) => broadcast({ type: 'share', share: shareView(s) });
const shareNote = (roomId, text) => { try { postMessage({ room: roomId, sender: 'tropa', kind: 'system', content: text }); } catch (e) { console.error(e); } };
const hoursLabel = (h) => (h ? `${h} h` : 'until you stop it');
function ngrokReady() {
  if (!hostOnline()) throw new UserError('the tropa host helper is not running on your machine — start it with: tropa host start');
  const n = host.info.ngrok || {};
  if (!n.installed) throw new UserError('ngrok is not installed on your machine (it is optional). Install it from https://ngrok.com/download, then run: ngrok config add-authtoken <your token>');
  if (!n.authed) throw new UserError('ngrok needs your authtoken once: ngrok config add-authtoken <token> (free at https://dashboard.ngrok.com/get-started/your-authtoken)');
}
function newShare({ roomId, port, hours, by, reason, status }) {
  port = Number(port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError('port must be a number between 1 and 65535');
  if (port === PORT) throw new UserError(`port ${port} is this chat server — sharing it would let anyone control your agents`);
  hours = hours === undefined || hours === null || hours === '' ? 4 : Number(hours);
  if (!Number.isFinite(hours) || hours < 0 || hours > 72) throw new UserError('hours must be between 0 (until stopped) and 72');
  const live = [...shares.values()].filter((s) => SHARE_LIVE.includes(s.status));
  const dup = live.find((s) => s.room_id === roomId && s.port === port);
  if (dup) return { share: dup, existing: true };
  if (live.filter((s) => s.status !== 'requested').length >= 3) throw new UserError('3 links are already open (the ngrok free plan limit) — stop one first');
  const s = { id: ++shareSeq, room_id: roomId, slug: roomId.replace(/^project:/, ''), port, hours, by, reason: String(reason || '').slice(0, 300),
    status, created_at: Date.now() };
  shares.set(s.id, s);
  return { share: s, existing: false };
}
function startShare(s) {
  ngrokReady();
  s.status = 'starting'; s.error = '';
  host.queue.push({ id: `share-${s.id}`, type: 'share', share_id: s.id, room_id: s.room_id, slug: s.slug, port: s.port, hours: s.hours });
  for (const f of [...host.waiters]) f();
  shareChanged(s);
  return s;
}
function stopShare(s, why) {
  if (s.status === 'requested') { s.status = 'denied'; shareChanged(s); shareNote(s.room_id, `🚫 Share #${s.id} (port ${s.port}) was not approved${why ? `: ${why}` : ''}.`); wakeRequester(s, `Your request to share port ${s.port} was denied.`); return s; }
  if (!SHARE_LIVE.includes(s.status)) return s;
  host.queue.push({ id: `unshare-${s.id}`, type: 'unshare', share_id: s.id, room_id: s.room_id, slug: s.slug, port: s.port });
  for (const f of [...host.waiters]) f();
  s.status = 'stopping'; shareChanged(s);
  return s;
}
function wakeRequester(s, reason) {
  if (!s.by || s.by.toLowerCase() === HUMAN_NAME.toLowerCase() || !watcherFor(s.room_id)) return;
  try { fireWake(s.room_id, s.by, { manual: true, reason: reason.slice(0, 300) }); } catch (e) { console.error(e); }
}
function findShare(roomId, ref) {
  const n = Number(String(ref).replace(/^#/, ''));
  const s = shares.get(n);
  if (s && (!roomId || s.room_id === roomId)) return s;
  return [...shares.values()].reverse().find((x) => x.room_id === roomId && x.port === n && [...SHARE_LIVE, 'stopping'].includes(x.status));
}
function approveShare(s) {
  if (s.status !== 'requested') throw new UserError(`share #${s.id} is ${s.status}, not waiting for approval`);
  startShare(s);
  shareNote(s.room_id, `✅ ${HUMAN_NAME} approved share #${s.id} (port ${s.port}). Starting ngrok…`);
  return s;
}
// the host helper reports what actually happened
api.post('/host/shares/:id', wrap((req) => {
  const s = shares.get(Number(req.params.id));
  if (!s) throw new UserError('unknown share');
  const b = req.body || {};
  const st = String(b.status || '');
  if (!['online', 'failed', 'stopped'].includes(st)) throw new UserError('bad status');
  s.status = st;
  if (b.url && /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(String(b.url))) s.url = String(b.url).replace(/\/$/, '');
  if (b.error) s.error = String(b.error).slice(0, 400);
  if (st === 'online') {
    s.expires_at = s.hours ? Date.now() + s.hours * 3600e3 : 0;
    const warn = b.warning ? `\n⚠️ ${String(b.warning).slice(0, 200)}` : '';
    shareNote(s.room_id, `🌐 **Share #${s.id} is live:** ${s.url} → localhost:${s.port}${s.by && s.by !== HUMAN_NAME ? ` (asked by @${s.by})` : ''}\n` +
      `Anyone with this link can open it. It stops ${s.hours ? `in ${s.hours} h` : 'when you stop it'}, or now with \`@tropa stop share ${s.id}\`.${warn}`);
    wakeRequester(s, `Share #${s.id} is live: ${s.url} → localhost:${s.port}. Post it where it's needed; don't share it outside the room.`);
  } else if (st === 'failed') {
    shareNote(s.room_id, `❌ Share #${s.id} (port ${s.port}) failed: ${s.error || 'ngrok did not start'}`);
    wakeRequester(s, `Share #${s.id} failed: ${s.error || 'ngrok did not start'}`);
  } else {
    shareNote(s.room_id, `⏹ Share #${s.id} stopped (port ${s.port})${b.reason ? `: ${String(b.reason).slice(0, 120)}` : ''}. The link no longer works.`);
  }
  shareChanged(s);
  return shareView(s);
}));
api.get('/shares', wrap((req) => {
  const room = req.query.room ? normalizeRoomId(String(req.query.room)) : '';
  return [...shares.values()].filter((s) => !room || s.room_id === room).map(shareView);
}));
api.post('/rooms/:id/shares', wrap((req) => {
  const roomId = roomOf(req);
  if (!roomId.startsWith('project:')) throw new UserError('links can only be shared from a project room');
  ngrokReady();
  const { share, existing } = newShare({ roomId, port: req.body?.port, hours: req.body?.hours, by: HUMAN_NAME, status: 'starting' });
  if (existing) return shareView(share);
  startShare(share);
  shareNote(roomId, `🌐 ${HUMAN_NAME} is sharing port ${share.port} (${hoursLabel(share.hours)}). Starting ngrok…`);
  return shareView(share);
}));
api.post('/shares/:id/approve', wrap((req) => { const s = shares.get(Number(req.params.id)); if (!s) throw new UserError('unknown share'); return shareView(approveShare(s)); }));
api.post('/shares/:id/deny', wrap((req) => { const s = shares.get(Number(req.params.id)); if (!s) throw new UserError('unknown share'); return shareView(stopShare(s)); }));
api.delete('/shares/:id', wrap((req) => { const s = shares.get(Number(req.params.id)); if (!s) throw new UserError('unknown share'); return shareView(stopShare(s)); }));

// chat commands from the human: @tropa share 3000 [2h] · @tropa stop share 3 · @tropa approve share 3 · @tropa deny share 3
const SHARE_CMD = /@tropa\s+(?:(share)\s+(\d{1,5})(?:\s+(?:for\s+)?(\d{1,2})\s*h(?:ours?)?)?|(stop|unshare)(?:\s+share)?\s+#?(\d{1,5})|(approve|deny)\s+share\s+#?(\d{1,5}))/i;
function shareCommand(m) {
  const c = String(m.content).match(SHARE_CMD);
  if (!c) return false;
  try {
    if (!m.room_id.startsWith('project:')) throw new UserError('links can only be shared from a project room');
    if (c[1]) {
      ngrokReady();
      const { share, existing } = newShare({ roomId: m.room_id, port: c[2], hours: c[3], by: HUMAN_NAME, status: 'starting' });
      if (!existing) { startShare(share); shareNote(m.room_id, `🌐 Sharing port ${share.port} (${hoursLabel(share.hours)}). Starting ngrok…`); }
    } else {
      const s = findShare(m.room_id, c[5] || c[7]);
      if (!s) throw new UserError(`no share #${c[5] || c[7]} in this room`);
      if (c[6] && c[6].toLowerCase() === 'approve') approveShare(s); else stopShare(s);
    }
  } catch (e) { shareNote(m.room_id, `⚠️ ${e.message}`); }
  return true;
}

// ---------- usage: tokens and API-equivalent cost per agent, reported by the host helper from the CLIs' own logs ----------
db.exec(`CREATE TABLE IF NOT EXISTS usage (
  project TEXT NOT NULL, agent TEXT NOT NULL, cli TEXT NOT NULL, model TEXT NOT NULL, day TEXT NOT NULL,
  input INTEGER DEFAULT 0, cache_read INTEGER DEFAULT 0, cache_write INTEGER DEFAULT 0, output INTEGER DEFAULT 0,
  turns INTEGER DEFAULT 0, cost REAL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (project, agent, cli, model, day));
  CREATE INDEX IF NOT EXISTS idx_usage_day ON usage(day);`);
const uq = {
  upsert: db.prepare(`INSERT INTO usage (project, agent, cli, model, day, input, cache_read, cache_write, output, turns, cost, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project, agent, cli, model, day) DO UPDATE SET
    input = excluded.input, cache_read = excluded.cache_read, cache_write = excluded.cache_write, output = excluded.output,
    turns = excluded.turns, cost = excluded.cost, updated_at = excluded.updated_at`),
  since: db.prepare(`SELECT * FROM usage WHERE day >= ? ORDER BY day`),
  sinceProject: db.prepare(`SELECT * FROM usage WHERE day >= ? AND project = ? ORDER BY day`),
  msgBuckets: db.prepare(`SELECT room_id, created_at / 900000 AS b, COUNT(*) AS n FROM messages WHERE created_at >= ? AND sender_kind != 'system' GROUP BY room_id, b`),
};
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayOf = (ms) => dayFmt.format(new Date(ms));
let usageInfo = { prices_as_of: '', updated_at: 0 };
api.post('/host/usage', wrap((req) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 50000) : [];
  const now = Date.now(), touched = new Set();
  const n = (x) => Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(Number(x) || 0)));
  db.exec('BEGIN');
  try {
    const sum = new Map();
    for (const r of rows) {
      const project = slugify(r.project || ''), day = String(r.day || '');
      let agent = cleanName(r.agent || '');
      const al = agent && q.getAlias.get(agent);   // sessions from before a rename carry the old name
      if (al) agent = al.target;
      const cli = CLI_TOOLS.includes(r.cli) ? r.cli : 'other';
      const model = String(r.model || '?').slice(0, 100);
      if (!project || !agent || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const cost = r.cost === null || r.cost === undefined || !Number.isFinite(Number(r.cost)) ? null : Math.max(0, Number(r.cost));
      const k = [project, agent, cli, model, day].join('\0');
      const c = sum.get(k) || { project, agent, cli, model, day, input: 0, cache_read: 0, cache_write: 0, output: 0, turns: 0, cost: null };
      for (const f of ['input', 'cache_read', 'cache_write', 'output', 'turns']) c[f] += n(r[f]);
      if (cost !== null) c.cost = (c.cost || 0) + cost;
      sum.set(k, c);
    }
    for (const c of sum.values()) {
      uq.upsert.run(c.project, c.agent, c.cli, c.model, c.day, c.input, c.cache_read, c.cache_write, c.output, c.turns, c.cost, now);
      touched.add(c.project);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  usageInfo = { prices_as_of: String(req.body?.prices_as_of || '').slice(0, 20), updated_at: now };
  if (touched.size) broadcast({ type: 'usage', projects: [...touched] });
  return { ok: true, rows: rows.length };
}));
// GET /api/usage?room=project:<slug>|all&days=30  → totals, per agent, per model, per project, and a year of daily cells
api.get('/usage', wrap((req) => {
  const room = String(req.query.room || 'all');
  const slug = room === 'all' ? '' : slugify(room.replace(/^project:/, ''));
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 400);
  const today = dayOf(Date.now());
  const yearAgo = dayOf(Date.now() - 371 * 86400e3), from = dayOf(Date.now() - (days - 1) * 86400e3);
  const rows = slug ? uq.sinceProject.all(yearAgo, slug) : uq.since.all(yearAgo);
  const cells = {}, agents = {}, models = {}, projects = {};
  const totals = { input: 0, cache_read: 0, cache_write: 0, output: 0, tokens: 0, turns: 0, cost: 0, unpriced_tokens: 0, messages: 0 };
  for (const r of rows) {
    const tokens = r.input + r.cache_read + r.cache_write + r.output;
    const c = cells[r.day] || (cells[r.day] = { tokens: 0, cost: 0, turns: 0, messages: 0, agents: {} });
    c.tokens += tokens; c.cost += r.cost || 0; c.turns += r.turns;
    const ca = c.agents[r.agent] || (c.agents[r.agent] = { tokens: 0, cost: 0, turns: 0 });
    ca.tokens += tokens; ca.cost += r.cost || 0; ca.turns += r.turns;
    const isToday = r.day === today;
    const ak = `${r.project}\0${r.agent}`;
    const a = agents[ak] || (agents[ak] = { project: r.project, agent: r.agent, clis: new Set(), models: new Set(), tokens: 0, output: 0, turns: 0, cost: 0, unpriced: false, today_tokens: 0, today_cost: 0, last_day: '' });
    if (isToday) { a.today_tokens += tokens; a.today_cost += r.cost || 0; }
    if (r.day > a.last_day) a.last_day = r.day;
    if (r.day < from) continue;            // the rest only counts inside the chosen range
    a.clis.add(r.cli); a.models.add(r.model); a.tokens += tokens; a.output += r.output; a.turns += r.turns; a.cost += r.cost || 0;
    if (r.cost === null) a.unpriced = true;
    const m = models[`${r.cli}\0${r.model}`] || (models[`${r.cli}\0${r.model}`] = { cli: r.cli, model: r.model, tokens: 0, output: 0, cost: 0, priced: true });
    m.tokens += tokens; m.output += r.output; m.cost += r.cost || 0; if (r.cost === null) m.priced = false;
    const p = projects[r.project] || (projects[r.project] = { project: r.project, tokens: 0, cost: 0, turns: 0 });
    p.tokens += tokens; p.cost += r.cost || 0; p.turns += r.turns;
    for (const k of ['input', 'cache_read', 'cache_write', 'output', 'turns']) totals[k] += r[k];
    totals.tokens += tokens; totals.cost += r.cost || 0; if (r.cost === null) totals.unpriced_tokens += tokens;
  }
  // activity: chat messages (not system notices) per day
  for (const b of uq.msgBuckets.all(Date.now() - 371 * 86400e3)) {
    if (slug ? b.room_id !== `project:${slug}` : false) continue;
    const d = dayOf(b.b * 900000);
    const c = cells[d] || (cells[d] = { tokens: 0, cost: 0, turns: 0, messages: 0, agents: {} });
    c.messages += b.n;
    if (d >= from) totals.messages += b.n;
  }
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  for (const c of Object.values(cells)) { c.cost = r6(c.cost); for (const a of Object.values(c.agents)) a.cost = r6(a.cost); }
  return {
    room, days, from, today, tz: TZ, collecting: hostOnline() && !!host.info.usage, prices_as_of: usageInfo.prices_as_of, updated_at: usageInfo.updated_at,
    totals: { ...totals, cost: r6(totals.cost) }, cells,
    agents: Object.values(agents).map((a) => ({ ...a, clis: [...a.clis], models: [...a.models], cost: r6(a.cost), today_cost: r6(a.today_cost) })).sort((x, y) => y.tokens - x.tokens),
    models: Object.values(models).map((m) => ({ ...m, cost: r6(m.cost) })).sort((x, y) => y.tokens - x.tokens),
    projects: Object.values(projects).map((p) => ({ ...p, cost: r6(p.cost) })).sort((x, y) => y.tokens - x.tokens),
  };
}));
// today's figures per agent, for agent cards and the sidebar
api.get('/usage/agents', wrap(() => {
  const today = dayOf(Date.now());
  const out = {};
  for (const r of uq.since.all(today)) {
    const k = r.agent.toLowerCase();
    const a = out[k] || (out[k] = { project: r.project, tokens: 0, cost: 0, turns: 0, unpriced: false });
    a.tokens += r.input + r.cache_read + r.cache_write + r.output; a.cost += r.cost || 0; a.turns += r.turns;
    if (r.cost === null) a.unpriced = true;
  }
  return { today, agents: out };
}));

// ---------- task board: one card per assignment, moved by the agents (and the human) as work flows ----------
db.exec(`CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, title TEXT NOT NULL, assignee TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo', branch TEXT DEFAULT '', note TEXT DEFAULT '', created_by TEXT DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT DEFAULT '');
  CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id, status);
  CREATE TABLE IF NOT EXISTS task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, at INTEGER NOT NULL,
    by TEXT DEFAULT '', field TEXT NOT NULL, old TEXT DEFAULT '', new TEXT DEFAULT '');
  CREATE INDEX IF NOT EXISTS idx_task_events ON task_events(task_id, id);`);
if (!db.prepare('PRAGMA table_info(tasks)').all().some((c) => c.name === 'description')) db.exec("ALTER TABLE tasks ADD COLUMN description TEXT DEFAULT ''");
// deps: JSON [{id, kind}] — kind "merge" (wait until that task is done) or "contract" (it only needs to have started,
// i.e. its contract is posted and work can run in parallel against it)
if (!db.prepare('PRAGMA table_info(tasks)').all().some((c) => c.name === 'deps')) db.exec("ALTER TABLE tasks ADD COLUMN deps TEXT DEFAULT '[]'");
const TASK_STATUS = ['todo', 'doing', 'review', 'qa', 'blocked', 'done'];
const tq = {
  list: db.prepare('SELECT * FROM tasks WHERE room_id = ? ORDER BY id'),
  get: db.prepare('SELECT * FROM tasks WHERE id = ?'),
  ins: db.prepare('INSERT INTO tasks (room_id, title, assignee, status, branch, note, created_by, created_at, updated_at, updated_by, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  upd: db.prepare('UPDATE tasks SET title = ?, assignee = ?, status = ?, branch = ?, note = ?, updated_at = ?, updated_by = ?, description = ? WHERE id = ?'),
  del: db.prepare('DELETE FROM tasks WHERE id = ?'),
  delRoom: db.prepare('DELETE FROM tasks WHERE room_id = ?'),
  ev: db.prepare('INSERT INTO task_events (task_id, at, by, field, old, new) VALUES (?, ?, ?, ?, ?, ?)'),
  events: db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY id'),
  delEvents: db.prepare('DELETE FROM task_events WHERE task_id = ?'),
  delRoomEvents: db.prepare('DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE room_id = ?)'),
  related: db.prepare("SELECT * FROM messages WHERE room_id = ? AND sender_kind != 'system' AND (content LIKE ? OR (? != '' AND content LIKE ?)) ORDER BY id DESC LIMIT 25"),
  byBranch: db.prepare("SELECT * FROM tasks WHERE room_id = ? AND branch = ? AND status != 'done' ORDER BY id DESC LIMIT 1"),
};
const cleanBranch = (b) => String(b || '').trim().replace(/^`|`$/g, '').slice(0, 120).replace(/[^\w./-]/g, '');

// ---- dependencies ----
tq.setDeps = db.prepare('UPDATE tasks SET deps = ? WHERE id = ?');
function parseDeps(t) {
  try { const d = JSON.parse(t?.deps || '[]'); return Array.isArray(d) ? d.filter((x) => x && Number.isInteger(x.id)).map((x) => ({ id: x.id, kind: x.kind === 'contract' ? 'contract' : 'merge' })) : []; }
  catch { return []; }
}
const depMet = (kind, status) => (kind === 'contract' ? ['doing', 'review', 'qa', 'done'].includes(status) : status === 'done');
/** Normalise what a caller gave (ids, "#12", {id, kind}) into [{id, kind}] and refuse unknown ids, other rooms and loops. */
function cleanDeps(roomId, selfId, mergeIds, contractIds) {
  const ids = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/)).map((x) => (typeof x === 'object' && x ? x.id : x))
    .map((x) => Number(String(x).replace(/^#/, ''))).filter((n) => Number.isInteger(n) && n > 0);
  const kindOf = new Map();
  for (const n of ids(mergeIds)) kindOf.set(n, 'merge');
  for (const x of Array.isArray(mergeIds) ? mergeIds : []) if (x && typeof x === 'object' && x.kind === 'contract') kindOf.set(Number(x.id), 'contract');
  for (const n of ids(contractIds)) kindOf.set(n, 'contract');
  if (kindOf.size > 30) throw new UserError('a task can depend on at most 30 others');
  const all = new Map(tq.list.all(roomId).map((t) => [t.id, t]));
  for (const n of kindOf.keys()) {
    if (n === selfId) throw new UserError(`#${n} can't depend on itself`);
    if (!all.has(n)) throw new UserError(`#${n} isn't a task on this board`);
  }
  if (selfId) {   // would the new edges make a loop? walk from each new dependency through the board's existing ones
    const seen = new Set();
    const reaches = (from) => {
      if (from === selfId) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return parseDeps(all.get(from)).some((d) => reaches(d.id));
    };
    for (const n of kindOf.keys()) if (reaches(n)) throw new UserError(`#${selfId} → #${n} would make a loop (#${n} already waits for #${selfId})`);
  }
  return [...kindOf].sort((a, b) => a[0] - b[0]).map(([id, kind]) => ({ id, kind }));
}
/** The board with what each card waits for, whether it's ready to start, and what it unblocks. */
function taskViews(roomId) {
  const rows = tq.list.all(roomId);
  const byId = new Map(rows.map((t) => [t.id, t]));
  const unblocks = new Map();
  for (const t of rows) for (const d of parseDeps(t)) if (byId.has(d.id)) { if (!unblocks.has(d.id)) unblocks.set(d.id, []); unblocks.get(d.id).push(t.id); }
  return rows.map((t) => {
    const deps = parseDeps(t).filter((d) => byId.has(d.id)).map((d) => ({ ...d, status: byId.get(d.id).status, title: byId.get(d.id).title }));
    const waits = deps.filter((d) => !depMet(d.kind, d.status));
    return { ...t, deps, waits_for: waits.map((d) => d.id), ready: t.status === 'todo' && !waits.length, unblocks: unblocks.get(t.id) || [] };
  });
}
const taskView = (t) => taskViews(t.room_id).find((x) => x.id === t.id) || t;
function broadcastTasks(roomId) {
  broadcast({ type: 'tasks', room_id: roomId, tasks: taskViews(roomId) });
  schedulePlanFile(roomId);
  try { refreshAttention(roomId); } catch (e) { console.error('attention', e); }
}
/** After a card moves: wake the owners of cards that just became ready. */
function announceUnblocked(roomId, before, cause) {
  const was = new Map(before.map((t) => [t.id, t]));
  const w = watcherFor(roomId);
  for (const t of taskViews(roomId)) {
    const prev = was.get(t.id);
    if (!t.ready || !prev || prev.ready || !t.deps.length) continue;
    const dep = t.deps.find((d) => d.id === cause.id);
    const why = dep?.kind === 'contract' ? `#${cause.id} has started, so its contract is out` : `#${cause.id} is done`;
    watcherSay(roomId, `🔓 #${t.id} ${t.title} is ready to start: ${why}.${t.assignee ? ` @${t.assignee}` : ''}`);
    const agent = t.assignee && w?.agents.find((a) => a.toLowerCase() === t.assignee.toLowerCase());
    if (agent) fireWake(roomId, agent, { manual: true, reason: `Task #${t.id} "${t.title}" is unblocked (${why}). Check it on the board (task_list) and start it.` });
  }
}

// ---- docs/PLAN.md, written by the watcher from the board (only a file tropa wrote, or none yet) ----
const PLAN_MARK = '<!-- tropa:auto-plan: this file is drawn from the task board; edits here are overwritten. Remove this line to keep your own. -->';
const planTimers = new Map();
function planMarkdown(roomId) {
  const views = taskViews(roomId);
  const label = (s) => String(s || '').replace(/["`;<>{}[\]()|#&]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  const lines = ['flowchart LR'];
  for (const t of views) lines.push(`  t${t.id}["#35;${t.id} ${label(t.title)}${t.assignee ? `<br/>@${label(t.assignee)}` : ''}${t.branch ? `<br/>${label(t.branch)}` : ''}"]`);
  for (const t of views) for (const d of t.deps) lines.push(d.kind === 'contract' ? `  t${d.id} -.->|"contract"| t${t.id}` : `  t${d.id} --> t${t.id}`);
  lines.push('  classDef todo fill:#e5e7eb,stroke:#6b7280,color:#111827', '  classDef ready fill:#e5e7eb,stroke:#16a34a,stroke-width:2px,color:#111827',
    '  classDef doing fill:#bfdbfe,stroke:#2563eb,color:#111827', '  classDef review fill:#ddd6fe,stroke:#7c3aed,color:#111827',
    '  classDef qa fill:#fde68a,stroke:#d97706,color:#111827', '  classDef blocked fill:#fecaca,stroke:#dc2626,color:#111827', '  classDef done fill:#bbf7d0,stroke:#16a34a,color:#111827');
  const groups = {};
  for (const t of views) (groups[t.ready ? 'ready' : t.status] ||= []).push(`t${t.id}`);
  for (const [cls, ids] of Object.entries(groups)) lines.push(`  class ${ids.join(',')} ${cls}`);
  const table = views.map((t) => `| ${t.id} | ${label(t.title)} | ${t.assignee ? '@' + t.assignee : ''} | ${t.branch || ''} | ${t.deps.map((d) => `${d.kind === 'contract' ? '~' : ''}${d.id}`).join(', ')} | ${t.ready ? 'ready' : t.status} |`);
  return `${PLAN_MARK}\n# Plan\n\nThe task board as a flowchart. An arrow means "waits for"; a dashed arrow means it only needs that task's contract (~ in the table).\nColours: grey to do · green border ready · blue doing · purple review · yellow QA · red blocked · green done.\n\n` +
    '```mermaid\n' + (views.length ? lines.join('\n') : 'flowchart LR\n  empty["No tasks yet"]') + '\n```\n\n' +
    `| # | Task | Owner | Branch | After | Status |\n|---|---|---|---|---|---|\n${table.join('\n')}\n`;
}
function schedulePlanFile(roomId) {
  if (!String(roomId).startsWith('project:')) return;
  clearTimeout(planTimers.get(roomId));
  const timer = setTimeout(() => {   // debounced: a burst of card moves writes the file once
    planTimers.delete(roomId);
    try { if (watcherFor(roomId) && tq.list.all(roomId).length) pushEvent(roomId, { type: 'write_plan', content: planMarkdown(roomId), mark: PLAN_MARK }); }
    catch (e) { console.error('plan file', e); }
  }, 8000);
  timer.unref();
  planTimers.set(roomId, timer);
}

function addTask(roomId, { title, assignee, branch, status, description, by, depends_on, contract_from }) {
  title = String(title || '').trim().slice(0, 200);
  if (!title) throw new UserError('a task needs a title');
  status = TASK_STATUS.includes(status) ? status : 'todo';
  const deps = cleanDeps(roomId, 0, depends_on, contract_from);
  const now = Date.now();
  const r = tq.ins.run(roomId, title, cleanName(assignee || ''), status, cleanBranch(branch), '', by || '', now, now, by || '', String(description || '').slice(0, 8000));
  tq.setDeps.run(JSON.stringify(deps), r.lastInsertRowid);
  const t = tq.get.get(r.lastInsertRowid);
  tq.ev.run(t.id, now, by || '', 'created', '', t.status);
  if (deps.length) tq.ev.run(t.id, now, by || '', 'deps', '', deps.map((d) => `${d.kind === 'contract' ? '~' : '#'}${d.id}`).join(' '));
  broadcastTasks(roomId);
  return taskView(t);
}
function updateTask(id, patch, by) {
  const t = tq.get.get(Number(id));
  if (!t) throw new UserError(`no task #${id}`);
  const before = taskViews(t.room_id);
  if (patch.depends_on !== undefined || patch.contract_from !== undefined) {
    const deps = cleanDeps(t.room_id, t.id, patch.depends_on ?? parseDeps(t).filter((d) => d.kind === 'merge').map((d) => d.id),
      patch.contract_from ?? (patch.depends_on !== undefined && patch.depends_on.some?.((x) => x && typeof x === 'object') ? [] : parseDeps(t).filter((d) => d.kind === 'contract').map((d) => d.id)));
    const fmt = (ds) => ds.map((d) => `${d.kind === 'contract' ? '~' : '#'}${d.id}`).join(' ');
    if (fmt(deps) !== fmt(parseDeps(t))) { tq.setDeps.run(JSON.stringify(deps), t.id); tq.ev.run(t.id, Date.now(), by || '', 'deps', fmt(parseDeps(t)), fmt(deps)); }
  }
  const next = { ...t };
  if (patch.title !== undefined) next.title = String(patch.title).trim().slice(0, 200) || t.title;
  if (patch.assignee !== undefined) next.assignee = cleanName(patch.assignee || '');
  if (patch.branch !== undefined) next.branch = cleanBranch(patch.branch);
  if (patch.note !== undefined) next.note = String(patch.note || '').slice(0, 300);
  if (patch.description !== undefined) next.description = String(patch.description || '').slice(0, 8000);
  if (patch.status !== undefined) {
    if (!TASK_STATUS.includes(patch.status)) throw new UserError(`status must be one of: ${TASK_STATUS.join(', ')}`);
    next.status = patch.status;
  }
  const now = Date.now();
  tq.upd.run(next.title, next.assignee, next.status, next.branch, next.note, now, by || '', next.description || '', t.id);
  for (const f of ['status', 'assignee', 'branch', 'title', 'note', 'description']) {
    if ((t[f] || '') !== (next[f] || '')) tq.ev.run(t.id, now, by || '', f, f === 'description' ? '' : String(t[f] || '').slice(0, 200), f === 'description' ? '' : String(next[f] || '').slice(0, 200));
  }
  const out = tq.get.get(t.id);
  broadcastTasks(t.room_id);
  if (out.status !== t.status) announceUnblocked(t.room_id, before, out);
  return taskView(out);
}
api.get('/rooms/:id/tasks', wrap((req) => taskViews(roomOf(req))));
api.get('/rooms/:id/plan.md', (req, res) => {
  try { res.type('text/markdown').send(planMarkdown(roomOf(req))); } catch (e) { res.status(e instanceof UserError ? 400 : 500).json({ error: e.message }); }
});
api.post('/rooms/:id/tasks', wrap((req) => addTask(roomOf(req), { ...req.body, by: HUMAN_NAME })));
api.patch('/tasks/:id', wrap((req) => updateTask(req.params.id, req.body || {}, HUMAN_NAME)));
// one task with its history and the messages that mention it (#id or its branch)
api.get('/tasks/:id', wrap((req) => {
  const t = tq.get.get(Number(req.params.id));
  if (!t) throw new UserError('no such task');
  const rel = tq.related.all(t.room_id, `%#${t.id}%`, t.branch || '', `%${t.branch || '\u0000'}%`)
    .filter((m) => new RegExp(`#${t.id}(?!\\d)`).test(m.content) || (t.branch && m.content.includes(t.branch)))
    .map((m) => ({ id: m.id, sender: m.sender, sender_kind: m.sender_kind, content: m.content.slice(0, 600), created_at: m.created_at }));
  return { ...taskView(t), events: tq.events.all(t.id), messages: rel.reverse() };
}));
api.delete('/tasks/:id', wrap((req) => {
  const t = tq.get.get(Number(req.params.id));
  if (!t) throw new UserError('no such task');
  tq.del.run(t.id); tq.delEvents.run(t.id);
  broadcastTasks(t.room_id);
  return { ok: true };
}));
// Agents often forget the board, so handoffs that name a branch move its card too.
const HANDOFF_RULES = [
  [/ready for review|please review|review (it|this|branch)/i, 'review'],
  [/please test|over to @?qa|ready (for|to) (test|qa)/i, 'qa'],
  [/\bFAIL\b|changes (needed|requested)/i, 'doing'],
  [/\bmerged\b/i, 'done'],
  [/\bblocked\b/i, 'blocked'],
];
function inferTaskMoves(m) {
  if (m.sender_kind === 'system' || !String(m.room_id).startsWith('project:')) return;
  const branches = [...String(m.content).matchAll(/\b([a-z0-9][\w.-]*\/[\w./-]+)\b/gi)].map((x) => cleanBranch(x[1])).filter((b) => !/^https?:|\.(md|json|js|ts|py|png)$/i.test(b));
  if (!branches.length) return;
  const rule = HANDOFF_RULES.find(([re]) => re.test(m.content));
  for (const b of new Set(branches)) {
    const t = tq.byBranch.get(m.room_id, b);
    if (!t) continue;
    if (rule && rule[1] !== t.status) updateTask(t.id, { status: rule[1] }, `${m.sender} (from message #${m.id})`);
    else if (!rule && t.status === 'todo' && m.sender.toLowerCase() === t.assignee.toLowerCase()) updateTask(t.id, { status: 'doing' }, `${m.sender} (from message #${m.id})`);
  }
}
bus.on('message', (m) => { try { inferTaskMoves(m); } catch (e) { console.error('task inference', e); } });

// ---------- questions waiting on the human ----------
// An agent asks with the ask_human tool (question, options, recommendation, what it does if nobody answers, by when),
// or simply @mentions the human with a question. Both are listed for the human until answered in the chat.
db.exec(`CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, message_id INTEGER, agent TEXT NOT NULL, question TEXT NOT NULL,
  options TEXT DEFAULT '[]', recommended INTEGER DEFAULT 0, fallback TEXT DEFAULT '', deadline_at INTEGER DEFAULT 0, task_id INTEGER DEFAULT 0,
  source TEXT DEFAULT 'tool', status TEXT NOT NULL DEFAULT 'open', answer TEXT DEFAULT '', answered_by TEXT DEFAULT '',
  created_at INTEGER NOT NULL, closed_at INTEGER DEFAULT 0);
  CREATE INDEX IF NOT EXISTS idx_questions_room ON questions(room_id, status);`);
const qq = {
  ins: db.prepare(`INSERT INTO questions (room_id, message_id, agent, question, options, recommended, fallback, deadline_at, task_id, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  get: db.prepare('SELECT * FROM questions WHERE id = ?'),
  byMsg: db.prepare("SELECT * FROM questions WHERE message_id = ? AND status = 'open'"),
  openFrom: db.prepare("SELECT * FROM questions WHERE room_id = ? AND lower(agent) = lower(?) AND status = 'open' ORDER BY id DESC"),
  list: db.prepare("SELECT * FROM questions WHERE status = 'open' OR closed_at > ? ORDER BY id"),
  due: db.prepare("SELECT * FROM questions WHERE status = 'open' AND deadline_at > 0 AND deadline_at <= ?"),
  close: db.prepare('UPDATE questions SET status = ?, answer = ?, answered_by = ?, closed_at = ? WHERE id = ?'),
  delRoom: db.prepare('DELETE FROM questions WHERE room_id = ?'),
};
const questionView = (r) => r && { ...r, options: (() => { try { return JSON.parse(r.options || '[]'); } catch { return []; } })() };
const broadcastQuestion = (id) => broadcast({ type: 'question', question: questionView(qq.get.get(id)) });
let asking = false;   // set while ask_human posts its own message, so the mention detector skips it
function askHuman({ roomId, agent, question, options, recommended, fallback, minutes, task_id }) {
  question = String(question || '').trim().slice(0, 1000);
  if (!question) throw new UserError('ask_human needs a question');
  const opts = (Array.isArray(options) ? options : []).map((o) => String(o || '').trim().slice(0, 200)).filter(Boolean).slice(0, 8);
  const rec = Number.isInteger(Number(recommended)) && Number(recommended) >= 1 && Number(recommended) <= opts.length ? Number(recommended) : 0;
  fallback = String(fallback || '').trim().slice(0, 300);
  const mins = Math.min(Math.max(Number(minutes) || 0, 0), 24 * 60);
  const deadline = fallback && mins ? Date.now() + mins * 60e3 : 0;
  const at = deadline ? new Date(deadline).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '';
  const content = `@${HUMAN_NAME} ${question}` + (opts.length ? '\n' + opts.map((o, i) => `${i + 1}. ${o}${i + 1 === rec ? ' (recommended)' : ''}`).join('\n') : '') +
    (fallback ? `\nIf there's no answer${at ? ` by ${at}` : ''}: ${fallback}` : '');
  asking = true;
  let msg;
  try { msg = postMessage({ room: roomId, sender: agent, kind: 'agent', content }); } finally { asking = false; }
  const r = qq.ins.run(roomId, msg.id, agent, question, JSON.stringify(opts), rec, fallback, deadline, Number(task_id) || 0, 'tool', Date.now());
  broadcastQuestion(r.lastInsertRowid);
  return { id: Number(r.lastInsertRowid), message_id: msg.id, at };
}
function closeQuestion(q, status, answer, by) {
  qq.close.run(status, String(answer || '').slice(0, 2000), by || '', Date.now(), q.id);
  broadcastQuestion(q.id);
}
bus.on('message', (m) => {
  try {
    if (!String(m.room_id).startsWith('project:')) return;
    const human = HUMAN_NAME.toLowerCase();
    if (m.sender_kind === 'agent' && !asking && (m.mentions || []).includes(human) && /\?/.test(m.content)) {
      // a plain "@human …?" message: list it too; numbered lines become the options
      const lines = String(m.content).split('\n');
      const opts = lines.map((l) => l.match(/^\s*(\d+)[.)]\s+(.+)$/)).filter(Boolean).map((x) => x[2].trim());
      const rec = opts.findIndex((o) => /recommend/i.test(o)) + 1;
      const q = lines.filter((l) => !/^\s*\d+[.)]\s+/.test(l)).join(' ').replace(new RegExp(`@${HUMAN_NAME}\\b`, 'gi'), '').replace(/\s+/g, ' ').trim().slice(0, 1000);
      const r = qq.ins.run(m.room_id, m.id, m.sender, q || m.content.slice(0, 1000), JSON.stringify(opts.map((o) => o.replace(/\s*\(?recommended[^)]*\)?\s*$/i, '').slice(0, 200)).slice(0, 8)), rec > 0 ? rec : 0, '', 0, 0, 'mention', Date.now());
      broadcastQuestion(r.lastInsertRowid);
    } else if (m.sender_kind === 'human') {
      // the human answered: a reply to the question's message, or a message to the agent that asked
      let q = m.reply_to ? qq.byMsg.get(m.reply_to) : null;
      if (!q) for (const name of m.mentions || []) { q = qq.openFrom.all(m.room_id, name).find((x) => x.message_id < m.id); if (q) break; }
      if (q) closeQuestion(q, 'answered', m.content, m.sender);
    }
  } catch (e) { console.error('questions', e); }
});
setInterval(() => {   // deadlines: the agent goes ahead with what it said it would do
  for (const q of qq.due.all(Date.now())) {
    closeQuestion(q, 'assumed', q.fallback, q.agent);
    watcherSay(q.room_id, `⏱ No answer to @${q.agent}'s question (#${q.message_id}), so it goes ahead with: ${q.fallback}`);
    const w = watcherFor(q.room_id);
    const agent = w?.agents.find((a) => a.toLowerCase() === q.agent.toLowerCase());
    if (agent) fireWake(q.room_id, agent, { manual: true, reason: `No answer to your question #${q.message_id} by the deadline: go ahead with what you proposed (${q.fallback}).` });
  }
}, 15000).unref();
api.get('/questions', wrap(() => qq.list.all(Date.now() - 24 * 3600e3).map(questionView)));
api.post('/questions/:id/answer', wrap((req) => {
  const q = qq.get.get(Number(req.params.id));
  if (!q) throw new UserError('no such question');
  const answer = String(req.body?.answer || '').trim();
  if (!answer) throw new UserError('write an answer');
  // posted as the human's reply in the chat: that wakes the agent and closes the question
  postMessage({ room: q.room_id, sender: HUMAN_NAME, kind: 'human', content: `@${q.agent} ${answer}`, reply_to: q.message_id || undefined });
  if (qq.get.get(q.id).status === 'open') closeQuestion(q, 'answered', answer, HUMAN_NAME);
  return questionView(qq.get.get(q.id));
}));
api.post('/questions/:id/dismiss', wrap((req) => {
  const q = qq.get.get(Number(req.params.id));
  if (!q) throw new UserError('no such question');
  if (q.status === 'open') closeQuestion(q, 'dismissed', '', HUMAN_NAME);
  return questionView(qq.get.get(q.id));
}));

// ---------- needs attention: work that looks stuck ----------
const snoozes = new Map();   // roomId -> Map(key -> until)
function attention(roomId) {
  const w = watcherFor(roomId);
  const lim = { ...WAKE_DEFAULTS.attention, ...(wakeSettings(roomId).attention || {}) };
  const out = { room_id: roomId, watching: !!w, limits: lim, items: [], notes: [] };
  if (!w) return out;
  const now = Date.now(), min = 60e3;
  const tasks = taskViews(roomId);
  const agentOf = (n) => n && w.agents.find((a) => a.toLowerCase() === n.toLowerCase());
  const pane = (a) => (a ? w.panes[a] : null);
  const lead = agentOf(wakeSettings(roomId).lead);
  const snz = snoozes.get(roomId) || new Map();
  const add = (it) => { if ((snz.get(it.key) || 0) <= now) out.items.push(it); };
  for (const a of w.agents) {
    const p = pane(a);
    const since = w.approvalSince?.[a];
    if (lim.approval_wait && p?.state === 'approval' && since && now - since >= lim.approval_wait * min) {
      const t = tasks.find((x) => x.status === 'doing' && x.assignee.toLowerCase() === a.toLowerCase());
      add({ key: `approval:${a}`, kind: 'approval', agent: a, task_id: t?.id || 0, title: t?.title || '', detail: p.prompt || '', since });
    }
  }
  for (const t of tasks) {
    const a = agentOf(t.assignee), p = pane(a);
    if (t.status === 'doing' && lim.doing_quiet && a && p && p.state === 'idle') {
      const quietSince = Math.max(p.changed_at || 0, t.updated_at);
      if (now - quietSince >= lim.doing_quiet * min) add({ key: `stalled:${t.id}`, kind: 'stalled', task_id: t.id, title: t.title, agent: a, since: quietSince, started: t.updated_at, unblocks: t.unblocks });
    }
    if (t.status === 'review' && lim.review_wait && now - t.updated_at >= lim.review_wait * min) add({ key: `review:${t.id}`, kind: 'review', task_id: t.id, title: t.title, agent: lead || '', owner: t.assignee, since: t.updated_at });
    if (t.status === 'blocked' && lim.blocked_wait && now - t.updated_at >= lim.blocked_wait * min) {
      const q = t.assignee ? qq.openFrom.all(roomId, t.assignee)[0] : null;
      add({ key: `blocked:${t.id}`, kind: 'blocked', task_id: t.id, title: t.title, agent: t.assignee, detail: t.note || '', since: t.updated_at, question_id: q?.id || 0 });
    }
  }
  for (const a of w.agents) {   // idle agents: flag only when they have something they could be doing
    const p = pane(a);
    if (!p || p.state !== 'idle' || !lim.idle_ready || now - (p.changed_at || now) < lim.idle_ready * min) continue;
    const mine = tasks.filter((t) => t.assignee.toLowerCase() === a.toLowerCase() && t.status !== 'done');
    if (mine.some((t) => t.status === 'doing')) continue;   // covered by "stalled"
    const ready = mine.filter((t) => t.ready);
    if (ready.length) add({ key: `idle:${a}`, kind: 'idle', agent: a, task_id: ready[0].id, title: ready[0].title, since: p.changed_at });
    else if (mine.some((t) => t.waits_for.length)) out.notes.push({ agent: a, since: p.changed_at, waits_for: [...new Set(mine.flatMap((t) => t.waits_for))] });
  }
  const order = { approval: 0, stalled: 1, blocked: 2, review: 3, idle: 4 };
  out.items.sort((x, y) => order[x.kind] - order[y.kind] || x.since - y.since);
  return out;
}
const attnSig = new Map();
function refreshAttention(roomId) {
  const a = attention(roomId);
  const sig = JSON.stringify([a.watching, a.items.map((i) => i.key), a.notes.map((n) => n.agent), a.limits]);
  if (attnSig.get(roomId) === sig) return a;
  attnSig.set(roomId, sig);
  broadcast({ type: 'attention', attention: a });
  return a;
}
setInterval(() => { for (const roomId of watchers.keys()) try { refreshAttention(roomId); } catch (e) { console.error('attention', e); } }, 10000).unref();
api.get('/attention', wrap(() => [...watchers.keys()].map((r) => attention(r))));
api.get('/rooms/:id/attention', wrap((req) => attention(roomOf(req))));
api.post('/rooms/:id/attention/snooze', wrap((req) => {
  const roomId = roomOf(req);
  const key = String(req.body?.key || '').slice(0, 100);
  if (!key) throw new UserError('key is required');
  const mins = Math.min(Math.max(Number(req.body?.minutes) || 60, 1), 24 * 60);
  if (!snoozes.has(roomId)) snoozes.set(roomId, new Map());
  snoozes.get(roomId).set(key, Date.now() + mins * 60e3);
  attnSig.delete(roomId);
  return refreshAttention(roomId);
}));

// add one agent to a running project (the host helper creates it, starts it and tells the lead)
/** A validated new-agent spec for project `slug` (throws a UserError explaining what's wrong). */
function agentSpec(slug, b) {
  const roomId = `project:${slug}`;
  let src = '';
  if (b.clone_of) {   // a copy of a teammate: same CLI, model, role and instruction unless given here (the host reads them from its agent.json)
    src = teamMembers(roomId, [String(b.clone_of)])[0];
    if (!src) throw new UserError(`there's no agent @${cleanName(b.clone_of)} on this team to clone`);
  }
  const a = { name: cleanName(b.name) || (src ? freeName(roomId, src) : ''), tool: String(b.tool || b.cli || (src ? '' : 'claude')).toLowerCase(), model: String(b.model || '').trim(),
    role: String(b.role || '').trim().slice(0, 200), instruction: String(b.instruction || '').trim().slice(0, 2000), ...(src ? { clone_of: src } : {}) };
  if (!a.name) throw new UserError('the agent needs a name (letters, digits, . _ -)');
  const low = a.name.toLowerCase();
  if (RESERVED.has(low) || low === HUMAN_NAME.toLowerCase()) throw new UserError(`"${a.name}" is a reserved name`);
  const taken = q.getAgent.get(a.name);
  if (taken && !removedAgent(a.name)) throw new UserError((taken.project || '').toLowerCase() === slug ? `@${a.name} is already on this team` : `the name @${a.name} is already used in project ${taken.project || 'general'}; agent names are unique across TropaAI`);
  if ((watcherFor(roomId)?.agents || []).some((n) => n.toLowerCase() === low)) throw new UserError(`@${a.name} is already on this team`);
  if (!(src && !a.tool) && !CLI_TOOLS.includes(a.tool)) throw new UserError(`CLI must be ${CLI_TOOLS.join(', ')}`);
  if (a.tool === 'gemini' && /^(ollama|openrouter)\//.test(a.model)) throw new UserError('Gemini CLI only runs Google\'s Gemini models');
  if (a.model && !/^[A-Za-z0-9._:/@-]{1,80}$/.test(a.model)) throw new UserError('invalid model id');
  return a;
}
/** "<base>-2", "<base>-3"… : the first name not used by any agent (or pending request) */
function freeName(roomId, base) {
  const stem = base.replace(/-\d+$/, '');
  const used = (n) => q.getAgent.get(n) || (watcherFor(roomId)?.agents || []).some((x) => x.toLowerCase() === n.toLowerCase())
    || [...agentReqs.values()].some((r) => r.status === 'requested' && r.agent.name.toLowerCase() === n.toLowerCase());
  for (let i = 2; i < 100; i++) { const n = `${stem}-${i}`.slice(0, 40); if (!used(n)) return n; }
  return '';
}
function queueAddAgent(roomId, slug, a, { start = true, trust = true } = {}) {
  if (!hostOnline()) throw new UserError('the tropa host helper is not running on your machine — start it with: tropa host start');
  removedAgents.delete(a.name.toLowerCase());   // re-adding a removed name is allowed
  const job = { id: require('node:crypto').randomUUID(), type: 'add_agent', room_id: roomId, slug, agent: a,
    start: start !== false, trust: trust !== false, status: 'queued', log: [] };
  jobs.set(job.id, job);
  host.queue.push({ ...job, log: undefined });
  for (const f of [...host.waiters]) f();
  return job;
}
api.post('/projects/:slug/agents', wrap((req) => {
  if (!hostOnline()) throw new UserError('the tropa host helper is not running on your machine — start it with: tropa host start');
  const slug = slugify(req.params.slug);
  const roomId = `project:${slug}`;
  requireRoom(roomId);
  const b = req.body || {};
  const a = agentSpec(slug, b);
  const job = queueAddAgent(roomId, slug, a, { start: b.start, trust: b.trust });
  for (const r of agentReqs.values()) if (r.status === 'requested' && r.room_id === roomId && r.agent.name.toLowerCase() === a.name.toLowerCase()) settleAgentReq(r, 'approved');
  return { job: jobView(job) };
}));

// ---------- growing the team: the lead (or the human, by chat) asks for a new teammate ----------
// team_growth 'ask' → a request in the room the human approves or denies; 'auto' → added at once; 'off' → refused.
const agentReqs = new Map();   // id -> { id, room_id, slug, agent: spec, by, reason, status, created_at }
let agentReqSeq = 0;
const agentReqView = (r) => ({ id: r.id, room_id: r.room_id, agent: r.agent, by: r.by, reason: r.reason, status: r.status, created_at: r.created_at, message_id: r.message_id || 0 });
const postNote = (roomId, text) => { try { return postMessage({ room: roomId, sender: 'tropa', kind: 'system', content: text }).id; } catch (e) { console.error(e); return 0; } };
const agentReqChanged = (r) => broadcast({ type: 'agent_request', request: agentReqView(r) });
const autoSpawns = new Map();   // roomId -> times the lead's requests were added automatically (rate limit)
function autoSpawnsLastHour(roomId) {
  const list = (autoSpawns.get(roomId) || []).filter((t) => Date.now() - t < 3600e3);
  autoSpawns.set(roomId, list);
  return list;
}
function agentDesc(a) {
  if (a.clone_of && !a.tool) return `@${a.name} (a copy of @${a.clone_of}${a.model ? `, on ${a.model}` : ''})${a.role ? `, ${a.role}` : ''}`;
  return `@${a.name} (${a.tool}${a.model ? ' · ' + a.model : ''})${a.role ? `, ${a.role}` : ''}${a.clone_of ? ` (copy of @${a.clone_of})` : ''}`;
}
function settleAgentReq(r, status) { r.status = status; agentReqChanged(r); }
function wakeAgentReq(r, text) {
  if (!r.by || r.by.toLowerCase() === HUMAN_NAME.toLowerCase() || !watcherFor(r.room_id)) return;
  try { fireWake(r.room_id, r.by, { manual: true, reason: text.slice(0, 300) }); } catch (e) { console.error(e); }
}
/** Ask for a new teammate. Returns { status: 'added' | 'requested', request?, job? }. */
function requestAgent(roomId, spec, { by, reason, human = false }) {
  const slug = roomId.slice('project:'.length);
  const s = wakeSettings(roomId);
  if (!human && s.team_growth === 'off') throw new UserError(`adding teammates is turned off for this project; ask @${HUMAN_NAME} in the room instead`);
  const a = agentSpec(slug, spec);
  const dup = [...agentReqs.values()].find((r) => r.room_id === roomId && r.status === 'requested' && r.agent.name.toLowerCase() === a.name.toLowerCase());
  if (dup) return { status: 'requested', request: dup, existing: true };
  // automatic adds are rate-limited: past auto_agents_per_hour in the last hour, the request waits for the human instead
  const limit = Math.max(0, Number(s.auto_agents_per_hour ?? 2) || 0);
  const recent = autoSpawnsLastHour(roomId);
  const overLimit = !human && s.team_growth === 'auto' && recent.length >= limit;
  if (human || (s.team_growth === 'auto' && !overLimit)) {
    const job = queueAddAgent(roomId, slug, a);
    if (!human) recent.push(Date.now());
    shareNote(roomId, `➕ ${human ? HUMAN_NAME : '@' + by} is adding ${agentDesc(a)}${reason ? `: ${reason}` : ''}. It starts in a few seconds.` +
      (!human ? ` (${recent.length} of ${limit} automatic adds this hour)` : ''));
    return { status: 'added', job };
  }
  const r = { id: ++agentReqSeq, room_id: roomId, slug, agent: a, by, reason: String(reason || '').slice(0, 300), status: 'requested', created_at: Date.now(), over_limit: overLimit };
  agentReqs.set(r.id, r);
  r.message_id = postNote(roomId, `🧑‍🤝‍🧑 **@${by} asks to add a teammate:** ${agentDesc(a)}\n` +
    (overLimit ? `⏸ It already added ${recent.length} agent${recent.length === 1 ? '' : 's'} automatically in the last hour (the limit is ${limit}), so this one waits for you.\n` : '') +
    `${r.reason ? `Why: ${r.reason}\n` : ''}${a.instruction ? `First instruction: ${a.instruction.slice(0, 300)}\n` : ''}` +
    `@${HUMAN_NAME}: approve with the button, or reply \`@tropa approve agent ${r.id}\` / \`@tropa deny agent ${r.id}\`.`);
  agentReqChanged(r);
  return { status: 'requested', request: r };
}
function approveAgentReq(r, edits = {}) {
  if (r.status !== 'requested') throw new UserError(`request #${r.id} is ${r.status}, not waiting for approval`);
  const a = agentSpec(r.slug, { ...r.agent, ...Object.fromEntries(Object.entries(edits).filter(([, v]) => v !== undefined && v !== '')) });
  queueAddAgent(r.room_id, r.slug, a);
  r.agent = a; settleAgentReq(r, 'approved');
  shareNote(r.room_id, `✅ ${HUMAN_NAME} approved ${agentDesc(a)}. Starting it…`);
  wakeAgentReq(r, `${HUMAN_NAME} approved @${a.name} (request #${r.id}); it's starting now and joins the room in a few seconds. Give it its first assignment with an @mention.`);
  return r;
}
// Approving or denying in plain words: "approve backend2", "yes add it" in reply to the request (or to the lead's
// message that names it). The buttons and "@tropa approve agent N" still work; this catches everything else.
const REQ_YES = /\b(approved?|approves|yes|ok(?:ay)?|go ahead|accept(?:ed)?|add (?:it|them|him|her))\b/i;
const REQ_NO = /\b(deny|denied|reject(?:ed)?|decline[d]?|don'?t add|do not add)\b/i;
function agentReqReply(m) {
  if (!m.room_id.startsWith('project:')) return false;
  const pending = [...agentReqs.values()].filter((r) => r.room_id === m.room_id && r.status === 'requested');
  if (!pending.length) return false;
  const text = String(m.content);
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = pending.filter((r) => new RegExp(`(?<![A-Za-z0-9._-])@?${esc(r.agent.name)}(?![A-Za-z0-9_-])`, 'i').test(text)
    || new RegExp(`\\b(?:agent\\s+)?request\\s*#?${r.id}\\b`, 'i').test(text));
  let hits = named;
  if (!hits.length && m.reply_to) {   // a reply to the request card, or to a message that names exactly one pending request
    const parent = q.getMsg.get(Number(m.reply_to));
    hits = pending.filter((r) => r.message_id === Number(m.reply_to));
    if (!hits.length && parent) {
      const inParent = pending.filter((r) => new RegExp(`(?<![A-Za-z0-9._-])@?${esc(r.agent.name)}(?![A-Za-z0-9_-])`, 'i').test(parent.content));
      if (inParent.length === 1) hits = inParent;
    }
  }
  if (!hits.length) return false;
  const yes = REQ_YES.test(text), no = REQ_NO.test(text);
  if (yes === no) return false;   // neither, or both: not a clear answer
  for (const r of hits) {
    try { if (yes) approveAgentReq(r); else denyAgentReq(r); } catch (e) { shareNote(m.room_id, `⚠️ ${e.message}`); }
  }
  return true;
}
function denyAgentReq(r, why) {
  if (r.status !== 'requested') throw new UserError(`request #${r.id} is ${r.status}, not waiting for approval`);
  settleAgentReq(r, 'denied');
  shareNote(r.room_id, `🚫 ${HUMAN_NAME} didn't add @${r.agent.name}${why ? `: ${why}` : ''}.`);
  wakeAgentReq(r, `Your request to add @${r.agent.name} was denied${why ? `: ${why}` : ''}. Carry on with the current team.`);
  return r;
}
const agentReqOf = (req) => { const r = agentReqs.get(Number(req.params.id)); if (!r) throw new UserError('unknown request'); return r; };
api.get('/agent-requests', wrap((req) => {
  const room = req.query.room ? normalizeRoomId(String(req.query.room)) : '';
  return [...agentReqs.values()].filter((r) => !room || r.room_id === room).map(agentReqView);
}));
api.post('/agent-requests/:id/approve', wrap((req) => agentReqView(approveAgentReq(agentReqOf(req), req.body || {}))));
api.post('/agent-requests/:id/deny', wrap((req) => agentReqView(denyAgentReq(agentReqOf(req), String(req.body?.reason || '').slice(0, 200)))));

// ---------- shrinking the team: the human (always confirmed) or the lead (per team_shrink) removes agents ----------
const rmReqs = new Map();   // id -> { id, room_id, names, by, reason, status, message_id, created_at }
let rmReqSeq = 0;
const rmReqView = (r) => ({ id: r.id, room_id: r.room_id, names: r.names, by: r.by, reason: r.reason, status: r.status, message_id: r.message_id || 0, created_at: r.created_at });
const rmReqChanged = (r) => broadcast({ type: 'removal_request', request: rmReqView(r) });
const atList = (names) => names.map((n) => '@' + n).join(', ');
/** Names in `words` that are agents on this room's team (case-insensitive), in their real spelling. */
function teamMembers(roomId, words) {
  const slug = roomId.slice('project:'.length).toLowerCase();
  const team = new Map((watcherFor(roomId)?.agents || []).map((n) => [n.toLowerCase(), n]));
  for (const a of q.listAgents.all()) if ((a.project || '').toLowerCase() === slug) team.set(a.name.toLowerCase(), a.name);
  return [...new Set(words.map((w) => team.get(String(w).replace(/^@/, '').toLowerCase())).filter(Boolean))];
}
function askRemoval(roomId, names, { by, reason }) {
  const dup = [...rmReqs.values()].find((r) => r.room_id === roomId && r.status === 'requested' && r.names.join() === names.join());
  if (dup) return dup;
  const r = { id: ++rmReqSeq, room_id: roomId, names, by, reason: String(reason || '').slice(0, 300), status: 'requested', created_at: Date.now() };
  rmReqs.set(r.id, r);
  const who = by.toLowerCase() === HUMAN_NAME.toLowerCase() ? 'Remove' : `**@${by} asks to remove**`;
  r.message_id = postNote(roomId, `🗑 ${who === 'Remove' ? `**Remove ${atList(names)} from the team?**` : `${who} ${atList(names)}`}${r.reason ? `\nWhy: ${r.reason}` : ''}\n` +
    `They stop, leave the room, and their folders move to agents/.removed/. Their messages and token usage stay. ` +
    `@${HUMAN_NAME}: confirm with the button, or reply \`@tropa confirm remove ${r.id}\` / \`@tropa cancel remove ${r.id}\`.`);
  rmReqChanged(r);
  return r;
}
function doRemoval(roomId, names, { by, reason }) {
  const done = [], failed = [];
  for (const n of names) { try { removeAgentNow(n); done.push(n); } catch (e) { failed.push(`${n} (${e.message})`); } }
  shareNote(roomId, `🗑 ${by.toLowerCase() === HUMAN_NAME.toLowerCase() ? HUMAN_NAME : '@' + by} removed ${atList(done) || 'nobody'}${reason ? `: ${reason}` : ''}.` +
    `${failed.length ? ` Couldn't remove ${failed.join(', ')}.` : ''} Their messages and usage are kept.`);
  return { done, failed };
}
function confirmRemoval(r) {
  if (r.status !== 'requested') throw new UserError(`removal #${r.id} is ${r.status}`);
  r.status = 'confirmed'; rmReqChanged(r);
  const res = doRemoval(r.room_id, r.names, { by: HUMAN_NAME, reason: r.reason });
  if (r.by.toLowerCase() !== HUMAN_NAME.toLowerCase()) wakeAgentReq({ ...r, room_id: r.room_id }, `${HUMAN_NAME} confirmed: removed ${atList(res.done)}. Reassign their open tasks.`);
  return r;
}
function cancelRemoval(r) {
  if (r.status !== 'requested') throw new UserError(`removal #${r.id} is ${r.status}`);
  r.status = 'cancelled'; rmReqChanged(r);
  shareNote(r.room_id, `↩ Kept ${atList(r.names)} (removal cancelled).`);
  if (r.by.toLowerCase() !== HUMAN_NAME.toLowerCase()) wakeAgentReq(r, `${HUMAN_NAME} kept ${atList(r.names)}; don't remove them.`);
  return r;
}
const rmReqOf = (req) => { const r = rmReqs.get(Number(req.params.id)); if (!r) throw new UserError('unknown removal request'); return r; };
api.get('/removal-requests', wrap((req) => {
  const room = req.query.room ? normalizeRoomId(String(req.query.room)) : '';
  return [...rmReqs.values()].filter((r) => !room || r.room_id === room).map(rmReqView);
}));
api.post('/removal-requests/:id/confirm', wrap((req) => rmReqView(confirmRemoval(rmReqOf(req)))));
api.post('/removal-requests/:id/cancel', wrap((req) => rmReqView(cancelRemoval(rmReqOf(req)))));

// The human asks in plain words ("remove agentx and agenty from the room", "@tropa remove agentx agenty"):
// always confirmed first. The message isn't passed to the agents, so the lead doesn't act on it at the same time.
const RM_CMD = /@tropa\s+(confirm|cancel)\s+remov(?:e|al)\s+#?(\d{1,6})/i;
const RM_ASK = /^\s*(?:@tropa\s+)?(?:please\s+)?(?:remove|kick|drop)\s+(.{1,300}?)(?:\s+from\s+(?:the\s+)?(?:room|team|project|chat))?\s*[.!]?\s*$/i;
function removalCommand(m) {
  const c = String(m.content).match(RM_CMD);
  if (c) {
    try {
      const r = rmReqs.get(Number(c[2]));
      if (!r || r.room_id !== m.room_id) throw new UserError(`no removal #${c[2]} in this room`);
      if (c[1].toLowerCase() === 'confirm') confirmRemoval(r); else cancelRemoval(r);
    } catch (e) { shareNote(m.room_id, `⚠️ ${e.message}`); }
    return true;
  }
  const text = String(m.content);
  const ask = text.match(RM_ASK);
  if (!ask || !m.room_id.startsWith('project:')) return false;
  const explicit = /^\s*@tropa\b/i.test(text) || /\sfrom\s+(?:the\s+)?(?:room|team|project|chat)\s*[.!]?\s*$/i.test(text);
  const names = teamMembers(m.room_id, ask[1].split(/[\s,]+|\band\b/i).filter(Boolean));
  if (!names.length) { if (explicit) shareNote(m.room_id, `⚠️ No agent on this team matches "${ask[1].slice(0, 80)}".`); return explicit; }
  if (!explicit && names.length !== ask[1].split(/[\s,]+|\band\b/i).filter((w) => w && !/^(the|agents?|@?all)$/i.test(w)).length) return false;   // "remove the old code" etc.
  askRemoval(m.room_id, names, { by: HUMAN_NAME, reason: '' });
  return true;
}

// chat: @tropa approve agent 3 · @tropa deny agent 3 · @tropa add agent NAME [cli] [model] [: role]
const AGENT_CMD = /@tropa\s+(?:(approve|deny)\s+agent\s+#?(\d{1,6})|add\s+agent\s+@?([A-Za-z0-9._-]{1,40})(?:\s+(claude|codex|opencode|qwen|gemini)\b)?(?:\s+(?![:—-])([A-Za-z0-9._:/@-]{1,81}))?\s*(?:[:—-]\s*)?([^\n]*))/i;
const CLONE_CMD = /@tropa\s+clone\s+@?([A-Za-z0-9._-]{1,40})(?:\s+as\s+@?([A-Za-z0-9._-]{1,40}))?(?:\s+(?:on\s+)?([A-Za-z0-9._:/@-]{1,80}))?/i;
function agentCommand(m) {
  const k = String(m.content).match(CLONE_CMD);
  if (k) {
    try {
      if (!m.room_id.startsWith('project:')) throw new UserError('agents are cloned in project rooms');
      requestAgent(m.room_id, { clone_of: k[1], name: k[2] || '', model: k[3] || '' }, { by: HUMAN_NAME, human: true });
    } catch (e) { shareNote(m.room_id, `⚠️ ${e.message}`); }
    return true;
  }
  const c = String(m.content).match(AGENT_CMD);
  if (!c) return false;
  try {
    if (!m.room_id.startsWith('project:')) throw new UserError('agents are added to project rooms');
    if (c[1]) {
      const r = agentReqs.get(Number(c[2]));
      if (!r || r.room_id !== m.room_id) throw new UserError(`no agent request #${c[2]} in this room`);
      if (c[1].toLowerCase() === 'approve') approveAgentReq(r); else denyAgentReq(r);
    } else {
      requestAgent(m.room_id, { name: c[3], tool: c[4] || 'claude', model: (c[5] || '').replace(/:$/, ''), role: (c[6] || '').trim() }, { by: HUMAN_NAME, human: true });
    }
  } catch (e) { shareNote(m.room_id, `⚠️ ${e.message}`); }
  return true;
}

// start (or restart the watcher of) a project's team from the chat: the host helper runs start_agent.sh --all and the watcher
api.post('/rooms/:id/start', wrap((req) => {
  const roomId = roomOf(req);
  if (!roomId.startsWith('project:')) throw new UserError('only project rooms have a team');
  const slug = roomId.slice('project:'.length);
  if (!hostOnline()) throw new UserError('the tropa host helper is not running on your machine — start it with: tropa host start');
  const job = { id: require('node:crypto').randomUUID(), type: 'start_team', room_id: roomId, slug, status: 'queued', log: [] };
  jobs.set(job.id, job);
  host.queue.push({ ...job, log: undefined });
  for (const f of [...host.waiters]) f();
  return { job: jobView(job) };
}));

// delete a whole project: its room (messages, cursors, wake settings) and optionally its agents
api.delete('/projects/:slug', wrap((req) => {
  const slug = slugify(req.params.slug);
  const roomId = `project:${slug}`;
  const room = q.getRoom.get(roomId);
  const agents = req.query.agents === '1' || req.query.agents === 'true'
    ? q.listAgents.all().filter((a) => (a.project || '').toLowerCase() === slug) : [];
  if (!room && !agents.length) throw new UserError(`project "${slug}" not found`);
  const stop = true;   // a deleted room can't keep a team: its watcher is told to stop on its next poll
  qd.put.run(slug, Date.now());
  for (const sh of shares.values()) if (sh.room_id === roomId && SHARE_LIVE.includes(sh.status)) stopShare(sh, 'project deleted');
  const tmux = watchers.get(roomId)?.tmux || '';
  if (stop && hostOnline()) {   // the watcher stops its own session on its next poll; the host helper makes sure
    host.queue.push({ id: `stop-${slug}-${Date.now()}`, type: 'stop_project', slug, tmux_session: tmux });
    for (const f of [...host.waiters]) f();
  }
  tq.delRoomEvents.run(roomId); tq.delRoom.run(roomId); qq.delRoom.run(roomId);
  if (room) { purgeRoomFiles(roomId); q.deleteRoom.run(roomId); broadcast({ type: 'room_deleted', room_id: roomId }); }
  for (const a of agents) { q.deleteAgent.run(a.name); broadcast({ type: 'agent_deleted', name: a.name }); }
  watchers.delete(roomId);
  for (const k of [...docCache.keys()]) if (k.startsWith(roomId + '\0')) dropDocCache(k);
  for (const k of [...wakeState.keys()]) if (k.startsWith(roomId + '\0')) { clearTimeout(wakeState.get(k).timer); wakeState.delete(k); }
  return { ok: true, room_deleted: !!room, agents_deleted: agents.map((a) => a.name), team_stopping: stop };
}));

app.use('/api', api);

app.get('/health', (req, res) => res.json({ ok: true, app: 'tropa-ai', version: PKG_VERSION, features: ['team', 'wake-routing', 'project-delete', 'files', 'host', 'shares', 'usage', 'docs'] }));
// Markdown rendering for the docs viewer, served from node_modules (no CDN needed)
const VENDOR = { 'marked.js': 'marked/lib/marked.umd.js', 'purify.js': 'dompurify/dist/purify.min.js' };
app.get('/vendor/:file', (req, res) => {
  const f = VENDOR[req.params.file];
  if (!f) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=86400').type('text/javascript').sendFile(path.join(__dirname, 'node_modules', f));
});
app.get('/agent-guide.md', (req, res) => res.type('text/markdown').sendFile(path.join(__dirname, 'AGENT_GUIDE.md')));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
server.requestTimeout = 0; // allow long-polls
server.headersTimeout = 120000;

// ---------- WebSocket (monitor UI) ----------
const wss = new WebSocketServer({ server, path: '/ws' });
function broadcast(event) {
  const data = JSON.stringify(event);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}
wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin) && !(process.env.ALLOWED_ORIGINS || '').split(',').includes(origin)) {
    ws.close(1008, 'origin not allowed'); return;
  }
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ type: 'hello' }));
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
  // refresh online flags for the UI
  broadcast({ type: 'agents', agents: q.listAgents.all().map(agentView) });
}, 30000).unref();

server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  console.log(`TropaAI chat listening on http://localhost:${PORT}  (MCP: /mcp, API: /api, UI: /)`);
});

function shutdown() { server.close(); try { db.close(); } catch {} process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { systemMessage };
