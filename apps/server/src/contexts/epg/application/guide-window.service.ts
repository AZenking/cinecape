import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ExperienceProgrammeDto, GuideWindowDto } from '@hmp/shared';
import { ProblemCode } from '@hmp/shared';
import { DomainError } from '../../../common/domain-error';
import { getDb } from '../../../modules/auth/db';
import { epgProgramme } from '../../../database/schema';
import { resolveGuideDayWindow } from '@contexts/epg/domain/guide-calendar';
import { GuideDateExpiredProblem } from '@contexts/epg/domain/guide-problems';
import { readCatalogRevision } from '@contexts/epg/infrastructure/catalog-revision.service';
import { loadChannelAssociations, type ChannelMetaRow } from '@contexts/epg/domain/binding-core';
import { programmeKeyOf } from '@contexts/epg/domain/programme-key.mapper';

/**
 * 公共 guide 窗口查询服务(T113/T115;data-model.md §8 逐字、contracts/api.md §2、research R8):
 *
 * 「先集合计算媒体可用性及手动/自动绑定映射,再批量取 programme 窗口,不在循环调用
 *   单频道授权服务」;guide 数据装配固定 8 次集合查询:
 *   1 频道 + 1 可用性 + 1 source_entry + 1 media_source + 1 manual_epg_binding +
 *   1 epg_channel(关联核心,与 live 投影共用同一实现)+
 *   1 批量 programme 窗口(整页一次,按关联对过滤)+ 1 catalog revision。
 *   (家庭 timezone 由 PublicContextService 的既有单查询随 scope 提供,不重复读取。)
 *
 * 「导入排期本身 UTC 保存,查询交叠条件 starts_at < to AND ends_at > from;
 *   请求 date 必须在允许范围内,from/to 必须在该日真实边界且 to>from(跨度上限即
 *   该日真实日长,普通日 24 小时)」;
 * 「一次响应最多 2000 节目/2 MiB,超限 422 GUIDE_WINDOW_TOO_LARGE,返回建议减少
 *   频道页,不静默截断」—— 节目数以 `LIMIT 2001` 有界查询探测,负载以完整响应序列化字节计量,
 *   两者超限一律抛 422,绝不返回截断数据。
 * 「每页最多 50 频道、默认 20;页面可分页遍历所有频道,包括无节目频道」——
 *   频道全集 = 家庭可用频道(不因无 EPG/关联失效隐藏),按名称+稳定标识排序后分页。
 *
 * 同步快照:better-sqlite3 同步驱动,nowMs 由调用方冻结传入;catalog revision 在同一
 * 同步块内读取,响应内 now/timezone/revision 同源。
 */

/** 一次响应最多返回的节目条数(data-model §8) */
export const GUIDE_MAX_PROGRAMMES = 2000;

/** 一次响应负载上限(2 MiB,完整 JSON 序列化字节) */
export const GUIDE_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

/** 频道分页默认/上限(data-model §8「每页最多 50 频道、默认 20」) */
export const GUIDE_DEFAULT_PAGE_SIZE = 20;
export const GUIDE_MAX_PAGE_SIZE = 50;

export interface GuideWindowRequest {
  readonly nowMs: number;
  /** 家庭 IANA 时区(调用方自 PublicContext scope 取得,同请求同源) */
  readonly timezone: string;
  /** 'YYYY-MM-DD';缺省 = 家庭今天 */
  readonly date?: string;
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly page?: number;
  readonly pageSize?: number;
}

interface ProgrammeRowRaw {
  id: string;
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string;
}

function toProgrammeDto(row: ProgrammeRowRaw): ExperienceProgrammeDto {
  return {
    key: programmeKeyOf(row.id),
    title: row.title,
    description: row.description,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
  };
}

/** 频道名称 + 稳定标识排序(与 live 投影一致;重复运行结果稳定) */
function byTitleThenId(left: ChannelMetaRow, right: ChannelMetaRow): number {
  if (left.title !== right.title) {
    return left.title < right.title ? -1 : 1;
  }
  if (left.id !== right.id) {
    return left.id < right.id ? -1 : 1;
  }
  return 0;
}

/**
 * 加载一页 GuideWindow(纯读取,无策略语义;校验失败抛 409/400/422 领域错误)。
 * 409 携带 allowedDates(GuideDateExpiredProblem);400 用 DomainError VALIDATION_FAILED;
 * 422 用 DomainError GUIDE_WINDOW_TOO_LARGE(注册表默认脱敏文案)。
 */
export function loadGuideWindow(householdId: string, request: GuideWindowRequest): GuideWindowDto {
  const { nowMs, timezone } = request;

  // 1) 日期与窗口解析(纯校验:409/400/422 语义来源)
  const resolved = resolveGuideDayWindow({
    nowMs,
    timezone,
    date: request.date,
    fromMs: request.fromMs,
    toMs: request.toMs,
  });
  if (!resolved.ok) {
    switch (resolved.reason) {
      case 'expired':
        throw new GuideDateExpiredProblem(resolved.allowedDates);
      case 'beyond':
        throw new DomainError(400, ProblemCode.VALIDATION_FAILED, '请求日期尚未进入可浏览范围,请选择今天至未来 6 天内的日期');
      case 'inverted':
        throw new DomainError(400, ProblemCode.VALIDATION_FAILED, '查询窗口起止无效:to 必须晚于 from');
      case 'window':
        throw new DomainError(422, 'GUIDE_WINDOW_TOO_LARGE');
    }
  }
  const { date, allowedDates, window } = resolved;
  const fromIso = new Date(window.fromMs).toISOString();
  const toIso = new Date(window.toMs).toISOString();

  // 2) 频道全集:可用频道(含无节目频道),名称+稳定标识排序后分页(关联核心 6 次集合查询)
  const core = loadChannelAssociations(householdId);
  const availableChannels = core.channelRows.filter((row) => core.availableIds.has(row.id)).sort(byTitleThenId);
  const totalChannels = availableChannels.length;
  const pageSize = Math.min(
    Number.isInteger(request.pageSize) && (request.pageSize ?? 0) >= 1 ? (request.pageSize as number) : GUIDE_DEFAULT_PAGE_SIZE,
    GUIDE_MAX_PAGE_SIZE,
  );
  const page = Number.isInteger(request.page) && (request.page ?? 0) >= 1 ? (request.page as number) : 1;
  const pageChannels = availableChannels.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);

  // 3) 本页频道关联对 → 一次批量节目窗口查询(交叠条件 + LIMIT 2001 探测,不静默截断)
  const programmesByMedia = new Map<string, ExperienceProgrammeDto[]>();
  const pairByMedia = new Map<string, string>();
  for (const channel of pageChannels) {
    const pairKey = core.associationByMedia.get(channel.id);
    if (pairKey !== undefined && pairKey !== null) {
      pairByMedia.set(channel.id, pairKey);
    }
  }
  const pairKeys = [...new Set(pairByMedia.values())];
  if (pairKeys.length > 0) {
    const db = getDb();
    const pairExpression = sql`(${epgProgramme.sourceId} || char(0) || ${epgProgramme.xmltvChannelId})`;
    const rows = db
      .select({
        id: epgProgramme.id,
        source_id: epgProgramme.sourceId,
        xmltv_channel_id: epgProgramme.xmltvChannelId,
        title: epgProgramme.title,
        description: epgProgramme.description,
        starts_at: epgProgramme.startsAt,
        ends_at: epgProgramme.endsAt,
      })
      .from(epgProgramme)
      .where(
        and(
          eq(epgProgramme.householdId, householdId),
          sql`${epgProgramme.startsAt} < ${toIso}`,
          sql`${epgProgramme.endsAt} > ${fromIso}`,
          inArray(pairExpression, pairKeys),
        ),
      )
      .limit(GUIDE_MAX_PROGRAMMES + 1)
      .all();
    if (rows.length > GUIDE_MAX_PROGRAMMES) {
      // 超限 422:不静默截断(data-model §8;建议减少每页频道数)
      throw new DomainError(422, 'GUIDE_WINDOW_TOO_LARGE');
    }
    const rowsByPair = new Map<string, ProgrammeRowRaw[]>();
    for (const row of rows) {
      const key = `${row.source_id}\u0000${row.xmltv_channel_id}`;
      const list = rowsByPair.get(key);
      if (list === undefined) {
        rowsByPair.set(key, [row]);
      } else {
        list.push(row);
      }
    }
    for (const [mediaId, pairKey] of pairByMedia) {
      programmesByMedia.set(
        mediaId,
        (rowsByPair.get(pairKey) ?? [])
          .map(toProgrammeDto)
          .sort((left, right) =>
            left.startsAt !== right.startsAt ? (left.startsAt < right.startsAt ? -1 : 1) : left.key < right.key ? -1 : 1,
          ),
      );
    }
  }

  // 4) 组装响应(catalog revision 同一同步块读取;公共字段白名单,无来源/XMLTV/个人数据)
  const response: GuideWindowDto = {
    date,
    timezone,
    now: new Date(nowMs).toISOString(),
    allowedDates: [...allowedDates],
    from: fromIso,
    to: toIso,
    page,
    pageSize,
    totalChannels,
    catalogRevision: readCatalogRevision(householdId),
    channels: pageChannels.map((channel) => ({
      media: {
        id: channel.id,
        type: 'channel',
        title: channel.title,
        description: channel.description,
        posterRef: channel.posterRef,
        contentLevel: channel.contentLevel,
        availability: 'available',
      },
      programmes: programmesByMedia.get(channel.id) ?? [],
    })),
  };

  // 5) 负载上限(2 MiB):完整序列化计量,超限 422 不静默截断
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > GUIDE_MAX_PAYLOAD_BYTES) {
    throw new DomainError(422, 'GUIDE_WINDOW_TOO_LARGE');
  }
  return response;
}
