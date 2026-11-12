import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelPageDto } from '@hmp/shared';
import {
  useRelatedLiveChannels,
  RELATED_LIVE_CHANNELS_PAGE_SIZE,
} from '../../../src/features/live/hooks/use-related-live-channels';
import {
  createQueryWrapper,
  createTestQueryClient,
  mockFetchSequence,
  type MockFetchSequence,
} from '../../helpers/query-test-utils';

/**
 * useRelatedLiveChannels 单测(T003;015 api-reuse.md「同类直播推荐 (Screen 4)」行):
 * - 请求形态:`section=group` + `groupKey` + 整组 pageSize(服务端上限 50),复用
 *   fetchLiveChannels/publicFetch,不新造请求通道;
 * - 前端过滤排除当前 activeChannelId(精确比较 media id)且保持服务端顺序;
 * - activeChannelId 换台仅本地过滤,不重发请求(排除项不进入缓存键);
 * - groupKey 缺省:零请求,空数组 ready 态。
 */

type ChannelRow = ChannelPageDto['items'][number];

function channelRow(id: string, title: string): ChannelRow {
  return {
    media: {
      id,
      type: 'channel',
      title,
      description: null,
      posterRef: null,
      contentLevel: null,
      availability: 'available',
    },
    groupKey: 'grp-news',
    groupLabel: '新闻',
    current: null,
    next: null,
  };
}

/** 三频道分组页(fixture:ch-a/ch-b/ch-c,服务端顺序即数组顺序) */
function groupPage(): ChannelPageDto {
  return {
    items: [channelRow('ch-a', '新闻一'), channelRow('ch-b', '新闻二'), channelRow('ch-c', '新闻三')],
    page: 1,
    pageSize: RELATED_LIVE_CHANNELS_PAGE_SIZE,
    total: 3,
    now: '2026-11-08T12:05:00.000Z',
    timezone: 'America/New_York',
    catalogRevision: 3,
  };
}

interface HarnessOptions {
  readonly groupKey: string | undefined;
  readonly activeChannelId: string | null;
}

/** 挂载 hook(每例独立内存 client;retry:false 保证失败态确定性) */
function mountRelatedChannels(initial: HarnessOptions) {
  const client = createTestQueryClient();
  return renderHook(({ options }: { options: HarnessOptions }) => useRelatedLiveChannels(options), {
    initialProps: { options: initial },
    wrapper: createQueryWrapper(client),
  });
}

afterEach(() => {
  // 恢复被 vi.spyOn 打桩的 global fetch,避免泄漏到后续用例
  vi.restoreAllMocks();
});

describe('useRelatedLiveChannels(T003 同类直播推荐)', () => {
  it('请求形态为 section=group + groupKey;前端排除 activeChannelId 且保持服务端顺序', async () => {
    const fetchMock: MockFetchSequence = mockFetchSequence([{ json: groupPage() }]);
    const { result } = mountRelatedChannels({ groupKey: 'grp-news', activeChannelId: 'ch-b' });

    await waitFor(() => expect(result.current.data).not.toBeNull());
    // 契约请求形态:既有公共端点 + Screen 4 行参数(pageSize 取服务端上限,整组一次取齐)
    expect(fetchMock.calls).toHaveLength(1);
    expect(fetchMock.calls[0]?.url).toBe(
      '/api/public/live/channels?section=group&groupKey=grp-news&page=1&pageSize=50',
    );
    expect(fetchMock.calls[0]?.init.method).toBe('GET');

    // 排除当前频道(ch-b),其余保持服务端顺序(不重排)
    expect(result.current.data?.map((row) => row.media.id)).toEqual(['ch-a', 'ch-c']);
    expect(result.current.status).toBe('ready');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('groupKey 缺省:不发请求,返回空数组 ready 态(retry 亦零请求)', async () => {
    // 空剧本:任何意外 fetch 都会以显式错误拒绝(暴露实现的意外请求)
    const fetchMock: MockFetchSequence = mockFetchSequence([]);
    const { result } = mountRelatedChannels({ groupKey: undefined, activeChannelId: 'ch-b' });

    // 泵送任务队列后仍无请求,且资源为 ready 空数组
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetchMock.calls).toHaveLength(0);
    expect(result.current.data).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    result.current.retry();
    expect(fetchMock.calls).toHaveLength(0);
  });

  it('activeChannelId 为 null 不过滤任何频道;换台仅本地过滤,不重发请求', async () => {
    const fetchMock: MockFetchSequence = mockFetchSequence([{ json: groupPage() }]);
    const { result, rerender } = mountRelatedChannels({
      groupKey: 'grp-news',
      activeChannelId: null,
    });

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data?.map((row) => row.media.id)).toEqual(['ch-a', 'ch-b', 'ch-c']);

    // 换台(ch-b 成为当前频道):排除项不进入缓存键 → 恰好仍为一次 fetch
    rerender({ options: { groupKey: 'grp-news', activeChannelId: 'ch-b' } });
    await waitFor(() =>
      expect(result.current.data?.map((row) => row.media.id)).toEqual(['ch-a', 'ch-c']),
    );
    expect(fetchMock.calls).toHaveLength(1);
  });
});
