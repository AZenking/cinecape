import { randomUUID } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';

/**
 * 016 T026 · 端到端走查(multi-source-live-epg;docs/specs/016-multi-source-live-epg/
 * quickstart.md 场景 1→5 全旅程):
 *
 * - 场景 1(本文件场景 1)多源导入聚合:两个含同名频道的 M3U 源经受控导入后,频道
 *   列表仅出现单个频道(API total=1 + 网格单卡片),resolve 下发两条物理线路
 *   (lines[] + selectedLineId;016 api.md §2.1 走现行 POST /playback/resolve 增量);
 * - 场景 2(场景 2)当前节目与进度:/live/channels 卡片呈现当前节目标题 + HeroUI
 *   ProgressBar aria 值,观看页伴随信息区呈现下一档;now-playing 批量投影接口直查
 *   断言(016 api.md §1.1,progress 由服务端按 now 计算);
 * - 场景 3(场景 3)多 EPG 级联与手动绑定:主源缺排期频道由备源补位(matchMode=
 *   cascade 且 epgSourceId=备源);手动绑定(ADR-0008 manual 锁)经全量重新同步
 *   (四源 refresh)后绑定保持且排期严格为手动指定源;
 * - 场景 4(场景 4)多线路容灾与 OSD:默认线路为坏流(上游 404)→ 播放器致命错误
 *   自动切线(新 resolve 携 lineId)+ Toast 提示;播放面 header「切换播放线路」
 *   Dropdown 手动选择第二线路(resolve 携 lineId + selectedLineId 变化);
 * - 场景 5(场景 5)权重治理与儿童隔离:主管理员 UI 调整 EPG 权重保存 → 列表反映
 *   新序且级联裁决按新权重生效(CCTV-1 供给源翻转);儿童档案访问未授权多线路频道
 *   被拒 —— resolve 404 MEDIA_NOT_FOUND 与缺失媒体同形、零签发(与现行 T037 裁决
 *   一致,契约层签发计数归 child-profile-multiline-policy 契约测试)。
 *
 * ══ 运行方式(隔离单进程栈;沿用 015 T023 既定方案)══
 *
 *   # 1) 种子夹具库 + 构建静态产物
 *   SEED=$(mktemp -d /tmp/redroad-t026.XXXXXX)
 *   pnpm --filter @hmp/server exec tsx test/fixtures/scale-fixture.cli.ts --dir $SEED --db-filename scale-fixture.hmp.db
 *   pnpm --filter @hmp/web build
 *   # 2) 隔离 Nest(PORT=3001 + useStaticAssets(apps/web/dist);绝不触碰 :3000/:5173;
 *   #    不设 E2E_SEED_SCALE —— 本套件不要求时钟锚定,见下方环境契约)
 *   DATA_DIR=$SEED DB_FILENAME=scale-fixture.hmp.db \
 *   PORT=3001 LAN_ALLOWED_TARGETS=<本机局域网 IPv4> \
 *   PUBLIC_ORIGIN=http://127.0.0.1:3001 pnpm --filter @hmp/server exec tsx src/main.ts
 *   # 3) 复用 playwright config:E2E_BASE_URL 指向隔离栈;webServer 探测 127.0.0.1:5173
 *   #    需有响应方走 reuseExistingServer 分支(不启动 e2e-servers.sh、不占用 :3000)
 *   E2E_BASE_URL=http://127.0.0.1:3001 pnpm exec playwright test test/e2e/multi-source-live-epg.spec.ts
 *
 * 环境契约:
 * - E2E_SEED_SCALE=1 规模夹具库(凭据 fixtureadmin/password-123;主档案 PIN 135790;
 *   儿童档案 PIN 246800)。注意:本套件不要求服务端时钟锚定 —— EPG 发布窗口以服务端
 *   真实时钟为基准([now−24h, now+7d]),夹具 XMLTV 排期围绕真实 now 生成;隔离栈启动
 *   时**不要**给 Nest 进程设 E2E_SEED_SCALE(否则 live 时钟锚回夹具锚点,与发布窗口
 *   错位 → 排期投影恒空;夹具自身排期窗口 [11-03, 11-10) 覆盖运行日,公共直播面不受
 *   影响);
 * - LAN_ALLOWED_TARGETS 须含本机非回环 IPv4(创建期字面类别校验拒绝回环字面量;
 *   fresh-deployment-loop 同款思路):导入上游与播放流上游 = 本套件 beforeAll 自起的
 *   受控 HTTP 服务(0.0.0.0 随机端口),M3U/XMLTV/流地址一律写该局域网 IPv4,
 *   零外网依赖;
 * - 服务器:PORT=3001 + apps/web/dist 静态产物(useStaticAssets;须先 build,产物
 *   含 016 UI)。
 */

/* ────────────────────────── 夹具常量 ────────────────────────── */

const OWNER = { username: 'fixtureadmin', password: 'password-123' } as const;
const MAIN_PIN = '135790';
const CHILD_PIN = '246800';
const CHILD_PROFILE_NAME = '儿童档案';

const GROUP_LABEL = '走查聚合验证';
const IPTV_SOURCE_A = '走查电信源';
const IPTV_SOURCE_B = '走查联通源';
const EPG_SOURCE_PRIMARY = '走查指南主源';
const EPG_SOURCE_BACKUP = '走查指南备源';

/** M3U 条目(tvg-id 与 XMLTV channel id 对齐级联链;清晰度后缀同时决定线路顺位罚分) */
interface M3uEntrySpec {
  readonly name: string;
  readonly tvgId: string;
  readonly streamPath: string;
}

/** 源 A(走查电信源):CCTV-1 基础名(权重 100) + 容灾台 4K(罚分 2 → 线路 1,坏流) */
const SOURCE_A_ENTRIES: readonly M3uEntrySpec[] = [
  { name: 'CCTV-1 综合', tvgId: 'cctv1', streamPath: '/streams/cctv-a/index.m3u8' },
  { name: '浙江卫视', tvgId: 'zjtv', streamPath: '/streams/zj-a/index.m3u8' },
  { name: '湖南卫视', tvgId: 'hntv', streamPath: '/streams/hn-a/index.m3u8' },
  { name: '走查容灾台 [4K]', tvgId: 'dz', streamPath: '/streams/failover-dead/index.m3u8' },
];
/** 源 B(走查联通源):同名频道带清晰度噪音后缀(聚合键与 A 相同) */
const SOURCE_B_ENTRIES: readonly M3uEntrySpec[] = [
  { name: 'CCTV-1 综合 [4K]', tvgId: 'cctv1', streamPath: '/streams/cctv-b/index.m3u8' },
  { name: '浙江卫视 (高清)', tvgId: 'zjtv', streamPath: '/streams/zj-b/index.m3u8' },
  { name: '走查容灾台 (标清)', tvgId: 'dz', streamPath: '/streams/failover-live/index.m3u8' },
];

/** XMLTV 频道排期(锚点日 2026-11-04 UTC 逐小时档;标题前缀区分供给源) */
interface XmltvChannelSpec {
  readonly id: string;
  readonly displayName: string;
  readonly titlePrefix: string;
}

const PRIMARY_GUIDE_CHANNELS: readonly XmltvChannelSpec[] = [
  { id: 'cctv1', displayName: 'CCTV-1 综合', titlePrefix: '主源央视' },
  { id: 'hntv-main', displayName: '湖南卫视·主源专用指南', titlePrefix: '主源绑定档' },
];
const BACKUP_GUIDE_CHANNELS: readonly XmltvChannelSpec[] = [
  { id: 'cctv1', displayName: 'CCTV-1 备源指南', titlePrefix: '备源央视' },
  { id: 'zjtv', displayName: '浙江卫视', titlePrefix: '备源浙江' },
];

/* ────────────────────────── 夹具构造(M3U / XMLTV / 受控流) ────────────────────────── */

/** 构造 Extended M3U 文本(形态对照 apps/server contract 夹具 buildM3u;组标题统一) */
function buildM3u(origin: string, entries: readonly M3uEntrySpec[]): string {
  const lines: string[] = ['#EXTM3U'];
  for (const entry of entries) {
    lines.push(
      `#EXTINF:-1 tvg-id="${entry.tvgId}" tvg-name="${entry.tvgId}" group-title="${GROUP_LABEL}",${entry.name}`,
    );
    lines.push(`${origin}${entry.streamPath}`);
  }
  return `${lines.join('\n')}\n`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 构造合法 XMLTV(围绕真实当前 UTC 日的逐小时档;时间带时区,契约同款格式):
 * EPG 发布窗口以服务端真实时钟为基准([now−24h, now+7d]),故排期生成取
 * 今日 ±1~+2 日的 96 个小时档 —— 在真实时钟下必有恰好一档覆盖「当前」;
 * 本套件不依赖 E2E_SEED_SCALE 时钟锚定(规模夹具自身的排期窗口 [11-03, 11-10)
 * 天然覆盖运行日的真实 now,直播页/guide 等公共面不受影响)。
 */
function buildXmltv(originLabel: string, channels: readonly XmltvChannelSpec[]): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv>'];
  for (const channel of channels) {
    lines.push(`  <channel id="${channel.id}">`);
    lines.push(`    <display-name>${channel.displayName}</display-name>`);
    lines.push('  </channel>');
  }
  const dayBeginUtcMs = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const stamps: Array<{ readonly start: string; readonly stop: string; readonly label: string }> = [];
  for (let dayOffset = -1; dayOffset <= 2; dayOffset += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const startMs = dayBeginUtcMs + dayOffset * 86_400_000 + hour * 3_600_000;
      const at = new Date(startMs);
      const stop = new Date(startMs + 3_600_000);
      const stampOf = (date: Date): string =>
        `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}` +
        `${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())} +0000`;
      stamps.push({
        start: stampOf(at),
        stop: stampOf(stop),
        label: `${pad2(at.getUTCMonth() + 1)}月${pad2(at.getUTCDate())}日${pad2(hour)}时档(${originLabel})`,
      });
    }
  }
  for (const channel of channels) {
    for (const slot of stamps) {
      lines.push(
        `  <programme channel="${channel.id}" start="${slot.start}" stop="${slot.stop}">`,
      );
      lines.push(`    <title>${channel.titlePrefix}${slot.label}</title>`);
      lines.push('  </programme>');
    }
  }
  lines.push('</tv>');
  return `${lines.join('\n')}\n`;
}

/** 直播流媒体清单(无 ENDLIST 直播形态;分片 URI 相对清单地址) */
function buildLiveMediaPlaylist(): string {
  const lines: string[] = ['#EXTM3U', '#PLAYLIST:walkthrough-live'];
  for (let index = 0; index < 4; index += 1) {
    lines.push(`#EXTINF:4.0,`, `seg${index}.ts`);
  }
  return `${lines.join('\n')}\n`;
}

interface FixtureUpstream {
  /** 以本机局域网 IPv4 构造的绝对地址(创建期拒绝回环字面量,非回环私网 IP 放行) */
  url(path: string): string;
  close(): Promise<void>;
}

/**
 * 受控导入/流上游(本套件专用;形态对照 apps/server contract controlled-media-server):
 * - M3U/XMLTV/直播清单 = 命中路由即 200;「坏线路」全部路由 404(容灾致命错误源);
 * - 健康线路的媒体分片 = 挂起不响应(零 ffmpeg 依赖):VHS 停在分片等待,不产生解码
 *   致命错误 —— 播放面稳定停在 playing 相位,供 OSD 手动换线交互(见场景 4 注释);
 * - 绑定 0.0.0.0 随机端口;地址一律经 url() 以局域网 IPv4 组装。
 */
async function startFixtureUpstream(lanIpv4Address: string): Promise<FixtureUpstream> {
  const routes = new Map<string, { status: number; contentType: string; body: string }>();
  const hangPrefixes: readonly string[] = ['/streams/'];
  const notFoundPrefix = '/streams/failover-dead/';
  let origin = '';

  const pending = new Set<http.ServerResponse>();
  const server = http.createServer((request, response) => {
    request.on('error', () => {});
    response.on('error', () => {});
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (path.startsWith(notFoundPrefix)) {
      response.statusCode = 404;
      response.end('fixture: dead line');
      return;
    }
    const route = routes.get(path);
    if (route !== undefined) {
      response.statusCode = route.status;
      response.setHeader('content-type', route.contentType);
      response.end(route.body);
      return;
    }
    // 健康线路分片挂起:登记响应句柄,close 时统一销毁连接
    if (hangPrefixes.some((prefix) => path.startsWith(prefix)) && path.includes('/seg')) {
      pending.add(response);
      response.once('close', () => pending.delete(response));
      return;
    }
    response.statusCode = 404;
    response.end('fixture: no route');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '0.0.0.0', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('受控夹具上游未按预期绑定 TCP 地址');
  }
  const port = (address as AddressInfo).port;
  origin = `http://${lanIpv4Address}:${port}`;
  routes.set('/lists/walkthrough-telecom.m3u', {
    status: 200,
    contentType: 'audio/x-mpegurl',
    body: buildM3u(origin, SOURCE_A_ENTRIES),
  });
  routes.set('/lists/walkthrough-unicom.m3u', {
    status: 200,
    contentType: 'audio/x-mpegurl',
    body: buildM3u(origin, SOURCE_B_ENTRIES),
  });
  routes.set('/guides/epg-primary.xml', {
    status: 200,
    contentType: 'application/xml',
    body: buildXmltv('主源', PRIMARY_GUIDE_CHANNELS),
  });
  routes.set('/guides/epg-backup.xml', {
    status: 200,
    contentType: 'application/xml',
    body: buildXmltv('备源', BACKUP_GUIDE_CHANNELS),
  });
  for (const channel of ['cctv-a', 'cctv-b', 'zj-a', 'zj-b', 'hn-a', 'failover-live']) {
    routes.set(`/streams/${channel}/index.m3u8`, {
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: buildLiveMediaPlaylist(),
    });
  }
  return {
    url(path: string): string {
      return `http://${lanIpv4Address}:${port}${path}`;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const response of [...pending]) {
          response.socket?.destroy();
        }
        pending.clear();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/* ────────────────────────── 公共辅助 ────────────────────────── */

/** 本机非回环 IPv4(环境变量 E2E_LAN_UPSTREAM_IP 可覆盖;缺失时由测试显式失败) */
function resolveLanIpv4(): string {
  const override = process.env.E2E_LAN_UPSTREAM_IP;
  if (override !== undefined && override !== '') {
    return override;
  }
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return '';
}

/** 播放意图面:authorize/prepare 为非阻塞面板,playing/unavailable 为全屏面(live-flow 同款) */
function expectPlaybackFace(page: Page): Promise<void> {
  return expect(
    page.getByTestId('playback-preparing').or(page.getByTestId('playback-surface')),
  ).toBeVisible({ timeout: 30_000 });
}

interface ApiProfile {
  readonly id: string;
  readonly name: string;
  readonly pinProtected: boolean;
  readonly status: string;
}

/** API 登录 + 选主档案(真实链路;cookie 落在 page 所属 context;live-flow 同款) */
async function apiLoginAndSelectMain(page: Page): Promise<void> {
  const login = await page.request.post('/api/auth/login', {
    data: { username: OWNER.username, password: OWNER.password, deviceType: 'web', deviceName: 'e2e-016-t026' },
  });
  expect(login.status(), `夹具账号登录应成功(需 E2E_SEED_SCALE=1 种子库)`).toBe(200);
  const profiles = (await (await page.request.get('/api/profiles')).json()) as ApiProfile[];
  const main = profiles.find((profile) => profile.name === '主档案' && profile.status === 'active');
  expect(main, '夹具主档案应存在').toBeDefined();
  if (main?.pinProtected === true) {
    expect((await page.request.post(`/api/profiles/${main.id}/unlock`, { data: { pin: MAIN_PIN } })).status()).toBe(200);
  }
  expect((await page.request.post(`/api/profiles/${main?.id ?? ''}/select`, { data: {} })).status()).toBe(200);
}

/** 切换为儿童档案(独立解锁 + 选档;夹具儿童 PIN 246800) */
async function apiSelectChildProfile(page: Page): Promise<void> {
  const login = await page.request.post('/api/auth/login', {
    data: { username: OWNER.username, password: OWNER.password, deviceType: 'web', deviceName: 'e2e-016-t026-child' },
  });
  expect(login.status()).toBe(200);
  const profiles = (await (await page.request.get('/api/profiles')).json()) as ApiProfile[];
  const child = profiles.find((profile) => profile.name === CHILD_PROFILE_NAME && profile.status === 'active');
  expect(child, '夹具儿童档案应存在').toBeDefined();
  if (child?.pinProtected === true) {
    expect((await page.request.post(`/api/profiles/${child.id}/unlock`, { data: { pin: CHILD_PIN } })).status()).toBe(200);
  }
  expect((await page.request.post(`/api/profiles/${child?.id ?? ''}/select`, { data: {} })).status()).toBe(200);
}

interface ApiChannelRow {
  readonly media: { readonly id: string; readonly title: string; readonly type: string; readonly availability: string };
  readonly groupKey: string;
  readonly groupLabel: string;
}

interface ApiChannelPage {
  readonly items: readonly ApiChannelRow[];
  readonly total: number;
}

async function fetchChannels(page: Page, query: string): Promise<ApiChannelPage> {
  const response = await page.request.get(`/api/public/live/channels?section=all&page=1&pageSize=50&${query}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as ApiChannelPage;
}

interface ProgrammeProjection {
  readonly key: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly progress?: number;
}

interface NowPlayingEntry {
  readonly current: ProgrammeProjection | null;
  readonly next: ProgrammeProjection | null;
  readonly matchMode: 'manual' | 'precise' | 'cascade' | 'alias' | 'none';
  readonly epgSourceId: string | null;
}

interface NowPlayingPage {
  readonly now: string;
  readonly programmes: Readonly<Record<string, NowPlayingEntry>>;
}

/** now-playing 直查(016 api.md §1.1;走查测试的期望源) */
async function fetchNowPlaying(page: Page, mediaIds: readonly string[]): Promise<NowPlayingPage> {
  const response = await page.request.get(
    `/api/public/live/channels/now-playing?mediaIds=${encodeURIComponent(mediaIds.join(','))}`,
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as NowPlayingPage;
}

interface StreamLineDto {
  readonly lineId: string;
  readonly sourceId: string;
  readonly sourceTitle: string;
  readonly label: string;
  readonly priority: number;
  readonly isDefault: boolean;
  readonly isEnabled: boolean;
}

interface PlaybackDto {
  readonly id: string;
  readonly state: string;
  readonly generation: number;
  readonly lines?: readonly StreamLineDto[];
  readonly selectedLineId?: string | null;
}

/** API resolve(非浏览器客户端放行 SameOrigin;返回 201 投影) */
async function apiResolve(page: Page, mediaId: string, lineId?: string): Promise<PlaybackDto> {
  const response = await page.request.post('/api/playback/resolve', {
    data: { mediaId, ...(lineId !== undefined ? { lineId } : {}) },
  });
  expect(response.status(), `resolve 应被接受:${mediaId}`).toBe(201);
  return (await response.json()) as PlaybackDto;
}

/** 幂等停止会话(清场;失败不阻塞 —— 会话由保留策略自然回收) */
async function apiStopSession(page: Page, sessionId: string): Promise<void> {
  await page.request.post(`/api/playback/sessions/${encodeURIComponent(sessionId)}/stop`, { data: {} });
}

interface SourceDto {
  readonly id: string;
  readonly name: string;
  readonly version: number;
}

/** 创建来源(201;remoteUrl 走本机局域网 IPv4 —— 创建期字面类别校验放行非回环私网) */
async function createSource(page: Page, kind: 'iptv' | 'epg', name: string, remoteUrl: string): Promise<SourceDto> {
  const response = await page.request.post('/api/settings/sources', { data: { kind, name, remoteUrl } });
  expect(response.status(), `来源 ${name} 创建应成功:${JSON.stringify(await response.json().catch(() => null))}`).toBe(201);
  return (await response.json()) as SourceDto;
}

/**
 * 发起导入(refresh)并轮询至 succeeded(45s 预算;import-channel-groups 契约同款链路):
 * - 409 SOURCE_BUSY(同源活动任务,例如权重保存自动入队的级联刷新占用中)按指数退避重试
 *   —— 复用既有刷新执行器互斥语义,绝不放宽断言;
 * - failed 终态立即失败(如实暴露,不重试凑绿)。
 */
async function refreshSourceUntilSucceeded(page: Page, source: SourceDto): Promise<void> {
  let refreshId = '';
  const acceptDeadline = Date.now() + 30_000;
  while (refreshId === '') {
    const response = await page.request.post(`/api/settings/sources/${source.id}/refresh`, {
      data: { expectedVersion: source.version, operationKey: randomUUID() },
    });
    if (response.status() === 202) {
      refreshId = ((await response.json()) as { id: string }).id;
      break;
    }
    if (response.status() !== 409 || Date.now() > acceptDeadline) {
      throw new Error(`来源 ${source.name} 刷新发起失败(HTTP ${response.status()}):${JSON.stringify(await response.json().catch(() => null))}`);
    }
    await page.waitForTimeout(1_000);
  }
  await expect
    .poll(async () => {
      const poll = await page.request.get(`/api/settings/refreshes/${refreshId}`);
      if (poll.status() !== 200) {
        return 'pending';
      }
      return ((await poll.json()) as { status: string }).status;
    }, { timeout: 45_000, intervals: [500] })
    .toBe('succeeded');
}

/** resolve 请求/响应采集(OSD 与容灾链路的网络级证据) */
interface ResolveTrace {
  readonly requestLineIds: Array<string | null>;
  readonly responseBodies: PlaybackDto[];
  track(page: Page): void;
}

function trackResolve(page: Page): ResolveTrace {
  const trace: ResolveTrace = {
    requestLineIds: [],
    responseBodies: [],
    track(tracked: Page): void {
      tracked.on('request', (request) => {
        if (new URL(request.url()).pathname !== '/api/playback/resolve') {
          return;
        }
        let lineId: string | null = null;
        try {
          lineId = (JSON.parse(request.postData() ?? '{}') as { lineId?: string }).lineId ?? null;
        } catch {
          lineId = null;
        }
        trace.requestLineIds.push(lineId);
      });
      tracked.on('response', (response) => {
        if (new URL(response.url()).pathname !== '/api/playback/resolve' || response.status() !== 201) {
          return;
        }
        void response
          .json()
          .then((body: PlaybackDto) => {
            trace.responseBodies.push(body);
          })
          .catch(() => undefined);
      });
    },
  };
  trace.track(page);
  return trace;
}

/* ────────────────────────── 走查套件 ══════════════════════════════ */

test.describe.serial('016 T026 · 多源直播与多 EPG 走查(quickstart 场景 1→5)', () => {
  test.setTimeout(240_000);

  /** 跨用例共享的导入事实(串行套件;场景 1 落值) */
  const world: {
    lanIpv4: string;
    upstream: FixtureUpstream | null;
    iptvA: SourceDto | null;
    iptvB: SourceDto | null;
    epgPrimary: SourceDto | null;
    epgBackup: SourceDto | null;
    groupKey: string;
    cctv: ApiChannelRow | null;
    zhejiang: ApiChannelRow | null;
    hunan: ApiChannelRow | null;
    failover: ApiChannelRow | null;
  } = {
    lanIpv4: '',
    upstream: null,
    iptvA: null,
    iptvB: null,
    epgPrimary: null,
    epgBackup: null,
    groupKey: '',
    cctv: null,
    zhejiang: null,
    hunan: null,
    failover: null,
  };

  test.beforeAll(async () => {
    world.lanIpv4 = resolveLanIpv4();
    world.upstream = await startFixtureUpstream(world.lanIpv4);
  });

  test.afterAll(async () => {
    await world.upstream?.close();
    world.upstream = null;
  });

  test('场景 1 · 多源导入聚合:两个同名频道 M3U 源归并为单频道多线路(quickstart US3 验收 1;FR-005)', async ({ page }) => {
    expect(
      world.lanIpv4,
      '缺少本机非回环 IPv4:导入/流上游地址与 LAN_ALLOWED_TARGETS 均需它(创建期拒绝回环字面量)',
    ).not.toBe('');
    const upstream = world.upstream;
    expect(upstream, '受控上游应在 beforeAll 就绪').not.toBeNull();
    await apiLoginAndSelectMain(page);

    // ── 导入两个含同名频道的 M3U 源(真实 refresh 链路:解析 → 暂存 → 发布事务)──
    world.iptvA = await createSource(page, 'iptv', IPTV_SOURCE_A, upstream!.url('/lists/walkthrough-telecom.m3u'));
    world.iptvB = await createSource(page, 'iptv', IPTV_SOURCE_B, upstream!.url('/lists/walkthrough-unicom.m3u'));
    await refreshSourceUntilSucceeded(page, world.iptvA);
    await refreshSourceUntilSucceeded(page, world.iptvB);

    // ── 聚合事实(服务端):同名归一化键的频道各只存在一个 media_item(016 前语义为多行)──
    for (const [query, holder] of [
      ['CCTV', 'cctv'],
      ['浙江卫视', 'zhejiang'],
      ['湖南卫视', 'hunan'],
      ['走查容灾台', 'failover'],
    ] as const) {
      const result = await fetchChannels(page, `q=${encodeURIComponent(query)}`);
      expect(result.total, `同名聚合后「${query}」应恰好一个逻辑频道`).toBe(1);
      expect(result.items[0]?.media.availability, `「${query}」频道应可用(present 条目跨来源)`).toBe('available');
      world[holder] = result.items[0] ?? null;
    }
    world.groupKey = world.cctv?.groupKey ?? '';

    // ── 多线路投影(016 api.md §2.1 走现行 POST /playback/resolve):lines/selectedLineId ──
    const cctv = world.cctv;
    expect(cctv, 'CCTV-1 聚合频道应已定位').not.toBeNull();
    const baseline = await apiResolve(page, cctv!.media.id);
    const lines = baseline.lines ?? [];
    expect(lines, '聚合频道应下发两条物理线路').toHaveLength(2);
    expect(lines[0]?.sourceTitle, '线路 1 应来自源 A(clarity 罚分 0 → priority 100)').toBe(IPTV_SOURCE_A);
    expect(lines[1]?.sourceTitle, '线路 2 应来自源 B([4K] 罚分 2 → priority 102)').toBe(IPTV_SOURCE_B);
    expect(lines[0]?.label).toContain('线路 1');
    expect(lines[1]?.label).toContain('线路 2');
    expect(lines[0]?.isDefault, '顺位首条为默认线路').toBe(true);
    expect(lines[1]?.isDefault).toBe(false);
    expect(baseline.selectedLineId, '缺省请求选中顺位首条').toBe(lines[0]?.lineId);
    const specified = await apiResolve(page, cctv!.media.id, lines[1]?.lineId);
    expect(specified.selectedLineId, '携 lineId 请求应回传选中线路(016 api.md §2.1)').toBe(lines[1]?.lineId);
    expect((specified.lines ?? []).map((line) => line.lineId)).toEqual(lines.map((line) => line.lineId));
    await apiStopSession(page, baseline.id);
    await apiStopSession(page, specified.id);

    // ── 频道列表 UI:网格仅出现单个频道卡片(无重复卡片)──
    await page.goto(`/live/channels?group=${world.groupKey}`);
    const grid = page.getByRole('region', { name: `${GROUP_LABEL} · 频道` });
    await expect(grid.locator('article').first()).toBeVisible({ timeout: 30_000 });
    const cctvCard = grid.getByRole('article', { name: `频道 ${cctv!.media.title}` });
    await expect(cctvCard, '同名聚合后 CCTV-1 应只有一个卡片(016 前语义会出现两个)').toHaveCount(1);
    await expect(grid.getByRole('article'), '该分组恰为四个聚合逻辑频道(2+3 条物理流归并)').toHaveCount(4);
  });

  test('场景 2 · 当前节目与进度:卡片标题/进度 aria 值 + 观看页下一档 + now-playing 直查(quickstart US1;FR-006/008)', async ({ page }) => {
    await apiLoginAndSelectMain(page);
    const upstream = world.upstream;
    expect(upstream).not.toBeNull();
    const cctv = world.cctv;
    expect(cctv).not.toBeNull();

    // ── 前置:导入两个 EPG 源(主源/备源)并固定权重(主源 10 < 备源 20)。
    //    同时为场景 3/5 备好级联链与 UI 权重治理的数据面;PUT 后级联刷新自动入队,
    //    后续显式 refresh 由 refreshSourceUntilSucceeded 的 409 重试兜底。──
    world.epgPrimary = await createSource(page, 'epg', EPG_SOURCE_PRIMARY, upstream!.url('/guides/epg-primary.xml'));
    world.epgBackup = await createSource(page, 'epg', EPG_SOURCE_BACKUP, upstream!.url('/guides/epg-backup.xml'));
    await refreshSourceUntilSucceeded(page, world.epgPrimary);
    await refreshSourceUntilSucceeded(page, world.epgBackup);
    const saved = await page.request.put('/api/settings/sources/epg-priorities', {
      data: {
        priorities: [
          { sourceId: world.epgPrimary.id, priority: 10 },
          { sourceId: world.epgBackup.id, priority: 20 },
        ],
      },
    });
    expect(saved.status(), JSON.stringify(await saved.json().catch(() => null))).toBe(200);
    expect(((await saved.json()) as { updatedCount: number }).updatedCount).toBe(2);

    // ── now-playing 直查(016 api.md §1.1):current/next/progress/matchMode ──
    const nowPlaying = await fetchNowPlaying(page, [cctv!.media.id]);
    const serverNowMs = Date.parse(nowPlaying.now);
    const realNowMs = Date.now();
    expect(
      Number.isFinite(serverNowMs) && Math.abs(serverNowMs - realNowMs) <= 10 * 60_000,
      `服务端 now 应为真实时钟(±10 分钟,EPG 发布窗口同基准):now=${nowPlaying.now}`,
    ).toBe(true);
    const projection = nowPlaying.programmes[cctv!.media.id];
    expect(projection, '聚合频道应有排期投影').toBeDefined();
    expect(projection?.current, 'CCTV-1 应命中主源排期(cascade L3 首源)').not.toBeNull();
    expect(projection?.next).not.toBeNull();
    expect(projection?.matchMode).toBe('cascade');
    expect(projection?.epgSourceId, 'L3 优先级升序首个命中源 = 主源').toBe(world.epgPrimary!.id);
    const currentProgress = projection?.current?.progress ?? -1;
    expect(currentProgress, 'progress 由服务端按 now 计算(两位小数,0~1 开区间)').toBeGreaterThan(0);
    expect(currentProgress).toBeLessThan(1);
    const currentStartMs = Date.parse(projection?.current?.start ?? '');
    const currentEndMs = Date.parse(projection?.current?.end ?? '');
    expect(serverNowMs).toBeGreaterThanOrEqual(currentStartMs);
    expect(serverNowMs).toBeLessThan(currentEndMs);
    const currentTitle = projection?.current?.title ?? '';
    const nextTitle = projection?.next?.title ?? '';

    // ── 频道卡片:当前节目标题 + HeroUI ProgressBar aria 值(016 T010;US1 验收 1)──
    await page.goto(`/live/channels?group=${world.groupKey}`);
    const grid = page.getByRole('region', { name: `${GROUP_LABEL} · 频道` });
    const cctvCard = grid.getByRole('article', { name: `频道 ${cctv!.media.title}` });
    await expect(cctvCard).toBeVisible({ timeout: 30_000 });
    await expect(cctvCard, '卡片正文应呈现当前节目标题').toContainText(currentTitle);
    const progressBar = cctvCard.getByRole('progressbar', { name: '节目播放进度' });
    await expect(progressBar).toBeVisible();
    let ariaText: string | null = null;
    await expect
      .poll(async () => {
        ariaText = await progressBar.getAttribute('aria-valuenow');
        return ariaText;
      }, { timeout: 10_000 })
      .toBeTruthy();
    const ariaValue = Number(ariaText);
    expect(
      Math.abs(ariaValue - Math.round(currentProgress * 100)),
      '进度条 aria 值应与 now-playing progress 同源(小时档内 ≤3% 容差)',
    ).toBeLessThanOrEqual(3);

    // ── 一体化观看页:伴随信息区当前节目 + 下一档预告(016 T011;US1 验收 1)──
    await page.goto(`/live/watch/${cctv!.media.id}`);
    await expect(page.getByTestId('live-watch-page')).toBeVisible({ timeout: 30_000 });
    const meta = page.getByTestId('watch-meta-panel');
    await expect(meta).toBeVisible();
    await expect(meta.getByRole('region', { name: '当前节目' })).toContainText(currentTitle, { timeout: 15_000 });
    await expect(meta.getByRole('region', { name: '即将播放 (Next)' })).toContainText(nextTitle, { timeout: 15_000 });
  });

  test('场景 3 · 多 EPG 级联补位 + 手动绑定在全量刷新后保持(quickstart US2 验收 1/3;FR-003/FR-004)', async ({ page }) => {
    await apiLoginAndSelectMain(page);
    const zhejiang = world.zhejiang;
    const hunan = world.hunan;
    expect(zhejiang).not.toBeNull();
    expect(hunan).not.toBeNull();
    expect(world.epgPrimary).not.toBeNull();
    expect(world.epgBackup).not.toBeNull();

    // ── 级联回退:主源无「浙江卫视」排期 → 备源补位(matchMode=cascade,epgSourceId=备源)──
    const cascade = (await fetchNowPlaying(page, [zhejiang!.media.id])).programmes[zhejiang!.media.id];
    expect(cascade?.current, '浙江卫视应呈现节目单(级联命中,未误降级 none)').not.toBeNull();
    expect(cascade?.matchMode, '接口级级联标记 = cascade(quickstart 场景 2 期望)').toBe('cascade');
    expect(cascade?.epgSourceId, '排期来自备源(主源缺失 → priority ASC 补位)').toBe(world.epgBackup!.id);
    const zhejiangTitle = cascade?.current?.title ?? '';

    // ── 前台呈现:浙江卫视卡片显示备源排期(非「暂无节目单」)──
    await page.goto(`/live/channels?group=${world.groupKey}`);
    const grid = page.getByRole('region', { name: `${GROUP_LABEL} · 频道` });
    const zhejiangCard = grid.getByRole('article', { name: /^频道 浙江卫视/ });
    await expect(zhejiangCard).toBeVisible({ timeout: 30_000 });
    await expect(zhejiangCard).toContainText(zhejiangTitle);

    // ── 手动绑定(ADR-0008):湖南卫视 → 主源 hntv-main(候选面取 expectedEpgGeneration)──
    const bindingQuery = await page.request.post(
      `/api/settings/catalog/media/${hunan!.media.id}/epg-binding/query`,
      { data: {} },
    );
    expect(bindingQuery.status()).toBe(200);
    const bindingBefore = (await bindingQuery.json()) as {
      mode: string;
      version: number;
      epgSourceId: string | null;
      xmltvChannelId: string | null;
    };
    expect(bindingBefore.mode, '绑定前为 auto(未锁定)').toBe('auto');
    const candidatesQuery = await page.request.post(
      `/api/settings/catalog/media/${hunan!.media.id}/epg-candidates/query`,
      { data: { epgSourceId: world.epgPrimary!.id, q: 'hntv-main', page: 1, pageSize: 20 } },
    );
    expect(candidatesQuery.status()).toBe(200);
    const candidates = (await candidatesQuery.json()) as {
      items: Array<{ xmltvChannelId: string }>;
      epgGeneration: number;
    };
    const target = candidates.items.find((candidate) => candidate.xmltvChannelId === 'hntv-main');
    expect(target, '主源应提供 hntv-main 候选').toBeDefined();
    const manualSave = await page.request.put(`/api/settings/catalog/media/${hunan!.media.id}/epg-binding`, {
      data: {
        expectedVersion: bindingBefore.version,
        mode: 'manual',
        epgSourceId: world.epgPrimary!.id,
        xmltvChannelId: 'hntv-main',
        expectedEpgGeneration: candidates.epgGeneration,
      },
    });
    expect(manualSave.status(), `手动绑定应成功:${JSON.stringify(await manualSave.json().catch(() => null))}`).toBe(200);
    const manualSaved = (await manualSave.json()) as { mode: string; status: string };
    expect(manualSaved.mode).toBe('manual');
    expect(manualSaved.status).toBe('valid');

    // ── 全量重新同步(quickstart 场景 3 步骤:全部 EPG 与 IPTV 源各触发一轮导入)──
    for (const source of [world.iptvA, world.iptvB, world.epgPrimary, world.epgBackup]) {
      expect(source).not.toBeNull();
      await refreshSourceUntilSucceeded(page, source!);
    }

    // ── 绑定保持:manual 锁不被自动算法覆盖(FR-004;SC-005 同语义)──
    const bindingAfter = (await (
      await page.request.post(`/api/settings/catalog/media/${hunan!.media.id}/epg-binding/query`, { data: {} })
    ).json()) as { mode: string; status: string; epgSourceId: string | null; xmltvChannelId: string | null };
    expect(bindingAfter.mode, '全量刷新后绑定仍为 manual').toBe('manual');
    expect(bindingAfter.status).toBe('valid');
    expect(bindingAfter.epgSourceId).toBe(world.epgPrimary!.id);
    expect(bindingAfter.xmltvChannelId).toBe('hntv-main');

    // ── 排期严格为手动指定源:matchMode=manual + 供给源恒为主源(不回退/不覆盖)──
    const manual = (await fetchNowPlaying(page, [hunan!.media.id])).programmes[hunan!.media.id];
    expect(manual?.matchMode, '手动绑定频道 matchMode=manual(L1 终态)').toBe('manual');
    expect(manual?.epgSourceId).toBe(world.epgPrimary!.id);
    expect(manual?.current, '手动绑定档应有节目').not.toBeNull();
    const manualTitle = manual?.current?.title ?? '';
    expect(manualTitle).toContain('主源绑定档');

    // ── 前台:湖南卫视卡片排期严格为手动指定节目单(重新加载网格:前段导航发生在
    //    绑定/全量刷新之前,瓦片数据不倒灌,30s 周期刷新不承诺即时性)──
    await page.goto(`/live/channels?group=${world.groupKey}`);
    const gridAfterResync = page.getByRole('region', { name: `${GROUP_LABEL} · 频道` });
    const hunanCard = gridAfterResync.getByRole('article', { name: /^频道 湖南卫视/ });
    await expect(hunanCard).toBeVisible({ timeout: 30_000 });
    await expect(hunanCard).toContainText(manualTitle, { timeout: 15_000 });
  });

  test('场景 4 · 多线路容灾自动切线 + Toast + OSD 手动换线(quickstart US3 验收 2/3;FR-011/FR-012)', async ({ page }) => {
    await apiLoginAndSelectMain(page);
    const failover = world.failover;
    expect(failover).not.toBeNull();
    const trace = trackResolve(page);

    // ── 先经 API 获知线路顺位与标识(线路 1 = 坏流 404,线路 2 = 健康挂起流;clarity 罚分确定性)──
    const learn = await apiResolve(page, failover!.media.id);
    const lines = learn.lines ?? [];
    expect(lines, '容灾台应有两条线路').toHaveLength(2);
    const deadLine = lines.find((line) => line.sourceTitle === IPTV_SOURCE_A);
    const healthyLine = lines.find((line) => line.sourceTitle === IPTV_SOURCE_B);
    expect(deadLine, '坏流线路应定位(源 A 404 上游)').toBeDefined();
    expect(healthyLine, '健康线路应定位(源 B 挂起流)').toBeDefined();
    await apiStopSession(page, learn.id);

    // ── 进入观看页自动起播:默认选中线路 1(坏流)→ 播放器致命错误 ──
    await page.goto(`/live/watch/${failover!.media.id}`);
    await expectPlaybackFace(page);
    await expect(page.getByTestId('playback-surface')).toBeVisible({ timeout: 30_000 });

    // ── 自动容灾(016 T020):致命错误 → 以 {…target, lineId} 发起新 resolve(新 session 契约)──
    await expect
      .poll(() => trace.requestLineIds, { timeout: 30_000 })
      .toContain(healthyLine!.lineId);
    expect(
      trace.requestLineIds[0] === null || trace.requestLineIds[0] === deadLine!.lineId,
      `起播首请求应为缺省优选或线路 1(坏流),实际:${String(trace.requestLineIds[0])}`,
    ).toBe(true);
    expect(
      trace.requestLineIds.filter((lineId) => lineId === healthyLine!.lineId).length,
      '容灾续接应至少发出一次携 lineId=健康线路 的新 resolve',
    ).toBeGreaterThanOrEqual(1);

    // ── Toast 轻量提示(单次/去重语义由编排层保证;文案锚 016 T020 实现)──
    await expect(page.getByTestId('app-toast-region')).toContainText(
      `当前线路异常,已自动切换至「${healthyLine!.label}」`,
      { timeout: 15_000 },
    );

    // ── 播放面 header OSD:线路切换 Dropdown 出现(lines ≥ 2 且 playing 相位)。
    //    健康线路的分片为挂起响应 —— VHS 停在分片等待、无解码致命错误,播放面稳定
    //    停在 playing 相位,供手动换线交互(夹具零 ffmpeg/真实媒体依赖)。──
    const switcher = page.getByTestId('playback-surface').getByRole('button', { name: '切换播放线路' });
    await expect(switcher, '播放面 header 应出现「切换播放线路」(016 T021)').toBeVisible({ timeout: 30_000 });
    await switcher.click();
    // RAC MenuTrigger 打开的 menu 可及名继承触发钮(aria-label=「切换播放线路」);
    // 菜单项可及名 = 线路 label + 来源次行(getByRole name 缺省子串匹配)
    const menu = page.getByRole('menu', { name: '切换播放线路' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: healthyLine!.label })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: deadLine!.label })).toBeVisible();

    // ── 手动选择第二线路(坏流线路 1):resolve 携 lineId + 响应 selectedLineId 变化 ──
    await menu.getByRole('menuitem', { name: deadLine!.label }).click();
    await expect
      .poll(() => trace.requestLineIds, { timeout: 20_000 })
      .toContain(deadLine!.lineId);
    await expect
      .poll(() => trace.responseBodies.some((body) => body.selectedLineId === deadLine!.lineId), {
        timeout: 20_000,
      })
      .toBe(true);
    // 容灾续接(R4):手动切上坏流后致命错误再次自动切回健康线路(编排级换线编排闭环)
    await expect(page.getByTestId('playback-surface')).toBeVisible({ timeout: 30_000 });
  });

  test('场景 5 · 权重治理 UI 保存即生效 + 儿童档案未授权多线路频道被拒(quickstart US4 验收 1/3;FR-013/FR-014)', async ({ page }) => {
    await apiLoginAndSelectMain(page);
    const cctv = world.cctv;
    const hunan = world.hunan;
    expect(cctv).not.toBeNull();
    expect(hunan).not.toBeNull();
    expect(world.epgPrimary).not.toBeNull();
    expect(world.epgBackup).not.toBeNull();

    // ── 权重基线(保存前):主源优先,CCTV-1 由主源供给 ──
    const before = (await fetchNowPlaying(page, [cctv!.media.id])).programmes[cctv!.media.id];
    expect(before?.epgSourceId).toBe(world.epgPrimary!.id);
    const beforeTitle = before?.current?.title ?? '';

    // ── 主管理员进入设置(ADR-0017 免套娃:isMain 档案即设置主体,前端免独立 PIN 门,
    //    服务端 SettingsGuard 逐请求核验 isMain;旧「输入设置 PIN」门已在 017 演进中
    //    被身份即门禁取代)→ IPTV 管理 · 节目单标签(018:来源×优先级合并看板)──
    await page.goto('/settings/iptv?tab=epg');
    const prioritiesList = page.getByTestId('epg-priorities-list');
    await expect(prioritiesList).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByTestId(`epg-priority-row-${world.epgPrimary!.id}`),
      '基线序:主源在前(priority ASC)',
    ).toBeVisible();
    const rowsBefore = await prioritiesList
      .locator('li')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid') ?? ''));
    expect(rowsBefore[0]).toBe(`epg-priority-row-${world.epgPrimary!.id}`);
    expect(rowsBefore[1]).toBe(`epg-priority-row-${world.epgBackup!.id}`);

    // ── UI 调整:备源上移 → 未保存标记 → 保存排序(草稿序重排 1..N 提交)──
    await page.getByRole('button', { name: `上移 ${EPG_SOURCE_BACKUP}` }).click();
    await expect(page.getByTestId('epg-priorities-dirty')).toBeVisible();
    await page.getByTestId('epg-priorities-save').click();
    // 保存计数覆盖列表全部行(夹具自带 EPG 源同列表,数量随数据栈浮动 → 形态断言)
    await expect(page.getByTestId('epg-priorities-status')).toContainText(/已保存 \d+ 个 EPG 来源的优先级/, {
      timeout: 15_000,
    });
    const rowsAfter = await prioritiesList
      .locator('li')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid') ?? ''));
    expect(rowsAfter[0], '保存后列表应反映新序(备源在前)').toBe(`epg-priority-row-${world.epgBackup!.id}`);
    expect(rowsAfter[1]).toBe(`epg-priority-row-${world.epgPrimary!.id}`);
    const prioritiesApi = (await (
      await page.request.get('/api/settings/sources/epg-priorities')
    ).json()) as { sources: Array<{ sourceId: string; priority: number }> };
    expect(prioritiesApi.sources[0]?.sourceId).toBe(world.epgBackup!.id);
    expect(prioritiesApi.sources[0]?.priority).toBeLessThan(prioritiesApi.sources[1]?.priority ?? 0);

    // ── 级联回退按新权重生效(US4 验收 1):CCTV-1 供给源翻转为备源(matchMode 仍 cascade)──
    const flipped = (await fetchNowPlaying(page, [cctv!.media.id])).programmes[cctv!.media.id];
    expect(flipped?.matchMode).toBe('cascade');
    expect(flipped?.epgSourceId, '新权重下 cascade 首个命中源 = 备源').toBe(world.epgBackup!.id);
    expect(flipped?.current?.title ?? '', '排期标题随供给源翻转(备源档)').not.toBe(beforeTitle);

    // ── 手动绑定不被权重级联刷新覆盖(ADR-0008 与权重治理正交)──
    const binding = (await (
      await page.request.post(`/api/settings/catalog/media/${hunan!.media.id}/epg-binding/query`, { data: {} })
    ).json()) as { mode: string; status: string };
    expect(binding.mode).toBe('manual');
    expect(binding.status).toBe('valid');

    // ── 儿童档案:白名单外多线路频道坚决拒绝(T037 裁决:404 同形 + 零签发)──
    await apiSelectChildProfile(page);
    const denied = await page.request.post('/api/playback/resolve', { data: { mediaId: cctv!.media.id } });
    expect(denied.status(), '儿童档案 resolve 未授权频道应 404').toBe(404);
    const deniedBody = (await denied.json()) as Record<string, unknown>;
    expect(deniedBody['code'], '拒绝码与契约一致(MEDIA_NOT_FOUND 同形)').toBe('MEDIA_NOT_FOUND');
    expect(JSON.stringify(deniedBody), '拒绝面零 ticket/会话句柄').not.toContain('ticket');
    const missing = await page.request.post('/api/playback/resolve', { data: { mediaId: randomUUID() } });
    expect(missing.status()).toBe(404);
    const missingBody = (await missing.json()) as Record<string, unknown>;
    expect(missingBody['code']).toBe('MEDIA_NOT_FOUND');
    expect(deniedBody, '白名单外与缺失媒体逐字段同形(不泄露存在性;T037 裁决 ①)').toEqual(missingBody);

    // ── 前台:儿童档案直达播放页 → 家长控制阻断面,零媒体流请求 ──
    const streamRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/playback/stream')) {
        streamRequests.push(request.url());
      }
    });
    await page.goto(`/live/watch/${cctv!.media.id}`);
    await expect(page.getByTestId('live-watch-page')).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByTestId('playback-surface').getByRole('alert'),
      '播放面应呈现阻断提示(家长控制)',
    ).toBeVisible({ timeout: 30_000 });
    expect(streamRequests, '拒绝路径零媒体流请求(零 ticket 消费)').toEqual([]);
  });
});
