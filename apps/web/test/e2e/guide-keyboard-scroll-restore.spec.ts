import { expect, test, type Page, type Locator } from '@playwright/test';

/**
 * EPG 节目单键盘/滚动/位置恢复 e2e(T110;FR-043/044/045、Edge Cases、ui.md §6):
 * 前置:E2E_SEED_SCALE=1 种子 T012 规模夹具(200 频道/67,200 排期),服务端时钟
 * 锚定 SCALE_FIXTURE_FIXED_NOW_MS(2026-11-04T12:05Z = 20:05 CST,家庭时区
 * Asia/Shanghai);/live/guide 直接可用。
 *
 * 覆盖:
 * - 从直播页「所有节目单」入口进入 /live/guide(US5 入口 → US6 墙);
 * - 键盘 Tab 到可见节目、焦点可见(:focus-visible outline,FR-044);
 * - 翻页/换窗后焦点定位到新窗口标题(不掉页面起点、不困于隐藏元素);
 * - EPG 局部二维滚动:横向滚动只在墙内,不扩散为整页横向溢出;
 * - 768 窄窗/600 高与 200% 缩放(等价 CSS 视口 384×300)无整页横向溢出;
 * - 查看节目详情返回、取消播放登录后恢复原日期、频道与时间位置(FR-045)。
 *
 * 限频注意:guide 30 次/分钟(契约 §1)为本套件与性能套件共享;本套件仅在
 * 参数变化时产生 guide 请求(纯键盘/滚动操作不重新请求),全程 ≤8 次。
 */

/** 节目按钮的可辨识 aria-label:含「频道,标题,起–止」(逗号 + 时段范围) */
function programmeButton(page: Page): Locator {
  return page.getByRole('region', { name: '节目墙' }).locator('button[aria-label*=","][aria-label*="–"]').first();
}

/** 登录弹层(HeroUI Modal;与播放面 data-testid 区分) */
function authDialog(page: Page): Locator {
  return page.locator('[role="dialog"][data-slot="modal-dialog"]');
}

async function guideUrlParams(page: Page): Promise<string> {
  return page.evaluate(() => window.location.search);
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

test.describe('EPG 节目单键盘、滚动与位置恢复(T110)', () => {
  test.describe.configure({ mode: 'serial' });

  test('从直播页「所有节目单」入口进入节目单墙,游客可见频道与节目', async ({ page }) => {
    await page.goto('/live');
    const entry = page.getByRole('region', { name: '所有节目单入口' }).getByRole('link', { name: '进入节目单' });
    await expect(entry).toBeVisible();
    await entry.click();
    await expect(page).toHaveURL(/\/live\/guide/);
    // 墙渲染:窗口标题 + 频道行 + 节目按钮(家庭时区 20:05 锚定的默认窗口)
    const wall = page.getByRole('region', { name: '节目墙' });
    await expect(wall.locator('#guide-window-title')).toContainText('家庭时区', { timeout: 30_000 });
    await expect(programmeButton(page)).toBeVisible();
    // 7 日期 Tab(今天标注)+ 当前时间标识
    await expect(page.getByRole('group', { name: '节目单日期' }).getByRole('button')).toHaveCount(7);
    await expect(page.getByRole('group', { name: '节目单日期' }).getByRole('button').first()).toContainText('今天');
    await expect(page.getByRole('status', { name: /当前时间 20:05/ })).toBeVisible();
  });

  test('键盘 Tab 到可见节目且焦点可见(:focus-visible);翻页后焦点定位到新窗口标题', async ({ page }) => {
    await page.goto('/live/guide');
    const wall = page.getByRole('region', { name: '节目墙' });
    await expect(programmeButton(page)).toBeVisible({ timeout: 30_000 });

    // Tab 前进直到焦点落在节目按钮上(原生 button,可达;上限 80 次防死循环)
    let focusedLabel = '';
    for (let tab = 0; tab < 80; tab += 1) {
      await page.keyboard.press('Tab');
      focusedLabel = await page.evaluate(() => {
        const active = document.activeElement;
        return active instanceof HTMLButtonElement ? (active.getAttribute('aria-label') ?? '') : '';
      });
      if (focusedLabel.includes(',') && focusedLabel.includes('–')) {
        break;
      }
    }
    expect(focusedLabel).toContain(',');
    expect(focusedLabel).toContain('–');
    // 焦点可见:键盘焦点触发 :focus-visible;应用约定为 outline 或 ring 阴影
    // (组件层 focus:outline-none + focus-visible:ring-2 ring-focus,HEROUI/ a11y 基线)
    const focusStyle = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) {
        return { outline: '', shadow: '' };
      }
      const computed = window.getComputedStyle(active);
      return { outline: `${computed.outlineStyle} ${computed.outlineWidth}`, shadow: computed.boxShadow };
    });
    const hasOutline = focusStyle.outline.includes('solid') && !focusStyle.outline.includes(' 0px');
    const hasRing = focusStyle.shadow !== 'none' && focusStyle.shadow.trim().length > 0;
    expect(hasOutline || hasRing).toBe(true);
    // 焦点元素在视口内可见(不掉到页面起点、不困于隐藏元素)
    const focused = page.locator('[role="region"][aria-label="节目墙"] button[aria-label*=","][aria-label*="–"]').first();
    await expect(focused).toBeVisible();

    // 翻页(频道分批):焦点自动定位到新窗口标题(FR-044),不落回页面起点
    await page.getByRole('button', { name: '下一页' }).click();
    await expect(page.locator('#guide-window-title')).toBeFocused({ timeout: 10_000 });
    const focusAfterPaging = await page.evaluate(() => document.activeElement?.id ?? '');
    expect(focusAfterPaging).toBe('guide-window-title');

    // 换窗(后一窗口):同样定位到新窗口标题
    await page.getByRole('button', { name: '后一窗口' }).click();
    await expect(page.locator('#guide-window-title')).toBeFocused({ timeout: 10_000 });
    // 页面焦点没有回到 body(不掉起点)
    const focusTag = await page.evaluate(() => document.activeElement?.tagName ?? '');
    expect(focusTag).not.toBe('BODY');
    void wall;
  });

  test('EPG 局部二维滚动:横向滚动只在墙内,不扩散为整页横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 600 });
    // 显式 6 小时窗口(00:00–06:00 CST = UTC [16:00Z, 22:00Z)):墙内容宽 = 176 + 6h×2px/min = 896px,
    // 窄窗下必然超出容器宽 → 局部横向滚动可被断言(默认窗口在锚点时刻为裁剪后的 ~4.4h,不一定溢出)
    await page.goto('/live/guide?from=2026-11-03T16%3A00%3A00.000Z&to=2026-11-03T22%3A00%3A00.000Z');
    await expect(programmeButton(page)).toBeVisible({ timeout: 30_000 });

    const wall = page.locator('[role="region"][aria-label="节目墙"]');
    const scrollState = await page.evaluate(() => {
      const container = document.querySelector('[role="region"][aria-label="节目墙"]');
      if (container === null) {
        throw new Error('未找到节目墙容器');
      }
      return {
        containerScrollWidth: container.scrollWidth,
        containerClientWidth: container.clientWidth,
        pageScrollWidth: document.documentElement.scrollWidth,
        pageClientWidth: document.documentElement.clientWidth,
      };
    });
    // 墙内容横向可滚(内容宽 > 容器宽),而整页无横向溢出(滚动被约束在墙内,FR-043)
    expect(scrollState.containerScrollWidth).toBeGreaterThan(scrollState.containerClientWidth);
    expect(scrollState.pageScrollWidth).toBeLessThanOrEqual(scrollState.pageClientWidth);

    // 在墙上横向滚动:容器 scrollLeft 变化,整页 scrollX 保持 0
    await wall.hover();
    await page.mouse.wheel(240, 0);
    await page.waitForTimeout(200);
    const afterWheel = await page.evaluate(() => ({
      containerLeft: (document.querySelector('[role="region"][aria-label="节目墙"]') as HTMLElement).scrollLeft,
      pageX: window.scrollX,
    }));
    expect(afterWheel.containerLeft).toBeGreaterThan(0);
    expect(afterWheel.pageX).toBe(0);
  });

  for (const viewport of [
    { name: '768 窄窗/600 高', width: 768, height: 600 },
    { name: '200% 缩放(等价 CSS 视口 384×300)', width: 384, height: 300 },
  ]) {
    test(`${viewport.name}:无整页横向溢出,墙内收拢为内部滚动`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/live/guide');
      await expect(programmeButton(page)).toBeVisible({ timeout: 30_000 });
      const state = await page.evaluate(() => ({
        pageScrollWidth: document.documentElement.scrollWidth,
        pageClientWidth: document.documentElement.clientWidth,
        containerClientWidth: (document.querySelector('[role="region"][aria-label="节目墙"]') as HTMLElement | null)?.clientWidth ?? 0,
      }));
      expect(state.pageScrollWidth).toBeLessThanOrEqual(state.pageClientWidth);
      // 墙容器收拢(窄于视口,内部滚动),不是把内容摊到页面上
      expect(state.containerClientWidth).toBeLessThanOrEqual(state.pageClientWidth);
    });
  }

  test('节目详情返回恢复原日期、频道与时间位置(URL 参数 + 滚动锚点不变,FR-045)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/live/guide');
    const target = programmeButton(page);
    await expect(target).toBeVisible({ timeout: 30_000 });

    // 造一个「原浏览位置」:墙内二维滚动到非零锚点
    await page.evaluate(() => {
      const container = document.querySelector('[role="region"][aria-label="节目墙"]') as HTMLElement;
      container.scrollLeft = 200;
      container.scrollTop = 96;
    });
    const beforeScroll = await wallScrollOf(page);
    expect(beforeScroll.top).toBeGreaterThan(0);
    const beforeParams = await guideUrlParams(page);

    // 打开详情(宽窗侧栏):dispatchEvent 触发点击,避免 Playwright 可操作性滚动破坏已设锚点
    await target.dispatchEvent('click');
    const detail = page.getByRole('complementary', { name: '节目详情' });
    await expect(detail).toBeVisible();

    // 返回(取消)→ 详情关闭,URL 与滚动位置原样恢复
    await detail.getByRole('button', { name: '取消' }).click();
    await expect(detail).toBeHidden();
    expect(await guideUrlParams(page)).toBe(beforeParams);
    const afterScroll = await wallScrollOf(page);
    expect(afterScroll.left).toBeCloseTo(beforeScroll.left, 5);
    expect(afterScroll.top).toBeCloseTo(beforeScroll.top, 5);
  });

  test('取消播放登录(游客)后恢复原日期、频道与时间位置;登录前零播放/媒体请求', async ({ page }) => {
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
    await page.evaluate(() => {
      const container = document.querySelector('[role="region"][aria-label="节目墙"]') as HTMLElement;
      container.scrollLeft = 160;
      container.scrollTop = 64;
    });
    const beforeScroll = await wallScrollOf(page);
    expect(beforeScroll.top).toBeGreaterThan(0);
    const beforeParams = await guideUrlParams(page);

    // 详情 → 「观看该频道当前直播」(游客)→ 详情先关、统一登录弹层出现
    // (dispatchEvent 同上:保持滚动锚点,不被可操作性滚动重置)
    await target.dispatchEvent('click');
    const detail = page.getByRole('complementary', { name: '节目详情' });
    await expect(detail).toBeVisible();
    await detail.getByRole('button', { name: /当前直播/ }).click();
    const dialog = authDialog(page);
    await expect(dialog.getByRole('heading', { name: '登录' })).toBeVisible({ timeout: 15_000 });
    expect(mediaRequests).toEqual([]); // 登录前零播放/媒体请求(US3/FR-011)

    // 取消登录:回原页面(URL 不变、滚动锚点不变、详情不再遮挡)
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toBeHidden();
    expect(await guideUrlParams(page)).toBe(beforeParams);
    const afterScroll = await wallScrollOf(page);
    expect(afterScroll.left).toBeCloseTo(beforeScroll.left, 5);
    expect(afterScroll.top).toBeCloseTo(beforeScroll.top, 5);
    expect(mediaRequests).toEqual([]);
  });
});
