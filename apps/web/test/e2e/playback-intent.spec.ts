import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * T049(005 US3 e2e,先 FAIL):游客继续原目标与竞态负向(SC-003 游客点击与竞态场景)。
 *
 * 运行方式:`cd apps/web && E2E_SEED_SCALE=1 pnpm exec playwright test test/e2e/playback-intent.spec.ts`
 * (E2E_SEED_SCALE=1:scripts/e2e-servers.sh 种子 T012 规模夹具,凭据 fixtureadmin/password-123,
 *  主档案 PIN 135790、儿童档案 PIN 246800。)
 *
 * 断言深度说明:夹具媒体源指向不可达地址(iptv.scale-fixture.test / /nas-media/…),
 * 真实媒体交付链已在 004 runtime/契约层覆盖(ADR-0009 基线);本套件断言到
 * 「resolve 接受 → 进入 prepare → 稳定拒绝/不可播放提示」层面,不依赖 FFmpeg 产出真实流。
 *
 * 覆盖:
 * - 游客点直播/点播详情播放 → 完成登录选档 → 继续原频道/原媒体(无需重找);
 *   登录选档完成前零 /playback/ 请求(更无媒体分段请求);
 * - 取消登录:弹层关闭、零 /playback/ 与媒体请求、不重复弹窗;
 * - 准备中连点/换目标:仅最新意图可起播(播放面标题=最后目标);
 * - 退出/换档后:播放面停止,旧会话读取被拒(401 / 404 PLAYBACK_NOT_FOUND 同形)。
 */

// 认证弹层定位:HeroUI Modal 的 Dialog 带 data-slot="modal-dialog";
// 播放面(协调器全屏挂载)同为 role="dialog",以 data-testid 区分,不能混用
const DIALOG = '[role="dialog"][data-slot="modal-dialog"]';

function dialogOf(page: Page): Locator {
  return page.locator(DIALOG);
}

async function expectStep(page: Page, title: string): Promise<void> {
  await expect(dialogOf(page).getByRole('heading', { name: title, exact: true })).toBeVisible();
}

/** 收集 /api/playback/* 请求与 resolve 响应会话 id(断言与终止核对用) */
function trackPlayback(page: Page): {
  readonly playbackRequests: string[];
  readonly resolvedSessionIds: () => readonly string[];
} {
  const playbackRequests: string[] = [];
  const sessionIds: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/playback/')) {
      playbackRequests.push(url.pathname);
    }
  });
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (url.pathname === '/api/playback/resolve' && response.status() === 201) {
      try {
        const body = (await response.json()) as { id?: string };
        if (typeof body.id === 'string') {
          sessionIds.push(body.id);
        }
      } catch {
        // 响应体读取失败不影响请求序列断言
      }
    }
  });
  return { playbackRequests, resolvedSessionIds: () => sessionIds };
}

/** 登录 → 选档主档案(受 PIN 保护)→ 弹层关闭 */
async function loginAndSelectMain(page: Page, pin: string): Promise<void> {
  await expectStep(page, '登录');
  await dialogOf(page).getByLabel('用户名').fill('fixtureadmin');
  await dialogOf(page).getByLabel('密码', { exact: true }).fill('password-123');
  await dialogOf(page).getByRole('button', { name: '登录', exact: true }).click();
  await expectStep(page, '选择 Profile');
  await dialogOf(page).getByRole('button', { name: /主档案/ }).click();
  await expectStep(page, '输入档案 PIN');
  await dialogOf(page).getByLabel('档案 PIN').fill(pin);
  await dialogOf(page).getByRole('button', { name: '解锁并选择' }).click();
  await expect(dialogOf(page)).toBeHidden({ timeout: 15_000 });
}

/** 经身份菜单程序化桥退出(与 IdentityMenu 同一 useSession().logout 代码路径) */
async function logout(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('hmp:auth-intent', { detail: { action: 'logout' } }));
  });
  await expect
    .poll(async () => (await page.request.get('/api/auth/session')).status(), { timeout: 10_000 })
    .toBe(401);
}

/** 经身份菜单程序化桥发起切档(打开选档弹层) */
async function openProfileSwitch(page: Page): Promise<Locator> {
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('hmp:auth-intent', { detail: { action: 'profile-selection' } }));
  });
  await expectStep(page, '选择 Profile');
  return dialogOf(page);
}

/** 打开登录弹层:/setup/status 偶发慢或公共限频(429→setup-unavailable 面)时按既有重试面恢复 */
async function openLoginModal(page: Page): Promise<void> {
  const dialog = dialogOf(page);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await page.getByRole('button', { name: '登录' }).first().click();
    try {
      await expect(dialog.getByRole('heading', { name: '登录', exact: true })).toBeVisible({ timeout: 8_000 });
      return;
    } catch {
      // 限频/瞬时失败呈现「初始化状态未知」重试面(不误判未初始化,FR-006):
      // 等待限频窗口滑动后点弹层自带「重试」
      const retry = dialog.getByRole('button', { name: '重试' });
      if (await retry.isVisible().catch(() => false)) {
        await page.waitForTimeout(4_000);
        await retry.click();
        continue;
      }
      const cancel = dialog.getByRole('button', { name: '取消' });
      if (await cancel.isVisible().catch(() => false)) {
        await cancel.click();
      }
      await page.waitForTimeout(1_000);
    }
  }
  await expectStep(page, '登录');
}

/** 确保已登录并选择主档案(串行套件内共享上下文;游客则现场完成登录选档)。
 *  一轮失败(reload 重置协调器状态)后整轮重试;仍失败则抛出暴露原因。 */
async function ensureAuthenticated(page: Page): Promise<void> {
  for (let round = 0; round < 2; round += 1) {
    const status = await page.request.get('/api/auth/session');
    if (status.status() === 200) {
      return;
    }
    try {
      await openLoginModal(page);
      await loginAndSelectMain(page, '135790');
      return;
    } catch {
      await page.reload();
      await page.waitForTimeout(1_000);
    }
  }
  await openLoginModal(page);
  await loginAndSelectMain(page, '135790');
}

/** 播放意图面:authorize/prepare 为非阻塞面板,playing/unavailable 为全屏面 */
async function expectPlaybackFace(page: Page): Promise<void> {
  await expect(
    page.getByTestId('playback-preparing').or(page.getByTestId('playback-surface')),
  ).toBeVisible({ timeout: 15_000 });
}

/** 等待全屏播放面出现并返回其标题文本(playing/unavailable 共用同一标题头) */
async function surfaceTitle(page: Page): Promise<string> {
  const surface = page.getByTestId('playback-surface');
  await expect(surface).toBeVisible({ timeout: 20_000 });
  const heading = surface.getByRole('heading', { level: 2 });
  await expect(heading).toBeVisible();
  return (await heading.textContent()) ?? '';
}

/** 播放意图面完全退场(authorize/prepare 面板与全屏面都消失) */
async function expectPlaybackGone(page: Page): Promise<void> {
  await expect(page.getByTestId('playback-preparing')).toBeHidden({ timeout: 10_000 });
  await expect(page.getByTestId('playback-surface')).toBeHidden({ timeout: 10_000 });
}

test.describe.serial('T049 · 从任何页面发起同一套受控播放(SC-003)', () => {
  // probe 对不可达夹具源的失败时长取决于环境 DNS/连接超时(004 预算 30 秒),
  // 用例超时留足准备窗口
  test.setTimeout(180_000);

  let firstChannelTitle = '';

  test('游客点直播播放 → 登录选档 → 继续原频道(登录前零 /playback/ 请求)', async ({ page }) => {
    const tracked = trackPlayback(page);
    await page.goto('/live');

    // 直播卡片播放按钮(正在直播区/全部区均为统一 PlayButton 入口)
    const playButtons = page.getByRole('button', { name: /当前直播/ });
    await expect(playButtons.first()).toBeVisible({ timeout: 15_000 });
    firstChannelTitle = ((await playButtons.first().getAttribute('aria-label')) ?? '')
      .replace(/^播放\s*/, '')
      .replace(/\s*当前直播$/, '');
    expect(firstChannelTitle.length).toBeGreaterThan(0);

    // 游客点击:进入登录意图;此刻必须零 /playback/ 请求(FR-011)
    await playButtons.first().click();
    await expectStep(page, '登录');
    expect(tracked.playbackRequests).toEqual([]);

    // 完成登录选档(主档案 PIN)→ 弹层关闭
    await loginAndSelectMain(page, '135790');

    // 继续原目标:播放意图面出现(先 prepare 面板);最终全屏面标题 = 点击的频道
    // (无需重找内容;US3 场景 1)
    await expectPlaybackFace(page);
    const title = await surfaceTitle(page);
    expect(title).toContain(firstChannelTitle);

    // 选档完成后才有播放请求:首条 /playback/ 请求发生于 resolve(接受 → prepare)
    await expect
      .poll(() => tracked.playbackRequests.some((path) => path === '/api/playback/resolve'), { timeout: 15_000 })
      .toBe(true);
    expect(tracked.resolvedSessionIds().length).toBeGreaterThanOrEqual(1);

    // 断言深度(夹具源不可达,真实交付链归 004 runtime):resolve 已接受 → 进入 prepare;
    // probe 稳定失败后呈现不可播放提示。probe 失败时长随环境(DNS/连接超时)浮动,
    // 两态任一即视为契约达成 —— 全程不得出现媒体分段请求或内部信息泄露。
    const surface = page.getByTestId('playback-surface');
    const unavailable = surface.getByText(/当前不可播放|不可用|终止|中断|超时/).first();
    let stableRejected = true;
    try {
      await expect(unavailable).toBeVisible({ timeout: 40_000 });
    } catch {
      // probe 仍在预算窗口内:断言停留在受控 prepare 面(resolve 已接受)
      stableRejected = false;
      await expect(surface.getByText(/正在准备播放|正在请求播放授权/).first()).toBeVisible({ timeout: 10_000 });
    }
    void stableRejected;
    const surfaceText = (await surface.textContent()) ?? '';
    expect(surfaceText).not.toContain('scale-fixture.test');
    expect(surfaceText).not.toContain('ticket=');
    expect(surfaceText).not.toContain('/nas-media');
    void stableRejected;
  });

  test('退出后重新登录;取消登录零播放请求;点播详情播放继续原媒体', async ({ page }) => {
    const tracked = trackPlayback(page);
    await logout(page);

    // 游客在点播详情点击播放 → 登录意图;取消 → 零 /playback/ 请求、弹层不重开
    await page.goto('/media/fx-vod-001');
    await expect(page.getByRole('button', { name: '播放 夹具影片 001(修订样本)' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: '播放 夹具影片 001(修订样本)' }).click();
    await expectStep(page, '登录');
    expect(tracked.playbackRequests).toEqual([]);
    await dialogOf(page).getByRole('button', { name: '取消' }).click();
    await expect(dialogOf(page)).toBeHidden();
    expect(tracked.playbackRequests).toEqual([]);

    // 弹层不重开(停留原页面)
    await page.waitForTimeout(500);
    await expect(dialogOf(page)).toHaveCount(0);

    // 再次点击播放 → 完成登录选档 → 继续原媒体(US3 场景 1:同一入口继续原目标)
    await page.getByRole('button', { name: '播放 夹具影片 001(修订样本)' }).click();
    await expectStep(page, '登录');
    await loginAndSelectMain(page, '135790');
    const title = await surfaceTitle(page);
    expect(title).toContain('夹具影片 001(修订样本)');
    await expect
      .poll(() => tracked.playbackRequests.some((path) => path === '/api/playback/resolve'), { timeout: 15_000 })
      .toBe(true);
  });

  test('准备中连点/换目标:仅最新内容可起播(播放面标题=最后目标)', async ({ page }) => {
    const tracked = trackPlayback(page);
    await page.goto('/live');
    await ensureAuthenticated(page);

    const playButtons = page.getByRole('button', { name: /当前直播/ });
    await expect(playButtons.first()).toBeVisible({ timeout: 15_000 });
    const firstTitle = ((await playButtons.nth(0).getAttribute('aria-label')) ?? '')
      .replace(/^播放\s*/, '')
      .replace(/\s*当前直播$/, '');
    const secondTitle = ((await playButtons.nth(1).getAttribute('aria-label')) ?? '')
      .replace(/^播放\s*/, '')
      .replace(/\s*当前直播$/, '');
    expect(firstTitle).not.toBe(secondTitle);

    // 已选档:直接 authorize;准备面板为非阻塞面 —— 准备中立即换目标(B 覆盖 A,FR-013)
    await playButtons.nth(0).click();
    await expect(page.getByTestId('playback-preparing')).toBeVisible({ timeout: 10_000 });
    await playButtons.nth(1).click();

    // 仅最新意图可起播:全屏面标题=第二目标(旧准备结果不得改写播放面)
    const title = await surfaceTitle(page);
    expect(title).toContain(secondTitle);
    expect(title).not.toContain(firstTitle);

    // B 的 resolve 已发生;旧目标 A 的会话不得进入新播放面
    await expect
      .poll(() => tracked.playbackRequests.filter((path) => path === '/api/playback/resolve').length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
  });

  test('退出登录:播放面停止,旧会话读取 401', async ({ page }) => {
    const tracked = trackPlayback(page);
    await page.goto('/live');
    await ensureAuthenticated(page);
    const playButtons = page.getByRole('button', { name: /当前直播/ });
    await expect(playButtons.first()).toBeVisible({ timeout: 15_000 });
    await playButtons.first().click();
    await expectPlaybackFace(page);
    await expect
      .poll(() => tracked.resolvedSessionIds().length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
    const sessionId = tracked.resolvedSessionIds()[tracked.resolvedSessionIds().length - 1] as string;

    // 退出:播放面即时停止(FR-014);服务端同事务终态化旧上下文播放
    await logout(page);
    await expectPlaybackGone(page);

    // 旧会话读取:会话已撤销 → 401 SESSION_INVALID
    const old = await page.request.get(`/api/playback/sessions/${sessionId}`);
    expect(old.status()).toBe(401);
    expect(((await old.json()) as { code?: string }).code).toBe('SESSION_INVALID');
  });

  test('换档:旧播放停止,旧会话读取 404 同形(不能转用于新身份)', async ({ page }) => {
    const tracked = trackPlayback(page);
    // 上一用例已退出 → 重新登录并选主档案
    await page.goto('/live');
    await ensureAuthenticated(page);

    const playButtons = page.getByRole('button', { name: /当前直播/ });
    await expect(playButtons.first()).toBeVisible({ timeout: 15_000 });
    await playButtons.first().click();
    await expectPlaybackFace(page);
    await expect
      .poll(() => tracked.resolvedSessionIds().length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
    const sessionId = tracked.resolvedSessionIds()[tracked.resolvedSessionIds().length - 1] as string;

    // 换档到儿童档案(PIN 246800)
    const dialog = await openProfileSwitch(page);
    await dialog.getByRole('button', { name: /儿童档案/ }).click();
    await expectStep(page, '输入档案 PIN');
    await dialog.getByLabel('档案 PIN').fill('246800');
    await dialog.getByRole('button', { name: '解锁并选择' }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // 播放面停止;旧会话(pcv 失衡+已终态)读取与「不存在」同形 404
    await expectPlaybackGone(page);
    const old = await page.request.get(`/api/playback/sessions/${sessionId}`);
    expect(old.status()).toBe(404);
    expect(((await old.json()) as { code?: string }).code).toBe('PLAYBACK_NOT_FOUND');
  });
});
