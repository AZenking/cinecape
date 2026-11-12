/**
 * 010 T028 — VOD 有界缓存 registry(infrastructure):opaque ref 签发/校验、
 * 搜索会话/预览快照的有界存储、TTL、每家庭活对象计数、进程总字节上限、
 * 固定来源顺序轮转指针、禁源/配置失配失效钩子与 dispose/shutdown 清理。
 *
 * 纯 TS 基础设施原语:唯一运行时依赖为 node:crypto(ref 随机源,可注入替换)
 * 与自身 domain(vod-budgets 缺省预算)。零网络、零 DB、零 Nest —— 有界性与
 * 淘汰策略全部确定性好测;计时取注入时钟(缺省 Date.now),无内部定时器
 * (到期惰性判定 + 显式 sweep;服务/装配层可周期调用)。
 *
 * 数值来源(逐字对照,不自创):
 * - docs/specs/010-online-vod/contracts/api.md §2 搜索段:「10min/最多 2000 结果;
 *   每家庭 100 个活搜索、1000 个活预览,全进程最多 256MiB、单详情 4MiB,
 *   超额拒绝或淘汰最早过期项,ref 失效 410。禁源/配置失配先失效缓存再拒绝旧页」;
 * - 每家庭 100/1000 与 256MiB 取 domain/vod-budgets.ts VOD_BUDGETS(T019 已承载);
 * - 10min TTL 与 2000 结果属 api §2 缓存段契约值,VOD_BUDGETS(T019 范围)未承载,
 *   以本文件 VOD_SEARCH_SESSION_TTL_MS / (结果上限在 search.service.ts) 为过渡登记点
 *   (对齐 PC_005_PROBLEM_CODES 的「唯一过渡登记点」惯例,共享包收编时迁移)。
 *
 * opaque ref 设计(任务钉面「HMAC 或随机+注册表,不可解码:ref→内部键只在注册表可逆」):
 * - ref = 类别前缀 + `v1` + base64url(随机 128bit):不含源地址、源配置 ID、家庭 ID、
 *   上游键或任何可解码载荷;仅注册表 Map 可逆(ref → {entryId, local});
 * - 伪造/未签发 ref 解析即 undefined(消费方映射 404 同形);曾签发而过期的
 *   entry 在被物理淘汰前保持可解析且 expired=true(消费方映射 410,不与伪造混同);
 * - 注册表随 entry 淘汰/失效/dispose 一并清除,无第二生命周期。
 *
 * 淘汰策略(api §2「超额拒绝或淘汰最早过期项」):
 * - put 入场:同 (家庭, kind) 活对象满额 → 拒绝(false,消费方映射 429);
 *   同 id 重复 put 视为替换(预览快照覆写绑定),不受满额拦截;
 * - 总字节:先淘汰全部已过期项,再按「最早过期(次序:expiresAtMs 升序、
 *   createdAtMs 升序)」淘汰在活项直至容纳;单条即超上限 → 拒绝;
 * - 已过期项在被 sweep/淘汰前仍可读(expired=true),保证「ref 失效 410」窗口;
 *   sweep()/压力淘汰即物理清除(「成功明确删除不能 stale 复活」:evict/invalidate
 *   之后的 get 为 undefined,不可复活)。
 */

import { randomBytes } from 'node:crypto';
import { VOD_BUDGETS } from '../domain/vod-budgets';

/* ------------------------------------------------------------------ */
/* 契约常量(api.md §2 缓存段;VOD_BUDGETS 未承载值的过渡登记点)          */
/* ------------------------------------------------------------------ */

/** 搜索会话/预览缓存 TTL:api §2「10min」逐字(固定自创建起算,重放不延长) */
export const VOD_SEARCH_SESSION_TTL_MS = 600_000;

/** 缓存条目固定入账开销(键/元数据近似摊销;载荷字节数单独估算) */
const ENTRY_OVERHEAD_BYTES = 128;

/* ------------------------------------------------------------------ */
/* 类型                                                                 */
/* ------------------------------------------------------------------ */

/** 缓存条目类别:search=搜索会话(含已生成页/未消费队列);preview=预览快照与标题绑定 */
export type VodCacheKind = 'search' | 'preview';

/** opaque ref 类别(仅决定前缀字符;不含任何语义载荷) */
export type VodRefKind = 'search' | 'cursor' | 'source' | 'title' | 'line' | 'episode' | 'poster';

const REF_KIND_PREFIX: Record<VodRefKind, string> = {
  search: 's',
  cursor: 'c',
  source: 'r',
  title: 't',
  line: 'l',
  episode: 'e',
  poster: 'p',
} as const;

/** 缓存条目读视图(payload 泛型由消费方标注;expired=true 表示已过 TTL 未物理淘汰) */
export interface VodCacheEntryView<P = unknown> {
  readonly id: string;
  readonly householdId: string;
  readonly kind: VodCacheKind;
  /** 绑定的来源配置 ID(禁源/配置失配失效钩子的匹配键;绝不进入任何公共 DTO) */
  readonly sourceIds: readonly string[];
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  /** true = 已过 expiresAtMs(仍在册待淘汰;消费方映射 410) */
  readonly expired: boolean;
  /** 近似入账字节数(载荷估算 + 固定开销) */
  readonly bytes: number;
  readonly payload: P;
}

/** put 入参(幂等替换语义:同 id 重复 put = 原子替换并重估字节) */
export interface VodCachePutInput<P> {
  readonly id: string;
  readonly householdId: string;
  readonly kind: VodCacheKind;
  readonly sourceIds: readonly string[];
  /** 绝对到期 epoch ms(调用方按 now + TTL 计算;本 registry 不改写) */
  readonly expiresAtMs: number;
  readonly payload: P;
}

export interface VodCacheStats {
  readonly entries: number;
  /** 未过期的活条目数(每家庭上限的计数口径) */
  readonly activeEntries: number;
  readonly searchEntries: number;
  readonly previewEntries: number;
  readonly bytes: number;
  readonly refs: number;
}

export interface VodCacheOptions {
  /** 缺省 VOD_SEARCH_SESSION_TTL_MS(api §2 10min) */
  readonly ttlMs?: number;
  /** 缺省 VOD_BUDGETS.households.maxActiveSearchesPerHousehold(100) */
  readonly maxActiveSearchesPerHousehold?: number;
  /** 缺省 VOD_BUDGETS.households.maxActivePreviewsPerHousehold(1000) */
  readonly maxActivePreviewsPerHousehold?: number;
  /** 缺省 VOD_BUDGETS.cache.maxTotalBytes(256MiB) */
  readonly maxTotalBytes?: number;
  /** 注入时钟(测试确定性);缺省 Date.now */
  readonly nowMs?: () => number;
  /** ref 随机源注入(测试确定性);缺省 node:crypto 128bit base64url */
  readonly randomToken?: () => string;
}

/**
 * 有界缓存 registry(见文件头设计说明)。全部方法同步;异常路径仅表现为
 * 返回 false/undefined(资源忙/不存在),不排队、不等待(api §0「不堆无界队列」)。
 */
export interface VodCache {
  /** 生效 TTL ms(固定自创建起算,重放不延长) */
  readonly ttlMs: number;
  /** 生效总字节上限(淘汰与拒绝判定的依据) */
  readonly maxTotalBytes: number;
  /** 签发 opaque ref(未注册;仅 allocateRef 注册可逆映射) */
  issueRef(kind: VodRefKind): string;
  /** 签发并注册 ref → {entryId, local} 可逆映射;返回 ref 本体 */
  allocateRef(entryId: string, local: string, kind: VodRefKind): string;
  /** ref 反查(仅注册表可逆);未签发/已随条目清除 → undefined(消费方映射 404) */
  resolveRef(ref: string): { readonly entryId: string; readonly local: string } | undefined;
  /**
   * 写入/替换条目并重估字节;满额(每家庭活对象)或总字节容纳失败 → false
   * (消费方映射 429 资源忙)。同 id 替换不受满额拦截(预览快照覆写绑定)。
   */
  put<P>(input: VodCachePutInput<P>): boolean;
  /** 读条目(过期仍返回 expired=true 直至物理淘汰);不存在 → undefined */
  get<P = unknown>(id: string): VodCacheEntryView<P> | undefined;
  /** 显式删除(「成功明确删除不能 stale 复活」:同 id 不可再读、ref 一并失效) */
  evict(id: string): boolean;
  /**
   * 禁源/配置失配失效钩子(api §2「先失效缓存再拒绝旧页」):清除该家庭绑定
   * 此来源的全部缓存条目(两种 kind)及其 ref;返回清除条目数。
   */
  invalidateSource(householdId: string, sourceId: string): number;
  /** 固定来源顺序轮转起点:返回当前指针并前移(mod sourceCount;单调轮转) */
  nextRotationStart(householdId: string, sourceCount: number): number;
  /** 物理清除全部已过期条目及其 ref;返回清除条目数 */
  sweep(nowMs?: number): number;
  stats(): VodCacheStats;
  /** shutdown:清空全部条目/ref/指针;幂等,之后 put/get/ref 一律空转 */
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/* 内部记录与实现                                                       */
/* ------------------------------------------------------------------ */

interface EntryRecord {
  readonly id: string;
  readonly householdId: string;
  readonly kind: VodCacheKind;
  readonly sourceIds: readonly string[];
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  bytes: number;
  payload: unknown;
}

/** 载荷字节估算(JSON 序列化长度;循环结构/序列化失败按 0 计,不影响有界性判定方向) */
export function estimateVodCacheBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
  } catch {
    return 0;
  }
}

function defaultRandomToken(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * 创建有界缓存 registry。数值缺省全部取自 VOD_BUDGETS / api §2(见文件头);
 * options 仅允许收紧(装配侧以 VodRuntimeConfig 传入生效值)。
 */
export function createVodCache(options: VodCacheOptions = {}): VodCache {
  const ttlMs = options.ttlMs ?? VOD_SEARCH_SESSION_TTL_MS;
  const maxActiveSearchesPerHousehold =
    options.maxActiveSearchesPerHousehold ?? VOD_BUDGETS.households.maxActiveSearchesPerHousehold;
  const maxActivePreviewsPerHousehold =
    options.maxActivePreviewsPerHousehold ?? VOD_BUDGETS.households.maxActivePreviewsPerHousehold;
  const maxTotalBytes = options.maxTotalBytes ?? VOD_BUDGETS.cache.maxTotalBytes;
  const nowMs = options.nowMs ?? (() => Date.now());
  const randomToken = options.randomToken ?? defaultRandomToken;

  /** entryId → 条目(含已过期未淘汰) */
  const entries = new Map<string, EntryRecord>();
  /** ref → 可逆映射(仅注册表可逆;随条目清除) */
  const refs = new Map<string, { readonly entryId: string; readonly local: string }>();
  /** entryId → 该条目签发的全部 ref(级联清除用) */
  const refsByEntry = new Map<string, Set<string>>();
  /** 家庭 → 固定来源顺序轮转指针 */
  const rotationPointers = new Map<string, number>();
  let disposed = false;

  function dropEntry(record: EntryRecord): void {
    entries.delete(record.id);
    const bound = refsByEntry.get(record.id);
    if (bound !== undefined) {
      for (const ref of bound) {
        refs.delete(ref);
      }
      refsByEntry.delete(record.id);
    }
  }

  function householdKindCap(kind: VodCacheKind): number {
    return kind === 'search' ? maxActiveSearchesPerHousehold : maxActivePreviewsPerHousehold;
  }

  function activeCount(householdId: string, kind: VodCacheKind, atMs: number): number {
    let count = 0;
    for (const record of entries.values()) {
      if (record.householdId === householdId && record.kind === kind && record.expiresAtMs > atMs) {
        count += 1;
      }
    }
    return count;
  }

  function totalBytes(): number {
    let total = 0;
    for (const record of entries.values()) {
      total += record.bytes;
    }
    return total;
  }

  /** 压力淘汰:先清全部过期,再按最早过期(次淘汰序:expiresAtMs 升序 → createdAtMs 升序)清在活项 */
  function evictUntilFits(neededBytes: number): void {
    const atMs = nowMs();
    for (const record of [...entries.values()]) {
      if (totalBytes() + neededBytes <= maxTotalBytes) return;
      if (record.expiresAtMs <= atMs) dropEntry(record);
    }
    const byEarliestExpiry = [...entries.values()].sort((a, b) =>
      a.expiresAtMs !== b.expiresAtMs ? a.expiresAtMs - b.expiresAtMs : a.createdAtMs - b.createdAtMs,
    );
    for (const record of byEarliestExpiry) {
      if (totalBytes() + neededBytes <= maxTotalBytes) return;
      dropEntry(record);
    }
  }

  const cache: VodCache = {
    ttlMs,
    maxTotalBytes,

    issueRef(kind: VodRefKind): string {
      return `${REF_KIND_PREFIX[kind]}1-${randomToken()}`;
    },

    allocateRef(entryId: string, local: string, kind: VodRefKind): string {
      const ref = this.issueRef(kind);
      refs.set(ref, { entryId, local });
      let bound = refsByEntry.get(entryId);
      if (bound === undefined) {
        bound = new Set();
        refsByEntry.set(entryId, bound);
      }
      bound.add(ref);
      return ref;
    },

    resolveRef(ref: string) {
      if (disposed) return undefined;
      return refs.get(ref);
    },

    put<P>(input: VodCachePutInput<P>): boolean {
      if (disposed) return false;
      const atMs = nowMs();
      const existing = entries.get(input.id);
      if (existing === undefined) {
        const cap = householdKindCap(input.kind);
        if (activeCount(input.householdId, input.kind, atMs) >= cap) {
          return false;
        }
      }
      const bytes = estimateVodCacheBytes(input.payload) + ENTRY_OVERHEAD_BYTES;
      if (bytes > maxTotalBytes) {
        return false;
      }
      // 替换先摘旧账,再按新字节做压力判定(自身不计入压力来源)
      if (existing !== undefined) {
        // 010 恢复:同 id 替换只摘条目账,保留该条目已签发 ref(游标/标题/线路级联
        // 清除仅随 evict/invalidate/淘汰;persist 每次变异重写会话,清 ref 会使
        // 已生成游标在下一页即「未签发」,违反 api §2 续页/重放语义)
        entries.delete(existing.id);
      }
      evictUntilFits(bytes);
      if (totalBytes() + bytes > maxTotalBytes) {
        return false;
      }
      entries.set(input.id, {
        id: input.id,
        householdId: input.householdId,
        kind: input.kind,
        sourceIds: [...input.sourceIds],
        createdAtMs: existing?.createdAtMs ?? atMs,
        expiresAtMs: input.expiresAtMs,
        bytes,
        payload: input.payload,
      });
      return true;
    },

    get<P = unknown>(id: string): VodCacheEntryView<P> | undefined {
      if (disposed) return undefined;
      const record = entries.get(id);
      if (record === undefined) return undefined;
      const atMs = nowMs();
      return {
        id: record.id,
        householdId: record.householdId,
        kind: record.kind,
        sourceIds: record.sourceIds,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
        expired: record.expiresAtMs <= atMs,
        bytes: record.bytes,
        payload: record.payload as P,
      };
    },

    evict(id: string): boolean {
      const record = entries.get(id);
      if (record === undefined) return false;
      dropEntry(record);
      return true;
    },

    invalidateSource(householdId: string, sourceId: string): number {
      if (disposed) return 0;
      let removed = 0;
      for (const record of [...entries.values()]) {
        if (record.householdId === householdId && record.sourceIds.includes(sourceId)) {
          dropEntry(record);
          removed += 1;
        }
      }
      return removed;
    },

    nextRotationStart(householdId: string, sourceCount: number): number {
      if (sourceCount <= 0) return 0;
      const current = rotationPointers.get(householdId) ?? 0;
      const start = current % sourceCount;
      rotationPointers.set(householdId, (current + 1) % sourceCount);
      return start;
    },

    sweep(atMs?: number): number {
      if (disposed) return 0;
      const at = atMs ?? nowMs();
      let removed = 0;
      for (const record of [...entries.values()]) {
        if (record.expiresAtMs <= at) {
          dropEntry(record);
          removed += 1;
        }
      }
      return removed;
    },

    stats(): VodCacheStats {
      const atMs = nowMs();
      let activeEntries = 0;
      let searchEntries = 0;
      let previewEntries = 0;
      for (const record of entries.values()) {
        if (record.kind === 'search') searchEntries += 1;
        else previewEntries += 1;
        if (record.expiresAtMs > atMs) activeEntries += 1;
      }
      return {
        entries: entries.size,
        activeEntries,
        searchEntries,
        previewEntries,
        bytes: totalBytes(),
        refs: refs.size,
      };
    },

    dispose(): void {
      disposed = true;
      entries.clear();
      refs.clear();
      refsByEntry.clear();
      rotationPointers.clear();
    },
  };

  return cache;
}
