/**
 * profile 只读事务端口工厂(T016,同连接绑定实现;纯读面)。
 *
 * 端口归属说明:ProfileReader / PlaybackProfileReader / PreferenceProfileReader 分别由
 * online-vod / playback / personal-data 的 T015 工作集端口文件声明、所有者标注为
 * profile(三个接口方法面一致:findProfile 返回 profile $inferSelect 行)。
 * 因 R2 跨上下文深导入禁令(import type 亦成边),本文件以**结构镜像类型**声明接口
 * (镜像源在注释标明),一份实现同时满足三者;行类型直接取自 @platform/database/schema
 * 的 Profile 投影,结构一致性由消费侧工作集装配处编译期强制。
 */
import type { Profile } from '@platform/database/schema';
import type { TransactionBinding } from '@platform/database/unit-of-work';

/** 镜像 ProfileReader / PlaybackProfileReader / PreferenceProfileReader(方法面一致) */
export interface ProfileReaderMirror {
  findProfile(householdId: string, profileId: string): Profile | undefined;
}

/**
 * profile 只读事务工厂(当前主档案行)。
 */
export class DrizzleProfileTxReaders implements ProfileReaderMirror {
  constructor(private readonly binding: TransactionBinding) {}

  findProfile(householdId: string, profileId: string): Profile | undefined {
    // 跨家庭/不存在返回 undefined,404 判定归用例(端口注释);
    // type/status 供年龄分级与可用性判定(is_main/is_default/pin 元数据随行)
    return this.binding.get<Profile>(
      `SELECT
        id,
        household_id AS householdId,
        account_id AS accountId,
        name,
        avatar,
        type,
        is_default AS isDefault,
        pin_hash AS pinHash,
        status,
        failed_pin_count AS failedPinCount,
        pin_locked_until AS pinLockedUntil,
        is_main AS isMain,
        pin_version AS pinVersion,
        version,
        created_at AS createdAt
       FROM profile
       WHERE household_id = ? AND id = ?`,
      [householdId, profileId],
    );
  }
}

/** TxStore 工厂(装配期注册进 UnitOfWork txStores,键 'profile') */
export function createProfileTxReaders(binding: TransactionBinding): DrizzleProfileTxReaders {
  return new DrizzleProfileTxReaders(binding);
}
