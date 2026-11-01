/**
 * 来源管理页(T134,US8;FR-037;T025 数据层迁移;010 T034 叠加 vod 增量):
 * - 来源列表经 useAppQuery(settings.sources 键,硬请求 + isPending 门控 /
 *   isError RetryableAlert(formatApiError + 重试)/ 成功出主体);
 * - 创建/启停字段修改/手动导入/快照确认与丢弃均为 confirmed 变更(当次密码 +
 *   CAS/幂等 operationKey):等待服务端确认,成功后失效 settings.sources 键以
 *   服务端真值回填(替代原手工 load());任务状态在本页 jobs 表局部承载并经
 *   useSettingsPolling 轮询(授权失效即终止;任务读取无键工厂归属,见报告);
 * - 创建成功明确「开始导入」下一步;快照确认(awaiting_confirmation)提供确认/丢弃;
 * - 成功发布后提供「查看内容」入口;失败提示重试并保留上次成功目录(不自动清理);
 * - 每敏感操作独立弹当次密码;409 冲突提示重读现值,不静默覆盖(失效重读);
 * - 403 SETTINGS_ACCESS_* 经 handleAccessLost 立即隐藏;重新解锁后重挂硬请求。
 *
 * 010 T034(US1 web 侧,叠加于既有 dirty 改动之上,零回退):
 * - kind=vod 创建分支(remoteUrl 必填、adapter 固定 apple-cms-json 展示;
 *   NAS/EPG 专属字段在 vod 下隐藏;创建体严格按 010 契约 VodCreateSourceRequest,
 *   不携带 enabled/privateAccessApproved——未知字段服务端拒绝);
 * - kind=vod 行内 capabilities 徽标(resume:operational/requiresCurrentProbe);
 * - 「测试」→ POST /settings/sources/:id/test(当次密码)→ 结果行内展示
 *   (reachable/compatible/reason 中文文案;纯读不写媒体,不失效任何键);
 * - vod 启停弹层提示「定位版本递增」(启停均失效活动 locator,api.md §2);
 * - 编辑界面不提供根地址修改入口(PATCH 根地址服务端 400 拒绝,UI 不撒谎);
 * - 409 VOD_QUOTA_EXCEEDED 单列呈现(提示管理来源,不混入版本冲突文案);
 *   422 SOURCE_TARGET_DENIED 呈现服务端拒绝原因(detail 为稳定脱敏文案,无 URL 回显);
 * - 服务端拒绝优先:测试入口仅对 kind=vod 展示属体验优化,任何 4xx 响应
 *   (含未来契约变化)均原样经弹层/页面呈现,不以按钮隐藏代替服务端拒绝。
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Button, Form, Input, Label, ListBox, Radio, RadioGroup, Select, TextField } from '@heroui/react';
import type { Vod } from '@hmp/shared';
import { LoadingSpinner, RetryableAlert } from '../../shared/ui';
import { useAppMutation, useAppQuery } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import { formatApiError } from '../../shared/query/error';
import { isFetchApiError, privateFetch } from '../../shared/fetch';
import { classifySettingsWriteError, useSettingsPolling } from './shared/access-expiry';
import type { RefreshDto, RootDto, SourceDto, SourcePageDto } from './shared/settings-api';
import { PasswordConfirmModal } from './shared/password-confirm-modal';
import { useUnsavedGuard } from './shared/unsaved-guard';
import { useSettingsAccess } from './settings-access-provider';
import { useSettingsPageMeta } from './settings-modules';

/**
 * 010 来源 DTO 视图(005 SourceDto 的兼容扩展;010 openapi components/Source 同形):
 * kind 增加 'vod',kind=vod 附 capabilities(api.md §2「现有来源DTO扩kind=vod及capabilities」)。
 * 就地声明(005 settings-api.ts 保持 005 面不变,与 010 契约类型经 @hmp/shared Vod 对齐)。
 */
type SettingsSourceDto = Omit<SourceDto, 'kind'> & {
  kind: SourceDto['kind'] | 'vod';
  capabilities?: Vod.components['schemas']['VodSourceCapabilities'];
};

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

export function SettingsSourcesPage(): ReactNode {
  const access = useSettingsAccess();
  const { title } = useSettingsPageMeta();
  const [creating, setCreating] = useState(false);
  const [createdSource, setCreatedSource] = useState<SettingsSourceDto | null>(null); // 创建成功 → 「开始导入」下一步
  const [jobs, setJobs] = useState<Record<string, RefreshDto>>({});
  const [confirmJob, setConfirmJob] = useState<{ job: RefreshDto; action: 'confirm' | 'discard' } | null>(null);
  const [confirmPatch, setConfirmPatch] = useState<{ source: SettingsSourceDto; input: Record<string, unknown> } | null>(null);
  const [importTarget, setImportTarget] = useState<SettingsSourceDto | null>(null);
  const [importKey, setImportKey] = useState<string | null>(null);
  // 010 T034:连通性测试(仅 kind=vod 提供入口);每来源保留最近一次结果行内展示
  const [testResults, setTestResults] = useState<Record<string, SourceTestResultDto>>({});
  const [testTarget, setTestTarget] = useState<SettingsSourceDto | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const sourcesQuery = useAppQuery<SettingsSourcePageDto>({
    domain: 'settings',
    queryKey: queryKeys.settings.sources(),
    queryFn: ({ signal }) => privateFetch<SettingsSourcePageDto>('/settings/sources', { signal }),
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

  // 手动导入(含创建后「开始导入」):confirmed 变更 + 当次密码 + 幂等 operationKey
  const startRefresh = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { sourceId: string; ownerPassword: string; expectedVersion: number; operationKey: string }) =>
      privateFetch<RefreshDto>(`/settings/sources/${vars.sourceId}/refresh`, {
        method: 'POST',
        body: {
          ownerPassword: vars.ownerPassword,
          expectedVersion: vars.expectedVersion,
          operationKey: vars.operationKey,
        },
      }),
    invalidate: [queryKeys.settings.sources()],
  });

  // 启停/字段修改:confirmed 变更 + 当次密码 + expectedVersion CAS
  // (010:根地址字段不可经 PATCH 修改——服务端 400 拒绝,本页不提供修改入口)
  const patchSource = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { sourceId: string; ownerPassword: string; input: Record<string, unknown> }) =>
      privateFetch<SettingsSourceDto>(`/settings/sources/${vars.sourceId}`, {
        method: 'PATCH',
        body: { ownerPassword: vars.ownerPassword, ...vars.input },
      }),
    invalidate: [queryKeys.settings.sources()],
  });

  // 010 T034 连通性测试(POST /settings/sources/:id/test,当次密码;纯读不写媒体、
  // 不失效任何查询键):成功行内展示 SourceTestResult;失败按 problem detail 呈现,
  // 403 SETTINGS_ACCESS_* 走既有 handleAccessLost 重验证流。
  const testSource = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { sourceId: string; ownerPassword: string }) =>
      privateFetch<SourceTestResultDto>(`/settings/sources/${vars.sourceId}/test`, {
        method: 'POST',
        body: { ownerPassword: vars.ownerPassword },
      }),
  });

  // 快照确认/丢弃:confirmed 变更 + 当次密码 + 任务当前版本
  const settleRefresh = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { jobId: string; action: 'confirm' | 'discard'; ownerPassword: string; expectedVersion: number }) =>
      privateFetch<RefreshDto>(`/settings/refreshes/${vars.jobId}/${vars.action}`, {
        method: 'POST',
        body: { ownerPassword: vars.ownerPassword, expectedVersion: vars.expectedVersion },
      }),
    invalidate: [queryKeys.settings.sources()],
  });

  const sources = sourcesQuery.data?.items ?? null;

  const openImport = (source: SettingsSourceDto): void => {
    setPageError(null);
    setImportKey(newOperationKey());
    setImportTarget(source);
  };

  return (
    <section aria-label={`设置 · ${title}`} className="flex flex-1 flex-col gap-4 py-2">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      {sourcesQuery.isPending ? <LoadingSpinner label="正在读取来源…" /> : null}
      {sourcesQuery.isError ? (
        <RetryableAlert
          title="读取失败"
          description={formatApiError(sourcesQuery.error)}
          onRetry={() => void sourcesQuery.refetch()}
        />
      ) : null}
      {pageError !== null ? <p role="alert" className="text-sm text-danger">{pageError}</p> : null}
      {notice !== null ? <p role="status" className="text-sm text-success" data-testid="sources-notice">{notice}</p> : null}

      <div className="flex justify-end">
        <Button
          variant="primary"
          size="sm"
          data-testid="create-source-open"
          onPress={() => {
            setPageError(null);
            setCreating(true);
          }}
        >
          新建来源
        </Button>
      </div>

      {createdSource !== null ? (
        <div className="flex flex-col gap-2 rounded border border-success p-3 text-sm" data-testid="source-created-next-step">
          <p className="text-success">来源「{createdSource.name}」已创建。下一步:开始导入,拉取目录内容。</p>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              data-testid="source-start-import"
              onPress={() => openImport(createdSource)}
            >
              开始导入
            </Button>
            <Button variant="ghost" size="sm" onPress={() => setCreatedSource(null)}>
              稍后再说
            </Button>
          </div>
        </div>
      ) : null}

      {sources !== null ? (
        <ul className="flex flex-col gap-2" data-testid="source-list">
          {sources.map((source) => {
            const job = source.lastJobId !== null ? (jobs[source.lastJobId] ?? null) : null;
            const testResult = testResults[source.id] ?? null;
            return (
              <li key={source.id} className="flex flex-col gap-2 rounded border border-border p-3" data-testid={`source-row-${source.id}`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium text-foreground">
                      {source.name}
                      <span className="ml-2 rounded bg-surface px-1.5 py-0.5 text-xs text-muted">{source.kind}</span>
                      {/* 010 T034:kind=vod 行内能力徽标(契约字段逐字呈现) */}
                      {source.kind === 'vod' && source.capabilities !== undefined ? (
                        <span
                          className="ml-2 rounded bg-surface px-1.5 py-0.5 text-xs text-muted"
                          data-testid={`source-capabilities-${source.id}`}
                        >
                          {formatVodCapabilities(source.capabilities)}
                        </span>
                      ) : null}
                      <span className={`ml-2 text-xs ${source.enabled ? 'text-success' : 'text-danger'}`}>
                        {source.enabled ? '已启用' : '已停用'}
                      </span>
                    </span>
                    <span className="text-xs text-muted">
                      位置:{source.locationLabel} · 版本 {source.version}
                      {source.lastSuccessAt !== null
                        ? ` · 上次成功 ${source.lastSuccessAt.slice(0, 19).replace('T', ' ')}`
                        : ' · 尚无成功导入'}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onPress={() => setConfirmPatch({ source, input: { expectedVersion: source.version, enabled: !source.enabled } })}
                      data-testid={`source-toggle-${source.id}`}
                    >
                      {source.enabled ? '停用' : '启用'}
                    </Button>
                    {/* 连通性测试:入口仅对 kind=vod 展示属体验优化;服务端对非 vod 一律 400,
                        任何 4xx 响应仍原样呈现——不以按钮隐藏代替服务端拒绝(010 T034) */}
                    {source.kind === 'vod' ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onPress={() => {
                          setPageError(null);
                          setTestTarget(source);
                        }}
                        data-testid={`source-test-${source.id}`}
                      >
                        测试
                      </Button>
                    ) : null}
                    <Button
                      variant="primary"
                      size="sm"
                      onPress={() => openImport(source)}
                      isDisabled={!source.enabled}
                      data-testid={`source-import-${source.id}`}
                    >
                      手动导入
                    </Button>
                    {source.lastSuccessAt !== null ? (
                      <Link
                        to="/vod"
                        className="rounded px-2 py-1 text-sm text-muted underline-offset-2 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                        data-testid={`source-view-${source.id}`}
                      >
                        查看内容
                      </Link>
                    ) : null}
                  </div>
                </div>
                {testResult !== null ? (
                  <div
                    className="flex flex-col gap-1 rounded bg-surface p-2 text-xs text-muted"
                    data-testid={`source-test-result-${source.id}`}
                  >
                    <span>
                      测试结果:{testResult.reachable ? '可达' : '不可达'} · {testResult.compatible ? '格式兼容' : '格式不兼容'}
                      {testResult.reason !== null ? ` · 原因:${VOD_TEST_REASON_LABELS[testResult.reason]}` : ''}
                    </span>
                    <span>能力:{formatVodCapabilities(testResult.capabilities)}</span>
                  </div>
                ) : null}
                {job !== null ? (
                  <div className="flex flex-col gap-1 rounded bg-surface p-2 text-xs text-muted" data-testid={`source-job-${source.id}`}>
                    <span>
                      导入任务:{job.status}
                      {job.errorCode != null ? ` · ${job.errorCode}` : ''}
                      {job.counts != null
                        ? ` · 新增 ${job.counts.added} / 更新 ${job.counts.updated} / 缺失 ${job.counts.missing}`
                        : ''}
                    </span>
                    {job.status === 'awaiting_confirmation' ? (
                      <div className="flex gap-2">
                        <Button variant="primary" size="sm" onPress={() => setConfirmJob({ job, action: 'confirm' })} data-testid={`job-confirm-${job.id}`}>
                          确认发布
                        </Button>
                        <Button variant="danger" size="sm" onPress={() => setConfirmJob({ job, action: 'discard' })} data-testid={`job-discard-${job.id}`}>
                          丢弃快照
                        </Button>
                      </div>
                    ) : null}
                    {job.status === 'failed' ? (
                      <p className="text-warning">导入失败:上次成功目录已保留;可重试手动导入,不影响现有内容。</p>
                    ) : null}
                    {job.status === 'succeeded' ? (
                      <p className="text-success">导入发布成功,可点「查看内容」浏览新目录。</p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {creating ? (
        <CreateSourceForm
          onCreated={(source) => {
            setCreating(false); // 表单收起(脏状态解除)
            setCreatedSource(source); // 明确「开始导入」下一步(FR-037);列表回填由 invalidate 驱动
          }}
          onCancel={() => setCreating(false)}
        />
      ) : null}

      {/* 手动导入(含创建后「开始导入」):当次密码 + 幂等 operationKey */}
      <PasswordConfirmModal
        open={importTarget !== null}
        title="开始导入"
        description={
          importTarget !== null && importKey !== null
            ? `将立即导入「${importTarget.name}」(任务幂等键 ${importKey});导入期间不阻塞其他设置操作。`
            : ''
        }
        submitLabel="开始导入"
        onSubmit={(ownerPassword: string) => {
          if (importTarget === null || importKey === null) {
            return Promise.reject(new Error('no source'));
          }
          return startRefresh
            .mutateAsync({
              sourceId: importTarget.id,
              ownerPassword,
              expectedVersion: importTarget.version,
              operationKey: importKey,
            })
            .then((job) => {
              setJobs((current) => ({ ...current, [job.id]: job }));
              setNotice(`导入任务已创建(状态 ${job.status}),正在轮询任务状态…`);
              setCreatedSource(null); // 下一步动作已完成
            })
            .catch((cause: unknown) => {
              const kind = classifySettingsWriteError(cause);
              if (kind === 'access-lost') {
                access.handleAccessLost();
                return;
              }
              if (kind === 'conflict') {
                setPageError('来源已被其他操作修改(版本冲突):列表已按服务端现值刷新,请重试。');
                return; // 列表回填由 invalidate 驱动
              }
              throw cause; // 密码错误:弹层保持
            });
        }}
        onClose={() => {
          setImportTarget(null);
          setImportKey(null);
        }}
      />

      {/* 启停/字段修改:当次密码 + expectedVersion CAS(vod 启停提示定位版本递增) */}
      <PasswordConfirmModal
        open={confirmPatch !== null}
        title="保存来源修改"
        description={
          confirmPatch !== null && confirmPatch.source.kind === 'vod' && confirmPatch.input.enabled !== undefined
            ? '启停在线点播来源会使该来源的活动定位失效(定位版本递增),进行中的播放定位需重新获取。'
            : undefined
        }
        submitLabel="确认保存"
        onSubmit={(ownerPassword: string) => {
          if (confirmPatch === null) {
            return Promise.reject(new Error('no patch'));
          }
          return patchSource
            .mutateAsync({ sourceId: confirmPatch.source.id, ownerPassword, input: confirmPatch.input })
            .then(() => {
              setNotice('来源已保存');
            })
            .catch((cause: unknown) => {
              const kind = classifySettingsWriteError(cause);
              if (kind === 'access-lost') {
                access.handleAccessLost();
                return;
              }
              if (isFetchApiError(cause) && cause.code === 'VOD_QUOTA_EXCEEDED') {
                // 409 配额上限 ≠ 版本冲突:按服务端 problem detail 呈现(提示管理来源)
                setPageError(formatApiError(cause));
                return;
              }
              if (kind === 'conflict') {
                setPageError('来源已被其他操作修改(版本冲突):列表已按服务端现值刷新,请重试。');
                return; // 列表回填由 invalidate 驱动
              }
              throw cause;
            });
        }}
        onClose={() => setConfirmPatch(null)}
      />

      {/* 010 T034 连通性测试:当次密码;纯读探测;结果行内展示,失败按 problem detail 呈现 */}
      <PasswordConfirmModal
        open={testTarget !== null}
        title="测试来源连通性"
        description={
          testTarget !== null
            ? `将对「${testTarget.name}」发起一次有界连通性/兼容性探测;纯读操作,不写入任何媒体。`
            : ''
        }
        submitLabel="开始测试"
        onSubmit={(ownerPassword: string) => {
          if (testTarget === null) {
            return Promise.reject(new Error('no source'));
          }
          const target = testTarget;
          return testSource
            .mutateAsync({ sourceId: target.id, ownerPassword })
            .then((result) => {
              setTestResults((current) => ({ ...current, [target.id]: result }));
            })
            .catch((cause: unknown) => {
              const kind = classifySettingsWriteError(cause);
              if (kind === 'access-lost') {
                access.handleAccessLost(); // 403 SETTINGS_ACCESS_*:既有重验证流(解锁门接管)
                return;
              }
              throw cause; // 400/409/422 等:弹层按 problem detail 呈现服务端拒绝
            });
        }}
        onClose={() => setTestTarget(null)}
      />

      {/* 快照确认/丢弃:当次密码 + 任务当前版本 */}
      <PasswordConfirmModal
        open={confirmJob !== null}
        title={confirmJob?.action === 'confirm' ? '确认发布导入快照' : '丢弃导入快照'}
        description={
          confirmJob !== null
            ? confirmJob.action === 'confirm'
              ? '确认后快照将发布为新目录(缺失条目将被清理)。'
              : '丢弃后保留上次成功目录不变,可重新导入。'
            : ''
        }
        submitLabel={confirmJob?.action === 'confirm' ? '确认发布' : '确认丢弃'}
        onSubmit={(ownerPassword: string) => {
          if (confirmJob === null) {
            return Promise.reject(new Error('no job'));
          }
          return settleRefresh
            .mutateAsync({
              jobId: confirmJob.job.id,
              action: confirmJob.action,
              ownerPassword,
              expectedVersion: confirmJob.job.version,
            })
            .then((fresh) => {
              setJobs((current) => ({ ...current, [fresh.id]: fresh }));
              setNotice(fresh.status === 'succeeded' ? '快照已确认发布' : '快照已丢弃,上次成功目录保留');
            })
            .catch((cause: unknown) => {
              const kind = classifySettingsWriteError(cause);
              if (kind === 'access-lost') {
                access.handleAccessLost();
                return;
              }
              if (kind === 'conflict') {
                setPageError('任务状态已变化(版本冲突):请以最新任务状态重新操作。');
                return;
              }
              throw cause;
            });
        }}
        onClose={() => setConfirmJob(null)}
      />
      {guard.dialog}
    </section>
  );
}

function CreateSourceForm({
  onCreated,
  onCancel,
}: {
  onCreated: (source: SettingsSourceDto) => void;
  onCancel: () => void;
}): ReactNode {
  const access = useSettingsAccess();
  const [kind, setKind] = useState<'iptv' | 'epg' | 'nas' | 'vod'>('iptv');
  const [name, setName] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [rootKey, setRootKey] = useState('');
  const [relativeDirectory, setRelativeDirectory] = useState('');
  const [roots, setRoots] = useState<RootDto[] | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // NAS 根目录读取:键工厂无对应键(shared/query/keys.ts 本任务只读),保留表单级
  // 一次性命令式读取(NAS 表单打开时一次;偏差已记录 —— 见 T025 报告「迁移映射」)
  useEffect(() => {
    if (kind === 'nas' && roots === null) {
      void privateFetch<RootDto[]>('/settings/source-roots')
        .then(setRoots)
        .catch((cause: unknown) => {
          if (classifySettingsWriteError(cause) === 'access-lost') {
            access.handleAccessLost();
            return;
          }
          setRoots([]);
        });
    }
  }, [kind, roots, access]);

  // 创建来源:confirmed 变更(当次密码);成功后失效来源列表回填。
  // 010 vod 分支:创建体严格按契约 VodCreateSourceRequest(ownerPassword/kind/name/
  // remoteUrl/adapter),不携带 enabled/privateAccessApproved(未知字段服务端拒绝;
  // NAS/EPG 绑定字段在 vod 下同理禁带);iptv/epg/nas 分支保持 005 面不变。
  const createSource = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { ownerPassword: string }) =>
      privateFetch<SettingsSourceDto>('/settings/sources', {
        method: 'POST',
        body:
          kind === 'vod'
            ? {
                ownerPassword: vars.ownerPassword,
                kind,
                name: name.trim(),
                remoteUrl: remoteUrl.trim(),
                adapter: 'apple-cms-json' as const,
              }
            : {
                ownerPassword: vars.ownerPassword,
                kind,
                name: name.trim(),
                enabled: true,
                privateAccessApproved: true,
                ...(kind !== 'nas' ? { remoteUrl: remoteUrl.trim() } : { rootKey, relativeDirectory }),
              },
      }),
    invalidate: [queryKeys.settings.sources()],
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (name.trim() === '') {
      setError('请填写来源名称');
      return;
    }
    if (kind !== 'nas' && remoteUrl.trim() === '') {
      setError(
        kind === 'epg'
          ? 'EPG 来源必须提供 XMLTV remoteUrl'
          : kind === 'vod'
            ? '在线点播来源必须提供 remoteUrl(根地址)'
            : 'IPTV 来源必须提供 remoteUrl',
      );
      return;
    }
    if (kind === 'nas' && (rootKey === '' || relativeDirectory === '')) {
      setError('NAS 来源必须选择根目录与相对目录');
      return;
    }
    setError(null);
    setPasswordOpen(true);
  };

  const submit = (ownerPassword: string): Promise<void> =>
    createSource
      .mutateAsync({ ownerPassword })
      .then((created) => {
        onCreated(created);
      })
      .catch((cause: unknown) => {
        const kindOf = classifySettingsWriteError(cause);
        if (kindOf === 'access-lost') {
          access.handleAccessLost();
          return;
        }
        // 010 T034:其余拒绝原样上抛进弹层,按 problem detail 呈现——422
        // SOURCE_TARGET_DENIED 显示服务端拒绝原因(detail 为稳定脱敏短语,无 URL 回显);
        // 409 VOD_QUOTA_EXCEEDED 显示「已达上限,请管理来源」;密码错误保持弹层不关。
        throw cause;
      });

  return (
    <Form onSubmit={handleSubmit} className="flex max-w-md flex-col gap-3 rounded border border-border p-4" aria-label="新建来源">
      <h3 className="text-sm font-semibold text-foreground">新建来源</h3>
      <RadioGroup
        className="flex gap-4 text-sm"
        name="source-kind"
        value={kind}
        onChange={(value) => setKind(value as 'iptv' | 'epg' | 'nas' | 'vod')}
      >
        <Label>类型</Label>
        <Radio value="iptv">
          <Radio.Content><Radio.Control><Radio.Indicator /></Radio.Control>IPTV</Radio.Content>
        </Radio>
        <Radio value="epg">
          <Radio.Content><Radio.Control><Radio.Indicator /></Radio.Control>EPG(XMLTV)</Radio.Content>
        </Radio>
        <Radio value="nas">
          <Radio.Content><Radio.Control><Radio.Indicator /></Radio.Control>NAS</Radio.Content>
        </Radio>
        {/* 010 T034:kind=vod(在线点播;Apple CMS JSON 适配器) */}
        <Radio value="vod">
          <Radio.Content><Radio.Control><Radio.Indicator /></Radio.Control>在线点播(VOD)</Radio.Content>
        </Radio>
      </RadioGroup>
      <TextField className="w-full" value={name} onChange={setName}>
        <Label>来源名称</Label>
        <Input name="name" maxLength={100} />
      </TextField>
      {kind !== 'nas' ? (
        <>
          <TextField className="w-full" value={remoteUrl} onChange={setRemoteUrl}>
            <Label>
              {kind === 'epg'
                ? '节目单地址(XMLTV URL)'
                : kind === 'vod'
                  ? '在线点播根地址(Apple CMS URL)'
                  : '播放列表地址(M3U URL)'}
            </Label>
            <Input name="remoteUrl" placeholder={kind === 'epg' ? 'https://…/epg.xml' : 'http://…'} />
          </TextField>
          {/* 010 T034:adapter 固定 apple-cms-json 展示(内置唯一适配器,不提供选择) */}
          {kind === 'vod' ? (
            <div className="flex flex-col gap-1">
              <span className="text-sm text-muted">适配器(内置,不可更改)</span>
              <span
                className="rounded bg-surface px-2 py-1 text-sm text-foreground"
                data-testid="create-vod-adapter"
              >
                apple-cms-json
              </span>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            {/* T013:NAS 根目录原生 select 元素 → HeroUI Select。选项(请选择… '' + roots)、
                当前值(rootKey)与 onChange(setRootKey)语义等价;aria-label 替代 htmlFor。 */}
            <span id="source-root-label" className="text-sm text-muted">NAS 根目录</span>
            <Select
              aria-labelledby="source-root-label"
              selectedKey={rootKey}
              onSelectionChange={(key) => {
                if (key !== null) {
                  setRootKey(String(key));
                }
              }}
            >
              <Select.Trigger data-testid="source-root">
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  <ListBox.Item id="" textValue="请选择…">请选择…</ListBox.Item>
                  {(roots ?? []).map((root) => (
                    <ListBox.Item key={root.rootKey} id={root.rootKey} textValue={root.label}>{root.label}</ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </div>
          <TextField className="w-full" value={relativeDirectory} onChange={setRelativeDirectory}>
            <Label>相对目录</Label>
            <Input name="relativeDirectory" placeholder="movies" />
          </TextField>
        </>
      )}
      {error !== null ? (
        <p role="alert" className="text-sm text-danger">{error}</p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onPress={onCancel}>
          取消
        </Button>
        <Button type="submit" variant="primary" size="sm" data-testid="create-source-submit">
          创建(下一步开始导入)
        </Button>
      </div>
      <PasswordConfirmModal
        open={passwordOpen}
        title="确认创建来源"
        description="创建后明确进入「开始导入」;导入失败会保留上次成功目录。"
        submitLabel="确认创建"
        onSubmit={submit}
        onClose={() => setPasswordOpen(false)}
      />
    </Form>
  );
}
