import { Inject, Injectable } from '@nestjs/common';
import { ProblemCode, type PublicContextDto, type PublicMediaDto, type PublicMediaPageDto } from '@hmp/shared';
import type { Vod } from '@hmp/shared';
import { PublicContextService } from '@platform/http-common/public-context/public-context.service';
import { DomainError } from '@platform/http-common/domain-error';
import { loadAvailableMediaIdSet } from '@contexts/policy';
import {
  mediaCatalogStore,
  type PublicCatalogSourceRow,
  type VodEpisodePageRow,
} from '@contexts/media-catalog/application/media-catalog-store.port';
import { toPublicMedia, type PublicMediaRow } from '@contexts/media-catalog/domain/public-media-projection';

/**
 * 公共目录服务(T023/T024/T025,005 contracts/api.md §1/§2、research R1):
 * - 家庭范围一律 PublicContextService.requireScope() 服务端确定(零家庭 → 未初始化形态、
 *   多家庭配置损坏/存储不可读 → 503),不读取任何请求身份声明;
 * - 目录/详情只含本家庭可用内容(available = present 条目 × 启用来源 × 播放资源,
 *   复用 loadAvailableMediaIdSet 同一谓词,不复制可用性规则),不执行 ProfilePolicy
 *   过滤(FR-002:浏览与策略无关,元数据对游客完全可见);
 * - 未执行 ProfilePolicy ≠ 授权下放:公共投影无 canPlay/策略结果字段,浏览 ≠ 可播放;
 * - 排序与既有观看目录同语义:UTF-8 字节序 title 升序、同题按 id 升序(稳定);
 * - DTO 一律经 public-media-projection 白名单出口,绝无源地址/来源凭据/播放票据。
 *
 * 010 T030(在线点播 US1,api.md §2、data-model §2):
 * - vod 只展示「已物化且可用父项」(父可浏览=至少一个已发布子项 × 启用来源 × 完整根
 *   locator,经 store.loadVodBrowsableParentIds 单查询),父项媒体卡片不重复铺子项,
 *   子项卡片只经 /public/media/:id/episodes 分页分集呈现;
 * - detailKind/parentMediaId 为 010 加字段扩展:media_role 即 detailKind 词汇,
 *   standalone 行保持 005 投影逐字段零变化(NAS/IPTV 行为零变化),vod 行才追加;
 * - 「父不进入可播放候选集合」:候选树=子项层 —— 父项无 source_entry/playback 链,
 *   在 loadAvailableMediaIdSet/策略候选集内恒不可用(可用性先于策略),绝不进 allowed;
 * - GET /public/media/:id/episodes 编排:非父(可见)400 VOD_EPISODE_REQUIRED、
 *   不存在/跨家庭/父不可用 404 同形、修订绑定 cursor 重放稳定、详情变化 409
 *   VOD_DETAIL_CHANGED、每页总计 100 子项、线路按 lineRef 聚合可跨页重复;
 * - 不可用 404 与子项可解析候选集合分开:分集行 availability=candidate 表达
 *   「可解析播放候选」,unavailable 仅摘要保留(浏览 ≠ 可播放)。
 *
 * 008-repository-extraction(T010,ADR-0015 D1):Database.db.prepare 原生查询逐字
 * 移入仓储实现(infrastructure/media-catalog-store.drizzle.ts),本服务经
 * media-catalog 仓储端口访问,调用形态与返回形态均不变。
 */

/** 未初始化部署的默认展示值(与初始化向导 InitializeRequest 缺省一致,data-model §9) */
const UNINITIALIZED_DISPLAY = {
  language: 'zh-CN',
  timezone: 'Asia/Shanghai',
} as const;

/** 010 StableEpisodes 契约类型(共享生成产物统一经 Vod 命名空间入口取用) */
type StableEpisodesDto = Vod.components['schemas']['StableEpisodes'];
type StableEpisodeLineDto = Vod.components['schemas']['StableEpisodeLine'];

/** 分集分页:每页总计 100 子项(api.md §2;跨线路合计,单页线路数不封顶) */
const EPISODES_PAGE_SIZE = 100;

/** 分集分页 cursor 载荷(修订绑定:offset + 父绑定 + 修订指纹;opaque,不携带上游语义) */
interface EpisodesCursorPayload {
  /** 编码版本(解码校验;不支持静默升级旧形态) */
  v: 1;
  /** 绑定的父媒体 ID(跨父重放即非法 cursor) */
  p: string;
  /** 已消费子项数(下一页起始 offset;整数 0..上限) */
  o: number;
  /** 修订指纹(签发时 vod_title.current_detail_revision;漂移即 409) */
  r: number;
}

const EPISODES_CURSOR_VERSION = 1;
/** offset 合理上界(单标题预算:20 线 × 2000 子项;防伪造 cursor 巨页切片) */
const EPISODES_CURSOR_MAX_OFFSET = 40_000;

/** 稳定排序(与 catalog.service.compareTitleBinaryThenId 同语义):UTF-8 字节序 title,同题 id */
function compareTitleBinaryThenId(a: PublicMediaRow, b: PublicMediaRow): number {
  const byTitle = Buffer.compare(Buffer.from(a.title, 'utf8'), Buffer.from(b.title, 'utf8'));
  if (byTitle !== 0) {
    return byTitle;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 不存在/跨家庭/不可用统一同形 404,不泄露存在性 */
function notFound(): DomainError {
  return new DomainError(404, ProblemCode.NOT_FOUND);
}

/**
 * 010 投影出口:media_role 即 detailKind,仅 vod 行追加 detailKind/parentMediaId;
 * standalone 行原样返回 005 投影(NAS/IPTV 响应零变化,既有七键逐字保持)。
 */
function toPublicMediaWithDetailKind(row: PublicCatalogSourceRow & PublicMediaRow): PublicMediaDto {
  const dto = toPublicMedia(row);
  if (row.mediaRole === 'standalone') {
    return dto;
  }
  return {
    ...dto,
    detailKind: row.mediaRole as NonNullable<PublicMediaDto['detailKind']>,
    // vod_title 父项 parentMediaId=null(LEFT JOIN 仅对子项命中);子项为父标题媒体 ID
    parentMediaId: row.mediaRole === 'vod_episode' ? row.parentMediaId : null,
  };
}

/** 分集 cursor 编码:base64url(JSON);载荷不含上游/地址语义(opaque) */
function encodeEpisodesCursor(payload: EpisodesCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** 分集 cursor 解码:形态非法(无法解析/版本不符/类型越界)→ undefined(调用方 400) */
function decodeEpisodesCursor(cursor: string): EpisodesCursorPayload | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const candidate = raw as Record<string, unknown>;
  if (
    candidate['v'] !== EPISODES_CURSOR_VERSION ||
    typeof candidate['p'] !== 'string' ||
    candidate['p'] === '' ||
    typeof candidate['o'] !== 'number' ||
    !Number.isInteger(candidate['o']) ||
    candidate['o'] < 0 ||
    candidate['o'] > EPISODES_CURSOR_MAX_OFFSET ||
    typeof candidate['r'] !== 'number' ||
    !Number.isInteger(candidate['r']) ||
    candidate['r'] < 1
  ) {
    return undefined;
  }
  return { v: EPISODES_CURSOR_VERSION, p: candidate['p'], o: candidate['o'], r: candidate['r'] };
}

/** 页内子项按线路聚合(保持全序;lineRef=vod_line.id,跨页重复由消费者按其聚合) */
function groupEpisodeLines(pageRows: readonly VodEpisodePageRow[]): StableEpisodesDto['lines'] {
  const lines: StableEpisodeLineDto[] = [];
  const byLineRef = new Map<string, StableEpisodeLineDto>();
  for (const row of pageRows) {
    let line = byLineRef.get(row.lineId);
    if (line === undefined) {
      line = { lineRef: row.lineId, name: row.lineName, episodes: [] };
      byLineRef.set(row.lineId, line);
      lines.push(line);
    }
    line.episodes.push({
      mediaId: row.mediaId,
      label: row.label,
      // candidate=子可解析候选(present×enabled×资源);unavailable 仅摘要,浏览≠可播放
      availability: row.resolvable ? 'candidate' : 'unavailable',
      sequenceOrdinal: row.sequenceOrdinal,
    });
  }
  return lines;
}

@Injectable()
export class PublicCatalogService {
  // @Inject 显式声明依赖(esbuild/tsx 运行时不发射 design:paramtypes,仓库既有惯例)
  constructor(
    @Inject(PublicContextService) private readonly publicContext: PublicContextService,
  ) {}

  /** GET /public/context:PublicContext 白名单投影(T023;未初始化返回默认展示值) */
  getContext(): PublicContextDto {
    const scope = this.publicContext.requireScope();
    const now = new Date().toISOString();
    if (!scope.initialized) {
      return {
        initialized: false,
        displayName: null,
        language: UNINITIALIZED_DISPLAY.language,
        timezone: UNINITIALIZED_DISPLAY.timezone,
        now,
        catalogRevision: 1,
      };
    }
    const { household } = scope;
    const revisionRow = mediaCatalogStore().findCatalogRevision(household.householdId);
    return {
      initialized: true,
      displayName: household.displayName,
      language: household.language,
      timezone: household.timezone,
      now,
      catalogRevision: revisionRow?.revision ?? 1,
    };
  }

  /**
   * GET /public/media:公共目录列表(T024;010 行为扩展)——
   * q(字面包含,管道已限 <=100)/type 筛选只影响搜索不扩大范围;
   * 仅可用内容进入目录:standalone(NAS/IPTV)沿用既有可用集合;vod 父项按
   * 「已物化+父级可用」集合准入;vod 子项一律不铺(父卡/分集接口呈现)。
   * 未初始化部署:无家庭即无内容 → 空页(不泄露存储形态)。
   */
  listMedia(query: PublicMediaListQuery): PublicMediaPageDto {
    const scope = this.publicContext.requireScope();
    if (!scope.initialized) {
      return { items: [], page: query.page, pageSize: query.pageSize, total: 0 };
    }
    const householdId = scope.household.householdId;
    const availableIds = loadAvailableMediaIdSet(householdId);
    const browsableParents = mediaCatalogStore().loadVodBrowsableParentIds(householdId);
    const rows = mediaCatalogStore().listPublicCatalogRows(householdId);
    const availableRows: Array<PublicCatalogSourceRow & PublicMediaRow> = [];
    for (const row of rows) {
      // 父不铺子:「子项卡片」不进列表,稳定子项只经详情/分集接口呈现
      if (row.mediaRole === 'vod_episode') {
        continue;
      }
      if (row.mediaRole === 'vod_title') {
        // vod 只展示已物化且可用父项(父可浏览链;与子可解析候选集合分开)
        if (!browsableParents.has(row.id)) {
          continue;
        }
      } else if (!availableIds.has(row.id)) {
        continue; // standalone(NAS/IPTV)既有准入不变:只有可用资源进入目录
      }
      if (query.type !== undefined && row.type !== query.type) {
        continue;
      }
      const needle = (query.q ?? '').trim().toLowerCase();
      if (needle !== '' && !row.title.toLowerCase().includes(needle)) {
        continue; // 字面包含;q/%/_ 无通配符语义(不经 SQL LIKE)
      }
      // 进目录者即可用(上方集合判定);补投影标志,避免行缺 available 字段被误标 unavailable
      availableRows.push({ ...row, available: true });
    }
    availableRows.sort(compareTitleBinaryThenId);
    const total = availableRows.length;
    const start = (query.page - 1) * query.pageSize;
    return {
      items: availableRows.slice(start, start + query.pageSize).map(toPublicMediaWithDetailKind),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  /**
   * GET /public/media/{mediaId}:公共详情(T025;010 扩展)——
   * 与列表同一可用集合判定(父项走父可浏览链,子项/standalone 走可解析候选链);
   * 不存在/跨家庭/不可用统一同形 404;白名单投影,无个人状态、无播放 URL 或票据。
   */
  getMedia(mediaId: string): PublicMediaDto {
    const scope = this.publicContext.requireScope();
    if (!scope.initialized) {
      throw notFound();
    }
    const householdId = scope.household.householdId;
    const row = mediaCatalogStore().findPublicCatalogRowById(householdId, mediaId);
    if (row === undefined) {
      throw notFound();
    }
    if (row.mediaRole === 'vod_title') {
      if (!mediaCatalogStore().loadVodBrowsableParentIds(householdId).has(mediaId)) {
        throw notFound(); // 未物化/不可用父项与不存在同形
      }
    } else if (!availableIdsOf(householdId).has(mediaId)) {
      throw notFound(); // standalone/vod_episode 同一「可解析候选」可见性链
    }
    return toPublicMediaWithDetailKind({ ...row, available: true });
  }

  /**
   * GET /public/media/{mediaId}/episodes 编排(010 T030;T031 装配路由)——
   * - 非父媒体(standalone/vod_episode):可见者 400 VOD_EPISODE_REQUIRED(类别错),
   *   不可见者 404 同形(不泄露存在性;可用性/可见性先于专用错误);
   * - vod 父项:稳定映射缺失/父不可用 404 同形;
   * - 修订绑定 cursor:解码非法/跨父 400;签发修订 ≠ 当前修订 409 VOD_DETAIL_CHANGED
   *   (重读并明确重选,不静默续页);无 cursor = 第一页;
   * - 每页总计 100 子项;分集全量单查询 + 内存切片/线路分组(禁 N+1);
   *   nextCursor 取尽为 null;页序全序确定 → 同 cursor 重放逐字段稳定;
   * - stale 恒 false:本读面消费已发布稳定层(稳定详情失败回退属预览/物化链职责)。
   */
  listEpisodes(mediaId: string, cursor?: string): StableEpisodesDto {
    const scope = this.publicContext.requireScope();
    if (!scope.initialized) {
      throw notFound();
    }
    const householdId = scope.household.householdId;
    const store = mediaCatalogStore();
    const row = store.findPublicCatalogRowById(householdId, mediaId);
    if (row === undefined) {
      throw notFound();
    }
    if (row.mediaRole !== 'vod_title') {
      // 非父:不可见/不存在 404 同形;可见非父(含 vod_episode 子项)为类别错 400
      if (!availableIdsOf(householdId).has(mediaId)) {
        throw notFound();
      }
      throw new DomainError(400, ProblemCode.VOD_EPISODE_REQUIRED);
    }
    const facet = store.findVodParentFacet(householdId, mediaId);
    if (facet === undefined || !facet.browsable) {
      throw notFound(); // 稳定映射缺失/不可用父项与不存在同形
    }
    let offset = 0;
    if (cursor !== undefined && cursor !== '') {
      const payload = decodeEpisodesCursor(cursor);
      if (payload === undefined || payload.p !== mediaId) {
        throw new DomainError(400, ProblemCode.VALIDATION_FAILED, 'episodes cursor 形态非法或不匹配该媒体');
      }
      if (payload.r !== facet.detailRevision) {
        // 修订绑定:详情变化后旧 cursor 一律 409,重读重选,不静默续页
        throw new DomainError(409, ProblemCode.VOD_DETAIL_CHANGED);
      }
      offset = payload.o;
    }
    const allRows = store.listVodEpisodePageRows(householdId, mediaId, facet.detailRevision);
    const pageRows = allRows.slice(offset, offset + EPISODES_PAGE_SIZE);
    const nextCursor =
      offset + EPISODES_PAGE_SIZE < allRows.length
        ? encodeEpisodesCursor({
            v: EPISODES_CURSOR_VERSION,
            p: mediaId,
            o: offset + EPISODES_PAGE_SIZE,
            r: facet.detailRevision,
          })
        : null;
    return {
      parentMediaId: mediaId,
      detailRevision: facet.detailRevision,
      // 当前修订快照 fetched_at;快照行缺失回退物化时间(不伪造墙钟)
      fetchedAt: facet.snapshotFetchedAt ?? facet.materializedAt,
      stale: false,
      lines: groupEpisodeLines(pageRows),
      nextCursor,
    };
  }
}

/** 「子可解析候选」可见性链(standalone 与 vod_episode 同一集合;复用 policy 等价下推查询) */
function availableIdsOf(householdId: string): Set<string> {
  return loadAvailableMediaIdSet(householdId);
}

/** GET /public/media 查询形态(管道已严格校验;此处为服务层契约类型) */
export interface PublicMediaListQuery {
  readonly q?: string;
  readonly type?: PublicMediaDto['type'];
  readonly page: number;
  readonly pageSize: number;
}
