/**
 * 来源管理页(T134,US8;FR-037):
 * - IPTV/NAS 来源配置、启停、手动导入(刷新)、任务状态轮询(授权失效即终止);
 * - 创建成功明确「开始导入」下一步;快照确认(awaiting_confirmation)提供确认/丢弃;
 * - 成功发布后提供「查看内容」入口;失败提示重试并保留上次成功目录(不自动清理);
 * - 每敏感操作独立弹当次密码;409 冲突提示重读现值,不静默覆盖。
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Button, Form, TextField, Label, Input } from '@heroui/react';
import { LoadingSpinner, RetryableAlert } from '../../shared/ui';
import { classifySettingsWriteError, useSettingsPolling } from './shared/access-expiry';
import { errorTextOf, settingsApi, type RefreshDto, type RootDto, type SourceDto } from './shared/settings-api';
import { PasswordConfirmModal } from './shared/password-confirm-modal';
import { useUnsavedGuard } from './shared/unsaved-guard';
import { useSettingsAccess } from './settings-access-provider';
import { useSettingsPageMeta } from './settings-modules';

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
  const [sources, setSources] = useState<SourceDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createdSource, setCreatedSource] = useState<SourceDto | null>(null); // 创建成功 → 「开始导入」下一步
  const [jobs, setJobs] = useState<Record<string, RefreshDto>>({});
  const [confirmJob, setConfirmJob] = useState<{ job: RefreshDto; action: 'confirm' | 'discard' } | null>(null);
  const [confirmPatch, setConfirmPatch] = useState<{ source: SourceDto; input: Record<string, unknown> } | null>(null);
  const [importTarget, setImportTarget] = useState<SourceDto | null>(null);
  const [importKey, setImportKey] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback((): void => {
    void (async () => {
      try {
        const page = await settingsApi.listSources();
        setSources(page.items);
        setLoadError(null);
        // 页面打开/刷新时,对来源上的最近任务补一次状态读取(进行中的任务随后进入轮询)
        for (const source of page.items) {
          if (source.lastJobId === null) {
            continue;
          }
          try {
            const job = await settingsApi.getRefresh(source.lastJobId);
            setJobs((current) => ({ ...current, [job.id]: job }));
          } catch (jobError) {
            if (classifySettingsWriteError(jobError) === 'access-lost') {
              access.handleAccessLost();
              return;
            }
            // 单个任务不可见不阻塞来源列表
          }
        }
      } catch (error) {
        if (classifySettingsWriteError(error) === 'access-lost') {
          access.handleAccessLost();
          return;
        }
        setLoadError(errorTextOf(error));
      }
    })();
  }, [access]);

  useEffect(() => {
    load();
  }, [load, access.reloadEpoch, attempt]);

  // 任务状态轮询:仅跟踪进行中/待确认任务;授权失效由 useSettingsPolling 立即终止
  const tracked = Object.values(jobs).filter((job) => !isTerminal(job.status));
  useSettingsPolling(
    async () => {
      for (const job of tracked) {
        const fresh = await settingsApi.getRefresh(job.id);
        setJobs((current) => ({ ...current, [fresh.id]: fresh }));
        if (fresh.status === 'succeeded' || fresh.status === 'failed') {
          load(); // 发布成功/失败:刷新来源列表(lastSuccessAt/查看内容入口/失败提示)
        }
      }
    },
    { intervalMs: 1000, enabled: tracked.length > 0 },
  );

  const isDirty = creating; // 创建表单打开即视为存在未保存编辑(FR-041 拦截)
  const guard = useUnsavedGuard(isDirty);

  const openImport = (source: SourceDto): void => {
    setPageError(null);
    setImportKey(newOperationKey());
    setImportTarget(source);
  };

  return (
    <section aria-label={`设置 · ${title}`} className="flex flex-1 flex-col gap-4 py-2">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      {sources === null && loadError === null ? <LoadingSpinner label="正在读取来源…" /> : null}
      {loadError !== null ? (
        <RetryableAlert title="读取失败" description={loadError} onRetry={() => setAttempt((n) => n + 1)} />
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
            return (
              <li key={source.id} className="flex flex-col gap-2 rounded border border-border p-3" data-testid={`source-row-${source.id}`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium text-foreground">
                      {source.name}
                      <span className="ml-2 rounded bg-surface px-1.5 py-0.5 text-xs text-muted">{source.kind}</span>
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
            setCreatedSource(source); // 明确「开始导入」下一步(FR-037)
            load();
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
          return settingsApi
            .startRefresh(importTarget.id, {
              ownerPassword,
              expectedVersion: importTarget.version,
              operationKey: importKey,
            })
            .then((job) => {
              setJobs((current) => ({ ...current, [job.id]: job }));
              setNotice(`导入任务已创建(状态 ${job.status}),正在轮询任务状态…`);
              setCreatedSource(null); // 下一步动作已完成
              load(); // 刷新来源列表:令 source.lastJobId → 任务面板可见
            })
            .catch((cause: unknown) => {
              const kind = classifySettingsWriteError(cause);
              if (kind === 'access-lost') {
                access.handleAccessLost();
                return;
              }
              if (kind === 'conflict') {
                setPageError('来源已被其他操作修改(版本冲突):列表已按服务端现值刷新,请重试。');
                load();
                return;
              }
              throw cause; // 密码错误:弹层保持
            });
        }}
        onClose={() => {
          setImportTarget(null);
          setImportKey(null);
        }}
      />

      {/* 启停/字段修改:当次密码 + expectedVersion CAS */}
      <PasswordConfirmModal
        open={confirmPatch !== null}
        title="保存来源修改"
        submitLabel="确认保存"
        onSubmit={(ownerPassword: string) => {
          if (confirmPatch === null) {
            return Promise.reject(new Error('no patch'));
          }
          return settingsApi
            .patchSource(confirmPatch.source.id, { ownerPassword, ...confirmPatch.input })
            .then(() => {
              setNotice('来源已保存');
              load();
            })
            .catch((cause: unknown) => {
              const kind = classifySettingsWriteError(cause);
              if (kind === 'access-lost') {
                access.handleAccessLost();
                return;
              }
              if (kind === 'conflict') {
                setPageError('来源已被其他操作修改(版本冲突):列表已按服务端现值刷新,请重试。');
                load();
                return;
              }
              throw cause;
            });
        }}
        onClose={() => setConfirmPatch(null)}
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
          const request =
            confirmJob.action === 'confirm'
              ? settingsApi.confirmRefresh(confirmJob.job.id, ownerPassword, confirmJob.job.version)
              : settingsApi.discardRefresh(confirmJob.job.id, ownerPassword, confirmJob.job.version);
          return request.then(
            (fresh) => {
              setJobs((current) => ({ ...current, [fresh.id]: fresh }));
              setNotice(fresh.status === 'succeeded' ? '快照已确认发布' : '快照已丢弃,上次成功目录保留');
              load();
            },
            (cause: unknown) => {
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
            },
          );
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
  onCreated: (source: SourceDto) => void;
  onCancel: () => void;
}): ReactNode {
  const access = useSettingsAccess();
  const [kind, setKind] = useState<'iptv' | 'nas'>('iptv');
  const [name, setName] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [rootKey, setRootKey] = useState('');
  const [relativeDirectory, setRelativeDirectory] = useState('');
  const [roots, setRoots] = useState<RootDto[] | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (kind === 'nas' && roots === null) {
      void settingsApi
        .listRoots()
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

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (name.trim() === '') {
      setError('请填写来源名称');
      return;
    }
    if (kind === 'iptv' && remoteUrl.trim() === '') {
      setError('IPTV 来源必须提供 remoteUrl');
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
    settingsApi
      .createSource({
        ownerPassword,
        kind,
        name: name.trim(),
        enabled: true,
        privateAccessApproved: true,
        ...(kind === 'iptv' ? { remoteUrl: remoteUrl.trim() } : { rootKey, relativeDirectory }),
      })
      .then(onCreated)
      .catch((cause: unknown) => {
        const kindOf = classifySettingsWriteError(cause);
        if (kindOf === 'access-lost') {
          access.handleAccessLost();
          return;
        }
        throw cause; // 目标被拒/密码错误:弹层呈现服务端稳定文案
      });

  return (
    <Form onSubmit={handleSubmit} className="flex max-w-md flex-col gap-3 rounded border border-border p-4" aria-label="新建来源">
      <h3 className="text-sm font-semibold text-foreground">新建来源</h3>
      <fieldset className="flex gap-4 text-sm">
        <legend className="text-muted">类型</legend>
        <label className="flex items-center gap-1">
          <input type="radio" name="source-kind" checked={kind === 'iptv'} onChange={() => setKind('iptv')} />
          IPTV
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" name="source-kind" checked={kind === 'nas'} onChange={() => setKind('nas')} />
          NAS
        </label>
      </fieldset>
      <TextField className="w-full" value={name} onChange={setName}>
        <Label>来源名称</Label>
        <Input name="name" maxLength={100} />
      </TextField>
      {kind === 'iptv' ? (
        <TextField className="w-full" value={remoteUrl} onChange={setRemoteUrl}>
          <Label>播放列表地址(M3U URL)</Label>
          <Input name="remoteUrl" placeholder="http://…" />
        </TextField>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <label htmlFor="source-root" className="text-sm text-muted">NAS 根目录</label>
            <select
              id="source-root"
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
              value={rootKey}
              onChange={(event) => setRootKey(event.target.value)}
            >
              <option value="">请选择…</option>
              {(roots ?? []).map((root) => (
                <option key={root.rootKey} value={root.rootKey}>{root.label}</option>
              ))}
            </select>
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
