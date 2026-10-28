import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentSession } from '@platform/http-common/current-session.decorator';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { SessionGuard } from '@platform/http-common/session.guard';
import { SameOriginGuard } from '@platform/http-common/same-origin/same-origin.guard';
import { StrictBodyPipe } from '@platform/http-common/strict-input/strict-pipes';
import { strictObject } from '@platform/http-common/strict-input/strict-schema';
import { bootstrapMainProfile, recoverMainProfilePin } from '@contexts/identity-access/application/bootstrap.service';
import type { ProfileSummaryBody } from '@contexts/identity-access/interface/account-session.dto';

/**
 * 首建与 PIN 恢复路由(T037,005 contracts/api.md §3;ADR-0011 决议 2/6)。
 * 边界均为 Session+管理角色+当次密码(逐次验证);同源校验按 api.md §1
 * 「所有写操作和带密码的查询必须校验同源 Origin」挂载。
 * 两个端点都是窄用途例外:不签 settings grant、不返回管理主体、不自动选档。
 */

/** 契约 BootstrapProfileRequest:严格必填(缺 ownerPassword → 400 VALIDATION_FAILED) */
const bootstrapRequestSchema = strictObject({
  name: z.string().min(1).max(50),
  pin: z.string().regex(/^\d{6}$/, 'PIN 必须为 6 位数字'),
  ownerPassword: z.string().min(1),
});

/** 契约 PinRecoveryRequest:目标主档案由服务端确定,不接受 profileId */
const pinRecoveryRequestSchema = strictObject({
  newPin: z.string().regex(/^\d{6}$/, 'PIN 必须为 6 位数字'),
  ownerPassword: z.string().min(1),
});

@Controller('auth')
export class BootstrapController {
  /** 零档案首建:201 仅 ProfileSummary(isMain=true),不自动选档;已有档案 409 */
  @Post('bootstrap-profile')
  @HttpCode(201)
  @UseGuards(SessionGuard, SameOriginGuard)
  async bootstrap(
    @CurrentSession() context: SessionContext,
    @Body(new StrictBodyPipe(bootstrapRequestSchema))
    input: z.infer<typeof bootstrapRequestSchema>,
  ): Promise<ProfileSummaryBody> {
    return bootstrapMainProfile(context, input);
  }

  /** 主档案 PIN 窄用途恢复:204 无响应体,不返回管理主体、不签 settings grant */
  @Post('main-profile/pin-recovery')
  @HttpCode(204)
  @UseGuards(SessionGuard, SameOriginGuard)
  async pinRecovery(
    @CurrentSession() context: SessionContext,
    @Body(new StrictBodyPipe(pinRecoveryRequestSchema))
    input: z.infer<typeof pinRecoveryRequestSchema>,
  ): Promise<void> {
    await recoverMainProfilePin(context, input);
  }
}
