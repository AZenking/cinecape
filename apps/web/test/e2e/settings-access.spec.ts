import { expect, test, type Page } from '@playwright/test';

/**
 * T079(005 US7 Playwright e2e,先 FAIL):主 Profile 验证后进入统一设置(SC-007)。
 * 权威:docs/specs/005-pc-browsing-flow/contracts/ui.md §7、contracts/api.md §6/§7、
 * spec FR-031/032/033、SC-007、ADR-0011。
 *
 * 前置:E2E_SEED_SCALE=1 规模夹具(fixtureadmin/password-123;主成人「主档案」
 * mainPin=135790、儿童「儿童档案」childPin=246800;夹具会话已选主档案)。
 *
 * 覆盖:主 Profile 菜单设置入口→独立 PIN 验证→左菜单/右主体布局+可导航空架;
 * 选档解锁与设置解锁独立;DELETE /settings/access 后主体隐藏与重新验证恢复
 * (15 分钟固定 TTL 的自然到期场景留待 T141/T144 服务端时间受控验证 —— 本套件
 * 以「撤销后主体隐藏 + 重新验证恢复」验证同一拒绝/恢复路径);解锁期间要求账号
 * 密码的操作(PIN 恢复)仍逐次验证(FR-033);普通成人/儿童档案无设置入口且
 * 直达 /settings/* 被拒;取消 PIN 输入返回原页面,旧回调不得重开。
 *
 * ⚠️ 本套件要求服务端已注册 SettingsModule(app.module.ts 一行,见 US7 报告);
 * 未注册时 /api/settings/** 全部 404,本套件按 FAIL 呈现(与 T079 先 FAIL 一致)。
 */

const LOGIN = { username: 'fixtureadmin', password: 'password-123' } as const;
const MAIN_PIN = '135790';
const CHILD_PIN = '246800';
const PIN_FIELD = '设置 PIN(6 位数字)';
// 菜单拆分:家庭管理组 = IPTV 管理(/settings/iptv)+ NAS/点播(/settings/sources),原「来源管理/EPG 管理」不再存在
const SETTING_MODULE_TITLES = ['账号信息', '成员管理', '内容策略', 'IPTV 管理', 'NAS/点播', '设备管理', '家庭设置'];

interface ProfileSummaryDto {
  id: string;
  name: string;
  isMain: boolean;
  pinProtected: boolean;
  status: string;
}

async function apiLogin(page: Page): Promise<void> {
  const res = await page.request.post('/api/auth/login', { data: { ...LOGIN } });
  expect(res.status(), 'API 登录应成功').toBe(200);
}

async function listProfiles(page: Page): Promise<ProfileSummaryDto[]> {
  const res = await page.request.get('/api/profiles');
  expect(res.status()).toBe(200);
  return (await res.json()) as ProfileSummaryDto[];
}

async function unlockAndSelect(page: Page, profileId: string, pin: string): Promise<void> {
  const unlock = await page.request.post(`/api/profiles/${profileId}/unlock`, { data: { pin } });
  expect(unlock.status(), JSON.stringify(await unlock.json())).toBe(200);
  const select = await page.request.post(`/api/profiles/${profileId}/select`, { data: {} });
  expect(select.status()).toBe(200);
}

async function mainProfileOf(page: Page): Promise<ProfileSummaryDto> {
  const main = (await listProfiles(page)).find((profile) => profile.isMain);
  expect(main, '夹具应含主档案').toBeDefined();
  return main!;
}

/** 打开身份菜单(已选档态) */
async function openIdentityMenu(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /主档案|儿童档案|爸爸/ }).click();
}

test.describe.serial('T079 · 主 Profile 验证后进入统一设置(SC-007)', () => {
  let ordinaryAdultId: string | null = null;

  test('主 Profile:菜单设置入口 → 独立 PIN 验证 → 左菜单/右主体布局与七实页', async ({ page }) => {
    await apiLogin(page);
    const main = await mainProfileOf(page);
    await unlockAndSelect(page, main.id, MAIN_PIN);

    // 管理主体零预取:进入设置前监听请求
    const accountRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/settings/account')) {
        accountRequests.push(request.url());
      }
    });

    await openIdentityMenu(page);
    await page.getByRole('menuitem', { name: '设置' }).click();
    // lead 接线后的统一意图流(ui.md §3):设置入口经 settingsPin 弹层验证,
    // 验证成功才导航到 /settings/account;URL 在弹层期间保持原页面
    await expect(page.getByRole('heading', { name: '输入设置 PIN' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');

    // 未解锁:弹层只显示 PIN 输入(独立验证),不预取账号管理主体
    await expect(page.getByLabel(PIN_FIELD)).toBeVisible();
    await expect(page.getByTestId('account-summary')).toBeHidden();
    expect(accountRequests).toHaveLength(0);

    // 错误 PIN:服务端 detail 文字呈现,不进入布局
    await page.getByLabel(PIN_FIELD).fill('000000');
    await page.getByRole('button', { name: '验证并进入设置' }).click();
    await expect(page.getByRole('alert').filter({ hasText: '剩余尝试次数' })).toBeVisible();
    await expect(page.getByTestId('account-summary')).toBeHidden();

    // 独立 PIN 验证成功 → 弹层关闭并导航进入布局
    await page.getByLabel(PIN_FIELD).fill(MAIN_PIN);
    await page.getByRole('button', { name: '验证并进入设置' }).click();
    await expect(page).toHaveURL(/\/settings\/account$/);

    // 左菜单/右主体布局:七个子模块全部注册
    const nav = page.getByRole('navigation', { name: '设置子菜单' });
    await expect(nav).toBeVisible();
    for (const title of SETTING_MODULE_TITLES) {
      await expect(nav.getByRole('option', { name: title })).toBeVisible();
    }
    await expect(page.getByTestId('settings-current-module')).toHaveText('账号信息');
    // 账号信息实页(T132):只读 AccountSummary 呈现真实服务端数据
    await expect(page.getByTestId('account-summary')).toContainText('fixtureadmin');
    expect(accountRequests.length).toBeGreaterThanOrEqual(1);

    // 夹具补一个普通成人档案(后续负向用例使用)。005 US8 起管理写迁入设置边界:
    // 旧 POST /api/profiles 已删除,经 /api/settings/profiles 创建(需先解锁设置,
    // 上面 UI PIN 验证已解锁;013/ADR-0017:创建档案为常规操作免当次密码,
    // 请求体不带 ownerPassword —— 服务端 strict 契约拒绝未知字段)
    if (ordinaryAdultId === null) {
      const created = await page.request.post('/api/settings/profiles', {
        data: { name: '爸爸', type: 'adult', pin: '369258' },
      });
      if (created.status() === 201) {
        ordinaryAdultId = ((await created.json()) as { id: string }).id;
      }
    }

    // 导航到成员管理:US8 实页(T131 后占位已替换)—— 档案列表呈现真实服务端数据
    await nav.getByRole('option', { name: '成员管理' }).click();
    await expect(page).toHaveURL(/\/settings\/profiles$/);
    await expect(page.getByTestId('settings-current-module')).toHaveText('成员管理');
    await expect(page.getByTestId('profile-list')).toBeVisible();
    await expect(page.getByTestId('profile-list')).toContainText('主档案');
  });
  test('选档解锁与设置解锁相互独立:选档后进设置仍要求 PIN;取消返回原页面', async ({ page }) => {
    await apiLogin(page);
    const main = await mainProfileOf(page);
    // 选档解锁(输过一次 PIN)不等于设置解锁
    await unlockAndSelect(page, main.id, MAIN_PIN);

    await page.goto('/vod');
    await page.getByRole('button', { name: /主档案/ }).click();
    await page.getByRole('menuitem', { name: '设置' }).click();
    // 统一意图流:仍在 /vod 弹出 settingsPin(选档已解锁不豁免设置 PIN)
    await expect(page.getByRole('heading', { name: '输入设置 PIN' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/vod');
    // 设置解锁独立:仍要求 PIN(选档已解锁也须再验证)
    await expect(page.getByLabel(PIN_FIELD)).toBeVisible();

    // 取消 PIN 输入:弹层关闭留在原页面(/vod),旧回调不得重开已取消的设置
    await page.getByLabel(PIN_FIELD).fill(MAIN_PIN);
    await page.getByRole('button', { name: '取消' }).click();
    await expect(page).toHaveURL(/\/vod$/);
    await page.waitForTimeout(600);
    await expect(page).toHaveURL(/\/vod$/); // 不自动重开
    await expect(page.getByLabel(PIN_FIELD)).toBeHidden();
  });

  test('撤销后主体隐藏、重新验证恢复(15 分钟固定 TTL 到期场景替身,见注释)', async ({ page }) => {
    await apiLogin(page);
    const main = await mainProfileOf(page);
    await unlockAndSelect(page, main.id, MAIN_PIN);

    await page.goto('/settings/account');
    await page.getByLabel(PIN_FIELD).fill(MAIN_PIN);
    await page.getByRole('button', { name: '验证并进入设置' }).click();
    await expect(page.getByTestId('account-summary')).toBeVisible();

    // 服务端撤销(15 分钟固定 TTL 不可缩短:自然到期由 T141/T144 服务端时间受控
    // 验证;本用例经 DELETE /settings/access 验证同一「失效 → 拒绝 → 恢复」路径)
    expect((await page.request.delete('/api/settings/access')).status()).toBe(204);
    await page.reload();
    await expect(page.getByLabel(PIN_FIELD)).toBeVisible();
    await expect(page.getByTestId('account-summary')).toBeHidden();

    // 重新验证恢复
    await page.getByLabel(PIN_FIELD).fill(MAIN_PIN);
    await page.getByRole('button', { name: '验证并进入设置' }).click();
    await expect(page.getByTestId('account-summary')).toBeVisible();
  });

  test('儿童档案:无设置入口,直达 /settings/* 被服务端拒绝', async ({ page }) => {
    await apiLogin(page);
    const child = (await listProfiles(page)).find((profile) => profile.name === '儿童档案');
    expect(child).toBeDefined();
    await unlockAndSelect(page, child!.id, CHILD_PIN);

    // 普通(非主)档案隐藏设置入口(隐藏入口不替代服务端校验)
    await openIdentityMenu(page);
    await expect(page.getByRole('menuitem', { name: '设置' })).toBeHidden();
    await page.keyboard.press('Escape');

    // 直达 /settings/*:页面本身只呈现解锁门,管理主体零返回;凭据正确的儿童 PIN
    // 也在服务端被拒(403),不泄露任何管理数据
    await page.goto('/settings/account');
    await expect(page.getByLabel(PIN_FIELD)).toBeVisible();
    await page.getByLabel(PIN_FIELD).fill(CHILD_PIN);
    await page.getByRole('button', { name: '验证并进入设置' }).click();
    await expect(page.getByRole('alert').filter({ hasText: '仅限当前主档案' })).toBeVisible();
    const account = await page.request.get('/api/settings/account');
    expect(account.status()).toBe(403);
    expect(((await account.json()) as { code: string }).code).toBe('SETTINGS_ACCESS_REQUIRED');
  });

  test('普通成人档案:同样无设置入口且直达被拒', async ({ page }) => {
    test.skip(ordinaryAdultId === null, '普通成人档案未创建(首用例失败时跳过)');
    await apiLogin(page);
    await unlockAndSelect(page, ordinaryAdultId!, '369258');

    await openIdentityMenu(page);
    await expect(page.getByRole('menuitem', { name: '设置' })).toBeHidden();
    await page.keyboard.press('Escape');

    await page.goto('/settings/account');
    await expect(page.getByLabel(PIN_FIELD)).toBeVisible();
    await page.getByLabel(PIN_FIELD).fill('369258');
    await page.getByRole('button', { name: '验证并进入设置' }).click();
    await expect(page.getByRole('alert').filter({ hasText: '仅限当前主档案' })).toBeVisible();
    expect((await page.request.get('/api/settings/account')).status()).toBe(403);
  });

  test('解锁期间要求账号密码的操作(PIN 恢复)仍逐次验证(FR-033);恢复后旧设置 PIN 失效', async ({ page }) => {
    await apiLogin(page);
    const main = await mainProfileOf(page);
    await unlockAndSelect(page, main.id, MAIN_PIN);

    await page.goto('/settings/account');
    await page.getByLabel(PIN_FIELD).fill(MAIN_PIN);
    await page.getByRole('button', { name: '验证并进入设置' }).click();
    await expect(page.getByTestId('account-summary')).toBeVisible();

    const recovery = (await page.request.get('/api/auth/session')).status() === 200;
    expect(recovery).toBe(true);

    // 有效设置 grant 不豁免当次账号密码:缺密码 400、错误密码 403(逐次验证)
    const missing = await page.request.post('/api/auth/main-profile/pin-recovery', {
      data: { newPin: '246813' },
    });
    expect(missing.status()).toBe(400);
    const wrong = await page.request.post('/api/auth/main-profile/pin-recovery', {
      data: { newPin: '246813', ownerPassword: 'totally-wrong-pass' },
    });
    expect(wrong.status()).toBe(403);
    // 失败的恢复不撤销有效设置授权
    const stillUnlocked = (await (await page.request.get('/api/settings/access')).json()) as { unlocked: boolean };
    expect(stillUnlocked.unlocked).toBe(true);

    // 正确当次密码:恢复成功(204);服务端撤销全部设置授予(pin_version/清身份)
    const ok = await page.request.post('/api/auth/main-profile/pin-recovery', {
      data: { newPin: '246813', ownerPassword: LOGIN.password },
    });
    expect(ok.status()).toBe(204);
    const access = await page.request.get('/api/settings/access');
    expect(((await access.json()) as { unlocked: boolean }).unlocked).toBe(false);

    // 旧设置 PIN 不再可用;页面回到解锁门(不自动重开)
    await page.reload();
    await expect(page.getByLabel(PIN_FIELD)).toBeVisible();
    await page.getByLabel(PIN_FIELD).fill(MAIN_PIN);
    await page.getByRole('button', { name: '验证并进入设置' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    expect((await page.request.get('/api/settings/account')).status()).toBe(403);
  });
});
