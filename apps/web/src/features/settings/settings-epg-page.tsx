/**
 * EPG 管理页(T134,US8;FR-038;T025 数据层迁移):
 * - 来源清单(经 settings sources 域:kind=epg/iptv)经 useAppQuery(settings.epg 键,
 *   硬请求 + isPending 门控 / isError RetryableAlert(formatApiError + 重试)/ 成功出主体;
 *   页面域归属 epg 键 —— 与来源管理页各自硬请求,单页挂载 + 挂载即清,互不串缓存);
 * - 手动同步/IPTV 关联为 confirmed 变更(当次密码 + CAS/幂等 operationKey),成功后
 *   失效 settings.epg 键以服务端真值回填(替代原手工 load());任务状态在本页 jobs 表
 *   局部承载并经 useSettingsPolling 轮询(授权失效即终止;任务读取无键工厂归属);
 * - 逐频道手动匹配与解除:选频道 → 查询当前绑定 → 选候选(指定 EPG 来源)→
 *   手动锁定 / 解除(manual 失效不自动回退)。绑定查询/候选查询为 POST 敏感读取
 *   (当次密码):凭据不进查询缓存(契约「敏感动作不经查询缓存保留凭据」),由
 *   confirmed 动作闭包经 privateFetch 执行;手动锁定/解除为 confirmed 变更,
 *   绑定结果由匹配面板局部承载(无列表读取依赖,失效集合为空);
 * - 界面不提供定时同步、模糊匹配或批量匹配入口;
 * - 所有敏感操作经同一个「待执行动作 + 当次密码」弹层逐次验证(不复用验证态);
 * - 403 SETTINGS_ACCESS_* 经 handleAccessLost 立即隐藏;重新解锁后重挂硬请求。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, ListBox, Select } from '@heroui/react';
import { LoadingSpinner, RetryableAlert } from '../../shared/ui';
import { useAppMutation, useAppQuery } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import { formatApiError } from '../../shared/query/error';
import { privateFetch } from '../../shared/fetch';
import { classifySettingsWriteError, useSettingsPolling } from './shared/access-expiry';
import type {
  CandidateDto,
  EpgBindingDto,
  EpgCandidate,
  RefreshDto,
  SourceDto,
  SourcePageDto,
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
  const [jobs, setJobs] = useState<Record<string, RefreshDto>>({});
  const [channelSearch, setChannelSearch] = useState('');
  const [channels, setChannels] = useState<CandidateDto[] | null>(null);
  const [match, setMatch] = useState<MatchFlow | null>(null);
  const [candidateTarget, setCandidateTarget] = useState<EpgCandidate | null>(null);
  const [candidateQuery, setCandidateQuery] = useState('');
  const [pendingAction, setPendingAction] = useState<((password: string) => Promise<void>) | null>(null);
  const [pendingDescription, setPendingDescription] = useState<string>('');
  const [pageError, setPageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // EPG 页数据 = /settings/sources(kind 全量,页面内本地过滤 epg/iptv)。
  // 键取工厂的 settings.epg(页面域键):与来源管理页(sources 键)各自硬请求,
  // 单页挂载 + settings 域挂载即清,两页间不存在缓存互串。
  const sourcesQuery = useAppQuery<SourcePageDto>({
    domain: 'settings',
    queryKey: queryKeys.settings.epg(),
    queryFn: ({ signal }) => privateFetch<SourcePageDto>('/settings/sources', { signal }),
  });

  // 管理主体读取得到 403 SETTINGS_ACCESS_*:立即回到锁定态(解锁门随之隐藏本页)
  useEffect(() => {
    if (sourcesQuery.isError && classifySettingsWriteError(sourcesQuery.error) === 'access-lost') {
      access.handleAccessLost();
    }
  }, [sourcesQuery.isError, sourcesQuery.error, access]);

  /** 已补读状态的任务(避免列表回填后对同一任务重复引导读取) */
  const bootstrappedRef = useRef<Set<string>>(new Set());

  // 列表回填时,对来源上的最近任务补一次状态读取(进行中的任务随后进入轮询)
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
          bootstrappedRef.current.delete(jobId);
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
        if (isTerminal(fresh.status)) {
          void sourcesQuery.refetch(); // 终态:回填来源列表(lastSuccessAt/任务面板归位)
        }
      }
    }, [tracked, sourcesQuery]),
    { intervalMs: 1000, enabled: tracked.length > 0 },
  );

  const sources = sourcesQuery.data?.items ?? null;
  const epgSources = (sources ?? []).filter((source) => source.kind === 'epg');
  const iptvSources = (sources ?? []).filter((source) => source.kind === 'iptv');

  // 手动同步:confirmed 变更 + 当次密码 + 幂等 operationKey;成功后失效来源清单回填
  const startSync = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { sourceId: string; ownerPassword: string; expectedVersion: number }) =>
      privateFetch<RefreshDto>(`/settings/sources/${vars.sourceId}/refresh`, {
        method: 'POST',
        body: {
          ownerPassword: vars.ownerPassword,
          expectedVersion: vars.expectedVersion,
          operationKey: newOperationKey(),
        },
      }),
    invalidate: [queryKeys.settings.epg()],
  });

  // IPTV 关联(含解除):confirmed 变更 + 当次密码 + CAS;成功后失效来源清单回填
  const patchLink = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { sourceId: string; ownerPassword: string; expectedVersion: number; epgSourceId: string | null }) =>
      privateFetch<SourceDto>(`/settings/sources/${vars.sourceId}`, {
        method: 'PATCH',
        body: {
          ownerPassword: vars.ownerPassword,
          expectedVersion: vars.expectedVersion,
          epgSourceId: vars.epgSourceId,
        },
      }),
    invalidate: [queryKeys.settings.epg()],
  });

  // 手动锁定绑定:confirmed 变更 + CAS + expectedEpgGeneration。失效集合为空:
  // 绑定/候选仅由匹配面板局部承载(当次密码读取,不经查询缓存),无列表读取依赖。
  const saveBinding = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: {
      channel: CandidateDto;
      binding: EpgBindingDto;
      epgSourceId: string;
      candidateGeneration: number;
      target: EpgCandidate;
      ownerPassword: string;
    }) =>
      privateFetch<EpgBindingDto>(`/settings/catalog/media/${vars.channel.id}/epg-binding`, {
        method: 'PUT',
        body: {
          ownerPassword: vars.ownerPassword,
          expectedVersion: vars.binding.version,
          mode: 'manual',
          epgSourceId: vars.epgSourceId,
          xmltvChannelId: vars.target.xmltvChannelId,
          expectedEpgGeneration: vars.candidateGeneration,
        },
      }),
  });

  // 解除手动绑定(写 auto 墓碑):confirmed 变更 + CAS;失效集合为空(同上)
  const unbindBinding = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { channel: CandidateDto; binding: EpgBindingDto; ownerPassword: string }) =>
      privateFetch<EpgBindingDto>(`/settings/catalog/media/${vars.channel.id}/epg-binding`, {
        method: 'PUT',
        body: {
          ownerPassword: vars.ownerPassword,
          expectedVersion: vars.binding.version,
          mode: 'auto',
        },
      }),
  });

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
          void sourcesQuery.refetch(); // 失效对账等价:按服务端现值刷新界面
          return;
        }
        if (kind === 'password' && onPasswordError) {
          setPageError(formatApiError(cause)); // 密码错误:弹层保持,错误可见,输入保留
          return;
        }
        if (kind === 'validation' || kind === 'not-found' || kind === 'password' || kind === 'error') {
          throw cause;
        }
        throw cause;
      });
  };

  // 频道候选查询:POST 敏感读取(当次密码,凭据不进查询缓存)——confirmed 闭包内执行
  const doSearch = (password: string): Promise<void> =>
    privateFetch<{ items: CandidateDto[] }>('/settings/catalog/candidates/query', {
      method: 'POST',
      body: {
        ownerPassword: password,
        q: channelSearch === '' ? undefined : channelSearch,
        type: 'channel',
        pageSize: 20,
      },
    }).then((page) => {
      setChannels(page.items);
      setPendingAction(null);
    });

  const openMatch = (channel: CandidateDto): void => {
    setCandidateQuery('');
    requirePassword(`查询「${channel.title}」的当前 EPG 绑定与候选(当次密码)。`, (password) =>
      runGuarded(async () => {
        // 绑定/候选查询:POST 敏感读取(当次密码),凭据不进查询缓存
        const binding = await privateFetch<EpgBindingDto>(`/settings/catalog/media/${channel.id}/epg-binding/query`, {
          method: 'POST',
          body: { ownerPassword: password },
        });
        if (epgSources.length === 0) {
          setPageError('暂无可用 EPG 来源:请先在「来源管理」创建 kind=epg 来源并完成一次同步。');
          setPendingAction(null);
          return;
        }
        const epgSource = epgSources[0]!;
        const candidatePage = await privateFetch<{ items: EpgCandidate[]; epgGeneration: number }>(
          `/settings/catalog/media/${channel.id}/epg-candidates/query`,
          { method: 'POST', body: { ownerPassword: password, epgSourceId: epgSource.id, pageSize: 20 } },
        );
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
      {sourcesQuery.isPending ? <LoadingSpinner label="正在读取 EPG 来源…" /> : null}
      {sourcesQuery.isError ? (
        <RetryableAlert
          title="读取失败"
          description={formatApiError(sourcesQuery.error)}
          onRetry={() => void sourcesQuery.refetch()}
        />
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
                              startSync
                                .mutateAsync({ sourceId: source.id, ownerPassword: password, expectedVersion: source.version })
                                .then((job) => {
                                  setJobs((current) => ({ ...current, [job.id]: job }));
                                  setNotice(`同步任务已创建(状态 ${job.status}),正在轮询…`);
                                  setPendingAction(null);
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
                {/* T011:原生 select 元素 → HeroUI Select(Root/Trigger/Value/Indicator/Popover +
                    ListBox.Item;3.2.6 无 Select.Item,见 HEROUI-NOTES §3 坑 4)。
                    等价性:选项集合(未关联 '' + epgSources)、当前值(selectedKey=epgSourceId ?? '')、
                    变更回调(仍走 requirePassword 当次密码 + CAS,空键=解除关联)。 */}
                <Select
                  aria-label={`为 ${iptv.name} 选择 EPG 来源`}
                  selectedKey={iptv.epgSourceId ?? ''}
                  onSelectionChange={(key) => {
                    const next = key === null ? '' : String(key);
                    requirePassword(
                      next === '' ? `解除「${iptv.name}」的 EPG 关联。` : `将「${iptv.name}」关联到所选 EPG 来源。`,
                      (password) =>
                        runGuarded(
                          () =>
                            patchLink
                              .mutateAsync({
                                sourceId: iptv.id,
                                ownerPassword: password,
                                expectedVersion: iptv.version,
                                epgSourceId: next === '' ? null : next,
                              })
                              .then(() => {
                                setNotice(next === '' ? '已解除 EPG 关联' : 'EPG 关联已保存');
                                setPendingAction(null);
                              }),
                          false,
                        )(password),
                    );
                  }}
                >
                  <Select.Trigger data-testid={`epg-link-${iptv.id}`}>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      <ListBox.Item id="" textValue="未关联">未关联</ListBox.Item>
                      {epgSources.map((source) => (
                        <ListBox.Item key={source.id} id={source.id} textValue={source.name}>{source.name}</ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
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
          <div className="flex items-end gap-2">
            <div className="flex flex-1 flex-col gap-1">
              <label htmlFor="epg-candidate-q" className="text-xs text-muted">候选筛选(名称或 XMLTV ID 子串)</label>
              <input
                id="epg-candidate-q"
                className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
                value={candidateQuery}
                onChange={(event) => setCandidateQuery(event.target.value)}
                data-testid="epg-candidates-filter-q"
              />
            </div>
            <Button
              variant="primary"
              size="sm"
              onPress={() => {
                const current = match;
                if (current === null) {
                  return;
                }
                const needle = candidateQuery.trim();
                requirePassword(
                  needle === '' ? '查询全部 EPG 候选(当次密码)。' : `按「${needle}」筛选 EPG 候选(当次密码)。`,
                  (password) =>
                    runGuarded(async () => {
                      // 候选筛选:POST 敏感读取(当次密码),凭据不进查询缓存
                      const candidatePage = await privateFetch<{ items: EpgCandidate[]; epgGeneration: number }>(
                        `/settings/catalog/media/${current.channel.id}/epg-candidates/query`,
                        {
                          method: 'POST',
                          body: {
                            ownerPassword: password,
                            epgSourceId: current.epgSourceId,
                            q: needle === '' ? undefined : needle,
                            pageSize: 20,
                          },
                        },
                      );
                      setMatch((prev) =>
                        prev === null
                          ? prev
                          : { ...prev, candidates: candidatePage.items, candidateGeneration: candidatePage.epgGeneration },
                      );
                      setPendingAction(null);
                    }, false)(password),
                );
              }}
              data-testid="epg-candidates-apply"
            >
              筛选候选
            </Button>
          </div>
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
                      unbindBinding
                        .mutateAsync({ channel: match.channel, binding: match.binding, ownerPassword: password })
                        .then((saved) => {
                          setNotice(`已解除「${match.channel.title}」的手动匹配`);
                          setMatch((prev) => (prev === null ? prev : { ...prev, binding: saved }));
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
          return saveBinding
            .mutateAsync({
              channel: match.channel,
              binding: match.binding,
              epgSourceId: match.epgSourceId,
              candidateGeneration: match.candidateGeneration,
              target: candidateTarget,
              ownerPassword: password,
            })
            .then((saved) => {
              setNotice(`已手动匹配:「${match.channel.title}」→ ${candidateTarget.displayName}(${saved.status})`);
              setMatch((prev) => (prev === null ? prev : { ...prev, binding: saved }));
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
