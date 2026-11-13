/**
 * 015 T005 · 直播全流程重构(015-live-flow-redesign)测试夹具。
 *
 * 面向 015 各 User Story 单测与 e2e 提供纯数据桩(零网络、零真实凭据,形状 =
 * packages/shared 生成的 Experience 契约类型,经 @hmp/shared type import):
 * - 分类组:电影(movie)/音乐(music)/体育(sports)各 3 频道,合计 9 频道;
 *   每个频道含 current(正在播出,时间窗与 NOW 严格相交)与 next(下一档预告,
 *   起始时刻在 NOW 之后);另含「全部」Tab 的前端伪分组键常量(见 ALL_GROUP_KEY);
 * - NOW 时间戳:LIVE_REDESIGN_NOW_ISO 为固定服务端快照即时(不依赖 Date.now(),
 *   行为确定可复现),配套 minutesFromNow(n)/windowFromMinutes(s,e) 相对时间工具,
 *   保证「时间窗与 NOW 相交」判定在任何时区/任何运行时刻都稳定;
 * - 构造器:buildProgramme / buildChannelRow / buildChannelRows /
 *   buildChannelListPage / buildGroupPage / buildProgrammes,全部返回全新实例,
 *   overrides 可覆盖任意字段以构造边角形态(如 current=null 无节目单频道)。
 *
 * 命名对照(重要):spec 文档(data-model.md §1、contracts/api-reuse.md)中的
 * ChannelListDto / ChannelGroupItemDto / logoRef / currentProgramme / nextProgramme
 * 是**前端投影记法**;实际以 @hmp/shared 导出为准(禁止臆造字段名):
 * - ChannelListDto ≙ ChannelPageDto { items/page/pageSize/total/now/timezone/catalogRevision }
 * - ChannelGroupItemDto ≙ GroupDto { key, label }(服务端不提供 count/「全部」组)
 * - logoRef ≙ ChannelRowDto.media.posterRef(频道 Logo 同源不透明引用,null=无 Logo)
 * - currentProgramme/nextProgramme ≙ ChannelRowDto.current / .next(Programme|null)
 *
 * 时间约定:与 helpers/live-data.ts 同风格,ISO 串统一 `YYYY-MM-DDTHH:mm:ss.sssZ`
 * 全格式(字符串比较即时间比较);但锚点即时**刻意不同于** LIVE_NOW
 * (2026-11-01T12:00:00.000Z),取 2026-11-15T12:00:00.000Z,便于测试区分
 * 「012 例牌世界」与「015 重构世界」两套夹具,避免同名导出互相冲突。
 *
 * 消费方(User Story spec 文件,均在 apps/web/test/features/live/ 下):
 * - US1 首页大屏与分类全景:live-hero-player.spec.tsx、channel-card-hover-play.spec.tsx
 * - US2 Live 行直达 EPG 时间墙:live-routing-epg.spec.tsx
 * - US3 分类网格与 Tab 联动:channel-grid-page.spec.tsx
 * - US4 播放与详情一体化页:live-watch-page.spec.tsx
 * - US5 游客意图恢复全链路:guest-intent-recovery.spec.tsx
 */

import type {
  ChannelPageDto,
  ChannelRowDto,
  ExperienceProgrammeDto,
  ExperienceProgrammesDto,
  GroupDto,
  GroupPageDto,
  PublicMediaDto,
} from '@hmp/shared';

// ── 快照锚点常量 ────────────────────────────────────────────────────────────

/** 家庭 IANA 时区字符串(005 contracts:快照 timezone 字段;示例取 Asia/Shanghai) */
export const LIVE_REDESIGN_TIMEZONE = 'Asia/Shanghai';

/**
 * 桩世界的固定服务端「现在」:2026-11-15 12:00:00.000 UTC(家庭时区 20:00)。
 * 全部夹具时间窗都相对该即时推导(负偏移=过去、正偏移=未来),测试可据此
 * 复算播出进度(如缺省当前节目 NOW−20min → NOW+40min,进度恰为 1/3)。
 */
export const LIVE_REDESIGN_NOW_ISO = '2026-11-15T12:00:00.000Z';

/** 桩世界的目录修订号(快照 catalogRevision 字段;取 15 呼应 feature 编号) */
export const LIVE_REDESIGN_CATALOG_REVISION = 15;

/**
 * 「全部」分类 Tab 的前端伪分组键(US3 分类网格)。
 * 服务端 GroupPageDto.items 只含真实来源分组(不提供「全部」组);
 * 该键仅作为网格页 Tab 约定,表示不过滤 groupKey——不得写入 buildGroupPage().items。
 */
export const ALL_GROUP_KEY = 'all';

/**
 * 来源主分组常量(≥3 组;key 为不透明 groupKey)。
 * 消费方:US3 channel-grid-page.spec.tsx(Tabs 清单断言)、US1 分类泳道标题。
 */
export const LIVE_REDESIGN_GROUPS: readonly GroupDto[] = [
  { key: 'movie', label: '电影' },
  { key: 'music', label: '音乐' },
  { key: 'sports', label: '体育' },
] as const;

// ── 相对时间工具 ────────────────────────────────────────────────────────────

/**
 * 返回「NOW ± minutes 分钟」的 ISO 8601 串(全格式 `.sssZ`)。
 * NOW 为固定即时,结果纯函数可复现:minutesFromNow(60) === '2026-11-15T13:00:00.000Z'。
 * 消费方:US2 live-routing-epg.spec.tsx(NOW 红线相交节目块)、US4 live-watch-page.spec.tsx(进度复算)。
 */
export function minutesFromNow(minutes: number): string {
  return new Date(Date.parse(LIVE_REDESIGN_NOW_ISO) + minutes * 60_000).toISOString();
}

/** 节目时间窗(startsAt/endsAt,ISO 8601 全格式) */
export interface LiveRedesignWindow {
  startsAt: string;
  endsAt: string;
}

/**
 * 返回相对 NOW 的时间窗:startMinutes/endMinutes 为分钟偏移(负=过去)。
 * 例:windowFromMinutes(-20, 40) = NOW−20min → NOW+40min(与 NOW 严格相交);
 * windowFromMinutes(-120, -60) = 已播完窗、windowFromMinutes(60, 120) = 未开播窗。
 * 消费方:US2 EPG 墙构造相交/不相交节目块、US1 卡片当前节目窗。
 */
export function windowFromMinutes(startMinutes: number, endMinutes: number): LiveRedesignWindow {
  return { startsAt: minutesFromNow(startMinutes), endsAt: minutesFromNow(endMinutes) };
}

// ── 节目构造器 ──────────────────────────────────────────────────────────────

/** 节目种子:key/title 必填;时间窗以分钟偏移声明(缺省 NOW−20 → NOW+40,与 NOW 相交) */
export interface LiveRedesignProgrammeSeed {
  /** 节目唯一 key(契约 Programme.key;缺省派生 `${channelId}:${slot}`) */
  key?: string;
  title: string;
  description?: string | null;
  /** 起始时刻相对 NOW 的分钟偏移(负=过去);缺省 −20 */
  startsAtMinutes?: number;
  /** 结束时刻相对 NOW 的分钟偏移;缺省 +40 */
  endsAtMinutes?: number;
}

/**
 * 生成一份节目(ExperienceProgrammeDto)。
 * 消费方:US1~US5 通用;构造非相交窗(已播完/未开播)节目用 startsAtMinutes/endsAtMinutes 负/大正偏移。
 */
export function buildProgramme(
  seed: LiveRedesignProgrammeSeed,
  channelId?: string,
  slot: 'current' | 'next' = 'current',
): ExperienceProgrammeDto {
  return {
    key: seed.key ?? `${channelId ?? 'lr-channel'}:${slot}`,
    title: seed.title,
    description: seed.description ?? null,
    posterRef: null,
    startsAt: minutesFromNow(seed.startsAtMinutes ?? -20),
    endsAt: minutesFromNow(seed.endsAtMinutes ?? 40),
  };
}

/** 频道行节目种子对(当前播出 + 下一档预告;各自可整字段定制) */
export interface LiveRedesignChannelProgrammeSeeds {
  current: LiveRedesignProgrammeSeed;
  next: LiveRedesignProgrammeSeed;
}

// ── 频道行构造器 ────────────────────────────────────────────────────────────

/** 频道行种子:id/title/分组必填;current/next 缺省给「正在播出 + 下一档」标准窗 */
export interface LiveRedesignChannelSeed {
  /** 频道媒体 ID(uuid 形状;契约 ChannelRow.media.id) */
  id: string;
  title: string;
  description?: string | null;
  /** 频道 Logo 同源不透明引用(= spec 文档所称 logoRef;null=无 Logo) */
  posterRef?: string | null;
  groupKey: string;
  groupLabel: string;
  /** 当前播出节目(缺省 NOW−20 → NOW+40,与 NOW 严格相交);传 null 构造无节目单频道 */
  current?: LiveRedesignProgrammeSeed | null;
  /** 下一档预告(缺省 NOW+40 → NOW+100,起始在 NOW 之后);传 null 构造无预告频道 */
  next?: LiveRedesignProgrammeSeed | null;
}

/**
 * 生成单条频道行(ChannelRowDto;overrides 可覆盖任意字段构造边角形态)。
 * 消费方:US1 live-hero-player / channel-card-hover-play、US4 live-watch-page(单频道定制)。
 */
export function buildChannelRow(
  seed: LiveRedesignChannelSeed,
  overrides: Partial<ChannelRowDto> = {},
): ChannelRowDto {
  const media: PublicMediaDto = {
    id: seed.id,
    type: 'channel',
    title: seed.title,
    description: seed.description ?? null,
    posterRef: seed.posterRef ?? null,
    contentLevel: null,
    availability: 'available',
  };
  return {
    media,
    groupKey: seed.groupKey,
    groupLabel: seed.groupLabel,
    current:
      seed.current === null || seed.current === undefined
        ? null
        : buildProgramme(seed.current, seed.id, 'current'),
    next:
      seed.next === null || seed.next === undefined
        ? null
        : buildProgramme(seed.next, seed.id, 'next'),
    ...overrides,
  };
}

// ── 规范频道集(电影/音乐/体育 × 3 频道)────────────────────────────────────

/**
 * 规范频道种子集:3 组 × 每组 3 频道。
 * 每频道 current 与 NOW 严格相交、next 起始在 NOW 之后;同组内刻意错开时间窗,
 * 供进度条/排序类断言区分(如「经典电影台」进度更深、「动作影院」刚开播)。
 * 电影/音乐/体育每组首个频道带非空 posterRef,供 Logo 渲染断言(US1/US3)。
 */
const LIVE_REDESIGN_CHANNEL_SEEDS: readonly LiveRedesignChannelSeed[] = [
  // ── 电影 movie ──
  {
    id: 'b0000000-0000-4000-8000-000000000001',
    title: '星光影城',
    description: '24 小时轮播院线新片与经典佳作',
    posterRef: 'lr-movie-01',
    groupKey: 'movie',
    groupLabel: '电影',
    current: {
      title: '星际回响',
      description: '科幻大片:深空殖民舰收到无法解析的信号',
      startsAtMinutes: -20,
      endsAtMinutes: 40,
    },
    next: {
      title: '午夜场:雾都疑云',
      description: '悬疑经典修复版',
      startsAtMinutes: 40,
      endsAtMinutes: 100,
    },
  },
  {
    id: 'b0000000-0000-4000-8000-000000000002',
    title: '经典电影台',
    groupKey: 'movie',
    groupLabel: '电影',
    current: {
      title: '罗马假日',
      description: '黑白经典:公主的罗马一日',
      startsAtMinutes: -35,
      endsAtMinutes: 25,
    },
    next: {
      title: '摩登时代',
      description: '卓别林默片杰作',
      startsAtMinutes: 25,
      endsAtMinutes: 85,
    },
  },
  {
    id: 'b0000000-0000-4000-8000-000000000003',
    title: '动作影院',
    groupKey: 'movie',
    groupLabel: '电影',
    current: {
      title: '疾速追击',
      description: '动作大片:退隐杀手重返江湖',
      startsAtMinutes: -5,
      endsAtMinutes: 55,
    },
    next: {
      title: '铁血防线',
      description: '硬核军事动作片',
      startsAtMinutes: 55,
      endsAtMinutes: 115,
    },
  },
  // ── 音乐 music ──
  {
    id: 'b0000000-0000-4000-8000-000000000004',
    title: '流行音乐台',
    description: '华语流行 MV 与打歌舞台全天轮播',
    posterRef: 'lr-music-01',
    groupKey: 'music',
    groupLabel: '音乐',
    current: {
      title: '华语金曲榜',
      description: '本周新歌打榜实时更新',
      startsAtMinutes: -20,
      endsAtMinutes: 40,
    },
    next: {
      title: '新歌首发',
      description: '一线歌手新歌首播',
      startsAtMinutes: 40,
      endsAtMinutes: 100,
    },
  },
  {
    id: 'b0000000-0000-4000-8000-000000000005',
    title: '经典金曲台',
    groupKey: 'music',
    groupLabel: '音乐',
    current: {
      title: '岁月留声',
      description: '八十年代金曲连播',
      startsAtMinutes: -30,
      endsAtMinutes: 30,
    },
    next: {
      title: '黑胶时光',
      description: '复古黑胶鉴赏栏目',
      startsAtMinutes: 30,
      endsAtMinutes: 90,
    },
  },
  {
    id: 'b0000000-0000-4000-8000-000000000006',
    title: '演唱会现场',
    groupKey: 'music',
    groupLabel: '音乐',
    current: {
      title: '不插电现场',
      description: '原声弹唱专场实录',
      startsAtMinutes: -15,
      endsAtMinutes: 45,
    },
    next: {
      title: '夏夜音乐节',
      description: '露天音乐节全场回放',
      startsAtMinutes: 45,
      endsAtMinutes: 105,
    },
  },
  // ── 体育 sports ──
  {
    id: 'b0000000-0000-4000-8000-000000000007',
    title: '体育赛事台',
    description: '顶级联赛直播与赛点集锦',
    posterRef: 'lr-sports-01',
    groupKey: 'sports',
    groupLabel: '体育',
    current: {
      title: '英超直播',
      description: '曼联对阵阿森纳,下半场进行中',
      startsAtMinutes: -20,
      endsAtMinutes: 40,
    },
    next: {
      title: '赛后分析',
      description: '名嘴复盘本场战术',
      startsAtMinutes: 40,
      endsAtMinutes: 100,
    },
  },
  {
    id: 'b0000000-0000-4000-8000-000000000008',
    title: '足球频道',
    groupKey: 'sports',
    groupLabel: '体育',
    current: {
      title: '西甲精选',
      description: '国家德比全场回放',
      startsAtMinutes: -10,
      endsAtMinutes: 50,
    },
    next: {
      title: '青训纪实',
      description: '梯队小将成长记录',
      startsAtMinutes: 50,
      endsAtMinutes: 110,
    },
  },
  {
    id: 'b0000000-0000-4000-8000-000000000009',
    title: '篮球频道',
    groupKey: 'sports',
    groupLabel: '体育',
    current: {
      title: 'CBA 直播',
      description: '季后赛半决赛第四节',
      startsAtMinutes: -25,
      endsAtMinutes: 35,
    },
    next: {
      title: '球星专访',
      description: '本赛季 MVP 一对一访谈',
      startsAtMinutes: 35,
      endsAtMinutes: 95,
    },
  },
] as const;

/**
 * 生成规范频道行集(全新数组与全新行对象,可安全改动;9 频道 = 3 组 × 3)。
 * 消费方:US1 分类泳道/US3 网格/US2 频道清单断言的数据源。
 */
export function buildChannelRows(): ChannelRowDto[] {
  return LIVE_REDESIGN_CHANNEL_SEEDS.map((seed) => buildChannelRow({ ...seed }));
}

/**
 * 规范频道行集类型化常量(buildChannelRows() 的冻结只读快照;
 * 需要可变副本时请调用 buildChannelRows(),勿直接改写本常量)。
 */
export const LIVE_REDESIGN_CHANNELS: readonly ChannelRowDto[] = buildChannelRows();

/**
 * 规范频道行按 groupKey 分组索引(只读;key 顺序 = LIVE_REDESIGN_GROUPS 声明序)。
 * 消费方:US3 channel-grid-page.spec.tsx(Tab 切换仅展示对应分类频道)。
 */
export const LIVE_REDESIGN_CHANNELS_BY_GROUP: Readonly<
  Record<string, readonly ChannelRowDto[]>
> = Object.fromEntries(
  LIVE_REDESIGN_GROUPS.map((group) => [
    group.key,
    LIVE_REDESIGN_CHANNELS.filter((row) => row.groupKey === group.key),
  ]),
);

// ── 分组页 / 频道列表页构造器(端点响应桩)─────────────────────────────────

/**
 * GET /public/live/groups 响应桩(GroupPageDto;同步快照 now/timezone/catalogRevision)。
 * 消费方:US1 分类泳道装配、US3 channel-grid-page.spec.tsx(Tabs 数据源)。
 */
export function buildGroupPage(overrides: Partial<GroupPageDto> = {}): GroupPageDto {
  return {
    items: LIVE_REDESIGN_GROUPS.map((group) => ({ ...group })),
    now: LIVE_REDESIGN_NOW_ISO,
    timezone: LIVE_REDESIGN_TIMEZONE,
    catalogRevision: LIVE_REDESIGN_CATALOG_REVISION,
    ...overrides,
  };
}

export interface LiveRedesignChannelListPageOptions {
  /** 只取某分组(≡ section=group&groupKey=:key 页);缺省全部分区(≡ section=all) */
  groupKey?: string;
  /** 整页字段覆盖(page/pageSize/total/快照字段等) */
  overrides?: Partial<ChannelPageDto>;
}

/**
 * GET /public/live/channels 响应桩(ChannelPageDto;spec 文档所称 ChannelListDto)。
 * 含 timezone/now/items 及分页字段,形状与服务端同形;快照字段固定取锚点常量。
 * 消费方:US1 首页分区、US3 分类网格、US2/US4 同组频道清单、US5 游客浏览数据源。
 */
export function buildChannelListPage(
  options: LiveRedesignChannelListPageOptions = {},
): ChannelPageDto {
  const items = (options.groupKey === undefined
    ? LIVE_REDESIGN_CHANNEL_SEEDS
    : LIVE_REDESIGN_CHANNEL_SEEDS.filter((seed) => seed.groupKey === options.groupKey)
  ).map((seed) => buildChannelRow({ ...seed }));
  return {
    items,
    page: 1,
    pageSize: Math.max(items.length, 1),
    total: items.length,
    now: LIVE_REDESIGN_NOW_ISO,
    timezone: LIVE_REDESIGN_TIMEZONE,
    catalogRevision: LIVE_REDESIGN_CATALOG_REVISION,
    ...options.overrides,
  };
}

// ── 单频道节目快照构造器 ────────────────────────────────────────────────────

export interface LiveRedesignProgrammesOptions {
  /** 当前节目;缺省取规范首频道(星光影城)的 current */
  current?: ExperienceProgrammeDto | null;
  /** 下一档节目;缺省取规范首频道的 next */
  next?: ExperienceProgrammeDto | null;
  /** 快照状态;缺省 'available'(unavailable = 频道节目数据不可用形态) */
  status?: ExperienceProgrammesDto['status'];
  /** 整体字段覆盖 */
  overrides?: Partial<ExperienceProgrammesDto>;
}

/**
 * GET /public/media/{mediaId}/programmes 响应桩(ExperienceProgrammesDto)。
 * 消费方:US4 live-watch-page.spec.tsx(详情面板节目信息)、US2 相交节目详情断言。
 */
export function buildProgrammes(
  options: LiveRedesignProgrammesOptions = {},
): ExperienceProgrammesDto {
  // 缺省值重建自规范首频道种子,保证返回的快照不与常量共享对象引用
  const [firstSeed] = LIVE_REDESIGN_CHANNEL_SEEDS;
  const fallbackCurrent = firstSeed?.current
    ? buildProgramme(firstSeed.current, firstSeed.id, 'current')
    : null;
  const fallbackNext = firstSeed?.next
    ? buildProgramme(firstSeed.next, firstSeed.id, 'next')
    : null;
  return {
    status: options.status ?? 'available',
    current: options.current !== undefined ? options.current : fallbackCurrent,
    next: options.next !== undefined ? options.next : fallbackNext,
    now: LIVE_REDESIGN_NOW_ISO,
    timezone: LIVE_REDESIGN_TIMEZONE,
    catalogRevision: LIVE_REDESIGN_CATALOG_REVISION,
    ...options.overrides,
  };
}
