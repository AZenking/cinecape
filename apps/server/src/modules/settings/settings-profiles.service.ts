import { and, eq, ne } from 'drizzle-orm';
import { ProblemCode } from '@hmp/shared';
import type { Profile } from '../../database/schema';
import { deviceSession, household, profile, profilePolicy } from '../../database/schema';
import { DomainError, createDomainError } from '../../common/domain-error';
import type { SessionContext } from '../../common/current-session.decorator';
import { getDb, type Db } from '../auth/db';
import { hashPassword } from '../auth/password.service';
import { requireManagementRole } from '../auth/bootstrap.service';
import { verifyOwnerPassword } from './settings-owner-password';
import { clearDeviceSessionsProfile } from '@contexts/profile/application/identity-transition';
import { revokeUnlockGrantsForProfile } from '@contexts/profile/application/pin.service';
import { defaultPolicyValues } from '../policy/policy.rules';
import { assertNotLastActiveProfile, swapDefault } from '@contexts/profile/application/profile.service';
import { toProfileSummary, type ProfileSummaryBody } from '../auth/account-session.dto';
import { revokeAllSettingsGrantsForHouseholdTx, revokeSettingsGrantsForProfileTx } from './settings-access-revocation';
import { requireValidSettingsGrantTx } from './settings-access-grant.service';

/**
 * Profile 管理 / PIN / 主档案转移服务(T127,005 contracts/api.md §6 + data-model.md
 * §2 profile + FR-036):
 *
 * - GET /settings/profiles:家庭全部档案 ProfileSummary 白名单(与选档投影同源);
 * - POST:创建(当次密码;PIN 统一 6 位数字;默认策略同事务;version=1);
 * - PATCH {profileId}:编辑/停用/PIN 管理,expectedVersion CAS(旧/伪造版本一律 409
 *   VERSION_CONFLICT 不静默覆盖);「主档案不允许 clearPin」(400)、「不能停用最后
 *   一个可用档案」(409 LAST_ACTIVE_PROFILE)、「现任主档案须先转移」(409
 *   MAIN_PROFILE_CONFLICT);PIN 更新/停用同事务递增相应版本、撤销该档案选档/设置授予、
 *   清空选用会话并终态化活动播放(data-model §2);
 * - PUT /settings/main-profile:三项 CAS(expectedVersion=household.main_profile_version /
 *   expectedCurrentProfileVersion=现任主档案 version / expectedProfileVersion=目标
 *   version),一次事务先去旧标记再设新标记,撤销全部设置授予;响应只返回新主档案 ID
 *   与 mainProfileVersion(MainProfileReply),不返回已无权读取的设置主体。
 *
 * 事务纪律:PIN 哈希与密码验证在事务外;BEGIN IMMEDIATE 提交前重验权限快照
 * (requireValidSettingsGrantTx)与全部版本快照。
 */

function notFound(): DomainError {
  return new DomainError(404, ProblemCode.NOT_FOUND);
}

/** 归属校验单一实现点:不存在/跨家庭/非本账号统一 404 同形 */
function requireProfileOfHousehold(db: Db, householdId: string, accountId: string, profileId: string): Profile {
  const row = db
    .select()
    .from(profile)
    .where(and(eq(profile.id, profileId), eq(profile.householdId, householdId), eq(profile.accountId, accountId)))
    .get();
  if (row === undefined) {
    throw notFound();
  }
  return row;
}

export function listManagedProfiles(householdId: string, accountId: string): ProfileSummaryBody[] {
  return getDb()
    .select()
    .from(profile)
    .where(and(eq(profile.householdId, householdId), eq(profile.accountId, accountId)))
    .all()
    .map(toProfileSummary);
}

// ---------------------------------------------------------------------------
// 创建(T127;POST 当次密码)
// ---------------------------------------------------------------------------

export interface CreateManagedProfileInput {
  name: string;
  type: 'adult' | 'child';
  avatar?: string;
  isDefault: boolean;
  pin?: string;
  ownerPassword?: string;
}

export async function createManagedProfile(context: SessionContext, input: CreateManagedProfileInput): Promise<ProfileSummaryBody> {
  requireManagementRole(context);
  const db = getDb();
  // 当次密码(既有计数/锁定)在事务外;PIN 哈希同样在事务外
  await verifyOwnerPassword(context, input.ownerPassword);
  const pinHash = input.pin !== undefined ? await hashPassword(input.pin) : undefined;

  return db.transaction(
    (tx) => {
      requireValidSettingsGrantTx(tx, context);
      const householdId = context.session.householdId;
      const now = new Date().toISOString();
      const row: Profile = {
        id: crypto.randomUUID(),
        householdId,
        accountId: context.account.id,
        name: input.name,
        avatar: input.avatar ?? null,
        type: input.type,
        isDefault: input.isDefault ? 1 : 0,
        pinHash: pinHash ?? null,
        status: 'active',
        failedPinCount: 0,
        pinLockedUntil: null,
        isMain: 0,
        pinVersion: 1,
        version: 1,
        createdAt: now,
      };
      // 默认唯一互换:新行成为唯一可用默认(先清既有可用默认,避免部分唯一索引冲突)
      if (row.isDefault === 1) {
        swapActiveDefaultTx(tx, householdId, row.id);
      }
      tx.insert(profile).values(row).run();
      // 默认内容策略同事务(成人 18/true,儿童 12/false;与 bootstrap/旧创建路径同语义)
      const defaults = defaultPolicyValues(input.type);
      tx
        .insert(profilePolicy)
        .values({
          householdId,
          profileId: row.id,
          maxContentLevel: defaults.maxContentLevel,
          allowUnrated: defaults.allowUnrated ? 1 : 0,
          allowedMediaIds: '[]',
          blockedMediaIds: '[]',
          allowedChannelIds: '[]',
          version: 1,
          updatedAt: now,
        })
        .run();
      return toProfileSummary(row);
    },
    { behavior: 'immediate' },
  );
}

/** FR-013 默认唯一互换(事务内):与 profile.service 私有实现同语义(swapDefault 纯函数复用) */
function swapActiveDefaultTx(tx: Db, householdId: string, targetProfileId: string): void {
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

// ---------------------------------------------------------------------------
// 编辑 / 停用 / PIN(T127;expectedVersion CAS)
// ---------------------------------------------------------------------------

export interface PatchManagedProfileInput {
  expectedVersion: number;
  ownerPassword?: string;
  name?: string;
  avatar?: string;
  isDefault?: boolean;
  status?: 'active' | 'disabled';
  pin?: string;
  clearPin?: boolean;
}

export async function patchManagedProfile(
  context: SessionContext,
  profileId: string,
  input: PatchManagedProfileInput,
): Promise<ProfileSummaryBody> {
  requireManagementRole(context);
  const db = getDb();
  await verifyOwnerPassword(context, input.ownerPassword);
  const pinHash = input.pin !== undefined ? await hashPassword(input.pin) : undefined;
  const identityReset = input.clearPin === true || pinHash !== undefined || input.status === 'disabled';

  const summary = db.transaction(
    (tx) => {
      requireValidSettingsGrantTx(tx, context);
      const householdId = context.session.householdId;
      const row = requireProfileOfHousehold(tx, householdId, context.account.id, profileId);
      if (row.version !== input.expectedVersion) {
        // 旧版本与伪造版本一律 409,不静默覆盖现值
        throw createDomainError('VERSION_CONFLICT');
      }

      // 主档案守卫:不允许 clearPin;不允许停用(现任主档案须先转移)
      if (row.isMain === 1) {
        if (input.clearPin === true) {
          throw new DomainError(400, ProblemCode.VALIDATION_FAILED, '主档案不允许清除 PIN');
        }
        if (input.status === 'disabled' && row.status === 'active') {
          throw createDomainError('MAIN_PROFILE_CONFLICT');
        }
      }

      const patch: {
        name?: string;
        avatar?: string | null;
        isDefault?: number;
        status?: string;
        pinHash?: string | null;
        failedPinCount?: number;
        pinLockedUntil?: string | null;
        pinVersion?: number;
        version: number;
      } = { version: row.version + 1 };
      if (input.name !== undefined) {
        patch.name = input.name;
      }
      if (input.avatar !== undefined) {
        patch.avatar = input.avatar;
      }

      // clearPin / PIN 变更:重置状态机并递增 pin_version(旧授予与旧身份全部失效)
      let pinChanged = false;
      if (input.clearPin === true) {
        patch.pinHash = null;
        patch.failedPinCount = 0;
        patch.pinLockedUntil = null;
        patch.pinVersion = row.pinVersion + 1;
        pinChanged = true;
      } else if (pinHash !== undefined) {
        patch.pinHash = pinHash;
        patch.failedPinCount = 0;
        patch.pinLockedUntil = null;
        patch.pinVersion = row.pinVersion + 1;
        pinChanged = true;
      }

      // 「不能停用最后一个可用档案」(事务内校验;SQLite 写串行无竞态)
      const disabling = input.status === 'disabled' && row.status === 'active';
      if (disabling) {
        const activeOthers = tx
          .select({ id: profile.id })
          .from(profile)
          .where(and(eq(profile.householdId, householdId), eq(profile.status, 'active'), ne(profile.id, row.id)))
          .all();
        assertNotLastActiveProfile(activeOthers.length);
      }
      if (input.status !== undefined) {
        patch.status = input.status;
      }

      // 默认互换(重新启用保留默认/显式设默认)
      const reEnablingWithDefault = input.status === 'active' && row.status === 'disabled' && row.isDefault === 1;
      if (input.isDefault === true || reEnablingWithDefault) {
        swapActiveDefaultTx(tx, householdId, row.id);
        patch.isDefault = 1;
      } else if (input.isDefault === false) {
        patch.isDefault = 0;
      }

      tx.update(profile).set(patch).where(eq(profile.id, row.id)).run();

      /**
       * 身份失效级联(data-model §2;同一事务):停用或 PIN 变更 → 使用该档案的
       * 设备会话清空身份、递增上下文版本、终态化活动播放并撤票;同事务撤销该档案
       * 全部设置授予(「撤销该档案的选档授予与所有设置授予」)。
       */
      if (disabling || pinChanged) {
        const usingSessionIds = tx
          .select({ id: deviceSession.id })
          .from(deviceSession)
          .where(and(eq(deviceSession.householdId, householdId), eq(deviceSession.activeProfileId, row.id)))
          .all()
          .map((session) => session.id);
        clearDeviceSessionsProfile(tx, { householdId, deviceSessionIds: usingSessionIds, profileId: row.id });
        revokeSettingsGrantsForProfileTx(tx, { householdId, profileId: row.id });
      }

      const updated = tx.select().from(profile).where(eq(profile.id, row.id)).get();
      if (updated === undefined) {
        throw notFound();
      }
      return toProfileSummary(updated);
    },
    { behavior: 'immediate' },
  );

  // 提交后撤销内存选档授予(PIN 变更/停用后旧解锁不得复用;与 profile.service 同模式)
  if (identityReset) {
    revokeUnlockGrantsForProfile(profileId);
  }
  return summary;
}

// ---------------------------------------------------------------------------
// 主档案转移(三项 CAS,一次事务)
// ---------------------------------------------------------------------------

export interface TransferMainProfileInput {
  profileId: string;
  expectedVersion: number;
  expectedCurrentProfileVersion: number;
  expectedProfileVersion: number;
  ownerPassword: string;
}

/** 契约 MainProfileReply:响应只返回新主档案 ID 与 mainProfileVersion(api.md §6) */
export interface MainProfileReplyBody {
  mainProfileId: string;
  mainProfileVersion: number;
}

export async function transferMainProfile(context: SessionContext, input: TransferMainProfileInput): Promise<MainProfileReplyBody> {
  requireManagementRole(context);
  const db = getDb();
  const householdId = context.session.householdId;
  await verifyOwnerPassword(context, input.ownerPassword);

  return db.transaction(
    (tx): MainProfileReplyBody => {
      // 权限快照重验(转移使全部设置授予失效,当前有效授予是本次操作的授权前提)
      requireValidSettingsGrantTx(tx, context);

      // 现任主档案(必须存在;Settings 守卫已保证,防御性 404)
      const currentMain = tx
        .select()
        .from(profile)
        .where(and(eq(profile.householdId, householdId), eq(profile.isMain, 1)))
        .get();
      if (currentMain === undefined) {
        throw notFound();
      }
      // CAS 1:household.main_profile_version
      const householdRow = tx.select().from(household).where(eq(household.id, householdId)).get();
      if (householdRow === undefined || householdRow.mainProfileVersion !== input.expectedVersion) {
        throw createDomainError('VERSION_CONFLICT');
      }
      // CAS 2:现任主档案 version
      if (currentMain.version !== input.expectedCurrentProfileVersion) {
        throw createDomainError('VERSION_CONFLICT');
      }
      // 目标归属(404 同形)
      const target = requireProfileOfHousehold(tx, householdId, context.account.id, input.profileId);
      // CAS 3:目标 version
      if (target.version !== input.expectedProfileVersion) {
        throw createDomainError('VERSION_CONFLICT');
      }
      // 目标必须 active adult 已设 PIN;已是主档案属非法输入
      if (target.id === currentMain.id) {
        throw new DomainError(400, ProblemCode.VALIDATION_FAILED, '目标档案已是主档案');
      }
      if (target.status !== 'active' || target.type !== 'adult' || target.pinHash === null) {
        // 「目标必须 active adult 有 PIN」:状态冲突 409
        throw createDomainError('MAIN_PROFILE_CONFLICT');
      }

      // 一次事务先去旧标记再设新标记(两行版本同步递增;不允许中间状态提交)
      tx
        .update(profile)
        .set({ isMain: 0, version: currentMain.version + 1 })
        .where(eq(profile.id, currentMain.id))
        .run();
      tx
        .update(profile)
        .set({ isMain: 1, version: target.version + 1 })
        .where(eq(profile.id, target.id))
        .run();
      tx
        .update(household)
        .set({ mainProfileVersion: householdRow.mainProfileVersion + 1 })
        .where(eq(household.id, householdId))
        .run();
      // 「完成撤销全部设置授予」(转移后旧授权一律失效;含未撤销行兜底)
      revokeAllSettingsGrantsForHouseholdTx(tx, householdId);

      return { mainProfileId: target.id, mainProfileVersion: householdRow.mainProfileVersion + 1 };
    },
    { behavior: 'immediate' },
  );
}
