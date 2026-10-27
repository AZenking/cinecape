import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { GuideWindowDto } from '@hmp/shared';
import { SessionProvider } from '../../src/app/session-provider';
import { ActionCoordinator } from '../../src/app/action-coordinator';
import { SettingsAccessProvider } from '../../src/features/settings/settings-access-provider';
import { SettingsEpgPage } from '../../src/features/settings/settings-epg-page';
import { SettingsPolicyPage } from '../../src/features/settings/settings-policy-page';
import { SettingsSourcesPage } from '../../src/features/settings/settings-sources-page';
import { GuidePage } from '../../src/features/epg/GuidePage';
import { createQueryWrapper, createTestQueryClient } from '../helpers/query-test-utils';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient as appQueryClient } from '../../src/shared/query/client';

/**
 * T010(006-US1,先 FAIL)· 原生 <select> → HeroUI Select 等价性组件测试:
 * - 选项集合与替换前一致、当前值正确回显(onSelectionChange 绑定既有 state);
 * - 键盘可开合(Enter/方向键)、焦点落在触发器上(可焦点可见,FR-003);
 * - 变更回调语义等价:仍走原有「当次密码 + CAS」流程(设置页)/URL 参数(指南页)。
 * 覆盖 T011(epg-link)、T012(policy-profile/policy-level)、T013(source-root)、
 * T014(视图模式/每页频道数)。
 */

interface FetchCall {
  method: string;
  path: string;
  body: unknown;
}

let fetchCalls: FetchCall[] = [];
let fetchRouter: (method: string, path: string) => { status: number; body: unknown } | undefined;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

function installFetchRouter(): void {
  fetchCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost:3000');
      const path = url.pathname + (url.search || '');
      const method = (init?.method ?? 'GET').toUpperCase();
      let body: unknown = undefined;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      fetchCalls.push({ method, path, body });
      if (path === '/api/auth/session') {
        return jsonResponse({ status: 401, code: 'SESSION_INVALID', title: 'SESSION_INVALID' }, 401);
      }
      if (path === '/api/setup/status') {
        return jsonResponse({ initialized: true });
      }
      const outcome = fetchRouter(method, path);
      if (outcome !== undefined) {
        return jsonResponse(outcome.body, outcome.status);
      }
      return jsonResponse({});
    }),
  );
}

/** 打开弹层后按可见文本选定选项(替换前为原生 selectOptions;用户可见交互等价) */
async function chooseOption(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement, label: string): Promise<void> {
  await user.click(trigger);
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByRole('option', { name: label }));
}

/* ---------------- settings-epg-page(T011:IPTV→EPG 关联) ---------------- */

const EPG_A = {
  id: 'epg-a',
  kind: 'epg',
  name: 'EPG 源 A',
  enabled: true,
  version: 1,
  epgSourceId: null,
  locationLabel: 'epg.example/xmltv.xml',
  lastSuccessAt: '2026-01-02T00:00:00.000Z',
  lastJobId: null,
};
const EPG_B = { ...EPG_A, id: 'epg-b', name: 'EPG 源 B' };
const IPTV = {
  id: 'iptv-1',
  kind: 'iptv',
  name: '直播源',
  enabled: true,
  version: 4,
  epgSourceId: 'epg-a',
  locationLabel: 'media.example.tv',
  lastSuccessAt: null,
  lastJobId: null,
};

function renderPage(page: ReactNode, path: string): void {
  // T025:设置页迁移 useAppQuery/useAppMutation 后需 QueryClientProvider;
  // 变更失效固定经应用单例(hooks.ts),观察端必须挂同一实例
  appQueryClient.clear();
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={appQueryClient}>
        <SettingsAccessProvider>
          <Routes>
            <Route path={path} element={page} />
          </Routes>
        </SettingsAccessProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('T011 · settings-epg-page IPTV 关联 Select(FR-001/002/003)', () => {
  beforeEach(() => {
    installFetchRouter();
    fetchRouter = (_method, path) => {
      if (path === '/api/settings/access') {
        return { status: 200, body: { unlocked: true, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() } };
      }
      if (path === '/api/settings/sources' && _method === 'GET') {
        return { status: 200, body: { items: [IPTV, EPG_A, EPG_B], page: 1, pageSize: 20, total: 3 } };
      }
      if (path === '/api/settings/sources/iptv-1' && _method === 'PATCH') {
        return { status: 200, body: { ...IPTV, epgSourceId: 'epg-b', version: 5 } };
      }
      return undefined;
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('选项集合与当前值等价:未关联 + 全部 EPG 来源,当前回显已关联来源名', async () => {
    renderPage(<SettingsEpgPage />, '/settings/epg');
    // 注:RAC 触发器同时带 aria-label 与 aria-labelledby(值+自身),可及名含当前值;
    // 断言沿用套件惯例 getByLabelText(标签关联查询,与替换前原生 select 一致)
    const trigger = await screen.findByLabelText('为 直播源 选择 EPG 来源');
    expect(trigger).toHaveTextContent('EPG 源 A'); // 当前值(iptv.epgSourceId='epg-a')
    await userEvent.setup().click(trigger);
    const listbox = await screen.findByRole('listbox');
    const labels = within(listbox)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(labels).toEqual(['未关联', 'EPG 源 A', 'EPG 源 B']);
  });

  it('变更回调等价:选择目标 EPG 来源 → 仍弹当次密码确认 → PATCH epgSourceId', async () => {
    const user = userEvent.setup();
    renderPage(<SettingsEpgPage />, '/settings/epg');
    const trigger = await screen.findByLabelText('为 直播源 选择 EPG 来源');
    await chooseOption(user, trigger, 'EPG 源 B');
    // 原语义保留:选择即弹当次密码确认(而非直接保存)
    expect(await screen.findByText('将「直播源」关联到所选 EPG 来源。')).toBeVisible();
    await user.type(screen.getByLabelText('主账号密码(当次验证)'), 'password-123');
    await user.click(screen.getByTestId('password-submit'));
    await waitFor(() => {
      const patch = fetchCalls.find((call) => call.method === 'PATCH' && call.path === '/api/settings/sources/iptv-1');
      expect(patch).toBeDefined();
      expect((patch?.body as Record<string, unknown>).epgSourceId).toBe('epg-b');
    });
  });

  it('键盘可开合且焦点可见;选「未关联」→ 解除关联确认与 PATCH null 等价', async () => {
    const user = userEvent.setup();
    renderPage(<SettingsEpgPage />, '/settings/epg');
    const trigger = await screen.findByLabelText('为 直播源 选择 EPG 来源');
    trigger.focus();
    expect(trigger).toHaveFocus();
    await user.keyboard('{Enter}'); // 键盘开
    const listbox = await screen.findByRole('listbox');
    expect(listbox).toBeVisible();
    await user.keyboard('{ArrowUp}'); // 当前值 EPG 源 A → 上移到「未关联」(空值键)
    await user.keyboard('{Enter}'); // 键盘选
    expect(await screen.findByText('解除「直播源」的 EPG 关联。')).toBeVisible();
    await user.type(screen.getByLabelText('主账号密码(当次验证)'), 'password-123');
    await user.click(screen.getByTestId('password-submit'));
    await waitFor(() => {
      const patch = fetchCalls.find((call) => call.method === 'PATCH' && call.path === '/api/settings/sources/iptv-1');
      expect(patch).toBeDefined();
      expect((patch?.body as Record<string, unknown>).epgSourceId).toBeNull();
    });
  });
});

/* ---------------- settings-policy-page(T012:目标档案 + 最高内容等级) ---------------- */

const PROFILES = [
  {
    id: 'p-1',
    name: '张三',
    avatar: null,
    type: 'adult',
    isDefault: true,
    isMain: true,
    pinProtected: true,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    version: 2,
  },
  {
    id: 'p-2',
    name: '李四',
    avatar: null,
    type: 'adult',
    isDefault: false,
    isMain: false,
    pinProtected: true,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  },
];

function policyOf(profileId: string): Record<string, unknown> {
  return {
    profileId,
    maxContentLevel: 0,
    allowUnrated: false,
    allowedMediaIds: [],
    blockedMediaIds: [],
    allowedChannelIds: [],
    version: 7,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('T012 · settings-policy-page 两处 Select(FR-001/002/003)', () => {
  beforeEach(() => {
    installFetchRouter();
    fetchRouter = (_method, path) => {
      if (path === '/api/settings/access') {
        return { status: 200, body: { unlocked: true, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() } };
      }
      if (path === '/api/settings/profiles' && _method === 'GET') {
        return { status: 200, body: PROFILES };
      }
      if (/^\/api\/settings\/profiles\/p-[12]\/policy$/.test(path) && _method === 'GET') {
        const profileId = path.split('/')[4] ?? '';
        return { status: 200, body: policyOf(profileId) };
      }
      return undefined;
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('目标档案 Select:选项=档案名(主档案/停用后缀),当前值回显,切换触发重读策略', async () => {
    const user = userEvent.setup();
    renderPage(<SettingsPolicyPage />, '/settings/policy');
    const trigger = await screen.findByTestId('policy-profile-select');
    await waitFor(() => expect(trigger).toHaveTextContent('张三')); // 当前值 = 活跃档案
    await user.click(trigger);
    const listbox = await screen.findByRole('listbox');
    const labels = within(listbox)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(labels).toEqual(['张三(主档案)', '李四']); // 与原 option 文案逐字等价
    await user.click(within(listbox).getByRole('option', { name: '李四' }));
    await waitFor(() => {
      expect(fetchCalls.some((call) => call.path === '/api/settings/profiles/p-2/policy')).toBe(true);
    });
    await waitFor(() => expect(trigger).toHaveTextContent('李四'));
  });

  it('最高内容等级 Select:选项集合/当前值等价,键盘开合选档可见(焦点可见)', async () => {
    const user = userEvent.setup();
    renderPage(<SettingsPolicyPage />, '/settings/policy');
    const trigger = await screen.findByTestId('policy-level');
    await waitFor(() => expect(trigger).toHaveTextContent('全年龄(0)'));
    trigger.focus();
    expect(trigger).toHaveFocus();
    await user.keyboard('{Enter}');
    const listbox = await screen.findByRole('listbox');
    const labels = within(listbox)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(labels).toEqual(['全年龄(0)', '6+(0~6)', '12+(0~12)', '15+(0~15)', '18+(0~18,全部)']);
    await user.keyboard('{ArrowDown}'); // → 6+(0~6)
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByTestId('policy-level')).toHaveTextContent('6+(0~6)'));
  });
});

/* ---------------- settings-sources-page(T013:NAS 根目录) ---------------- */

const ROOTS = [
  { rootKey: 'root-a', label: '媒体库' },
  { rootKey: 'root-b', label: '照片库' },
];

describe('T013 · settings-sources-page NAS 根目录 Select(FR-001/002)', () => {
  beforeEach(() => {
    installFetchRouter();
    fetchRouter = (_method, path) => {
      if (path === '/api/settings/access') {
        return { status: 200, body: { unlocked: true, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() } };
      }
      if (path === '/api/settings/sources') {
        return { status: 200, body: { items: [], page: 1, pageSize: 20, total: 0 } };
      }
      if (path === '/api/settings/source-roots') {
        return { status: 200, body: ROOTS };
      }
      return undefined;
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('选项集合/当前值等价:请选择… + 全部根目录,选定后回显根目录标签', async () => {
    const user = userEvent.setup();
    renderPage(<SettingsSourcesPage />, '/settings/sources');
    await user.click(await screen.findByTestId('create-source-open'));
    await user.click(screen.getByRole('radio', { name: 'NAS' }));
    const trigger = await screen.findByLabelText('NAS 根目录');
    expect(trigger).toHaveTextContent('请选择…'); // 当前值(rootKey='')
    await chooseOption(user, trigger, '媒体库');
    await waitFor(() => expect(screen.getByLabelText('NAS 根目录')).toHaveTextContent('媒体库'));
  });
});

/* ---------------- GuidePage(T014:视图模式 + 每页频道数) ---------------- */

const TZ = 'America/New_York';
const NOW_ISO = '2026-11-04T12:05:00.000Z';
const ALLOWED_DATES = ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10'];

function programme(key: string, title: string, startsAt: string, endsAt: string) {
  return { key, title, description: null, startsAt, endsAt };
}

function channelOf(id: string, title: string, programmes: ReturnType<typeof programme>[]) {
  return {
    media: { id, type: 'channel' as const, title, description: null, posterRef: null, contentLevel: null, availability: 'available' as const },
    programmes,
  };
}

const GUIDE_BODY: GuideWindowDto = {
  date: '2026-11-04',
  timezone: TZ,
  now: NOW_ISO,
  allowedDates: ALLOWED_DATES,
  from: '2026-11-04T05:00:00.000Z',
  to: '2026-11-05T05:00:00.000Z',
  page: 1,
  pageSize: 20,
  totalChannels: 25,
  catalogRevision: 9,
  channels: [channelOf('ch-a', '频道甲', [programme('pg-a1', '早间新闻', '2026-11-04T11:00:00.000Z', '2026-11-04T12:00:00.000Z')])],
};

function LocationProbe(): ReactNode {
  const location = useLocation();
  return <div data-testid="loc-probe">{location.pathname + location.search}</div>;
}

function renderGuidePage(initialEntry = '/live/guide'): void {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SessionProvider>
        <SettingsAccessProvider>
          <ActionCoordinator>
            <LocationProbe />
            <GuidePage />
          </ActionCoordinator>
        </SettingsAccessProvider>
      </SessionProvider>
    </MemoryRouter>,
    // T023:GuidePage 取数已迁移 useAppQuery,需 QueryClientProvider(每例新 client)
    { wrapper: createQueryWrapper(createTestQueryClient()) },
  );
}

function guideCalls(): string[] {
  return fetchCalls
    .filter((call) => call.path.startsWith('/api/public/guide'))
    .map((call) => call.path);
}

describe('T014 · GuidePage 视图/每页频道数 Select(筛选行为不变)', () => {
  beforeEach(() => {
    installFetchRouter();
    fetchRouter = (_method, path) => {
      if (path.startsWith('/api/public/guide')) {
        return { status: 200, body: GUIDE_BODY };
      }
      return undefined;
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('视图模式 Select:选项=节目墙/按频道列表,当前值回显,切换写 URL view=list', async () => {
    const user = userEvent.setup();
    renderGuidePage();
    const trigger = await screen.findByLabelText('视图模式');
    await waitFor(() => expect(trigger).toHaveTextContent('节目墙')); // 当前值(view=wall)
    await chooseOption(user, trigger, '按频道列表');
    await waitFor(() => expect(screen.getByTestId('loc-probe')).toHaveTextContent('view=list'));
    await waitFor(() => expect(screen.getByLabelText('视图模式')).toHaveTextContent('按频道列表'));
  });

  it('每页频道数 Select:键盘开合、选项 20/30/50,选 50 → 请求与 URL pageSize=50 且清 channelPage', async () => {
    const user = userEvent.setup();
    renderGuidePage('/live/guide?channelPage=2');
    const trigger = await screen.findByLabelText('每页频道数');
    await waitFor(() => expect(trigger).toHaveTextContent('20')); // 当前值(pageSize 缺省 20)
    trigger.focus();
    expect(trigger).toHaveFocus();
    await user.keyboard('{Enter}');
    const listbox = await screen.findByRole('listbox');
    const labels = within(listbox)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(labels).toEqual(['20', '30', '50']);
    await user.click(within(listbox).getByRole('option', { name: '50' }));
    await waitFor(() => {
      expect(guideCalls().some((url) => url.includes('pageSize=50'))).toBe(true);
    });
    // channelPage 被清空(原 onChange 语义:改 pageSize 即回第 1 页)
    expect(guideCalls().at(-1)).toContain('page=1');
    expect(screen.getByTestId('loc-probe')).toHaveTextContent('pageSize=50');
    expect(screen.getByTestId('loc-probe').textContent).not.toContain('channelPage');
  });
});
