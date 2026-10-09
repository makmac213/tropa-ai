'use strict';
/*
 * AI-IRC — a chat service for Claude agents.
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
const HUMAN_NAME = process.env.HUMAN_NAME || 'human';
const KOKORO_URL = (process.env.KOKORO_URL || 'http://kokoro:8880').replace(/\/+$/, '');
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
    is_image: /^image\//.test(a.mime), url: `/api/files/${a.id}` };
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

function ensureRoom(roomId, topic = '') {
  const existing = q.getRoom.get(roomId);
  if (existing) return existing;
  const project = roomId.startsWith('project:') ? roomId.slice(8) : null;
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

function registerAgent({ name, project, description }) {
  const n = cleanName(name);
  if (!n) throw new UserError('agent name is required (letters, digits, . _ -)');
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
function renameAgent(oldName, newName) {
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
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const renamed = q.getAgent.get(n);
  broadcast({ type: 'agent_renamed', old_name: a.name, agent: agentView(renamed) });
  for (const roomId of agentRoomIds(renamed)) {
    try { const m = systemMessage(roomId, `${a.name} is now known as ${n}`); markRead(n, roomId, m.id); } catch {}
  }
  return renamed;
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
const MCP_INSTRUCTIONS = `AI-IRC is a shared chat for Claude agents working in different sessions, and their human (${HUMAN_NAME}).
Rooms: "general" (all agents, any project) and "project:<slug>" (only agents working on that project).
Workflow:
1. Call register once at the start with a short, stable agent name (e.g. "api-backend"), your project slug, and who you are: provider (e.g. "Claude Code", "Codex", "OpenCode") and model (e.g. "claude-opus-4-5"). This joins you to general + your project room. To change your name later, use rename (don't register a second name). To switch project, call register again with the same name and the new project.
2. Call check_inbox when you start a task, before handing off, and whenever you finish a chunk of work.
3. Use send_message to hand off work, ask another agent a question, or report status. Mention agents with @name and the human with @${HUMAN_NAME}. Keep messages self-contained: include file paths, decisions, and next steps so the reader doesn't need your context.
4. Use wait_for_messages when you are blocked waiting for a reply.
5. Files: attachments in messages are shown as "📎 <path>" — that path is inside the project folder, read it there. To show the human or the team a file (mockup, screenshot, PDF, doc), save it in the project and call share_file with its path.
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
      const a = renameAgent(agentName, args.new_name);
      return `You are now "${a.name}". Pass agent:"${a.name}" in every call from now on.`;
    }
    case 'share_file': {
      const a = agent();
      const msg = shareFile({ room: args.room, agent: a.name, path: args.path, content: args.content, reply_to: args.reply_to });
      return `Shared ${args.path} as #${msg.id}. The watcher uploads it from the project folder in a few seconds.`;
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
        serverInfo: { name: 'ai-irc', version: '1.0.0' },
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
  const room = ensureRoom(roomId, req.body.topic);
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
  const filename = `ai-irc_${slug}_${p.date}_${p.time.replace(':', '')}.${fmt}`;
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
      : refused ? 'Kokoro container is not reachable — is it running? (docker compose ps)'
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
api.delete('/agents/:name', wrap((req) => {
  q.deleteAgent.run(req.params.name);
  broadcast({ type: 'agent_deleted', name: req.params.name });
  return { ok: true };
}));
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
// AI-IRC decides who to wake. A watcher on the host (tropa's room_watcher.py) long-polls
// /api/watch/poll for wake/command events, types them into the agents' tmux windows,
// and streams each agent's screen back here for the monitor's Team view.
db.exec(`CREATE TABLE IF NOT EXISTS room_wake (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  settings TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT 0)`);
const WAKE_DEFAULTS = { lead: '', wake: 'auto', wake_rules: 'smart', max_wakes_per_agent_per_hour: 0,
  cooldown_seconds: 20, debounce_seconds: 2, history_limit: 20 };
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
  if ('wake' in patch) {
    if (!['auto', 'paused'].includes(patch.wake)) throw new UserError('wake must be "auto" or "paused"');
    out.wake = patch.wake;
  }
  if ('wake_rules' in patch) {
    if (!['smart', 'all'].includes(patch.wake_rules)) throw new UserError('wake_rules must be "smart" or "all"');
    out.wake_rules = patch.wake_rules;
  }
  for (const [k, lo, hi] of [['max_wakes_per_agent_per_hour', 0, 1000], ['cooldown_seconds', 0, 3600],
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
    panes: w ? w.panes : {}, settings: wakeSettings(roomId) };
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
  return `[ai-irc] ${reason} Read your unread messages in ${roomId} (ai-irc read_messages, agent "${agent}", limit ${s.history_limit}). ` +
    'Follow AGENTS.md: act if you are mentioned or needed, otherwise stay silent.';
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

// watcher endpoints
api.post('/watch/poll', wrap(async (req, res) => {
  const roomId = normalizeRoomId(req.body.room);
  ensureRoom(roomId);
  const w = watcherRecord(roomId);
  const wasOn = !!watcherFor(roomId);
  w.seen = Date.now();
  const agents = (Array.isArray(req.body.agents) ? req.body.agents : []).map(cleanName).filter(Boolean);
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
  return { events: w.queue.splice(0), settings: wakeSettings(roomId), human: HUMAN_NAME,
    files: qa.pendingSync.all(roomId).map(attView), uploads: qa.pendingUpload.all(roomId).map(attView) };
}));
api.post('/watch/panes', wrap((req) => {
  const roomId = normalizeRoomId(req.body.room);
  const w = watcherRecord(roomId);
  w.seen = Date.now();
  const panes = req.body.panes && typeof req.body.panes === 'object' ? req.body.panes : {};
  for (const [name, p] of Object.entries(panes)) {
    const n = cleanName(name);
    if (!n || !p) continue;
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
const RESERVED = new Set(['controlcenter', 'watcher', 'tropa', 'all', 'here', 'team', 'everyone', 'system']);
api.get('/host', wrap(() => ({ connected: hostOnline(), ...host.info, human: HUMAN_NAME })));
api.post('/host/poll', wrap(async (req, res) => {
  const wasOn = hostOnline();
  host.seen = Date.now();
  host.info = { projects_dir: String(req.body.projects_dir || ''), home: String(req.body.home || ''), version: String(req.body.version || ''),
    clis: Array.isArray(req.body.clis) ? req.body.clis.map(String).slice(0, 10) : [],
    models: Object.fromEntries(['claude', 'opencode', 'qwen', 'codex'].map((t) => [t, (Array.isArray(req.body.models?.[t]) ? req.body.models[t] : [])
      .map((m) => (typeof m === 'string' ? { id: m, label: '' } : { id: String(m?.id || ''), label: String(m?.label || '').slice(0, 120) }))
      .filter((m) => /^[A-Za-z0-9._:/@-]{1,100}$/.test(m.id)).slice(0, 500)])),
    folders: (Array.isArray(req.body.folders) ? req.body.folders : []).slice(0, 500)
      .filter((f) => /^[A-Za-z0-9._-]{1,60}$/.test(String(f?.name || '')))
      .map((f) => ({ name: String(f.name), kit: !!f.kit, git: !!f.git, slug: slugify(f.slug || f.name) })) };
  if (!wasOn) broadcast({ type: 'host', host: { connected: true, ...host.info } });
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
  return { jobs: host.queue.splice(0) };
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
  const folder = String(b.folder || slug).trim();
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(folder) || /^\.+$/.test(folder)) throw new UserError('folder must be a simple name (letters, digits, . _ -)');
  const brief = String(b.brief || '').slice(0, MAX_CONTENT - 500);
  const existing = !!b.existing;
  if (existing && !(host.info.folders || []).some((f) => f.name === folder)) throw new UserError(`no folder "${folder}" in ${host.info.projects_dir || 'the projects folder'}`);
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
    if (!['claude', 'opencode', 'qwen', 'codex'].includes(a.tool)) throw new UserError(`${a.name}: CLI must be claude, opencode, qwen or codex`);
    if (a.model && !/^[A-Za-z0-9._:/@-]{1,80}$/.test(a.model)) throw new UserError(`${a.name}: invalid model id`);
  }
  const lead = b.lead ? cleanName(b.lead) : '';
  if (lead && !seen.has(lead.toLowerCase())) throw new UserError('the lead must be one of the agents');
  const files = (Array.isArray(b.files) ? b.files : []).map(Number).filter(Boolean);
  const room = ensureRoom(roomId, String(b.topic || name || '').slice(0, 300));
  if (b.topic || name) { q.setTopic.run(String(b.topic || name).slice(0, 300), roomId); broadcast({ type: 'room', room: q.getRoom.get(roomId) }); }
  setWakeSettings(roomId, { lead });
  const intro = [existing ? `🧩 **Team added to existing project: ${name || slug}** (\`${folder}\`)` : `🆕 **New project: ${name || slug}**`, brief ? `\n${brief}` : '',
    files.length ? `\nFiles are saved in \`${ATT_DIR}/\`.` : ''].join('\n').trim();
  const msg = postMessage({ room: roomId, sender: HUMAN_NAME, kind: 'human', content: intro, attachments: files });
  const job = { id: require('node:crypto').randomUUID(), type: 'create_project', room_id: roomId, slug, name: name || slug, folder,
    brief, agents, lead, existing, start: b.start !== false, trust: b.trust !== false, kickoff: String(b.kickoff || '').slice(0, 4000),
    human: HUMAN_NAME, status: 'queued', log: [], message_id: msg.id };
  jobs.set(job.id, job);
  host.queue.push({ ...job, log: undefined });
  for (const f of [...host.waiters]) f();
  return { job: jobView(job), room: q.getRoom.get(roomId) || room };
}));

// delete a whole project: its room (messages, cursors, wake settings) and optionally its agents
api.delete('/projects/:slug', wrap((req) => {
  const slug = slugify(req.params.slug);
  const roomId = `project:${slug}`;
  const room = q.getRoom.get(roomId);
  const agents = req.query.agents === '1' || req.query.agents === 'true'
    ? q.listAgents.all().filter((a) => (a.project || '').toLowerCase() === slug) : [];
  if (!room && !agents.length) throw new UserError(`project "${slug}" not found`);
  if (room) { purgeRoomFiles(roomId); q.deleteRoom.run(roomId); broadcast({ type: 'room_deleted', room_id: roomId }); }
  for (const a of agents) { q.deleteAgent.run(a.name); broadcast({ type: 'agent_deleted', name: a.name }); }
  watchers.delete(roomId);
  for (const k of [...wakeState.keys()]) if (k.startsWith(roomId + '\0')) { clearTimeout(wakeState.get(k).timer); wakeState.delete(k); }
  return { ok: true, room_deleted: !!room, agents_deleted: agents.map((a) => a.name) };
}));

app.use('/api', api);

const PKG_VERSION = (() => { try { return require('./package.json').version; } catch { return ''; } })();
app.get('/health', (req, res) => res.json({ ok: true, app: 'ai-irc', version: PKG_VERSION, features: ['team', 'wake-routing', 'project-delete', 'files', 'host'] }));
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
  console.log(`TropaAI chat (AI-IRC) listening on http://localhost:${PORT}  (MCP: /mcp, API: /api, UI: /)`);
});

function shutdown() { server.close(); try { db.close(); } catch {} process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { systemMessage };
