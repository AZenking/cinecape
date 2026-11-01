import { Body, Controller, Get, Inject, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentProfile } from '@platform/http-common/profile-context/current-profile.decorator';
import type { ProfileContext } from '@platform/http-common/profile-context/current-profile.decorator';
import { CurrentSession } from '@platform/http-common/current-session.decorator';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { SameOriginGuard } from '@platform/http-common/same-origin/same-origin.guard';
import { SessionGuard } from '@platform/http-common/session.guard';
import { CurrentProfileGuard } from '@platform/http-common/profile-context/current-profile.guard';
import { RateLimitGuard } from '@platform/http-common/rate-limit/rate-limit.guard';
import { RateLimit } from '@platform/http-common/rate-limit/rate-limit.decorator';
import { StrictBodyPipe, StrictQueryPipe } from '@platform/http-common/strict-input/strict-pipes';
import { strictObject } from '@platform/http-common/strict-input/strict-schema';
import { createSwitchCandidatesService } from '@contexts/online-vod/application/switch-candidates.service';
import type { SwitchCandidatesCommand } from '@contexts/online-vod/application/switch-candidates.service';
import {
  SWITCH_PROBE_BUDGETS,
  createSwitchProbeService,
} from '@contexts/online-vod/application/switch-probe.service';
import type {
  SwitchProbeCommand,
  SwitchProbeResultValues,
} from '@contexts/online-vod/application/switch-probe.service';
import type { SwitchProbePolicyGate, SwitchProbeBudgetShape, VodProbeUpstreamFn } from '@contexts/online-vod/application/switch-probe.service';
import { VodWriteBodyGuard } from '@contexts/online-vod/interface/materialization.controller';
import type { VodSourceConfigurationPort } from '@contexts/online-vod/application/publication-work-set.port';
import type { OnlineVodStore } from '@contexts/online-vod/application/online-vod-store.port';
import type { PlaybackTransitionSourcePort, SwitchSourceContextFacts, SwitchSourceTitleFactsLoader } from '@contexts/online-vod/application/switch-candidates.service';
import type { VodDetailUpstreamFn } from '@contexts/online-vod/application/preview.service';
import type { VodSearchUpstreamFn } from '@contexts/online-vod/application/search.service';
import type { VodCache } from '@contexts/online-vod/infrastructure/vod-cache';
import type { VodRuntimeConfig } from '@contexts/online-vod/infrastructure/vod-config';
import type {
  ResolvedMaterializationTarget,
} from '@contexts/online-vod/application/materialization.service';
import type { MaterializeCommand } from '@contexts/online-vod/application/publication-work-set.port';

/**
 * T070/T071 装配束令牌(本文件就地声明;模块工厂绑定,控制器同文件注入 ——
 * 避免与 online-vod.module.ts 形成 import 环,亦不扩大跨上下文发布面)。
 */
export const VOD_SWITCH_WIRING = Symbol('VOD_SWITCH_WIRING');

/**
 * 换源路由装配束(online-vod.module.ts 工厂产出;控制器构造器内直构 T070/T071 用例)。
 * 全部依赖与本模块既有 provider 同源:VodCache 与 T028/T070 同一单例、上游读取与
 * T028 同一 SafeUpstream 形态、来源配置同端口、来源会话授权为 playback_session
 * 只读投影(PlaybackTransitionSourcePort 消费面;不 import playback 私有实现)。
 */
export interface VodSwitchWiring {
  /** 运行期预算(候选用例消费 VodBudgetShape) */
  readonly config: VodRuntimeConfig;
  /** 测速预算(契约值;api §5「单候选3s/1MiB、全次5s,内部并发3」) */
  readonly probeBudgets: SwitchProbeBudgetShape;
  /** 有界缓存单例(与 T028/T070 同一实例) */
  readonly cache: VodCache;
  /** 来源配置端口(T015 发布面) */
  readonly sourceConfig: VodSourceConfigurationPort;
  /** 候选检索上游(显式首页分页形态;见模块工厂注释) */
  readonly switchSearchUpstream: VodSearchUpstreamFn;
  /** 候选详情上游(T028 详情工厂同形态) */
  readonly fetchDetailUpstream: VodDetailUpstreamFn;
  /** 有界测速上游(装配面接 SafeUpstreamPort;清单形态/预算分类) */
  readonly probeUpstream: VodProbeUpstreamFn;
  /** 过渡来源只读端口(候选/测速授权消费面;404 同形) */
  readonly transitionSource: PlaybackTransitionSourcePort;
  /** 来源可信标题事实投影(签名 → 物化预览事实 → 目录标题回退) */
  readonly loadSourceTitleFacts: SwitchSourceTitleFactsLoader;
  /** 候选目标内容策略门(服务端已有映射事实;internal-ports §3) */
  readonly policyGate: SwitchProbePolicyGate;
  /** 非事务读面(候选预览修订对齐;零写) */
  readonly store: OnlineVodStore;
  /**
   * 来源会话预授权(控制器薄面前置;不存在/跨设备/跨 Profile/旧 context/代次失配
   * 一律 404 同形 —— api §0「旧上下文按既有 404 同形」;T059 只读授权同语义)。
   */
  readonly authorizeSwitchSource: (input: {
    readonly householdId: string;
    readonly deviceSessionId: string;
    readonly profileId: string;
    readonly profileContextVersion: number;
    readonly fromSessionId: string;
    readonly expectedGeneration: number;
  }) => SwitchSourceContextFacts;
  /** 设备会话当前 profile_context_version(会话缺失 401 同形;T031 装配先例) */
  readonly readProfileContextVersion: (deviceSessionId: string) => number;
  /**
   * T070 候选绑定 → 物化目标桥挂载点(VOD_MATERIALIZATION resolveTarget 消费):
   * T070 签发 ref 经缓存注册表反查绑定载荷;非 T070 签发 ref 返回 undefined(回落
   * 基础解析桥),禁源/失配抛 410(对齐 preview 语义)。
   */
  readonly resolveCandidateBindingTarget: (
    householdId: string,
    command: Extract<MaterializeCommand, { kind: 'candidateRef' }>,
  ) => ResolvedMaterializationTarget | undefined;
  /**
   * 物化预览事实登记挂载点(稳定分支解析成功后调用):登记 title/year 服务端事实,
   * 供缺签名标题的候选检索(loadSourceTitleFacts)投影;有界进程内,零持久化。
   */
  readonly noteMaterializedTitleFacts: (
    householdId: string,
    titleRef: string,
    previewCache: { get<P = unknown>(id: string): { readonly payload: P } | undefined },
    target: ResolvedMaterializationTarget,
  ) => void;
}

/**
 * 010 T070/T071 — 换源候选清单与有界测速契约路由(api.md §5;US4)。
 *
 * 控制器薄面:同源/Session/当前 Profile 守卫(Profile 同栈,T031 物化控制器同款)
 * → 限流(候选清单沿用 progress 控制桶 60/min/DeviceSession;测速独立 vodProbe 桶
 * 10/min/DeviceSession,api §0「创建 intent/测速各 10/min/DeviceSession」)→ 写体
 * 预算(16KiB,物化同款)→ 严格 DTO(未知字段/界外一律 400)→ 来源会话预授权
 * (不存在/跨设备/跨 Profile/旧 context/代次失配一律 404 同形;api §0/§5)→
 * 用例执行 → 白名单输出。业务语义零新增:候选聚合/签发/分页在 T070 服务,有界
 * 测速/预算/取消/分类在 T071 服务;no-store 等安全头由全局拦截器保证。
 *
 * 服务直构(本控制器即 T070/T071 组合根接线点):依赖经 VOD_SWITCH_WIRING 装配束
 * 注入(与 T028 搜索/预览同一 VodCache 单例、同一 SafeUpstream 上游工厂形态),
 * 构造器内 createSwitchCandidatesService / createSwitchProbeService 直构。
 *
 * 测速取消传播:客户端断连(res close 且未正常结束)即经 AbortSignal 传入服务面,
 * 挂起上游在预算内收敛(api §6「取消传播 AbortSignal」)。
 */

/* ------------------------------------------------------------------ */
/* 请求 DTO(严格 query/body;openapi 形态)                              */
/* ------------------------------------------------------------------ */

/** GET /vod/switch-candidates 严格 query(未知字段一律 400;不接任意 q/URL;query 值为 wire 字符串,代次经 coerce 收窄) */
const candidatesQuerySchema = strictObject({
  fromSessionId: z.string().uuid(),
  expectedGeneration: z.coerce.number().int().min(1),
  cursor: z.string().min(1).optional(),
});

/** POST /vod/switch-probes 严格 body(candidateRefs 1–3 个不透明引用) */
const probesBodySchema = strictObject({
  fromSessionId: z.string().uuid(),
  expectedGeneration: z.number().int().min(1),
  candidateRefs: z.array(z.string().min(1)).min(1).max(3),
});

/** 契约未钉体的 GET 防御性空体(未知 JSON 字段一律 400,公共检索同款) */
const EMPTY_BODY_SCHEMA = z.preprocess((value: unknown) => value ?? {}, strictObject({}));

/** 成功响应 Content-Type(契约 e2e 对 problem+json 形态断言;播放控制同款惯例) */
const RESPONSE_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

/* ------------------------------------------------------------------ */
/* 输出白名单(api §1/§5 回执键;内部字段零下发)                          */
/* ------------------------------------------------------------------ */

/** 候选清单回执(api §5 200:{items,nextCursor,partial,reasons};expiresAt 不下发) */
interface SwitchCandidatesReplyDto {
  readonly items: readonly Record<string, unknown>[];
  readonly nextCursor: string | null;
  readonly partial: boolean;
  readonly reasons: readonly string[];
}

/** 测速回执(api §5 200:{items:ProbeResult[]};ProbeResult 恒 4 键纯值) */
interface SwitchProbesReplyDto {
  readonly items: readonly SwitchProbeResultValues[];
}

/* ------------------------------------------------------------------ */
/* 控制器                                                               */
/* ------------------------------------------------------------------ */

@Controller('vod')
@UseGuards(SameOriginGuard, SessionGuard, CurrentProfileGuard)
export class VodSwitchController {
  /** T070 换源候选用例(构造器直构;依赖全部来自装配束) */
  private readonly candidates: ReturnType<typeof createSwitchCandidatesService>;
  /** T071 有界测速用例(构造器直构;依赖全部来自装配束) */
  private readonly probes: ReturnType<typeof createSwitchProbeService>;
  private readonly wiring: VodSwitchWiring;

  constructor(
    // @Inject 显式声明(esbuild/tsx 不发射 design:paramtypes;仓库既有惯例)
    @Inject(VOD_SWITCH_WIRING) wiring: VodSwitchWiring,
  ) {
    this.wiring = wiring;
    this.candidates = createSwitchCandidatesService({
      config: wiring.config,
      cache: wiring.cache,
      sourceConfig: wiring.sourceConfig,
      searchUpstream: wiring.switchSearchUpstream,
      fetchDetailUpstream: wiring.fetchDetailUpstream,
      transitionSource: wiring.transitionSource,
      loadSourceTitleFacts: wiring.loadSourceTitleFacts,
      store: wiring.store,
    });
    this.probes = createSwitchProbeService({
      config: wiring.probeBudgets ?? SWITCH_PROBE_BUDGETS,
      cache: wiring.cache,
      sourceConfig: wiring.sourceConfig,
      transitionSource: wiring.transitionSource,
      policyGate: wiring.policyGate,
      probeUpstream: wiring.probeUpstream,
    });
  }

  /**
   * GET /vod/switch-candidates:已授权 fromSession 可信标题 → 多源聚合候选
   * (api §5 200{items,nextCursor,partial,reasons};服务端从来源标题构造搜索,
   * 不接任意 q/URL;failed 可恢复来源仅 60s)。来源会话预授权在服务前执行:
   * 不存在/跨设备/跨 Profile/旧 context/代次失配一律 404 同形。
   */
  @Get('switch-candidates')
  @UseGuards(RateLimitGuard)
  @RateLimit('progress')
  async listCandidates(
    @Query(new StrictQueryPipe(candidatesQuerySchema))
    query: { readonly fromSessionId: string; readonly expectedGeneration: number; readonly cursor?: string },
    @Body(new StrictBodyPipe(EMPTY_BODY_SCHEMA)) _body: Record<string, never>,
    @CurrentSession() session: SessionContext,
    @CurrentProfile() profile: ProfileContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SwitchCandidatesReplyDto> {
    res.setHeader('Content-Type', RESPONSE_CONTENT_TYPE);
    const householdId = session.session.householdId;
    const deviceSessionId = session.session.id;
    const profileContextVersion = this.wiring.readProfileContextVersion(deviceSessionId);
    this.wiring.authorizeSwitchSource({
      householdId,
      deviceSessionId,
      profileId: profile.id,
      profileContextVersion,
      fromSessionId: query.fromSessionId,
      expectedGeneration: query.expectedGeneration,
    });
    const command: SwitchCandidatesCommand = {
      householdId,
      deviceSessionId,
      profileId: profile.id,
      profileContextVersion,
      fromSessionId: query.fromSessionId,
      expectedGeneration: query.expectedGeneration,
      cursor: query.cursor ?? null,
    };
    const page = await this.candidates.listCandidates(command);
    return {
      items: page.items.map((item) => ({ ...item })),
      nextCursor: page.nextCursor,
      partial: page.partial,
      reasons: [...page.reasons],
    };
  }

  /**
   * POST /vod/switch-probes:逐候选「先授权再测」有界诊断(api §5;ProbeResult 4 键;
   * 单候选 3s/1MiB、全次 5s、内部并发 3;无票/无历史/不物化)。未授权目标 404 同形
   * 且零上游请求;客户端断连经 AbortSignal 传播取消。
   */
  @Post('switch-probes')
  @UseGuards(RateLimitGuard, VodWriteBodyGuard)
  @RateLimit('vodProbe')
  async probe(
    @Body(new StrictBodyPipe(probesBodySchema))
    body: { readonly fromSessionId: string; readonly expectedGeneration: number; readonly candidateRefs: readonly string[] },
    @CurrentSession() session: SessionContext,
    @CurrentProfile() profile: ProfileContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SwitchProbesReplyDto> {
    res.setHeader('Content-Type', RESPONSE_CONTENT_TYPE);
    const householdId = session.session.householdId;
    const deviceSessionId = session.session.id;
    const profileContextVersion = this.wiring.readProfileContextVersion(deviceSessionId);
    // 取消传播:客户端断连(响应未正常结束即连接关闭)→ 中止全部挂起上游
    const abort = new AbortController();
    const onClientGone = (): void => {
      if (!res.writableEnded) {
        abort.abort();
      }
    };
    res.on('close', onClientGone);
    const command: SwitchProbeCommand = {
      householdId,
      deviceSessionId,
      profileId: profile.id,
      profileContextVersion,
      fromSessionId: body.fromSessionId,
      expectedGeneration: body.expectedGeneration,
      candidateRefs: body.candidateRefs,
      signal: abort.signal,
    };
    try {
      const items = await this.probes.probe(command);
      // POST 缺省 201 → 契约钉 200(api §5 测速行「200{items}」)
      res.status(200);
      return { items: [...items] };
    } finally {
      res.off('close', onClientGone);
    }
  }
}
