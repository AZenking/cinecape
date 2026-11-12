import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsEpgPage } from '../../src/features/settings/settings-epg-page';
import { SettingsIptvPage } from '../../src/features/settings/settings-iptv-page';
import { SettingsAccessProvider } from '../../src/features/settings/settings-access-provider';
import { ChannelEditModal } from '../../src/features/settings/components/ChannelEditModal';
import type { CandidateDto, SourceDto } from '../../src/features/settings/shared/settings-api';

interface FetchCall {
  method: string;
  path: string;
  body: unknown;
}

let fetchCalls: FetchCall[] = [];
let queryClient: QueryClient;

function renderSettingsPage(): void {
  render(
    <MemoryRouter initialEntries={['/settings/epg']}>
      <QueryClientProvider client={queryClient}>
        <SettingsAccessProvider>
          <Routes>
            <Route path="/settings/epg" element={<SettingsEpgPage />} />
          </Routes>
        </SettingsAccessProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

const mockChannels: CandidateDto[] = [
  {
    id: 'ch-1',
    type: 'channel',
    title: 'CCTV-1 综合',
    description: null,
    contentLevel: null,
    poster: null,
    version: 1,
    available: true,
    visible: false,
    logoUrl: 'https://example.com/cctv1.png',
    lineCount: 2,
    epgBinding: {
      mediaId: 'ch-1',
      mode: 'manual',
      version: 1,
      epgSourceId: 'src-1',
      xmltvChannelId: 'cctv1',
      status: 'valid',
      invalidReason: null,
    },
  },
  {
    id: 'ch-2',
    type: 'channel',
    title: 'CCTV-2 财经',
    description: null,
    contentLevel: null,
    poster: null,
    version: 1,
    available: true,
    visible: false,
    logoUrl: null,
    lineCount: 1,
    epgBinding: {
      mediaId: 'ch-2',
      mode: 'auto',
      version: 1,
      epgSourceId: null,
      xmltvChannelId: null,
      status: 'auto',
      invalidReason: null,
    },
  },
];

const mockEpgSources: SourceDto[] = [
  {
    id: 'src-1',
    name: 'EPG-CN',
    kind: 'epg',
    enabled: true,
    version: 1,
    epgSourceId: null,
    locationLabel: 'https://epg.pw/xmltv.xml',
    lastSuccessAt: '2026-11-09T00:00:00Z',
    lastJobId: null,
  },
  {
    id: 'src-iptv-1',
    name: '国内电视台直播源',
    kind: 'iptv',
    enabled: true,
    version: 1,
    epgSourceId: null,
    locationLabel: 'https://raw.githubusercontent.com',
    lastSuccessAt: '2026-11-09T00:00:00Z',
    lastJobId: null,
  },
];

function setupFetchMocks(): void {
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

      if (path === '/api/settings/sources') {
        return jsonResponse({ items: mockEpgSources, total: 1 });
      }

      if (path === '/api/settings/catalog/candidates/query') {
        return jsonResponse({
          items: mockChannels,
          total: 2,
          page: 1,
          pageSize: 50,
        });
      }

      if (path === '/api/settings/catalog/media/batch-visibility' && method === 'POST') {
        const payload = body as { mediaIds?: string[]; all?: boolean; visible: boolean };
        const updatedCount = payload.all ? 2 : (payload.mediaIds?.length ?? 0);
        return jsonResponse({ updatedCount });
      }

      if (path === '/api/settings/catalog/upload-logo' && method === 'POST') {
        return jsonResponse({
          url: '/api/public/media/custom-logos/test-logo-uuid.png',
          filename: 'test-logo-uuid.png',
        });
      }

      if (path === '/api/settings/catalog/media/ch-1/epg-binding/query') {
        return jsonResponse(mockChannels[0]!.epgBinding);
      }

      if (path === '/api/settings/catalog/media/ch-1/epg-candidates/query') {
        return jsonResponse({
          items: [
            { xmltvChannelId: 'cctv1', displayName: 'CCTV-1 综合', current: null, next: null },
            { xmltvChannelId: 'cctv1-hd', displayName: 'CCTV-1 高清', current: null, next: null },
          ],
          epgGeneration: 3,
        });
      }

      if (path === '/api/settings/catalog/media/ch-1/epg-binding' && method === 'PUT') {
        const payload = body as { mode: 'manual' | 'auto'; xmltvChannelId?: string };
        return jsonResponse({
          mediaId: 'ch-1',
          mode: payload.mode,
          version: 2,
          epgSourceId: payload.mode === 'manual' ? 'src-1' : null,
          xmltvChannelId: payload.mode === 'manual' ? payload.xmltvChannelId : null,
          status: payload.mode === 'manual' ? 'valid' : 'auto',
          invalidReason: null,
        });
      }

      if (path === '/api/settings/catalog/media/ch-1/streams' && method === 'GET') {
        return jsonResponse({
          items: [
            {
              id: 'st-1',
              sourceEntryId: 'se-1',
              sourceId: 'src-iptv-1',
              sourceName: '国内电视台直播源',
              protocol: 'hls',
              location: 'http://example.com/cctv1.m3u8',
              priority: 10,
            },
            {
              id: 'st-2',
              sourceEntryId: 'se-2',
              sourceId: 'src-iptv-2',
              sourceName: '备用源',
              protocol: 'hls',
              location: 'http://backup.example.com/cctv1.m3u8',
              priority: 5,
            },
          ],
        });
      }

      if (path === '/api/settings/catalog/media/ch-1/streams' && method === 'POST') {
        const payload = body as { location: string; protocol?: string };
        return jsonResponse({
          id: 'st-new',
          sourceEntryId: 'se-new',
          sourceId: 'manual',
          sourceName: '自定义线路',
          protocol: payload.protocol ?? 'hls',
          location: payload.location,
          priority: 0,
        });
      }

      if (path.startsWith('/api/settings/catalog/media/ch-1/streams/') && method === 'PATCH') {
        const streamId = path.split('/').pop()!;
        const payload = body as { location?: string; priority?: number };
        return jsonResponse({
          id: streamId,
          sourceEntryId: 'se-' + streamId,
          sourceId: 'src-1',
          sourceName: '源',
          protocol: 'hls',
          location: payload.location ?? 'http://example.com/cctv1.m3u8',
          priority: payload.priority ?? 10,
        });
      }

      if (path.startsWith('/api/settings/catalog/media/ch-1/streams/') && method === 'DELETE') {
        return jsonResponse({ success: true });
      }

      if (path.startsWith('/api/settings/catalog/media/') && method === 'PATCH') {
        return jsonResponse({
          ...mockChannels[0],
          version: 2,
        });
      }

      return jsonResponse({});
    }),
  );
}

describe('频道批量操作与统一编辑弹窗测试', () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    setupFetchMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('批量操作: 勾选频道并触发批量设为显示与批量设为隐藏(批量栏仅在有勾选时出现)', async () => {
    const user = userEvent.setup();
    renderSettingsPage();

    // 等待频道渲染
    await waitFor(() => {
      expect(screen.getByTestId('channel-row-ch-1')).toBeInTheDocument();
      expect(screen.getByTestId('channel-row-ch-2')).toBeInTheDocument();
    });

    // 无勾选时不渲染批量栏(018:批量栏仅在有选择时出现)
    expect(screen.queryByTestId('channel-batch-bar')).not.toBeInTheDocument();

    // 勾选第 1 个频道 → 批量栏出现
    const checkbox1 = screen.getByTestId('select-channel-ch-1');
    const input1 = checkbox1.querySelector('input') ?? checkbox1;
    await user.click(input1);

    const batchBar = screen.getByTestId('channel-batch-bar');
    expect(batchBar).toHaveTextContent('已选 1 项');
    const batchVisibleBtn = screen.getByTestId('batch-visible-btn');
    const batchHideBtn = screen.getByTestId('batch-hide-btn');
    expect(batchVisibleBtn).toBeEnabled();
    expect(batchHideBtn).toBeEnabled();

    // 点击批量设为显示
    await user.click(batchVisibleBtn);

    await waitFor(() => {
      const call = fetchCalls.find(
        (c) => c.method === 'POST' && c.path === '/api/settings/catalog/media/batch-visibility',
      );
      expect(call).toBeDefined();
      expect(call?.body).toStrictEqual({
        mediaIds: ['ch-1'],
        visible: true,
      });
    });

    // 勾选全选当前页(选择语义 = 当前页)后再批量设为隐藏
    const selectAllCheckbox = screen.getByTestId('select-all-checkbox');
    const selectAllInput = selectAllCheckbox.querySelector('input') ?? selectAllCheckbox;
    await user.click(selectAllInput);

    expect(screen.getByTestId('channel-batch-bar')).toHaveTextContent('已选 2 项');

    // 点击批量设为隐藏
    await user.click(screen.getByTestId('batch-hide-btn'));

    await waitFor(() => {
      const call = fetchCalls
        .reverse()
        .find((c) => c.method === 'POST' && c.path === '/api/settings/catalog/media/batch-visibility');
      expect(call).toBeDefined();
      expect(call?.body).toStrictEqual({
        mediaIds: ['ch-1', 'ch-2'],
        visible: false,
      });
    });
  });

  it('全库快捷操作: 更多菜单发起,确认弹层明确忽略当前搜索后发送 all: true;取消则不发请求', async () => {
    const user = userEvent.setup();
    renderSettingsPage();

    await waitFor(() => {
      expect(screen.getByTestId('channel-row-ch-1')).toBeInTheDocument();
    });

    // 全库入口在「更多」菜单内
    await user.click(screen.getByTestId('channel-more-menu'));
    const allHideItem = await screen.findByRole('menuitem', { name: '全库设为隐藏' });
    await user.click(allHideItem);

    // 确认弹层:文案明确「忽略当前搜索与筛选条件」;取消不发送任何请求
    const dialog = await screen.findByTestId('all-visibility-confirm');
    expect(dialog).toHaveTextContent('忽略当前搜索与筛选条件');
    await user.click(screen.getByTestId('all-visibility-cancel'));
    expect(
      fetchCalls.find(
        (c) => c.method === 'POST' && (c.body as { all?: boolean })?.all === true,
      ),
    ).toBeUndefined();

    // 再次发起并确认 → 发送 all: true
    await user.click(screen.getByTestId('channel-more-menu'));
    await user.click(await screen.findByRole('menuitem', { name: '全库设为隐藏' }));
    await user.click(await screen.findByTestId('all-visibility-confirm-btn'));

    await waitFor(() => {
      const call = fetchCalls.find(
        (c) =>
          c.method === 'POST' &&
          c.path === '/api/settings/catalog/media/batch-visibility' &&
          (c.body as { all?: boolean })?.all === true,
      );
      expect(call).toBeDefined();
      expect(call?.body).toStrictEqual({
        all: true,
        visible: false,
      });
    });
  });

  it('ChannelEditModal 整合弹窗: 支持修改名称、Tab 切换至 EPG 匹配、选定候选锁定绑定', async () => {
    const user = userEvent.setup();
    const handleSaved = vi.fn();
    const handleClose = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <ChannelEditModal
          isOpen={true}
          channel={mockChannels[0]!}
          epgSources={mockEpgSources}
          onSaved={handleSaved}
          onClose={handleClose}
        />
      </QueryClientProvider>,
    );

    // 默认处于“基本资料与台标”标签
    expect(screen.getByTestId('channel-edit-title-input')).toHaveValue('CCTV-1 综合');

    // 切换到“EPG 节目单匹配”标签
    const epgTab = screen.getByRole('tab', { name: /EPG 节目单匹配/ });
    await user.click(epgTab);

    // 校验候选列表加载
    await waitFor(() => {
      expect(screen.getByTestId('epg-candidate-cctv1')).toBeInTheDocument();
      expect(screen.getByTestId('epg-candidate-cctv1-hd')).toBeInTheDocument();
    });

    // 点击选定候选进行手动绑定锁定
    const bindCandidateBtn = screen.getByTestId('epg-candidate-cctv1-hd');
    await user.click(bindCandidateBtn);

    await waitFor(() => {
      const putCall = fetchCalls.find(
        (c) => c.method === 'PUT' && c.path === '/api/settings/catalog/media/ch-1/epg-binding',
      );
      expect(putCall).toBeDefined();
      expect(putCall?.body).toStrictEqual({
        expectedVersion: 1,
        mode: 'manual',
        epgSourceId: 'src-1',
        xmltvChannelId: 'cctv1-hd',
        expectedEpgGeneration: 3,
      });
      expect(handleSaved).toHaveBeenCalled();
    });
  });

  it('ChannelEditModal 直播源线路: 支持查看线路、修改 URL、设为主线路与新增线路', async () => {
    const user = userEvent.setup();
    const handleSaved = vi.fn();
    const handleClose = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <ChannelEditModal
          isOpen={true}
          channel={mockChannels[0]!}
          epgSources={mockEpgSources}
          onSaved={handleSaved}
          onClose={handleClose}
          initialTab="streams"
        />
      </QueryClientProvider>,
    );

    // 等待线路加载完成并展示
    await waitFor(() => {
      expect(screen.getByTestId('stream-row-st-1')).toBeInTheDocument();
      expect(screen.getByTestId('stream-row-st-2')).toBeInTheDocument();
    });

    // 验证线路 1 为首选主线路（包含首选标识），线路 2 为备用线路（包含设为主线路按钮）
    expect(screen.getByTestId('set-primary-stream-st-2')).toBeInTheDocument();
    expect(screen.queryByTestId('set-primary-stream-st-1')).toBeNull();

    // 1. 修改线路 1 的 URL 并点击保存
    const streamInput1 = screen.getByTestId('stream-input-st-1').querySelector('input') ?? screen.getByTestId('stream-input-st-1');
    await user.clear(streamInput1);
    await user.type(streamInput1, 'http://example.com/cctv1-edited.m3u8');

    const saveBtn1 = screen.getByTestId('save-stream-st-1');
    expect(saveBtn1).toBeEnabled();
    await user.click(saveBtn1);

    await waitFor(() => {
      const patchCall = fetchCalls.find(
        (c) => c.method === 'PATCH' && c.path === '/api/settings/catalog/media/ch-1/streams/st-1',
      );
      expect(patchCall).toBeDefined();
      expect(patchCall?.body).toStrictEqual({
        location: 'http://example.com/cctv1-edited.m3u8',
      });
      expect(handleSaved).toHaveBeenCalled();
    });

    // 2. 点击将线路 2 设为主线路
    const setPrimaryBtn2 = screen.getByTestId('set-primary-stream-st-2');
    await user.click(setPrimaryBtn2);

    await waitFor(() => {
      const patchPriorityCall = fetchCalls.find(
        (c) =>
          c.method === 'PATCH' &&
          c.path === '/api/settings/catalog/media/ch-1/streams/st-2' &&
          typeof (c.body as { priority?: number })?.priority === 'number',
      );
      expect(patchPriorityCall).toBeDefined();
    });

    // 3. 新增一条直播源线路
    const newStreamInput = screen.getByTestId('add-stream-input').querySelector('input') ?? screen.getByTestId('add-stream-input');
    await user.type(newStreamInput, 'https://newstream.com/live.m3u8');

    const addStreamBtn = screen.getByTestId('add-stream-btn');
    await user.click(addStreamBtn);

    await waitFor(() => {
      const postCall = fetchCalls.find(
        (c) => c.method === 'POST' && c.path === '/api/settings/catalog/media/ch-1/streams',
      );
      expect(postCall).toBeDefined();
      expect(postCall?.body).toStrictEqual({
        location: 'https://newstream.com/live.m3u8',
      });
    });
  });

  it('SettingsIptvPage: 直播源列表不展示冗余的「查看内容」按钮', async () => {
    render(
      <MemoryRouter initialEntries={['/settings/iptv']}>
        <QueryClientProvider client={queryClient}>
          <SettingsAccessProvider>
            <Routes>
              <Route path="/settings/iptv" element={<SettingsIptvPage />} />
            </Routes>
          </SettingsAccessProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    // 等待来源卡片渲染
    await waitFor(() => {
      expect(screen.getByText('国内电视台直播源')).toBeInTheDocument();
    });

    // 来源卡片中应包含「手动导入」
    expect(screen.getByTestId('source-import-src-iptv-1')).toBeInTheDocument();

    // 但绝不应包含「查看内容」按钮
    expect(screen.queryByTestId('source-view-src-iptv-1')).toBeNull();
    expect(screen.queryByText('查看内容')).toBeNull();
  });
});
