import { and, eq } from 'drizzle-orm';
import { ProblemCode, type ProgrammeDto, type ProgrammesDto } from '@hmp/shared';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { DomainError } from '@platform/http-common/domain-error';
import {
  device,
  deviceSession,
  epgChannel,
  epgProgramme,
  manualEpgBinding,
  mediaItem,
  mediaSource,
  profile,
  sourceEntry,
} from '@platform/database/schema';
import { getDb } from '@contexts/identity-access';
import {
  loadAvailableMediaIdSet,
  loadBatchCatalogContext,
  type MediaType,
  type CatalogCandidateRow,
} from '@contexts/policy';

/**
 * EPG 节目指南服务(T042;US4,只读;T071 增手动绑定优先):
 * - GET /media/{mediaId}/programmes 的编排(T044 由 catalog 控制器消费,纯函数模块,
 *   对齐 catalog/policy 惯例;数据访问经 auth/db 共享 SQLite 单例):
 *   1) 授权管线与详情完全一致(loadBatchCatalogContext:会话/设备/档案 → 最新策略 →
 *      家庭真实资源 → evaluatePolicy;不复制判定规则),未命中 → 统一同形 404 NOT_FOUND
 *      (不存在/跨家庭/不可见/不可用不区分),随后要求 type=channel,否则 400 VALIDATION_FAILED;
 *   2) 绑定解析优先级(T071;data-model「0004 增补」):manual 有效 → 只用 manual 目标;
 *      manual 失效(源禁用/频道缺失/冲突)→ 200 unavailable 且不回退自动/其他 EPG;
 *      无行或 auto 墓碑 → 沿用 FR-007 自动精确匹配;绑定行与目标指南在同一同步读取
 *      快照内取得(better-sqlite3 同步执行,查询间无并发写穿插),模式与指南不混代;
 *      手动配置的存在不改变授权链的频道可用性判定;
 *   3) 自动关联解析(data-model epg_channel 节/research R6):该频道 present 条目所属 IPTV 来源
 *      (enabled)→ 其 epg_source_id(同家庭存在;IPTV 或 EPG 来源禁用视为无关联,跳过)→
 *      epg_channel 以 upstream_channel_id 精确匹配(SQLite BINARY 相等,不合并不模糊猜测);
 *      多个有效来源共享同一媒体时按 source_id 升序取第一个「有效且精确匹配且
 *      conflicted=0」的关联,conflicted/无匹配者跳过;
 *   4) 窗口判定(UTC):current 满足 startsAt≤now<endsAt(起点含、终点不含);
 *      next 为未来 startsAt 最早的一条(与 current 互斥,正在播出的不是 next);
 *      关联胜出但指南无当前/未来节目(过期 EPG,research R6)同样降级 unavailable。
 * - 降级契约(contracts/api.md):未关联/EPG 禁用/标识冲突/tvg 无匹配/manual 失效/无有效节目 →
 *   200 {status:'unavailable', current:null, next:null},绝不 404/500;
 * - DTO 仅契约字段(Programme{title,description,startsAt,endsAt}),时间为显式 UTC ISO
 *   (存储即 UTC ISO 文本,字符串序即时间序);不返回来源地址/路径/upstream 原始标识,
 *   普通节目响应不暴露管理候选或绑定目标(data-model「0004 增补」)。
 */

/** 胜出的指南关联:同家庭 EPG 来源 + 精确匹配且未冲突的 XMLTV 频道标识 */
interface EpgAssociation {
  epgSourceId: string;
  xmltvChannelId: string;
}

const UNAVAILABLE: ProgrammesDto = { status: 'unavailable', current: null, next: null };

function notFound(): DomainError {
  // 与详情一致:不存在/跨家庭/不可见/不可用统一同形,不泄漏存在性
  return new DomainError(404, ProblemCode.NOT_FOUND);
}

/**
 * 节目读取授权装载(T044 授权链 + T071 零档案兜底):
 * - 常规:loadBatchCatalogContext(会话/设备/当前档案 → 最新策略 → 家庭候选 → evaluatePolicy),
 *   不复制判定规则;有档案但未选择/失效 → 403 ACTIVE_PROFILE_REQUIRED(既有契约不变);
 * - 零档案兜底:家庭从未创建任何档案时,「当前观看者/ProfilePolicy」无从适用
 *   (FR-023「普通节目查询仍须当前 ProfilePolicy 放行」以存在当前档案为前提),
 *   按无政策放行 —— 真实可用(present 条目×启用来源×播放资源)媒体全部放行,
 *   不可用/不存在/跨家庭仍 404 同形;候选装载复用与批量上下文同一集合查询
 *   (loadAvailableMediaIdSet,无政策语义),兜底分支不引入第二套政策规则;
 *   会话/设备信任源先重验(与批量上下文同一判定),失效即维持原 403,兜底不放宽信任。
 */
function loadProgrammeReadContext(householdId: string, sessionId: string): { allowed: CatalogCandidateRow[] } {
  const db = getDb();
  try {
    return { allowed: loadBatchCatalogContext(db, { householdId, sessionId }).allowed };
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== ProblemCode.ACTIVE_PROFILE_REQUIRED) {
      throw error;
    }
    // 家庭存在档案(未选择/失效/损坏)→ 403 语义不变
    const anyProfile = db.select({ id: profile.id }).from(profile).where(eq(profile.householdId, householdId)).limit(1).get();
    if (anyProfile !== undefined) {
      throw error;
    }
    // 零档案:信任源先重验,不因兜底放宽(会话撤销/过期/换家庭/设备撤销 → 维持原 403)
    const session = db.select().from(deviceSession).where(eq(deviceSession.id, sessionId)).get();
    const deviceRow = session === undefined ? undefined : db.select().from(device).where(eq(device.id, session.deviceId)).get();
    if (
      session === undefined ||
      session.revokedAt !== null ||
      !(Date.parse(session.expiresAt) > Date.now()) ||
      session.householdId !== householdId ||
      deviceRow === undefined ||
      deviceRow.revokedAt !== null
    ) {
      throw error;
    }
    // 无政策放行:可用性集合判定与批量上下文逐 id 等价(available=false 不放行 → 404 同形)
    const mediaRows = db
      .select({
        id: mediaItem.id,
        type: mediaItem.type,
        title: mediaItem.title,
        description: mediaItem.description,
        contentLevel: mediaItem.contentLevel,
        version: mediaItem.version,
      })
      .from(mediaItem)
      .where(eq(mediaItem.householdId, householdId))
      .all();
    const availableIds = loadAvailableMediaIdSet(db, householdId);
    return {
      allowed: mediaRows
        .filter((row) => availableIds.has(row.id))
        .map((row) => ({
          id: row.id,
          type: row.type as MediaType,
          title: row.title,
          description: row.description,
          contentLevel: row.contentLevel,
          version: row.version,
          available: true,
        })),
    };
  }
}

/**
 * 关联解析:source_id 升序扫描该媒体的 present 条目所属 IPTV 来源链;
 * 任一来源产出「有效(链路两端均启用)+ 精确匹配 + 不冲突」关联即胜出,否则 null。
 */
function resolveEpgAssociation(householdId: string, mediaId: string): EpgAssociation | null {
  const db = getDb();
  const entries = db
    .select({ sourceId: sourceEntry.sourceId, upstreamChannelId: sourceEntry.upstreamChannelId })
    .from(sourceEntry)
    .where(and(eq(sourceEntry.householdId, householdId), eq(sourceEntry.mediaId, mediaId), eq(sourceEntry.present, 1)))
    .all();
  const sourceIds = [...new Set(entries.map((entry) => entry.sourceId))].sort();
  for (const sourceId of sourceIds) {
    const iptv = db
      .select()
      .from(mediaSource)
      .where(and(eq(mediaSource.householdId, householdId), eq(mediaSource.id, sourceId)))
      .get();
    // IPTV 来源须启用;禁用来源视为无关联(不可用媒体的指南不因断源泄漏)
    if (iptv === undefined || iptv.kind !== 'iptv' || iptv.enabled !== 1 || iptv.epgSourceId === null) {
      continue;
    }
    const epg = db
      .select()
      .from(mediaSource)
      .where(and(eq(mediaSource.householdId, householdId), eq(mediaSource.id, iptv.epgSourceId)))
      .get();
    // EPG 目标须存在同家庭且启用(允许关联暂时禁用 EPG,但观看时无节目 → 跳过该关联)
    if (epg === undefined || epg.kind !== 'epg' || epg.enabled !== 1) {
      continue;
    }
    const upstreamIds = [
      ...new Set(
        entries
          .filter((entry) => entry.sourceId === sourceId && entry.upstreamChannelId !== null)
          .map((entry) => entry.upstreamChannelId as string),
      ),
    ].sort();
    for (const upstreamId of upstreamIds) {
      const channel = db
        .select({ conflicted: epgChannel.conflicted })
        .from(epgChannel)
        .where(
          and(
            eq(epgChannel.householdId, householdId),
            eq(epgChannel.sourceId, iptv.epgSourceId),
            eq(epgChannel.xmltvChannelId, upstreamId),
          ),
        )
        .get();
      // 精确匹配且未冲突才胜出;冲突/无匹配跳过(不合并、不猜测)
      if (channel !== undefined && channel.conflicted === 0) {
        return { epgSourceId: iptv.epgSourceId, xmltvChannelId: upstreamId };
      }
    }
  }
  return null;
}

/**
 * 手动绑定优先解析(T071;data-model「0004 增补」读取状态派生):
 * - 无行或 auto 墓碑(mode!=='manual')→ null:不代表手动配置,节目匹配沿用 FR-007;
 * - manual:目标源禁用/行缺失 → 失效(source_disabled 同因,来源侧不可用),
 *   目标频道在该源缺失 → channel_missing,conflicted=1 → channel_conflict;
 * - manual 有效 → 返回 manual 目标(节目查询只用它,不叠加/不比较自动匹配)。
 * 失效一律以 'invalid' 标记返回(具体原因属管理读取 getBindingState,普通节目响应不暴露)。
 */
function resolveManualOverride(householdId: string, mediaId: string): EpgAssociation | 'invalid' | null {
  const db = getDb();
  const row = db
    .select({
      mode: manualEpgBinding.mode,
      epgSourceId: manualEpgBinding.epgSourceId,
      xmltvChannelId: manualEpgBinding.xmltvChannelId,
    })
    .from(manualEpgBinding)
    .where(and(eq(manualEpgBinding.householdId, householdId), eq(manualEpgBinding.mediaId, mediaId)))
    .get();
  // 无行/auto 墓碑:目标两列为 null,无手动语义可施加
  if (row === undefined || row.mode !== 'manual' || row.epgSourceId === null || row.xmltvChannelId === null) {
    return null;
  }
  const source = db
    .select({ enabled: mediaSource.enabled })
    .from(mediaSource)
    .where(and(eq(mediaSource.householdId, householdId), eq(mediaSource.id, row.epgSourceId)))
    .get();
  // 来源侧不可用(禁用;无硬删除,行缺失仅剩防御路径)→ invalid,不回退自动
  if (source === undefined || source.enabled !== 1) {
    return 'invalid';
  }
  const channel = db
    .select({ conflicted: epgChannel.conflicted })
    .from(epgChannel)
    .where(
      and(
        eq(epgChannel.householdId, householdId),
        eq(epgChannel.sourceId, row.epgSourceId),
        eq(epgChannel.xmltvChannelId, row.xmltvChannelId),
      ),
    )
    .get();
  // 目标频道缺失/冲突 → invalid,不回退(失效是配置事实,不是可绕过的临时状态)
  if (channel === undefined || channel.conflicted !== 0) {
    return 'invalid';
  }
  return { epgSourceId: row.epgSourceId, xmltvChannelId: row.xmltvChannelId };
}

function toProgrammeDto(row: Pick<typeof epgProgramme.$inferSelect, 'title' | 'description' | 'startsAt' | 'endsAt'>): ProgrammeDto {
  return {
    title: row.title,
    description: row.description,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
  };
}

/** GET /media/{mediaId}/programmes 编排(先授权,再要求频道,再解析关联与窗口) */
export function getMediaProgrammes(context: SessionContext, mediaId: string): ProgrammesDto {
  const householdId = context.session.householdId;
  // 1) 与详情同一授权管线与判定顺序(批量上下文,不复制规则;零档案家庭走兜底,见上)
  const catalog = loadProgrammeReadContext(householdId, context.session.id);
  const hit = catalog.allowed.find((candidate) => candidate.id === mediaId);
  if (hit === undefined) {
    throw notFound();
  }
  // 2) 仅频道提供节目指南;非频道 → 400(授权已通过,区别于 404)
  if (hit.type !== 'channel') {
    throw new DomainError(400, ProblemCode.VALIDATION_FAILED, '仅频道条目提供节目指南');
  }
  // 3) 绑定解析(T071 手动优先,data-model「0004 增补」):manual 有效 → 只用 manual 目标;
  //    invalid → 200 unavailable 且不回退自动/其他 EPG;无行/auto 墓碑 → 沿用 FR-007。
  //    绑定行与目标指南在同一同步读取快照内取得(同步执行,查询间无并发写穿插),
  //    模式与指南不混代;手动配置的存在不改变授权链的频道可用性判定。
  const manual = resolveManualOverride(householdId, mediaId);
  if (manual === 'invalid') {
    return UNAVAILABLE;
  }
  // 4) 自动关联解析失败(未关联/禁用/冲突/无匹配)→ 契约降级,非错误
  const association = manual ?? resolveEpgAssociation(householdId, mediaId);
  if (association === null) {
    return UNAVAILABLE;
  }
  // 5) 窗口判定:startsAt 升序扫描,首个命中区间即 current、首个未来开始即 next
  const rows = getDb()
    .select({
      title: epgProgramme.title,
      description: epgProgramme.description,
      startsAt: epgProgramme.startsAt,
      endsAt: epgProgramme.endsAt,
    })
    .from(epgProgramme)
    .where(
      and(
        eq(epgProgramme.householdId, householdId),
        eq(epgProgramme.sourceId, association.epgSourceId),
        eq(epgProgramme.xmltvChannelId, association.xmltvChannelId),
      ),
    )
    .orderBy(epgProgramme.startsAt)
    .all();
  const now = Date.now();
  let current: ProgrammeDto | null = null;
  let next: ProgrammeDto | null = null;
  for (const row of rows) {
    const startsAtMs = Date.parse(row.startsAt);
    const endsAtMs = Date.parse(row.endsAt);
    if (current === null && startsAtMs <= now && now < endsAtMs) {
      current = toProgrammeDto(row);
      continue;
    }
    if (next === null && startsAtMs > now) {
      next = toProgrammeDto(row);
      break; // startsAt 升序:首个未来开始即最早 next
    }
  }
  // 关联有效但无当前/未来节目(过期 EPG)同样降级 unavailable(research R6)
  if (current === null && next === null) {
    return UNAVAILABLE;
  }
  return { status: 'available', current, next };
}
