import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * T021(012 US3 e2e 先行)· EPG 状态刷新恢复与「开面板不播放」
 * (FR-016/FR-017/FR-018、url-state §1、ui.md §3.3–§3.5):
 *
 * - 首次进入定位当前时间附近:墙内横向滚动锚落在当前时刻附近(全天窗 2880px,
 *   固定时钟 20:05 CST → 锚点远大于 0),并显示时区说明(家庭时区标注);
 * - 设置语义状态(日期/每页频道数/频道页/视图)→ 刷新 → URL 与语义状态完整恢复;
 *   刷新后滚动回缺省位置可接受(url-state §1 规则3;垂直 0/横向按窗口缺省定位);
 * - 节目块点击打开详情面板而非直接播放:面板出现、全程零 playback/媒体流请求。
 *
 * 前置(与 guide-keyboard/guide-performance 套件同约定):E2E_SEED_SCALE=1 种子
 * 规模夹具(200 频道),服务端时钟锚定 2026-11-04T12:05Z(家庭时区 Asia/Shanghai
 * 20:05);`pnpm --filter @hmp/web exec playwright test test/e2e/guide-state-restore.spec.ts`
 * 经 playwright.config webServer(e2e-servers.sh)自动起双服务,运行时显式带
 * E2E_SEED_SCALE=1。限频:本套件仅参数变化产生 guide 请求,全程 ≤10 次(<30/分)。
 */

/** 节目块按钮可辨识 aria-label(含「频道,标题」逗号与「起–止」) */
function programmeButton(page: Page): Locator {
  return page
    .getByRole('region', { name: '节目墙' })
    .locator('button[aria-label*=","][aria-label*="–"]')
    .first();
}

/** 列表视图的频道分区(仅 GuideChannelList 渲染) */
function listSections(page: Page): Locator {
  return page.locator('[role="region"][aria-label="节目墙"] section[aria-label^="频道"]');
}

/** 墙视图独有:窗口标题锚(仅 GuideWall 渲染) */
function wallTitle(page: Page): Locator {
  return page.locator('#guide-window-title');
}

async function wallScrollOf(page: Page): Promise<{ left: number; top: number }> {
  return page.evaluate(() => {
    const wall = document.querySelector('[role="region"][aria-label="节目墙"]');
    if (wall === null) {
      throw new Error('未找到节目墙滚动容器');
    }
    return { left: wall.scrollLeft, top: wall.scrollTop };
  });
}

test.describe('EPG 状态恢复与开面板不播放(T021)', () => {
  test('首次进入定位当前时间附近,显示时区说明(FR-015;T023 定位)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/live/guide');
    await expect(wallTitle(page)).toContainText('家庭时区', { timeout: 30_000 });
    // 时区说明:头部标注家庭时区(IANA + 偏移;种子/真实部署家庭时区均为 Asia/Shanghai)
    await expect(page.getByText(/Asia\/Shanghai/).first()).toBeVisible();
    // 当前时间标识(家庭时区 HH:mm;具体值由服务端时钟决定,种子环境锚定 20:05)
    await expect(page.getByRole('status', { name: /当前时间 \d{2}:\d{2}/ })).toBeVisible();
    // 定位当前时间附近:横向滚动锚在当前时刻附近(0 表示仍停在 00:00 未定位)
    await expect.poll(async () => (await wallScrollOf(page)).left, { timeout: 10_000 }).toBeGreaterThan(0);
    // 当前节目与后续排期同屏:节目块可见
    await expect(programmeButton(page)).toBeVisible();
  });

  test('设置语义状态 → 刷新 → URL 与语义状态恢复;滚动回缺省可接受(FR-018、url-state §1)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/live/guide');
    await expect(programmeButton(page)).toBeVisible({ timeout: 30_000 });

    // 设置状态:date(明天)→ 每页频道数 50 → 频道第 2 页 → 列表视图
    // (Select 触发器经 T014 稳定 testid 定位:aria-label 与 aria-labelledby 并存,
    //  真实浏览器可访问名由 labelledby 合成,文本定位不稳;jsdom/vitest 无此差异)
    const dateTabs = page.getByRole('group', { name: '节目单日期' }).getByRole('button');
    await dateTabs.nth(1).click();
    await expect(page).toHaveURL(/date=\d{4}-\d{2}-\d{2}/);
    await page.getByTestId('guide-page-size-select').click();
    await page.getByRole('option', { name: '50' }).click();
    await expect(page).toHaveURL(/pageSize=50/);
    await page.getByRole('button', { name: '下一页' }).click();
    await expect(page).toHaveURL(/channelPage=2/);
    await page.getByTestId('guide-view-select').click();
    await page.getByRole('option', { name: '按频道列表' }).click();
    await expect(page).toHaveURL(/view=list/);
    await expect(listSections(page).first()).toBeVisible();

    // 刷新:URL 直挂恢复(语义状态完整;滚动不进 URL)
    await page.reload();
    await expect(page).toHaveURL(/date=\d{4}-\d{2}-\d{2}/);
    await expect(page).toHaveURL(/pageSize=50/);
    await expect(page).toHaveURL(/channelPage=2/);
    await expect(page).toHaveURL(/view=list/);
    // 语义状态恢复:列表视图、日期 Tab 选中、第 2 页内容(翻页按钮可用性来自响应 total)
    await expect(listSections(page).first()).toBeVisible({ timeout: 30_000 });
    await expect(dateTabs.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: '上一页' })).toBeEnabled();

    // 切回墙视图:墙恢复;滚动回缺省位置可接受(垂直 0;明天窗口横向锚 0 = 日首)
    await page.getByTestId('guide-view-select').click();
    await page.getByRole('option', { name: '节目墙' }).click();
    await expect(wallTitle(page)).toBeVisible({ timeout: 30_000 });
    const scroll = await wallScrollOf(page);
    expect(scroll.top).toBe(0);
    expect(scroll.left).toBe(0);
  });

  test('节目块点击开详情面板不播放:面板出现,全程零 playback/媒体请求(FR-017)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const mediaRequests: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('/api/playback') || url.includes('ticket=') || /\.m3u8(\?|$)|\.mp4(\?|$)/.test(url)) {
        mediaRequests.push(url);
      }
    });

    await page.goto('/live/guide');
    const target = programmeButton(page);
    await expect(target).toBeVisible({ timeout: 30_000 });
    const beforeUrl = page.url();

    await target.click();
    // 共享详情面板(浮层)出现:六要素容器语义 + 次操作恒在;状态按时段推导
    const dialog = page.getByRole('dialog', { name: /节目详情/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: '收藏频道' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '查看节目单' })).toBeVisible();
    // 停留在节目单页:URL 未被播放行为改写;零 playback/媒体流请求
    expect(page.url()).toBe(beforeUrl);
    expect(mediaRequests).toEqual([]);

    // 面板可关闭回节目单(不产生任何播放副作用)
    await dialog.getByRole('button', { name: '关闭' }).click();
    await expect(dialog).toBeHidden();
    expect(mediaRequests).toEqual([]);
  });
});
