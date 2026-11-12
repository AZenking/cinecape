import { expect, test, type Page } from '@playwright/test';

/**
 * 012 T006(US1 e2e):游客统一播放链路——三类入口 × 零请求 × 面板一致(SC-001/SC-002/SC-006)。
 *
 * - 三入口:① 直播首页「正在直播」卡片播放按钮;② /live/guide 节目墙频道列「直播」按钮;
 *   ③ 首页「直播」导航入口(游客 IA:导航卡片两跳进入 /live,spec SC-001 澄清裁决)。
 * - 每入口断言:游客点击播放 → 统一登录选档弹层出现;授权前 /playback 与 /api/me 请求计数为 0
 *   (SC-006 负向);取消后弹层关闭不重开。
 * - 015 语义修订(ui-layout §3.2):EPG 墙内与 NOW 相交的 current 块 = 直播语义,点击
 *   直接起播(同统一链路);仅 upcoming/ended 块保持详情面板路径 —— 本套件的「节目块
 *   点击开面板」断言相应只锚定非 current 块,并新增 current 块直起播的链路断言。
 * - 面板一致(SC-002):直播首页 Hero「节目详情」入口与 EPG 节目块详情两路径打开的
 *   dialog 含同一结构特征(家庭时区标注 + 收藏频道/查看节目单/关闭按钮;组件级一致由
 *   T003 单测钉面,e2e 钉宿主产物;015 起 current 档卡片文字区改导航观看页,卡片
 *   文字区不再是面板入口)。
 * - 运行:webServer(reuseExistingServer)沿用 scripts/e2e-servers.sh 双服务;E2E_SEED_SCALE=1
 *   种子环境为标准命令(见 tasks.md/quickstart);真实数据栈亦可跑(选择器全部泛化,不锚定频道名)。
 */

/** 统计页面已发出的 playback 与个人(/api/me)API 请求(零请求负向断言用,差值语义) */
function countSensitiveRequests(page: Page): { playback: number; personal: number; urls: string[] } {
  const counts = { playback: 0, personal: 0, urls: [] as string[] };
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/playback')) {
      counts.playback += 1;
      counts.urls.push(url);
    }
    if (url.includes('/api/me')) {
      counts.personal += 1;
      counts.urls.push(url);
    }
  });
  return counts;
}

/** 打开直播首页节目详情面板:Hero 大屏次操作「节目详情」(015 起 current 档卡片
 *  文字区点击改导航 /live/watch/:id 观看页,卡片文字区不再是面板入口;Hero 次操作
 *  与 upcoming 档节目名为剩余面板入口,本 helper 取 Hero 次操作) */
async function openLiveCardDetail(page: Page): Promise<void> {
  const hero = page.getByTestId('live-hero-player');
  const detailButton = hero.getByRole('button', { name: /^节目详情/ });
  await detailButton.waitFor({ state: 'visible' });
  await detailButton.click();
}

test.describe('012 T006 · 游客统一播放链路与面板一致', () => {
  test.describe.configure({ mode: 'serial' });

  test('入口① 直播首页卡片:游客播放 → 登录弹层;授权前零 /playback 与 /api/me', async ({ page }) => {
    const counts = countSensitiveRequests(page);
    await page.goto('/live');
    const playButton = page.locator('button[aria-label^="播放 "]').first();
    await playButton.waitFor({ state: 'visible' });
    // 015 双层交互(T004):卡片中央 ▶ 恒在 DOM,hover 才启用可点(pointer-events
    // 随 group-hover 切换)—— 先悬停所在卡片再点击(等价用户悬停后点击)
    await page.locator('article').first().hover();
    await playButton.click();
    // 统一登录选档弹层(游客不直达播放)
    const dialog = page.locator('[role="dialog"][data-slot="modal-dialog"]');
    await expect(dialog.getByRole('heading', { name: '登录' })).toBeVisible();
    // 授权前零敏感请求(SC-006 负向)
    expect(counts.playback).toBe(0);
    expect(counts.personal).toBe(0);
    // 取消:弹层关闭且不重开、仍零请求(FR-006 废弃语义)
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toHaveCount(0);
    expect(counts.playback).toBe(0);
    expect(counts.personal).toBe(0);
  });

  test('入口② EPG 节目墙频道列「直播」按钮:同一链路;current 块直起播、非 current 块开面板', async ({ page }) => {
    const counts = countSensitiveRequests(page);
    await page.goto('/live/guide');
    const watchButton = page.locator('button[aria-label^="播放 "][aria-label$="当前直播"]').first();
    await watchButton.waitFor({ state: 'visible' });
    await watchButton.click();
    const dialog = page.locator('[role="dialog"][data-slot="modal-dialog"]');
    await expect(dialog.getByRole('heading', { name: '登录' })).toBeVisible();
    expect(counts.playback).toBe(0);
    expect(counts.personal).toBe(0);
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toHaveCount(0);

    // 非 current 节目块(upcoming/ended)点击 = 打开详情面板(零播放),面板结构与
    // 直播 Hero 详情一致(SC-002 宿主产物特征;015 起 current 块为直起播语义,
    // 见下方独立断言,故此处显式排除 aria-label 以「,正在直播」结尾的 current 块)
    const programmeBlock = page
      .locator('button[data-programme-key]:not([aria-label$=",正在直播"])')
      .first();
    // 墙内节目块与 sticky 频道列重叠/远端定位,常规 click 命中检测会被拦截重试超时
    // (guide 套件同款处理):dispatchEvent 直发 DOM click,真实触发同一条 onClick 链路
    await programmeBlock.dispatchEvent('click');
    const detail = page.locator('[role="dialog"][data-slot="modal-dialog"]');
    await expect(detail).toHaveCount(1);
    await expect(detail.getByText(/家庭时区/)).toBeVisible();
    await expect(detail.getByRole('button', { name: '收藏频道' })).toBeVisible();
    await expect(detail.getByRole('button', { name: '查看节目单' })).toBeVisible();
    expect(counts.playback).toBe(0);
    await detail.getByRole('button', { name: '关闭' }).click();
    await expect(detail).toHaveCount(0);

    // 015 新语义:与 NOW 相交的 current 块(LIVE 角标)点击直接起播 —— 游客仍走
    // 统一登录弹层,授权前零播放请求(ui-layout §3.2;与频道列「直播」按钮同链路)
    const currentBlock = page
      .locator('button[data-programme-key][aria-label$=",正在直播"]')
      .first();
    await currentBlock.dispatchEvent('click');
    const playDialog = page.locator('[role="dialog"][data-slot="modal-dialog"]');
    await expect(playDialog.getByRole('heading', { name: '登录' })).toBeVisible();
    expect(counts.playback).toBe(0);
    await playDialog.getByRole('button', { name: '取消' }).click();
    await expect(playDialog).toHaveCount(0);
    expect(counts.playback).toBe(0);
  });

  test('入口③ 首页导航两跳(/ → 直播卡片 → /live → 播放):同链路、同零请求', async ({ page }) => {
    const counts = countSensitiveRequests(page);
    await page.goto('/');
    await page.getByRole('link', { name: /直播/ }).first().click();
    await expect(page).toHaveURL(/\/live/);
    const playButton = page.locator('button[aria-label^="播放 "]').first();
    await playButton.waitFor({ state: 'visible' });
    // 015 双层交互(T004):卡片中央 ▶ 恒在 DOM,hover 才启用可点(pointer-events
    // 随 group-hover 切换)—— 先悬停所在卡片再点击(等价用户悬停后点击)
    await page.locator('article').first().hover();
    await playButton.click();
    const dialog = page.locator('[role="dialog"][data-slot="modal-dialog"]');
    await expect(dialog.getByRole('heading', { name: '登录' })).toBeVisible();
    expect(counts.playback).toBe(0);
    expect(counts.personal).toBe(0);
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('面板一致(SC-002):直播 Hero 详情与 EPG 节目块详情 dialog 结构特征一致', async ({ page }) => {
    await page.goto('/live');
    await openLiveCardDetail(page);
    const liveDetail = page.locator('[role="dialog"][data-slot="modal-dialog"]');
    await expect(liveDetail).toHaveCount(1);
    const liveFeatures = {
      hasZoneNote: (await liveDetail.getByText(/家庭时区/).count()) > 0,
      hasFavorite: (await liveDetail.getByRole('button', { name: '收藏频道' }).count()) === 1,
      hasGuide: (await liveDetail.getByRole('button', { name: '查看节目单' }).count()) === 1,
      hasClose: (await liveDetail.getByRole('button', { name: '关闭' }).count()) === 1,
    };
    await liveDetail.getByRole('button', { name: '关闭' }).click();
    await expect(liveDetail).toHaveCount(0);

    await page.goto('/live/guide');
    // 非 current 块开面板(015 语义;current 块已改为直接起播,不在此断言面)
    const programmeBlock = page
      .locator('button[data-programme-key]:not([aria-label$=",正在直播"])')
      .first();
    // 墙内节目块与 sticky 频道列重叠/远端定位,常规 click 命中检测会被拦截重试超时
    // (guide 套件同款处理):dispatchEvent 直发 DOM click,真实触发同一条 onClick 链路
    await programmeBlock.dispatchEvent('click');
    const guideDetail = page.locator('[role="dialog"][data-slot="modal-dialog"]');
    await expect(guideDetail).toHaveCount(1);
    const guideFeatures = {
      hasZoneNote: (await guideDetail.getByText(/家庭时区/).count()) > 0,
      hasFavorite: (await guideDetail.getByRole('button', { name: '收藏频道' }).count()) === 1,
      hasGuide: (await guideDetail.getByRole('button', { name: '查看节目单' }).count()) === 1,
      hasClose: (await guideDetail.getByRole('button', { name: '关闭' }).count()) === 1,
    };
    expect(guideFeatures).toEqual(liveFeatures);
    // 两入口结构特征齐备(同一共享面板产物的宿主级证明;组件级由 T003 单测钉面)
    expect(Object.values(liveFeatures).every(Boolean)).toBe(true);
  });
});
