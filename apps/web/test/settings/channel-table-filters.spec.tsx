/**
 * 018 · 频道管理表格全量过滤修复(settings-epg-page)契约与交互:
 *
 * - 服务端可见性过滤:切片切换请求携带 visibility 枚举、回到第 1 页;
 *   三档计数 = 服务端 counts(家庭+关键词+类型过滤后、可见性过滤前),
 *   结果计数 = 当前切片 total(过滤后);前端不做本地当页过滤/重排;
 * - 搜索:按应用词回第 1 页全量过滤;
 * - 勾选语义:全选 = 当前页;翻页/切片/搜索变更清空勾选(批量栏随勾选出现/消失);
 * - 页钳制:显隐变更导致当前页收缩越界 → 自动回退到最后有效页重取;
 * - 失败态:候选查询失败以可重试错误面呈现(不静默吞掉),重试恢复列表。
 *
 * rig:stub 全局 fetch 模拟服务端过滤/计数/分页语义(与契约一致:基础过滤 →
 * counts → visibility → 稳定排序(显示优先/标题 UTF-8/id)→ 分页)。
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsEpgPage } from '../../src/features/settings/settings-epg-page';
import { SettingsAccessProvider } from '../../src/features/settings/settings-access-provider';
import type { CandidateDto, CandidatePageDto } from '../../src/features/settings/shared/settings-api';

interface FetchCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

let fetchCalls: FetchCall[] = [];
let queryClient: QueryClient;
/** 候选查询失败次数(每次消耗一;0 = 正常) */
let queryFailures = 0;

/** 60 个频道:前 41 个前台可见、后 19 个隐藏(>1 页混合可见性;标题零填充稳定排序) */
const ALL_CHANNELS: CandidateDto[] = Array.from({ length: 60 }, (_, index) => {
  const seq = String(index + 1).padStart(3, '0');
  return {
    id: `ch-${seq}`,
    type: 'channel' as const,
    title: `频道-${seq}`,
    description: null,
    contentLevel: null,
    poster: null,
    version: 1,
    available: true,
    visible: index < 41,
    logoUrl: null,
    lineCount: 1,
  };
});

/** 服务端语义(与实现一致):基础过滤 → counts → visibility → 稳定排序 → 分页 */
function queryChannels(body: Record<string, unknown>): CandidatePageDto {
  const q = String(body.q ?? '').trim().toLowerCase();
  let base = ALL_CHANNELS.filter(
    (channel) => q === '' || channel.title.toLowerCase().includes(q),
  );
  const counts = {
    all: base.length,
    visible: base.filter((channel) => channel.visible !== false).length,
    hidden: base.filter((channel) => channel.visible === false).length,
  };
  const visibility = body.visibility ?? 'all';
  if (visibility === 'visible') {
    base = base.filter((channel) => channel.visible !== false);
  } else if (visibility === 'hidden') {
    base = base.filter((channel) => channel.visible === false);
  }
  const sorted = [...base].sort((a, b) => {
    const aVis = a.visible !== false;
    const bVis = b.visible !== false;
    if (aVis !== bVis) return aVis ? -1 : 1;
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  });
  const pageSize = Number(body.pageSize ?? 20);
  const page = Number(body.page ?? 1);
  return {
    items: sorted.slice((page - 1) * pageSize, page * pageSize),
    total: sorted.length,
    counts,
    page,
    pageSize,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

function installFetchMock(): void {
  fetchCalls = [];
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
        return jsonResponse({ items: [], page: 1, pageSize: 20, total: 0 });
      }
      if (path === '/api/settings/catalog/candidates/query' && method === 'POST') {
        if (queryFailures > 0) {
          queryFailures -= 1;
          return jsonResponse({ title: 'Internal Server Error', status: 500, detail: '服务暂不可用' }, 500);
        }
        return jsonResponse(queryChannels(body ?? {}));
      }
      const patchMatch = /^\/api\/settings\/catalog\/media\/(ch-\d+)$/.exec(path);
      if (patchMatch !== null && method === 'PATCH') {
        const target = ALL_CHANNELS.find((channel) => channel.id === patchMatch[1]);
        if (target !== undefined && typeof body?.visible === 'boolean') {
          target.visible = body.visible;
          return jsonResponse({ ...target, version: target.version + 1 });
        }
        return jsonResponse(target ?? {}, target === undefined ? 404 : 200);
      }
      if (path === '/api/settings/catalog/media/batch-visibility' && method === 'POST') {
        return jsonResponse({ updatedCount: 0 });
      }
      return jsonResponse({});
    }),
  );
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/settings/iptv']}>
      <QueryClientProvider client={queryClient}>
        <SettingsAccessProvider>
          <Routes>
            <Route path="/settings/iptv" element={<SettingsEpgPage hideHeader />} />
          </Routes>
        </SettingsAccessProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function lastQueryCall(): FetchCall {
  const calls = fetchCalls.filter(
    (call) => call.method === 'POST' && call.path === '/api/settings/catalog/candidates/query',
  );
  return calls[calls.length - 1]!;
}

async function visibleRowIds(): Promise<string[]> {
  const rows = await screen.findAllByTestId(/^channel-row-/);
  return rows.map((row) => row.getAttribute('data-testid')?.replace('channel-row-', '') ?? '');
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryFailures = 0;
  // 逐用例恢复可见性基线(41 可见 / 19 隐藏)
  ALL_CHANNELS.forEach((channel, index) => {
    channel.visible = index < 41;
  });
  installFetchMock();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('018 · 频道管理全量过滤修复(服务端可见性切片/计数/分页)', () => {
  vi.setConfig({ testTimeout: 15000 });

  it('初始加载:默认 visibility=all 全量,计数标签呈现服务端三档 counts;表格按服务端序(显示优先)呈现', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('channel-row-ch-001')).toBeInTheDocument();
    });
    expect(lastQueryCall().body).toMatchObject({ visibility: 'all', page: 1, pageSize: 50, type: 'channel' });

    // 三档计数 = 全量真值(41 可见 / 19 隐藏 / 60 全部),与切片无关
    expect(screen.getByTestId('visibility-filter-all')).toHaveTextContent('全部 (60)');
    expect(screen.getByTestId('visibility-filter-visible')).toHaveTextContent('前台显示 (41)');
    expect(screen.getByTestId('visibility-filter-hidden')).toHaveTextContent('已隐藏 (19)');
    // 结果计数 = 当前切片 total
    expect(screen.getByTestId('channel-result-count')).toHaveTextContent('共 60 个频道');
    // 服务端稳定排序:显示项在前(首页全为可见频道)
    // 服务端稳定排序:41 条可见在前,隐藏补足当页尾部(第 42-50 行 = ch-042..ch-050)
    const ids = await visibleRowIds();
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe('ch-001');
    expect(ids[40]).toBe('ch-041');
    expect(ids[41]).toBe('ch-042');
  });

  it('切换已隐藏切片:请求 visibility=hidden 回第 1 页,仅呈现隐藏频道;计数恒为全量三档(不随切片改写)', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('channel-row-ch-001')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('visibility-filter-hidden'));

    await waitFor(() => {
      expect(screen.queryByTestId('channel-row-ch-001')).not.toBeInTheDocument();
    });
    expect(lastQueryCall().body).toMatchObject({ visibility: 'hidden', page: 1 });

    const ids = await visibleRowIds();
    expect(ids).toHaveLength(19);
    expect(ids[0]).toBe('ch-042');
    // 计数标签仍是全量三档(可见性过滤前),结果计数 = 过滤后 total
    expect(screen.getByTestId('visibility-filter-visible')).toHaveTextContent('前台显示 (41)');
    expect(screen.getByTestId('channel-result-count')).toHaveTextContent('共 19 个频道');
  });

  it('搜索:应用词回第 1 页按全量过滤;清空立即复原;翻页沿用已应用词', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('channel-row-ch-001')).toBeInTheDocument();
    });

    const input = screen.getByTestId('epg-channel-q').querySelector('input') ?? screen.getByTestId('epg-channel-q');
    await user.clear(input);
    await user.type(input, '频道-05');
    await user.click(screen.getByTestId('epg-channel-search'));

    await waitFor(() => {
      expect(lastQueryCall().body).toMatchObject({ q: '频道-05', page: 1 });
    });
    const ids = await visibleRowIds();
    expect(ids).toHaveLength(10); // 频道-050 .. 频道-059
    expect(ids[0]).toBe('ch-050');
    // 计数随关键词基线变化(家庭+关键词+类型过滤后)
    expect(screen.getByTestId('visibility-filter-all')).toHaveTextContent('全部 (10)');
  });

  it('搜索无结果时，全库操作确认仍读取完整家庭频道数，取消不写入', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('channel-row-ch-001');
    await user.type(screen.getByTestId('epg-channel-q'), '没有这样的频道');
    await user.click(screen.getByTestId('epg-channel-search'));
    await screen.findByTestId('epg-channel-empty');
    expect(screen.getByTestId('visibility-filter-all')).toHaveTextContent('全部 (0)');
    await user.click(screen.getByTestId('channel-more-menu'));
    await user.click(await screen.findByRole('menuitem', { name: '全库设为隐藏' }));
    const dialog = await screen.findByTestId('all-visibility-confirm');
    await waitFor(() => expect(dialog).toHaveTextContent('共 60 个频道'));
    expect(lastQueryCall().body).not.toHaveProperty('q');
    expect(lastQueryCall().body).toMatchObject({ type: 'channel', visibility: 'all', pageSize: 1 });
    await user.click(screen.getByTestId('all-visibility-cancel'));
    expect(fetchCalls.some((call) => call.path === '/api/settings/catalog/media/batch-visibility')).toBe(false);
  });

  it('勾选语义:全选 = 当前页;翻页/切片变更清空勾选(批量栏随勾选出现与消失)', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('channel-row-ch-001')).toBeInTheDocument();
    });

    // 全选当前页(50/页):批量栏计数 = 50,而非全库 60
    const selectAll = screen.getByTestId('select-all-checkbox');
    await user.click(selectAll.querySelector('input') ?? selectAll);
    expect(screen.getByTestId('channel-batch-bar')).toHaveTextContent('已选 50 项(当前页)');

    // 手动翻到第 2 页:勾选清空,批量栏消失
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => {
      expect(screen.getByTestId('channel-row-ch-051')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('channel-batch-bar')).not.toBeInTheDocument();

    // 勾选一条后切换切片:同样清空
    const one = screen.getByTestId('select-channel-ch-051');
    await user.click(one.querySelector('input') ?? one);
    expect(screen.getByTestId('channel-batch-bar')).toHaveTextContent('已选 1 项');
    await user.click(screen.getByTestId('visibility-filter-hidden'));
    await waitFor(() => {
      expect(screen.queryByTestId('channel-batch-bar')).not.toBeInTheDocument();
    });
  });

  it('页钳制:隐藏当前页最后一条可见频道后,越界页自动回退到最后有效页', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('channel-row-ch-001')).toBeInTheDocument();
    });

    // 前台显示切片 + 20/页:41 条可见 → 3 页;翻到第 3 页(仅 ch-041)
    await user.click(screen.getByTestId('visibility-filter-visible'));
    await waitFor(() => {
      expect(lastQueryCall().body).toMatchObject({ visibility: 'visible' });
    });
    await user.click(screen.getByRole('button', { name: '20' }));
    await waitFor(() => {
      expect(lastQueryCall().body).toMatchObject({ pageSize: 20, page: 1 });
    });
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => {
      expect(screen.getByTestId('channel-row-ch-021')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => {
      expect(screen.getByTestId('channel-row-ch-041')).toBeInTheDocument();
    });
    expect(screen.getByTestId('channel-result-count')).toHaveTextContent('第 3/3 页');

    // 隐藏 ch-041 → 可见集合收缩为 40(20/页 → 2 页);第 3 页越界 → 钳制回第 2 页
    const switchEl = screen.getByTestId('channel-visibility-switch-ch-041');
    await user.click(switchEl.querySelector('input') ?? switchEl);

    await waitFor(() => {
      expect(screen.getByTestId('channel-result-count')).toHaveTextContent('共 40 个频道');
    });
    await waitFor(() => {
      // 钳制后的最后一次查询落在最后有效页(第 2 页),当页呈现 ch-021..ch-040
      expect(lastQueryCall().body).toMatchObject({ visibility: 'visible', page: 2 });
      expect(screen.getByTestId('channel-row-ch-040')).toBeInTheDocument();
      expect(screen.queryByTestId('channel-row-ch-041')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('visibility-filter-visible')).toHaveTextContent('前台显示 (40)');
  });

  it('失败态:候选查询失败呈现可重试错误面(不静默);重试恢复列表', async () => {
    const user = userEvent.setup();
    queryFailures = 1;
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('频道列表读取失败');
    expect(alert).toHaveTextContent('服务暂不可用');

    await user.click(within(alert).getByRole('button', { name: '重试' }));
    await waitFor(() => {
      expect(screen.getByTestId('channel-row-ch-001')).toBeInTheDocument();
    });
  });
});
