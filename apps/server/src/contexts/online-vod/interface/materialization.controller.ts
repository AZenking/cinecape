import { Body, Controller, Inject, Post, Res, UseGuards } from '@nestjs/common';
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ProblemCode } from '@hmp/shared';
import { DomainError } from '@platform/http-common/domain-error';
import { CurrentProfile } from '@platform/http-common/profile-context/current-profile.decorator';
import type { ProfileContext } from '@platform/http-common/profile-context/current-profile.decorator';
import { CurrentSession } from '@platform/http-common/current-session.decorator';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { SameOriginGuard } from '@platform/http-common/same-origin/same-origin.guard';
import { SessionGuard } from '@platform/http-common/session.guard';
import { CurrentProfileGuard } from '@platform/http-common/profile-context/current-profile.guard';
import { RateLimitGuard } from '@platform/http-common/rate-limit/rate-limit.guard';
import { RateLimit } from '@platform/http-common/rate-limit/rate-limit.decorator';
import { StrictBodyPipe } from '@platform/http-common/strict-input/strict-pipes';
import {
  materialize,
  type MaterializationContext,
  type MaterializeTargetResolver,
  type ResolvedMaterializationTarget,
} from '@contexts/online-vod/application/materialization.service';
import type {
  MaterializeCommand,
  MaterializeOutcome,
} from '@contexts/online-vod/application/publication-work-set.port';
import { VOD_MATERIALIZATION, type VodMaterializationAssembly } from '@contexts/online-vod/online-vod.tokens';

/**
 * 010 T031 — 物化契约路由(POST /api/vod/materializations;api.md §3 + §7 I1)。
 *
 * 控制器薄面:同源/Session/当前 Profile 守卫 → Profile 控制桶限流(progress,
 * 每 DeviceSession 60/min)→ 16KiB 写体预算 → 严格 oneOf DTO(未知字段/混分支
 * 400)→ 物化应用用例(materialize;T029)→ 白名单输出 Materialized。业务语义
 * 零新增;错误一律经既有 DomainError/问题码;no-store/no-referrer 由全局拦截器
 * 与 ProblemJsonFilter 保证。首次 key 201;同成功 key 重放 200 replayed=true
 * (api.md §3 幂等段,以用例回执判定状态码)。
 *
 * resolveTarget 桥(见 createVodMaterializationTargetResolver):
 * - 稳定分支:titleRef/episodeRef 经预览缓存(T028 服务同一 VodCache 单例)注册表
 *   反查 → 标题预览载荷 → ResolvedMaterializationTarget(键/事实全为服务端事实,
 *   不接受浏览器推导上游键);禁源/配置失配先失效缓存再 410(对齐 T028 preview
 *   「先失效缓存再拒绝旧页」);
 * - 候选分支:先按原 candidateRef 查最新登记映射(api §7 I1「新 key 不得使用过期
 *   原候选」:已登记且过期 → 410;从未登记且无绑定 → 404 候选绑定冲突),再经
 *   登记目标注册表解析候选绑定事实。候选签发的唯一合法来源在预览缓存/US4
 *   (T067/T070,US1 不可达面),本装配以 registerVodMaterializationTarget 暴露
 *   登记桥面(生产装配零注册;供契约 rig 直种合法候选绑定,T024 契约)。
 */

/* ------------------------------------------------------------------ */
/* 请求 DTO(严格 oneOf;openapi MaterializationRequest)                  */
/* ------------------------------------------------------------------ */

const titleEpisodeBranchSchema = z.strictObject({
  titleRef: z.string().min(1),
  episodeRef: z.string().min(1),
  previewRevision: z.number().int().min(1),
  operationKey: z.string().uuid(),
});

const candidateBranchSchema = z.strictObject({
  candidateRef: z.string().min(1),
  previewRevision: z.number().int().min(1),
  operationKey: z.string().uuid(),
});

/** MaterializationRequest = strict oneOf(混带/缺字段/未知字段经 strictObject 整体 400) */
const materializationRequestSchema = z.union([titleEpisodeBranchSchema, candidateBranchSchema]);

/**
 * wire DTO → MaterializeCommand 判别联合(api §3 请求体无 kind 字段;T031 装配修正:
 * 此前直 cast 导致 kind 缺失,稳定分支全部误入候选分支 → 登记表未命中 404)。
 * zod union 已保证二分支恰一,按 titleRef 在场判定分支。
 */
function materializeCommandOf(body: unknown): MaterializeCommand {
  if (typeof body === 'object' && body !== null && 'titleRef' in body) {
    const branch = body as z.infer<typeof titleEpisodeBranchSchema>;
    return {
      kind: 'stableRef',
      titleRef: branch.titleRef,
      episodeRef: branch.episodeRef,
      previewRevision: branch.previewRevision,
      operationKey: branch.operationKey,
    };
  }
  const branch = body as z.infer<typeof candidateBranchSchema>;
  return {
    kind: 'candidateRef',
    candidateRef: branch.candidateRef,
    previewRevision: branch.previewRevision,
    operationKey: branch.operationKey,
  };
}

/** 写体预算(契约「写 body<=16KiB」;播放控制守卫同款 Content-Length 预检模式) */
const VOD_WRITE_BODY_MAX_BYTES = 16 * 1024;

@Injectable()
export class VodWriteBodyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return true;
    }
    const contentLength = request.headers['content-length'];
    if (typeof contentLength === 'string' && contentLength !== '') {
      const bytes = Number(contentLength);
      if (Number.isFinite(bytes) && bytes > VOD_WRITE_BODY_MAX_BYTES) {
        throw new DomainError(400, ProblemCode.VALIDATION_FAILED, 'JSON 请求体超出 16KiB 预算');
      }
    }
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* 登记目标注册表(装配桥登记面;生产装配零注册)                          */
/* ------------------------------------------------------------------ */

const REGISTERED_STABLE_TARGETS = new Map<string, ResolvedMaterializationTarget>();
const REGISTERED_CANDIDATE_TARGETS = new Map<string, ResolvedMaterializationTarget>();

function stableRegistryKey(titleRef: string, episodeRef: string): string {
  return `${titleRef}\u0000${episodeRef}`;
}

/**
 * 直种一个登记物化目标(opaque ref → 服务端事实;装配桥登记面)。生产装配不
 * 调用;供契约 rig 直种合法目标/候选绑定(T024 夹具 ref 不经预览缓存签发,
 * 替代「伪造 ref 打通正向链」的非契约路径)。同 key 重复注册为覆盖(rig 重建
 * 即重种);注册目标仍受事务内 CAS/策略/配额全量重验,不构成授权旁路。
 */
export function registerVodMaterializationTarget(
  target: ResolvedMaterializationTarget & {
    readonly titleRef?: string;
    readonly episodeRef?: string;
    readonly candidateRef?: string;
  },
): void {
  if (target.candidateRef !== undefined) {
    REGISTERED_CANDIDATE_TARGETS.set(target.candidateRef, target);
    return;
  }
  if (target.titleRef !== undefined && target.episodeRef !== undefined) {
    REGISTERED_STABLE_TARGETS.set(stableRegistryKey(target.titleRef, target.episodeRef), target);
  }
}

/** 清空登记目标注册表(rig 卫生兜底;注册表随用例文件进程隔离) */
export function clearVodMaterializationTargets(): void {
  REGISTERED_STABLE_TARGETS.clear();
  REGISTERED_CANDIDATE_TARGETS.clear();
}

/* ------------------------------------------------------------------ */
/* 控制器                                                               */
/* ------------------------------------------------------------------ */

@Controller('vod')
@UseGuards(SameOriginGuard, SessionGuard, CurrentProfileGuard)
export class VodMaterializationController {
  constructor(
    // @Inject 显式声明(esbuild/tsx 不发射 design:paramtypes;仓库既有惯例)
    @Inject(VOD_MATERIALIZATION) private readonly assembly: VodMaterializationAssembly,
  ) {}

  /** POST /vod/materializations:首次 201;同成功 key 重放 200 replayed=true(api.md §3) */
  @Post('materializations')
  @UseGuards(RateLimitGuard, VodWriteBodyGuard)
  @RateLimit('progress')
  async materialize(
    @Body(new StrictBodyPipe(materializationRequestSchema)) body: unknown,
    @CurrentSession() session: SessionContext,
    @CurrentProfile() profile: ProfileContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MaterializeOutcome> {
    const command = materializeCommandOf(body);
    const context: MaterializationContext = {
      householdId: session.session.householdId,
      deviceSessionId: session.session.id,
      profileId: profile.id,
      // 幂等 scope=家庭/DeviceSession/contextVersion:版本取服务端会话现值
      profileContextVersion: this.assembly.readProfileContextVersion(session.session.id),
    };
    const outcome = await materialize(this.assembly.deps, command, context, this.assembly.resolveTarget);
    // 幂等语义落状态码:同成功 key 重放 200,首次 201(Nest 路由缺省);
    // Content-Type 沿播放控制同款 problem+json 形态(契约 e2e 断言面)
    res.status(outcome.replayed ? 200 : 201);
    res.setHeader('Content-Type', 'application/problem+json; charset=utf-8');
    return outcome;
  }
}

/* ------------------------------------------------------------------ */
/* resolveTarget 桥(装配层实现;online-vod.module.ts 工厂调用)           */
/* ------------------------------------------------------------------ */

/** 预览缓存最小读面(T031 桥消费;与 T028 服务共享同一实例的子面) */
export interface VodPreviewCacheReader {
  get<P = unknown>(
    id: string,
  ): {
    readonly householdId: string;
    readonly kind: 'search' | 'preview';
    readonly expired: boolean;
    readonly expiresAtMs: number;
    readonly payload: P;
  } | undefined;
  /** ref 反查(仅注册表可逆;未签发/已清除 → undefined) */
  resolveRef(ref: string): { readonly entryId: string; readonly local: string } | undefined;
  invalidateSource(householdId: string, sourceId: string): number;
}

/** 登记映射新鲜度读面(OnlineVodStore 的候选反查子面;api §7 I1) */
export interface VodCandidateFreshnessReader {
  findLatestRegisteredCandidateByCandidateRef(
    householdId: string,
    candidateRef: string,
  ): { readonly expiresAt: string } | undefined;
}

/** 来源配置读面(结构相容 VodSourceConfigurationPort;装配处传 sources 发布面实现) */
export interface VodTargetSourceConfigReader {
  listEnabledVodSources(
    householdId: string,
  ): ReadonlyArray<{ readonly sourceId: string; readonly locatorRevision: number; readonly adapter: string }>;
  readLocatorRevision(householdId: string, sourceId: string): number | undefined;
  findSourceConfig(householdId: string, sourceId: string): { readonly adapter: string } | undefined;
}

function notFound(): DomainError {
  // 伪造/跨家庭/未签发 ref 与不存在同形(api §0/§6)
  return new DomainError(404, ProblemCode.NOT_FOUND);
}

function previewExpired(detail: string): DomainError {
  return new DomainError(410, ProblemCode.VOD_PREVIEW_EXPIRED, detail);
}

/** 预览缓存行/集载荷(私有面;preview.service VodTitlePayload['lines'] 结构镜像) */
interface StoredEpisodeLike {
  readonly episodeRef: string;
  readonly label: string;
  readonly status: 'candidate' | 'unsupported';
  readonly reason: string | null;
  readonly episodeKey: string | null;
  readonly locatorUrl: string | null;
}

interface StoredLineLike {
  readonly lineRef: string;
  readonly name: string;
  readonly lineKey: string | null;
  readonly episodes: readonly StoredEpisodeLike[];
}

/**
 * 构建物化目标解析桥(module 装配调用;cache 为 T028 服务同一单例)。
 * 稳定分支:预览缓存反查(禁源/失配先失效缓存再 410);候选分支:登记映射新鲜度
 * (过期 410)→ 登记目标注册表(缺失 404 候选绑定冲突)。
 */
export function createVodMaterializationTargetResolver(input: {
  readonly cache: VodPreviewCacheReader;
  readonly store: VodCandidateFreshnessReader;
  readonly sourceConfig: VodTargetSourceConfigReader;
}): MaterializeTargetResolver {
  /** 禁源/配置失配门(对齐 T028 preview「先失效缓存再拒绝旧页」) */
  function requireSourceAlive(householdId: string, sourceId: string, locatorRevision: number): void {
    const enabled = input.sourceConfig
      .listEnabledVodSources(householdId)
      .find((endpoint) => endpoint.sourceId === sourceId);
    const currentRevision = input.sourceConfig.readLocatorRevision(householdId, sourceId);
    const adapter = input.sourceConfig.findSourceConfig(householdId, sourceId)?.adapter;
    const healthy =
      enabled !== undefined &&
      enabled.locatorRevision === locatorRevision &&
      currentRevision === locatorRevision &&
      adapter === 'apple-cms-json';
    if (!healthy) {
      input.cache.invalidateSource(householdId, sourceId);
      throw previewExpired('预览引用已过期,请重新获取预览');
    }
  }

  /** 标题条目读门:伪造/跨家庭 404;签发过但 TTL 已过 410(与 T028 preview 同形) */
  function loadTitleEntry(
    householdId: string,
    titleRef: string,
  ): { readonly expiresAtMs: number; readonly payload: Record<string, unknown> } {
    const view = input.cache.get<Record<string, unknown>>(titleRef);
    if (view === undefined || view.householdId !== householdId || view.kind !== 'preview') {
      throw notFound();
    }
    if (view.expired) {
      throw previewExpired('预览引用已过期,请重新获取预览');
    }
    return view;
  }

  /** 标题预览载荷 → 整片详情解析事实(私有定位只入库不进公共 DTO) */
  function detailFactsOf(
    payload: Record<string, unknown>,
    expiresAtMs: number,
  ): ResolvedMaterializationTarget['detail'] {
    const lines = ((payload['lines'] ?? []) as readonly StoredLineLike[]).filter(
      (line) => line.lineKey !== null && line.lineKey.length > 0,
    );
    const factLines = lines.map((line, lineIndex) => ({
      lineKey: line.lineKey as string,
      displayName: line.name !== '' ? line.name : (line.lineKey as string),
      // 解析层线序即 wire 位置序(1 起;preview 装配保序)
      sortOrder: lineIndex + 1,
      episodes: line.episodes.flatMap((episode, episodeIndex) => {
        if (episode.episodeKey === null || episode.episodeKey.length === 0) {
          return [];
        }
        const ordinalMatch = /\d+/.exec(episode.episodeKey);
        const parsed = ordinalMatch === null ? Number.NaN : Number.parseInt(ordinalMatch[0] ?? '', 10);
        return [
          {
            episodeKey: episode.episodeKey,
            label: episode.label !== '' ? episode.label : episode.episodeKey,
            ordinal: Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : episodeIndex + 1,
            seasonKey: null,
            sequenceRevision: 1,
            sequenceStatus: 'ordered' as const,
            // 预览层证据恒 unverified(T025);等级/连续性证据由定位/probe 阶段推进
            contentLevel: null,
            contentVersionState: 'unverified' as const,
            evidenceKind: null,
            evidenceDigest: null,
            schemaVersion: null,
            continuityRevision: null,
            continuitySignature: null,
          },
        ];
      }),
    }));
    // 私有载荷(含上游定位;JSON 落 vod_detail_snapshot,绝不进公共 DTO)
    const locatorEntries = lines.map((line) => ({
      lineKey: line.lineKey,
      name: line.name,
      episodes: line.episodes.map((episode) => ({
        episodeKey: episode.episodeKey,
        locatorUrl: episode.locatorUrl,
      })),
    }));
    const fetchedAtMs = typeof payload['fetchedAtMs'] === 'number' ? payload['fetchedAtMs'] : 0;
    return {
      detailRevision: typeof payload['previewRevision'] === 'number' ? payload['previewRevision'] : 0,
      locatorRevision: typeof payload['locatorRevision'] === 'number' ? payload['locatorRevision'] : 0,
      title: typeof payload['title'] === 'string' ? payload['title'] : '',
      description: typeof payload['synopsis'] === 'string' ? payload['synopsis'] : null,
      parentContentLevel: null,
      payloadDigest: createHash('sha256').update(JSON.stringify(locatorEntries)).digest('hex'),
      validatedPrivatePayload: JSON.stringify({ kind: 'vod-detail-private', lines: locatorEntries }),
      fetchedAt: new Date(fetchedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      lines: factLines,
    };
  }

  /** 稳定分支:titleRef+episodeRef → 目标事实(选中集必须为预览内 candidate 集) */
  function resolveStableTarget(
    context: MaterializationContext,
    command: Extract<MaterializeCommand, { kind: 'stableRef' }>,
  ): ResolvedMaterializationTarget {
    // 非预览缓存签发的 ref(缓存完全未命中):登记目标注册表兜底(装配桥面;
    // 生产零注册 → 404 同形),注册目标仍受事务内 CAS/策略/配额全量重验。
    if (input.cache.get(command.titleRef) === undefined) {
      const registered = lookupRegisteredStableTarget(command.titleRef, command.episodeRef);
      if (registered === undefined) {
        throw notFound();
      }
      return registered;
    }
    const view = loadTitleEntry(context.householdId, command.titleRef);
    const payload = view.payload;
    if (payload['kind'] !== 'title-preview') {
      // 仅有搜索绑定(尚未取详情):不存在可物化的预览事实 → 410 同形
      throw previewExpired('预览引用已过期,请重新获取预览');
    }
    const sourceId = typeof payload['sourceId'] === 'string' ? payload['sourceId'] : '';
    const locatorRevision = typeof payload['locatorRevision'] === 'number' ? payload['locatorRevision'] : 0;
    requireSourceAlive(context.householdId, sourceId, locatorRevision);

    // episodeRef 经注册表反查:必须签发于本标题条目(entryId=titleRef;伪造/跨标题 404)
    const episodeResolution = input.cache.resolveRef(command.episodeRef);
    if (episodeResolution === undefined || episodeResolution.entryId !== command.titleRef) {
      throw notFound();
    }
    const lines = (payload['lines'] ?? []) as readonly StoredLineLike[];
    let selected: { lineKey: string; episodeKey: string } | undefined;
    for (const line of lines) {
      if (line.lineKey === null || line.lineKey.length === 0) continue;
      for (const episode of line.episodes) {
        if (
          episode.episodeRef === command.episodeRef &&
          episode.status === 'candidate' &&
          episode.episodeKey !== null
        ) {
          selected = { lineKey: line.lineKey, episodeKey: episode.episodeKey };
        }
      }
    }
    if (selected === undefined) {
      // 选中集不在当前预览的候选集合内(伪造/非候选):同形 404,不泄露判定细节
      throw notFound();
    }
    return {
      sourceId,
      upstreamVodId: typeof payload['upstreamVodId'] === 'string' ? payload['upstreamVodId'] : '',
      lineKey: selected.lineKey,
      episodeKey: selected.episodeKey,
      previewRevision: typeof payload['previewRevision'] === 'number' ? payload['previewRevision'] : 0,
      previewExpiresAt: new Date(view.expiresAtMs).toISOString(),
      detail: detailFactsOf(payload, view.expiresAtMs),
    };
  }

  /** 候选分支:登记映射新鲜度门 + 登记目标注册表(缺失 404 候选绑定冲突) */
  function resolveCandidateTarget(
    context: MaterializationContext,
    command: Extract<MaterializeCommand, { kind: 'candidateRef' }>,
  ): ResolvedMaterializationTarget {
    // api §7 I1:同家庭已有登记映射且已过期 → 新 key 不得使用过期原候选(410)
    const registered = input.store.findLatestRegisteredCandidateByCandidateRef(
      context.householdId,
      command.candidateRef,
    );
    if (registered !== undefined && Date.parse(registered.expiresAt) <= Date.now()) {
      throw previewExpired('候选引用已过期,请重新获取候选');
    }
    const target = REGISTERED_CANDIDATE_TARGETS.get(command.candidateRef);
    if (target === undefined) {
      // 从未登记且无服务端绑定:候选绑定冲突 404(与不存在同形;openapi NotFound404)
      throw notFound();
    }
    return target;
  }

  return async (command, context) => {
    if (command.kind === 'stableRef') {
      return resolveStableTarget(context, command);
    }
    return resolveCandidateTarget(context, command);
  };
}

/* ------------------------------------------------------------------ */
/* 注册表读面(仅 module 工厂消费;不构成跨上下文发布面)                  */
/* ------------------------------------------------------------------ */

/** 稳定分支注册表查询(ref → 登记目标;装配桥内部面) */
export function lookupRegisteredStableTarget(titleRef: string, episodeRef: string): ResolvedMaterializationTarget | undefined {
  return REGISTERED_STABLE_TARGETS.get(stableRegistryKey(titleRef, episodeRef));
}
