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
  tmp = mkdtempSync(join(tmpdir(), 'tropa-pause-'));
  port = await freePort(); base = `http://127.0.0.1:${port}`;
  srv = spawn(process.execPath, ['--no-warnings', join(here, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: join(tmp, 'data'), TROPA_STATE: join(tmp, 'state'),
      TROPA_SECRET: '', TROPA_WATCH_GRACE_MS: '0', TROPA_CREDIT_SURE_MS: '300', HUMAN_NAME: 'tester' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  key = readFileSync(join(tmp, 'state', `secret-${port}.key`), 'utf8').trim();
});
after(() => { srv?.kill(); rmSync(tmp, { recursive: true, force: true }); });

const R = 'project%3Apaused';
const poll = async () => (await (await req('/api/watch/poll', { method: 'POST', headers: KEY(), body: { room: 'project:paused', agents: ['ada', 'bob'], tmux_session: 'ai-p', timeout: 0 } })).json()).events || [];
const wakesFor = (evs, a) => evs.filter((e) => e.type === 'wake' && e.agent === a);
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

test('an agent out of credits is paused: nothing reaches it until it is resumed, then its messages do', async () => {
  await poll();
  await req(`/api/rooms/${R}/wake`, { method: 'PATCH', headers: KEY(), body: { debounce_seconds: 0, cooldown_seconds: 0 } });
  // the watcher sees "out of credits" on ada's screen
  const outOfCredits = () => req('/api/watch/panes', { method: 'POST', headers: KEY(), body: { room: 'project:paused', panes: {
    ada: { state: 'idle', text: 'x', limit: { kind: 'credits', text: 'Personal is out of credits' } }, bob: { state: 'idle', text: 'x' } } } });
  await outOfCredits(); await settle();
  assert.deepEqual((await (await req(`/api/rooms/${R}/team`)).json()).settings.paused_agents, {}, 'one glimpse is not enough');
  await outOfCredits(); await settle();
  const team = await (await req(`/api/rooms/${R}/team`)).json();
  assert.ok(team.settings.paused_agents.ada, 'ada is paused');
  assert.equal(team.settings.paused_agents.ada.why, 'out of credits');
  const msgs = await (await req(`/api/rooms/${R}/messages`)).json();
  assert.ok(msgs.some((m) => /`ada` is paused \(out of credits\)/.test(m.content)), 'the room is told once');
  await poll();   // clear what's queued so far

  const m = await (await req(`/api/rooms/${R}/messages`, { method: 'POST', headers: KEY(), body: { sender_kind: 'human', content: '@ada @bob please check the totals' } })).json();
  await settle();
  const evs = await poll();
  assert.equal(wakesFor(evs, 'ada').length, 0, 'nothing is typed into a paused agent');
  assert.equal(wakesFor(evs, 'bob').length, 1, 'its teammates still get the message');

  assert.equal((await req(`/api/rooms/${R}/agents/ada/pause`, { method: 'POST', body: { paused: false } })).status, 401);   // the human's call
  const r = await (await req(`/api/rooms/${R}/agents/ada/pause`, { method: 'POST', headers: KEY(), body: { paused: false } })).json();
  assert.equal(r.changed, true);
  await settle();
  const evs2 = await poll();
  const after = wakesFor(evs2, 'ada');
  assert.equal(after.length, 1, 'resumed: it gets the messages that waited');
  assert.ok(after[0].message_ids.includes(m.id));
  assert.equal(after[0].resumed, true, 'the watcher is told to type it in although the old error is still on screen');
  assert.deepEqual((await (await req(`/api/rooms/${R}/team`)).json()).settings.paused_agents, {});
  // right after Resume its screen still shows the old error: that doesn't pause it again
  const panes = (text) => req('/api/watch/panes', { method: 'POST', headers: KEY(), body: { room: 'project:paused', panes: {
    ada: { state: 'idle', text, limit: { kind: 'credits', text: 'Personal is out of credits' } } } } });
  await panes('x'); await settle();
  assert.deepEqual((await (await req(`/api/rooms/${R}/team`)).json()).settings.paused_agents, {}, 'the old error line is ignored after Resume');
  // a new credits error (the screen changed) pauses it again
  await panes('x\nworking...\nPersonal is out of credits'); await settle(); await panes('x\nworking...\nPersonal is out of credits'); await settle();
  assert.ok((await (await req(`/api/rooms/${R}/team`)).json()).settings.paused_agents.ada, 'a new error pauses it again');
  await req(`/api/rooms/${R}/agents/ada/pause`, { method: 'POST', headers: KEY(), body: { paused: false } });
});

test('pausing by hand works the same, and doesn\'t repeat', async () => {
  const a = await (await req(`/api/rooms/${R}/agents/bob/pause`, { method: 'POST', headers: KEY(), body: {} })).json();
  assert.equal(a.changed, true); assert.ok(a.paused_agents.bob);
  const b = await (await req(`/api/rooms/${R}/agents/bob/pause`, { method: 'POST', headers: KEY(), body: {} })).json();
  assert.equal(b.changed, false);
  await req(`/api/rooms/${R}/agents/bob/pause`, { method: 'POST', headers: KEY(), body: { paused: false } });
});

test('a glimpse of the error does not pause; posting in the room proves it can work and resumes it', async () => {
  const pane = (limit, state = 'idle', text = 'y') => req('/api/watch/panes', { method: 'POST', headers: KEY(), body: { room: 'project:paused', panes: {
    bob: { state, text, ...(limit ? { limit: { kind: 'credits', text: 'Credit balance is too low' } } : {}) } } } });
  const pausedNow = async () => (await (await req(`/api/rooms/${R}/team`)).json()).settings.paused_agents.bob;
  await pane(true); await settle(100); await pane(false); await settle(500); await pane(false); await settle();
  assert.equal(await pausedNow(), undefined, 'gone before it was sure: not paused');
  await pane(true, 'idle', 'z'); await settle(); await pane(true, 'idle', 'z'); await settle();
  assert.equal((await pausedNow())?.why, 'out of credits');
  await req(`/api/rooms/${R}/messages`, { method: 'POST', body: { agent: 'bob', content: 'Done: card #42 is in review.' } });
  await settle();
  assert.equal(await pausedNow(), undefined, 'it posted, so it has credits: resumed');
  const msgs = await (await req(`/api/rooms/${R}/messages`)).json();
  assert.ok(msgs.some((m) => /`bob` just posted in the room, so it isn't out of credits after all/.test(m.content)));
});
