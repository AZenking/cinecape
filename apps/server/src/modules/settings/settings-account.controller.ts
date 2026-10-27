import { Body, Controller, Get, HttpCode, Put, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { ProblemCode, SESSION_COOKIE } from '@hmp/shared';
import { env } from '../../config/env';
import { account } from '../../database/schema';
import { DomainError } from '../../common/domain-error';
import { CurrentSession } from '../../common/current-session.decorator';
import type { SessionContext } from '../../common/current-session.decorator';
import { SameOriginGuard } from '../../common/same-origin/same-origin.guard';
import { SessionGuard } from '../../common/session.guard';
import { SettingsAccessGuard } from '../../common/settings-access/settings-access.guard';
import { StrictBodyPipe } from '../../common/strict-input/strict-pipes';
import { strictObject } from '../../common/strict-input/strict-schema';
import { getDb } from '../auth/db';
import { changeAccountPassword } from './settings-account.service';
import { requireValidSettingsGrant } from './settings-access-grant.service';

/**
 * 账号与安全契约路由(T126,005 contracts/api.md §6):
 * - GET /settings/account:AccountSummary 白名单投影(id/username/role;openapi
 *   AccountSummary 即此三键,US7 的最小空架实现升格为本模块的完整路由 ——
 *   settings-access.controller 中的同名路由随本次收编移除,守卫链不变);
 * - PUT /settings/account/password:{ownerPassword,newPassword} → 204 + 清 cookie;
 *   Settings 边界 + 当次密码;成功使全部旧会话/设置授予/选档授予失效(服务层同事务),
 *   收藏与历史保留(FR-035)。
 * 严格入参:PasswordChangeRequest(minLength 8 / maxLength 128,additionalProperties:false)。
 */

/** 契约 PasswordChangeRequest(openapi components/schemas) */
const passwordChangeRequestSchema = strictObject({
  ownerPassword: z.string().min(8).max(128),
  newPassword: z.string().min(8).max(128),
});

/** 契约 AccountSummary(openapi components/schemas:只读白名单投影) */
export interface AccountSummaryBody {
  id: string;
  username: string;
  role: 'owner' | 'admin';
}

/** 重读身份(api.md §7 次序尾段):Guard 通过后以库内现值为准 */
function readAccountSummary(context: SessionContext): AccountSummaryBody {
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

@Controller('settings')
export class SettingsAccountController {
  /** GET /settings/account:AccountSummary 白名单投影(Settings 边界,逐请求重检) */
  @Get('account')
  @UseGuards(SessionGuard, SettingsAccessGuard)
  getAccount(@CurrentSession() context: SessionContext): AccountSummaryBody {
    return readAccountSummary(context);
  }

  /** PUT /settings/account/password:当次密码改密;204 + 清 cookie */
  @Put('account/password')
  @HttpCode(204)
  @UseGuards(SameOriginGuard, SessionGuard, SettingsAccessGuard)
  async changePassword(
    @CurrentSession() context: SessionContext,
    @Body(new StrictBodyPipe(passwordChangeRequestSchema)) input: z.infer<typeof passwordChangeRequestSchema>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await changeAccountPassword(context, input);
    // 当前会话已在同事务撤销;卫生清理客户端 Cookie(对齐 logout 语义)
    response.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: env.COOKIE_SECURE,
    });
  }
}
