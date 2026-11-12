/**
 * EPG 来源合并看板(018 IPTV 管理优化;由 settings-iptv-page.tsx 的「节目单」
 * 标签整体承载 —— 合并裁决:来源清单与优先级是同一批 EPG 源的两个投影,
 * 拆成两列展示会让同一来源出现两次、停用源在优先级视图里凭空消失):
 *
 * - 合并读取:GET /settings/sources(全类型分页,本地过滤 kind=epg,含停用源)
 *   × GET /settings/sources/epg-priorities(契约 016 §3.1,启用源 priority ASC);
 *   按 sourceId 合并 —— 每源恰一行,停用源不缺行(无优先级投影时排尾部,
 *   频道数/上次同步仅在 DTO 提供时呈现,绝不臆造计数);
 * - 行内能力:上移/下移排序(本地草稿)、立即同步(POST refresh,幂等 operationKey,
 *   与来源管理同一语义)、启停开关(PATCH expectedVersion CAS)、任务状态呈现
 *   (awaiting_confirmation 确认/丢弃、失败提示、进行中不确定进度 —— 服务端不提供
 *   百分比,不臆造;轮询 useSettingsPolling 授权失效即终止);
 * - 「保存排序」统一提交 PUT(契约 016 §3.2):显示序(含停用源)重排为 1..N 连续
 *   整数,body 恰 { priorities: [{ sourceId, priority }] };保存语义复用既有契约
 *   (级联刷新由服务端自动入队);草稿在保存成功前始终保留,失败可修正重试;
 * - 取消按钮丢弃草稿回服务端现序;未保存期间 useUnsavedGuard 拦截离开;
 * - 失败呈现稳定语义文案(role=alert,403 权限 / 400 校验 / 404 不存在),
 *   useAppMutation 内建 toast 通道经 onToast 置空避免双重提示;
 * - 403 access-lost 接线 handleAccessLost(门禁判断在 SettingsGuard/AdminRouteGuard
 *   体系,本区块不重复鉴权)。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, ProgressBar, Switch } from '@heroui/react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { LoadingSpinner, RetryableAlert, useAppToast } from '../../shared/ui';
import { useAppMutation, useAppQuery } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import { formatApiError } from '../../shared/query/error';
import { privateFetch } from '../../shared/fetch';
import { classifySettingsWriteError, useSettingsPolling } from './shared/access-expiry';
import { useUnsavedGuard } from './shared/unsaved-guard';
import { useSettingsAccess } from './settings-access-provider';
import { fetchAllSettingsSources, type RefreshDto, type SourceDto, type SourcePageDto } from './shared/settings-api';
import type { EpgSourcePriorityDto } from '@hmp/shared';

/** 契约 016 §3.1:GET 响应(sources 按 priority ASC;仅启用源) */
interface EpgSourcePriorityPageDto {
  sources: EpgSourcePriorityDto[];
}

/** 契约 016 §3.2:PUT 响应 */
interface EpgPrioritiesSaveResult {
  success: boolean;
  updatedCount: number;
}

/**
 * 查询键:锚定工厂 settings.epg 派生(T025 所有权不含 shared/query/keys.ts,
 * 不新增工厂条目):前缀失效(settings.epg)天然覆盖本键;settings 域挂载即清
 * (gcTime 0)且 Tabs 非激活面板不挂载,与「频道管理」标签无缓存互串。
 */
const PRIORITIES_QUERY_KEY = [...queryKeys.settings.epg(), 'priorities'] as const;

/** 手动同步 operationKey:客户端生成 UUID(幂等键,服务端去重;与来源管理页同款) */
function newOperationKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isTerminal(status: RefreshDto['status']): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'discarded' ||
    status === 'expired' ||
    status === 'stale' ||
    status === 'interrupted'
  );
}

/** 合并行:来源清单行 × 优先级投影(无投影 = 停用源,channelCount/lastSyncAt 缺席) */
interface MergedEpgSourceRow {
  source: SourceDto;
  priority: EpgSourcePriorityDto | null;
}

/** 保存前的显示序 → 契约 PUT body:priority 重排为 1..N 连续整数(含停用源) */
function draftPrioritiesPayload(rows: MergedEpgSourceRow[]): Array<{ sourceId: string; priority: number }> {
  return rows.map((row, index) => ({ sourceId: row.source.id, priority: index + 1 }));
}

/** 时间呈现跟随页面既有惯例(ISO 截取;null → 未同步) */
function formatSyncTime(lastSyncAt: string): string {
  return lastSyncAt.slice(0, 19).replace('T', ' ');
}

export function SettingsEpgPriorities(): ReactNode {
  const access = useSettingsAccess();
  const toast = useAppToast();
  /** 本地草稿序(sourceId 有序数组;null = 无草稿,展示服务端真值) */
  const [draftOrder, setDraftOrder] = useState<string[] | null>(null);
  /** 保存成功的行内反馈(role=status;有新草稿动作时让位清除) */
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  /** 保存失败的稳定语义错误面(role=alert) */
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 任务状态表(与来源管理页同款:lastJobId 补读 + 进行中轮询) */
  const [jobs, setJobs] = useState<Record<string, RefreshDto>>({});

  // 来源清单(全类型分页;本地过滤 kind=epg —— 含停用源,合并主集合)
  const sourcesQuery = useAppQuery<SourcePageDto>({
    domain: 'settings',
    queryKey: queryKeys.settings.sources(),
    queryFn: ({ signal }) => fetchAllSettingsSources(signal),
  });
  const prioritiesQuery = useAppQuery<EpgSourcePriorityPageDto>({
    domain: 'settings',
    queryKey: PRIORITIES_QUERY_KEY,
    queryFn: ({ signal }) =>
      privateFetch<EpgSourcePriorityPageDto>('/settings/sources/epg-priorities?includeDisabled=true', { signal }),
  });

  // 读取 403 SETTINGS_ACCESS_*/FORBIDDEN:回锁定态(解锁门随之隐藏本区块)
  useEffect(() => {
    const queries = [sourcesQuery, prioritiesQuery];
    for (const query of queries) {
      if (query.isError && classifySettingsWriteError(query.error) === 'access-lost') {
        access.handleAccessLost();
        return;
      }
    }
  }, [sourcesQuery.isError, sourcesQuery.error, prioritiesQuery.isError, prioritiesQuery.error, access]);

  /** 已补读状态的任务(避免失效重读后对同一任务重复引导读取) */
  const bootstrappedRef = useRef<Set<string>>(new Set());

  // 列表回填时对来源上的最近任务补一次状态读取(进行中的任务随后进入轮询)
  useEffect(() => {
    const items = sourcesQuery.data?.items;
    if (items === undefined) {
      return;
    }
    for (const source of items) {
      if (source.kind !== 'epg') {
        continue;
      }
      const jobId = source.lastJobId;
      if (jobId === null || bootstrappedRef.current.has(jobId)) {
        continue;
      }
      bootstrappedRef.current.add(jobId);
      void privateFetch<RefreshDto>(`/settings/refreshes/${jobId}`)
        .then((job) => {
          setJobs((current) => ({ ...current, [job.id]: job }));
        })
        .catch((jobError: unknown) => {
          bootstrappedRef.current.delete(jobId);
          if (classifySettingsWriteError(jobError) === 'access-lost') {
            access.handleAccessLost();
          }
          // 单个任务不可见不阻塞合并看板
        });
    }
  }, [sourcesQuery.data, access]);

  const epgSources = useMemo(
    () => (sourcesQuery.data?.items ?? []).filter((source) => source.kind === 'epg'),
    [sourcesQuery.data],
  );

  /** 合并:每源一行(停用源不缺行);基准序 = 启用源(优先级投影 priority ASC)→ 停用源(清单序) */
  const serverRows = useMemo<MergedEpgSourceRow[]>(() => {
    const byId = new Map(epgSources.map((source) => [source.id, source]));
    const rows: MergedEpgSourceRow[] = [];
    const seen = new Set<string>();
    for (const priority of prioritiesQuery.data?.sources ?? []) {
      const source = byId.get(priority.sourceId);
      if (source === undefined) {
        continue; // 优先级视图与清单不同步时以清单为准(失效重读收敛)
      }
      rows.push({ source, priority });
      seen.add(source.id);
    }
    for (const source of epgSources) {
      if (!seen.has(source.id)) {
        rows.push({ source, priority: null });
      }
    }
    return rows;
  }, [epgSources, prioritiesQuery.data]);
  const serverOrder = useMemo(() => serverRows.map((row) => row.source.id), [serverRows]);

  // 草稿有效性:覆盖服务端现集合(缺源/多源即作废,服务端真值优先)
  const draftCoversServer =
    draftOrder !== null &&
    draftOrder.length === serverOrder.length &&
    serverOrder.every((id) => draftOrder.includes(id));
  const displayRows = useMemo<MergedEpgSourceRow[]>(() => {
    if (draftOrder === null || !draftCoversServer) {
      return serverRows;
    }
    const byId = new Map(serverRows.map((row) => [row.source.id, row]));
    return draftOrder.flatMap((id) => {
      const row = byId.get(id);
      return row === undefined ? [] : [row];
    });
  }, [draftOrder, draftCoversServer, serverRows]);
  const isDirty = draftCoversServer && serverOrder.some((id, index) => draftOrder?.[index] !== id);

  const guard = useUnsavedGuard(isDirty);

  /** 草稿重排(仅本地;保存按钮统一提交) */
  const moveRow = (index: number, direction: -1 | 1): void => {
    const current = displayRows.map((row) => row.source.id);
    const target = index + direction;
    if (target < 0 || target >= current.length) {
      return;
    }
    const next = [...current];
    const moved = next[index]!;
    next[index] = next[target]!;
    next[target] = moved;
    setDraftOrder(next);
    setSavedNotice(null); // 新草稿动作让位:成功反馈不再代表当前状态
  };

  /** 丢弃草稿回服务端现序(未保存改动取消;守卫随 isDirty 归位解除) */
  const cancelDraft = (): void => {
    setDraftOrder(null);
    setSaveError(null);
    setSavedNotice(null);
  };

  // 任务状态轮询:仅跟踪进行中/待确认任务;授权失效由 useSettingsPolling 立即终止
  const tracked = Object.values(jobs).filter((job) => !isTerminal(job.status));
  useSettingsPolling(
    useCallback(async () => {
      for (const job of tracked) {
        const fresh = await privateFetch<RefreshDto>(`/settings/refreshes/${job.id}`);
        setJobs((current) => ({ ...current, [fresh.id]: fresh }));
        if (fresh.status === 'succeeded' || fresh.status === 'failed') {
          void sourcesQuery.refetch(); // 发布成功/失败:回填来源清单(lastSuccessAt/任务入口)
          void prioritiesQuery.refetch();
        }
      }
    }, [tracked, sourcesQuery, prioritiesQuery]),
    { intervalMs: 1000, enabled: tracked.length > 0 },
  );

  // 立即同步:POST refresh(幂等 operationKey;成功失效来源清单回填真值)
  const startRefresh = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { sourceId: string; expectedVersion: number; operationKey: string }) =>
      privateFetch<RefreshDto>(`/settings/sources/${vars.sourceId}/refresh`, {
        method: 'POST',
        body: { expectedVersion: vars.expectedVersion, operationKey: vars.operationKey },
      }),
    invalidate: [queryKeys.settings.sources()],
  });

  // 启停:PATCH expectedVersion CAS(与来源管理页同一语义)
  const patchSource = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { sourceId: string; input: Record<string, unknown> }) =>
      privateFetch<SourceDto>(`/settings/sources/${vars.sourceId}`, {
        method: 'PATCH',
        body: { ...vars.input },
      }),
    invalidate: [queryKeys.settings.sources()],
  });

  // 快照确认/丢弃(awaiting_confirmation 交互保留;任务当前版本 CAS)
  const settleRefresh = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { jobId: string; action: 'confirm' | 'discard'; expectedVersion: number }) =>
      privateFetch<RefreshDto>(`/settings/refreshes/${vars.jobId}/${vars.action}`, {
        method: 'POST',
        body: { expectedVersion: vars.expectedVersion },
      }),
    invalidate: [queryKeys.settings.sources()],
  });

  // 保存:confirmed 等待态 + 成功失效本键(服务端真值回填,级联刷新由服务端自动入队)。
  // 内建 toast 通道置空:错误统一由本区块稳定错误面(role=alert)呈现。
  const savePriorities = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    onToast: () => {},
    mutationFn: (vars: { priorities: Array<{ sourceId: string; priority: number }> }) =>
      privateFetch<EpgPrioritiesSaveResult>('/settings/sources/epg-priorities', {
        method: 'PUT',
        body: { priorities: vars.priorities },
      }),
    invalidate: [PRIORITIES_QUERY_KEY],
  });

  /** 统一失败分流:授权丢失立即隐藏;冲突提示重读;其余经数据层 toast 呈现 */
  const handleMutationFailure = (cause: unknown, conflictMessage: string): void => {
    const kind = classifySettingsWriteError(cause);
    if (kind === 'access-lost') {
      access.handleAccessLost();
      return;
    }
    if (kind === 'conflict') {
      toast.error(conflictMessage);
      return; // 列表回填由 invalidate 驱动
    }
    // 其余拒绝由 useAppMutation onError 统一经 toast 呈现
  };

  const runSync = (row: MergedEpgSourceRow): void => {
    void startRefresh
      .mutateAsync({
        sourceId: row.source.id,
        expectedVersion: row.source.version,
        operationKey: newOperationKey(),
      })
      .then((job) => {
        setJobs((current) => ({ ...current, [job.id]: job }));
        toast.success(`同步任务已创建(状态 ${job.status}),正在轮询任务状态…`);
      })
      .catch((cause: unknown) => {
        handleMutationFailure(cause, '来源已被其他操作修改(版本冲突):列表已按服务端现值刷新,请重试。');
      });
  };

  const toggleSource = (row: MergedEpgSourceRow): void => {
    void patchSource
      .mutateAsync({
        sourceId: row.source.id,
        input: { expectedVersion: row.source.version, enabled: !row.source.enabled },
      })
      .then(() => {
        toast.success('来源已保存');
      })
      .catch((cause: unknown) => {
        handleMutationFailure(cause, '来源已被其他操作修改(版本冲突):列表已按服务端现值刷新,请重试。');
      });
  };

  const settleJob = (job: RefreshDto, action: 'confirm' | 'discard'): void => {
    void settleRefresh
      .mutateAsync({ jobId: job.id, action, expectedVersion: job.version })
      .then((fresh) => {
        setJobs((current) => ({ ...current, [fresh.id]: fresh }));
        toast.success(fresh.status === 'succeeded' ? '快照已确认发布' : '快照已丢弃,上次成功目录保留');
      })
      .catch((cause: unknown) => {
        handleMutationFailure(cause, '任务状态已变化(版本冲突):请以最新任务状态重新操作。');
      });
  };

  /** 保存失败分流:稳定语义文案(403/400/404)落 role=alert 错误面;草稿保留可重试 */
  const handleSaveFailure = (cause: unknown): void => {
    const kind = classifySettingsWriteError(cause);
    if (kind === 'access-lost') {
      access.handleAccessLost();
      setSaveError('权限已失效(HTTP 403):请重新验证主管理员身份后再调整 EPG 源优先级。');
      return;
    }
    if (kind === 'validation') {
      setSaveError('优先级数据未通过校验(HTTP 400):请刷新页面后重试。');
      return;
    }
    if (kind === 'not-found') {
      setSaveError('部分 EPG 来源已不存在(HTTP 404):列表将按服务端现值刷新,请重新调整后再保存。');
      setDraftOrder(null);
      void sourcesQuery.refetch();
      void prioritiesQuery.refetch();
      return;
    }
    setSaveError(formatApiError(cause));
  };

  /** 保存排序:显示序(含停用源)重排 1..N 提交;草稿保留至成功(失败可修正重试) */
  const runSave = (): void => {
    setSaveError(null);
    void savePriorities
      .mutateAsync({ priorities: draftPrioritiesPayload(displayRows) })
      .then((result) => {
        setDraftOrder(null);
        setSavedNotice(`已保存 ${result.updatedCount} 个节目单来源的排序，将按新顺序匹配节目单。`);
        toast.success('EPG 源优先级已保存');
      })
      .catch((cause: unknown) => {
        handleSaveFailure(cause);
      });
  };

  const isSaving = savePriorities.isPending;
  const isPending = sourcesQuery.isPending || prioritiesQuery.isPending;
  // 优先级投影失败不阻断来源清单(降级:无投影 → 清单序 + 计数缺席);清单失败为致命错误面
  const prioritiesError = prioritiesQuery.isError ? prioritiesQuery.error : null;
  const queryError = sourcesQuery.isError ? sourcesQuery.error : null;
  const retryQuery = (): void => {
    if (sourcesQuery.isError) {
      void sourcesQuery.refetch();
    }
    if (prioritiesQuery.isError) {
      void prioritiesQuery.refetch();
    }
  };

  return (
    <section aria-label="EPG 来源与优先级" className="flex flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-sm font-semibold text-foreground">EPG 来源与优先级</h2>
          <p className="text-xs text-muted">按列表顺序匹配节目单，优先使用靠前的已启用来源。</p>
        </div>
        <div className="flex items-center gap-2">
          {isDirty ? (
            <span role="status" data-testid="epg-priorities-dirty" className="text-xs text-warning">
              未保存的排序调整
            </span>
          ) : null}
          {isDirty ? (
            <Button variant="ghost" size="sm" onPress={cancelDraft} data-testid="epg-priorities-cancel">
              取消
            </Button>
          ) : null}
          <Button
            variant={isDirty ? 'primary' : 'secondary'}
            size="sm"
            isDisabled={!isDirty || isSaving}
            onPress={runSave}
            data-testid="epg-priorities-save"
          >
            保存排序
          </Button>
        </div>
      </div>

      {isPending ? <LoadingSpinner label="正在读取 EPG 来源…" /> : null}
      {queryError !== null ? (
        <RetryableAlert title="读取失败" description={formatApiError(queryError)} onRetry={retryQuery} />
      ) : null}
      {prioritiesError !== null ? (
        <RetryableAlert
          title="优先级读取失败"
          description={`${formatApiError(prioritiesError)}(暂按来源清单排序,可重试)`}
          onRetry={() => void prioritiesQuery.refetch()}
        />
      ) : null}
      {!isPending && queryError === null ? (
        <>
          {saveError !== null ? (
            <p role="alert" data-testid="epg-priorities-error" className="text-sm text-danger">
              {saveError}
            </p>
          ) : null}
          {savedNotice !== null ? (
            <p role="status" data-testid="epg-priorities-status" className="text-sm text-success">
              {savedNotice}
            </p>
          ) : null}
          {displayRows.length === 0 ? (
            <p className="text-sm text-muted">暂无节目单来源。点击右上角「新建来源」添加节目单，再开始同步。</p>
          ) : (
            <ol aria-label="EPG 来源优先级列表" data-testid="epg-priorities-list" className="flex flex-col gap-2">
              {displayRows.map((row, index) => {
                const { source, priority } = row;
                const job = source.lastJobId !== null ? (jobs[source.lastJobId] ?? null) : null;
                return (
                  <li
                    key={source.id}
                    data-testid={`epg-priority-row-${source.id}`}
                    className={`flex flex-col gap-3 rounded-xl border border-border/30 px-4 py-3 ${
                      source.enabled ? 'bg-surface/40' : 'bg-surface/20'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="truncate text-sm font-medium text-foreground">{source.name}</span>
                        <span className="truncate text-xs text-muted" data-testid={`epg-source-domain-${source.id}`}>
                          {source.locationLabel}
                        </span>
                        <span className="text-xs text-muted">
                          {priority !== null ? `${priority.channelCount} 个频道` : '频道数量暂不可用'}
                          {source.lastSuccessAt !== null
                            ? ` · 上次成功同步 ${formatSyncTime(source.lastSuccessAt)}`
                            : ' · 尚无成功导入'}
                        </span>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                        <Button
                          variant="secondary"
                          size="sm"
                          onPress={() => runSync(row)}
                          isDisabled={!source.enabled}
                          className="text-foreground"
                          data-testid={`epg-source-sync-${source.id}`}
                        >
                          立即同步
                        </Button>
                        <Switch
                          isSelected={source.enabled}
                          onChange={() => toggleSource(row)}
                          aria-label={`${source.enabled ? '停用' : '启用'} ${source.name}`}
                        >
                          <Switch.Content data-testid={`epg-source-toggle-${source.id}`}>
                            <Switch.Control>
                              <Switch.Thumb />
                            </Switch.Control>
                            <span className="select-none text-xs text-muted">
                              {source.enabled ? '已启用' : '已停用'}
                            </span>
                          </Switch.Content>
                        </Switch>
                        <Button
                          variant="ghost"
                          size="sm"
                          isIconOnly
                          isDisabled={index === 0 || isSaving}
                          onPress={() => moveRow(index, -1)}
                          aria-label={`上移 ${source.name}`}
                          data-testid={`epg-priority-up-${source.id}`}
                        >
                          <ArrowUp size={16} aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          isIconOnly
                          isDisabled={index === displayRows.length - 1 || isSaving}
                          onPress={() => moveRow(index, 1)}
                          aria-label={`下移 ${source.name}`}
                          data-testid={`epg-priority-down-${source.id}`}
                        >
                          <ArrowDown size={16} aria-hidden="true" />
                        </Button>
                      </div>
                    </div>

                    {job !== null && job.status === 'awaiting_confirmation' ? (
                      <div
                        className="flex flex-col gap-2.5 rounded-xl border border-warning/30 bg-warning-soft/20 p-3 sm:flex-row sm:items-center sm:justify-between"
                        data-testid={`epg-source-job-${source.id}`}
                      >
                        <div className="flex flex-col gap-0.5 text-xs">
                          <span className="font-medium text-warning">待确认快照 (awaiting_confirmation)</span>
                          <span className="text-muted">
                            {job.counts != null
                              ? `新增 ${job.counts.added} · 更新 ${job.counts.updated} · 缺失 ${job.counts.missing}`
                              : '就绪'}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="primary"
                            size="sm"
                            onPress={() => settleJob(job, 'confirm')}
                            data-testid={`job-confirm-${job.id}`}
                          >
                            确认发布
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            onPress={() => settleJob(job, 'discard')}
                            data-testid={`job-discard-${job.id}`}
                          >
                            丢弃快照
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    {job !== null && job.status === 'failed' ? (
                      <div
                        className="flex items-center rounded-xl border border-danger/30 bg-danger-soft/20 px-3.5 py-2.5 text-xs text-danger"
                        data-testid={`epg-source-job-${source.id}`}
                      >
                        <span>导入失败:上次成功目录已保留;可重试立即同步,不影响现有内容。</span>
                      </div>
                    ) : null}

                    {job !== null && (job.status === 'queued' || job.status === 'running') ? (
                      <div
                        className="flex flex-col gap-2 rounded-xl bg-surface-secondary/40 px-3.5 py-2.5 text-xs text-muted"
                        data-testid={`epg-source-job-${source.id}`}
                      >
                        <ProgressBar isIndeterminate aria-label={`${source.name} 同步进行中`} className="w-full">
                          <ProgressBar.Track>
                            <ProgressBar.Fill />
                          </ProgressBar.Track>
                        </ProgressBar>
                        <span>正在导入…</span>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </>
      ) : null}

      {guard.dialog}
    </section>
  );
}
