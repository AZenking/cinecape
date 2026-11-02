import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Navigate, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { NotFoundPage } from '../src/app/NotFoundPage';
import { SettingsLayout } from '../src/layouts/SettingsLayout';
import { SettingsAccountPage } from '../src/features/settings/settings-account-page';
import { SettingsModulePlaceholder } from '../src/features/settings/settings-module-placeholder';
import { SETTINGS_MODULES } from '../src/features/settings/settings-modules';
import type { DeviceDto, PolicyDto, ProfileSummary, SourceDto, SourcePageDto } from '../src/features/settings/shared/settings-api';
import { queryClient as appQueryClient } from '../src/shared/query/client';

/**
 * T031(012 US5 测试先行;现状审计型):设置交互规则。
 * 权威:docs/specs/012-live-settings-experience/contracts/ui.md §5.2/§5.4 + FR-026/027/028:
 * - FR-028:URL 保留当前分类——直挂 /settings/epg 打开原模块,「刷新」(同地址重新
 *   挂载)仍回原模块;模块加载失败仅影响该模块(左侧导航可用 + 重试入口);
 * - FR-026:无全页保存按钮——保存入口只出现在当前编辑区域;单选即选即存(当次密码
 *   确认后直接提交,无页面保存按钮);现状无开关控件(存在则须满足即时生效契约);
 * - FR-027:危险操作二次确认并说明后果——撤销设备、停用档案(删除 Profile 现状等价物)
 *   确认前零请求,确认后携带当次密码执行。
 */

interface FetchCall {
  method: string;
  path: string;
  body: unknown;
}

let fetchCalls: FetchCall[] = [];
/** true 时 /api/settings/sources 返回 500(模块级失败用) */
let sourcesFail = false;

const IPTV_SOURCE: SourceDto = {
  id: 'iptv-1',
  kind: 'iptv',
  name: 'IPTV 家庭源',
  enabled: true,
  version: 3,
  epgSourceId: null,
  locationLabel: 'iptv://home',
  lastSuccessAt: null,
  lastJobId: null,
};
const EPG_SOURCE: SourceDto = {
  id: 'epg-1',
  kind: 'epg',
  name: 'EPG 官方源',
  enabled: true,
  version: 1,
  epgSourceId: null,
  locationLabel: 'epg://official',
  lastSuccessAt: null,
  lastJobId: null,
};

const SOURCE_PAGE: SourcePageDto = { items: [IPTV_SOURCE, EPG_SOURCE], page: 1, pageSize: 20, total: 2 };

const PROFILES: ProfileSummary[] = [
  {
    id: 'p-main',
    name: '主档案',
    avatar: null,
    type: 'adult',
    isDefault: true,
    isMain: true,
    pinProtected: true,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  },
  {
    id: 'p-kid',
    name: '小孩',
    avatar: null,
    type: 'child',
    isDefault: false,
    isMain: false,
    pinProtected: false,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  },
];

const POLICY: PolicyDto = {
  profileId: 'p-main',
  maxContentLevel: 6,
  allowUnrated: false,
  allowedMediaIds: [],
  blockedMediaIds: [],
  allowedChannelIds: [],
  version: 2,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const DEVICE: DeviceDto = {
  id: 'd1',
  name: '客厅电视',
  type: 'tv',
  lastSeenAt: '2026-01-01T08:00:00.000Z',
  revokedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function problemResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/problem+json' } });
}

/** 宽视口(≥900px):左侧子菜单直接渲染(setup.ts 垫片缺省不匹配任何查询) */
function setWideViewport(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('min-width'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function installFetch(): void {
  fetchCalls = [];
  sourcesFail = false;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost:3000');
      const call: FetchCall = {
        method: (init?.method ?? 'GET').toUpperCase(),
        path: url.pathname,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      fetchCalls.push(call);
      if (call.path === '/api/settings/access') {
        return Promise.resolve(
          jsonResponse({ unlocked: true, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }),
        );
      }
      if (call.path === '/api/settings/account') {
        return Promise.resolve(jsonResponse({ id: 'acc-1', username: 'admin', role: 'owner' }));
      }
      if (call.path === '/api/settings/profiles') {
        return Promise.resolve(jsonResponse(PROFILES));
      }
      if (call.path === '/api/settings/household') {
        return Promise.resolve(
          jsonResponse({ name: '家', language: 'zh-CN', timezone: 'Asia/Shanghai', version: 1, mainProfileVersion: 1 }),
        );
      }
      if (call.path === '/api/settings/devices') {
        return Promise.resolve(jsonResponse([DEVICE]));
      }
      if (call.path === '/api/settings/devices/d1/revoke' && call.method === 'POST') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (call.path === '/api/settings/profiles/p-kid' && call.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ...PROFILES[1], status: 'disabled', version: 2 }));
      }
      if (call.path === '/api/settings/profiles/p-main/policy') {
        return Promise.resolve(jsonResponse(POLICY));
      }
      if (call.path === '/api/settings/sources' && call.method === 'GET') {
        return sourcesFail
          ? Promise.resolve(problemResponse({ status: 500, code: 'ERROR', title: 'Internal Error' }, 500))
          : Promise.resolve(jsonResponse(SOURCE_PAGE));
      }
      if (call.path === '/api/settings/sources/iptv-1' && call.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ...IPTV_SOURCE, epgSourceId: 'epg-1', version: 4 }));
      }
      return Promise.resolve(problemResponse({ status: 404, code: 'NOT_FOUND', title: 'Not Found' }, 404));
    }),
  );
}

/** 与 routes.tsx /settings 子树同构的最小挂载(由 SETTINGS_MODULES 派生;避免耦合并行开发的 live/epg 页面) */
function renderSettingsRoutes(path: string): { unmount: () => void } {
  appQueryClient.clear();
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={appQueryClient}>
        <Routes>
          <Route path="/settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="/settings/account" replace />} />
            <Route path="account" element={<SettingsAccountPage />} />
            {SETTINGS_MODULES.filter((module) => module.key !== 'account').map((module) => (
              <Route
                key={module.key}
                path={module.key}
                element={<SettingsModulePlaceholder moduleName={module.title} scope={module.scope ?? ''} />}
              />
            ))}
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { unmount: view.unmount };
}

function nav(): HTMLElement {
  return screen.getByRole('navigation', { name: '设置子菜单' });
}

function revokeCalls(): FetchCall[] {
  return fetchCalls.filter((call) => call.path === '/api/settings/devices/d1/revoke');
}

function patchKidCalls(): FetchCall[] {
  return fetchCalls.filter((call) => call.path === '/api/settings/profiles/p-kid');
}

beforeEach(() => {
  installFetch();
  setWideViewport();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('T031 · 设置交互规则(ui.md §5.2/§5.4 / FR-026–FR-028)', () => {
  it('FR-028:直挂 /settings/epg 打开原模块;刷新(同地址重新挂载)仍打开原模块;应用内切换后 URL 分类跟随且导航高亮同步', async () => {
    const user = userEvent.setup();
    // 直挂:URL 即分类载体
    const first = renderSettingsRoutes('/settings/epg');
    expect(await screen.findByTestId('settings-current-module')).toHaveTextContent('EPG 管理');
    expect(await screen.findByLabelText('设置 · EPG 管理')).toBeVisible();
    expect(within(nav()).getByRole('link', { name: 'EPG 管理' })).toHaveAttribute('aria-current', 'page');
    // 刷新语义:同地址全新挂载仍打开原模块(分类状态以 URL 保存)
    first.unmount();
    const second = renderSettingsRoutes('/settings/epg');
    expect(await screen.findByTestId('settings-current-module')).toHaveTextContent('EPG 管理');
    // 应用内切换:分类跟随导航,高亮同步
    await user.click(within(nav()).getByRole('link', { name: '档案管理' }));
    expect(await screen.findByTestId('settings-current-module')).toHaveTextContent('档案管理');
    expect(within(nav()).getByRole('link', { name: '档案管理' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav()).getByRole('link', { name: 'EPG 管理' })).not.toHaveAttribute('aria-current', 'page');
    second.unmount();
  });

  it('FR-028:模块级加载失败仅影响该模块——重试入口可见、左侧导航可用、其余模块不受影响;恢复后重试成功', async () => {
    const user = userEvent.setup();
    sourcesFail = true;
    renderSettingsRoutes('/settings/epg');
    const epgSection = await screen.findByLabelText('设置 · EPG 管理');
    // 仅该模块进入失败态:读取失败 + 显式重试入口(5xx 有一次自动重试,放宽等待)
    const alert = await within(epgSection).findByRole('alert', {}, { timeout: 3000 });
    expect(alert).toHaveTextContent('读取失败');
    expect(within(alert).getByRole('button', { name: '重试' })).toBeVisible();
    // 左侧导航不受影响:七条链接全部可达
    expect(within(nav()).getAllByRole('link')).toHaveLength(SETTINGS_MODULES.length);
    // 其余模块照常工作
    await user.click(within(nav()).getByRole('link', { name: '账号与安全' }));
    expect(await screen.findByTestId('account-summary')).toBeVisible();
    // 回到失败模块仍可重试;服务端恢复后重试即转好(5xx 自动重试一次,放宽等待)
    await user.click(within(nav()).getByRole('link', { name: 'EPG 管理' }));
    const retry = await within(await screen.findByLabelText('设置 · EPG 管理')).findByRole(
      'button',
      { name: '重试' },
      { timeout: 3000 },
    );
    sourcesFail = false;
    await user.click(retry);
    expect(await screen.findByTestId('epg-source-list')).toBeVisible();
    expect(within(await screen.findByLabelText('设置 · EPG 管理')).queryByRole('alert')).toBeNull();
  });

  it('FR-026:无全页保存按钮——通用设置的保存入口在当前编辑表单内且草稿未编辑时禁用', async () => {
    renderSettingsRoutes('/settings/general');
    const form = await screen.findByRole('form', { name: '家庭通用设置' });
    const save = within(form).getByRole('button', { name: '保存修改' });
    expect(save).toBeDisabled(); // 局部保存:草稿未编辑不可提交
    // 页面上全部含「保存」的按钮都在该编辑表单内,无全页保存条
    const saveButtons = screen.getAllByRole('button', { name: /保存/ });
    expect(saveButtons.length).toBeGreaterThanOrEqual(1);
    for (const button of saveButtons) {
      expect(button.closest('form')).toBe(form);
    }
  });

  it('FR-026:无全页保存按钮——策略页两个保存入口分别位于当前编辑区域(编辑器容器)内', async () => {
    renderSettingsRoutes('/settings/policy');
    const editor = await screen.findByTestId('policy-editor');
    const saveButtons = within(editor).getAllByRole('button', { name: /保存/ });
    expect(saveButtons.map((button) => button.textContent)).toEqual(['保存等级设置', '保存名单']);
    // 编辑区域之外(含布局本体)无任何保存按钮
    expect(screen.getAllByRole('button', { name: /保存/ })).toEqual(saveButtons);
  });

  it('FR-026:EPG 页单选即选即存——整页无保存按钮、无开关控件;关联变更直接进入当次密码确认并提交', async () => {
    const user = userEvent.setup();
    renderSettingsRoutes('/settings/epg');
    await screen.findByTestId('epg-source-list');
    // 无全页保存按钮(关联即选即存,经当次密码);现状无开关控件(存在即须即时生效)
    expect(screen.queryAllByRole('button', { name: /保存/ })).toHaveLength(0);
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    // 单选变更 → 立即弹当次密码确认并提交,无保存按钮参与
    await user.click(screen.getByTestId('epg-link-iptv-1'));
    await user.click(await screen.findByRole('option', { name: 'EPG 官方源' }));
    const dialog = await screen.findByRole('dialog', { name: '当次密码验证' });
    expect(dialog).toHaveTextContent('将「IPTV 家庭源」关联到所选 EPG 来源。');
    await user.type(within(dialog).getByLabelText(/主账号密码/), 'owner-pass');
    await user.click(within(dialog).getByRole('button', { name: '确认执行' }));
    expect(await screen.findByTestId('epg-notice')).toHaveTextContent('EPG 关联已保存');
    const patch = fetchCalls.find((call) => call.path === '/api/settings/sources/iptv-1' && call.method === 'PATCH');
    expect(patch).toBeDefined();
    expect((patch!.body as { epgSourceId?: string }).epgSourceId).toBe('epg-1');
    expect((patch!.body as { ownerPassword?: string }).ownerPassword).toBe('owner-pass');
  });

  it('FR-027:撤销设备二次确认——确认弹层说明后果,确认前零撤销请求,确认后携带当次密码执行', async () => {
    const user = userEvent.setup();
    renderSettingsRoutes('/settings/devices');
    expect(await screen.findByTestId('device-list')).toBeVisible();
    expect(revokeCalls()).toHaveLength(0);
    await user.click(screen.getByTestId('device-revoke-d1'));
    // 二次确认:弹层说明后果(撤销会话与授权、需重新登录)
    const dialog = await screen.findByRole('dialog', { name: '撤销设备' });
    expect(dialog).toHaveTextContent('将撤销「客厅电视」上的全部会话与设置授权');
    expect(dialog).toHaveTextContent('该设备需要重新登录');
    // 确认前零撤销请求
    expect(revokeCalls()).toHaveLength(0);
    await user.type(within(dialog).getByLabelText(/主账号密码/), 'owner-pass');
    await user.click(within(dialog).getByRole('button', { name: '确认撤销' }));
    // 确认后才执行:恰好一次撤销,携带当次密码
    await screen.findByTestId('devices-notice');
    expect(screen.getByTestId('devices-notice')).toHaveTextContent('设备已撤销');
    const revokes = revokeCalls();
    expect(revokes).toHaveLength(1);
    expect((revokes[0]!.body as { ownerPassword?: string }).ownerPassword).toBe('owner-pass');
  });

  it('FR-027:停用档案(删除 Profile 现状等价物)二次确认——确认前零变更请求,确认后携带当次密码执行', async () => {
    const user = userEvent.setup();
    renderSettingsRoutes('/settings/profiles');
    expect(await screen.findByTestId('profile-list')).toBeVisible();
    expect(patchKidCalls()).toHaveLength(0);
    await user.click(screen.getByTestId('profile-disable-p-kid'));
    const dialog = await screen.findByRole('dialog', { name: '停用档案「小孩」' });
    expect(dialog).toHaveTextContent('停用后该档案不可再被选择');
    expect(dialog).toHaveTextContent('正在观看的设备将被要求重新选档');
    expect(patchKidCalls()).toHaveLength(0);
    await user.type(within(dialog).getByLabelText(/主账号密码/), 'owner-pass');
    await user.click(within(dialog).getByRole('button', { name: '确认执行' }));
    expect(await screen.findByTestId('profiles-notice')).toHaveTextContent('档案「小孩」已停用');
    const patches = patchKidCalls();
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toMatchObject({ status: 'disabled', clearPin: false, ownerPassword: 'owner-pass' });
  });
});
