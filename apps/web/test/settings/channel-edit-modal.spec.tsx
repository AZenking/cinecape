import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChannelEditModal } from '../../src/features/settings/components/ChannelEditModal';
import type { CandidateDto } from '../../src/features/settings/shared/settings-api';

/**
 * T015 (018 US2): 频道编辑弹窗名称修改与表单提交测试。
 * 验证:
 * 1. 弹窗打开时正确加载频道的初始名称与版本;
 * 2. 修改频道名称并点击保存，发送正确的 PATCH 请求 (expectedVersion, title);
 * 3. 保存成功后触发 onSaved 与 onClose 回调;
 * 4. 频道名称为空时校验拦截，不触发保存请求;
 * 5. 点击取消按钮直接关闭弹窗，不发起网络变更。
 */

interface FetchCall {
  method: string;
  path: string;
  body: unknown;
}

let fetchCalls: FetchCall[] = [];
let queryClient: QueryClient;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

function installFetchRouter(patchStatus = 200): void {
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

      if (path.startsWith('/api/settings/catalog/media/') && method === 'PATCH') {
        if (patchStatus === 409) {
          return jsonResponse(
            { code: 'MEDIA_VERSION_CONFLICT', message: '媒体已被其他操作修改' },
            409,
          );
        }
        return jsonResponse({
          id: 'cctv-1',
          type: 'channel',
          title: (body as { title?: string })?.title ?? 'CCTV-1',
          version: 2,
          visible: true,
        });
      }

      return jsonResponse({});
    }),
  );
}

const sampleChannel: CandidateDto = {
  id: 'cctv-1',
  type: 'channel',
  title: 'CCTV-1 综合',
  description: null,
  contentLevel: null,
  poster: null,
  version: 1,
  available: true,
  visible: true,
  logoUrl: null,
  lineCount: 2,
};

describe('018 US2 频道编辑弹窗 (ChannelEditModal) 重命名组件测试', () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    installFetchRouter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('初始渲染: 正确显示频道初始名称', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <ChannelEditModal
          isOpen={true}
          channel={sampleChannel}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />
      </QueryClientProvider>,
    );

    const titleInput = await screen.findByTestId('channel-edit-title-input');
    expect(titleInput).toBeInTheDocument();
    expect(titleInput).toHaveValue('CCTV-1 综合');
  });

  it('修改频道名称并保存: 正确发送 PATCH 请求并调用回调', async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();
    const handleSaved = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <ChannelEditModal
          isOpen={true}
          channel={sampleChannel}
          onClose={handleClose}
          onSaved={handleSaved}
        />
      </QueryClientProvider>,
    );

    const titleInput = await screen.findByTestId('channel-edit-title-input');
    await user.clear(titleInput);
    await user.type(titleInput, '我的央视一套');

    const saveBtn = screen.getByTestId('channel-edit-save-btn');
    await user.click(saveBtn);

    await waitFor(() => {
      const patchCall = fetchCalls.find(
        (c) => c.method === 'PATCH' && c.path === '/api/settings/catalog/media/cctv-1',
      );
      expect(patchCall).toBeDefined();
      expect(patchCall?.body).toStrictEqual({
        expectedVersion: 1,
        title: '我的央视一套',
        logoUrl: null,
      });
      expect(handleSaved).toHaveBeenCalledTimes(1);
      expect(handleClose).toHaveBeenCalledTimes(1);
    });
  });

  it('名称为空校验: 清空名称后点击保存被拦截，不发起网络请求', async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();
    const handleSaved = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <ChannelEditModal
          isOpen={true}
          channel={sampleChannel}
          onClose={handleClose}
          onSaved={handleSaved}
        />
      </QueryClientProvider>,
    );

    const titleInput = await screen.findByTestId('channel-edit-title-input');
    await user.clear(titleInput);

    const saveBtn = screen.getByTestId('channel-edit-save-btn');
    await user.click(saveBtn);

    // 等待异步处理完成，验证没有发起 PATCH 请求
    await new Promise((resolve) => setTimeout(resolve, 100));
    const patchCall = fetchCalls.find(
      (c) => c.method === 'PATCH' && c.path === '/api/settings/catalog/media/cctv-1',
    );
    expect(patchCall).toBeUndefined();
    expect(handleSaved).not.toHaveBeenCalled();
    expect(handleClose).not.toHaveBeenCalled();
  });

  it('点击取消按钮: 直接关闭弹窗，不调用 onSaved 且不发送 PATCH', async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();
    const handleSaved = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <ChannelEditModal
          isOpen={true}
          channel={sampleChannel}
          onClose={handleClose}
          onSaved={handleSaved}
        />
      </QueryClientProvider>,
    );

    const cancelBtn = await screen.findByTestId('channel-edit-cancel-btn');
    await user.click(cancelBtn);

    expect(handleClose).toHaveBeenCalledTimes(1);
    expect(handleSaved).not.toHaveBeenCalled();
    expect(fetchCalls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });
});
