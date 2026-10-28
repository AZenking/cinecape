import { randomUUID } from 'node:crypto';
import { ProblemCode } from '@hmp/shared';
import type { Profile } from '@platform/database/schema';
import { DomainError } from '@platform/http-common/domain-error';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { defaultPolicyValues } from '@contexts/policy';
import { profileStore, type ProfileTxStore } from '@contexts/profile/application/profile-store.port';

/**
 * Profile 聚合(US2:T025 创建/编辑/停用、T026 select、T028 停用级联)。
 * 全部写操作走仓储端口事务(profileStore().withTransaction,008 T006 抽取后语义不变:
 * 迁移前为 getDb().transaction),事务内完成:
 * - isDefault 互换(纯函数 swapDefault 计算期望态 → 差量写库;FR-013 每家庭至多一个可用默认);
 * - 「至少一个可用」守卫(纯函数 assertNotLastActiveProfile;FR-013,409 LAST_ACTIVE_PROFILE);
 * - 停用级联(T028/FR-016):同事务清空引用该 Profile 的 device_session.active_profile_id;
 * - clearPin / PIN 变更:重置 PIN 状态机并作废未消费的解锁授予。
 * 归属判定一律以服务端会话为信任源(FR-018):household/account 取自 @CurrentSession,
 * 请求体中的任何身份字段被 zod 剥离忽略;不存在或不属于当前家庭 → 404 NOT_FOUND(不泄露存在性)。
 *
 * 008-repository-extraction(ADR-0015 D1):数据访问经 application/profile-store.port.ts
 * 仓储端口(Drizzle 实现位于 infrastructure/profile-store.drizzle.ts);查询逐字迁移,
 * 行→DTO 映射与用例编排留本层。
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
 * 被 policy/settings 等跨上下文消费(经发布面),签名不得变化。
 */
export function requireOwnedProfile(profileId: string, context: SessionContext): Profile {
  const row = profileStore().findOwnedProfile(profileId, context.session.householdId, context.session.accountId);
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
    // 0006(数据代际 2):新建档案为非主档案,版本列取值与 DDL DEFAULT 一致
    // (主档案 bootstrap/is_main 语义由 005-US2 后续任务接入)
    isMain: 0,
    pinVersion: 1,
    version: 1,
    createdAt: new Date().toISOString(),
  };
  return profileStore().withTransaction((tx) => {
    // 先互换:新行尚未插入,把既有可用默认全部清掉,避免部分唯一索引冲突
    if (row.isDefault === 1) {
      swapActiveDefaultTo(tx, command.householdId, row.id);
    }
    tx.insertProfile(row);
    // 阶段 2/FR-003:档案与默认策略同事务原子创建(成人 18/true,儿童 12/false,空名单)
    insertDefaultPolicy(tx, row);
    return toProfileDto(row);
  });
}

/** 同事务插入默认策略(仅创建路径;运行时缺失策略一律拒绝,不自动补建,FR-008) */
function insertDefaultPolicy(tx: ProfileTxStore, row: Profile): void {
  const defaults = defaultPolicyValues(row.type as 'adult' | 'child');
  tx.insertProfilePolicy({
    householdId: row.householdId,
    profileId: row.id,
    maxContentLevel: defaults.maxContentLevel,
    allowUnrated: defaults.allowUnrated ? 1 : 0,
    allowedMediaIds: '[]',
    blockedMediaIds: '[]',
    allowedChannelIds: '[]',
    version: 1,
    updatedAt: row.createdAt,
  });
}

// ---------------------------------------------------------------------------
// select(T026 → T038 已迁移)
// ---------------------------------------------------------------------------
// 选档逻辑(select/unlock)自 T038(005-US2)起由 profile-selection.service.ts
// 承载:身份版本递增、设置授予撤销与播放终态化在 identity-transition.ts 挂钩。
// 007-T031:旧管理面 updateProfile 已随 005-US8 整体迁往 settings 上下文
// (settings-profiles.service 自带同语义实现),本文件零消费副本删除。

// ---------------------------------------------------------------------------
// 事务内助手
// ---------------------------------------------------------------------------

/**
 * FR-013 默认唯一互换(事务内):把 targetProfileId 设为唯一可用默认。
 * 纯函数 swapDefault 计算期望态 → 仅对「原为默认、期望非默认」的非目标行写 0
 * (目标行由调用方的 insert/patch 写入;targetProfileId 不在 active 集合时即
 * 「清空全部可用默认」语义,用于重建默认的启用场景)。
 */
function swapActiveDefaultTo(tx: ProfileTxStore, householdId: string, targetProfileId: string): void {
  const rows = tx.listActiveProfileDefaultFlags(householdId);
  for (const desired of swapDefault(rows, targetProfileId)) {
    if (desired.isDefault || desired.id === targetProfileId) {
      continue;
    }
    const original = rows.find((candidate) => candidate.id === desired.id);
    if (original !== undefined && original.isDefault === 1) {
      tx.clearProfileDefault(desired.id);
    }
  }
}
