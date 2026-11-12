/**
 * 018 · EPG 来源合并看板(settings-epg-priorities:来源清单 × 优先级合一)契约与交互:
 *
 * - 合并读取:GET /api/settings/sources(本地过滤 kind=epg,含停用源)×
 *   GET /api/settings/sources/epg-priorities(启用源 priority ASC)按 sourceId 合并 ——
 *   每源恰一行、停用源不缺行(无优先级投影 → 排尾部、呈现「未参与级联(已停用)」、
 *   不臆造频道数/同步时间);非 EPG 来源不出现;
 * - 排序草稿:上移/下移仅改本地(首行禁上移/末行禁下移),「取消」丢弃草稿回服务端
 *   现序,未保存提示与保存按钮联动;保存前零 PUT;
 * - PUT body = { priorities: [{ sourceId, priority }] }:显示序(含停用源)重排为
 *   1..N 连续整数 → { success, updatedCount };成功后失效重读(GET 二次),未保存
 *   提示归位;失败呈现稳定语义文案(403 权限/400 校验/404 不存在),草稿保留可重试;
 * - 行内能力:启停开关 PATCH /settings/sources/:id(expectedVersion CAS + enabled)、
 *   立即同步 POST /settings/sources/:id/refresh(幂等 operationKey;停用源禁用)、
 *   任务状态呈现(awaiting_confirmation 确认/丢弃;failed 失败提示;进行中不确定进度);
 * - 读取 403:RetryableAlert 稳定文案 + 重试(不重复鉴权,门禁在 Guard 体系)。
 *
 * rig 惯例:stub 全局 fetch 走真实 privateFetch 底座,观察端挂应用单例 QueryClient;
 * DTO 手写最小合法对象,零真实网络。SettingsAccessProvider 无 SessionProvider 时按
 * 主管理员渲染(provider 缺省口径),不 mock 会话。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toast } from '@heroui/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsEpgPriorities } from '../../src/features/settings/settings-epg-priorities';
import { SettingsAccessProvider } from '../../src/features/settings/settings-access-provider';
import { AppToastRegion } from '../../src/shared/ui';
import { queryClient as appQueryClient } from '../../src/shared/query/client';
import type { EpgSourcePriorityDto } from '@hmp/shared';
import type { RefreshDto, SourceDto } from '../../src/features/settings/shared/settings-api';

interface FetchCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

/** problem+json 覆盖(null = 正常应答) */
interface ProblemOverride {
  status: number;
  title: string;
  code?: string;
  detail?: string;
}

let fetchCalls: FetchCall[] = [];
let prioritiesFixture: EpgSourcePriorityDto[];
let sourcesFixture: SourceDto[];
let getPrioritiesProblem: ProblemOverride | null = null;
let getSourcesProblem: ProblemOverride | null = null;
let putProblem: ProblemOverride | null = null;
/** 任务表(jobId → RefreshDto;默认 awaiting_confirmation 任务挂在 src_epg_b) */
let jobsFixture: Record<string, RefreshDto>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function problem(body: ProblemOverride): Response {
  return new Response(JSON.stringify(body), {
    status: body.status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

function sortedFixture(): EpgSourcePriorityDto[] {
  return [...prioritiesFixture].sort((a, b) => a.priority - b.priority);
}

function makeSource(overrides: Partial<SourceDto> & Pick<SourceDto, 'id' | 'name' | 'enabled'>): SourceDto {
  return {
    kind: 'epg',
    version: 1,
    epgSourceId: null,
    locationLabel: 'epg.example/xmltv.xml',
    lastSuccessAt: '2026-11-09T08:00:00Z',
    lastJobId: null,
    ...overrides,
  };
}

function installFetchMock(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost:3000');
      const path = url.pathname;
      const method = (init?.method ?? 'GET').toUpperCase();
      let body: Record<string, unknown> | null = null;
      if (typeof init?.body === 'string' && init.body !== '') {
        body = JSON.parse(init.body) as Record<string, unknown>;
      }
      fetchCalls.push({ method, path, body });
      if (path === '/api/settings/sources' && method === 'GET') {
        if (getSourcesProblem !== null) {
          return problem(getSourcesProblem);
        }
        return jsonResponse({ items: sourcesFixture, page: 1, pageSize: 20, total: sourcesFixture.length });
      }
      if (/^\/api\/settings\/sources\/[^/]+$/.test(path) && method === 'PATCH') {
        const sourceId = path.split('/').pop() ?? '';
        const enabled = (body?.enabled as boolean | undefined) ?? undefined;
        sourcesFixture = sourcesFixture.map((source) =>
          source.id === sourceId && enabled !== undefined
            ? { ...source, enabled, version: source.version + 1 }
            : source,
        );
        return jsonResponse(sourcesFixture.find((source) => source.id === sourceId) ?? {});
      }
      if (/^\/api\/settings\/sources\/[^/]+\/refresh$/.test(path) && method === 'POST') {
        const sourceId = path.split('/').at(-2) ?? '';
        const job: RefreshDto = {
          id: `job-${sourceId}-new`,
          sourceId,
          status: 'queued',
          version: 1,
          createdAt: '2026-11-09T08:00:00Z',
          startedAt: null,
          finishedAt: null,
          expiresAt: null,
          counts: { added: 0, updated: 0, missing: 0, failed: 0, channels: 0, programmes: 0 },
          confirmationReason: null,
          errorCode: null,
        };
        jobsFixture = { ...jobsFixture, [job.id]: job };
        return jsonResponse(job, 202);
      }
      if (path === '/api/settings/sources/epg-priorities') {
        if (method === 'GET') {
          if (getPrioritiesProblem !== null) {
            return problem(getPrioritiesProblem);
          }
          return jsonResponse({ sources: sortedFixture() });
        }
        if (method === 'PUT') {
          if (putProblem !== null) {
            return problem(putProblem);
          }
          const priorities = (body?.priorities ?? []) as Array<{ sourceId: string; priority: number }>;
          for (const entry of priorities) {
            const source = prioritiesFixture.find((item) => item.sourceId === entry.sourceId);
            if (source !== undefined) {
              source.priority = entry.priority;
            }
          }
          return jsonResponse({ success: true, updatedCount: priorities.length });
        }
      }
      const refreshMatch = /^\/api\/settings\/refreshes\/([^/]+)$/.exec(path);
      if (refreshMatch !== null && method === 'GET') {
        const job = jobsFixture[refreshMatch[1] ?? ''];
        if (job !== undefined) {
          return jsonResponse(job);
        }
      }
      const settleMatch = /^\/api\/settings\/refreshes\/([^/]+)\/(confirm|discard)$/.exec(path);
      if (settleMatch !== null && method === 'POST') {
        const job = jobsFixture[settleMatch[1] ?? ''];
        if (job !== undefined) {
          const settled: RefreshDto = {
            ...job,
            status: settleMatch[2] === 'confirm' ? 'succeeded' : 'discarded',
            version: job.version + 1,
          };
          jobsFixture = { ...jobsFixture, [settled.id]: settled };
          return jsonResponse(settled);
        }
      }
      return jsonResponse({ title: 'Not Found', status: 404 }, 404);
    }),
  );
}

function renderBoard(): void {
  appQueryClient.clear();
  render(
    <MemoryRouter initialEntries={['/settings/iptv?tab=epg']}>
      <QueryClientProvider client={appQueryClient}>
        <AppToastRegion />
        <SettingsAccessProvider>
          <SettingsEpgPriorities />
        </SettingsAccessProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function rowIds(): string[] {
  return screen
    .getAllByTestId(/^epg-priority-row-/)
    .map((row) => row.getAttribute('data-testid')?.replace('epg-priority-row-', '') ?? '');
}

function calls(method: string, path: string): FetchCall[] {
  return fetchCalls.filter((call) => call.method === method && call.path === path);
}

const AWAITING_JOB: RefreshDto = {
  id: 'job-awaiting',
  sourceId: 'src_epg_b',
  status: 'awaiting_confirmation',
  version: 3,
  createdAt: '2026-11-09T07:00:00Z',
  startedAt: '2026-11-09T07:00:01Z',
  finishedAt: null,
  expiresAt: null,
  counts: { added: 4, updated: 2, missing: 1, failed: 0, channels: 6, programmes: 900 },
  confirmationReason: 'empty_snapshot',
  errorCode: null,
};

beforeEach(() => {
  Toast.toast.clear();
  fetchCalls = [];
  getPrioritiesProblem = null;
  getSourcesProblem = null;
  putProblem = null;
  prioritiesFixture = [
    { sourceId: 'src_epg_a', name: '官方 XMLTV', priority: 10, channelCount: 180, lastSyncAt: '2026-11-09T08:00:00Z' },
    { sourceId: 'src_epg_c', name: '第三方聚合源', priority: 30, channelCount: 12, lastSyncAt: '2026-11-01T23:30:00Z' },
  ];
  sourcesFixture = [
    makeSource({ id: 'src_epg_c', name: '第三方聚合源', enabled: true, lastJobId: null }),
    makeSource({ id: 'src_epg_a', name: '官方 XMLTV', enabled: true, lastJobId: null }),
    // 停用源:优先级视图不含 → 合并看板必须仍显示(排尾部,不臆造计数)
    makeSource({
      id: 'src_epg_b',
      name: '社区备用 EPG',
      enabled: false,
      lastSuccessAt: null,
      lastJobId: 'job-awaiting',
    }),
    // 非 EPG 来源:合并看板不出现
    makeSource({ id: 'src_iptv_x', name: '直播订阅', kind: 'iptv', enabled: true }),
  ];
  jobsFixture = { 'job-awaiting': { ...AWAITING_JOB } };
  installFetchMock();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('018 · EPG 来源合并看板(来源清单 × 优先级合一)', () => {
  vi.setConfig({ testTimeout: 15000 });

  it('合并渲染:启用源按 priority ASC,停用源不缺行排尾部;行内呈现域名/权重/频道数/上次同步,过滤非 EPG 来源', async () => {
    renderBoard();

    await screen.findByTestId('epg-priorities-list');
    await screen.findByTestId('epg-priority-row-src_epg_a');

    // 基准序 = 启用源 priority ASC(10 → 30)→ 停用源(清单序);每源恰一行
    expect(rowIds()).toEqual(['src_epg_a', 'src_epg_c', 'src_epg_b']);
    expect(screen.queryByTestId('epg-priority-row-src_iptv_x')).not.toBeInTheDocument();

    const rowA = screen.getByTestId('epg-priority-row-src_epg_a');
    expect(rowA).toHaveTextContent('官方 XMLTV');
    expect(rowA).toHaveTextContent('epg.example/xmltv.xml');
    // 真实计数仅在优先级投影提供时呈现(不臆造)
    expect(rowA).toHaveTextContent('180 个频道');
    expect(rowA).toHaveTextContent('上次成功同步 2026-11-09 08:00:00');
    expect(rowA).toHaveTextContent('已启用');

    // 停用源:不缺行,无优先级投影 → 不呈现臆造的频道数/同步时间
    const rowB = screen.getByTestId('epg-priority-row-src_epg_b');
    expect(rowB).toHaveTextContent('社区备用 EPG');
    expect(rowB).toHaveTextContent('已停用');
    expect(rowB).toHaveTextContent('频道数量暂不可用');
    expect(rowB).toHaveTextContent('尚无成功导入');

    // 初始无未保存提示,保存不可用
    expect(screen.queryByTestId('epg-priorities-dirty')).not.toBeInTheDocument();
    expect(screen.getByTestId('epg-priorities-save')).toBeDisabled();
  });

  it('上移/下移草稿:边界禁用,未保存提示出现且零 PUT;取消丢弃草稿回服务端现序', async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByTestId('epg-priority-row-src_epg_a');

    // 边界:首行禁上移、末行禁下移
    expect(screen.getByTestId('epg-priority-up-src_epg_a')).toBeDisabled();
    expect(screen.getByTestId('epg-priority-up-src_epg_c')).toBeEnabled();
    expect(screen.getByTestId('epg-priority-down-src_epg_b')).toBeDisabled();

    // 草稿重排:官方 XMLTV 下移 → c,a,b
    await user.click(screen.getByTestId('epg-priority-down-src_epg_a'));
    expect(rowIds()).toEqual(['src_epg_c', 'src_epg_a', 'src_epg_b']);
    expect(screen.getByTestId('epg-priorities-dirty')).toHaveTextContent('未保存');
    expect(screen.getByTestId('epg-priorities-save')).toBeEnabled();
    expect(screen.getByTestId('epg-priorities-cancel')).toBeEnabled();

    // 取消:丢弃草稿回服务端现序,未保存归位
    await user.click(screen.getByTestId('epg-priorities-cancel'));
    expect(rowIds()).toEqual(['src_epg_a', 'src_epg_c', 'src_epg_b']);
    expect(screen.queryByTestId('epg-priorities-dirty')).not.toBeInTheDocument();
    expect(screen.getByTestId('epg-priorities-save')).toBeDisabled();

    // 草稿期间零写入
    expect(calls('PUT', '/api/settings/sources/epg-priorities')).toHaveLength(0);
  });

  it('保存:PUT body = 显示序(含停用源)重排 1..N;成功后失效重读,未保存提示归位', async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByTestId('epg-priority-row-src_epg_a');

    // 官方 XMLTV 下移一位(草稿序 c,a,b)→ 保存
    await user.click(screen.getByTestId('epg-priority-down-src_epg_a'));
    await user.click(screen.getByTestId('epg-priorities-save'));

    await waitFor(() => {
      expect(calls('PUT', '/api/settings/sources/epg-priorities')).toHaveLength(1);
    });
    const putBody = calls('PUT', '/api/settings/sources/epg-priorities')[0]?.body as {
      priorities: Array<{ sourceId: string; priority: number }>;
    };
    // 严格契约形状:仅 priorities 键;显示序(含停用源)重排为连续 1..N
    expect(Object.keys(putBody).sort()).toEqual(['priorities']);
    expect(putBody.priorities).toEqual([
      { sourceId: 'src_epg_c', priority: 1 },
      { sourceId: 'src_epg_a', priority: 2 },
      { sourceId: 'src_epg_b', priority: 3 },
    ]);

    // 成功反馈 + 失效重读(GET 二次请求)
    await waitFor(() => {
      expect(calls('GET', '/api/settings/sources/epg-priorities')).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId('epg-priorities-status')).toHaveTextContent('已保存 3 个');
    });
    expect(screen.queryByTestId('epg-priorities-dirty')).not.toBeInTheDocument();
    expect(screen.getByTestId('epg-priorities-save')).toBeDisabled();
  });

  it('失败呈现稳定语义:PUT 400/403 各出稳定文案,草稿保留可重试', async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByTestId('epg-priority-row-src_epg_a');

    putProblem = { status: 400, title: 'Bad Request', code: 'VALIDATION_FAILED', detail: '优先级必须是 1~999 的整数' };
    await user.click(screen.getByTestId('epg-priority-down-src_epg_a'));
    await user.click(screen.getByTestId('epg-priorities-save'));
    await waitFor(() => {
      expect(screen.getByTestId('epg-priorities-error')).toHaveTextContent('优先级数据未通过校验(HTTP 400)');
    });
    // 草稿保留:顺序未归位,可重试
    expect(screen.getByTestId('epg-priorities-save')).toBeEnabled();
    expect(rowIds()).toEqual(['src_epg_c', 'src_epg_a', 'src_epg_b']);

    putProblem = { status: 403, title: 'Forbidden', code: 'FORBIDDEN' };
    await user.click(screen.getByTestId('epg-priorities-save'));
    await waitFor(() => {
      expect(screen.getByTestId('epg-priorities-error')).toHaveTextContent('权限已失效(HTTP 403)');
    });
    expect(calls('PUT', '/api/settings/sources/epg-priorities')).toHaveLength(2);
  });

  it('读取失败:RetryableAlert 呈现稳定文案并提供重试(重读按同端点)', async () => {
    getSourcesProblem = { status: 403, title: 'Forbidden', code: 'FORBIDDEN' };
    renderBoard();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('读取失败');
    expect(alert).toHaveTextContent('没有权限执行此操作');
    expect(screen.getByRole('button', { name: '重试' })).toBeEnabled();
    expect(screen.queryByTestId('epg-priorities-list')).not.toBeInTheDocument();
  });

  it('行内操作:启停开关 PATCH enabled(CAS 版本);停用源禁用立即同步,启用源发起 refresh(幂等 operationKey)', async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByTestId('epg-priority-row-src_epg_a');

    // 停用源:立即同步禁用(同步属运维入口,停用即不可发起)
    expect(screen.getByTestId('epg-source-sync-src_epg_b')).toBeDisabled();
    // 启用源:立即同步 → POST refresh(202 queued;body 含 expectedVersion + operationKey UUID)
    await user.click(screen.getByTestId('epg-source-sync-src_epg_a'));
    await waitFor(() => {
      const call = fetchCalls.find((c) => c.method === 'POST' && c.path === '/api/settings/sources/src_epg_a/refresh');
      expect(call).toBeDefined();
      expect(call?.body).toMatchObject({ expectedVersion: 1 });
      expect(String((call?.body as { operationKey?: string })?.operationKey)).toMatch(
        /^[0-9a-f-]{36}$/,
      );
    });

    // 启停开关:停用第三方聚合源 → PATCH enabled=false + CAS 版本
    const toggle = screen.getByTestId('epg-source-toggle-src_epg_c');
    const toggleInput = toggle.querySelector('input') ?? toggle;
    await user.click(toggleInput);
    await waitFor(() => {
      const patch = fetchCalls.find(
        (c) => c.method === 'PATCH' && c.path === '/api/settings/sources/src_epg_c',
      );
      expect(patch).toBeDefined();
      expect(patch?.body).toStrictEqual({ expectedVersion: 1, enabled: false });
    });
  });

  it('任务状态:awaiting_confirmation 呈现待确认快照与计数,确认/丢弃经任务 CAS;failed 呈现失败提示', async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByTestId('epg-priority-row-src_epg_b');

    // 停用源挂着 awaiting_confirmation 任务:行内常驻待确认面(计数 = 服务端真值)
    const jobPanel = screen.getByTestId('epg-source-job-src_epg_b');
    expect(jobPanel).toHaveTextContent('待确认快照 (awaiting_confirmation)');
    expect(jobPanel).toHaveTextContent('新增 4');
    expect(jobPanel).toHaveTextContent('更新 2');
    expect(jobPanel).toHaveTextContent('缺失 1');

    // 确认发布 → POST confirm(expectedVersion CAS)
    await user.click(screen.getByTestId('job-confirm-job-awaiting'));
    await waitFor(() => {
      const call = fetchCalls.find(
        (c) => c.method === 'POST' && c.path === '/api/settings/refreshes/job-awaiting/confirm',
      );
      expect(call).toBeDefined();
      expect(call?.body).toStrictEqual({ expectedVersion: 3 });
    });

    // failed 任务:失败提示常驻可读(上次成功目录保留语义)
    jobsFixture = {
      ...jobsFixture,
      'job-awaiting': { ...AWAITING_JOB, id: 'job-awaiting', status: 'failed' },
    };
    renderBoard();
    await screen.findByTestId('epg-priority-row-src_epg_b');
    // 双渲染仅断言失败面存在(组件按 lastJobId 補读任务后呈现)
    await waitFor(
      () => {
        expect(
          screen.getAllByTestId('epg-source-job-src_epg_b').some((panel) =>
            panel.textContent?.includes('导入失败'),
          ),
        ).toBe(true);
      },
      { timeout: 6000 },
    );
  });
});
