import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from '@platform/config/env.schema';
import { setEnvOverride } from '@platform/config/env';
import {
  createProgrammePosterService,
  type ProgrammePosterServiceDeps,
} from '@contexts/epg/application/programme-poster.service';
import type {
  EpgStore,
  EpgTxStore,
  ProgrammeMatchKeyCandidateRow,
  ProgrammePosterRow,
  ProgrammeRekeyRow,
} from '@contexts/epg/application/epg-store.port';
import { TmdbError, type TmdbClient } from '@contexts/epg/infrastructure/tmdb.client';
import type { TmdbPosterCandidate } from '@contexts/epg/domain/programme-poster-match';

const NOW = Date.UTC(2026, 10, 13, 4, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function useEnv(extra: Record<string, string> = {}): void {
  setEnvOverride(loadEnv({ NODE_ENV: 'test', TMDB_API_KEY: 'test-key', ...extra }));
}

function candidate(overrides: Partial<TmdbPosterCandidate> = {}): TmdbPosterCandidate {
  return {
    id: 1,
    mediaType: 'movie',
    title: '沙丘',
    originalTitle: 'Dune',
    posterPath: '/a.jpg',
    releaseDate: '2021-09-15',
    voteAverage: 7.8,
    popularity: 100,
    adult: false,
    ...overrides,
  };
}

class FakeClient implements TmdbClient {
  calls = 0;
  enabled = true;
  handler: (query: string) => Promise<readonly TmdbPosterCandidate[]> = async () => [candidate()];

  isEnabled(): boolean {
    return this.enabled;
  }

  async searchMulti(input: { query: string }): Promise<readonly TmdbPosterCandidate[]> {
    this.calls += 1;
    return this.handler(input.query);
  }
}

class FakeStore {
  readonly rows = new Map<string, ProgrammePosterRow>();
  readonly refUpdates: Array<{ matchKey: string; ref: string | null }> = [];
  readonly keyUpdates: Array<{ id: string; matchKey: string | null }> = [];
  readonly gcCutoffs: string[] = [];
  pending: ProgrammeMatchKeyCandidateRow[] = [];
  rekeyRows: ProgrammeRekeyRow[] = [];

  listProgrammePosterRows(_householdId: string, matchKeys: readonly string[]): ProgrammePosterRow[] {
    return matchKeys.map((key) => this.rows.get(key)).filter((row): row is ProgrammePosterRow => row !== undefined);
  }

  listProgrammeMatchKeyCandidateRows(
    _householdId: string,
    afterId: string | null,
    limit: number,
  ): ProgrammeMatchKeyCandidateRow[] {
    return this.pending
      .filter((row) => afterId === null || row.id > afterId)
      .slice(0, limit);
  }

  listProgrammeRowsForRekey(
    _householdId: string,
    afterId: string | null,
    limit: number,
  ): ProgrammeRekeyRow[] {
    return this.rekeyRows
      .filter((row) => afterId === null || row.id > afterId)
      .slice(0, limit);
  }

  withTransaction<T>(fn: (tx: EpgTxStore) => T): T {
    const tx = {
      upsertProgrammePoster: (row: ProgrammePosterRow) => {
        this.rows.set(row.matchKey, row);
      },
      updateProgrammePosterRefs: (
        _householdId: string,
        entries: ReadonlyArray<{ matchKey: string; ref: string | null }>,
      ) => {
        this.refUpdates.push(...entries);
      },
      updateProgrammeMatchKeys: (
        _householdId: string,
        entries: ReadonlyArray<{ id: string; matchKey: string | null }>,
      ) => {
        this.keyUpdates.push(...entries);
      },
      deleteExpiredProgrammePosterRows: (_householdId: string, cutoffIso: string) => {
        this.gcCutoffs.push(cutoffIso);
        return 0;
      },
    } as unknown as EpgTxStore;
    return fn(tx);
  }
}

function serviceWith(
  client: FakeClient,
  store: FakeStore,
  sleeps: number[] = [],
): ReturnType<typeof createProgrammePosterService> {
  const deps: ProgrammePosterServiceDeps = {
    client,
    store: store as unknown as Pick<
      EpgStore,
      | 'listProgrammePosterRows'
      | 'withTransaction'
      | 'listProgrammeMatchKeyCandidateRows'
      | 'listProgrammeRowsForRekey'
    >,
    nowMs: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return createProgrammePosterService(deps);
}

afterEach(() => {
  setEnvOverride(null);
});

describe('020 · 节目海报补全服务', () => {
  it('resolveCachedRefs：只返回未过期的 matched ref；过期/负缓存不回 ref', () => {
    useEnv();
    const store = new FakeStore();
    const client = new FakeClient();
    const service = serviceWith(client, store);

    const matched: ProgrammePosterRow = {
      householdId: 'h1',
      matchKey: '沙丘',
      ref: '0123456789abcdef0123456789abcdef',
      state: 'matched',
      tmdbId: 1,
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
      expiresAt: new Date(NOW + DAY).toISOString(),
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    };
    store.rows.set('沙丘', matched);
    store.rows.set('过期的', { ...matched, matchKey: '过期的', ref: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', expiresAt: new Date(NOW - DAY).toISOString() });
    store.rows.set('未匹配', {
      ...matched,
      matchKey: '未匹配',
      ref: null,
      state: 'no_match',
      tmdbId: null,
      mediaType: null,
      posterPath: null,
    });

    const refs = service.resolveCachedRefs({
      householdId: 'h1',
      titles: ['沙丘 (2021)', '过期的', '未匹配', '新闻联播'],
      nowMs: NOW,
    });
    expect(refs.size).toBe(1);
    expect(refs.get('沙丘 (2021)')).toEqual({ matchKey: '沙丘', ref: matched.ref });
    expect(client.calls).toBe(0);
  });

  it('enrichAfterEpgPublish：去重/跳过通用栏目/写入 matched 与 ref；第二次零调用', async () => {
    useEnv();
    const store = new FakeStore();
    const client = new FakeClient();
    client.handler = async (query) =>
      query.includes('沙丘') ? [candidate()] : [candidate({ id: 2, title: '流浪地球2', originalTitle: '流浪地球2', posterPath: '/b.jpg', releaseDate: '2023-01-22' })];
    const service = serviceWith(client, store);

    const titles = ['沙丘 (2021)', '流浪地球2', '新闻联播', '沙丘 (2021)'];
    const first = await service.enrichAfterEpgPublish({ householdId: 'h1', titles, nowMs: NOW });
    expect(first.titles).toBe(2);
    expect(first.lookups).toBe(2);
    expect(first.matched).toBe(2);
    expect(first.noMatch).toBe(0);
    expect(first.skipped).toBe(0);
    expect(store.rows.size).toBe(2);
    expect(store.refUpdates).toHaveLength(2);
    expect(store.gcCutoffs).toHaveLength(1);

    const second = await service.enrichAfterEpgPublish({ householdId: 'h1', titles, nowMs: NOW + 1000 });
    expect(second.cacheHits).toBe(2);
    expect(second.lookups).toBe(0);
    expect(client.calls).toBe(2);
  });

  it('负缓存：no_match 在 TTL 内不重复调用', async () => {
    useEnv();
    const store = new FakeStore();
    const client = new FakeClient();
    client.handler = async () => [];
    const service = serviceWith(client, store);

    const first = await service.enrichAfterEpgPublish({ householdId: 'h1', titles: ['沙丘'], nowMs: NOW });
    expect(first.noMatch).toBe(1);
    expect(store.rows.get('沙丘')?.state).toBe('no_match');
    expect(store.rows.get('沙丘')?.ref).toBeNull();

    const second = await service.enrichAfterEpgPublish({ householdId: 'h1', titles: ['沙丘'], nowMs: NOW + DAY });
    expect(second.lookups).toBe(0);
    expect(client.calls).toBe(1);
  });

  it('单次上限：超过 TMDB_MAX_LOOKUPS_PER_RUN 的标题标记 skipped', async () => {
    useEnv({ TMDB_MAX_LOOKUPS_PER_RUN: '1' });
    const store = new FakeStore();
    const client = new FakeClient();
    const service = serviceWith(client, store);

    const summary = await service.enrichAfterEpgPublish({
      householdId: 'h1',
      titles: ['沙丘', '流浪地球2', '阿凡达'],
      nowMs: NOW,
    });
    expect(summary.lookups).toBe(1);
    expect(summary.skipped).toBe(2);
    expect(client.calls).toBe(1);
  });

  it('调用间隔：第 2 次请求前 sleep 配置的最小间隔', async () => {
    useEnv({ TMDB_LOOKUP_INTERVAL_MS: '150' });
    const store = new FakeStore();
    const client = new FakeClient();
    const sleeps: number[] = [];
    const service = serviceWith(client, store, sleeps);

    await service.enrichAfterEpgPublish({
      householdId: 'h1',
      titles: ['沙丘', '流浪地球2'],
      nowMs: NOW,
    });
    expect(sleeps).toEqual([150]);
  });

  it('401：当前标题 failed、剩余 skipped、不抛异常', async () => {
    useEnv();
    const store = new FakeStore();
    const client = new FakeClient();
    client.handler = async () => {
      throw new TmdbError('auth', 'bad key');
    };
    const service = serviceWith(client, store);

    const summary = await service.enrichAfterEpgPublish({
      householdId: 'h1',
      titles: ['沙丘', '流浪地球2'],
      nowMs: NOW,
    });
    expect(summary.failed).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(store.rows.get('沙丘')?.state).toBe('failed');
    expect(store.rows.get('沙丘')?.ref).toBeNull();
  });

  it('TTL：matched 180 天、no_match 30 天、failed 60 分钟', async () => {
    useEnv();
    const store = new FakeStore();
    const client = new FakeClient();
    const service = serviceWith(client, store);

    client.handler = async () => [candidate()];
    await service.enrichAfterEpgPublish({ householdId: 'h1', titles: ['沙丘'], nowMs: NOW });
    expect(Date.parse(store.rows.get('沙丘')!.expiresAt)).toBe(NOW + 180 * DAY);

    store.rows.clear();
    client.handler = async () => [];
    await service.enrichAfterEpgPublish({ householdId: 'h1', titles: ['沙丘'], nowMs: NOW });
    expect(Date.parse(store.rows.get('沙丘')!.expiresAt)).toBe(NOW + 30 * DAY);

    store.rows.clear();
    client.handler = async () => {
      throw new TmdbError('http', '500');
    };
    await service.enrichAfterEpgPublish({ householdId: 'h1', titles: ['沙丘'], nowMs: NOW });
    expect(Date.parse(store.rows.get('沙丘')!.expiresAt)).toBe(NOW + 60 * 60_000);
  });

  it('backfillMatchKeys：分批补齐旧行 poster_match_key，通用栏目保持 NULL', () => {
    useEnv();
    const store = new FakeStore();
    const client = new FakeClient();
    const service = serviceWith(client, store);

    store.pending = [
      { id: 'a', title: '沙丘 (2021)' },
      { id: 'b', title: '新闻联播' },
      { id: 'c', title: '流浪地球2 第1集' },
    ];
    const updated = service.backfillMatchKeys({ householdId: 'h1', limit: 10 });
    expect(updated).toBe(2);
    expect(store.keyUpdates).toEqual([
      { id: 'a', matchKey: '沙丘' },
      { id: 'c', matchKey: '流浪地球2' },
    ]);
  });

  it('rekeyProgrammeMatchKeys：按新规则重算旧行，变更行清空 key/ref', () => {
    useEnv();
    const store = new FakeStore();
    const client = new FakeClient();
    const service = serviceWith(client, store);
    store.rekeyRows = [
      { id: 'a', title: '1001夜剧场:生万物(4)', posterMatchKey: '1001夜剧场生万物4' },
      { id: 'b', title: '电视剧', posterMatchKey: '电视剧' },
      { id: 'c', title: '战狼2', posterMatchKey: '战狼2' },
    ];
    expect(service.rekeyProgrammeMatchKeys({ householdId: 'h1', limit: 10 })).toBe(2);
    expect(store.keyUpdates).toEqual([
      { id: 'a', matchKey: '生万物' },
      { id: 'b', matchKey: null },
    ]);
    expect(client.calls).toBe(0);
  });
});