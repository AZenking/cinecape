/**
 * 来源管理页(T134,US8;FR-037;T025 数据层迁移;010 T034 叠加 vod 增量;013/ADR-0017 演进):
 * - 来源列表经 useAppQuery(settings.sources 键,硬请求 + isPending 门控 /
 *   isError RetryableAlert(formatApiError + 重试)/ 成功出主体);
 * - 创建/启停字段修改/手动导入/快照确认与丢弃均为常规管理操作(013/ADR-0017:
 *   常规运维免当次密码;CAS/幂等 operationKey 语义照旧):等待服务端确认,成功后
 *   失效 settings.sources 键以服务端真值回填(替代原手工 load());任务状态在本页
 *   jobs 表局部承载并经 useSettingsPolling 轮询(授权失效即终止;任务读取无键工厂
 *   归属,见报告);
 * - 创建成功明确「开始导入」下一步;快照确认(awaiting_confirmation)提供确认/丢弃;
 * - 成功发布后提供「查看内容」入口;失败提示重试并保留上次成功目录(不自动清理);
 * - 409 冲突提示重读现值,不静默覆盖(失效重读);
 * - 403 SETTINGS_ACCESS_* 经 handleAccessLost 立即隐藏;重新解锁后重挂硬请求;
 * - 013/ADR-0017:本页全部操作均不再弹「当次密码」验证层;单次密码交互仅保留于
 *   高危面(撤销设备/档案 PIN/主档案转移,见对应页面),请求体一律不携带 ownerPassword
 *   (服务端 strict 契约拒绝未知字段)。
 *
 * 010 T034(US1 web 侧,叠加于既有 dirty 改动之上,零回退):
 * - kind=vod 创建分支(remoteUrl 必填、adapter 固定 apple-cms-json 展示;
 *   NAS/EPG 专属字段在 vod 下隐藏;创建体严格按 010 契约 VodCreateSourceRequest,
 *   不携带 enabled/privateAccessApproved——未知字段服务端拒绝);
 * - kind=vod 行内 capabilities 徽标(resume:operational/requiresCurrentProbe);
 * - 「测试」→ POST /settings/sources/:id/test(纯读探测)→ 结果行内展示
 *   (reachable/compatible/reason 中文文案;纯读不写媒体,不失效任何键);
 * - 编辑界面不提供根地址修改入口(PATCH 根地址服务端 400 拒绝,UI 不撒谎);
 * - 409 VOD_QUOTA_EXCEEDED 单列呈现(提示管理来源,不混入版本冲突文案);
 *   422 SOURCE_TARGET_DENIED 呈现服务端拒绝原因(detail 为稳定脱敏文案,无 URL 回显);
 * - 服务端拒绝优先:测试入口仅对 kind=vod 展示属体验优化,任何 4xx 响应
 *   (含未来契约变化)均原样经页面/数据层呈现,不以按钮隐藏代替服务端拒绝。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Button, Card, Chip, Disclosure, ProgressBar, Switch } from '@heroui/react';
import type { Vod } from '@hmp/shared';
import { LoadingSpinner, RetryableAlert, useAppToast } from '../../shared/ui';
import { useAppMutation, useAppQuery } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import { formatApiError } from '../../shared/query/error';
import { isFetchApiError, privateFetch } from '../../shared/fetch';
import { classifySettingsWriteError, useSettingsPolling } from './shared/access-expiry';
import { fetchAllSettingsSources, type RefreshDto, type SourcePageDto } from './shared/settings-api';
import { useUnsavedGuard } from './shared/unsaved-guard';
import { useSettingsAccess } from './settings-access-provider';
import { useSettingsPageMeta } from './settings-modules';
import { SettingsPageHeader } from './shared/settings-page-header';
import { CreateSourceModal, type SettingsSourceDto, type SettingsSourceKind } from './components/CreateSourceModal';

/** 来源类型(菜单拆分用:IPTV 管理/NAS/点播 各显示自己的子集) */
export type { SettingsSourceKind };

/** 010 来源分页(条目为 010 视图;分页字段与 005 相同) */
type SettingsSourcePageDto = Omit<SourcePageDto, 'items'> & { items: SettingsSourceDto[] };

/** POST /settings/sources/:id/test 200 响应(010 契约 SourceTestResult;纯读不写媒体) */
type SourceTestResultDto = Vod.components['schemas']['SourceTestResult'];

/** SourceTestResult.reason → 面向管理者的中文文案(服务端稳定码;不回显上游细节) */
const VOD_TEST_REASON_LABELS: Record<'timeout' | 'invalid' | 'unavailable', string> = {
  timeout: '探测超时',
  invalid: '目标无效或不被许可',
  unavailable: '上游暂不可用',
};

/** VodSourceCapabilities → 稳定字段逐字呈现(不发明能力值) */
function formatVodCapabilities(capabilities: Vod.components['schemas']['VodSourceCapabilities']): string {
  return `resume:${capabilities.resume} · requiresCurrentProbe:${capabilities.requiresCurrentProbe}`;
}

/** 手动导入 operationKey:客户端生成 UUID(幂等键,服务端去重) */
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

export interface SettingsSourcesPageProps {
  /** 仅展示/可创建这些来源类型(缺省 = 全量,兼容旧调用与未拆分场景) */
  readonly kinds?: readonly SettingsSourceKind[];
  /** 页头描述(缺省 = 全量文案「管理直播、节目单与点播来源」) */
  readonly description?: string;
  /** 新建按钮文案(缺省「新建来源」) */
  readonly createActionLabel?: string;
  /** 隐藏独立页头(嵌入到带有公共页头的聚合父页时使用) */
  readonly hideHeader?: boolean;
  /** 外部受控创建状态 */
  readonly isCreating?: boolean;
  readonly onCreatingChange?: (creating: boolean) => void;
  /** 隐藏「查看内容」按钮 */
  readonly hideViewContent?: boolean;
}

export function SettingsSourcesPage({
  kinds,
  description,
  createActionLabel,
  hideHeader,
  isCreating: controlledCreating,
  onCreatingChange,
  hideViewContent = false,
}: SettingsSourcesPageProps = {}): ReactNode {
  const access = useSettingsAccess();
  const { title } = useSettingsPageMeta();
  const toast = useAppToast();
  // IPTV 专属视图(IPTV 管理页嵌入,单类型 iptv):kind 徽标冗余隐藏、手动导入改称
  // 立即同步;NAS/点播与全量视图保持原词汇(混合类型下徽标仍有信息量)
  const isIptvScopedView = kinds !== undefined && kinds.length > 0 && kinds.every((kind) => kind === 'iptv' || kind === 'epg');
  const [internalCreating, setInternalCreating] = useState(false);
  const creating = controlledCreating !== undefined ? controlledCreating : internalCreating;
  const setCreating = onCreatingChange ?? setInternalCreating;
  const [createdSource, setCreatedSource] = useState<SettingsSourceDto | null>(null); // 创建成功 → 「开始导入」下一步
  const [jobs, setJobs] = useState<Record<string, RefreshDto>>({});
  // 010 T034:连通性测试(仅 kind=vod 提供入口);每来源保留最近一次结果行内展示
  const [testResults, setTestResults] = useState<Record<string, SourceTestResultDto>>({});

  const sourcesQuery = useAppQuery<SettingsSourcePageDto>({
    domain: 'settings',
    queryKey: queryKeys.settings.sources(),
    queryFn: ({ signal }) => fetchAllSettingsSources<SettingsSourceDto>(signal),
  });

  // 管理主体读取得到 403 SETTINGS_ACCESS_*:立即回到锁定态(解锁门随之隐藏本页)
  useEffect(() => {
    if (sourcesQuery.isError && classifySettingsWriteError(sourcesQuery.error) === 'access-lost') {
      access.handleAccessLost();
    }
  }, [sourcesQuery.isError, sourcesQuery.error, access]);

  /** 已补读状态的任务(避免失效重读列表后对同一任务重复引导读取) */
  const bootstrappedRef = useRef<Set<string>>(new Set());

  // 页面打开/列表回填时,对来源上的最近任务补一次状态读取(进行中的任务随后进入轮询)
  useEffect(() => {
    const items = sourcesQuery.data?.items;
    if (items === undefined) {
      return;
    }
    for (const source of items) {
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
          bootstrappedRef.current.delete(jobId); // 允许下次列表回填重试
          if (classifySettingsWriteError(jobError) === 'access-lost') {
            access.handleAccessLost();
            return;
          }
          // 单个任务不可见不阻塞来源列表
        });
    }
  }, [sourcesQuery.data, access]);

  // 任务状态轮询:仅跟踪进行中/待确认任务;授权失效由 useSettingsPolling 立即终止
  const tracked = Object.values(jobs).filter((job) => !isTerminal(job.status));
  useSettingsPolling(
    useCallback(async () => {
      for (const job of tracked) {
        const fresh = await privateFetch<RefreshDto>(`/settings/refreshes/${job.id}`);
        setJobs((current) => ({ ...current, [fresh.id]: fresh }));
        if (fresh.status === 'succeeded' || fresh.status === 'failed') {
          void sourcesQuery.refetch(); // 发布成功/失败:回填来源列表(lastSuccessAt/查看内容入口/失败提示)
        }
      }
    }, [tracked, sourcesQuery]),
    { intervalMs: 1000, enabled: tracked.length > 0 },
  );

  const isDirty = creating; // 创建表单打开即视为存在未保存编辑(FR-041 拦截)
  const guard = useUnsavedGuard(isDirty);

  // 手动导入(含创建后「开始导入」):常规操作免当次密码(013/ADR-0017)+ 幂等 operationKey
  const startRefresh = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { sourceId: string; expectedVersion: number; operationKey: string }) =>
      privateFetch<RefreshDto>(`/settings/sources/${vars.sourceId}/refresh`, {
        method: 'POST',
        body: {
          expectedVersion: vars.expectedVersion,
          operationKey: vars.operationKey,
        },
      }),
    invalidate: [queryKeys.settings.sources()],
  });

  // 启停/字段修改:常规操作免当次密码 + expectedVersion CAS
  // (010:根地址字段不可经 PATCH 修改——服务端 400 拒绝,本页不提供修改入口)
  const patchSource = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { sourceId: string; input: Record<string, unknown> }) =>
      privateFetch<SettingsSourceDto>(`/settings/sources/${vars.sourceId}`, {
        method: 'PATCH',
        body: { ...vars.input },
      }),
    invalidate: [queryKeys.settings.sources()],
  });

  // 010 T034 连通性测试(POST /settings/sources/:id/test;纯读不写媒体、
  // 不失效任何查询键):成功行内展示 SourceTestResult;失败按 problem detail 呈现,
  // 403 SETTINGS_ACCESS_* 走既有 handleAccessLost 重验证流。
  const testSource = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { sourceId: string }) =>
      privateFetch<SourceTestResultDto>(`/settings/sources/${vars.sourceId}/test`, {
        method: 'POST',
      }),
  });

  // 快照确认/丢弃:常规操作免当次密码 + 任务当前版本 CAS(awaiting_confirmation 交互保留)
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

  const fetchedSources = sourcesQuery.data?.items ?? null;
  // 菜单拆分:按 kinds 客户端过滤(服务端列表为全类型分页;查询键共享,react-query 去重)
  const sources =
    kinds === undefined ? fetchedSources : (fetchedSources?.filter((source) => kinds.includes(source.kind)) ?? null);

  /** 统一失败分流:授权丢失立即隐藏;版本冲突提示重读;其余经数据层 toast 呈现 */
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
    // 其余拒绝(校验/配额/上游等)由 useAppMutation onError 统一经 toast 呈现
    // formatApiError 文案,此处不再重复提示。
  };

  /** 手动导入(含创建后「开始导入」):直接执行;每次调用生成新幂等 operationKey */
  const runImport = (source: SettingsSourceDto): void => {
    void startRefresh
      .mutateAsync({ sourceId: source.id, expectedVersion: source.version, operationKey: newOperationKey() })
      .then((job) => {
        setJobs((current) => ({ ...current, [job.id]: job }));
        toast.success(`导入任务已创建(状态 ${job.status}),正在轮询任务状态…`);
        setCreatedSource(null); // 下一步动作已完成
      })
      .catch((cause: unknown) => {
        handleMutationFailure(cause, '来源已被其他操作修改(版本冲突):列表已按服务端现值刷新,请重试。');
      });
  };

  /** 启停/字段修改:直接执行(vod 启停「定位版本递增」语义由服务端契约保证) */
  const applyPatch = (source: SettingsSourceDto, input: Record<string, unknown>): void => {
    void patchSource
      .mutateAsync({ sourceId: source.id, input })
      .then(() => {
        toast.success('来源已保存');
      })
      .catch((cause: unknown) => {
        if (isFetchApiError(cause) && cause.code === 'VOD_QUOTA_EXCEEDED') {
          // 409 配额上限 ≠ 版本冲突:按服务端 problem detail 呈现(提示管理来源)
          toast.error(formatApiError(cause));
          return;
        }
        handleMutationFailure(cause, '来源已被其他操作修改(版本冲突):列表已按服务端现值刷新,请重试。');
      });
  };

  /** 启停开关/按钮共用:取反 enabled + CAS 版本 */
  const toggleSource = (source: SettingsSourceDto): void => {
    applyPatch(source, { expectedVersion: source.version, enabled: !source.enabled });
  };

  /** 连通性测试(010 T034):直接探测,结果行内展示 */
  const runTest = (source: SettingsSourceDto): void => {
    void testSource
      .mutateAsync({ sourceId: source.id })
      .then((result) => {
        setTestResults((current) => ({ ...current, [source.id]: result }));
      })
      .catch((cause: unknown) => {
        if (classifySettingsWriteError(cause) === 'access-lost') {
          access.handleAccessLost(); // 403 SETTINGS_ACCESS_*:既有重验证流(解锁门接管)
          return;
        }
        // 400/409/422 等:经 useAppMutation toast 呈现服务端拒绝
      });
  };

  /** 快照确认/丢弃(awaiting_confirmation):直接执行,expectedVersion 幂等键照旧 */
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

  return (
    <section aria-label={`设置 · ${title}`} className="flex flex-1 flex-col gap-6">
      {!hideHeader && (
        <SettingsPageHeader
          description={description ?? '管理直播、节目单与点播来源'}
          actions={
            <Button
              variant="primary"
              size="sm"
              data-testid="create-source-open"
              onPress={() => {
                setCreating(true);
              }}
            >
              {createActionLabel ?? '新建来源'}
            </Button>
          }
        />
      )}
      {sourcesQuery.isPending ? <LoadingSpinner label="正在读取来源…" /> : null}
      {sourcesQuery.isError ? (
        <RetryableAlert
          title="读取失败"
          description={formatApiError(sourcesQuery.error)}
          onRetry={() => void sourcesQuery.refetch()}
        />
      ) : null}
      {createdSource !== null ? (
        <div className="flex flex-col gap-2 rounded-2xl border border-success/50 bg-success-soft p-4 text-sm" data-testid="source-created-next-step">
          {createdSource.kind === 'vod' ? (
            <>
              {/* 010:vod 无导入面(服务端对 vod refresh 稳定 400,目录按需拉取),
                  下一步引导为连通性测试而非导入,避免必失败入口 */}
              <p className="text-success">
                来源「{createdSource.name}」已创建。在线点播无需导入目录,可先「测试」验证连通性,再到点播页搜索拉取内容。
              </p>
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  data-testid="source-start-test"
                  onPress={() => {
                    runTest(createdSource);
                  }}
                >
                  测试连通性
                </Button>
                <Button variant="ghost" size="sm" onPress={() => setCreatedSource(null)}>
                  稍后再说
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-success">来源「{createdSource.name}」已创建。下一步:开始导入,拉取目录内容。</p>
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  data-testid="source-start-import"
                  onPress={() => runImport(createdSource)}
                >
                  开始导入
                </Button>
                <Button variant="ghost" size="sm" onPress={() => setCreatedSource(null)}>
                  稍后再说
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {sources !== null ? (
        <ul className="flex flex-col gap-4" data-testid="source-list">
          {sources.map((source) => {
            const job = source.lastJobId !== null ? (jobs[source.lastJobId] ?? null) : null;
            const testResult = testResults[source.id] ?? null;
            return (
              <li key={source.id} data-testid={`source-row-${source.id}`}>
                <Card
                  variant="default"
                  className={`rounded-2xl border border-border/40 p-0 shadow-none ${
                    source.enabled ? 'bg-surface/50' : 'bg-surface/30'
                  }`}
                >
                  <Card.Content className="flex flex-col gap-3.5 p-4 sm:p-5">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {source.name}
                          </span>
                          {/* IPTV 专属视图单类型,kind 徽标冗余;混合视图(NAS/点播/全量)保留 */}
                          {!isIptvScopedView ? (
                            <Chip size="sm" variant="soft" color="default" className="text-xs font-medium uppercase">
                              {source.kind}
                            </Chip>
                          ) : null}
                          {source.kind === 'vod' && source.capabilities !== undefined ? (
                            <Chip
                              size="sm"
                              variant="soft"
                              color="default"
                              className="text-xs"
                              data-testid={`source-capabilities-${source.id}`}
                            >
                              {formatVodCapabilities(source.capabilities)}
                            </Chip>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                          <span className="truncate max-w-[320px]">{source.locationLabel}</span>
                          <span>·</span>
                          <span>
                            {source.lastSuccessAt !== null
                              ? `上次导入 ${source.lastSuccessAt.slice(0, 16).replace('T', ' ')}`
                              : '尚无成功导入'}
                          </span>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-2.5">
                        {source.kind === 'vod' ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onPress={() => runTest(source)}
                            data-testid={`source-test-${source.id}`}
                          >
                            测试
                          </Button>
                        ) : null}
                        {source.kind !== 'vod' ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onPress={() => runImport(source)}
                            isDisabled={!source.enabled}
                            className={isIptvScopedView ? 'text-foreground' : undefined}
                            data-testid={`source-import-${source.id}`}
                          >
                            {isIptvScopedView ? '立即同步' : '手动导入'}
                          </Button>
                        ) : null}
                        {!hideViewContent && (source.kind === 'vod' || (source.kind !== 'epg' && source.lastSuccessAt !== null)) ? (
                          <Link
                            to={source.kind === 'iptv' ? '/live/channels' : '/vod'}
                            className="inline-flex h-8 items-center justify-center rounded-lg border border-border/60 bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                            data-testid={`source-view-${source.id}`}
                          >
                            查看内容
                          </Link>
                        ) : null}
                        <div className="ml-1 flex items-center">
                          {/* 启停状态经开关旁文字标签表达(可读;不用整卡透明度弱化) */}
                          <Switch
                            isSelected={source.enabled}
                            onChange={() => toggleSource(source)}
                            aria-label={`${source.enabled ? '停用' : '启用'} ${source.name}`}
                          >
                            <Switch.Content data-testid={`source-toggle-${source.id}`}>
                              <Switch.Control>
                                <Switch.Thumb />
                              </Switch.Control>
                              <span className="select-none text-xs text-muted">
                                {source.enabled ? '已启用' : '已停用'}
                              </span>
                            </Switch.Content>
                          </Switch>
                        </div>
                      </div>
                    </div>

                    {testResult !== null ? (
                      <div
                        className="flex flex-col gap-1 rounded-xl bg-surface-secondary/40 p-3 text-xs text-muted"
                        data-testid={`source-test-result-${source.id}`}
                      >
                        <span>
                          测试结果:{testResult.reachable ? '可达' : '不可达'} · {testResult.compatible ? '格式兼容' : '格式不兼容'}
                          {testResult.reason !== null ? ` · 原因:${VOD_TEST_REASON_LABELS[testResult.reason]}` : ''}
                        </span>
                        <span>能力:{formatVodCapabilities(testResult.capabilities)}</span>
                      </div>
                    ) : null}

                    {job !== null && job.status === 'awaiting_confirmation' ? (
                      <div
                        className="flex flex-col gap-2.5 rounded-xl border border-warning/30 bg-warning-soft/20 p-3 sm:flex-row sm:items-center sm:justify-between"
                        data-testid={`source-job-${source.id}`}
                      >
                        <div className="flex flex-col gap-0.5 text-xs">
                          <span className="font-medium text-warning">
                            待确认快照 (awaiting_confirmation)
                          </span>
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
                        className="flex items-center justify-between rounded-xl border border-danger/30 bg-danger-soft/20 px-3.5 py-2.5 text-xs text-danger"
                        data-testid={`source-job-${source.id}`}
                      >
                        <span>
                          导入失败:上次成功目录已保留;可重试手动导入,不影响现有内容。
                        </span>
                      </div>
                    ) : null}

                    {job !== null && (job.status === 'queued' || job.status === 'running') ? (
                      /* 进行中:服务端不提供百分比 → 不确定进度(绝不臆造百分比);计数仅在
                         服务端已发布真实快照计数时展示 */
                      <div
                        className="flex flex-col gap-2 rounded-xl bg-surface-secondary/40 px-3.5 py-2.5 text-xs text-muted"
                        data-testid={`source-job-${source.id}`}
                      >
                        <ProgressBar isIndeterminate aria-label={`${source.name} 同步进行中`} className="w-full">
                          <ProgressBar.Track>
                            <ProgressBar.Fill />
                          </ProgressBar.Track>
                        </ProgressBar>
                        <span>
                          正在导入…
                          {job.counts != null
                            ? `（新增 ${job.counts.added} / 更新 ${job.counts.updated} / 缺失 ${job.counts.missing}）`
                            : ''}
                        </span>
                      </div>
                    ) : null}

                    {job !== null && job.status === 'succeeded' ? (
                      /* 最新一次导入的计数明细收纳为可展开条目(成功摘要常驻一行,明细按需查看);
                         失败/待确认仍保持常驻可见(上方两个分支) */
                      <div className="border-t border-border/10 pt-2" data-testid={`source-job-${source.id}`}>
                        <Disclosure>
                          <Disclosure.Heading className="text-xs text-muted">
                            <Disclosure.Trigger className="flex items-center gap-2 text-muted">
                              <span className="inline-block size-1.5 rounded-full bg-success" />
                              <span>
                                {job.counts != null ? '上次导入完成,查看计数明细' : '导入发布成功'}
                              </span>
                              <Disclosure.Indicator />
                            </Disclosure.Trigger>
                          </Disclosure.Heading>
                          <Disclosure.Content>
                            {job.counts != null ? (
                              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 pt-1 text-xs text-muted sm:grid-cols-3" data-testid={`source-job-counts-${source.id}`}>
                <div className="flex justify-between gap-2"><dt>新增</dt><dd className="text-foreground">{job.counts.added}</dd></div>
                <div className="flex justify-between gap-2"><dt>更新</dt><dd className="text-foreground">{job.counts.updated}</dd></div>
                <div className="flex justify-between gap-2"><dt>缺失</dt><dd className="text-foreground">{job.counts.missing}</dd></div>
                <div className="flex justify-between gap-2"><dt>频道</dt><dd className="text-foreground">{job.counts.channels}</dd></div>
                <div className="flex justify-between gap-2"><dt>节目</dt><dd className="text-foreground">{job.counts.programmes}</dd></div>
                <div className="flex justify-between gap-2"><dt>失败</dt><dd className="text-foreground">{job.counts.failed}</dd></div>
                              </dl>
                            ) : (
                              <p className="pt-1 text-xs text-muted">本次发布未返回计数。</p>
                            )}
                          </Disclosure.Content>
                        </Disclosure>
                      </div>
                    ) : null}
                  </Card.Content>
                </Card>
              </li>
            );
          })}
        </ul>
      ) : null}

      {creating ? (
        <CreateSourceModal
          allowedKinds={kinds}
          onCreated={(source) => {
            setCreating(false); // 表单收起(脏状态解除)
            setCreatedSource(source); // 明确「开始导入」下一步(FR-037);列表回填由 invalidate 驱动
          }}
          onCancel={() => setCreating(false)}
        />
      ) : null}

      {guard.dialog}
    </section>
  );
}

/** NAS/点播来源页(设置菜单拆分:仅 NAS/在线点播两类;IPTV/EPG 已并入「IPTV 管理」) */
export function SettingsNasVodSourcesPage(): ReactNode {
  return (
    <SettingsSourcesPage
      kinds={['nas', 'vod'] satisfies readonly SettingsSourceKind[]}
      description="管理 NAS 影库与在线点播来源及导入任务"
    />
  );
}
