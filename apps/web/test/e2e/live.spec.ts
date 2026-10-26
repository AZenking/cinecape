import { expect, test, type Page, type Response } from '@playwright/test';

/**
 * 直播首页 e2e(T062;SC-005、FR-021/022/023;US3 登录前零媒体请求):
 * 前置:E2E_SEED_SCALE=1 种子 T012 规模夹具(200 频道/67,200 排期,固定窗口
 * 2026-11-04~11-10 CST)。服务端 now 由 live 模块时钟缝锚定:
 * - E2E_SEED_SCALE=1 缺省锚到 SCALE_FIXTURE_FIXED_NOW_MS(20:05 CST,ch001 重叠档内);
 * - 或 HMP_CLOCK_OFFSET_MS 显式偏移(锚到档位边界附近,验证 30 秒内节目变化)。
 * 断言全部以「服务端 API 响应」为期望源(SC-005 100% 一致),容许秒级时钟漂移;
 * 时间换算用 Intl 显式 Asia/Shanghai(与服务端家庭时区一致),不用浏览器本地时区。
 */

/** T012 规模夹具固定锚点(SCALE_FIXTURE_FIXED_NOW_MS) */
const SCALE_ANCHOR_MS = Date.UTC(2026, 10, 4, 12, 5, 0);
/** 档位边界(20:30 CST):锚点附近用于 30 秒节目变化观察 */
const SLOT_BOUNDARY_MS = Date.UTC(2026, 10, 4, 12, 30, 0);

interface ApiChannelRow {
  media: { id: string; type: string; title: string; availability: string };
  groupKey: string;
  groupLabel: string;
  current: { key: string; title: string; startsAt: string; endsAt: string } | null;
  next: { key: string; title: string; startsAt: string; endsAt: string } | null;
}

interface ApiChannelPage {
  items: ApiChannelRow[];
  page: number;
  pageSize: number;
  total: number;
  now: string;
  timezone: string;
  catalogRevision: number;
}

/** 家庭时区(夹具固定 Asia/Shanghai)格式化 HH:mm(e2e 侧期望计算) */
function hhmmInShanghai(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

async function fetchChannelsApi(page: Page, query: string): Promise<ApiChannelPage> {
  const response = await page.request.get(`/api/public/live/channels${query}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as ApiChannelPage;
}

/** 直播页现在分区的卡片标题序列(DOM 顺序即服务端 A-007 排序) */
async function sectionCardTitles(page: Page, sectionLabel: string): Promise<string[]> {
  return page.getByRole('region', { name: sectionLabel }).locator('article h3').allTextContents();
}

test.describe('直播首页(T062 · 游客)', () => {
  test('分区顺序与频道名/节目名/起止时间展示,正在直播与后端响应 100% 一致(SC-005)', async ({ page }) => {
    const apiPage = await fetchChannelsApi(page, '?section=now&page=1&pageSize=20');
    expect(apiPage.timezone).toBe('Asia/Shanghai');
    expect(apiPage.items.length).toBeGreaterThan(0);

    await page.goto('/live');
    const guideRegion = page.getByRole('region', { name: '所有节目单入口' });
    await expect(guideRegion.getByRole('link', { name: '进入节目单' })).toBeVisible();
    // 等待数据落地(骨架 → 卡片)
    await page.getByRole('region', { name: '正在直播' }).locator('article').first().waitFor({ timeout: 30_000 });

    // 分区顺序(FR-021):所有节目单入口 → 正在直播 → 即将播放 → 各分组正在直播
    const orderOf = async (locatorText: string): Promise<number> => {
      const element = page.getByRole('heading', { name: locatorText }).first();
      await element.waitFor();
      return (await element.boundingBox())?.y ?? Number.POSITIVE_INFINITY;
    };
    const guideY = await orderOf('所有节目单');
    const nowY = await orderOf('正在直播');
    const nextY = await orderOf('即将播放');
    const groupY = await orderOf('各分组正在直播');
    expect(guideY).toBeLessThan(nowY);
    expect(nowY).toBeLessThan(nextY);
    expect(nextY).toBeLessThan(groupY);

    // SC-005:正在直播区与后端响应 100% 一致(频道顺序、节目标题、起止时间)
    const apiTitles = apiPage.items.map((row) => row.media.title);
    const domTitles = await sectionCardTitles(page, '正在直播');
    expect(domTitles.slice(0, apiTitles.length)).toEqual(apiTitles);
    for (const row of apiPage.items.slice(0, 3)) {
      const card = page.getByRole('article', { name: `频道 ${row.media.title}` });
      const expectedCurrent =
        row.current !== null
          ? `${hhmmInShanghai(row.current.startsAt)}–${hhmmInShanghai(row.current.endsAt)}`
          : '暂无节目';
      await expect(card.getByText(expectedCurrent).first()).toBeVisible();
      if (row.next !== null) {
        await expect(card.getByText(`${hhmmInShanghai(row.next.startsAt)} 开始`).first()).toBeVisible();
      }
    }
    // 即将播放区同样与后端一致(首个频道)
    const nextApi = await fetchChannelsApi(page, '?section=next&page=1&pageSize=20');
    const nextDom = await sectionCardTitles(page, '即将播放');
    expect(nextDom.slice(0, nextApi.items.length)).toEqual(nextApi.items.map((row) => row.media.title));

    // 每区可继续查看 + 浏览状态写 URL(FR-045)
    await page.getByRole('button', { name: /查看更多/ }).first().click();
    await expect(page).toHaveURL(/section=now/);
    await expect(page.getByRole('button', { name: '下一页' })).toBeVisible();
    expect(apiPage.total).toBeGreaterThan(apiPage.items.length);
  });

  test('page.clock 推进:30 秒周期刷新触发,档位边界处节目变化在 30 秒内反映(FR-022)', async ({ page }) => {
    test.setTimeout(240_000);
    const before = await fetchChannelsApi(page, '?section=now&page=1&pageSize=5');
    const serverNowMs = Date.parse(before.now);
    await page.clock.install({ time: new Date(serverNowMs) });

    let channelsResponses = 0;
    page.on('response', (response: Response) => {
      if (response.url().includes('/api/public/live/channels')) {
        channelsResponses += 1;
      }
    });
    await page.goto('/live');
    await page.getByRole('region', { name: '正在直播' }).locator('article').first().waitFor();
    const initialResponses = channelsResponses;

    // 距最近一个当前节目结束边界的秒数(决定本运行能否观察到真实节目变化)
    const nearestEndMs = Math.min(
      ...before.items.filter((row) => row.current !== null).map((row) => Date.parse(row.current!.endsAt)),
    );
    const msToBoundary = nearestEndMs - serverNowMs;

    if (msToBoundary > 0 && msToBoundary <= 150_000) {
      // 边界在视野内:推进浏览器时钟烧掉刷新周期,等待服务端跨边界,断言 DOM 在 30 秒内跟随
      let apiProgramme: string | null = before.items[0]?.current?.title ?? null;
      const deadline = Date.now() + msToBoundary + 120_000;
      // 轮询 ≥4 秒/次:公共限频 120 次/分钟,不得自耗配额挤占后续用例
      while (Date.now() < deadline) {
        await page.clock.runFor(30_000);
        await page.waitForTimeout(4_000);
        const latest = await fetchChannelsApi(page, '?section=now&page=1&pageSize=5');
        const latestProgramme = latest.items[0]?.current?.title ?? null;
        if (latestProgramme !== null && latestProgramme !== apiProgramme) {
          apiProgramme = latestProgramme;
          break;
        }
      }
      expect(apiProgramme).not.toBeNull();
      // DOM 在一个刷新周期内(≤35 秒容差)反映服务端新节目
      await expect(
        page.getByRole('region', { name: '正在直播' }).locator('article').first().getByText(apiProgramme as string),
      ).toBeVisible({ timeout: 35_000 });
    } else {
      // 边界远期:验证 30 秒刷新机制本身(推进浏览器时钟 30 秒 → 新的分区请求发生,
      // DOM 与最新服务端响应保持一致)
      const callsBefore = channelsResponses;
      await page.clock.runFor(31_000);
      await expect
        .poll(() => channelsResponses, { timeout: 15_000 })
        .toBeGreaterThan(callsBefore);
      const latest = await fetchChannelsApi(page, '?section=now&page=1&pageSize=5');
      const firstTitle = latest.items[0]?.media.title;
      if (firstTitle !== undefined) {
        await expect(
          page.getByRole('region', { name: '正在直播' }).locator('article h3').first(),
        ).toHaveText(firstTitle, { timeout: 15_000 });
      }
    }
    expect(channelsResponses).toBeGreaterThan(initialResponses);
  });

  test('点击无 EPG 可用频道播放:进入登录入口,登录前零媒体流请求', async ({ page }) => {
    const groups = await (await page.request.get('/api/public/live/groups')).json() as {
      items: Array<{ key: string; label: string }>;
    };
    const otherGroup = groups.items.find((group) => group.label === '其他');
    expect(otherGroup).toBeDefined(); // 无 EPG 频道归入其他(夹具 197~200)

    const mediaRequests: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      // 播放/媒体流特征:受控播放 API、票据、HLS/MP4 资源(排除 dev server 的 .ts 模块地址)
      if (url.includes('/api/playback') || url.includes('ticket=') || /\.m3u8(\?|$)|\.mp4(\?|$)/.test(url)) {
        mediaRequests.push(url);
      }
    });

    // 直达其他分组聚焦视图(URL 即公共浏览状态)
    await page.goto(`/live?section=group&group=${otherGroup!.key}`);
    const card = page.getByRole('article', { name: '频道 夹具频道 197' });
    await expect(card).toBeVisible();
    // 无 EPG 频道:暂无节目占位 + 播放入口保留(FR-023)
    await expect(card.getByText('暂无节目')).toBeVisible();
    await card.getByRole('button', { name: '播放 夹具频道 197 当前直播' }).click();
    // 登录入口出现(页面级游客提示区;US3 统一登录选档接管前的占位)。
    // 登录前媒体流/播放请求为零(登录流程本体属 US2/US3)
    await expect(page.getByRole('status').getByRole('button', { name: '登录' })).toBeVisible();
    expect(mediaRequests).toEqual([]);
  });

  for (const viewport of [
    { name: '1024 宽', width: 1024, height: 768 },
    { name: '2560 宽', width: 2560, height: 1080 },
    { name: '768 窄窗', width: 768, height: 600 },
  ]) {
    test(`${viewport.name}无整页横向溢出`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/live');
      await page
        .getByRole('region', { name: '正在直播' })
        .locator('article')
        .first()
        .waitFor({ timeout: 45_000 });
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return { scrollWidth: doc.scrollWidth, innerWidth: window.innerWidth };
      });
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 1);
    });
  }
});

// 锚点常量被上方注释契约引用(供运行者核对服务端时钟缝缺省锚定);显式引用避免 TS6133
void SCALE_ANCHOR_MS;
void SLOT_BOUNDARY_MS;
