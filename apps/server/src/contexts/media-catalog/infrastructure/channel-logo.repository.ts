/**
 * 014 T008 — channel_logo 胜者注册表读面仓储(解析端口的非事务读路径)。
 *
 * 职责边界(ADR-0015 D1 seam 惯例,同 media-catalog-store.drizzle 的原生查询形态):
 * - 仅承载**读路径**(解析按 (household_id, ref) 索引单查,data-model §2 查询面);
 *   发布事务内的全部读写走 transaction-participants.ts 的事务镜像方法
 *   (同事务同连接,不经本仓储);
 * - 句柄惰性解析 Database.db(生产;SQLite 单例 close/重开安全),不捕获构造期句柄;
 * - upstream_url 为私有载荷:本仓储行类型仅限 server 内消费(解析端口/代理用例),
 *   绝不进公共 DTO/日志(internal-ports §5 禁止事项)。
 *
 * channel_logo DDL 权威在 migrations/0009_channel_logos(data-model §2);本文件
 * 原生 SQL 原生字符串,不依赖 drizzle schema 对象。
 */
import { Database } from '@platform/database/database';
import type { ChannelLogoSourceKind } from '@contexts/media-catalog/infrastructure/transaction-participants';

/** 解析读面行(按 ref 单查投影;mediaId 供下游/日志外零消费) */
export interface ChannelLogoResolveRow {
  readonly mediaId: string;
  readonly ref: string;
  readonly upstreamUrl: string | null;
  readonly sourceKind: ChannelLogoSourceKind;
  readonly revision: number;
  readonly revokedAt: string | null;
}

/** 按 (household_id, ref) 单查(未签发/伪造/跨家庭/GC 后 → undefined) */
const CHANNEL_LOGO_BY_REF_SQL = `
  SELECT
    media_id AS mediaId,
    ref,
    upstream_url AS upstreamUrl,
    source_kind AS sourceKind,
    revision,
    revoked_at AS revokedAt
  FROM channel_logo
  WHERE household_id = ? AND ref = ?
`;

/** 生产读面:句柄随 Database 单例惰性解析(测试 rig 可直接以行类型桩替) */
export function findChannelLogoByRef(householdId: string, ref: string): ChannelLogoResolveRow | undefined {
  return Database.db.prepare(CHANNEL_LOGO_BY_REF_SQL).get(householdId, ref) as ChannelLogoResolveRow | undefined;
}
