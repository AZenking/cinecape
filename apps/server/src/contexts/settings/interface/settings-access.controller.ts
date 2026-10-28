import { Body, Controller, Delete, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { SameOriginGuard } from '@platform/http-common/same-origin/same-origin.guard';
import { SessionGuard } from '@platform/http-common/session.guard';
import { CurrentSession } from '@platform/http-common/current-session.decorator';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { StrictBodyPipe } from '@platform/http-common/strict-input/strict-pipes';
import { strictObject } from '@platform/http-common/strict-input/strict-schema';
import {
  readSettingsAccessStatus,
  revokeCurrentSessionGrant,
  type SettingsAccessBody,
} from '@contexts/settings/application/settings-access-grant.service';
import { verifyAndIssueSettingsAccess } from '@contexts/settings/application/settings-pin-verification.service';

/**
 * /settings/access 独立入口契约路由(T083,005 contracts/api.md §6/§7):
 *
 * - /settings/access 是「独立入口」(§7):GET/DELETE 仅 Session;POST 用
 *   Session+当前主 Profile+管理角色+PIN 签发 —— 绝不经过已有 grant 守卫;
 * - 一般设置主体路由(GET /settings/account 等)由 T126~T130 的各子域控制器承载,
 *   本控制器不再收编代表路由(US8 起 account 归 settings-account.controller);
 * - 未知 JSON 字段一律 400(StrictBodyPipe);PIN 6 位数字(openapi 契约 pattern)。
 */

/** 契约 SettingsAccessPinRequest(openapi components/schemas:pin pattern ^[0-9]{6}$) */
const settingsPinRequestSchema = strictObject({
  pin: z.string().regex(/^[0-9]{6}$/),
});

@Controller('settings')
export class SettingsAccessController {
  /** GET /settings/access:仅 Session;最小状态,无授予 200 unlocked=false/expiresAt=null */
  @Get('access')
  @UseGuards(SessionGuard)
  getAccess(@CurrentSession() context: SessionContext): SettingsAccessBody {
    return readSettingsAccessStatus(context);
  }

  /** POST /settings/access:独立 PIN 验证签发;不得要求已有 grant;200 SettingsAccess */
  @Post('access')
  @HttpCode(200)
  @UseGuards(SameOriginGuard, SessionGuard)
  async postAccess(
    @CurrentSession() context: SessionContext,
    @Body(new StrictBodyPipe(settingsPinRequestSchema)) input: { pin: string },
  ): Promise<SettingsAccessBody> {
    return verifyAndIssueSettingsAccess(context, input.pin);
  }

  /** DELETE /settings/access:仅 Session;撤销当前授予,204 幂等 */
  @Delete('access')
  @HttpCode(204)
  @UseGuards(SameOriginGuard, SessionGuard)
  deleteAccess(@CurrentSession() context: SessionContext): void {
    revokeCurrentSessionGrant(context);
  }
}
