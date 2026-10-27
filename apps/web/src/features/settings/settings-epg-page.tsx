/**
 * EPG 管理页(T134,US8;FR-038):
 * - EPG 来源配置(经 settings sources 域:kind=epg)、手动同步、任务状态轮询
 *   (授权失效即终止);
 * - IPTV 关联(为 IPTV 来源选择 EPG 来源;PATCH epgSourceId,当次密码 + CAS);
 * - 逐频道手动匹配与解除:选频道 → 查询当前绑定 → 选候选(指定 EPG 来源)→
 *   手动锁定 / 解除(manual 失效不自动回退);
 * - 界面不提供定时同步、模糊匹配或批量匹配入口;
 * - 所有敏感操作经同一个「待执行动作 + 当次密码」弹层逐次验证(不复用验证态)。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@heroui/react';
import { LoadingSpinner, RetryableAlert } from '../../shared/ui';
import { classifySettingsWriteError, useSettingsPolling } from './shared/access-expiry';
import {
  errorTextOf,
  settingsApi,
  type CandidateDto,
  type EpgBindingDto,
  type EpgCandidate,
  type RefreshDto,
  type SourceDto,
} from './shared/settings-api';
import { PasswordConfirmModal } from './shared/password-confirm-modal';
import { useSettingsAccess } from './settings-access-provider';
import { useSettingsPageMeta } from './settings-modules';

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

interface MatchFlow {
  channel: CandidateDto;
  binding: EpgBindingDto;
  epgSourceId: string;
  candidates: EpgCandidate[];
  candidateGeneration: number;
}

export function SettingsEpgPage(): ReactNode {
  const access = useSettingsAccess();
  const { title } = useSettingsPageMeta();
  const [sources, setSources] = useState<SourceDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [jobs, setJobs] = useState<Record<string, RefreshDto>>({});
  const [channelSearch, setChannelSearch] = useState('');
  const [channels, setChannels] = useState<CandidateDto[] | null>(null);
  const [match, setMatch] = useState<MatchFlow | null>(null);
  const [candidateTarget, setCandidateTarget] = useState<EpgCandidate | null>(null);
  const [pendingAction, setPendingAction] = useState<((password: string) => Promise<void>) | null>(null);
  const [pendingDescription, setPendingDescription] = useState<string>('');
  const [pageError, setPageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback((): void => {
    void (async () => {
      try {
        const page = await settingsApi.listSources();
        setSources(page.items);
        setLoadError(null);
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

  const tracked = Object.values(jobs).filter((job) => !isTerminal(job.status));
  useSettingsPolling(
    async () => {
      for (const job of tracked) {
        const fresh = await settingsApi.getRefresh(job.id);
        setJobs((current) => ({ ...current, [fresh.id]: fresh }));
        if (isTerminal(fresh.status)) {
          load();
        }
      }
    },
    { intervalMs: 1000, enabled: tracked.length > 0 },
  );

  const epgSources = (sources ?? []).filter((source) => source.kind === 'epg');
  const iptvSources = (sources ?? []).filter((source) => source.kind === 'iptv');

  /** 统一入口:弹出当次密码确认后执行 action;密码错误弹层保持(内容保留) */
  const requirePassword = (description: string, action: (password: string) => Promise<void>): void => {
    setPageError(null);
    setNotice(null);
    setPendingDescription(description);
    setPendingAction(() => action);
  };

  const runGuarded = (action: () => Promise<void>, onPasswordError: boolean): ((password: string) => Promise<void>) => {
    return (_password: string) =>
      action().catch((cause: unknown) => {
        const kind = classifySettingsWriteError(cause);
        if (kind === 'access-lost') {
          access.handleAccessLost();
          setPendingAction(null);
          return;
        }
        if (kind === 'conflict') {
          setPageError('版本冲突:数据已被其他操作修改,界面已按服务端现值刷新,请重新操作。');
          setPendingAction(null);
          load();
          return;
        }
        if (kind === 'password' && onPasswordError) {
          setPageError(errorTextOf(cause)); // 密码错误:弹层保持,错误可见,输入保留
          return;
        }
        if (kind === 'validation' || kind === 'not-found' || kind === 'password' || kind === 'error') {
          throw cause;
        }
        throw cause;
      });
  };

  const doSearch = (password: string): Promise<void> =>
    settingsApi
      .queryCandidates({
        ownerPassword: password,
        q: channelSearch === '' ? undefined : channelSearch,
        type: 'channel',
        pageSize: 20,
      })
      .then((page) => {
        setChannels(page.items);
        setPendingAction(null);
      });

  const openMatch = (channel: CandidateDto): void => {
    requirePassword(`查询「${channel.title}」的当前 EPG 绑定与候选(当次密码)。`, (password) =>
      runGuarded(async () => {
        const binding = await settingsApi.queryBinding(channel.id, password);
        if (epgSources.length === 0) {
          setPageError('暂无可用 EPG 来源:请先在「来源管理」创建 kind=epg 来源并完成一次同步。');
          setPendingAction(null);
          return;
        }
        const epgSource = epgSources[0]!;
        const candidatePage = await settingsApi.queryEpgCandidates(channel.id, {
          ownerPassword: password,
          epgSourceId: epgSource.id,
          pageSize: 20,
        });
        setMatch({
          channel,
          binding,
          epgSourceId: epgSource.id,
          candidates: candidatePage.items,
          candidateGeneration: candidatePage.epgGeneration,
        });
        setPendingAction(null);
      }, false)(password),
    );
  };

  return (
    <section aria-label={`设置 · ${title}`} className="flex flex-1 flex-col gap-4 py-2">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      {sources === null && loadError === null ? <LoadingSpinner label="正在读取 EPG 来源…" /> : null}
      {loadError !== null ? (
        <RetryableAlert title="读取失败" description={loadError} onRetry={() => setAttempt((n) => n + 1)} />
      ) : null}
      {pageError !== null ? <p role="alert" className="text-sm text-danger">{pageError}</p> : null}
      {notice !== null ? <p role="status" className="text-sm text-success" data-testid="epg-notice">{notice}</p> : null}

      {/* EPG 来源 + 手动同步 */}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-foreground">EPG 来源(手动同步;无定时任务)</h3>
        {epgSources.length === 0 ? (
          <p className="text-sm text-muted">暂无 EPG 来源;请在「来源管理」创建 kind=epg 的来源。</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="epg-source-list">
            {epgSources.map((source) => {
              const job = source.lastJobId !== null ? (jobs[source.lastJobId] ?? null) : null;
              return (
                <li key={source.id} className="flex flex-col gap-2 rounded border border-border p-3" data-testid={`epg-source-${source.id}`}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium text-foreground">
                        {source.name}
                        <span className={`ml-2 text-xs ${source.enabled ? 'text-success' : 'text-danger'}`}>
                          {source.enabled ? '已启用' : '已停用'}
                        </span>
                      </span>
                      <span className="text-xs text-muted">
                        {source.lastSuccessAt !== null
                          ? `上次同步成功 ${source.lastSuccessAt.slice(0, 19).replace('T', ' ')}`
                          : '尚未成功同步'}
                      </span>
                    </div>
                    <Button
                      variant="primary"
                      size="sm"
                      onPress={() =>
                        requirePassword(`将立即同步「${source.name}」(幂等任务键,失败保留上次成功节目单)。`, (password) =>
                          runGuarded(
                            () =>
                              settingsApi
                                .startRefresh(source.id, {
                                  ownerPassword: password,
                                  expectedVersion: source.version,
                                  operationKey: newOperationKey(),
                                })
                                .then((job) => {
                                  setJobs((current) => ({ ...current, [job.id]: job }));
                                  setNotice(`同步任务已创建(状态 ${job.status}),正在轮询…`);
                                  setPendingAction(null);
                                  load(); // 刷新来源列表:令 source.lastJobId → 任务面板可见
                                }),
                            false,
                          )(password),
                        )
                      }
                      isDisabled={!source.enabled}
                      data-testid={`epg-sync-${source.id}`}
                    >
                      手动同步
                    </Button>
                  </div>
                  {job !== null ? (
                    <p className="rounded bg-surface p-2 text-xs text-muted" data-testid={`epg-job-${source.id}`}>
                      同步任务:{job.status}
                      {job.errorCode != null ? ` · ${job.errorCode}` : ''}
                      {job.counts != null ? ` · 频道 ${job.counts.channels} / 节目 ${job.counts.programmes}` : ''}
                      {job.status === 'failed' ? ' · 上次成功节目单保留,可重试' : ''}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* IPTV 关联 */}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-foreground">IPTV 关联</h3>
        {iptvSources.length === 0 ? (
          <p className="text-sm text-muted">暂无 IPTV 来源。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {iptvSources.map((iptv) => (
              <li key={iptv.id} className="flex flex-wrap items-center justify-between gap-3 rounded border border-border p-3">
                <span className="text-sm text-foreground">
                  {iptv.name}
                  <span className="ml-2 text-xs text-muted">
                    当前关联:
                    {iptv.epgSourceId !== null
                      ? ((sources ?? []).find((s) => s.id === iptv.epgSourceId)?.name ?? '已关联来源')
                      : '未关联'}
                  </span>
                </span>
                <select
                  aria-label={`为 ${iptv.name} 选择 EPG 来源`}
                  className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
                  value={iptv.epgSourceId ?? ''}
                  onChange={(event) => {
                    const next = event.target.value;
                    requirePassword(
                      next === '' ? `解除「${iptv.name}」的 EPG 关联。` : `将「${iptv.name}」关联到所选 EPG 来源。`,
                      (password) =>
                        runGuarded(
                          () =>
                            settingsApi
                              .patchSource(iptv.id, { ownerPassword: password, expectedVersion: iptv.version, epgSourceId: next === '' ? null : next })
                              .then(() => {
                                setNotice(next === '' ? '已解除 EPG 关联' : 'EPG 关联已保存');
                                setPendingAction(null);
                                load();
                              }),
                          false,
                        )(password),
                    );
                  }}
                  data-testid={`epg-link-${iptv.id}`}
                >
                  <option value="">未关联</option>
                  {epgSources.map((source) => (
                    <option key={source.id} value={source.id}>{source.name}</option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 逐频道手动匹配 */}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-foreground">逐频道手动匹配(仅手动;无模糊/批量)</h3>
        <div className="flex max-w-md items-end gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <label htmlFor="epg-channel-q" className="text-sm text-muted">频道名称</label>
            <input
              id="epg-channel-q"
              className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
              value={channelSearch}
              onChange={(event) => setChannelSearch(event.target.value)}
              data-testid="epg-channel-q"
            />
          </div>
          <Button
            variant="primary"
            size="sm"
            onPress={() => requirePassword('查询频道候选需当次密码验证。', (password) => runGuarded(() => doSearch(password).catch(() => undefined), false)(password))}
            data-testid="epg-channel-search"
          >
            查询频道
          </Button>
        </div>
        {channels !== null ? (
          channels.length === 0 ? (
            <p className="text-sm text-muted">没有匹配的频道。</p>
          ) : (
            <ul className="flex flex-col gap-1" data-testid="epg-channel-list">
              {channels.map((channel) => (
                <li key={channel.id} className="flex items-center justify-between gap-3 rounded border border-border px-3 py-1.5">
                  <span className="truncate text-sm text-foreground">
                    {channel.title}
                    <span className="ml-2 text-xs text-muted">版本 {channel.version}</span>
                  </span>
                  <Button variant="ghost" size="sm" onPress={() => openMatch(channel)} data-testid={`epg-match-${channel.id}`}>
                    匹配 / 解除
                  </Button>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>

      {/* 匹配面板:当前绑定 + 候选选择 + 解除 */}
      {match !== null ? (
        <div className="flex max-w-2xl flex-col gap-3 rounded border border-border p-4" data-testid="epg-match-panel">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">「{match.channel.title}」的 EPG 匹配</h3>
            <Button variant="ghost" size="sm" onPress={() => setMatch(null)}>
              关闭
            </Button>
          </div>
          <p className="text-xs text-muted">
            当前绑定:
            {match.binding.mode === 'manual'
              ? `手动 → ${match.binding.xmltvChannelId ?? ''}(${match.binding.status}${match.binding.invalidReason !== null ? `:${match.binding.invalidReason}` : ''};manual 失效不自动回退)`
              : '自动(未手动锁定)'}
            ,版本 {match.binding.version}。
          </p>
          <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto">
            {match.candidates.length === 0 ? (
              <li className="text-sm text-muted">该 EPG 来源暂无候选频道(可能尚未成功同步)。</li>
            ) : (
              match.candidates.map((candidate) => (
                <li key={candidate.xmltvChannelId} className="flex items-center justify-between gap-3 rounded border border-border px-3 py-1.5">
                  <span className="truncate text-sm text-foreground">
                    {candidate.displayName}
                    <span className="ml-2 text-xs text-muted">{candidate.xmltvChannelId}</span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onPress={() => setCandidateTarget(candidate)}
                    data-testid={`epg-candidate-${candidate.xmltvChannelId}`}
                  >
                    选定
                  </Button>
                </li>
              ))
            )}
          </ul>
          {match.binding.mode === 'manual' ? (
            <Button
              variant="danger"
              size="sm"
              className="self-start"
              onPress={() =>
                requirePassword(`解除「${match.channel.title}」的手动绑定(写 auto 墓碑,不自动回退)。`, (password) =>
                  runGuarded(
                    () =>
                      settingsApi
                        .unbindBinding(match.channel.id, {
                          ownerPassword: password,
                          expectedVersion: match.binding.version,
                          mode: 'auto',
                        })
                        .then((saved) => {
                          setNotice(`已解除「${match.channel.title}」的手动匹配`);
                          setMatch({ ...match, binding: saved });
                          setPendingAction(null);
                        }),
                    false,
                  )(password),
                )
              }
              data-testid="epg-unbind"
            >
              解除手动匹配
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* 统一当次密码弹层:待执行动作逐次验证 */}
      <PasswordConfirmModal
        open={pendingAction !== null}
        title="当次密码验证"
        description={pendingDescription}
        submitLabel="确认执行"
        onSubmit={
          pendingAction === null
            ? () => Promise.reject(new Error('no action'))
            : (password: string) => pendingAction(password)
        }
        onClose={() => setPendingAction(null)}
      />

      {/* manual 匹配二次确认(选定候选后) */}
      <PasswordConfirmModal
        open={candidateTarget !== null && match !== null}
        title="手动匹配 EPG 频道"
        description={
          candidateTarget !== null && match !== null
            ? `将「${match.channel.title}」手动锁定到「${candidateTarget.displayName}」;manual 失效后不会自动回退。`
            : ''
        }
        submitLabel="确认匹配"
        onSubmit={(password: string) => {
          if (candidateTarget === null || match === null) {
            return Promise.reject(new Error('no candidate'));
          }
          return settingsApi
            .saveBinding(match.channel.id, {
              ownerPassword: password,
              expectedVersion: match.binding.version,
              mode: 'manual',
              epgSourceId: match.epgSourceId,
              xmltvChannelId: candidateTarget.xmltvChannelId,
              expectedEpgGeneration: match.candidateGeneration,
            })
            .then((saved) => {
              setNotice(`已手动匹配:「${match.channel.title}」→ ${candidateTarget.displayName}(${saved.status})`);
              setMatch({ ...match, binding: saved });
              setCandidateTarget(null);
            })
            .catch((cause: unknown) => {
              const kind = classifySettingsWriteError(cause);
              if (kind === 'access-lost') {
                access.handleAccessLost();
                return;
              }
              if (kind === 'conflict') {
                setPageError('候选指南或绑定已变化(版本冲突):请重新打开匹配流程。');
                setMatch(null);
                setCandidateTarget(null);
                return;
              }
              throw cause; // 密码错误:弹层保持
            });
        }}
        onClose={() => setCandidateTarget(null)}
      />
    </section>
  );
}
