import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentSession, type SessionContext } from '@platform/http-common/current-session.decorator';
import { SessionGuard } from '@platform/http-common/session.guard';
import { SameOriginGuard } from '@platform/http-common/same-origin/same-origin.guard';
import { StrictBodyPipe } from '@platform/http-common/strict-input/strict-pipes';
import { strictObject } from '@platform/http-common/strict-input/strict-schema';
import { listSelectableProfiles, selectActiveProfile, unlockSelectionPin } from '@contexts/profile/application/profile-selection.service';
import type { AccountSessionBody, ProfileSummaryBody } from '@contexts/identity-access';

/**
 * Profile 选档契约路由(T038,005 contracts/api.md §3;api.md §8「/profiles 只保留
 * 选档 GET/unlock/select」):
 * - GET /profiles:选档摘要(ProfileSummary 白名单;禁用可见但不可选;不含策略/
 *   锁定计数/失败日志等设置主体);
 * - POST /profiles/{profileId}/unlock:{pin} 签一次性选档授予(与设置验证共享原
 *   profile 持久失败计数);
 * - POST /profiles/{profileId}/select:选择当前观看者(实际换档同事务递增
 *   profile_context_version、撤销设置授予、终态化旧上下文活动播放)。
 *
 * ⚠️ 旧管理路由(POST /profiles、PATCH /profiles/{profileId})已按 US8 T125 迁入
 * /api/settings/profiles(settings-profiles.controller),此处不再注册、不保留别名。
 */

/** 契约 UnlockRequest;strictObject:未知字段(身份声明等)一律 400(005 §1) */
const unlockRequestSchema = strictObject({
  pin: z.string(),
});

/** select 可选请求体;strictObject:householdId/profileId/isAdmin 等未知字段一律 400(005 §1) */
const selectProfileRequestSchema = strictObject({
  ownerPassword: z.string().optional(),
});

@Controller('profiles')
@UseGuards(SessionGuard)
export class ProfileController {
  /**
   * GET /profiles(T038 最小选档接口):登录会话的选档摘要 —— ProfileSummary 白名单
   * (id,name,avatar,type,isDefault,isMain,pinProtected,status,createdAt,version);
   * 禁用档案可见但 select 拒绝;不返回策略/锁定计数/失败日志等设置主体。
   */
  @Get()
  list(@CurrentSession() context: SessionContext): ProfileSummaryBody[] {
    return listSelectableProfiles(context.session.householdId);
  }

  /**
   * POST /profiles/:profileId/select(T038):选择当前观看者,200 → AccountSession
   * (SessionDto 形,无 sessionToken)。受 PIN 保护须先 unlock;实际换档同事务递增
   * device_session.profile_context_version、撤销设置授予、终态化旧上下文活动播放;
   * 同一有效档案重选 200 但不递增。身份声明字段由 strictObject 400 拒绝。
   */
  @Post(':profileId/select')
  @HttpCode(200)
  @UseGuards(SessionGuard, SameOriginGuard)
  async select(
    @Param('profileId') profileId: string,
    @Body(new StrictBodyPipe(selectProfileRequestSchema))
    input: z.infer<typeof selectProfileRequestSchema>,
    @CurrentSession() context: SessionContext,
  ): Promise<AccountSessionBody> {
    return selectActiveProfile(context, profileId, input.ownerPassword);
  }

  /**
   * POST /profiles/:profileId/unlock(T038):PIN 解锁,签一次性选档授予。
   * 与设置验证共享原 profile 持久失败计数:未设 PIN 403 → 锁定窗口内 423
   * PROFILE_PIN_LOCKED(即使 PIN 正确,跨刷新/新会话保留)→ 错误 403 FORBIDDEN
   * (detail 仅含剩余次数)→ 成功 200 {unlocked:true}。
   */
  @Post(':profileId/unlock')
  @HttpCode(200)
  @UseGuards(SessionGuard, SameOriginGuard)
  async unlock(
    @Param('profileId') profileId: string,
    @Body(new StrictBodyPipe(unlockRequestSchema))
    input: z.infer<typeof unlockRequestSchema>,
    @CurrentSession() context: SessionContext,
  ): Promise<{ unlocked: true }> {
    return unlockSelectionPin(context, profileId, input.pin);
  }
}
