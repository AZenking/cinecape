/**
 * 010 T070 — 换源候选用例(application):已授权 fromSession 可信标题 → 多源搜索 →
 * matchCandidate 评分 → opaque 具体候选集(60s TTL/cursor 分页/partial/reasons)。
 *
 * 纯函数模块惯例(对齐 search/preview.service):依赖经参数注入函数束
 * (SwitchCandidatesServiceDeps,供 T071/T072 装配)——来源配置经
 * VodSourceConfigurationPort、有界缓存经 VodCache、上游读取经注入的
 * VodSearchUpstreamFn/VodDetailUpstreamFn(T028 上游装配面形态;网络在事务外,
 * 本服务零 DB 写、零会话写、零历史写);来源授权经 PlaybackTransitionSourcePort
 * 形态端口(internal-ports.md §1:playback 所有,「终态也可读合法来源上下文,不会
 * 重新授权旧源媒体交付」;本服务消费 T059 transition-source-context 的同上下文
 * 只读授权产物,终态/恢复窗判定在本服务)。
 *
 * 行为契约(逐行即语义,docs/specs/010-online-vod/contracts/api.md §5 换源行 +
 * tasks.md T070 原文):
 * - 不接受任意 q/URL:命令面只有 fromSessionId/expectedGeneration/cursor——搜索词
 *   恒由服务端从已授权来源会话的可信标题事实(canonicalName)构造,类型面无
 *   q/URL/客户端候选/列表下标字段(T070「不接受任意q/URL」);
 * - 授权序:同上下文只读来源授权(404 同形,port 语义)→ 代次校验(expectedGeneration
 *   ≠ 当前 generation → 409 PLAYBACK_GENERATION_STALE)→ 终态门(仅 ended/failed
 *   可列候选,其余 409 SOURCE_NOT_TERMINAL——「正常switch旧来源必须先stop到ended」)
 *   → failed 恢复窗(endedAt 起 60s 内可列,恰界/无时刻即过期 → 410 TRANSITION_
 *   EXPIRED——T070「可恢复failed仅60s」,与 SWITCH_CANDIDATE_TTL_MS 同族常量);
 * - 候选集合:全部启用源 × 检索命中标题 × 锚定集所在线(每 (源,标题,线,集) 一个
 *   候选;与来源自身相同 (sourceId, upstreamVodId) 的整题剔除 —— api §5/FR-029
 *   「当前线路和跨来源」,010 T070 修复);锚定 = 候选详情内集键与来源可信集键相等的
 *   candidate 集(每线至多一锚;来源集键 null 时取该线首个 candidate 集为锚,季集
 *   位由匹配面按缺字段降歧义,不猜等价);无锚定集的标题整题跳过——「返回opaque
 *   具体集」:候选必须绑定准确 title/episode 键(api §7 I1),不造「无具体集」候选;
 * - 评分:候选事实按 T025 解析面投影(upstreamVodId/canonicalName=detail.title/
 *   year=detail.year/knownVersionLabel=identity.version;解析面无季/语言字段 →
 *   seasonKey/languageVersion 恒 null,不自动制造),经 domain matchCandidate 判定,
 *   结论(confidence/reasons/规则版本)逐候选原样下发,不改写、不提升;
 * - opaque 签发(登记形态选型,本条即选型结论):candidateRef 经 VodCache
 *   allocateRef 签发并绑定本列列表(注册表可逆,ref→内部键不可解码,T028 同形态);
 *   候选私有绑定(源/上游键/线集键/定位物料/候选溯源)以 'preview' 条目存同一
 *   registry,TTL=SWITCH_CANDIDATE_TTL_MS;intent 只接受已登记目标
 *   (registeredCandidateRef)的映射,登记发生在物化事务(T029 materialize 候选
 *   分支 registerCandidateMapping 已落地)——本服务发布绑定,不预登记
 *   registered_candidate(data-model §10:登记行含目标 media/修订/物化 operation,
 *   列候选时尚不存在);
 * - 分页:每页 20(对齐 api §2 搜索页族),游标 opaque(cache 注册表可逆,绑定本列
 *   列表);缺 cursor 即新列(重新授权+重新搜索);已生成页重放逐字段不变;列过期
 *   (60s)后 cursor 410 VOD_SEARCH_EXPIRED;
 * - partial/reasons:源失败汇总(源 ref 为本列签发的 opaque ref,reasons 形如
 *   `<sourceRef>@<status>`,不下发源配置 ID);单源搜索成功但其全部候选详情抓取
 *   失败 → 该源降级 unavailable;全部被尝试源失败 → 502(全源失败)/504(全部超时);
 * - 预算:上游总期限 search.totalTimeoutMs(搜索+详情共享同一 deadline)、并发
 *   search.concurrency、单详情字节预算 preview.maxBytes——数值全部取运行配置
 *   (VodBudgetShape),不硬编码裸值。
 */

// 010 惯例:DomainError 取自 domain-error;ProblemCode 常量值取自 @hmp/shared
import { DomainError } from '@platform/http-common/domain-error';
import { ProblemCode } from '@hmp/shared';
import type { VodSourceConfigurationPort } from './publication-work-set.port';
import type { OnlineVodStore } from './online-vod-store.port';
import {
  SWITCH_CANDIDATE_TTL_MS,
  isSwitchCandidateFresh,
  matchCandidate,
  type CandidateFacts,
  type MatchConfidence,
  type MatchReason,
  type SourceTitleFacts,
} from '../domain/source-match.rules';
import type { ParsedVodSearchItem, ParsedVodTitleDetail } from '../domain/provider-model';
import type { VodBudgetShape } from '../domain/vod-budgets';
import type { VodCache } from '../infrastructure/vod-cache';
import {
  VOD_SEARCH_PAGE_SIZE,
  VOD_UPSTREAM_PROBLEM_CODES,
  vodUpstreamError,
  type VodSearchUpstreamFn,
} from './search.service';
import type { VodDetailUpstreamFn } from './preview.service';

/* ------------------------------------------------------------------ */
/* 来源授权端口(PlaybackTransitionSourcePort 消费形态;实现由 playback 侧装配) */
/* ------------------------------------------------------------------ */

/** 只读来源授权请求(调用方当前身份;服务端推导,绝不取自请求体) */
export interface SwitchSourceContextRequest {
  readonly householdId: string;
  /** 当前设备会话(必须与来源会话同设备;T059 同上下文校验语义) */
  readonly deviceSessionId: string;
  /** 当前 Profile(必须与来源会话同 Profile) */
  readonly profileId: string;
  /** 当前身份上下文版本(A→B→A 不等即 404) */
  readonly profileContextVersion: number;
  /** 来源播放会话 id */
  readonly fromSessionId: string;
}

/**
 * 只读来源上下文事实(授权成功产物;与 T059 ReadonlyTransitionSourceContext 的
 * 判定字段子集结构相容——装配侧直传该服务即可)。零票据/交付/私有地址材料。
 */
export interface SwitchSourceContextFacts {
  readonly fromSessionId: string;
  readonly generation: number;
  readonly state: string;
  readonly mediaId: string;
  readonly endedAt: string | null;
}

/**
 * 过渡来源只读端口(PlaybackTransitionSourcePort 消费面;所有者 playback,
 * internal-ports.md §1)。实现即 T059 TransitionSourceContextService
 * (authorizeReadonlySourceContext;同上下文校验 + 404 同形,不重发源票)。
 */
export interface PlaybackTransitionSourcePort {
  authorizeReadonlySourceContext(request: SwitchSourceContextRequest): SwitchSourceContextFacts;
}

/**
 * 来源可信标题事实读取钩子(装配面注入;T071 接线点):由 vod store 物化事实
 * (+continuitySignature/目录标题)投影 api §5 的「已授权 fromSession 可信标题」。
 * 契约:mediaId 非已物化 VOD 子项 → undefined(本服务映射 404 同形);canonicalName
 * 归一后为空 → undefined(缺关键字段不自动制造「内容一致」,data-model §3)。
 */
export type SwitchSourceTitleFactsLoader = (
  householdId: string,
  mediaId: string,
) => SourceTitleFacts | undefined;

/* ------------------------------------------------------------------ */
/* 命令/响应纯值(api §5 200 形态;与冻结 DTO 逐字段对齐)                  */
/* ------------------------------------------------------------------ */

/** 换源候选命令(Profile+原设备上下文由守卫推导;面内无 q/URL/候选/下标字段) */
export interface SwitchCandidatesCommand {
  readonly householdId: string;
  readonly deviceSessionId: string;
  readonly profileId: string;
  readonly profileContextVersion: number;
  readonly fromSessionId: string;
  readonly expectedGeneration: number;
  /** 缺省/null = 新列(第一页);否则为既有列的续页/重放游标 */
  readonly cursor?: string | null;
}

/** 单个换源候选(api §1 SwitchCandidate;只元数据,source 内部 ID/位置不下发) */
export interface SwitchCandidateValues {
  readonly candidateRef: string;
  readonly title: string;
  /** 候选锚定集显示名 */
  readonly label: string;
  readonly year: string | null;
  /** 候选季(T025 解析面无季字段 → 恒 null,不自动制造) */
  readonly season: string | null;
  readonly versionLabel: string | null;
  readonly sourceLabel: string;
  readonly lineLabel: string;
  readonly matchConfidence: MatchConfidence;
  readonly matchReasons: readonly MatchReason[];
  readonly previewRevision: number;
  readonly expiresAt: string;
}

/** 换源候选页(api §5 200:{items,nextCursor,partial,reasons} + 列表到期时刻) */
export interface SwitchCandidatesPage {
  readonly items: readonly SwitchCandidateValues[];
  readonly nextCursor: string | null;
  readonly partial: boolean;
  readonly reasons: readonly string[];
  readonly expiresAt: string;
}

/* ------------------------------------------------------------------ */
/* 候选私有绑定(api §7 I1 candidateRef 绑定的发布形态;绝不进公共 DTO)     */
/* ------------------------------------------------------------------ */

/** 候选绑定内单线定位物料(物化 resolver 的 validatedPrivatePayload 原料) */
export interface VodCandidateLineMaterial {
  readonly lineKey: string;
  readonly lineLabel: string;
  readonly episodes: readonly {
    readonly episodeKey: string;
    readonly label: string;
    /** 上游定位地址逐字透传(私有;T042 定位消费) */
    readonly locatorUrl: string | null;
  }[];
}

/**
 * 候选绑定载荷(vod-cache 'preview' 条目;candidateRef → 内部键只在注册表可逆):
 * 服务端记录绑定家庭条目归属、来源(源/上游/线/集键)、预览修订、候选溯源
 * (原 session/generation,api §7 I1)与匹配结论;定位地址为私有面。
 * 物化候选分支(T029)经装配层 resolver 消费本载荷构造 ResolvedMaterializationTarget
 * 与 CandidateProvenance,并同事务登记 registeredCandidateRef。
 */
export interface VodCandidateBindingPayload {
  readonly kind: 'candidate-binding';
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly upstreamVodId: string;
  readonly lineKey: string;
  readonly lineLabel: string;
  readonly episodeKey: string;
  readonly episodeLabel: string;
  readonly title: string;
  readonly year: string | null;
  /** 登记时的来源定位器修订(禁源/配置失配判定的 CAS 读数) */
  readonly locatorRevision: number;
  readonly previewRevision: number;
  readonly fetchedAtMs: number;
  readonly matchConfidence: MatchConfidence;
  readonly matchReasons: readonly MatchReason[];
  readonly matchRuleVersion: string;
  /** 候选溯源:原来源播放会话与代次(api §7 I1「来源session/generation」) */
  readonly fromSessionId: string;
  readonly sourceGeneration: number;
  readonly lines: readonly VodCandidateLineMaterial[];
}

/* ------------------------------------------------------------------ */
/* 依赖注入面(T071/T072 组合根装配;测试注入受控 stub)                    */
/* ------------------------------------------------------------------ */

export interface SwitchCandidatesServiceDeps {
  /** 运行期预算(数值来源 VodRuntimeConfig/VOD_BUDGETS;不硬编码裸值) */
  readonly config: VodBudgetShape;
  /** 有界缓存 registry(infrastructure/vod-cache.ts;opaque ref 签发/候选绑定载体) */
  readonly cache: VodCache;
  /** 来源配置端口(T015 发布面;启用来源清单) */
  readonly sourceConfig: VodSourceConfigurationPort;
  /** 上游搜索函数束(T028 形态;SafeUpstream+解析装配;测试注入 stub) */
  readonly searchUpstream: VodSearchUpstreamFn;
  /** 上游详情函数束(T028 形态;测试注入 stub) */
  readonly fetchDetailUpstream: VodDetailUpstreamFn;
  /** 过渡来源只读端口(playback 所有;T059 transition-source-context 装配) */
  readonly transitionSource: PlaybackTransitionSourcePort;
  /** 来源可信标题事实读取钩子(vod store 物化事实投影;见类型注释) */
  readonly loadSourceTitleFacts: SwitchSourceTitleFactsLoader;
  /** 非事务读面(已物化标题映射读数;预览修订对齐;零写) */
  readonly store: OnlineVodStore;
  /** 注入时钟(测试确定性);缺省 Date.now */
  readonly nowMs?: () => number;
}

/* ------------------------------------------------------------------ */
/* 列表状态(缓存载荷;纯数据,进程内存态)                                 */
/* ------------------------------------------------------------------ */

/** 已接受候选(签发 ref + 公共值;绑定载荷另存 'preview' 条目) */
interface AcceptedSwitchCandidate {
  readonly candidateRef: string;
  readonly values: SwitchCandidateValues;
}

/** 换源候选列表状态(vod-cache 'search' 条目 payload;TTL=SWITCH_CANDIDATE_TTL_MS) */
interface SwitchListingState {
  readonly listingId: string;
  readonly householdId: string;
  readonly deviceSessionId: string;
  readonly profileId: string;
  readonly profileContextVersion: number;
  readonly fromSessionId: string;
  readonly fromGeneration: number;
  /** 每启用源一个不透明 sourceRef(reasons 载体;与启用源配置顺序同序) */
  readonly sourceRefs: readonly string[];
  /** 源失败汇总(列级,构建时一次定格;逐页一致) */
  readonly partial: boolean;
  readonly reasons: readonly string[];
  readonly accepted: readonly AcceptedSwitchCandidate[];
  /** 已消费条目数(续页推进;列内可变游标) */
  consumedCount: number;
  /** 已生成页快照(重放逐字段不变) */
  readonly pages: (SwitchCandidatesPage | undefined)[];
  readonly expiresAtMs: number;
}

/** 单源状态(VodSourceSearchStatus.status 词表;源失败汇总口径与 T028 一致) */
type SwitchSourceStatus = 'ok' | 'empty' | 'timeout' | 'invalid' | 'unavailable';

const FAILED_STATUSES: readonly SwitchSourceStatus[] = ['timeout', 'invalid', 'unavailable'];

function isFailedStatus(status: SwitchSourceStatus): boolean {
  return FAILED_STATUSES.includes(status);
}

/** 页快照冻结(重放不变:重放返回同一冻结对象,逐字段同值) */
function freezeSwitchPage(page: SwitchCandidatesPage): SwitchCandidatesPage {
  Object.freeze(page);
  Object.freeze(page.items);
  for (const item of page.items) Object.freeze(item);
  Object.freeze(page.reasons);
  return page;
}

/* ------------------------------------------------------------------ */
/* 服务工厂                                                             */
/* ------------------------------------------------------------------ */

/**
 * 创建换源候选用例。返回面即 T071 控制器接线点:`listCandidates(command)`。
 * 候选绑定注册表随 VodCache 单例生存(TTL 惰性判定 + 显式 sweep)。
 */
export function createSwitchCandidatesService(deps: SwitchCandidatesServiceDeps): {
  listCandidates(command: SwitchCandidatesCommand): Promise<SwitchCandidatesPage>;
} {
  const now = deps.nowMs ?? (() => Date.now());

  /** 新标题预览修订计数(家庭×源×上游 ID 粒度,单调递增;进程内存态) */
  const freshRevisions = new Map<string, number>();

  /* ---------- 授权链(每次调用执行,含 cursor 重放) ---------- */

  /**
   * 授权序(文件头):同上下文只读授权(404 同形,port)→ 代次(409)→ 终态门
   * (409)→ failed 恢复窗(410)。授权失败优先于专用错误(api §0),不可借错误
   * 判别旧会话存在性。
   */
  function authorizeSwitchSource(command: SwitchCandidatesCommand): SwitchSourceContextFacts {
    const context = deps.transitionSource.authorizeReadonlySourceContext({
      householdId: command.householdId,
      deviceSessionId: command.deviceSessionId,
      profileId: command.profileId,
      profileContextVersion: command.profileContextVersion,
      fromSessionId: command.fromSessionId,
    });
    if (command.expectedGeneration !== context.generation) {
      throw new DomainError(409, ProblemCode.PLAYBACK_GENERATION_STALE, '来源会话代次已过期,请重建播放');
    }
    if (context.state === 'failed') {
      // 「failed可恢复来源仅60s」:endedAt 起 60s 窗;恰界/无时刻即过期(与候选
      // TTL 同族常量 SWITCH_CANDIDATE_TTL_MS;isSwitchCandidateFresh 同口径)
      const failedAtMs = context.endedAt === null ? null : Date.parse(context.endedAt);
      const withinWindow =
        failedAtMs !== null &&
        isSwitchCandidateFresh({ expiresAtMs: failedAtMs + SWITCH_CANDIDATE_TTL_MS }, now());
      if (!withinWindow) {
        throw new DomainError(410, ProblemCode.TRANSITION_EXPIRED, 'failed 来源已超出可恢复窗口,请重新解析播放');
      }
      return context;
    }
    if (context.state !== 'ended') {
      // 「正常switch旧来源必须先stop到ended」:活动/未终态来源不列候选(409 同形,
      // 不泄露具体活动态)
      throw new DomainError(409, ProblemCode.SOURCE_NOT_TERMINAL, '来源尚未停止,请先停止当前播放');
    }
    return context;
  }

  /* ---------- 列表状态持久化(每次变异后重估字节;容纳失败 = 429 资源忙) ---------- */

  function persist(state: SwitchListingState, sourceIds: readonly string[]): void {
    const ok = deps.cache.put({
      id: state.listingId,
      householdId: state.householdId,
      kind: 'search',
      sourceIds: [...sourceIds],
      expiresAtMs: state.expiresAtMs,
      payload: state,
    });
    if (!ok) {
      throw vodUpstreamError(
        VOD_UPSTREAM_PROBLEM_CODES.VOD_CACHE_CAPACITY,
        '换源候选缓存已达进程或家庭上限,请稍后重试',
      );
    }
  }

  /* ---------- 页构建/重放(对齐 T028:已生成页冻结,续页只切缓冲) ---------- */

  function buildPage(state: SwitchListingState, pageIndex: number): SwitchCandidatesPage {
    const slice = state.accepted.slice(state.consumedCount, state.consumedCount + VOD_SEARCH_PAGE_SIZE);
    state.consumedCount += slice.length;
    const remaining = state.accepted.length - state.consumedCount;
    const nextCursor =
      remaining > 0 ? deps.cache.allocateRef(state.listingId, `page:${pageIndex + 1}`, 'cursor') : null;
    const page: SwitchCandidatesPage = {
      items: slice.map((entry) => entry.values),
      nextCursor,
      partial: state.partial,
      reasons: state.reasons,
      expiresAt: new Date(state.expiresAtMs).toISOString(),
    };
    state.pages[pageIndex] = freezeSwitchPage(page);
    return page;
  }

  function loadListingState(householdId: string, cursor: string): SwitchListingState {
    const resolved = deps.cache.resolveRef(cursor);
    // 伪造/他会话/越界游标与已过期列同以 410 拒绝(ref 失效语义;恢复动作同为重新取候选)
    const listingId = resolved === undefined ? undefined : resolved.entryId;
    const view = listingId === undefined ? undefined : deps.cache.get<SwitchListingState>(listingId);
    const payload = view?.payload as SwitchListingState | undefined;
    if (
      listingId === undefined ||
      view === undefined ||
      view.expired ||
      view.householdId !== householdId ||
      view.kind !== 'search' ||
      payload?.listingId !== listingId
    ) {
      throw new DomainError(410, ProblemCode.VOD_SEARCH_EXPIRED, '换源候选列表已过期,请重新获取候选');
    }
    return payload;
  }

  function resolvePageIndex(state: SwitchListingState, cursor: string): number {
    const resolved = deps.cache.resolveRef(cursor);
    if (resolved === undefined || resolved.entryId !== state.listingId) {
      throw new DomainError(410, ProblemCode.VOD_SEARCH_EXPIRED, '分页游标已失效,请重新获取候选');
    }
    const match = /^page:(\d+)$/.exec(resolved.local);
    const pageIndex = match === null ? Number.NaN : Number.parseInt(match[1] ?? '', 10);
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 1 || pageIndex > state.pages.length) {
      throw new DomainError(410, ProblemCode.VOD_SEARCH_EXPIRED, '分页游标已失效,请重新获取候选');
    }
    return pageIndex;
  }

  /* ---------- 候选详情导航(锚定集选取;解析面见文件头「候选集合」) ---------- */

  interface AnchoredEpisode {
    readonly lineKey: string;
    readonly lineLabel: string;
    readonly episodeKey: string;
    readonly episodeLabel: string;
    readonly locatorUrl: string | null;
  }

  /**
   * 单标题锚定集:每线取「集键与来源可信集键相等」的 candidate 集(来源集键 null
   * 时取该线首个 candidate 集为锚,季集位由匹配面按缺字段降歧义,不猜等价);
   * 无锚定集的线跳过;整题无线命中 → 空数组(不造「无具体集」候选)。
   */
  function anchorEpisodesOf(detail: ParsedVodTitleDetail, sourceEpisodeKey: string | null): AnchoredEpisode[] {
    const anchors: AnchoredEpisode[] = [];
    for (const line of detail.lines) {
      if (line.lineKey === null) continue;
      const playable = line.episodes.filter(
        (episode) => episode.status === 'candidate' && episode.episodeKey !== null,
      );
      const anchored =
        sourceEpisodeKey === null
          ? playable[0]
          : playable.find((episode) => episode.episodeKey === sourceEpisodeKey);
      if (anchored === undefined || anchored.episodeKey === null) continue;
      anchors.push({
        lineKey: line.lineKey,
        lineLabel: line.displayName,
        episodeKey: anchored.episodeKey,
        episodeLabel: anchored.label,
        locatorUrl: anchored.locatorUrl ?? null,
      });
    }
    return anchors;
  }

  /** 候选定位物料(全部线/集的键与私有地址;物化 resolver 原料) */
  function lineMaterialsOf(detail: ParsedVodTitleDetail): VodCandidateLineMaterial[] {
    return detail.lines
      .filter((line) => line.lineKey !== null)
      .map((line) => ({
        lineKey: line.lineKey ?? '',
        lineLabel: line.displayName,
        episodes: line.episodes
          .filter((episode) => episode.episodeKey !== null)
          .map((episode) => ({
            episodeKey: episode.episodeKey ?? '',
            label: episode.label,
            locatorUrl: episode.locatorUrl ?? null,
          })),
      }));
  }

  /* ---------- 有界上游读取(共享 deadline + 并发闸,对齐 T028 手法) ---------- */

  /** deadline 收敛占位(runBounded 内部;与任务失败 undefined 区分,供 timeout 分类) */
  const DEADLINE_PLACEHOLDER: unique symbol = Symbol('vod-switch-candidates-deadline');

  /**
   * 并发闸内执行全部任务;共享 deadline 到点即以占位收敛该任务(携 abort 信号;
   * 上游拒绝经占位统一按失败消费,不排队不无界等待)。占位 ≠ undefined:
   * DEADLINE_PLACEHOLDER=总期限耗尽(timeout 语义),undefined=任务自身失败。
   */
  async function runBounded<T>(
    tasks: readonly ((signal: AbortSignal) => Promise<T>)[],
    deadlineMs: number,
  ): Promise<(T | typeof DEADLINE_PLACEHOLDER | undefined)[]> {
    const results: (T | typeof DEADLINE_PLACEHOLDER | undefined)[] = new Array(tasks.length);
    let cursor = 0;
    const workerCount = Math.max(1, Math.min(deps.config.search.concurrency, tasks.length));
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < tasks.length) {
        const slot = cursor;
        cursor += 1;
        const task = tasks[slot];
        if (task === undefined) continue;
        const remainingMs = deadlineMs - now();
        const controller = new AbortController();
        if (remainingMs <= 0) {
          controller.abort();
          results[slot] = DEADLINE_PLACEHOLDER;
          continue;
        }
        results[slot] = await new Promise<T | typeof DEADLINE_PLACEHOLDER | undefined>((resolve) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            controller.abort();
            resolve(DEADLINE_PLACEHOLDER);
          }, remainingMs);
          timer.unref?.();
          task(controller.signal).then(
            (value) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve(value);
            },
            () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve(undefined);
            },
          );
        });
      }
    });
    await Promise.all(workers);
    return results;
  }

  /** 槽位是否失败(任务拒绝或 deadline 收敛;详情/降级计数口径;类型面收窄守卫) */
  function isFailedSlot<T>(
    slot: T | typeof DEADLINE_PLACEHOLDER | undefined | null,
  ): slot is undefined | null | typeof DEADLINE_PLACEHOLDER {
    return slot === undefined || slot === null || slot === (DEADLINE_PLACEHOLDER as unknown);
  }

  /* ---------- 主流程 ---------- */

  async function listCandidates(command: SwitchCandidatesCommand): Promise<SwitchCandidatesPage> {
    // ── 授权链(404 → 409 代次 → 409 终态 → 410 failed 恢复窗)──
    const context = authorizeSwitchSource(command);

    // ── cursor 续页/重放(列只读;不重新搜索)──
    if (command.cursor !== undefined && command.cursor !== null && command.cursor !== '') {
      const state = loadListingState(command.householdId, command.cursor);
      // 跨列/跨来源会话游标一律 410(列绑定原 session/generation,api §7 I1)
      if (
        state.fromSessionId !== command.fromSessionId ||
        state.deviceSessionId !== command.deviceSessionId ||
        state.profileId !== command.profileId ||
        state.profileContextVersion !== command.profileContextVersion ||
        state.fromGeneration !== context.generation
      ) {
        throw new DomainError(410, ProblemCode.VOD_SEARCH_EXPIRED, '换源候选列表已过期,请重新获取候选');
      }
      const pageIndex = resolvePageIndex(state, command.cursor);
      const replayed = state.pages[pageIndex];
      if (replayed !== undefined) return replayed;
      if (state.accepted.length - state.consumedCount === 0) {
        throw new DomainError(410, ProblemCode.VOD_SEARCH_EXPIRED, '分页游标已失效,请重新获取候选');
      }
      return buildPage(state, pageIndex);
    }

    // ── 新列:来源可信标题事实(缺 → 404 同形,不泄露内部状态)──
    const sourceTitleFacts = deps.loadSourceTitleFacts(command.householdId, context.mediaId);
    const query = (sourceTitleFacts?.canonicalName ?? '').trim();
    if (sourceTitleFacts === undefined || query.length === 0) {
      throw new DomainError(404, ProblemCode.NOT_FOUND, '当前播放内容没有可用的换源候选');
    }

    // ── 启用来源(无源 → 502,与 T028 搜索同形)──
    const enabled = deps.sourceConfig.listEnabledVodSources(command.householdId);
    if (enabled.length === 0) {
      throw vodUpstreamError(
        VOD_UPSTREAM_PROBLEM_CODES.VOD_UPSTREAM_FAILED,
        '没有可用的在线片源,请在设置中配置并启用来源',
      );
    }
    const sourceRefs = enabled.map(() => deps.cache.issueRef('source'));
    const listingId = deps.cache.issueRef('search');
    const expiresAtMs = now() + SWITCH_CANDIDATE_TTL_MS;
    const deadlineMs = now() + deps.config.search.totalTimeoutMs;

    // ── 第一阶段:多源搜索(服务端从可信标题构造查询;每源首页,T028 同形)──
    const searchOutcomes = await runBounded(
      enabled.map(
        (endpoint) =>
          async (signal: AbortSignal): Promise<{ readonly items: readonly ParsedVodSearchItem[] } | null> => {
            try {
              return await deps.searchUpstream({
                sourceId: endpoint.sourceId,
                query,
                page: 1,
                deadlineMs,
                signal,
              });
            } catch {
              return null;
            }
          },
      ),
      deadlineMs,
    );

    // 逐源状态 + 去重后的检索条目((source, VOD ID) 去重,T028 同口径)
    const sourceStatuses: SwitchSourceStatus[] = enabled.map((_endpoint, index) => {
      const outcome = searchOutcomes[index];
      if (outcome === DEADLINE_PLACEHOLDER) return 'timeout';
      if (outcome === undefined || outcome === null) return 'unavailable';
      return outcome.items.length > 0 ? 'ok' : 'empty';
    });
    const searchedItems: (readonly ParsedVodSearchItem[])[] = enabled.map((_endpoint, index) => {
      const outcome = searchOutcomes[index];
      if (isFailedSlot(outcome)) return [];
      const sourceId = enabled[index]?.sourceId ?? '';
      const seen = new Set<string>();
      return outcome.items.filter((item) => {
        const key = `${sourceId} ${item.identity.upstreamVodId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    });

    // 全部被尝试源失败 → 502(全源失败)/504(全部超时);出结果源视为成功(T028 同形)
    if (sourceStatuses.length > 0 && sourceStatuses.every(isFailedStatus)) {
      if (sourceStatuses.every((status) => status === 'timeout')) {
        throw vodUpstreamError(VOD_UPSTREAM_PROBLEM_CODES.VOD_UPSTREAM_TIMEOUT, '上游搜索总期限耗尽,请稍后重试');
      }
      throw vodUpstreamError(VOD_UPSTREAM_PROBLEM_CODES.VOD_UPSTREAM_FAILED, '全部在线片源搜索失败,请稍后重试');
    }

    // ── 第二阶段:候选详情抓取 + 锚定 + 评分(ok 源的检索条目;同 deadline)──
    // 010 T070 修复：FR-029 排除来源自身候选 —— 换源候选为「当前线路和跨来源」,
    // 与来源自身相同 (sourceId, upstreamVodId) 的检索条目整题不入组装(其全部线锚
    // 同属自身实例,不抓详情/不评分/不签发);来源绑定经 store 反查:来源上下文
    // mediaId → 分集 → 线路 → 稳定标题映射(与 loadSourceTitleFacts 同链),未物化/
    // 非 VOD 来源无绑定事实即无排除(同源异题不排除,排除仅精确到 (sourceId, upstreamVodId))。
    const sourceEpisode = deps.store.findEpisodeByMedia(command.householdId, context.mediaId);
    const sourceLine =
      sourceEpisode === undefined ? undefined : deps.store.findLine(command.householdId, sourceEpisode.lineId);
    const sourceTitle =
      sourceLine === undefined ? undefined : deps.store.findTitle(command.householdId, sourceLine.titleId);
    const sourceOwnIdentity =
      sourceTitle === undefined ? null : { sourceId: sourceTitle.sourceId, upstreamVodId: sourceTitle.upstreamVodId };
    const detailTasks = enabled.flatMap((endpoint, sourceIndex) =>
      (searchedItems[sourceIndex] ?? []).flatMap((item) => {
        // 010 T070 修复：FR-029 排除来源自身候选(同 (sourceId, upstreamVodId) 整题剔除)
        if (
          sourceOwnIdentity !== null &&
          endpoint.sourceId === sourceOwnIdentity.sourceId &&
          item.identity.upstreamVodId === sourceOwnIdentity.upstreamVodId
        ) {
          return [];
        }
        return [{ sourceIndex, sourceId: endpoint.sourceId, item } as const];
      }),
    );
    const detailOutcomes = await runBounded(
      detailTasks.map(({ sourceId, item }) => async (signal: AbortSignal): Promise<ParsedVodTitleDetail | null> => {
        try {
          return await deps.fetchDetailUpstream({
            sourceId,
            upstreamVodId: item.identity.upstreamVodId,
            deadlineMs,
            maxBytes: deps.config.preview.maxBytes,
            signal,
          });
        } catch {
          return null;
        }
      }),
      deadlineMs,
    );
    // 详情全败的单源降级 unavailable(源失败汇总;部分成功保持 ok)
    const detailAttempted = new Map<number, number>();
    const detailFailed = new Map<number, number>();
    detailTasks.forEach((_task, index) => {
      const sourceIndex = detailTasks[index]?.sourceIndex;
      if (sourceIndex === undefined) return;
      detailAttempted.set(sourceIndex, (detailAttempted.get(sourceIndex) ?? 0) + 1);
      if (isFailedSlot(detailOutcomes[index])) {
        detailFailed.set(sourceIndex, (detailFailed.get(sourceIndex) ?? 0) + 1);
      }
    });
    for (const [sourceIndex, attempted] of detailAttempted) {
      if (sourceStatuses[sourceIndex] === 'ok' && attempted > 0 && detailFailed.get(sourceIndex) === attempted) {
        sourceStatuses[sourceIndex] = 'unavailable';
      }
    }

    // ── 评分 + 签发 + 绑定登记(候选集合见文件头)──
    const accepted: AcceptedSwitchCandidate[] = [];
    detailTasks.forEach((task, index) => {
      const detail = detailOutcomes[index];
      if (isFailedSlot(detail)) return;
      const endpoint = enabled[task.sourceIndex];
      if (endpoint === undefined) return;
      const anchors = anchorEpisodesOf(detail, sourceTitleFacts.episodeKey);
      if (anchors.length === 0) return;
      // 预览修订:已物化标题对齐当前详情指针(物化 CAS 409 面);新标题按计数器递增
      const existingTitle = deps.store.findTitleMapping(
        command.householdId,
        endpoint.sourceId,
        task.item.identity.upstreamVodId,
      );
      const revisionKey = `${command.householdId} ${endpoint.sourceId} ${task.item.identity.upstreamVodId}`;
      const previewRevision =
        existingTitle?.currentDetailRevision ?? (freshRevisions.get(revisionKey) ?? 0) + 1;
      if (existingTitle === undefined) freshRevisions.set(revisionKey, previewRevision);

      for (const anchor of anchors) {
        const candidateFacts: CandidateFacts = {
          upstreamVodId: task.item.identity.upstreamVodId,
          canonicalName: detail.title,
          year: detail.year,
          seasonKey: null,
          episodeKey: anchor.episodeKey,
          languageVersion: null,
          knownVersionLabel: task.item.identity.version,
          expiresAtMs,
        };
        const conclusion = matchCandidate({ sourceTitleFacts, candidateFacts });
        const candidateRef = deps.cache.allocateRef(listingId, `candidate:${accepted.length}`, 'episode');
        const values: SwitchCandidateValues = {
          candidateRef,
          title: detail.title,
          label: anchor.episodeLabel,
          year: detail.year,
          season: candidateFacts.seasonKey,
          versionLabel: candidateFacts.knownVersionLabel,
          sourceLabel: endpoint.name,
          lineLabel: anchor.lineLabel,
          matchConfidence: conclusion.confidence,
          matchReasons: conclusion.reasons,
          previewRevision,
          expiresAt: new Date(expiresAtMs).toISOString(),
        };
        const bound = deps.cache.put<VodCandidateBindingPayload>({
          id: candidateRef,
          householdId: command.householdId,
          kind: 'preview',
          sourceIds: [endpoint.sourceId],
          expiresAtMs,
          payload: {
            kind: 'candidate-binding',
            sourceId: endpoint.sourceId,
            sourceLabel: endpoint.name,
            upstreamVodId: task.item.identity.upstreamVodId,
            lineKey: anchor.lineKey,
            lineLabel: anchor.lineLabel,
            episodeKey: anchor.episodeKey,
            episodeLabel: anchor.episodeLabel,
            title: detail.title,
            year: detail.year,
            locatorRevision: endpoint.locatorRevision,
            previewRevision,
            fetchedAtMs: now(),
            matchConfidence: conclusion.confidence,
            matchReasons: conclusion.reasons,
            matchRuleVersion: conclusion.matchRuleVersion,
            fromSessionId: command.fromSessionId,
            sourceGeneration: context.generation,
            lines: lineMaterialsOf(detail),
          },
        });
        if (!bound) {
          throw vodUpstreamError(
            VOD_UPSTREAM_PROBLEM_CODES.VOD_CACHE_CAPACITY,
            '候选缓存已达家庭上限,请稍后重试',
          );
        }
        accepted.push({ candidateRef, values });
      }
    });

    // ── 列表落册(源失败汇总一次定格)+ 第一页 ──
    const partial = sourceStatuses.some(isFailedStatus);
    const reasons = sourceStatuses.flatMap((status, index) =>
      isFailedStatus(status) ? [`${sourceRefs[index] ?? ''}@${status}`] : [],
    );
    const state: SwitchListingState = {
      listingId,
      householdId: command.householdId,
      deviceSessionId: command.deviceSessionId,
      profileId: command.profileId,
      profileContextVersion: command.profileContextVersion,
      fromSessionId: command.fromSessionId,
      fromGeneration: context.generation,
      sourceRefs,
      partial,
      reasons,
      accepted,
      consumedCount: 0,
      pages: [],
      expiresAtMs,
    };
    const page = buildPage(state, 0);
    persist(state, enabled.map((endpoint) => endpoint.sourceId));
    return page;
  }

  return { listCandidates };
}
