/**
 * 010 T019 — VOD 运行期配置装配面（infrastructure 层）。
 *
 * 职责：
 * - 读进程 env 覆盖（全部有 VOD_BUDGETS 缺省；只允许在契约值之内收紧，
 *   超出契约上限或非法值一律 fail-fast 抛错，绝不静默放宽——api.md §0 上限为
 *   冻结契约，部署侧不得借 env 放大）；
 * - 输出强类型 VodRuntimeConfig（数值形态 = domain VodBudgetShape +
 *   脱敏摘要方法），创建时经 assertWithinBudget 复核；
 * - 提供 Nest provider 形态的工厂 vodConfigProvider()（FactoryProvider，
 *   不实例化任何连接/客户端；绑定进 online-vod.module.ts 归后续任务，
 *   本任务不改 module/tokens 文件）。
 *
 * 结构化脱敏：VodRuntimeConfig.toString()/toLogForm() 只由「数值字段白名单」
 * 构建——env 原文、来源地址、凭据没有任何通道进入摘要对象（读 env 处连原文
 * 都不回显进错误消息，只报变量名与要求）。
 *
 * 数值来源：docs/specs/010-online-vod/tasks.md T019 与 contracts/api.md §0
 * （逐字对照见 domain/vod-budgets.ts 头注）；本文件不新增任何契约数值。
 *
 * env 变量表（缺省 = VOD_BUDGETS 对应字段；字节均为整数字节，时间为整毫秒）：
 * | 变量                                    | 缺省（VOD_BUDGETS）            |
 * | VOD_SEARCH_TIMEOUT_MS                  | search.totalTimeoutMs = 8000  |
 * | VOD_SEARCH_CONCURRENCY                 | search.concurrency = 3        |
 * | VOD_PREVIEW_TIMEOUT_MS                 | preview.totalTimeoutMs = 8000 |
 * | VOD_PREVIEW_MAX_BYTES                  | preview.maxBytes = 4194304    |
 * | VOD_MAX_ENABLED_SOURCES                | catalog.maxEnabledSources = 10 |
 * | VOD_MAX_PARENT_TITLES                  | catalog.maxParentTitles = 5000 |
 * | VOD_MAX_CHILD_EPISODES                 | catalog.maxChildEpisodes = 100000 |
 * | VOD_DETAIL_MAX_LINES                   | detail.maxLines = 20          |
 * | VOD_DETAIL_MAX_EPISODES_PER_LINE       | detail.maxEpisodesPerLine = 2000 |
 * | VOD_DETAIL_MAX_EPISODES_TOTAL          | detail.maxEpisodesTotal = 5000 |
 * | VOD_DETAIL_MAX_BYTES                   | detail.maxBytes = 4194304     |
 * | VOD_MAX_ACTIVE_SEARCHES_PER_HOUSEHOLD  | households.maxActiveSearchesPerHousehold = 100 |
 * | VOD_MAX_ACTIVE_PREVIEWS_PER_HOUSEHOLD  | households.maxActivePreviewsPerHousehold = 1000 |
 * | VOD_CACHE_MAX_TOTAL_BYTES              | cache.maxTotalBytes = 268435456 |
 * | VOD_PUBLIC_QUERY_RATE_PER_IP_PER_MIN   | rateLimits.publicQueryPerIpPerMinute = 120 |
 * | VOD_SEARCH_RATE_PER_IP_PER_MIN         | rateLimits.vodSearchPerIpPerMinute = 20 |
 */

import type { FactoryProvider } from '@nestjs/common';
import { assertWithinBudget, VOD_BUDGETS } from '../domain/vod-budgets';
import type { VodBudgetShape } from '../domain/vod-budgets';

/** 运行期生效配置：数值形态与 VOD_BUDGETS 一一对应（可收紧），附脱敏摘要方法 */
export interface VodRuntimeConfig extends VodBudgetShape {
  /** 结构化脱敏摘要：单行字符串，只含数值预算字段，绝不含来源地址/凭据/env 原文 */
  toString(): string;
  /** 结构化脱敏日志形态：点路径 → 数值（白名单构建），供 logger 直接消费 */
  toLogForm(): VodConfigLogForm;
}

/** 摘要形态：点路径（VOD_BUDGETS 字段名）→ 数值；只允许数值字段进入 */
export type VodConfigLogForm = Record<string, number>;

/** online-vod 配置注入令牌（本文件就地声明；tokens.ts 归属调整归后续任务） */
export const VOD_RUNTIME_CONFIG = Symbol('VOD_RUNTIME_CONFIG');

/**
 * 读一组 env 得到运行期生效配置：
 * - 未设置/空串 → 取 VOD_BUDGETS 契约缺省；
 * - 非法（非安全整数或 <1）→ fail-fast 抛错（不回显 env 原文）；
 * - 超出契约上限 → fail-fast 抛错（env 只允许收紧，不允许放大契约冻结值）。
 * 输出经 assertWithinBudget 复核后冻结，防止装配后被改写。
 */
export function loadVodRuntimeConfig(env: NodeJS.ProcessEnv = process.env): VodRuntimeConfig {
  const effective: VodBudgetShape = {
    search: {
      totalTimeoutMs: readBoundedInt(env, 'VOD_SEARCH_TIMEOUT_MS', VOD_BUDGETS.search.totalTimeoutMs),
      concurrency: readBoundedInt(env, 'VOD_SEARCH_CONCURRENCY', VOD_BUDGETS.search.concurrency),
    },
    preview: {
      totalTimeoutMs: readBoundedInt(env, 'VOD_PREVIEW_TIMEOUT_MS', VOD_BUDGETS.preview.totalTimeoutMs),
      maxBytes: readBoundedInt(env, 'VOD_PREVIEW_MAX_BYTES', VOD_BUDGETS.preview.maxBytes),
    },
    catalog: {
      maxEnabledSources: readBoundedInt(env, 'VOD_MAX_ENABLED_SOURCES', VOD_BUDGETS.catalog.maxEnabledSources),
      maxParentTitles: readBoundedInt(env, 'VOD_MAX_PARENT_TITLES', VOD_BUDGETS.catalog.maxParentTitles),
      maxChildEpisodes: readBoundedInt(env, 'VOD_MAX_CHILD_EPISODES', VOD_BUDGETS.catalog.maxChildEpisodes),
    },
    detail: {
      maxLines: readBoundedInt(env, 'VOD_DETAIL_MAX_LINES', VOD_BUDGETS.detail.maxLines),
      maxEpisodesPerLine: readBoundedInt(
        env,
        'VOD_DETAIL_MAX_EPISODES_PER_LINE',
        VOD_BUDGETS.detail.maxEpisodesPerLine,
      ),
      maxEpisodesTotal: readBoundedInt(env, 'VOD_DETAIL_MAX_EPISODES_TOTAL', VOD_BUDGETS.detail.maxEpisodesTotal),
      maxBytes: readBoundedInt(env, 'VOD_DETAIL_MAX_BYTES', VOD_BUDGETS.detail.maxBytes),
    },
    households: {
      maxActiveSearchesPerHousehold: readBoundedInt(
        env,
        'VOD_MAX_ACTIVE_SEARCHES_PER_HOUSEHOLD',
        VOD_BUDGETS.households.maxActiveSearchesPerHousehold,
      ),
      maxActivePreviewsPerHousehold: readBoundedInt(
        env,
        'VOD_MAX_ACTIVE_PREVIEWS_PER_HOUSEHOLD',
        VOD_BUDGETS.households.maxActivePreviewsPerHousehold,
      ),
    },
    cache: {
      maxTotalBytes: readBoundedInt(env, 'VOD_CACHE_MAX_TOTAL_BYTES', VOD_BUDGETS.cache.maxTotalBytes),
    },
    rateLimits: {
      publicQueryPerIpPerMinute: readBoundedInt(
        env,
        'VOD_PUBLIC_QUERY_RATE_PER_IP_PER_MIN',
        VOD_BUDGETS.rateLimits.publicQueryPerIpPerMinute,
      ),
      vodSearchPerIpPerMinute: readBoundedInt(
        env,
        'VOD_SEARCH_RATE_PER_IP_PER_MIN',
        VOD_BUDGETS.rateLimits.vodSearchPerIpPerMinute,
      ),
    },
  };
  assertWithinBudget(effective);

  // 数值字段白名单：摘要的唯一来源；这里之外没有字段可进入日志形态（脱敏机制本身）。
  const logForm: VodConfigLogForm = buildLogForm(effective);
  return Object.freeze({
    ...effective,
    toLogForm(): VodConfigLogForm {
      return { ...logForm };
    },
    toString(): string {
      return `VodRuntimeConfig(${JSON.stringify(logForm)})`;
    },
  });
}

/**
 * Nest provider 工厂（FactoryProvider 形态）：DI 解析时才读 env（惰性、可测），
 * 纯值工厂，不实例化连接/客户端。绑定进 online-vod.module.ts 的 providers 归
 * 后续任务（010 T006 骨架不动；消费方以 VOD_RUNTIME_CONFIG 令牌注入）。
 */
export function vodConfigProvider(): FactoryProvider<VodRuntimeConfig> {
  return {
    provide: VOD_RUNTIME_CONFIG,
    useFactory: () => loadVodRuntimeConfig(),
  };
}

/* ------------------------------------------------------------------ */
/* 内部辅助                                                             */
/* ------------------------------------------------------------------ */

/**
 * 有界整数读法：缺省 = cap（即 VOD_BUDGETS 契约值）；
 * 非法或超出 cap 时 fail-fast。错误消息只含变量名与界限值，绝不回显 env 原文
 * （误配置可能含敏感串，脱敏纪律从装配面开始）。
 */
function readBoundedInt(env: NodeJS.ProcessEnv, key: string, cap: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') {
    return cap;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`VOD 预算 env 非法(fail-fast，需为 1..${cap} 的安全整数): ${key}`);
  }
  if (parsed > cap) {
    throw new Error(`VOD 预算 env 超出契约上限(env 只允许收紧，契约值 ${cap}): ${key}`);
  }
  return parsed;
}

/** 数值白名单摘要构建（点路径与 domain/vod-budgets.ts VOD_BUDGETS 字段一一对应） */
function buildLogForm(s: VodBudgetShape): VodConfigLogForm {
  return {
    'search.totalTimeoutMs': s.search.totalTimeoutMs,
    'search.concurrency': s.search.concurrency,
    'preview.totalTimeoutMs': s.preview.totalTimeoutMs,
    'preview.maxBytes': s.preview.maxBytes,
    'catalog.maxEnabledSources': s.catalog.maxEnabledSources,
    'catalog.maxParentTitles': s.catalog.maxParentTitles,
    'catalog.maxChildEpisodes': s.catalog.maxChildEpisodes,
    'detail.maxLines': s.detail.maxLines,
    'detail.maxEpisodesPerLine': s.detail.maxEpisodesPerLine,
    'detail.maxEpisodesTotal': s.detail.maxEpisodesTotal,
    'detail.maxBytes': s.detail.maxBytes,
    'households.maxActiveSearchesPerHousehold': s.households.maxActiveSearchesPerHousehold,
    'households.maxActivePreviewsPerHousehold': s.households.maxActivePreviewsPerHousehold,
    'cache.maxTotalBytes': s.cache.maxTotalBytes,
    'rateLimits.publicQueryPerIpPerMinute': s.rateLimits.publicQueryPerIpPerMinute,
    'rateLimits.vodSearchPerIpPerMinute': s.rateLimits.vodSearchPerIpPerMinute,
  };
}
