/**
 * 010 T028 — 公共预览/详情用例(application):titleRef → VodPreview 纯值装配。
 *
 * 纯函数模块惯例:依赖经参数注入函数束(VodPreviewServiceDeps,供 T031 装配)——
 * 有界缓存经 VodCache、来源配置经 VodSourceConfigurationPort、详情抓取经注入的
 * VodDetailUpstreamFn(T031 以 SafeUpstream(preview.totalTimeoutMs/preview.maxBytes
 * 有界读取)+ T025 parseDetailDocument 装配;网络在事务外)。预览不物化、不建个人
 * 记录:零 ONLINE_VOD_STORE/事务面消费,零 DB 写(契约 §2「预览/搜索不物化」)。
 *
 * 行为契约(逐行即语义,docs/specs/010-online-vod/contracts/api.md §2):
 * - 缓存命中重放:同 titleRef 在 TTL 内逐字段同值(previewRevision/fetchedAt/
 *   expiresAt 不变);
 * - 未命中取详情:预算 preview.totalTimeoutMs(8s)/preview.maxBytes(4MiB);
 *   超体积与超条目(20 线/单线 2000/合计 5000)一律 422 VOD_DETAIL_TOO_LARGE
 *   整次失败(openapi VodDetailTooLarge422);
 * - ref 失效 410 VOD_PREVIEW_EXPIRED;伪造/未签发 ref 404 同形(不与失效混同);
 * - 禁源/配置失配:先失效缓存(invalidateSource 钩子)再拒绝旧页 410;
 * - format_unsupported 判定 = 定位非 HLS/不可解析形态:定位地址为常见直连媒体
 *   容器扩展名(.mp4/.mkv/.ts 等)即判非 HLS 形态;歧义形态(无扩展名/重定向/
 *   带签名参数)一律保守保持 candidate,最终可播性归定位/probe 阶段(T042/T044);
 *   identity_ambiguous 仍来自解析层标记(T025),优先于 format 判定。
 *
 * payload 私有面:预览快照在缓存中保留 lineKey/episodeKey/locatorUrl(供 T029
 * 物化候选绑定/T042 定位消费),公开投影 toVodPreviewValues 只输出 api §1
 * VodPreview 字段(无源地址/无个人字段)。
 */

// 010 恢复:DomainError 取自 domain-error;ProblemCode 常量值取自 @hmp/shared
import { DomainError } from '@platform/http-common/domain-error';
import { ProblemCode } from '@hmp/shared';
import type { VodSourceConfigurationPort } from './publication-work-set.port';
import {
  ProviderParseError,
  type ParsedVodLine,
  type ParsedVodTitleDetail,
  type ParsedVodUnsupportedReason,
} from '../domain/provider-model';
import type { VodBudgetShape } from '../domain/vod-budgets';
import type { VodCache, VodCacheEntryView } from '../infrastructure/vod-cache';
import { VodUpstreamTimeoutError, vodUpstreamError, VOD_UPSTREAM_PROBLEM_CODES } from './search.service';

/* ------------------------------------------------------------------ */
/* 公共值形态(api §1 VodPreview;与冻结 DTO 逐字段对齐的纯值)            */
/* ------------------------------------------------------------------ */

export type VodPreviewEpisodeReason = ParsedVodUnsupportedReason | 'format_unsupported';

export interface VodPreviewEpisodeValues {
  readonly episodeRef: string;
  readonly label: string;
  readonly status: 'candidate' | 'unsupported';
  readonly reason: VodPreviewEpisodeReason | null;
}

export interface VodPreviewLineValues {
  readonly lineRef: string;
  readonly name: string;
  readonly episodes: readonly VodPreviewEpisodeValues[];
}

export interface VodPreviewValues {
  readonly titleRef: string;
  readonly title: string;
  readonly description: string | null;
  readonly year: string | null;
  readonly sourceLabel: string;
  /** 同源海报资源不透明引用(服务端代理取回);上游未给海报 → null */
  readonly posterRef: string | null;
  readonly previewRevision: number;
  readonly fetchedAt: string;
  readonly expiresAt: string;
  readonly lines: readonly VodPreviewLineValues[];
}

/* ------------------------------------------------------------------ */
/* 缓存载荷(私有面:含定位地址与键,绝不进入公共 DTO)                     */
/* ------------------------------------------------------------------ */

/** 缓存条目内单集(公共值 + 私有键/定位) */
interface StoredEpisode {
  readonly episodeRef: string;
  readonly label: string;
  readonly status: 'candidate' | 'unsupported';
  readonly reason: VodPreviewEpisodeReason | null;
  /** 解析层集键(T029 物化绑定消费) */
  readonly episodeKey: string | null;
  /** 上游定位地址逐字透传(私有;T042 定位消费) */
  readonly locatorUrl: string | null;
}

/** 缓存条目内单线 */
interface StoredLine {
  readonly lineRef: string;
  readonly name: string;
  /** 解析层线键(T029 物化绑定消费) */
  readonly lineKey: string | null;
  readonly episodes: readonly StoredEpisode[];
}

/** 标题缓存条目载荷:绑定(搜索登记)→ 预览快照(取详情后原子替换) */
export type VodTitlePayload =
  | {
      readonly kind: 'title-binding';
      readonly sourceId: string;
      readonly sourceLabel: string;
      readonly upstreamVodId: string;
      readonly title: string;
      readonly year: string | null;
      readonly locatorRevision: number;
      readonly searchId: string;
      /** 上游海报地址(私有定位;上游未给 → null;绑定/快照两形态恒携带) */
      readonly posterUrl: string | null;
      /** poster 级不透明 ref(无海报恒 null;快照原样承继绑定值,保持重放不变) */
      readonly posterRef: string | null;
    }
  | {
      readonly kind: 'title-preview';
      readonly sourceId: string;
      readonly sourceLabel: string;
      readonly upstreamVodId: string;
      readonly title: string;
      readonly year: string | null;
      readonly locatorRevision: number;
      readonly searchId: string;
      readonly posterUrl: string | null;
      readonly posterRef: string | null;
      readonly synopsis: string | null;
      readonly previewRevision: number;
      readonly fetchedAtMs: number;
      readonly lines: readonly StoredLine[];
    };

/* ------------------------------------------------------------------ */
/* 注入面                                                               */
/* ------------------------------------------------------------------ */

/** 单源详情上游请求(装配侧据此走 SafeUpstream read(byteBudget=maxBytes)) */
export interface VodDetailUpstreamRequest {
  readonly sourceId: string;
  readonly upstreamVodId: string;
  /** 绝对 deadline(epoch ms) */
  readonly deadlineMs: number;
  /** 单详情字节预算(超限由装配侧整体拒绝 → ProviderParseError budget_exceeded) */
  readonly maxBytes: number;
  /** deadline 触发的外部中止信号 */
  readonly signal: AbortSignal;
}

export type VodDetailUpstreamFn = (request: VodDetailUpstreamRequest) => Promise<ParsedVodTitleDetail>;

export interface VodPreviewServiceDeps {
  readonly config: VodBudgetShape;
  readonly cache: VodCache;
  readonly sourceConfig: VodSourceConfigurationPort;
  readonly fetchDetail: VodDetailUpstreamFn;
  readonly nowMs?: () => number;
}

/* ------------------------------------------------------------------ */
/* 内部                                                                 */
/* ------------------------------------------------------------------ */

/** 常见直连媒体容器扩展名(判定「非 HLS 形态」的唯一证据面;pathname 末段) */
const DIRECT_MEDIA_EXTENSION_RE = /\.(?:mp4|mkv|avi|mov|flv|wmv|rmvb|rm|mpg|mpeg|3gp|ts|webm|m2ts)$/i;

/**
 * format_unsupported 判定:定位 URL(pathname,剥 query/fragment)以直连媒体容器
 * 扩展名结尾 → 非 HLS/不可解析形态。其余形态(无扩展名/.m3u8/重定向入口/带签名
 * 参数)保守保持 candidate,最终可播性归定位/probe 阶段。
 */
function isDirectMediaLocator(locatorUrl: string | null): boolean {
  if (locatorUrl === null) return true;
  const withoutFragment = locatorUrl.split('#', 1)[0] ?? locatorUrl;
  const withoutQuery = withoutFragment.split('?', 1)[0] ?? withoutFragment;
  return DIRECT_MEDIA_EXTENSION_RE.test(withoutQuery);
}

/** 预览修订计数(家庭×源×上游 ID 粒度,单调递增;进程内存态) */
function revisionKey(householdId: string, sourceId: string, upstreamVodId: string): string {
  return `${householdId} ${sourceId} ${upstreamVodId}`;
}

/* ------------------------------------------------------------------ */
/* 服务工厂                                                             */
/* ------------------------------------------------------------------ */

/**
 * 创建公共预览用例。返回面即 T031 控制器接线点:`preview(command)`。
 * (episodeRef/lineRef 的注册表反查供 T029 物化绑定/T031 候选分支经
 * cache.resolveRef + get<VodTitlePayload> 消费。)
 */
export function createVodPreviewService(deps: VodPreviewServiceDeps): {
  preview(command: { readonly householdId: string; readonly titleRef: string }): Promise<VodPreviewValues>;
} {
  const now = deps.nowMs ?? (() => Date.now());
  const revisions = new Map<string, number>();

  function toPublic(payload: Extract<VodTitlePayload, { kind: 'title-preview' }>, titleRef: string, expiresAtMs: number): VodPreviewValues {
    return {
      titleRef,
      title: payload.title,
      description: payload.synopsis,
      year: payload.year,
      sourceLabel: payload.sourceLabel,
      posterRef: payload.posterRef,
      previewRevision: payload.previewRevision,
      fetchedAt: new Date(payload.fetchedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      lines: payload.lines.map((line) => ({
        lineRef: line.lineRef,
        name: line.name,
        episodes: line.episodes.map((episode) => ({
          episodeRef: episode.episodeRef,
          label: episode.label,
          status: episode.status,
          reason: episode.reason,
        })),
      })),
    };
  }

  /**
   * 禁源/配置失配门(api §2「先失效缓存再拒绝旧页」):来源必须仍启用、
   * locatorRevision 与登记值一致、adapter 仍为 apple-cms-json;任一不满足 →
   * 先失效该源全部缓存,再 410 VOD_PREVIEW_EXPIRED。
   */
  function requireSourceAlive(householdId: string, payload: VodTitlePayload): void {
    const sourceId = payload.sourceId;
    const enabled = deps.sourceConfig
      .listEnabledVodSources(householdId)
      .find((endpoint) => endpoint.sourceId === sourceId);
    const locatorRevision = deps.sourceConfig.readLocatorRevision(householdId, sourceId);
    const adapter = deps.sourceConfig.findSourceConfig(householdId, sourceId)?.adapter;
    const healthy =
      enabled !== undefined &&
      enabled.locatorRevision === payload.locatorRevision &&
      locatorRevision === payload.locatorRevision &&
      adapter === 'apple-cms-json';
    if (!healthy) {
      deps.cache.invalidateSource(householdId, sourceId);
      throw new DomainError(410, ProblemCode.VOD_PREVIEW_EXPIRED, '预览引用已过期,请重新获取预览');
    }
  }

  function loadTitleEntry(householdId: string, titleRef: string): VodCacheEntryView<VodTitlePayload> {
    // 伪造/未签发 ref:404 与不存在同形(api §2「跨家庭/伪造404」;resolveRef 按
    // 注册表可逆,他家庭 titleRef 若被持有亦然签发于本家庭外 → 视为未签发)
    if (deps.cache.resolveRef(titleRef) === undefined) {
      throw new DomainError(404, ProblemCode.NOT_FOUND, '媒体不存在或当前不可见');
    }
    const view = deps.cache.get<VodTitlePayload>(titleRef);
    if (view === undefined || view.householdId !== householdId || view.kind !== 'preview') {
      throw new DomainError(404, ProblemCode.NOT_FOUND, '媒体不存在或当前不可见');
    }
    // ref 失效(签发过但 TTL 已过):410 VOD_PREVIEW_EXPIRED,保留 q 重新预览
    if (view.expired) {
      throw new DomainError(410, ProblemCode.VOD_PREVIEW_EXPIRED, '预览引用已过期,请重新获取预览');
    }
    return view;
  }

  async function fetchDetailPayload(
    sourceId: string,
    upstreamVodId: string,
  ): Promise<ParsedVodTitleDetail> {
    const deadlineMs = now() + deps.config.preview.totalTimeoutMs;
    const remainingMs = deadlineMs - now();
    const controller = new AbortController();
    if (remainingMs <= 0) {
      controller.abort();
      throw vodUpstreamError(VOD_UPSTREAM_PROBLEM_CODES.VOD_UPSTREAM_TIMEOUT, '上游详情读取超出预算时限');
    }
    let settled = false;
    const outcome = await new Promise<
      | { readonly kind: 'result'; readonly detail: ParsedVodTitleDetail }
      | { readonly kind: 'timeout' }
      | { readonly kind: 'error'; readonly error: unknown }
    >((resolve) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        controller.abort();
        resolve({ kind: 'timeout' });
      }, remainingMs);
      timer.unref?.();
      deps
        .fetchDetail({
          sourceId,
          upstreamVodId,
          deadlineMs,
          maxBytes: deps.config.preview.maxBytes,
          signal: controller.signal,
        })
        .then(
          (detail) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ kind: 'result', detail });
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ kind: 'error', error });
          },
        );
    });
    if (outcome.kind === 'timeout') {
      throw vodUpstreamError(VOD_UPSTREAM_PROBLEM_CODES.VOD_UPSTREAM_TIMEOUT, '上游详情读取超出预算时限');
    }
    if (outcome.kind === 'error') {
      throw outcome.error;
    }
    return outcome.detail;
  }

  /** 上游详情错误映射:超体积/超条目 → 422;超时 → 504;其余 → 502(脱敏) */
  function mapDetailFailure(error: unknown): DomainError {
    if (error instanceof VodUpstreamTimeoutError) {
      return vodUpstreamError(VOD_UPSTREAM_PROBLEM_CODES.VOD_UPSTREAM_TIMEOUT, '上游详情读取超出预算时限');
    }
    if (error instanceof ProviderParseError) {
      if (error.code === 'budget_exceeded' || error.code === 'field_length_exceeded') {
        return new DomainError(422, ProblemCode.VOD_DETAIL_TOO_LARGE, '详情或预览超出体积或条目预算,整次失败');
      }
      return vodUpstreamError(VOD_UPSTREAM_PROBLEM_CODES.VOD_UPSTREAM_FAILED, '在线片源详情读取失败,请稍后重试');
    }
    return vodUpstreamError(VOD_UPSTREAM_PROBLEM_CODES.VOD_UPSTREAM_FAILED, '在线片源详情读取失败,请稍后重试');
  }

  /** 解析详情 → 缓存条目载荷(装配 ref;format_unsupported 见文件头判定) */
  function assembleLines(titleRef: string, detail: ParsedVodTitleDetail): { readonly lines: readonly StoredLine[] } {
    const lines = detail.lines.map((line: ParsedVodLine, lineIndex): StoredLine => {
      const lineRef = deps.cache.allocateRef(titleRef, `line:${line.sortOrder}:${lineIndex}`, 'line');
      const episodes = line.episodes.map((episode, episodeIndex): StoredEpisode => {
        const episodeRef = deps.cache.allocateRef(titleRef, `episode:${lineIndex}:${episodeIndex}`, 'episode');
        if (episode.status === 'unsupported') {
          // 解析层标记(identity_ambiguous)优先
          return {
            episodeRef,
            label: episode.label,
            status: 'unsupported',
            reason: episode.reason ?? 'identity_ambiguous',
            episodeKey: episode.episodeKey,
            locatorUrl: episode.locatorUrl ?? null,
          };
        }
        if (isDirectMediaLocator(episode.locatorUrl ?? null)) {
          return {
            episodeRef,
            label: episode.label,
            status: 'unsupported',
            reason: 'format_unsupported',
            episodeKey: episode.episodeKey,
            locatorUrl: episode.locatorUrl ?? null,
          };
        }
        return {
          episodeRef,
          label: episode.label,
          status: 'candidate',
          reason: null,
          episodeKey: episode.episodeKey,
          locatorUrl: episode.locatorUrl ?? null,
        };
      });
      return { lineRef, name: line.displayName, lineKey: line.lineKey, episodes };
    });
    return { lines };
  }

  async function preview(command: { readonly householdId: string; readonly titleRef: string }): Promise<VodPreviewValues> {
    const view = loadTitleEntry(command.householdId, command.titleRef);
    const payload = view.payload;
    requireSourceAlive(command.householdId, payload);

    if (payload.kind === 'title-preview') {
      // 缓存命中重放:TTL 内逐字段不变(fetchedAt/expiresAt/previewRevision 原值)
      return toPublic(payload, command.titleRef, view.expiresAtMs);
    }

    // 未命中:取详情(preview 8s/4MiB)→ 装配 → 原子替换绑定条目(零 DB 写)
    let detail: ParsedVodTitleDetail;
    try {
      detail = await fetchDetailPayload(payload.sourceId, payload.upstreamVodId);
    } catch (error) {
      // 010 恢复:已定型的 DomainError(内部共享 deadline 504)直接透传,
      // 不得再经上游失败映射降级为 502(否则全部超时被错标为失败)
      if (error instanceof DomainError) {
        throw error;
      }
      throw mapDetailFailure(error);
    }

    const key = revisionKey(command.householdId, payload.sourceId, payload.upstreamVodId);
    const previewRevision = (revisions.get(key) ?? 0) + 1;
    revisions.set(key, previewRevision);
    const fetchedAtMs = now();
    const expiresAtMs = fetchedAtMs + deps.cache.ttlMs;
    // 海报补签:列表简表(ac=list)常缺 vod_pic、详情(ac=detail)才带 —— 绑定缺图而
    // 详情有图时,在快照组装时补发 poster 级 ref(绑定在 titleRef 条目,随快照原子
    // 替换保留;绑定已有图则原样承继,不因详情侧海报变化改写已签发 ref)
    const posterUrl = payload.posterUrl ?? detail.posterUrl;
    const posterRef =
      payload.posterRef ??
      (detail.posterUrl !== null
        ? deps.cache.allocateRef(command.titleRef, `poster:${payload.sourceId} ${payload.upstreamVodId}`, 'poster')
        : null);
    const stored: VodTitlePayload = {
      kind: 'title-preview',
      sourceId: payload.sourceId,
      sourceLabel: payload.sourceLabel,
      upstreamVodId: payload.upstreamVodId,
      title: detail.title,
      year: detail.year ?? payload.year,
      locatorRevision: payload.locatorRevision,
      searchId: payload.searchId,
      posterUrl,
      posterRef,
      synopsis: detail.synopsis,
      previewRevision,
      fetchedAtMs,
      lines: assembleLines(command.titleRef, detail).lines,
    };
    const persisted = deps.cache.put<VodTitlePayload>({
      id: command.titleRef,
      householdId: command.householdId,
      kind: 'preview',
      sourceIds: [payload.sourceId],
      expiresAtMs,
      payload: stored,
    });
    if (!persisted) {
      throw vodUpstreamError(
        VOD_UPSTREAM_PROBLEM_CODES.VOD_CACHE_CAPACITY,
        '预览缓存已达进程或家庭上限,请稍后重试',
      );
    }
    return toPublic(stored as Extract<VodTitlePayload, { kind: 'title-preview' }>, command.titleRef, expiresAtMs);
  }

  return { preview };
}
