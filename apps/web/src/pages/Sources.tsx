/**
 * 来源管理页(T030;T045 增强 EPG 能力,User Story 1/4)。
 *
 * - GET /sources 分页列表:类型徽标 / 启用开关 / 版本 / 最近成功时间 / 最近任务状态;
 *   lastJobId 对应的任务在进入页面时按需回查,跨会话仍能看到终态与待确认摘要;
 *   EPG 来源同样展示最近成功时间与最近任务,成功摘要显示「频道 N / 节目 M」;
 * - 新增/编辑:SourceFormCard 页内表单(kind/NAS 根域编辑不可改;EPG 仅名称/地址/启用,
 *   副标题提示首次保存后用刷新完成导入;IPTV 编辑可选同家庭 EPG,关联已停用 EPG
 *   允许保存并提示暂无节目;remoteUrl 留空保留现值、掩码拦截),提交经家长验证;
 *   409 SOURCE_VERSION_CONFLICT 提示「配置已更新,请刷新后重试」;
 * - 刷新:startSourceRefresh(ownerPassword 经家长验证弹窗)→ pollRefresh 每 2 秒轮询,
 *   进入终态或待确认时停止,页面离开统一 abort;
 * - 待确认:行内原因(快照为空 / 缺失比例达到 25%)与确认发布/丢弃,均需家长验证;
 *   failed/interrupted 行内提供「重试」(重新发起刷新,同样经家长验证);
 * - 错误仅显示稳定 code 对应的友好文案;401 交给现有会话处理(SessionProvider → 登录)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Chip,
  Spinner,
  Switch,
} from '@heroui/react';
import { ApiError, api, pollRefresh } from '../lib/api';
import { useSession } from '../lib/session';
import { ParentVerificationModal } from '../components/ParentVerificationModal';
import { SourceFormCard, type SourceFormPayload } from '../components/sources/SourceFormCard';
import { SourceJobSummary } from '../components/sources/SourceJobSummary';
import {
  SOURCE_KIND_LABELS,
  friendlyErrorMessage,
  formatDateTime,
  type SourceKind,
} from '../components/sources/messages';
import type {
  CreateSourceRequest,
  PatchSourceRequest,
  RefreshDto,
  RootDto,
  SourceDto,
} from '@hmp/shared';

/** 列表分页大小(契约默认 20,最大 100) */
const PAGE_SIZE = 20;

/** EPG 候选遍历的页数上限(MVP 兜底,避免异常 total 造成死循环) */
const EPG_SCAN_PAGE_LIMIT = 5;

/** 操作结果通知;tone=warning 用于「需要人工确认」类提示 */
interface NoticeState {
  tone: 'success' | 'danger' | 'warning';
  message: string;
}

/** 等待家长验证的操作(弹窗确认后按类型分发) */
type PendingVerification =
  | { action: 'createSource'; body: CreateSourceRequest }
  | { action: 'patchSource'; sourceId: string; body: PatchSourceRequest }
  | { action: 'refreshSource'; source: SourceDto }
  | { action: 'confirmRefresh'; job: RefreshDto }
  | { action: 'discardRefresh'; job: RefreshDto };

/** 表单模式(编辑时锁定目标来源) */
type FormMode = { type: 'create' } | { type: 'edit'; source: SourceDto };

/** 类型徽标配色(信息由文字承载,颜色仅强化) */
function kindChipColor(kind: SourceKind): 'accent' | 'success' | 'default' {
  switch (kind) {
    case 'iptv':
      return 'accent';
    case 'epg':
      return 'success';
    default:
      return 'default';
  }
}

/** 任务是否占用来源(queued/running/awaiting_confirmation 期间禁止再次刷新) */
function isJobBlocking(status: RefreshDto['status']): boolean {
  return status === 'queued' || status === 'running' || status === 'awaiting_confirmation';
}

/** 判断错误是否为轮询被中止(页面离开/组件卸载,静默即可) */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** 家长验证弹窗的按操作说明文案 */
function verifyDescription(pending: PendingVerification | null): string | undefined {
  if (pending === null) {
    return undefined;
  }
  switch (pending.action) {
    case 'createSource':
      return `创建来源「${pending.body.name}」`;
    case 'patchSource':
      return '保存来源配置修改(kind 与 NAS 根域不可修改)';
    case 'refreshSource':
      return `刷新来源「${pending.source.name}」;导入完成并确认前不会改变现有目录`;
    case 'confirmRefresh':
      return '确认发布该刷新快照(将改变观看目录)';
    case 'discardRefresh':
      return '丢弃该刷新快照(保留现有目录不变)';
  }
}

export function Sources() {
  const { refresh: refreshSession } = useSession();

  /* ------------------------------ 列表与分页 ------------------------------ */
  const [sources, setSources] = useState<SourceDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  /** page 的 ref 镜像:轮询回调等异步路径读取,避免闭包过期 */
  const pageRef = useRef(1);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  /* ------------------------------ 表单与选项 ------------------------------ */
  const [formMode, setFormMode] = useState<FormMode>({ type: 'create' });
  const [epgOptions, setEpgOptions] = useState<SourceDto[]>([]);
  const [rootOptions, setRootOptions] = useState<RootDto[]>([]);

  /* --------------------------- 任务跟踪与轮询 --------------------------- */
  /** sourceId → 最近任务快照(含跨会话 lastJobId 回查结果) */
  const [jobsBySource, setJobsBySource] = useState<Record<string, RefreshDto>>({});
  const jobsRef = useRef<Record<string, RefreshDto>>({});
  /** 页面级轮询取消器:卸载时 abort 所有在途轮询 */
  const pollAbortRef = useRef<AbortController | null>(null);
  /** 回查发现仍在执行(queued/running)的任务:交由 effect 恢复轮询 */
  const [jobsToResume, setJobsToResume] = useState<string[]>([]);

  /* ----------------------------- 家长验证流程 ----------------------------- */
  const [pending, setPending] = useState<PendingVerification | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  /** 401 交给现有会话处理:触发会话刷新 → SessionProvider 置匿名 → 路由守卫转登录 */
  const handleUnauthorized = useCallback((): void => {
    void refreshSession();
  }, [refreshSession]);

  /** 记录任务快照(state + ref 双写,异步回调始终读最新值) */
  const trackJob = useCallback((job: RefreshDto): void => {
    jobsRef.current = { ...jobsRef.current, [job.sourceId]: job };
    setJobsBySource(jobsRef.current);
  }, []);

  const loadSources = useCallback(
    async (targetPage: number): Promise<void> => {
      pageRef.current = targetPage;
      setPage(targetPage);
      setLoading(true);
      setListError(null);
      try {
        const result = await api.listSources(targetPage, PAGE_SIZE);
        setSources(result.items);
        setTotal(result.total);
        // 回查上一会话遗留的最近任务(本会话已跟踪的来源不覆盖)
        const pendingLookup = result.items.filter(
          (item): item is SourceDto & { lastJobId: string } =>
            item.lastJobId !== null && jobsRef.current[item.id] === undefined,
        );
        const settled = await Promise.allSettled(
          pendingLookup.map((item) => api.getRefresh(item.lastJobId)),
        );
        const resumeIds: string[] = [];
        for (const item of settled) {
          if (item.status === 'fulfilled') {
            trackJob(item.value);
            // 上一会话仍在执行的任务:恢复轮询直到终态
            if (item.value.status === 'queued' || item.value.status === 'running') {
              resumeIds.push(item.value.id);
            }
          }
          // 回查失败的来源:行内任务状态显示「—」,不影响列表
        }
        if (resumeIds.length > 0) {
          setJobsToResume(resumeIds);
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          handleUnauthorized();
        }
        setListError(friendlyErrorMessage(error, '来源列表加载失败，请检查网络后重试。'));
      } finally {
        setLoading(false);
      }
    },
    [handleUnauthorized, trackJob],
  );

  /** EPG 候选:GET /sources 翻页收集后按 kind=epg 过滤(契约无 kind 查询参数) */
  const loadEpgOptions = useCallback(async (): Promise<void> => {
    try {
      const collected: SourceDto[] = [];
      for (let current = 1; current <= EPG_SCAN_PAGE_LIMIT; current += 1) {
        const result = await api.listSources(current, 100);
        collected.push(...result.items);
        if (collected.length >= result.total) {
          break;
        }
      }
      setEpgOptions(collected.filter((item) => item.kind === 'epg'));
    } catch {
      // 下拉候选加载失败:退化为「不关联」,不阻塞表单
      setEpgOptions([]);
    }
  }, []);

  const loadRootOptions = useCallback(async (): Promise<void> => {
    try {
      setRootOptions(await api.listSourceRoots());
    } catch {
      // 根列表失败:创建 NAS 时下拉为空并提示不可选
      setRootOptions([]);
    }
  }, []);

  useEffect(() => {
    void loadSources(1);
    void loadEpgOptions();
    void loadRootOptions();
  }, [loadSources, loadEpgOptions, loadRootOptions]);

  // 页面离开:停止全部在途轮询(契约「UI 路由」:进入终态或页面离开停止)
  useEffect(() => {
    return () => {
      pollAbortRef.current?.abort();
    };
  }, []);

  const ensurePollSignal = useCallback((): AbortSignal => {
    if (pollAbortRef.current === null) {
      pollAbortRef.current = new AbortController();
    }
    return pollAbortRef.current.signal;
  }, []);

  /** 每 2 秒轮询任务直到终态或进入待确认(awaiting 时停下等用户操作) */
  const pollJob = useCallback(
    async (refreshId: string): Promise<void> => {
      try {
        const final = await pollRefresh({
          refreshId,
          signal: ensurePollSignal(),
          shouldStop: (snapshot) => {
            // 观测中间快照(queued→running),进入待确认时停止自动轮询
            trackJob(snapshot);
            return snapshot.status === 'awaiting_confirmation';
          },
        });
        trackJob(final);
        if (final.status === 'succeeded') {
          setNotice({ tone: 'success', message: '刷新完成，目录已更新。' });
        } else if (final.status === 'awaiting_confirmation') {
          setNotice({ tone: 'warning', message: '刷新完成，快照需要确认后才会发布。' });
        }
        await loadSources(pageRef.current);
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          handleUnauthorized();
          return;
        }
        setNotice({
          tone: 'danger',
          message: friendlyErrorMessage(error, '刷新状态查询失败，请稍后重试。'),
        });
      }
    },
    [ensurePollSignal, handleUnauthorized, loadSources, trackJob],
  );

  // 恢复轮询:回查发现的在途任务统一在此续轮(pollJob 完成后的列表刷新不会再产生续轮项)
  useEffect(() => {
    if (jobsToResume.length === 0) {
      return;
    }
    setJobsToResume([]);
    for (const refreshId of jobsToResume) {
      void pollJob(refreshId);
    }
  }, [jobsToResume, pollJob]);

  /* ------------------------------ 派生状态 ------------------------------ */

  /** 占用中的来源(禁用「刷新」按钮,避免 409 SOURCE_BUSY) */
  const busySourceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const job of Object.values(jobsBySource)) {
      if (isJobBlocking(job.status)) {
        ids.add(job.sourceId);
      }
    }
    return ids;
  }, [jobsBySource]);

  /* ------------------------------ 家长验证 ------------------------------ */

  const openEnableToggle = useCallback((source: SourceDto): void => {
    setNotice(null);
    setVerifyError(null);
    setPending({
      action: 'patchSource',
      sourceId: source.id,
      body: { expectedVersion: source.version, enabled: !source.enabled },
    });
  }, []);

  const openRefresh = useCallback((source: SourceDto): void => {
    setNotice(null);
    setVerifyError(null);
    setPending({ action: 'refreshSource', source });
  }, []);

  const openConfirm = useCallback((job: RefreshDto): void => {
    setNotice(null);
    setVerifyError(null);
    setPending({ action: 'confirmRefresh', job });
  }, []);

  const openDiscard = useCallback((job: RefreshDto): void => {
    setNotice(null);
    setVerifyError(null);
    setPending({ action: 'discardRefresh', job });
  }, []);

  const openFormSubmit = useCallback((payload: SourceFormPayload): void => {
    setNotice(null);
    setVerifyError(null);
    setPending(
      payload.mode === 'create'
        ? { action: 'createSource', body: payload.body }
        : { action: 'patchSource', sourceId: payload.sourceId, body: payload.body },
    );
  }, []);

  const openEdit = useCallback((source: SourceDto): void => {
    setNotice(null);
    setFormMode({ type: 'edit', source });
    document.getElementById('source-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const cancelEdit = useCallback((): void => {
    setFormMode({ type: 'create' });
  }, []);

  /** 家长验证通过后的统一分发:验证失败弹窗保持,其余失败关闭弹窗给提示 */
  const handleVerified = useCallback(
    async (password: string): Promise<void> => {
      const pendingAction = pending;
      if (pendingAction === null || acting) {
        return;
      }
      setActing(true);
      setVerifyError(null);
      try {
        switch (pendingAction.action) {
          case 'createSource': {
            const created = await api.createSource({
              ...pendingAction.body,
              ownerPassword: password,
            });
            setNotice({ tone: 'success', message: `已创建来源「${created.name}」。` });
            setFormMode({ type: 'create' });
            await Promise.all([loadSources(1), loadEpgOptions()]);
            break;
          }
          case 'patchSource': {
            const updated = await api.patchSource(pendingAction.sourceId, {
              ...pendingAction.body,
              ownerPassword: password,
            });
            setNotice({
              tone: 'success',
              message: `已保存来源「${updated.name}」（版本 ${updated.version}）。`,
            });
            setFormMode({ type: 'create' });
            await Promise.all([loadSources(pageRef.current), loadEpgOptions()]);
            break;
          }
          case 'refreshSource': {
            const started = await api.startSourceRefresh(pendingAction.source.id, {
              ownerPassword: password,
              expectedVersion: pendingAction.source.version,
              operationKey: crypto.randomUUID(),
            });
            trackJob(started);
            setNotice({
              tone: 'success',
              message: `已开始刷新「${pendingAction.source.name}」，正在执行…`,
            });
            void pollJob(started.id);
            break;
          }
          case 'confirmRefresh': {
            const done = await api.confirmRefresh(pendingAction.job.id, {
              ownerPassword: password,
              expectedVersion: pendingAction.job.version,
            });
            trackJob(done);
            setNotice({ tone: 'success', message: '快照已确认发布。' });
            await loadSources(pageRef.current);
            break;
          }
          case 'discardRefresh': {
            const done = await api.discardRefresh(pendingAction.job.id, {
              ownerPassword: password,
              expectedVersion: pendingAction.job.version,
            });
            trackJob(done);
            setNotice({ tone: 'success', message: '快照已丢弃，现有目录保持不变。' });
            await loadSources(pageRef.current);
            break;
          }
        }
        setPending(null);
        setVerifyError(null);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          // 401 交给现有会话处理
          setPending(null);
          setVerifyError(null);
          handleUnauthorized();
          return;
        }
        const message = friendlyErrorMessage(error, '操作失败，请稍后重试。');
        if (error instanceof ApiError && (error.status === 403 || error.status === 423)) {
          // 验证失败/锁定:弹窗保持打开,由服务端计数与锁定统一限流
          setVerifyError(message);
        } else {
          setPending(null);
          setVerifyError(null);
          setNotice({ tone: 'danger', message });
          // 版本/状态冲突后同步服务端最新数据;编辑中的过期版本退出编辑,避免反复 409
          if (error instanceof ApiError && (error.status === 409 || error.status === 422)) {
            if (pendingAction.action === 'patchSource') {
              setFormMode({ type: 'create' });
            }
            if (
              pendingAction.action === 'confirmRefresh' ||
              pendingAction.action === 'discardRefresh'
            ) {
              // 状态冲突:回查任务最新快照,同步行内摘要(可能已被标记 stale/expired)
              void api.getRefresh(pendingAction.job.id).then(trackJob).catch(() => undefined);
            }
            void loadSources(pageRef.current);
          }
        }
      } finally {
        setActing(false);
      }
    },
    [acting, handleUnauthorized, loadEpgOptions, loadSources, pending, pollJob, trackJob],
  );

  const changePage = useCallback(
    (next: number): void => {
      void loadSources(next);
    },
    [loadSources],
  );

  /* ------------------------------- 渲染 ------------------------------- */

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">来源管理</h1>
        <p className="mt-1 text-sm text-muted">
          管理 IPTV 播放列表、EPG 节目指南与 NAS 媒体目录。重复刷新按身份去重,不会产生重复媒体;
          刷新失败时保留上次成功目录。
        </p>
      </div>

      {notice && (
        <Alert status={notice.tone}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>
              {notice.tone === 'success' ? '操作成功' : notice.tone === 'warning' ? '需要确认' : '操作未完成'}
            </Alert.Title>
            <Alert.Description>{notice.message}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {/* 来源列表 */}
      {loading && sources.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-12">
          <Spinner size="lg" />
          <p className="text-sm text-muted">正在加载来源…</p>
        </div>
      ) : listError !== null ? (
        <div className="space-y-4">
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>来源列表加载失败</Alert.Title>
              <Alert.Description>{listError}</Alert.Description>
            </Alert.Content>
          </Alert>
          <Button variant="outline" onPress={() => void loadSources(pageRef.current)}>
            重试
          </Button>
        </div>
      ) : sources.length === 0 ? (
        <p className="py-8 text-sm text-muted">还没有媒体来源,用下方表单添加第一个来源。</p>
      ) : (
        <>
          <ul className="space-y-3">
            {sources.map((source) => {
              const job = jobsBySource[source.id];
              const busy = busySourceIds.has(source.id);
              return (
                <li key={source.id} className="space-y-3 rounded-xl border border-border p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div className="min-w-0 space-y-1">
                      <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                        <Chip
                          size="sm"
                          variant="soft"
                          color={kindChipColor(source.kind)}
                          aria-label={`类型 ${SOURCE_KIND_LABELS[source.kind]}`}
                        >
                          {SOURCE_KIND_LABELS[source.kind]}
                        </Chip>
                        <span className="truncate">{source.name}</span>
                        <span className="text-xs text-muted">版本 {source.version}</span>
                        {!source.enabled && (
                          <span className="text-xs text-warning">⚠ 已停用</span>
                        )}
                      </p>
                      <p className="text-xs text-muted">
                        位置 {source.locationLabel} · 最近成功 {formatDateTime(source.lastSuccessAt)} ·
                        最近任务 {job === undefined ? '—' : '见下方摘要'}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-3">
                      <Switch
                        isSelected={source.enabled}
                        onChange={() => openEnableToggle(source)}
                        isDisabled={acting}
                      >
                        <Switch.Content>
                          <Switch.Control>
                            <Switch.Thumb />
                          </Switch.Control>
                          {source.enabled ? '已启用' : '已停用'}
                        </Switch.Content>
                      </Switch>
                      <Button
                        size="sm"
                        variant="outline"
                        isDisabled={busy || acting}
                        onPress={() => openRefresh(source)}
                      >
                        刷新
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        isDisabled={acting}
                        onPress={() => openEdit(source)}
                      >
                        编辑
                      </Button>
                    </div>
                  </div>

                  {/* 最近任务摘要:执行中/终态 counts;待确认含原因与操作按钮;
                      failed/interrupted 行内「重试」复用同一家长验证刷新流程(T045) */}
                  {job !== undefined && (
                    <SourceJobSummary
                      job={job}
                      source={source}
                      polling={job.status === 'queued' || job.status === 'running'}
                      isActionPending={acting}
                      onConfirm={() => openConfirm(job)}
                      onDiscard={() => openDiscard(job)}
                      onRetry={() => openRefresh(source)}
                    />
                  )}
                </li>
              );
            })}
          </ul>

          {/* 分页 */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">
              第 {page} / {totalPages} 页 · 共 {total} 个来源
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                isDisabled={page <= 1 || loading}
                onPress={() => changePage(page - 1)}
              >
                上一页
              </Button>
              <Button
                size="sm"
                variant="outline"
                isDisabled={page >= totalPages || loading}
                onPress={() => changePage(page + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        </>
      )}

      {/* 新增/编辑表单(页内区块;编辑时以来源 id 重挂载以重置草稿) */}
      <Card>
        <Card.Header>
          <Card.Title>
            {formMode.type === 'edit' ? `编辑来源「${formMode.source.name}」` : '新增来源'}
          </Card.Title>
          <Card.Description>
            远程地址保存后不回显;编辑时留空表示保持现值。保存需家长验证。
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <div id="source-form">
            <SourceFormCard
              key={formMode.type === 'edit' ? formMode.source.id : 'create'}
              mode={formMode}
              epgOptions={epgOptions}
              rootOptions={rootOptions}
              submitting={acting}
              onSubmit={openFormSubmit}
              onCancelEdit={cancelEdit}
            />
          </div>
        </Card.Content>
      </Card>

      {/* 家长验证弹窗:创建/编辑/刷新/确认/丢弃共用,当次密码即用即清 */}
      <ParentVerificationModal
        isOpen={pending !== null}
        title="家长验证 · 来源管理"
        description={verifyDescription(pending)}
        isPending={acting}
        error={verifyError}
        onCancel={() => {
          if (!acting) {
            setPending(null);
            setVerifyError(null);
          }
        }}
        onConfirm={(password) => void handleVerified(password)}
      />
    </section>
  );
}
