import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * T032(006 US3 e2e):身份切换与前端缓存隔离。
 *
 * 与 T096(005 场景 4,双上下文对照)分工:T096 证明「切档后 B 无 A 的收藏」的
 * 业务主链路;本套件聚焦 006 新缓存层的三类行为:
 * 1. 在途个人响应在切档后被丢弃(路由拦截慢响应;实现缺陷时旧档数据会渲染到新档案界面);
 * 2. 会话丢失(清除 Cookie)→ 个人域清空、统一收敛到登录引导,公共浏览不中断;
 * 3. 切档往返:公共页不闪断;公共缓存保留;A 回切后收藏仍在(新数据层行为等价)。
 *
 * 跨档案泄漏的缓存级细分证明(键内嵌 profileId、cancel→remove→mutationCache.clear、
 * 401 去重)由单测 test/unit/identity-purge.spec.tsx(9 用例)承载;本套件做真实
 * 浏览器端到端验证。独立 DATA_DIR 由 playwright webServer 保证全新空库。
 */

const MAIN_PIN = '135790';
const CHILD_PIN = '246800';

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: '登录', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
  await dialog.getByLabel('用户名').fill('fixtureadmin');
  await dialog.getByLabel('密码', { exact: true }).fill('password-123');
  await dialog.getByRole('button', { name: '登录', exact: true }).click();
}

async function selectProfile(page: Page, profileName: string, pin: string): Promise<void> {
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '选择 Profile' })).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: new RegExp(profileName) }).click();
  await expect(dialog.getByRole('heading', { name: '输入档案 PIN' })).toBeVisible();
  await dialog.getByLabel('档案 PIN').fill(pin);
  await dialog.getByRole('button', { name: '解锁并选择' }).click();
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15_000 });
}

async function switchProfile(page: Page, profileName: string, pin: string): Promise<void> {
  await page.getByRole('button', { name: /主档案|儿童档案/ }).first().click();
  await page.getByRole('menuitem', { name: '切换 Profile' }).click();
  await selectProfile(page, profileName, pin);
}

async function favoriteFixtureChannel(page: Page): Promise<void> {
  await page.goto('/media/fx-ch-001');
  const star = page.getByRole('button', { name: /^收藏 夹具频道 001$/ });
  await expect(star).toBeVisible();
  await star.click();
  await expect(page.getByRole('button', { name: /^取消收藏 夹具频道 001$/ })).toBeVisible();
}

function favoritesSection(page: Page): Locator {
  return page.getByTestId('home-favorites');
}

test.describe.serial('T032 · 身份切换与缓存隔离(006 US3)', () => {
  test('主档案收藏并在首页可见(基线建立)', async ({ page }) => {
    await login(page);
    await selectProfile(page, '主档案', MAIN_PIN);
    await favoriteFixtureChannel(page);
    await page.goto('/');
    await expect(page.getByTestId('favorite-card')).toHaveCount(1);
    await expect(page.getByText(/夹具频道 001/).first()).toBeVisible();
  });

  test('在途个人响应在切档后被丢弃:慢响应返回也不得渲染到新档案界面', async ({ page }) => {
    // 独立上下文:本用例自建身份数据(主档案收藏 fx-ch-001)
    await login(page);
    await selectProfile(page, '主档案', MAIN_PIN);
    await favoriteFixtureChannel(page);
    await page.goto('/');
    await expect(page.getByTestId('favorite-card')).toHaveCount(1);

    // 拦截个人收藏请求使其在途 3s:确保切档瞬间存在一个主档案的在途 /me 请求
    await page.route('**/api/me/favorites/channels*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await route.continue();
    });

    // 重新加载首页触发个人收藏请求(慢、在途);在途期间切换到儿童档案
    await page.goto('/');
    await expect(page.getByTestId('home-favorites')).toBeVisible();
    await switchProfile(page, '儿童档案', CHILD_PIN);

    // 切档即清档:切档瞬间主档案收藏卡必须立即消失(同步清除,非等待慢响应)
    await expect(page.getByTestId('favorite-card')).toHaveCount(0);

    // 放行慢响应窗口后:迟到的主档案响应不得把收藏卡渲染到儿童档案界面
    await page.waitForTimeout(4_000);
    await expect(page.getByTestId('favorite-card')).toHaveCount(0);
    await expect(page.getByTestId('home-favorites').getByText(/夹具频道 001/)).toHaveCount(0);

    // 儿童档案自身收藏为空态(慢响应放行后到达)
    await expect(favoritesSection(page).getByText(/还没有收藏频道/)).toBeVisible({ timeout: 10_000 });
    await page.unroute('**/api/me/favorites/channels*');
  });

  test('会话丢失:个人域清空、统一收敛登录引导,公共浏览不中断', async ({ page }) => {
    await login(page);
    await selectProfile(page, '主档案', MAIN_PIN);
    await page.goto('/');
    await expect(page.getByTestId('home-favorites')).toBeVisible();

    // 模拟会话丢失:清除会话 Cookie 后,任何页面加载的个人请求都将 401
    await page.context().clearCookies();
    await page.goto('/');

    // 公共壳照常渲染(公共浏览不因会话丢失中断)
    await expect(page.getByRole('link', { name: '映岬 Cinecape' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '首页' })).toBeVisible();

    // 统一收敛到游客/登录引导:登录入口回归、个人区消失、无半失效的已选档身份
    await expect(page.getByRole('button', { name: '登录', exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('home-favorites')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /主档案|儿童档案/ })).toHaveCount(0);
  });

  test('切档往返:公共页不中断;A 回切后收藏仍在(公共缓存保留,新数据层行为等价)', async ({ page }) => {
    await login(page);
    await selectProfile(page, '主档案', MAIN_PIN);

    // 已有收藏(前一用例建立;若独立重跑则重建)
    await page.goto('/');
    if ((await page.getByTestId('favorite-card').count()) === 0) {
      await favoriteFixtureChannel(page);
      await page.goto('/');
    }
    await expect(page.getByTestId('favorite-card')).toHaveCount(1);

    // 切到儿童档案:公共点播页直达且不要求登录(公共缓存/浏览保留)
    await switchProfile(page, '儿童档案', CHILD_PIN);
    await page.goto('/vod');
    await expect(page.getByRole('heading', { name: '点播' })).toBeVisible();
    await expect(page.getByRole('link', { name: '映岬 Cinecape' })).toBeVisible();

    // 回切主档案:收藏仍在(个人域按档案隔离,不互吞)
    await switchProfile(page, '主档案', MAIN_PIN);
    await page.goto('/');
    await expect(page.getByTestId('favorite-card')).toHaveCount(1);
    await expect(page.getByText(/夹具频道 001/).first()).toBeVisible();
  });
});
