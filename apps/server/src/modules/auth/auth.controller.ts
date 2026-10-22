import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ProblemCode, SESSION_COOKIE } from '@hmp/shared';
import { env } from '../../config/env';
import { DomainError } from '../../common/domain-error';
import { SessionGuard } from '../../common/session.guard';
import { CurrentSession } from '../../common/current-session.decorator';
import type { SessionContext } from '../../common/current-session.decorator';
import { parseBody } from './validation';
import { registerDevice, type DeviceType } from './device.service';
import {
  authenticate,
  buildRestoredSessionDto,
  buildSessionDto,
  issueSession,
  renewSession,
  resolveSessionToken,
  revokeSessionByToken,
  setSessionCookie,
  type RestoredSessionDtoBody,
  type SessionDtoBody,
} from './session.service';

/** 契约 LoginRequest(components/schemas/LoginRequest) */
const loginRequestSchema = z.object({
  username: z.string(),
  password: z.string(),
  deviceType: z.enum(['web', 'mobile', 'tv', 'nas', 'other']).default('web'),
  deviceName: z.string().max(100).optional(),
});

/**
 * 认证与会话生命周期:
 * - POST /auth/login(T019/FR-007/008/009):失败统一 401 INVALID_CREDENTIALS;
 *   成功签发设备会话,下发 httpOnly Cookie hmp_session 并返回一次性 sessionToken;
 * - GET /auth/session(T033/FR-010):严格 Guard 校验后恢复登录态并滑动续期;
 * - POST /auth/logout(T034/FR-011/012):幂等注销,不走严格 Guard(语义见
 *   revokeSessionByToken)—— Guard 会把已注销会话直接 401,与「重复 logout
 *   仍 204」冲突,故在控制器内按 Guard 同规则手工解析令牌。
 */
@Controller('auth')
export class AuthController {
  /** 契约:登录成功为 200(initialize 才是 201) */
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionDtoBody> {
    const input = parseBody(loginRequestSchema, body);
    const account = await authenticate(input.username, input.password);

    const device = registerDevice({
      householdId: account.householdId,
      type: input.deviceType as DeviceType,
      name: input.deviceName ?? null,
    });
    const issued = issueSession({
      householdId: account.householdId,
      accountId: account.id,
      deviceId: device.id,
    });
    setSessionCookie(response, issued);
    return buildSessionDto(issued, account);
  }

  /**
   * 恢复/校验当前会话(T033/FR-010):过期或撤销一律 401(Guard,恰好过期 =
   * 已过期);通过后滑动续期并返回无 sessionToken 的 SessionDto。
   * 仅本方法挂严格 Guard —— logout 必须放行已注销/过期令牌以维持 204 幂等。
   */
  @Get('session')
  @UseGuards(SessionGuard)
  getSession(@CurrentSession() context: SessionContext): RestoredSessionDtoBody {
    const expiresAt = renewSession(context.session.id, context.session.expiresAt);
    return buildRestoredSessionDto(context, expiresAt);
  }

  /** 注销当前会话(T034/FR-011/012):幂等,重复调用同样 204 */
  @Post('logout')
  @HttpCode(204)
  logout(@Req() request: Request, @Res({ passthrough: true }) response: Response): void {
    const token = resolveSessionToken(request);
    if (token === null) {
      throw new DomainError(401, ProblemCode.SESSION_INVALID, undefined);
    }
    revokeSessionByToken(token);
    // 注销成功即失效客户端 Cookie(契约 204 无响应体,Cookie 清理为附加卫生措施)
    response.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: env.COOKIE_SECURE,
    });
  }
}
