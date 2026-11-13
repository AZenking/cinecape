/**
 * 012 T004 · 直播节目/频道数据桩。
 *
 * 面向 012 直播故事单测提供三类桩(全部为零网络、零真实凭据的最小合法 DTO,
 * 形状 = packages/shared 生成的 Experience 契约类型,经 @hmp/shared type import):
 * - LIVE_PROGRAMME_STATES:四状态节目——now(正在直播,时间窗覆盖 LIVE_NOW)/
 *   upcoming(未来)/ ended(已播完)/ none(null,无节目单);每个节目含 startsAt/
 *   endsAt ISO 时刻;快照级时区用 LIVE_TEST_TIMEZONE('Asia/Shanghai',家庭 IANA
 *   时区字符串,data-model §8「服务端返回 now/timezone/revision」);
 * - 分组频道:LIVE_GROUPS(≥3 组)+ liveChannelRows/liveChannelPage(每组 ≥2 频道,
 *   其中例牌电影频道 current/next 双 null = 无节目单频道,FR-012 保留身份钉面);
 * - 单独样本:LIVE_UPCOMING_PROGRAMME / LIVE_ENDED_PROGRAMME(upcoming 与 ended
 *   节目样本,供 T012 等入口禁用断言直接取用)。
 *
 * 时间约定:全部锚定固定即时 LIVE_NOW(不依赖 Date.now(),行为确定可复现);
 * ISO 串统一 `YYYY-MM-DDTHH:mm:ss.sssZ` 全格式,字符串比较即时间比较。
 * 现在档 now = LIVE_NOW−30min → +30min;upcoming = +1h → +2h;ended = −2h → −1h。
 *
 * 用法:
 * - 频道行以四状态档位声明节目:liveChannelRow({ current: 'now', next: 'upcoming' });
 * - 需要逐频道不同的节目文案时用 liveProgramme(seed)(时间窗仍取自档位),
 *   缺省复用四态样本本体——SC-002「三入口面板内容一致」断言可直接受益;
 * - liveProgrammes({ current: 'ended' }) 直接产出共享节目详情面板宿主的
 *   Programmes 快照形状(status/current/next/now/timezone/catalogRevision)。
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

/** 家庭 IANA 时区字符串(005 contracts:快照 timezone 字段;示例取 Asia/Shanghai) */
export const LIVE_TEST_TIMEZONE = 'Asia/Shanghai';

/** 桩世界的固定「现在」:2026-11-01 12:00:00 UTC(家庭时区 20:00) */
export const LIVE_NOW = '2026-11-01T12:00:00.000Z';

/** 四状态节目各自的时间窗(相对 LIVE_NOW;none 无窗口) */
export const LIVE_PROGRAMME_WINDOWS = {
  now: { startsAt: '2026-11-01T11:30:00.000Z', endsAt: '2026-11-01T12:30:00.000Z' },
  upcoming: { startsAt: '2026-11-01T13:00:00.000Z', endsAt: '2026-11-01T14:00:00.000Z' },
  ended: { startsAt: '2026-11-01T09:30:00.000Z', endsAt: '2026-11-01T10:30:00.000Z' },
} as const;

/** 节目四状态档位(含 none=null;频道行 current/next、Programmes 快照共用) */
export interface LiveProgrammeStates {
  now: ExperienceProgrammeDto;
  upcoming: ExperienceProgrammeDto;
  ended: ExperienceProgrammeDto;
  none: null;
}

/** 四状态节目样本(单一事实源;起止时间取自 LIVE_PROGRAMME_WINDOWS) */
export const LIVE_PROGRAMME_STATES: LiveProgrammeStates = {
  now: {
    key: 'prog-now',
    title: '例牌正播节目',
    description: '正在直播的例牌节目',
    posterRef: null,
    startsAt: LIVE_PROGRAMME_WINDOWS.now.startsAt,
    endsAt: LIVE_PROGRAMME_WINDOWS.now.endsAt,
  },
  upcoming: {
    key: 'prog-upcoming',
    title: '例牌预告节目',
    description: '即将开播的例牌节目',
    posterRef: null,
    startsAt: LIVE_PROGRAMME_WINDOWS.upcoming.startsAt,
    endsAt: LIVE_PROGRAMME_WINDOWS.upcoming.endsAt,
  },
  ended: {
    key: 'prog-ended',
    title: '例牌已播完节目',
    description: '已经播完的例牌节目',
    posterRef: null,
    startsAt: LIVE_PROGRAMME_WINDOWS.ended.startsAt,
    endsAt: LIVE_PROGRAMME_WINDOWS.ended.endsAt,
  },
  none: null,
};

/** 四状态档位名(频道行 current/next、liveProgrammes 选项取值) */
export type LiveProgrammeSlot = keyof LiveProgrammeStates;

/** upcoming 节目样本(T004 指定;同 LIVE_PROGRAMME_STATES.upcoming) */
export const LIVE_UPCOMING_PROGRAMME: ExperienceProgrammeDto =
  LIVE_PROGRAMME_STATES.upcoming;

/** ended 节目样本(T004 指定;同 LIVE_PROGRAMME_STATES.ended) */
export const LIVE_ENDED_PROGRAMME: ExperienceProgrammeDto = LIVE_PROGRAMME_STATES.ended;

/** 生成一份节目:时间窗由档位决定,文案逐字段可定制(多频道变体用) */
export interface LiveProgrammeSeed {
  key: string;
  title: string;
  /** 时间窗档位(none 无节目,不可生成) */
  slot: Exclude<LiveProgrammeSlot, 'none'>;
  description?: string | null;
}

export function liveProgramme(seed: LiveProgrammeSeed): ExperienceProgrammeDto {
  const window = LIVE_PROGRAMME_WINDOWS[seed.slot];
  return {
    key: seed.key,
    title: seed.title,
    description: seed.description ?? null,
    posterRef: null,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
  };
}

/** 频道 PublicMedia 夹具(公共投影白名单字段;channel 类型/可用) */
export function liveChannelMedia(seed: {
  id: string;
  title: string;
  description?: string | null;
}): PublicMediaDto {
  return {
    id: seed.id,
    type: 'channel',
    title: seed.title,
    description: seed.description ?? null,
    posterRef: null,
    contentLevel: null,
    availability: 'available',
  };
}

/** 频道行种子:以四状态档位声明当前/下一节目(缺省 none → null) */
export interface LiveChannelRowSeed {
  id: string;
  title: string;
  groupKey: string;
  groupLabel: string;
  current?: LiveProgrammeSlot;
  next?: LiveProgrammeSlot;
  description?: string | null;
}

/** 生成单条频道行(overrides 可覆盖整个 ChannelRow 任意字段) */
export function liveChannelRow(
  seed: LiveChannelRowSeed,
  overrides: Partial<ChannelRowDto> = {},
): ChannelRowDto {
  return {
    media: liveChannelMedia({ id: seed.id, title: seed.title, description: seed.description }),
    groupKey: seed.groupKey,
    groupLabel: seed.groupLabel,
    current: LIVE_PROGRAMME_STATES[seed.current ?? 'none'],
    next: LIVE_PROGRAMME_STATES[seed.next ?? 'none'],
    ...overrides,
  };
}

/** 来源主分组(≥3 组;key 为不透明 groupKey) */
export const LIVE_GROUPS: GroupDto[] = [
  { key: 'g-news', label: '例牌新闻' },
  { key: 'g-drama', label: '例牌剧场' },
  { key: 'g-kids', label: '例牌少儿' },
];

/**
 * 规范频道行集:3 组 × 每组 2 频道;例牌电影频道 current/next 双 null
 * = 「无节目单」频道(FR-012 保留身份的钉面数据)。
 */
export function liveChannelRows(): ChannelRowDto[] {
  return [
    liveChannelRow({
      id: 'a0000000-0000-4000-8000-000000000001',
      title: '例牌新闻台',
      groupKey: 'g-news',
      groupLabel: '例牌新闻',
      current: 'now',
      next: 'upcoming',
    }),
    liveChannelRow({
      id: 'a0000000-0000-4000-8000-000000000002',
      title: '例牌纪录频道',
      groupKey: 'g-news',
      groupLabel: '例牌新闻',
      current: 'now',
      next: 'none',
    }),
    liveChannelRow({
      id: 'a0000000-0000-4000-8000-000000000003',
      title: '例牌剧场频道',
      groupKey: 'g-drama',
      groupLabel: '例牌剧场',
      current: 'now',
      next: 'upcoming',
    }),
    liveChannelRow({
      id: 'a0000000-0000-4000-8000-000000000004',
      title: '例牌电影频道',
      groupKey: 'g-drama',
      groupLabel: '例牌剧场',
      current: 'none',
      next: 'none',
    }),
    liveChannelRow({
      id: 'a0000000-0000-4000-8000-000000000005',
      title: '例牌少儿频道',
      groupKey: 'g-kids',
      groupLabel: '例牌少儿',
      current: 'now',
      next: 'upcoming',
    }),
    liveChannelRow({
      id: 'a0000000-0000-4000-8000-000000000006',
      title: '例牌动画频道',
      groupKey: 'g-kids',
      groupLabel: '例牌少儿',
      current: 'now',
      next: 'none',
    }),
  ];
}

/** GET /public/live/groups 响应桩(同步快照:now/timezone/catalogRevision) */
export function liveGroupPage(overrides: Partial<GroupPageDto> = {}): GroupPageDto {
  return {
    items: [...LIVE_GROUPS],
    now: LIVE_NOW,
    timezone: LIVE_TEST_TIMEZONE,
    catalogRevision: 1,
    ...overrides,
  };
}

export interface LiveChannelPageOptions {
  /** 只取某分组(channel section=group 页);缺省全部分区 */
  groupKey?: string;
  /** 整页字段覆盖(page/pageSize/total/快照字段等) */
  overrides?: Partial<ChannelPageDto>;
}

/** GET /public/live/channels 响应桩(多频道分组;快照字段与服务端同形) */
export function liveChannelPage(options: LiveChannelPageOptions = {}): ChannelPageDto {
  const items = liveChannelRows().filter(
    (row) => options.groupKey === undefined || row.groupKey === options.groupKey,
  );
  return {
    items,
    page: 1,
    pageSize: Math.max(items.length, 1),
    total: items.length,
    now: LIVE_NOW,
    timezone: LIVE_TEST_TIMEZONE,
    catalogRevision: 1,
    ...options.overrides,
  };
}

export interface LiveProgrammesOptions {
  /** 当前节目档位;缺省 'now' */
  current?: LiveProgrammeSlot;
  /** 下一节目档位;缺省 'upcoming' */
  next?: LiveProgrammeSlot;
  /** 快照状态;缺省 'available'(unavailable = 频道节目数据不可用形态) */
  status?: ExperienceProgrammesDto['status'];
  /** 整体字段覆盖 */
  overrides?: Partial<ExperienceProgrammesDto>;
}

/** GET /public/media/{mediaId}/programmes 响应桩(单频道节目快照) */
export function liveProgrammes(options: LiveProgrammesOptions = {}): ExperienceProgrammesDto {
  return {
    status: options.status ?? 'available',
    current: LIVE_PROGRAMME_STATES[options.current ?? 'now'],
    next: LIVE_PROGRAMME_STATES[options.next ?? 'upcoming'],
    now: LIVE_NOW,
    timezone: LIVE_TEST_TIMEZONE,
    catalogRevision: 1,
    ...options.overrides,
  };
}
