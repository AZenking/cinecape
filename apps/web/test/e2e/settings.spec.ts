import { expect, request, test, type Page } from '@playwright/test';

/**
 * T124(005 US8 Playwright e2e,先 FAIL;013/ADR-0017 契约矩阵同步):设置七子模块纯键盘代表性读写 + 持久化。
 * 权威:tasks.md T124、contracts/ui.md §7、contracts/api.md §6/§7、data-model §3
 * + 013/ADR-0017:常规管理运维免当次密码(来源/策略/家庭设置/档案创建/EPG 匹配等
 * 直接提交,请求体不带 ownerPassword);单次密码仅保留于高危面(撤销设备等)。
 *
 * 前置:E2E_SEED_SCALE=1 规模夹具(fixtureadmin/password-123;主档案 mainPin=135790;
 * 夹具预置来源 fx-src-a-iptv-main / fx-src-a-epg-xmltv / fx-src-a-nas-vod,其 remoteUrl
 * 均为不可达 .test 域,e2e 环境亦无 LAN_ALLOWED_TARGETS 许可 —— 真实 IPTV/NAS/EPG 上游
 * 导入不可达,相关断言到「任务创建 + 状态轮询层」为止(注明);快照确认
 * (awaiting_confirmation→confirm/discard)链路由服务端契约测试与前端组件测试覆盖。
 *
 * 覆盖:
 * - 1280 宽:纯键盘(Tab 焦点/focus+Enter、Esc)完成七子模块各一项代表性读写
 *   (账号读/建档案+PIN(免密码直接创建)/改策略名单(免密码直接保存)/建 IPTV 来源+
 *   手动导入(免密码,到任务层)/频道匹配标签 EPG 手动同步+逐频道匹配与解除(免密码)/
 *   撤销设备(保留单次密码)/改家庭名称与时区(免密码直接保存))。
 *   设置菜单拆分:家庭管理组内原「来源管理/EPG 管理」重组为「IPTV 管理」(直播源/
 *   EPG 来源/频道匹配三标签,?tab= 深链)与「NAS/点播」;IPTV 来源建导走「IPTV 管理」
 *   直播源标签,EPG 同步与逐频道匹配走「频道匹配」标签;
 * - 刷新后数据持久;
 * - 1024/1440/1920/2560 宽:键盘导航遍历七模块均可用;
 * - 768 窄窗/600 高:折叠菜单键盘可用;200% 缩放按等价 CSS 视口(640×540,
 *   即 1280×1080 逻辑像素按 200% 呈现)验证同一可用性(注释注明等价关系);
 * - 改密(本套件最后一项):旧会话失效 → 新密码重登 → 收藏/历史仍在 →
 *   返回观看页不重登。
 *
 * ⚠️ 改密会改掉夹具账号密码:同一次 playwright run 共享同一服务端库(每 run 重新
 * 种子,天然隔离),因此改密放最后一个 test,避免影响同 run 内其它用例。
 */

const LOGIN = { username: 'fixtureadmin', password: 'password-123' } as const;
const NEW_PASSWORD = 'new-password-456';
const MAIN_PIN = '135790';
const PIN_FIELD = '设置 PIN(6 位数字)';
const OWNER_PASSWORD_FIELD = '主账号密码(当次验证)';

// 菜单拆分后侧栏名:IPTV 管理(/settings/iptv)+ NAS/点播(/settings/sources)
const MODULE_TITLES = ['账号信息', '成员管理', '内容策略', 'IPTV 管理', 'NAS/点播', '设备管理', '家庭设置'] as const;

interface ProfileSummaryDto {
  id: string;
  name: string;
  isMain: boolean;
  pinProtected: boolean;
  status: string;
}

interface DeviceDto {
  id: string;
  name: string | null;
  revokedAt: string | null;
}

async function apiLogin(page: Page): Promise<void> {
  const res = await page.request.post('/api/auth/login', { data: { ...LOGIN } });
  expect(res.status(), `API 登录应成功:${res.status()} ${JSON.stringify(await res.json().catch(() => null))}`).toBe(200);
}

async function listProfiles(page: Page): Promise<ProfileSummaryDto[]> {
  const res = await page.request.get('/api/profiles');
  expect(res.status()).toBe(200);
  return (await res.json()) as ProfileSummaryDto[];
}

async function unlockAndSelect(page: Page, profileId: string, pin: string): Promise<void> {
  expect((await page.request.post(`/api/profiles/${profileId}/unlock`, { data: { pin } })).status()).toBe(200);
  expect((await page.request.post(`/api/profiles/${profileId}/select`, { data: {} })).status()).toBe(200);
}

/** 已登录态进入设置:身份菜单键盘开启 → 设置项 Enter → PIN 门键盘通过(URL 到 /settings/account) */
async function openSettingsViaKeyboard(page: Page): Promise<void> {
  await page.goto('/');
  const identity = page.getByRole('button', { name: /主档案/ });
  await identity.focus();
  await page.keyboard.press('Enter');
  const settingsItem = page.getByRole('menuitem', { name: '设置' });
  await settingsItem.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '输入设置 PIN' })).toBeVisible();
  const pinInput = page.getByLabel(PIN_FIELD);
  await pinInput.fill(MAIN_PIN);
  await pinInput.press('Enter');
  await expect(page).toHaveURL(/\/settings\/account$/);
}

/** 已在 /settings/* 内:等「解锁门或已解锁主体」二者其一渲染,门在则重过 PIN
 *  (grant 15 分钟 TTL 兜底;provider 首次 GET access 期间两者皆未渲染,须等待)。
 *  unlockedIndicator 由调用方按当前模块给一个「已解锁才渲染」的定位器。 */
async function ensureUnlocked(page: Page, unlockedIndicator?: ReturnType<Page['getByTestId']>): Promise<void> {
  const gate = page.getByLabel(PIN_FIELD);
  const indicator = unlockedIndicator ?? page.getByTestId('account-summary');
  await expect(gate.or(indicator).first()).toBeVisible({ timeout: 10_000 });
  if (await gate.isVisible().catch(() => false)) {
    await gate.fill(MAIN_PIN);
    await page.getByRole('button', { name: '验证并进入设置' }).click();
  }
  await expect(indicator).toBeVisible({ timeout: 10_000 });
}

/** 键盘导航到子模块:左菜单 ListBox 选项 focus+Enter(纯键盘;窄窗折叠菜单见窄窗用例) */
async function navToModule(page: Page, title: string): Promise<void> {
  const option = page.getByRole('navigation', { name: '设置子菜单' }).getByRole('option', { name: title });
  await option.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('settings-current-module')).toHaveText(title);
}

/** 统一当次密码弹层:键盘输入密码并 Enter 提交(验证失败时弹层保持,由调用方断言)。
 *  013/ADR-0017 后仅高危保留流程(撤销设备等)仍弹此层;页面可能同时挂多个弹层实例
 *  (关闭动画期短暂共存),调用方可传 dialogName 精确收窄;缺省以「可见字段」过滤。 */
async function confirmWithPassword(page: Page, password: string = LOGIN.password, dialogName?: string): Promise<void> {
  const dialog = dialogName === undefined ? page.getByRole('dialog') : page.getByRole('dialog', { name: dialogName });
  const field = dialog.getByLabel(OWNER_PASSWORD_FIELD);
  await expect(field).toBeVisible();
  await field.fill(password);
  await field.press('Enter');
}

test.describe.serial('T124 · 设置七子模块纯键盘代表性读写与持久化', () => {
  test('1280 宽:纯键盘完成七子模块代表性读写', async ({ page }) => {
    await apiLogin(page);
    const main = (await listProfiles(page)).find((profile) => profile.isMain);
    expect(main, '夹具应含主档案').toBeDefined();
    await unlockAndSelect(page, main!.id, MAIN_PIN);

    await openSettingsViaKeyboard(page);

    // ── 1) 账号信息:代表性读(键盘可达的只读主体) ──
    await expect(page.getByTestId('account-summary')).toContainText('fixtureadmin');

    // ── 2) 成员管理:建档案 + PIN(013/ADR-0017:常规操作免当次密码,直接创建) ──
    await navToModule(page, '成员管理');
    await page.getByTestId('create-profile-open').focus();
    await page.keyboard.press('Enter');
    await page.getByLabel('档案名称').fill('键盘儿童');
    await page.getByLabel('PIN(可选,6 位数字)').fill('234567');
    await page.getByTestId('create-profile-submit').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('app-toast-region')).toContainText('已创建');
    await expect(page.getByTestId('profile-list')).toContainText('键盘儿童');

    // ── 3) 内容策略:改名单(频道白名单整体替换写入 fx-ch-001;免当次密码直接保存)──
    // ListEditor 的 label 未以 for/id 关联(纯视觉标签),以 policy-editor 内第三个
    // textarea(允许/禁止/白名单固定次序)定位
    await navToModule(page, '内容策略');
    await expect(page.getByTestId('policy-editor')).toBeVisible();
    const channelAllowlist = page.getByTestId('policy-editor').locator('textarea').nth(2);
    await channelAllowlist.fill('fx-ch-001');
    await page.getByTestId('policy-save-lists').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('app-toast-region')).toContainText('名单已整体替换保存');

    // ── 4) IPTV 管理 · 直播源标签:建 IPTV 来源 + 手动导入(免当次密码直接执行;本文件内可达上游)
    //       (菜单拆分:IPTV 来源建导自原「来源管理」迁入「IPTV 管理」直播源标签) ──
    await navToModule(page, 'IPTV 管理');
    await page.getByTestId('create-source-open').focus();
    await page.keyboard.press('Enter');
    await page.getByLabel('来源名称').fill('键盘IPTV');
    // 主机名形态 URL(创建期仅做字面类别校验;IP 字面量回环会被拒,e2e 环境亦无
    // LAN_ALLOWED_TARGETS 许可 —— 真实上游不可达,导入断言到「任务创建+状态轮询层」)
    await page.getByLabel('播放列表地址(M3U URL)').fill('http://kb-iptv.e2e.invalid/list.m3u8');
    await page.getByTestId('create-source-submit').focus();
    await page.keyboard.press('Enter');
    // 创建成功明确「开始导入」下一步(FR-037);免当次密码直接导入
    await expect(page.getByTestId('source-created-next-step')).toContainText('键盘IPTV');
    await page.getByTestId('source-start-sync').focus();
    await page.keyboard.press('Enter');
    // 任务创建 + 状态轮询层(注明:e2e 环境上游不可达 → 任务异步以 failed 终态收束,
    // 失败保留上次成功目录;awaiting_confirmation→确认发布链路由服务端契约测试与
    // 前端组件测试覆盖。失败任务不回写 source.last_job_id,行内不渲染任务卡 ——
    // 任务生命周期经「创建 notice + 轮询 GET /settings/refreshes/{id} 到终态」断言)
    const refreshResponses: Array<{ id: string; status: string }> = [];
    page.on('response', (response) => {
      if (response.url().includes('/refresh') && response.request().method() === 'POST') {
        void response
          .json()
          .then((body: { id?: string; status?: string }) => {
            if (typeof body.id === 'string') {
              refreshResponses.push({ id: body.id, status: body.status ?? '' });
            }
          })
          .catch(() => undefined);
      }
    });
    // 任务创建反馈(轮询层入口);免当次密码直接执行
    await expect(page.getByTestId('app-toast-region')).toContainText('同步任务已创建', { timeout: 10_000 });
    // 轮询到终态:上游不可达 → failed(不伪造成功;行保持「尚无成功导入」)
    await expect
      .poll(
        async () => {
          if (refreshResponses.length === 0) {
            return 'pending';
          }
          const refreshId = refreshResponses[0]!.id;
          const poll = await page.request.get(`/api/settings/refreshes/${refreshId}`);
          if (poll.status() !== 200) {
            return 'pending';
          }
          return ((await poll.json()) as { status: string }).status;
        },
        { timeout: 20_000, intervals: [500] },
      )
      .toBe('failed');
    const kbSourceRow = page.getByTestId('source-list').locator('li', { hasText: '键盘IPTV' }).first();
    await expect(kbSourceRow).toContainText('尚无成功导入');

    // ── 5) IPTV 管理 · EPG 来源与频道资产:手动导入/同步(不可达上游 → 断言到
    //        任务创建+状态轮询层,注明)+ 逐频道手动匹配与解除 ──
    await navToModule(page, 'IPTV 管理');
    // a) 节目单标签(018:来源清单 × 优先级合并看板):立即同步
    const epgTab = page.getByRole('tab', { name: '节目单' });
    await epgTab.focus();
    await page.keyboard.press('Enter');
    await expect(epgTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('settings-current-module')).toHaveText('IPTV 管理');

    const epgSyncResponses: Array<{ id: string }> = [];
    page.on('response', (response) => {
      if (response.url().includes('/refresh') && response.request().method() === 'POST') {
        void response
          .json()
          .then((body: { id?: string }) => {
            if (typeof body.id === 'string') {
              epgSyncResponses.push({ id: body.id });
            }
          })
          .catch(() => undefined);
      }
    });
    const epgSync = page.getByTestId('epg-priorities-list').getByRole('button', { name: '立即同步' }).first();
    await epgSync.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('app-toast-region')).toContainText('同步任务已创建');
    await expect
      .poll(
        async () => {
          if (epgSyncResponses.length === 0) {
            return 'pending';
          }
          const poll = await page.request.get(`/api/settings/refreshes/${epgSyncResponses[epgSyncResponses.length - 1]!.id}`);
          if (poll.status() !== 200) {
            return 'pending';
          }
          return ((await poll.json()) as { status: string }).status;
        },
        { timeout: 20_000, intervals: [500] },
      )
      .toBe('failed');

    // b) 切换至频道管理标签:逐频道手动匹配与解除
    const matchingTab = page.getByRole('tab', { name: '频道管理' });
    await matchingTab.focus();
    await page.keyboard.press('Enter');
    await expect(matchingTab).toHaveAttribute('aria-selected', 'true');
    // 逐频道:搜索频道 → 打开匹配面板 → 选定候选(免当次密码直接匹配)→ 解除
    // (013/ADR-0017:EPG 匹配链路常规化,全部免当次密码)
    await page.getByTestId('epg-channel-q').fill('夹具频道 001');
    await page.getByTestId('epg-channel-search').focus();
    await page.keyboard.press('Enter');
    const matchButton = page.getByTestId('epg-channel-list').getByRole('button', { name: '匹配 / 解除' }).first();
    await expect(matchButton).toBeVisible();
    await matchButton.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('epg-match-panel')).toBeVisible();
    const candidate = page.getByTestId('epg-match-panel').locator('[data-testid^="epg-candidate-"]').first();
    await candidate.focus();
    await page.keyboard.press('Enter');
    // manual 匹配免当次密码直接保存(013:二次确认弹层已随密码层移除)
    await expect(page.getByTestId('app-toast-region')).toContainText('已手动匹配');
    // 解除(manual 失效不自动回退:写 auto 墓碑;免当次密码直接执行)
    await page.getByTestId('epg-unbind').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('app-toast-region')).toContainText('已解除');

    // ── 6) 设备管理:撤销设备(独立 request context 登录一台「待撤销」设备,避免
    //        撤销当前会话设备;独立上下文不共享浏览器 Cookie —— 登录 Set-Cookie
    //        不会覆盖浏览器会话,否则设置授予随会话切换失效)──
    const throwawayApi = await request.newContext({
      baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173',
    });
    const throwaway = await throwawayApi.post('/api/auth/login', {
      data: { ...LOGIN, deviceName: '键盘待撤销设备' },
    });
    expect(throwaway.status()).toBe(200);
    await navToModule(page, '设备管理');
    await expect(page.getByTestId('device-list')).toBeVisible();
    const devicesRes = await page.request.get('/api/settings/devices');
    expect(devicesRes.status()).toBe(200);
    const deviceItems = (await devicesRes.json()) as DeviceDto[];
    const target = deviceItems.find((device) => device.name === '键盘待撤销设备');
    expect(target, `待撤销设备应在列表:${JSON.stringify(deviceItems).slice(0, 400)}`).toBeDefined();
    await page.getByTestId(`device-revoke-${target!.id}`).focus();
    await page.keyboard.press('Enter');
    await confirmWithPassword(page);
    await expect(page.getByTestId('app-toast-region')).toContainText('设备已撤销');
    const revokedRow = page.getByTestId('device-list').locator('li', { hasText: '键盘待撤销设备' });
    await expect(revokedRow).toContainText('撤销');

    // ── 7) 家庭设置:改家庭名称 + 时区(CAS + 免当次密码直接保存) ──
    await navToModule(page, '家庭设置');
    await page.getByLabel('家庭名称').fill('键盘之家');
    await page.getByLabel('时区(IANA,如 Asia/Shanghai)').fill('Asia/Tokyo');
    await page.getByTestId('general-save').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('app-toast-region')).toContainText('家庭设置已保存');

    // ── 刷新后数据持久(grant 为服务端会话态,刷新不丢) ──
    await page.reload();
    await ensureUnlocked(page, page.getByLabel('家庭名称'));
    await expect(page.getByLabel('家庭名称')).toHaveValue('键盘之家');
    await expect(page.getByLabel('时区(IANA,如 Asia/Shanghai)')).toHaveValue('Asia/Tokyo');
    await navToModule(page, '成员管理');
    await expect(page.getByTestId('profile-list')).toContainText('键盘儿童');
    // IPTV 来源行在「IPTV 管理」直播源标签(NAS/点播页不显示 iptv 类型来源)
    await navToModule(page, 'IPTV 管理');
    await expect(page.getByTestId('source-list').locator('li', { hasText: '键盘IPTV' })).toContainText('尚无成功导入');

    // Esc 键盘路径:设置内 Esc 无残留弹层(密码弹层关闭路径由组件测试覆盖,此处验证主流程无阻塞)
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-current-module')).toHaveText('IPTV 管理');
  });

  for (const width of [1024, 1440, 1920, 2560]) {
    test(`${width} 宽:键盘遍历七模块均可用`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await apiLogin(page);
      const main = (await listProfiles(page)).find((profile) => profile.isMain);
      await unlockAndSelect(page, main!.id, MAIN_PIN);
      await openSettingsViaKeyboard(page);

      for (const title of MODULE_TITLES) {
        await navToModule(page, title);
        // 每模块至少一个主体区域键盘可达可见(代表性,不在每个宽度重复全部读写)
        switch (title) {
          case '账号信息':
            await expect(page.getByTestId('account-summary')).toBeVisible();
            break;
          case '成员管理':
            await expect(page.getByTestId('profile-list')).toBeVisible();
            break;
          case '内容策略':
            await expect(page.getByTestId('policy-profile-select')).toBeVisible();
            break;
          case 'IPTV 管理':
            // 直播源标签(默认):来源列表可达;频道管理标签切过去后主体可达
            await expect(page.getByTestId('source-list')).toBeVisible();
            await page.getByRole('tab', { name: '频道管理' }).focus();
            await page.keyboard.press('Enter');
            await expect(page.getByTestId('epg-channel-q')).toBeVisible();
            break;
          case 'NAS/点播':
            await expect(page.getByTestId('source-list')).toBeVisible();
            break;
          case '设备管理':
            await expect(page.getByTestId('device-list')).toBeVisible();
            break;
          case '家庭设置':
            await expect(page.getByLabel('家庭名称')).toBeVisible();
            break;
        }
      }
      // 宽窗全部 ≥1024:左菜单常驻(非折叠按钮形态)
      await expect(page.getByRole('button', { name: '菜单' })).toBeHidden();
    });
  }

  test('窄窗/600 高与 200% 缩放等价视口:折叠菜单键盘可用;768 边界为常驻侧栏', async ({ page }) => {
    // 断点语义(SettingsLayout:媒体查询 min-width:768px 承载窄窗折叠):恰好 768 宽
    // 命中断点为宽窗(侧栏常驻),折叠菜单形态在断点以下 —— 以 700×600 验证;200% 缩放
    // 按等价 CSS 视口 640×540 验证(1280×1080 逻辑像素按 200% 呈现的可用性等价于
    // 640×540 CSS 视口,ui.md §7 注明)。
    for (const viewport of [
      { width: 700, height: 600 },
      { width: 640, height: 540 },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await apiLogin(page);
      const main = (await listProfiles(page)).find((profile) => profile.isMain);
      await unlockAndSelect(page, main!.id, MAIN_PIN);
      await openSettingsViaKeyboard(page);

      // 窄窗:左菜单折叠为「菜单」按钮,键盘开启后导航(面包屑/标题仍显示当前模块)
      const menuButton = page.getByRole('button', { name: '菜单' });
      await expect(menuButton).toBeVisible();
      await menuButton.focus();
      await page.keyboard.press('Enter');
      const option = page.getByRole('navigation', { name: '设置子菜单' }).getByRole('option', { name: '家庭设置' });
      await option.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('settings-current-module')).toHaveText('家庭设置');
      // 折叠菜单导航后收起;主体表单键盘可读写(代表性:改家庭名不保存,验证输入可达)
      await expect(page.getByLabel('家庭名称')).toBeVisible();
      await page.getByLabel('家庭名称').fill(`窄窗之家-${viewport.width}`);
      await expect(page.getByLabel('家庭名称')).toHaveValue(`窄窗之家-${viewport.width}`);
      // 不保存直接导航:未保存拦截弹层(FR-041)键盘可决策 —— 放弃编辑
      await menuButton.focus();
      await page.keyboard.press('Enter');
      await page
        .getByRole('navigation', { name: '设置子菜单' })
        .getByRole('option', { name: '账号信息' })
        .focus();
      await page.keyboard.press('Enter');
      const overlay = page.getByTestId('unsaved-overlay');
      await expect(overlay).toBeVisible();
      await page.getByTestId('unsaved-discard').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('settings-current-module')).toHaveText('账号信息');
      await expect(page.getByTestId('account-summary')).toBeVisible();
    }

    // 768 边界:经典滚动条占宽后媒体查询可能落入窄形态 —— 不断言具体形态,
    // 只断言两种形态下「键盘导航到模块 + 主体表单可达」皆成立(768/600 高可用性)
    await page.setViewportSize({ width: 768, height: 600 });
    await apiLogin(page);
    const boundaryMain = (await listProfiles(page)).find((profile) => profile.isMain);
    await unlockAndSelect(page, boundaryMain!.id, MAIN_PIN);
    await openSettingsViaKeyboard(page);
    const collapsedMenu = page.getByRole('button', { name: '菜单' });
    if (await collapsedMenu.isVisible().catch(() => false)) {
      await collapsedMenu.focus();
      await page.keyboard.press('Enter');
    }
    await navToModule(page, '家庭设置');
    await expect(page.getByLabel('家庭名称')).toBeVisible();
  });

  test('改密:旧会话失效、新密码重登、收藏历史仍在、返回观看页不重登(套件最后一项)', async ({ page }) => {
    await apiLogin(page);
    const main = (await listProfiles(page)).find((profile) => profile.isMain);
    await unlockAndSelect(page, main!.id, MAIN_PIN);
    // 预置一条收藏(改密后核对保留;data-model:密码改动同事务撤销会话/授予,保留收藏历史)
    const fav = await page.request.put('/api/me/favorites/channels/fx-ch-001', { data: {} });
    expect([200, 201, 204]).toContain(fav.status());

    // 键盘进入设置 → 账号信息改密
    await page.goto('/settings/account');
    await ensureUnlocked(page);
    await expect(page.getByTestId('account-summary')).toBeVisible();
    await page.getByLabel('当前密码(fixtureadmin 的主账号密码)').fill(LOGIN.password);
    await page.getByLabel('新密码(8~128 位)').fill(NEW_PASSWORD);
    await page.getByLabel('确认新密码').fill(NEW_PASSWORD);
    await page.getByTestId('password-change-submit').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('password-change-done')).toBeVisible();

    // 旧会话已服务端撤销:authed API 立即 401
    expect((await page.request.get('/api/auth/session')).status()).toBe(401);

    // 新密码重登(改密成功回调跳 /?intent=login;公共布局渲染「登录」按钮,
    // 键盘触发后弹层开在登录步骤)
    await page.getByTestId('password-change-done').getByRole('button', { name: '使用新密码重新登录' }).click();
    const loginButton = page.getByRole('button', { name: '登录', exact: true });
    await expect(loginButton).toBeVisible();
    await loginButton.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');
    await dialog.getByLabel('用户名').fill(LOGIN.username);
    await dialog.getByLabel('密码', { exact: true }).fill(NEW_PASSWORD);
    await dialog.getByRole('button', { name: '登录', exact: true }).click();
    // 登录成功进入选档(SC-002 续流:新会话无档)—— 选主档案 + PIN 解锁
    await expect(dialog.getByRole('heading', { name: '选择 Profile' })).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole('button', { name: /主档案/ }).click();
    await expect(dialog.getByRole('heading', { name: '输入档案 PIN' })).toBeVisible();
    await dialog.getByLabel('档案 PIN').fill(MAIN_PIN);
    await dialog.getByRole('button', { name: '解锁并选择' }).click();
    // 选档完成即关闭弹层(失败弹层保持并呈现错误)
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // 新会话建立:收藏仍在(旧会话撤销不动个人数据)
    const favorites = await page.request.get('/api/me/favorites/channels');
    expect(favorites.status()).toBe(200);
    expect(JSON.stringify(await favorites.json())).toContain('fx-ch-001');

    // 返回观看页不重登:会话保持,身份菜单直接可见(无登录弹层)
    await page.goto('/vod');
    await expect(page.getByRole('button', { name: /主档案/ })).toBeVisible();
    await expect(dialog).toBeHidden();
  });
});
