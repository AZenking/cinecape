/**
 * media-catalog 事务参与者(T016,同连接绑定实现)。
 *
 * 端口归属说明:CatalogParticipant 由 online-vod 发布工作集
 * (contexts/online-vod/application/publication-work-set.port.ts)声明、所有者标注为
 * media-catalog(internal-ports.md §1 CatalogMaterializationParticipant:发布父子媒体、
 * 角色、关系、元数据及公共 revision;独立维护目录不混个人历史)。因 R2 跨上下文
 * 深导入禁令(import type 亦成边),本文件以**结构镜像类型**声明端口形状
 * (逐字段一致,镜像源在注释标明),结构一致性由消费侧工作集装配处编译期强制;
 * 行类型 CatalogMediaRow 直接取自 @platform/database/schema 的 MediaItem 投影。
 *
 * 与 UnitOfWork 的接合:装配期注册进 createUnitOfWork txStores(键 'catalog'),
 * 每次 run 由平台以同一连接 TransactionBinding 调用工厂;全部方法同步执行,
 * 任何方法抛错(含 FK/CHECK 冲突)即整体回滚。列名对照 schema.ts / migrations/0007。
 *
 * 014 T008 增量:channel_logo 胜者注册表镜像方法面(internal-ports.md §2,签名形状
 * 以该节冻结)——findChannelLogo / upsertChannelLogoWinner / revokeChannelLogo /
 * gcExpiredChannelLogoTombstones / setChannelPosterRef;合并语义按 data-model §4
 * M1–M4:active 同源同 url 无操作不换 ref;epg 绝不覆盖 iptv 胜者;upsert 活动行
 * 覆盖墓碑(清 revoked_at、换 ref、revision+1);引用签发(随机 128-bit hex)在
 * 参与者内完成,UNIQUE(household_id, ref) 冲突重签重试(唯一约束兜底)。
 * channel_logo DDL 权威在 migrations/0009_channel_logos(data-model §2);本文件
 * 原生 SQL 不依赖 drizzle schema 对象(与 MEDIA_ITEM_SELECT 同风格)。
 */
import { randomBytes } from 'node:crypto';
import type { MediaItem } from '@platform/database/schema';
import type { TransactionBinding } from '@platform/database/unit-of-work';
import { issueLogoRef, type LogoRef, type RandomBytesFn } from '@contexts/media-catalog/domain/logo-ref';

/* ------------------------------ 跨上下文类型镜像(R2 禁深导入;源: online-vod publication-work-set.port.ts) ------------------------------ */

/** 镜像 CatalogMediaRow(= schema MediaItem,media_item $inferSelect) */
export type CatalogMediaRowMirror = MediaItem;

/** 镜像 VodParentMediaInsert:vod_title 父媒体发布值集(media_item 新行) */
export interface VodParentMediaInsert {
  readonly id: string;
  readonly householdId: string;
  readonly type: 'movie' | 'series' | 'video';
  readonly title: string;
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 镜像 VodEpisodeMediaInsert:vod_episode 子媒体发布值集(media_item 新行) */
export interface VodEpisodeMediaInsert {
  readonly id: string;
  readonly householdId: string;
  readonly title: string;
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * 镜像 MediaRelationInsert:父子关系写入值集(media_relation 新行)。
 * 010 收敛:media_relation 已改为 (household_id, child_id) 复合主键、无独立
 * id/created_at 列(010 data-model §2 / migrations/0007),值集仅 5 字段。
 */
export interface MediaRelationInsert {
  readonly householdId: string;
  readonly parentId: string;
  readonly childId: string;
  readonly sortOrder: number;
}

/** 镜像 CatalogParticipant:目录物化参与者端口 */
export interface CatalogParticipantMirror {
  findCatalogMedia(householdId: string, mediaId: string): CatalogMediaRowMirror | undefined;
  insertVodTitleMedia(values: VodParentMediaInsert): void;
  insertVodEpisodeMedia(values: VodEpisodeMediaInsert): void;
  insertEpisodeParentRelation(values: MediaRelationInsert): void;
  updateDerivedPresentation(householdId: string, mediaId: string, patch: { title?: string; description?: string | null }, updatedAt: string): boolean;
  bumpPublicCatalogRevision(householdId: string): void;
}

/** media_item 行投影(列别名 camelCase) */
const MEDIA_ITEM_SELECT = `
  SELECT
    id,
    household_id AS householdId,
    type,
    title,
    description,
    poster_ref AS posterRef,
    content_level AS contentLevel,
    title_overridden AS titleOverridden,
    type_overridden AS typeOverridden,
    version,
    content_revision AS contentRevision,
    media_role AS mediaRole,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM media_item
`;

/* ------------------------------------------------------------------ */
/* 014 T008:channel_logo 胜者注册表镜像(internal-ports.md §2)           */
/* ------------------------------------------------------------------ */

/** channel_logo 胜者来源词汇(data-model §2 source_kind CHECK) */
export type ChannelLogoSourceKind = 'iptv' | 'epg' | 'custom';

/** channel_logo 行投影(胜者读取;internal-ports §2 findChannelLogo 返回形状) */
export interface ChannelLogoWinnerRow {
  readonly mediaId: string;
  readonly ref: string;
  /** 私有上游地址;墓碑态必须为 NULL(data-model §2 CHECK) */
  readonly upstreamUrl: string | null;
  readonly sourceKind: ChannelLogoSourceKind;
  /** 来源证据(media_source 同家庭行) */
  readonly sourceId: string;
  readonly revision: number;
  /** 墓碑时间(ISO-8601);NULL=active */
  readonly revokedAt: string | null;
}

/** 胜者写入命令(internal-ports §2 upsertChannelLogoWinner 命令形状) */
export interface ChannelLogoWinnerCommand {
  readonly householdId: string;
  readonly mediaId: string;
  readonly upstreamUrl: string;
  readonly sourceKind: ChannelLogoSourceKind;
  readonly sourceId: string;
  /** 事务内时间戳(ISO-8601);缺省 = 参与者内取当前时间(测试可注入确定性值) */
  readonly nowIso?: string;
}

/**
 * 镜像 ChannelLogoParticipant:channel_logo 注册表事务参与者端口
 * (镜像源:014 internal-ports.md §2「发布参与者(media-catalog 事务镜像扩展)」;
 * 消费方 sources/epg 发布工作集经结构镜像类型消费,同 CatalogParticipantMirror 惯例)。
 */
export interface ChannelLogoParticipantMirror {
  findChannelLogo(householdId: string, mediaId: string): ChannelLogoWinnerRow | undefined;
  upsertChannelLogoWinner(command: ChannelLogoWinnerCommand): { ref: string };
  revokeChannelLogo(householdId: string, mediaId: string, nowIso: string): void;
  gcExpiredChannelLogoTombstones(householdId: string, olderThanIso: string): void;
  setChannelPosterRef(householdId: string, mediaId: string, ref: string | null): void;
}

/**
 * 墓碑 GC 窗口(data-model §4「墓碑窗口:revoked_at ≤ now−7d 的行在任一发布事务内
 * 集合 DELETE」);发布方据此计算 gcExpiredChannelLogoTombstones 的 olderThanIso。
 */
export const CHANNEL_LOGO_TOMBSTONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** channel_logo 胜者读取(列别名 camelCase;按 (household_id, media_id) 单查) */
const CHANNEL_LOGO_SELECT = `
  SELECT
    media_id AS mediaId,
    ref,
    upstream_url AS upstreamUrl,
    source_kind AS sourceKind,
    source_id AS sourceId,
    revision,
    revoked_at AS revokedAt
  FROM channel_logo
`;

/** UNIQUE(household_id, ref) 冲突判定(重签重试的唯一触发面;其余约束原样上抛) */
function isChannelLogoRefConflict(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code ?? '';
  const message = error instanceof Error ? error.message : '';
  return code.startsWith('SQLITE_CONSTRAINT') && message.includes('channel_logo.household_id, channel_logo.ref');
}

/** 重签重试上限(128-bit 随机下冲突概率可忽略;上限纯为防御失控循环) */
const LOGO_REF_ISSUE_MAX_ATTEMPTS = 5;

/**
 * media-catalog 事务参与者绑定实现(目录发布/复用/派生展示/公共 revision;
 * 014 T008 起兼任 channel_logo 注册表参与者)。
 */
export class DrizzleMediaCatalogTxParticipants implements CatalogParticipantMirror, ChannelLogoParticipantMirror {
  /** 随机字节源(T007 引用签发;测试注入确定性字节驱动重签路径) */
  private readonly random: RandomBytesFn;

  constructor(
    private readonly binding: TransactionBinding,
    random: RandomBytesFn = randomBytes,
  ) {
    this.random = random;
  }

  findCatalogMedia(householdId: string, mediaId: string): CatalogMediaRowMirror | undefined {
    return this.binding.get<CatalogMediaRowMirror>(
      `${MEDIA_ITEM_SELECT} WHERE household_id = ? AND id = ?`,
      [householdId, mediaId],
    );
  }

  insertVodTitleMedia(values: VodParentMediaInsert): void {
    // media_role='vod_title' 与 type 配对由 media_item_media_role_type_check(CHECK)落实;
    // 派生列取初值:poster_ref/content_level NULL、人工保护标记 0、version/content_revision 1
    this.binding.exec(
      `INSERT INTO media_item (
        id, household_id, type, title, description, poster_ref, content_level,
        title_overridden, type_overridden, version, content_revision, media_role,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, 0, 1, 1, 'vod_title', ?, ?)`,
      [values.id, values.householdId, values.type, values.title, values.description, values.createdAt, values.updatedAt],
    );
  }

  insertVodEpisodeMedia(values: VodEpisodeMediaInsert): void {
    this.binding.exec(
      `INSERT INTO media_item (
        id, household_id, type, title, description, poster_ref, content_level,
        title_overridden, type_overridden, version, content_revision, media_role,
        created_at, updated_at
      ) VALUES (?, ?, 'episode', ?, ?, NULL, NULL, 0, 0, 1, 1, 'vod_episode', ?, ?)`,
      [values.id, values.householdId, values.title, values.description, values.createdAt, values.updatedAt],
    );
  }

  insertEpisodeParentRelation(values: MediaRelationInsert): void {
    // 010 收敛:media_relation 为 5 列(household_id,parent_id,child_id,kind,sort_order),
    // 行身份即 (household_id, child_id) 复合主键、无独立 id/created_at(0007 本体);
    // kind=vod_episode 单层父子;child 唯一父/自环由复合主键与 CHECK 落实,冲突即回滚
    this.binding.exec(
      `INSERT INTO media_relation (household_id, parent_id, child_id, kind, sort_order)
       VALUES (?, ?, ?, 'vod_episode', ?)`,
      [values.householdId, values.parentId, values.childId, values.sortOrder],
    );
  }

  updateDerivedPresentation(
    householdId: string,
    mediaId: string,
    patch: { title?: string; description?: string | null },
    updatedAt: string,
  ): boolean {
    // 仅覆盖派生展示字段:人工 title(title_overridden=1)保留不动;patch 缺省键/
    // description 的 null 语义均按「不覆盖」处理(上游载荷缺省;派生展示无独立清除路径)。
    // 「实际是否变更」在同一事务内先读后算(BEGIN IMMEDIATE 持写锁期间无并发写者,
    // 读算写原子);无差异不产生写入并返回 false。
    const current = this.binding.get<{
      title: string;
      description: string | null;
      titleOverridden: number;
    }>('SELECT title, description, title_overridden AS titleOverridden FROM media_item WHERE household_id = ? AND id = ?', [
      householdId,
      mediaId,
    ]);
    if (current === undefined) {
      return false;
    }
    const nextTitle = current.titleOverridden === 1 || patch.title === undefined ? current.title : patch.title;
    const nextDescription = patch.description === undefined ? current.description : patch.description;
    if (nextTitle === current.title && nextDescription === current.description) {
      return false;
    }
    this.binding.exec(
      'UPDATE media_item SET title = ?, description = ?, version = version + 1, updated_at = ? WHERE household_id = ? AND id = ?',
      [nextTitle, nextDescription, updatedAt, householdId, mediaId],
    );
    return true;
  }

  bumpPublicCatalogRevision(householdId: string): void {
    // catalog_state.revision +1(一家庭一行;缺行补建 revision=2,与既有
    // bumpCatalogRevision 同语义);仅公开变化时由 application 调用(重放不虚增)
    this.binding.exec(
      `INSERT INTO catalog_state (household_id, revision) VALUES (?, 2)
       ON CONFLICT(household_id) DO UPDATE SET revision = catalog_state.revision + 1`,
      [householdId],
    );
  }

  /* ---------------------------------------------------------------- */
  /* 014 T008:channel_logo 胜者注册表(internal-ports.md §2 / M1–M4)      */
  /* ---------------------------------------------------------------- */

  /** 胜者读取(合并判定输入;无行 undefined) */
  findChannelLogo(householdId: string, mediaId: string): ChannelLogoWinnerRow | undefined {
    return this.binding.get<ChannelLogoWinnerRow>(
      `${CHANNEL_LOGO_SELECT} WHERE household_id = ? AND media_id = ?`,
      [householdId, mediaId],
    );
  }

  /**
   * 胜者写入/撤销的原子执行体(data-model §4 M1/M3 写入路径;调用方先经
   * findChannelLogo 判定来源证据后再进入,BEGIN IMMEDIATE 事务内读算写原子):
   * - 行存在且 active 且(同源同 url)⇒ 无操作不换 ref(ref 稳定性 = 浏览器缓存
   *   与 revision 不变,data-model §6);
   * - 行存在且 active(iptv) 且本次来源 epg ⇒ 不动,epg 绝不覆盖 iptv 胜者
   *   (data-model §4「任何场景」行),返回既有 ref;
   * - 其余(缺行新签 / active 换源换 url / 墓碑复 active)⇒ 同行写入:新签 ref、
   *   revision+1(缺行 1)、清 revoked_at;引用签发在参与者内完成
   *   (internal-ports §2「签发 + 写 poster_ref 同事务同域」),UNIQUE
   *   (household_id, ref) 冲突时重签重试(唯一约束兜底,T007)。
   */
  upsertChannelLogoWinner(command: ChannelLogoWinnerCommand): { ref: LogoRef } {
    const nowIso = command.nowIso ?? new Date().toISOString();
    const current = this.findChannelLogo(command.householdId, command.mediaId);
    if (current !== undefined && current.revokedAt === null) {
      if (current.upstreamUrl === command.upstreamUrl && current.sourceKind === command.sourceKind) {
        return { ref: current.ref };
      }
      if (current.sourceKind === 'iptv' && command.sourceKind === 'epg') {
        return { ref: current.ref };
      }
      if (current.sourceKind === 'custom' && command.sourceKind !== 'custom') {
        return { ref: current.ref };
      }
    }
    const nextRevision = (current?.revision ?? 0) + 1;
    for (let attempt = 0; attempt < LOGO_REF_ISSUE_MAX_ATTEMPTS; attempt += 1) {
      const ref = issueLogoRef(this.random);
      try {
        if (current === undefined) {
          this.binding.exec(
            `INSERT INTO channel_logo (
              household_id, media_id, ref, upstream_url, source_kind, source_id,
              revision, revoked_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
            [
              command.householdId,
              command.mediaId,
              ref,
              command.upstreamUrl,
              command.sourceKind,
              command.sourceId,
              nextRevision,
              nowIso,
              nowIso,
            ],
          );
        } else {
          // 同行覆盖(墓碑复 active / 换源换 url):清 revoked_at、换 ref、revision+1
          this.binding.exec(
            `UPDATE channel_logo
             SET ref = ?, upstream_url = ?, source_kind = ?, source_id = ?,
                 revision = ?, revoked_at = NULL, updated_at = ?
             WHERE household_id = ? AND media_id = ?`,
            [
              ref,
              command.upstreamUrl,
              command.sourceKind,
              command.sourceId,
              nextRevision,
              nowIso,
              command.householdId,
              command.mediaId,
            ],
          );
        }
        return { ref };
      } catch (error) {
        // ref 撞同家庭其他频道行(128-bit 随机,现实不可达;唯一约束兜底):重签重试
        if (!isChannelLogoRefConflict(error)) {
          throw error;
        }
      }
    }
    throw new Error(`channel_logo ref 签发重签重试耗尽(${LOGO_REF_ISSUE_MAX_ATTEMPTS} 次)`);
  }

  /**
   * 撤销转墓碑(M2/M4 执行体):清 upstream_url + 置 revoked_at(data-model §5
   * active → tombstone)。仅对 active 行生效(幂等:无行/已墓碑 no-op,不刷新
   * 已有 revoked_at——墓碑窗口以首次撤销时间计);来源证据门(只撤自己来源的
   * 胜者,M2 仅 active(iptv)/M4 仅 active(epg))由发布方先读后判,本执行体
   * 不重复证据判定(BEGIN IMMEDIATE 同事务内读算写原子)。
   */
  revokeChannelLogo(householdId: string, mediaId: string, nowIso: string): void {
    this.binding.exec(
      `UPDATE channel_logo
       SET upstream_url = NULL, revoked_at = ?, updated_at = ?
       WHERE household_id = ? AND media_id = ? AND revoked_at IS NULL`,
      [nowIso, nowIso, householdId, mediaId],
    );
  }

  /**
   * 墓碑 GC(data-model §4「revoked_at ≤ now−7d 的行在任一发布事务内集合 DELETE,
   * 无后台任务」):olderThanIso 由发布方以 CHANNEL_LOGO_TOMBSTONE_WINDOW_MS 计算;
   * 集合 DELETE 仅触该家庭,active 行不受影响。
   */
  gcExpiredChannelLogoTombstones(householdId: string, olderThanIso: string): void {
    this.binding.exec(
      'DELETE FROM channel_logo WHERE household_id = ? AND revoked_at IS NOT NULL AND revoked_at <= ?',
      [householdId, olderThanIso],
    );
  }

  /** media_item.poster_ref 落值(发布事务内;既有 updateDerivedPresentation 同风格) */
  setChannelPosterRef(householdId: string, mediaId: string, ref: string | null): void {
    this.binding.exec(
      'UPDATE media_item SET poster_ref = ? WHERE household_id = ? AND id = ?',
      [ref, householdId, mediaId],
    );
  }
}

/** TxStore 工厂(装配期注册进 UnitOfWork txStores,键 'catalog';random 仅供测试注入重签序列) */
export function createMediaCatalogTxParticipants(
  binding: TransactionBinding,
  random?: RandomBytesFn,
): DrizzleMediaCatalogTxParticipants {
  return new DrizzleMediaCatalogTxParticipants(binding, random);
}
