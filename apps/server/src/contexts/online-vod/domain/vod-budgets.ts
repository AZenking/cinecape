/**
 * 010 T019 — VOD 预算常量/派生类型/校验辅助。
 *
 * 010 T090 knip 清理:删除无消费面——VOD_RATE_BUCKETS(限流装配改由 playback
 * rate-limit 策略面承担)、isWithinBudget 谓词、独立限流桶 registry 段
 * (VodRateBucket/VodBucketOptions/VodBudgetRegistryOptions/VodBudgetRegistry/
 * createVodBudgetRegistry)与 6 个未消费派生预算类型;VOD_BUDGETS/校验辅助/
 * 快照与 detail 派生类型保持不变。
 *
 * 纯 TS：零 Nest/Node 运行时依赖、零 import（定时器仅用全局
 * setTimeout/clearTimeout，句柄为 @types/node 全局类型 NodeJS.Timeout，属任务
 * 允许的「类型引用 node 类型」；不 import 任何 node 值 API）。
 * 本文件不得 import @nestjs/*、drizzle、platform 层（.dependency-cruiser.cjs
 * R1a/R3 对 domain 层的硬禁令）。
 *
 * 数值来源（逐字对照任务文本，不自创/漏项；每项旁注出处）：
 * - docs/specs/010-online-vod/tasks.md T019：「搜索8s/并发3、预览8s/4MiB、
 *   10启用源/5000父/100000子、详情20线/单线2000/总5000项、每家庭100搜索/1000预览/
 *   进程256MiB；独立限流桶/TTL及shutdown取消，禁止无界等待」（依赖 T006）；
 * - docs/specs/010-online-vod/contracts/api.md §0（限流/上限）：「公共查询每IP
 *   120/min上限内，在线搜索另20/min」「所有桶有TTL和全局数量上限，资源忙返回429
 *   不堆无界队列」「上游502/总期限504」；
 * - docs/specs/010-online-vod/plan.md Technical Context「Scale/Scope」同值佐证：
 *   10启用源、5000父/100000子、详情最多20线路/单线2000/总5000项/4MiB（配额是
 *   明确初值，不是现有容量实测结论）。
 *
 * 语义备注：
 * - 单详情 4MiB 与预览体积 4MiB 是 api.md §2「超限422整次失败」的阈值口径；
 *   进程 256MiB 是总缓存上限（超额拒绝或淘汰最早过期项），非单请求限额；
 * - 搜索 8s 为单次搜索上游总期限（各源共享同一 deadline，全部超时映射 504）。
 */

/** MiB 换算（4MiB/256MiB 字节值由此推导，避免手写长数字出错） */
const MIB = 1024 * 1024;

/**
 * VOD 预算总表（契约冻结初值；env 覆盖面见 infrastructure/vod-config.ts ——
 * 只允许收紧、不允许超出本表上限，见该文件 loadVodRuntimeConfig）。
 */
export const VOD_BUDGETS = {
  /** 搜索上游预算：8s 总期限 / 并发 3（tasks T019「搜索8s/并发3」；总期限耗尽映射 504，api §0） */
  search: {
    totalTimeoutMs: 8_000,
    concurrency: 3,
  },
  /** 预览上游预算：8s / 4MiB（tasks T019「预览8s/4MiB」；超体积 422，api §0 错误收敛/§2） */
  preview: {
    totalTimeoutMs: 8_000,
    maxBytes: 4 * MIB,
  },
  /** 目录规模初值：10 启用源 / 5000 父 / 100000 子（tasks T019；api §2「限10启用源」） */
  catalog: {
    maxEnabledSources: 10,
    maxParentTitles: 5000,
    maxChildEpisodes: 100_000,
  },
  /** 单详情预算：最多 20 线 / 单线 2000 / 总 5000 项 / 单详情 4MiB（tasks T019；超限 422 整次失败，api §2） */
  detail: {
    maxLines: 20,
    maxEpisodesPerLine: 2000,
    maxEpisodesTotal: 5000,
    maxBytes: 4 * MIB,
  },
  /** 每家庭活对象上限：100 活搜索 / 1000 活预览（tasks T019；api §2「每家庭100个活搜索、1000个活预览」） */
  households: {
    maxActiveSearchesPerHousehold: 100,
    maxActivePreviewsPerHousehold: 1000,
  },
  /** 进程总缓存上限：256MiB（tasks T019；api §2「全进程最多256MiB」） */
  cache: {
    maxTotalBytes: 256 * MIB,
  },
  /** HTTP 限流初值（api §0）：公共查询每 IP 120/min，在线搜索另 20/min */
  rateLimits: {
    publicQueryPerIpPerMinute: 120,
    vodSearchPerIpPerMinute: 20,
  },
} as const;

/* ------------------------------------------------------------------ */
/* 派生类型                                                            */
/* ------------------------------------------------------------------ */

export type VodBudgetSnapshot = typeof VOD_BUDGETS;
export type VodDetailBudget = VodBudgetSnapshot['detail'];

/**
 * 宽化预算形态（字段集合与 VOD_BUDGETS 逐一对应，但为 number 字段）：
 * 契约快照（VodBudgetSnapshot，字面量类型）与运行期生效配置（如
 * infrastructure/vod-config.ts 的 VodRuntimeConfig）都可赋值给本形态，
 * 校验辅助据此同时服务两者。
 */
export interface VodBudgetShape {
  readonly search: { readonly totalTimeoutMs: number; readonly concurrency: number };
  readonly preview: { readonly totalTimeoutMs: number; readonly maxBytes: number };
  readonly catalog: {
    readonly maxEnabledSources: number;
    readonly maxParentTitles: number;
    readonly maxChildEpisodes: number;
  };
  readonly detail: {
    readonly maxLines: number;
    readonly maxEpisodesPerLine: number;
    readonly maxEpisodesTotal: number;
    readonly maxBytes: number;
  };
  readonly households: {
    readonly maxActiveSearchesPerHousehold: number;
    readonly maxActivePreviewsPerHousehold: number;
  };
  readonly cache: { readonly maxTotalBytes: number };
  readonly rateLimits: {
    readonly publicQueryPerIpPerMinute: number;
    readonly vodSearchPerIpPerMinute: number;
  };
}

/* ------------------------------------------------------------------ */
/* 校验辅助（纯函数；失败抛纯 Error 子类，不用 Nest HttpException）        */
/* ------------------------------------------------------------------ */

/** 单条预算违规（path 为 VOD_BUDGETS 组内点路径；message 为稳定中文短语） */
export interface VodBudgetViolation {
  readonly path: string;
  readonly message: string;
}

/** 逐字段校验预算快照：所有值必须为 >=1 的安全整数（契约未定义跨字段派生约束，不发明） */
export function findBudgetViolations(snapshot: VodBudgetShape): VodBudgetViolation[] {
  const violations: VodBudgetViolation[] = [];
  const positiveInt = (path: string, value: number): void => {
    if (!Number.isSafeInteger(value) || value < 1) {
      violations.push({ path, message: '需为 >=1 的安全整数' });
    }
  };
  positiveInt('search.totalTimeoutMs', snapshot.search.totalTimeoutMs);
  positiveInt('search.concurrency', snapshot.search.concurrency);
  positiveInt('preview.totalTimeoutMs', snapshot.preview.totalTimeoutMs);
  positiveInt('preview.maxBytes', snapshot.preview.maxBytes);
  positiveInt('catalog.maxEnabledSources', snapshot.catalog.maxEnabledSources);
  positiveInt('catalog.maxParentTitles', snapshot.catalog.maxParentTitles);
  positiveInt('catalog.maxChildEpisodes', snapshot.catalog.maxChildEpisodes);
  positiveInt('detail.maxLines', snapshot.detail.maxLines);
  positiveInt('detail.maxEpisodesPerLine', snapshot.detail.maxEpisodesPerLine);
  positiveInt('detail.maxEpisodesTotal', snapshot.detail.maxEpisodesTotal);
  positiveInt('detail.maxBytes', snapshot.detail.maxBytes);
  positiveInt('households.maxActiveSearchesPerHousehold', snapshot.households.maxActiveSearchesPerHousehold);
  positiveInt('households.maxActivePreviewsPerHousehold', snapshot.households.maxActivePreviewsPerHousehold);
  positiveInt('cache.maxTotalBytes', snapshot.cache.maxTotalBytes);
  positiveInt('rateLimits.publicQueryPerIpPerMinute', snapshot.rateLimits.publicQueryPerIpPerMinute);
  positiveInt('rateLimits.vodSearchPerIpPerMinute', snapshot.rateLimits.vodSearchPerIpPerMinute);
  return violations;
}

/** 预算校验失败错误（纯 Error 子类；interface 层负责翻译为 HTTP 语义） */
export class VodBudgetViolationError extends Error {
  readonly violations: readonly VodBudgetViolation[];

  constructor(violations: readonly VodBudgetViolation[]) {
    super(
      `VOD 预算校验失败(${violations.length} 项): ${violations
        .map((v) => `${v.path} ${v.message}`)
        .join('; ')}`,
    );
    this.name = 'VodBudgetViolationError';
    this.violations = violations;
  }
}

/** fail-fast 断言：预算快照越界即抛 VodBudgetViolationError */
export function assertWithinBudget(snapshot: VodBudgetShape): void {
  const violations = findBudgetViolations(snapshot);
  if (violations.length > 0) {
    throw new VodBudgetViolationError(violations);
  }
}

/* 010 T090 knip 清理:原「独立限流桶/TTL 领域接口」段(VodRateBucket/VodBucketOptions/
 * VodBudgetRegistryOptions/VodBudgetRegistry/createVodBudgetRegistry 及其内部辅助)
 * 已删除——零消费面(限流运行时由 playback rate-limit 策略面承担),详见文件头注记。
 */
