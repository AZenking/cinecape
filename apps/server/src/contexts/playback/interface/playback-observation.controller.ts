import { Body, Controller, HttpCode, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentSession, type SessionContext } from '@platform/http-common/current-session.decorator';
import { SessionGuard } from '@platform/http-common/session.guard';
import { parseBody } from '@contexts/identity-access';
import { PlaybackReadinessGuard } from '@contexts/playback/interface/playback-readiness.guard';
import { PlaybackWriteGuard } from '@contexts/playback/interface/playback.controller';
import { PlaybackAuthorizationService } from '@contexts/playback/application/playback-authorization.service';
import {
  PhaseObservationService,
  PlaybackObservationRateLimitedError,
  type ObservationReply,
} from '@contexts/playback/application/phase-observation.service';

/**
 * 播放相位观测端点(010 T057,US3)—— POST /api/playback/sessions/:id/observations。
 *
 * 权威依据(先读后写):
 * - docs/specs/010-online-vod/contracts/api.md §4 observations 行:
 *   「{eventSeq>=1,expectedGeneration,event:playing|pause|seeking|seeked|waiting|ratechange|error,
 *   positionSeconds>=0,playbackRate:0.5–2} → 200{accepted,lastEventSeq}；同seq同载荷重放,
 *   冲突409、陈旧false;无历史/epoch写;授权/交付/phase检查」;
 * - §7 I4:「observations回复追加playbackStarted:boolean…收到playing的HTTP确认后UI才视为
 *   解除等待」;§0:「phase观测独立120/min/session」「限流429+Retry-After」「JSON未知字段
 *   拒绝」「身份/个人接口从当前验证Session推导,禁止body/query的profileId」;
 * - docs/specs/010-online-vod/tasks.md T057 原文(路由面:严格 zod + 守卫链与
 *   playback.controller 同栈)。
 *
 * 请求面横切(与 PlaybackController 同栈,逐守卫同序):
 * - PlaybackReadinessGuard → SessionGuard(游客 401 SESSION_INVALID;令牌入口唯一权威)→
 *   PlaybackWriteGuard(同源/CSRF + 16KiB 体预算;复用 playback.controller 导出的同一守卫类,
 *   栈面逐字一致)→ authorization.authorizeControl(归属/绑定档案/最新策略/家庭资源;
 *   跨设备/旧上下文/随机 id 同形 404 不泄露存在性)→ 服务层事务内再重验
 *   (身份/代次/phase/交付,见 phase-observation.service);
 * - 成功响应公共安全头与 playback.controller 同款(no-store/no-referrer;Content-Type
 *   沿用该控制器既有 problem+json 惯例,契约 e2e 经 superagent +json 结构化解析不受影响);
 * - 限流 429:Retry-After 由本处按服务抛出的窗口余量动态注入(ProblemJsonFilter 注册表
 *   无动态头,同 004 播放限频口径)。
 */

/**
 * observations 请求契约(api.md §4 observations 行逐字;strict 拒绝未知字段 —— 伪造
 * profileId 等一律 400 VALIDATION_FAILED,身份只从服务端会话推导)。倍速 0.5–2 闭区间
 * 与位置非负由 schema 承担(恰界 0.5/2 合法;越界/未知 event 枚举 400,契约 A6)。
 */
const observationRequestSchema = z
  .object({
    eventSeq: z.number().int().min(1),
    expectedGeneration: z.number().int().min(1),
    event: z.enum(['playing', 'pause', 'seeking', 'seeked', 'waiting', 'ratechange', 'error']),
    positionSeconds: z.number().finite().min(0),
    playbackRate: z.number().finite().min(0.5).max(2),
  })
  .strict();

/** 成功响应 Content-Type(PlaybackController 既有惯例,契约 e2e problem+json 形态断言) */
const RESPONSE_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

/** 成功响应公共安全头(api.md §0:所有响应 no-store/no-referrer) */
function applyObservationResponseHeaders(res: Response): void {
  res.setHeader('Content-Type', RESPONSE_CONTENT_TYPE);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

@Controller('playback')
@UseGuards(PlaybackReadinessGuard, SessionGuard, PlaybackWriteGuard)
export class PlaybackObservationController {
  /**
   * 构造注入显式 token:契约测试管线(vitest/esbuild)不产出 design:paramtypes 元数据,
   * 依赖解析必须逐参数 @Inject(与 PlaybackController 同一纪律)。
   */
  constructor(
    @Inject(PlaybackAuthorizationService) private readonly authorization: PlaybackAuthorizationService,
    @Inject(PhaseObservationService) private readonly observations: PhaseObservationService,
  ) {}

  /**
   * POST /playback/sessions/:id/observations:200 {accepted,lastEventSeq,playbackStarted}。
   * 授权链(authorizeControl)先于限流/域级语义(api.md §0「来源/上下文授权失败优先于
   * 专用错误」);观测不当授权证明 —— 本端点无任何票据/资产/资格副作用。
   */
  @Post('sessions/:id/observations')
  @HttpCode(200)
  async observe(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ObservationReply> {
    const input = parseBody(observationRequestSchema, body);
    // 归属/当前 Profile/上下文版本/最新策略授权链(非本设备/跨家庭/旧上下文 404 同形)
    await this.authorization.authorizeControl(context, id);
    try {
      const reply = this.observations.ingest(
        {
          householdId: context.session.householdId,
          deviceSessionId: context.session.id,
          sessionId: id,
        },
        input,
      );
      applyObservationResponseHeaders(res);
      return reply;
    } catch (error) {
      if (error instanceof PlaybackObservationRateLimitedError) {
        // 限流 429 附动态 Retry-After(ProblemJsonFilter 注册表无动态头,同 004 播放限频)
        res.setHeader('Retry-After', String(error.retryAfterSeconds));
      }
      throw error;
    }
  }
}
