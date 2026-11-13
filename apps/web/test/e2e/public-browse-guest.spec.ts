import { expect, test } from '@playwright/test';

/**
 * T021(US1 Playwright e2e):游客无会话直接浏览公共页面(SC-001 游客部分基线)。
 * 对照 docs/specs/005-pc-browsing-flow/tasks.md T021 与 spec.md US1 独立测试:
 * - E2E_SEED_SCALE=1 环境(webServer 自动起 Nest+vite 并种子 T012 规模夹具:
 *   200 频道 / 500 点播 / 固定时钟);
 * - 无会话浏览器直接打开并刷新 `/`、`/vod`、`/media/:id`(点播 id 从
 *   GET /api/public/media 现取,保证为夹具中的可用内容),断言不跳转登录、
 *   不要求选档、目录/详情元数据可见;
 * - `/live`、`/live/guide` 仅断言入口可达、无登录门槛(节目内容在 US5/US6
 *   与 T141 集成后验证);
 * - 全程使用全新 context(无 cookie),等价「没有会话的浏览器」。
 */

test.describe('游客直接浏览家庭内容(T021)', () => {
  let availableMediaId: string;
  let availableMediaTitle: string;

  test.beforeAll(async ({ request }) => {
    // 游客请求上下文(无 cookie):从公共目录现取一个可用点播媒体
    const response = await request.get('/api/public/media?type=movie&pageSize=1');
    expect(response.status()).toBe(200);
    const page = (await response.json()) as {
      items: Array<{ id: string; title: string }>;
      total: number;
    };
    expect(page.total).toBeGreaterThan(0);
    expect(page.items.length).toBeGreaterThan(0);
    availableMediaId = page.items[0]!.id;
    availableMediaTitle = page.items[0]!.title;
  });

  test.describe.configure({ mode: 'serial' });

  test('游客打开首页 `/`:公共区可见,不跳转登录,刷新后仍可浏览', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/$/);
    // 公共导航壳可见;登录入口为占位按钮而非强制跳转
    await expect(page.getByRole('link', { name: '映岬 Cinecape' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '公共导航' })).toBeVisible();
    await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
    // 公共区入口(直播摘要入口/节目单入口/点播入口)可见
    await expect(page.getByRole('heading', { name: '首页', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: /所有节目单/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^点播 浏览基础点播目录/ })).toBeVisible();
    // 不要求选档/登录:无任何弹层(登录/选档均为 US2 统一受控弹层)
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // 刷新后仍可加载(公共页直接刷新仍可加载,ui.md §1)
    await page.reload();
    await expect(page.getByRole('heading', { name: '首页', level: 1 })).toBeVisible();
    await expect(page).not.toHaveURL(/login|profiles/);
  });

  test('游客打开点播目录 `/vod`:目录元数据可见,刷新后恢复加载', async ({ page }) => {
    await page.goto('/vod');
    await expect(page).toHaveURL(/\/vod/);
    // 目录渲染夹具可用内容(规模夹具标题形态「夹具影片 …」)
    await expect(page.getByRole('heading', { name: '点播', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: /夹具影片/ }).first()).toBeVisible();
    await expect(page.getByRole('group', { name: '类型筛选' })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('link', { name: /夹具影片/ }).first()).toBeVisible();
    await expect(page).not.toHaveURL(/login|profiles/);
  });

  test('游客直达详情 `/media/:id`:元数据可见、无个人状态,刷新后仍可读', async ({ page }) => {
    await page.goto(`/media/${availableMediaId}`);
    await expect(page).toHaveURL(new RegExp(`/media/${availableMediaId}$`));
    // 详情元数据可见(标题即公共投影 title;成人级内容不隐藏)
    await expect(page.getByRole('heading', { name: availableMediaTitle, level: 1 })).toBeVisible();
    await expect(page.getByText('类型')).toBeVisible();
    // 无个人状态区(进度/收藏不出现);播放入口为 US3 统一入口(游客点击先登录选档,
    // 不发起任何播放请求,FR-011)
    await expect(page.getByText(/观看历史|继续观看/)).toHaveCount(0);
    const playRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/playback/')) {
        playRequests.push(request.url());
      }
    });
    await page.getByRole('button', { name: `播放 ${availableMediaTitle}` }).click();
    await expect(page.locator('[role="dialog"][data-slot="modal-dialog"]').getByRole('heading', { name: '登录' })).toBeVisible();
    expect(playRequests).toEqual([]);
    // 取消:回原页面,弹层关闭(不自动播放)
    await page.locator('[role="dialog"][data-slot="modal-dialog"]').getByRole('button', { name: '取消' }).click();
    await expect(page.locator('[role="dialog"][data-slot="modal-dialog"]')).toBeHidden();
    expect(playRequests).toEqual([]);

    await page.reload();
    await expect(page.getByRole('heading', { name: availableMediaTitle, level: 1 })).toBeVisible();
    await expect(page).not.toHaveURL(/login|profiles/);
  });

  test('游客打开 `/live` 与 `/live/guide`:入口可达,无登录门槛(内容归 US5/US6)', async ({ page }) => {
    await page.goto('/live');
    await expect(page).toHaveURL(/\/live$/);
    await expect(page.getByRole('heading', { name: '直播', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: '登录' })).toBeVisible();

    await page.goto('/live/guide');
    await expect(page).toHaveURL(/\/live\/guide$/);
    // 页面标题按产品要求仅保留语义(sr-only),不呈现可见文案
    await expect(page.getByRole('heading', { name: '节目单', level: 1 })).toBeAttached();
    // 两页均无登录跳转(仅断言入口无门槛;节目内容 US5/US6 后验证)
    await expect(page).not.toHaveURL(/login|profiles/);
  });
});
