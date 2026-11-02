import { spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';

/**
 * 012 T026 · 播放连续性 e2e(US4;FR-020/FR-021/FR-023、SC-005、ui.md §4):
 *
 * 运行方式(独立 DATA_DIR 由 playwright.config.ts 注入;双服务由 webServer 启动):
 *   cd apps/web && E2E_SEED_SCALE=1 LAN_ALLOWED_TARGETS=127.0.0.1 \
 *     pnpm exec playwright test test/e2e/live-player-continuity.spec.ts
 *
 * - E2E_SEED_SCALE=1:种子 T012 规模夹具(凭据 fixtureadmin/password-123,主档案
 *   「主档案」PIN 135790)——guide 节目墙用种子频道(有 EPG);其源指向不可达
 *   夹具地址,播放到达「resolve 接受 → 播放面呈现(准备/不可播放)」层面(与
 *   playback-intent.spec 同一断言深度,不依赖真实媒体交付);
 * - 浮层开/关「不中断播放」用受控真实链路(spec 进程内 ffmpeg HLS 直播上游,经
 *   设置 API 导入;online-vod-global.spec 同款受控上游模式):真实 playing 下
 *   开/关浮层,断言媒体持续推进、零新会话。
 *
 * 009 非模态框架语义(以现状能力为准,不虚构遮罩路径):
 * - 播放面为非模态浮层:无遮罩层,底层 guide 全程可见可用;
 * - Escape 无 dismiss 通道(防误关):按 Escape 播放面保持;
 * - 退出唯一路径 = 播放面「退出」按钮 → 统一 close 收口。
 *
 * 退出恢复断言面(FR-021 现状能力):播放面不导航 —— URL/筛选(pageSize)/滚动
 * 在退出后与进入前一致(播放面存在期间与退出后逐点核对);焦点恢复现状缺口
 * (退出按钮卸载后焦点落 body,恢复落点在协调器播放面壳 —— 登记,不在本 e2e 虚断)。
 */

/* ------------------------------------------------------------------ */
/* 认证弹层与播放面定位(playback-intent.spec 同款约定)                  */
/* ------------------------------------------------------------------ */


/** 播放意图面:authorize/prepare 为非阻塞面板,playing/unavailable 为浮层面 */
async function expectPlaybackFace(page: Page): Promise<void> {
  await expect(page.getByTestId('playback-preparing').or(page.getByTestId('playback-surface'))).toBeVisible({
    timeout: 20_000,
  });
}

/** 播放意图面完全退场 */
async function expectPlaybackGone(page: Page): Promise<void> {
  await expect(page.getByTestId('playback-preparing')).toBeHidden({ timeout: 10_000 });
  await expect(page.getByTestId('playback-surface')).toBeHidden({ timeout: 10_000 });
}

/** API 登录 + 选主档案(真实链路;cookie 落在 page 所属 context) */
async function apiLoginAndSelectMain(page: Page): Promise<void> {
  const login = await page.request.post('/api/auth/login', {
    data: { username: 'fixtureadmin', password: 'password-123', deviceType: 'web', deviceName: 'e2e-012-t026' },
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

/** 设置入口解锁(签发 settings grant;源导入前置) */
async function apiUnlockSettings(page: Page): Promise<void> {
  const access = await page.request.post('/api/settings/access', { data: { pin: '135790' } });
  expect(access.status()).toBe(200);
}

/* ------------------------------------------------------------------ */
/* 受控上游夹具(真实 HLS 直播流;online-vod-global 同款紧凑版)           */
/* ------------------------------------------------------------------ */

const SEGMENT_SECONDS = 2;
const SEGMENT_COUNT = 60; // 120s 滚动池(按绝对序号取模循环,覆盖用例时长足够)
const LIVE_WINDOW_BACK = 12;
const LIVE_WINDOW_FORWARD = 4;

/** 受控频道标题(spec 进程内唯一;同一 DATA_DIR 复跑会残留同名旧源,唯一后缀
 *  保证目录检索/卡片定位只命中本次导入的频道 —— 旧源的上游端口已死,命中即 503) */
const CHANNEL_MAIN = `e2e 连续性频道 ${process.pid}`;

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

/** 启动受控上游:ffmpeg 生成真实 H.264 TS 分片池 + 动态滚动直播清单 */
async function startFixtureUpstream(): Promise<FixtureUpstream> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redroad-e2e-012-continuity-'));
  const segDir = path.join(tmpDir, 'segs');
  fs.mkdirSync(segDir);
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
      const entries = [CHANNEL_MAIN]
        .map((title, index) => `#EXTINF:-1 group-title="e2e连续性",${title}\nhttp://${primaryLanIpv4()}:${(server.address() as AddressInfo).port}/hls/${index === 0 ? 'a' : 'b'}/index.m3u8`)
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

/** 等待媒体真实 playing(video.js VHS 消费网关产物;自动播放拒绝时点手势面) */
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
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
}

/** /api/playback/resolve 请求计数(零新会话负向) */
function trackResolveCount(page: Page): () => number {
  let count = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/playback/resolve') {
      count += 1;
    }
  });
  return () => count;
}

// 真实 Chromium 缺省不带 autoplay 豁免(online-vod-global 同款;保留手势面兼容)
test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

test.describe.serial('T026 · 播放连续性(退出恢复 / 浮层不中断 / 009 退出语义)', () => {
  test.setTimeout(300_000);

  let upstream: FixtureUpstream | null = null;

  test.afterAll(async () => {
    await upstream?.close();
    upstream = null;
  });

  test('受控上游注册与频道导入(设置 API 真实链路;供浮层真实播放用例)', async ({ page }) => {
    upstream = await startFixtureUpstream();
    await apiLoginAndSelectMain(page);
    await apiUnlockSettings(page);
    const create = await page.request.post('/api/settings/sources', {
      data: {
        kind: 'iptv',
        name: 'e2e 受控连续性源(T026)',
        remoteUrl: `${upstream.baseUrl}/live.m3u`,
        enabled: true,
        ownerPassword: 'password-123',
      },
    });
    expect(create.status(), `源创建应成功:${create.status()}`).toBe(201);
    const source = (await create.json()) as { id: string; version: number };
    const refresh = await page.request.post(`/api/settings/sources/${source.id}/refresh`, {
      data: { expectedVersion: source.version, operationKey: crypto.randomUUID(), ownerPassword: 'password-123' },
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
  });
  test('播放设置浮层开/关不中断播放;无「打开完整设置」入口(FR-023)', async ({ page }) => {
    const resolveCount = trackResolveCount(page);
    await apiLoginAndSelectMain(page);

    // 受控真实频道(直播首页入口)→ 真实 playing(无节目单频道在 Now 区与分组区
    // 各保留一张身份卡(FR-012)—— 取第一张即可,两卡同一 PlayButton 语义)
    await page.goto('/live');
    const card = page.getByRole('article', { name: `频道 ${CHANNEL_MAIN}` }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole('button', { name: `播放 ${CHANNEL_MAIN} 当前直播` }).click();
    await waitRealPlaying(page);
    const videoState = () =>
      page
        .getByTestId('playback-video')
        .evaluate((video: HTMLVideoElement) => ({
          paused: video.paused,
          readyState: video.readyState,
          currentTime: video.currentTime,
        }));
    const before = await videoState();
    const resolvesAtPlaying = resolveCount();
    expect(resolvesAtPlaying).toBeGreaterThanOrEqual(1);

    // 打开浮层:三组当前值呈现;无跳转完整设置页入口(FR-023)
    const surface = page.getByTestId('playback-surface');
    await surface.getByRole('button', { name: '播放设置' }).click();
    const overlay = page.getByTestId('playback-settings');
    await expect(overlay).toBeVisible();
    await expect(overlay.getByText('音轨', { exact: true })).toBeVisible();
    await expect(overlay.getByText('字幕', { exact: true })).toBeVisible();
    await expect(overlay.getByTestId('playback-quality')).toContainText('当前交付:');
    await expect(page.getByText('打开完整设置')).toHaveCount(0);
    // 浮层打开期间媒体零中断
    const duringOpen = await videoState();
    expect(duringOpen.paused).toBe(false);

    // 关闭浮层:媒体持续推进、播放面存活、零新会话
    await overlay.getByRole('button', { name: '关闭播放设置' }).click();
    await expect(overlay).toBeHidden();
    await expect
      .poll(async () => (await videoState()).currentTime, { timeout: 15_000, message: '关闭浮层后媒体应持续推进' })
      .toBeGreaterThan(before.currentTime);
    expect((await videoState()).paused).toBe(false);
    expect(resolveCount()).toBe(resolvesAtPlaying); // 开/关浮层零新会话
    await expect(surface).toBeVisible();
  });
  test('guide→播放→退出:URL/筛选/滚动恢复;Escape 不关闭(009);退出按钮唯一路径', async ({ page }) => {
    await apiLoginAndSelectMain(page);

    // guide 状态进入:URL 携带 pageSize(筛选面)+ 节目墙滚动到非零位置
    await page.goto('/live/guide?pageSize=10');
    const wall = page.getByRole('region', { name: '节目墙' });
    await expect(wall).toBeVisible({ timeout: 20_000 });
    const playButton = wall.getByRole('button', { name: /当前直播/ }).first();
    await expect(playButton).toBeVisible({ timeout: 20_000 });
    const channelTitle = ((await playButton.getAttribute('aria-label')) ?? '')
      .replace(/^播放\s*/, '')
      .replace(/\s*当前直播$/, '');
    expect(channelTitle.length).toBeGreaterThan(0);
    await wall.evaluate((el) => {
      el.scrollTop = 120;
      el.scrollLeft = 200;
    });
    const urlBefore = page.url();
    expect(urlBefore).toContain('pageSize=10');

    // guide→播放(已选档:直接 authorize → 播放意图面 → 播放面浮层)
    // (点击的动作性滚动可能调整容器视口 —— 滚动参照点取「播放面出现后」:
    //  FR-021 不变式 = 退出不得改变退出前的滚动/URL,而非点击前的历史值)
    await playButton.click();
    await expectPlaybackFace(page);
    const surface = page.getByTestId('playback-surface');
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await expect(surface.getByRole('heading', { level: 2 })).toContainText(channelTitle);
    // 播放面存活期内:guide 底层全程可见可用(009 非模态 —— 无遮罩、无整页隐藏)
    await expect(wall).toBeVisible();
    expect(page.url()).toBe(urlBefore);
    const scrollDuringPlayback = await wall.evaluate((el) => ({ top: el.scrollTop, left: el.scrollLeft }));

    // 等播放面内容面定型(夹具源不可达 → 稳定拒绝;或引擎已挂载。两态均持「退出」)
    await expect(
      surface.getByText(/当前不可播放|不可用|终止|中断|超时/).first().or(surface.getByTestId('playback-video')),
    ).toBeVisible({ timeout: 60_000 });

    // Escape:009 防误关 —— 无 dismiss 通道,播放面保持(不虚构遮罩路径)
    await page.keyboard.press('Escape');
    await expect(surface).toBeVisible();
    expect(page.url()).toBe(urlBefore);

    // 退出唯一路径:播放面「退出」按钮 → 统一 close 收口 → 播放面退场
    await surface.getByRole('button', { name: '退出播放' }).click();
    await expectPlaybackGone(page);

    // 退出恢复(FR-021 现状面):URL/筛选不变、节目墙滚动不变、guide 可交互
    expect(page.url()).toBe(urlBefore);
    await expect(wall).toBeVisible();
    const scrollAfter = await wall.evaluate((el) => ({ top: el.scrollTop, left: el.scrollLeft }));
    expect(scrollAfter).toEqual(scrollDuringPlayback);
    await expect(playButton).toBeVisible();
  });
});
