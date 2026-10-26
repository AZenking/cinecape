import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as fetchModule from '../src/shared/fetch';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { VodCatalogPage } from '../src/features/catalog/VodCatalogPage';
import type { PublicMediaPageDto } from '@hmp/shared';

/**
 * T019(US1 前端单测):基础点播目录的 URL 状态与三态区分。
 * 对照 docs/specs/005-pc-browsing-flow/contracts/ui.md §1 与 spec.md US1 场景4/5:
 * - q/type/page 写入 URL 查询参数(FR-045);从详情返回(同 URL 重进)恢复原搜索、
 *   筛选与页码且不重置回第一页;
 * - 加载中、成功空结果(暂无内容/无匹配)与失败可重试三态互不混淆(FR-004);
 * - 公共数据请求经 publicFetch(credentials:'omit')发出(底座已测,这里断言调用形态)。
 *
 * fetch 以 vi.mock 替换 publicFetch(其余导出保留真实实现,FetchApiError 可实例化);
 * 路由用 MemoryRouter + 地址探针组件断言 URL 查询参数。
 */

const publicFetchMock = vi.fn();

vi.mock('../src/shared/fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof fetchModule>();
  return {
    ...actual,
    publicFetch: (...args: Parameters<typeof actual.publicFetch>) => publicFetchMock(...args),
  };
});

function mediaPage(overrides: Partial<PublicMediaPageDto> = {}): PublicMediaPageDto {
  return {
    items: [
      {
        id: 'm-1',
        type: 'movie',
        title: 'Alpha 动作18',
        description: null,
        posterRef: null,
        contentLevel: 18,
        availability: 'available',
      },
      {
        id: 'm-2',
        type: 'channel',
        title: 'Zeta 少儿台',
        description: null,
        posterRef: null,
        contentLevel: 0,
        availability: 'available',
      },
    ],
    page: 1,
    pageSize: 20,
    total: 2,
    ...overrides,
  };
}

/** 地址探针:渲染当前 pathname+search,供 URL 状态断言 */
function LocationProbe(): React.ReactElement {
  const location = useLocation();
  return (
    <span data-testid="location">
      {location.pathname}
      {location.search}
    </span>
  );
}

function renderCatalogAt(initialUrl: string): void {
  render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <Routes>
        <Route path="/vod" element={<VodCatalogPage />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

/** 取第 n 次 publicFetch 调用的请求形态 */
function fetchCallOf(index: number): { path: string; query: Record<string, unknown> } {
  expect(publicFetchMock.mock.calls.length).toBeGreaterThan(index);
  const [path, init] = publicFetchMock.mock.calls[index] as [string, { query?: Record<string, unknown> }];
  return { path, query: init?.query ?? {} };
}

beforeEach(() => {
  publicFetchMock.mockReset();
  publicFetchMock.mockResolvedValue(mediaPage());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('VodCatalogPage:q/type/page 写入 URL 查询参数(FR-045)', () => {
  it('初始加载:以默认条件(page=1,无 q/type)请求公共目录,成功后渲染条目', async () => {
    renderCatalogAt('/vod');

    // 请求形态:公共端点 + 默认页
    await waitFor(() => expect(publicFetchMock).toHaveBeenCalled());
    expect(fetchCallOf(0)).toMatchObject({ path: '/public/media', query: { page: 1 } });

    // 成功态:条目标题可见,链接指向 /media/:id
    expect(await screen.findByRole('link', { name: /Alpha 动作18/ })).toHaveAttribute('href', '/media/m-1');
    expect(screen.getByRole('link', { name: /Zeta 少儿台/ })).toBeInTheDocument();

    // 三态互斥:成功后无加载中与错误提示
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('提交搜索:q 写入 URL 且翻回第一页,并以新 q 重新请求', async () => {
    const user = userEvent.setup();
    renderCatalogAt('/vod');
    await screen.findByRole('link', { name: /Alpha 动作18/ });

    const searchBox = screen.getByRole('textbox', { name: '搜索点播' });
    await user.clear(searchBox);
    await user.type(searchBox, 'alpha');
    await user.click(screen.getByRole('button', { name: '搜索' }));

    // URL 写入 q,page 重置(未带 page 键 = 第一页)
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/vod?q=alpha'));
    expect(screen.getByTestId('location').textContent).not.toContain('page=');

    // 以新条件重新请求
    await waitFor(() => expect(publicFetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(fetchCallOf(publicFetchMock.mock.calls.length - 1)).toMatchObject({
      path: '/public/media',
      query: { q: 'alpha', page: 1 },
    });
  });

  it('类型筛选:type 写入 URL,并以新 type 重新请求', async () => {
    const user = userEvent.setup();
    renderCatalogAt('/vod');
    await screen.findByRole('link', { name: /Alpha 动作18/ });

    await user.click(screen.getByRole('button', { name: '影片' }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('type=movie'));
    await waitFor(() => expect(publicFetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(fetchCallOf(publicFetchMock.mock.calls.length - 1)).toMatchObject({
      query: { type: 'movie', page: 1 },
    });
  });

  it('翻页:page 写入 URL,并以新页码重新请求', async () => {
    publicFetchMock.mockResolvedValue(
      mediaPage({
        total: 45,
        pageSize: 20,
        items: Array.from({ length: 20 }, (_, i) => ({
          id: `m-${i + 1}`,
          type: 'movie' as const,
          title: `批量影片 ${i + 1}`,
          description: null,
          posterRef: null,
          contentLevel: 3,
          availability: 'available' as const,
        })),
      }),
    );
    const user = userEvent.setup();
    renderCatalogAt('/vod');
    await screen.findByText('批量影片 1');

    await user.click(screen.getByRole('button', { name: '下一页' }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('page=2'));
    await waitFor(() => expect(publicFetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(fetchCallOf(publicFetchMock.mock.calls.length - 1)).toMatchObject({
      query: { page: 2 },
    });
  });
});

describe('VodCatalogPage:详情返回恢复原条件与页码(FR-045)', () => {
  it('带 q/type/page 直接打开(等价详情返回):请求不重置回第一页,输入回显', async () => {
    renderCatalogAt('/vod?q=alpha&type=movie&page=2');

    await waitFor(() => expect(publicFetchMock).toHaveBeenCalled());
    expect(fetchCallOf(0)).toMatchObject({
      path: '/public/media',
      query: { q: 'alpha', type: 'movie', page: 2 },
    });

    // URL 保持原状(未重写),输入框回显原搜索词
    expect(screen.getByTestId('location')).toHaveTextContent('/vod?q=alpha&type=movie&page=2');
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: '搜索点播' })).toHaveValue('alpha');
    });
  });
});

describe('VodCatalogPage:加载中/成功空结果/失败可重试三态互不混淆(FR-004)', () => {
  it('加载中:呈现 status 提示,不出现空态/错误文案', async () => {
    publicFetchMock.mockReturnValue(new Promise(() => undefined)); // 永不落定
    renderCatalogAt('/vod');

    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('暂无内容')).not.toBeInTheDocument();
    expect(screen.queryByText('无匹配结果')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('成功空结果(无筛选):显示「暂无内容」,不显示错误', async () => {
    publicFetchMock.mockResolvedValue(mediaPage({ items: [], total: 0 }));
    renderCatalogAt('/vod');

    expect(await screen.findByText('暂无内容')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('成功空结果(带筛选):显示「无匹配结果」而非「暂无内容」', async () => {
    publicFetchMock.mockResolvedValue(mediaPage({ items: [], total: 0 }));
    renderCatalogAt('/vod?q=不存在的词');

    expect(await screen.findByText('无匹配结果')).toBeInTheDocument();
    expect(screen.queryByText('暂无内容')).not.toBeInTheDocument();
  });

  it('失败可重试:alert + 重试按钮,错误不只靠颜色;重试以原条件重新请求', async () => {
    publicFetchMock.mockRejectedValueOnce(new Error('网络中断'));
    const user = userEvent.setup();
    renderCatalogAt('/vod?page=3');

    const alert = await screen.findByRole('alert');
    // 错误不只靠颜色:有明确文案与重试按钮
    expect(within(alert).getByText('目录加载失败')).toBeInTheDocument();
    expect(within(alert).getByText('网络中断')).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: '重试' })).toBeInTheDocument();

    // 重试:以同一 URL 条件重新请求(page=3 不丢失)
    publicFetchMock.mockResolvedValue(mediaPage({ page: 3 }));
    await user.click(within(alert).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(publicFetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(fetchCallOf(publicFetchMock.mock.calls.length - 1)).toMatchObject({
      query: { page: 3 },
    });
    expect(await screen.findByRole('link', { name: /Alpha 动作18/ })).toBeInTheDocument();
  });

  it('公共目录请求经 publicFetch(credentials omit 底座)发起,路径为 /public/media', async () => {
    renderCatalogAt('/vod');
    await waitFor(() => expect(publicFetchMock).toHaveBeenCalled());
    const [path, init] = publicFetchMock.mock.calls[0] as [string, unknown];
    expect(path).toBe('/public/media');
    expect(init).toBeDefined();
  });
});
