import { expect, test } from '@playwright/test';

/**
 * T013(005-pc-browsing-flow · Phase 2):PC 浏览器骨架 e2e 冒烟门禁。
 *
 * 独立 DATA_DIR 由 playwright.config.ts 注入(按进程隔离的临时目录;本冒烟页面为
 * 公共骨架占位、不发起任何 API 请求,DATA_DIR 仅作为环境语义保证不触碰真实数据)。
 * webServer 由 config 启动 `pnpm --filter @hmp/web dev`(Vite,127.0.0.1:5173)。
 *
 * 断言(仅 Phase 1~2 骨架,不代表 005 功能完成):
 * - 游客打开 `/`:品牌 HOME MEDIA 与 首页/点播/直播 导航渲染,无登录强制跳转;
 * - `/vod`、`/live` 直达对应占位页(真实 005 页面由 US1/US5 接入);
 * - 公共地址全程不出现登录路由跳转(骨架阶段已无 /login 路由)。
 */

test.describe('T013 foundation 冒烟 · 公共骨架(游客)', () => {
  test('首页渲染品牌与导航,不强制登录', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('link', { name: 'HOME MEDIA' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: '公共导航' });
    await expect(nav).toBeVisible();
    for (const label of ['首页', '点播', '直播']) {
      await expect(nav.getByRole('link', { name: label })).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: '首页' })).toBeVisible();

    // 无登录强制跳转:仍在公共首页
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('/vod 与 /live 可达且仍在公共壳内', async ({ page }) => {
    await page.goto('/vod');
    await expect(page.getByRole('heading', { name: '点播' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/vod');
    await expect(page.getByRole('link', { name: 'HOME MEDIA' })).toBeVisible();

    await page.goto('/live');
    // T067 接入真实 LivePage 后页内含「正在直播」等分区标题,断言用 exact 避免歧义
    await expect(page.getByRole('heading', { name: '直播', exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/live');
    await expect(page.getByRole('link', { name: 'HOME MEDIA' })).toBeVisible();
  });
});
