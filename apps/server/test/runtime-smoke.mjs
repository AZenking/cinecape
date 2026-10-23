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
  const profile = await api('/profiles', 'POST', { name: 'Protected', type: 'child', pin: '4321', ownerPassword: password }, 201);
  await api(`/profiles/${profile.id}/select`, 'POST', {}, 403);
  await api(`/profiles/${profile.id}/unlock`, 'POST', { pin: '0000' }, 403);
  await api(`/profiles/${profile.id}/unlock`, 'POST', { pin: '4321' });
  await api(`/profiles/${profile.id}/select`, 'POST', {});
  // 阶段 2(002 契约):策略读取/保存 —— 默认值、家长验证、版本冲突、锁定(真实 HTTP,非 mock)
  const policyRoute = `/profiles/${profile.id}/policy`;
  const policy = await api(policyRoute, 'GET');
  assert.equal(policy.maxContentLevel, 12, 'child default level');
  assert.equal(policy.allowUnrated, false, 'child default unrated');
  assert.equal(policy.version, 1);
  const savedPolicy = await api(policyRoute, 'PUT', { ownerPassword: password, expectedVersion: 1, policy: { maxContentLevel: 10, allowUnrated: false } });
  assert.equal(savedPolicy.version, 2, 'version bump');
  assert.equal(savedPolicy.maxContentLevel, 10);
  await api(policyRoute, 'PUT', { ownerPassword: password, expectedVersion: 1, policy: { maxContentLevel: 3, allowUnrated: false } }, 409);
  await api(policyRoute, 'PUT', { expectedVersion: 2, policy: { maxContentLevel: 3, allowUnrated: false } }, 403);
  for (let i = 0; i < 5; i++) {
    await api(policyRoute, 'PUT', { ownerPassword: 'wrong-password', expectedVersion: 2, policy: { maxContentLevel: 3, allowUnrated: false } }, 403);
  }
  await api(policyRoute, 'PUT', { ownerPassword: password, expectedVersion: 2, policy: { maxContentLevel: 3, allowUnrated: false } }, 423);
  await stop();
  await start();
  assert.equal((await api('/auth/session')).activeProfile.id, profile.id);
  const policyAfterRestart = await api(policyRoute, 'GET');
  assert.equal(policyAfterRestart.maxContentLevel, 10, 'policy persists across restart');
  assert.equal(policyAfterRestart.version, 2);
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
    'PIN rejection/unlock/select', 'parent-verified policy save/version conflict/lockout(423)',
    'process restart persistence(policy+session)', 'backup restore integrity', 'logout/idempotency',
  ] }));
} finally {
  await stop();
  fs.rmSync(dir, { recursive: true, force: true });
}
