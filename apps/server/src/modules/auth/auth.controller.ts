import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { SESSION_COOKIE } from '@hmp/shared';
import { env } from '../../config/env';
import { deviceSession } from '../../database/schema';
import { getDb } from './db';
import { SameOriginGuard } from '../../common/same-origin/same-origin.guard';
import { SessionGuard } from '../../common/session.guard';
import { CurrentSession } from '../../common/current-session.decorator';
import type { SessionContext } from '../../common/current-session.decorator';
import { StrictBodyPipe } from '../../common/strict-input/strict-pipes';
import { strictObject } from '../../common/strict-input/strict-schema';
import { clearDeviceSessionsProfile } from '@contexts/profile/application/identity-transition';
import { registerDevice, type DeviceType } from './device.service';
import { hashToken } from './token.service';
import {
  authenticate,
  issueSession,
  renewSession,
  resolveSessionToken,
  setSessionCookie,
  type IssuedSession,
} from './session.service';
import { buildAccountSession, restoreAccountSession, type AccountSessionBody } from './account-session.dto';

/** 契约 LoginRequest(B001LoginRequest;strictObject 拒绝未知字段) */
const loginRequestSchema = strictObject({
  username: z.string(),
  password: z.string(),
  deviceType: z.enum(['web', 'mobile', 'tv', 'nas', 'other']).default('web'),
  deviceName: z.string().max(100).optional(),
});

/**
 * 认证与会话生命周期(T039,005 contracts/api.md §3):
 * - POST /auth/login(Public+同源):200 SessionDto(=AccountSession 形,
 *   含一次性 sessionToken),httpOnly Cookie 下发;
 * - GET /auth/session(Session):AccountSession DTO(householdId、账号与当前 Profile
 *   最小摘要、bootstrapRequired、profileContextVersion;不含 PIN hash/设置主体);
 *   当前 Profile 失效时同事务失效回落并返回 activeProfile=null(FR-009);
 * - POST /auth/logout:幂等 204 —— 撤销会话与设置授予、终态化当前上下文活动播放、
 *   清 cookie;无凭证/未知令牌/已注销同样 204(契约「Session/已失效幂等」)。
 */
@Controller('auth')
export class AuthController {
  /** 契约:登录成功为 200 */
  @Post('login')
  @HttpCode(200)
  @UseGuards(SameOriginGuard)
  async login(
    @Body(new StrictBodyPipe(loginRequestSchema))
    input: z.infer<typeof loginRequestSchema>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AccountSessionBody> {
    const account = await authenticate(input.username, input.password);

    const device = registerDevice({
      householdId: account.householdId,
      type: input.deviceType as DeviceType,
      name: input.deviceName ?? null,
    });
    const issued: IssuedSession = issueSession({
      householdId: account.householdId,
      accountId: account.id,
      deviceId: device.id,
    });
    setSessionCookie(response, issued);
    return buildAccountSession({
      sessionId: issued.sessionId,
      account,
      expiresAt: issued.expiresAt,
      sessionToken: issued.sessionToken,
    });
  }

  /**
   * 恢复/校验当前会话:过期或撤销一律 401(Guard,恰好过期 = 已过期);通过后
   * 滑动续期并返回 AccountSession DTO(无 sessionToken)。Profile 失效回落见
   * restoreAccountSession(FR-009:me 与播放由 CurrentProfileGuard 拒绝并指示重选)。
   */
  @Get('session')
  @UseGuards(SessionGuard)
  getSession(@CurrentSession() context: SessionContext): AccountSessionBody {
    const expiresAt = renewSession(context.session.id, context.session.expiresAt);
    return restoreAccountSession(context, expiresAt);
  }

  /**
   * 注销当前会话(T039 契约:幂等 204):同事务撤销会话 + 撤销设置授予 +
   * 终态化当前上下文活动播放并撤票;之后清 cookie。无凭证/未知令牌/已注销会话
   * 一律 204(「已失效幂等」),不泄露会话存在性。
   */
  @Post('logout')
  @HttpCode(204)
  @UseGuards(SameOriginGuard)
  logout(@Req() request: Request, @Res({ passthrough: true }) response: Response): void {
    const token = resolveSessionToken(request);
    if (token !== null) {
      revokeSessionWithIdentityCleanup(token);
    }
    // 注销成功即失效客户端 Cookie(204 无响应体;对无凭证请求同样是卫生清理)
    response.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: env.COOKIE_SECURE,
    });
  }
}

/**
 * 幂等注销 + 身份清理(同事务):
 * - 查无此令牌/已注销 → no-op(幂等);
 * - 撤销会话;若会话仍指向活动档案,则同事务按失效回落语义清空 active_profile_id、
 *   递增 profile_context_version、撤销设置授予并终态化该上下文活动播放(撤票,
 *   data-model §2「改变身份…终态化…在同一事务」)。
 */
function revokeSessionWithIdentityCleanup(token: string): void {
  getDb().transaction((tx) => {
    const row = tx
      .select({
        id: deviceSession.id,
        householdId: deviceSession.householdId,
        activeProfileId: deviceSession.activeProfileId,
        revokedAt: deviceSession.revokedAt,
      })
      .from(deviceSession)
      .where(eq(deviceSession.tokenHash, hashToken(token)))
      .get();
    if (row === undefined || row.revokedAt !== null) {
      return; // 幂等:未知令牌/重复注销 no-op
    }
    const now = new Date().toISOString();
    tx.update(deviceSession)
      .set({ revokedAt: now })
      .where(and(eq(deviceSession.id, row.id), eq(deviceSession.householdId, row.householdId)))
      .run();
    if (row.activeProfileId !== null) {
      clearDeviceSessionsProfile(tx, {
        householdId: row.householdId,
        deviceSessionIds: [row.id],
        profileId: row.activeProfileId,
      });
    }
  });
}
