import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * T096(005 US4 e2e;E2E_SEED_SCALE=1 规模夹具,双浏览器上下文模拟双设备):
 * 复现 spec.md US4 场景矩阵 —— 断言深度说明:
 *
 * - 夹具 NAS 源指向不可达路径,「真实媒体交付」不存在:进度协议场景(乱序/重复/
 *   伪造他档/失效会话写入被拒、断网恢复、位置精度)用 API 层断言,完整样本构造
 *   与负向矩阵由服务端契约测试覆盖(T092/T093);本 e2e 只对「游客/未选档零个人
 *   请求」「越权 body 伪造 400」「未认证 401」做 API 层负向抽查;
 * - 「真正 started 后才出现历史」在本环境只能验证负向半边(仅看详情/直播不产生
 *   历史,历史区保持空态);正向历史卡/继续观看入口渲染由 T094(mock 数据)与
 *   服务端 T093 覆盖;
 * - 「失效媒体不可用可取消」的不可用渲染由 T094 mock 覆盖(夹具无法经 API 把
 *   可用频道变失效),本 e2e 覆盖「失效点播公共详情同形 404、无播放入口」。
 *
 * 场景映射:
 * 1 公共区可见与未选档选档入口(游客零 /me 请求);
 * 2 收藏/取消幂等且刷新后一致(UI 星标 + API 幂等重放);
 * 3 仅看详情/解析失败不进历史(历史区保持空态);
 * 4 切换即清档(B 档案个人区为空,A 的收藏不泄漏;A 回切后收藏仍在);
 * 8 伪造身份/未认证写入被拒(API 层)。
 */

const FAV_URL = '/api/me/favorites/channels';
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

/** 受控弹层内完成「选择档案 → PIN 解锁 → 选定」(登录后协调器自动进入选档步骤) */
async function pickProfileInDialog(page: Page, profileName: string, pin: string): Promise<void> {
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '选择 Profile' })).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: new RegExp(profileName) }).click();
  // PIN 档案 → selectionPin 步骤(提交按钮 = 解锁并选择)
  await expect(dialog.getByRole('heading', { name: '输入档案 PIN' })).toBeVisible();
  await dialog.getByLabel('档案 PIN').fill(pin);
  await dialog.getByRole('button', { name: '解锁并选择' }).click();
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15_000 });
}

/** 登录后选档(登录成功后协调器自动进入选档步骤) */
async function selectProfile(page: Page, profileName: string, pin: string): Promise<void> {
  await pickProfileInDialog(page, profileName, pin);
}

/** 已选档状态下切换档案:顶栏身份菜单(档案名触发器)→ 切换 Profile */
async function switchProfile(page: Page, profileName: string, pin: string): Promise<void> {
  // 触发器 = 档案名按钮(无 dialog 打开时唯一)
  await page.getByRole('button', { name: /主档案|儿童档案/ }).first().click();
  await page.getByRole('menuitem', { name: '切换 Profile' }).click();
  await pickProfileInDialog(page, profileName, pin);
}

function favoritesSection(page: Page): Locator {
  return page.getByTestId('home-favorites');
}

test.describe.serial('T096 · 首页个人区(E2E,双设备上下文)', () => {
  test('场景 1:游客仅公共区、零 /me 请求;未选档提供选档入口', async ({ page }) => {
    const meRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/me/')) {
        meRequests.push(request.url());
      }
    });
    await page.goto('/');
    // 公共区:三个入口 + 轻量登录提示;无个人区
    await expect(page.getByRole('link', { name: /所有节目单/ })).toBeVisible();
    await expect(page.getByRole('link', { name: '点播', exact: true })).toBeVisible();
    await expect(page.getByText(/登录并选择观看档案后/)).toBeVisible();
    await expect(page.getByTestId('home-personal-area')).toHaveCount(0);
    expect(meRequests).toHaveLength(0);
  });

  test('登录选档后个人区出现(收藏 → 历史空态);场景 3:仅看详情不产生历史', async ({ page }) => {
    await login(page);
    await selectProfile(page, '主档案', MAIN_PIN);
    // 个人区:收藏/历史分区(首屏空态);公共入口仍在
    await expect(page.getByTestId('home-personal-area')).toBeVisible();
    await expect(favoritesSection(page)).toBeVisible();
    await expect(page.getByTestId('home-history')).toBeVisible();
    await expect(page.getByRole('link', { name: /所有节目单/ })).toBeVisible();
    // 场景 3(负向半边):仅访问点播详情(不播放)→ 历史保持空
    await page.goto('/media/fx-vod-001');
    await expect(page.getByRole('heading', { name: /夹具影片 001/ })).toBeVisible();
    await page.goto('/');
    await expect(page.getByTestId('home-history')).toBeVisible();
    await expect(page.getByText(/还没有点播观看记录/)).toBeVisible();
    // 空态收藏提示
    await expect(favoritesSection(page).getByText(/还没有收藏频道/)).toBeVisible();
  });

  test('场景 2:收藏(UI 星标)与取消幂等,刷新后一致', async ({ page }) => {
    await login(page);
    await selectProfile(page, '主档案', MAIN_PIN);
    // UI 星标收藏:频道详情页独立星标(不触发播放)
    await page.goto('/media/fx-ch-001');
    const star = page.getByRole('button', { name: /^收藏 夹具频道 001$/ });
    await expect(star).toBeVisible();
    await star.click();
    await expect(page.getByRole('button', { name: /^取消收藏 夹具频道 001$/ })).toBeVisible();
    // 幂等重放(同 PUT 再发):服务端 204,记录不重复
    const repeat = await page.request.put(FAV_URL + '/fx-ch-001', { data: {} });
    expect(repeat.status()).toBe(204);
    // 刷新首页:恰一张收藏卡
    await page.goto('/');
    await expect(page.getByTestId('favorite-card')).toHaveCount(1);
    await expect(page.getByText(/夹具频道 001/).first()).toBeVisible();
    // 重复 PUT 后再刷新:仍一张(幂等)
    await page.request.put(FAV_URL + '/fx-ch-001', { data: {} });
    await page.goto('/');
    await expect(page.getByTestId('favorite-card')).toHaveCount(1);
    // 取消收藏(幂等 DELETE):已不存在仍成功;首页回空态
    const remove = await page.request.delete(FAV_URL + '/fx-ch-001');
    expect(remove.status()).toBe(204);
    const removeAgain = await page.request.delete(FAV_URL + '/fx-ch-001');
    expect(removeAgain.status()).toBe(204);
    await page.goto('/');
    await expect(favoritesSection(page).getByText(/还没有收藏频道/)).toBeVisible();
  });

  test('场景 4:切换 Profile 即清档 —— B 无 A 的收藏;A 回切后收藏仍在(双上下文对照)', async ({ browser }) => {
    // 设备 A:主档案收藏 fx-ch-001
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await login(pageA);
    await selectProfile(pageA, '主档案', MAIN_PIN);
    await pageA.request.put(FAV_URL + '/fx-ch-001', { data: {} });
    await pageA.goto('/');
    await expect(pageA.getByTestId('favorite-card')).toHaveCount(1);

    // 设备 B(独立浏览器上下文 = 第二台设备):同一账号选儿童档案
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await login(pageB);
    await selectProfile(pageB, '儿童档案', CHILD_PIN);
    await pageB.goto('/');
    // B 的个人区为空:看不到 A 的收藏(串档 0)
    await expect(pageB.getByTestId('home-personal-area')).toBeVisible();
    await expect(pageB.getByTestId('home-favorites').getByText(/还没有收藏频道/)).toBeVisible();
    await expect(pageB.getByTestId('favorite-card')).toHaveCount(0);

    // 设备 A 仍在:收藏未受 B 影响(跨设备各档案独立)
    await expect(pageA.getByTestId('favorite-card')).toHaveCount(1);

    // A 上切换到儿童档案:个人区立即清档(B 视角同空)
    await switchProfile(pageA, '儿童档案', CHILD_PIN);
    await expect(pageA.getByTestId('home-favorites').getByText(/还没有收藏频道/)).toBeVisible();
    // 切回主档案:收藏恢复(按档案隔离持久)
    await switchProfile(pageA, '主档案', MAIN_PIN);
    await expect(pageA.getByTestId('favorite-card')).toHaveCount(1);

    await contextA.close();
    await contextB.close();
  });

  test('场景 8(API 层负向):伪造身份字段 400、未认证写入 401;失效点播详情同形不可播', async ({ page, browser }) => {
    await login(page);
    await selectProfile(page, '主档案', MAIN_PIN);
    // body 伪造 profileId/householdId → 400(未知字段拒绝,身份只从服务端推导)
    const forged = await page.request.put(FAV_URL + '/fx-ch-002', {
      data: { profileId: 'fx-profile-child', householdId: 'other-household' },
    });
    expect(forged.status()).toBe(400);
    // 未认证(全新无 Cookie 浏览器上下文)写入 → 401
    const anonymous = await browser.newContext();
    const guestPage = await anonymous.newPage();
    const guestPut = await guestPage.request.put(FAV_URL + '/fx-ch-002', { data: {} });
    expect(guestPut.status()).toBe(401);
    await anonymous.close();
    // 失效点播(fx-vod-481,present=0):公共详情同形 404,无播放入口(不当作可播放)
    await page.goto('/media/fx-vod-481');
    await expect(page.getByText(/内容不存在或已下架/)).toBeVisible();
    await expect(page.getByRole('button', { name: /播放/ })).toHaveCount(0);
  });
});
