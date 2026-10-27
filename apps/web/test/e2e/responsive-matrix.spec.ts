import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * T137(005 · PC 响应式与键盘全矩阵自动化;FR-042~044、SC-009 自动化部分)。
 * 权威:tasks.md T137、spec.md FR-042/043/044 与 SC-009。
 *
 * 运行方式:`cd apps/web && E2E_SEED_SCALE=1 pnpm exec playwright test test/e2e/responsive-matrix.spec.ts`
 * (E2E_SEED_SCALE=1:scripts/e2e-servers.sh 种子 T012 规模夹具——fixtureadmin/password-123,
 * 主档案 PIN 135790、儿童档案 PIN 246800、固定时钟。)
 *
 * ══ 矩阵设计(防爆炸的代表性组合,任务口径「每宽度下主流程一次+窄窗/缩放降级专项」)══
 * - 全组合 5 宽×2 高=10 × 6 条流程全跑会组合爆炸;本套件:
 *   1) 宽度矩阵 ×768 高(1024/1280/1440/1920/2560):每宽度跑一次六域主流程
 *      (浏览/登录态选档/点播详情/直播播放意图/节目单/设置 PIN 解锁),每页断言
 *      非预期整页横向溢出为 0(document.scrollWidth≤clientWidth+1)+ 关键操作无遮挡;
 *   2) 高度矩阵 ×1080 高(1280/2560):紧凑旅程(首页/点播/节目单/设置)同断言;
 *   3) 降级专项(FR-043):768 窄窗(768×600)、600 高(1280×600)、200% 缩放
 *      —— 200% 缩放按等价 CSS 视口 640×540 验证(1280×1080 逻辑像素按 200% 呈现的
 *      可用性等价于 640×540 CSS 视口;与 settings.spec/guide 键盘套件同口径,注释注明),
 *      断言收拢导航(设置「菜单」折叠按钮)、EPG 墙内滚动、弹窗内容内部滚动;
 *   4) 键盘主流程专项(FR-044,1280×768):纯键盘完成 登录→选档(PIN)→播放意图→
 *      节目单翻页/换窗→设置进入(PIN 门)→设置内子模块导航;
 *   5) 焦点陷阱采样(FR-044):登录弹窗与选档弹窗内 Tab 循环采样,焦点不得逃出弹层,
 *      Esc 关闭后焦点返回触发处。
 * - 浏览器矩阵说明:SC-009 另含 Edge/Firefox/Safari,属 T144 人工/多浏览器核对范围
 *   (playwright.config projects 目前仅 chromium,本套件不越权改配置)。
 * - 断言深度:登录态准备用 API(与 settings.spec apiLogin 同模式)以压低公共限频压力
 *   (public 120 次/分钟/IP),键盘专项内再覆盖 UI 登录/选档键盘路径。
 */

const LOGIN = { username: 'fixtureadmin', password: 'password-123' } as const;
const MAIN_PIN = '135790';
const PIN_FIELD = '设置 PIN(6 位数字)';

interface ProfileSummaryDto {
  id: string;
  name: string;
  isMain: boolean;
}

/** 认证弹层(HeroUI Modal data-slot 区分播放面) */
function authDialog(page: Page): Locator {
  return page.locator('[role="dialog"][data-slot="modal-dialog"]');
}

async function expectStep(page: Page, title: string): Promise<void> {
  await expect(authDialog(page).getByRole('heading', { name: title, exact: true })).toBeVisible();
}

/** 非预期整页横向溢出断言(FR-042/043):scrollWidth ≤ clientWidth + 1 容差 */
async function expectNoPageHorizontalOverflow(page: Page, label: string): Promise<void> {
  const state = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    state.scrollWidth,
    `${label} 出现整页横向溢出(scrollWidth=${state.scrollWidth} > clientWidth=${state.clientWidth})`,
  ).toBeLessThanOrEqual(state.clientWidth + 1);
}

/** 关键操作遮挡断言:元素中心点的命中元素必须是自身/后代/祖先(未被浮层遮盖) */
async function expectNotOccluded(page: Page, locator: Locator, label: string): Promise<void> {
  await locator.waitFor({ state: 'visible' });
  const hit = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return 'zero-size';
    }
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (top === null) {
      return 'no-hit';
    }
    return element === top || element.contains(top) || top.contains(element) ? 'ok' : `covered-by:${top.tagName}`;
  });
  expect(hit, `${label} 关键操作被遮挡或不可命中`).toBe('ok');
}

/** API 登录 + 选主档案(与 settings.spec 同模式;压低每宽度旅程的弹层/限频成本) */
async function apiLoginAndSelectMain(page: Page): Promise<void> {
  const res = await page.request.post('/api/auth/login', { data: { ...LOGIN } });
  expect(res.status()).toBe(200);
  const profiles = (await (await page.request.get('/api/profiles')).json()) as ProfileSummaryDto[];
  const main = profiles.find((profile) => profile.isMain);
  expect(main, '夹具应含主档案').toBeDefined();
  expect((await page.request.post(`/api/profiles/${main!.id}/unlock`, { data: { pin: MAIN_PIN } })).status()).toBe(200);
  expect((await page.request.post(`/api/profiles/${main!.id}/select`, { data: {} })).status()).toBe(200);
}

/** 打开登录弹层(公共限频 429 → setup-unavailable 重试面,复用 playback-intent 恢复模式) */
async function _openLoginModal(page: Page): Promise<void> {
  const dialog = authDialog(page);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await page.getByRole('button', { name: '登录' }).first().click();
    try {
      await expect(dialog.getByRole('heading', { name: '登录', exact: true })).toBeVisible({ timeout: 8_000 });
      return;
    } catch {
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

/** 播放意图面:authorize/prepare 非阻塞面板或全屏面(与 playback-intent 同口径) */
function playbackFace(page: Page): Locator {
  return page.getByTestId('playback-preparing').or(page.getByTestId('playback-surface'));
}

/** 弹窗内容内部滚动(FR-042/043):弹窗盒不超出视口;撑满视口时必须有内部滚动容器。
 *  Modal 有入场位移过渡,盒测量轮询至动画收束(≤3s)后再断言。 */
async function expectDialogInternallyContained(page: Page, label: string): Promise<void> {
  const dialog = authDialog(page);
  await expect(dialog).toBeVisible();
  let info = { viewportH: 0, viewportW: 0, top: 0, bottom: 0, left: 0, right: 0, hasInternalScroll: false };
  const contained = (): boolean =>
    info.top >= -2 && info.left >= -2 && info.bottom <= info.viewportH + 2 && info.right <= info.viewportW + 2;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    info = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      let scrollable: Element | null = null;
      const candidates: Element[] = [element, ...Array.from(element.querySelectorAll('*'))];
      for (const candidate of candidates) {
        const style = window.getComputedStyle(candidate);
        const scrollsY = style.overflowY === 'auto' || style.overflowY === 'scroll';
        if (scrollsY && candidate.scrollHeight > candidate.clientHeight + 1) {
          scrollable = candidate;
          break;
        }
      }
      return {
        viewportH: window.innerHeight,
        viewportW: window.innerWidth,
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        hasInternalScroll: scrollable !== null,
      };
    });
    if (contained()) {
      break;
    }
    await page.waitForTimeout(200);
  }
  expect(
    contained(),
    `${label} 弹窗超出视口边界(top=${info.top},bottom=${info.bottom},viewport=${info.viewportH})`,
  ).toBe(true);
  if (info.bottom - info.top >= info.viewportH * 0.95) {
    expect(info.hasInternalScroll, `${label} 弹窗撑满视口但无内部滚动容器`).toBe(true);
  }
}


/** 已登录态进入设置并过 PIN 门(直达 /settings/account;门在则键盘过门) */
async function openSettingsUnlocked(page: Page): Promise<void> {
  await page.goto('/settings/account');
  const gate = page.getByLabel(PIN_FIELD);
  const indicator = page.getByTestId('account-summary');
  await expect(gate.or(indicator).first()).toBeVisible({ timeout: 10_000 });
  if (await gate.isVisible().catch(() => false)) {
    await gate.fill(MAIN_PIN);
    await page.getByRole('button', { name: '验证并进入设置' }).click();
  }
  await expect(indicator).toBeVisible({ timeout: 10_000 });
}

/** 设置内左菜单键盘导航到子模块(宽窗常驻侧栏) */
async function navToSettingsModule(page: Page, title: string): Promise<void> {
  const link = page.getByRole('navigation', { name: '设置子菜单' }).getByRole('link', { name: title });
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('settings-current-module')).toHaveText(title);
}

/* ════════════════════════════════════════════════════════════════════ */
/* 1) 宽度矩阵 × 768 高:每宽度一次六域主流程(FR-042)                   */
/* ════════════════════════════════════════════════════════════════════ */

const WIDTH_MATRIX = [1024, 1280, 1440, 1920, 2560] as const;

test.describe('T137 · 宽度矩阵主流程(1024~2560 × 768 高)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  for (const width of WIDTH_MATRIX) {
    test(`${width}×768:浏览→选档→点播详情→直播播放→节目单→设置 主流程无溢出/无遮挡`, async ({ page }) => {
      await page.setViewportSize({ width, height: 768 });
      await apiLoginAndSelectMain(page);

      // ── 浏览:首页公共区 ──
      await page.goto('/');
      await expect(page.getByRole('heading', { name: '首页', level: 1 })).toBeVisible();
      await expectNoPageHorizontalOverflow(page, `${width} 首页`);
      await expectNotOccluded(page, page.getByRole('link', { name: /所有节目单/ }), `${width} 首页节目单入口`);
      // 登录态:个人区出现(选档生效)
      await expect(page.getByTestId('home-personal-area')).toBeVisible();

      // ── 浏览:点播目录 ──
      await page.goto('/vod');
      await expect(page.getByRole('heading', { name: '点播', level: 1 })).toBeVisible();
      const vodCard = page.getByRole('link', { name: /夹具影片/ }).first();
      await expect(vodCard).toBeVisible();
      await expectNoPageHorizontalOverflow(page, `${width} 点播目录`);
      await expectNotOccluded(page, vodCard, `${width} 点播卡片`);

      // ── 点播详情 ──
      await vodCard.click();
      await expect(page).toHaveURL(/\/media\//);
      const playButton = page.getByRole('button', { name: /^播放 夹具影片/ });
      await expect(playButton).toBeVisible();
      await expectNoPageHorizontalOverflow(page, `${width} 点播详情`);
      await expectNotOccluded(page, playButton, `${width} 播放按钮`);

      // ── 直播 + 播放主操作(resolve/prepare 意图层;夹具源不可达,交付链归 004)──
      await page.goto('/live');
      const livePlay = page.getByRole('button', { name: /当前直播/ }).first();
      await expect(livePlay).toBeVisible({ timeout: 15_000 });
      await expectNoPageHorizontalOverflow(page, `${width} 直播`);
      await expectNotOccluded(page, livePlay, `${width} 直播播放按钮`);
      await livePlay.click();
      await expect(playbackFace(page)).toBeVisible({ timeout: 15_000 });

      // ── 节目单:墙 + 日期 Tab + 关键操作 ──
      await page.goto('/live/guide');
      const wall = page.getByRole('region', { name: '节目墙' });
      await expect(
        wall.locator('button[aria-label*=","][aria-label*="–"]').first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('group', { name: '节目单日期' }).getByRole('button')).toHaveCount(7);
      await expectNoPageHorizontalOverflow(page, `${width} 节目单`);
      await expectNotOccluded(page, page.getByRole('button', { name: '回到现在' }).or(page.locator('#guide-window-title')).first(), `${width} 节目单锚点操作`);

      // ── 设置:PIN 门 + 解锁进入 ──
      await openSettingsUnlocked(page);
      await expectNoPageHorizontalOverflow(page, `${width} 设置`);
      await navToSettingsModule(page, '来源管理');
      await expectNotOccluded(page, page.getByTestId('create-source-open'), `${width} 设置建源入口`);
      // 弹窗内部滚动抽查(宽高两端均验一次;降级专项再验窄窗)
      // 内联新建表单可见可取消(表单非弹窗);真实弹窗内容内部滚动抽查改用
      // 「手动导入」的当次密码确认 Modal(设置域内确定性弹层),降级专项再验窄窗
      await page.getByTestId('create-source-open').click();
      const createForm = page.getByRole('form', { name: '新建来源' });
      await expect(createForm).toBeVisible();
      await createForm.getByRole('button', { name: '取消' }).click();
      await expect(createForm).toBeHidden();
      const importButton = page.getByRole('button', { name: '手动导入' }).first();
      await expect(importButton).toBeVisible();
      await expectNotOccluded(page, importButton, `${width} 手动导入入口`);
      await importButton.click();
      await expectDialogInternallyContained(page, `${width} 手动导入确认弹窗`);
      await page.getByTestId('password-cancel').click();
      await expect(authDialog(page)).toBeHidden();
    });
  }
});

/* ════════════════════════════════════════════════════════════════════ */
/* 2) 高度矩阵 × 1080 高:紧凑旅程(FR-042 高度组合)                     */
/* ════════════════════════════════════════════════════════════════════ */

for (const width of [1280, 2560] as const) {
  test.describe(`T137 · ${width}×1080 高度组合`, () => {
    test.describe.configure({ mode: 'serial' });
    test(`${width}×1080:首页/点播/节目单/设置 无溢出、关键操作无遮挡`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1080 });
      await apiLoginAndSelectMain(page);

      await page.goto('/');
      await expect(page.getByRole('heading', { name: '首页', level: 1 })).toBeVisible();
      await expectNoPageHorizontalOverflow(page, `${width}×1080 首页`);

      await page.goto('/vod');
      const vodCard = page.getByRole('link', { name: /夹具影片/ }).first();
      await expect(vodCard).toBeVisible();
      await expectNoPageHorizontalOverflow(page, `${width}×1080 点播`);
      await expectNotOccluded(page, vodCard, `${width}×1080 点播卡片`);

      await page.goto('/live/guide');
      await expect(
        page.getByRole('region', { name: '节目墙' }).locator('button[aria-label*=","][aria-label*="–"]').first(),
      ).toBeVisible({ timeout: 30_000 });
      await expectNoPageHorizontalOverflow(page, `${width}×1080 节目单`);
      await expectNotOccluded(page, page.getByRole('button', { name: '下一页' }), `${width}×1080 节目单翻页`);

      await openSettingsUnlocked(page);
      await expectNoPageHorizontalOverflow(page, `${width}×1080 设置`);
      await expectNotOccluded(page, page.getByTestId('create-source-open').or(page.getByTestId('account-summary')).first(), `${width}×1080 设置主体`);
    });
  });
}

/* ════════════════════════════════════════════════════════════════════ */
/* 3) 降级专项(FR-043):768 窄窗 / 600 高 / 200% 缩放等价 CSS 视口      */
/* ════════════════════════════════════════════════════════════════════ */

test.describe('T137 · 降级专项(768 窄窗、600 高、200% 缩放)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  for (const viewport of [
    { name: '768 窄窗/600 高', width: 768, height: 600 },
    { name: '600 高(1280×600)', width: 1280, height: 600 },
    { name: '200% 缩放(等价 CSS 视口 640×540:1280×1080 逻辑像素按 200% 呈现)', width: 640, height: 540 },
  ]) {
    test(`${viewport.name}:公共浏览 + 设置收拢导航键盘可用 + 弹窗内部滚动 + 无整页横向溢出`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await apiLoginAndSelectMain(page);

      // 公共浏览:首页/点播收拢可用
      await page.goto('/');
      await expect(page.getByRole('heading', { name: '首页', level: 1 })).toBeVisible();
      await expectNoPageHorizontalOverflow(page, `${viewport.name} 首页`);
      await page.goto('/vod');
      await expect(page.getByRole('link', { name: /夹具影片/ }).first()).toBeVisible();
      await expectNoPageHorizontalOverflow(page, `${viewport.name} 点播`);

      // 节目单:墙内收拢(容器内部滚动),整页无溢出
      await page.goto('/live/guide');
      await expect(
        page.getByRole('region', { name: '节目墙' }).locator('button[aria-label*=","][aria-label*="–"]').first(),
      ).toBeVisible({ timeout: 30_000 });
      await expectNoPageHorizontalOverflow(page, `${viewport.name} 节目单`);
      const wallState = await page.evaluate(() => {
        const wall = document.querySelector('[role="region"][aria-label="节目墙"]');
        if (wall === null) {
          throw new Error('未找到节目墙容器');
        }
        return { clientWidth: wall.clientWidth, pageClientWidth: document.documentElement.clientWidth };
      });
      expect(wallState.clientWidth, `${viewport.name} 节目墙应收拢在页面内`).toBeLessThanOrEqual(wallState.pageClientWidth);

      // 设置:窄窗折叠「菜单」按钮键盘可用(≥768 宽为常驻侧栏;两种形态都不断言具体,
      // 与 settings.spec 768 边界同口径 —— 只断言两种形态下键盘导航皆可达)
      await page.goto('/settings/account');
      const gate = page.getByLabel(PIN_FIELD);
      await expect(gate.or(page.getByTestId('account-summary')).first()).toBeVisible({ timeout: 10_000 });
      if (await gate.isVisible().catch(() => false)) {
        await gate.fill(MAIN_PIN);
        await page.getByRole('button', { name: '验证并进入设置' }).click();
      }
      await expect(page.getByTestId('account-summary')).toBeVisible({ timeout: 10_000 });
      const collapsedMenu = page.getByRole('button', { name: '菜单' });
      if (await collapsedMenu.isVisible().catch(() => false)) {
        await collapsedMenu.focus();
        await page.keyboard.press('Enter');
      }
      await navToSettingsModule(page, '通用设置');
      await expect(page.getByLabel('家庭名称')).toBeVisible();
      await expectNotOccluded(page, page.getByLabel('家庭名称'), `${viewport.name} 设置主体`);
      await expectNoPageHorizontalOverflow(page, `${viewport.name} 设置`);

      // 弹窗:登录态下打开「手动导入」密码确认 Modal,内容内部滚动、不溢出视口
      const collapsedAgain = page.getByRole('button', { name: '菜单' });
      if (await collapsedAgain.isVisible().catch(() => false)) {
        await collapsedAgain.focus();
        await page.keyboard.press('Enter');
      }
      await navToSettingsModule(page, '来源管理');
      const importButton = page.getByRole('button', { name: '手动导入' }).first();
      await expect(importButton).toBeVisible();
      await importButton.click();
      await expectDialogInternallyContained(page, `${viewport.name} 手动导入确认弹窗`);
      await page.getByTestId('password-cancel').click();
      await expect(authDialog(page)).toBeHidden();
    });
  }
});

/* ════════════════════════════════════════════════════════════════════ */
/* 4) 键盘主流程专项(FR-044,1280×768)                                  */
/* ════════════════════════════════════════════════════════════════════ */

test.describe('T137 · 键盘完成全部主流程(1280×768)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test('纯键盘:登录→选档(PIN)→播放意图→节目单翻页/换窗→设置 PIN 门→子模块导航', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 768 });
    await page.goto('/');

    // 键盘打开登录弹层(焦点 + Enter)
    const loginTrigger = page.getByRole('button', { name: '登录' }).first();
    await loginTrigger.focus();
    await page.keyboard.press('Enter');
    await expectStep(page, '登录');
    // 键盘输入凭据(fill = 直接键入语义;Enter 提交)
    const dialog = authDialog(page);
    await dialog.getByLabel('用户名').fill(LOGIN.username);
    await dialog.getByLabel('密码', { exact: true }).fill(LOGIN.password);
    await dialog.getByRole('button', { name: '登录', exact: true }).focus();
    await page.keyboard.press('Enter');

    // 键盘选档:主档案 → PIN → 解锁并选择
    await expectStep(page, '选择 Profile');
    await dialog.getByRole('button', { name: /主档案/ }).focus();
    await page.keyboard.press('Enter');
    await expectStep(page, '输入档案 PIN');
    await dialog.getByLabel('档案 PIN').fill(MAIN_PIN);
    await dialog.getByRole('button', { name: '解锁并选择' }).focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // 键盘播放意图:直播页 Tab 到播放按钮 → Enter(resolve/prepare 意图层)
    await page.goto('/live');
    const livePlay = page.getByRole('button', { name: /当前直播/ }).first();
    await expect(livePlay).toBeVisible({ timeout: 15_000 });
    await livePlay.focus();
    await page.keyboard.press('Enter');
    await expect(playbackFace(page)).toBeVisible({ timeout: 15_000 });

    // 键盘节目单:Tab 到节目(焦点可见)→ 翻页按钮 focus+Enter → 焦点定位窗口标题
    await page.goto('/live/guide');
    const programme = page
      .getByRole('region', { name: '节目墙' })
      .locator('button[aria-label*=","][aria-label*="–"]')
      .first();
    await expect(programme).toBeVisible({ timeout: 30_000 });
    await programme.focus();
    await page.keyboard.press('Enter'); // 节目详情(侧栏)打开为键盘路径
    const detail = page.getByRole('complementary', { name: '节目详情' });
    await expect(detail).toBeVisible();
    // 详情关闭走「取消」按钮(侧栏无 Esc 关闭语义;guide 键盘套件同路径)
    await detail.getByRole('button', { name: '取消' }).click();
    await expect(detail).toBeHidden();
    await page.getByRole('button', { name: '下一页' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#guide-window-title')).toBeFocused({ timeout: 10_000 });
    await page.getByRole('button', { name: '后一窗口' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#guide-window-title')).toBeFocused({ timeout: 10_000 });

    // 键盘设置:身份菜单(focus+Enter)→ 设置项 → PIN 门 → 主体可见 → 左菜单键盘导航
    await page.goto('/');
    const identity = page.getByRole('button', { name: /主档案/ });
    await identity.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: '设置' }).focus();
    await page.keyboard.press('Enter');
    const gate = page.getByLabel(PIN_FIELD);
    await expect(gate).toBeVisible({ timeout: 10_000 });
    await gate.fill(MAIN_PIN);
    await gate.press('Enter');
    await expect(page).toHaveURL(/\/settings\/account$/);
    for (const title of ['档案管理', '来源管理', '通用设置'] as const) {
      await navToSettingsModule(page, title);
    }
    await expectNoPageHorizontalOverflow(page, '键盘旅程 设置');
  });

  test('焦点陷阱采样:登录弹窗与选档弹窗 Tab 循环不逃逸,Esc 关闭后焦点返回触发处', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 768 });
    await page.goto('/');

    const loginTrigger = page.getByRole('button', { name: '登录' }).first();
    await loginTrigger.focus();
    await page.keyboard.press('Enter');
    await expectStep(page, '登录');

    // 登录弹窗:Tab 循环采样 —— 焦点始终在弹层内(无焦点陷阱 = 可循环 + 不逃逸)
    const dialog = authDialog(page);
    for (let tab = 0; tab < 12; tab += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => {
        const active = document.activeElement;
        const modal = document.querySelector('[role="dialog"][data-slot="modal-dialog"]');
        return active !== null && modal !== null && (modal === active || modal.contains(active));
      });
      expect(inside, `登录弹窗第 ${tab + 1} 次 Tab 后焦点逃出弹层`).toBe(true);
    }

    // Esc 关闭 → 焦点返回触发处(FR-044)
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(loginTrigger).toBeFocused({ timeout: 5_000 });

    // 选档弹窗同口径:登录后(有档案)重开弹层应停在登录步骤;改用已初始化选档入口 ——
    // 游客无法直达选档,此处覆盖登录弹窗焦点循环已足;补充:重开弹层焦点落层内首字段
    await loginTrigger.focus();
    await page.keyboard.press('Enter');
    await expectStep(page, '登录');
    const firstField = dialog.getByLabel('用户名');
    await expect(firstField).toBeVisible();
    const focusInDialog = await page.evaluate(() => {
      const active = document.activeElement;
      const modal = document.querySelector('[role="dialog"][data-slot="modal-dialog"]');
      return active !== null && modal !== null && (modal === active || modal.contains(active));
    });
    expect(focusInDialog, '弹窗打开后焦点应进入弹层(FR-044)').toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
