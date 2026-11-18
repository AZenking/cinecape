import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * 015 T023 · 端到端走查(live-flow-redesign;quickstart.md 场景 1→5 全旅程):
 *
 * - Screen 1 `/live`:LiveHeroPlayer 直接播放大屏(data-testid=live-hero-player)→
 *   正在直播行 → 即将播放行 → 各分类泳道(行名 = 分组名 `${label}`)自上而下;
 *   卡片 hover 浮现中央 ▶(015 T004 双层交互),点击直接起播(游客 → 统一登录
 *   弹层,授权前零媒体流请求);
 * - 智能分流(FR-003/FR-004):正在直播行尾「查看全部」直达 `/live/guide`;
 *   分类行尾「全部XX频道 ›」直达 `/live/channels?group=:key` 且分类 Tab 自动激活;
 * - Screen 3 `/live/guide`:NOW 垂直红线可见;与 NOW 相交的 current 块(绿色 LIVE
 *   角标,aria-label 以「,正在直播」结尾)点击直接起播链路(游客 → 认证 Modal);
 * - Screen 4 `/live/watch/:channelId`:进入即自动起播(播放面出现),右侧伴随信息
 *   (当前节目/进度/收藏/Next);底部同类型直播横条点击另一卡片 → URL 静默 replace
 *   为新频道且零整页重载(window 探针存活断言);
 * - Screen 2 `/live/channels`:搜索关键字过滤(300ms 防抖写 ?q=,期望源=服务端
 *   section=group 响应)、Tab 切换 URL 同步;
 * - 游客意图链(US5):游客点击 Hero/卡片播放 → 认证 Modal → 登录选档 → 自动恢复
 *   原目标起播;取消则停留原页零播放(FR-014;SC-005 授权前零媒体请求)。
 *
 * 前置(与既有 live/guide 套件同约定):`E2E_SEED_SCALE=1` 种子 T012 规模夹具
 * (200 频道/67,200 排期;凭据 fixtureadmin/password-123,主档案 PIN 135790),
 * 服务端时钟锚定 SCALE_FIXTURE_FIXED_NOW_MS(2026-11-04T12:05Z = 20:05 CST)。
 * 分类标签数据驱动(夹具分组为 央视/卫视/影视/体育…,quickstart 示例的「电影」
 * 在不同数据栈下标签可变,断言以 API 分组清单为期望源,不锚定具体标签)。
 * 夹具媒体源不可达:起播断言到「resolve 接受 → 播放面呈现」层(与 playback-intent
 * 同深度),真实交付链归 ADR-0009 runtime 基线。
 */

/** 认证弹层(HeroUI Modal data-slot;与播放面 data-testid 区分) */
function authDialog(page: Page): Locator {
  return page.locator('[role="dialog"][data-slot="modal-dialog"]');
}

/** 收集媒体流/播放特征请求(授权前必须为 0;排除 dev server 的 .ts 模块地址) */
function trackMediaRequests(page: Page): { readonly urls: string[] } {
  const urls: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/playback') || url.includes('ticket=') || /\.m3u8(\?|$)|\.mp4(\?|$)/.test(url)) {
      urls.push(url);
    }
  });
  return { urls };
}

interface ApiChannelRow {
  media: { id: string; title: string; type: string; availability: string };
  groupKey: string;
  groupLabel: string;
  current: { key: string; title: string; startsAt: string; endsAt: string } | null;
  next: { key: string; title: string; startsAt: string; endsAt: string } | null;
}

async function fetchJson<T>(request: Page['request'], url: string): Promise<T> {
  const response = await request.get(url);
  expect(response.status()).toBe(200);
  return (await response.json()) as T;
}

/** API 登录 + 选主档案(真实链路;cookie 落在 page 所属 context;live-player-continuity 同款) */
async function apiLoginAndSelectMain(page: Page): Promise<void> {
  const login = await page.request.post('/api/auth/login', {
    data: { username: 'fixtureadmin', password: 'password-123', deviceType: 'web', deviceName: 'e2e-015-t023' },
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

/** 播放意图面:authorize/prepare 为非阻塞面板,playing/unavailable 为全屏面 */
async function expectPlaybackFace(page: Page): Promise<void> {
  await expect(
    page.getByTestId('playback-preparing').or(page.getByTestId('playback-surface')),
  ).toBeVisible({ timeout: 20_000 });
}

/** 卡片 hover 后中央 ▶ 淡入(015 T004):computed opacity → 1(hover 态可点) */
async function hoverRevealPlay(page: Page, card: Locator): Promise<Locator> {
  const hoverPlay = card.locator('button[aria-label^="播放 "]:not([aria-label$="当前直播"])');
  await card.hover();
  await expect
    .poll(
      async () =>
        hoverPlay.evaluate((element) => {
          const computed = getComputedStyle(element);
          return `${computed.opacity} ${computed.pointerEvents}`;
        }),
      { timeout: 5_000 },
    )
    .toMatch(/^1 auto$/);
  return hoverPlay;
}

test.describe('015 T023 · 直播全流程重构走查(quickstart 场景 1→5)', () => {
  test('场景 1 · Screen 1:Hero 大屏 + 三区泳道顺序 + 卡片 hover ▶ 直接起播', async ({ page }) => {
    const media = trackMediaRequests(page);
    await page.goto('/live');

    // 顶部 Hero 直接播放大屏容器(015 T008;FR-002):容器 + LIVE 标注 + 主操作
    const hero = page.getByTestId('live-hero-player');
    await expect(hero).toBeVisible({ timeout: 30_000 });
    await expect(hero.getByTestId('live-hero-live-badge')).toContainText('正在直播');
    await expect(hero.getByRole('button', { name: /^直接收看/ })).toBeVisible();

    // 三区顺序:正在直播 → 即将播放 → 各分类正在直播(Hero 之下自上而下;FR-001)
    const orderOf = async (locatorText: string): Promise<number> => {
      const element = page.getByRole('heading', { name: locatorText }).first();
      await element.waitFor();
      return (await element.boundingBox())?.y ?? Number.POSITIVE_INFINITY;
    };
    const heroY = (await hero.boundingBox())?.y ?? 0;
    const nowY = await orderOf('正在直播');
    const nextY = await orderOf('即将播放');
    const groupY = await orderOf('各分类正在直播');
    expect(heroY).toBeLessThan(nowY);
    expect(nowY).toBeLessThan(nextY);
    expect(nextY).toBeLessThan(groupY);

    // 分类泳道行名 = 分组名本身 `${label}`(不拼「· 正在直播」;数据驱动,不锚定具体标签)
    const groups = await fetchJson<{ items: Array<{ key: string; label: string }> }>(
      page.request,
      '/api/public/live/groups',
    );
    expect(groups.items.length).toBeGreaterThan(0);
    const firstLabel = groups.items[0]!.label;
    await expect(page.getByRole('region', { name: firstLabel, exact: true })).toBeVisible();

    // 卡片 hover → 中央 ▶ 平滑浮现(FR-005);点击直接起播:游客 → 认证 Modal,
    // 授权前零媒体流请求(不进入静态二级详情页;SC-001 路径长度 1 次点击)
    const card = page.getByRole('region', { name: '正在直播', exact: true }).locator('article').first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    const hoverPlay = await hoverRevealPlay(page, card);
    await hoverPlay.click();
    const dialog = authDialog(page);
    await expect(dialog.getByRole('heading', { name: '登录' })).toBeVisible();
    expect(media.urls).toEqual([]);
    expect(new URL(page.url()).pathname).toBe('/live'); // 不导航二级页
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toBeHidden();
    expect(media.urls).toEqual([]);
  });

  test('场景 2 · 分流:Live 行尾 → /live/guide;分类行尾 → /live/channels?group= 且 Tab 激活', async ({ page }) => {
    await page.goto('/live');
    const nowRegion = page.getByRole('region', { name: '正在直播', exact: true });
    await expect(nowRegion.locator('article').first()).toBeVisible({ timeout: 30_000 });

    // FR-003:正在直播行尾「查看全部」直达 EPG 节目单时间墙
    await nowRegion.getByRole('button', { name: '查看全部' }).click();
    await expect(page).toHaveURL(/\/live\/guide$/);

    // FR-004:分类行尾「全部XX频道 ›」直达分类平铺网格,URL 携带 ?group=:key
    await page.goto('/live');
    const groups = await fetchJson<{ items: Array<{ key: string; label: string }> }>(
      page.request,
      '/api/public/live/groups',
    );
    const target = groups.items[0]!;
    const categoryRow = page.getByRole('region', { name: target.label, exact: true });
    await expect(categoryRow).toBeVisible({ timeout: 30_000 });
    await categoryRow.getByRole('button', { name: `全部${target.label}频道 ›` }).click();
    await expect(page).toHaveURL(new RegExp(`/live/channels\\?group=${target.key}$`));

    // Screen 2:?group= → 对应分类 Tab 自动高亮(无需二次点击)
    const tab = page.getByRole('tab', { name: target.label });
    await expect(tab).toBeVisible({ timeout: 15_000 });
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  });

  test('场景 3 · Screen 3:NOW 线可见,current 块点击直接起播(游客 → 认证 Modal)', async ({ page }) => {
    const media = trackMediaRequests(page);
    await page.goto('/live/guide');
    const wall = page.getByRole('region', { name: '节目墙' });
    await expect(wall).toBeVisible({ timeout: 30_000 });

    // NOW 垂直红线(纵贯节目网格的当前时刻指示;种子锚定 20:05 CST 起随真实时间流动)
    await expect(page.getByRole('status', { name: /当前时间 \d{2}:\d{2}/ })).toBeVisible();

    // 与 NOW 相交的 current 块(LIVE 角标,aria-label 以「,正在直播」结尾)存在且可点
    const currentBlock = wall.locator('button[data-programme-key][aria-label$=",正在直播"]').first();
    await expect(currentBlock).toBeVisible({ timeout: 30_000 });
    // 点击走 dispatchEvent(既有 guide 套件同款):首次定位把 NOW 锚在视口左侧,
    // current 块与 sticky 频道列(z-10)重叠,常规 click 的命中检测会被 sticky 列
    // 拦截重试超时;dispatchEvent 直发 DOM click 事件,真实触发同一条 onClick 链路
    await currentBlock.dispatchEvent('click');

    // 起播链路触发:游客 → 统一认证 Modal;授权前零媒体流请求(FR-008/FR-014)
    const dialog = authDialog(page);
    await expect(dialog.getByRole('heading', { name: '登录' })).toBeVisible();
    expect(media.urls).toEqual([]);
    expect(new URL(page.url()).pathname).toBe('/live/guide');
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toBeHidden();
    expect(media.urls).toEqual([]);
  });

  test('场景 4 · Screen 4:一体化播放页伴随信息 + 同类型横条就地换台(零整页重载)', async ({ page }) => {
    test.setTimeout(120_000);
    await apiLoginAndSelectMain(page);

    // 选取一个同分组 ≥2 频道的频道(保证同类换台有目标;数据驱动,不锚定频道名)
    const rows = await fetchJson<{ items: ApiChannelRow[] }>(
      page.request,
      '/api/public/live/channels?section=all&page=1&pageSize=50',
    );
    const groupSizes = new Map<string, number>();
    for (const row of rows.items) {
      groupSizes.set(row.groupKey, (groupSizes.get(row.groupKey) ?? 0) + 1);
    }
    const origin = rows.items.find((row) => (groupSizes.get(row.groupKey) ?? 0) >= 2);
    expect(origin, '夹具应存在同分组 ≥2 频道的频道(同类换台目标)').toBeDefined();

    // 进入一体化播放页:进入即自动起播(FR-010;播放面 = 全局播放面浮层)
    const resolves: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/playback/resolve') {
        resolves.push(request.url());
      }
    });
    await page.goto(`/live/watch/${origin!.media.id}`);
    await expect(page.getByTestId('live-watch-page')).toBeVisible({ timeout: 30_000 });
    await expectPlaybackFace(page);
    await expect
      .poll(() => resolves.length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);

    // 右侧伴随信息(FR-011):频道名/当前节目/进度/收藏/Next 齐备
    const meta = page.getByTestId('watch-meta-panel');
    await expect(meta).toBeVisible();
    await expect(meta.getByRole('heading', { level: 1 })).toContainText(origin!.media.title);
    await expect(meta.getByRole('region', { name: '当前节目' })).toContainText(origin!.current?.title ?? '暂无节目单');
    await expect(meta.getByRole('button', { name: `收藏 ${origin!.media.title}` })).toBeVisible();
    await expect(meta.getByRole('region', { name: '即将播放 (Next)' })).toBeVisible();

    // 底部同类型直播横条(FR-012)→ 点击另一卡片就地换台(FR-013):
    // URL 静默 replace 为新频道 + 零整页重载(window 探针存活)+ 面板即时联动
    const strip = page.getByTestId('same-type-live-strip');
    await expect(strip).toBeVisible({ timeout: 30_000 });
    // 同类目标以服务端同类响应为期望源(排除当前频道;不锚定频道名)
    const siblings = await fetchJson<{ items: ApiChannelRow[] }>(
      page.request,
      `/api/public/live/channels?section=group&groupKey=${origin!.groupKey}&page=1&pageSize=50`,
    );
    const targetRow = siblings.items.find((row) => row.media.id !== origin!.media.id);
    expect(targetRow, '同类型横条应提供非当前频道的换台目标').toBeDefined();

    await page.evaluate(() => {
      (window as { __t023Probe?: string }).__t023Probe = 'alive';
    });
    const resolvesBefore = resolves.length;
    await strip.getByRole('button', { name: `切换到 ${targetRow!.media.title}` }).click();
    await expect(page).toHaveURL(new RegExp(`/live/watch/${targetRow!.media.id}$`));
    // 零整页重载:探针仍存活(SPA 内 navigate replace,页面组件不卸载;SC-004)
    expect(await page.evaluate(() => (window as { __t023Probe?: string }).__t023Probe)).toBe('alive');
    // 播放器就地切流:换台发起新 resolve 意图(新会话),播放面持续存活
    await expect
      .poll(() => resolves.length, { timeout: 15_000 })
      .toBeGreaterThan(resolvesBefore);
    await expectPlaybackFace(page);
    // 右侧伴随信息即时联动为新频道(FR-013)
    await expect(meta.getByRole('heading', { level: 1 })).toContainText(targetRow!.media.title, { timeout: 15_000 });
  });

  test('场景 5 · Screen 2:搜索即时过滤(?q= 防抖写 URL,期望源=服务端)+ Tab 切换 URL 同步', async ({ page }) => {
    const groups = await fetchJson<{ items: Array<{ key: string; label: string }> }>(
      page.request,
      '/api/public/live/groups',
    );
    const target = groups.items[0]!;
    await page.goto(`/live/channels?group=${target.key}`);
    await expect(page.getByRole('tab', { name: target.label })).toHaveAttribute('aria-selected', 'true', {
      timeout: 15_000,
    });

    // 搜索关键字 → 网格即时过滤(300ms 防抖写 ?q=;DOM 与服务端同参响应一致)
    const searchBox = page.getByPlaceholder('按频道名称搜索');
    await searchBox.fill('夹具频道 00');
    await expect(page).toHaveURL(/q=/, { timeout: 10_000 });
    const expected = await fetchJson<{ items: ApiChannelRow[]; total: number }>(
      page.request,
      `/api/public/live/channels?section=group&groupKey=${target.key}&page=1&pageSize=50&q=${encodeURIComponent('夹具频道 00')}`,
    );
    const grid = page.getByRole('region', { name: `${target.label} · 频道` });
    await expect(grid.locator('article').first()).toBeVisible({ timeout: 30_000 });
    // 等过滤落地(300ms 防抖 + 换键请求;keepPreviousData 会短暂保留旧网格)
    await expect(grid.locator('article')).toHaveCount(expected.items.length, { timeout: 15_000 });
    const domTitles = await grid.locator('article').evaluateAll((articles) =>
      articles.map((article) => article.getAttribute('aria-label') ?? ''),
    );
    expect(domTitles).toEqual(expected.items.map((row) => `频道 ${row.media.title}`));

    // 一键清空(HeroUI SearchField 内置清除)
    await page.getByRole('button', { name: '清空搜索' }).click();
    await expect(page).toHaveURL(new RegExp(`/live/channels\\?group=${target.key}$`), { timeout: 10_000 });

    // 切 Tab → URL 同步(切回「全部」不带 group 参数;网格无整页刷新更新)
    await page.getByRole('tab', { name: '全部' }).click();
    await expect(page).toHaveURL(/\/live\/channels$/, { timeout: 10_000 });
    await expect(page.getByRole('tab', { name: '全部' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('region', { name: '全部频道' })).toBeVisible({ timeout: 30_000 });
  });

  test('场景 5 · 游客意图链:Hero 播放 → 认证 Modal → 登录选档 → 自动起播原目标', async ({ page }) => {
    const media = trackMediaRequests(page);
    await page.goto('/live');
    const hero = page.getByTestId('live-hero-player');
    await expect(hero).toBeVisible({ timeout: 30_000 });

    // 游客点击 Hero 主播放操作:统一认证 Modal;授权前零媒体流请求(SC-005)
    const playButton = hero.getByRole('button', { name: /^直接收看/ });
    const targetTitle = ((await playButton.getAttribute('aria-label')) ?? '').replace(/^直接收看\s*/, '');
    expect(targetTitle.length).toBeGreaterThan(0);
    await playButton.click();
    const dialog = authDialog(page);
    await expect(dialog.getByRole('heading', { name: '登录' })).toBeVisible();
    expect(media.urls).toEqual([]);

    // 登录 → 选主档案(PIN)→ 弹层自动关闭
    await dialog.getByLabel('用户名').fill('fixtureadmin');
    await dialog.getByLabel('密码', { exact: true }).fill('password-123');
    await dialog.getByRole('button', { name: '登录', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: '选择 Profile' })).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole('button', { name: /主档案/ }).click();
    await expect(dialog.getByRole('heading', { name: '输入档案 PIN' })).toBeVisible({ timeout: 15_000 });
    await dialog.getByLabel('档案 PIN').fill('135790');
    await dialog.getByRole('button', { name: '解锁并选择' }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // 自动恢复最初点击的目标并起播(FR-014):播放面出现,标题=原目标频道
    await expectPlaybackFace(page);
    const surface = page.getByTestId('playback-surface');
    await expect(surface.getByRole('heading', { level: 2 })).toContainText(targetTitle, { timeout: 30_000 });
    await expect
      .poll(() => media.urls.some((url) => url.includes('/api/playback/resolve')), { timeout: 15_000 })
      .toBe(true);
  });

  test('场景 5 · 取消分支:认证 Modal 关闭后停留原视口,零后台播放', async ({ page }) => {
    const media = trackMediaRequests(page);
    await page.goto('/live');
    const card = page.getByRole('region', { name: '正在直播', exact: true }).locator('article').first();
    await expect(card).toBeVisible({ timeout: 30_000 });

    const hoverPlay = await hoverRevealPlay(page, card);
    await hoverPlay.click();
    const dialog = authDialog(page);
    await expect(dialog.getByRole('heading', { name: '登录' })).toBeVisible();
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toBeHidden();

    // 平滑停留原页:URL 不变、弹层不重开、零播放/媒体请求(FR-014 验收 4)
    expect(new URL(page.url()).pathname).toBe('/live');
    await page.waitForTimeout(800);
    await expect(authDialog(page)).toHaveCount(0);
    expect(media.urls).toEqual([]);
  });
});
