// Uses a fresh temporary database and compiled production assets, never user data.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers';
import console from 'node:console';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(root, 'apps/server/package.json'));
const SQLite = require('better-sqlite3');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-runtime-smoke-'));
const server = net.createServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
server.close();
await once(server, 'close');
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, NODE_ENV: 'test', DATA_DIR: dir, PORT: String(port) };
let child;
let token;
const password = 'Runtime-smoke-fixture-only';
const { fetch } = globalThis;

function migrate(command, dataDir = dir) {
  const result = spawnSync(process.execPath, ['apps/server/dist/database/migrate.js', command], {
    cwd: root, env: { ...env, DATA_DIR: dataDir }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

async function start() {
  child = spawn(process.execPath, ['apps/server/dist/main.js'], { cwd: root, env, stdio: 'ignore' });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Server exited before readiness');
    try { if ((await fetch(`${base}/api/healthz`)).ok) return; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Server readiness timeout');
}

async function api(route, method = 'GET', body, status = 200) {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, status, `${method} ${route}`);
  return status === 204 ? undefined : response.json();
}

try {
  migrate('drill', path.join(dir, 'drill'));
  migrate('up');
  migrate('up');
  await start();
  for (const route of ['/', '/setup', '/profiles/manage']) {
    const response = await fetch(`${base}${route}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<div id="root">/);
  }
  assert.equal((await fetch(`${base}/api/not-a-route`)).status, 404);
  const credentials = { householdName: 'Runtime QA', username: 'runtimeqa', password };
  const init = await api('/setup/initialize', 'POST', credentials, 201);
  token = init.sessionToken;
  await api('/setup/initialize', 'POST', credentials, 409);
  await api('/auth/login', 'POST', { username: 'runtimeqa', password: 'wrong' }, 401);
  const timings = [];
  for (let i = 0; i < 20; i++) {
    const started = performance.now();
    await api('/auth/login', 'POST', { username: 'runtimeqa', password });
    timings.push(performance.now() - started);
  }
  const profile = await api('/profiles', 'POST', { name: 'Protected', type: 'child', pin: '4321' }, 201);
  await api(`/profiles/${profile.id}/select`, 'POST', {}, 403);
  await api(`/profiles/${profile.id}/unlock`, 'POST', { pin: '0000' }, 403);
  await api(`/profiles/${profile.id}/unlock`, 'POST', { pin: '4321' });
  await api(`/profiles/${profile.id}/select`, 'POST', {});
  await stop();
  await start();
  assert.equal((await api('/auth/session')).activeProfile.id, profile.id);
  const db = new SQLite(path.join(dir, 'hmp.db'));
  await db.backup(path.join(dir, 'restore.db'));
  db.close();
  const restored = new SQLite(path.join(dir, 'restore.db'), { readonly: true });
  assert.equal(restored.prepare('SELECT name FROM profile').get().name, 'Protected');
  assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
  restored.close();
  await api('/auth/logout', 'POST', {}, 204);
  await api('/auth/logout', 'POST', {}, 204);
  await api('/auth/session', 'GET', undefined, 401);
  timings.sort((a, b) => a - b);
  assert.ok(timings[18] < 3000, 'SC-002 login p95 < 3 seconds');
  console.log(JSON.stringify({ result: 'PASS', loginP95Ms: Math.round(timings[18]), scenarios: [
    'migration drill/idempotent up', 'compiled SPA/API routing', 'initialization/login',
    'PIN rejection/unlock/select', 'process restart persistence', 'backup restore integrity', 'logout/idempotency',
  ] }));
} finally {
  await stop();
  fs.rmSync(dir, { recursive: true, force: true });
}
