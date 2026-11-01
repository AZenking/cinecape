/**
 * 010-online-vod T029:物化公共发布语义(纯函数模块,零框架/零 IO 依赖)。
 *
 * 职责边界(与 materialization.service.ts 分工):
 * - catalogRevision 发布判定:仅「公共可见变化/首次物化」+1;无变化重放一律不加
 *   (data-model §3「catalogRevision只在公共可见字段/关系/可用性或首次物化改变时+1;
 *   无变化重放、URL token/采集时间变化不加」、§4「同key结果固定不刷新」);
 * - 派生展示发布:经 CatalogParticipant.updateDerivedPresentation 既有语义落库
 *   (人工 title/title_overridden 保留不动,patch 缺省键不覆盖),返回实际是否变更;
 * - 不透明引用铸造:registeredCandidateRef 等公开发布引用只由随机 UUID 构成,
 *   不可解码(不含上游键/URL/来源内部 ID,api.md §0「私有opaque ref不能携带可解码URL」);
 * - 固定保留期常量:物化幂等结果与登记候选均固定 24h,重放不延长
 *   (data-model §4「固定24h保留，重放不延长」、§10 I1「至少 24h 保护映射/目标」)。
 *
 * 本文件不直接触碰数据库:所有写入经调用方传入的事务参与者端口
 * (T015 publication-work-set.port.ts),与物化资源同一事务提交(由
 * materialization.service 编排;失败整体回滚,revision 不虚增)。
 */
import { randomUUID } from 'node:crypto';
import type { CatalogParticipant } from './publication-work-set.port';

/** 物化幂等结果与登记候选的固定保留期:24 小时(重放不延长;到期由 T084 回收) */
export const MATERIALIZATION_RETENTION_MS = 24 * 60 * 60 * 1000;

/** 公共发布变化判定输入(物化事务内在写入前收集的事实;全部为布尔/计数,无载荷) */
export interface PublicationChangeInput {
  /** 本次为幂等重放:固定不加(原结果原样返回,revision 不虚增) */
  readonly replayed: boolean;
  /** 首次物化(目标父媒体为本次新建):公共目录新增可见父项 */
  readonly firstPublication: boolean;
  /** 派生展示实际变更(updateDerivedPresentation 返回 true;人工字段保留语义已内含) */
  readonly derivedPresentationChanged: boolean;
  /** 本次新发布的线路数(0=无) */
  readonly newLines: number;
  /** 本次新发布的子项(分集媒体/映射)数(0=无) */
  readonly newEpisodes: number;
  /** 本次新发布的导航序列行数(0=无) */
  readonly newSequences: number;
  /** 本次新发布的不可变详情快照(同 revision 已存在则为 false,不重复发布) */
  readonly detailSnapshotPublished: boolean;
}

/** 公共发布判定输出:bumpCatalogRevision 与其构成原因(审计/测试可读,无敏感信息) */
export interface PublicationChange {
  readonly bumpCatalogRevision: boolean;
  readonly reasons: readonly string[];
}

/**
 * catalogRevision 发布判定(纯函数):重放恒不加;其余任一公共可见构成成立即 +1。
 * 「新增其他集不使已有子revision改变」不影响本判定——新子项属公共可见关系变化,
 * 按契约计 +1;已有子项的 revision 不由本函数触碰。
 */
export function describePublicationChange(input: PublicationChangeInput): PublicationChange {
  if (input.replayed) {
    return { bumpCatalogRevision: false, reasons: [] };
  }
  const reasons: string[] = [];
  if (input.firstPublication) {
    reasons.push('first_publication');
  }
  if (input.derivedPresentationChanged) {
    reasons.push('derived_presentation');
  }
  if (input.newLines > 0) {
    reasons.push('new_lines');
  }
  if (input.newEpisodes > 0) {
    reasons.push('new_episodes');
  }
  if (input.newSequences > 0) {
    reasons.push('new_sequences');
  }
  if (input.detailSnapshotPublished) {
    reasons.push('detail_snapshot');
  }
  return { bumpCatalogRevision: reasons.length > 0, reasons };
}

/**
 * 派生展示发布(media-catalog 既有语义的调用点):仅覆盖派生 title/description,
 * 人工修正(title_overridden/type_overridden)保留不动;返回「实际是否变更」,
 * 作为 catalogRevision 判定输入(无差异不产生写入、不计公共变化)。
 */
export function publishDerivedPresentation(
  catalog: CatalogParticipant,
  householdId: string,
  parentMediaId: string,
  patch: { readonly title?: string; readonly description?: string | null },
  updatedAt: string,
): boolean {
  return catalog.updateDerivedPresentation(householdId, parentMediaId, patch, updatedAt);
}

/**
 * 铸造不透明发布引用(registeredCandidateRef 等):随机 UUID 前缀形态,
 * 不编码任何上游键/URL/来源内部 ID;同前缀引用彼此独立不可推测。
 */
export function mintOpaqueRef(prefix: string, generateId: () => string = randomUUID): string {
  return `${prefix}-${generateId()}`;
}
