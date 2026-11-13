import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '@platform/config/env.schema';
import { setEnvOverride } from '@platform/config/env';
import { createTmdbClient, TmdbError } from '@contexts/epg/infrastructure/tmdb.client';

function useEnv(extra: Record<string, string> = {}): void {
  setEnvOverride(loadEnv({ NODE_ENV: 'test', ...extra }));
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

afterEach(() => {
  setEnvOverride(null);
});

describe('020 · TMDB 客户端', () => {
  it('无 Key 时禁用，不调用 fetch', async () => {
    useEnv();
    const fetchImpl = vi.fn();
    const client = createTmdbClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(client.isEnabled()).toBe(false);
    await expect(client.searchMulti({ query: '沙丘', language: 'zh-CN', region: 'CN' })).rejects.toMatchObject({
      kind: 'disabled',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('v3 Key：请求 search/multi，参数完整，映射 movie/tv 候选', async () => {
    useEnv({ TMDB_API_KEY: 'test-key' });
    const fetchImpl = vi.fn(
      async () =>
        jsonResponse({
          results: [
            {
              id: 1,
              media_type: 'movie',
              title: '沙丘',
              original_title: 'Dune',
              poster_path: '/a.jpg',
              release_date: '2021-09-15',
              vote_average: 7.8,
              popularity: 100,
              adult: false,
            },
            {
              id: 2,
              media_type: 'tv',
              name: '沙丘剧集',
              original_name: 'Dune Series',
              poster_path: '/b.jpg',
              first_air_date: '2024-01-01',
              vote_average: 6.5,
              popularity: 20,
              adult: false,
            },
            { id: 3, media_type: 'person', name: '某人' },
          ],
        }),
    );
    const client = createTmdbClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const candidates = await client.searchMulti({ query: '沙丘', language: 'zh-CN', region: 'CN' });

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ id: 1, mediaType: 'movie', title: '沙丘', posterPath: '/a.jpg' });
    expect(candidates[1]).toMatchObject({ id: 2, mediaType: 'tv', title: '沙丘剧集' });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/3/search/multi');
    expect(parsed.searchParams.get('query')).toBe('沙丘');
    expect(parsed.searchParams.get('language')).toBe('zh-CN');
    expect(parsed.searchParams.get('region')).toBe('CN');
    expect(parsed.searchParams.get('include_adult')).toBe('false');
    expect(parsed.searchParams.get('page')).toBe('1');
    expect(parsed.searchParams.get('api_key')).toBe('test-key');
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('v4 Token：Authorization Bearer，且不发送 api_key', async () => {
    useEnv({ TMDB_READ_ACCESS_TOKEN: 'v4-token' });
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }));
    const client = createTmdbClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.searchMulti({ query: 'Dune', language: 'en-US', region: 'US' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).searchParams.get('api_key')).toBeNull();
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer v4-token');
  });

  it('401：熔断 60 分钟，第二次不再发请求', async () => {
    useEnv({ TMDB_API_KEY: 'bad-key' });
    const fetchImpl = vi.fn(async () => jsonResponse({ status_message: 'Invalid API key' }, 401));
    const client = createTmdbClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.searchMulti({ query: '沙丘', language: 'zh-CN', region: 'CN' })).rejects.toMatchObject({
      kind: 'auth',
    });
    await expect(client.searchMulti({ query: '沙丘', language: 'zh-CN', region: 'CN' })).rejects.toMatchObject({
      kind: 'circuit_open',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('429：按 Retry-After 重试，最多 2 次后抛 rate_limit', async () => {
    useEnv({ TMDB_API_KEY: 'test-key' });
    const fetchImpl = vi.fn(async () => jsonResponse({ status_message: 'rate limited' }, 429, { 'retry-after': '0' }));
    const sleeps: number[] = [];
    const client = createTmdbClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(client.searchMulti({ query: '沙丘', language: 'zh-CN', region: 'CN' })).rejects.toBeInstanceOf(
      TmdbError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([0, 0]);
  });

  it('5xx：重试后失败；非法 JSON 归为 json 错误', async () => {
    useEnv({ TMDB_API_KEY: 'test-key' });
    const fiveHundred = vi.fn(async () => jsonResponse({}, 500));
    const client500 = createTmdbClient({ fetchImpl: fiveHundred as unknown as typeof fetch, sleep: async () => undefined });
    await expect(
      client500.searchMulti({ query: '沙丘', language: 'zh-CN', region: 'CN' }),
    ).rejects.toMatchObject({ kind: 'http' });
    expect(fiveHundred).toHaveBeenCalledTimes(3);

    const badJson = vi.fn(
      async () =>
        new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const clientJson = createTmdbClient({ fetchImpl: badJson as unknown as typeof fetch, sleep: async () => undefined });
    await expect(
      clientJson.searchMulti({ query: '沙丘', language: 'zh-CN', region: 'CN' }),
    ).rejects.toMatchObject({ kind: 'json' });
  });

  it('超时：不重试到无限；3 次后抛 timeout', async () => {
    useEnv({ TMDB_API_KEY: 'test-key' });
    const timeout = vi.fn(async () => {
      const error = new Error('timeout');
      error.name = 'TimeoutError';
      throw error;
    });
    const client = createTmdbClient({ fetchImpl: timeout as unknown as typeof fetch, sleep: async () => undefined });
    await expect(
      client.searchMulti({ query: '沙丘', language: 'zh-CN', region: 'CN' }),
    ).rejects.toMatchObject({ kind: 'timeout' });
    expect(timeout).toHaveBeenCalledTimes(3);
  });

  it('配置为 0 次上限时禁用（只读缓存模式）', () => {
    useEnv({ TMDB_API_KEY: 'test-key', TMDB_MAX_LOOKUPS_PER_RUN: '0' });
    const client = createTmdbClient({ fetchImpl: vi.fn() as unknown as typeof fetch });
    expect(client.isEnabled()).toBe(false);
  });
});