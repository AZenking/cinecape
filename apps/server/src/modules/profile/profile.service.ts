import { randomUUID } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { ProblemCode } from '@hmp/shared';
import type { Profile } from '../../database/schema';
import { deviceSession, profile, profilePolicy } from '../../database/schema';
import { DomainError } from '../../common/domain-error';
import type { SessionContext } from '../../common/current-session.decorator';
import { getDb, type Db } from '../auth/db';
import { verifyParentPassword } from '../auth/parent-verification.service';
import { consumeUnlockGrant, hasUnlockGrant, revokeUnlockGrantsForProfile } from './pin.service';
import { defaultPolicyValues } from '../policy/policy.rules';

/**
 * Profile 聚合(US2:T025 创建/编辑/停用、T026 select、T028 停用级联)。
 * 全部写操作走 drizzle 事务(getDb().transaction),事务内完成:
 * - isDefault 互换(纯函数 swapDefault 计算期望态 → 差量写库;FR-013 每家庭至多一个可用默认);
 * - 「至少一个可用」守卫(纯函数 assertNotLastActiveProfile;FR-013,409 LAST_ACTIVE_PROFILE);
 * - 停用级联(T028/FR-016):同事务清空引用该 Profile 的 device_session.active_profile_id;
 * - clearPin / PIN 变更:重置 PIN 状态机并作废未消费的解锁授予。
 * 归属判定一律以服务端会话为信任源(FR-018):household/account 取自 @CurrentSession,
 * 请求体中的任何身份字段被 zod 剥离忽略;不存在或不属于当前家庭 → 404 NOT_FOUND(不泄露存在性)。
 */

/** ProfileDto 响应体(契约 components/schemas/ProfileDto,不包含 pinHash 等凭据字段) */
export interface ProfileDtoBody {
  id: string;
  name: string;
  avatar: string | null;
  type: 'adult' | 'child';
  isDefault: boolean;
  /** 是否设置了 PIN(只暴露布尔,永不暴露哈希,FR-007) */
  pinProtected: boolean;
  status: 'active' | 'disabled';
  createdAt: string;
}

// ---------------------------------------------------------------------------
// 纯规则函数(unit: profile.rules.spec.ts)
// ---------------------------------------------------------------------------

/**
 * FR-013 默认唯一互换(纯函数):targetId 成为唯一默认,其余一律 false。
 * 输入不被修改;服务层据此差量写库(目标行本身由调用方的 insert/patch 写入)。
 * 返回类型用 Omit 覆盖而非交集:输入行多为 DB 形态(isDefault: number),
 * 交集会因 number & boolean 塌缩为 never。
 */
export function swapDefault<T extends { id: string }>(
  profiles: T[],
  targetId: string,
): Array<Omit<T, 'isDefault'> & { isDefault: boolean }> {
  return profiles.map((row) => ({ ...row, isDefault: row.id === targetId }));
}

/** FR-013「至少一个可用」守卫:家庭内除目标外没有其他可用 Profile 时拒绝停用 */
export function assertNotLastActiveProfile(activeOtherCount: number): void {
  if (activeOtherCount < 1) {
    throw new DomainError(409, ProblemCode.LAST_ACTIVE_PROFILE, '每个家庭至少保留一个可用 Profile');
  }
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export function listProfiles(householdId: string): ProfileDtoBody[] {
  const rows = getDb()
    .select()
    .from(profile)
    .where(eq(profile.householdId, householdId)) // 显式 household 边界(FR-006)
    .all();
  return rows.map(toProfileDto);
}

/** 白名单式输出:pin_hash / failed_pin_count / pin_locked_until 永不出现在 DTO(FR-007) */
export function toProfileDto(row: Profile): ProfileDtoBody {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    // DB CHECK 约束保证取值,类型收窄仅映射层局部断言
    type: row.type as ProfileDtoBody['type'],
    isDefault: row.isDefault === 1,
    pinProtected: row.pinHash !== null,
    status: row.status as ProfileDtoBody['status'],
    createdAt: row.createdAt,
  };
}

/**
 * 归属校验单一实现点(FR-014/FR-019):按 id + 会话 household + 会话 account 精确匹配;
 * 不存在或不属于当前家庭 → 404 NOT_FOUND,与「不存在」不可区分(不泄露跨家庭存在性)。
 */
export function requireOwnedProfile(profileId: string, context: SessionContext): Profile {
  const row = getDb()
    .select()
    .from(profile)
    .where(
      and(
        eq(profile.id, profileId),
        eq(profile.householdId, context.session.householdId),
        eq(profile.accountId, context.session.accountId),
      ),
    )
    .get();
  if (row === undefined) {
    throw new DomainError(404, ProblemCode.NOT_FOUND);
  }
  return row;
}

// ---------------------------------------------------------------------------
// 创建 / 编辑(T025)
// ---------------------------------------------------------------------------

export interface CreateProfileCommand {
  householdId: string;
  accountId: string;
  name: string;
  type: 'adult' | 'child';
  avatar?: string;
  isDefault: boolean;
  /** argon2id 哈希由控制器在事务外预先计算(短事务),明文 PIN 不进入服务层 */
  pinHash?: string;
}

export function createProfile(command: CreateProfileCommand): ProfileDtoBody {
  const row: Profile = {
    id: randomUUID(),
    householdId: command.householdId,
    accountId: command.accountId,
    name: command.name,
    avatar: command.avatar ?? null,
    type: command.type,
    isDefault: command.isDefault ? 1 : 0,
    pinHash: command.pinHash ?? null,
    status: 'active',
    failedPinCount: 0,
    pinLockedUntil: null,
    createdAt: new Date().toISOString(),
  };
  return getDb().transaction((tx) => {
    // 先互换:新行尚未插入,把既有可用默认全部清掉,避免部分唯一索引冲突
    if (row.isDefault === 1) {
      swapActiveDefaultTo(tx, command.householdId, row.id);
    }
    tx.insert(profile).values(row).run();
    // 阶段 2/FR-003:档案与默认策略同事务原子创建(成人 18/true,儿童 12/false,空名单)
    insertDefaultPolicy(tx, row);
    return toProfileDto(row);
  });
}

/** 同事务插入默认策略(仅创建路径;运行时缺失策略一律拒绝,不自动补建,FR-008) */
function insertDefaultPolicy(tx: Db, row: Profile): void {
  const defaults = defaultPolicyValues(row.type as 'adult' | 'child');
  tx
    .insert(profilePolicy)
    .values({
      householdId: row.householdId,
      profileId: row.id,
      maxContentLevel: defaults.maxContentLevel,
      allowUnrated: defaults.allowUnrated ? 1 : 0,
      allowedMediaIds: '[]',
      blockedMediaIds: '[]',
      allowedChannelIds: '[]',
      version: 1,
      updatedAt: row.createdAt,
    })
    .run();
}

export interface UpdateProfileCommand {
  profileId: string;
  householdId: string;
  accountId: string;
  name?: string;
  avatar?: string;
  isDefault?: boolean;
  status?: 'active' | 'disabled';
  clearPin?: boolean;
  /** 新 PIN 的 argon2id 哈希(控制器预先计算);与 clearPin 同时出现时 clearPin 优先 */
  pinHash?: string;
}

export function updateProfile(command: UpdateProfileCommand): ProfileDtoBody {
  return getDb().transaction((tx) => {
    const row = tx
      .select()
      .from(profile)
      .where(
        and(
          eq(profile.id, command.profileId),
          eq(profile.householdId, command.householdId),
          eq(profile.accountId, command.accountId),
        ),
      )
      .get();
    if (row === undefined) {
      throw new DomainError(404, ProblemCode.NOT_FOUND);
    }

    const patch: {
      name?: string;
      avatar?: string | null;
      isDefault?: number;
      status?: string;
      pinHash?: string | null;
      failedPinCount?: number;
      pinLockedUntil?: string | null;
    } = {};
    if (command.name !== undefined) {
      patch.name = command.name;
    }
    if (command.avatar !== undefined) {
      patch.avatar = command.avatar;
    }

    // clearPin / PIN 变更:重置 PIN 状态机,并作废该档案全部未消费解锁授予(旧授予不得绕过新 PIN)
    if (command.clearPin === true) {
      patch.pinHash = null;
      patch.failedPinCount = 0;
      patch.pinLockedUntil = null;
    } else if (command.pinHash !== undefined) {
      patch.pinHash = command.pinHash;
      patch.failedPinCount = 0;
      patch.pinLockedUntil = null;
    }

    const disabling = command.status === 'disabled' && row.status === 'active';
    if (disabling) {
      // FR-013:家庭内至少保留一个可用 Profile(事务内校验,SQLite 写串行无竞态)
      const activeOthers = tx
        .select({ id: profile.id })
        .from(profile)
        .where(
          and(
            eq(profile.householdId, row.householdId),
            eq(profile.status, 'active'),
            ne(profile.id, row.id),
          ),
        )
        .all();
      assertNotLastActiveProfile(activeOthers.length);
    }
    if (command.status !== undefined) {
      patch.status = command.status;
    }

    // 重新启用保留了默认标记的档案 → 先清其他可用默认,避免部分唯一索引瞬时冲突
    const reEnablingWithDefault = command.status === 'active' && row.status === 'disabled' && row.isDefault === 1;
    if (command.isDefault === true || reEnablingWithDefault) {
      swapActiveDefaultTo(tx, row.householdId, row.id);
      patch.isDefault = 1;
    } else if (command.isDefault === false) {
      patch.isDefault = 0;
    }

    if (Object.keys(patch).length > 0) {
      tx.update(profile).set(patch).where(eq(profile.id, row.id)).run();
    }

    // T028/FR-016 停用级联:同一事务内清空引用该 Profile 的会话当前观看者
    if (disabling) {
      tx
        .update(deviceSession)
        .set({ activeProfileId: null })
        .where(eq(deviceSession.activeProfileId, row.id))
        .run();
    }

    // PIN 变更/清除成功落库后才作废授予(事务已保证一致性,此处仅内存副作用)
    if (patch.pinHash !== undefined) {
      revokeUnlockGrantsForProfile(row.id);
    }

    const updated = tx.select().from(profile).where(eq(profile.id, row.id)).get();
    if (updated === undefined) {
      throw new DomainError(404, ProblemCode.NOT_FOUND);
    }
    return toProfileDto(updated);
  });
}

// ---------------------------------------------------------------------------
// select(T026)
// ---------------------------------------------------------------------------

/** select 响应体(契约 200 → SessionDto;sessionToken 仅登录响应出现,此处不携带) */
export interface SelectProfileResult {
  sessionId: string;
  account: { id: string; username: string; role: 'owner' | 'admin' };
  activeProfile: ProfileDtoBody;
  expiresAt: string;
}

/**
 * 选择当前观看者(FR-014;阶段 2 增补 FR-012):校验顺序 404(归属)→
 * 403 PROFILE_NOT_SELECTABLE(已停用)→ 403 PROFILE_PIN_REQUIRED(PIN 未解锁)→
 * 403 PARENT_VERIFICATION_REQUIRED/FAILED、423 LOCKED(无 PIN 成人 + 家庭含任一儿童档案,
 * 含停用儿童;owner 会话可能被儿童共用,不能凭会话角色直接切换到未受保护成人);
 * 通过后事务内更新 device_session.active_profile_id,成功后消费解锁授予(一次性)。
 * 有 PIN 目标始终走 PIN 授予,ownerPassword 不替代 PIN。
 */
export async function selectProfile(
  profileId: string,
  context: SessionContext,
  ownerPassword?: string,
): Promise<SelectProfileResult> {
  const row = requireOwnedProfile(profileId, context);
  if (row.status === 'disabled') {
    throw new DomainError(403, ProblemCode.PROFILE_NOT_SELECTABLE, '该 Profile 已停用,无法选择');
  }
  if (row.pinHash !== null && !hasUnlockGrant(context.session.id, row.id)) {
    throw new DomainError(403, ProblemCode.PROFILE_PIN_REQUIRED, '该 Profile 受 PIN 保护,请先解锁');
  }
  if (row.pinHash === null && row.type === 'adult' && householdHasChildProfile(row.householdId)) {
    if (ownerPassword === undefined || ownerPassword === '') {
      throw new DomainError(
        403,
        ProblemCode.PARENT_VERIFICATION_REQUIRED,
        '家庭存在儿童档案,选择未设 PIN 的成人需家长验证',
      );
    }
    await verifyParentPassword(context, ownerPassword);
  }

  getDb().transaction((tx) => {
    tx
      .update(deviceSession)
      .set({ activeProfileId: row.id })
      .where(eq(deviceSession.id, context.session.id))
      .run();
  });
  consumeUnlockGrant(context.session.id, row.id);

  return {
    sessionId: context.session.id,
    account: {
      id: context.account.id,
      username: context.account.username,
      role: context.account.role,
    },
    activeProfile: toProfileDto(row),
    expiresAt: context.session.expiresAt,
  };
}

/** 家庭是否存在任一儿童档案(含停用;停用儿童同样触发无 PIN 成人切换保护,FR-012) */
export function householdHasChildProfile(householdId: string): boolean {
  const row = getDb()
    .select({ id: profile.id })
    .from(profile)
    .where(and(eq(profile.householdId, householdId), eq(profile.type, 'child')))
    .limit(1)
    .get();
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// 事务内助手
// ---------------------------------------------------------------------------

/**
 * FR-013 默认唯一互换(事务内):把 targetProfileId 设为唯一可用默认。
 * 纯函数 swapDefault 计算期望态 → 仅对「原为默认、期望非默认」的非目标行写 0
 * (目标行由调用方的 insert/patch 写入;targetProfileId 不在 active 集合时即
 * 「清空全部可用默认」语义,用于重建默认的启用场景)。
 */
function swapActiveDefaultTo(tx: Db, householdId: string, targetProfileId: string): void {
  const rows = tx
    .select({ id: profile.id, isDefault: profile.isDefault })
    .from(profile)
    .where(and(eq(profile.householdId, householdId), eq(profile.status, 'active')))
    .all();
  for (const desired of swapDefault(rows, targetProfileId)) {
    if (desired.isDefault || desired.id === targetProfileId) {
      continue;
    }
    const original = rows.find((candidate) => candidate.id === desired.id);
    if (original !== undefined && original.isDefault === 1) {
      tx.update(profile).set({ isDefault: 0 }).where(eq(profile.id, desired.id)).run();
    }
  }
}
