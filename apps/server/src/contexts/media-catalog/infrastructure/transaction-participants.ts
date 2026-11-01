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
 */
import type { MediaItem } from '@platform/database/schema';
import type { TransactionBinding } from '@platform/database/unit-of-work';

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

/**
 * media-catalog 事务参与者绑定实现(目录发布/复用/派生展示/公共 revision)。
 */
export class DrizzleMediaCatalogTxParticipants implements CatalogParticipantMirror {
  constructor(private readonly binding: TransactionBinding) {}

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
}

/** TxStore 工厂(装配期注册进 UnitOfWork txStores,键 'catalog') */
export function createMediaCatalogTxParticipants(binding: TransactionBinding): DrizzleMediaCatalogTxParticipants {
  return new DrizzleMediaCatalogTxParticipants(binding);
}
