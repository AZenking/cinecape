/**
 * 查询键工厂(T020;006 contracts/query-keys.md——唯一键来源)。
 *
 * - 三域前缀是硬约束:键首段 `public` / `profile` / `settings` 决定身份缓存域,
 *   域级清除(切档/登出/401)按首段前缀匹配执行(scopes.ts);
 * - 个人键必须携带 profileId(经 session 注入,FR-021),不得以裸资源路径作个人键;
 * - 键可序列化:参数对象一律置于键末位元素,不含函数/类实例/时间戳瞬态值
 *   (日期用 `YYYY-MM-DD` 字符串);同参同键、异参异键;
 * - 键与缓存值不含播放票据、源地址、来源凭据(宪法原则三);
 * - 页面/封装 hook 一律经本工厂取键,禁止手写字符串键;
 *   新增资源只能扩本工厂(契约变更需同步 contracts/query-keys.md)。
 *
 * 参数类型在本文件内联定义(宽松形状;服务端 DTO 经 `@hmp/shared` type-only
 * 引入由调用方负责,键参数只需保证可序列化)。
 */

/**
 * 公共目录筛选(catalog;参数对象置于键末位)。
 * 具体字段形状在页面迁移(T023)时按服务端契约收敛,此处保留可选字段子集。
 */
export interface CatalogFilters {
  /** 窗口日期(`YYYY-MM-DD`,目录按日期窗口取数时使用) */
  date?: string;
  /** 频道 id(目录限定单频道时使用) */
  channelId?: string;
  /** 来源主分组 groupKey;缺省 = 全部分组 */
  group?: string;
  /** 关键字搜索 */
  search?: string;
  /** 媒体类型筛选(如电影/剧集;缺省 = 全部) */
  type?: string;
  /** 页码(从 1 起) */
  page?: number;
  /** 页大小 */
  pageSize?: number;
}

/** EPG 墙窗口查询(guide;日期/频道窗口;字段均可选,缺省由页面语义决定) */
export interface GuideQuery {
  /** 窗口起始日期(`YYYY-MM-DD`,不含瞬态时间戳) */
  date?: string;
  /** 频道 id(窗口限定单频道时使用;缺省 = 全量频道) */
  channelId?: string;
  /** 窗口时长(小时);缺省由服务端契约决定 */
  hours?: number;
  /** 日内子窗口起点(epoch ms;可选,键可序列化) */
  fromMs?: number;
  /** 日内子窗口终点(epoch ms;可选) */
  toMs?: number;
  /** 页码(从 1 起) */
  page?: number;
  /** 页大小 */
  pageSize?: number;
}

/** 公共 EPG 节目单查询(epg;频道×日期) */
export interface EpgQuery {
  /** 查询日期(`YYYY-MM-DD`);缺省 = 今日 */
  date?: string;
  /** 频道 id;缺省 = 全量频道 */
  channelId?: string;
}

/** 直播频道列表查询(live.channels;分区/分组/搜索/分页) */
export interface LiveChannelQuery {
  /** 分区标识(now/next/all 等页面分区) */
  section?: string;
  /** 来源主分组 groupKey;缺省 = 全部分组 */
  groupKey?: string;
  /** 关键字搜索 */
  q?: string;
  /** 页码(从 1 起) */
  page?: number;
  /** 页大小 */
  pageSize?: number;
}

/** 分页参数(个人历史等分页列表;置于键末位) */
export interface Page {
  /** 页码(从 1 起) */
  page: number;
  /** 页大小;缺省由服务端契约决定 */
  pageSize?: number;
}

/**
 * 010 在线点播搜索取数输入(010 api.md §2「首次{q}或后续{searchId,cursor?},两组互斥」)。
 *
 * 双形状必须保留(010 T032 A1 的承载):
 * - `{q}` = 活跃搜索期取数输入(与 searchId/cursor 互斥);
 * - `{searchId,cursor?}` = 刷新/返回恢复期与翻页期取数输入(缺 cursor 重放第一页)。
 * 「成功页把 searchId 写入 URL」不得改变取数输入——活跃期查询键只含 q。
 */
export type VodSearchInput = { q: string } | { searchId: string; cursor?: string };

/** 010 稳定父详情分集查询(GET /public/media/:id/episodes;修订绑定 cursor) */
export interface VodEpisodesQuery {
  /** 分页游标;null = 第一页 */
  cursor: string | null;
}

/**
 * 唯一查询键工厂。
 * 返回值均为 `as const` 只读元组,可直接用作 queryKey 与失效/清除谓词的匹配前缀。
 */
export const queryKeys = {
  // ── public 域:匿名可读、身份无关(publicFetch, credentials:'omit') ──
  public: {
    /** 公共上下文(匿名可读的服务端投影摘要) */
    context: () => ['public', 'context'] as const,
    /** 点播目录(按筛选条件分域) */
    catalog: (filters: CatalogFilters) => ['public', 'catalog', filters] as const,
    /** 媒体详情 */
    media: (id: string) => ['public', 'media', id] as const,
    /** EPG 墙(日期/频道窗口,慢变数据可传 staleTime 60s) */
    guide: (query: GuideQuery) => ['public', 'guide', query] as const,
    /** 直播族失效前缀(覆盖 groups/channels 全部直播键;30s 轮询契约不变) */
    live: () => ['public', 'live'] as const,
    /** 直播分区列表(30s 轮询契约不变) */
    liveGroups: () => ['public', 'live', 'groups'] as const,
    /** 直播频道列表(分区/分组/搜索/分页;30s 轮询契约不变) */
    liveChannels: (query: LiveChannelQuery) => ['public', 'live', 'channels', query] as const,
    /** 频道节目单 */
    epg: (query: EpgQuery) => ['public', 'epg', query] as const,
    /**
     * 010 在线点播搜索(T034 收编 T033 内联键;api.md §2 两组参数互斥)。
     * input=null(无活跃搜索/无恢复目标)落 `{idle:true}` 占位——形状与 T033 基线逐字一致,
     * 活跃期键只含 q,「写 searchId 不改变取数输入」由该双形状承载(见 VodSearchInput)。
     */
    vodSearch: (input: VodSearchInput | null) => ['public', 'vod', 'search', input ?? { idle: true }] as const,
    /** 010 在线点播临时预览(titleRef 为服务端 opaque ref) */
    vodPreview: (titleRef: string) => ['public', 'vod', 'preview', titleRef] as const,
    /** 010 稳定父详情分集(修订绑定 cursor;缺 cursor=第一页) */
    vodEpisodes: (parentMediaId: string, query: VodEpisodesQuery) =>
      ['public', 'media', 'episodes', parentMediaId, query] as const,
  },
  // ── profile 域:个人数据,键必须携带 profileId(privateFetch) ──
  profile: (profileId: string) => ({
    /** 个人收藏 */
    favorites: () => ['profile', profileId, 'favorites'] as const,
    /** 观看历史(分页) */
    history: (page: Page) => ['profile', profileId, 'history', page] as const,
    /** 单媒体观看进度 */
    progress: (id: string) => ['profile', profileId, 'progress', id] as const,
    /**
     * 010 在线点播父片聚合进度(T049;api.md §3 GET /me/vod/titles/:parentId/progress):
     * TitleProgress={latest,resumeCandidate,nextEpisodeAction},身份恒由服务端从当前
     * Session/激活 Profile 推导,键按 profileId 隔离(切档域清除按首段前缀覆盖)。
     */
    vodTitleProgress: (parentMediaId: string) =>
      ['profile', profileId, 'vod', 'title-progress', parentMediaId] as const,
    /** 013 个人偏好设置(播放/外观) */
    preferences: () => ['profile', profileId, 'preferences'] as const,
  }),
  // ── settings 域:管理数据,每次进入请求最新(privateFetch) ──
  settings: {
    /** 账号设置 */
    account: () => ['settings', 'account'] as const,
    /** 档案管理 */
    profiles: () => ['settings', 'profiles'] as const,
    /** 家长策略 */
    policy: () => ['settings', 'policy'] as const,
    /** 来源管理 */
    sources: () => ['settings', 'sources'] as const,
    /** 设备管理 */
    devices: () => ['settings', 'devices'] as const,
    /** EPG 源设置 */
    epg: () => ['settings', 'epg'] as const,
    /** 家庭(Household)设置 */
    household: () => ['settings', 'household'] as const,
  },
} as const;
