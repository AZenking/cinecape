/**
 * policy 事务参与者(T016,同连接绑定实现;只读事务面)。
 *
 * 端口归属说明:PolicyReader / PlaybackPolicyReader 分别由 online-vod 发布工作集与
 * playback 工作集端口文件声明、所有者标注为 policy(internal-ports.md §1
 * EffectiveMediaPolicyPort:ADR-0006 允许名单规则保留,判定顺序归 application)。
 * 因 R2 跨上下文深导入禁令(import type 亦成边),本文件以**结构镜像类型**声明端口
 * 形状(两端口方法面一致,一份实现同时满足两者;镜像源在注释标明),结构一致性由
 * 消费侧工作集装配处编译期强制。注意:policy domain/application 的
 * effective-media-policy 判定实现归 T017,本文件只提供事务内事实读取,不承载判定。
 *
 * 与 UnitOfWork 的接合:装配期注册进 createUnitOfWork txStores(键 'policy'),
 * 每次 run 由平台以同一连接 TransactionBinding 调用工厂;全部方法同步执行。
 * 列名对照 schema.ts(0002 profile_policy / 0003 media_item)。
 */
import type { TransactionBinding } from '@platform/database/unit-of-work';

/* ------------------------------ 跨上下文类型镜像(R2 禁深导入;源: online-vod/playback 工作集端口) ------------------------------ */

/** 镜像 PolicyRow / profile_policy $inferSelect(见 @platform/database/schema ProfilePolicy) */
export interface PolicyRowMirror {
  readonly householdId: string;
  readonly profileId: string;
  readonly maxContentLevel: number;
  readonly allowUnrated: number;
  readonly allowedMediaIds: string;
  readonly blockedMediaIds: string;
  readonly allowedChannelIds: string;
  readonly version: number;
  readonly updatedAt: string;
}

/** 镜像 PolicyTargetMediaRow / PlaybackPolicyTargetRow(两端口投影形状一致) */
export interface PolicyTargetMediaRowMirror {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly contentLevel: number | null;
  readonly version: number;
}

/** 镜像 PolicyReader(online-vod MaterializeWorkSet.policy)/ PlaybackPolicyReader(playback 工作集.policy) */
export interface PolicyReaderMirror {
  findEffectivePolicy(householdId: string, profileId: string): PolicyRowMirror | undefined;
  listPolicyTargetMedia(householdId: string, mediaIds: readonly string[]): PolicyTargetMediaRowMirror[];
}

/** SQLite 变量参数单批上限(32766 之上部分构建收窄;取保守 500 分批,仍为批量装载) */
const BATCH_PARAM_LIMIT = 500;

/**
 * policy 事务参与者绑定实现(有效策略行 + 批量目标媒体事实;纯读面)。
 */
export class DrizzlePolicyTxReaders implements PolicyReaderMirror {
  constructor(private readonly binding: TransactionBinding) {}

  findEffectivePolicy(householdId: string, profileId: string): PolicyRowMirror | undefined {
    // 行缺失按策略拒绝语义交由用例处理(端口注释);分级基线/名单原文随行携带
    return this.binding.get<PolicyRowMirror>(
      `SELECT
        household_id AS householdId,
        profile_id AS profileId,
        max_content_level AS maxContentLevel,
        allow_unrated AS allowUnrated,
        allowed_media_ids AS allowedMediaIds,
        blocked_media_ids AS blockedMediaIds,
        allowed_channel_ids AS allowedChannelIds,
        version,
        updated_at AS updatedAt
       FROM profile_policy
       WHERE household_id = ? AND profile_id = ?`,
      [householdId, profileId],
    );
  }

  listPolicyTargetMedia(householdId: string, mediaIds: readonly string[]): PolicyTargetMediaRowMirror[] {
    // 批量装载(父/子一次集合查询,禁每集 N+1);入参去重,空集直接返回空
    const uniqueIds = Array.from(new Set(mediaIds));
    if (uniqueIds.length === 0) {
      return [];
    }
    const rows: PolicyTargetMediaRowMirror[] = [];
    for (let offset = 0; offset < uniqueIds.length; offset += BATCH_PARAM_LIMIT) {
      const batch = uniqueIds.slice(offset, offset + BATCH_PARAM_LIMIT);
      const placeholders = batch.map(() => '?').join(', ');
      rows.push(
        ...this.binding.all<PolicyTargetMediaRowMirror>(
          `SELECT id, type, title, content_level AS contentLevel, version
           FROM media_item
           WHERE household_id = ? AND id IN (${placeholders})`,
          [householdId, ...batch],
        ),
      );
    }
    return rows;
  }
}

/** TxStore 工厂(装配期注册进 UnitOfWork txStores,键 'policy') */
export function createPolicyTxReaders(binding: TransactionBinding): DrizzlePolicyTxReaders {
  return new DrizzlePolicyTxReaders(binding);
}
