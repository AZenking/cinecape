/**
 * identity-access 只读事务端口工厂(T016,同连接绑定实现;纯读面)。
 *
 * 端口归属说明:IdentitySnapshotReader / PlaybackIdentityReader / PreferenceIdentityReader
 * 分别由 online-vod / playback / personal-data 的 T015 工作集端口文件声明、所有者标注为
 * identity-access(三个接口方法面一致:findDeviceContext 快照形状逐字段相同)。
 * 因 R2 跨上下文深导入禁令(import type 亦成边),本文件以**结构镜像类型**声明
 * (镜像源在注释标明),一份实现同时满足三者;结构一致性由消费侧工作集装配处编译期强制。
 *
 * 与 UnitOfWork 的接合:装配期注册进 createUnitOfWork txStores(键 'identityAccess'),
 * 每次 run 由平台以同一连接 TransactionBinding 调用工厂;事务内身份重验
 * (「已授权不能替代事务内重验」)由此读取面供事实,撤销/过期判定归 application。
 */
import type { TransactionBinding } from '@platform/database/unit-of-work';

/* ------------- 跨上下文类型镜像(R2 禁深导入;源: online-vod/playback/personal-data 工作集端口,所有者 identity-access) ------------- */

/** 镜像 DeviceIdentitySnapshot / PlaybackIdentitySnapshot / PreferenceIdentitySnapshot(三端口快照形状一致) */
export interface DeviceIdentitySnapshotMirror {
  readonly deviceSessionId: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly profileId: string;
  readonly profileContextVersion: number;
  readonly revokedAt: string | null;
  readonly expiresAt: string;
}

/** 镜像三个 identity 读取端口(方法面一致) */
export interface IdentityReaderMirror {
  findDeviceContext(deviceSessionId: string): DeviceIdentitySnapshotMirror | undefined;
}

/**
 * identity-access 只读事务工厂(设备会话身份快照)。
 */
export class DrizzleIdentityAccessTxReaders implements IdentityReaderMirror {
  constructor(private readonly binding: TransactionBinding) {}

  findDeviceContext(deviceSessionId: string): DeviceIdentitySnapshotMirror | undefined {
    // active_profile_id 为 NULL(无当前观看者)不构成可用身份上下文 → undefined;
    // revokedAt/expiresAt 原样携带,撤销/过期拒绝判定归 application(端口注释)
    return this.binding.get<DeviceIdentitySnapshotMirror>(
      `SELECT
        id AS deviceSessionId,
        account_id AS accountId,
        device_id AS deviceId,
        active_profile_id AS profileId,
        profile_context_version AS profileContextVersion,
        revoked_at AS revokedAt,
        expires_at AS expiresAt
       FROM device_session
       WHERE id = ? AND active_profile_id IS NOT NULL`,
      [deviceSessionId],
    );
  }
}

/** TxStore 工厂(装配期注册进 UnitOfWork txStores,键 'identityAccess') */
export function createIdentityAccessTxReaders(binding: TransactionBinding): DrizzleIdentityAccessTxReaders {
  return new DrizzleIdentityAccessTxReaders(binding);
}
