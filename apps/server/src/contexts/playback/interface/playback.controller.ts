import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Res, UseGuards } from '@nestjs/common';
import { PlaybackReadinessGuard } from '@contexts/playback/interface/playback-readiness.guard';
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Response, Request } from 'express';
import { z } from 'zod';
import { ProblemCode } from '@hmp/shared';
import { CurrentSession, type SessionContext } from '@platform/http-common/current-session.decorator';
import { SessionGuard } from '@platform/http-common/session.guard';
import { createDomainError, DomainError } from '@platform/http-common/domain-error';
import { RateLimit } from '@platform/http-common/rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '@platform/http-common/rate-limit/rate-limit.guard';
import { parseBody } from '@contexts/identity-access';
import { getConfig } from '@platform/config/env';
import { createPlaybackBudgets } from '@platform/config/playback-budgets';
import { PlaybackRepository } from '@contexts/playback/infrastructure/playback.repository';
import { PlaybackAuthorizationService } from '@contexts/playback/application/playback-authorization.service';
import { PlaybackTicketService, type TicketReply } from '@contexts/playback/application/playback-ticket.service';
import { PlaybackResolverService, type PlaybackDto } from '@contexts/playback/application/playback-resolver.service';
// 010 T060:过渡消费编排(resolve 过渡分支最小接线;完整判别面归 T061)
import { PlaybackTransitionService } from '@contexts/playback/application/playback-transition.service';
import {
  PlaybackSelectionService,
  type SeekCapability,
} from '@contexts/playback/application/playback-selection.service';
import { playbackStore } from '@contexts/playback/application/playback-store.port';
import { PlaybackLifecycleService } from '@contexts/playback/infrastructure/playback-lifecycle.service';
import { PlaybackRateLimitService, type PlaybackRateLimitBucket } from '@contexts/playback/application/playback-rate-limit.service';
import { PlaybackAuditService } from '@contexts/playback/application/playback-audit.service';
// 007-T021:PersonalDataModule exports 已对齐令牌,注入改经发布令牌(裸导入 = 发布面契约)
// 007-T022a:类型注解改用发布面接口 IProgressWriteService(注入值仍为实现类实例,行为零变化)
// 010 T046:progress 面切 applySampleDetailed(8 键 ProgressSampleOutcome;applySample 3 键旧义保留)
import {
  PROGRESS_WRITE_PORT,
  type IProgressWriteService,
  type ProgressSampleOutcome,
  type ProgressSampleReply,
} from '@contexts/personal-data';

/**
 * 播放控制端点(T031,spec 004)—— resolve/GET session/renew/heartbeat/stop/selection/seek。
 *
 * 权威依据(先读后写):
 * - docs/specs/004-playback-resolver/contracts/api.md「控制端点」「稳定错误」节:
 *   请求/成功形态、CAS(expectedVersion/expectedGeneration)、未知字段拒绝、
 *   跨设备/家庭统一 404、限频 429+Retry-After、位置/轨道校验语义;
 * - 授权顺序:SessionGuard(令牌入口唯一权威)→ authorization.authorizeControl
 *   (归属/绑定档案/最新策略/家庭资源;真实 id 与随机 id 同形 404 不泄漏存在性);
 * - 领域错误一律直接抛出 DomainError,由全局 ProblemJsonFilter 统一渲染
 *   problem+json + Cache-Control:no-store + Referrer-Policy:no-referrer;
 * - 响应 Content-Type 按契约 e2e 断言统一为 application/problem+json(charset=utf-8;
 *   superagent 按 +json 结构化后缀解析,res.body 不受影响)。
 *
 * 端点行为逐条对齐契约(实现细节见各服务文件头):
 * - POST /resolve:authorizeResolve → resolver.resolve → 201 PlaybackDto + Location;
 *   主动重复 resolve 各建新 session(授权拒绝不建 session 由 resolver 顺序保证);
 * - GET /sessions/:id:authorizeControl 归属校验 → repository.getSession → toDto
 *   (GET 不重签也不复现旧票:票字段恒空);
 * - POST /renew:ticket.issueOrRenew(authorizeControl + revalidate + 短事务 CAS 签发)→ 200;
 * - POST /heartbeat:lifecycle.heartbeat(不递增 version/generation;终态不复活)→ 204;
 * - POST /stop:lifecycle.stopSession(幂等,终态零副作用;取消 preparing 即终态)→ 204;
 * - PUT /selection、POST /seek:selection 服务(CAS/单槽串行/时间轴元数据)→ 200 PlaybackDto。
 *
 * 请求面横切(本文件 PlaybackWriteGuard):
 * - 同源/CSRF:JSON 写端点校验 Origin(存在时必须与请求 Host 同源)与 Sec-Fetch-Site
 *   (cross-site 拒绝;无头的非浏览器客户端放行 —— 契约:Cookie 浏览器同源,Bearer
 *   客户端逐请求携带原认证,token 不能单独授权);既有代码无任何 CSRF 机制
 *   (全仓检索 decorator/guard/interceptor 无 Origin/CSRF 相关实现),按任务口径落
 *   最小同源校验并在此说明;
 * - 体限制:Content-Length > budgets.request.jsonBodyMaxBytes(16KiB)→ 400
 *   VALIDATION_FAILED。main.ts 未配置全局 body parser limit(既有现状),
 *   按最小侵入原则只在播放控制路由以守卫校验,不改动全局配置。
 */

/* ------------------------------------------------------------------ */
/* 请求体契约(strict:未知字段拒绝,api.md「未知字段拒绝」)                 */
/* ------------------------------------------------------------------ */

/**
 * resolve 请求契约(005 api.md §5:strict 拒绝未知字段 —— profileId/householdId/
 * startPosition 等一律 400;startMode 缺省 beginning,resume 仅点播,频道请求 resume
 * 由 resolver 依媒体类型返回 400 PLAYBACK_SEEK_UNSUPPORTED)。
 * 010 过渡分支(api.md §4 严格 oneOf,T061 判别面):基础分支 {mediaId,startMode?} 与
 * 过渡分支 {mediaId,transitionIntentId} 为严格互斥 union —— 两分支各自 .strict(),
 * additionalProperties 互斥:过渡请求携 startMode、基础请求携 transitionIntentId 均
 * 以未知字段 400(不依赖 refine 的「共现拒绝」,分支面即判别面)。
 * 016 api.md §2.1 增量(经父代理契约-现实裁决走现行 POST /playback/resolve 请求体):
 * lineId 可选(指定物理线路,= resolve 响应 lines[].lineId 回传);过渡分支不收 lineId
 * (严格面保持)。service 层无法收口:strict zod 在控制器先拒绝未知字段。
 */
const resolveBaseRequestSchema = z
  .object({
    mediaId: z.string().min(1),
    startMode: z.enum(['beginning', 'resume']).optional(),
    lineId: z.string().min(1).optional(),
  })
  .strict();

const resolveTransitionRequestSchema = z
  .object({
    mediaId: z.string().min(1),
    transitionIntentId: z.string().min(1),
  })
  .strict();

/** resolve 严格判别 union(过渡分支优先判别;导出供单元面断言互斥契约) */
export const resolveRequestContractSchema = z.union([resolveTransitionRequestSchema, resolveBaseRequestSchema]);

type ResolveRequest = z.infer<typeof resolveRequestContractSchema>;

const renewRequestSchema = z
  .object({ expectedGeneration: z.number().int().min(1) })
  .strict();

const heartbeatRequestSchema = z
  .object({
    positionSeconds: z.number().finite().min(0),
    paused: z.boolean(),
  })
  .strict();

/**
 * progress 请求契约(005 api.md §5 progress;T092):body=`{sampleSeq,expectedGeneration,
 * positionSeconds,reason}`,reason=started|periodic|pause;未知字段拒绝;体 <=16KiB 由
 * PlaybackWriteGuard 承担。sampleSeq 为会话生命周期内单调正整数。
 */
const progressRequestSchema = z
  .object({
    sampleSeq: z.number().int().min(1),
    expectedGeneration: z.number().int().min(1),
    positionSeconds: z.number().finite().min(0),
    reason: z.enum(['started', 'periodic', 'pause']),
  })
  .strict();

/**
 * stop 请求契约(005 api.md §5「stop 与最终保存」;T101):finalProgress 可选
 * `{sampleSeq,expectedGeneration,positionSeconds}`;空 body 结束准备/取消(既有语义)。
 */
const stopRequestSchema = z
  .object({
    finalProgress: z
      .object({
        sampleSeq: z.number().int().min(1),
        expectedGeneration: z.number().int().min(1),
        positionSeconds: z.number().finite().min(0),
      })
      .strict()
      .optional(),
  })
  .strict();

const selectionRequestSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    positionSeconds: z.number().finite().min(0).optional(),
    audioTrackId: z.string().min(1).optional(),
    subtitleTrackId: z.string().min(1).nullable().optional(),
  })
  .strict();

const seekRequestSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    positionSeconds: z.number().finite().min(0),
  })
  .strict();

/** 成功响应 Content-Type(契约 e2e 对 problem+json 形态断言;+json 后缀照常 JSON 解析) */
const RESPONSE_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

/** 成功响应公共安全头(api.md 开篇:所有响应 no-store/no-referrer,媒体字节不公开缓存) */
function applyControlResponseHeaders(res: Response): void {
  res.setHeader('Content-Type', RESPONSE_CONTENT_TYPE);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

/**
 * 010 T046 状态面响应(PlaybackDto HTTP 形态追加;api.md §7 I4):resolver 的
 * PlaybackDto 类型保持既有键面(resolver 已定稿不改),在线 vod 会话的 GET 状态/renew
 * 响应以交集扩展携带 I4 事实 —— seekCapability(none|client|server_rebuild)/
 * playbackStarted:boolean,经 T045 sessionSeekFacts(事实来源=交付/probe 时长与
 * playback_started_at 只读投影)。
 */
interface PlaybackStatusDto extends PlaybackDto {
  readonly seekCapability?: SeekCapability;
  readonly playbackStarted?: boolean;
}

/** renew 响应(TicketReply 同面追加;仅在线 vod 会话携带 I4 两键) */
interface PlaybackRenewReply extends TicketReply {
  readonly seekCapability?: SeekCapability;
  readonly playbackStarted?: boolean;
}

/**
 * 会话媒体是否在线点播子项(T043 判别同源:media_item.media_role='vod_episode')。
 * 仅在线 vod 会话扩展 I4/8 键面;NAS/IPTV/直播(standalone)键面零变化 —— T019
 * resource-selection 单测钉死 standalone preparing 状态 DTO 恰 13 键、T092 钉死
 * progress 恰 3 键,全形态统一键面会破坏既有绿基线,故按 T043 先例「仅 vod 会话携带」。
 */
function isOnlineVodSession(householdId: string, mediaId: string): boolean {
  return playbackStore().findMediaItemRowInHousehold(householdId, mediaId)?.mediaRole === 'vod_episode';
}

/* ------------------------------------------------------------------ */
/* 写端点横切守卫(同源/CSRF + 16KiB 体限制;GET/HEAD 豁免)               */
/* ------------------------------------------------------------------ */

@Injectable()
export class PlaybackWriteGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return true;
    }
    // 16KiB JSON 体预算(仅播放控制路由;全局 body parser 配置保持既有现状不动);
    // 预算在调用期读取「当前」已校验 env(与模块工厂同款 per-rig 语义,类引用守卫不走 DI)
    const jsonBodyMaxBytes = createPlaybackBudgets(getConfig()).request.jsonBodyMaxBytes;
    const contentLength = request.headers['content-length'];
    if (typeof contentLength === 'string' && contentLength !== '') {
      const bytes = Number(contentLength);
      if (Number.isFinite(bytes) && bytes > jsonBodyMaxBytes) {
        throw new DomainError(400, ProblemCode.VALIDATION_FAILED, 'JSON 请求体超出 16KiB 预算');
      }
    }
    // CSRF:跨站fetch元数据头优先(现代浏览器;cross-site 一律拒绝)
    const secFetchSite = request.headers['sec-fetch-site'];
    if (typeof secFetchSite === 'string' && secFetchSite.trim().toLowerCase() === 'cross-site') {
      throw new DomainError(403, ProblemCode.FORBIDDEN, '跨站写请求被拒绝');
    }
    // Origin 同源校验(存在即必须与请求 Host 同源;不发送 Origin 的非浏览器客户端放行)
    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin !== '') {
      let originHost = '';
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = '';
      }
      const host = typeof request.headers.host === 'string' ? request.headers.host : '';
      if (originHost === '' || originHost !== host) {
        throw new DomainError(403, ProblemCode.FORBIDDEN, '非同源写请求被拒绝');
      }
    }
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* 控制器                                                               */
/* ------------------------------------------------------------------ */

@Controller('playback')
@UseGuards(PlaybackReadinessGuard, SessionGuard, PlaybackWriteGuard)
export class PlaybackController {
  /**
   * 构造注入显式 token:契约测试管线(vitest/esbuild)不产出 design:paramtypes 元数据,
   * 依赖解析必须逐参数 @Inject(与模块工厂 inject 数组同一语义)。
   */
  constructor(
    @Inject(PlaybackRepository) private readonly repository: PlaybackRepository,
    @Inject(PlaybackAuthorizationService) private readonly authorization: PlaybackAuthorizationService,
    @Inject(PlaybackResolverService) private readonly resolver: PlaybackResolverService,
    @Inject(PlaybackTicketService) private readonly ticket: PlaybackTicketService,
    @Inject(PlaybackLifecycleService) private readonly lifecycle: PlaybackLifecycleService,
    @Inject(PlaybackSelectionService) private readonly selection: PlaybackSelectionService,
    @Inject(PlaybackRateLimitService) private readonly rateLimit: PlaybackRateLimitService,
    @Inject(PlaybackAuditService) private readonly audit: PlaybackAuditService,
    @Inject(PROGRESS_WRITE_PORT) private readonly progressWrite: IProgressWriteService,
    @Inject(PlaybackTransitionService) private readonly transitions: PlaybackTransitionService,
  ) {}

  /**
   * POST /playback/resolve:主动解析建 preparing session(201 + Location;不等待 probe)。
   * 拒绝旁路(T043):授权/解析抛出的 DomainError 先经审计服务落 failure_event
   * (仅认证成功的会话;401 SESSION_INVALID 不写)后原样重抛 —— 接入点为控制器 catch,
   * authorization/resolver 零改动(最小侵入;审计写入尽力而为,不影响响应)。
   */
  @Post('resolve')
  async resolve(
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PlaybackDto | Record<string, unknown>> {
    const input: ResolveRequest = parseBody(resolveRequestContractSchema, body);
    this.requireSlot(context, res, 'control');
    // 010 T061 过渡分支(US3 完整判别面;schema 严格 union 保证分支互斥):携带
    // transitionIntentId 时走过渡消费编排(201 consumed/200 同 intent 重放同后继,
    // Location 同形),并发起后继 fire-and-forget 准备;审计旁路与常规 resolve 同款。
    if ('transitionIntentId' in input) {
      const transitioned = await this.transitions
        .resolveTransition(context, { mediaId: input.mediaId, transitionIntentId: input.transitionIntentId })
        .catch((error: unknown) => {
          this.audit.recordResolveRejection(context, input.mediaId, error);
          throw error;
        });
      res.status(transitioned.kind === 'replayed' ? 200 : 201);
      res.setHeader('Location', `/api/playback/sessions/${transitioned.sessionId}`);
      applyControlResponseHeaders(res);
      return transitioned.dto;
    }
    const outcome = await this.resolver
      .resolve(context, input.mediaId, { startMode: input.startMode, lineId: input.lineId })
      .catch((error: unknown) => {
        this.audit.recordResolveRejection(context, input.mediaId, error);
        throw error;
      });
    res.setHeader('Location', `/api/playback/sessions/${outcome.session.id}`);
    applyControlResponseHeaders(res);
    return outcome.dto;
  }

  /** GET /playback/sessions/:id:原设备+原档案轮询(票字段恒空;不泄漏源) */
  @Get('sessions/:id')
  async get(
    @Param('id') id: string,
    @CurrentSession() context: SessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PlaybackStatusDto> {
    // 归属校验(非本设备/跨家庭/不存在统一 404 PLAYBACK_NOT_FOUND;终态行仍可查询)
    await this.authorization.authorizeControl(context, id);
    const loaded = this.repository.getSession(context.session.householdId, id);
    if (!loaded.ok) {
      throw createDomainError(loaded.code, loaded.detail);
    }
    applyControlResponseHeaders(res);
    // 010 T046(api.md §7 I4):在线 vod 会话追加 seekCapability/playbackStarted(经
    // T045 sessionSeekFacts;preparing 期 delivery/duration 未定 → none/false);
    // 其余媒体角色 DTO 键面零变化(004/005 契约回归)。
    if (!isOnlineVodSession(context.session.householdId, loaded.value.mediaId)) {
      return this.resolver.toDto(loaded.value);
    }
    const seekFacts = await this.selection.sessionSeekFacts(context.session.householdId, id);
    return {
      ...this.resolver.toDto(loaded.value),
      seekCapability: seekFacts.seekCapability,
      playbackStarted: seekFacts.playbackStarted,
    };
  }

  /** POST /playback/sessions/:id/renew:复用 session 仅换票(200 TicketReply;vod 会话附 I4 两键) */
  @Post('sessions/:id/renew')
  @HttpCode(200)
  async renew(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PlaybackRenewReply> {
    const input = parseBody(renewRequestSchema, body);
    this.requireSlot(context, res, 'renew');
    // 换代 CAS 请求侧预检(契约 e2e:seek 换代后携旧代 expectedGeneration 的 renew 得
    // 409 PLAYBACK_GENERATION_STALE,不落入 preparing 的 PLAYBACK_NOT_READY)——只读比对,
    // 签发短事务内的仓储 CAS 仍是唯一权威(竞态窗口由其收口,零写入语义不变)
    const loaded = this.repository.getSession(context.session.householdId, id);
    if (loaded.ok && loaded.value.generation !== input.expectedGeneration) {
      throw createDomainError('PLAYBACK_GENERATION_STALE');
    }
    applyControlResponseHeaders(res);
    const reply = await this.ticket.issueOrRenew(id, input.expectedGeneration, context);
    // 010 T046(api.md §7 I4):在线 vod 会话的 renew 响应同面追加 I4 事实(TicketReply
    // 三键原样保留;其余媒体角色零变化)。
    if (loaded.ok && isOnlineVodSession(context.session.householdId, loaded.value.mediaId)) {
      const seekFacts = await this.selection.sessionSeekFacts(context.session.householdId, id);
      return {
        ...reply,
        seekCapability: seekFacts.seekCapability,
        playbackStarted: seekFacts.playbackStarted,
      };
    }
    return reply;
  }

  /** POST /playback/sessions/:id/heartbeat:15s 遥测(204;不递增 version/generation) */
  @Post('sessions/:id/heartbeat')
  @HttpCode(204)
  async heartbeat(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<void> {
    // 归属校验(跨设备/跨家庭/不存在统一 404;终态不复活由仓储终态守卫拒绝)
    await this.authorization.authorizeControl(context, id);
    const input = parseBody(heartbeatRequestSchema, body);
    const result = this.lifecycle.heartbeat(id, {
      positionSeconds: input.positionSeconds,
      paused: input.paused,
    });
    if (!result.ok) {
      throw createDomainError(result.code, result.detail);
    }
  }

  /**
   * POST /playback/sessions/:id/progress(005 api.md §5 progress;T100):
   * 全量校验(会话/当前 Profile/资源修订/时长/generation/上下文版本,经 authorizeControl
   * 与写入状态机两层)后按 data-model §7 写入状态转换处理;限频每 DeviceSession
   * 60 次/分钟(方法级守卫位于类级 SessionGuard 之后,§1 限频次序)。
   *
   * 010 T046(api.md §1 ProgressReply 8 键):写入面切 applySampleDetailed(与
   * applySample 同一编排的会话接受+历史应用全量形态),按媒体角色投影响应键面 ——
   * 在线 vod 会话(media_role='vod_episode')返回 8 键(applied/reason/historyRevision
   * + sessionAccepted/acceptedSampleSeq/acceptedPositionSeconds/acceptedGeneration/
   * sessionStarted);NAS 静态/直播会话(standalone/channel 同路由)投影回既有 3 键
   * (applied 只指历史写入旧义;T092 恰 3 键断言回归保护)。投影只裁键不改值。
   */
  @Post('sessions/:id/progress')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit('progress')
  async progress(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProgressSampleReply | ProgressSampleOutcome> {
    const input = parseBody(progressRequestSchema, body);
    // 归属/当前 Profile/上下文版本/最新策略授权链(非本设备/跨家庭 404;换档后 404;
    // 绑定档案 ≠ 当前激活档案 403 —— api.md「服务端验证Session、当前Profile、最新策略」)
    await this.authorization.authorizeControl(context, id);
    // 媒体角色判别(T043 同源事实;会话行在授权链已验存在,mediaId 缺失防御性归 standalone)
    const mediaId = playbackStore().findSessionMediaId(id)?.mediaId ?? '';
    const isOnlineVod = isOnlineVodSession(context.session.householdId, mediaId);
    const outcome = this.progressWrite.applySampleDetailed(
      {
        householdId: context.session.householdId,
        deviceSessionId: context.session.id,
        sessionId: id,
      },
      input,
    );
    applyControlResponseHeaders(res);
    if (isOnlineVod) {
      return outcome;
    }
    return { applied: outcome.applied, reason: outcome.reason, historyRevision: outcome.historyRevision };
  }

  /**
   * POST /playback/sessions/:id/stop:幂等终止(204;终态零副作用,取消 preparing 同此)。
   * stop 走 contextVersion:'any'(api.md §5「身份撤销后的 stop 沿用既有最小幂等清理
   * 规则」):旧上下文会话已被身份变化事务终态化,重复 stop 保持幂等清理语义,不因
   * 版本失衡升级为读写拒绝。携 finalProgress 时改为 'current':身份变化之后旧上下文
   * 不允许夹带历史写入(404 同形);final 与终态在同一事务先保存后终态化(T101)。
   *
   * 010 T058 增量(仅响应编码面,204 状态/幂等/授权语义零变化):空体以显式 JSON
   * Content-Type 经 res.end() 收尾 —— express res.send 对 204 恒剥离 Content-Type,
   * supertest/superagent 对无类型空体解析为 {}(truthy),T051 D2 冻结断言「finish 先赢
   * 后 stop 仍 204 且响应体为 falsy 空体」不可成立;带类型空体经 JSON 解析器落 ''(falsy),
   * 语义仍为 RFC 9113 无内容(安全头已由全局拦截器在进控制器前设置)。
   */
  @Post('sessions/:id/stop')
  @HttpCode(204)
  async stop(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
    @Res() res: Response,
  ): Promise<void> {
    const input = parseBody(stopRequestSchema, body);
    if (input.finalProgress !== undefined) {
      await this.authorization.authorizeControl(context, id, { contextVersion: 'current' });
      const result = await this.lifecycle.stopSessionWithFinal(id, input.finalProgress);
      if (!result.ok) {
        throw createDomainError(result.code, result.detail);
      }
    } else {
      await this.authorization.authorizeControl(context, id, { contextVersion: 'any' });
      const result = await this.lifecycle.stopSession(id);
      if (!result.ok) {
        throw createDomainError(result.code, result.detail);
      }
    }
    res.setHeader('Content-Type', 'application/json');
    res.status(204);
    res.end();
  }

  /** PUT /playback/sessions/:id/selection:授权后原子换轨(200 PlaybackDto;无票字段) */
  @Put('sessions/:id/selection')
  async select(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PlaybackDto> {
    const input = parseBody(selectionRequestSchema, body);
    this.requireSlot(context, res, 'control');
    const outcome = await this.selection.selectTracks(id, input, context);
    applyControlResponseHeaders(res);
    return outcome.dto;
  }

  /** POST /playback/sessions/:id/seek:NAS 定位换代(200 PlaybackDto;直播 400 不支持) */
  @Post('sessions/:id/seek')
  @HttpCode(200)
  async seek(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PlaybackDto> {
    const input = parseBody(seekRequestSchema, body);
    this.requireSlot(context, res, 'control');
    const outcome = await this.selection.seek(id, input, context);
    applyControlResponseHeaders(res);
    return outcome.dto;
  }

  /* ---------------- 内部 ---------------- */

  /**
   * 解析控制限频(contracts:resolve/seek/selection 每设备每分钟 30 次共享桶;
   * renew 每分钟 10 次独立桶)。超限 429 PLAYBACK_RATE_LIMITED,Retry-After(秒,
   * 向上取整)由本处动态注入响应头(ProblemJsonFilter 注册表无动态头)。
   */
  private requireSlot(context: SessionContext, res: Response, bucket: PlaybackRateLimitBucket): void {
    const outcome = this.rateLimit.acquire(context.session.deviceId, bucket);
    if (!outcome.ok) {
      res.setHeader('Retry-After', String(outcome.retryAfterSeconds));
      throw createDomainError('PLAYBACK_RATE_LIMITED');
    }
  }
}
