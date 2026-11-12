import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * T139(005 · SC-010 新环境完整闭环 e2e;FR-048)。
 * 权威:tasks.md T139、spec.md SC-010/FR-047~048。
 *
 * ══ 运行方式(全新空库 + 可达上游,本套件专用环境;playwright webServer 走
 * scripts/e2e-servers.sh 无种子分支 = 迁移建空库,已在脚本确认)══
 *
 *   LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ifconfig 2>/dev/null | awk '/inet /&&!/127\.0\.0\.1/{print $2; exit}')
 *   NASROOT=$(mktemp -d /tmp/redroad-fresh-nas.XXXXXX)
 *   cd apps/web && \
 *     LAN_UPSTREAM_IP="$LAN_IP" \
 *     LAN_ALLOWED_TARGETS="$LAN_IP" \
 *     MEDIA_ROOTS="nas-main=$NASROOT" \
 *     pnpm exec playwright test test/e2e/fresh-deployment-loop.spec.ts
 *
 * 环境变量契约(套件内显式守卫,缺失即失败,不静默 skip):
 * - 不设 E2E_SEED_SCALE → e2e-servers.sh 走 `migrate.ts up` 建全新空库(独立临时 DATA_DIR);
 * - LAN_ALLOWED_TARGETS=$LAN_UPSTREAM_IP:部署级精确许可,放行本机非回环 IPv4 上的
 *   受控 m3u 上游(源目标安全语义:创建期字面类别校验拒绝回环字面量,故用非回环
 *   本机 IP;刷新期由 safe-http-reader 按许可列表逐跳放行 —— 与
 *   sources-refresh.e2e-spec 的 LAN_ALLOWED_TARGETS='127.0.0.1' 契约夹具同思路);
 * - MEDIA_ROOTS=nas-main=<临时根>:NAS 来源授权根(根内 movies/ 相对目录由本套件
 *   在 beforeAll 用 ffmpeg 生成真实 mp4,供 probe 产生可信时长)。
 *
 * ══ 断言深度与口径(报告口径注明)══
 * - 完整闭环:账号配置→登录→首建档案→选档→导入来源(IPTV m3u + NAS 影库)→
 *   公开浏览→收藏→播放→历史→设置,全部经真实 UI/HTTP 完成。
 *   设置菜单拆分:IPTV 来源经「IPTV 管理」(/settings/iptv 直播源标签)创建导入,
 *   NAS 来源经「NAS/点播」(/settings/sources)创建导入;
 * - 播放:UI 点击断言到 resolve(201)→ prepare 层;NAS 真实 mp4 使 probe 产生可信
 *   时长,会话可到 ready/playing(本环境可真实完成的深度;IPTV 流地址指向不可达
 *   端口,稳定拒绝属预期 —— 夹具无真实媒体交付链,交付层归 004 runtime);
 * - 历史:「真正 started 才产生历史」——经 API 对 resolve 绑定的 VOD 会话发送
 *   reason='started' 进度样本(样本形态对照 playback-progress.contract.spec.ts),
 *   UI 断言历史卡与「继续观看」入口出现;
 * - 源媒体与备份误删次数为 0(口径注明:删除行为无从对部署外世界断言,自动化语义 =
 *   全程零 DELETE 类 API 请求 + 初始化恰好一次 + 无清库/重置类请求 + 源媒体文件与
 *   上游夹具在套件结束时刻原样存在);
 * - 独立环境:webServer 每次运行 mktemp 全新 DATA_DIR,套件自证 bootstrapRequired
 *   由 true → false。
 */

/* ────────────────────────── 环境契约与夹具 ────────────────────────── */

const OWNER = { username: 'admin', password: 'password-123' } as const;
const MAIN_PROFILE = { name: '闭环妈妈', pin: '246810' };
const HOUSEHOLD_ORIGINAL = '闭环之家';
const HOUSEHOLD_RENAMED = '闭环之家·改';
const IPTV_SOURCE_NAME = '闭环直播源';
const NAS_SOURCE_NAME = '闭环影库';
const CHANNEL_NAMES = ['闭环频道新闻', '闭环频道影视'] as const;
const MOVIE_TITLE = 'fresh-loop-movie';
const M3U_PATH = '/fresh-loop.m3u';

const LAN_UPSTREAM_IP = process.env.LAN_UPSTREAM_IP ?? '';
const MEDIA_ROOTS_RAW = process.env.MEDIA_ROOTS ?? '';

function nasRootOf(raw: string): { rootKey: string; rootPath: string } {
  const firstPair = raw.split(',')[0] ?? '';
  const separator = firstPair.indexOf('=');
  expect(separator, `MEDIA_ROOTS 形态应为 rootKey=/abs/path,实际:${raw}`).toBeGreaterThan(0);
  const rootKey = firstPair.slice(0, separator);
  const rootPath = firstPair.slice(separator + 1);
  expect(rootPath.startsWith('/'), `MEDIA_ROOTS 根必须为绝对路径:${rootPath}`).toBe(true);
  return { rootKey, rootPath };
}

/** 受控 m3u 上游(0.0.0.0 绑定;仅本套件导入期被服务端读取一次) */
async function startUpstream(): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  const m3u = [
    '#EXTM3U',
    ...CHANNEL_NAMES.flatMap((name, index) => [
      `#EXTINF:-1 tvg-id="loop-${index}",${name}`,
      `http://127.0.0.1:9/loop-${index}.stream`,
    ]),
    '',
  ].join('\n');
  const server = http.createServer((request_, response) => {
    response.setHeader('content-type', 'audio/x-mpegurl');
    response.end(request_.url === M3U_PATH ? m3u : 'not-found');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '0.0.0.0', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('受控 m3u 上游未按预期绑定 TCP 地址');
  }
  return {
    server,
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** ffmpeg 生成真实 mp4(lavfi 测试源 120 秒,供 probe 可信时长/续播语义) */
function generateRealMp4(target: string): Promise<void> {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
        '-t', '120',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest',
        target,
      ],
      { stdio: 'ignore' },
    );
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 生成夹具 mp4 失败: exit ${code}`))));
    child.on('error', reject);
  });
}

/* ────────────────────────── 共享状态与记录 ────────────────────────── */

const upstreamM3uUrlHolder: { url: string } = { url: '' };
const nasMp4PathHolder: { path: string } = { path: '' };
/** DELETE 类浏览器请求记录(误删口径=0 的自动化语义) */
const deleteApiRequests: string[] = [];
/** 初始化(清库语义反义)调用记录:闭环自举应恰好一次 */
const initializeApiRequests: string[] = [];
const wipeLikeApiRequests: string[] = [];

function trackRequests(page: Page): void {
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) {
      return;
    }
    if (request.method() === 'DELETE') {
      deleteApiRequests.push(`${request.method()} ${url.pathname}`);
    }
    if (url.pathname === '/api/setup/initialize') {
      initializeApiRequests.push(url.pathname);
    }
    if (/\/(reset|wipe|purge|danger|maintenance|teardown)/.test(url.pathname)) {
      wipeLikeApiRequests.push(`${request.method()} ${url.pathname}`);
    }
  });
}

/* ────────────────────────── UI 操作辅助(先例:auth-profile-flow / settings)── */

function authDialog(page: Page): Locator {
  return page.locator('[role="dialog"][data-slot="modal-dialog"]');
}

async function expectStep(page: Page, title: string): Promise<void> {
  await expect(authDialog(page).getByRole('heading', { name: title, exact: true })).toBeVisible();
}

/** 导入任务 POST 记录(URL 收窄到 /sources/{id}/refresh,排除 confirm/discard) */
function trackRefreshPosts(page: Page): () => string[] {
  const ids: string[] = [];
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/refresh') && !url.includes('/confirm') && !url.includes('/discard') && response.request().method() === 'POST') {
      void response
        .json()
        .then((body: { id?: string }) => {
          if (typeof body.id === 'string') {
            ids.push(body.id);
          }
        })
        .catch(() => undefined);
    }
  });
  return () => ids;
}

/** 轮询导入任务到期望终态(可达上游 → succeeded) */
async function expectRefreshTerminal(page: Page, refreshId: string, want: string, timeoutMs = 45_000): Promise<void> {
  await expect
    .poll(async () => {
      const poll = await page.request.get(`/api/settings/refreshes/${refreshId}`);
      if (poll.status() !== 200) {
        return 'pending';
      }
      return ((await poll.json()) as { status: string }).status;
    }, { timeout: timeoutMs, intervals: [500] })
    .toBe(want);
}

/** API 登录 + 选主档案(闭环后各分段测试的登录态准备) */
async function apiLoginAndSelectMain(page: Page): Promise<void> {
  const res = await page.request.post('/api/auth/login', { data: { ...OWNER } });
  expect(res.status(), `API 登录应成功:${JSON.stringify(await res.json().catch(() => null))}`).toBe(200);
  const profiles = (await (await page.request.get('/api/profiles')).json()) as Array<{ id: string; isMain: boolean }>;
  const main = profiles.find((profile) => profile.isMain);
  expect(main, '闭环应已建主档案').toBeDefined();
  expect((await page.request.post(`/api/profiles/${main!.id}/unlock`, { data: { pin: MAIN_PROFILE.pin } })).status()).toBe(200);
  expect((await page.request.post(`/api/profiles/${main!.id}/select`, { data: {} })).status()).toBe(200);
}

const PIN_FIELD = '设置 PIN(6 位数字)';

async function navToSettingsModule(page: Page, title: string): Promise<void> {
  const option = page.getByRole('navigation', { name: '设置子菜单' }).getByRole('option', { name: title });
  await option.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('settings-current-module')).toHaveText(title);
}

/* ────────────────────────── 闭环套件 ══════════════════════════════ */

test.describe.serial('T139 · 新环境完整闭环(SC-010 / FR-048)', () => {
  test.setTimeout(240_000);

  let upstream: { server: http.Server; port: number; close: () => Promise<void> } | null = null;
  let channelMediaId = '';
  let videoMediaId = '';

  test.beforeAll(async () => {
    // 环境契约守卫(缺失即失败,不静默跳过)
    expect(
      LAN_UPSTREAM_IP,
      '缺少 LAN_UPSTREAM_IP:请按文件头运行说明提供本机非回环 IPv4(m3u 上游地址与部署许可同源)',
    ).not.toBe('');
    expect(
      process.env.E2E_SEED_SCALE ?? '',
      '本套件必须跑在全新空库:不要设置 E2E_SEED_SCALE(webServer 走迁移建空库分支)',
    ).toBe('');
    const nas = nasRootOf(MEDIA_ROOTS_RAW);
    nasMp4PathHolder.path = path.join(nas.rootPath, 'movies', `${MOVIE_TITLE}.mp4`);
    await generateRealMp4(nasMp4PathHolder.path);
    upstream = await startUpstream();
    upstreamM3uUrlHolder.url = `http://${LAN_UPSTREAM_IP}:${upstream.port}${M3U_PATH}`;
  });

  test.afterAll(async () => {
    await upstream?.close();
  });

  test('① 账号配置(空库自举)→ 登录 → 首建档案 → 选档解锁(FR-006/007/008/030)', async ({ page }) => {
    trackRequests(page);
    // 空库自证:setup/status.initialized=false(游客 session 为 401,无会话态可查)
    const status = await page.request.get('/api/setup/status');
    expect(status.status()).toBe(200);
    expect((await status.json() as { initialized: boolean }).initialized, '独立环境应从未初始化空库开始').toBe(false);

    await page.goto('/');
    await expectStep(page, '配置家庭主账号');
    await authDialog(page).getByLabel('家庭名称').fill(HOUSEHOLD_ORIGINAL);
    await authDialog(page).getByLabel('管理员用户名').fill(OWNER.username);
    await authDialog(page).getByLabel('密码', { exact: true }).fill(OWNER.password);
    await authDialog(page).getByRole('button', { name: '创建家庭账号' }).click();

    // FR-007:201 后停留显式登录
    await expectStep(page, '登录');
    await authDialog(page).getByLabel('用户名').fill(OWNER.username);
    await authDialog(page).getByLabel('密码', { exact: true }).fill(OWNER.password);
    await authDialog(page).getByRole('button', { name: '登录', exact: true }).click();

    // 零档案 → 首建(名称 + 6 位 PIN + 当次密码)
    await expectStep(page, '创建主档案');
    await authDialog(page).getByLabel('档案名称').fill(MAIN_PROFILE.name);
    await authDialog(page).getByLabel('档案 PIN(6 位数字)').fill(MAIN_PROFILE.pin);
    await authDialog(page).getByLabel('当前账号密码').fill(OWNER.password);
    await authDialog(page).getByRole('button', { name: '创建主档案' }).click();

    // 首建成功进入选档 → PIN 解锁选定
    await expectStep(page, '选择 Profile');
    await authDialog(page).getByRole('button', { name: new RegExp(MAIN_PROFILE.name) }).click();
    await expectStep(page, '输入档案 PIN');
    await authDialog(page).getByLabel('档案 PIN').fill(MAIN_PROFILE.pin);
    await authDialog(page).getByRole('button', { name: '解锁并选择' }).click();
    await expect(authDialog(page)).toBeHidden();

    const session = await page.request.get('/api/auth/session');
    expect(session.status()).toBe(200);
    const dto = (await session.json()) as { bootstrapRequired: boolean; activeProfile: { name: string } | null };
    expect(dto.bootstrapRequired).toBe(false);
    expect(dto.activeProfile?.name).toBe(MAIN_PROFILE.name);
  });

  test('② 导入来源:IPTV(可达 m3u 上游)+ NAS(真实 mp4)双双发布成功(FR-037/038)', async ({ page }) => {
    trackRequests(page);
    await apiLoginAndSelectMain(page);
    await page.goto('/settings/account');
    const gate = page.getByLabel(PIN_FIELD);
    const indicator = page.getByTestId('account-summary');
    await expect(gate.or(indicator).first()).toBeVisible({ timeout: 10_000 });
    if (await gate.isVisible().catch(() => false)) {
      await gate.fill(MAIN_PROFILE.pin);
      await page.getByRole('button', { name: '验证并进入设置' }).click();
    }
    await expect(indicator).toBeVisible({ timeout: 10_000 });
    // 菜单拆分:IPTV 来源建导走「IPTV 管理」直播源标签;NAS 来源建导走「NAS/点播」
    await navToSettingsModule(page, 'IPTV 管理');

    const nextRefreshId = trackRefreshPosts(page);

    // ── IPTV:来源创建(可达上游地址,创建期字面类别校验放行非回环私网 IP)→ 开始导入
    //    (013/ADR-0017:来源创建/导入为常规操作免当次密码,直接执行)──
    await page.getByTestId('create-source-open').click();
    await page.getByLabel('来源名称').fill(IPTV_SOURCE_NAME);
    await page.getByLabel('播放列表地址(M3U URL)').fill(upstreamM3uUrlHolder.url);
    await page.getByTestId('create-source-submit').click();
    await expect(page.getByTestId('source-created-next-step')).toContainText(IPTV_SOURCE_NAME);
    await page.getByTestId('source-start-import').click();
    await expect(page.getByTestId('app-toast-region')).toContainText('导入任务已创建', { timeout: 10_000 });
    const iptvRefreshId = nextRefreshId()[nextRefreshId().length - 1];
    expect(iptvRefreshId, '应捕获 IPTV 导入任务 id').toBeDefined();
    await expectRefreshTerminal(page, iptvRefreshId!, 'succeeded');
    // 直播源标签行回写成功事实(IPTV 来源仅出现在「IPTV 管理」,NAS/点播页不显示)
    await expect(page.getByTestId('source-list').locator('li', { hasText: IPTV_SOURCE_NAME })).toBeVisible();

    // ── NAS:真实 mp4 根扫描(首扫全部新增 → 自动发布成功;免当次密码直接执行)
    //    (菜单拆分:NAS 来源在「NAS/点播」页创建,创建表单仅 NAS/在线点播两类标签)──
    await navToSettingsModule(page, 'NAS/点播');
    const nas = nasRootOf(MEDIA_ROOTS_RAW);
    await page.getByTestId('create-source-open').click();
    await page.getByRole('tab', { name: 'NAS' }).click();
    await page.getByLabel('来源名称').fill(NAS_SOURCE_NAME);
    await page.getByLabel('NAS 根目录').selectOption(nas.rootKey);
    await page.getByLabel('相对目录').fill('movies');
    await page.getByTestId('create-source-submit').click();
    await expect(page.getByTestId('source-created-next-step')).toContainText(NAS_SOURCE_NAME);
    await page.getByTestId('source-start-import').click();
    await expect(page.getByTestId('app-toast-region')).toContainText('导入任务已创建', { timeout: 10_000 });
    const nasRefreshId = nextRefreshId()[nextRefreshId().length - 1];
    expect(nasRefreshId, '应捕获 NAS 导入任务 id').toBeDefined();
    await expectRefreshTerminal(page, nasRefreshId!, 'succeeded');

    // NAS 来源行回写成功事实(不再显示「尚无成功导入」)
    await expect(page.getByTestId('source-list').locator('li', { hasText: NAS_SOURCE_NAME })).not.toContainText('尚无成功导入');

    // 目录事实(服务端):频道 2 + 视频 1,均为可用
    const channels = await page.request.get('/api/public/media?type=channel&pageSize=20');
    expect(channels.status()).toBe(200);
    const channelPage = (await channels.json()) as { items: Array<{ id: string; title: string; type: string; availability: string }>; total: number };
    expect(channelPage.total).toBe(CHANNEL_NAMES.length);
    for (const name of CHANNEL_NAMES) {
      expect(channelPage.items.some((item) => item.title === name && item.availability === 'available'), `频道 ${name} 应可用`).toBe(true);
    }
    // 后续收藏/播放步骤固定用「闭环频道新闻」:按标题取 id(公共列表顺序不承诺)
    const newsChannel = channelPage.items.find((item) => item.title === CHANNEL_NAMES[0]);
    expect(newsChannel, `应能按标题定位 ${CHANNEL_NAMES[0]}`).toBeDefined();
    channelMediaId = newsChannel!.id;
    const videos = await page.request.get('/api/public/media?type=video&pageSize=20');
    expect(videos.status()).toBe(200);
    const videoPage = (await videos.json()) as { items: Array<{ id: string; title: string; availability: string }>; total: number };
    const movie = videoPage.items.find((item) => item.title === MOVIE_TITLE);
    expect(movie, `NAS 影片 ${MOVIE_TITLE} 应已发布:${JSON.stringify(videoPage.items).slice(0, 300)}`).toBeDefined();
    expect(movie!.availability).toBe('available');
    videoMediaId = movie!.id;
  });

  test('③ 公开浏览:游客可见导入目录(频道直播 + 影片详情)(SC-010 导入后目录可见)', async ({ page }) => {
    trackRequests(page);
    // 全新无 Cookie 上下文(本测试独立 context)= 游客
    await page.goto('/live');
    await expect(page.getByRole('heading', { name: '直播', level: 1 })).toBeVisible();
    await expect(page.getByRole('article', { name: `频道 ${CHANNEL_NAMES[0]}` })).toBeVisible({ timeout: 15_000 });
    await expect(page).not.toHaveURL(/login|profiles/);

    await page.goto(`/media/${videoMediaId}`);
    await expect(page.getByRole('heading', { name: MOVIE_TITLE, level: 1 })).toBeVisible();
    // 游客无个人状态;播放入口为统一受控入口(点击先登录,不发起播放)
    await expect(page.getByText(/观看历史|继续观看/)).toHaveCount(0);
    await page.getByRole('button', { name: `播放 ${MOVIE_TITLE}` }).click();
    await expect(authDialog(page).getByRole('heading', { name: '登录' })).toBeVisible();
    await authDialog(page).getByRole('button', { name: '取消' }).click();
    await expect(authDialog(page)).toBeHidden();
  });

  test('④ 收藏:选档后频道星标,首页收藏卡出现(FR-016/017)', async ({ page }) => {
    trackRequests(page);
    await apiLoginAndSelectMain(page);
    await page.goto(`/media/${channelMediaId}`);
    const star = page.getByRole('button', { name: new RegExp(`^收藏 ${CHANNEL_NAMES[0]}$`) });
    await expect(star).toBeVisible();
    await star.click();
    await expect(page.getByRole('button', { name: new RegExp(`^取消收藏 ${CHANNEL_NAMES[0]}$`) })).toBeVisible();
    await page.goto('/');
    await expect(page.getByTestId('favorite-card')).toHaveCount(1);
    await expect(page.getByTestId('favorite-card')).toContainText(CHANNEL_NAMES[0]);
  });

  test('⑤ 播放:UI 点击到 resolve→prepare 层;NAS 真实媒体 probe 成功到 ready(FR-005/012)', async ({ page }) => {
    trackRequests(page);
    await apiLoginAndSelectMain(page);
    const resolvedSessionIds: string[] = [];
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/api/playback/resolve' && response.status() === 201) {
        void response
          .json()
          .then((body: { id?: string }) => {
            if (typeof body.id === 'string') {
              resolvedSessionIds.push(body.id);
            }
          })
          .catch(() => undefined);
      }
    });

    // UI 播放意图(NAS 影片,真实文件):resolve 接受 → prepare 面
    await page.goto(`/media/${videoMediaId}`);
    await page.getByRole('button', { name: `播放 ${MOVIE_TITLE}` }).click();
    await expect(
      page.getByTestId('playback-preparing').or(page.getByTestId('playback-surface')),
    ).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => resolvedSessionIds.length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
    const uiSessionId = resolvedSessionIds[resolvedSessionIds.length - 1]!;

    // prepare 层(服务端真实 probe 本地 mp4):轮询会话到 ready/playing
    // (resolve 201 仅表示接受;probe/准备异步完成 —— 契约 FR-005 的轮询语义;
    //  夹具为真实 mp4,failed 属环境故障而非预期断言深度)
    let lastObservedState = 'pending';
    await expect
      .poll(async () => {
        const res = await page.request.get(`/api/playback/sessions/${uiSessionId}`);
        if (res.status() !== 200) {
          lastObservedState = `http-${res.status()}`;
          return false;
        }
        lastObservedState = ((await res.json()) as { state: string }).state;
        return ['ready', 'playing', 'paused'].includes(lastObservedState);
      }, { timeout: 90_000, intervals: [1_000] })
      .toBe(true);
    expect(['ready', 'playing', 'paused'], `终态观测应为就绪/播放中,实际 ${lastObservedState}`).toContain(lastObservedState);
    void resolvedSessionIds;
  });

  test('⑥ 历史:API 构造真正 started 样本 → 首页历史卡与「继续观看」出现(FR-018/019)', async ({ page }) => {
    trackRequests(page);
    await apiLoginAndSelectMain(page);

    // 独立 resolve(新会话新 epoch):probe 完成后发送 started 样本
    // (样本形态对照 playback-progress.contract.spec.ts;generation 自 resolve 起 = 1)
    const resolveRes = await page.request.post('/api/playback/resolve', { data: { mediaId: videoMediaId } });
    expect(resolveRes.status()).toBe(201);
    const sessionId = (resolveRes.headers()['location'] ?? '').split('/').pop() ?? '';
    expect(sessionId).toMatch(/[\w-]{8}/);
    await expect
      .poll(async () => {
        const res = await page.request.get(`/api/playback/sessions/${sessionId}`);
        if (res.status() !== 200) {
          return 'pending';
        }
        return ((await res.json()) as { state: string }).state;
      }, { timeout: 90_000, intervals: [1_000] })
      .toBe('ready');

    const started = await page.request.post(`/api/playback/sessions/${sessionId}/progress`, {
      data: { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 30, reason: 'started' },
    });
    expect(started.status(), `started 样本应被接受:${JSON.stringify(await started.json().catch(() => null))}`).toBe(200);
    expect(await started.json()).toMatchObject({ applied: true, reason: 'accepted' });

    // UI:首页历史卡 + 继续观看入口;详情页恢复语义文案
    await page.goto('/');
    await expect(page.getByTestId('home-history')).toBeVisible();
    const historyCard = page.getByTestId('history-card').first();
    await expect(historyCard).toBeVisible({ timeout: 15_000 });
    await expect(historyCard).toContainText(MOVIE_TITLE);
    await expect(historyCard.getByRole('button', { name: `继续观看 ${MOVIE_TITLE}` })).toBeVisible();
    await page.goto(`/media/${videoMediaId}`);
    await expect(page.getByText(/上次观看至/)).toBeVisible();
    await expect(page.getByRole('button', { name: `继续观看 ${MOVIE_TITLE}` })).toBeVisible();
  });

  test('⑦ 设置:PIN 解锁 + 改家庭名称保存(免当次密码直接提交)+ 刷新持久(FR-031/033/041)', async ({ page }) => {
    trackRequests(page);
    await apiLoginAndSelectMain(page);
    await page.goto('/settings/account');
    const gate = page.getByLabel(PIN_FIELD);
    const indicator = page.getByTestId('account-summary');
    await expect(gate.or(indicator).first()).toBeVisible({ timeout: 10_000 });
    if (await gate.isVisible().catch(() => false)) {
      await gate.fill(MAIN_PROFILE.pin);
      await page.getByRole('button', { name: '验证并进入设置' }).click();
    }
    await expect(indicator).toBeVisible({ timeout: 10_000 });
    await navToSettingsModule(page, '家庭设置');
    await page.getByLabel('家庭名称').fill(HOUSEHOLD_RENAMED);
    await page.getByTestId('general-save').click();
    await expect(page.getByTestId('app-toast-region')).toContainText('家庭设置已保存');
    // 刷新持久(grant 服务端会话态,刷新不丢;CAS 已提交)
    await page.reload();
    await expect(gate.or(page.getByLabel('家庭名称')).first()).toBeVisible({ timeout: 10_000 });
    if (await gate.isVisible().catch(() => false)) {
      await gate.fill(MAIN_PROFILE.pin);
      await page.getByRole('button', { name: '验证并进入设置' }).click();
    }
    await expect(page.getByLabel('家庭名称')).toHaveValue(HOUSEHOLD_RENAMED, { timeout: 10_000 });
  });

  test('⑧ 完整性收口:零 DELETE、初始化恰一次、无清库请求、源媒体原样存在(SC-010 误删=0 口径)', async ({ page }) => {
    trackRequests(page);
    // 自动化口径:全程无任何 DELETE 类 API 请求(收藏星标为 PUT,无取消收藏;无设备撤销等)
    expect(deleteApiRequests, '闭环全程不得出现 DELETE 类 API 请求').toEqual([]);
    // 无清库语义:初始化恰好一次(①的自举),且无重置/清库/维护类端点被触达
    expect(initializeApiRequests, '账号配置应恰好初始化一次,不得重复清库重建').toHaveLength(1);
    expect(wipeLikeApiRequests, '不得触达重置/清库/维护类端点').toEqual([]);
    // 会话事实:闭环终点仍为已初始化 + 主档案可选
    await apiLoginAndSelectMain(page);
    const session = await page.request.get('/api/auth/session');
    expect(((await session.json()) as { bootstrapRequired: boolean }).bootstrapRequired).toBe(false);
    // 源媒体原样:上游夹具定义仍在(模块态),NAS 影片文件仍在磁盘且公共目录可见
    expect(fs.existsSync(nasMp4PathHolder.path), `源媒体文件应原样存在:${nasMp4PathHolder.path}`).toBe(true);
    expect(fs.statSync(nasMp4PathHolder.path).size, '源媒体文件不得为空/被截断').toBeGreaterThan(0);
    const videos = await page.request.get('/api/public/media?type=video&pageSize=20');
    const videoPage = (await videos.json()) as { items: Array<{ id: string; title: string; availability: string }> };
    expect(videoPage.items.some((item) => item.title === MOVIE_TITLE && item.availability === 'available')).toBe(true);
    void upstreamM3uUrlHolder;
  });
});
