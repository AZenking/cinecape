/**
 * 手动 EPG 匹配对话框(T072,User Story 5;FR-023～026)。
 *
 * - 入口:频道详情页 owner 专属「EPG 匹配」按钮(MediaDetail 渲染,本组件不做角色判断);
 * - 家长验证「当次」语义(ADR-0006):打开即需输入主账号密码调 query 端点读取绑定态;
 *   密码仅存内存、随请求 body 传输,取消/失败立即清空;来源选择、搜索词等非敏感输入
 *   在失败后保留,密码重输后候选自动重查;关闭对话框即结束当次验证;
 * - 来源下拉来自 GET /sources(owner 可调,无需密码),取 kind=epg 且启用的子集;
 *   绑定态里的 epgSourceId 用于首次预选;来源切换清空旧候选列表与页码
 *   (契约:来源切换必须重新查询,旧 generation 作废),搜索词保留;
 * - 搜索防抖 300ms + 服务端分页(pageSize=20);候选行展示
 *   xmltvChannelId/displayName/current/next;「绑定此频道」携带当前绑定 version
 *   与候选页 epgGeneration 保存锁定;mode=manual 时提供「解除绑定(恢复自动)」;
 * - 409 分流:EPG_BINDING_VERSION_CONFLICT → 「绑定已被其他操作更新,请重新打开」;
 *   EPG_CANDIDATE_STALE → 「EPG 已更新,请重新查询候选」并自动清空候选列表、
 *   保留来源选择(页码回 1);错误文案统一走 messages.ts,不透传 detail;
 * - invalid 不回退(FR-025):展示失效原因与「保留配置,恢复后自动生效」,
 *   不提供自动回退按钮,仅保留家长主动解除入口;
 * - 键盘可操作:焦点管理沿用 HeroUI Modal 惯例(打开聚焦密码框、Esc 关闭、
 *   背板点击关闭,进行中禁用 dismiss),全部交互为原生可聚焦元素。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Chip,
  FieldError,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Spinner,
  TextField,
} from '@heroui/react';
import { ApiError, api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { formatProgrammeRange } from '../catalog/messages';
import {
  CODE_EPG_CANDIDATE_STALE,
  EPG_INVALID_REASON_LABELS,
  EPG_INVALID_RETAINED_HINT,
  bindingModeStatusText,
  friendlyEpgMessage,
} from './messages';
import type {
  EpgBindingDto,
  EpgCandidateDto,
  EpgCandidatePageDto,
  SourceDto,
} from '@hmp/shared';

/** 候选分页大小(契约默认 20;本对话框固定,上限 100 由服务端约束) */
const CANDIDATE_PAGE_SIZE = 20;

/** 搜索防抖(ms;与观看目录页一致) */
const SEARCH_DEBOUNCE_MS = 300;

/** 搜索词长度上限(契约 q ≤ 100 字符,trim 后字面包含) */
const QUERY_MAX_LENGTH = 100;

/** 来源清单扫描页上限(GET /sources 每页 100;与来源管理页 loadEpgOptions 一致) */
const SOURCE_SCAN_PAGE_LIMIT = 5;

/** 候选查询语境:来源 + 已应用(防抖后)搜索词 + 页码;任一变化即重查 */
interface CandidateQueryContext {
  sourceId: string | null;
  q: string;
  page: number;
}

/** 进行中的管理操作(互斥;进行中禁用全部操作与 dismiss) */
type PendingAction = 'query' | 'save' | 'unbind';

/** 候选区错误:固定文案 + 展示色(候选过期=warning 可恢复,其余=danger) */
interface CandidatesError {
  text: string;
  tone: 'warning' | 'danger';
}

/** 候选行节目槽位展示:标题(起止时间);null 显示「暂无节目」(无节目 ≠ 失效,FR-024) */
function programmeSlotText(slot: EpgCandidateDto['current']): string {
  if (slot === null) {
    return '暂无节目';
  }
  return `${slot.title}（${formatProgrammeRange(slot.startsAt, slot.endsAt)}）`;
}

export interface EpgBindingDialogProps {
  isOpen: boolean;
  /** 频道媒体 id(契约路径参数) */
  mediaId: string;
  /** 频道标题(对话框标题与成功提示用) */
  mediaTitle: string;
  onClose: () => void;
  /** 保存/解除成功后回调(携带最新绑定态;详情页可据此刷新节目单) */
  onBindingChanged?: (binding: EpgBindingDto) => void;
}

export function EpgBindingDialog({
  isOpen,
  mediaId,
  mediaTitle,
  onClose,
  onBindingChanged,
}: EpgBindingDialogProps) {
  const { refresh: refreshSession } = useSession();

  /* ------------------------------ 会话内状态 ------------------------------ */

  /** 打开序号:重开对话框即新会话,旧会话在途响应一律丢弃(防旧写回覆盖新会话) */
  const sessionRef = useRef(0);

  /**
   * 当次家长密码:仅存内存、随请求 body 传输;取消/失败立即清空;
   * 绝不写入 localStorage/URL/日志(与 ParentVerificationModal 同一纪律)。
   */
  const [password, setPassword] = useState('');

  const [binding, setBinding] = useState<EpgBindingDto | null>(null);
  const [bindingError, setBindingError] = useState<string | null>(null);

  /** EPG 来源清单(kind=epg,含停用:停用项仅用于展示当前绑定目标名) */
  const [epgSources, setEpgSources] = useState<SourceDto[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);

  const [searchDraft, setSearchDraft] = useState('');
  const [candidateQuery, setCandidateQuery] = useState<CandidateQueryContext>({
    sourceId: null,
    q: '',
    page: 1,
  });
  const [candidates, setCandidates] = useState<EpgCandidatePageDto | null>(null);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [candidatesError, setCandidatesError] = useState<CandidatesError | null>(null);
  /** 候选请求代次:来源/搜索词/页码快速变化时丢弃旧响应 */
  const candidatesGenRef = useRef(0);

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** 密码「在场」布尔:候选 effect 只看有无,不因每次击键重发请求 */
  const hasPassword = password !== '';

  /** 下拉选项:仅启用中的 EPG 来源(契约候选要求来源启用且已成功导入,后者由服务端校验) */
  const enabledEpgSources = useMemo(() => epgSources.filter((item) => item.enabled), [epgSources]);

  /** 当前绑定目标来源展示名(清单未含时回退显示 id,如来源已停用被过滤) */
  const boundSourceName = useMemo(() => {
    if (binding?.epgSourceId == null) {
      return null;
    }
    return epgSources.find((item) => item.id === binding.epgSourceId)?.name ?? binding.epgSourceId;
  }, [binding, epgSources]);

  const totalCandidatePages = Math.max(
    1,
    Math.ceil((candidates?.total ?? 0) / CANDIDATE_PAGE_SIZE),
  );

  /* --------------------- 打开即重开会话:敏感态清空,统一重置 --------------------- */

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    sessionRef.current += 1;
    candidatesGenRef.current += 1;
    setPassword('');
    setBinding(null);
    setBindingError(null);
    setEpgSources([]);
    setSourcesLoading(false);
    setSearchDraft('');
    setCandidateQuery({ sourceId: null, q: '', page: 1 });
    setCandidates(null);
    setCandidatesLoading(false);
    setCandidatesError(null);
    setPending(null);
    setActionError(null);
    setNotice(null);
  }, [isOpen]);

  /* ----------------- 来源清单:GET /sources(owner;无需家长密码) ----------------- */

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const session = sessionRef.current;
    let discarded = false;
    const load = async (): Promise<void> => {
      setSourcesLoading(true);
      try {
        const collected: SourceDto[] = [];
        for (let current = 1; current <= SOURCE_SCAN_PAGE_LIMIT; current += 1) {
          const result = await api.listSources(current, 100);
          collected.push(...result.items);
          if (collected.length >= result.total) {
            break;
          }
        }
        if (discarded || sessionRef.current !== session) {
          return;
        }
        setEpgSources(collected.filter((item) => item.kind === 'epg'));
      } catch {
        // 来源清单失败:下拉为空并提示;不阻塞密码验证与绑定态查询
        if (!discarded && sessionRef.current === session) {
          setEpgSources([]);
        }
      } finally {
        if (!discarded && sessionRef.current === session) {
          setSourcesLoading(false);
        }
      }
    };
    void load();
    return () => {
      discarded = true;
    };
  }, [isOpen]);

  /* ---------------- 搜索防抖:300ms 后应用并回第 1 页(与目录页一致) ---------------- */

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = searchDraft.trim().slice(0, QUERY_MAX_LENGTH);
      setCandidateQuery((prev) => (prev.q === next ? prev : { ...prev, q: next, page: 1 }));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [searchDraft]);

  /* --------------- 候选查询:绑定态+来源+当次密码齐备即自动查询 --------------- */
  /* 依赖用 hasPassword(而非 password):重输密码自动重查,但击键过程不逐字重发。 */

  useEffect(() => {
    // 局部常量以便跨 async 闭包保持 null 收窄(strict 下对象属性收窄不出函数边界)
    const sourceId = candidateQuery.sourceId;
    if (!isOpen || binding === null || sourceId === null || !hasPassword) {
      return;
    }
    const gen = candidatesGenRef.current + 1;
    candidatesGenRef.current = gen;
    let discarded = false;
    const load = async (): Promise<void> => {
      setCandidatesLoading(true);
      setCandidatesError(null);
      try {
        const result = await api.queryEpgCandidates(mediaId, {
          ownerPassword: password,
          epgSourceId: sourceId,
          q: candidateQuery.q === '' ? undefined : candidateQuery.q,
          page: candidateQuery.page,
          pageSize: CANDIDATE_PAGE_SIZE,
        });
        if (discarded || gen !== candidatesGenRef.current) {
          return; // 旧代次响应(来源/搜索词/页码已再变):一律丢弃
        }
        setCandidates(result);
      } catch (error) {
        if (discarded || gen !== candidatesGenRef.current) {
          return;
        }
        setPassword(''); // 失败清空密码;来源/搜索词等非敏感输入保留
        setCandidates(null);
        setCandidatesError({ text: friendlyEpgMessage(error, '候选查询失败，请稍后重试。'), tone: 'danger' });
        if (error instanceof ApiError && error.status === 401) {
          // 401 交给现有会话处理:refresh → SessionProvider 置匿名 → 路由守卫转登录
          void refreshSession();
        }
      } finally {
        if (!discarded && gen === candidatesGenRef.current) {
          setCandidatesLoading(false);
        }
      }
    };
    void load();
    return () => {
      discarded = true;
    };
  }, [binding, candidateQuery, hasPassword, isOpen, mediaId, password, refreshSession]);

  /* ------------------------------ 交互回调 ------------------------------ */

  /**
   * 保存/解除失败的统一分流:
   * - 409 EPG_CANDIDATE_STALE:候选(含旧 generation)整体作废——清空候选列表、页码回 1,
   *   保留来源选择;提示「EPG 已更新,请重新查询候选」,密码重输后自动重查;
   * - 其余(含 409 EPG_BINDING_VERSION_CONFLICT):映射固定文案展示,不擅改候选状态。
   */
  const applyActionFailure = useCallback(
    (error: unknown): void => {
      if (error instanceof ApiError && error.code === CODE_EPG_CANDIDATE_STALE) {
        setCandidates(null);
        setCandidateQuery((prev) => (prev.page === 1 ? prev : { ...prev, page: 1 }));
        setCandidatesError({
          text: friendlyEpgMessage(error, 'EPG 已更新，请重新查询候选。'),
          tone: 'warning',
        });
        return;
      }
      setActionError(friendlyEpgMessage(error, '操作失败，请稍后重试。'));
      if (error instanceof ApiError && error.status === 401) {
        void refreshSession();
      }
    },
    [refreshSession],
  );

  /** 查询/刷新绑定态:即首次家长验证;失败清空密码,成功后保留供本会话后续操作 */
  const handleQueryBinding = useCallback(async (): Promise<void> => {
    if (pending !== null || password === '') {
      return;
    }
    const session = sessionRef.current;
    setPending('query');
    setBindingError(null);
    setActionError(null);
    setNotice(null);
    try {
      const dto = await api.queryManualEpgBinding(mediaId, { ownerPassword: password });
      if (sessionRef.current !== session) {
        return; // 对话框已重开:旧会话响应丢弃
      }
      setBinding(dto);
      // 绑定态来源预选:仅当尚未选择时用 epgSourceId 预选,不覆盖已有人工选择
      if (dto.epgSourceId !== null) {
        setCandidateQuery((prev) =>
          prev.sourceId === null ? { ...prev, sourceId: dto.epgSourceId } : prev,
        );
      }
    } catch (error) {
      if (sessionRef.current !== session) {
        return;
      }
      setPassword(''); // 失败清空密码
      setBinding(null);
      setBindingError(friendlyEpgMessage(error, '绑定状态查询失败，请稍后重试。'));
      if (error instanceof ApiError && error.status === 401) {
        void refreshSession();
      }
    } finally {
      if (sessionRef.current === session) {
        setPending(null);
      }
    }
  }, [mediaId, password, pending, refreshSession]);

  /** 保存锁定:PUT mode=manual,携带当前绑定 version 与候选页 epgGeneration */
  const handleBind = useCallback(
    async (candidate: EpgCandidateDto): Promise<void> => {
      if (binding === null || candidates === null || candidateQuery.sourceId === null) {
        return;
      }
      if (pending !== null || password === '') {
        return;
      }
      const session = sessionRef.current;
      setPending('save');
      setActionError(null);
      setNotice(null);
      try {
        const dto = await api.updateEpgBinding(mediaId, {
          mode: 'manual',
          expectedVersion: binding.version,
          epgSourceId: candidateQuery.sourceId,
          xmltvChannelId: candidate.xmltvChannelId,
          expectedEpgGeneration: candidates.epgGeneration,
          ownerPassword: password,
        });
        if (sessionRef.current !== session) {
          return;
        }
        setBinding(dto);
        setNotice(
          `已将「${mediaTitle}」绑定到「${candidate.displayName}」，保存即锁定并优先于自动匹配。`,
        );
        onBindingChanged?.(dto);
      } catch (error) {
        if (sessionRef.current !== session) {
          return;
        }
        setPassword(''); // 失败清空密码;来源/搜索词/候选列表等非敏感输入保留
        applyActionFailure(error);
      } finally {
        if (sessionRef.current === session) {
          setPending(null);
        }
      }
    },
    [
      applyActionFailure,
      binding,
      candidates,
      candidateQuery.sourceId,
      mediaId,
      mediaTitle,
      onBindingChanged,
      password,
      pending,
    ],
  );

  /** 解除绑定:PUT mode=auto(不带目标字段),恢复自动匹配 */
  const handleUnbind = useCallback(async (): Promise<void> => {
    if (binding === null || pending !== null || password === '') {
      return;
    }
    const session = sessionRef.current;
    setPending('unbind');
    setActionError(null);
    setNotice(null);
    try {
      const dto = await api.updateEpgBinding(mediaId, {
        mode: 'auto',
        expectedVersion: binding.version,
        ownerPassword: password,
      });
      if (sessionRef.current !== session) {
        return;
      }
      setBinding(dto);
      setNotice('已解除手动绑定，恢复自动匹配。');
      onBindingChanged?.(dto);
    } catch (error) {
      if (sessionRef.current !== session) {
        return;
      }
      setPassword('');
      applyActionFailure(error);
    } finally {
      if (sessionRef.current === session) {
        setPending(null);
      }
    }
  }, [applyActionFailure, binding, mediaId, onBindingChanged, password, pending]);

  /** 来源切换:清空旧候选列表与页码(契约:必须重查,旧 generation 作废);搜索词保留 */
  const changeSource = useCallback((sourceId: string): void => {
    setCandidates(null);
    setCandidatesError(null);
    setCandidateQuery((prev) =>
      prev.sourceId === sourceId && prev.page === 1 ? prev : { ...prev, sourceId, page: 1 },
    );
  }, []);

  const changePage = useCallback((next: number): void => {
    setCandidateQuery((prev) => (prev.page === next ? prev : { ...prev, page: next }));
  }, []);

  /** 关闭:清空密码(当次语义);进行中不可关闭(与服务端锁定计数一致的保守策略) */
  const handleDismiss = useCallback((): void => {
    if (pending !== null) {
      return;
    }
    setPassword('');
    onClose();
  }, [onClose, pending]);

  /** 候选行是否为当前绑定目标(来源一致且频道 ID 一致;invalid 亦算,便于重绑同一目标) */
  const isRowBound = useCallback(
    (candidate: EpgCandidateDto): boolean =>
      binding !== null &&
      binding.mode === 'manual' &&
      binding.epgSourceId === candidateQuery.sourceId &&
      binding.xmltvChannelId === candidate.xmltvChannelId,
    [binding, candidateQuery.sourceId],
  );

  /* ------------------------------- 渲染 ------------------------------- */

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          handleDismiss();
        }
      }}
    >
      <Modal.Backdrop isDismissable={pending === null} isKeyboardDismissDisabled={pending !== null}>
        <Modal.Container placement="center" size="lg">
          <Modal.Dialog aria-label={`EPG 匹配 · ${mediaTitle}`}>
            <Modal.Body className="space-y-4 pt-4">
              <div className="space-y-1">
                <h2 className="text-base font-semibold text-foreground">EPG 匹配</h2>
                <p className="text-sm text-muted">
                  为「{mediaTitle}」手动指定 EPG 频道；保存即锁定并优先于来源级自动匹配。
                </p>
              </div>

              {/* 当前绑定态:mode/status/version/目标或失效原因(invalid 不回退,FR-025) */}
              <div className="rounded-xl border border-border p-3">
                <h3 className="text-sm font-medium text-foreground">当前绑定</h3>
                {binding === null ? (
                  <p className="mt-1 text-sm text-muted">
                    {bindingError ?? '输入主账号密码后查询当前绑定状态。'}
                  </p>
                ) : (
                  <div className="mt-2 space-y-2">
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      <Chip
                        size="sm"
                        variant="soft"
                        color={
                          binding.mode === 'manual' && binding.status === 'invalid'
                            ? 'warning'
                            : 'default'
                        }
                        aria-label={`绑定状态 ${bindingModeStatusText(binding)}`}
                      >
                        {bindingModeStatusText(binding)}
                      </Chip>
                      <span className="text-muted">版本 {binding.version}</span>
                    </p>
                    {binding.mode === 'manual' && (
                      <p className="text-sm text-muted">
                        目标：{boundSourceName ?? '未知来源'} · {binding.xmltvChannelId}
                      </p>
                    )}
                    {binding.mode === 'manual' &&
                      binding.status === 'invalid' &&
                      binding.invalidReason !== null && (
                        <Alert status="warning">
                          <Alert.Indicator />
                          <Alert.Content>
                            <Alert.Title>
                              {EPG_INVALID_REASON_LABELS[binding.invalidReason]}
                            </Alert.Title>
                            <Alert.Description>{EPG_INVALID_RETAINED_HINT}</Alert.Description>
                          </Alert.Content>
                        </Alert>
                      )}
                  </div>
                )}
              </div>

              {/* 家长密码:每次打开重新输入;取消/失败清空,来源/搜索词等非敏感输入保留 */}
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleQueryBinding();
                }}
              >
                <TextField
                  value={password}
                  onChange={setPassword}
                  isDisabled={pending !== null}
                  isRequired
                  validationBehavior="aria"
                  fullWidth
                  autoFocus
                >
                  <Label>主账号密码</Label>
                  <Input
                    type="password"
                    autoComplete="current-password"
                    placeholder="主账号登录密码"
                  />
                  <FieldError>{password === '' ? '请输入密码' : undefined}</FieldError>
                </TextField>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted">
                    查询、保存与解除均需主账号密码；验证仅当次有效。
                  </p>
                  <Button
                    type="submit"
                    variant="primary"
                    isPending={pending === 'query'}
                    isDisabled={password === '' || pending !== null}
                  >
                    {binding === null ? '查询绑定状态' : '刷新绑定状态'}
                  </Button>
                </div>
              </form>

              {/* 管理区:绑定态读取成功后展示(来源选择/搜索/候选/解除) */}
              {binding !== null && (
                <div className="space-y-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                    <Select
                      className="max-w-xs"
                      value={candidateQuery.sourceId}
                      onChange={(key) => {
                        if (typeof key === 'string' && key !== '') {
                          changeSource(key);
                        }
                      }}
                      aria-label="选择 EPG 来源"
                      isDisabled={
                        pending !== null || sourcesLoading || enabledEpgSources.length === 0
                      }
                    >
                      <Label>EPG 来源</Label>
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox>
                          {enabledEpgSources.map((source) => (
                            <ListBox.Item key={source.id} id={source.id} textValue={source.name}>
                              {source.name}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                    </Select>
                    <TextField
                      value={searchDraft}
                      onChange={setSearchDraft}
                      fullWidth
                      className="max-w-sm"
                      aria-label="按 ID 或名称搜索 EPG 频道"
                    >
                      <Label>搜索频道</Label>
                      <Input
                        type="search"
                        placeholder="按 XMLTV ID 或名称搜索(最多 100 字符)"
                        maxLength={QUERY_MAX_LENGTH}
                      />
                    </TextField>
                  </div>

                  {sourcesLoading ? (
                    <div className="flex items-center gap-3 py-2">
                      <Spinner size="sm" aria-label="加载来源" />
                      <p className="text-sm text-muted">正在加载 EPG 来源…</p>
                    </div>
                  ) : enabledEpgSources.length === 0 ? (
                    <Alert status="warning">
                      <Alert.Indicator />
                      <Alert.Content>
                        <Alert.Title>暂无可用 EPG 来源</Alert.Title>
                        <Alert.Description>
                          请先在来源管理添加并启用 EPG 来源，完成刷新导入后再绑定。
                        </Alert.Description>
                      </Alert.Content>
                    </Alert>
                  ) : candidateQuery.sourceId === null ? (
                    <p className="text-sm text-muted">请先选择 EPG 来源。</p>
                  ) : (
                    <div className="space-y-2">
                      {candidatesError !== null && (
                        <Alert status={candidatesError.tone}>
                          <Alert.Indicator />
                          <Alert.Content>
                            <Alert.Title>候选暂不可用</Alert.Title>
                            <Alert.Description>{candidatesError.text}</Alert.Description>
                          </Alert.Content>
                        </Alert>
                      )}
                      {!hasPassword && (
                        <p className="text-xs text-muted">
                          密码已清除，请重新输入主账号密码以查询候选与保存。
                        </p>
                      )}

                      {candidatesLoading ? (
                        <div className="flex items-center gap-3 py-4">
                          <Spinner size="sm" aria-label="加载候选" />
                          <p className="text-sm text-muted">正在查询候选频道…</p>
                        </div>
                      ) : candidates === null ? (
                        <p className="py-2 text-sm text-muted">
                          {hasPassword ? '正在准备候选…' : '请重新输入密码后查询候选。'}
                        </p>
                      ) : candidates.items.length === 0 ? (
                        <p className="py-2 text-sm text-muted">没有匹配的候选频道。</p>
                      ) : (
                        <>
                          <ul className="space-y-2">
                            {candidates.items.map((candidate) => {
                              const bound = isRowBound(candidate);
                              return (
                                <li
                                  key={candidate.xmltvChannelId}
                                  className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-start sm:justify-between"
                                >
                                  <div className="min-w-0 space-y-1">
                                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                                      <span className="truncate">{candidate.displayName}</span>
                                      <span className="text-xs font-normal text-muted">
                                        {candidate.xmltvChannelId}
                                      </span>
                                      {bound && (
                                        <Chip size="sm" variant="soft" color="success">
                                          当前绑定
                                        </Chip>
                                      )}
                                      {candidate.current === null && candidate.next === null && (
                                        <Chip size="sm" variant="soft" color="default">
                                          暂无节目数据
                                        </Chip>
                                      )}
                                    </p>
                                    <p className="text-xs text-muted">
                                      当前：{programmeSlotText(candidate.current)}
                                    </p>
                                    <p className="text-xs text-muted">
                                      下一：{programmeSlotText(candidate.next)}
                                    </p>
                                  </div>
                                  <Button
                                    size="sm"
                                    variant={bound ? 'ghost' : 'outline'}
                                    isDisabled={
                                      pending !== null ||
                                      !hasPassword ||
                                      (bound && binding.status === 'valid')
                                    }
                                    onPress={() => void handleBind(candidate)}
                                    aria-label={`绑定频道 ${candidate.displayName}`}
                                  >
                                    绑定此频道
                                  </Button>
                                </li>
                              );
                            })}
                          </ul>

                          {/* 分页(服务端分页;查询中/操作中禁翻页) */}
                          <nav
                            aria-label="候选分页"
                            className="flex flex-wrap items-center justify-between gap-2"
                          >
                            <p className="flex items-center gap-2 text-xs text-muted">
                              第 {candidates.page} / {totalCandidatePages} 页 · 共{' '}
                              {candidates.total} 个候选
                              {candidatesLoading && <Spinner size="sm" aria-label="加载中" />}
                            </p>
                            <div className="flex items-center gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                isDisabled={
                                  candidates.page <= 1 ||
                                  candidatesLoading ||
                                  pending !== null ||
                                  !hasPassword
                                }
                                onPress={() => changePage(candidates.page - 1)}
                              >
                                上一页
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                isDisabled={
                                  candidates.page >= totalCandidatePages ||
                                  candidatesLoading ||
                                  pending !== null ||
                                  !hasPassword
                                }
                                onPress={() => changePage(candidates.page + 1)}
                              >
                                下一页
                              </Button>
                            </div>
                          </nav>
                        </>
                      )}
                    </div>
                  )}

                  {/* 解除:仅 manual 展示;解除写 auto 墓碑恢复自动匹配(FR-023/025) */}
                  {binding.mode === 'manual' && (
                    <div className="flex justify-end">
                      <Button
                        variant="outline"
                        isPending={pending === 'unbind'}
                        isDisabled={pending !== null || !hasPassword}
                        onPress={() => void handleUnbind()}
                      >
                        解除绑定（恢复自动）
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* 操作错误(409 版本冲突/422/404/网络等;文案集中映射,不透传 detail) */}
              {actionError !== null && (
                <Alert status="danger">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>操作未完成</Alert.Title>
                    <Alert.Description>{actionError}</Alert.Description>
                  </Alert.Content>
                </Alert>
              )}

              {/* 成功提示(保存锁定/解除) */}
              {notice !== null && (
                <Alert status="success">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>操作成功</Alert.Title>
                    <Alert.Description>{notice}</Alert.Description>
                  </Alert.Content>
                </Alert>
              )}

              {/* 底部关闭(Esc/背板点击同样触发;进行中禁用) */}
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  isDisabled={pending !== null}
                  onPress={handleDismiss}
                >
                  关闭
                </Button>
              </div>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
