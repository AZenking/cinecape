# Internal Ports: 020-tmdb-programme-posters

日期：2026-11-13。遵循 DDD 分层与 ADR-0015 仓储 seam；跨上下文只经 `@contexts/epg` 发布面。

## 1. EPG 发布面（`@contexts/epg`）

```ts
// 纯函数：标题 → 归一化键（sources 发布事务写 epg_programme.poster_match_key 用）
export function posterMatchKeyOf(title: string): string | null;

export interface ProgrammePosterRef {
  readonly matchKey: string;
  readonly ref: string;
}

export interface ProgrammePosterEnrichmentSummary {
  readonly titles: number;
  readonly cacheHits: number;
  readonly lookups: number;
  readonly matched: number;
  readonly noMatch: number;
  readonly failed: number;
  readonly skipped: number;
  readonly durationMs: number;
}

export interface IEpgProgrammePosterService {
  /** 同步只读；仅返回 state=matched 且未过期的 ref；按 raw title 建 Map；零网络 */
  resolveCachedRefs(input: {
    readonly householdId: string;
    readonly titles: readonly string[];
    readonly nowMs: number;
  }): ReadonlyMap<string, ProgrammePosterRef>;

  /** 事务外网络补全 + 短事务写回；best-effort，不抛出业务错误（内部记录） */
  enrichAfterEpgPublish(input: {
    readonly householdId: string;
    readonly titles: readonly string[];
    readonly nowMs: number;
  }): Promise<ProgrammePosterEnrichmentSummary>;

  /** CLI/测试：补齐旧行 poster_match_key（分批） */
  backfillMatchKeys(input: {
    readonly householdId: string;
    readonly limit: number;
  }): number;
}
```

令牌：`EPG_PROGRAMME_POSTER_PORT`；`EpgModule` 以 `useValue`/`useFactory` 绑定并 exports；`SourcesModule` imports `EpgModule`，`RefreshExecutorService` 以 `@Optional() @Inject(EPG_PROGRAMME_POSTER_PORT)` 消费。

## 2. 仓储端口（`EpgStore` 扩展）

```ts
interface ProgrammePosterRow {
  householdId: string; matchKey: string; ref: string | null;
  state: 'matched' | 'no_match' | 'failed';
  tmdbId: number | null; mediaType: 'movie' | 'tv' | null;
  title: string | null; originalTitle: string | null;
  posterPath: string | null; releaseDate: string | null;
  voteAverage: number | null; popularity: number | null;
  matchScore: number | null; yearHint: number | null;
  attempts: number; lastAttemptAt: string | null;
  expiresAt: string; createdAt: string; updatedAt: string;
}

interface EpgStore {
  // 分块（≤500）读取；返回有效 matched 行
  listProgrammePosterRows(householdId: string, matchKeys: readonly string[]): ProgrammePosterRow[];
  findProgrammePosterByRef(householdId: string, ref: string): ProgrammePosterRow | undefined;
  listProgrammeMatchKeyCandidateRows(householdId: string, afterId: string | null, limit: number): Array<{ id: string; title: string }>;
  updateProgrammeMatchKeys(householdId: string, entries: ReadonlyArray<{ id: string; matchKey: string }>): void;
}

interface EpgTxStore {
  upsertProgrammePoster(row: ProgrammePosterRow): void;
  updateProgrammePosterRefs(householdId: string, entries: ReadonlyArray<{ matchKey: string; ref: string | null }>): void;
  deleteExpiredProgrammePosterRows(householdId: string, cutoffIso: string): number;
}
```

事务边界：
- `resolveCachedRefs` → 纯读，无事务。
- `enrichAfterEpgPublish` 的网络循环在事务外；结果写入 `epgStore().withTransaction`（upsert + 更新节目 ref + GC）。
- `publishEpgWindow` 仍在原单事务内；只做本地列写入，不联网。

## 3. 来源发布端口（`sources`）

```ts
interface EpgPublishParams {
  // ...既有字段
  readonly posterByTitle?: ReadonlyMap<string, ProgrammePosterRef>;
}
```

- `RefreshExecutorService.executeEpgJob` 在 `publishEpgWindow` 前调用 `resolveCachedRefs`；发布后 `await enrichAfterEpgPublish`。
- `publishEpgWindow` 按 `programme.title` 查 `posterByTitle`；缺失时 `posterMatchKeyOf(title)` 兜底，`poster_ref=NULL`。
- `insertEpgProgrammeIfAbsent` 增加 `posterMatchKey`/`posterRef`；`epgProgrammeHasPosterColumns()` 缺列守卫走旧 SQL。
- 发布事务写入 `poster_ref` 是缓存命中值；补全成功后同家庭所有当前 `poster_match_key` 行统一更新。

## 4. TMDB 客户端端口（仅 EPG 内部）

```ts
interface TmdbClient {
  searchMulti(input: {
    query: string; language: string; region: string;
  }): Promise<TmdbSearchResult[]>; // 已过滤/校验的最小结果
}
```

- 不导出到其他上下文；`EpgModule` 内 `TMDB_CLIENT` provider。
- 失败类型：`TmdbAuthError` / `TmdbRateLimitError` / `TmdbCircuitOpenError` / `TmdbUpstreamError`。
- 客户端不做缓存、不做匹配；缓存/匹配在 application/domain。

## 5. 公共代理端口

- `ProgrammePosterProxyService.fetch({ householdId, posterRef }): Promise<{ contentType; bytes }>`。
- 依赖 `EpgStore.findProgrammePosterByRef` + `SAFE_UPSTREAM_PORT` + `getConfig().TMDB_IMAGE_BASE_URL`。
- 允许目标：`{ kind: 'host', host: new URL(imageBase).hostname }`，不使用 `LAN_ALLOWED_TARGETS` 的 `public` 全放行。
- 预算：2 MiB / 8s / 4s / ≤3 跳（与 010/014 同量级）。

## 6. 禁止事项

- 读取路径不得调用 TMDB 客户端。
- `sources` 不得深导入 `epg/infrastructure/*` 或 `epg/application/*` 内部文件；只经 `@contexts/epg` 发布面。
- 公共 DTO/日志不得出现 TMDB ID、API Key、上游 URL、完整 `match_key` 列表或标题列表。
- 图片代理不得接受客户端指定 host/URL；只按 ref 查表并拼接配置基址。