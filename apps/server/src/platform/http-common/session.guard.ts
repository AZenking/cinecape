import { Injectable, Inject, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ProblemCode as ProblemCodeConst, SESSION_COOKIE } from '@hmp/shared';
import { attachSessionContext, type SessionContext } from '@platform/http-common/current-session.decorator';
import { DomainError } from '@platform/http-common/domain-error';
import { Database } from '@platform/database/database';
import { SESSION_VERIFIER_PORT, type SessionVerifierPort } from '@platform/http-common/platform.ports';

/**
 * 会话信任源 Guard(T012)—— 单一校验管线,任何一步失败一律
 * 401 SESSION_INVALID(统一无差别,不泄露失败原因、无放行窗口;
 * 边界语义:恰好过期 = 已过期)。
 *
 * 管线:token 哈希查找 → session.revoked_at IS NULL → expires_at > now
 *       → device.revoked_at IS NULL → account/device/activeProfile 归属一致(自联查询)。
 *
 * T009(005 contracts/api.md §1)边界说明:
 * - 本 Guard 保持「账号/设备信任」语义不变,仍是 Session 边界的唯一权威校验;
 * - 公共浏览(/public/** 等 Public 边界路由)**不挂本 Guard**——公共路由不读取身份,
 *   即便携带失效 Cookie 也按匿名公开浏览,绝不以会话决定内容范围;
 * - 需要身份的边界在 SessionGuard 之后叠加 CurrentProfileGuard(Profile 边界);
 * - 令牌解析 extractSessionToken 与校验管线 validateSessionToken 导出复用,
 *   后续任务不得另写第二套 token 校验。
 */

interface SessionRow {
  session_id: string;
  session_household_id: string;
  session_account_id: string;
  session_device_id: string;
  active_profile_id: string | null;
  session_expires_at: string;
  session_revoked_at: string | null;
  account_username: string;
  account_role: string;
  account_household_id: string;
  device_household_id: string;
  device_revoked_at: string | null;
  profile_household_id: string | null;
  profile_account_id: string | null;
}

/** 自联查询:一次取回归属一致性校验所需的全部行 */
const SESSION_BY_TOKEN_HASH_SQL = `
  SELECT
    s.id                AS session_id,
    s.household_id      AS session_household_id,
    s.account_id        AS session_account_id,
    s.device_id         AS session_device_id,
    s.active_profile_id AS active_profile_id,
    s.expires_at        AS session_expires_at,
    s.revoked_at        AS session_revoked_at,
    a.username          AS account_username,
    a.role              AS account_role,
    a.household_id      AS account_household_id,
    d.household_id      AS device_household_id,
    d.revoked_at        AS device_revoked_at,
    p.household_id      AS profile_household_id,
    p.account_id        AS profile_account_id
  FROM device_session s
  INNER JOIN account a ON a.id = s.account_id
  INNER JOIN device d  ON d.id = s.device_id
  LEFT  JOIN profile p ON p.id = s.active_profile_id
  WHERE s.token_hash = ?
`;

function sessionInvalid(): DomainError {
  return new DomainError(401, ProblemCodeConst.SESSION_INVALID, undefined);
}

/** 令牌来源:Authorization: Bearer 或手工解析 Cookie(不引入 cookie-parser) */
export function extractSessionToken(request: Request): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    const token = authorization.slice('Bearer '.length).trim();
    return token === '' ? null : token;
  }
  const cookieHeader = request.headers.cookie;
  if (typeof cookieHeader !== 'string') {
    return null;
  }
  for (const pair of cookieHeader.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (pair.slice(0, separator).trim() === SESSION_COOKIE) {
      const token = pair.slice(separator + 1).trim();
      return token === '' ? null : token;
    }
  }
  return null;
}

@Injectable()
export class SessionGuard implements CanActivate {
  // T022b 治理裁决(ADR-0014 修正案)R4 端口反转:platform 不再深导入
  // identity-access 基础设施,改消费组合根绑定的 SESSION_VERIFIER_PORT
  // (真实实现 = 发布面纯函数 hashToken,HTTP 行为零变化)。
  // @Inject 显式声明依赖(esbuild/tsx 运行时不发射 design:paramtypes,仓库既有惯例);
  // 守卫由路由所在模块注入器在请求期延迟实例化,令牌经组合根 @Global 模块全局可见。
  constructor(
    @Inject(SESSION_VERIFIER_PORT) private readonly sessionVerifier: SessionVerifierPort,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const token = extractSessionToken(request);
    if (token === null) {
      throw sessionInvalid();
    }
    attachSessionContext(request, validateSessionToken(token, this.sessionVerifier));
    return true;
  }
}

/** 校验管线(T009 导出复用);通过返回上下文,失败一律 401 SESSION_INVALID。
 *  T022b 端口反转:令牌哈希经 SessionVerifierPort 注入(原 identity-access 深导入)。 */
export function validateSessionToken(token: string, verifier: SessionVerifierPort): SessionContext {
  const now = Date.now();
  const row = Database.db.prepare(SESSION_BY_TOKEN_HASH_SQL).get(verifier.hashToken(token)) as
    | SessionRow
    | undefined;

  // 1. token 哈希查找
  if (row === undefined) {
    throw sessionInvalid();
  }
  // 2. 会话未撤销
  if (row.session_revoked_at !== null) {
    throw sessionInvalid();
  }
  // 3. 未过期(严格大于;恰好过期 = 已过期)
  if (!(Date.parse(row.session_expires_at) > now)) {
    throw sessionInvalid();
  }
  // 4. 设备未撤销
  if (row.device_revoked_at !== null) {
    throw sessionInvalid();
  }
  // 5. 归属一致:account / device / activeProfile 必须与 session 同属一行 household
  const profileConsistent =
    row.active_profile_id === null ||
    (row.profile_household_id === row.session_household_id &&
      row.profile_account_id === row.session_account_id);
  if (
    !profileConsistent ||
    row.account_household_id !== row.session_household_id ||
    row.device_household_id !== row.session_household_id
  ) {
    throw sessionInvalid();
  }

  return {
    session: {
      id: row.session_id,
      householdId: row.session_household_id,
      accountId: row.session_account_id,
      deviceId: row.session_device_id,
      activeProfileId: row.active_profile_id,
      expiresAt: row.session_expires_at,
    },
    account: {
      id: row.session_account_id,
      householdId: row.account_household_id,
      username: row.account_username,
      role: row.account_role as SessionContext['account']['role'],
    },
  };
  }
