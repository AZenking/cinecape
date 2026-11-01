/**
 * 过渡端点控制器(010-online-vod T060,US3)—— next-plans / transition-intents HTTP 面。
 *
 * 端点(api.md §5 + §7 I3):
 * - POST /playback/next-plans:200 NextPlanReply(9 键;TTL 60s 固定;每设备 20 活计划
 *   按最早过期淘汰 —— store cap 参数,不另写淘汰;无确定下一集 404 VOD_NEXT_UNAVAILABLE);
 * - POST /playback/transition-intents:201 IntentReply(同 key 重放 200 同结果不续 TTL;
 *   异摘要 409 IDEMPOTENCY_CONFLICT;槽 CAS 409 TRANSITION_SLOT_CONFLICT 附原后继;
 *   过期计划 410 NEXT_PLAN_EXPIRED);
 * - GET /playback/transition-intents/:id:200 IntentReply(过期未消费 410);
 * - POST /playback/transition-intents/:id/cancel:200 TransitionCancelReply(取消输给
 *   消费返回 successor);
 * - POST /playback/transition-intents/:id/cleanup(010 T062):200 TransitionCleanupReply
 *   仅 outcome 键(api.md §7 I5 最小清理;不要求策略放行,不返回目标 ID/元数据/位置/票据);
 * - GET /playback/transition-intents/:id 失权判定(T062):完整 IntentReply 要求当前源/
 *   目标权限 —— 路由先经 TransitionCleanupService.assertFullReplyEntitlement(归属同形
 *   404 先行 + 授权权威失权 4xx),失权不返回完整结果、客户端转 cleanup(api §5 GET 行
 *   「不借 GET 发票」);判定通过后委托既有 getIntent(过期未消费 410 语义不变);
 * - switch/recover_switch(T072,US4):经同一 POST /playback/transition-intents 端点
 *   开放 —— 请求 schema(T052 严格 oneOf switch 分支)原样放行,编排归服务层
 *   createSwitchIntent(候选绑定 registeredCandidateRef+previewRevision CAS/carry
 *   checkpoint 精确匹配/recover 60s 故障窗;本文件零分支差异)。
 *
 * 请求面(严格 zod;api.md §5 IntentRequest 严格 oneOf):
 * - next/manual_next:nextPlanRef 必填、positionMode 即用户选择;historyChoiceConfirmed
 *   与客户端目标 ID 未收录 → 未知字段 400 VALIDATION_FAILED(T052 B7/H3 钉面);
 * - switch/recover_switch:形态收录(T072 起真实编排 —— 候选绑定/carry checkpoint/
 *   故障恢复窗,语义面归服务层);
 * - 未知字段拒绝(.strict)、伪造 profileId/householdId 400(H3);
 * - 守卫链同栈:PlaybackReadinessGuard → SessionGuard(令牌入口唯一权威,游客/伪造
 *   token 401 SESSION_INVALID)→ PlaybackWriteGuard(同源/CSRF + 16KiB 体限制);
 * - 响应头与 PlaybackController 同款(no-store/no-referrer;错误由全局 ProblemJsonFilter
 *   统一渲染 problem+json)。
 *
 * 限频说明(api.md §0「创建 intent 10/min/DeviceSession」):既有限频器桶词表
 * (control/renew)与预算数值归 playback-budgets/playback-rate-limit.service 所有,
 * 本任务文件域不含;过渡桶挂接待预算词表扩展(接线点已留),不在本交付内另写限频。
 */
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentSession, type SessionContext } from '@platform/http-common/current-session.decorator';
import { SessionGuard } from '@platform/http-common/session.guard';
import { parseBody } from '@contexts/identity-access';
import { PlaybackReadinessGuard } from '@contexts/playback/interface/playback-readiness.guard';
import { PlaybackWriteGuard } from '@contexts/playback/interface/playback.controller';
import {
  PlaybackTransitionService,
  type NextPlanCommand,
  type TransitionIntentCommand,
} from '@contexts/playback/application/playback-transition.service';
import { TransitionCleanupService } from '@contexts/playback/application/transition-cleanup.service';

/* ------------------------------------------------------------------ */
/* 请求体契约(严格 oneOf;未知字段拒绝)                                   */
/* ------------------------------------------------------------------ */

/** POST /playback/next-plans(api.md §7 I3:{fromSessionId,expectedGeneration,action}) */
const nextPlanRequestSchema = z
  .object({
    fromSessionId: z.string().min(1),
    expectedGeneration: z.number().int().min(1),
    action: z.enum(['next', 'manual_next']),
  })
  .strict();

/** next/manual_next 分支(nextPlanRef 必填;positionMode 即用户选择;无确认字段) */
const nextIntentRequestSchema = z
  .object({
    fromSessionId: z.string().min(1),
    expectedGeneration: z.number().int().min(1),
    action: z.enum(['next', 'manual_next']),
    nextPlanRef: z.string().min(1),
    positionMode: z.enum(['beginning', 'target_history']),
    expectedSlotRevision: z.number().int().min(0),
    operationKey: z.string().min(1),
  })
  .strict();

/**
 * switch/recover_switch 分支(api.md §5 形态完整收录,服务层一期显式拒绝 ——
 * US4/T072 开放前请求可判别、拒绝明确,不留静默失败)。
 */
const switchIntentRequestSchema = z
  .object({
    fromSessionId: z.string().min(1),
    expectedGeneration: z.number().int().min(1),
    action: z.enum(['switch', 'recover_switch']),
    targetCandidateRef: z.string().min(1),
    previewRevision: z.number().int().min(1),
    positionMode: z.enum(['carry', 'target_history', 'beginning']),
    confirmedAmbiguous: z.boolean(),
    sourceCheckpoint: z
      .object({
        expectedGeneration: z.number().int().min(1),
        sampleSeq: z.number().int().min(1),
      })
      .strict()
      .optional(),
    allowEarlierAcceptedPosition: z.boolean().optional(),
    expectedSlotRevision: z.number().int().min(0),
    operationKey: z.string().min(1),
  })
  .strict();

/** IntentRequest 严格 oneOf(action 判别) */
const intentRequestSchema = z.discriminatedUnion('action', [nextIntentRequestSchema, switchIntentRequestSchema]);

/** cancel 请求(空体) */
const cancelRequestSchema = z.object({}).strict();

/** cleanup 请求(api.md §7 I5:body={};严格拒绝任何附加字段) */
const cleanupRequestSchema = z.object({}).strict();

/* ------------------------------------------------------------------ */
/* 响应头(与 PlaybackController.applyControlResponseHeaders 同款)         */
/* ------------------------------------------------------------------ */

function applyTransitionResponseHeaders(res: Response): void {
  // 与播放控制面同构:恒 problem+json 形态字符集 + no-store/no-referrer(成功响应亦然,
  // 契约 e2e 的 expectProblemContentType 对错误面断言;+json 后缀照常 JSON 解析)
  res.setHeader('Content-Type', 'application/problem+json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

/**
 * 过渡控制器(守卫链与 PlaybackController 同栈;构造注入显式 token,与契约测试
 * 管线无 design:paramtypes 元数据的既有约定一致)。
 */
@Controller('playback')
@UseGuards(PlaybackReadinessGuard, SessionGuard, PlaybackWriteGuard)
export class PlaybackTransitionController {
  constructor(
    @Inject(PlaybackTransitionService) private readonly transitions: PlaybackTransitionService,
    // 010 T062:最小清理编排 + GET 失权判定(cleanup 端点/工作集;I5)
    @Inject(TransitionCleanupService) private readonly cleanup: TransitionCleanupService,
  ) {}

  /** POST /playback/next-plans:200 NextPlanReply(有界服务端计划;不建播放/epoch/历史,不占槽) */
  @Post('next-plans')
  @HttpCode(200)
  async createNextPlan(
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const input = parseBody(nextPlanRequestSchema, body) as NextPlanCommand;
    const reply = await this.transitions.createNextPlan(context, input);
    applyTransitionResponseHeaders(res);
    return reply;
  }

  /** POST /playback/transition-intents:201 IntentReply;同 key 重放 200(动态 status) */
  @Post('transition-intents')
  async createIntent(
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const input = parseBody(intentRequestSchema, body) as TransitionIntentCommand;
    const outcome = await this.transitions.createIntent(context, input);
    res.status(outcome.httpStatus);
    applyTransitionResponseHeaders(res);
    return outcome.reply;
  }

  /** GET /playback/transition-intents/:id:200 IntentReply(过期未消费 410 TRANSITION_EXPIRED) */
  @Get('transition-intents/:id')
  async getIntent(
    @Param('id') id: string,
    @CurrentSession() context: SessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    // 失权判定先行(T062;api §5 GET 行「完整 IntentReply 要求当前源/目标权限;失权时
    // 不返回完整结果,使用 cleanup 最小清理接口,不借 GET 发票」):归属同形 404 与
    // 授权失权 4xx 在此收口;通过后委托既有语义(过期未消费 410 等)
    await this.cleanup.assertFullReplyEntitlement(context, id);
    // 归属/过期判定在服务(设备/Profile/context 全等;跨设备/旧 context 404 同形)
    const reply = this.transitions.getIntent(context, id);
    applyTransitionResponseHeaders(res);
    return reply;
  }

  /** POST /playback/transition-intents/:id/cancel:200 TransitionCancelReply(输家返回 successor) */
  @Post('transition-intents/:id/cancel')
  @HttpCode(200)
  async cancelIntent(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    parseBody(cancelRequestSchema, body);
    const reply = this.transitions.cancelIntent(context, id);
    applyTransitionResponseHeaders(res);
    return reply;
  }

  /**
   * POST /playback/transition-intents/:id/cleanup(010 T062;api.md §7 I5):200
   * TransitionCleanupReply 仅 outcome 键 —— 最小清理分支不要求源/目标当前内容策略
   * 放行,不返回目标 ID/元数据/位置/票据;事务内 pending 取消/释放槽、consumed 为唯一
   * 后继写持久 cleanup_requested + 撤交付,提交后投递幂等空 stop;重试同入口幂等。
   */
  @Post('transition-intents/:id/cleanup')
  @HttpCode(200)
  async cleanupIntent(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    parseBody(cleanupRequestSchema, body);
    const reply = await this.cleanup.cleanupIntent(context, id);
    applyTransitionResponseHeaders(res);
    return reply;
  }
}
