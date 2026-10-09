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
const TZ = process.env.TZ || 'Asia/Manila';
const HUMAN_NAME = process.env.HUMAN_NAME || 'Mark';
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
  return r && { ...r, mentions: JSON.parse(r.mentions || '[]'), created_iso: new Date(r.created_at).toISOString() };
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
function postMessage({ room, sender, kind = 'agent', content, reply_to }) {
  const roomId = normalizeRoomId(room);
  const text = String(content ?? '').trim();
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
  return `[#${m.id} ${m.room_id} ${fmtTime(m.created_at)}${reply}] ${who}: ${m.content}`;
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
  return postMessage({ room: req.params.id, sender, kind, content: req.body.content, reply_to: req.body.reply_to });
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
    sendTranscript(res, { rooms: [room], msgs: q.allMsgsRoom.all(room.id), title: `AI-IRC transcript — ${label}`,
      slug: room.id.replace(':', '-'), format: req.query.format });
  } catch (e) {
    if (e instanceof UserError) return res.status(400).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'internal error' });
  }
});
api.get('/transcript', (req, res) => {
  try {
    sendTranscript(res, { rooms: q.listRooms.all(), msgs: q.allMsgs.all(), title: 'AI-IRC transcript — all rooms',
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
app.use('/api', api);

app.get('/health', (req, res) => res.json({ ok: true }));
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
  console.log(`AI-IRC listening on http://localhost:${PORT}  (MCP: /mcp, API: /api, UI: /)`);
});

function shutdown() { server.close(); try { db.close(); } catch {} process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { systemMessage };
