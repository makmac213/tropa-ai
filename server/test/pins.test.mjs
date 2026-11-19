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
  tmp = mkdtempSync(join(tmpdir(), 'tropa-pins-'));
  port = await freePort(); base = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', join(here, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: join(tmp, 'data'), TROPA_STATE: join(tmp, 'state'),
      TROPA_SECRET: '', TROPA_WATCH_GRACE_MS: '0', HUMAN_NAME: 'tester' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  key = readFileSync(join(tmp, 'state', `secret-${port}.key`), 'utf8').trim();
});
after(() => { srv?.kill(); rmSync(tmp, { recursive: true, force: true }); });

test('pin a message, list the room\'s pins, unpin it', async () => {
  await req('/api/agents/register', { method: 'POST', body: { agent: 'ada', project: 'pins' } });
  const m = await (await req('/api/rooms/project%3Apins/messages', { method: 'POST', body: { agent: 'ada', content: 'the release checklist' } })).json();
  assert.equal((await req(`/api/messages/${m.id}/pin`, { method: 'POST', body: {} })).status, 401);   // the human's action: it needs the key
  const p = await (await req(`/api/messages/${m.id}/pin`, { method: 'POST', body: {}, headers: KEY() })).json();
  assert.ok(p.pinned_at > 0); assert.equal(p.pinned_by, 'tester');
  const pins = await (await req('/api/rooms/project%3Apins/pins')).json();
  assert.deepEqual(pins.map((x) => x.id), [m.id]); assert.equal(pins[0].content, 'the release checklist');
  const msgs = await (await req('/api/rooms/project%3Apins/messages')).json();
  assert.ok(msgs.find((x) => x.id === m.id).pinned_at > 0);   // messages carry their pin, so the page can mark them
  await req(`/api/messages/${m.id}/pin`, { method: 'POST', body: { pinned: false }, headers: KEY() });
  assert.deepEqual(await (await req('/api/rooms/project%3Apins/pins')).json(), []);
  assert.equal((await req('/api/messages/999999/pin', { method: 'POST', body: {}, headers: KEY() })).status, 400);
});
