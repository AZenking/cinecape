import { spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, test, type APIRequestContext, type Locator, type Page, type Request, type Response } from '@playwright/test';

/**
 * T082(010 US5 e2e 证据任务;quickstart Q9/Q7 受控真实链路):
 *
 * 运行方式(独立 DATA_DIR 由 playwright.config.ts 注入;双服务由 webServer 启动):
 *   cd apps/web && E2E_SEED_SCALE=1 LAN_ALLOWED_TARGETS=127.0.0.1 \
 *     pnpm exec playwright test test/e2e/online-vod-global.spec.ts
 *
 * - E2E_SEED_SCALE=1:种子 T012 规模夹具(凭据 fixtureadmin/password-123,
 *   主档案「主档案」PIN 135790、儿童档案「儿童档案」PIN 246800)。
 * - LAN_ALLOWED_TARGETS=<本机 LAN IPv4>(与 spec 内 primaryLanIpv4() 同一地址):
 *   许可服务端(SafeUpstream/hls-proxy/导入器)读取本 spec 进程内启动的受控上游。
 *   环回 IP 字面量被创建期校验拒绝(SSRF 设计)、`localhost` 无法经 c-ares 解析
 *   (SOURCE_DNS_INVALID,实测),故受控上游绑 LAN IPv4——部署预期的私网目标形态。
 *   「受控上游 + 本地 app 即真实链路」(quickstart Q9/Q7 可控环境替代;
 *   弱网 = Playwright route 延迟)。
 *
 * 真实链路面(与既有 e2e 的「夹具源不可达→prepare 失败」深度不同):
 * - spec 进程生成真实 H.264 MPEG-TS 分片(ffmpeg testsrc2)+ 动态滚动直播清单
 *   (无 ENDLIST),经设置 API 注册 IPTV 源→导入→确认,直播页点播该频道;
 * - resolve→probe(hls_proxy 候选即时成功)→ready→换票→PlayerView 挂载,
 *   video.js VHS 经网关真实消费 HLS → 真实 playing → 进度泵 started/periodic/
 *   observations/heartbeat 全链在真实浏览器上运行(dev 模式 React StrictMode 开启,
 *   双挂载行为被自然覆盖)。
 *
 * 覆盖(quickstart Q9/Q7 可执行部分;其余未具备环境部分在 evidence 中如实分列):
 * 1. Q9:20 次路由导航不中断全局播放/心跳/进度;设置入口可用且焦点正确;
 *    导航期间零 /stop(generation 变化不卸载 stop 的路由面等价断言)。
 * 2. Q9/T079:弱网(route 延迟 5s > 有界窗口 1s)退出/切档,/stop 在 ≤1s 内发出、
 *   恰一次、带 finalProgress;退出后零进度补报(旧身份零补报)。
 * 3. 重复关闭:快速双击退出仅一次 /stop;StrictMode 双挂载下 started 恰一次。
 * 4. Q7/T081:浏览器退出 watchdog——无客户端 ready 会话(created_at+60s 期限)与
 *    真实播放中会话(45s 失联)浏览器直接退出后均被回收为终态;终态复活 0;
 *    全部已建会话终态后无主会话 0。
 */

/* ------------------------------------------------------------------ */
/* 受控上游夹具(真实 HLS 直播流)                                          */
/* ------------------------------------------------------------------ */

/** 分片时长秒(与清单 EXTINF 一致) */
const SEGMENT_SECONDS = 2;
/** 预生成分片数(480s 滚动池,按绝对序号取模循环) */
const SEGMENT_COUNT = 240;
/** 直播清单窗口:过去 24 个 + 未来 6 个分片 */
const LIVE_WINDOW_BACK = 24;
const LIVE_WINDOW_FORWARD = 6;

/** 频道标题(spec 内唯一,用于目录查询与播放按钮定位) */
const CHANNEL_MAIN = 'e2e 全局播放频道';
const CHANNEL_ALT = 'e2e 备用频道';

/**
 * 受控上游绑定地址:本机非内部 IPv4(LAN 形态)。
 * 依据:①创建期目标校验按设计拒绝 IP 字面量环回(SSRF 面,T083);
 * ②运行期 SafeUpstream 以 node:dns.resolve4/6 解析(c-ares,不查 /etc/hosts),
 *   `localhost` 会 SOURCE_DNS_INVALID(本 spec 实测);私网 LAN 地址正是部署预期目标。
 * 运行须注入 LAN_ALLOWED_TARGETS=<同一地址>(见文件头运行命令)。
 */
function primaryLanIpv4(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  throw new Error('未找到非内部 IPv4 地址:受控上游需要 LAN 地址形态(创建期拒绝环回字面量)');
}

interface FixtureUpstream {
  readonly port: number;
  readonly baseUrl: string;
  close(): Promise<void>;
}

/**
 * 启动受控上游:ffmpeg 生成真实 H.264 TS 分片池 + 动态滚动直播清单。
 * 返回前等待首窗分片可用(绝对序号 0..N 已生成)。
 */
async function startFixtureUpstream(): Promise<FixtureUpstream> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redroad-e2e-vod-global-'));
  const segDir = path.join(tmpDir, 'segs');
  fs.mkdirSync(segDir);
  // 真实可解码视频(testsrc2 动态图案;H.264,yuv420p,2s 关键帧对齐)
  const durationSeconds = SEGMENT_COUNT * SEGMENT_SECONDS;
  const probe = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-f', 'lavfi',
      '-i', `testsrc2=duration=${durationSeconds}:size=160x96:rate=5`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p',
      '-force_key_frames', 'expr:gte(t,n_forced*2)',
      '-an',
      '-f', 'segment',
      '-segment_time', String(SEGMENT_SECONDS),
      '-reset_timestamps', '1',
      path.join(segDir, 'seg-%04d.ts'),
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 },
  );
  if (probe.error !== undefined || probe.status !== 0) {
    const detail = probe.stderr !== null ? probe.stderr.toString().slice(-400) : String(probe.error);
    throw new Error(`受控上游分片生成失败(需要 PATH 内 ffmpeg):${detail}`);
  }
  const segmentFiles = fs.readdirSync(segDir).sort();
  expect(segmentFiles.length).toBeGreaterThanOrEqual(SEGMENT_COUNT);

  const startedAtMs = Date.now();
  const server = http.createServer((req, res) => {
    res.on('error', () => {});
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // 动态滚动直播清单(无 ENDLIST):按墙钟推进绝对序号,窗口 [now-24, now+6]
    const playlist = /^\/hls\/(a|b)\/index\.m3u8$/.exec(url.pathname);
    if (playlist !== null) {
      const elapsed = Math.floor((Date.now() - startedAtMs) / (SEGMENT_SECONDS * 1000));
      const absSeq = Math.max(elapsed - LIVE_WINDOW_BACK, 0);
      const lines: string[] = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS}`,
        `#EXT-X-MEDIA-SEQUENCE:${absSeq}`,
      ];
      for (let index = 0; index < LIVE_WINDOW_BACK + LIVE_WINDOW_FORWARD; index += 1) {
        const abs = absSeq + index;
        if (abs > elapsed + LIVE_WINDOW_FORWARD) {
          break;
        }
        const file = segmentFiles[abs % segmentFiles.length] as string;
        lines.push('#EXTINF:2.0,', `seg/${file}`);
      }
      res.writeHead(200, {
        'content-type': 'application/vnd.apple.mpegurl',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end(`${lines.join('\n')}\n`);
      return;
    }
    const segment = /^\/hls\/(?:a|b)\/seg\/(seg-\d+\.ts)$/.exec(url.pathname);
    if (segment !== null) {
      const file = path.join(segDir, segment[1] as string);
      if (!fs.existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'video/mp2t',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      fs.createReadStream(file).pipe(res);
      return;
    }
    if (url.pathname === '/live.m3u') {
      // 导入用扩展 M3U(绝对入口地址;无 EPG → 自成分组,可播形态)
      const entries = [CHANNEL_MAIN, CHANNEL_ALT]
        .map((title, index) => `#EXTINF:-1 group-title="e2e受控",${title}\nhttp://${primaryLanIpv4()}:${(server.address() as AddressInfo).port}/hls/${index === 0 ? 'a' : 'b'}/index.m3u8`)
        .join('\n');
      res.writeHead(200, { 'content-type': 'audio/x-mpegurl' });
      res.end(`#EXTM3U\n${entries}\n`);
      return;
    }
    res.writeHead(404);
    res.end('fixture upstream: no route');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // 绑定本机 LAN IPv4:创建期拒绝环回字面量;运行期 SafeUpstream 按该地址精确许可
    server.listen(0, primaryLanIpv4(), () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const lanHost = primaryLanIpv4();
  return {
    port: address.port,
    baseUrl: `http://${lanHost}:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/* ------------------------------------------------------------------ */
/* 请求跟踪与登录辅助                                                     */
/* ------------------------------------------------------------------ */

interface PlaybackRequestRecord {
  readonly method: string;
  readonly path: string;
  readonly atMs: number;
  readonly body: string | null;
}

interface PlaybackTracking {
  readonly requests: PlaybackRequestRecord[];
  readonly resolvedSessionIds: string[];
  /** /stop 请求发出时刻(ms) */
  stopRequestTimes(): number[];
  /** /progress 请求发出时刻(ms) */
  progressRequestTimes(): number[];
  /** reason=started 的进度样本数(按请求体判定;发送即计数,不依赖 ACK) */
  startedSampleCount(): number;
  /** 收到非空接受游标的进度响应数(started ACK 的观测依据) */
  progressAckedCount(): number;
}

/** 独立计时等待(不依赖 page;context 关闭后仍可用) */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function attachTracking(page: Page): PlaybackTracking {
  const requests: PlaybackRequestRecord[] = [];
  const resolvedSessionIds: string[] = [];
  let progressAcked = 0;
  page.on('request', (request: Request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/playback/')) {
      return;
    }
    let body: string | null = null;
    try {
      body = request.postData() ?? null;
    } catch {
      body = null;
    }
    requests.push({ method: request.method(), path: url.pathname, atMs: Date.now(), body });
  });
  page.on('response', (response: Response) => {
    const url = new URL(response.url());
    if (url.pathname === '/api/playback/resolve' && response.status() === 201) {
      void response
        .json()
        .then((body: { id?: string }) => {
          if (typeof body.id === 'string') {
            resolvedSessionIds.push(body.id);
          }
        })
        .catch(() => undefined);
      return;
    }
    if (url.pathname.endsWith('/progress') && response.status() === 200) {
      void response
        .text()
        .then((text) => {
          // started ACK 观测(api.md §1 ProgressReply 双形态):在线 vod 会话为 8 键
          // (sessionAccepted+acceptedSampleSeq…);直播/NAS 会话按 T046/T092 投影回
          // 既有 3 键(applied/reason/historyRevision,永无 acceptedSampleSeq)。
          // 接受语义取两形态并集:8 键游标在场,或 3 键 reason∈accepted|duplicate|
          // superseded(duplicate=原样本已被接受后的重放应答)。
          if (text.includes('acceptedSampleSeq') || /"reason"\s*:\s*"(accepted|duplicate|superseded)"/.test(text)) {
            progressAcked += 1;
          }
        })
        .catch(() => undefined);
    }
  });
  return {
    requests,
    resolvedSessionIds,
    stopRequestTimes: () =>
      requests.filter((record) => record.path.endsWith('/stop')).map((record) => record.atMs),
    progressRequestTimes: () =>
      requests.filter((record) => record.path.endsWith('/progress')).map((record) => record.atMs),
    startedSampleCount: () =>
      requests.filter(
        (record) => record.path.endsWith('/progress') && record.body !== null && record.body.includes('"started"'),
      ).length,
    progressAckedCount: () => progressAcked,
  };
}

/** API 登录 + 选主档案(与服务端同一真实链路;cookie 落在 page 所属 context) */
async function apiLoginAndSelectMain(page: Page): Promise<void> {
  const login = await page.request.post('/api/auth/login', {
    data: { username: 'fixtureadmin', password: 'password-123', deviceType: 'web', deviceName: 'e2e-t082' },
  });
  expect(login.status(), 'fixture 账号登录应成功(需 E2E_SEED_SCALE=1 种子)').toBe(200);
  const profiles = (await (await page.request.get('/api/profiles')).json()) as Array<{
    id: string;
    name: string;
    pinProtected: boolean;
    status: string;
  }>;
  const main = profiles.find((profile) => profile.name === '主档案' && profile.status === 'active');
  expect(main, '夹具主档案应存在').toBeDefined();
  if (main?.pinProtected === true) {
    const unlock = await page.request.post(`/api/profiles/${main.id}/unlock`, { data: { pin: '135790' } });
    expect(unlock.status()).toBe(200);
  }
  const select = await page.request.post(`/api/profiles/${main?.id ?? ''}/select`, { data: {} });
  expect(select.status()).toBe(200);
}

/** 设置入口解锁(签发 settings grant) */
async function apiUnlockSettings(page: Page): Promise<void> {
  const access = await page.request.post('/api/settings/access', { data: { pin: '135790' } });
  expect(access.status()).toBe(200);
}

function dialogOf(page: Page): Locator {
  return page.locator('[role="dialog"][data-slot="modal-dialog"]');
}

async function expectStep(page: Page, title: string): Promise<void> {
  await expect(dialogOf(page).getByRole('heading', { name: title, exact: true })).toBeVisible();
}

/** 播放意图面完全退场(authorize/prepare 面板与全屏面都消失) */
async function expectPlaybackGone(page: Page): Promise<void> {
  await expect(page.getByTestId('playback-preparing')).toBeHidden({ timeout: 10_000 });
  await expect(page.getByTestId('playback-surface')).toBeHidden({ timeout: 10_000 });
}

/** 等待真实播放面 + 媒体真实 playing(video.js VHS 消费受控网关产物)。
 *  自动播放策略拒绝时点击「点击播放」手势面恢复(010 T065 既有出路,真实手势)。 */
async function waitRealPlaying(page: Page): Promise<void> {
  const surface = page.getByTestId('playback-surface');
  await expect(surface).toBeVisible({ timeout: 30_000 });
  const gestureButton = page.getByTestId('autoplay-gesture').getByRole('button', { name: '点击播放' });
  const deadlineMs = Date.now() + 45_000;
  for (;;) {
    if (await gestureButton.isVisible().catch(() => false)) {
      await gestureButton.click();
    }
    const state = (await page
      .getByTestId('playback-video')
      .evaluate((video: HTMLVideoElement) => ({ paused: video.paused, readyState: video.readyState }))
      .catch(() => ({ paused: true, readyState: 0 }))) as { paused: boolean; readyState: number };
    if (!state.paused && state.readyState >= 2) {
      return;
    }
    if (Date.now() > deadlineMs) {
      throw new Error(`媒体元素未真实起播(实测 paused=${state.paused}, readyState=${state.readyState})`);
    }
    await sleep(500);
  }
}

/* ------------------------------------------------------------------ */
/* 用例(串行;受控上游与目录一次准备,多测试共享)                            */
/* ------------------------------------------------------------------ */

// 真实 Chromium 缺省不带 autoplay 豁免:显式允许无手势起播(顶层 use,describe 内禁止)
// (策略拒绝路径仍被保留——waitRealPlaying 兼容「点击播放」手势面)
test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

test.describe.serial('T082 · US5 全局播放/退出/守护(Q9/Q7 受控真实链路)', () => {
  // watchdog 回收期限(60s/45s)+ 扫描节拍(15s)留裕度
  test.setTimeout(300_000);

  let upstream: FixtureUpstream | null = null;
  let mainChannelId = '';
  /** 全部已建会话(无主会话 0 断言的样本池) */
  const trackedSessions = new Map<string, string>();

  test.afterAll(async () => {
    await upstream?.close();
    upstream = null;
  });

  test('受控上游注册与频道导入(设置 API 真实链路)', async ({ page }) => {
    upstream = await startFixtureUpstream();

    await apiLoginAndSelectMain(page);
    await apiUnlockSettings(page);

    // 1. 创建 IPTV 源(指向 spec 进程内受控上游;013/ADR-0017:常规操作免当次密码,
    // 请求体不带 ownerPassword —— 服务端 strict 契约拒绝未知字段)
    const create = await page.request.post('/api/settings/sources', {
      data: {
        kind: 'iptv',
        name: 'e2e 受控直播源(T082)',
        remoteUrl: `${upstream.baseUrl}/live.m3u`,
        enabled: true,
      },
    });
    expect(create.status(), `源创建应成功:${create.status()}`).toBe(201);
    const source = (await create.json()) as { id: string; version: number };

    // 2. 发起导入 → 等待终态(正常 diff 自动发布 succeeded;异常 diff 才 awaiting_confirmation;
    //    免当次密码,幂等 operationKey 照旧)
    const refresh = await page.request.post(`/api/settings/sources/${source.id}/refresh`, {
      data: { expectedVersion: source.version, operationKey: crypto.randomUUID() },
    });
    expect(refresh.status()).toBe(202);
    const refreshId = ((await refresh.json()) as { id: string }).id;
    let jobStatus = '';
    await expect
      .poll(
        async () => {
          const job = await page.request.get(`/api/settings/refreshes/${refreshId}`);
          if (job.status() !== 200) {
            return `http-${job.status()}`;
          }
          jobStatus = ((await job.json()) as { status: string }).status;
          return ['succeeded', 'awaiting_confirmation', 'failed', 'interrupted', 'stale', 'expired'].includes(jobStatus)
            ? jobStatus
            : `pending:${jobStatus}`;
        },
        { timeout: 30_000, message: '导入任务应到达终态' },
      )
      .toMatch(/^(succeeded|awaiting_confirmation|failed|interrupted|stale|expired)$/);
    expect(jobStatus, `导入应成功:${jobStatus}`).toBe('succeeded');

    // 3. 公共目录应出现受控频道(自成分组 group-title=e2e受控;q=标题检索定位)
    await expect
      .poll(
        async () => {
          const channels = (await (
            await page.request.get(`/api/public/live/channels?section=all&q=${encodeURIComponent(CHANNEL_MAIN)}`)
          ).json()) as { items: Array<{ media: { id: string; title: string } }> };
          return Array.isArray(channels.items) && channels.items.some((row) => row.media.title === CHANNEL_MAIN);
        },
        { timeout: 20_000, message: '受控频道应发布到公共目录' },
      )
      .toBe(true);
    const channels = (await (
      await page.request.get(`/api/public/live/channels?section=all&q=${encodeURIComponent(CHANNEL_MAIN)}`)
    ).json()) as { items: Array<{ media: { id: string; title: string } }> };
    const mainChannel = channels.items.find((row) => row.media.title === CHANNEL_MAIN);
    expect(mainChannel).toBeDefined();
    mainChannelId = mainChannel?.media.id ?? '';
    expect(mainChannelId).not.toBe('');
  });

  test('Q9:20 次路由导航不中断全局播放/心跳/进度,设置入口可用且焦点正确', async ({ page }) => {
    const tracking = attachTracking(page);
    await apiLoginAndSelectMain(page);

    // 直播页点播受控频道 → 真实播放
    await page.goto('/live');
    const card = page.getByRole('article', { name: `频道 ${CHANNEL_MAIN}` });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole('button', { name: `播放 ${CHANNEL_MAIN} 当前直播` }).click();
    await waitRealPlaying(page);
    // 进度泵 started 样本应已发出并被确认(真实 playing 触发;ACK=接受游标回程)
    await expect.poll(() => tracking.startedSampleCount(), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => tracking.progressAckedCount(), { timeout: 20_000, message: 'started 应被服务端确认' })
      .toBeGreaterThanOrEqual(1);
    for (const id of tracking.resolvedSessionIds) {
      trackedSessions.set(id, 'nav-playing');
    }

    // 20 次客户端路由导航(react-router,非整页刷新):全局播放面/泵不受影响
    const nav = page.getByRole('navigation', { name: '公共导航' });
    const videoStartedAt = await page.getByTestId('playback-video').evaluate((video: HTMLVideoElement) => video.currentTime);
    const progressBefore = tracking.progressRequestTimes().length;
    const heartbeatBefore = tracking.requests.filter((record) => record.path.endsWith('/heartbeat')).length;
    const labels = ['首页', '点播', '直播'] as const;
    for (let index = 0; index < 20; index += 1) {
      const label = labels[index % labels.length] as string;
      await nav.getByRole('link', { name: label }).click();
      const expectedPath = label === '首页' ? '/' : label === '点播' ? '/vod' : '/live';
      await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toBe(expectedPath);
      await expect(page.getByTestId('playback-surface'), `第 ${index + 1} 次导航后播放面仍在`).toBeVisible();
    }
    // 泵存活:导航窗口内至少一个新的周期进度样本与一个心跳
    await expect
      .poll(() => tracking.progressRequestTimes().length, { timeout: 25_000, message: '导航期间应有新的进度样本' })
      .toBeGreaterThan(progressBefore);
    await expect
      .poll(
        () => tracking.requests.filter((record) => record.path.endsWith('/heartbeat')).length,
        { timeout: 25_000, message: '导航期间应有心跳节拍' },
      )
      .toBeGreaterThan(heartbeatBefore);
    // 路由变化不卸载播放:导航全程零 /stop(generation/路由变化不触发卸载 stop)
    expect(tracking.stopRequestTimes(), '20 次导航期间不得出现 /stop').toEqual([]);
    // 媒体仍在真实播放(时间轴前进、未暂停)
    const videoNow = await page.getByTestId('playback-video').evaluate((video: HTMLVideoElement) => ({
      paused: video.paused,
      currentTime: video.currentTime,
    }));
    expect(videoNow.paused).toBe(false);
    expect(videoNow.currentTime).toBeGreaterThan(videoStartedAt);

    // 设置入口仍可用:身份菜单 → 设置 → PIN 门弹层,焦点落入弹层;取消后播放继续
    await page.getByRole('button', { name: /主档案/ }).first().click();
    const menu = page.getByRole('menu', { name: '身份菜单' });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: '设置' }).click();
    await expectStep(page, '输入设置 PIN');
    const settingsDialog = dialogOf(page);
    const focusInside = await settingsDialog.evaluate(
      (element) => element.contains(document.activeElement),
    );
    expect(focusInside, '设置 PIN 门打开后焦点应落入弹层').toBe(true);
    await settingsDialog.getByRole('button', { name: '取消' }).click();
    await expect(dialogOf(page)).toBeHidden();
    await expect(page.getByTestId('playback-surface')).toBeVisible();
    const videoAfterSettings = await page.getByTestId('playback-video').evaluate((video: HTMLVideoElement) => video.paused);
    expect(videoAfterSettings).toBe(false);

    // 收口:正常退出(为后续用例清理;本会话已进跟踪池)
    await page.getByRole('button', { name: '退出播放' }).click();
    await expectPlaybackGone(page);
    for (const id of tracking.resolvedSessionIds) {
      trackedSessions.set(id, 'nav-ended');
    }
  });

  test('弱网退出:进度节流 5s 下退出,≤1s 内恰一次 /stop(带 final),退出后零补报', async ({ page }) => {
    const tracking = attachTracking(page);
    await apiLoginAndSelectMain(page);
    // 弱网:进度样本延迟 5s(> 有界保存窗口 1s);stop/heartbeat 不节流
    await page.route('**/api/playback/sessions/*/progress', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      await route.fallback();
    });

    await page.goto('/live');
    const card = page.getByRole('article', { name: `频道 ${CHANNEL_MAIN}` });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole('button', { name: `播放 ${CHANNEL_MAIN} 当前直播` }).click();
    await waitRealPlaying(page);
    await expect.poll(() => tracking.startedSampleCount(), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    // started 已确认(弱网下 ACK 延迟 5s 回程;确认后才构成「final 载荷」前提)
    await expect
      .poll(() => tracking.progressAckedCount(), { timeout: 20_000, message: 'started 应被服务端确认' })
      .toBeGreaterThanOrEqual(1);
    const sessionId = tracking.resolvedSessionIds[tracking.resolvedSessionIds.length - 1];
    expect(sessionId, 'resolve 应产出会话 id').toBeTruthy();
    trackedSessions.set(sessionId ?? '', 'weak-exit');

    // 退出:点击时刻 → /stop 请求发出时刻 必须 ≤1s(进度被弱网拖住也不得等待保存)
    const exitStartMs = Date.now();
    await page.getByRole('button', { name: '退出播放' }).click();
    await expectPlaybackGone(page);
    await expect.poll(() => tracking.stopRequestTimes().length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    const stopTimes = tracking.stopRequestTimes();
    expect(stopTimes.length, '本会话退出路径应恰一次 /stop').toBe(1);
    const stopDeltaMs = (stopTimes[0] ?? 0) - exitStartMs;
    expect(stopDeltaMs, `退出到 /stop 发出应 ≤1000ms(实测 ${stopDeltaMs}ms)`).toBeLessThanOrEqual(1_000);
    // final 载荷:started 已确认 → /stop 必须携带 finalProgress(恰一次 final)
    const stopRecord = tracking.requests.find((record) => record.path.endsWith('/stop'));
    expect(stopRecord?.body ?? '', '已确认会话的 /stop 应携带 finalProgress').toContain('finalProgress');
    // 旧身份零补报:/stop 之后不得再发出任何进度样本(泵已收口,弱网重试不越界)
    await page.waitForTimeout(2_500);
    const progressAfterStop = tracking.progressRequestTimes().filter((atMs) => atMs > (stopTimes[0] ?? 0));
    expect(progressAfterStop, '/stop 后零进度补报').toEqual([]);

    // 服务端事实:优雅退出 → ended
    const dto = (await (await page.request.get(`/api/playback/sessions/${sessionId}`)).json()) as { state: string };
    expect(dto.state).toBe('ended');
    trackedSessions.set(sessionId ?? '', 'weak-exit-ended');
  });

  test('弱网切档:进度节流下切换 Profile,≤1s 内恰一次 /stop,播放面收口', async ({ page }) => {
    const tracking = attachTracking(page);
    await apiLoginAndSelectMain(page);
    await page.route('**/api/playback/sessions/*/progress', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      await route.fallback();
    });

    await page.goto('/live');
    const card = page.getByRole('article', { name: `频道 ${CHANNEL_MAIN}` });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole('button', { name: `播放 ${CHANNEL_MAIN} 当前直播` }).click();
    await waitRealPlaying(page);
    await expect.poll(() => tracking.startedSampleCount(), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => tracking.progressAckedCount(), { timeout: 20_000, message: 'started 应被服务端确认' })
      .toBeGreaterThanOrEqual(1);
    const sessionId = tracking.resolvedSessionIds[tracking.resolvedSessionIds.length - 1];
    expect(sessionId).toBeTruthy();
    trackedSessions.set(sessionId ?? '', 'weak-switch');

    // 切档:身份菜单 → 切换 Profile → 儿童档案(PIN 246800)——身份变化即统一收口
    await page.getByRole('button', { name: /主档案/ }).first().click();
    const menu = page.getByRole('menu', { name: '身份菜单' });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: '切换 Profile' }).click();
    await expectStep(page, '选择 Profile');
    const switchStartMs = Date.now();
    await dialogOf(page).getByRole('button', { name: /儿童档案/ }).click();
    await expectStep(page, '输入档案 PIN');
    await dialogOf(page).getByLabel('档案 PIN').fill('246800');
    await dialogOf(page).getByRole('button', { name: '解锁并选择' }).click();
    await expect(dialogOf(page)).toBeHidden({ timeout: 15_000 });

    // 身份撤销收口:播放面卸载,/stop ≤1s(不被弱网保存阻塞)
    await expectPlaybackGone(page);
    await expect.poll(() => tracking.stopRequestTimes().length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    const stopTimes = tracking.stopRequestTimes();
    expect(stopTimes.length, '切档收口应恰一次 /stop').toBe(1);
    const stopDeltaMs = (stopTimes[0] ?? 0) - switchStartMs;
    expect(stopDeltaMs, `切档到 /stop 发出应 ≤1000ms(实测 ${stopDeltaMs}ms)`).toBeLessThanOrEqual(1_000);
    const progressAfterStop = tracking.progressRequestTimes().filter((atMs) => atMs > (stopTimes[0] ?? 0));
    expect(progressAfterStop, '/stop 后零进度补报').toEqual([]);

    // 旧上下文会话:身份变化事务已终态化,读取与「不存在」同形 404(005 既有契约)
    const old = await page.request.get(`/api/playback/sessions/${sessionId}`);
    expect(old.status()).toBe(404);
    expect(((await old.json()) as { code?: string }).code).toBe('PLAYBACK_NOT_FOUND');
  });

  test('重复关闭与 StrictMode 双挂载:关闭路径恰一次 /stop,started 恰一次', async ({ page }) => {
    const tracking = attachTracking(page);
    await apiLoginAndSelectMain(page);

    await page.goto('/live');
    const card = page.getByRole('article', { name: `频道 ${CHANNEL_MAIN}` });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole('button', { name: `播放 ${CHANNEL_MAIN} 当前直播` }).click();
    await waitRealPlaying(page);
    await expect.poll(() => tracking.startedSampleCount(), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => tracking.progressAckedCount(), { timeout: 20_000, message: 'started 应被服务端确认' })
      .toBeGreaterThanOrEqual(1);
    const sessionId = tracking.resolvedSessionIds[tracking.resolvedSessionIds.length - 1];
    expect(sessionId).toBeTruthy();
    trackedSessions.set(sessionId ?? '', 'double-close');

    // StrictMode(dev 双挂载)下的样本纪律:started 恰一次(seq 不重发)
    expect(tracking.startedSampleCount(), 'StrictMode 双挂载下 started 样本应恰一次').toBe(1);

    // 挂载稳定期(播放建立 1s 后)不得有提前 /stop(挂载/挂载清理不产生会话 stop)
    await page.waitForTimeout(1_000);
    const stopsBeforeClose = tracking.stopRequestTimes().length;

    // 重复关闭:快速双击退出 → close 幂等,仅一次 /stop
    const exitButton = page.getByRole('button', { name: '退出播放' });
    await exitButton.dblclick();
    await expectPlaybackGone(page);
    await expect.poll(() => tracking.stopRequestTimes().length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    expect(
      tracking.stopRequestTimes().length,
      `重复关闭后 /stop 总数应为挂载稳定期值 + 1(实测 ${tracking.stopRequestTimes().length},关闭前 ${stopsBeforeClose})`,
    ).toBe(stopsBeforeClose + 1);
    const dto = (await (await page.request.get(`/api/playback/sessions/${sessionId}`)).json()) as { state: string };
    expect(dto.state).toBe('ended');
    trackedSessions.set(sessionId ?? '', 'double-close-ended');
  });

  test('Q7/T081 浏览器退出 watchdog:无主 ready 与播放中会话回收,无主 0/复活 0', async ({ page, playwright }) => {
    // A. 无客户端 ready 会话:仅 resolve(不经浏览器播放),客户端即消失
    //    ——期限锚点起 60s 固定期限回收(heartbeat/renew 不续命)
    const resolveReply = await page.request.post('/api/playback/resolve', {
      data: { mediaId: mainChannelId, startMode: 'beginning' },
    });
    expect(resolveReply.status()).toBe(201);
    const orphanReadyId = ((await resolveReply.json()) as { id: string }).id;
    trackedSessions.set(orphanReadyId, 'orphan-ready');

    // B. 真实播放中会话:浏览器直接退出(无 stop/无退出点击)
    const context = page.context();
    const tracking = attachTracking(page);
    await page.goto('/live');
    const card = page.getByRole('article', { name: `频道 ${CHANNEL_ALT}` });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole('button', { name: `播放 ${CHANNEL_ALT} 当前直播` }).click();
    await waitRealPlaying(page);
    await expect.poll(() => tracking.startedSampleCount(), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    const orphanPlayingId = tracking.resolvedSessionIds[tracking.resolvedSessionIds.length - 1];
    expect(orphanPlayingId).toBeTruthy();
    trackedSessions.set(orphanPlayingId ?? '', 'orphan-playing');

    // 摘取 cookie 供浏览器死亡后的服务端断言(独立 APIRequestContext)
    const cookies = await context.cookies();
    const afterExit: APIRequestContext = await playwright.request.newContext({
      storageState: { cookies, origins: [] },
    });
    await context.close(); // 浏览器直接退出:零 stop、零补报

    // 终态等待:ready-orphan ≤ created+60s 期限 + 扫描节拍;playing-orphan ≤ 45s 失联 + 节拍
    const deadlineMs = Date.now() + 120_000;
    const terminalStates = ['ended', 'interrupted', 'failed', 'not-found'];
    const readState = async (request: APIRequestContext, id: string): Promise<string> => {
      const reply = await request.get(`/api/playback/sessions/${id}`);
      if (reply.status() === 404) {
        return 'not-found';
      }
      expect(reply.status()).toBe(200);
      return ((await reply.json()) as { state: string }).state;
    };
    let readyState = '';
    let playingState = '';
    while (Date.now() < deadlineMs) {
      readyState = await readState(afterExit, orphanReadyId ?? '');
      playingState = await readState(afterExit, orphanPlayingId ?? '');
      if (terminalStates.includes(readyState) && terminalStates.includes(playingState)) {
        break;
      }
      await sleep(3_000);
    }
    expect(
      ['interrupted', 'not-found'],
      `无主 ready 会话应被期限回收为 interrupted(实测 ${readyState};T081 未起播 60s 固定期限)`,
    ).toContain(readyState);
    expect(
      ['interrupted', 'not-found'],
      `播放中无主会话应被失联回收为 interrupted(实测 ${playingState};45s 失联扫描)`,
    ).toContain(playingState);
    trackedSessions.set(orphanReadyId ?? '', 'orphan-ready-reclaimed');
    trackedSessions.set(orphanPlayingId ?? '', 'orphan-playing-reclaimed');

    // 终态复活 0:终态后再轮询 + renew 尝试,状态不得回到活动态
    for (let round = 0; round < 3; round += 1) {
      await sleep(3_000);
      for (const id of [orphanReadyId ?? '', orphanPlayingId ?? '']) {
        const state = await readState(afterExit, id);
        expect(terminalStates, `终态会话 ${id} 不得复活(实测 ${state})`).toContain(state);
      }
      const renew = await afterExit.post(`/api/playback/sessions/${orphanReadyId ?? ''}/renew`, {
        data: { expectedGeneration: 1 },
      });
      expect(renew.status(), '终态会话换票必须被拒绝(不得复活交付)').toBeGreaterThanOrEqual(400);
    }

    // 无主会话 0:本套件全部已建会话均须终态(无任何残留活动态)
    for (const [id, label] of trackedSessions) {
      const state = await readState(afterExit, id);
      expect(
        terminalStates,
        `无主会话必须为 0:会话 ${id}(${label})实测 ${state}`,
      ).toContain(state);
    }
    await afterExit.dispose();
  });
});
