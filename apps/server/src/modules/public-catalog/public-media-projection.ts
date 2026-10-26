import type { PublicMediaDto } from '@hmp/shared';

/**
 * PublicMedia 白名单投影(T017/T024/T025,005 data-model.md §9 逐字):
 * 「PublicMedia:id、type、title、description、posterRef、contentLevel、availability;
 *   posterRef 仅服务端认可的同源展示资源或 null,导入任意外部 URL 不直接渲染。
 *   只有可用资源进入目录;个人记录的失效媒体使用 unavailable 摘要。」
 *
 * 本模块是公共目录/详情唯一的 DTO 出口:白名单外的源字段(source URL、来源身份、
 * upstream 标识、播放 location 等)即使出现在内部行上也绝不进入 DTO;
 * HTTP 层与服务层一律复用本投影,不另建第二套字段映射。
 */

/** 投影输入行(内部目录事实;仅声明投影所需的白名单来源列) */
export interface PublicMediaRow {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly description: string | null;
  readonly posterRef: string | null;
  readonly contentLevel: number | null;
  /** 家庭级真实可用性(present 条目 × 启用来源 × 播放资源;与 004/005 投影同口径) */
  readonly available: boolean;
}

/**
 * posterRef 同源认可门(data-model §9)——
 * 「posterRef 仅服务端认可的同源展示资源或 null」。当前部署没有同源海报展示端点
 * (003 导入管线把 media_item.poster_ref 恒写 NULL,仓库内亦无海报资源路由),
 * 因此「服务端认可的展示资源引用」集合为空:任何存储值(含将来可能出现的导入
 * 外部 URL)一律投影为 null,绝不把存储值原样转发给客户端渲染。
 * 后续若新增同源海报端点,仅需在此扩展「认可的同源引用」判定(例如
 * `/api/posters/{opaqueRef}` 白名单形态),不放宽为直通存储值。
 */
function approvedPosterRef(_rawPosterRef: string | null): string | null {
  return null;
}

/** 白名单投影:唯一合法出口;availability 由家庭级可用性映射(unavailable 摘要保留元数据) */
export function toPublicMedia(row: PublicMediaRow): PublicMediaDto {
  return {
    id: row.id,
    type: row.type as PublicMediaDto['type'],
    title: row.title,
    description: row.description,
    posterRef: approvedPosterRef(row.posterRef),
    contentLevel: row.contentLevel,
    availability: row.available ? 'available' : 'unavailable',
  };
}
