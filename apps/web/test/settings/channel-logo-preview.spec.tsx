import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChannelEditModal } from '../../src/features/settings/components/ChannelEditModal';
import type { CandidateDto } from '../../src/features/settings/shared/settings-api';

/**
 * T020 (018 US3): 频道编辑弹窗台标 Logo 实时预览与回退组件测试。
 * 验证:
 * 1. 初始无 Logo 时显示 <Tv /> 图标占位回退;
 * 2. 初始有 Logo 时正确呈现 <img> 图片预览;
 * 3. 用户在输入框中输入新的图片 URL，即时呈现图片预览;
 * 4. 图片加载失败 (onError) 时，自动回退到 <Tv /> 图标，无破碎裂图;
 * 5. 用户重新修改 URL 后，错误状态重置并尝试加载新图;
 * 6. 保存带有自定义 Logo 的频道信息，发送包含 logoUrl 的 PATCH 请求;
 * 7. 清空 Logo 输入后保存，发送 logoUrl: null 的 PATCH 请求。
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

      if (path.startsWith('/api/settings/catalog/media/') && method === 'PATCH') {
        return jsonResponse({
          id: 'cctv-1',
          type: 'channel',
          title: (body as { title?: string })?.title ?? 'CCTV-1',
          version: 2,
          visible: true,
          posterRef: '0123456789abcdef0123456789abcdef',
        });
      }

      return jsonResponse({});
    }),
  );
}

const channelWithoutLogo: CandidateDto = {
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
  lineCount: 1,
};

const channelWithLogo: CandidateDto = {
  id: 'cctv-2',
  type: 'channel',
  title: 'CCTV-2 财经',
  description: null,
  contentLevel: null,
  poster: null,
  version: 1,
  available: true,
  visible: true,
  logoUrl: 'https://example.com/cctv2.png',
  lineCount: 1,
};

describe('018 US3 频道台标实时预览与回退 (ChannelEditModal) 测试', () => {
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

  it('初始无台标时: 呈现 <Tv /> 回退图标，不渲染 img 标签', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <ChannelEditModal
          isOpen={true}
          channel={channelWithoutLogo}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('channel-logo-preview-fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('channel-logo-preview-img')).not.toBeInTheDocument();
  });

  it('初始有台标时: 呈现 <img> 预览且 src 正确', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <ChannelEditModal
          isOpen={true}
          channel={channelWithLogo}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />
      </QueryClientProvider>,
    );

    const img = screen.getByTestId('channel-logo-preview-img');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'https://example.com/cctv2.png');
    expect(screen.queryByTestId('channel-logo-preview-fallback')).not.toBeInTheDocument();
  });

  it('输入新的台标 URL: 即时更新图片预览', async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <ChannelEditModal
          isOpen={true}
          channel={channelWithoutLogo}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />
      </QueryClientProvider>,
    );

    const logoInput = screen.getByTestId('channel-edit-logo-input');
    await user.type(logoInput, 'https://cdn.example/my-channel.png');

    const img = screen.getByTestId('channel-logo-preview-img');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'https://cdn.example/my-channel.png');
    expect(screen.queryByTestId('channel-logo-preview-fallback')).not.toBeInTheDocument();
  });

  it('图片加载失败时: 自动回退到 <Tv /> 占位图标，修改输入后恢复尝试', async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <ChannelEditModal
          isOpen={true}
          channel={channelWithLogo}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />
      </QueryClientProvider>,
    );

    const img = screen.getByTestId('channel-logo-preview-img');
    expect(img).toBeInTheDocument();

    // 触发图片加载失败事件
    fireEvent.error(img);

    // 错误后应回退为 fallback 占位
    expect(screen.getByTestId('channel-logo-preview-fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('channel-logo-preview-img')).not.toBeInTheDocument();

    // 用户在输入框中输入新字符，重置错误状态并重新尝试加载图片
    const logoInput = screen.getByTestId('channel-edit-logo-input');
    await user.type(logoInput, '?v=2');

    const newImg = screen.getByTestId('channel-logo-preview-img');
    expect(newImg).toBeInTheDocument();
    expect(newImg).toHaveAttribute('src', 'https://example.com/cctv2.png?v=2');
  });

  it('提交带有自定义 Logo 的表单: 发送完整 PATCH 请求', async () => {
    const user = userEvent.setup();
    const handleSaved = vi.fn();
    const handleClose = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <ChannelEditModal
          isOpen={true}
          channel={channelWithoutLogo}
          onClose={handleClose}
          onSaved={handleSaved}
        />
      </QueryClientProvider>,
    );

    const logoInput = screen.getByTestId('channel-edit-logo-input');
    await user.type(logoInput, 'https://cdn.example/custom-cctv1.png');

    const saveBtn = screen.getByTestId('channel-edit-save-btn');
    await user.click(saveBtn);

    await waitFor(() => {
      const patchCall = fetchCalls.find(
        (c) => c.method === 'PATCH' && c.path === '/api/settings/catalog/media/cctv-1',
      );
      expect(patchCall).toBeDefined();
      expect(patchCall?.body).toStrictEqual({
        expectedVersion: 1,
        title: 'CCTV-1 综合',
        logoUrl: 'https://cdn.example/custom-cctv1.png',
      });
      expect(handleSaved).toHaveBeenCalledTimes(1);
      expect(handleClose).toHaveBeenCalledTimes(1);
    });
  });

  it('清空 Logo 并保存: 发送 logoUrl: null 的 PATCH 请求', async () => {
    const user = userEvent.setup();
    const handleSaved = vi.fn();
    const handleClose = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <ChannelEditModal
          isOpen={true}
          channel={channelWithLogo}
          onClose={handleClose}
          onSaved={handleSaved}
        />
      </QueryClientProvider>,
    );

    const logoInput = screen.getByTestId('channel-edit-logo-input');
    await user.clear(logoInput);

    const saveBtn = screen.getByTestId('channel-edit-save-btn');
    await user.click(saveBtn);

    await waitFor(() => {
      const patchCall = fetchCalls.find(
        (c) => c.method === 'PATCH' && c.path === '/api/settings/catalog/media/cctv-2',
      );
      expect(patchCall).toBeDefined();
      expect(patchCall?.body).toStrictEqual({
        expectedVersion: 1,
        title: 'CCTV-2 财经',
        logoUrl: null,
      });
      expect(handleSaved).toHaveBeenCalledTimes(1);
      expect(handleClose).toHaveBeenCalledTimes(1);
    });
  });
});
