import { Body, Controller, Get, HttpCode, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentSession, type SessionContext } from '@platform/http-common/current-session.decorator';
import { SessionGuard } from '@platform/http-common/session.guard';
import { parseBody } from '@contexts/identity-access';
import { PlaybackReadinessGuard } from '@contexts/playback/interface/playback-readiness.guard';
import { PlaybackWriteGuard } from '@contexts/playback/interface/playback.controller';
import { PlaybackAuthorizationService } from '@contexts/playback/application/playback-authorization.service';
import { PlaybackLifecycleService } from '@contexts/playback/infrastructure/playback-lifecycle.service';
import {
  PlaybackFinishService,
  type PlaybackFinishInput,
  type PlaybackFinishScope,
} from '@contexts/playback/application/playback-finish.service';
import type { FinishReceiptOutcome } from '@contexts/playback/application/playback-work-set.port';

/**
 * 播放完成/结束端点(010 T058,US3)—— POST /playback/sessions/:id/finish 与
 * GET /playback/sessions/:id/finish-result。
 *
 * 权威依据(先读后写):
 * - docs/specs/010-online-vod/contracts/api.md §4:
 *   · finish 行:「{operationKey:UUID,finalProgress:{sampleSeq,expectedGeneration,
 *     positionSeconds},cause:natural_end} → 200 FinishReceipt;同payload重放,不在终态
 *     升级;硬非法400/409整次回滚;无证据不等于接口失败,可ended=true/autoNextEligible=false」
 *     + 语义段「same operationKey 异 payload 409;已有 receipt 且新 key 不同则 409
 *     FINISH_ALREADY_RECORDED 附恢复路径而不重算;finish 重放先校验身份/归属再读 receipt,
 *     不要求活动态;无权读取时只允许既有最小空 stop清理」;
 *   · finish-result 行:「200 FinishReceipt|null;只当前原设备/原上下文,可用于丢响应
 *     恢复;禁止跨上下文读旧结果」;
 *   · stop 行(既有装配,本文件零改动):「仍204;无auto-next资格;先赢的stop使后到
 *     finish返回not_completed且不补写final」;
 * - §0:「JSON未知字段拒绝」「身份/个人接口从当前验证Session推导,禁止body/query的
 *   profileId」「来源/上下文授权失败优先于专用错误」;
 * - docs/specs/010-online-vod/tasks.md T058 原文(路由面:严格 zod + 守卫链与
 *   playback.controller 同栈)。
 *
 * 请求面横切(与 PlaybackController/PlaybackObservationController 同栈,逐守卫同序):
 * - PlaybackReadinessGuard → SessionGuard(游客 401 SESSION_INVALID)→ PlaybackWriteGuard
 *   (同源/CSRF + 16KiB 体预算;复用 playback.controller 导出的同一守卫类)→
 *   authorization.authorizeControl(归属/绑定档案/最新策略/家庭资源;跨设备/旧上下文/
 *   随机 id 同形 404 不泄露存在性;contextVersion 'current')→ 服务层事务内再重验
 *   (身份/归属,见 playback-finish.service);
 * - finish 成功提交后:任务取消/回收在 commit 后执行(internal-ports §2)—— 经 lifecycle
 *   结算面取消该会话活动转换 + 安排延迟清理(与 stop 提交后收口同款;尽力而为,不影响
 *   已提交的 receipt 响应)。
 */

/**
 * finish 请求契约(api.md §4 finish 行逐字;strict 拒绝未知字段 —— 伪造 profileId 等
 * 一律 400 VALIDATION_FAILED,身份只从服务端会话推导)。operationKey 必须 UUID;
 * cause 仅 natural_end;final 为本次样本(seq/generation/位置)。
 */
const finishRequestSchema = z
  .object({
    operationKey: z.string().uuid(),
    finalProgress: z
      .object({
        sampleSeq: z.number().int().min(1),
        expectedGeneration: z.number().int().min(1),
        positionSeconds: z.number().finite().min(0),
      })
      .strict(),
    cause: z.literal('natural_end'),
  })
  .strict();

/** 成功响应 Content-Type(PlaybackController 既有惯例,契约 e2e problem+json 形态断言) */
const RESPONSE_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

/** 成功响应公共安全头(api.md §0:所有响应 no-store/no-referrer) */
function applyFinishResponseHeaders(res: Response): void {
  res.setHeader('Content-Type', RESPONSE_CONTENT_TYPE);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

@Controller('playback')
@UseGuards(PlaybackReadinessGuard, SessionGuard, PlaybackWriteGuard)
export class PlaybackFinishController {
  /**
   * 构造注入显式 token:契约测试管线(vitest/esbuild)不产出 design:paramtypes 元数据,
   * 依赖解析必须逐参数 @Inject(与 PlaybackController 同一纪律)。
   */
  constructor(
    @Inject(PlaybackAuthorizationService) private readonly authorization: PlaybackAuthorizationService,
    @Inject(PlaybackFinishService) private readonly finishService: PlaybackFinishService,
    @Inject(PlaybackLifecycleService) private readonly lifecycle: PlaybackLifecycleService,
  ) {}

  /**
   * POST /playback/sessions/:id/finish:200 FinishReceipt(13 键)。
   * 授权链(authorizeControl)先于域级语义(api.md §0);stop 仍 204(既有
   * PlaybackController 装配零改动);session 只有一份不可变 finish 结果 —— 重放返回
   * 原结果,冲突 409,硬非法 400 整次回滚。
   */
  @Post('sessions/:id/finish')
  @HttpCode(200)
  async finish(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FinishReceiptOutcome> {
    const input: PlaybackFinishInput = parseBody(finishRequestSchema, body);
    // 归属/当前 Profile/上下文版本/最新策略授权链(非本设备/跨家庭/旧上下文 404 同形)
    await this.authorization.authorizeControl(context, id);
    const receipt = this.finishService.finish(this.scopeOf(context, id), input);
    // 提交后收口(internal-ports §2「任务取消/回收在 commit 后」):取消活动转换 + 安排
    // 延迟清理;尽力而为,失败不影响已提交的 receipt 响应(replay 亦幂等)
    await this.lifecycle.settleAfterFinishCommit(id).catch(() => undefined);
    applyFinishResponseHeaders(res);
    return receipt;
  }

  /**
   * GET /playback/sessions/:id/finish-result:200 FinishReceipt|null(丢响应恢复;
   * 只当前原设备/原上下文 —— 跨设备/旧上下文/随机 id 同形 404,不泄露存在性)。
   * 响应体经 res.json 显式序列化:无 receipt 形态必须落**字面 JSON null** —— Nest 对
   * null 返回值发空体,superagent 解析为 ''(非 null),契约 E1「200 body null」钉死
   * FinishReceipt|null 字面形态。
   */
  @Get('sessions/:id/finish-result')
  async finishResult(
    @Param('id') id: string,
    @CurrentSession() context: SessionContext,
    @Res() res: Response,
  ): Promise<void> {
    await this.authorization.authorizeControl(context, id);
    const receipt = this.finishService.finishResult(this.scopeOf(context, id));
    // 公共安全头(no-store/no-referrer;Content-Type 由 res.json 落 application/json,
    // 「字面 JSON null」形态不经 problem+json 惯例 —— 200 成功体是 FinishReceipt|null)
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.json(receipt);
  }

  /** 服务侧范围(身份一律服务端推导;会话 id 取路由参数) */
  private scopeOf(context: SessionContext, sessionId: string): PlaybackFinishScope {
    return {
      householdId: context.session.householdId,
      deviceSessionId: context.session.id,
      sessionId,
    };
  }
}
