// Uses a fresh temporary database and compiled production assets, never user data.
// 003-media-catalog 阶段 3 扩展(T031/T039/T047/T053/T056/T073):真实构建产物 + 临时库 + 真实 HTTP
// 服务 + 本地受控 M3U/XMLTV 夹具服务(127.0.0.1 随机端口)+ os.tmpdir 临时 NAS 根,非 mock。
// 005-pc-browsing-flow 收口改写(US8 管理迁移 + T083 设置解锁):管理面全部改走
// /api/settings/*(§6「新 settings 前缀是替代,不保留旧 /sources、/catalog、/devices
// 等管理入口」),前置编排 = 登录 → bootstrap 主档案(零档案唯一首建)→
// POST /profiles/{id}/unlock{pin} → select → POST /settings/access{pin} 签 15 分钟
// 固定授予;换档/重启撤销授予由 mapi() 幂等重解锁吸收(§7 授权次序)。
// 场景分节:S1 来源闭环 / S2 目录矩阵 / S3 EPG 全流程 / S4 名单闭环 / S5 性能基准(SC-005)
//        / S6 手动 EPG 绑定增补(T073;US5/ADR-0008,quickstart H/SC-010)
//        / S7 US2 播放负向矩阵(T039;真实 HTTP:切档案/收紧策略/注销/停源 → 下一请求拒绝,
//          Range/HEAD、旧缓冲不计停止期限、流中失败不注入 JSON;NAS direct + 本地 HLS 上游)
//        / S8 US1 004 播放正向/鲁棒性真实 HTTP 场景(T033;T032 真实媒体夹具 + 真实 ffprobe/
//          ffmpeg 证据,不以 mock 子进程替代:起播字节多路径(direct/audio_transcode/
//          video_transcode)/续期同 session 与任务行/Range/seek 换代/纯字幕 version+1/
//          额度满(尽力+实测依据,见 S8 组 4)/限时失败与 preparing
//          取消/失联扫描/recoverOnBoot 重启/旁车字幕 WEBVTT)。
//        / S9 US2b SC-004 记录真实 HTTP 场景(T047;quickstart「SC-004:记录」;
//          005 T130:记录查询迁入 /settings/devices/{id}/playback-records/query,
//          Settings 边界 = 主档案选中+设置授予+当次密码):
//          独立记录设备(新登录=新 Device,限频/家长验证计数天然隔离)成功播放+解析失败
//          → 家长密码查询恰 2 条、session 13 键/failure 6 键字段完整率 100%、伪造 token
//          401 不入设备记录、权限负向(错误密码/缺密码/非 owner/不存在设备 404 同形)、
//          第二设备记录不混入。浏览器 UI 层证据不在本文件能力内(UI 数据源=本 API,
//          DevicePlaybackRecords 组件已由 T046 交付;缺口由 evidence.md 如实记录)。
// 浏览器渲染层证据需真实浏览器环境,本文件仅产出 HTTP 层证据(见输出 browserEvidence 声明)。
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers';
import console from 'node:console';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
// T032 播放媒体夹具(只读使用;程序化用法见其文件头):可复现自制媒体/受控 HLS,
// generateAll({outDir}) 同步返回 { outDir, entries, verification },样本文件名即语义。
import { generateAll } from './fixtures/playback/generate-media.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(root, 'apps/server/package.json'));
const SQLite = require('better-sqlite3');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-runtime-smoke-'));
// 服务进程稳定性 preload(写入临时目录,随 smoke 清理;经 spawn argv --require 注入):
// 本机 Node 工具链下 better-sqlite3 Statement 包装对象一旦被 GC 终结,会触发
// node::RemoveEnvironmentCleanupHook `(env) != nullptr` 断言崩溃 —— 与
// apps/server/test/contract/sources-refresh.e2e-spec.ts 文件头记录并上报的已知问题同源。
// 该契约套件的 --expose-gc + 显式 gc() 缓解在服务进程大批量导入场景下不适用(实测仍崩,
// 最小复现:better-sqlite3 prepare/run churn + gc() 必崩)。smoke 不允许改 src/**,故在
// preload 中对 Database.prototype.prepare 做保活包装:Statement 不再变为不可达,终结器
// 永不触发;smoke 进程寿命短内存可承受,进程退出走 better-sqlite3 Addon::Cleanup →
// CloseHandles 原生收尾路径(sqlite3_finalize 全量执行),不依赖 JS GC。
const supportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-runtime-smoke-support-'));
const statementKeepAlivePreload = path.join(supportDir, 'statement-keepalive.cjs');
fs.writeFileSync(
  statementKeepAlivePreload,
  [
    '// runtime-smoke 注入:持强引用全部 better-sqlite3 Statement,阻止其进入 GC 终结队列',
    '// (见 apps/server/test/runtime-smoke.mjs 头部说明;失败不阻塞服务启动)',
    'try {',
    '  const { createRequire } = require("node:module");',
    '  const rootRequire = createRequire(process.env.HMP_SMOKE_SERVER_PKG);',
    '  const Database = rootRequire("better-sqlite3");',
    '  const keptStatements = [];',
    '  const originalPrepare = Database.prototype.prepare;',
    '  Database.prototype.prepare = function (...args) {',
    '    const statement = originalPrepare.apply(this, args);',
    '    keptStatements.push(statement);',
    '    return statement;',
    '  };',
    '} catch { /* 忽略:无法保活时按原行为运行 */ }',
    '',
  ].join('\n'),
);
const serverArgvPrefix = ['--require', statementKeepAlivePreload];
// smoke 自身进程同样直接使用 better-sqlite3(serverDb/备份),按同一机理保活
try {
  const keptStatements = [];
  const originalPrepare = SQLite.prototype.prepare;
  SQLite.prototype.prepare = function (...args) {
    const statement = originalPrepare.apply(this, args);
    keptStatements.push(statement);
    return statement;
  };
} catch { /* 忽略 */ }
// NAS 只读临时根(夹具专用,绝不指向用户数据;对应 MEDIA_ROOTS=nas-main=...)
const nasBase = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-runtime-smoke-nas-'));
const nasRoot = path.join(nasBase, 'root');
fs.mkdirSync(nasRoot, { recursive: true });

/* ------------------------------------------------------------------ */
/* 受控 M3U/XMLTV 夹具服务(内联简版;绑 127.0.0.1 随机端口,可编程路由) */
/* ------------------------------------------------------------------ */

const MIN_MS = 60_000;
/** EPG 夹具节目窗口基准(整秒):节目时间围绕 now 构造,S3 断言 current/next 用 */
const guideBase = Math.floor(Date.now() / 1000) * 1000;

function buildM3uText(entries) {
  const lines = ['#EXTM3U'];
  for (const entry of entries) {
    const attrs = entry.tvgId === undefined ? '' : ` tvg-id="${entry.tvgId}"`;
    lines.push(`#EXTINF:-1${attrs},${entry.name}`);
    lines.push(entry.url);
  }
  return `${lines.join('\n')}\n`;
}

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** XMLTV 时间戳:UTC +0000 显式时区(解析层归一 UTC 后与 ISO 断言对照) */
function xmltvStamp(ms) {
  const at = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())} +0000`
  );
}

function buildXmltvText(channels, programmes) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv>'];
  for (const channel of channels) {
    lines.push(`  <channel id="${xmlEscape(channel.id)}">`);
    lines.push(`    <display-name>${xmlEscape(channel.displayName ?? channel.id)}</display-name>`);
    lines.push('  </channel>');
  }
  for (const programme of programmes) {
    lines.push(
      `  <programme channel="${xmlEscape(programme.channel)}" start="${xmlEscape(programme.start)}" stop="${xmlEscape(programme.stop)}">`,
    );
    lines.push(`    <title>${xmlEscape(programme.title)}</title>`);
    lines.push('  </programme>');
  }
  lines.push('</tv>');
  return `${lines.join('\n')}\n`;
}

/** 主 IPTV 夹具:3 频道,tvg-id smoke-ch-1/2/3(ch-3 不在 EPG → programmes unavailable 样本) */
const liveM3u = buildM3uText([
  { name: '烟雾一台', tvgId: 'smoke-ch-1', url: 'http://stream.example/ch1.m3u8' },
  { name: '烟雾二台', tvgId: 'smoke-ch-2', url: 'http://stream.example/ch2.m3u8' },
  { name: '烟雾三台', tvgId: 'smoke-ch-3', url: 'http://stream.example/ch3.m3u8' },
]);
/** 失败夹具:EXTINF 缺播放地址 → 整次解析失败(M3U_ENTRY_MISSING_URL) */
const brokenM3u = '#EXTM3U\n#EXTINF:-1 tvg-id="bad-one",无地址频道\n';
/** EPG 夹具:2 频道 3 节目,ch-1 双节目围绕 now(current/next),ch-2 单节目 */
const guideXml = buildXmltvText(
  [
    { id: 'smoke-ch-1', displayName: '烟雾新闻台' },
    { id: 'smoke-ch-2', displayName: '烟雾少儿台' },
  ],
  [
    { channel: 'smoke-ch-1', start: xmltvStamp(guideBase - 30 * MIN_MS), stop: xmltvStamp(guideBase + 30 * MIN_MS), title: '晨间新闻' },
    { channel: 'smoke-ch-1', start: xmltvStamp(guideBase + 30 * MIN_MS), stop: xmltvStamp(guideBase + 150 * MIN_MS), title: '午间剧场' },
    { channel: 'smoke-ch-2', start: xmltvStamp(guideBase - 45 * MIN_MS), stop: xmltvStamp(guideBase + 45 * MIN_MS), title: '动画乐园' },
  ],
);
/** S5 性能夹具:10000 条目(≤ M3U_MAX_ENTRIES=20000,字节 ≤10MiB) */
const PERF_ENTRIES = 10_000;
function buildPerfM3u(count) {
  const lines = ['#EXTM3U'];
  for (let index = 0; index < count; index += 1) {
    const tag = String(index).padStart(5, '0');
    lines.push(`#EXTINF:-1 tvg-id="perf-${tag}",性能频道 ${tag}`);
    lines.push(`http://perf-stream.example/${index}/index.m3u8`);
  }
  return `${lines.join('\n')}\n`;
}
const perfM3u = buildPerfM3u(PERF_ENTRIES);

const fixturePending = new Set();
const fixtureRoutes = new Map();
function fixtureText(res, status, contentType, body) {
  if (res.headersSent || res.destroyed) return;
  const payload = Buffer.from(body, 'utf8');
  res.statusCode = status;
  res.setHeader('content-type', contentType);
  res.setHeader('content-length', String(payload.length));
  res.end(payload);
}
fixtureRoutes.set('/live.m3u', (req, res) => fixtureText(res, 200, 'audio/x-mpegurl', liveM3u));
fixtureRoutes.set('/broken.m3u', (req, res) => fixtureText(res, 200, 'audio/x-mpegurl', brokenM3u));
fixtureRoutes.set('/guide.xml', (req, res) => fixtureText(res, 200, 'application/xml', guideXml));
fixtureRoutes.set('/perf.m3u', (req, res) => fixtureText(res, 200, 'audio/x-mpegurl', perfM3u));
fixtureRoutes.set('/hang.xml', (req, res) => {
  // 永不响应:占住刷新任务(并发 SOURCE_BUSY 断言),abortFixturePending 释放后任务失败
  fixturePending.add(res);
  res.once('close', () => fixturePending.delete(res));
});
fixtureRoutes.set('/slow.m3u', (req, res) => {
  // 慢响应:构造 running 窗口供 kill+respawn 中断场景使用
  fixturePending.add(res);
  res.once('close', () => fixturePending.delete(res));
  setTimeout(() => {
    fixturePending.delete(res);
    fixtureText(res, 200, 'audio/x-mpegurl', liveM3u);
  }, 15_000);
});
function abortFixturePending() {
  for (const res of [...fixturePending]) res.socket?.destroy();
  fixturePending.clear();
}
const fixture = http.createServer((req, res) => {
  req.on('error', () => {});
  res.on('error', () => {});
  const pathname = new URL(req.url ?? '/', 'http://fixture.invalid').pathname;
  const route = fixtureRoutes.get(pathname);
  if (route === undefined) {
    res.statusCode = 404;
    res.end('runtime-smoke fixture: no route');
    return;
  }
  route(req, res);
});
await new Promise((resolve, reject) => {
  fixture.once('error', reject);
  fixture.listen(0, '127.0.0.1', () => {
    fixture.off('error', reject);
    resolve();
  });
});
const fixtureBase = `http://127.0.0.1:${fixture.address().port}`;
async function closeFixture() {
  abortFixturePending();
  await new Promise((resolve) => fixture.close(() => resolve()));
  fixture.closeAllConnections();
}

const server = net.createServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
server.close();
await once(server, 'close');
const base = `http://127.0.0.1:${port}`;
// LAN_ALLOWED_TARGETS 精确许可 127.0.0.1(夹具地址);MEDIA_ROOTS 授权 NAS 临时根;
// HMP_SMOKE_SERVER_PKG 供 preload 解析 apps/server 的 better-sqlite3(pnpm 严格布局)
const env = {
  ...process.env, NODE_ENV: 'test', DATA_DIR: dir, PORT: String(port),
  MEDIA_ROOTS: `nas-main=${nasRoot}`, LAN_ALLOWED_TARGETS: '127.0.0.1',
  // S8(T033)显式注入转换并发预算(默认即 1):额度满场景的确定性口径。转码管线已接线
  // (见 S8 组 4),BUSY 窗口受小样本转码时长限制,按「尽力+实测依据」结构如实报告。
  PLAYBACK_CONVERSION_CONCURRENCY: '1',
  HMP_SMOKE_SERVER_PKG: path.join(root, 'apps/server', 'package.json'),
};
let child;
let token;
const password = 'Runtime-smoke-fixture-only';
const { fetch } = globalThis;

function migrate(command, dataDir = dir) {
  const result = spawnSync(process.execPath, [...serverArgvPrefix, 'apps/server/dist/database/migrate.js', command], {
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

/** 崩溃式重启前置:SIGKILL(不经优雅关闭,模拟真实中断) */
async function killHard() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

async function start() {
  // 服务进程日志落盘(临时目录,随 smoke 清理;失败时在 finally 打印尾部辅助诊断)
  const serverLogFd = fs.openSync(path.join(supportDir, 'server.log'), 'a');
  child = spawn(process.execPath, [...serverArgvPrefix, 'apps/server/dist/main.js'], { cwd: root, env, stdio: ['ignore', serverLogFd, serverLogFd] });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Server exited before readiness');
    try { if ((await fetch(`${base}/api/healthz`)).ok) return; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Server readiness timeout');
}

/** 重启韧性封装:kill 后端口/库恢复存在竞态,短暂重试再 spawn */
async function startResilient() {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await start();
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function apiWith(bearer, route, method = 'GET', body, status = 200) {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, status, `${method} ${route} -> ${status}`);
  return status === 204 ? undefined : response.json();
}

function api(route, method = 'GET', body, status = 200) {
  return apiWith(token, route, method, body, status);
}

/* ------------------------------------------------------------------ */
/* 005 契约前置辅助(T081/T082/T083;api.md §6/§7):设置边界 = Session +    */
/* 当前主 Profile + 管理 PIN 授予。管理面调用一律经 mapi():先幂等解锁。    */
/* ------------------------------------------------------------------ */

/** 主档案管理 PIN(bootstrap 建档时设定;6 位数字,契约 pattern ^[0-9]{6}$) */
const mainPin = '135790';
/** bootstrap 创建的主档案(005:管理写要求「当前主 Profile」,观看成人即主档案) */
let mainProfile = null;

/**
 * 005 设置解锁编排(幂等,对齐 helpers-management selectMainAndUnlockSettings 的
 * HTTP 层语义;.mjs 不能 import TS helper 故内联):GET /settings/access 仅 Session →
 * 未解锁则 GET /profiles 选档摘要定位主档案 → POST /profiles/{id}/unlock{pin} →
 * select → POST /settings/access{pin} 签 15 分钟固定授予(不续期)。
 * 换档撤销授予 / 重启撤销授予由本函数幂等吸收(再解锁,不改变观看语义:
 * 主档案已选中时 select 为同档案重选,不递增上下文、不终态化播放)。
 */
async function ensureSettings(bearer = token) {
  if ((await apiWith(bearer, '/settings/access')).unlocked === true) return;
  const main = (await apiWith(bearer, '/profiles')).find(profile => profile.isMain);
  check(main !== undefined, '005 前置:主档案存在于选档摘要(GET /profiles)');
  await apiWith(bearer, `/profiles/${main.id}/unlock`, 'POST', { pin: mainPin });
  await apiWith(bearer, `/profiles/${main.id}/select`, 'POST', {});
  await apiWith(bearer, '/settings/access', 'POST', { pin: mainPin });
}

/** PIN 保护主档案的一次性选档授予 + 选择(005 §3;替代旧「成人 + ownerPassword」选档) */
async function selectMain(bearer = token) {
  await apiWith(bearer, `/profiles/${mainProfile.id}/unlock`, 'POST', { pin: mainPin });
  return apiWith(bearer, `/profiles/${mainProfile.id}/select`, 'POST', {});
}

/** 管理面请求(指定会话):先幂等解锁设置,再发请求 */
async function mapiWith(bearer, route, method = 'GET', body, status = 200) {
  await ensureSettings(bearer);
  return apiWith(bearer, route, method, body, status);
}

/** 管理面请求(主会话) */
function mapi(route, method = 'GET', body, status = 200) {
  return mapiWith(token, route, method, body, status);
}

/* ------------------------------------------------------------------ */
/* 阶段 3 断言计数辅助(新增场景断言数统计)                              */
/* ------------------------------------------------------------------ */

let assertionCount = 0;
function check(condition, label) {
  assertionCount += 1;
  assert.ok(condition, label);
}
function checkEq(actual, expected, label) {
  assertionCount += 1;
  assert.deepStrictEqual(actual, expected, label);
}

/* ------------------------------------------------------------------ */
/* 阶段 3 专用辅助:跨进程 DB 访问(照 sources-refresh 契约夹具的         */
/* pointSourceAt 模式;创建期字面校验拒绝回环地址,经真实 API 建源后把     */
/* remote_url 接到本夹具,刷新期由 LAN_ALLOWED_TARGETS='127.0.0.1' 放行)  */
/* ------------------------------------------------------------------ */

let dbHandle = null;
/* S7 本地 HLS 上游句柄(try 内赋值;finally 统一关闭,避免监听句柄泄漏) */
let s7Upstream = null;
/* S8 T032 媒体夹具目录(try 内赋值;finally 统一清理) */
let s8MediaBase = null;
function serverDb() {
  if (dbHandle === null) {
    dbHandle = new SQLite(path.join(dir, 'hmp.db'));
    dbHandle.pragma('busy_timeout = 5000');
  }
  return dbHandle;
}
function pointSourceAt(sourceId, remoteUrl) {
  serverDb().prepare('UPDATE media_source SET remote_url = ? WHERE id = ?').run(remoteUrl, sourceId);
}

async function sourceVersionOf(sourceId) {
  // 005:T124 来源管理迁入 /settings/sources(Settings 边界,api.md §6)
  const page = await mapi('/settings/sources?page=1&pageSize=50');
  const item = page.items.find(source => source.id === sourceId);
  check(item !== undefined, `来源应在列表中: ${sourceId}`);
  return item.version;
}

/** 发起刷新:ownerPassword + 当前 source.version + 幂等 operationKey(005 T124 settings 前缀) */
async function startRefresh(sourceId, status = 202) {
  const expectedVersion = await sourceVersionOf(sourceId);
  return mapi(`/settings/sources/${sourceId}/refresh`, 'POST', {
    ownerPassword: password, expectedVersion, operationKey: randomUUID(),
  }, status);
}

async function waitForRefresh(refreshId, statuses, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  for (;;) {
    polls += 1;
    // 005:T124 刷新任务轮询迁入 /settings/refreshes/{id}(Location 同步更新)
    const body = await mapi(`/settings/refreshes/${refreshId}`);
    if (statuses.includes(body.status)) return body;
    if (polls % 50 === 0) console.log(`[wait] refresh ${refreshId} polls=${polls} status=${body.status}`);
    if (Date.now() > deadline) {
      throw new Error(`刷新 ${refreshId} 等待 [${statuses.join(',')}] 超时,最后状态: ${JSON.stringify(body)}`);
    }
    await sleep(100);
  }
}

const adultList = (query = '') => api(`/media${query}`);
const titlesOf = (page) => page.items.map(item => item.title);

try {
  migrate('drill', path.join(dir, 'drill'));
  migrate('up');
  migrate('up');
  await start();
  // 005 ui.md §1(T010):旧 /setup、/profiles 管理骨架已整体移除,SPA 地址只保留
  // 公共观看路由与 /settings/*;此处断言「编译产物 + 静态回退」仍按 005 地址面成立。
  for (const route of ['/', '/vod', '/live/guide', '/settings/account']) {
    const response = await fetch(`${base}${route}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<div id="root">/);
  }
  assert.equal((await fetch(`${base}/api/not-a-route`)).status, 404);
  const credentials = { householdName: 'Runtime QA', username: 'runtimeqa', password };
  // 005 §3(T036):initialize 仅建 Household+Account,201 {initialized:true} ——
  // 无会话/无 sessionToken/不自动登录。旧「初始化即自动登录」断言按契约改写为显式 login。
  const init = await api('/setup/initialize', 'POST', credentials, 201);
  checkEq(init, { initialized: true }, '005:initialize 201 仅 {initialized:true}(无 sessionToken/无 Set-Cookie)');
  await api('/setup/initialize', 'POST', credentials, 409);
  await api('/auth/login', 'POST', { username: 'runtimeqa', password: 'wrong' }, 401);
  const timings = [];
  for (let i = 0; i < 20; i++) {
    const started = performance.now();
    await api('/auth/login', 'POST', { username: 'runtimeqa', password });
    timings.push(performance.now() - started);
  }
  // 005 §3:登录不自动选档;零档案会话 bootstrapRequired=true,唯一首建入口为
  // bootstrap-profile(管理角色+当次密码,创建即主档案、PIN 保护、不自动选档)。
  const bootstrapLogin = await api('/auth/login', 'POST', { username: 'runtimeqa', password });
  token = bootstrapLogin.sessionToken;
  checkEq(bootstrapLogin.bootstrapRequired, true, '005:零档案会话 bootstrapRequired=true(不允许借字段写身份)');
  mainProfile = await api('/auth/bootstrap-profile', 'POST', { name: 'SmokeOwner', pin: mainPin, ownerPassword: password }, 201);
  checkEq([mainProfile.isMain, mainProfile.pinProtected, mainProfile.type], [true, true, 'adult'],
    '005:bootstrap 主档案 isMain/PIN 保护/adult,且未自动选档(002 契约不自动选档保留)');
  checkEq((await api('/auth/session')).activeProfile, null, '005:bootstrap 后 activeProfile 仍为 null(不自动选档)');
  // 005 设置解锁编排首次成立(登录 → 主档案 unlock+select → POST /settings/access)。
  // 管理面建立后才能建档案:旧 POST /profiles 管理口已迁入 /settings/profiles(T125)。
  await ensureSettings();
  checkEq((await api('/settings/access')).unlocked, true, '005:设置授予已签发(GET /settings/access 最小状态)');
  // 阶段 2(002 契约保留):儿童档案 PIN 选档流 —— 005 统一 6 位数字 PIN(契约 pattern)
  const profile = await mapi('/settings/profiles', 'POST', { name: 'Protected', type: 'child', pin: '443210', ownerPassword: password }, 201);
  await api(`/profiles/${profile.id}/select`, 'POST', {}, 403);
  await api(`/profiles/${profile.id}/unlock`, 'POST', { pin: '000000' }, 403);
  await api(`/profiles/${profile.id}/unlock`, 'POST', { pin: '443210' });
  await api(`/profiles/${profile.id}/select`, 'POST', {});
  // 阶段 2(002 契约):策略读取/保存 —— 默认值、家长验证、版本冲突、锁定(真实 HTTP,非 mock)
  // 005 T126:策略管理迁入 /settings/profiles/{id}/policy;换档(儿童→主档案)已同事务
  // 撤销设置授予(identity-transition),ensureSettings 幂等重解锁。
  const policyRoute = `/settings/profiles/${profile.id}/policy`;
  const policy = await mapi(policyRoute, 'GET');
  assert.equal(policy.maxContentLevel, 12, 'child default level');
  assert.equal(policy.allowUnrated, false, 'child default unrated');
  assert.equal(policy.version, 1);
  const savedPolicy = await mapi(policyRoute, 'PUT', { ownerPassword: password, expectedVersion: 1, policy: { maxContentLevel: 10, allowUnrated: false } });
  assert.equal(savedPolicy.version, 2, 'version bump');
  assert.equal(savedPolicy.maxContentLevel, 10);
  await mapi(policyRoute, 'PUT', { ownerPassword: password, expectedVersion: 1, policy: { maxContentLevel: 3, allowUnrated: false } }, 409);
  await mapi(policyRoute, 'PUT', { expectedVersion: 2, policy: { maxContentLevel: 3, allowUnrated: false } }, 403);
  for (let i = 0; i < 5; i++) {
    await mapi(policyRoute, 'PUT', { ownerPassword: 'wrong-password', expectedVersion: 2, policy: { maxContentLevel: 3, allowUnrated: false } }, 403);
  }
  await mapi(policyRoute, 'PUT', { ownerPassword: password, expectedVersion: 2, policy: { maxContentLevel: 3, allowUnrated: false } }, 423);
  // 切回儿童档案跨重启(005:选档上下文持久;重启后管理读需主档案,届时再切回)
  await api(`/profiles/${profile.id}/unlock`, 'POST', { pin: '443210' });
  await api(`/profiles/${profile.id}/select`, 'POST', {});
  await stop();
  await start();
  assert.equal((await api('/auth/session')).activeProfile.id, profile.id, '005:儿童选档跨重启持久');
  await ensureSettings(); // 重启撤销全部设置授予(data-model §3)→ 重解锁;儿童→主档案换档
  const policyAfterRestart = await mapi(policyRoute, 'GET');
  assert.equal(policyAfterRestart.maxContentLevel, 10, 'policy persists across restart');
  assert.equal(policyAfterRestart.version, 2);
  const db = new SQLite(path.join(dir, 'hmp.db'));
  await db.backup(path.join(dir, 'restore.db'));
  db.close();
  const restored = new SQLite(path.join(dir, 'restore.db'), { readonly: true });
  // 005:bootstrap 先建主档案(首行已不再是儿童档)—— 断言儿童档在备份中存在
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM profile WHERE name = 'Protected'").get().n, 1, 'backup contains Protected profile');
  assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
  restored.close();
  await api('/auth/logout', 'POST', {}, 204);
  await api('/auth/logout', 'POST', {}, 204);
  await api('/auth/session', 'GET', undefined, 401);
  timings.sort((a, b) => a - b);
  assert.ok(timings[18] < 3000, 'SC-002 login p95 < 3 seconds');
  console.log(JSON.stringify({ result: 'PASS', loginP95Ms: Math.round(timings[18]), scenarios: [
    'migration drill/idempotent up', 'compiled SPA/API routing(005 address map)', 'initialization(no auto-login)+explicit login',
    'bootstrap main profile(PIN)/selection unlock+select(6-digit)', 'settings access unlock(005 T083)',
    'parent-verified policy save/version conflict/lockout(423,settings prefix)',
    'process restart persistence(selection+policy+grant revoked-then-reunlock)', 'backup restore integrity', 'logout/idempotency',
  ] }));

  /* -------------------------------------------------------------- */
  /* 阶段 3 前置:重新登录(阶段 2 以 logout 收尾)并清除阶段 2 刻意     */
  /* 造成的家长验证锁定(直改 DB,与 pointSourceAt 同一直访模式)。       */
  /* 005:观看成人 = 主档案 —— 管理写要求「当前主 Profile」,独立无 PIN    */
  /* 成人档无法承载管理调用;主档案 PIN 保护 → unlock+select 编排。       */
  /* -------------------------------------------------------------- */
  const relaunch = await api('/auth/login', 'POST', { username: 'runtimeqa', password });
  token = relaunch.sessionToken;
  serverDb().prepare('DELETE FROM parent_verification_state').run();
  await ensureSettings();
  const adultProfile = mainProfile; // 005:观看成人即主档案(后续 S2~S9 沿用该别名)

  /* -------------------------------------------------------------- */
  /* S1 US1 来源闭环(T031;quickstart A/SC-001/002)                  */
  /* -------------------------------------------------------------- */
  const iptv = await mapi('/settings/sources', 'POST', {
    ownerPassword: password, kind: 'iptv', name: '烟雾直播', remoteUrl: 'http://iptv-fixture.example/live.m3u',
  }, 201);
  pointSourceAt(iptv.id, `${fixtureBase}/live.m3u`);
  const iptvJob = await startRefresh(iptv.id);
  checkEq(iptvJob.counts, { added: 0, updated: 0, missing: 0, failed: 0, channels: 0, programmes: 0 }, '202 即时 counts 全零');
  const iptvDone = await waitForRefresh(iptvJob.id, ['succeeded']);
  checkEq(iptvDone.counts, { added: 3, updated: 0, missing: 0, failed: 0, channels: 0, programmes: 0 }, 'IPTV 首刷 added=3');

  const epg = await mapi('/settings/sources', 'POST', {
    ownerPassword: password, kind: 'epg', name: '烟雾指南', remoteUrl: 'http://epg-fixture.example/guide.xml',
  }, 201);
  pointSourceAt(epg.id, `${fixtureBase}/guide.xml`);
  const epgJob = await startRefresh(epg.id);
  const epgDone = await waitForRefresh(epgJob.id, ['succeeded']);
  checkEq(epgDone.counts, { added: 0, updated: 0, missing: 0, failed: 0, channels: 2, programmes: 3 }, 'EPG 首刷 counts');

  fs.writeFileSync(path.join(nasRoot, 'smoke-family-movie.mp4'), Buffer.alloc(4096, 7));
  fs.writeFileSync(path.join(nasRoot, 'smoke-late-night-horror.mp4'), Buffer.alloc(2048, 7));
  const nasSource = await mapi('/settings/sources', 'POST', {
    ownerPassword: password, kind: 'nas', name: '烟雾影库', rootKey: 'nas-main', relativeDirectory: '',
  }, 201);
  const nasJob = await startRefresh(nasSource.id);
  const nasDone = await waitForRefresh(nasJob.id, ['succeeded']);
  checkEq(nasDone.counts.added, 2, 'NAS 首刷 added=2');

  const list1 = await adultList();
  checkEq(list1.total, 5, '成人目录 = 3 频道 + 2 视频');
  const idsBefore = list1.items.map(item => item.id).sort();

  const againJob = await startRefresh(iptv.id);
  const againDone = await waitForRefresh(againJob.id, ['succeeded']);
  checkEq(againDone.counts.added, 0, '重复刷新 added=0');
  checkEq(againDone.counts.updated, 3, '重复刷新 updated=3');
  const list2 = await adultList();
  checkEq(list2.items.map(item => item.id).sort(), idsBefore, '重复刷新媒体身份稳定');

  pointSourceAt(iptv.id, `${fixtureBase}/broken.m3u`);
  const failJob = await startRefresh(iptv.id);
  const failDone = await waitForRefresh(failJob.id, ['failed']);
  check(typeof failDone.errorCode === 'string' && failDone.errorCode.length > 0, '失败任务携带稳定 errorCode');
  const list3 = await adultList();
  checkEq(list3.total, 5, '失败刷新保留上次成功目录');

  const disableVersion = await sourceVersionOf(iptv.id);
  await mapi(`/settings/sources/${iptv.id}`, 'PATCH', { ownerPassword: password, expectedVersion: disableVersion, enabled: false });
  const list4 = await adultList();
  checkEq(list4.total, 2, '禁用 IPTV 后仅 NAS 内容可见');
  check(list4.items.every(item => item.type === 'video'), '禁用后 IPTV 频道不可见');
  const enableVersion = await sourceVersionOf(iptv.id);
  await mapi(`/settings/sources/${iptv.id}`, 'PATCH', { ownerPassword: password, expectedVersion: enableVersion, enabled: true });
  const list5 = await adultList();
  checkEq(list5.total, 5, '重新启用后目录恢复');
  console.log('[S1] US1 来源闭环 OK:三来源成功导入/幂等刷新身份稳定/失败保留/禁用即时生效');

  /* -------------------------------------------------------------- */
  /* S2 US2 目录矩阵(T039;quickstart B/SC-003)                      */
  /* -------------------------------------------------------------- */
  // 005 T125:档案创建迁入 /settings/profiles(POST /profiles 管理口已删除)
  const childProfile = await mapi('/settings/profiles', 'POST', { name: 'SmokeChild', type: 'child', ownerPassword: password }, 201);
  const listS2 = await adultList('?pageSize=100');
  const mediaByTitle = (title) => listS2.items.find(item => item.title === title);
  const ch1 = mediaByTitle('烟雾一台');
  const ch2 = mediaByTitle('烟雾二台');
  const ch3 = mediaByTitle('烟雾三台');
  const videoA = mediaByTitle('smoke-family-movie');
  const videoB = mediaByTitle('smoke-late-night-horror');
  check(ch1 && ch2 && ch3 && videoA && videoB, 'S2 前置:五条媒体均可在目录中定位');
  // 人工分级(经真实 PATCH /settings/catalog/media,T128):ch1=0(白名单内可见)/videoA=3/videoB=18(超限);ch2/ch3 保持未评级
  for (const [media, level] of [[ch1, 0], [videoA, 3], [videoB, 18]]) {
    const patched = await mapi(`/settings/catalog/media/${media.id}`, 'PATCH', {
      ownerPassword: password, expectedVersion: media.version, contentLevel: level,
    });
    checkEq(patched.contentLevel, level, `人工分级生效: ${media.title}`);
    checkEq(patched.version, media.version + 1, '人工修正版本 +1');
  }
  // 儿童策略:maxContentLevel=6 + allowUnrated=false + blocked 含 ch3;白名单 ch1(可见)/ch2(未评级仍拒绝)
  // 005 T126:策略/名单管理迁入 /settings/profiles/{id}/policy(/lists)
  await mapi(`/settings/profiles/${childProfile.id}/policy`, 'PUT', {
    ownerPassword: password, expectedVersion: 1, policy: { maxContentLevel: 6, allowUnrated: false },
  });
  const childLists = await mapi(`/settings/profiles/${childProfile.id}/policy/lists`, 'PUT', {
    ownerPassword: password, expectedVersion: 2,
    allowedMediaIds: [], blockedMediaIds: [ch3.id], allowedChannelIds: [ch1.id, ch2.id],
  });
  checkEq(childLists.version, 3, '名单保存版本 +1');
  checkEq(childLists.blockedMediaIds, [ch3.id], 'blocked 名单已保存');

  // 第二「设备」:新登录会话(无 activeProfile → 403 ACTIVE_PROFILE_REQUIRED)
  const sessionB = (await api('/auth/login', 'POST', { username: 'runtimeqa', password })).sessionToken;
  const noProfile = await apiWith(sessionB, '/media', 'GET', undefined, 403);
  checkEq(noProfile.code, 'ACTIVE_PROFILE_REQUIRED', '无 activeProfile 会话 403');
  await apiWith(sessionB, `/profiles/${childProfile.id}/select`, 'POST', {});

  const adultAll = await adultList('?pageSize=100');
  checkEq(adultAll.total, 5, '成人列表 = 全量');
  checkEq(new Set(titlesOf(adultAll)), new Set(['烟雾一台', '烟雾二台', '烟雾三台', 'smoke-family-movie', 'smoke-late-night-horror']));
  const adultSearch = await adultList(`?q=${encodeURIComponent('烟雾')}&pageSize=100`);
  checkEq(adultSearch.total, 3, '成人搜索命中 3 频道');
  const adultPage2 = await adultList('?page=2&pageSize=2');
  checkEq(adultPage2.total, 5, '翻页 total 一致(成人)');
  checkEq(adultPage2.items.length, 2, '翻页第 2 页 2 条');

  const childAll = await apiWith(sessionB, '/media?pageSize=100');
  checkEq(childAll.total, 2, '儿童列表仅白名单频道 + 等级内视频');
  checkEq(new Set(titlesOf(childAll)), new Set(['烟雾一台', 'smoke-family-movie']));
  check(!titlesOf(childAll).includes('烟雾三台'), '被禁不可见');
  check(!titlesOf(childAll).includes('smoke-late-night-horror'), '超限不可见');
  check(!titlesOf(childAll).includes('烟雾二台'), '未评级频道不可见(allowUnrated=false)');
  const childSearch = await apiWith(sessionB, `/media?q=${encodeURIComponent('烟雾')}&pageSize=100`);
  checkEq(childSearch.total, 1, '儿童搜索被过滤');
  const childPage2 = await apiWith(sessionB, '/media?page=2&pageSize=2');
  checkEq(childPage2.total, 2, '翻页 total 一致(儿童)');
  checkEq(childPage2.items.length, 0, '儿童越界页空列表');

  const blockedGet = await apiWith(sessionB, `/media/${ch3.id}`, 'GET', undefined, 404);
  const missingGet = await apiWith(sessionB, `/media/${randomUUID()}`, 'GET', undefined, 404);
  checkEq(blockedGet, missingGet, '被禁 id 与随机 uuid 同形 404');
  checkEq(blockedGet.code, 'NOT_FOUND', '统一 NOT_FOUND');
  console.log('[S2] US2 目录矩阵 OK:成人全量/儿童过滤(超限/未评级/被禁)/搜索翻页 total 一致/同形 404/无档案 403');

  /* -------------------------------------------------------------- */
  /* S3 US4 EPG 全流程(T047;quickstart D/SC-008)                    */
  /* -------------------------------------------------------------- */
  const epgAgain = await startRefresh(epg.id);
  const epgAgainDone = await waitForRefresh(epgAgain.id, ['succeeded']);
  checkEq(epgAgainDone.counts, { added: 0, updated: 0, missing: 0, failed: 0, channels: 2, programmes: 3 }, 'EPG 刷新成功 counts');
  const patchVersion = await sourceVersionOf(iptv.id);
  await mapi(`/settings/sources/${iptv.id}`, 'PATCH', { ownerPassword: password, expectedVersion: patchVersion, epgSourceId: epg.id });
  const progCh1 = await api(`/media/${ch1.id}/programmes`);
  checkEq(progCh1.status, 'available', '关联频道节目可用');
  checkEq(progCh1.current.title, '晨间新闻', 'current 节目');
  checkEq(progCh1.current.startsAt, new Date(guideBase - 30 * MIN_MS).toISOString(), 'current 起始为 UTC ISO');
  checkEq(progCh1.next.title, '午间剧场', 'next 节目');
  checkEq(progCh1.next.endsAt, new Date(guideBase + 150 * MIN_MS).toISOString(), 'next 结束边界');
  const progCh3 = await api(`/media/${ch3.id}/programmes`);
  checkEq(progCh3, { status: 'unavailable', current: null, next: null }, '未关联 tvg-id → unavailable');
  const wrongPatch = await mapi(`/settings/sources/${iptv.id}`, 'PATCH', { ownerPassword: 'wrong-password', expectedVersion: patchVersion + 1, name: 'X' }, 403);
  checkEq(wrongPatch.code, 'PARENT_VERIFICATION_FAILED', '错误密码拒绝');

  // 并发刷新拒绝:hang 路由占住第一任务 → 第二任务 409 SOURCE_BUSY;释放后第一任务 failed,旧指南保留
  pointSourceAt(epg.id, `${fixtureBase}/hang.xml`);
  const hangJob = await startRefresh(epg.id);
  await waitForRefresh(hangJob.id, ['running']);
  const busy = await startRefresh(epg.id, 409);
  checkEq(busy.code, 'SOURCE_BUSY', '同来源并发刷新拒绝');
  abortFixturePending();
  const hangDone = await waitForRefresh(hangJob.id, ['failed']);
  check(hangDone.errorCode !== null, '被中断的读取以 failed 结束');
  const progAfterFail = await api(`/media/${ch1.id}/programmes`);
  checkEq(progAfterFail.status, 'available', '失败刷新保留旧指南');

  // 重启中断:慢 M3U 构造 running → SIGKILL → respawn 同 DATA_DIR → interrupted 可见 → 手动重试成功
  pointSourceAt(iptv.id, `${fixtureBase}/slow.m3u`);
  const slowJob = await startRefresh(iptv.id);
  await waitForRefresh(slowJob.id, ['running']);
  await killHard();
  await startResilient();
  const interrupted = await waitForRefresh(slowJob.id, ['interrupted'], 20_000);
  checkEq(interrupted.errorCode, null, 'interrupted 无 errorCode');
  check(interrupted.finishedAt !== null, 'interrupted 具备 finishedAt');
  pointSourceAt(iptv.id, `${fixtureBase}/live.m3u`);
  const retryJob = await startRefresh(iptv.id);
  const retryDone = await waitForRefresh(retryJob.id, ['succeeded']);
  checkEq(retryDone.counts.added, 0, '手动重试幂等 added=0');
  checkEq(retryDone.counts.updated, 3, '手动重试 updated=3');
  const listAfterRestart = await adultList('?pageSize=100');
  checkEq(listAfterRestart.total, 5, '中断+重试后目录完整保留');
  console.log('[S3] US4 EPG 全流程 OK:counts/关联 current+next/unavailable/并发 409 SOURCE_BUSY/失败保留/重启 interrupted/手动重试成功');

  /* -------------------------------------------------------------- */
  /* S4 US3 名单闭环(T053;quickstart B3/B4/SC-004)                  */
  /* -------------------------------------------------------------- */
  // 005 T128:候选查询/人工修正迁入 /settings/catalog/*(api.md §6)
  const noPwdQuery = await mapi('/settings/catalog/candidates/query', 'POST', {}, 403);
  checkEq(noPwdQuery.code, 'PARENT_VERIFICATION_REQUIRED', '未验证不能查询候选');
  const wrongPwdQuery = await mapi('/settings/catalog/candidates/query', 'POST', { ownerPassword: 'definitely-wrong' }, 403);
  checkEq(wrongPwdQuery.code, 'PARENT_VERIFICATION_FAILED', '错误密码不能查询候选');
  const noPwdSave = await mapi(`/settings/profiles/${childProfile.id}/policy/lists`, 'PUT', {
    expectedVersion: 1, allowedMediaIds: [], blockedMediaIds: [], allowedChannelIds: [],
  }, 403);
  checkEq(noPwdSave.code, 'PARENT_VERIFICATION_REQUIRED', '未验证不能保存名单');

  const candidates = await mapi('/settings/catalog/candidates/query', 'POST', { ownerPassword: password });
  check(candidates.items.some(item => item.id === videoB.id), '候选可见被儿童策略隐藏的媒体(超限 videoB)');

  const childBefore = await apiWith(sessionB, '/media?pageSize=100');
  checkEq(childBefore.total, 2, '名单变更前儿童不可见 videoB');
  const policyNow = await mapi(`/settings/profiles/${childProfile.id}/policy`);
  const allowSaved = await mapi(`/settings/profiles/${childProfile.id}/policy/lists`, 'PUT', {
    ownerPassword: password, expectedVersion: policyNow.version,
    allowedMediaIds: [videoB.id], blockedMediaIds: [ch3.id], allowedChannelIds: [ch1.id, ch2.id],
  });
  checkEq(allowSaved.version, policyNow.version + 1, '允许名单保存版本 +1');
  const childAfterAllow = await apiWith(sessionB, '/media?pageSize=100');
  checkEq(childAfterAllow.total, 3, '加入允许名单后儿童可见');
  check(childAfterAllow.items.some(item => item.id === videoB.id), '另一会话下一请求即生效(允许)');
  const blockSaved = await mapi(`/settings/profiles/${childProfile.id}/policy/lists`, 'PUT', {
    ownerPassword: password, expectedVersion: allowSaved.version,
    allowedMediaIds: [videoB.id], blockedMediaIds: [ch3.id, videoB.id], allowedChannelIds: [ch1.id, ch2.id],
  });
  checkEq(blockSaved.version, allowSaved.version + 1, '禁止名单保存版本 +1');
  const childAfterBlock = await apiWith(sessionB, '/media?pageSize=100');
  checkEq(childAfterBlock.total, 2, '再加入禁止后不可见(禁止优先,即使仍在允许名单)');
  check(!childAfterBlock.items.some(item => item.id === videoB.id), '禁止优先生效(另一会话下一请求)');
  console.log('[S4] US3 名单闭环 OK:候选绕过观看策略/允许后可见/再禁止不可见(禁止优先)/两设备下一请求生效');

  /* -------------------------------------------------------------- */
  /* S5 SC-005 性能基准(T056;quickstart G)—— HTTP 层证据              */
  /* -------------------------------------------------------------- */
  const perfSource = await mapi('/settings/sources', 'POST', {
    ownerPassword: password, kind: 'iptv', name: '性能直播源', remoteUrl: 'http://perf-fixture.example/perf.m3u',
  }, 201);
  console.log('[S5] perf source created, pointing at fixture');
  pointSourceAt(perfSource.id, `${fixtureBase}/perf.m3u`);
  const perfJobStart = performance.now();
  const perfJob = await startRefresh(perfSource.id);
  console.log(`[S5] perf refresh started id=${perfJob.id}`);
  const perfDone = await waitForRefresh(perfJob.id, ['succeeded'], 180_000);
  checkEq(perfDone.counts.added, PERF_ENTRIES, `性能源一次刷新导入 ${PERF_ENTRIES} 条`);
  const perfImportSeconds = (performance.now() - perfJobStart) / 1000;

  const bigList = await adultList('?page=1&pageSize=1');
  check(bigList.total >= 10_000, `/api/media 总量 ≥10000(实际 ${bigList.total})`);
  const totalMedia = bigList.total;

  const hardware = {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    nodeVersion: process.version,
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    cpuCount: os.cpus().length,
    totalMemBytes: os.totalmem(),
  };

  // 连续 20 次「搜索+翻页」:墙钟统计(每次样本 = 两个请求的合计墙钟)
  const samples = [];
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    const search = await adultList(`?q=${encodeURIComponent('烟雾')}&page=1&pageSize=20`);
    const page2 = await adultList('?page=2&pageSize=50');
    samples.push(performance.now() - started);
    checkEq(search.total, 3, '性能期搜索结果稳定');
    checkEq(page2.total, totalMedia, '性能期翻页 total 稳定');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const within2sCount = samples.filter(ms => ms <= 2000).length;
  const p50 = sorted[9];
  const p95 = sorted[18];
  // SC-005 的「至少 19 次 ≤2s」为真实浏览器页面展示准则(quickstart G);HTTP 层仅记录
  // 统计数据作为证据。当前实现 /api/media 单请求在全量策略过滤下随数据量线性变慢,
  // 属 T056 明文后续优化项(「不达标先优化批量查询/索引」),此处如实输出不做硬门禁。
  const httpTargetMet = within2sCount >= 19;

  // 刷新期间继续浏览:发起刷新后立即并发浏览,断言仍 200 且读完整快照(total 不变)
  const reloadStart = performance.now();
  const reloadJob = await startRefresh(perfSource.id);
  const duringTasks = [0, 1, 2, 3].map(async () => {
    const started = performance.now();
    const duringPage = await adultList('?page=3&pageSize=50');
    return { ms: Math.round((performance.now() - started) * 10) / 10, total: duringPage.total };
  });
  const duringResults = await Promise.all(duringTasks);
  for (const result of duringResults) {
    checkEq(result.total, totalMedia, '刷新期间浏览仍读完整快照');
  }
  const duringSamples = duringResults.map(result => result.ms);
  const reloadDone = await waitForRefresh(reloadJob.id, ['succeeded'], 180_000);
  checkEq(reloadDone.counts.added, 0, '刷新期间浏览不受影响:重复刷新 added=0');
  checkEq(reloadDone.counts.updated, PERF_ENTRIES, '重复刷新 updated=10000');
  const reloadSeconds = (performance.now() - reloadStart) / 1000;

  const s5 = {
    totalMedia,
    perfImportSeconds: Math.round(perfImportSeconds * 10) / 10,
    samplesMs: samples.map(ms => Math.round(ms * 10) / 10),
    httpWithin2sCount: within2sCount,
    httpP50Ms: Math.round(p50 * 10) / 10,
    httpP95Ms: Math.round(p95 * 10) / 10,
    httpTarget19of20Met: httpTargetMet,
    httpLayerNote: httpTargetMet
      ? 'HTTP 层达到 19/20 ≤2s 参考线'
      : 'HTTP 层未达 19/20 ≤2s 参考线:单请求全量策略过滤随数据量变慢,属 T056 明文后续优化项(批量查询/索引);SC-005 的 ≤2s 准则为浏览器页面展示层,证据待真实浏览器环境',
    duringRefresh: { httpStatusAll200: true, totalsStable: true, samplesMs: duringSamples, reloadSeconds: Math.round(reloadSeconds * 10) / 10 },
    hardware,
    browserEvidence: 'HTTP 层证据;浏览器渲染层证据需真实浏览器环境,当前记录为待补',
  };
  console.log(`[S5] 性能基准:总量 ${totalMedia};导入 ${s5.perfImportSeconds}s;20 次搜索+翻页 ≤2s 次数 ${within2sCount}/20;p50 ${s5.httpP50Ms}ms;p95 ${s5.httpP95Ms}ms;参考线 19/20 ${httpTargetMet ? '达到' : '未达(HTTP 层,见 httpLayerNote)'}`);

  /* -------------------------------------------------------------- */
  /* S6 US5 手动 EPG 绑定增补(T073;quickstart H/SC-010)—— 全部真实 HTTP */
  /* -------------------------------------------------------------- */
  // S6 夹具在分节开始时生成(与 S1~S3 的模块装载期不同):S5 万条导入耗时不确定,
  // 节目窗口必须围绕 S6 实际执行时刻的 now 构造(±60/90 分钟 current、+200/240 分钟
  // next 的宽窗),避免长跑后窗口过期把「无当前节目」误判成「绑定失效」。
  // 三个新路由只增不改,不影响既有夹具;S6 数据量小,不影响已完成的性能基准。
  const s6Base = Math.floor(Date.now() / 1000) * 1000;
  const s6EpgAText = buildXmltvText(
    [
      { id: 'chan-match', displayName: 'S6匹配频道' },
      { id: 'chan-other', displayName: 'S6另一频道' },
    ],
    [
      { channel: 'chan-match', start: xmltvStamp(s6Base - 90 * MIN_MS), stop: xmltvStamp(s6Base + 90 * MIN_MS), title: 'S6匹配当前' },
      { channel: 'chan-match', start: xmltvStamp(s6Base + 90 * MIN_MS), stop: xmltvStamp(s6Base + 240 * MIN_MS), title: 'S6匹配下一' },
      { channel: 'chan-other', start: xmltvStamp(s6Base - 60 * MIN_MS), stop: xmltvStamp(s6Base + 60 * MIN_MS), title: 'S6另一当前' },
      { channel: 'chan-other', start: xmltvStamp(s6Base + 60 * MIN_MS), stop: xmltvStamp(s6Base + 200 * MIN_MS), title: 'S6另一下一' },
    ],
  );
  const s6EpgBText = buildXmltvText(
    [{ id: 'chan-alt', displayName: 'S6备选频道' }],
    [
      { channel: 'chan-alt', start: xmltvStamp(s6Base - 60 * MIN_MS), stop: xmltvStamp(s6Base + 60 * MIN_MS), title: 'S6备选当前' },
      { channel: 'chan-alt', start: xmltvStamp(s6Base + 60 * MIN_MS), stop: xmltvStamp(s6Base + 200 * MIN_MS), title: 'S6备选下一' },
    ],
  );
  // tvg-id 与 EPG-A/EPG-B 频道 id 全不相交(chan-match-a 与 chan-match 是不同字符串,
  // 前缀相近也不得自动匹配)→ 自动链全程无匹配,节目只来自手动目标或 FR-007 降级。
  const s6M3uText = buildM3uText([
    { name: 'S6绑定台', tvgId: 'chan-x', url: 'http://s6-stream.example/chan-x.m3u8' },
    { name: 'S6备用台', tvgId: 'chan-match-a', url: 'http://s6-stream.example/chan-match-a.m3u8' },
  ]);
  fixtureRoutes.set('/s6-epg-a.xml', (req, res) => fixtureText(res, 200, 'application/xml', s6EpgAText));
  fixtureRoutes.set('/s6-epg-b.xml', (req, res) => fixtureText(res, 200, 'application/xml', s6EpgBText));
  fixtureRoutes.set('/s6-live.m3u', (req, res) => fixtureText(res, 200, 'audio/x-mpegurl', s6M3uText));

  const s6StartCount = assertionCount;
  // 005 T128:手动 EPG 绑定迁入 /settings/catalog/media/{id}(§6「不保留旧 /catalog 管理入口」)
  const catalogMediaRoute = (mediaId) => `/settings/catalog/media/${mediaId}`;
  const queryBindingS6 = (mediaId, body, status = 200) => mapi(`${catalogMediaRoute(mediaId)}/epg-binding/query`, 'POST', body, status);
  const queryCandidatesS6 = (mediaId, body, status = 200) => mapi(`${catalogMediaRoute(mediaId)}/epg-candidates/query`, 'POST', body, status);
  const putBindingS6 = (mediaId, body, status = 200) => mapi(`${catalogMediaRoute(mediaId)}/epg-binding`, 'PUT', body, status);
  // manual 保存体工厂(家长验证语义沿用 S1 的 ownerPassword 请求写法);
  // expectedVersion/expectedEpgGeneration 每次显式给出 —— 服务层按 generation→version 次序校验。
  const manualSave = (overrides = {}) => ({
    ownerPassword: password, mode: 'manual', expectedVersion: 0,
    epgSourceId: epgA.id, xmltvChannelId: 'chan-match', expectedEpgGeneration: 1, ...overrides,
  });

  // 三来源:EPG-A(chan-match/chan-other)/EPG-B(chan-alt)/S6 IPTV(tvg-id 全不相交)
  const epgA = await mapi('/settings/sources', 'POST', {
    ownerPassword: password, kind: 'epg', name: 'S6指南A', remoteUrl: 'http://s6-epg-a-fixture.example/guide.xml',
  }, 201);
  pointSourceAt(epgA.id, `${fixtureBase}/s6-epg-a.xml`);
  const epgAFirst = await startRefresh(epgA.id);
  checkEq((await waitForRefresh(epgAFirst.id, ['succeeded'])).counts,
    { added: 0, updated: 0, missing: 0, failed: 0, channels: 2, programmes: 4 }, 'S6 前置:EPG-A 首刷 counts(2 频道 4 节目)');
  const epgB = await mapi('/settings/sources', 'POST', {
    ownerPassword: password, kind: 'epg', name: 'S6指南B', remoteUrl: 'http://s6-epg-b-fixture.example/guide.xml',
  }, 201);
  pointSourceAt(epgB.id, `${fixtureBase}/s6-epg-b.xml`);
  const epgBFirst = await startRefresh(epgB.id);
  checkEq((await waitForRefresh(epgBFirst.id, ['succeeded'])).counts,
    { added: 0, updated: 0, missing: 0, failed: 0, channels: 1, programmes: 2 }, 'S6 前置:EPG-B 首刷 counts(1 频道 2 节目)');
  const s6Iptv = await mapi('/settings/sources', 'POST', {
    ownerPassword: password, kind: 'iptv', name: 'S6直播', remoteUrl: 'http://s6-iptv-fixture.example/live.m3u',
  }, 201);
  pointSourceAt(s6Iptv.id, `${fixtureBase}/s6-live.m3u`);
  const s6IptvFirst = await startRefresh(s6Iptv.id);
  checkEq((await waitForRefresh(s6IptvFirst.id, ['succeeded'])).counts,
    { added: 2, updated: 0, missing: 0, failed: 0, channels: 0, programmes: 0 }, 'S6 前置:S6 IPTV 首刷 added=2');
  const s6Bound = (await adultList(`?q=${encodeURIComponent('S6绑定台')}`)).items[0];
  const s6Spare = (await adultList(`?q=${encodeURIComponent('S6备用台')}`)).items[0];
  check(s6Bound !== undefined && s6Spare !== undefined, 'S6 前置:两个新频道可在目录定位');

  // —— 组 1:自动不匹配(已关联 EPG-A 但 tvg-id 全不相交)—————————————
  const s6AssocVersion = await sourceVersionOf(s6Iptv.id);
  await mapi(`/settings/sources/${s6Iptv.id}`, 'PATCH', { ownerPassword: password, expectedVersion: s6AssocVersion, epgSourceId: epgA.id });
  const s6IptvAgain = await startRefresh(s6Iptv.id);
  checkEq((await waitForRefresh(s6IptvAgain.id, ['succeeded'])).counts,
    { added: 0, updated: 2, missing: 0, failed: 0, channels: 0, programmes: 0 }, 'S6-1:关联后刷新 IPTV 幂等 updated=2');
  checkEq(await api(`/media/${s6Bound.id}/programmes`), { status: 'unavailable', current: null, next: null },
    'S6-1:刷新 IPTV 后已关联 EPG-A 但 tvg-id 不相交 → unavailable(自动无匹配)');
  checkEq((await api(`/media/${s6Spare.id}/programmes`)).status, 'unavailable', 'S6-1:chan-match-a 前缀相近也不得自动匹配');

  // —— 组 2:基线读取 + 候选查询(家长验证/来源过滤/q 过滤/generation)——————
  checkEq(await queryBindingS6(s6Bound.id, { ownerPassword: password }), {
    mediaId: s6Bound.id, mode: 'auto', version: 0, epgSourceId: null, xmltvChannelId: null, status: 'auto', invalidReason: null,
  }, 'S6-2:无行绑定基线 = auto/version 0/status auto');
  const candA = await queryCandidatesS6(s6Bound.id, { ownerPassword: password, epgSourceId: epgA.id });
  checkEq(candA.total, 2, 'S6-2:EPG-A 候选 total=2');
  checkEq(candA.items.map(item => item.xmltvChannelId), ['chan-match', 'chan-other'], 'S6-2:候选按 xmltv_channel_id 升序');
  checkEq(candA.epgGeneration, 1, 'S6-2:页级 epgGeneration = 首次成功发布后的 g1');
  const matchItem = candA.items[0];
  checkEq(matchItem.displayName, 'S6匹配频道', 'S6-2:候选携带 displayName');
  checkEq(matchItem.current.title, 'S6匹配当前', 'S6-2:候选 current 围绕 now');
  checkEq(matchItem.next.title, 'S6匹配下一', 'S6-2:候选 next 节目');
  checkEq(Object.keys(matchItem).sort(), ['current', 'displayName', 'next', 'xmltvChannelId'], 'S6-2:候选条目字段白名单(无源位置)');
  const candFiltered = await queryCandidatesS6(s6Bound.id, { ownerPassword: password, epgSourceId: epgA.id, q: 'match' });
  checkEq(candFiltered.items.map(item => item.xmltvChannelId), ['chan-match'], 'S6-2:q 子串过滤命中 chan-match');
  checkEq(candFiltered.total, 1, 'S6-2:q 过滤后 total=1');
  const candB = await queryCandidatesS6(s6Bound.id, { ownerPassword: password, epgSourceId: epgB.id });
  checkEq(candB.items.map(item => item.xmltvChannelId), ['chan-alt'], 'S6-2:来源过滤 —— EPG-B 只返回 chan-alt');
  checkEq(candB.epgGeneration, 1, 'S6-2:EPG-B 独立 generation');

  // —— 组 3:保存锁定(manual v0→v1)与节目即时切换 ———————————————
  const saved = await putBindingS6(s6Bound.id, manualSave({ expectedVersion: 0, expectedEpgGeneration: candA.epgGeneration }));
  checkEq(saved, {
    mediaId: s6Bound.id, mode: 'manual', version: 1, epgSourceId: epgA.id,
    xmltvChannelId: 'chan-match', status: 'valid', invalidReason: null,
  }, 'S6-3:PUT manual(expectedVersion=0,g=g1)→ 200 valid/version 1');
  checkEq(await queryBindingS6(s6Bound.id, { ownerPassword: password }), {
    mediaId: s6Bound.id, mode: 'manual', version: 1, epgSourceId: epgA.id,
    xmltvChannelId: 'chan-match', status: 'valid', invalidReason: null,
  }, 'S6-3:保存后读取一致(mode=manual/status=valid/version=1)');
  const progManual = await api(`/media/${s6Bound.id}/programmes`);
  checkEq(progManual.status, 'available', 'S6-3:manual 绑定后节目立即可用');
  checkEq(progManual.current.title, 'S6匹配当前', 'S6-3:current 来自 EPG-A chan-match(与自动链无关)');
  checkEq(progManual.next.title, 'S6匹配下一', 'S6-3:next 来自 EPG-A chan-match');
  checkEq(progManual.current.startsAt, new Date(s6Base - 90 * MIN_MS).toISOString(), 'S6-3:current 起始与夹具窗口一致(UTC ISO)');
  checkEq((await api(`/media/${s6Spare.id}/programmes`)).status, 'unavailable', 'S6-3:绑定不外溢 —— 未绑定频道仍 unavailable');

  // —— 组 4:刷新/重启/改默认 EPG 保留 ——————————————————————————
  const epgAAgain = await startRefresh(epgA.id);
  checkEq((await waitForRefresh(epgAAgain.id, ['succeeded'])).counts,
    { added: 0, updated: 0, missing: 0, failed: 0, channels: 2, programmes: 4 }, 'S6-4:EPG-A 重复刷新 counts(窗口替换不触碰绑定)');
  const bindingAfterRefresh = await queryBindingS6(s6Bound.id, { ownerPassword: password });
  checkEq([bindingAfterRefresh.mode, bindingAfterRefresh.status, bindingAfterRefresh.version], ['manual', 'valid', 1],
    'S6-4:EPG 刷新后绑定保留 manual/valid/v1');
  checkEq((await api(`/media/${s6Bound.id}/programmes`)).current.title, 'S6匹配当前', 'S6-4:EPG 刷新后节目仍正确');
  await killHard();
  await startResilient();
  const bindingAfterRestart = await queryBindingS6(s6Bound.id, { ownerPassword: password });
  checkEq([bindingAfterRestart.mode, bindingAfterRestart.status, bindingAfterRestart.version], ['manual', 'valid', 1],
    'S6-4:SIGKILL+respawn 后绑定保留');
  checkEq((await api(`/media/${s6Bound.id}/programmes`)).current.title, 'S6匹配当前', 'S6-4:重启后节目仍正确');
  const s6PatchVersion = await sourceVersionOf(s6Iptv.id);
  await mapi(`/settings/sources/${s6Iptv.id}`, 'PATCH', { ownerPassword: password, expectedVersion: s6PatchVersion, epgSourceId: epgB.id });
  checkEq((await api(`/media/${s6Bound.id}/programmes`)).current.title, 'S6匹配当前',
    'S6-4:IPTV 默认 EPG 改关联 EPG-B 后仍用 manual 目标(EPG-A chan-match)节目');
  checkEq((await queryBindingS6(s6Bound.id, { ownerPassword: password })).epgSourceId, epgA.id, 'S6-4:绑定目标未随默认 EPG 漂移');

  // —— 组 5:conflicted → invalid 不回退;恢复同 ID 重新 valid ————————
  serverDb().prepare("UPDATE epg_channel SET conflicted = 1 WHERE source_id = ? AND xmltv_channel_id = 'chan-match'").run(epgA.id);
  checkEq(await api(`/media/${s6Bound.id}/programmes`), { status: 'unavailable', current: null, next: null },
    'S6-5:目标频道 conflicted → unavailable(默认 EPG 已是 EPG-B,不回退自动/其他 EPG)');
  const conflictedState = await queryBindingS6(s6Bound.id, { ownerPassword: password });
  checkEq([conflictedState.mode, conflictedState.status, conflictedState.invalidReason, conflictedState.version],
    ['manual', 'invalid', 'channel_conflict', 1], 'S6-5:读取状态 = invalid/channel_conflict(版本不变)');
  serverDb().prepare("UPDATE epg_channel SET conflicted = 0 WHERE source_id = ? AND xmltv_channel_id = 'chan-match'").run(epgA.id);
  const restoredState = await queryBindingS6(s6Bound.id, { ownerPassword: password });
  checkEq([restoredState.status, restoredState.invalidReason], ['valid', null], 'S6-5:恢复同 ID(conflicted=0)→ 重新 valid');
  checkEq((await api(`/media/${s6Bound.id}/programmes`)).current.title, 'S6匹配当前', 'S6-5:恢复后节目恢复');

  // —— 组 6:解除恢复自动 + 旧版本 ABA 防护 ————————————————————
  const unbound = await putBindingS6(s6Bound.id, { ownerPassword: password, mode: 'auto', expectedVersion: 1 });
  checkEq([unbound.mode, unbound.version, unbound.epgSourceId, unbound.xmltvChannelId, unbound.status],
    ['auto', 2, null, null, 'auto'], 'S6-6:解除 → auto 墓碑 v2(目标两列清空)');
  checkEq(await api(`/media/${s6Bound.id}/programmes`), { status: 'unavailable', current: null, next: null },
    'S6-6:解除后回自动链 —— tvg 无匹配 → unavailable(FR-007)');
  const abaStale = await putBindingS6(s6Bound.id, manualSave({ expectedVersion: 1, expectedEpgGeneration: 2 }), 409);
  checkEq(abaStale.code, 'EPG_BINDING_VERSION_CONFLICT', 'S6-6:解除后旧 version=1 保存 → 409(ABA 防护,当前已 v2)');
  const afterAba = await queryBindingS6(s6Bound.id, { ownerPassword: password });
  checkEq([afterAba.mode, afterAba.version], ['auto', 2], 'S6-6:409 后原配置不变');

  // —— 组 7:并发保存(恰一成功)+ 候选 generation 过期 ————————————
  // 并发对不预先断言单请求状态码:两路响应先都取回,再断言「恰一 200 一 409」
  const putBindingLooseS6 = (mediaId, body) => fetch(`${base}/api${catalogMediaRoute(mediaId)}/epg-binding`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
  const [leftR, rightR] = await Promise.all([
    putBindingLooseS6(s6Bound.id, manualSave({ expectedVersion: 2, expectedEpgGeneration: 2, xmltvChannelId: 'chan-match' })),
    putBindingLooseS6(s6Bound.id, manualSave({ expectedVersion: 2, expectedEpgGeneration: 2, xmltvChannelId: 'chan-other' })),
  ]);
  checkEq([leftR.status, rightR.status].sort(), [200, 409], 'S6-7:两路并发同版本保存 → 恰一 200 一 409');
  const loser = leftR.status === 409 ? leftR : rightR;
  const winner = leftR.status === 200 ? leftR : rightR;
  checkEq(loser.body.code, 'EPG_BINDING_VERSION_CONFLICT', 'S6-7:失败方为 EPG_BINDING_VERSION_CONFLICT');
  const winnerState = await queryBindingS6(s6Bound.id, { ownerPassword: password });
  checkEq([winnerState.version, winnerState.xmltvChannelId], [3, winner.body.xmltvChannelId], 'S6-7:落库版本 3 且目标与胜者一致');
  const candBeforeBump = await queryCandidatesS6(s6Bound.id, { ownerPassword: password, epgSourceId: epgA.id });
  checkEq(candBeforeBump.epgGeneration, 2, 'S6-7:再刷新前 generation=2(候选 g 已取得)');
  const epgABump = await startRefresh(epgA.id);
  await waitForRefresh(epgABump.id, ['succeeded']);
  const candAfterBump = await queryCandidatesS6(s6Bound.id, { ownerPassword: password, epgSourceId: epgA.id });
  checkEq(candAfterBump.epgGeneration, 3, 'S6-7:EPG-A 再刷新后 generation 2→3');
  const staleGen = await putBindingS6(s6Bound.id,
    manualSave({ expectedVersion: 3, expectedEpgGeneration: candBeforeBump.epgGeneration }), 409);
  checkEq(staleGen.code, 'EPG_CANDIDATE_STALE', 'S6-7:用旧 generation 保存 → 409 EPG_CANDIDATE_STALE(generation 先于版本校验)');
  const staleVersion = await putBindingS6(s6Bound.id, manualSave({ expectedVersion: 2, expectedEpgGeneration: 3 }), 409);
  checkEq(staleVersion.code, 'EPG_BINDING_VERSION_CONFLICT', 'S6-7:对照 —— 新 generation+旧 version → 409 VERSION_CONFLICT(两道防护独立)');
  const resaved = await putBindingS6(s6Bound.id,
    manualSave({ expectedVersion: 3, expectedEpgGeneration: candAfterBump.epgGeneration }));
  checkEq([resaved.status, resaved.version, resaved.xmltvChannelId], ['valid', 4, 'chan-match'],
    'S6-7:重查候选后以新 generation 重存成功 → v4(锁定 chan-match 供负向组)');

  // —— 组 8:负向(管理角色/缺错密码/非频道/禁用源)与泄漏反向断言 ——————————
  // 005 契约差异(api.md §1/§6):Settings 边界管理角色 = owner **与 admin** ——
  // 旧 004「requireOwner → 403 FORBIDDEN」的 owner-only 语义在设置路由不复存在
  // (device 记录查询在服务层继承 owner-only,见 S9-4)。直改 role 与 pointSourceAt
  // 同直访模式,SessionGuard/SettingsAccessGuard 每请求重读;用后立即恢复 owner。
  serverDb().prepare("UPDATE account SET role = 'admin' WHERE username = 'runtimeqa'").run();
  const adminQuery = await queryBindingS6(s6Bound.id, { ownerPassword: password });
  checkEq([adminQuery.mode, adminQuery.status, adminQuery.version], ['manual', 'valid', 4],
    'S6-8:admin 亦为管理角色 → 设置查询 200(005 契约;旧 owner-only 断言按契约改写)');
  const adminGrantRevoked = await mapi('/settings/access', 'DELETE', undefined, 204);
  checkEq(adminGrantRevoked, undefined, 'S6-8:DELETE /settings/access 仅 Session 即可撤销(幂等 204)');
  // 无授予负向必须绕过 ensureSettings(否则幂等重解锁会把断言打穿):直用 api()
  const adminNoGrant = await api(`${catalogMediaRoute(s6Bound.id)}/epg-binding/query`, 'POST', { ownerPassword: password }, 403);
  checkEq(adminNoGrant.code, 'SETTINGS_ACCESS_REQUIRED', 'S6-8:管理角色但无设置授予 → 403(grant 维度独立拒绝)');
  serverDb().prepare("UPDATE account SET role = 'owner' WHERE username = 'runtimeqa'").run();
  await ensureSettings(); // 恢复授予,后续负向按「有授予」口径断言
  const childNoPwd = await apiWith(sessionB, `${catalogMediaRoute(s6Bound.id)}/epg-binding/query`, 'POST', {}, 403);
  checkEq(childNoPwd.code, 'SETTINGS_ACCESS_REQUIRED', 'S6-8:儿童档案会话(非主档案)→ 403(005 设置边界先于密码;旧 PARENT_VERIFICATION_REQUIRED 语义由 grant 前置取代)');
  const ownerNoPwd = await queryBindingS6(s6Bound.id, {}, 403);
  checkEq(ownerNoPwd.code, 'PARENT_VERIFICATION_REQUIRED', 'S6-8:owner 会话缺密码 → 403');
  const wrongPwd = await putBindingS6(s6Bound.id,
    manualSave({ expectedVersion: 4, expectedEpgGeneration: 3, ownerPassword: 'definitely-wrong' }), 403);
  checkEq(wrongPwd.code, 'PARENT_VERIFICATION_FAILED', 'S6-8:错误密码 → 403');
  const videoPut = await putBindingS6(videoA.id, manualSave({ expectedVersion: 0, expectedEpgGeneration: 3 }), 400);
  checkEq(videoPut.code, 'VALIDATION_FAILED', 'S6-8:非频道媒体(NAS 导入 video)→ 400');
  const epgADisableVersion = await sourceVersionOf(epgA.id);
  await mapi(`/settings/sources/${epgA.id}`, 'PATCH', { ownerPassword: password, expectedVersion: epgADisableVersion, enabled: false });
  const disabledState = await queryBindingS6(s6Bound.id, { ownerPassword: password });
  checkEq([disabledState.status, disabledState.invalidReason], ['invalid', 'source_disabled'],
    'S6-8:禁用目标源 → 现有绑定 invalid/source_disabled');
  checkEq(await api(`/media/${s6Bound.id}/programmes`), { status: 'unavailable', current: null, next: null },
    'S6-8:禁用目标源 → unavailable(不回退默认 EPG-B)');
  const disabledNew = await putBindingS6(s6Bound.id, manualSave({ expectedVersion: 4, expectedEpgGeneration: 3 }), 422);
  checkEq(disabledNew.code, 'EPG_SOURCE_NOT_READY', 'S6-8:禁用源上新绑定 → 422 EPG_SOURCE_NOT_READY');
  const disabledCand = await queryCandidatesS6(s6Bound.id, { ownerPassword: password, epgSourceId: epgA.id }, 422);
  checkEq(disabledCand.code, 'EPG_SOURCE_NOT_READY', 'S6-8:禁用源候选查询 → 422 EPG_SOURCE_NOT_READY');
  const epgAEnableVersion = await sourceVersionOf(epgA.id);
  await mapi(`/settings/sources/${epgA.id}`, 'PATCH', { ownerPassword: password, expectedVersion: epgAEnableVersion, enabled: true });
  const reEnabled = await queryBindingS6(s6Bound.id, { ownerPassword: password });
  checkEq([reEnabled.status, reEnabled.invalidReason, reEnabled.version], ['valid', null, 4],
    'S6-8:重新启用目标源 → 恢复 valid(版本不变)');
  checkEq((await api(`/media/${s6Bound.id}/programmes`)).current.title, 'S6匹配当前', 'S6-8:重新启用后节目恢复');
  // 泄漏反向断言:候选/绑定 200 响应体不得含流地址/夹具源地址/物理路径/密码
  const s6LeakTexts = [];
  const s6RawPosts = [
    [`${catalogMediaRoute(s6Bound.id)}/epg-candidates/query`, { ownerPassword: password, epgSourceId: epgA.id }],
    [`${catalogMediaRoute(s6Bound.id)}/epg-binding/query`, { ownerPassword: password }],
  ];
  for (const [route, body] of s6RawPosts) {
    const response = await fetch(`${base}/api${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, `POST ${route} -> 200`);
    s6LeakTexts.push(await response.text());
  }
  for (const fragment of ['s6-stream.example', '.m3u8', 's6-epg-a-fixture.example', 's6-epg-b-fixture.example', 's6-iptv-fixture.example', nasRoot, password]) {
    const kind = fragment === nasRoot ? 'NAS 物理路径' : fragment === password ? '家长密码' : fragment;
    check(!s6LeakTexts.some(text => text.includes(fragment)), `S6-8:候选/绑定响应体不含敏感片段(${kind})`);
  }
  const s6AssertionCount = assertionCount - s6StartCount;
  console.log(`[S6] US5 手动 EPG 绑定 OK:自动不匹配/候选查询与来源过滤/保存锁定/刷新重启改默认保留/conflicted invalid 无回退/解除 ABA/并发与 generation 双 409/负向与泄漏反向断言(新增 ${s6AssertionCount} 断言)`);

  /* -------------------------------------------------------------- */
  /* S7 US2 播放负向矩阵(T039)—— 全部真实 HTTP,独立临时 DATA_DIR:      */
  /* 在媒体/控制请求间切档案/收紧策略/注销/停源,下一请求拒绝;旧缓冲不计  */
  /* 停止期限(拒绝后立即重取同一票 URL 必拒);流中失败不注入 JSON。      */
  /* 媒体面:NAS direct 为主(ffmpeg 生成真实 mp4 → probe → direct),另    */
  /* 起本地 http HLS 上游(对齐 playback-stream.e2e-spec.ts 模式)覆盖      */
  /* 清单/分片/MAP/key/字幕请求;失败码轮询/资产同形 404 分层说明见组 6。  */
  /* -------------------------------------------------------------- */
  const s7StartCount = assertionCount;
  // 前置 1:ffmpeg 生成真实可播 mp4(H.264 8bit yuv420p + AAC + mp4 容器 → plan direct,
  // 本机 ffmpeg 8.1.1 在位)。同内容两份独立媒体身份:A 供全程基线与负向矩阵,
  // B 为目录第二可播样本(独立解析/授权路径,不与 A 牵连)。
  const s7Ffmpeg = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=128x96:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'baseline',
    '-c:a', 'aac', '-b:a', '32k', '-shortest', '-movflags', '+faststart',
    path.join(nasRoot, 'smoke-playable-a.mp4'),
  ], { encoding: 'utf8' });
  checkEq(s7Ffmpeg.status, 0, `S7 前置:ffmpeg 生成真实 mp4(本机 ffmpeg 在位;stderr: ${String(s7Ffmpeg.stderr ?? '').slice(0, 200)})`);
  fs.copyFileSync(path.join(nasRoot, 'smoke-playable-a.mp4'), path.join(nasRoot, 'smoke-playable-b.mp4'));
  const movieBytesA = fs.readFileSync(path.join(nasRoot, 'smoke-playable-a.mp4'));
  check(movieBytesA.length > 0, 'S7 前置:真实 mp4 非空(供字节级断言)');
  const s7NasJob = await startRefresh(nasSource.id);
  const s7NasDone = await waitForRefresh(s7NasJob.id, ['succeeded']);
  checkEq(s7NasDone.counts.added, 2, 'S7 前置:两份真实 mp4 经 NAS 刷新导入');
  const s7Catalog = await adultList(`?q=${encodeURIComponent('smoke-playable')}`);
  const playableA = s7Catalog.items.find(item => item.title === 'smoke-playable-a');
  const playableB = s7Catalog.items.find(item => item.title === 'smoke-playable-b');
  check(playableA !== undefined && playableB !== undefined, 'S7 前置:两份可播媒体在目录定位');

  // 前置 2:本地 http HLS 上游(仅 127.0.0.1 随机端口,LAN_ALLOWED_TARGETS 已许可)——
  // master(变体+字幕组)/hi(MAP+KEY+分片;broken 标志切换为断流分片)/字幕子清单/VTT。
  const s7SegmentBytes = Buffer.alloc(2048, 0x42);
  const s7InitBytes = Buffer.alloc(720, 0x21);
  const s7KeyBytes = Buffer.from('0123456789abcdef', 'utf8');
  const s7VttText = 'WEBVTT\n\n00:00:00.000 --> 00:00:06.000\nS7 字幕文本 plain words\n';
  const s7MasterText = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="English",DEFAULT=YES,LANGUAGE="en",URI="subs/playlist.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,SUBTITLES="sub"',
    'hi.m3u8',
    '',
  ].join('\n');
  const s7HiText = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x9c7db8778570d05c3177c349fd9236aa',
    '#EXTINF:4.0,',
    'seg-0.ts',
    '',
  ].join('\n');
  const s7HiBrokenText = ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXTINF:4.0,', 'broken-seg.ts', ''].join('\n');
  // broken 模式下 master 去掉字幕组:断流变体成为唯一子清单(资产 URL 无歧义)
  const s7MasterBrokenText = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    'hi.m3u8',
    '',
  ].join('\n');
  const s7SubsText = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXTINF:6.0,', '000.vtt', ''].join('\n');
  let s7VariantBroken = false;
  s7Upstream = http.createServer((req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
    const pathname = new URL(req.url ?? '/', 'http://s7-upstream.invalid').pathname;
    const s7Text = (body, contentType) => {
      const payload = Buffer.from(body, 'utf8');
      res.writeHead(200, { 'content-type': contentType, 'content-length': String(payload.length), connection: 'close' });
      res.end(payload);
    };
    const s7Bytes = (payload, contentType) => {
      res.writeHead(200, { 'content-type': contentType, 'content-length': String(payload.length), connection: 'close' });
      res.end(payload);
    };
    if (pathname === '/s7/master.m3u8') return s7Text(s7VariantBroken ? s7MasterBrokenText : s7MasterText, 'application/vnd.apple.mpegurl');
    if (pathname === '/s7/hi.m3u8') return s7Text(s7VariantBroken ? s7HiBrokenText : s7HiText, 'application/vnd.apple.mpegurl');
    if (pathname === '/s7/subs/playlist.m3u8') return s7Text(s7SubsText, 'application/vnd.apple.mpegurl');
    if (pathname === '/s7/subs/000.vtt') return s7Text(s7VttText, 'text/vtt');
    if (pathname === '/s7/init.mp4') return s7Bytes(s7InitBytes, 'video/mp4');
    if (pathname === '/s7/key.bin') return s7Bytes(s7KeyBytes, 'application/octet-stream');
    if (pathname === '/s7/seg-0.ts') return s7Bytes(s7SegmentBytes, 'video/mp2t');
    if (pathname === '/s7/broken-seg.ts') {
      // 断流分片:声明 2048 字节、发出 1024 字节后粗暴断开(模拟源故障;对齐 T015 契约场景)
      res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': '2048', connection: 'close' });
      res.write(Buffer.alloc(1024, 0x41));
      // eslint-disable-next-line no-undef -- 断流时序:宏任务延迟销毁,模拟上游粗暴断开
      setImmediate(() => res.destroy());
      return;
    }
    res.writeHead(404, { connection: 'close' });
    res.end('runtime-smoke s7 upstream: no route');
  });
  await new Promise((resolve, reject) => {
    s7Upstream.once('error', reject);
    s7Upstream.listen(0, '127.0.0.1', () => {
      s7Upstream.off('error', reject);
      resolve();
    });
  });
  const s7UpstreamBase = `http://127.0.0.1:${s7Upstream.address().port}`;
  // HLS 频道经真实导入链建源(字面 URL 不指向上游);导入后直改 playback_source 的
  // location/requires_proxy 接到本地上游(与 pointSourceAt 同直访模式,仅测试夹具)。
  fixtureRoutes.set('/s7-live.m3u', (req, res) => fixtureText(res, 200, 'audio/x-mpegurl',
    buildM3uText([{ name: 'S7直播台', tvgId: 's7-ch-1', url: 'http://s7-iptv-fixture.example/master.m3u8' }])));
  const s7Iptv = await mapi('/settings/sources', 'POST', {
    ownerPassword: password, kind: 'iptv', name: 'S7直播', remoteUrl: 'http://s7-iptv-fixture.example/live.m3u',
  }, 201);
  pointSourceAt(s7Iptv.id, `${fixtureBase}/s7-live.m3u`);
  const s7IptvJob = await startRefresh(s7Iptv.id);
  const s7IptvDone = await waitForRefresh(s7IptvJob.id, ['succeeded']);
  checkEq(s7IptvDone.counts.added, 1, 'S7 前置:HLS 频道经 IPTV 刷新导入');
  const s7Channel = (await adultList(`?q=${encodeURIComponent('S7直播台')}`)).items[0];
  check(s7Channel !== undefined, 'S7 前置:HLS 频道在目录定位');
  serverDb().prepare('UPDATE playback_source SET location = ?, requires_proxy = 1 WHERE media_item_id = ?')
    .run(`${s7UpstreamBase}/s7/master.m3u8`, s7Channel.id);

  // S7 专用辅助(模块内对齐 S6 命名惯例):
  const s7EntryUrlOf = (playbackUrl) => {
    const parsed = new URL(playbackUrl, base);
    return `${parsed.pathname}${parsed.search}`;
  };
  /** 媒体/资产原始请求(不断言状态;返回 status/headers/body/text 供负向矩阵断言) */
  const s7Media = async (pathWithQuery, bearer, options = {}) => {
    const response = await fetch(`${base}${pathWithQuery}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }),
        ...(options.range === undefined ? {} : { Range: options.range }),
      },
    });
    const body = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, body, text: body.toString('utf8') };
  };
  /** 控制端点宽松请求(不断言状态;renew 恢复分支的竞态判别用) */
  const s7ApiLoose = async (route, method, body) => {
    const response = await fetch(`${base}/api${route}`, {
      method,
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  /** 原始 socket 流读取(断流场景:头部已发后连接被服务端关闭;end/aborted/error 均收口) */
  const s7RawStreamGet = (pathWithQuery, bearer) => new Promise((resolve, reject) => {
    const target = new URL(`${base}${pathWithQuery}`);
    const request = http.request(
      {
        hostname: target.hostname, port: target.port,
        path: `${target.pathname}${target.search}`, method: 'GET',
        headers: bearer === null ? {} : { Authorization: `Bearer ${bearer}` },
      },
      (message) => {
        const chunks = [];
        let settled = false;
        const finish = (aborted) => {
          if (settled) return;
          settled = true;
          resolve({ status: message.statusCode ?? 0, body: Buffer.concat(chunks), aborted });
        };
        message.on('data', (chunk) => chunks.push(chunk));
        message.on('end', () => finish(false));
        message.on('aborted', () => finish(true));
        message.on('error', () => finish(true));
      },
    );
    request.on('error', reject);
    request.end();
  });
  /** 会话状态轮询(拒绝期 GET 为 problem 无 state,故不断言状态码,按 state 匹配) */
  const s7WaitForPlayback = async (sessionId, statuses, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    let polls = 0;
    for (;;) {
      polls += 1;
      const response = await fetch(`${base}/api/playback/sessions/${sessionId}`, {
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      });
      const body = await response.json();
      if (statuses.includes(body.state)) return body;
      if (polls % 50 === 0) console.log(`[wait] playback ${sessionId} polls=${polls} http=${response.status} state=${String(body.state ?? '')}`);
      if (Date.now() > deadline) {
        throw new Error(`播放会话 ${sessionId} 等待 [${statuses.join(',')}] 超时,最后 HTTP ${response.status}: ${JSON.stringify(body)}`);
      }
      await sleep(100);
    }
  };
  const s7ExtractAssetUrls = (text) => [...text.matchAll(/\/api\/playback\/stream\/[^\s"'<>]+/g)].map(match => match[0]);
  /**
   * 「拒绝 → 恢复」敏感段的会话恢复分派:后台权限复核每 15s 对全部活动会话 revalidate,
   * 拒绝即回收 interrupted(T038 预期行为)。若复核拍恰落在拒绝窗口内,同会话恢复断言
   * 不可达 —— 此时按系统回收语义断言(409 PLAYBACK_NOT_READY),并以全新解析证明
   * 「恢复后授权/取票/交付可用」;输出注明竞态分支,不改变矩阵判定。
   */
  const s7RecoverAfterRestore = async (deniedSession, expectedGeneration, label) => {
    const renewBack = await s7ApiLoose(`/playback/sessions/${deniedSession}/renew`, 'POST', { expectedGeneration });
    if (renewBack.status === 200) {
      check(typeof renewBack.body.playbackUrl === 'string' && renewBack.body.playbackUrl.length > 0, `${label}:恢复后 renew 可用`);
      return { sameSession: true, playbackUrl: renewBack.body.playbackUrl };
    }
    checkEq(renewBack.status, 409, `${label}:竞态分支 —— 复核已回收会话,renew 409`);
    checkEq(renewBack.body.code, 'PLAYBACK_NOT_READY', `${label}:竞态分支稳定码 PLAYBACK_NOT_READY`);
    console.log(`[S7] note: ${label} 后台权限复核拍恰在拒绝窗口内回收会话(15s 周期,系统回收语义);恢复证据改由全新解析承担`);
    const reborn = await api('/playback/resolve', 'POST', { mediaId: playableA.id }, 201);
    const rebornReady = await s7WaitForPlayback(reborn.id, ['ready']);
    const rebornTicket = await api(`/playback/sessions/${reborn.id}/renew`, 'POST', { expectedGeneration: rebornReady.generation });
    return { sameSession: false, playbackUrl: rebornTicket.playbackUrl };
  };

  // —— 组 1 基线:owner 会话 + 成人档案 → resolve → ready → renew → GET 200 字节一致 ——
  checkEq((await api('/auth/session')).activeProfile.id, adultProfile.id, 'S7 前置:当前档案为无 PIN 成人');
  const s7A = await api('/playback/resolve', 'POST', { mediaId: playableA.id }, 201);
  checkEq([s7A.state, s7A.delivery, s7A.playbackUrl, s7A.generation], ['preparing', null, null, 1],
    'S7-1:resolve 201 preparing(不猜 delivery;ready 前无票)');
  const s7AReady = await s7WaitForPlayback(s7A.id, ['ready']);
  checkEq(s7AReady.delivery, 'direct', 'S7-1:真实 mp4 probe → direct 交付');
  const s7ATicket = await api(`/playback/sessions/${s7A.id}/renew`, 'POST', { expectedGeneration: s7AReady.generation });
  check(typeof s7ATicket.ticketExpiresAt === 'string', 'S7-1:TicketReply 携带 ticketExpiresAt');
  const s7AUrl = s7EntryUrlOf(s7ATicket.playbackUrl);
  checkEq(new URL(s7ATicket.playbackUrl, base).pathname,
    `/api/playback/stream/${s7A.id}/${s7AReady.generation}/index`, 'S7-1:playbackUrl 为同源入口 index(不含源位置)');
  const s7Full = await s7Media(s7AUrl, token);
  checkEq(s7Full.status, 200, 'S7-1:授权媒体 GET 200');
  check((s7Full.headers.get('content-type') ?? '').includes('video/mp4'), 'S7-1:Content-Type video/mp4');
  checkEq(s7Full.headers.get('accept-ranges'), 'bytes', 'S7-1:Accept-Ranges bytes');
  checkEq(s7Full.headers.get('content-length'), String(movieBytesA.length), 'S7-1:Content-Length 与源一致');
  checkEq(s7Full.headers.get('cache-control'), 'no-store', 'S7-1:字节响应 no-store(不公开缓存)');
  checkEq(s7Full.body, movieBytesA, 'S7-1:字节与源文件一致');

  // —— 组 1b HLS 基线:hls_proxy 交付,清单重写 + 分片/MAP/key/字幕资产可取 ——
  const s7D = await api('/playback/resolve', 'POST', { mediaId: s7Channel.id }, 201);
  const s7DReady = await s7WaitForPlayback(s7D.id, ['ready']);
  checkEq(s7DReady.delivery, 'hls_proxy', 'S7-1b:HLS 频道 requires_proxy → hls_proxy');
  const s7DTicket = await api(`/playback/sessions/${s7D.id}/renew`, 'POST', { expectedGeneration: s7DReady.generation });
  const s7DUrl = s7EntryUrlOf(s7DTicket.playbackUrl);
  const s7Manifest = await s7Media(s7DUrl, token);
  checkEq(s7Manifest.status, 200, 'S7-1b:入口清单 GET 200');
  check((s7Manifest.headers.get('content-type') ?? '').includes('application/vnd.apple.mpegurl'), 'S7-1b:清单 MIME');
  check(!s7Manifest.text.includes('127.0.0.1') && !s7Manifest.text.includes('://'),
    'S7-1b:清单重写同源化(禁透传上游地址)');
  const s7ChildUrls = s7ExtractAssetUrls(s7Manifest.text);
  checkEq(s7ChildUrls.length, 2, 'S7-1b:变体+字幕子清单两个资产 URL');
  let s7VariantUrls = [];
  let s7VttUrl = null;
  for (const childUrl of s7ChildUrls) {
    const child = await s7Media(childUrl, token);
    checkEq(child.status, 200, 'S7-1b:子清单 GET 200');
    if (child.text.includes('#EXT-X-MAP')) {
      s7VariantUrls = s7ExtractAssetUrls(child.text);
    } else {
      s7VttUrl = s7ExtractAssetUrls(child.text)[0] ?? null;
    }
  }
  checkEq(s7VariantUrls.length, 3, 'S7-1b:MAP+key+分片三个资产 URL');
  check(s7VttUrl !== null, 'S7-1b:字幕资产 URL 存在');
  const s7AssetBodies = [];
  for (const assetUrl of s7VariantUrls) {
    const asset = await s7Media(assetUrl, token);
    checkEq(asset.status, 200, 'S7-1b:MAP/key/分片 GET 200');
    s7AssetBodies.push(asset);
  }
  check(s7AssetBodies.some(asset => asset.body.equals(s7InitBytes)), 'S7-1b:MAP(init)字节一致');
  check(s7AssetBodies.some(asset => asset.body.equals(s7KeyBytes)), 'S7-1b:key 16 字节一致');
  check(s7AssetBodies.some(asset => asset.body.equals(s7SegmentBytes)), 'S7-1b:分片字节一致');
  check(s7AssetBodies.some(asset => (asset.headers.get('content-type') ?? '').includes('application/octet-stream')),
    'S7-1b:key MIME octet-stream');
  const s7KeyUrl = s7VariantUrls[s7AssetBodies.findIndex(asset => asset.body.equals(s7KeyBytes))];
  const s7SegUrl = s7VariantUrls[s7AssetBodies.findIndex(asset => asset.body.equals(s7SegmentBytes))];
  const s7Vtt = await s7Media(s7VttUrl, token);
  checkEq(s7Vtt.status, 200, 'S7-1b:字幕 GET 200');
  check((s7Vtt.headers.get('content-type') ?? '').includes('text/vtt') && s7Vtt.text.startsWith('WEBVTT'),
    'S7-1b:字幕 text/vtt 纯文本');

  // —— 组 2 切换档案(005 T039 契约改写):实际换档同事务「终态化旧上下文活动播放 +
  //      撤票 + 递增 profile_context_version」—— 切儿童后旧票 URL 立即 401(票已撤销)、
  //      旧会话控制面 404 同形(上下文版本为唯一拒绝依据,A→B→A 不能复活);
  //      切回主档案后旧会话不复活,恢复证据由全新解析承担(005 §5)——
  await api(`/profiles/${childProfile.id}/select`, 'POST', {});
  const s7SwitchDirect = await s7Media(s7AUrl, token);
  checkEq(s7SwitchDirect.status, 401, 'S7-2:切儿童档案后同一票 URL 立即 401(换档事务已撤票,旧缓冲不计停止期限)');
  checkEq(JSON.parse(s7SwitchDirect.text).code, 'PLAYBACK_TICKET_INVALID', 'S7-2:票门先于授权 → PLAYBACK_TICKET_INVALID(撤销票不因换档复活)');
  const s7SwitchManifest = await s7Media(s7DUrl, token);
  checkEq(s7SwitchManifest.status, 401, 'S7-2:清单请求同拒(同事务撤票)');
  const s7SwitchSeg = await s7Media(s7SegUrl, token);
  checkEq(s7SwitchSeg.status, 401, 'S7-2:分片请求同拒');
  const s7SwitchKey = await s7Media(s7KeyUrl, token);
  checkEq(s7SwitchKey.status, 401, 'S7-2:key 请求同拒');
  const s7SwitchVtt = await s7Media(s7VttUrl, token);
  checkEq(s7SwitchVtt.status, 401, 'S7-2:字幕请求同拒');
  const s7SwitchSession = await api(`/playback/sessions/${s7A.id}`, 'GET', undefined, 404);
  checkEq(s7SwitchSession.code, 'PLAYBACK_NOT_FOUND', 'S7-2:旧上下文 GET 会话 404 同形(上下文版本失配与不存在不可区分,不泄露旧会话)');
  // 切回主档案(PIN 保护:unlock 一次性选档授予 → select;005 §3)
  await selectMain();
  // A→B→A 不能复活:旧会话终态 interrupted 且版本失配持续(与 playback-context-binding 契约同口径)
  const s7DbState = serverDb().prepare('SELECT state, ended_at AS endedAt FROM playback_session WHERE id = ?').get(s7A.id);
  checkEq(s7DbState.state, 'interrupted', 'S7-2:换档同事务终态化旧上下文播放(DB 事实,interrupted)');
  check(s7DbState.endedAt !== null, 'S7-2:interrupted 具备 ended_at');
  const s7StaleRenewAfterSwitch = await s7ApiLoose(`/playback/sessions/${s7A.id}/renew`, 'POST', { expectedGeneration: s7AReady.generation });
  checkEq([s7StaleRenewAfterSwitch.status, s7StaleRenewAfterSwitch.body.code], [404, 'PLAYBACK_NOT_FOUND'],
    'S7-2:旧上下文 renew 404(不产生新票,A→B→A 不能复活)');
  const s7SwitchGetAfterBack = await api(`/playback/sessions/${s7A.id}`, 'GET', undefined, 404);
  checkEq(s7SwitchGetAfterBack.code, 'PLAYBACK_NOT_FOUND', 'S7-2:切回主档案后旧会话仍 404(版本绑定是唯一拒绝依据)');
  const s7SwitchReborn = await api('/playback/resolve', 'POST', { mediaId: playableA.id }, 201);
  const s7SwitchRebornReady = await s7WaitForPlayback(s7SwitchReborn.id, ['ready']);
  const s7SwitchRebornTicket = await api(`/playback/sessions/${s7SwitchReborn.id}/renew`, 'POST', { expectedGeneration: s7SwitchRebornReady.generation });
  checkEq((await s7Media(s7EntryUrlOf(s7SwitchRebornTicket.playbackUrl), token)).status, 200,
    'S7-2:切回主档案后全新解析→取票→GET 200(恢复仅经新会话)');

  // —— 组 3 收紧策略(005:组 2 换档已确定性终态化组 1 会话,基线改由全新解析建立):
  //      黑名单该媒体 → 媒体 GET/renew/GET 会话 下一请求 404 同形(无策略明细);
  //      恢复策略 → renew 可用、旧票 URL 恢复 200(立即生效,不因旧响应放行/拒绝)——
  const s7B = await api('/playback/resolve', 'POST', { mediaId: playableA.id }, 201);
  const s7BReady = await s7WaitForPlayback(s7B.id, ['ready']);
  const s7BTicket = await api(`/playback/sessions/${s7B.id}/renew`, 'POST', { expectedGeneration: s7BReady.generation });
  const s7BUrl = s7EntryUrlOf(s7BTicket.playbackUrl);
  // 005 T126:策略管理迁入 /settings/profiles/{id}/policy(/lists)
  const s7PolicyBefore = await mapi(`/settings/profiles/${adultProfile.id}/policy`);
  await mapi(`/settings/profiles/${adultProfile.id}/policy/lists`, 'PUT', {
    ownerPassword: password, expectedVersion: s7PolicyBefore.version,
    allowedMediaIds: [], blockedMediaIds: [playableA.id], allowedChannelIds: [],
  });
  const s7PolicyDirect = await s7Media(s7BUrl, token);
  checkEq(s7PolicyDirect.status, 404, 'S7-3:黑名单后媒体 GET 404(策略拒绝统一同形)');
  checkEq(JSON.parse(s7PolicyDirect.text).code, 'MEDIA_NOT_FOUND', 'S7-3:统一 MEDIA_NOT_FOUND(不返回策略明细)');
  const s7PolicyRenew = await api(`/playback/sessions/${s7B.id}/renew`, 'POST',
    { expectedGeneration: s7BReady.generation }, 404);
  checkEq(s7PolicyRenew.code, 'MEDIA_NOT_FOUND', 'S7-3:renew 同拒(提交前重验最新策略)');
  const s7PolicySession = await api(`/playback/sessions/${s7B.id}`, 'GET', undefined, 404);
  checkEq(s7PolicySession.code, 'MEDIA_NOT_FOUND', 'S7-3:GET 会话同拒');
  await mapi(`/settings/profiles/${adultProfile.id}/policy/lists`, 'PUT', {
    ownerPassword: password, expectedVersion: s7PolicyBefore.version + 1,
    allowedMediaIds: [], blockedMediaIds: [], allowedChannelIds: [],
  });
  const s7PolicyBack = await s7RecoverAfterRestore(s7B.id, s7BReady.generation, 'S7-3');
  const s7PolicyBackUrl = s7PolicyBack.sameSession ? s7BUrl : s7EntryUrlOf(s7PolicyBack.playbackUrl);
  const s7PolicyBackDirect = await s7Media(s7PolicyBackUrl, token);
  checkEq(s7PolicyBackDirect.status, 200, 'S7-3:恢复策略后取票/媒体 GET 恢复 200');
  if (s7PolicyBack.sameSession) {
    checkEq(s7PolicyBackDirect.body, movieBytesA, 'S7-3:恢复后旧票同 URL 字节一致(旧缓冲不残留拒绝也不残留放行)');
  }

  // —— 组 3b 流中失败不注入 JSON(HLS 断流,真实 HTTP 可靠注入):变体切 broken →
  //      已发字节后关闭连接,字节流无 JSON 注入;失败码经 GET 会话轮询可见 ——
  //      分层说明:direct 场景 fd 语义下 unlink 不中断已打开读取,流中途 IO 错误的可靠
  //      注入属 unit 层 streamFactory 钩子(nas-reader.spec「流中途错误」);本组以 HLS
  //      上游断流提供运行时真服务证据(与 playback-stream.e2e「上游中途断流」同场景)。
  //      005:组 2 换档已同事务终态化 s7D(旧上下文 GET 404 同形、不可复活),断流场景
  //      按契约语义改用全新 HLS 会话(同一上游位置),不再探测旧会话状态。
  const s7D2 = await api('/playback/resolve', 'POST', { mediaId: s7Channel.id }, 201);
  const s7D2Ready = await s7WaitForPlayback(s7D2.id, ['ready']);
  checkEq(s7D2Ready.delivery, 'hls_proxy', 'S7-3b:全新 HLS 会话 ready(组 2 终态化不影响新解析)');
  const s7D2Ticket = await api(`/playback/sessions/${s7D2.id}/renew`, 'POST', { expectedGeneration: s7D2Ready.generation });
  const s7BrokenSessionId = s7D2.id;
  const s7BrokenEntryUrl = s7EntryUrlOf(s7D2Ticket.playbackUrl);
  s7VariantBroken = true;
  const s7BrokenManifest = await s7Media(s7BrokenEntryUrl, token);
  checkEq(s7BrokenManifest.status, 200, 'S7-3b:断流场景清单照常 200(失败在分片读取中)');
  const s7BrokenChildren = s7ExtractAssetUrls(s7BrokenManifest.text);
  checkEq(s7BrokenChildren.length, 1, 'S7-3b:broken master 仅含断流变体一个子清单 URL');
  const s7BrokenVariant = await s7Media(s7BrokenChildren[0], token);
  checkEq(s7BrokenVariant.status, 200, 'S7-3b:broken 变体清单 200');
  const s7BrokenSegUrls = s7ExtractAssetUrls(s7BrokenVariant.text);
  checkEq(s7BrokenSegUrls.length, 1, 'S7-3b:断流变体重写出 1 个分片 URL');
  const s7Streamed = await s7RawStreamGet(s7BrokenSegUrls[0], token);
  checkEq(s7Streamed.status, 200, 'S7-3b:流中失败 —— 响应头已发(200)');
  check(s7Streamed.body.length > 0, 'S7-3b:已发出部分字节(截断字节流)');
  check(!s7Streamed.body.includes(0x7b), 'S7-3b:字节流无 JSON 注入(无 { 字节)');
  check(!s7Streamed.body.toString('utf8').includes('"type"'), 'S7-3b:字节流无 problem 形态字段');
  let s7FailureCode = null;
  for (let attempt = 0; attempt < 50 && s7FailureCode === null; attempt += 1) {
    const s7View = await api(`/playback/sessions/${s7BrokenSessionId}`);
    if (typeof s7View.failureCode === 'string') {
      s7FailureCode = s7View.failureCode;
    } else {
      await sleep(100);
    }
  }
  check(typeof s7FailureCode === 'string' && s7FailureCode.length > 0, 'S7-3b:会话稳定失败码经轮询可见');

  // —— 组 4 注销:logout → 媒体 GET(旧票)/清单/renew 下一请求 401;重新登录+选档案后
  //      旧票 URL 仍 401(票绑定原设备会话,已销毁)——
  await api('/auth/logout', 'POST', {}, 204);
  const s7LogoutDirect = await s7Media(s7AUrl, token);
  checkEq(s7LogoutDirect.status, 401, 'S7-4:注销后同一票 URL 立即 401(旧缓冲不计停止期限)');
  checkEq(JSON.parse(s7LogoutDirect.text).code, 'SESSION_INVALID', 'S7-4:会话撤销 → SESSION_INVALID');
  checkEq((await s7Media(s7DUrl, token)).status, 401, 'S7-4:清单请求同 401');
  const s7LogoutRenew = await api(`/playback/sessions/${s7A.id}/renew`, 'POST',
    { expectedGeneration: s7AReady.generation }, 401);
  checkEq(s7LogoutRenew.code, 'SESSION_INVALID', 'S7-4:renew 401');
  token = (await api('/auth/login', 'POST', { username: 'runtimeqa', password })).sessionToken;
  // 005 §3:主档案 PIN 保护 → unlock+select(替代旧「无 PIN 成人 + ownerPassword」选档)
  await selectMain();
  const s7ReloginDirect = await s7Media(s7AUrl, token);
  checkEq(s7ReloginDirect.status, 401, 'S7-4:重新登录+选档案后旧票 URL 仍 401');
  checkEq(JSON.parse(s7ReloginDirect.text).code, 'PLAYBACK_TICKET_INVALID',
    'S7-4:票设备会话绑定 → PLAYBACK_TICKET_INVALID(原会话已销毁不可复活)');

  // —— 组 5 停源:重登录基线 → 直改 DB 禁用 NAS 源(与 pointSourceAt 同直访模式)→
  //      renew/媒体 GET 404 同形;恢复源后全新解析可用 ——
  const s7E = await api('/playback/resolve', 'POST', { mediaId: playableA.id }, 201);
  const s7EReady = await s7WaitForPlayback(s7E.id, ['ready']);
  const s7ETicket = await api(`/playback/sessions/${s7E.id}/renew`, 'POST', { expectedGeneration: s7EReady.generation });
  const s7EUrl = s7EntryUrlOf(s7ETicket.playbackUrl);
  checkEq((await s7Media(s7EUrl, token)).status, 200, 'S7-5:重新登录后可重新解析起播(200 基线)');
  serverDb().prepare('UPDATE media_source SET enabled = 0 WHERE id = ?').run(nasSource.id); // 直改:仅测试夹具
  const s7SourceDirect = await s7Media(s7EUrl, token);
  checkEq(s7SourceDirect.status, 404, 'S7-5:停源后媒体 GET 404(下一请求拒绝)');
  checkEq(JSON.parse(s7SourceDirect.text).code, 'MEDIA_NOT_FOUND', 'S7-5:无启用源统一 MEDIA_NOT_FOUND 同形');
  const s7SourceRenew = await api(`/playback/sessions/${s7E.id}/renew`, 'POST',
    { expectedGeneration: s7EReady.generation }, 404);
  checkEq(s7SourceRenew.code, 'MEDIA_NOT_FOUND', 'S7-5:停源后 renew 404');
  serverDb().prepare('UPDATE media_source SET enabled = 1 WHERE id = ?').run(nasSource.id);
  const s7F = await api('/playback/resolve', 'POST', { mediaId: playableA.id }, 201);
  const s7FReady = await s7WaitForPlayback(s7F.id, ['ready']);
  const s7FTicket = await api(`/playback/sessions/${s7F.id}/renew`, 'POST', { expectedGeneration: s7FReady.generation });
  const s7FUrl = s7EntryUrlOf(s7FTicket.playbackUrl);
  checkEq((await s7Media(s7FUrl, token)).status, 200, 'S7-5:恢复源后全新解析→renew→GET 200');

  // —— 组 6 Range/HEAD:206 Content-Range 一致;HEAD 授权 200 无体;HEAD 未授权 401 ——
  const s7Range = await s7Media(s7FUrl, token, { range: 'bytes=0-99' });
  checkEq(s7Range.status, 206, 'S7-6:单区间 Range → 206');
  checkEq(s7Range.headers.get('content-range'), `bytes 0-99/${movieBytesA.length}`, 'S7-6:Content-Range 一致');
  checkEq(s7Range.headers.get('content-length'), '100', 'S7-6:Content-Length = 区间长');
  checkEq(s7Range.body, movieBytesA.subarray(0, 100), 'S7-6:区间字节正确');
  const s7Head = await s7Media(s7FUrl, token, { method: 'HEAD' });
  checkEq(s7Head.status, 200, 'S7-6:授权 HEAD 200');
  checkEq(s7Head.headers.get('content-length'), String(movieBytesA.length), 'S7-6:HEAD 头与 GET 一致');
  checkEq(s7Head.body.length, 0, 'S7-6:HEAD 不发送响应体');
  const s7HeadAnon = await s7Media(s7FUrl, null, { method: 'HEAD' });
  // HEAD 响应体被 HTTP 栈双侧抑制(RFC 7231),401 语义经状态行 + problem Content-Type 头表达
  checkEq(s7HeadAnon.status, 401, 'S7-6:未授权 HEAD 401(与 GET 同鉴权)');
  check((s7HeadAnon.headers.get('content-type') ?? '').includes('application/problem+json'),
    'S7-6:401 以 problem Content-Type 头表达');

  // —— 组 7 资产同形 404 + direct 源故障(未发 headers → problem,不含路径细节)——
  //      分层说明:已发字节后流中途失败的 JSON 注入防护由组 3b(HLS)提供运行时证据,
  //      direct fd 形态的流中途错误路径见 nas-reader.spec(unit 层 streamFactory 注入)。
  const s7FTicketValue = new URL(s7FTicket.playbackUrl, base).searchParams.get('ticket') ?? '';
  const s7BadAsset = await s7Media(`/api/playback/stream/${s7F.id}/${s7FReady.generation}/not-a-real-asset?ticket=${s7FTicketValue}`, token);
  checkEq(s7BadAsset.status, 404, 'S7-7:不存在 assetId → 404(不接受任意资产)');
  checkEq(JSON.parse(s7BadAsset.text).code, 'MEDIA_NOT_FOUND', 'S7-7:资产枚举不存在统一 MEDIA_NOT_FOUND problem+json');
  fs.rmSync(path.join(nasRoot, 'smoke-playable-a.mp4')); // 直改 rm:临时夹具文件,随 smoke 清理
  const s7DeletedSource = await s7Media(s7FUrl, token);
  checkEq(s7DeletedSource.status, 503, 'S7-7:direct 源文件删除 → 503(未发 headers 源故障 problem)');
  checkEq(JSON.parse(s7DeletedSource.text).code, 'PLAYBACK_RESOURCE_UNAVAILABLE', 'S7-7:稳定码(不含源位置)');
  check(!s7DeletedSource.text.includes(nasRoot) && !s7DeletedSource.text.includes('smoke-playable'),
    'S7-7:响应体不含 NAS 物理路径/文件名');

  const s7AssertionCount = assertionCount - s7StartCount;
  console.log(`[S7] US2 播放负向矩阵 OK(005):基线起播(direct+HLS 清单/分片/MAP/key/字幕)/换档同事务终态化+撤票(旧票 401/旧会话 404 不复活,恢复经全新解析)/收紧策略 404/注销 401+旧票作废/停源 404/Range 206+HEAD/流中失败不注入 JSON+失败码可轮询(新增 ${s7AssertionCount} 断言)`);

  /* -------------------------------------------------------------- */
  /* S8 US1 004 播放正向/鲁棒性真实 HTTP 场景(T033;SC-001/SC-009 HTTP 层) */
  /* 全部真实 HTTP + 真实 ffprobe/ffmpeg 证据,不以 mock 子进程替代真实转换   */
  /* 证据;与 S7 负向矩阵互补不重复。组 1 起播字节(多路径,转码交付全强度    */
  /* 清单/分片字节)/组 2 续期同 session 与任务行/组 3 Range+seek 换代确定性  */
  /* 恢复序列+组 3b 转码 seek preparing 409 窗口/组 4 额度满(尽力+实测证据) */
  /* /组 5 限时失败与 preparing 取消(转码会话)/组 6 失联扫描+终态票门 401  */
  /* /组 7 旁车字幕 WEBVTT/组 8 recoverOnBoot 重启恢复。                    */
  /* -------------------------------------------------------------- */
  const s8StartCount = assertionCount;
  // 限频预算隔离(确定性前置):renew 桶为每设备滑动 60 秒窗口(10 次/分,失败请求同计),
  // S7 尾部的 renew 记账仍可能在窗口内存活;此处等待一个完整窗口自然排空,再进入 S8 的
  // renew 序列(本场景自身峰值 9 次/窗口 < 10,留 1 次余量;期间无任何播放请求发出)。
  await sleep(60_000);
  // 前置:T032 夹具(同步 generateAll = lavfi 生成 + 自动 ffprobe 复核;产物只落临时目录,
  // 随 smoke 清理)。按「样本文件名即语义」拷贝所需样本入 NAS 只读根。T032 矩阵无字幕
  // 样本:同 stem 旁车 .srt 为本场景临时构造(明注,不改 T032 清单;.srt 不在 NAS 扫描
  // 扩展名白名单内,不会被导入目录)。
  s8MediaBase = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-runtime-smoke-s8-media-'));
  const s8Generated = generateAll({ outDir: s8MediaBase });
  checkEq(s8Generated.verification.fail, 0, 'S8 前置:T032 generateAll 自动复核 0 失败');
  const s8SampleNames = [
    'mp4-h264-aac-direct.mp4',       // direct 起播基线(亦挂同 stem 旁车字幕供组 3c/组 7)
    'mp4-h264-ac3-atranscode.mp4',   // audio_transcode 路径(probe/plan 真实证据)
    'mkv-hevc10-aac-vtranscode.mkv', // video_transcode 路径(10bit HEVC;128×96 小样本,性能不足判定不适用)
    'corrupt-truncated.mp4',         // 非法样本:截去头部 1024 字节破坏 box → probe 稳定失败
  ];
  for (const name of s8SampleNames) {
    fs.copyFileSync(path.join(s8MediaBase, name), path.join(nasRoot, name));
  }
  fs.writeFileSync(path.join(nasRoot, 'mp4-h264-aac-direct.srt'),
    '1\n00:00:00,000 --> 00:00:02,500\nS8 字幕文本 plain words\n');
  // S7 组 7 为构造「direct 源文件删除 → 503」删除了 smoke-playable-a.mp4(目录项保留)。
  // S8 刷新前按同夹具语义重建该文件(内容取 playable-b 副本):否则本源刷新 diff 出现
  // 缺失项,003 目录安全栏(deletion_ratio_exceeded)会把刷新置为 awaiting_confirmation
  // 而非 succeeded —— 重建使 diff 无缺失,刷新幂等终态(该文件至多 updated/unchanged)。
  fs.copyFileSync(path.join(nasRoot, 'smoke-playable-b.mp4'), path.join(nasRoot, 'smoke-playable-a.mp4'));
  const s8DirectBytes = fs.readFileSync(path.join(nasRoot, 'mp4-h264-aac-direct.mp4'));
  check(s8DirectBytes.length > 0, 'S8 前置:direct 样本字节可读(供字节级断言)');
  const s8NasDone = await waitForRefresh((await startRefresh(nasSource.id)).id, ['succeeded']);
  checkEq(s8NasDone.counts.added, 4, 'S8 前置:4 份样本经 NAS 刷新导入(.srt 不入目录)');
  const s8MediaByTitle = async (title) =>
    (await adultList(`?q=${encodeURIComponent(title)}`)).items.find(item => item.title === title);
  const s8Direct = await s8MediaByTitle('mp4-h264-aac-direct');
  const s8Ac3 = await s8MediaByTitle('mp4-h264-ac3-atranscode');
  const s8Hevc10 = await s8MediaByTitle('mkv-hevc10-aac-vtranscode');
  const s8Corrupt = await s8MediaByTitle('corrupt-truncated');
  check(s8Direct !== undefined && s8Ac3 !== undefined && s8Hevc10 !== undefined && s8Corrupt !== undefined,
    'S8 前置:四份样本媒体在目录定位');
  /** renew 辅助:遇 429 PLAYBACK_RATE_LIMITED 按短退避诚实重试(预算 10 次/分/设备;
   *  单次退避 ≤8s,远小于 45s 失联阈值 —— 长退避会让无心跳会话被失联扫描回收) */
  const s8Renew = async (sessionId, expectedGeneration) => {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(`${base}/api/playback/sessions/${sessionId}/renew`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ expectedGeneration }),
      });
      if (response.status === 429 && attempt < 8) {
        await sleep(8_000 + 250); // 429 未记账(检查不通过不消耗配额),窗口滑出后即可通过
        continue;
      }
      assert.equal(response.status, 200, `renew ${sessionId} -> 200(HTTP ${response.status})`);
      return response.json();
    }
  };
  /** 期望非 200 的 renew(409 稳定码断言用):同款 429 诚实退避后返回终态 status/body,
   *  使「409 NOT_READY/GENERATION_STALE」断言不被限流窗口位置偶然击穿 */
  const s8RenewLoose = async (sessionId, expectedGeneration) => {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(`${base}/api/playback/sessions/${sessionId}/renew`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ expectedGeneration }),
      });
      if (response.status === 429 && attempt < 8) {
        await sleep(8_000 + 250);
        continue;
      }
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    }
  };
  /** 确定性 ready 轮询(seek 恢复专用;200ms 间隔):直达 ready 即返回;failed 快速失败携带
   *  稳定码;超时抛错携带最后视图(转码 seek 相位真实 ffmpeg 产出首产物,窗口为秒级) */
  const s8WaitReady = async (sessionId, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const response = await fetch(`${base}/api/playback/sessions/${sessionId}`, {
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      });
      const body = await response.json();
      if (body.state === 'ready') return body;
      if (body.state === 'failed') {
        throw new Error(`会话 ${sessionId} 在 ready 轮询中落 failed:${JSON.stringify(body)}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`会话 ${sessionId} ready 轮询超时(${timeoutMs}ms):${JSON.stringify(body)}`);
      }
      await sleep(200);
    }
  };
  /** 会话终态轮询(额度满 BUSY 观测:失败以会话 state=failed + failureCode 稳定码呈现,
   *  不经同步 503 —— resolve 对准备段 fire-and-forget,响应恒 201) */
  const s8WaitTerminal = async (sessionId, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const response = await fetch(`${base}/api/playback/sessions/${sessionId}`, {
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      });
      const body = await response.json();
      if (['ready', 'failed', 'ended', 'interrupted'].includes(body.state)) return body;
      if (Date.now() > deadline) {
        throw new Error(`会话 ${sessionId} 终态轮询超时(${timeoutMs}ms):${JSON.stringify(body)}`);
      }
      await sleep(200);
    }
  };
  /** 转换额度排空等待(确定性前置):计额状态 = reserved～stopping(data-model 全活跃集),
   *  小样本 ffmpeg 秒级退出;下一个转码会话 resolve 前确保额度空闲,避免 BUSY 串扰 */
  const s8WaitConversionsDrained = async (timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = serverDb().prepare(
        "SELECT COUNT(*) AS n FROM playback_conversion WHERE state IN ('reserved','probing','starting','running','stopping')",
      ).get();
      if (row.n === 0) return;
      if (Date.now() > deadline) {
        throw new Error(`S8 转换额度排空超时:仍有 ${row.n} 个活跃转换任务`);
      }
      await sleep(200);
    }
  };
  /** 转码会话最近一次转换任务行实测耗时(额度窗口证据;无行/未完成为 null) */
  const s8ConversionWallMs = (sessionId) => {
    const row = serverDb().prepare(
      'SELECT started_at AS startedAt, ended_at AS endedAt FROM playback_conversion WHERE session_id = ? ORDER BY rowid DESC LIMIT 1',
    ).get(sessionId);
    if (row === undefined || row.startedAt === null || row.endedAt === null) return null;
    return Date.parse(row.endedAt) - Date.parse(row.startedAt);
  };
  const s8TicketRowsOf = (sessionId) =>
    serverDb().prepare('SELECT COUNT(*) AS n FROM playback_ticket WHERE session_id = ?').get(sessionId).n;
  const s8ConversionRowsOf = (sessionId) =>
    serverDb().prepare('SELECT COUNT(*) AS n FROM playback_conversion WHERE session_id = ?').get(sessionId).n;
  // 转换路径场景(全强度;转码管线已接线):probe/plan + 真实 ffmpeg 首产物 → ready →
  // renew 签票 → 入口 GET 200(window.m3u8 滚动清单同源重写带票)→ 分片 GET 200 字节非零
  // —— 转码交付的 HTTP 层真实证据,不以 mock 子进程替代(2026-10-26 现状:交付已接线,
  // 无降级分支;额度排空等待保证相邻转码场景不因全局并发=1 互相击穿)。
  const s8ConversionNotes = [];
  const s8ConversionScenario = async (media, expectedDelivery, label) => {
    await s8WaitConversionsDrained();
    const resolveResp = await api('/playback/resolve', 'POST', { mediaId: media.id }, 201);
    const ready = await s7WaitForPlayback(resolveResp.id, ['ready', 'failed'], 20_000);
    checkEq(ready.state, 'ready', `${label}:resolve→ready(真实 ffprobe probe + 真实 ffmpeg 转换管线)`);
    checkEq(ready.delivery, expectedDelivery, `${label}:计划交付 = ${expectedDelivery}`);
    check(s8ConversionRowsOf(resolveResp.id) > 0, `${label}:真实转码任务行已建(ConversionSupervisor reserve)`);
    const ticket = await s8Renew(resolveResp.id, ready.generation);
    check(typeof ticket.playbackUrl === 'string' && ticket.playbackUrl.length > 0, `${label}:ready 后 renew 签票`);
    checkEq(ticket.generation, ready.generation, `${label}:TicketReply.generation = 会话当前代`);
    const entry = await s7Media(s7EntryUrlOf(ticket.playbackUrl), token);
    checkEq(entry.status, 200, `${label}:转码入口 GET 200(window.m3u8 滚动清单经网关交付)`);
    check((entry.headers.get('content-type') ?? '').includes('mpegurl'), `${label}:入口 MIME mpegurl`);
    check(entry.text.includes('#EXTM3U'), `${label}:入口为可解析 HLS 清单(滚动窗口)`);
    const s8Assets = s7ExtractAssetUrls(entry.text);
    check(s8Assets.length > 0, `${label}:清单重写出分片资产 URL(同源重写)`);
    check(s8Assets.every(assetUrl => assetUrl.includes('ticket=')), `${label}:重写分片 URL 同源带票`);
    const s8Segment = await s7Media(s8Assets[0], token);
    checkEq(s8Segment.status, 200, `${label}:分片 GET 200`);
    check(s8Segment.body.length > 0, `${label}:分片字节非零`);
    s8ConversionNotes.push(`${expectedDelivery}: 入口 200 mpegurl + ${s8Assets.length} 个带票分片 URL + 首分片 200(${s8Segment.body.length}B);转码任务行实测 ${String(s8ConversionWallMs(resolveResp.id))}ms`);
  };

  // —— 组 1 起播字节(多路径):direct 字节一致 + 转换路径 probe/plan 真实证据 ————
  checkEq((await api('/auth/session')).activeProfile.id, adultProfile.id, 'S8 前置:当前档案为无 PIN 成人');
  const s8AResolve = await api('/playback/resolve', 'POST', { mediaId: s8Direct.id }, 201);
  const s8AReady = await s7WaitForPlayback(s8AResolve.id, ['ready']);
  checkEq(s8AReady.delivery, 'direct', 'S8-1a:direct 样本 probe → direct 交付');
  check(s8AReady.durationSeconds !== null && s8AReady.durationSeconds >= 2.5 && s8AReady.durationSeconds <= 3.5,
    'S8-1a:probe 时长事实 ∈ [2.5,3.5]s(T032 预期)');
  const s8ATicket1 = await s8Renew(s8AResolve.id, s8AReady.generation);
  const s8AUrl = s7EntryUrlOf(s8ATicket1.playbackUrl);
  const s8AFull = await s7Media(s8AUrl, token);
  checkEq(s8AFull.status, 200, 'S8-1a:direct 授权起播 GET 200');
  checkEq(s8AFull.body, s8DirectBytes, 'S8-1a:起播字节与源文件一致');
  await s8ConversionScenario(s8Ac3, 'audio_transcode', 'S8-1b');
  await s8ConversionScenario(s8Hevc10, 'video_transcode', 'S8-1c');

  // —— 组 2 续期同 session/任务:renew 两次 → session/generation/version 不变、
  //     任务行不新增(direct 恒无任务行)、票行递增、TTL 预算生效 ————————
  const s8TicketsBefore = s8TicketRowsOf(s8AResolve.id);
  const s8ConversionsBefore = s8ConversionRowsOf(s8AResolve.id);
  const s8ATicket2 = await s8Renew(s8AResolve.id, s8AReady.generation);
  const s8ATicket3 = await s8Renew(s8AResolve.id, s8AReady.generation);
  const s8AAfter = await api(`/playback/sessions/${s8AResolve.id}`);
  checkEq([s8AAfter.id, s8AAfter.generation, s8AAfter.version],
    [s8AResolve.id, s8AReady.generation, s8AReady.version], 'S8-2:renew×2 后 session/generation/version 均不变');
  check(new URL(s8ATicket2.playbackUrl, base).searchParams.get('ticket') !==
    new URL(s8ATicket3.playbackUrl, base).searchParams.get('ticket'), 'S8-2:每次 renew 签发新票(不复用明文票)');
  checkEq(s8TicketRowsOf(s8AResolve.id), s8TicketsBefore + 2, 'S8-2:票行递增 +2(续期=新票新行,旧票不动)');
  checkEq(s8ConversionRowsOf(s8AResolve.id), s8ConversionsBefore, 'S8-2:续期不新增转换任务行');
  checkEq(s8ConversionsBefore, 0, 'S8-2:direct 起播不占转换额度(无任务行)');
  const s8TtlMs = Date.parse(s8ATicket3.ticketExpiresAt) - Date.now();
  check(Number.isFinite(s8TtlMs) && s8TtlMs > 0 && s8TtlMs <= 305_000, 'S8-2:票 TTL 预算生效(≤300s,+5s 时钟容差)');

  // —— 组 3 Range/seek/换轨:206 区间字节 + seek 换代 CAS + 纯字幕 version+1 ————
  const s8Range = await s7Media(s8AUrl, token, { range: 'bytes=0-99' });
  checkEq(s8Range.status, 206, 'S8-3:direct 单区间 Range → 206');
  checkEq(s8Range.headers.get('content-range'), `bytes 0-99/${s8DirectBytes.length}`, 'S8-3:Content-Range 一致');
  checkEq(s8Range.headers.get('content-length'), '100', 'S8-3:Content-Length = 区间长');
  checkEq(s8Range.body, s8DirectBytes.subarray(0, 100), 'S8-3:区间字节正确');
  const s8AView = await api(`/playback/sessions/${s8AResolve.id}`);
  const s8SeekStartedAt = Date.now();
  const s8ASeek = await api(`/playback/sessions/${s8AResolve.id}/seek`, 'POST',
    { expectedVersion: s8AView.version, positionSeconds: 1 });
  checkEq([s8ASeek.state, s8ASeek.generation, s8ASeek.version],
    ['preparing', s8AView.generation + 1, s8AView.version + 1], 'S8-3:seek → preparing 且 generation/version 各 +1');
  checkEq(s8ASeek.positionSeconds, 1, 'S8-3:seek 目标位置落库');
  const s8StaleRenew = await s8RenewLoose(s8AResolve.id, s8AView.generation);
  checkEq([s8StaleRenew.status, s8StaleRenew.body.code], [409, 'PLAYBACK_GENERATION_STALE'],
    'S8-3:旧代 renew → 409 GENERATION_STALE(旧票立即失效;请求侧 CAS 预检,状态无关确定性)');
  // 确定性全强度序列(direct reprepare 已接线,微任务级重回 ready;409 NOT_READY 仅
  // preparing 窗口内成立 —— direct 会话窗口在响应返回前即关闭,竞态断言已被下列
  // 确定性序列替代;「preparing 期 renew → 409」改由转码会话断言,见组 3b):
  // 轮询 GET 至 ready → 新代 renew 200 → 新代入口 GET 200 字节可取。
  const s8AReprepared = await s8WaitReady(s8AResolve.id, 20_000);
  const s8DirectSeekRecoveryMs = Date.now() - s8SeekStartedAt;
  check(s8DirectSeekRecoveryMs <= 15_000,
    `S8-3:seek 恢复 ≤15s(watchdog.seekTimeoutSeconds 预算;实测 ${s8DirectSeekRecoveryMs}ms)`);
  checkEq(s8AReprepared.generation, s8AView.generation + 1, 'S8-3:reprepare 后会话代 = seek 新代');
  const s8ATicket4 = await s8Renew(s8AResolve.id, s8ASeek.generation);
  checkEq(s8ATicket4.generation, s8ASeek.generation, 'S8-3:新代 renew 200 且 TicketReply.generation = 新代');
  const s8ASeekEntry = await s7Media(s7EntryUrlOf(s8ATicket4.playbackUrl), token);
  checkEq(s8ASeekEntry.status, 200, 'S8-3:新代 playbackUrl 入口 GET 200');
  checkEq(s8ASeekEntry.body, s8DirectBytes, 'S8-3:新代起播字节与源文件一致(direct 交付不因 seek 变质)');

  // —— 组 3b 转码会话 seek:preparing 窗口真实存在(真实 ffmpeg 重启,秒级)—————
  // 「preparing 期 renew → 409 PLAYBACK_NOT_READY」只能由转码会话承载:audio/video_
  // transcode 的 seek 相位经「取消旧代转换 → 重新 reserve → spawn ffmpeg → 首产物」
  // 管线,窗口为秒级;seek 响应返回即发 renew 必落窗口内(409 确定性成立)。随后
  // 轮询 ready(seek 15 秒预算)→ 新代 renew 200 → 新代清单/分片字节可取。
  // 限频预算隔离:renew 桶 10 次/分/设备,组 1~3 峰值已用 7 次/窗口;此处先等待一个
  // 完整窗口自然排空,再进入转码 seek 的 2 次 renew + 组 3c 的 1 次(≤9/窗口,同 S8 开场口径)。
  await sleep(60_000);
  await s8WaitConversionsDrained();
  const s8TSeekResolve = await api('/playback/resolve', 'POST', { mediaId: s8Ac3.id }, 201);
  const s8TSeekReady = await s7WaitForPlayback(s8TSeekResolve.id, ['ready'], 20_000);
  checkEq(s8TSeekReady.delivery, 'audio_transcode', 'S8-3b:转码样本 probe → audio_transcode 交付');
  // lint 清理(既有 no-unused-vars):两处调用均有副作用(签票/等待 ready),返回值本就不需要 ——
  // 去掉赋值保留调用,行为不变。
  await s8Renew(s8TSeekResolve.id, s8TSeekReady.generation);
  const s8TSeekView = await api(`/playback/sessions/${s8TSeekResolve.id}`);
  const s8TSeekStartedAt = Date.now();
  const s8TSeek = await api(`/playback/sessions/${s8TSeekResolve.id}/seek`, 'POST',
    { expectedVersion: s8TSeekView.version, positionSeconds: 1 });
  checkEq([s8TSeek.state, s8TSeek.generation, s8TSeek.version],
    ['preparing', s8TSeekReady.generation + 1, s8TSeekReady.version + 1],
    'S8-3b:转码 seek → preparing 且 generation/version 各 +1');
  const s8TSeekPreparingRenew = await s8RenewLoose(s8TSeekResolve.id, s8TSeek.generation);
  checkEq([s8TSeekPreparingRenew.status, s8TSeekPreparingRenew.body.code], [409, 'PLAYBACK_NOT_READY'],
    'S8-3b:preparing 窗口内 renew → 409 PLAYBACK_NOT_READY(转码相位真实 ffmpeg 重启,拒签票)');
  await s8WaitReady(s8TSeekResolve.id, 20_000);
  const s8TranscodeSeekRecoveryMs = Date.now() - s8TSeekStartedAt;
  check(s8TranscodeSeekRecoveryMs <= 15_000,
    `S8-3b:转码 seek 恢复 ≤15s(watchdog.seekTimeoutSeconds 预算;实测 ${s8TranscodeSeekRecoveryMs}ms)`);
  const s8TSeekTicket2 = await s8Renew(s8TSeekResolve.id, s8TSeek.generation);
  checkEq(s8TSeekTicket2.generation, s8TSeek.generation, 'S8-3b:新代 renew 200 且 TicketReply.generation = 新代');
  const s8TSeekEntry = await s7Media(s7EntryUrlOf(s8TSeekTicket2.playbackUrl), token);
  checkEq(s8TSeekEntry.status, 200, 'S8-3b:新代转码入口 GET 200(seek 后重转码产物经网关交付)');
  check((s8TSeekEntry.headers.get('content-type') ?? '').includes('mpegurl'), 'S8-3b:新代入口 MIME mpegurl');
  check(s8TSeekEntry.text.includes('#EXTM3U'), 'S8-3b:新代清单可解析(#EXTM3U)');
  const s8TSeekAssets = s7ExtractAssetUrls(s8TSeekEntry.text);
  check(s8TSeekAssets.length > 0, 'S8-3b:新代清单重写出带票分片 URL');
  const s8TSeekSegment = await s7Media(s8TSeekAssets[0], token);
  checkEq(s8TSeekSegment.status, 200, 'S8-3b:新代分片 GET 200');
  check(s8TSeekSegment.body.length > 0, 'S8-3b:新代分片字节非零');

  // —— 组 3c 纯字幕切换:同 stem 旁车 .srt(临时构造)→ version+1 不换代 ————
  // 旁车轨词表按实现确定性编号 sub-sidecar-1(playback-subtitles.service 同 stem 扫描序)。
  const s8SubResolve = await api('/playback/resolve', 'POST', { mediaId: s8Direct.id }, 201);
  const s8SubReady = await s7WaitForPlayback(s8SubResolve.id, ['ready']);
  const s8SubTicket = await s8Renew(s8SubResolve.id, s8SubReady.generation);
  const s8SubUrl = s7EntryUrlOf(s8SubTicket.playbackUrl);
  const s8SubSelect = await api(`/playback/sessions/${s8SubResolve.id}/selection`, 'PUT',
    { expectedVersion: s8SubReady.version, subtitleTrackId: 'sub-sidecar-1' });
  checkEq(s8SubSelect.version, s8SubReady.version + 1, 'S8-3c:纯字幕切换 version+1');
  checkEq(s8SubSelect.generation, s8SubReady.generation, 'S8-3c:纯字幕切换不换代');
  check(['ready', 'playing'].includes(s8SubSelect.state), 'S8-3c:纯字幕不触发重建(不进 preparing)');
  checkEq(serverDb().prepare('SELECT subtitle_track_id AS id FROM playback_session WHERE id = ?').get(s8SubResolve.id).id,
    'sub-sidecar-1', 'S8-3c:字幕选择落库');
  const s8SubEntry = await s7Media(s8SubUrl, token);
  checkEq(s8SubEntry.status, 200, 'S8-3c:纯字幕切换后入口仍 200(不重推流)');

  // —— 组 4 额度满(尽力/非确定性 —— 诚实优先于凑绿)————————————————
  // 转码管线已接线:额度在准备段真实生效。可观测面为会话终态(失败以 state=failed +
  // failureCode 稳定码呈现;resolve 对准备段 fire-and-forget,响应恒 201 —— 不存在
  // 同步 503 形态)。PLAYBACK_CONVERSION_CONCURRENCY=1 已注入;小样本(128×96 2s)
  // 转码秒级退出导致 BUSY 窗口极窄,两轮尽力:①3 并发 resolve 竞 reserve;②错峰
  // (先 resolve 待转换行进入活跃态,再 resolve 第二会话)。任一轮出现失败稳定码
  // PLAYBACK_CONVERSION_BUSY 即硬断言;否则如实记录 busyObserved=false,并以 winner
  // 任务行 started_at→ended_at 实测墙钟作为「窗口毫秒级」依据,不为触发 BUSY 注入
  // 假进程、不放宽其他断言。
  let s8BusyObserved = false;
  let s8BusyEvidence = '未触发';
  const s8BusyProbeIds = [];
  const s8BusyOnce = async () => {
    const response = await fetch(`${base}/api/playback/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mediaId: s8Ac3.id }),
    });
    const body = await response.json();
    s8BusyProbeIds.push(body.id);
    return { status: response.status, id: body.id };
  };
  const s8BusyActiveRowOf = (sessionId) =>
    serverDb().prepare(
      "SELECT COUNT(*) AS n FROM playback_conversion WHERE session_id = ? AND state IN ('reserved','probing','starting','running','stopping')",
    ).get(sessionId).n;
  await s8WaitConversionsDrained();
  const s8BusyRound1 = await Promise.all([s8BusyOnce(), s8BusyOnce(), s8BusyOnce()]);
  check(s8BusyRound1.every(r => r.status === 201), 'S8-4:并发转换 resolve 均 201 接受(拒绝在准备段收口)');
  let s8BusyTerminals = await Promise.all(s8BusyProbeIds.map(id => s8WaitTerminal(id, 20_000)));
  const s8BusyLoserOf = (terminals) =>
    terminals.find(session => session.state === 'failed' && session.failureCode === 'PLAYBACK_CONVERSION_BUSY');
  let s8BusyLoser = s8BusyLoserOf(s8BusyTerminals);
  if (s8BusyLoser === undefined) {
    // 第二轮(错峰窗口):winner 转换行进入活跃态后立刻 resolve 挑战者 —— 挑战者的
    // 准备段(ffprobe+plan+reserve)与 winner 剩余编码赛跑,窗口比盲并发更宽。
    console.log('[S8] note: 组 4 第一轮并发未触发 BUSY,进入第二轮错峰窗口实测');
    await s8WaitConversionsDrained();
    const s8BusyHolder = await s8BusyOnce();
    const s8HolderReadyState = await s7WaitForPlayback(s8BusyHolder.id, ['ready', 'failed'], 20_000);
    if (s8HolderReadyState.state === 'ready') {
      const holderDeadline = Date.now() + 10_000;
      while (s8BusyActiveRowOf(s8BusyHolder.id) === 0 && Date.now() <= holderDeadline) {
        await sleep(50); // winner 首产物后任务仍在运行 → 行活跃;行已终态则窗口已关,如实放行
      }
      const s8BusyChallenger = await s8BusyOnce();
      checkEq(s8BusyChallenger.status, 201, 'S8-4:第二轮挑战 resolve 201 接受');
      s8BusyTerminals = [...s8BusyTerminals, s8HolderReadyState, await s8WaitTerminal(s8BusyChallenger.id, 20_000)];
      s8BusyLoser = s8BusyLoserOf(s8BusyTerminals);
    }
  }
  const s8BusyWinner = s8BusyTerminals.find(session => session.state === 'ready');
  if (s8BusyLoser !== undefined) {
    s8BusyObserved = true;
    checkEq(s8BusyLoser.failureCode, 'PLAYBACK_CONVERSION_BUSY', 'S8-4:额度满稳定码 PLAYBACK_CONVERSION_BUSY 真实出现(会话 failed 携稳定码)');
    check(s8BusyWinner !== undefined, 'S8-4:额度 winner 会话照常 ready(额度串行,不连坐)');
    s8BusyEvidence = 'BUSY 真实出现(会话 failed 携稳定码 PLAYBACK_CONVERSION_BUSY)';
  } else {
    check(s8BusyWinner !== undefined, 'S8-4(尽力未触发):至少一个转码会话 ready(额度未被击穿,仅窗口未捕捉)');
    const s8WinnerWallMs = s8BusyWinner === undefined ? null : s8ConversionWallMs(s8BusyWinner.id);
    s8BusyEvidence = `两轮未触发:小样本转码窗口毫秒级(winner 任务行实测 ${String(s8WinnerWallMs)}ms;BUSY 语义由仓储 reserve BEGIN IMMEDIATE 计数与单测覆盖)`;
    console.log(`[S8] note: 组 4 PLAYBACK_CONVERSION_BUSY 未触发 —— ${s8BusyEvidence}`);
  }

  // —— 组 5 限时失败/取消:corrupt 样本 probe 稳定失败 + preparing 期 stop 取消 ——
  const s8CorruptResolve = await api('/playback/resolve', 'POST', { mediaId: s8Corrupt.id }, 201);
  const s8CorruptFailed = await s7WaitForPlayback(s8CorruptResolve.id, ['failed'], 20_000);
  checkEq(s8CorruptFailed.state, 'failed', 'S8-5:corrupt 样本轮询至 failed');
  check(['PLAYBACK_FORMAT_UNSUPPORTED', 'PLAYBACK_RESOURCE_UNAVAILABLE'].includes(s8CorruptFailed.failureCode ?? ''),
    `S8-5:稳定失败码(实测 ${String(s8CorruptFailed.failureCode)};截头破坏 box 预期 PLAYBACK_FORMAT_UNSUPPORTED)`);
  await api(`/playback/sessions/${s8CorruptResolve.id}/stop`, 'POST', {}, 204);
  checkEq((await api(`/playback/sessions/${s8CorruptResolve.id}`)).state, 'failed', 'S8-5:终态 failed 上 stop 幂等(状态不改写)');
  await api(`/playback/sessions/${s8CorruptResolve.id}/stop`, 'POST', {}, 204);
  // 取消样本改用转码会话(同类竞态排查):direct 会话 resolve→ready 微任务级完成,
  // 「preparing 期 stop」在 HTTP 流上不可达;转码会话准备段含真实 ffmpeg 启动(秒级),
  // stop 落在 preparing 窗口内为稳定形态。stop 幂等 204 断言状态无关,保留原样。
  await s8WaitConversionsDrained();
  const s8CancelResolve = await api('/playback/resolve', 'POST', { mediaId: s8Ac3.id }, 201);
  checkEq(s8CancelResolve.state, 'preparing', 'S8-5:取消样本(转码)resolve 201 preparing');
  await api(`/playback/sessions/${s8CancelResolve.id}/stop`, 'POST', {}, 204);
  checkEq((await api(`/playback/sessions/${s8CancelResolve.id}`)).state, 'ended', 'S8-5:preparing 期 stop → 终态 ended');
  await sleep(300);
  checkEq((await api(`/playback/sessions/${s8CancelResolve.id}`)).state, 'ended', 'S8-5:取消后不再转 ready(终态不可复活;准备管线 markReady 被终态 CAS 拒绝)');

  // —— 组 6 失联:真实心跳节拍证据后,DB 直拨 last_heartbeat_at 回拨 50 秒(直改=
  //     测试夹具,与 pointSourceAt 同直访模式)→ 后台失联扫描(15s/拍,阈值 45s)回收 ——
  const s8Disc = await api('/playback/resolve', 'POST', { mediaId: s8Direct.id }, 201);
  const s8DiscReady = await s7WaitForPlayback(s8Disc.id, ['ready']);
  const s8DiscTicket = await s8Renew(s8Disc.id, s8DiscReady.generation);
  const s8DiscUrl = s7EntryUrlOf(s8DiscTicket.playbackUrl);
  checkEq((await s7Media(s8DiscUrl, token)).status, 200, 'S8-6 前置:失联样本起播 200(进入 playing)');
  const s8Beat0 = serverDb().prepare('SELECT last_heartbeat_at AS beat FROM playback_session WHERE id = ?').get(s8Disc.id).beat;
  await api(`/playback/sessions/${s8Disc.id}/heartbeat`, 'POST', { positionSeconds: 1, paused: false }, 204);
  const s8Beat1 = serverDb().prepare('SELECT last_heartbeat_at AS beat FROM playback_session WHERE id = ?').get(s8Disc.id).beat;
  check(Date.parse(s8Beat1) >= Date.parse(s8Beat0), 'S8-6:heartbeat 刷新 last_heartbeat_at(15s 节拍语义)');
  serverDb().prepare('UPDATE playback_session SET last_heartbeat_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 50_000).toISOString(), s8Disc.id);
  const s8Lost = await s7WaitForPlayback(s8Disc.id, ['interrupted'], 30_000);
  checkEq(s8Lost.state, 'interrupted', 'S8-6:失联回收 interrupted(45s 阈值,扫描 15s/拍)');
  check(s8Lost.endedAt !== null, 'S8-6:interrupted 具备 endedAt');
  checkEq(s8Lost.failureCode ?? null, null, 'S8-6:失联属系统回收,interrupted 无 failureCode');
  // 终态票门已入运行构建(dist 重建后 validateStreamTicket 拒绝终态会话旧票)——全强度
  // 硬断言:失联回收后旧票 URL GET 立即 401 稳定码 PLAYBACK_TICKET_INVALID。
  const s8LostDirect = await s7Media(s8DiscUrl, token);
  const s8TerminalTicketGateInBuild = true;
  checkEq(s8LostDirect.status, 401, 'S8-6:失联回收后旧票 URL GET → 401(终态票门)');
  checkEq(JSON.parse(s8LostDirect.text).code, 'PLAYBACK_TICKET_INVALID', 'S8-6:旧票稳定码 PLAYBACK_TICKET_INVALID(立即失效,不待 TTL)');
  const s8LostRenew = await s8RenewLoose(s8Disc.id, s8DiscReady.generation);
  checkEq([s8LostRenew.status, s8LostRenew.body.code], [409, 'PLAYBACK_NOT_READY'], 'S8-6:终态 renew 409 NOT_READY(失联会话不可复活/不可续票)');
  check(Date.parse(s8DiscTicket.ticketExpiresAt) - Date.now() <= 305_000,
    'S8-6:旧票受 TTL 预算约束(≤300s,到期即失效)');

  // —— 组 7 字幕:旁车字幕资产 GET(资产 id 来自实现字幕目录的确定性编号)————
  // 分层说明:direct 路径旁车字幕真实可用(同 stem .srt 临时构造);HLS 上游字幕资产
  // (清单重写 + VTT 字节)已由 S7-1b 覆盖,字幕授权拒绝矩阵已由 S7-2 覆盖,不重复。
  const s8SubAssetUrl = s8SubUrl.replace('/index?', '/sub-sidecar-1?');
  const s8SubAsset = await s7Media(s8SubAssetUrl, token);
  checkEq(s8SubAsset.status, 200, 'S8-7:旁车字幕资产 GET 200(经票绑定入口的同源资产路径)');
  check((s8SubAsset.headers.get('content-type') ?? '').includes('text/vtt'), 'S8-7:字幕 MIME text/vtt');
  check(s8SubAsset.text.startsWith('WEBVTT'), 'S8-7:内容以 WEBVTT 头开始(SRT→VTT 转换)');
  check(s8SubAsset.text.includes('S8 字幕文本 plain words'), 'S8-7:字幕文本完整可读');

  // —— 组 8 重启:活动会话全 interrupted + 私有根孤儿清理 + 目录/名单/EPG 保留 +
  //     新 resolve 可用(现有「process restart persistence」SIGKILL/respawn 模式)——
  const s8HouseholdId = serverDb().prepare('SELECT household_id AS h FROM playback_session WHERE id = ?').get(s8Disc.id).h;
  const s8OrphanDir = path.join(dir, 'playback', s8HouseholdId, randomUUID(), '1');
  fs.mkdirSync(s8OrphanDir, { recursive: true });
  fs.writeFileSync(path.join(s8OrphanDir, 'orphan-segment.ts'), Buffer.alloc(512, 0x51));
  const s8RestartProbe = await api('/playback/resolve', 'POST', { mediaId: s8Direct.id }, 201);
  await s7WaitForPlayback(s8RestartProbe.id, ['ready']); // 重启前保持活动,供 recoverOnBoot 标记
  const s8MediaTotalBefore = (await adultList('?page=1&pageSize=1')).total;
  const s8PolicyBefore = await mapi(`/settings/profiles/${adultProfile.id}/policy`);
  const s8ProgrammeBefore = await api(`/media/${ch1.id}/programmes`);
  await killHard();
  await startResilient();
  checkEq((await api(`/playback/sessions/${s8RestartProbe.id}`)).state, 'interrupted', 'S8-8:重启后活动播放会话全 interrupted');
  check(!fs.existsSync(s8OrphanDir), 'S8-8:私有根孤儿任务目录已清理(recoverOnBoot 扫描)');
  checkEq((await adultList('?page=1&pageSize=1')).total, s8MediaTotalBefore, 'S8-8:目录数据保留');
  checkEq((await mapi(`/settings/profiles/${adultProfile.id}/policy`)).version, s8PolicyBefore.version, 'S8-8:名单/策略保留');
  checkEq((await api(`/media/${ch1.id}/programmes`)).current.title, s8ProgrammeBefore.current.title, 'S8-8:EPG 数据保留');
  const s8Reborn = await api('/playback/resolve', 'POST', { mediaId: s8Direct.id }, 201);
  const s8RebornReady = await s7WaitForPlayback(s8Reborn.id, ['ready']);
  const s8RebornTicket = await s8Renew(s8Reborn.id, s8RebornReady.generation);
  checkEq((await s7Media(s7EntryUrlOf(s8RebornTicket.playbackUrl), token)).status, 200,
    'S8-8:重启后新 resolve→renew→GET 起播可用');

  const s8AssertionCount = assertionCount - s8StartCount;
  console.log(`[S8] US1 播放正向/鲁棒性 OK:起播字节多路径(direct 字节一致+转码交付全强度 清单/带票分片字节)/续期同 session 与任务行/Range 206/seek 换代 CAS+确定性恢复序列(direct ${s8DirectSeekRecoveryMs}ms/转码 ${s8TranscodeSeekRecoveryMs}ms,均 ≤15s 预算)/转码 preparing 窗口 409/纯字幕 version+1 不换代/额度满(${s8BusyObserved ? 'BUSY 真实出现' : '尽力未触发(窗口毫秒级,实测依据见输出)'})/限时失败+preparing 取消(转码会话)/失联回收+旧票 401 稳定码/recoverOnBoot 重启+孤儿清理+数据保留/旁车字幕 WEBVTT(新增 ${s8AssertionCount} 断言)`);

  /* -------------------------------------------------------------- */
  /* S9 US2b SC-004 记录真实 HTTP 场景(T047;quickstart「SC-004:记录」)  */
  /* 「有效设备失败事件与成功 session 分离、字段齐全;无效会话不进入设备    */
  /* 记录;家长能按设备查询且越权拒绝」。复用 S7/S8 播放世界(夹具媒体/    */
  /* s7Media/s7EntryUrlOf 直访辅助);005 T130:记录查询迁入               */
  /* /settings/devices/{id}/playback-records/query(Settings 边界 = 主档案 */
  /* 选中 + 设置授予 + owner-only + 当次密码,api.md §6/§8)。             */
  /* 浏览器 UI 验收(DevicePlaybackRecords 组件操作)不在本文件能力内 ——  */
  /* 分层说明:本 API 即 UI 数据源(T046 已交付组件并过 tsc/build 门禁), */
  /* 浏览器层缺口由 evidence.md 如实记录(归 T054/T055 浏览器链路层)。    */
  /* -------------------------------------------------------------- */
  const s9StartCount = assertionCount;
  // 前置 1:家长验证计数清零(直改 DB,与阶段 3 前置同一先例)——S3/S4/S6 曾各有 1 次错误
  // 密码计数,清零使 S9 的「错误密码 → FAILED → 正确密码恢复」断言与更早场景解耦;
  // S9 全程错误密码恰 1 次 ≪ 5 次×5min 锁定阈值,不触发锁定死锁。
  serverDb().prepare('DELETE FROM parent_verification_state').run();
  // 前置 2:独立记录设备 A —— 新登录=新 Device(auth 契约取舍「每次登录新建 Device」),
  // 播放限频(renew 10/分/设备)与既有设备窗口天然隔离;deviceId 经 sessionId 直访定位。
  const s9LoginA = await api('/auth/login', 'POST', { username: 'runtimeqa', password }, 200);
  const s9TokenA = s9LoginA.sessionToken;
  const s9DeviceA = serverDb().prepare('SELECT device_id AS id FROM device_session WHERE id = ?').get(s9LoginA.sessionId).id;
  check(typeof s9DeviceA === 'string' && s9DeviceA.length > 0, 'S9 前置:登录即建新 Device,记录设备 A 定位(sessionId→device_id 直访)');
  // 005:device A 会话选主档案(PIN 保护 → unlock+select)并解锁设置(记录查询的 Settings 前置)
  await ensureSettings(s9TokenA);
  const s9RecordsUrlOf = (deviceId) => `/settings/devices/${deviceId}/playback-records/query`; // 005 T130 settings 前缀
  const s9PagePre = await mapiWith(s9TokenA, s9RecordsUrlOf(s9DeviceA), 'POST', { ownerPassword: password });
  checkEq(s9PagePre.items.length, 0, 'S9 前置:新设备记录页初始为空(「恰 2 条」判定的确定性前提)');

  /* S9 专用辅助(bearer 参数化;S7/S8 同类辅助硬编码全局 token,跨设备会话不可复用) */
  const s9Renew = async (bearer, sessionId, expectedGeneration) => {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(`${base}/api/playback/sessions/${sessionId}/renew`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ expectedGeneration }),
      });
      if (response.status === 429 && attempt < 8) {
        await sleep(8_000 + 250); // 429 未记账;窗口滑出后重试(s8Renew 同款诚实退避)
        continue;
      }
      assert.equal(response.status, 200, `renew ${sessionId} -> 200(HTTP ${response.status})`);
      return response.json();
    }
  };
  const s9WaitForPlayback = async (bearer, sessionId, statuses, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const response = await fetch(`${base}/api/playback/sessions/${sessionId}`, {
        headers: { Authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      });
      const body = await response.json();
      if (statuses.includes(body.state)) return body;
      if (Date.now() > deadline) {
        throw new Error(`S9 播放会话 ${sessionId} 等待 [${statuses.join(',')}] 超时,最后 HTTP ${response.status}: ${JSON.stringify(body)}`);
      }
      await sleep(100);
    }
  };
  const s9IsoFieldOk = (value) => typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));

  // —— 组 1 基线:成功播放(resolve→ready→renew→GET 媒体→stop)+ 同设备策略拒绝解析
  //      失败(S7-3 黑名单手法)→ 家长密码查询恰 2 条(1 session + 1 failure)—————
  const s9Resolve = await apiWith(s9TokenA, '/playback/resolve', 'POST', { mediaId: s8Direct.id }, 201);
  const s9Ready = await s9WaitForPlayback(s9TokenA, s9Resolve.id, ['ready']);
  checkEq(s9Ready.delivery, 'direct', 'S9-1:resolve→ready(direct 交付;记录场景成功播放基线)');
  const s9Ticket = await s9Renew(s9TokenA, s9Resolve.id, s9Ready.generation);
  const s9Entry = await s7Media(s7EntryUrlOf(s9Ticket.playbackUrl), s9TokenA);
  checkEq(s9Entry.status, 200, 'S9-1:首次媒体 GET 200(首次交付 → started_at 一次性落库)');
  await apiWith(s9TokenA, `/playback/sessions/${s9Resolve.id}/stop`, 'POST', {}, 204);
  checkEq((await apiWith(s9TokenA, `/playback/sessions/${s9Resolve.id}`)).state, 'ended', 'S9-1:stop → 终态 ended(ended_at 终态迁移落库)');
  // 005 T126:策略管理迁入 /settings/profiles/{id}/policy(/lists);device A 会话已选主档案
  const s9PolicyBefore = await mapiWith(s9TokenA, `/settings/profiles/${adultProfile.id}/policy`);
  await mapiWith(s9TokenA, `/settings/profiles/${adultProfile.id}/policy/lists`, 'PUT', {
    ownerPassword: password, expectedVersion: s9PolicyBefore.version,
    allowedMediaIds: [], blockedMediaIds: [s8Direct.id], allowedChannelIds: [],
  });
  const s9Denied = await apiWith(s9TokenA, '/playback/resolve', 'POST', { mediaId: s8Direct.id }, 404);
  checkEq(s9Denied.code, 'MEDIA_NOT_FOUND', 'S9-1:黑名单后 resolve → 404 同形(有效会话解析被拒 → 审计写入路径)');
  await mapiWith(s9TokenA, `/settings/profiles/${adultProfile.id}/policy/lists`, 'PUT', {
    ownerPassword: password, expectedVersion: s9PolicyBefore.version + 1,
    allowedMediaIds: [], blockedMediaIds: [], allowedChannelIds: [],
  });
  const s9Page = await mapiWith(s9TokenA, s9RecordsUrlOf(s9DeviceA), 'POST', { ownerPassword: password });
  checkEq(s9Page.items.length, 2, 'S9-1:记录恰 2 条(1 session + 1 failure,成功/失败分离)');
  const s9SessionRec = s9Page.items.find(item => item.kind === 'session');
  const s9FailureRec = s9Page.items.find(item => item.kind === 'failure');
  check(s9SessionRec !== undefined && s9FailureRec !== undefined, 'S9-1:session 与 failure 各恰一条(kind 判别联合)');
  check(s9Page.items[0] === s9FailureRec && s9Page.items[1] === s9SessionRec, 'S9-1:页序 (time,id) 倒序 —— failure 后发生故排在首');
  checkEq(s9Page.nextCursor, null, 'S9-1:单页到底 nextCursor=null');

  // —— 组 2 字段完整率 100%:session 13 键/failure 6 键逐一语义断言 + 查询响应面 ——
  const s9FieldOk = (value) => value !== null && value !== undefined && (typeof value !== 'string' || value.length > 0);
  checkEq([...Object.keys(s9SessionRec)].sort(), ['createdAt', 'delivery', 'deviceId', 'endedAt', 'failureCode', 'id', 'kind',
    'mediaId', 'playbackSourceId', 'positionSeconds', 'profileId', 'startedAt', 'state'].sort(),
    'S9-2:session 记录恰 13 键(openapi PlaybackSessionRecord 精确键集)');
  const s9SessionFieldChecks = [
    ['kind', s9SessionRec.kind === 'session'],
    ['id', s9FieldOk(s9SessionRec.id) && s9SessionRec.id === s9Resolve.id],
    ['deviceId', s9SessionRec.deviceId === s9DeviceA],
    ['mediaId', s9SessionRec.mediaId === s8Direct.id],
    ['profileId', s9SessionRec.profileId === adultProfile.id],
    ['state', s9SessionRec.state === 'ended'],
    ['delivery', s9SessionRec.delivery === 'direct'],
    ['positionSeconds', typeof s9SessionRec.positionSeconds === 'number' && Number.isFinite(s9SessionRec.positionSeconds)],
    ['createdAt', s9IsoFieldOk(s9SessionRec.createdAt)],
    ['startedAt', s9IsoFieldOk(s9SessionRec.startedAt)],
    ['endedAt', s9IsoFieldOk(s9SessionRec.endedAt)],
    ['failureCode', s9SessionRec.failureCode === null], // 语义:成功播放无失败码(按语义为「应空即空」)
    ['playbackSourceId', typeof s9SessionRec.playbackSourceId === 'string' && s9SessionRec.playbackSourceId.length > 0
      && !s9SessionRec.playbackSourceId.includes('/') && !s9SessionRec.playbackSourceId.includes('.mp4')
      && !s9SessionRec.playbackSourceId.includes(nasRoot)], // 不透明串:非路径/文件名
  ];
  for (const [field, ok] of s9SessionFieldChecks) {
    check(ok, `S9-2:session 记录 ${field} 语义断言(非空/应空即空/归属正确)`);
  }
  const s9SessionRate = Math.round(s9SessionFieldChecks.filter(([, ok]) => ok).length / s9SessionFieldChecks.length * 100);
  checkEq(s9SessionRate, 100, 'S9-2:session 记录字段完整率 = 100%(按语义非空计数/13)');
  checkEq([...Object.keys(s9FailureRec)].sort(), ['id', 'kind', 'mediaId', 'occurredAt', 'profileId', 'stableCode'].sort(),
    'S9-2:failure 记录恰 6 键(openapi PlaybackFailureRecord 精确键集;无 deviceId)');
  const s9FailureFieldChecks = [
    ['kind', s9FailureRec.kind === 'failure'],
    ['id', s9FieldOk(s9FailureRec.id) && s9FailureRec.id !== s9SessionRec.id],
    ['occurredAt', s9IsoFieldOk(s9FailureRec.occurredAt)],
    ['stableCode', s9FailureRec.stableCode === 'MEDIA_NOT_FOUND'],
    ['profileId', s9FailureRec.profileId === adultProfile.id], // 拒绝时激活档案(可确定 → 非 null)
    ['mediaId', s9FailureRec.mediaId === s8Direct.id], // 可见媒体按可见性保留(策略拒绝不折叠可见性)
  ];
  for (const [field, ok] of s9FailureFieldChecks) {
    check(ok, `S9-2:failure 记录 ${field} 语义断言(非空/稳定码/可见性保留)`);
  }
  const s9FailureRate = Math.round(s9FailureFieldChecks.filter(([, ok]) => ok).length / s9FailureFieldChecks.length * 100);
  checkEq(s9FailureRate, 100, 'S9-2:failure 记录字段完整率 = 100%(6/6)');
  const s9OverallRate = Math.round(
    (s9SessionFieldChecks.filter(([, ok]) => ok).length + s9FailureFieldChecks.filter(([, ok]) => ok).length)
    / (s9SessionFieldChecks.length + s9FailureFieldChecks.length) * 100,
  );
  checkEq(s9OverallRate, 100, 'S9-2:记录字段完整率(session 13 + failure 6)= 100%(写入输出)');
  const s9RawRecords = await fetch(`${base}/api${s9RecordsUrlOf(s9DeviceA)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${s9TokenA}` },
    body: JSON.stringify({ ownerPassword: password }),
  });
  checkEq(s9RawRecords.status, 200, 'S9-2:记录查询原始响应 200(响应面检查)');
  checkEq(s9RawRecords.headers.get('cache-control'), 'no-store', 'S9-2:记录查询 Cache-Control no-store');
  checkEq(s9RawRecords.headers.get('referrer-policy'), 'no-referrer', 'S9-2:Referrer-Policy no-referrer');
  checkEq(s9RawRecords.headers.get('content-type'), 'application/json; charset=utf-8', 'S9-2:成功响应 Content-Type = application/json(005 settings 端点;problem+json 仅错误响应,旧 004 成功体 problem+json 形态不保留)');
  const s9RawText = await s9RawRecords.text();
  check(!s9RawText.includes(nasRoot) && !s9RawText.includes('.mp4') && !s9RawText.includes('ticket=') && !s9RawText.includes(password),
    'S9-2:记录体零泄漏(无 NAS 路径/文件名/票明文/家长密码回显)');

  // —— 组 3 未认证不入设备记录:伪造 token resolve → 401 → 记录集合不变 ————
  const s9Forged = await fetch(`${base}/api/playback/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer s9-forged-token-not-in-db' },
    body: JSON.stringify({ mediaId: s8Direct.id }),
  });
  checkEq(s9Forged.status, 401, 'S9-3:伪造 token resolve → 401(无效会话)');
  checkEq((await s9Forged.json()).code, 'SESSION_INVALID', 'S9-3:稳定码 SESSION_INVALID(仅脱敏安全日志语义)');
  const s9PageAfterForged = await mapiWith(s9TokenA, s9RecordsUrlOf(s9DeviceA), 'POST', { ownerPassword: password });
  checkEq(s9PageAfterForged.items.map(item => item.id), s9Page.items.map(item => item.id),
    'S9-3:未认证解析不入设备记录(记录集合逐 id 不变)');

  // —— 组 4 权限负向:错误密码/缺密码/非 owner/不存在设备 404 同形 ————————
  // 005 T130:Settings 边界(主档案+授予)先于 owner-only 与当次密码(服务层继承 004 语义)
  const s9WrongPwd = await mapiWith(s9TokenA, s9RecordsUrlOf(s9DeviceA), 'POST', { ownerPassword: 's9-definitely-wrong' }, 403);
  checkEq(s9WrongPwd.code, 'PARENT_VERIFICATION_FAILED', 'S9-4:错误密码 → 403 FAILED(当次密码;全程 1 次 ≪ 锁定阈值)');
  const s9NoPwd = await mapiWith(s9TokenA, s9RecordsUrlOf(s9DeviceA), 'POST', {}, 403);
  checkEq(s9NoPwd.code, 'PARENT_VERIFICATION_REQUIRED', 'S9-4:缺失密码 → 403 REQUIRED(不计入失败计数)');
  const s9RecoverPage = await mapiWith(s9TokenA, s9RecordsUrlOf(s9DeviceA), 'POST', { ownerPassword: password });
  checkEq(s9RecoverPage.items.map(item => item.id), s9Page.items.map(item => item.id),
    'S9-4:失败尝试后正确密码恢复查询(成功验证清零,集合不变)');
  // 非 owner:直改 role 与 S6 同款直访模式(SessionGuard 每请求重读;用后立即恢复,期间无其他请求)。
  // 005 语义:admin 属管理角色可通过 Settings 守卫,但记录查询 owner-only 在服务层继承 ——
  // 仍 403 FORBIDDEN(与旧 004 断言同形; requireOwner 先于家长验证)。
  serverDb().prepare("UPDATE account SET role = 'admin' WHERE username = 'runtimeqa'").run();
  const s9AdminBody = await mapiWith(s9TokenA, s9RecordsUrlOf(s9DeviceA), 'POST', { ownerPassword: password }, 403);
  checkEq(s9AdminBody.code, 'FORBIDDEN', 'S9-4:非 owner 账号(admin)→ 403 FORBIDDEN(服务层 owner-only 继承;Settings 守卫放行 admin 不放宽记录查询)');
  serverDb().prepare("UPDATE account SET role = 'owner' WHERE username = 'runtimeqa'").run();
  const s9UnknownA = await mapiWith(s9TokenA, s9RecordsUrlOf(randomUUID()), 'POST', { ownerPassword: password }, 404);
  checkEq(s9UnknownA.code, 'NOT_FOUND', 'S9-4:不存在 deviceId → 404(密码正确仍拒,不泄漏存在性)');
  const s9UnknownB = await mapiWith(s9TokenA, s9RecordsUrlOf(randomUUID()), 'POST', { ownerPassword: password }, 404);
  checkEq(s9UnknownB, s9UnknownA, 'S9-4:两个随机 deviceId 404 响应体逐字段一致(同形,不可枚举)');

  // —— 组 5 设备隔离:device B(S2 第二登录既有设备)自有记录不混入 device A ————
  const s9SessionB = await apiWith(sessionB, '/auth/session');
  const s9DeviceB = serverDb().prepare('SELECT device_id AS id FROM device_session WHERE id = ?').get(s9SessionB.sessionId).id;
  check(s9DeviceB !== s9DeviceA, 'S9-5:device B 与 device A 为不同设备(两次独立登录)');
  await apiWith(sessionB, `/profiles/${childProfile.id}/select`, 'POST', {});
  const s9BDenied = await apiWith(sessionB, '/playback/resolve', 'POST', { mediaId: ch3.id }, 404);
  checkEq(s9BDenied.code, 'MEDIA_NOT_FOUND', 'S9-5:device B(child 黑名单 ch3)解析拒绝 → 404 同形(构造 device B 自有记录)');
  // 005 T130:记录查询属 Settings 边界 → device B 会话切回主档案(选档撤销其授予,重解锁)后查询
  await ensureSettings(sessionB);
  const s9PageB = await mapiWith(sessionB, s9RecordsUrlOf(s9DeviceB), 'POST', { ownerPassword: password });
  checkEq(s9PageB.items.length, 1, 'S9-5:device B 记录恰 1 条(仅自有 failure,无 device A 记录)');
  checkEq([s9PageB.items[0].kind, s9PageB.items[0].stableCode, s9PageB.items[0].mediaId, s9PageB.items[0].profileId],
    ['failure', 'MEDIA_NOT_FOUND', ch3.id, childProfile.id],
    'S9-5:device B failure 字段语义正确(child 档案拒绝时激活档案;可见媒体保留 mediaId)');
  const s9PageA2 = await mapiWith(s9TokenA, s9RecordsUrlOf(s9DeviceA), 'POST', { ownerPassword: password });
  checkEq(s9PageA2.items.map(item => item.id), s9Page.items.map(item => item.id),
    'S9-5:device A 记录集合不变(不混入 device B 记录;session 记录 deviceId 恒为 device A)');
  check(!s9PageA2.items.some(item => item.id === s9PageB.items[0].id), 'S9-5:device B failure id 不出现在 device A 页');

  const s9AssertionCount = assertionCount - s9StartCount;
  console.log(`[S9] US2b SC-004 记录 OK:基线恰 2 条(1 session+1 failure)/字段完整率 100%(session 13 键+failure 6 键,逐键语义)/未认证 401 不入设备记录/权限负向(错误密码 FAILED/缺密码 REQUIRED/非 owner FORBIDDEN/不存在设备 404 同形)/第二设备记录不混入(新增 ${s9AssertionCount} 断言)`);
  console.log(JSON.stringify({
    result: 'PASS',
    phase2Scenarios: 8,
    phase3Scenarios: ['S1-source-loop', 'S2-catalog-matrix', 'S3-epg-flow', 'S4-policy-lists', 'S5-perf-baseline', 'S6-manual-epg-binding', 'S7-us2-playback-negative-matrix', 'S8-us1-playback-positive-robustness', 'S9-us2b-playback-records'],
    assertionCount,
    s5,
    s6: {
      assertionCount: s6AssertionCount,
      finalBinding: { mediaId: s6Bound.id, mode: 'manual', version: resaved.version, epgSourceId: epgA.id, xmltvChannelId: 'chan-match' },
      epgAGenerationFinal: candAfterBump.epgGeneration,
      epgBGeneration: candB.epgGeneration,
    },
    s7: {
      assertionCount: s7AssertionCount,
      matrix: {
        profileSwitch: '005 换档同事务终态化:旧票 URL 401 PLAYBACK_TICKET_INVALID(媒体/清单/分片/key/字幕)+ 旧会话 GET/renew 404 PLAYBACK_NOT_FOUND(上下文版本为唯一拒绝依据);A→B→A 不复活,恢复经全新解析',
        policyTighten: '404 MEDIA_NOT_FOUND 同形(媒体/renew/GET 会话)',
        logout: '401 SESSION_INVALID + 重登录后旧票 401 PLAYBACK_TICKET_INVALID',
        sourceDisabled: '404 MEDIA_NOT_FOUND 同形(renew/媒体 GET)',
        rangeHead: '206 Content-Range 一致;HEAD 200 无体 / 未授权 401',
        midStreamFailure: 'HLS 断流:截断字节流无 JSON 注入 + 失败码轮询可见;direct 未发 headers → 503 problem',
      },
      directSession: { id: s7A.id, delivery: s7AReady.delivery, generation: s7AReady.generation, note: '组 2 换档后已确定性 interrupted(005 终态化语义)' },
      hlsSession: { id: s7BrokenSessionId, delivery: 'hls_proxy', failureCode: s7FailureCode, note: '断流场景使用组 3b 全新 HLS 会话(组 1 会话被组 2 换档终态化)' },
    },
    s8: {
      assertionCount: s8AssertionCount,
      mediaFixture: {
        generator: 'T032 generate-media.mjs(只读使用;generateAll 生成+自动复核)',
        verification: { pass: s8Generated.verification.pass, fail: s8Generated.verification.fail, totalChecks: s8Generated.verification.totalChecks },
        samples: s8SampleNames,
        sidecarNote: '旁车字幕 mp4-h264-aac-direct.srt 为本场景临时构造(T032 矩阵无字幕样本;.srt 不入目录)',
      },
      conversionDelivery: {
        notes: s8ConversionNotes,
        wiredNote: '转码管线已接线(2026-10-26 现状):resolve/seek 相位经 ConversionSupervisor reserve → 真实 ffmpeg → 首产物 → ready,产物以 window.m3u8 滚动清单经网关同源重写带票交付;本场景全强度断言入口 200 + 分片 200 字节非零,无降级分支。',
      },
      quotaBusyObserved: s8BusyObserved,
      quotaBusyEvidence: s8BusyEvidence,
      terminalTicketGate: s8TerminalTicketGateInBuild
        ? '终态票门在运行构建中生效(硬断言):失联/回收后旧票 URL 立即 401 PLAYBACK_TICKET_INVALID'
        : '终态票门未在运行构建中生效',
      seekReprepare: {
        directMs: s8DirectSeekRecoveryMs,
        transcodeMs: s8TranscodeSeekRecoveryMs,
        budgetMs: 15_000,
        note: 'seek/换代 reprepare 已接线:direct 会话微任务级重回 ready(确定性轮询序列断言新代 renew/字节);转码会话经真实 ffmpeg 管线重回 ready(preparing 窗口内 renew 409 NOT_READY 由组 3b 断言)。恢复实测均 ≤ watchdog.seekTimeoutSeconds=15s 预算。',
      },
      subtitle: 'direct 旁车字幕 sub-sidecar-1 → 200 text/vtt + WEBVTT 头(临时构造 .srt;HLS 字幕资产与授权拒绝由 S7-1b/S7-2 分层覆盖)',
    },
    s9: {
      assertionCount: s9AssertionCount,
      scenario: 'SC-004 记录(US2b T047;quickstart「SC-004:记录」):真实 HTTP 家长设备播放记录查询',
      recordsDevice: { deviceIdKind: '新登录=新 Device(限频/家长验证计数与既有设备隔离)', baselineRecords: 2, composition: '1 session(ended,startedAt/endedAt 齐全)+ 1 failure(MEDIA_NOT_FOUND,mediaId 按可见性保留)' },
      recordFieldCompletenessRate: s9OverallRate,
      unauthenticatedExcluded: '伪造 token resolve 401 SESSION_INVALID → 记录集合逐 id 不变(仅脱敏安全日志语义)',
      permissionMatrix: {
        wrongPassword: '403 PARENT_VERIFICATION_FAILED(全程 1 次 ≪ 5 次×5min 锁定阈值;成功验证清零后恢复)',
        missingPassword: '403 PARENT_VERIFICATION_REQUIRED(不计入失败计数)',
        nonOwner: '403 FORBIDDEN(admin 直改 role 同 S6 手法;Settings 守卫放行管理角色,owner-only 在记录查询服务层继承 004 语义)',
        unknownDevice: '404 NOT_FOUND,两个随机 deviceId 响应体逐字段一致(同形不可枚举)',
      },
      deviceIsolation: 'device B(第二登录)自有 failure 记录不混入 device A 查询,反向亦然(恰 1 条/恰 2 条互斥)',
      browserEvidence: 'HTTP 层即 UI 数据源;DevicePlaybackRecords 组件浏览器验收不在本文件能力内(组件由 T046 交付,过 tsc/build 门禁),浏览器层缺口由 evidence.md 如实记录(归 T054/T055 浏览器链路层)',
    },
  }));
} catch (error) {
  // 失败时输出服务日志尾部辅助诊断(临时目录即将被清理)
  try {
    const serverLogPath = path.join(supportDir, 'server.log');
    if (fs.existsSync(serverLogPath)) {
      const tail = fs.readFileSync(serverLogPath, 'utf8').split('\n').slice(-40).join('\n');
      console.error('[server.log tail]\n' + tail);
    }
  } catch { /* 忽略诊断失败 */ }
  throw error;
} finally {
  await stop();
  await closeFixture();
  if (s7Upstream !== null) {
    s7Upstream.closeAllConnections();
    await new Promise((resolve) => s7Upstream.close(() => resolve()));
    s7Upstream = null;
  }
  if (dbHandle !== null) {
    dbHandle.close();
    dbHandle = null;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(nasBase, { recursive: true, force: true });
  fs.rmSync(supportDir, { recursive: true, force: true });
  if (s8MediaBase !== null) {
    fs.rmSync(s8MediaBase, { recursive: true, force: true });
    s8MediaBase = null;
  }
}
