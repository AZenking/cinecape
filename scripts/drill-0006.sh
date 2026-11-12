#!/usr/bin/env bash
# T140 备份恢复与回滚演练入口(005;权威:tasks.md T140 + data-model.md §10/§3)。
#
# - 仅对 mktemp 独立临时目录操作(源库/备份/恢复库/NAS 根全部位于临时目录),
#   绝不触碰真实用户库与默认 DATA_DIR;
# - 前置:apps/server 已构建(dist/main.js 与 dist/database/migrate.js;先 `pnpm -r build`);
# - 演练程序为本文件内嵌的 Node 脚本(运行时写入 mktemp 临时文件执行,不在仓库内
#   落盘,故不进入 eslint project service;流程与断言见内嵌程序文件头注释):
#     A. 源世界:独立临时目录 0006 up/down/up(migrate drill)+ 真实最小世界
#        (真实 settings grant / 频道收藏 / 点播历史(writer_epoch=旧 epoch)/活动 playing 会话);
#     B. 备份:VACUUM INTO 在线一致性快照;
#     C. 恢复:备份还原到另一独立临时目录;
#     D. 断言(data-model §10):readiness(healthz)→ 授予全撤销(库与 HTTP 双面)→
#        活动播放标 interrupted → history/favorites 保留(可续播/可读)→ 恢复后可重新
#        PIN 解锁(管理面 readiness)→ 新 resolve 的 candidate_epoch > 旧 epoch 且时钟单调;
#     E. 输出逐断言清单 + PASS JSON;退出码非零即演练失败;临时目录无论成败全部清理。
set -euo pipefail
cd "$(dirname "$0")/.."

for artifact in apps/server/dist/main.js apps/server/dist/database/migrate.js; do
  if [ ! -f "$artifact" ]; then
    echo "[drill-0006] 缺少构建产物 $artifact —— 请先执行 pnpm -r build" >&2
    exit 2
  fi
done

DRILL_PROGRAM="$(mktemp -d /tmp/hmp-drill-0006-program.XXXXXX)/drill-program.mjs"
trap 'rm -rf "$(dirname "$DRILL_PROGRAM")"' EXIT
cat > "$DRILL_PROGRAM" <<'DRILL_PROGRAM_EOF'
// T140 备份恢复与回滚演练(005;data-model.md §10)—— 独立临时目录,绝不触碰真实用户库。
//
// 权威依据:
// - tasks.md T140:「仅对独立临时目录执行 0006 up/down/up;备份恢复验证 data-model.md §10
//   "恢复备份后先撤销授予、标记活动播放中断,再提供 readiness。history 与 favorites 保留",
//   且下次新 session 的 epoch 大于旧值」;
// - data-model.md §10:「恢复备份后先撤销授予、标记活动播放中断,再提供 readiness。
//   history 与 favorites 保留,不能复用旧 session 写入权绕过重授权;下次新 session 的
//   epoch 比旧值更大」;§3:「启动时撤销所有 grants,避免恢复备份或进程重启继承不可
//   验证的旧授权」;
// - migrate.ts:「drill:up → down → up,结束必须全部已应用(SC-006 回滚演练)」——
//   对全量迁移而言 down 恰好回滚最近一个 = 0006,即 0006 up/down/up。
//
// 流程(全部数据落在 mktemp 目录;真实 HTTP + 真实构建产物,同 runtime-smoke 机理):
//   A. 源世界:临时 DATA_DIR 执行 migrate drill(0006 up/down/up,幂等 up ×2)→ 起真实
//      服务 → initialize/login/bootstrap 主档案(PIN)/设置解锁(真实 settings grant)/
//      IPTV+NAS 双来源真实刷新(本地夹具上游 + ffmpeg 真实 mp4)→ 频道收藏(真实 API)
//      → 点播 resolve(分配真实旧 epoch)→ ready → renew → GET 交付(playing)→
//      started+periodic 进度(真实 profile_viewing_history,writer_epoch=旧 epoch);
//   B. 备份:对源库执行 SQLite VACUUM INTO(在线一致性快照);
//   C. 恢复:把备份还原到另一独立临时目录(新 hmp.db);
//   D. 断言(对恢复库起新服务):
//      ① readiness:healthz 200(恢复后先恢复安全态再提供 readiness);
//      ② 授予全撤销:settings_access_grant 全部 revoked_at 非空 + GET /settings/access
//        unlocked=false(旧会话不能继承旧授权);
//      ③ 活动播放被标 interrupted:playback_session 旧活动会话 state='interrupted'
//        且 ended_at 非空(启动恢复语义,不依赖前端 stop);
//      ④ history 与 favorites 保留:/me/history 位置=1.5s 可续播、/me/favorites/channels
//        含收藏频道;
//      ⑤ epoch 单调:新登录选主档案后新 resolve 分配的 candidate_epoch > 旧值
//        (profile_progress_clock.next_epoch 同步递增,不可重置)。
//   E. 输出逐断言清单 + PASS JSON;退出码非零即演练失败。
//
// 用法:node scripts/drill-0006.mjs(或 bash scripts/drill-0006.sh;需先 pnpm -r build)。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import console from 'node:console';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'apps/server', 'package.json'));
const SQLite = require('better-sqlite3');

const MAIN_PIN = '135790';
const password = 'Drill-fixture-only';
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let assertions = 0;
function check(condition, label) {
  assertions += 1;
  assert.ok(condition, label);
  console.log(`  ✓ ${label}`);
}
function checkEq(actual, expected, label) {
  assertions += 1;
  assert.deepStrictEqual(actual, expected, label);
  console.log(`  ✓ ${label}`);
}

/* ---- 临时目录(一切写入仅此处;进程结束无论成败全部清理) ---------------- */
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-drill-0006-'));
const srcDir = path.join(workDir, 'src-data');
const restoreDir = path.join(workDir, 'restore-data');
const nasRoot = path.join(workDir, 'nas', 'root');
fs.mkdirSync(srcDir, { recursive: true });
fs.mkdirSync(restoreDir, { recursive: true });
fs.mkdirSync(nasRoot, { recursive: true });
let server = null;
let child = null;
let base = null;
let fixture = null;
const { fetch } = globalThis;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function envFor(dataDir, port) {
  return {
    ...process.env, NODE_ENV: 'test', DATA_DIR: dataDir, PORT: String(port),
    MEDIA_ROOTS: `nas-main=${nasRoot}`, LAN_ALLOWED_TARGETS: '127.0.0.1',
  };
}

function migrate(command, dataDir) {
  // PORT 传任意合法正值(env fail-fast 校验 PORT>0;migrate 不绑定端口)
  const result = spawnSync(process.execPath, ['apps/server/dist/database/migrate.js', command], {
    cwd: root, env: envFor(dataDir, 3000), encoding: 'utf8',
  });
  assert.equal(result.status, 0, `migrate ${command} 失败: ${result.stderr}`);
}

async function start(dataDir, port) {
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['apps/server/dist/main.js'], {
    cwd: root, env: envFor(dataDir, port), stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', () => {}); // 服务日志不进演练输出(失败经断言暴露)
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error('服务进程在就绪前退出');
    try {
      if ((await fetch(`${base}/api/healthz`)).ok) return;
    } catch { /* starting */ }
    await sleep(50);
  }
  throw new Error('服务就绪超时');
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
  child = null;
}

async function api(bearer, route, method = 'GET', body, status = 200) {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, status, `${method} ${route} -> ${status}(实际 ${response.status})`);
  return status === 204 ? undefined : response.json();
}

function openDb(dataDir) {
  const handle = new SQLite(path.join(dataDir, 'hmp.db'));
  handle.pragma('busy_timeout = 5000');
  return handle;
}

try {
  /* ================================================================== */
  /* A. 源世界:0006 up/down/up(drill)+ 真实最小世界                     */
  /* ================================================================== */
  console.log('[A] 源世界:独立临时目录 0006 up/down/up(migrate drill)+ 真实最小数据');
  const portA = await freePort();
  migrate('drill', srcDir);
  migrate('up', srcDir); // 幂等再跑一次:全部已应用,零变更
  {
    const db = openDb(srcDir);
    const applied = db.prepare('SELECT COUNT(*) AS n FROM _migrations').get().n;
    check(applied >= 6, `迁移 drill 后全部已应用(_migrations=${applied},含 0006)`);
    const v0006 = db.prepare("SELECT COUNT(*) AS n FROM _migrations WHERE name LIKE '0006%'").get().n;
    checkEq(v0006, 1, '0006 在 drill(up/down/up)后恰应用一次');
    db.close();
  }
  await start(srcDir, portA);

  await api(null, '/setup/initialize', 'POST', { householdName: 'Drill QA', username: 'drillqa', password }, 201);
  const loginA = await api(null, '/auth/login', 'POST', { username: 'drillqa', password });
  const tokenA = loginA.sessionToken;
  const mainProfile = await api(tokenA, '/auth/bootstrap-profile', 'POST', { name: 'DrillOwner', pin: MAIN_PIN, ownerPassword: password }, 201);
  await api(tokenA, `/profiles/${mainProfile.id}/unlock`, 'POST', { pin: MAIN_PIN });
  await api(tokenA, `/profiles/${mainProfile.id}/select`, 'POST', {});
  await api(tokenA, '/settings/access', 'POST', { pin: MAIN_PIN }); // 真实 settings grant(活动)
  checkEq((await api(tokenA, '/settings/access')).unlocked, true, '源世界:设置授予已签发(活动)');

  // IPTV 渠道(收藏载体)+ NAS 点播(epoch/历史载体):本地夹具上游 + 真实 mp4
  const m3u = '#EXTM3U\n#EXTINF:-1 tvg-id="drill-ch-1",演练频道\nhttp://drill-fixture.example/ch1.m3u8\n';
  fixture = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'audio/x-mpegurl', 'content-length': String(Buffer.byteLength(m3u)) });
    res.end(m3u);
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const fixtureBase = `http://127.0.0.1:${fixture.address().port}`;
  const ffmpeg = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=128x96:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'baseline',
    '-c:a', 'aac', '-b:a', '32k', '-shortest', '-movflags', '+faststart',
    path.join(nasRoot, 'drill-movie.mp4'),
  ], { encoding: 'utf8' });
  checkEq(ffmpeg.status, 0, 'ffmpeg 生成真实 mp4(可信时长载体)');

  const iptv = await api(tokenA, '/settings/sources', 'POST', {
    kind: 'iptv', name: '演练直播', remoteUrl: 'http://iptv-drill.example/live.m3u', // 013:来源管理免当次密码
  }, 201);
  openDb(srcDir).prepare('UPDATE media_source SET remote_url = ? WHERE id = ?').run(`${fixtureBase}/live.m3u`, iptv.id);
  const refresh = async (sourceId) => {
    const page = await api(tokenA, '/settings/sources?page=1&pageSize=50');
    const version = page.items.find((item) => item.id === sourceId).version;
    const job = await api(tokenA, `/settings/sources/${sourceId}/refresh`, 'POST', { expectedVersion: version, operationKey: randomUUID() }, 202);
    for (;;) {
      const view = await api(tokenA, `/settings/refreshes/${job.id}`);
      if (view.status === 'succeeded') return view;
      if (view.status === 'failed') throw new Error(`刷新失败: ${JSON.stringify(view)}`);
      await sleep(100);
    }
  };
  await refresh(iptv.id);
  const nas = await api(tokenA, '/settings/sources', 'POST', {
    kind: 'nas', name: '演练影库', rootKey: 'nas-main', relativeDirectory: '', // 013:来源管理免当次密码
  }, 201);
  await refresh(nas.id);
  const catalog = await api(tokenA, '/media?pageSize=100');
  const channel = catalog.items.find((item) => item.type === 'channel');
  const video = catalog.items.find((item) => item.type === 'video');
  check(channel !== undefined && video !== undefined, '源世界:频道与点播各就位(收藏/历史载体)');

  await api(tokenA, `/me/favorites/channels/${channel.id}`, 'PUT', {}, 204); // 真实收藏

  // 点播 resolve → 旧 epoch 分配 → ready → 交付(playing)→ started/periodic 进度(真实历史)
  const oldResolve = await api(tokenA, '/playback/resolve', 'POST', { mediaId: video.id }, 201);
  const OLD_SESSION_ID = oldResolve.id;
  for (;;) {
    const view = await api(tokenA, `/playback/sessions/${OLD_SESSION_ID}`);
    if (view.state === 'ready') { var oldReady = view; break; }
    if (view.state === 'failed') throw new Error(`点播准备失败: ${JSON.stringify(view)}`);
    await sleep(100);
  }
  const ticket = await api(tokenA, `/playback/sessions/${OLD_SESSION_ID}/renew`, 'POST', { expectedGeneration: oldReady.generation });
  const entry = new URL(ticket.playbackUrl, base);
  const delivered = await fetch(`${base}${entry.pathname}${entry.search}`, { headers: { Authorization: `Bearer ${tokenA}` } });
  checkEq(delivered.status, 200, '源世界:首次媒体交付 200(started_at 一次性落库,进入 playing)');
  const p1 = await api(tokenA, `/playback/sessions/${OLD_SESSION_ID}/progress`, 'POST',
    { sampleSeq: 1, expectedGeneration: oldReady.generation, positionSeconds: 1, reason: 'started' });
  checkEq(p1.reason, 'accepted', '源世界:started 进度被接受(历史建立)');
  const p2 = await api(tokenA, `/playback/sessions/${OLD_SESSION_ID}/progress`, 'POST',
    { sampleSeq: 2, expectedGeneration: oldReady.generation, positionSeconds: 1.5, reason: 'periodic' });
  checkEq(p2.reason, 'accepted', '源世界:periodic 进度被接受(位置 1.5s,≤ 可信时长 2s)');

  // 源库事实快照(旧值基准)
  const srcDb = openDb(srcDir);
  const oldGrantCount = srcDb.prepare('SELECT COUNT(*) AS n FROM settings_access_grant WHERE revoked_at IS NULL').get().n;
  const oldHistory = srcDb.prepare('SELECT writer_epoch, position_seconds FROM profile_viewing_history').get();
  const oldSession = srcDb.prepare('SELECT state FROM playback_session WHERE id = ?').get(OLD_SESSION_ID);
  const oldClock = srcDb.prepare('SELECT next_epoch FROM profile_progress_clock').get();
  const favoriteCount = srcDb.prepare('SELECT COUNT(*) AS n FROM profile_channel_favorite').get().n;
  checkEq(oldGrantCount, 1, '源世界:恰一条活动设置授予');
  checkEq(favoriteCount, 1, '源世界:恰一条频道收藏');
  checkEq(oldSession.state, 'playing', '源世界:点播会话活动(playing)');
  const OLD_EPOCH = oldHistory.writer_epoch;
  check(oldHistory.position_seconds === 1.5, '源世界:历史位置=1.5s');
  checkEq(oldClock.next_epoch, OLD_EPOCH + 1, `源世界:时钟 next_epoch=${OLD_EPOCH + 1}(旧 epoch=${OLD_EPOCH})`);

  /* ================================================================== */
  /* B. 备份:VACUUM INTO(在线一致性快照)                                */
  /* ================================================================== */
  console.log('[B] 备份:VACUUM INTO(在线一致性快照)');
  const backupPath = path.join(workDir, 'backup.db');
  srcDb.exec(`VACUUM INTO '${backupPath}'`);
  srcDb.close();
  check(fs.existsSync(backupPath) && fs.statSync(backupPath).size > 0, '备份文件生成且非空');

  /* ================================================================== */
  /* C. 恢复:备份还原到另一独立临时目录                                   */
  /* ================================================================== */
  console.log('[C] 恢复:备份还原到新目录(restore-data/hmp.db)');
  fs.copyFileSync(backupPath, path.join(restoreDir, 'hmp.db'));
  await stop();
  fixture.close();

  /* ================================================================== */
  /* D. 断言:对恢复库起新服务,按 data-model §10 逐项断言                 */
  /* ================================================================== */
  console.log('[D] 恢复库断言(readiness/授予撤销/播放中断/history+favorites/epoch 单调)');
  const portB = await freePort();
  await start(restoreDir, portB); // ① readiness:启动恢复完成后 healthz 200
  check(true, '恢复库 readiness:healthz 200(恢复安全态之后才提供)');

  const restoredDb = openDb(restoreDir);
  const grants = restoredDb.prepare('SELECT revoked_at FROM settings_access_grant').all();
  check(grants.length >= 1 && grants.every((row) => row.revoked_at !== null),
    '② 授予全撤销:settings_access_grant 全部 revoked_at 非空(启动撤销,不继承旧授权)');
  const restoredSession = restoredDb.prepare('SELECT state, ended_at FROM playback_session WHERE id = ?').get(OLD_SESSION_ID);
  checkEq([restoredSession.state, restoredSession.ended_at !== null], ['interrupted', true],
    '③ 活动播放被标 interrupted(ended_at 非空,不依赖前端 stop)');
  const keptHistory = restoredDb.prepare('SELECT writer_epoch, position_seconds, writer_playback_session_id FROM profile_viewing_history').get();
  checkEq([keptHistory.writer_epoch, keptHistory.position_seconds], [OLD_EPOCH, 1.5],
    '④a history 保留(writer_epoch/位置不变)');
  checkEq(restoredDb.prepare('SELECT COUNT(*) AS n FROM profile_channel_favorite').get().n, 1,
    '④b favorites 保留(恰一条频道收藏)');

  // HTTP 面:旧会话的授予状态不可见;新登录可恢复正常使用
  checkEq((await api(tokenA, '/settings/access')).unlocked, false,
    '② GET /settings/access unlocked=false(恢复后旧/新会话均无有效授予)');
  const loginB = await api(null, '/auth/login', 'POST', { username: 'drillqa', password });
  const tokenB = loginB.sessionToken;
  await api(tokenB, `/profiles/${mainProfile.id}/unlock`, 'POST', { pin: MAIN_PIN });
  await api(tokenB, `/profiles/${mainProfile.id}/select`, 'POST', {});
  const history = await api(tokenB, '/me/history');
  check(history.items.length === 1, `④a GET /me/history 恰一条(实际 ${JSON.stringify(history.items)})`);
  check(history.items[0]?.media?.id === video.id, `④a 历史归属点播媒体(media.id=${JSON.stringify(history.items[0]?.media?.id)})`);
  check(history.items[0]?.positionSeconds === 1.5, `④a 历史位置保留 1.5s(实际 ${JSON.stringify(history.items[0]?.positionSeconds)})`);
  check(history.items[0]?.canResume === true, `④a canResume=true(续播语义成立,实际 ${JSON.stringify(history.items[0]?.canResume)})`);
  const favorites = await api(tokenB, '/me/favorites/channels');
  check(favorites.items.length === 1 && favorites.items[0]?.media?.id === channel.id,
    `④b GET /me/favorites/channels 保留(收藏频道可读,实际 ${JSON.stringify(favorites.items.map((item) => item.media?.id))})`);
  await api(tokenB, '/settings/access', 'POST', { pin: MAIN_PIN }); // 恢复后可重新解锁设置(管理面 readiness)
  checkEq((await api(tokenB, '/settings/access')).unlocked, true, 'readiness:恢复后重新 PIN 验证可再签发授予(管理面可用)');

  // ⑤ epoch 单调:新 resolve 分配的 candidate_epoch 必须大于旧值
  const newResolve = await api(tokenB, '/playback/resolve', 'POST', { mediaId: video.id }, 201);
  const newState = restoredDb.prepare('SELECT candidate_epoch FROM playback_progress_state WHERE playback_session_id = ?').get(newResolve.id);
  const newClock = restoredDb.prepare('SELECT next_epoch FROM profile_progress_clock').get();
  check(newState.candidate_epoch > OLD_EPOCH,
    `⑤ 新 session 的 candidate_epoch=${newState.candidate_epoch} > 旧 epoch=${OLD_EPOCH}`);
  check(newClock.next_epoch > oldClock.next_epoch,
    `⑤ 时钟 next_epoch=${newClock.next_epoch} 单调递增(旧 ${oldClock.next_epoch},不可重置)`);
  restoredDb.close();

  console.log(`\n[drill-0006] PASS:0006 up/down/up + 备份恢复演练通过(断言 ${assertions} 项)`);
  console.log(JSON.stringify({
    result: 'PASS', assertions, oldEpoch: OLD_EPOCH, newEpoch: newState.candidate_epoch,
    backupBytes: fs.statSync(backupPath).size,
    restored: { grantsRevoked: true, activePlaybackInterrupted: true, historyKept: true, favoritesKept: true, readiness: true, epochMonotonic: true },
  }));
} catch (error) {
  console.error(`[drill-0006] FAIL(断言 ${assertions} 项后失败):`, error);
  throw error;
} finally {
  await stop();
  fixture?.close();
  fs.rmSync(workDir, { recursive: true, force: true });
}
DRILL_PROGRAM_EOF
exec node "$DRILL_PROGRAM" "$@"
