import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * T035(005 US2 e2e):SC-002 主链路 —— 全新部署配置→显式登录→零档案首建→
 * 选档/解锁→回原目标→刷新恢复→退出;负向:取消登录返回原页面无媒体请求、
 * 无重复弹窗;已初始化直接登录选档;错误凭据统一失败提示。
 *
 * 独立 DATA_DIR 由 playwright webServer(scripts/e2e-servers.sh)保证:每次运行
 * 全新空库 —— 本套件第一个用例即「全新部署」。
 *
 * 触发方式:PublicLayout 正式接线(登录按钮 onPress→useAuthAction、身份菜单
 * <IdentityMenu />)由 lead 完成;接线前经协调器程序化入口 hmp:auth-intent
 * (同一代码路径)发起意图,接线后可原样切换为点击头部入口。
 * 所有弹层断言/操作一律 scope 到 role=dialog(PublicLayout 头部还有静态
 * 「登录」占位按钮,避免 strict mode 冲突;接线后二者合一)。
 */

/** 经协调器程序化入口发起认证意图(与 PublicLayout 接线后同一代码路径) */
async function dispatchIntent(page: Page, action: string, returnTo?: string): Promise<void> {
  await page.evaluate(
    ([intentAction, intentReturnTo]) => {
      window.dispatchEvent(
        new CustomEvent('hmp:auth-intent', {
          detail: { action: intentAction, returnTo: intentReturnTo },
        }),
      );
    },
    [action, returnTo],
  );
}

/** 唯一受控弹层(单 Modal,分步切换内容) */
function dialog(page: Page): Locator {
  return page.getByRole('dialog');
}

async function expectStep(page: Page, title: string): Promise<void> {
  // 步骤标题 = Modal.Heading(h2);步骤内按钮可能同名(如「登录」),用 heading role 消歧
  await expect(dialog(page).getByRole('heading', { name: title, exact: true })).toBeVisible();
}

async function expectStepHidden(page: Page, title: string): Promise<void> {
  await expect(dialog(page).getByRole('heading', { name: title, exact: true })).toBeHidden();
}

test.describe.serial('T035 · 认证与选档主链路(SC-002)', () => {
  test('全新部署:初始化弹窗配置 → 201 后停留显式登录 → 手动登录 → 零档案首建 → 选档解锁 → 回到原目标', async ({ page }) => {
    await page.goto('/');

    // FR-006:未初始化时以弹窗配置家庭和主账号(自动弹出,单 Modal)
    await expectStep(page, '配置家庭主账号');
    await dialog(page).getByLabel('家庭名称').fill('幸福之家');
    await dialog(page).getByLabel('管理员用户名').fill('admin');
    await dialog(page).getByLabel('密码', { exact: true }).fill('password-123');
    await dialog(page).getByRole('button', { name: '创建家庭账号' }).click();

    // FR-007:201 后停留在显式登录步骤 —— 不自动登录(弹窗内容切换为登录)
    await expectStep(page, '登录');
    await expect(dialog(page).getByLabel('用户名')).toBeVisible();

    // 负向(错误凭据统一失败提示):错误密码得到统一失败文案
    await dialog(page).getByLabel('用户名').fill('admin');
    await dialog(page).getByLabel('密码', { exact: true }).fill('totally-wrong-pass');
    await dialog(page).getByRole('button', { name: '登录', exact: true }).click();
    await expect(dialog(page).getByText('用户名或密码错误')).toBeVisible();

    // 手动登录成功(仍在同一弹层内继续原意图)
    await dialog(page).getByLabel('密码', { exact: true }).fill('password-123');
    await dialog(page).getByRole('button', { name: '登录', exact: true }).click();

    // FR-030:零档案 → 首建(名称 + 6 位数字 PIN + 当次密码)
    await expectStep(page, '创建主档案');
    await dialog(page).getByLabel('档案名称').fill('妈妈');
    await dialog(page).getByLabel('档案 PIN(6 位数字)').fill('246810');
    await dialog(page).getByLabel('当前账号密码').fill('password-123');
    await dialog(page).getByRole('button', { name: '创建主档案' }).click();

    // 首建成功进入选档(不静默激活主档案)
    await expectStep(page, '选择 Profile');
    await dialog(page).getByRole('button', { name: /妈妈/ }).click();

    // 受 PIN 保护档案先验证(选档 PIN ≠ 设置 PIN)
    await expectStep(page, '输入档案 PIN');
    await dialog(page).getByLabel('档案 PIN').fill('246810');
    await dialog(page).getByRole('button', { name: '解锁并选择' }).click();

    // 选档成功:弹层关闭并回到原目标(本链路发起于首页)
    await expect(dialog(page)).toBeHidden();
    await expect(page).toHaveURL(/\/$/);

    // 服务端会话事实:当前 Profile 已选择
    const session = await page.request.get('/api/auth/session');
    expect(session.status()).toBe(200);
    const dto = (await session.json()) as { activeProfile: { name: string } | null };
    expect(dto.activeProfile?.name).toBe('妈妈');

    // 刷新恢复(FR-009,同一浏览器上下文):会话与当前 Profile 持久,公共页正常渲染
    await page.reload();
    await expect(page.getByRole('link', { name: 'HOME MEDIA' })).toBeVisible();
    await expect(dialog(page)).toBeHidden();
    const restored = await page.request.get('/api/auth/session');
    expect(restored.status()).toBe(200);
    const restoredDto = (await restored.json()) as {
      account: { username: string };
      activeProfile: { name: string } | null;
      bootstrapRequired: boolean;
    };
    expect(restoredDto.account.username).toBe('admin');
    expect(restoredDto.activeProfile?.name).toBe('妈妈');
    expect(restoredDto.bootstrapRequired).toBe(false);
  });

  test('负向:游客公共页发起登录后取消 —— 返回原页面、无新增媒体请求、不重复弹窗', async ({ page }) => {
    // 先退出(经同一程序化入口;正式接线后为身份菜单「退出登录」)
    await dispatchIntent(page, 'logout');
    await expect
      .poll(async () => (await page.request.get('/api/auth/session')).status(), { timeout: 10_000 })
      .toBe(401);

    await page.goto('/vod');
    await expect(page).toHaveURL(/\/vod$/);
    await expect(page.getByRole('link', { name: 'HOME MEDIA' })).toBeVisible();
    // 已初始化部署:不自动弹出配置弹窗(FR-007 游客仍可浏览)
    await expect(dialog(page)).toBeHidden();

    // 游客发起登录意图 → 统一受控登录弹层
    await dispatchIntent(page, 'login');
    await expectStep(page, '登录');

    // 取消:清凭据与意图、返回原页面(不导航)
    let mediaRequestsAfterCancel = 0;
    let tracking = false;
    page.on('request', (request) => {
      if (tracking && request.url().includes('/api/public/media')) {
        mediaRequestsAfterCancel += 1;
      }
    });
    await dialog(page).getByRole('button', { name: '取消' }).click();
    tracking = true;

    await expect(dialog(page)).toBeHidden();
    await expect(page).toHaveURL(/\/vod$/);
    await page.waitForTimeout(800);
    expect(mediaRequestsAfterCancel).toBe(0); // 取消登录不触发任何媒体请求(FR-010);遮罩已彻底卸载

    // 取消后不自动重开:SPA 内导航到首页也不出现弹窗(不重复弹窗)
    await page.getByRole('link', { name: 'HOME MEDIA' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(dialog(page)).toBeHidden();
  });

  test('已初始化部署:直接登录 → 显式选档(跳过首建)→ 回到原业务目标 /vod', async ({ page }) => {
    await page.goto('/vod');
    await dispatchIntent(page, 'login', '/vod');

    await expectStep(page, '登录');
    await dialog(page).getByLabel('用户名').fill('admin');
    await dialog(page).getByLabel('密码', { exact: true }).fill('password-123');
    await dialog(page).getByRole('button', { name: '登录', exact: true }).click();

    // 已有档案:直接进入选档(不再首建,FR-008)
    await expectStep(page, '选择 Profile');
    await expectStepHidden(page, '创建主档案');
    await dialog(page).getByRole('button', { name: /妈妈/ }).click();

    await expectStep(page, '输入档案 PIN');
    await dialog(page).getByLabel('档案 PIN').fill('246810');
    await dialog(page).getByRole('button', { name: '解锁并选择' }).click();

    // 选档成功回到原业务目标(FR-010:保留本应用内原内容目标)
    await expect(dialog(page)).toBeHidden();
    await expect(page).toHaveURL(/\/vod$/);

    // 最终卫生:退出,恢复游客态(复用同一实例运行时从干净身份开始)
    await dispatchIntent(page, 'logout');
    await expect
      .poll(async () => (await page.request.get('/api/auth/session')).status(), { timeout: 10_000 })
      .toBe(401);
  });
});
