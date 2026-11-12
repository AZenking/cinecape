import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { cleanupRigs, initialize, startFreshApp, type TestRig } from '../../helpers';
import { Database } from '@platform/database/database';
import { getDb } from '@platform/database/drizzle';
import { mediaSource, vodSourceConfig } from '@platform/database/schema';
import { DomainError } from '@platform/http-common/domain-error';
import { loadVodRuntimeConfig } from '@contexts/online-vod/infrastructure/vod-config';
import {
  createVodCache,
  VOD_SEARCH_SESSION_TTL_MS,
  type VodCache,
} from '@contexts/online-vod/infrastructure/vod-cache';
import { VOD_BUDGETS } from '@contexts/online-vod/domain/vod-budgets';
import { ProviderParseError } from '@contexts/online-vod/domain/provider-model';
import { parseDetailDocument, parseSearchList } from '@contexts/online-vod/infrastructure/apple-cms.adapter';
import {
  createVodSearchService,
  VodUpstreamTimeoutError,
  VOD_SEARCH_MAX_RESULTS,
  VOD_SEARCH_PAGE_SIZE,
  type VodSearchUpstreamFn,
} from '@contexts/online-vod/application/search.service';
// 010 恢复:VodDetailUpstream* 定义在 preview.service(与 VodDetailUpstreamFn 同域导出)
import {
  createVodPreviewService,
  type VodDetailUpstreamFn,
  type VodDetailUpstreamRequest,
} from '@contexts/online-vod/application/preview.service';
import type { VodSourceConfigurationPort } from '@contexts/online-vod/application/publication-work-set.port';
import {
  buildAppleCmsListDocument,
  createGappedDuplicateWorld,
  createThreeEpisodeSerialWorld,
  type AppleCmsListDocument,
  type AppleCmsVodItem,
} from '../../fixtures/online-vod/fixture-upstream';

/**
 * 010 T028 单元测试 —— 搜索/预览服务级行为契约(tasks.md T028 第 4 交付)。
 *
 * 环境:内存上游 stub(注入 VodSearchUpstreamFn/VodDetailUpstreamFn,零真实网络;
 * 解析经 T025 apple-cms.adapter 真实函数)+ 真实迁移 DDL(startFreshApp 权威 up.sql,
 * 禁源用例直改 media_source 模拟 T026 启停 locator_revision+1 语义)。
 * 断言面(api.md §2 搜索/详情表 + 缓存段逐行):
 * 固定来源轮转、(source,VOD ID) 去重、未消费保留/分页 20、已生成页重放不变、
 * 同 cursor 并发合并、partial/reasons、502/504/410/422/429、每家庭与总字节上限、
 * 禁源先失效缓存、ref 不可解码、预览零写库。
 */

/* ------------------------------------------------------------------ */
/* rig / DB 直改 seed                                                   */
/* ------------------------------------------------------------------ */

interface VodRig extends TestRig {
  readonly householdId: string;
}

async function startVodRig(prefix: string, env?: Record<string, string>): Promise<VodRig> {
  const rig = await startFreshApp({ prefix, env });
  expect((await initialize(rig.app)).status).toBe(201);
  const householdRow = Database.db.prepare('SELECT id FROM household LIMIT 1').get() as { id: string };
  return { ...rig, householdId: householdRow.id };
}

/** kind=vod 来源行(media_source + vod_source_config 一源一行);返回 sourceId */
function seedVodSource(householdId: string, name: string): string {
  const sourceId = `src-${randomUUID()}`;
  const now = new Date().toISOString();
  getDb().transaction((tx) => {
    tx.insert(mediaSource)
      .values({
        id: sourceId,
        householdId,
        kind: 'vod',
        name,
        remoteUrl: 'http://127.0.0.1:9/api.php/provide/vod/',
        enabled: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(vodSourceConfig).values({ householdId, sourceId, adapter: 'apple-cms-json' }).run();
  });
  return sourceId;
}

/** 禁源(对齐 T026 A6 语义:启停均 locator_revision+1 防 ABA) */
function disableVodSource(sourceId: string): void {
  Database.db
    .prepare(
      'UPDATE media_source SET enabled = 0, locator_revision = locator_revision + 1, updated_at = ? WHERE id = ?',
    )
    .run(new Date().toISOString(), sourceId);
}

function tableCountOf(table: string): number {
  const row = Database.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

/* ------------------------------------------------------------------ */
/* 来源配置端口(读真实 DDL 表)                                          */
/* ------------------------------------------------------------------ */

function createDbSourceConfig(): VodSourceConfigurationPort {
  return {
    listEnabledVodSources(householdId) {
      // 010 恢复:显式 ORDER BY rowid 钉死「seed 即配置顺序」—— 否则规划器走
      // (household_id, id) 唯一索引返回 id(随机 UUID)字典序,轮转用例逐 run 漂移
      const rows = getDb()
        .select({ id: mediaSource.id, name: mediaSource.name, locatorRevision: mediaSource.locatorRevision })
        .from(mediaSource)
        .where(and(eq(mediaSource.householdId, householdId), eq(mediaSource.kind, 'vod'), eq(mediaSource.enabled, 1)))
        .orderBy(sql`rowid`)
        .all();
      const adapters = getDb()
        .select({ sourceId: vodSourceConfig.sourceId, adapter: vodSourceConfig.adapter })
        .from(vodSourceConfig)
        .where(eq(vodSourceConfig.householdId, householdId))
        .all();
      const adapterBySource = new Map(adapters.map((row) => [row.sourceId, row.adapter]));
      return rows
        .filter((row) => adapterBySource.get(row.id) === 'apple-cms-json')
        .map((row) => ({ sourceId: row.id, name: row.name, adapter: 'apple-cms-json' as const, locatorRevision: row.locatorRevision }));
    },
    readLocatorRevision(householdId, sourceId) {
      const row = getDb()
        .select({ locatorRevision: mediaSource.locatorRevision })
        .from(mediaSource)
        .where(and(eq(mediaSource.householdId, householdId), eq(mediaSource.id, sourceId)))
        .get();
      return row?.locatorRevision;
    },
    findSourceConfig(householdId, sourceId) {
      return getDb()
        .select({ householdId: vodSourceConfig.householdId, sourceId: vodSourceConfig.sourceId, adapter: vodSourceConfig.adapter })
        .from(vodSourceConfig)
        .where(and(eq(vodSourceConfig.householdId, householdId), eq(vodSourceConfig.sourceId, sourceId)))
        .get();
    },
  };
}

/* ------------------------------------------------------------------ */
/* 上游 stub(内存;解析走 T025 真实函数)                                 */
/* ------------------------------------------------------------------ */

interface StubSource {
  readonly sourceId: string;
  /** mode:ok=按 pages 回包;hang=永不回包(仅 abort 拒绝);fail=传输层失败 */
  readonly mode: 'ok' | 'hang' | 'fail';
  /** 上游页(下标 0 = 第 1 页;越界页回空列表) */
  readonly pages: readonly AppleCmsListDocument[];
  readonly details: ReadonlyMap<string, AppleCmsVodItem>;
  readonly detailMode?: 'fail' | 'hang';
}

function hangUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new VodUpstreamTimeoutError());
      return;
    }
    signal.addEventListener('abort', () => reject(new VodUpstreamTimeoutError()), { once: true });
  });
}

function createUpstreamStubs(sources: readonly StubSource[]): {
  readonly searchUpstream: VodSearchUpstreamFn;
  // 010 恢复:对齐服务注入面 VodDetailUpstreamFn(Promise 形;服务侧在事务外 await)
  readonly fetchDetail: VodDetailUpstreamFn;
  readonly counters: {
    searchCalls: number;
    detailCalls: number;
    maxSearchConcurrency: number;
    abortedSignals: number;
    detailPageTwoCalls: number;
  };
} {
  const byId = new Map(sources.map((source) => [source.sourceId, source]));
  let activeSearch = 0;
  const counters = {
    searchCalls: 0,
    detailCalls: 0,
    maxSearchConcurrency: 0,
    abortedSignals: 0,
    detailPageTwoCalls: 0,
  };
  const searchUpstream: VodSearchUpstreamFn = async (request) => {
    counters.searchCalls += 1;
    if (request.page === 2) counters.detailPageTwoCalls += 1;
    if (request.signal.aborted) counters.abortedSignals += 1;
    request.signal.addEventListener('abort', () => {
      counters.abortedSignals += 1;
    }, { once: true });
    activeSearch += 1;
    counters.maxSearchConcurrency = Math.max(counters.maxSearchConcurrency, activeSearch);
    try {
      const source = byId.get(request.sourceId);
      if (source === undefined) return { items: [], hasMore: false };
      if (source.mode === 'hang') return await hangUntilAborted(request.signal);
      if (source.mode === 'fail') throw new Error('stub upstream transport failure');
      const document =
        source.pages[request.page - 1] ??
        ({ code: 1, msg: '', page: request.page, pagecount: 1, limit: '20', total: 0, list: [] } as AppleCmsListDocument);
      // wd= 语义:仅命中 vod_en(检索词)的条目返回,对齐真实上游检索行为
      const filtered: AppleCmsListDocument = {
        ...document,
        total: document.list.filter((item) => item.vod_en === request.query).length,
        list: document.list.filter((item) => item.vod_en === request.query),
      };
      return { items: parseSearchList(filtered), hasMore: filtered.pagecount > filtered.page };
    } finally {
      activeSearch -= 1;
    }
  };
  const fetchDetail = async (request: VodDetailUpstreamRequest) => {
    counters.detailCalls += 1;
    const source = byId.get(request.sourceId);
    if (source === undefined || source.detailMode === 'fail') {
      throw new Error('stub detail transport failure');
    }
    if (source.detailMode === 'hang') return await hangUntilAborted(request.signal);
    const item = source.details.get(request.upstreamVodId);
    if (item === undefined) {
      throw new ProviderParseError('integrity_violation', 'stub detail missing');
    }
    return parseDetailDocument(buildAppleCmsListDocument([item]), { budgets: VOD_BUDGETS.detail });
  };
  return { searchUpstream, fetchDetail, counters };
}

/* ------------------------------------------------------------------ */
/* 服务接线                                                             */
/* ------------------------------------------------------------------ */

interface WireOptions {
  readonly sources: readonly StubSource[];
  readonly env?: Record<string, string>;
  /** 注入时钟(缺省真实时间) */
  readonly nowMs?: () => number;
  readonly cache?: VodCache;
}

function wireServices(rig: VodRig, options: WireOptions) {
  const config = loadVodRuntimeConfig(options.env ?? {});
  // 010 恢复:运行期配置(含 env 收紧值,如 C1 的预览活对象配额)贯通缓存上限
  const cache =
    options.cache ??
    createVodCache({
      ...(options.nowMs ? { nowMs: options.nowMs } : {}),
      maxActiveSearchesPerHousehold: config.households.maxActiveSearchesPerHousehold,
      maxActivePreviewsPerHousehold: config.households.maxActivePreviewsPerHousehold,
      maxTotalBytes: config.cache.maxTotalBytes,
    });
  const stubs = createUpstreamStubs(options.sources);
  const sourceConfig = createDbSourceConfig();
  return {
    cache,
    stubs,
    search: createVodSearchService({
      config,
      cache,
      sourceConfig,
      searchUpstream: stubs.searchUpstream,
      nowMs: options.nowMs,
    }),
    preview: createVodPreviewService({
      config,
      cache,
      sourceConfig,
      fetchDetail: stubs.fetchDetail,
      nowMs: options.nowMs,
    }),
  };
}

/* ------------------------------------------------------------------ */
/* 值构造与断言辅助                                                      */
/* ------------------------------------------------------------------ */

/** brief 形态 wire 条目(镜像 fixture buildAppleCmsVodItem 字段面) */
function makeBriefItem(id: number, name: string, keyword: string, year = '2024'): AppleCmsVodItem {
  return {
    vod_id: id,
    type_id: 6,
    type_name: '夹具连续剧',
    vod_name: name,
    vod_sub: '',
    vod_en: keyword,
    vod_letter: name.slice(0, 1).toUpperCase(),
    vod_remarks: '连载完毕',
    vod_year: year,
    vod_area: '',
    vod_lang: '',
    vod_version: '',
    vod_actor: '',
    vod_director: '',
    vod_blurb: '夹具简介',
    vod_content: '<p>夹具简介</p>',
    vod_pubdate: '2026-01-01',
    vod_total: 0,
    vod_serial: '',
    vod_time: '2026-01-01 00:00:00',
    vod_time_add: 0,
    vod_play_from: '',
    vod_play_url: '',
    vod_play_note: '',
  };
}

/** n 条批量 brief 条目(id 自 base 递增) */
function makeBulkItems(base: number, count: number, keyword: string): AppleCmsVodItem[] {
  return Array.from({ length: count }, (_item, index) => makeBriefItem(base + index, `夹具批量片${String(index + 1).padStart(2, '0')}号`, keyword));
}

async function expectDomainError(promise: Promise<unknown>, status: number, code: string): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    expect(error, `应抛 DomainError(${status} ${code})`).toBeInstanceOf(DomainError);
    const domain = error as DomainError;
    expect(domain.status).toBe(status);
    expect(domain.code).toBe(code);
    return domain;
  }
  throw new Error(`应抛 DomainError(${status} ${code}),实际正常返回`);
}

/** opaque ref 形态:无 http、无源配置 ID、不可解码出 URL 载荷 */
function expectOpaqueRef(ref: string, secretSourceIds: readonly string[]): void {
  expect(ref.length).toBeGreaterThan(0);
  expect(ref).not.toContain('http');
  expect(ref).not.toContain('/');
  for (const sourceId of secretSourceIds) {
    expect(ref).not.toContain(sourceId);
  }
}

afterEach(cleanupRigs);

/* ------------------------------------------------------------------ */
/* A 搜索:轮转/去重/分页重放/并发合并/partial/502/504/410                */
/* ------------------------------------------------------------------ */

describe('T028 · 搜索服务(api.md §2 搜索段)', () => {
  it('A1 固定来源轮转:两次搜索起始源轮换,聚合缓冲按轮转序拼接;ref 均不可解码', async () => {
    const rig = await startVodRig('hmp-t028-a1-');
    const sourceA = seedVodSource(rig.householdId, '夹具片源A');
    const sourceB = seedVodSource(rig.householdId, '夹具片源B');
    const wire = wireServices(rig, {
      sources: [
        { sourceId: sourceA, mode: 'ok', pages: [buildAppleCmsListDocument(makeBulkItems(5001, 2, 'q'))], details: new Map() },
        { sourceId: sourceB, mode: 'ok', pages: [buildAppleCmsListDocument(makeBulkItems(6001, 2, 'q'))], details: new Map() },
      ],
    });

    const first = await wire.search.search({ mode: 'query', householdId: rig.householdId, query: 'q' });
    expect(first.items.map((item) => item.sourceLabel)).toEqual(['夹具片源A', '夹具片源A', '夹具片源B', '夹具片源B']);
    expect(first.partial).toBe(false);
    expect(first.reasons).toEqual([]);
    expect(first.sources).toHaveLength(2);
    for (const source of first.sources) {
      expect(['ok', 'empty']).toContain(source.status);
      expectOpaqueRef(source.sourceId, [sourceA, sourceB]);
    }
    for (const item of first.items) {
      expect(item.posterRef).toBeNull();
      expectOpaqueRef(item.titleRef, [sourceA, sourceB]);
    }
    expectOpaqueRef(first.searchId, [sourceA, sourceB]);

    const second = await wire.search.search({ mode: 'query', householdId: rig.householdId, query: 'q' });
    expect(second.items.map((item) => item.sourceLabel)).toEqual(['夹具片源B', '夹具片源B', '夹具片源A', '夹具片源A']);
    // 两次搜索 searchId/标题 ref 相互独立(不共享会话)
    expect(second.searchId).not.toBe(first.searchId);
  });

  it('A2 按 (source,VOD ID) 去重:同源重复 vod_id 只出一卡;跨源同 id 各自成卡', async () => {
    const rig = await startVodRig('hmp-t028-a2-');
    const sourceA = seedVodSource(rig.householdId, '夹具片源A');
    const sourceB = seedVodSource(rig.householdId, '夹具片源B');
    const duplicated: AppleCmsVodItem = { ...makeBriefItem(5001, '夹具批量片01号', 'dup'), vod_name: '重复身份条目' };
    const wire = wireServices(rig, {
      sources: [
        {
          sourceId: sourceA,
          mode: 'ok',
          pages: [buildAppleCmsListDocument([makeBriefItem(5001, '夹具批量片01号', 'dup'), duplicated])],
          details: new Map(),
        },
        { sourceId: sourceB, mode: 'ok', pages: [buildAppleCmsListDocument([makeBriefItem(5001, '夹具批量片01号', 'dup')])], details: new Map() },
      ],
    });

    const page = await wire.search.search({ mode: 'query', householdId: rig.householdId, query: 'dup' });
    // 同源 (A,5001) 去重为一卡;跨源 (B,5001) 独立成卡 → 共 2 卡
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.titleRef).not.toBe(page.items[1]?.titleRef);
  });

  it('A3 分页 20/页 + 未消费保留 + 已生成页重放不变(缺 cursor 重放第一页)', async () => {
    const rig = await startVodRig('hmp-t028-a3-');
    const sourceA = seedVodSource(rig.householdId, '夹具片源A');
    const wire = wireServices(rig, {
      sources: [
        {
          sourceId: sourceA,
          mode: 'ok',
          pages: [buildAppleCmsListDocument(makeBulkItems(5001, 25, 'bulksearch'))],
          details: new Map(),
        },
      ],
    });

    const page1 = await wire.search.search({ mode: 'query', householdId: rig.householdId, query: 'bulksearch' });
    expect(page1.items).toHaveLength(VOD_SEARCH_PAGE_SIZE);
    expect(page1.nextCursor).toBeTypeOf('string');
    expect(page1.sources[0]?.hasMore).toBe(true);
    expectOpaqueRef(page1.nextCursor ?? '', [sourceA]);

    const page2 = await wire.search.search({
      mode: 'page',
      householdId: rig.householdId,
      searchId: page1.searchId,
      cursor: page1.nextCursor,
    });
    expect(page2.items).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();
    expect(page2.sources[0]?.hasMore).toBe(false);
    expect(wire.stubs.counters.searchCalls, '未消费缓冲续页不重抓上游').toBe(1);

    // 已生成页重放不变:缺 cursor 重放第一页,逐字段同值
    const replayFirst = await wire.search.search({ mode: 'page', householdId: rig.householdId, searchId: page1.searchId, cursor: null });
    expect(replayFirst).toEqual(page1);
    // 同 cursor 重放第二页同样不变,上游不重抓
    const replaySecond = await wire.search.search({
      mode: 'page',
      householdId: rig.householdId,
      searchId: page1.searchId,
      cursor: page1.nextCursor,
    });
    expect(replaySecond).toEqual(page2);
    expect(wire.stubs.counters.searchCalls).toBe(1);
  });

  it('A4 缓冲耗尽续页抓上游 + 同 cursor 并发合并(单次上游抓取)', async () => {
    const rig = await startVodRig('hmp-t028-a4-');
    const sourceA = seedVodSource(rig.householdId, '夹具片源A');
    const wire = wireServices(rig, {
      sources: [
        {
          sourceId: sourceA,
          mode: 'ok',
          pages: [
            { ...buildAppleCmsListDocument(makeBulkItems(5001, VOD_SEARCH_PAGE_SIZE, 'paged')), page: 1, pagecount: 2 },
            { ...buildAppleCmsListDocument(makeBulkItems(5900, 12, 'paged')), page: 2, pagecount: 2 },
          ],
          details: new Map(),
        },
      ],
    });

    const page1 = await wire.search.search({ mode: 'query', householdId: rig.householdId, query: 'paged' });
    expect(page1.items).toHaveLength(VOD_SEARCH_PAGE_SIZE);
    expect(page1.nextCursor).toBeTypeOf('string');

    const [secondA, secondB] = await Promise.all([
      wire.search.search({ mode: 'page', householdId: rig.householdId, searchId: page1.searchId, cursor: page1.nextCursor }),
      wire.search.search({ mode: 'page', householdId: rig.householdId, searchId: page1.searchId, cursor: page1.nextCursor }),
    ]);
    expect(secondA.items).toHaveLength(12);
    expect(secondA.nextCursor).toBeNull();
    expect(secondB).toEqual(secondA);
    expect(wire.stubs.counters.searchCalls, '同 cursor 并发合并:上游第二页只抓一次').toBe(2);
    expect(wire.stubs.counters.detailPageTwoCalls, '上游 page=2 请求恰一次').toBe(1);
  });

  it('A5 部分源超时 → 200 partial=true + reasons 非空 + 状态混合,健康源照常返回;中止信号传播', async () => {
    const rig = await startVodRig('hmp-t028-a5-');
    const sourceA = seedVodSource(rig.householdId, '健康源');
    const sourceB = seedVodSource(rig.householdId, '挂起源');
    const wire = wireServices(rig, {
      env: { VOD_SEARCH_TIMEOUT_MS: '150' },
      sources: [
        { sourceId: sourceA, mode: 'ok', pages: [buildAppleCmsListDocument(makeBulkItems(5001, 3, 'q'))], details: new Map() },
        { sourceId: sourceB, mode: 'hang', pages: [], details: new Map() },
      ],
    });

    const page = await wire.search.search({ mode: 'query', householdId: rig.householdId, query: 'q' });
    expect(page.partial).toBe(true);
    expect(page.reasons.length).toBeGreaterThanOrEqual(1);
    const statuses = page.sources.map((source) => source.status);
    expect(statuses).toContain('ok');
    expect(statuses).toContain('timeout');
    expect(page.items).toHaveLength(3);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(wire.stubs.counters.abortedSignals, 'deadline 触发 AbortSignal 传播').toBeGreaterThanOrEqual(1);
  });

  it('A6 全源失败 → 502 VOD_UPSTREAM_FAILED;全部超时 → 504 VOD_UPSTREAM_TIMEOUT;无启用源 → 502', async () => {
    const rig = await startVodRig('hmp-t028-a6-');
    const sourceA = seedVodSource(rig.householdId, '失败源');
    const sourceB = seedVodSource(rig.householdId, '挂起源');
    const wire = wireServices(rig, {
      env: { VOD_SEARCH_TIMEOUT_MS: '120' },
      sources: [
        { sourceId: sourceA, mode: 'fail', pages: [], details: new Map() },
        { sourceId: sourceB, mode: 'hang', pages: [], details: new Map() },
      ],
    });
    await expectDomainError(
      wire.search.search({ mode: 'query', householdId: rig.householdId, query: 'q' }),
      502,
      'VOD_UPSTREAM_FAILED',
    );

    // 全部超时(单挂起源,独立 rig 避免 A 组第一段残留状态)
    const hangRig = await startVodRig('hmp-t028-a6b-');
    const hangOnly = seedVodSource(hangRig.householdId, '只挂起源');
    const wire2 = wireServices(hangRig, {
      env: { VOD_SEARCH_TIMEOUT_MS: '120' },
      sources: [{ sourceId: hangOnly, mode: 'hang', pages: [], details: new Map() }],
    });
    await expectDomainError(
      wire2.search.search({ mode: 'query', householdId: hangRig.householdId, query: 'q' }),
      504,
      'VOD_UPSTREAM_TIMEOUT',
    );

    // 无启用 vod 源(独立 rig,零 seed)→ 502 同形
    const emptyRig = await startVodRig('hmp-t028-a6c-');
    const wire3 = wireServices(emptyRig, { sources: [] });
    await expectDomainError(
      wire3.search.search({ mode: 'query', householdId: emptyRig.householdId, query: 'q' }),
      502,
      'VOD_UPSTREAM_FAILED',
    );
  });

  it('A7 全源成功但 0 条 → 200 空页(非 partial),与部分失败区分', async () => {
    const rig = await startVodRig('hmp-t028-a7-');
    const sourceA = seedVodSource(rig.householdId, '空源A');
    const sourceB = seedVodSource(rig.householdId, '空源B');
    const wire = wireServices(rig, {
      sources: [
        { sourceId: sourceA, mode: 'ok', pages: [buildAppleCmsListDocument([])], details: new Map() },
        { sourceId: sourceB, mode: 'ok', pages: [buildAppleCmsListDocument([])], details: new Map() },
      ],
    });
    const page = await wire.search.search({ mode: 'query', householdId: rig.householdId, query: 'q' });
    expect(page.items).toEqual([]);
    expect(page.partial).toBe(false);
    expect(page.reasons).toEqual([]);
    expect(page.nextCursor).toBeNull();
    for (const source of page.sources) {
      expect(source.status).toBe('empty');
      expect(source.hasMore).toBe(false);
    }
  });

  it('A8 会话/游标失效 → 410 VOD_SEARCH_EXPIRED(TTL 过、伪造游标、未知 searchId)', async () => {
    let clockMs = 1_700_000_000_000;
    const nowMs = (): number => clockMs;
    const rig = await startVodRig('hmp-t028-a8-');
    const sourceA = seedVodSource(rig.householdId, '夹具片源A');
    const cache = createVodCache({ nowMs });
    const wire = wireServices(rig, {
      nowMs,
      cache,
      sources: [{ sourceId: sourceA, mode: 'ok', pages: [buildAppleCmsListDocument(makeBulkItems(5001, 3, 'q'))], details: new Map() }],
    });

    const page = await wire.search.search({ mode: 'query', householdId: rig.householdId, query: 'q' });
    // 伪造游标 / 未知 searchId(未过期)
    await expectDomainError(
      wire.search.search({ mode: 'page', householdId: rig.householdId, searchId: page.searchId, cursor: 'c1-forged' }),
      410,
      'VOD_SEARCH_EXPIRED',
    );
    await expectDomainError(
      wire.search.search({ mode: 'page', householdId: rig.householdId, searchId: 's1-unknown', cursor: null }),
      410,
      'VOD_SEARCH_EXPIRED',
    );
    // TTL 过期(10min)
    clockMs += VOD_SEARCH_SESSION_TTL_MS + 1;
    await expectDomainError(
      wire.search.search({ mode: 'page', householdId: rig.householdId, searchId: page.searchId, cursor: null }),
      410,
      'VOD_SEARCH_EXPIRED',
    );
    // 跨家庭同形 410(公共面无存在性泄露差异)
    await expectDomainError(
      wire.search.search({ mode: 'query', householdId: 'hh-other', query: 'q' }),
      502,
      'VOD_UPSTREAM_FAILED',
    );
  });

  it('A9 并发闸 ≤3 与 2000 结果上限(达到后不再抓取、nextCursor 终结)', async () => {
    const rig = await startVodRig('hmp-t028-a9-');
    const sourceA = seedVodSource(rig.householdId, '并发源');
    // 010 恢复:A1 裁决同模式——本用例钉「会话最多 2000 结果」契约;标题绑定按 C1
    // 语义计入预览活对象(默认 1000),二者叠加会使大结果集在 1001 条即 429。
    // 故此处按测试对象隔离预览配额(≥2000),结果上限行为不被无关预算截断。
    const wire = wireServices(rig, {
      cache: createVodCache({ maxActivePreviewsPerHousehold: VOD_SEARCH_MAX_RESULTS + 1 }),
      sources: [
        {
          sourceId: sourceA,
          mode: 'ok',
          pages: [
            { ...buildAppleCmsListDocument(makeBulkItems(10000, 1500, 'cap')), page: 1, pagecount: 2 },
            { ...buildAppleCmsListDocument(makeBulkItems(20000, 1500, 'cap')), page: 2, pagecount: 2 },
          ],
          details: new Map(),
        },
      ],
    });

    const first = await wire.search.search({ mode: 'query', householdId: rig.householdId, query: 'cap' });
    expect(first.items).toHaveLength(VOD_SEARCH_PAGE_SIZE);
    let nextCursor = first.nextCursor;
    let total = first.items.length;
    let guard = 0;
    while (nextCursor !== null && guard < 300) {
      guard += 1;
      const page = await wire.search.search({
        mode: 'page',
        householdId: rig.householdId,
        searchId: first.searchId,
        cursor: nextCursor,
      });
      total += page.items.length;
      nextCursor = page.nextCursor;
    }
    expect(total, '会话累计恰好 2000 条(最多 2000 结果)').toBe(VOD_SEARCH_MAX_RESULTS);
    expect(nextCursor, '达到上限后 nextCursor 终结').toBeNull();
    expect(wire.stubs.counters.maxSearchConcurrency, '上游并发闸 = search.concurrency(3)').toBeLessThanOrEqual(3);
    expect(wire.stubs.counters.searchCalls, '2000 上限后不再抓取上游第三页').toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* B 预览:重放/ref 失效/422/format_unsupported/禁源/502/504              */
/* ------------------------------------------------------------------ */

describe('T028 · 预览服务(api.md §2 详情段)', () => {
  it('B1 有效 ref → VodPreview 纯值;缓存命中重放逐字段不变(详情只取一次)', async () => {
    const rig = await startVodRig('hmp-t028-b1-');
    const world = createThreeEpisodeSerialWorld('http://127.0.0.1:9');
    const sourceA = seedVodSource(rig.householdId, '夹具片源A');
    const wire = wireServices(rig, {
      sources: [
        {
          sourceId: sourceA,
          mode: 'ok',
          pages: [buildAppleCmsListDocument([world.briefItem])],
          details: new Map([[String(world.seed.upstreamVodId), world.item]]),
        },
      ],
    });

    const page = await wire.search.search({ mode: 'query', householdId: rig.householdId, query: 'stardust' });
    const card = page.items[0];
    expect(card).toBeDefined();
    const first = await wire.preview.preview({ householdId: rig.householdId, titleRef: card?.titleRef ?? '' });
    expect(first.titleRef).toBe(card?.titleRef);
    expect(first.title).toBe('fixture·星尘信使');
    expect(first.year).toBe('2024');
    expect(first.posterRef).toBeNull();
    expect(first.previewRevision).toBeGreaterThanOrEqual(1);
    expect(first.description).not.toBeNull();
    expect(first.lines).toHaveLength(1);
    const line = first.lines[0];
    expect(line?.episodes).toHaveLength(3);
    for (const episode of line?.episodes ?? []) {
      expect(episode.status).toBe('candidate');
      expect(episode.reason).toBeNull();
      expectOpaqueRef(episode.episodeRef, [sourceA]);
      expect(episode.episodeRef).not.toContain('.m3u8');
    }
    expectOpaqueRef(line?.lineRef ?? '', [sourceA]);

    const replay = await wire.preview.preview({ householdId: rig.householdId, titleRef: card?.titleRef ?? '' });
    expect(replay).toEqual(first);
    expect(wire.stubs.counters.detailCalls, '缓存命中重放不再抓详情').toBe(1);
  });

  it('B2 identity_ambiguous(重复键世界)与 format_unsupported(直连媒体定位)分别映射', async () => {
    const rig = await startVodRig('hmp-t028-b2-');
    const gapped = createGappedDuplicateWorld('http://127.0.0.1:9');
    const sourceA = seedVodSource(rig.householdId, '缺集世界源');
    const mp4Detail: AppleCmsVodItem = {
      ...makeBriefItem(7100, '夹具直连影片', 'mp4show'),
      vod_play_from: 'main',
      vod_play_url: '第01集$http://127.0.0.1:9/vod/movie.mp4',
    };
    const wire = wireServices(rig, {
      sources: [
        {
          sourceId: sourceA,
          mode: 'ok',
          pages: [buildAppleCmsListDocument([gapped.briefItem, mp4Detail])],
          details: new Map([
            [String(gapped.seed.upstreamVodId), gapped.item],
            ['7100', mp4Detail],
          ]),
        },
      ],
    });

    const page = await wire.search.search({ mode: 'query', householdId: rig.householdId, query: 'mistfiles' });
    const gappedPreview = await wire.preview.preview({
      householdId: rig.householdId,
      titleRef: page.items[0]?.titleRef ?? '',
    });
    const episodes = gappedPreview.lines.flatMap((line) => line.episodes);
    expect(episodes.length).toBeGreaterThanOrEqual(1);
    expect(
      episodes.some((episode) => episode.reason === 'identity_ambiguous' && episode.status === 'unsupported'),
      '重复键世界应出现 identity_ambiguous',
    ).toBe(true);

    const mp4Page = await wire.search.search({ mode: 'query', householdId: rig.householdId, query: 'mp4show' });
    const mp4Preview = await wire.preview.preview({
      householdId: rig.householdId,
      titleRef: mp4Page.items[0]?.titleRef ?? '',
    });
    const mp4Episodes = mp4Preview.lines.flatMap((line) => line.episodes);
    expect(mp4Episodes).toHaveLength(1);
    expect(mp4Episodes[0]?.status).toBe('unsupported');
    expect(mp4Episodes[0]?.reason).toBe('format_unsupported');
  });

  it('B3 伪造 ref → 404;TTL 过期 → 410 VOD_PREVIEW_EXPIRED;超线路预算 → 422 VOD_DETAIL_TOO_LARGE;详情失败 → 502;详情超时 → 504', async () => {
    const rig = await startVodRig('hmp-t028-b3-');
    const world = createThreeEpisodeSerialWorld('http://127.0.0.1:9');
    const sourceA = seedVodSource(rig.householdId, '夹具片源A');
    const oversizeDetail: AppleCmsVodItem = {
      ...makeBriefItem(8800, '夹具超线路源影片', 'bigshow'),
      vod_play_from: Array.from({ length: 21 }, (_v, i) => `线${i + 1}`).join('$$$'),
      vod_play_url: Array.from({ length: 21 }, (_v, i) => `第01集$http://127.0.0.1:9/vod/l${i + 1}/index.m3u8`).join('$$$'),
    };
    let clockMs = 1_700_000_000_000;
    const nowMs = (): number => clockMs;
    const cache = createVodCache({ nowMs });
    const wire = wireServices(rig, {
      env: { VOD_PREVIEW_TIMEOUT_MS: '120' },
      nowMs,
      cache,
      sources: [
        {
          sourceId: sourceA,
          mode: 'ok',
          pages: [buildAppleCmsListDocument([world.briefItem, oversizeDetail])],
          details: new Map([
            [String(world.seed.upstreamVodId), world.item],
            ['8800', oversizeDetail],
          ]),
        },
      ],
    });

    // 伪造 ref → 404(与不存在同形,不泄露存在性)
    await expectDomainError(
      wire.preview.preview({ householdId: rig.householdId, titleRef: `t1-${randomUUID()}` }),
      404,
      'NOT_FOUND',
    );

    const page = await wire.search.search({ mode: 'query', householdId: rig.householdId, query: 'stardust' });
    const titleRef = page.items[0]?.titleRef ?? '';
    // 超线路预算(21 > 20)→ 422 整次失败
    const bigPage = await wire.search.search({ mode: 'query', householdId: rig.householdId, query: 'bigshow' });
    await expectDomainError(
      wire.preview.preview({ householdId: rig.householdId, titleRef: bigPage.items[0]?.titleRef ?? '' }),
      422,
      'VOD_DETAIL_TOO_LARGE',
    );

    // TTL 过期 → 410(签发过但失效,不与伪造 404 混同)
    clockMs += VOD_SEARCH_SESSION_TTL_MS + 1;
    await expectDomainError(
      wire.preview.preview({ householdId: rig.householdId, titleRef }),
      410,
      'VOD_PREVIEW_EXPIRED',
    );
  });

  it('B4 禁源先失效缓存再拒绝旧页 410;详情上游失败 502;详情超时 504', async () => {
    const rig = await startVodRig('hmp-t028-b4-');
    const world = createThreeEpisodeSerialWorld('http://127.0.0.1:9');
    const sourceA = seedVodSource(rig.householdId, '将被禁源');
    const failSource = seedVodSource(rig.householdId, '详情失败源');
    const hangSource = seedVodSource(rig.householdId, '详情挂起源');
    const failDetail: AppleCmsVodItem = makeBriefItem(9100, '夹具失败详情影片', 'failshow');
    const hangDetail: AppleCmsVodItem = makeBriefItem(9200, '夹具挂起详情影片', 'hangshow');
    const wire = wireServices(rig, {
      env: { VOD_PREVIEW_TIMEOUT_MS: '120' },
      sources: [
        {
          sourceId: sourceA,
          mode: 'ok',
          pages: [buildAppleCmsListDocument([world.briefItem])],
          details: new Map([[String(world.seed.upstreamVodId), world.item]]),
        },
        { sourceId: failSource, mode: 'ok', pages: [buildAppleCmsListDocument([failDetail])], details: new Map([['9100', failDetail]]), detailMode: 'fail' },
        { sourceId: hangSource, mode: 'ok', pages: [buildAppleCmsListDocument([hangDetail])], details: new Map([['9200', hangDetail]]), detailMode: 'hang' },
      ],
    });

    const page = await wire.search.search({ mode: 'query', householdId: rig.householdId, query: 'stardust' });
    const titleRef = page.items[0]?.titleRef ?? '';
    const first = await wire.preview.preview({ householdId: rig.householdId, titleRef });
    expect(first.previewRevision).toBeGreaterThanOrEqual(1);

    // 禁源(启停 locator_revision+1)→ 先失效缓存 → 旧 ref 410 VOD_PREVIEW_EXPIRED
    const entriesBefore = wire.cache.stats().entries;
    disableVodSource(sourceA);
    await expectDomainError(
      wire.preview.preview({ householdId: rig.householdId, titleRef }),
      410,
      'VOD_PREVIEW_EXPIRED',
    );
    // 010 恢复:invalidateSource 按 vod-cache 契约清除「绑定该源的全部条目(两种
    // kind)」——搜索会话 sourceIds 含全部启用源,与预览快照同被清除,故断言清除数≥1
    expect(
      entriesBefore - wire.cache.stats().entries,
      '禁源失效钩子清除该源缓存条目(含会话与预览快照)',
    ).toBeGreaterThanOrEqual(1);

    // 详情上游失败 → 502;详情超时 → 504
    const failPage = await wire.search.search({ mode: 'query', householdId: rig.householdId, query: 'failshow' });
    await expectDomainError(
      wire.preview.preview({ householdId: rig.householdId, titleRef: failPage.items[0]?.titleRef ?? '' }),
      502,
      'VOD_UPSTREAM_FAILED',
    );
    const hangPage = await wire.search.search({ mode: 'query', householdId: rig.householdId, query: 'hangshow' });
    await expectDomainError(
      wire.preview.preview({ householdId: rig.householdId, titleRef: hangPage.items[0]?.titleRef ?? '' }),
      504,
      'VOD_UPSTREAM_TIMEOUT',
    );
  });
});

/* ------------------------------------------------------------------ */
/* C 上限与零写入                                                       */
/* ------------------------------------------------------------------ */

describe('T028 · 缓存上限与零写库(api.md §2 缓存段)', () => {
  it('C1 每家庭预览配额满额 → 429 VOD_CACHE_CAPACITY(标题绑定计入预览活对象)', async () => {
    const rig = await startVodRig('hmp-t028-c1-', { VOD_MAX_ACTIVE_PREVIEWS_PER_HOUSEHOLD: '1' });
    const sourceA = seedVodSource(rig.householdId, '满额源A');
    const sourceB = seedVodSource(rig.householdId, '满额源B');
    const wire = wireServices(rig, {
      env: { VOD_MAX_ACTIVE_PREVIEWS_PER_HOUSEHOLD: '1' },
      sources: [
        { sourceId: sourceA, mode: 'ok', pages: [buildAppleCmsListDocument(makeBulkItems(5001, 1, 'qa'))], details: new Map() },
        { sourceId: sourceB, mode: 'ok', pages: [buildAppleCmsListDocument(makeBulkItems(6001, 1, 'qb'))], details: new Map() },
      ],
    });

    await wire.search.search({ mode: 'query', householdId: rig.householdId, query: 'qa' });
    // 第二次搜索登记第二个标题绑定 → 预览活对象超 1 → 429
    await expectDomainError(
      wire.search.search({ mode: 'query', householdId: rig.householdId, query: 'qb' }),
      429,
      'VOD_CACHE_CAPACITY',
    );
  });

  it('C2 进程总字节上限收紧至不可容纳 → 429 VOD_CACHE_CAPACITY(不淘汰拒新写)', async () => {
    const rig = await startVodRig('hmp-t028-c2-', { VOD_CACHE_MAX_TOTAL_BYTES: '200' });
    const sourceA = seedVodSource(rig.householdId, '字节受限源');
    const cache = createVodCache({ maxTotalBytes: 200 });
    const wire = wireServices(rig, {
      cache,
      sources: [{ sourceId: sourceA, mode: 'ok', pages: [buildAppleCmsListDocument(makeBulkItems(5001, 3, 'q'))], details: new Map() }],
    });
    await expectDomainError(
      wire.search.search({ mode: 'query', householdId: rig.householdId, query: 'q' }),
      429,
      'VOD_CACHE_CAPACITY',
    );
  });

  it('C3 预览/搜索不物化、不建个人记录(公共表零写入)', async () => {
    const rig = await startVodRig('hmp-t028-c3-');
    const world = createThreeEpisodeSerialWorld('http://127.0.0.1:9');
    const sourceA = seedVodSource(rig.householdId, '零写库源');
    const wire = wireServices(rig, {
      sources: [
        {
          sourceId: sourceA,
          mode: 'ok',
          pages: [buildAppleCmsListDocument([world.briefItem])],
          details: new Map([[String(world.seed.upstreamVodId), world.item]]),
        },
      ],
    });
    const page = await wire.search.search({ mode: 'query', householdId: rig.householdId, query: 'stardust' });
    await wire.preview.preview({ householdId: rig.householdId, titleRef: page.items[0]?.titleRef ?? '' });
    expect(tableCountOf('vod_title')).toBe(0);
    expect(tableCountOf('vod_line')).toBe(0);
    expect(tableCountOf('vod_episode')).toBe(0);
    expect(tableCountOf('vod_detail_snapshot')).toBe(0);
    expect(tableCountOf('vod_materialization_operation')).toBe(0);
    expect(tableCountOf('vod_registered_candidate')).toBe(0);
    expect(tableCountOf('media_item')).toBe(0);
    expect(tableCountOf('media_relation')).toBe(0);
    expect(tableCountOf('source_entry')).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* P 海报(posterRef):签发/私有载荷/预览承继/无海报 null                  */
/* ------------------------------------------------------------------ */

describe('海报代理前置 · posterRef 签发与承继(api.md §1 posterRef:string|null)', () => {
  it('P1 上游给 vod_pic:卡片签发 p 级 opaque posterRef;绑定载私有 posterUrl;预览原样承继', async () => {
    const rig = await startVodRig('vod-poster-p1');
    const sourceId = seedVodSource(rig.householdId, '海报源');
    const pic = 'http://127.0.0.1:9/pic/poster.jpg';
    const detailItem = {
      ...makeBriefItem(1, '海报片甲', 'posterkw'),
      vod_pic: pic,
      vod_play_from: '线路一',
      vod_play_url: '第01集$http://127.0.0.1:9/hls/1/index.m3u8',
    };
    const { cache, search, preview } = wireServices(rig, {
      sources: [
        {
          sourceId,
          mode: 'ok',
          pages: [buildAppleCmsListDocument([{ ...makeBriefItem(1, '海报片甲', 'posterkw'), vod_pic: pic }])],
          details: new Map([['1', detailItem]]),
        },
      ],
    });
    const page = await search.search({ mode: 'query', householdId: rig.householdId, query: 'posterkw' });
    const card = page.items[0];
    expect(card?.posterRef).not.toBeNull();
    const posterRef = card?.posterRef as string;
    // p 级前缀 + 不可解码(无 http/无源配置 ID)
    expect(posterRef.startsWith('p1-')).toBe(true);
    expect(posterRef).not.toContain('http');
    expect(posterRef).not.toContain(pic);
    expect(posterRef).not.toContain(sourceId);
    // 注册表可逆:local 类别 = poster 前缀,entryId = titleRef(posterRef 与标题绑定
    // 条目同寿:绑定淘汰/失效级联清除,会话淘汰不影响仍可用的标题绑定)
    const resolved = cache.resolveRef(posterRef);
    expect(resolved?.local.startsWith('poster:')).toBe(true);
    expect(resolved?.entryId).toBe(card?.titleRef ?? '');
    // 绑定载荷:私有 posterUrl 与公共面隔离
    const binding = cache.get<{ posterUrl: string | null; posterRef: string | null }>(resolved?.entryId ?? '');
    expect(binding?.payload.posterUrl).toBe(pic);
    expect(binding?.payload.posterRef).toBe(posterRef);
    // 预览(取详情)快照原样承继:重放/卡片一致
    const previewView = await preview.preview({ householdId: rig.householdId, titleRef: card?.titleRef ?? '' });
    expect(previewView.posterRef).toBe(posterRef);
  });

  it('P2 上游未给 vod_pic:posterRef 恒 null 且不签发 p 级 ref', async () => {
    const rig = await startVodRig('vod-poster-p2');
    const sourceId = seedVodSource(rig.householdId, '无海报源');
    const { cache, search } = wireServices(rig, {
      sources: [
        {
          sourceId,
          mode: 'ok',
          pages: [buildAppleCmsListDocument([makeBriefItem(1, '无海报片', 'nopickw')])],
          details: new Map([]),
        },
      ],
    });
    const page = await search.search({ mode: 'query', householdId: rig.householdId, query: 'nopickw' });
    expect(page.items[0]?.posterRef).toBeNull();
    // 全部注册 ref 的 local 无 poster 类别(未签发)
    const posterRefs = [...page.items].filter((item) => item.posterRef !== null);
    expect(posterRefs).toHaveLength(0);
    const bindingView = cache.get<{ posterUrl: string | null }>(page.items[0]?.titleRef ?? '');
    expect(bindingView?.payload.posterUrl).toBeNull();
  });
});

describe('海报补签 · 详情侧(ac=list 缺图、ac=detail 带图)', () => {
  it('P3 绑定无图 + 详情带 vod_pic:预览快照补发 posterRef 且重放稳定;卡片仍 null(诚实)', async () => {
    const rig = await startVodRig('vod-poster-p3');
    const sourceId = seedVodSource(rig.householdId, '详情图源');
    const detailPic = 'http://127.0.0.1:9/pic/detail-poster.webp';
    const detailItem = {
      ...makeBriefItem(1, '详情图片甲', 'detpicw'),
      vod_pic: detailPic,
      vod_play_from: '线路一',
      vod_play_url: '第01集$http://127.0.0.1:9/hls/1/index.m3u8',
    };
    const { cache, search, preview } = wireServices(rig, {
      sources: [
        {
          sourceId,
          mode: 'ok',
          pages: [buildAppleCmsListDocument([makeBriefItem(1, '详情图片甲', 'detpicw')])],
          details: new Map([['1', detailItem]]),
        },
      ],
    });
    const page = await search.search({ mode: 'query', householdId: rig.householdId, query: 'detpicw' });
    const card = page.items[0];
    // 列表无图:卡片诚实 null,未签发 p 级 ref
    expect(card?.posterRef).toBeNull();
    // 预览:快照组装时补签(p 级、绑定在 titleRef 条目、载荷携带详情海报地址)
    const previewView = await preview.preview({ householdId: rig.householdId, titleRef: card?.titleRef ?? '' });
    expect(previewView.posterRef).not.toBeNull();
    const posterRef = previewView.posterRef as string;
    expect(posterRef.startsWith('p1-')).toBe(true);
    const resolved = cache.resolveRef(posterRef);
    expect(resolved?.entryId).toBe(card?.titleRef ?? '');
    const snapshot = cache.get<{ posterUrl: string | null; posterRef: string | null }>(card?.titleRef ?? '');
    expect(snapshot?.payload.posterUrl).toBe(detailPic);
    expect(snapshot?.payload.posterRef).toBe(posterRef);
    // 缓存命中重放:posterRef 逐字段不变
    const replay = await preview.preview({ householdId: rig.householdId, titleRef: card?.titleRef ?? '' });
    expect(replay.posterRef).toBe(posterRef);
    expect(replay.previewRevision).toBe(previewView.previewRevision);
  });
});
