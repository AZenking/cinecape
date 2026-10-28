import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { ProblemCode, SESSION_COOKIE } from '@hmp/shared';
import type { NewDeviceSession } from '@platform/database/schema';
import { account, deviceSession, profile } from '@platform/database/schema';
import { env } from '@platform/config/env';
import { DomainError } from '@platform/http-common/domain-error';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { getDb } from '@contexts/identity-access/infrastructure/db';
import { hashPassword, verifyPassword } from '@contexts/identity-access/infrastructure/password.service';
import { generateToken, hashToken } from '@contexts/identity-access/infrastructure/token.service';

/**
 * 会话签发(T019/FR-008):
 * - 登录凭据验证:任何失败(账号不存在/密码错误)统一 401 INVALID_CREDENTIALS,
 *   不区分账号存在性;账号不存在时补一次等价 argon2 计算,消除时序差异;
 * - 明文令牌只在签发响应中出现一次,落库仅 SHA-256 哈希;
 * - 过期时间 = now + SESSION_TTL_DAYS 天(env 注入,FR-004)。
 * 纯函数导出,无需 Nest 注入(对齐 token.service.ts 惯例)。
 */

export interface AuthenticatedAccount {
  id: string;
  householdId: string;
  username: string;
  /** 数据库 CHECK 约束保证取值仅为 owner | admin */
  role: 'owner' | 'admin';
}

export interface IssuedSession {
  sessionId: string;
  /** 一次性明文令牌:仅出现在签发响应(契约 sessionToken),凭此可走 Bearer 通道 */
  sessionToken: string;
  expiresAt: string;
}

/** SessionDto 响应体(契约 components/schemas/SessionDto) */
export interface SessionDtoBody {
  sessionId: string;
  account: { id: string; username: string; role: 'owner' | 'admin' };
  /** 新签发会话尚未选择观看者(US2 才有 Profile 选择) */
  activeProfile: null;
  sessionToken: string;
  expiresAt: string;
}

function invalidCredentials(): DomainError {
  // 无 detail:两种失败路径的 problem 体必须逐字节一致(场景4 统一性断言)
  return new DomainError(401, ProblemCode.INVALID_CREDENTIALS);
}

/** 账号不存在时执行的等价 argon2 计算,防「账号不存在」被时序侧信道枚举 */
let timingEqualizerHash: string | null = null;

export async function authenticate(
  username: string,
  password: string,
): Promise<AuthenticatedAccount> {
  const row = getDb()
    .select()
    .from(account)
    .where(eq(account.usernameNormalized, username.toLowerCase()))
    .get();

  if (row === undefined) {
    timingEqualizerHash ??= await hashPassword('hmp-timing-equalizer');
    await verifyPassword(timingEqualizerHash, password);
    throw invalidCredentials();
  }

  const passwordMatches = await verifyPassword(row.passwordHash, password);
  if (!passwordMatches) {
    throw invalidCredentials();
  }
  return {
    id: row.id,
    householdId: row.householdId,
    username: row.username,
    role: row.role as AuthenticatedAccount['role'],
  };
}

export function issueSession(input: {
  householdId: string;
  accountId: string;
  deviceId: string;
}): IssuedSession {
  const sessionToken = generateToken(); // 32B CSPRNG → base64url
  const now = new Date();
  const ttlMs = env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const row: NewDeviceSession = {
    id: randomUUID(),
    householdId: input.householdId,
    accountId: input.accountId,
    deviceId: input.deviceId,
    tokenHash: hashToken(sessionToken), // 明文令牌不落库
    activeProfileId: null,
    expiresAt,
    revokedAt: null,
    lastActiveAt: now.toISOString(),
    createdAt: now.toISOString(),
  };
  getDb().insert(deviceSession).values(row).run();
  return { sessionId: row.id, sessionToken, expiresAt };
}

export function buildSessionDto(issued: IssuedSession, accountInfo: AuthenticatedAccount): SessionDtoBody {
  return {
    sessionId: issued.sessionId,
    account: {
      id: accountInfo.id,
      username: accountInfo.username,
      role: accountInfo.role,
    },
    activeProfile: null,
    sessionToken: issued.sessionToken,
    expiresAt: issued.expiresAt,
  };
}

/** httpOnly 会话 Cookie(契约 securitySchemes.sessionCookie,名 hmp_session) */
export function setSessionCookie(response: Response, issued: IssuedSession): void {
  response.cookie(SESSION_COOKIE, issued.sessionToken, {
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    expires: new Date(issued.expiresAt),
    maxAge: env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

// ---------------------------------------------------------------------------
// US3 会话生命周期(T033 恢复/滑动续期 · T034 幂等注销)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** 恢复响应中的观看者档案(契约 components/schemas/ProfileDto) */
export interface RestoredProfileDtoBody {
  id: string;
  name: string;
  avatar: string | null;
  type: 'adult' | 'child';
  isDefault: boolean;
  /** 是否设置了 PIN(不暴露哈希) */
  pinProtected: boolean;
  status: 'active' | 'disabled';
  createdAt: string;
}

/**
 * 恢复/校验会话的响应体(契约 components/schemas/SessionDto)。
 * 与登录响应 SessionDtoBody 的差异:不含 sessionToken —— 契约约定该字段
 * 仅在 POST /auth/login 响应中出现一次,恢复响应必须省略。
 */
export interface RestoredSessionDtoBody {
  sessionId: string;
  account: { id: string; username: string; role: 'owner' | 'admin' };
  activeProfile: RestoredProfileDtoBody | null;
  expiresAt: string;
}

function sessionInvalid(): DomainError {
  return new DomainError(401, ProblemCode.SESSION_INVALID, undefined);
}

/**
 * 滑动续期(T033/FR-010/research D5):
 * - last_active_at = now;
 * - expires_at = min(now + SESSION_TTL_DAYS, created_at + SESSION_ABSOLUTE_DAYS)(滑动不越过绝对上限);
 * - 仅当新过期时间晚于原值才写库(绝对上限封顶/时钟回拨时整体跳过,避免每请求写放大);
 * 返回生效的过期时间(ISO)。
 */
export function renewSession(sessionId: string, currentExpiresAt: string): string {
  const row = getDb()
    .select({ expiresAt: deviceSession.expiresAt, createdAt: deviceSession.createdAt })
    .from(deviceSession)
    .where(eq(deviceSession.id, sessionId))
    .get();
  if (row === undefined) {
    // Guard 已校验存在;防御性回退,绝不因续期放大失败面
    return currentExpiresAt;
  }
  const now = Date.now();
  const slidingExpiry = now + env.SESSION_TTL_DAYS * DAY_MS;
  const absoluteExpiry = Date.parse(row.createdAt) + env.SESSION_ABSOLUTE_DAYS * DAY_MS;
  const nextExpiresAt = new Date(Math.min(slidingExpiry, absoluteExpiry)).toISOString();
  if (Date.parse(row.expiresAt) >= Date.parse(nextExpiresAt)) {
    // 未前移 → 不写库,返回原值
    return row.expiresAt;
  }
  getDb()
    .update(deviceSession)
    .set({ lastActiveAt: new Date(now).toISOString(), expiresAt: nextExpiresAt })
    .where(eq(deviceSession.id, sessionId))
    .run();
  return nextExpiresAt;
}

/** 当前观看者 → ProfileDto(US2 选择后生效;已停用/不存在视为无上下文) */
function activeProfileDtoOf(profileId: string | null): RestoredProfileDtoBody | null {
  if (profileId === null) {
    return null;
  }
  const row = getDb().select().from(profile).where(eq(profile.id, profileId)).get();
  if (row === undefined || row.status !== 'active') {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    type: row.type as RestoredProfileDtoBody['type'],
    isDefault: row.isDefault === 1,
    pinProtected: row.pinHash !== null,
    status: 'active',
    createdAt: row.createdAt,
  };
}

/** 恢复响应 DTO(无 sessionToken;activeProfile 由服务端会话得出,FR-018) */
export function buildRestoredSessionDto(
  context: SessionContext,
  expiresAt: string,
): RestoredSessionDtoBody {
  return {
    sessionId: context.session.id,
    account: {
      id: context.account.id,
      username: context.account.username,
      role: context.account.role,
    },
    activeProfile: activeProfileDtoOf(context.session.activeProfileId),
    expiresAt,
  };
}

/**
 * 令牌来源:Authorization: Bearer 优先,其次手工解析 Cookie。
 * ⚠️ 与 common/session.guard.ts 的 extractToken 同规则(common 不可改动,镜像实现须保持同步)。
 */
export function resolveSessionToken(request: Request): string | null {
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

/**
 * 幂等注销(T034/FR-011/FR-012)。语义选择(与严格 Guard 有意不同):
 * - 令牌缺失/查无此会话 → 401 SESSION_INVALID(与 Guard 一致);
 * - 查到会话(无论是否已过期):
 *   - 未注销 → 写 revoked_at = now → 204;
 *   - 已注销 → no-op → 204(重复注销幂等,FR-012);
 *   - 已过期但未注销 → 同样补写 revoked_at → 204(注销过期会话无害且无副作用)。
 * 因此 logout 不走 SessionGuard(Guard 会把已注销/过期会话直接 401,与「重复
 * logout 仍 204」的契约冲突),由控制器按 Guard 同规则手工解析令牌后调用此处。
 */
export function revokeSessionByToken(token: string): void {
  const row = getDb()
    .select({ id: deviceSession.id, revokedAt: deviceSession.revokedAt })
    .from(deviceSession)
    .where(eq(deviceSession.tokenHash, hashToken(token)))
    .get();
  if (row === undefined) {
    throw sessionInvalid();
  }
  if (row.revokedAt !== null) {
    return; // 幂等:重复注销 no-op
  }
  getDb()
    .update(deviceSession)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(deviceSession.id, row.id))
    .run();
}
