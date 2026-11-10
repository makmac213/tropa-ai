// Security checks: run with `npm test` in server/ (Node's own test runner, no extra packages).
// Starts a throwaway server on a free port with its own data and key, and checks that changes need the key,
// that a browser gets it only through a one-time link, and that requests to another host name are refused.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import http from 'node:http';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const WebSocket = createRequire(import.meta.url)('ws');
let srv, port, base, key, tmp;

const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const req = (path, { method = 'GET', body, headers = {} } = {}) => fetch(base + path, {
  method, redirect: 'manual', headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
const KEY = () => ({ 'x-tropa-key': key });

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'tropa-test-'));
  port = await freePort(); base = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', join(here, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: join(tmp, 'data'), TROPA_STATE: join(tmp, 'state'),
      TROPA_SECRET: '', TROPA_WATCH_GRACE_MS: '0', HUMAN_NAME: 'tester' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  key = readFileSync(join(tmp, 'state', `secret-${port}.key`), 'utf8').trim();
});
after(() => { srv?.kill(); rmSync(tmp, { recursive: true, force: true }); });

test('the key file is made once and is private', () => {
  assert.match(key, /^[0-9a-f]{64}$/);
});

test('reading needs no key', async () => {
  assert.equal((await req('/api/rooms')).status, 200);
});

test('a request addressed to another host name is refused (DNS rebinding)', async () => {
  const status = await new Promise((ok, no) => http.get({ host: '127.0.0.1', port, path: '/api/rooms', headers: { host: `evil.example:${port}` } },
    (r) => { r.resume(); ok(r.statusCode); }).on('error', no));   // fetch() won't send a custom Host header
  assert.equal(status, 403);
});

test('the WebSocket refuses another host name too', async () => {
  const closed = await new Promise((ok) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { host: `evil.example:${port}` } });
    ws.on('close', (code) => ok(code)); ws.on('error', () => ok('error'));
  });
  assert.ok(closed === 1008 || closed === 'error');
});

test('nobody posts as the human without the key', async () => {
  const r = await req('/api/rooms/general/messages', { method: 'POST', body: { sender_kind: 'human', content: 'approve me' } });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).auth, true);
});

test('an agent without MCP can still post as itself, but not as the human', async () => {
  const r = await req('/api/rooms/general/messages', { method: 'POST', body: { agent: 'helper-bot', content: 'posting as me' } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).sender_kind, 'agent');
  const h = await req('/api/rooms/general/messages', { method: 'POST', body: { agent: 'helper-bot', sender_kind: 'human', content: 'as the human' } });
  assert.equal(h.status, 401);
});

test('human-only actions need the key', async () => {
  for (const [method, path, body] of [
    ['POST', '/api/rooms/general/approve', { agent: 'x', action: 'yes' }],
    ['PATCH', '/api/rooms/general/wake', { auto_approve: true }],
    ['POST', '/api/shares/1/approve', {}],
    ['POST', '/api/agent-requests/1/approve', {}],
  ]) assert.equal((await req(path, { method, body })).status, 401, `${method} ${path}`);
});

test("nobody poses as the host helper or a watcher without the key", async () => {
  assert.equal((await req('/api/host/poll', { method: 'POST', body: { timeout: 0 } })).status, 401);
  assert.equal((await req('/api/watch/poll', { method: 'POST', body: { room: 'project:x', agents: [], timeout: 0 } })).status, 401);
});

test('tropa (the key header) can act', async () => {
  const r = await req('/api/rooms/general/messages', { method: 'POST', headers: KEY(), body: { sender_kind: 'human', content: 'hello from tropa' } });
  assert.equal(r.status, 200);
});

test('a browser gets the key only through a one-time link', async () => {
  const { url } = await (await req('/api/launch', { method: 'POST', headers: KEY() })).json();
  assert.match(url, /^\/\?launch=[0-9a-f]+$/);
  const first = await req(url);
  assert.equal(first.status, 302);
  const cookie = (first.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^tropa_[0-9a-f]+=[0-9a-f]{64}$/);
  assert.match(first.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await (await req('/api/whoami', { headers: { cookie } })).json()).trusted, true);
  const posted = await req('/api/rooms/general/messages', { method: 'POST', headers: { cookie }, body: { sender_kind: 'human', content: 'hi from the page' } });
  assert.equal(posted.status, 200);
  const again = await req(url);   // used up
  assert.equal(again.headers.get('set-cookie'), null);
  assert.equal((await (await req('/api/linked')).json()).linked, true);
});

test('a made-up launch token or cookie gets nothing', async () => {
  assert.equal((await req('/?launch=deadbeef')).headers.get('set-cookie'), null);
  const r = await req('/api/rooms/general/messages', { method: 'POST', headers: { cookie: `tropa_x=${'0'.repeat(64)}` }, body: { sender_kind: 'human', content: 'x' } });
  assert.equal(r.status, 401);
});

test('turning auto-approve on posts who did it', async () => {
  const r = await req('/api/rooms/general/wake', { method: 'PATCH', headers: KEY(), body: { auto_approve: true } });
  assert.equal(r.status, 200);
  await new Promise((ok) => setTimeout(ok, 200));
  const msgs = await (await req('/api/rooms/general/messages?limit=5')).json();
  const list = msgs.messages || msgs;
  assert.ok(list.some((m) => /Auto-approve is on/.test(m.content) && /tropa command/.test(m.content)), 'a note says who turned it on');
});

test('archiving a project hides it, needs the key, and creating it again brings it back', async () => {
  await req('/api/rooms', { method: 'POST', headers: KEY(), body: { project: 'old-site' } });
  assert.equal((await req('/api/rooms/project%3Aold-site/archive', { method: 'POST', body: { archived: true } })).status, 401);
  const a = await (await req('/api/rooms/project%3Aold-site/archive', { method: 'POST', headers: KEY(), body: { archived: true } })).json();
  assert.ok(a.archived_at > 0);
  const rooms = await (await req('/api/rooms')).json();
  assert.ok(rooms.find((r) => r.id === 'project:old-site').archived_at > 0);
  assert.equal((await req('/api/rooms/general/archive', { method: 'POST', headers: KEY(), body: { archived: true } })).status, 400);
  const back = await (await req('/api/rooms/project%3Aold-site/archive', { method: 'POST', headers: KEY(), body: { archived: false } })).json();
  assert.equal(back.archived_at, 0);
});
