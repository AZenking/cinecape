/**
 * 010 在线点播 Apple CMS JSON 上游确定性夹具(T005)。
 *
 * ⚠️ 顶部声明:本文件无任何真实凭据/密钥/令牌;全部地址均为合成占位
 *    (127.0.0.1 回环端口占位、RFC 5737 TEST-NET-1 192.0.2.0/24 文档保留段、
 *    RFC 6761 保留域 .example.test),仅供隔离测试使用,不发起任何真实网络请求。
 *
 * 零依赖声明:本文件不 import 任何模块(含 src 业务模块与外部运行时依赖),
 * 全部响应以纯数据/构造函数返回(JSON 对象或可序列化描述),为后续 mock http
 * 层提供稳定输入;各故事测试经由 fixture-world.ts 组合消费,也可单独引用。
 *
 * 覆盖面(与 tasks.md T005 一致):
 * - 3 个健康源 + 1 个必超时源(timeoutMs 可配置),每个源地址可配置;
 * - 三类影片世界:三集连续剧(同线明确 N+1)、缺集/重复编号剧集
 *   (重复编号 → unsupported/identity_ambiguous 场景)、同名版本冲突(年份/版本);
 * - HLS:相对地址清单(相对 master URI)、带 key URI 的清单、302 redirect 链、
 *   不同 duration 的媒体(含 duration 未知场景的清单形态,即无 #EXT-X-ENDLIST)。
 *
 * Apple CMS 线格式(v10 JSON):vod_play_from 以 `$$$` 分隔多线路;vod_play_url
 * 按 `$$$` 对应每线,集与集以 `#` 分隔,单集为 `名称$地址`。episodeKey/lineKey
 * 是夹具侧稳定键(非上游线格式字段),供测试断言映射与去重;上游线格式本身
 * 只承载 label+url,重复键/重复线路在 wire 上表现为重复段。
 */

/* ------------------------------------------------------------------ */
/* 固定时间基与占位常量                                                 */
/* ------------------------------------------------------------------ */

/** 夹具固定 nowMs:2026-01-01T00:00:00.000Z(与 test/fixtures/clock.ts 的
 *  MANUAL_CLOCK_DEFAULT_START_MS 一致,全部 vod_time/时间戳由此推导)。 */
export const FIXTURE_UPSTREAM_FIXED_NOW_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

/** 源默认超时毫秒(可按源配置覆盖;契约层上游总期限见 api.md,本值仅夹具缺省) */
export const FIXTURE_SOURCE_DEFAULT_TIMEOUT_MS = 8_000;

/** Apple CMS v10 JSON API 的标准提供路径 */
export const FIXTURE_UPSTREAM_DEFAULT_API_PATH = '/api.php/provide/vod/';

/** 占位 AES-128 key 物料(16 字节 ASCII 合成值,非真实密钥) */
export const FIXTURE_HLS_KEY_MATERIAL = 'fixture-key-16b!';

/** 占位 IV(16 字节递增序列) */
export const FIXTURE_HLS_KEY_IV_HEX = '0x000102030405060708090a0b0c0d0e0f';

/** 占位分片载荷(纯文本,长度确定性,供断言 content-length) */
export const FIXTURE_HLS_SEGMENT_BODY = 'fixture-segment-payload\n'.repeat(2);

/** 源行为:healthy=全部路由正常响应;timeout=全部路由永不响应 */
export type FixtureSourceBehavior = 'healthy' | 'timeout';

/** 源地址(host 可为回环/文档保留段 IP 或保留域;port 缺省 80) */
export interface FixtureSourceAddress {
  host: string;
  port?: number;
}

/* ------------------------------------------------------------------ */
/* Apple CMS 线格式类型                                                 */
/* ------------------------------------------------------------------ */

/** Apple CMS v10 JSON 单条影片(detail 形态;brief 形态播放字段为空串) */
export interface AppleCmsVodItem {
  vod_id: number;
  type_id: number;
  type_name: string;
  vod_name: string;
  vod_sub: string;
  vod_en: string;
  vod_letter: string;
  vod_remarks: string;
  vod_year: string;
  vod_area: string;
  vod_lang: string;
  vod_version: string;
  vod_actor: string;
  vod_director: string;
  vod_blurb: string;
  vod_content: string;
  vod_pubdate: string;
  vod_total: number;
  vod_serial: string;
  vod_time: string;
  vod_time_add: number;
  vod_play_from: string;
  vod_play_url: string;
  vod_play_note: string;
}

/** Apple CMS v10 JSON 列表信封(code=1 成功;limit 沿用上游字符串形态) */
export interface AppleCmsListDocument {
  code: number;
  msg: string;
  page: number;
  pagecount: number;
  limit: string;
  total: number;
  list: AppleCmsVodItem[];
}

/* ------------------------------------------------------------------ */
/* 结构化影片世界(种子 → wire)                                          */
/* ------------------------------------------------------------------ */

/** 序列状态(对齐 data-model vod_episode_sequence:ordered/ambiguous/special) */
export type FixtureSequenceStatus = 'ordered' | 'ambiguous' | 'special';

export interface FixtureEpisodeSeed {
  /** 夹具侧上游稳定键;重复键 → identity_ambiguous 场景(如 backup 线两个 '02') */
  episodeKey: string;
  /** 上游展示名(wire 上 `label$url` 的 label) */
  label: string;
  /** 本集清单入口绝对地址(redirect 链场景为链入口) */
  playlistUri: string;
  /** 年季键(如 'S01');缺省=上游未给季 */
  seasonKey?: string;
  /** 明确 N+1 序号;缺省/null=上游未给序号 */
  ordinal?: number | null;
  sequenceStatus?: FixtureSequenceStatus;
}

export interface FixtureLineSeed {
  /** 夹具侧线路键;重复 lineKey → 详情 unsupported 场景(线格式无法表达键,
   *  重复表现为两条 `$$$` 段,由 adapter 判定) */
  lineKey: string;
  displayName: string;
  sortOrder: number;
  episodes: readonly FixtureEpisodeSeed[];
}

export interface FixtureTitleSeed {
  /** 夹具内稳定引用键(非上游字段;policy/测试断言用) */
  titleKey: string;
  upstreamVodId: number;
  name: string;
  sub?: string;
  /** vod_en:检索词(ac=list&wd= 命中依据) */
  searchKeyword: string;
  year?: string;
  remarks?: string;
  area?: string;
  lang?: string;
  /** vod_version:剧场版/导演剪辑版(版本冲突世界) */
  versionLabel?: string;
  typeId?: number;
  typeName?: string;
  episodesTotal?: number;
  synopsis?: string;
  lines: readonly FixtureLineSeed[];
}

/** 影片世界 = 种子 + 已渲染 wire 条目 + 该片全部 HLS 呈现 */
export interface FixtureTitleWorld {
  titleKey: string;
  searchKeyword: string;
  seed: FixtureTitleSeed;
  /** detail 形态 wire 条目(ac=detail&ids= 返回) */
  item: AppleCmsVodItem;
  /** brief 形态 wire 条目(ac=list 返回,播放字段为空) */
  briefItem: AppleCmsVodItem;
  presentations: readonly FixtureHlsPresentation[];
}

export interface FixtureEpisodeWorldSeed {
  episodeKey: string;
  label: string;
  presentation: FixtureHlsPresentation;
  seasonKey?: string;
  ordinal?: number | null;
  sequenceStatus?: FixtureSequenceStatus;
}

export interface FixtureLineWorldSeed {
  lineKey: string;
  displayName: string;
  sortOrder: number;
  episodes: readonly FixtureEpisodeWorldSeed[];
}

export interface FixtureTitleWorldSpec {
  titleKey: string;
  searchKeyword: string;
  upstreamVodId: number;
  name: string;
  sub?: string;
  year?: string;
  remarks?: string;
  area?: string;
  lang?: string;
  versionLabel?: string;
  typeId?: number;
  typeName?: string;
  episodesTotal?: number;
  synopsis?: string;
  lines: readonly FixtureLineWorldSeed[];
}

/* ------------------------------------------------------------------ */
/* HLS 模型与文本渲染                                                   */
/* ------------------------------------------------------------------ */

export interface FixtureHlsKey {
  method: 'AES-128';
  /** 相对 media 清单的 key 地址(absoluteUris 时渲染为绝对地址) */
  uri: string;
  ivHex?: string;
}

export interface FixtureHlsSegment {
  /** 相对 media 清单的分片地址 */
  uri: string;
  durationSeconds: number;
  title?: string;
}

export interface FixtureHlsVariantSpec {
  name: string;
  bandwidth: number;
  resolution?: string;
  /** media 清单相对 master 的地址(如 'media/index.m3u8') */
  mediaPath: string;
}

export interface FixtureMasterVariant {
  uriRelativeToMaster: string;
  absoluteUri: string;
  bandwidth: number;
  resolution: string | null;
  name: string;
}

export interface FixtureRedirectHop {
  fromUri: string;
  toUri: string;
  status: 301 | 302 | 307;
}

export interface FixtureHlsMediaPlaylist {
  variantName: string;
  uriRelativeToMaster: string;
  absoluteUri: string;
  text: string;
  /** 绝对化后的分片地址(按声明顺序) */
  segmentUris: readonly string[];
  targetDurationSeconds: number;
  /** 汇总时长;endList=false(时长未知清单形态)时为 null */
  totalDurationSeconds: number | null;
}

export interface FixtureHlsPresentation {
  /** 世界内稳定引用键(如 'three-episode-serial:01') */
  presentationKey: string;
  episodeKey: string | null;
  /** 播放器起始地址(有 redirect 链时为链入口,否则为 master) */
  entryUri: string;
  masterUri: string;
  masterText: string;
  variants: readonly FixtureMasterVariant[];
  mediaPlaylists: readonly FixtureHlsMediaPlaylist[];
  key: FixtureHlsKey | null;
  redirectHops: readonly FixtureRedirectHop[];
  /** 全部媒体清单汇总时长一致时取该值;任一未知则 null */
  totalDurationSeconds: number | null;
  /** 本呈现全部路由(master/media/分片/key/redirect 跳) */
  routes: readonly FixtureUpstreamRoute[];
}

export interface FixtureHlsPresentationOptions {
  presentationKey: string;
  episodeKey?: string;
  /** 源 origin(如 'http://127.0.0.1:18081') */
  origin: string;
  /** 清单根路径(如 '/vod/hls/1001/ep-01') */
  rootPath: string;
  segments: readonly FixtureHlsSegment[];
  /** 缺省 = 各分片 duration 上取整最大值 */
  targetDurationSeconds?: number;
  key?: FixtureHlsKey;
  /** 缺省 true;false = 无 #EXT-X-ENDLIST(duration 未知清单形态) */
  endList?: boolean;
  /** 缺省单一 720p variant('media/index.m3u8') */
  variants?: readonly FixtureHlsVariantSpec[];
  /** true 时清单内全部 URI 渲染为绝对地址(相对形态的对照组) */
  absoluteUris?: boolean;
  /** ≥1 时 master 经 302 链到达(≤3,呼应 research R3 redirect 上限) */
  redirectHops?: number;
}

const DEFAULT_VARIANT: FixtureHlsVariantSpec = {
  name: '720p',
  bandwidth: 1_200_000,
  resolution: '1280x720',
  mediaPath: 'media/index.m3u8',
};

function resolveRelativeUri(baseUri: string, relative: string): string {
  if (/^https?:\/\//i.test(relative)) {
    return relative;
  }
  const dirEnd = baseUri.lastIndexOf('/');
  const baseDir = dirEnd >= 0 ? baseUri.slice(0, dirEnd) : baseUri;
  const parts = baseDir.split('/');
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      // 'http:','<空>','host' 三段为 origin,不可回退越过
      if (parts.length > 3) {
        parts.pop();
      }
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

function pathOfUri(uri: string): string {
  const schemeIndex = uri.indexOf('://');
  if (schemeIndex < 0) {
    return uri;
  }
  const pathStart = uri.indexOf('/', schemeIndex + 3);
  return pathStart >= 0 ? uri.slice(pathStart) : '/';
}

function renderMasterPlaylist(variants: readonly FixtureMasterVariant[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const variant of variants) {
    const attributes = [`BANDWIDTH=${variant.bandwidth}`];
    if (variant.resolution !== null) {
      attributes.push(`RESOLUTION=${variant.resolution}`);
    }
    attributes.push(`NAME="${variant.name}"`);
    lines.push(`#EXT-X-STREAM-INF:${attributes.join(',')}`, variant.uriRelativeToMaster);
  }
  return `${lines.join('\n')}\n`;
}

function renderMediaPlaylist(input: {
  segments: readonly FixtureHlsSegment[];
  renderedSegmentUris: readonly string[];
  targetDurationSeconds: number;
  key: FixtureHlsKey | null;
  renderedKeyUri: string | null;
  endList: boolean;
  mediaSequence?: number;
}): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${input.targetDurationSeconds}`];
  if (input.mediaSequence !== undefined) {
    lines.push(`#EXT-X-MEDIA-SEQUENCE:${input.mediaSequence}`);
  }
  if (input.key !== null && input.renderedKeyUri !== null) {
    const keyAttributes = [`METHOD=${input.key.method}`, `URI="${input.renderedKeyUri}"`];
    if (input.key.ivHex !== undefined) {
      keyAttributes.push(`IV=${input.key.ivHex}`);
    }
    lines.push(`#EXT-X-KEY:${keyAttributes.join(',')}`);
  }
  input.segments.forEach((segment, index) => {
    const renderedUri = input.renderedSegmentUris[index];
    if (renderedUri === undefined) {
      throw new Error(`夹具分片缺渲染地址: ${segment.uri}`);
    }
    lines.push(`#EXTINF:${segment.durationSeconds.toFixed(3)},`);
    lines.push(renderedUri);
  });
  if (input.endList) {
    lines.push('#EXT-X-ENDLIST');
  }
  return `${lines.join('\n')}\n`;
}

/** 构造一个确定性 HLS 呈现(master + media + 分片/key/redirect 全路由) */
export function createHlsPresentation(options: FixtureHlsPresentationOptions): FixtureHlsPresentation {
  const endList = options.endList ?? true;
  const absoluteUris = options.absoluteUris ?? false;
  const variantSpecs = options.variants ?? [DEFAULT_VARIANT];
  const maxSegmentDuration = Math.max(...options.segments.map((segment) => Math.ceil(segment.durationSeconds)));
  const targetDurationSeconds = options.targetDurationSeconds ?? maxSegmentDuration;
  const masterUri = `${options.origin}${options.rootPath}/master.m3u8`;
  const redirectCount = Math.max(0, Math.min(3, options.redirectHops ?? 0));

  const redirectHops: FixtureRedirectHop[] = [];
  for (let step = 1; step <= redirectCount; step += 1) {
    const fromUri = `${options.origin}/redirect${options.rootPath}/step-${step}`;
    const toUri = step < redirectCount
      ? `${options.origin}/redirect${options.rootPath}/step-${step + 1}`
      : masterUri;
    redirectHops.push({ fromUri, toUri, status: 302 });
  }
  const entryUri = redirectCount > 0 ? redirectHops[0]?.fromUri ?? masterUri : masterUri;

  const masterDir = `${options.origin}${options.rootPath}`;
  const variants: FixtureMasterVariant[] = variantSpecs.map((variant) => ({
    uriRelativeToMaster: variant.mediaPath,
    absoluteUri: resolveRelativeUri(`${masterDir}/master.m3u8`, variant.mediaPath),
    bandwidth: variant.bandwidth,
    resolution: variant.resolution ?? null,
    name: variant.name,
  }));
  const renderedVariantUris = variants.map((variant) =>
    absoluteUris ? variant.absoluteUri : variant.uriRelativeToMaster,
  );

  const masterText = renderMasterPlaylist(variants.map((variant, index) => ({
    ...variant,
    uriRelativeToMaster: renderedVariantUris[index] ?? variant.uriRelativeToMaster,
  })));

  const key = options.key ?? null;
  const routeByPath = new Map<string, FixtureUpstreamRoute>();
  const registerRoute = (uri: string, body: string, contentType: string): string => {
    const path = pathOfUri(uri);
    if (!routeByPath.has(path)) {
      routeByPath.set(path, {
        method: 'GET',
        path,
        response: {
          kind: 'response',
          status: 200,
          headers: { 'content-type': contentType, 'content-length': String(body.length) },
          body,
        },
      });
    }
    return path;
  };

  registerRoute(masterUri, masterText, 'application/vnd.apple.mpegurl');

  const mediaPlaylists: FixtureHlsMediaPlaylist[] = variantSpecs.map((variantSpec) => {
    const mediaRelative = variantSpec.mediaPath;
    const mediaAbsolute = resolveRelativeUri(`${masterUri}`, mediaRelative);
    const renderedSegmentUris = options.segments.map((segment) =>
      absoluteUris ? resolveRelativeUri(mediaAbsolute, segment.uri) : segment.uri,
    );
    const renderedKeyUri = key === null
      ? null
      : absoluteUris
        ? resolveRelativeUri(mediaAbsolute, key.uri)
        : key.uri;
    const text = renderMediaPlaylist({
      segments: options.segments,
      renderedSegmentUris,
      targetDurationSeconds,
      key,
      renderedKeyUri,
      endList,
    });
    registerRoute(mediaAbsolute, text, 'application/vnd.apple.mpegurl');
    options.segments.forEach((segment) => {
      registerRoute(resolveRelativeUri(mediaAbsolute, segment.uri), FIXTURE_HLS_SEGMENT_BODY, 'video/mp2t');
    });
    return {
      variantName: variantSpec.name,
      uriRelativeToMaster: mediaRelative,
      absoluteUri: mediaAbsolute,
      text,
      segmentUris: options.segments.map((segment) => resolveRelativeUri(mediaAbsolute, segment.uri)),
      targetDurationSeconds,
      totalDurationSeconds: endList
        ? options.segments.reduce((sum, segment) => sum + segment.durationSeconds, 0)
        : null,
    };
  });

  if (key !== null) {
    // key 地址相对首个 media 清单解析(与清单内渲染一致)
    const firstMedia = mediaPlaylists[0];
    const keyBaseUri = firstMedia?.absoluteUri ?? masterUri;
    registerRoute(resolveRelativeUri(keyBaseUri, key.uri), FIXTURE_HLS_KEY_MATERIAL, 'application/octet-stream');
  }

  for (const hop of redirectHops) {
    const path = pathOfUri(hop.fromUri);
    routeByPath.set(path, {
      method: 'GET',
      path,
      response: {
        kind: 'response',
        status: hop.status,
        headers: { location: hop.toUri },
        body: '',
      },
    });
  }

  const mediaTotals = new Set(mediaPlaylists.map((playlist) => playlist.totalDurationSeconds));
  const totalDurationSeconds = mediaTotals.size === 1 ? mediaPlaylists[0]?.totalDurationSeconds ?? null : null;

  return {
    presentationKey: options.presentationKey,
    episodeKey: options.episodeKey ?? null,
    entryUri,
    masterUri,
    masterText,
    variants,
    mediaPlaylists,
    key,
    redirectHops,
    totalDurationSeconds,
    routes: [...routeByPath.values()],
  };
}

/* ------------------------------------------------------------------ */
/* 路由表(mock http 层的稳定输入)                                       */
/* ------------------------------------------------------------------ */

export type FixtureUpstreamRouteResponse =
  | { kind: 'response'; status: number; headers: Record<string, string>; body: string }
  /** 永不响应;超时点由源 timeoutMs 决定(必超时源全部路由为此形态) */
  | { kind: 'timeout' };

export interface FixtureUpstreamRoute {
  method: 'GET';
  /** 以 / 开头、相对源 origin 的请求目标(可含查询) */
  path: string;
  response: FixtureUpstreamRouteResponse;
}

export interface FixtureUpstreamSource {
  sourceId: string;
  displayName: string;
  behavior: FixtureSourceBehavior;
  adapter: 'apple-cms-json';
  address: FixtureSourceAddress;
  /** origin + apiPath(POST /settings/sources 的 remoteUrl 形态) */
  remoteUrl: string;
  apiPath: string;
  timeoutMs: number;
  titleWorlds: readonly FixtureTitleWorld[];
  /** 目录类路由(ac=detail / ac=list&wd / ac=list&pg) */
  catalogRoutes: readonly FixtureUpstreamRoute[];
  /** 媒体类路由(全部影片世界的 master/media/分片/key/redirect) */
  mediaRoutes: readonly FixtureUpstreamRoute[];
  /** catalog + media 合并,按注册顺序(mock 层可整表消费) */
  routes: readonly FixtureUpstreamRoute[];
}

function originOf(address: FixtureSourceAddress): string {
  return address.port === undefined ? `http://${address.host}` : `http://${address.host}:${address.port}`;
}

function serializeQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function formatAppleCmsTime(ms: number): string {
  const at = new Date(ms);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return (
    `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ` +
    `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`
  );
}

function buildAppleCmsVodItem(seed: FixtureTitleSeed, options: { brief: boolean }): AppleCmsVodItem {
  const playFrom = seed.lines.map((line) => line.displayName).join('$$$');
  const playUrl = seed.lines
    .map((line) => line.episodes.map((episode) => `${episode.label}$${episode.playlistUri}`).join('#'))
    .join('$$$');
  return {
    vod_id: seed.upstreamVodId,
    type_id: seed.typeId ?? 6,
    type_name: seed.typeName ?? 'fixture连续剧',
    vod_name: seed.name,
    vod_sub: seed.sub ?? '',
    vod_en: seed.searchKeyword,
    vod_letter: seed.name.slice(0, 1).toUpperCase(),
    vod_remarks: seed.remarks ?? '',
    vod_year: seed.year ?? '',
    vod_area: seed.area ?? '',
    vod_lang: seed.lang ?? '',
    vod_version: seed.versionLabel ?? '',
    vod_actor: '夹具演员甲,夹具演员乙',
    vod_director: '夹具导演',
    vod_blurb: seed.synopsis ?? '',
    vod_content: `<p>${seed.synopsis ?? ''}</p>`,
    vod_pubdate: '2026-01-01',
    vod_total: seed.episodesTotal ?? 0,
    vod_serial: String(seed.episodesTotal ?? 0),
    vod_time: formatAppleCmsTime(FIXTURE_UPSTREAM_FIXED_NOW_MS),
    vod_time_add: Math.floor(FIXTURE_UPSTREAM_FIXED_NOW_MS / 1000),
    vod_play_from: options.brief ? '' : playFrom,
    vod_play_url: options.brief ? '' : playUrl,
    vod_play_note: '',
  };
}

export function buildAppleCmsListDocument(
  items: readonly AppleCmsVodItem[],
  options: { page?: number; limit?: string } = {},
): AppleCmsListDocument {
  return {
    code: 1,
    msg: 'fixture 数据',
    page: options.page ?? 1,
    pagecount: 1,
    limit: options.limit ?? '20',
    total: items.length,
    list: [...items],
  };
}

/** 由种子构造影片世界(渲染 wire 条目,聚合呈现路由) */
export function createFixtureTitleWorld(spec: FixtureTitleWorldSpec): FixtureTitleWorld {
  const seed: FixtureTitleSeed = {
    titleKey: spec.titleKey,
    upstreamVodId: spec.upstreamVodId,
    name: spec.name,
    sub: spec.sub,
    searchKeyword: spec.searchKeyword,
    year: spec.year,
    remarks: spec.remarks,
    area: spec.area,
    lang: spec.lang,
    versionLabel: spec.versionLabel,
    typeId: spec.typeId,
    typeName: spec.typeName,
    episodesTotal: spec.episodesTotal,
    synopsis: spec.synopsis,
    lines: spec.lines.map((line) => ({
      lineKey: line.lineKey,
      displayName: line.displayName,
      sortOrder: line.sortOrder,
      episodes: line.episodes.map((episode) => ({
        episodeKey: episode.episodeKey,
        label: episode.label,
        playlistUri: episode.presentation.entryUri,
        seasonKey: episode.seasonKey,
        ordinal: episode.ordinal,
        sequenceStatus: episode.sequenceStatus,
      })),
    })),
  };
  const presentations = spec.lines.flatMap((line) => line.episodes.map((episode) => episode.presentation));
  return {
    titleKey: spec.titleKey,
    searchKeyword: spec.searchKeyword,
    seed,
    item: buildAppleCmsVodItem(seed, { brief: false }),
    briefItem: buildAppleCmsVodItem(seed, { brief: true }),
    presentations,
  };
}

function jsonResponse(status: number, body: string): FixtureUpstreamRouteResponse {
  return {
    kind: 'response',
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body,
  };
}

/** 通用源构造:catalog 路由(ac=detail / wd 检索 / 全量 list)+ 全部媒体路由 */
export function createFixtureVodSource(input: {
  sourceId: string;
  displayName: string;
  behavior: FixtureSourceBehavior;
  address: FixtureSourceAddress;
  timeoutMs?: number;
  apiPath?: string;
  titleWorlds: readonly FixtureTitleWorld[];
}): FixtureUpstreamSource {
  const apiPath = input.apiPath ?? FIXTURE_UPSTREAM_DEFAULT_API_PATH;
  const origin = originOf(input.address);
  const remoteUrl = `${origin}${apiPath}`;
  const timeoutMs = input.timeoutMs ?? FIXTURE_SOURCE_DEFAULT_TIMEOUT_MS;

  const routeByPath = new Map<string, FixtureUpstreamRoute>();
  const pushRoute = (route: FixtureUpstreamRoute): void => {
    if (!routeByPath.has(route.path)) {
      routeByPath.set(route.path, route);
    }
  };
  const adopt = (response: FixtureUpstreamRouteResponse, route: FixtureUpstreamRoute): void => {
    pushRoute(input.behavior === 'timeout' ? { ...route, response: { kind: 'timeout' } } : { ...route, response });
  };

  const catalogRoutes: FixtureUpstreamRoute[] = [];
  const registerCatalog = (params: Record<string, string>, body: AppleCmsListDocument): void => {
    const route: FixtureUpstreamRoute = {
      method: 'GET',
      path: `${apiPath}?${serializeQuery(params)}`,
      response: jsonResponse(200, JSON.stringify(body)),
    };
    catalogRoutes.push(route);
    adopt(route.response, route);
  };

  // 1) 逐片详情(ac=detail&ids=)
  for (const world of input.titleWorlds) {
    registerCatalog(
      { ac: 'detail', ids: String(world.seed.upstreamVodId) },
      buildAppleCmsListDocument([world.item]),
    );
  }
  // 2) 逐片检索(ac=list&wd=;brief 形态)。注册先于全量 list,保证带 wd 的请求优先命中。
  for (const world of input.titleWorlds) {
    registerCatalog(
      { ac: 'list', wd: world.searchKeyword },
      buildAppleCmsListDocument([world.briefItem]),
    );
  }
  // 3) 全量列表(ac=list&pg=1;全部 brief 条目)
  if (input.titleWorlds.length > 0) {
    registerCatalog(
      { ac: 'list', pg: '1' },
      buildAppleCmsListDocument(input.titleWorlds.map((world) => world.briefItem)),
    );
  }

  const mediaRoutes: FixtureUpstreamRoute[] = [];
  for (const world of input.titleWorlds) {
    for (const presentation of world.presentations) {
      for (const route of presentation.routes) {
        mediaRoutes.push(route);
        adopt(route.response, route);
      }
    }
  }

  return {
    sourceId: input.sourceId,
    displayName: input.displayName,
    behavior: input.behavior,
    adapter: 'apple-cms-json',
    address: input.address,
    remoteUrl,
    apiPath,
    timeoutMs,
    titleWorlds: [...input.titleWorlds],
    catalogRoutes,
    mediaRoutes,
    routes: [...routeByPath.values()],
  };
}

/* ------------------------------------------------------------------ */
/* 请求路由匹配(纯函数;mock http 层按此派发)                            */
/* ------------------------------------------------------------------ */

function parseRequestTarget(input: string): { pathname: string; query: Record<string, string> } {
  let rest = input;
  const schemeIndex = rest.indexOf('://');
  if (schemeIndex >= 0) {
    const pathStart = rest.indexOf('/', schemeIndex + 3);
    rest = pathStart >= 0 ? rest.slice(pathStart) : '/';
  }
  const queryIndex = rest.indexOf('?');
  const pathname = queryIndex >= 0 ? rest.slice(0, queryIndex) : rest;
  const query: Record<string, string> = {};
  if (queryIndex >= 0) {
    for (const pair of rest.slice(queryIndex + 1).split('&')) {
      if (pair === '') {
        continue;
      }
      const eq = pair.indexOf('=');
      const key = eq >= 0 ? pair.slice(0, eq) : pair;
      const value = eq >= 0 ? pair.slice(eq + 1) : '';
      query[decodeURIComponent(key)] = decodeURIComponent(value);
    }
  }
  return { pathname, query };
}

/** 命中规则:method 一致 + pathname 精确相等 + 路由声明的查询参数为请求参数子集
 *  (请求可多带 pg/hour 等上游附加参数)。找不到返回 null,由 mock 层决定 404/超时。 */
export function findUpstreamRoute(
  routes: readonly FixtureUpstreamRoute[],
  url: string,
  method: 'GET' = 'GET',
): FixtureUpstreamRoute | null {
  const request = parseRequestTarget(url);
  for (const route of routes) {
    if (route.method !== method) {
      continue;
    }
    const candidate = parseRequestTarget(route.path);
    if (candidate.pathname !== request.pathname) {
      continue;
    }
    let matched = true;
    for (const [key, value] of Object.entries(candidate.query)) {
      if (request.query[key] !== value) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return route;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 三类影片世界构造器                                                    */
/* ------------------------------------------------------------------ */

/** 影片世界引用键(夹具内稳定;policy/断言用) */
export const FIXTURE_TITLE_KEYS = {
  /** 世界一:三集连续剧,同线明确 N+1(ordinal 1→2→3,全部 ordered) */
  threeEpisodeSerial: 'three-episode-serial',
  /** 世界二:缺集(01/02/04)+ 重复编号(backup 线两个 '02')+ 重复 lineKey(镜像线路) */
  gappedDuplicateSeries: 'gapped-duplicate-series',
  /** 世界三:同名版本冲突两端(2019 剧场版 / 2023 导演剪辑版,时长不同) */
  echoTheatrical: 'echo-city-theatrical-2019',
  echoDirectorsCut: 'echo-city-directors-cut-2023',
  /** 必超时源独占:时长未知清单形态(endList=false)的独立影片 */
  standaloneMovie: 'silent-post-standalone',
} as const;

/** 标准单集呈现:count×durationSeconds 分片、相对地址、可带 key/redirect */
export function createStandardEpisodePresentation(input: {
  presentationKey: string;
  episodeKey: string;
  origin: string;
  rootPath: string;
  segmentCount: number;
  segmentDurationSeconds: number;
  key?: FixtureHlsKey;
  endList?: boolean;
  redirectHops?: number;
  variants?: readonly FixtureHlsVariantSpec[];
}): FixtureHlsPresentation {
  const segments = Array.from({ length: input.segmentCount }, (_, index) => ({
    uri: `seg-${String(index + 1).padStart(3, '0')}.ts`,
    durationSeconds: input.segmentDurationSeconds,
  }));
  return createHlsPresentation({
    presentationKey: input.presentationKey,
    episodeKey: input.episodeKey,
    origin: input.origin,
    rootPath: input.rootPath,
    segments,
    key: input.key,
    endList: input.endList,
    redirectHops: input.redirectHops,
    variants: input.variants,
  });
}

/** 世界一:三集连续剧(同线明确 N+1)。EP1 多码率相对清单;EP2 带 key URI;EP3 短片。 */
export function createThreeEpisodeSerialWorld(origin: string): FixtureTitleWorld {
  const ep01 = createStandardEpisodePresentation({
    presentationKey: `${FIXTURE_TITLE_KEYS.threeEpisodeSerial}:01`,
    episodeKey: '01',
    origin,
    rootPath: '/vod/hls/1001/ep-01',
    segmentCount: 3,
    segmentDurationSeconds: 120,
    variants: [
      { name: '720p', bandwidth: 1_200_000, resolution: '1280x720', mediaPath: 'media/index.m3u8' },
      { name: '1080p', bandwidth: 2_800_000, resolution: '1920x1080', mediaPath: 'media-1080/index.m3u8' },
    ],
  });
  const ep02 = createStandardEpisodePresentation({
    presentationKey: `${FIXTURE_TITLE_KEYS.threeEpisodeSerial}:02`,
    episodeKey: '02',
    origin,
    rootPath: '/vod/hls/1001/ep-02',
    segmentCount: 2,
    segmentDurationSeconds: 45,
    key: { method: 'AES-128', uri: 'keys/ep-02.key', ivHex: FIXTURE_HLS_KEY_IV_HEX },
  });
  const ep03 = createStandardEpisodePresentation({
    presentationKey: `${FIXTURE_TITLE_KEYS.threeEpisodeSerial}:03`,
    episodeKey: '03',
    origin,
    rootPath: '/vod/hls/1001/ep-03',
    segmentCount: 1,
    segmentDurationSeconds: 30,
  });
  return createFixtureTitleWorld({
    titleKey: FIXTURE_TITLE_KEYS.threeEpisodeSerial,
    searchKeyword: 'stardust',
    upstreamVodId: 1001,
    name: 'fixture·星尘信使',
    year: '2024',
    remarks: '连载完毕 共3集',
    area: '夹具地区',
    lang: '夹具语言',
    episodesTotal: 3,
    synopsis: '三集连续剧夹具:同线明确 N+1(ordinal 1→2→3),US2 连续性/US3 序列/完播基线。',
    lines: [
      {
        lineKey: 'main',
        displayName: 'fixture正片',
        sortOrder: 1,
        episodes: [
          { episodeKey: '01', label: '第01集', presentation: ep01, seasonKey: 'S01', ordinal: 1, sequenceStatus: 'ordered' },
          { episodeKey: '02', label: '第02集', presentation: ep02, seasonKey: 'S01', ordinal: 2, sequenceStatus: 'ordered' },
          { episodeKey: '03', label: '第03集', presentation: ep03, seasonKey: 'S01', ordinal: 3, sequenceStatus: 'ordered' },
        ],
      },
    ],
  });
}

/** 世界二:缺集/重复编号。主线缺 03;备用线重复键 '02'(→identity_ambiguous)+
 *  special 特典;镜像线与主线重复 lineKey(→unsupported)。 */
export function createGappedDuplicateWorld(origin: string): FixtureTitleWorld {
  const presentationFor = (episodeKey: string, rootPath: string): FixtureHlsPresentation =>
    createStandardEpisodePresentation({
      presentationKey: `${FIXTURE_TITLE_KEYS.gappedDuplicateSeries}:${episodeKey}`,
      episodeKey,
      origin,
      rootPath,
      segmentCount: 2,
      segmentDurationSeconds: 45,
    });
  const ep01 = presentationFor('01', '/vod/hls/1002/ep-01');
  const ep02a = presentationFor('02', '/vod/hls/1002/ep-02');
  const ep04 = presentationFor('04', '/vod/hls/1002/ep-04');
  const ep02BackupA = presentationFor('02-backup-a', '/vod/hls/1002/ep-02-bak-a');
  const ep02BackupB = presentationFor('02-backup-b', '/vod/hls/1002/ep-02-bak-b');
  const special = createStandardEpisodePresentation({
    presentationKey: `${FIXTURE_TITLE_KEYS.gappedDuplicateSeries}:SP00`,
    episodeKey: 'SP00',
    origin,
    rootPath: '/vod/hls/1002/ep-sp00',
    segmentCount: 1,
    segmentDurationSeconds: 60,
  });
  return createFixtureTitleWorld({
    titleKey: FIXTURE_TITLE_KEYS.gappedDuplicateSeries,
    searchKeyword: 'mistfiles',
    upstreamVodId: 1002,
    name: 'fixture·迷雾档案',
    year: '2023',
    remarks: '连载 12 集 已更 4 集',
    area: '夹具地区',
    lang: '夹具语言',
    episodesTotal: 12,
    synopsis: '缺集/重复编号夹具:主线缺 03;备用线两个 \'02\'(identity_ambiguous);镜像线重复 lineKey(unsupported);SP00 为 special。',
    lines: [
      {
        lineKey: 'main',
        displayName: 'fixture主线',
        sortOrder: 1,
        episodes: [
          { episodeKey: '01', label: '第01集', presentation: ep01, seasonKey: 'S01', ordinal: 1, sequenceStatus: 'ordered' },
          { episodeKey: '02', label: '第02集', presentation: ep02a, seasonKey: 'S01', ordinal: 2, sequenceStatus: 'ordered' },
          { episodeKey: '04', label: '第04集', presentation: ep04, seasonKey: 'S01', ordinal: 4, sequenceStatus: 'ordered' },
        ],
      },
      {
        lineKey: 'backup',
        displayName: 'fixture备用线路',
        sortOrder: 2,
        episodes: [
          { episodeKey: '02', label: '第02集', presentation: ep02BackupA, seasonKey: 'S01', ordinal: null, sequenceStatus: 'ambiguous' },
          { episodeKey: '02', label: '第02集', presentation: ep02BackupB, seasonKey: 'S01', ordinal: null, sequenceStatus: 'ambiguous' },
          { episodeKey: 'SP00', label: '特典·制作花絮', presentation: special, ordinal: null, sequenceStatus: 'special' },
        ],
      },
      {
        // 与主线重复 lineKey:详情该线 unsupported(data-model:重复/空 key 详情显示 unsupported)
        lineKey: 'main',
        displayName: 'fixture镜像线路',
        sortOrder: 3,
        episodes: [
          { episodeKey: '01', label: '第01集', presentation: presentationFor('01-mirror', '/vod/hls/1002/ep-01-mirror'), ordinal: 1, sequenceStatus: 'ordered' },
        ],
      },
    ],
  });
}

/** 世界三:同名版本冲突(同名不同版本/年份)。theatrical=2019 剧场版 180s;
 *  directors-cut=2023 导演剪辑版 240s 且 master 经 2 跳 302(US4 换源匹配冲突)。 */
export function createVersionConflictWorld(
  origin: string,
  variant: 'theatrical' | 'directors-cut',
): FixtureTitleWorld {
  if (variant === 'theatrical') {
    const presentation = createStandardEpisodePresentation({
      presentationKey: `${FIXTURE_TITLE_KEYS.echoTheatrical}:main`,
      episodeKey: 'movie',
      origin,
      rootPath: '/vod/hls/1003/movie',
      segmentCount: 3,
      segmentDurationSeconds: 60,
    });
    return createFixtureTitleWorld({
      titleKey: FIXTURE_TITLE_KEYS.echoTheatrical,
      searchKeyword: 'echocity',
      upstreamVodId: 1003,
      name: 'fixture·回声双城',
      year: '2019',
      versionLabel: '剧场版',
      remarks: '剧场版 2019',
      area: '夹具地区',
      lang: '夹具语言',
      episodesTotal: 1,
      synopsis: '版本冲突 A 端(2019 剧场版,180s):与导演剪辑版同名同年检索词,US4 match_conflict 素材。',
      lines: [
        {
          lineKey: 'main',
          displayName: 'fixture正片',
          sortOrder: 1,
          episodes: [
            { episodeKey: 'movie', label: '正片', presentation, ordinal: 1, sequenceStatus: 'special' },
          ],
        },
      ],
    });
  }
  const presentation = createStandardEpisodePresentation({
    presentationKey: `${FIXTURE_TITLE_KEYS.echoDirectorsCut}:main`,
    episodeKey: 'movie',
    origin,
    rootPath: '/vod/hls/2003/movie',
    segmentCount: 4,
    segmentDurationSeconds: 60,
    redirectHops: 2,
  });
  return createFixtureTitleWorld({
    titleKey: FIXTURE_TITLE_KEYS.echoDirectorsCut,
    searchKeyword: 'echocity',
    upstreamVodId: 2003,
    name: 'fixture·回声双城',
    year: '2023',
    versionLabel: '导演剪辑版',
    remarks: '导演剪辑版 2023',
    area: '夹具地区',
    lang: '夹具语言',
    episodesTotal: 1,
    synopsis: '版本冲突 B 端(2023 导演剪辑版,240s,302×2):与剧场版同名同年检索词,US4 match_conflict 素材。',
    lines: [
      {
        lineKey: 'main',
        displayName: 'fixture正片',
        sortOrder: 1,
        episodes: [
          { episodeKey: 'movie', label: '正片', presentation, ordinal: 1, sequenceStatus: 'special' },
        ],
      },
    ],
  });
}

/** 必超时源独占影片:endList=false 清单形态(duration 未知场景)。 */
export function createStandaloneMovieWorld(origin: string): FixtureTitleWorld {
  const presentation = createStandardEpisodePresentation({
    presentationKey: `${FIXTURE_TITLE_KEYS.standaloneMovie}:main`,
    episodeKey: 'hd',
    origin,
    rootPath: '/vod/hls/1004/hd',
    segmentCount: 2,
    segmentDurationSeconds: 60,
    endList: false,
  });
  return createFixtureTitleWorld({
    titleKey: FIXTURE_TITLE_KEYS.standaloneMovie,
    searchKeyword: 'silentpost',
    upstreamVodId: 1004,
    name: 'fixture·静默哨站',
    year: '2022',
    remarks: '正片',
    area: '夹具地区',
    lang: '夹具语言',
    episodesTotal: 1,
    synopsis: '独立影片夹具:清单无 #EXT-X-ENDLIST(总时长未知形态),T038 未知时长回收/续播素材。',
    lines: [
      {
        lineKey: 'main',
        displayName: 'fixture正片',
        sortOrder: 1,
        episodes: [
          { episodeKey: 'hd', label: 'HD', presentation, ordinal: null, sequenceStatus: 'special' },
        ],
      },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* 源集合:3 健康 + 1 必超时                                              */
/* ------------------------------------------------------------------ */

export const FIXTURE_SOURCE_IDS = {
  alpha: 'fixture-vod-source-alpha',
  beta: 'fixture-vod-source-beta',
  gamma: 'fixture-vod-source-gamma',
  /** 必超时源 */
  sigma: 'fixture-vod-source-sigma-timeout',
} as const;

/** 聚合上游集(源集合 + 合并路由,FixtureUpstream 的载体) */
export interface FixtureUpstream {
  sources: readonly FixtureUpstreamSource[];
  healthySources: readonly FixtureUpstreamSource[];
  timeoutSource: FixtureUpstreamSource;
  /** 全部源的合并路由(注册顺序:alpha→beta→gamma→sigma) */
  routes: readonly FixtureUpstreamRoute[];
  findSource(sourceId: string): FixtureUpstreamSource | null;
  /** (source, upstreamVodId) 二元组清单(搜索去重口径核对用) */
  sourceTitlePairs(): readonly { sourceId: string; upstreamVodId: number; titleKey: string }[];
}

export interface FixtureUpstreamSetOptions {
  timeoutSourceTimeoutMs?: number;
  healthySourceTimeoutMs?: number;
  /** 按源覆盖地址(默认回环/保留段占位地址,见各 builder) */
  sourceAddressOverrides?: Partial<Record<keyof typeof FIXTURE_SOURCE_IDS, FixtureSourceAddress>>;
}

export function createHealthyAlphaSource(options: {
  address?: FixtureSourceAddress;
  timeoutMs?: number;
} = {}): FixtureUpstreamSource {
  const origin = originOf(options.address ?? { host: '127.0.0.1', port: 18081 });
  return createFixtureVodSource({
    sourceId: FIXTURE_SOURCE_IDS.alpha,
    displayName: '夹具源A(健康)',
    behavior: 'healthy',
    address: options.address ?? { host: '127.0.0.1', port: 18081 },
    timeoutMs: options.timeoutMs,
    titleWorlds: [
      createThreeEpisodeSerialWorld(origin),
      createVersionConflictWorld(origin, 'theatrical'),
    ],
  });
}

export function createHealthyBetaSource(options: {
  address?: FixtureSourceAddress;
  timeoutMs?: number;
} = {}): FixtureUpstreamSource {
  const origin = originOf(options.address ?? { host: 'vod-beta.example.test', port: 18082 });
  return createFixtureVodSource({
    sourceId: FIXTURE_SOURCE_IDS.beta,
    displayName: '夹具源B(健康)',
    behavior: 'healthy',
    address: options.address ?? { host: 'vod-beta.example.test', port: 18082 },
    timeoutMs: options.timeoutMs,
    titleWorlds: [createGappedDuplicateWorld(origin)],
  });
}

export function createHealthyGammaSource(options: {
  address?: FixtureSourceAddress;
  timeoutMs?: number;
} = {}): FixtureUpstreamSource {
  // RFC 5737 TEST-NET-1 文档保留段,绝不可路由
  const address = options.address ?? { host: '192.0.2.10', port: 18083 };
  const origin = originOf(address);
  return createFixtureVodSource({
    sourceId: FIXTURE_SOURCE_IDS.gamma,
    displayName: '夹具源C(健康)',
    behavior: 'healthy',
    address,
    timeoutMs: options.timeoutMs,
    titleWorlds: [createVersionConflictWorld(origin, 'directors-cut')],
  });
}

export function createTimeoutSigmaSource(options: {
  address?: FixtureSourceAddress;
  timeoutMs?: number;
} = {}): FixtureUpstreamSource {
  const address = options.address ?? { host: '127.0.0.1', port: 18099 };
  const origin = originOf(address);
  return createFixtureVodSource({
    sourceId: FIXTURE_SOURCE_IDS.sigma,
    displayName: '夹具源D(必超时)',
    behavior: 'timeout',
    address,
    timeoutMs: options.timeoutMs,
    titleWorlds: [createStandaloneMovieWorld(origin)],
  });
}

export function createFixtureUpstreamSet(options: FixtureUpstreamSetOptions = {}): FixtureUpstream {
  const overrides = options.sourceAddressOverrides ?? {};
  const sources = [
    createHealthyAlphaSource({
      address: overrides.alpha,
      timeoutMs: options.healthySourceTimeoutMs,
    }),
    createHealthyBetaSource({
      address: overrides.beta,
      timeoutMs: options.healthySourceTimeoutMs,
    }),
    createHealthyGammaSource({
      address: overrides.gamma,
      timeoutMs: options.healthySourceTimeoutMs,
    }),
    createTimeoutSigmaSource({
      address: overrides.sigma,
      timeoutMs: options.timeoutSourceTimeoutMs,
    }),
  ];
  const timeoutSource = sources[sources.length - 1];
  if (timeoutSource === undefined) {
    throw new Error('fixture 上游集合构造异常:缺必超时源');
  }
  return {
    sources,
    healthySources: sources.filter((source) => source.behavior === 'healthy'),
    timeoutSource,
    routes: sources.flatMap((source) => source.routes),
    findSource: (sourceId) => sources.find((source) => source.sourceId === sourceId) ?? null,
    sourceTitlePairs: () =>
      sources.flatMap((source) =>
        source.titleWorlds.map((world) => ({
          sourceId: source.sourceId,
          upstreamVodId: world.seed.upstreamVodId,
          titleKey: world.titleKey,
        })),
      ),
  };
}
