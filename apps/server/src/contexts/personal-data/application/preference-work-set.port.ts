/**
 * 010-online-vod T015（范围扩展文件）：连播偏好写入事务工作集（纯 TS，零实现）。
 *
 * 偏差说明：T015 原文字面仅列 online-vod/playback 两个端口文件；本文件依据
 * docs/specs/010-online-vod/contracts/internal-ports.md §5「审查新增工作集」的
 * PreferenceWriteWorkSet（Identity/ProfileReader + PreferenceTx + PreferenceOperationTx）
 * 落在所有者 personal-data 的 application 目录（tasks.md T016 审查补充亦要求接入
 * PreferenceWrite 工作集），故按所有者归属单独建文件而非塞入 playback 文件。
 *
 * 契约来源：internal-ports.md §2（UnitOfWork 同步 run 机制）/ §5（PreferenceWriteWorkSet）；
 * 结果类型对齐 contracts/api.md §1（Preferences）与 §3（GET/PATCH /me/vod/preferences）。
 *
 * 与 T008 UnitOfWork API（apps/server/test/unit/online-vod/unit-of-work.spec.ts）对齐：
 * - 工作集成员经 createUnitOfWork({ resolveDatabase, txStores }) 的 personalData TxStore
 *   工厂以同一连接事务绑定（T016 实现），workSetFactory 产出本接口；
 * - callback 同步签名，全部方法同步返回；先成功重放、再 CAS、写偏好与不可变成功响应
 *   三步在同一 commit 内完成，任何一步失败整体回滚。
 */
import type { profile, profileVodPreferenceOperation } from '@platform/database/schema';

/* ------------------------------ schema 行投影（type-only 单一事实源） ------------------------------ */

/** 当前主档案行（profile） */
export type PreferenceProfileRow = typeof profile.$inferSelect;
/* (010 T090 knip 清理:原 VodPreferencesRow = profileVodPreferences.$inferSelect
 *  投影已删除——零消费,读取面走 VodPreferencesSnapshot 纯值形态) */
/** 偏好写入幂等操作行（profile_vod_preference_operation；仅成功操作占 key） */
export type PreferenceOperationRow = typeof profileVodPreferenceOperation.$inferSelect;

/* ------------------------------------ 配套纯值类型（事实/结果/写入值） ------------------------------------ */

/** 设备会话身份快照（identity-access 读取投影；同事务先重验当前身份再判定重放/写入） */
export interface PreferenceIdentitySnapshot {
  readonly deviceSessionId: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly profileId: string;
  readonly profileContextVersion: number;
  readonly revokedAt: string | null;
  readonly expiresAt: string;
}

/** 偏好快照（api §1 Preferences；无持久行返回传输初值 true/true/version=0，不偷偷写公共状态） */
export interface VodPreferencesSnapshot {
  readonly autoplayNext: boolean;
  readonly switchCarryPosition: boolean;
  readonly version: number;
}

/** 偏好 CAS 更新值集（至少一项偏好字段；持久 version 由实现 +1，服务端绝不写 0） */
export interface PreferenceUpdateValues {
  readonly householdId: string;
  readonly profileId: string;
  readonly expectedVersion: number;
  readonly autoplayNext: boolean | null;
  readonly switchCarryPosition: boolean | null;
}

/** 幂等成功响应写入值集（profile_vod_preference_operation 新行；仅成功操作占 key） */
export interface PreferenceOperationInsertValues {
  readonly id: string;
  readonly householdId: string;
  readonly deviceSessionId: string;
  readonly profileId: string;
  readonly profileContextVersion: number;
  readonly operationKey: string;
  readonly requestDigest: string;
  /** 当时 Preferences 的 JSON（成功响应不可变，重放原样返回不更新版本） */
  readonly resultJson: string;
  readonly committedAt: string;
  readonly expiresAt: string;
}

/* ------------------------------------------ Read 面 / Write 面 ------------------------------------------ */

/**
 * 身份快照读取端口。
 * 所有者：identity-access（T016 经 txStores 注册同连接绑定实现）。
 */
export interface PreferenceIdentityReader {
  /** 事务内重验当前设备会话身份与上下文版本（成功 key 重放同样先重验当前身份） */
  findDeviceContext(deviceSessionId: string): PreferenceIdentitySnapshot | undefined;
}

/**
 * 主档案读取端口。
 * 所有者：profile。
 */
export interface PreferenceProfileReader {
  /** 读当前 Profile 行（偏好归属一致性输入；跨家庭/不存在交由用例判 404） */
  findProfile(householdId: string, profileId: string): PreferenceProfileRow | undefined;
}

/**
 * 偏好事务端口。
 * 所有者：personal-data（profile_vod_preferences 读写；CAS 由 expectedVersion 比对执行）。
 */
export interface PreferenceTx {
  /** 读当前偏好快照（无行返回传输初值 version=0，不落库） */
  findPreferences(householdId: string, profileId: string): VodPreferencesSnapshot;
  /** CAS 更新偏好（expectedVersion 失配返回 undefined 交由用例判 409，整体回滚） */
  updatePreferencesWithCas(values: PreferenceUpdateValues): VodPreferencesSnapshot | undefined;
}

/**
 * 偏好幂等操作事务端口。
 * 所有者：personal-data（唯一 (household, device_session, context_version, operation_key)；
 * 固定 >=24h 保留，过期清理不删偏好）。
 */
export interface PreferenceOperationTx {
  /** 同 scope 读已提交成功操作（命中即先成功重放：原样返回 result，不更新偏好版本） */
  findCommittedOperation(householdId: string, deviceSessionId: string, profileContextVersion: number, operationKey: string): PreferenceOperationRow | undefined;
  /** 写不可变成功响应（与偏好 CAS 同 commit；幂等记录不进公共缓存或日志） */
  recordCommittedOperation(values: PreferenceOperationInsertValues): void;
}

/* ------------------- 工作集聚合（T008 run 同步 callback 消费形态） -------------------
 * (010 T090 knip 清理:原 PreferenceWriteWorkSet 聚合接口已删除——零代码消费,
 *  vod-preferences.service 以 deps 注入函数束承载同语义;成员端口
 *  PreferenceIdentityReader/PreferenceProfileReader/PreferenceTx/PreferenceOperationTx
 *  保留,均有独立消费方)
 * ----------------------------------------------------------------------------- */
