import { Body, Controller, Delete, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { ProblemCode } from '@hmp/shared';
import { account } from '../../database/schema';
import { DomainError } from '../../common/domain-error';
import { SameOriginGuard } from '../../common/same-origin/same-origin.guard';
import { SessionGuard } from '../../common/session.guard';
import { CurrentSession } from '../../common/current-session.decorator';
import type { SessionContext } from '../../common/current-session.decorator';
import { SettingsAccessGuard } from '../../common/settings-access/settings-access.guard';
import { StrictBodyPipe } from '../../common/strict-input/strict-pipes';
import { strictObject } from '../../common/strict-input/strict-schema';
import { getDb } from '../auth/db';
import {
  readSettingsAccessStatus,
  requireValidSettingsGrant,
  revokeCurrentSessionGrant,
  type SettingsAccessBody,
} from './settings-access-grant.service';
import { verifyAndIssueSettingsAccess } from './settings-pin-verification.service';

/**
 * /settings 契约路由(T083,005 contracts/api.md §6/§7):
 *
 * - /settings/access 是「独立入口」(§7):GET/DELETE 仅 Session;POST 用
 *   Session+当前主 Profile+管理角色+PIN 签发 —— 绝不经过已有 grant 守卫;
 * - GET /settings/account 是「一般设置主体」代表(§6 首行):挂
 *   SessionGuard + SettingsAccessGuard,次序 Session→角色/当前主 Profile→grant
 *   →严格入参→(敏感操作当次密码)→提交前重验由各设置写路由承担;本阶段仅返回
 *   只读 AccountSummary 白名单投影,完整账号与安全模块由 US8 扩展(T131 前的
 *   T12x 系列任务填充,不改路由与守卫挂载);
 * - 未知 JSON 字段一律 400(StrictBodyPipe);PIN 6 位数字(openapi 契约 pattern)。
 */

/** 契约 SettingsAccessPinRequest(openapi components/schemas:pin pattern ^[0-9]{6}$) */
const settingsPinRequestSchema = strictObject({
  pin: z.string().regex(/^[0-9]{6}$/),
});

/** 契约 AccountSummary(openapi components/schemas:只读白名单投影) */
export interface AccountSummaryBody {
  id: string;
  username: string;
  role: 'owner' | 'admin';
}

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

  /**
   * GET /settings/account:一般设置主体代表(US7 守卫挂载验证 + 前端账号与安全
   * 空架数据源)。逐请求经 SettingsAccessGuard 重检;成功返回只读 AccountSummary。
   */
  @Get('account')
  @UseGuards(SessionGuard, SettingsAccessGuard)
  getAccount(@CurrentSession() context: SessionContext): AccountSummaryBody {
    // 重读身份(api.md §7 次序尾段):以库内现值为准,Guard 有效性通过后读取
    requireValidSettingsGrant(context);
    const row = getDb()
      .select({ id: account.id, username: account.username, role: account.role })
      .from(account)
      .where(and(eq(account.householdId, context.session.householdId), eq(account.id, context.account.id)))
      .get();
    if (row === undefined) {
      // 会话与账号行不一致(理论不可达,Guard 已校验)→ 按会话失效拒绝
      throw new DomainError(401, ProblemCode.SESSION_INVALID, undefined);
    }
    return { id: row.id, username: row.username, role: row.role as AccountSummaryBody['role'] };
  }
}
