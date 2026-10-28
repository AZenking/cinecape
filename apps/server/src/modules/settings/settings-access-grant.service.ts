import { and, eq, isNull } from 'drizzle-orm';
import { ProblemCode } from '@hmp/shared';
import { device, deviceSession, household, profile, settingsAccessGrant, account } from '../../database/schema';
import { DomainError, createDomainError } from '../../common/domain-error';
import type { SessionContext } from '../../common/current-session.decorator';
import { getDb, type Db } from '@contexts/identity-access/infrastructure/db';

/**
 * 设置访问授予服务(T081,005 data-model §3 + contracts/api.md §6/§7 + ADR-0011 决议 3)。
 *
 * - 签发绑定 household + device_session + 当前主 Profile,并捕获
 *   profile_context_version / pin_version / main_profile_version 三个版本快照;
 * - 「每设备会话一行」:联合主键 (household_id, device_session_id) 覆盖写;
 * - `expires_at = issued_at + 15 分钟;固定不滑动`:任何 GET/刷新/返回/再次验证
 *   均不续期;同上下文已有有效授予的重验证返回原 issued_at/expires_at;
 * - `revoked_at` nullable 且「失效后不再恢复」:撤销只写 revoked_at,校验绝不
 *   复活;只有重新验证成功才覆盖写全新授予(原到期时间不复用);
 * - 授予本身无 bearer:服务层返回与持久化行都不存在 token 形态字段,浏览器仅收
 *   expiresAt 元数据(data-model §9 SettingsAccess);
 * - 校验「每次设置读取/写入连接 account/device/device_session/profile/household
 *   重新检查 role、归属、当前档案、状态、三个版本及 expires_at>serverNow」;
 *   Session 已失效先 401,仅档案/grant 不满足 403(api.md §7)。
 *
 * 服务为纯函数模块(对齐 token.service/pin.service 惯例),无需 Nest 注入;
 * 事务变体(Tx 后缀)供调用方在自己的 BEGIN IMMEDIATE 事务内组合
 * (settings-pin-verification 的「成功清零 + 签发」原子提交)。
 */

/** 固定 TTL:15 分钟;固定不滑动,无任何续期入口 */
export const SETTINGS_GRANT_TTL_MS = 15 * 60 * 1000;

/** 签发快照:必须与签发时刻的当前主 Profile / 会话上下文 / 家庭主档案版本一致 */
export interface SettingsGrantSnapshot {
  profileId: string;
  profileContextVersion: number;
  pinVersion: number;
  mainProfileVersion: number;
}

export interface IssuedSettingsGrant {
  profileId: string;
  issuedAt: string;
  expiresAt: string;
  /** true = 同上下文有效授予复用(不覆盖不续期);false = 新签发覆盖写 */
  reused: boolean;
}

export interface SettingsGrantValidation {
  expiresAt: string;
}

/** 契约 SettingsAccess 响应体(data-model §9:仅 unlocked/expiresAt 元数据) */
export interface SettingsAccessBody {
  unlocked: boolean;
  expiresAt: string | null;
}

function isoNow(): string {
  return new Date().toISOString();
}

function sessionInvalid(): DomainError {
  return new DomainError(401, ProblemCode.SESSION_INVALID, undefined);
}

function accessRequired(): DomainError {
  return createDomainError('SETTINGS_ACCESS_REQUIRED');
}

function accessExpired(): DomainError {
  return createDomainError('SETTINGS_ACCESS_EXPIRED');
}

/**
 * 事务内签发(调用方事务提交时生效):
 * - 同 (household, device_session) 已存在「未撤销 + 未过期 + 三版本/主档案一致」的
 *   授予 → 复用原行(原 issued_at/expires_at),不覆盖不续期;
 * - 否则按联合主键覆盖写全新授予(旧 revoked 行被新行取代 —— 非恢复,新到期时间)。
 */
export function issueSettingsGrantTx(
  tx: Db,
  input: { householdId: string; deviceSessionId: string; snapshot: SettingsGrantSnapshot },
): IssuedSettingsGrant {
  const now = new Date();
  const existing = tx
    .select()
    .from(settingsAccessGrant)
    .where(
      and(
        eq(settingsAccessGrant.householdId, input.householdId),
        eq(settingsAccessGrant.deviceSessionId, input.deviceSessionId),
      ),
    )
    .get();
  const snapshot = input.snapshot;
  if (
    existing !== undefined &&
    existing.revokedAt === null &&
    Date.parse(existing.expiresAt) > now.getTime() &&
    existing.profileId === snapshot.profileId &&
    existing.profileContextVersion === snapshot.profileContextVersion &&
    existing.pinVersion === snapshot.pinVersion &&
    existing.mainProfileVersion === snapshot.mainProfileVersion
  ) {
    // 同上下文有效授予:返回原 issued_at/expires_at,不覆盖或续期(data-model §3)
    return {
      profileId: existing.profileId,
      issuedAt: existing.issuedAt,
      expiresAt: existing.expiresAt,
      reused: true,
    };
  }
  const issuedAt = isoNow();
  const expiresAt = new Date(now.getTime() + SETTINGS_GRANT_TTL_MS).toISOString();
  tx
    .insert(settingsAccessGrant)
    .values({
      householdId: input.householdId,
      deviceSessionId: input.deviceSessionId,
      profileId: snapshot.profileId,
      profileContextVersion: snapshot.profileContextVersion,
      pinVersion: snapshot.pinVersion,
      mainProfileVersion: snapshot.mainProfileVersion,
      issuedAt,
      expiresAt,
      revokedAt: null,
    })
    .onConflictDoUpdate({
      target: [settingsAccessGrant.householdId, settingsAccessGrant.deviceSessionId],
      set: {
        profileId: snapshot.profileId,
        profileContextVersion: snapshot.profileContextVersion,
        pinVersion: snapshot.pinVersion,
        mainProfileVersion: snapshot.mainProfileVersion,
        issuedAt,
        expiresAt,
        // 全新授予:旧撤销行被覆盖取代(不是恢复 —— 原到期时间不复用)
        revokedAt: null,
      },
    })
    .run();
  return { profileId: snapshot.profileId, issuedAt, expiresAt, reused: false };
}

/** 独立短事务签发(PIN 验证服务在成功事务内用 Tx 变体;本变体供测试/工具路径) */
export function issueSettingsGrant(input: {
  householdId: string;
  deviceSessionId: string;
  snapshot: SettingsGrantSnapshot;
}): IssuedSettingsGrant {
  return getDb().transaction((tx) => issueSettingsGrantTx(tx, input), { behavior: 'immediate' });
}

/** 事务内撤销当前会话授予:仅未撤销行写 revoked_at(失效后不再恢复,幂等) */
export function revokeSettingsGrantTx(
  tx: Db,
  input: { householdId: string; deviceSessionId: string },
): void {
  tx.update(settingsAccessGrant)
    .set({ revokedAt: isoNow() })
    .where(
      and(
        eq(settingsAccessGrant.householdId, input.householdId),
        eq(settingsAccessGrant.deviceSessionId, input.deviceSessionId),
        isNull(settingsAccessGrant.revokedAt),
      ),
    )
    .run();
}

/** DELETE /settings/access 用例:撤销当前会话授予(仅 Session,204 幂等) */
export function revokeCurrentSessionGrant(context: SessionContext): void {
  getDb().transaction((tx) =>
    revokeSettingsGrantTx(tx, {
      householdId: context.session.householdId,
      deviceSessionId: context.session.id,
    }),
  );
}

/**
 * 一般设置主体逐请求重检(api.md §7 次序的「grant 有效性」段)。
 * 重检连接:account(角色/归属)、device/device_session(撤销/过期/当前档案/上下文版本)、
 * profile(当前主档案状态/pin_version)、household(main_profile_version)、
 * settings_access_grant(存在/未撤销/三版本/expires_at>serverNow)。
 * Session 失效先 401;档案/grant 不满足 403 SETTINGS_ACCESS_REQUIRED;过期 403
 * SETTINGS_ACCESS_EXPIRED。通过仅返回 expiresAt 元数据(无 bearer、无管理主体)。
 *
 * 管理写路径在 BEGIN IMMEDIATE 事务内以 requireValidSettingsGrantTx 重验同一份
 * 权限快照(data-model §1「提交前重新校验权限快照」);两个入口共用同一判定体。
 */
export function requireValidSettingsGrant(context: SessionContext): SettingsGrantValidation {
  return validateSettingsGrant(getDb(), context);
}

/** 事务内变体:调用方传入 BEGIN IMMEDIATE 事务句柄(或共享连接),提交前重验权限快照 */
export function requireValidSettingsGrantTx(tx: Db | TxDb, context: SessionContext): SettingsGrantValidation {
  return validateSettingsGrant(tx, context);
}

/** better-sqlite3 同步事务回调入参(与 parent-verification/policy.service 同一惯用法) */
type TxDb = Parameters<Parameters<Db['transaction']>[0]>[0];

function validateSettingsGrant(db: Db | TxDb, context: SessionContext): SettingsGrantValidation {
  const householdId = context.session.householdId;
  const now = Date.now();

  // 1. 会话/设备/账号行仍在且有效(撤销、过期 → 401 优先于一切 403)
  const sessionRow = db
    .select()
    .from(deviceSession)
    .where(and(eq(deviceSession.householdId, householdId), eq(deviceSession.id, context.session.id)))
    .get();
  if (
    sessionRow === undefined ||
    sessionRow.revokedAt !== null ||
    !(Date.parse(sessionRow.expiresAt) > now)
  ) {
    throw sessionInvalid();
  }
  const deviceRow = db
    .select({ revokedAt: device.revokedAt })
    .from(device)
    .where(and(eq(device.householdId, householdId), eq(device.id, sessionRow.deviceId)))
    .get();
  if (deviceRow === undefined || deviceRow.revokedAt !== null) {
    throw sessionInvalid();
  }
  const accountRow = db
    .select({ role: account.role })
    .from(account)
    .where(and(eq(account.householdId, householdId), eq(account.id, sessionRow.accountId)))
    .get();
  if (accountRow === undefined) {
    throw sessionInvalid();
  }

  // 2. 授予行存在且未撤销、未过期
  const grant = db
    .select()
    .from(settingsAccessGrant)
    .where(
      and(
        eq(settingsAccessGrant.householdId, householdId),
        eq(settingsAccessGrant.deviceSessionId, context.session.id),
      ),
    )
    .get();
  if (grant === undefined || grant.revokedAt !== null) {
    throw accessRequired();
  }
  if (!(Date.parse(grant.expiresAt) > now)) {
    throw accessExpired();
  }

  // 3. 当前主 Profile(状态/归属)+ 管理角色 + 会话当前档案必须仍是主档案
  const mainRow = db
    .select()
    .from(profile)
    .where(and(eq(profile.householdId, householdId), eq(profile.isMain, 1)))
    .get();
  if (mainRow === undefined || mainRow.status !== 'active') {
    throw accessRequired();
  }
  if (mainRow.accountId !== sessionRow.accountId || mainRow.householdId !== householdId) {
    throw accessRequired();
  }
  if (accountRow.role !== 'owner' && accountRow.role !== 'admin') {
    throw accessRequired();
  }
  if (sessionRow.activeProfileId !== mainRow.id) {
    throw accessRequired(); // 实际换档后授予不跨身份使用
  }
  if (grant.profileId !== mainRow.id) {
    throw accessRequired(); // 主档案变化/转移后旧授予指向已非主档案
  }

  // 4. 三个版本快照逐一比对(逐请求版本检查是并发撤销的竞态兜底)
  if (
    grant.profileContextVersion !== sessionRow.profileContextVersion ||
    grant.pinVersion !== mainRow.pinVersion
  ) {
    throw accessRequired();
  }
  const householdRow = db
    .select({ mainProfileVersion: household.mainProfileVersion })
    .from(household)
    .where(eq(household.id, householdId))
    .get();
  if (householdRow === undefined || grant.mainProfileVersion !== householdRow.mainProfileVersion) {
    throw accessRequired();
  }

  return { expiresAt: grant.expiresAt };
}

/**
 * GET /settings/access 最小状态(api.md §6 独立入口):仅 Session,任何有效会话
 * (含未选档/普通档案)可读;不读管理主体、不续期。grant 有效 → unlocked=true +
 * 服务器 expiresAt;否则 200 unlocked=false/expiresAt=null。Session 已失效仍 401
 * (上游透传 requireValidSettingsGrant 的 401,不吞成 200)。
 */
export function readSettingsAccessStatus(context: SessionContext): SettingsAccessBody {
  try {
    const valid = requireValidSettingsGrant(context);
    return { unlocked: true, expiresAt: valid.expiresAt };
  } catch (error) {
    if (error instanceof DomainError && error.status === 403) {
      return { unlocked: false, expiresAt: null };
    }
    throw error;
  }
}
