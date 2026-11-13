import { describe, expect, it, vi } from 'vitest';
import {
  createProgrammePosterProxyService,
  isWellFormedProgrammePosterRef,
} from '@contexts/epg/application/programme-poster-proxy.service';
import type { ProgrammePosterRow } from '@contexts/epg/application/epg-store.port';

const NOW = Date.UTC(2026, 10, 13, 4, 0, 0);
const VALID_REF = '0123456789abcdef0123456789abcdef';

function row(overrides: Partial<ProgrammePosterRow> = {}): ProgrammePosterRow {
  return {
    householdId: 'h1',
    matchKey: '沙丘',
    ref: VALID_REF,
    state: 'matched',
    tmdbId: 438631,
    mediaType: 'movie',
    title: '沙丘',
    originalTitle: 'Dune',
    posterPath: '/a.jpg',
    releaseDate: '2021-09-15',
    voteAverage: 7.8,
    popularity: 100,
    matchScore: 120,
    yearHint: 2021,
    attempts: 1,
    lastAttemptAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 24 * 60 * 60_000).toISOString(),
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function proxy(
  resolved: ProgrammePosterRow | undefined,
  read: (request: { url: string }) => Promise<{
    bytes: Buffer;
    contentType: string | null;
    contentEncoding: string | null;
    finalUrl: string;
    redirectsFollowed: number;
  }>,
) {
  return createProgrammePosterProxyService({
    resolveByRef: () => resolved,
    safeUpstream: { read },
    imageBaseUrl: 'https://image.tmdb.org/t/p/w342',
    allowedTargets: [{ kind: 'host', host: 'image.tmdb.org' }],
    nowMs: () => NOW,
  });
}

describe('020 · 节目海报代理', () => {
  it('ref 形态：32 位小写 hex', () => {
    expect(isWellFormedProgrammePosterRef(VALID_REF)).toBe(true);
    expect(isWellFormedProgrammePosterRef('A'.repeat(32))).toBe(false);
    expect(isWellFormedProgrammePosterRef('a'.repeat(31))).toBe(false);
    expect(isWellFormedProgrammePosterRef('../a')).toBe(false);
  });

  it('有效 matched/未过期 → 读取图片基址并原样返回', async () => {
    const read = vi.fn(async () => ({
      bytes: Buffer.from([1, 2, 3]),
      contentType: 'image/jpeg',
      contentEncoding: null,
      finalUrl: 'https://image.tmdb.org/t/p/w342/a.jpg',
      redirectsFollowed: 0,
    }));
    const service = proxy(row(), read);
    const content = await service.fetch({ householdId: 'h1', posterRef: VALID_REF });
    expect(content.contentType).toBe('image/jpeg');
    expect(content.bytes).toEqual(Buffer.from([1, 2, 3]));
    expect(read).toHaveBeenCalledTimes(1);
    expect((read.mock.calls[0] as unknown as [{ url: string }])[0].url).toBe(
      'https://image.tmdb.org/t/p/w342/a.jpg',
    );
  });

  it('伪造/跨家庭/过期/非 matched/非法路径 → 404 同形，不读上游', async () => {
    const read = vi.fn();
    await expect(
      proxy(undefined, read).fetch({ householdId: 'h1', posterRef: VALID_REF }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      proxy(row({ expiresAt: new Date(NOW - 1).toISOString() }), read).fetch({
        householdId: 'h1',
        posterRef: VALID_REF,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      proxy(row({ state: 'no_match' }), read).fetch({ householdId: 'h1', posterRef: VALID_REF }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      proxy(row({ posterPath: '//evil.example/a.jpg' }), read).fetch({
        householdId: 'h1',
        posterRef: VALID_REF,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(read).not.toHaveBeenCalled();
  });

  it('上游非 image/* 或非 identity → 502', async () => {
    const nonImage = proxy(row(), async () => ({
      bytes: Buffer.from('x'),
      contentType: 'text/html',
      contentEncoding: null,
      finalUrl: 'x',
      redirectsFollowed: 0,
    }));
    await expect(nonImage.fetch({ householdId: 'h1', posterRef: VALID_REF })).rejects.toMatchObject({
      status: 502,
      code: 'PROGRAMME_POSTER_UPSTREAM_FAILED',
    });

    const encoded = proxy(row(), async () => ({
      bytes: Buffer.from('x'),
      contentType: 'image/jpeg',
      contentEncoding: 'gzip',
      finalUrl: 'x',
      redirectsFollowed: 0,
    }));
    await expect(encoded.fetch({ householdId: 'h1', posterRef: VALID_REF })).rejects.toMatchObject({
      status: 502,
    });
  });

  it('上游超时/预算 → 504；其他失败 → 502', async () => {
    const timeout = proxy(row(), async () => {
      throw { code: 'SOURCE_IDLE_TIMEOUT' };
    });
    await expect(timeout.fetch({ householdId: 'h1', posterRef: VALID_REF })).rejects.toMatchObject({
      status: 504,
      code: 'PROGRAMME_POSTER_UPSTREAM_TIMEOUT',
    });

    const failed = proxy(row(), async () => {
      throw { code: 'SOURCE_REMOTE_UNREACHABLE' };
    });
    await expect(failed.fetch({ householdId: 'h1', posterRef: VALID_REF })).rejects.toMatchObject({
      status: 502,
    });
  });
});