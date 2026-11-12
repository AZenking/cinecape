/**
 * 010 T028 — 公共搜索用例(application):多源轮转聚合/去重/分页/并发合并/页重放。
 *
 * 纯函数模块惯例:依赖经参数注入函数束(VodSearchServiceDeps,供 T031 装配)——
 * 来源配置经 VodSourceConfigurationPort(T015 发布面端口)、有界缓存经 VodCache
 * (infrastructure/vod-cache.ts)、上游读取经注入的 VodSearchUpstreamFn(T031 以
 * SafeUpstream + T025 apple-cms.adapter 解析装配;网络在事务外,本服务零 DB 写)。
 * 输出为 T015 纯值(VodSearchPageSnapshot/PublicVodCardValues;VodSourceSearchStatus
 * 的 sourceId 字段载荷 = 不透明 sourceRef,api §1「无源配置 ID」),可直接由
 * T031 控制器按冻结 DTO 序列化。
 *
 * 行为契约(逐行即语义,docs/specs/010-online-vod/contracts/api.md §2 搜索段):
 * - 固定来源轮转缓冲:启用来源按配置固定顺序,轮转指针(缓存 registry 持有)决定
 *   每次搜索的起始源,聚合缓冲按轮转后顺序拼接;
 * - 未消费结果保留:已接受未分页的结果留在会话缓冲,后续 cursor 续页不重抓;
 * - 按 (source, VOD ID) 去重:同源同 upstreamVodId 只出一卡;跨源各自成卡;
 * - 同 cursor 并发合并:同页生成的在飞请求共享同一 Promise(单次上游抓取);
 * - 已生成页重放不变:页快照冻结存储,重放逐字段同值(含 nextCursor/expiresAt);
 * - 预算:上游总期限 8s(search.totalTimeoutMs,各源共享同一 deadline)、并发 3
 *   (search.concurrency)、每页 20、会话累计最多 2000 结果、TTL 10min
 *   (cache.ttlMs);数值全部取 VodRuntimeConfig/VOD_BUDGETS 与 api §2 契约常量;
 * - 响应区分:无启用源/全源失败 → 502;全部超时 → 504;部分失败 → 200
 *   partial=true + reasons;全部成功但 0 条 → 200 空页(非 partial);
 * - 会话/游标失效 → 410 VOD_SEARCH_EXPIRED;缺 cursor 重放第一页;
 * - 搜索不物化、不建个人记录:零 ONLINE_VOD_STORE/事务面消费,零 DB 写。
 *
 * 010 契约 502/504/429 载荷码:openapi 仅以 UpstreamFailed502/GatewayTimeout504
 * 与「超出缓存/工作队列上限明确 429」锁定 status,未锁专名;本文件
 * VOD_UPSTREAM_PROBLEM_CODES 为过渡登记点(对齐 PC_005_PROBLEM_CODES 惯例,
 * 共享包收编时迁移),detail 一律静态脱敏文案,不携带上游地址/源配置 ID。
 */

// 010 恢复:PcProblemCode 为 domain-error 导出的类型;ProblemCode 常量值取自 @hmp/shared
import { DomainError, type PcProblemCode } from '@platform/http-common/domain-error';
import { ProblemCode } from '@hmp/shared';
import type {
  PublicVodCardValues,
  VodSearchPageSnapshot,
  VodSourceConfigurationPort,
  VodSourceEndpointSnapshot,
  VodSourceSearchStatus,
} from './publication-work-set.port';
import type { ParsedVodSearchItem, ProviderParseError } from '../domain/provider-model';
import type { VodBudgetShape } from '../domain/vod-budgets';
import type { VodCache } from '../infrastructure/vod-cache';

/* ------------------------------------------------------------------ */
/* 契约常量(api.md §2;VOD_BUDGETS 未承载值的过渡登记点)                 */
/* ------------------------------------------------------------------ */

/** 每页条数:api §2「每页20」逐字 */
export const VOD_SEARCH_PAGE_SIZE = 20;

/** 单会话累计结果上限:api §2「最多2000结果」逐字(达到后不再抓取上游) */
export const VOD_SEARCH_MAX_RESULTS = 2000;

/* ------------------------------------------------------------------ */
/* 上游错误/问题码载体                                                   */
/* ------------------------------------------------------------------ */

/**
 * 上游装配侧超时错误(T031 装配 SafeUpstream 时对 SOURCE_IDLE_TIMEOUT/预算性
 * SOURCE_ABORTED/总期限耗尽抛出);服务侧亦按共享 deadline race 独立判定
 * timeout,二者任一命中即 timeout 语义。
 */
export class VodUpstreamTimeoutError extends Error {
  constructor(message = 'VOD 上游读取超出预算时限') {
    super(message);
    this.name = 'VodUpstreamTimeoutError';
  }
}

/** 010 契约 502/504/429 载荷码(过渡登记点;见文件头说明) */
export const VOD_UPSTREAM_PROBLEM_CODES = {
  /** 全源失败/无可用源(含详情上游失败)→ 502 */
  VOD_UPSTREAM_FAILED: 'VOD_UPSTREAM_FAILED',
  /** 全部超时/总期限耗尽 → 504 */
  VOD_UPSTREAM_TIMEOUT: 'VOD_UPSTREAM_TIMEOUT',
  /** 缓存/活对象上限满额(每家庭或进程总字节)→ 429 */
  VOD_CACHE_CAPACITY: 'VOD_CACHE_CAPACITY',
} as const;

export type VodUpstreamProblemCode = (typeof VOD_UPSTREAM_PROBLEM_CODES)[keyof typeof VOD_UPSTREAM_PROBLEM_CODES];

/** 载荷码 → PcProblemCode(过渡登记;010 契约收编前的唯一通道,cast 不扩散) */
export function vodUpstreamProblemCode(code: VodUpstreamProblemCode): PcProblemCode {
  return code as unknown as PcProblemCode;
}

/** 静态脱敏文案的 502/504/429 构造(不含上游地址/源配置 ID/来源诊断) */
export function vodUpstreamError(code: VodUpstreamProblemCode, detail: string): DomainError {
  const status = code === VOD_UPSTREAM_PROBLEM_CODES.VOD_UPSTREAM_FAILED
    ? 502
    : code === VOD_UPSTREAM_PROBLEM_CODES.VOD_UPSTREAM_TIMEOUT
      ? 504
      : 429;
  return new DomainError(status, vodUpstreamProblemCode(code), detail);
}

/* ------------------------------------------------------------------ */
/* 注入面(上游 provider 函数束;T031 以 SafeUpstream+T025 解析装配)       */
/* ------------------------------------------------------------------ */

/** 单源单页上游搜索请求(装配侧据此走 SafeUpstream 有界读取 + parseSearchList) */
export interface VodSearchUpstreamRequest {
  readonly sourceId: string;
  readonly query: string;
  /** 上游页码(1 起) */
  readonly page: number;
  /** 绝对 deadline(epoch ms);装配侧据此配置 SafeUpstream timeBudgets */
  readonly deadlineMs: number;
  /** 共享 deadline 触发的外部中止信号(取消传播 AbortSignal,契约 §0/§6) */
  readonly signal: AbortSignal;
}

/** 单源单页上游搜索结果(已解析纯值;hasMore=上游还有下一页) */
export interface VodSearchUpstreamPage {
  readonly items: readonly ParsedVodSearchItem[];
  readonly hasMore: boolean;
}

export type VodSearchUpstreamFn = (request: VodSearchUpstreamRequest) => Promise<VodSearchUpstreamPage>;

/** 搜索命令(q 首搜 | searchId+cursor 续页/重放;两组互斥由接口层校验) */
export type VodSearchCommand =
  | { readonly mode: 'query'; readonly householdId: string; readonly query: string }
  | {
      readonly mode: 'page';
      readonly householdId: string;
      readonly searchId: string;
      /** null = 缺 cursor:重放第一页(api §2「缺 cursor 重放第一页」) */
      readonly cursor: string | null;
    };

export interface VodSearchServiceDeps {
  /** 运行期预算(数值来源 VodRuntimeConfig/VOD_BUDGETS;不硬编码裸值) */
  readonly config: VodBudgetShape;
  /** 有界缓存 registry(infrastructure/vod-cache.ts) */
  readonly cache: VodCache;
  /** 来源配置端口(T015 发布面;启用来源清单/locator 读取) */
  readonly sourceConfig: VodSourceConfigurationPort;
  /** 上游搜索函数束(SafeUpstream+解析装配;测试注入 stub) */
  readonly searchUpstream: VodSearchUpstreamFn;
  /** 注入时钟(测试确定性);缺省 Date.now */
  readonly nowMs?: () => number;
}

/* ------------------------------------------------------------------ */
/* 会话状态(缓存载荷;纯数据,进程内存态)                                */
/* ------------------------------------------------------------------ */

/** 已接受条目(去重后;titleRef 为 opaque ref,绑定载荷见 VodTitleBindingPayload) */
interface AcceptedEntry {
  readonly item: ParsedVodSearchItem;
  readonly sourceIndex: number;
  readonly titleRef: string;
  /** 上游未给海报 → null(不签发 ref);有海报 → poster 级不透明 ref */
  readonly posterRef: string | null;
}

/**
 * 搜索会话载荷(vod-cache 条目 payload;Set 以进程内对象存活,字节估算按 JSON
 * 近似,不影响有界性判定方向)。
 */
interface SearchSessionState {
  readonly searchId: string;
  readonly householdId: string;
  readonly query: string;
  /** 轮转后的启用来源(固定顺序自轮转起点) */
  readonly sources: readonly VodSourceEndpointSnapshot[];
  /** 每源不透明 sourceRef(与 sources 同序;api §1 sourceRef 非源配置 ID) */
  readonly sourceRefs: readonly string[];
  /** 去重键集 `${sourceId} ${upstreamVodId}`(api §2「按(source,VOD ID)去重」) */
  readonly dedupeKeys: Set<string>;
  readonly accepted: AcceptedEntry[];
  /** 已消费条目数(续页推进;010 恢复:会话内可变游标,去 readonly) */
  consumedCount: number;
  /** 每源未消费计数(与 accepted 同步维护) */
  readonly remainingBySource: number[];
  /** 每源下一次待抓的上游页码(1 起;首搜成功有下一页时为 2) */
  readonly nextUpstreamPage: number[];
  /** 每源上游是否还有下一页 */
  readonly upstreamHasMore: boolean[];
  /** 每源最近一次状态(仅被实际尝试的源更新) */
  readonly sourceStatus: VodSourceSearchStatus['status'][];
  readonly pages: VodSearchPageSnapshot[];
  readonly sessionExpiresAtMs: number;
}

/** 标题绑定载荷(preview.service 消费;titleRef→内部键只在注册表可逆) */
export interface VodTitleBindingPayload {
  readonly kind: 'title-binding';
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly upstreamVodId: string;
  readonly title: string;
  readonly year: string | null;
  /** 登记时的来源定位器修订(禁源/配置失配判定的 CAS 读数) */
  readonly locatorRevision: number;
  readonly searchId: string;
  /** 上游海报地址(私有定位,绝不进入公共 DTO;上游未给 → null) */
  readonly posterUrl: string | null;
  /** poster 级不透明 ref(posterUrl 为 null 恒 null;随绑定条目同寿) */
  readonly posterRef: string | null;
}

const FAILED_STATUSES: readonly VodSourceSearchStatus['status'][] = ['timeout', 'invalid', 'unavailable'];

function isFailedStatus(status: VodSourceSearchStatus['status']): boolean {
  return FAILED_STATUSES.includes(status);
}

/** 页快照冻结(重放不变:重放返回同一冻结对象,JSON 逐字段同值) */
function freezePage(page: VodSearchPageSnapshot): VodSearchPageSnapshot {
  Object.freeze(page);
  Object.freeze(page.items);
  for (const item of page.items) Object.freeze(item);
  Object.freeze(page.sources);
  for (const source of page.sources) Object.freeze(source);
  Object.freeze(page.reasons);
  return page;
}

/* ------------------------------------------------------------------ */
/* 服务工厂                                                             */
/* ------------------------------------------------------------------ */

/**
 * 创建公共搜索用例。返回面即 T031 控制器接线点:`search(command)`。
 * 同一实例内承担「同 cursor 并发合并」的在飞表(进程内合并语义)。
 */
export function createVodSearchService(deps: VodSearchServiceDeps): {
  search(command: VodSearchCommand): Promise<VodSearchPageSnapshot>;
} {
  const now = deps.nowMs ?? (() => Date.now());

  // 010 恢复:同 cursor 并发合并的在飞表(searchId#pageIndex → 生成 Promise;完成即清除)
  const inflight = new Map<string, Promise<VodSearchPageSnapshot>>();

  /* ---------- 会话持久化(每次变异后重估字节;容纳失败 = 429 资源忙) ---------- */

  function persist(state: SearchSessionState): void {
    const ok = deps.cache.put({
      id: state.searchId,
      householdId: state.householdId,
      kind: 'search',
      sourceIds: state.sources.map((source) => source.sourceId),
      expiresAtMs: state.sessionExpiresAtMs,
      payload: state,
    });
    if (!ok) {
      throw vodUpstreamError(
        VOD_UPSTREAM_PROBLEM_CODES.VOD_CACHE_CAPACITY,
        '搜索缓存已达进程或家庭上限,请稍后重试',
      );
    }
  }

  /** 全部会话状态量构建(轮转起点由缓存 registry 指针给出) */
  function beginSession(householdId: string, query: string): SearchSessionState {
    const enabled = deps.sourceConfig.listEnabledVodSources(householdId);
    if (enabled.length === 0) {
      throw vodUpstreamError(
        VOD_UPSTREAM_PROBLEM_CODES.VOD_UPSTREAM_FAILED,
        '没有可用的在线片源,请在设置中配置并启用来源',
      );
    }
    const start = deps.cache.nextRotationStart(householdId, enabled.length);
    const sources: VodSourceEndpointSnapshot[] = [
      ...enabled.slice(start),
      ...enabled.slice(0, start),
    ];
    const searchId = deps.cache.issueRef('search');
    const state: SearchSessionState = {
      searchId,
      householdId,
      query,
      sources,
      sourceRefs: sources.map(() => deps.cache.issueRef('source')),
      dedupeKeys: new Set(),
      accepted: [],
      consumedCount: 0,
      remainingBySource: sources.map(() => 0),
      nextUpstreamPage: sources.map(() => 1),
      upstreamHasMore: sources.map(() => false),
      sourceStatus: sources.map(() => 'unavailable'),
      pages: [],
      sessionExpiresAtMs: now() + deps.cache.ttlMs,
    };
    return state;
  }

  /* ---------- 上游抓取(共享 deadline + 并发闸 + AbortSignal 传播) ---------- */

  type SourceAttempt =
    | { readonly kind: 'result'; readonly items: readonly ParsedVodSearchItem[]; readonly hasMore: boolean }
    | { readonly kind: 'status'; readonly status: VodSourceSearchStatus['status'] };

  function runOneSource(
    state: SearchSessionState,
    sourceIndex: number,
    upstreamPage: number,
    deadlineMs: number,
  ): Promise<SourceAttempt> {
    const endpoint = state.sources[sourceIndex];
    const remainingMs = deadlineMs - now();
    // 010 恢复:endpoint 缺失(索引越界,不应发生)按 unavailable 收敛,消除 possibly-undefined
    if (remainingMs <= 0 || endpoint === undefined) {
      return Promise.resolve({ kind: 'status', status: endpoint === undefined ? 'unavailable' : 'timeout' });
    }
    const controller = new AbortController();
    let settled = false;
    return new Promise<SourceAttempt>((resolve) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        controller.abort();
        resolve({ kind: 'status', status: 'timeout' });
      }, remainingMs);
      timer.unref?.();
      deps
        .searchUpstream({
          sourceId: endpoint.sourceId,
          query: state.query,
          page: upstreamPage,
          deadlineMs,
          signal: controller.signal,
        })
        .then(
          (page) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({
              kind: 'result',
              items: page.items,
              hasMore: page.hasMore,
            });
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({
              kind: 'status',
              status: classifyUpstreamFailure(error),
            });
          },
        );
    });
  }

  function classifyUpstreamFailure(error: unknown): VodSourceSearchStatus['status'] {
    if (error instanceof VodUpstreamTimeoutError) return 'timeout';
    // T025 解析整体拒绝(信封/完整性/身份/协议)→ invalid;其余传输故障 → unavailable
    if (typeof error === 'object' && error !== null && (error as ProviderParseError).name === 'ProviderParseError') {
      return 'invalid';
    }
    return 'unavailable';
  }

  /** 并发闸内抓取一轮;仅更新被尝试源的状态,返回按源序排列的结果(失败的为 null) */
  async function fetchRound(
    state: SearchSessionState,
    sourceIndexes: readonly number[],
    deadlineMs: number,
  ): Promise<(SourceAttempt | null)[]> {
    const results: (SourceAttempt | null)[] = sourceIndexes.map(() => null);
    let cursor = 0;
    const workerCount = Math.min(deps.config.search.concurrency, sourceIndexes.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < sourceIndexes.length) {
        const slot = cursor;
        cursor += 1;
        const sourceIndex = sourceIndexes[slot];
        if (sourceIndex === undefined) continue;
        const upstreamPage = state.nextUpstreamPage[sourceIndex] ?? 1;
        const attempt = await runOneSource(state, sourceIndex, upstreamPage, deadlineMs);
        results[slot] = attempt;
        // 状态仅被实际尝试的源更新(最新一次为准)
        state.sourceStatus[sourceIndex] =
          attempt.kind === 'status' ? attempt.status : attempt.items.length > 0 ? 'ok' : 'empty';
      }
    });
    await Promise.all(workers);
    return results;
  }

  /** 一轮结果并入会话缓冲(轮转顺序拼接 + (source, VOD ID) 去重 + 2000 上限) */
  function mergeRound(state: SearchSessionState, round: (SourceAttempt | null)[], sourceIndexes: readonly number[]): void {
    for (let slot = 0; slot < round.length; slot += 1) {
      const attempt = round[slot];
      // 010 恢复:undefined(空洞)/null/非 result 一并跳过,先收敛再取 result 字段
      if (attempt === undefined || attempt === null || attempt.kind !== 'result') continue;
      const sourceIndex = sourceIndexes[slot];
      if (sourceIndex === undefined) continue;
      state.upstreamHasMore[sourceIndex] = attempt.hasMore;
      state.nextUpstreamPage[sourceIndex] = (state.nextUpstreamPage[sourceIndex] ?? 1) + (attempt.hasMore ? 1 : 0);
      for (const item of attempt.items) {
        if (state.accepted.length >= VOD_SEARCH_MAX_RESULTS) return;
        const sourceId = state.sources[sourceIndex]?.sourceId ?? '';
        const dedupeKey = `${sourceId} ${item.identity.upstreamVodId}`;
        if (state.dedupeKeys.has(dedupeKey)) continue;
        state.dedupeKeys.add(dedupeKey);
        const titleRef = deps.cache.allocateRef(state.searchId, `title:${dedupeKey}`, 'title');
        // 海报 ref:仅在上游给了海报地址时签发(p 级 opaque ref;**绑定在 titleRef 条目**,
        // 随标题绑定的淘汰/失效级联清除,与会话 ref 解耦)
        const posterRef =
          item.posterUrl !== null ? deps.cache.allocateRef(titleRef, `poster:${dedupeKey}`, 'poster') : null;
        state.accepted.push({ item, sourceIndex, titleRef, posterRef });
        state.remainingBySource[sourceIndex] = (state.remainingBySource[sourceIndex] ?? 0) + 1;
        // 标题绑定登记(独立 10min TTL,与搜索会话同寿;titleRef 失效=410 而非 404)
        const bound = deps.cache.put<VodTitleBindingPayload>({
          id: titleRef,
          householdId: state.householdId,
          kind: 'preview',
          sourceIds: [sourceId],
          expiresAtMs: state.sessionExpiresAtMs,
          payload: {
            kind: 'title-binding',
            sourceId,
            sourceLabel: state.sources[sourceIndex]?.name ?? '',
            upstreamVodId: item.identity.upstreamVodId,
            title: item.title,
            year: item.year,
            locatorRevision: state.sources[sourceIndex]?.locatorRevision ?? 0,
            searchId: state.searchId,
            posterUrl: item.posterUrl,
            posterRef,
          },
        });
        if (!bound) {
          throw vodUpstreamError(
            VOD_UPSTREAM_PROBLEM_CODES.VOD_CACHE_CAPACITY,
            '预览缓存已达家庭上限,请稍后重试',
          );
        }
      }
    }
  }

  /* ---------- 页构建/重放 ---------- */

  function buildPage(state: SearchSessionState, pageIndex: number): VodSearchPageSnapshot {
    const slice = state.accepted.slice(state.consumedCount, state.consumedCount + VOD_SEARCH_PAGE_SIZE);
    state.consumedCount += slice.length;
    // 010 恢复:消费推进同步扣减每源未消费计数(sources[].hasMore 的「缓冲仍有货」依据)
    for (const entry of slice) {
      const remaining = state.remainingBySource[entry.sourceIndex];
      if (remaining !== undefined && remaining > 0) {
        state.remainingBySource[entry.sourceIndex] = remaining - 1;
      }
    }
    const remainingGlobal = state.accepted.length - state.consumedCount;

    const sources: VodSourceSearchStatus[] = state.sources.map((_source, index) => ({
      // api §1「sourceRef 不透明,无源配置 ID」:载荷为 opaque sourceRef
      sourceId: state.sourceRefs[index] ?? '',
      status: state.sourceStatus[index] ?? 'unavailable',
      hasMore:
        state.remainingBySource[index] !== undefined && state.remainingBySource[index] > 0
          ? true
          : state.upstreamHasMore[index] === true,
    }));
    const partial = state.sourceStatus.some(isFailedStatus);
    const reasons = state.sourceStatus.flatMap((status, index) =>
      isFailedStatus(status) ? [`${state.sourceRefs[index]}@${status}`] : [],
    );

    // 010 恢复:2000 上限语义是「达到后不再抓取上游」——已接受未消费缓冲仍应
    // 续页发完(最多 2000 结果全量可分页),上限只终结新的上游抓取
    const canContinue =
      remainingGlobal > 0 ||
      (state.upstreamHasMore.some((hasMore) => hasMore) && state.accepted.length < VOD_SEARCH_MAX_RESULTS);
    const nextCursor = canContinue
      ? deps.cache.allocateRef(state.searchId, `page:${pageIndex + 1}`, 'cursor')
      : null;

    const page: VodSearchPageSnapshot = {
      searchId: state.searchId,
      items: slice.map((entry): PublicVodCardValues => ({
        titleRef: entry.titleRef,
        title: entry.item.title,
        year: entry.item.year,
        sourceLabel: state.sources[entry.sourceIndex]?.name ?? '',
        posterRef: entry.posterRef,
      })),
      sources,
      nextCursor,
      partial,
      reasons,
      expiresAt: new Date(state.sessionExpiresAtMs).toISOString(),
    };
    state.pages[pageIndex] = freezePage(page);
    persist(state);
    return page;
  }

  /** 已生成页重放(逐字段不变);未生成页返回 null 交由生成路径 */
  function replayPage(state: SearchSessionState, pageIndex: number): VodSearchPageSnapshot | null {
    const page = state.pages[pageIndex];
    return page === undefined ? null : page;
  }

  /* ---------- 主流程 ---------- */

  function requireSession(householdId: string, searchId: string): SearchSessionState {
    const view = deps.cache.get<SearchSessionState>(searchId);
    // 未知/跨家庭/类别不符与已过期同以 410 VOD_SEARCH_EXPIRED 拒绝(ref 失效语义;
    // 公共面无存在性泄露差异——恢复动作同为「保留 q 重新搜索」)
    const payload = view?.payload as SearchSessionState | undefined;
    if (
      view === undefined ||
      view.expired ||
      view.householdId !== householdId ||
      view.kind !== 'search' ||
      payload?.searchId !== searchId
    ) {
      throw new DomainError(410, ProblemCode.VOD_SEARCH_EXPIRED, '搜索已过期,请保留关键词重新搜索');
    }
    return payload;
  }

  function resolvePageIndex(state: SearchSessionState, cursor: string | null): number {
    if (cursor === null || cursor === '') return 0;
    const resolved = deps.cache.resolveRef(cursor);
    // 伪造/他会话/越界游标一律 410(openapi「搜索/游标失效;保留 q 重新搜索」)
    if (resolved === undefined || resolved.entryId !== state.searchId) {
      throw new DomainError(410, ProblemCode.VOD_SEARCH_EXPIRED, '分页游标已失效,请保留关键词重新搜索');
    }
    const match = /^page:(\d+)$/.exec(resolved.local);
    const pageIndex = match === null ? Number.NaN : Number.parseInt(match[1] ?? '', 10);
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 1 || pageIndex > state.pages.length) {
      throw new DomainError(410, ProblemCode.VOD_SEARCH_EXPIRED, '分页游标已失效,请保留关键词重新搜索');
    }
    return pageIndex;
  }

  /** 全部被尝试源皆失败 → 502(全源失败/无可用源)或 504(全部超时);出结果源视为成功 */
  function throwIfAllFailed(attemptedStatuses: readonly VodSourceSearchStatus['status'][]): void {
    if (attemptedStatuses.length === 0 || attemptedStatuses.some((status) => !isFailedStatus(status))) {
      return;
    }
    if (attemptedStatuses.every((status) => status === 'timeout')) {
      throw vodUpstreamError(VOD_UPSTREAM_PROBLEM_CODES.VOD_UPSTREAM_TIMEOUT, '上游搜索总期限耗尽,请稍后重试');
    }
    throw vodUpstreamError(VOD_UPSTREAM_PROBLEM_CODES.VOD_UPSTREAM_FAILED, '全部在线片源搜索失败,请稍后重试');
  }

  /** 一轮逐源判定:出结果(含 0 条)= ok/empty 成功;失败源取其状态;空洞跳过 */
  function roundSourceStatuses(round: (SourceAttempt | null)[]): VodSourceSearchStatus['status'][] {
    return round.flatMap((attempt) => {
      if (attempt === undefined || attempt === null) return [];
      // 010 恢复:成功抓取(哪怕 0 条)必须计为非失败,否则部分健康场景被误判全失败
      return attempt.kind === 'status' ? [attempt.status] : ['ok'];
    });
  }

  async function search(command: VodSearchCommand): Promise<VodSearchPageSnapshot> {
    if (command.mode === 'query') {
      const query = command.query.trim();
      if (query.length === 0) {
        throw new DomainError(400, ProblemCode.VALIDATION_FAILED, '搜索关键词不能为空');
      }
      const state = beginSession(command.householdId, query);
      persist(state);
      const deadlineMs = now() + deps.config.search.totalTimeoutMs;
      const sourceIndexes = state.sources.map((_source, index) => index);
      const round = await fetchRound(state, sourceIndexes, deadlineMs);
      throwIfAllFailed(roundSourceStatuses(round));
      mergeRound(state, round, sourceIndexes);
      persist(state);
      return buildPage(state, 0);
    }

    /* ---- searchId+cursor:重放/续页 ---- */
    const state = requireSession(command.householdId, command.searchId);
    const pageIndex = resolvePageIndex(state, command.cursor);
    const replayed = replayPage(state, pageIndex);
    if (replayed !== null) return replayed;

    // 已生成页重放不变;同 cursor 并发合并:同页在飞生成共享同一 Promise
    const inflightKey = `${state.searchId}#${pageIndex}`;
    const pending = inflight.get(inflightKey);
    if (pending !== undefined) return pending;

    const generation = (async (): Promise<VodSearchPageSnapshot> => {
      if (state.accepted.length - state.consumedCount > 0) {
        // 未消费结果保留:缓冲续页,不抓上游
        return buildPage(state, pageIndex);
      }
      const attempts = state.sources
        .map((_source, index) => index)
        .filter((index) => state.upstreamHasMore[index] === true);
      if (attempts.length === 0) {
        throw new DomainError(410, ProblemCode.VOD_SEARCH_EXPIRED, '分页游标已失效,请保留关键词重新搜索');
      }
      const deadlineMs = now() + deps.config.search.totalTimeoutMs;
      const round = await fetchRound(state, attempts, deadlineMs);
      throwIfAllFailed(roundSourceStatuses(round));
      mergeRound(state, round, attempts);
      if (state.accepted.length - state.consumedCount === 0) {
        // 上游宣告有下一页但本轮 0 新条目:避免空转,按耗尽处理
        for (const index of attempts) state.upstreamHasMore[index] = false;
      }
      persist(state);
      return buildPage(state, pageIndex);
    })();

    inflight.set(inflightKey, generation);
    try {
      return await generation;
    } finally {
      inflight.delete(inflightKey);
    }
  }

  return { search };
}
