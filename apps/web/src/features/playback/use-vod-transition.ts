import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Vod } from '@hmp/shared';
import { FetchApiError, isAbortError, isFetchApiError, privateFetch } from '../../shared/fetch';
import type { AcceptedCheckpoint } from './progress-controller';

/**
 * 换源/过渡串行编排 hook(010 T074;tasks.md T074、api.md §5/§6/§7 I1、ui.md §4/§5/§6):
 *
 * - 复用 PlayerView 既有 usePlaybackProgress 泵(勿建第二泵):pauseAndFlush 产 carry
 *   checkpoint、stopOnce 恰一次 /stop(本 hook 只消费,不触碰 progress-controller 核心);
 * - 状态机(T069 契约):idle→selecting→pausing/flushing→materializing→creatingIntent→
 *   stoppingSource→resolvingTarget→done|failed;选候选即开始串行流:暂停确认(唯一
 *   checkpoint 来源,周期样本与源播放保持)→必要物化(candidateRef 分支取
 *   registeredCandidateRef,api.md §7 I1)→目标历史查询(三选一依据)→位置三选一
 *   (显式)→intent→stopOnce 确认→resolve({mediaId,transitionIntentId} 严格形,禁 startMode);
 * - checkpoint 纪律(api.md §5):sessionAccepted 游标方可作为 carry 提交;非接受(含
 *   pause 超时/409 SOURCE_PROGRESS_PENDING)一律显式确认面 —— 展示已确认游标,用户点击
 *   「使用已确认位置」后以新 operationKey+该游标+allowEarlierAcceptedPosition=true 提交;
 *   beginning/target_history 严格缺省 sourceCheckpoint 与 allowEarlierAcceptedPosition 字段;
 * - intent 目标一律用物化回包 registeredCandidateRef(I1),不用原始 candidateRef;
 * - 响应丢失恢复:网络层失败同 operationKey 同载荷原样重放(有界 ≤3 次尝试);intent 撞
 *   409 TRANSITION_SLOT_CONFLICT → GET 会话恢复当前 slot revision,以新 key+新
 *   expectedSlotRevision 有界重提(合计 ≤3,不无限新建 key);409 SOURCE_PROGRESS_PENDING
 *   → 重新展示显式确认面,不自动换游标重试;正常 switch 旧源先 stop 到 ended —— stop 响应
 *   丢失(泵吞网络错)以恢复读(GET 会话,'ended'=正面终态确认)承接口序,未终态不客户端
 *   阻断消费(服务端 409 SOURCE_NOT_TERMINAL 兜底,失败面提供重试);
 * - 身份守卫(ui.md §2/§5):每 await 后核对 stream 身份(sessionId/generation/流号=ui
 *   操作号 uiOperationRevision);切档(会话变化)关闭抽屉、中止在途候选/测速/过渡请求
 *   并整体重置 —— 迟到 candidates/probes 响应一律不回写、不链发(E1/E2);
 * - 输家/迟到意图追查(010 T075;api.md §5 cancel 行/§7 I5、ui.md §2/§4/§6):可创建
 *   后继的旧意图响应不能仅丢弃 —— (D1)用户取消已建意图 → cancel 裁决,输给消费
 *   (already_consumed)时显式 stop 不需要的后继;(D2)不同 ui 操作号仲裁:新操作在
 *   creatingIntent 窗口可换目标,旧流后到 201 的意图显式 cancel;(E3)关闭播放器后
 *   迟到 201 → 同 context 先 cancel、失权转 cleanup(无需后继 ID;cleanup_pending
 *   同入口有界重试);切档后不借旧 context 清理(服务端撤销事务兜底,ui.md §6);
 * - recover_switch(010 T075;api.md §5/§6、ui.md §4):action 经 options 注入 ——
 *   媒体故障后 60s 恢复窗口内由协调器恢复面以 action='recover_switch' 复用本串行流;
 *   窗口过期由协调器收口为普通播放,本 hook 不自动循环尝试来源(FR-038);
 * - 失败恢复(api.md §6/ui.md §4):停源前失败(候选/暂停/物化/intent)可恢复 —— 源播放
 *   保持、零 stop/零 resolve,提供重新选择/重试出路;停源后失败(resolve)不复活旧源 ——
 *   零 renew、不自动二次消费,提供显式重试;永不自动循环尝试来源(FR-038)。
 * - 本 hook 不实现 UI:vod-source-switcher.tsx(T074)消费状态面与动作回调;60s 恢复
 *   窗口注册与过期新播放由协调器层(action-coordinator)承担。
 */

type SwitchCandidateDto = Vod.components['schemas']['SwitchCandidate'];
type ProbeResultDto = Vod.components['schemas']['ProbeResult'];
type ProbeResultsDto = Vod.components['schemas']['ProbeResults'];
type SwitchCandidatePageDto = Vod.components['schemas']['SwitchCandidatePage'];
type MaterializedDto = Vod.components['schemas']['Materialized'];
type IntentReplyDto = Vod.components['schemas']['IntentReply'];
type SwitchIntentRequestDto = Vod.components['schemas']['SwitchIntentRequest'];
type TitleProgressDto = Vod.components['schemas']['TitleProgress'];
type PlaybackStatusDto = Vod.components['schemas']['PlaybackDto'];
/** 取消裁决(T075;api.md §5 cancel 行:取消与消费 CAS 竞争) */
type TransitionCancelReplyDto = Vod.components['schemas']['TransitionCancelReply'];
/** 仅清理分支最小结果(T075;api.md §7 I5) */
type TransitionCleanupReplyDto = Vod.components['schemas']['TransitionCleanupReply'];

/** 位置三选一(api.md §5 严格互斥;选择即 positionMode) */
export type VodTransitionPositionMode = 'carry' | 'target_history' | 'beginning';

/** 内部控制子状态(T069 契约;pausing/flushing 归并为 pausing,flushing 保留为契约别名) */
export type VodTransitionPhase =
  /** 无换源流 */
  | 'idle'
  /** 抽屉候选面(浏览/测速/选择;物化回包后的三选一等待同属此相位) */
  | 'selecting'
  /** 已选候选:pauseAndFlush 在途(串行流第一步) */
  | 'pausing'
  /** 契约别名(排队样本冲刷);当前实现与 pausing 归并 */
  | 'flushing'
  /** 物化(candidateRef 分支)+目标历史查询在途 */
  | 'materializing'
  /** 过渡意图创建在途(含 slot 冲突恢复重提) */
  | 'creatingIntent'
  /** stopOnce 确认在途(恰一次 /stop+恢复读) */
  | 'stoppingSource'
  /** 过渡消费在途(resolve;严格 {mediaId,transitionIntentId}) */
  | 'resolvingTarget'
  /** 串行流完成(resolve 201/200;后继会话由协调器接管,T075) */
  | 'done'
  /** 终止(failure.recoverable 区分停前可恢复/停后终态) */
  | 'failed';

export type VodTransitionFailureKind =
  /** 候选获取失败(停前可恢复;源播放不受影响) */
  | 'candidates'
  /** 暂停保存失败(停前可恢复;不产生 checkpoint) */
  | 'pause'
  /** 物化失败(停前可恢复;零 stop/零 resolve) */
  | 'materialize'
  /** intent 失败(停前可恢复;含 slot 冲突重提穷尽) */
  | 'intent'
  /** 源停止未完成(防御分支;stopOnce 契约不拒绝) */
  | 'stop'
  /** 消费失败(停后终态:源已 stop,不复活旧源;提供显式重试) */
  | 'resolve';

export interface VodTransitionFailure {
  readonly kind: VodTransitionFailureKind;
  /** true=停前可恢复(源播放保持,可重新选择/重试);false=停后终态(不复活旧源,仅显式重试) */
  readonly recoverable: boolean;
  readonly message: string;
}

/** 已选候选(串行流主体;选中即冻结) */
export interface VodTransitionSelection {
  readonly candidate: SwitchCandidateDto;
}

/** 物化+历史事实(I1;registeredCandidateRef 是 intent 目标唯一合法值) */
export interface VodTransitionTarget {
  readonly registeredCandidateRef: string;
  readonly targetMediaId: string;
  /** 目标有自己的未完成历史 → 三选一(ui.md §4);false=仅 carry/beginning 二选一 */
  readonly hasTargetHistory: boolean;
}

/** checkpoint 决议面(三选一/显式确认共用;api.md §5) */
export interface VodTransitionChoice {
  /** pause checkpoint 是否被服务端接受(非接受不得直接 carry) */
  readonly checkpointAccepted: boolean;
  /** 已确认游标(展示与提交一致:expectedGeneration/sampleSeq 精确冻结) */
  readonly cursorGeneration: number;
  readonly cursorSampleSeq: number;
  readonly cursorPositionSeconds: number | null;
  /** 显式确认面(非接受/409 后):carry 仅可经「使用已确认位置」提交(新 key+allow 标记) */
  readonly requiresExplicitConfirm: boolean;
}

export interface VodTransitionState {
  readonly phase: VodTransitionPhase;
  readonly drawerOpen: boolean;
  /** 候选(null=未加载;只元数据,无地址 —— FR-029) */
  readonly candidates: readonly SwitchCandidateDto[] | null;
  readonly candidatesLoading: boolean;
  /** 测速结果(candidateRef → ProbeResult;切档即清,ui.md §5) */
  readonly probes: Readonly<Record<string, ProbeResultDto>>;
  readonly selection: VodTransitionSelection | null;
  readonly target: VodTransitionTarget | null;
  readonly choice: VodTransitionChoice | null;
  readonly failure: VodTransitionFailure | null;
  /** 源播放终态确认(stop 恢复读;'ended'=true;null=未读) */
  readonly sourceTerminated: boolean | null;
  /** 消费成功后的后继会话(协调器接管接缝,T075) */
  readonly successorSessionId: string | null;
}

export interface UseVodTransitionOptions {
  readonly sessionId: string;
  readonly generation: number;
  /** 当前媒体元素(保留接缝;本 hook 不直接操作引擎) */
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  /** PlayerView 既有泵的暂停确认命令(carry checkpoint 唯一来源;勿建第二泵) */
  readonly pauseAndFlush: () => Promise<AcceptedCheckpoint>;
  /** PlayerView 既有泵的幂等停止命令(恰一次 /stop;网络错由泵吞并) */
  readonly stopOnce: () => Promise<void>;
  /**
   * 意图动作(api.md §5;缺省 'switch'):媒体故障 60s 恢复窗口内由协调器恢复面
   * (action-coordinator)以 'recover_switch' 复用本串行流;仅故障 failed 后 60s 有效,
   * 窗口过期由协调器收口为普通播放,本 hook 不自行判定时限。
   */
  readonly action?: 'switch' | 'recover_switch';
}

export interface VodTransitionApi {
  readonly state: VodTransitionState;
  /** 打开换源抽屉(首次打开拉取候选并默认 ≤3 测速) */
  readonly openDrawer: () => void;
  /** 关闭抽屉/取消换源:intent 未建 → 中止流恢复原播放;intent 已建 → 废弃本流并追查
   *  (cancel 裁决/already_consumed 显式 stop 后继/失权 cleanup,T075 D1) */
  readonly closeDrawer: () => void;
  /** 选择候选(行点击;仅 selecting 相位可发起,进行中不重入) */
  readonly selectCandidate: (candidate: SwitchCandidateDto) => void;
  /** 位置三选一(选择即 positionMode;carry 仅接受 checkpoint 且非 conflict) */
  readonly choosePosition: (mode: VodTransitionPositionMode) => void;
  /** 显式确认已展示游标(新 key+该游标+allowEarlierAcceptedPosition=true) */
  readonly confirmEarlierPosition: () => void;
  /** 重新选择(停前物化/候选失败出路):清选择并重拉候选(用户显式动作,单发) */
  readonly reselect: () => void;
  /** 停后消费失败重试(重新 resolve;不自动) */
  readonly retryResolve: () => void;
}

const IDLE_STATE: VodTransitionState = {
  phase: 'idle',
  drawerOpen: false,
  candidates: null,
  candidatesLoading: false,
  probes: {},
  selection: null,
  target: null,
  choice: null,
  failure: null,
  sourceTerminated: null,
  successorSessionId: null,
};

/** 网络层请求一次性 operationKey(UUID;api.md §5 IntentRequest/物化分支同语义) */
function newOperationKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** 网络层失败(TypeError 等;非服务端问题响应)→ 同 key 同载荷重放通道 */
function isNetworkError(error: unknown): boolean {
  return !isAbortError(error) && !isFetchApiError(error);
}

/** 同 key 有界重试上限(intent/物化合计 ≤3 次尝试:不无限新建 key,api.md §6) */
const MAX_OPERATION_ATTEMPTS = 3;

/** 串行流身份(await 后核对;任一失配即放弃 —— 迟到响应不回写) */
interface TransitionStream {
  readonly id: number;
  readonly sessionId: string;
  readonly generation: number;
  readonly abort: AbortController;
}

export function useVodTransition(options: UseVodTransitionOptions): VodTransitionApi {
  const { sessionId, generation, pauseAndFlush, stopOnce, action = 'switch' } = options;
  const [state, setState] = useState<VodTransitionState>(IDLE_STATE);

  // 稳定镜像面:异步链/事件回调一律读 ref(重渲染不重排,守卫读「最新」身份)
  const stateRef = useRef(state);
  stateRef.current = state;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const generationRef = useRef(generation);
  generationRef.current = generation;
  const pauseRef = useRef(pauseAndFlush);
  pauseRef.current = pauseAndFlush;
  const stopRef = useRef(stopOnce);
  stopRef.current = stopOnce;
  const actionRef = useRef(action);
  actionRef.current = action;

  /** 串行流号(单调;选候选/取消/切档推进,旧流凭失配放弃) */
  const streamSeqRef = useRef(0);
  const streamRef = useRef<TransitionStream | null>(null);
  /** 候选/测速拉取代次与中止(切档/关闭即作废在途响应,E1/E2) */
  const drawerFetchSeqRef = useRef(0);
  const drawerAbortRef = useRef<AbortController | null>(null);
  /** intent 当前 expectedSlotRevision(初始 0=open;slot 冲突恢复读刷新) */
  const slotRevisionRef = useRef(0);
  /** 已建立意图(停后重试 resolve 的最小事实;不留存票据/地址) */
  const intentRef = useRef<IntentReplyDto | null>(null);
  /** 输家意图追查在途控制器(T075 D1/D2/E3):切档即中止 —— 不借旧 context 清理(ui.md §6) */
  const loserAbortRef = useRef<AbortController | null>(null);
  /**
   * 串行流就绪前的位置预选(三选一按钮在选择候选后立即可点 —— 出现时机不钉,ui.md §4;
   * 暂停/物化完成时按 checkpoint 纪律一次性决议:carry 非接受不自动提交,转显式确认面)。
   */
  const pendingChoiceRef = useRef<{ readonly mode: VodTransitionPositionMode } | null>(null);

  const patch = useCallback((partial: Partial<VodTransitionState>): void => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  /** 流存活守卫:流号+会话+代次全部一致(T069:每 await 后核对) */
  const streamAlive = useCallback((stream: TransitionStream): boolean => {
    return (
      streamRef.current?.id === stream.id &&
      sessionIdRef.current === stream.sessionId &&
      generationRef.current === stream.generation
    );
  }, []);

  /**
   * 幂等停止任一会话(T075 追查面专用;不经进度泵 —— 该会话非本机在播会话,
   * 泵只绑定当前源):取消输给消费返回的后继引用等「本机不需要的已建会话」
   * 显式 stop(api.md §5「协调器显式 stop 不需要的后继」)。尽力而为,失败不链发。
   */
  async function stopForeignSession(sessionId: string, signal: AbortSignal): Promise<void> {
    await privateFetch<void>(`/playback/sessions/${encodeURIComponent(sessionId)}/stop`, {
      method: 'POST',
      body: {},
      signal,
    }).catch(() => undefined);
  }

  /**
   * 输家/迟到意图追查与清理(010 T075;api.md §5 cancel 行/§7 I5、ui.md §2/§4/§6):
   * 可创建后继的旧意图不能静默丢弃 ——
   * 1) 同 context 常规 cancel:有权限时返回裁决;already_consumed(取消输给消费)→
   *    等回 successor 并显式 stop 该不需要的后继(ui.md §4);
   * 2) cancel 失权(授权/内容策略拒绝;I5「正常有权 cancel 可返回 successor,失权时
   *    使用 cleanup」)→ 同 context 直接对已知 intent 调 cleanup(无需后继 ID;
   *    cleanup_pending=正在关闭,同入口有界重试,期间不启动替代会话);
   * 3) 切档(上下文已变)不借旧 context 清理 —— 服务端撤销事务+cleanup 扫描兜底。
   * 纯网络面,无状态回写;卸载后仍执行(E3 关闭播放器后迟到响应追查)。
   */
  async function traceIntentLoss(stream: TransitionStream, intentId: string): Promise<void> {
    if (sessionIdRef.current !== stream.sessionId) {
      return; // 切档:旧上下文不再发起清理(不借旧 context,ui.md §6)
    }
    loserAbortRef.current?.abort();
    const abort = new AbortController();
    loserAbortRef.current = abort;
    const sameContext = (): boolean => !abort.signal.aborted && sessionIdRef.current === stream.sessionId;
    try {
      const cancelReply = await privateFetch<TransitionCancelReplyDto>(
        `/playback/transition-intents/${encodeURIComponent(intentId)}/cancel`,
        { method: 'POST', body: {}, signal: abort.signal },
      );
      if (!sameContext()) {
        return; // 取消期间切档:后继追查随旧上下文止步
      }
      const successorId =
        typeof cancelReply?.successorSessionId === 'string' && cancelReply.successorSessionId !== ''
          ? cancelReply.successorSessionId
          : null;
      if (cancelReply?.outcome === 'already_consumed' && successorId !== null) {
        await stopForeignSession(successorId, abort.signal);
      }
      return;
    } catch (error) {
      if (isAbortError(error) || !sameContext()) {
        return; // 中止/切档:不借旧 context 继续
      }
      // cancel 被拒(失权/已失能):转仅清理分支(I5),不放宽、不重试 cancel
    }
    for (let attempt = 1; attempt <= MAX_OPERATION_ATTEMPTS; attempt += 1) {
      try {
        const cleanupReply = await privateFetch<TransitionCleanupReplyDto>(
          `/playback/transition-intents/${encodeURIComponent(intentId)}/cleanup`,
          { method: 'POST', body: {}, signal: abort.signal },
        );
        if (cleanupReply?.outcome === 'cleanup_pending' && attempt < MAX_OPERATION_ATTEMPTS && sameContext()) {
          continue; // 正在关闭:同入口有界重试(I5「响应丢失重试同入口」),不启动替代会话
        }
        return;
      } catch (cleanupError) {
        if (isAbortError(cleanupError) || !sameContext() || !isNetworkError(cleanupError)) {
          return; // 稳定拒绝:服务端撤销/watchdog 兜底;不借旧 context 重试
        }
        // 响应丢失:同入口重试(有界)
      }
    }
  }

  // 会话身份变化/卸载(B3 切档语义):关闭抽屉、中止在途候选/测速/过渡请求、整体重置 ——
  // 迟到响应凭代次守卫丢弃,不回写、不链发(ui.md §5 身份守卫)。输家意图追查随上下文
  // 失效一并中止:切档后不借旧 context 调 cancel/cleanup,由服务端撤销事务兜底(ui.md §6)。
  useEffect(() => {
    streamSeqRef.current += 1;
    streamRef.current = null;
    drawerFetchSeqRef.current += 1;
    drawerAbortRef.current?.abort();
    drawerAbortRef.current = null;
    intentRef.current = null;
    slotRevisionRef.current = 0;
    // 切档(非卸载):旧 context 的输家追查立即中止 —— 不借旧 context 清理(ui.md §6);
    // 卸载不中止:关闭播放器后迟到的可建后继意图响应仍须追查/清理(E3 钉面)
    loserAbortRef.current?.abort();
    loserAbortRef.current = null;
    setState(IDLE_STATE);
    return () => {
      const liveStream = streamRef.current;
      const liveIntent = intentRef.current;
      streamSeqRef.current += 1;
      streamRef.current = null;
      drawerFetchSeqRef.current += 1;
      drawerAbortRef.current?.abort();
      drawerAbortRef.current = null;
      // 卸载(关闭播放器)时已建未决意图仍须追查/清理(ui.md §2 可创建后继的旧响应
      // 不能弃管;E3 同源语义)—— 故意不中止 loserAbortRef:关闭后收口继续执行。
      // 切档路径不经此分支清理:重挂 setup 先行时 sessionIdRef 已是新会话,
      // traceIntentLoss 的同 context 守卫自动止步(不借旧 context,ui.md §6)。
      if (liveStream !== null && liveIntent !== null) {
        void traceIntentLoss(liveStream, liveIntent.id);
      }
    };
  }, [sessionId]);

  /** 候选拉取+默认 ≤3 测速(单发一次;身份守卫:切档后迟到响应不回写不链发) */
  const loadCandidates = useCallback(async (): Promise<void> => {
    const fetchedForSessionId = sessionIdRef.current;
    const fetchedForGeneration = generationRef.current;
    drawerAbortRef.current?.abort();
    const abort = new AbortController();
    drawerAbortRef.current = abort;
    const fetchSeq = drawerFetchSeqRef.current + 1;
    drawerFetchSeqRef.current = fetchSeq;
    const aliveDrawer = (): boolean =>
      fetchSeq === drawerFetchSeqRef.current &&
      sessionIdRef.current === fetchedForSessionId &&
      generationRef.current === fetchedForGeneration;
    patch({ candidates: null, candidatesLoading: true, probes: {}, failure: null });
    try {
      // api.md §5:写参数经 query(fromSessionId+expectedGeneration 必带;A1 钉面)
      const page = await privateFetch<SwitchCandidatePageDto>('/vod/switch-candidates', {
        query: { fromSessionId: fetchedForSessionId, expectedGeneration: fetchedForGeneration },
        signal: abort.signal,
      });
      if (!aliveDrawer()) {
        return; // 切档/关闭:迟到候选不回写(ui.md §5 身份守卫)
      }
      const items = Array.isArray(page?.items) ? page.items : [];
      patch({ candidates: items, candidatesLoading: false });
      // 默认最多 3 候选测速(ui.md §4):恰一次 POST,refs 1–3 不重复(A2 钉面)
      const candidateRefs = items.slice(0, 3).map((candidate) => candidate.candidateRef);
      if (candidateRefs.length === 0) {
        return;
      }
      const probeReply = await privateFetch<ProbeResultsDto>('/vod/switch-probes', {
        method: 'POST',
        body: { fromSessionId: fetchedForSessionId, expectedGeneration: fetchedForGeneration, candidateRefs },
        signal: abort.signal,
      });
      if (!aliveDrawer()) {
        return; // 迟到测速不回写、不推进(E2)
      }
      const probes: Record<string, ProbeResultDto> = {};
      for (const result of probeReply?.items ?? []) {
        probes[result.candidateRef] = result;
      }
      patch({ probes });
    } catch (error) {
      if (isAbortError(error) || !aliveDrawer()) {
        return;
      }
      patch({
        candidatesLoading: false,
        failure: { kind: 'candidates', recoverable: true, message: '候选获取失败,请稍后重试。' },
      });
    }
  }, [patch]);

  /** 打开抽屉(幂等):idle 进入 selecting;候选缺位时拉取 */
  const openDrawer = useCallback((): void => {
    if (stateRef.current.drawerOpen) {
      return;
    }
    const wasIdle = stateRef.current.phase === 'idle';
    patch({ drawerOpen: true, phase: wasIdle ? 'selecting' : stateRef.current.phase });
    if (stateRef.current.candidates === null || wasIdle) {
      void loadCandidates();
    }
  }, [loadCandidates, patch]);

  /**
   * 关闭抽屉/取消换源(ui.md §4 可取消;T075 D1):
   * - intent 未建(停前)→ 中止流恢复原播放;
   * - intent 已建 → 不能静默丢弃已创建意图(ui.md §2「可创建后继的旧响应必须追查/
   *   清理」):废弃本流(取消方零 resolve 消费)并追查 —— cancel 裁决,输给消费
   *   (already_consumed)显式 stop 不需要的后继;失权转 cleanup(I5)。
   */
  const closeDrawer = useCallback((): void => {
    const phase = stateRef.current.phase;
    const preIntent =
      phase === 'selecting' || phase === 'pausing' || phase === 'flushing' || phase === 'materializing';
    const stream = streamRef.current;
    const intent = intentRef.current;
    drawerAbortRef.current?.abort();
    drawerAbortRef.current = null;
    if (preIntent) {
      streamSeqRef.current += 1;
      stream?.abort.abort();
      streamRef.current = null;
      pendingChoiceRef.current = null;
      patch(
        preIntent
          ? { drawerOpen: false, phase: 'idle', selection: null, target: null, choice: null, failure: null, probes: {} }
          : { drawerOpen: false },
      );
      return;
    }
    if (intent !== null && stream !== null) {
      streamSeqRef.current += 1;
      streamRef.current = null;
      stream.abort.abort();
      intentRef.current = null;
      pendingChoiceRef.current = null;
      void traceIntentLoss(stream, intent.id);
    }
    patch({ drawerOpen: false, phase: 'idle', selection: null, target: null, choice: null, failure: null, successorSessionId: null });
  }, [patch]);

  /**
   * 物化(I1 候选分支):candidateRef+previewRevision+UUID operationKey;网络层失败同 key
   * 同载荷原样重放(有界);服务端稳定拒绝上抛。
   */
  async function postMaterialization(stream: TransitionStream, candidate: SwitchCandidateDto): Promise<MaterializedDto> {
    const payload = Object.freeze({
      candidateRef: candidate.candidateRef,
      previewRevision: candidate.previewRevision,
      operationKey: newOperationKey(),
    });
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_OPERATION_ATTEMPTS; attempt += 1) {
      try {
        return await privateFetch<MaterializedDto>('/vod/materializations', {
          method: 'POST',
          body: payload,
          signal: stream.abort.signal,
        });
      } catch (error) {
        if (isAbortError(error) || !isNetworkError(error)) {
          throw error;
        }
        lastError = error; // 响应丢失:同 key 同载荷重放(api.md §0 幂等)
      }
    }
    throw lastError;
  }

  /** 物化失败稳定文案(停前可恢复面;C2a 钉 /重新选择|重试|稍后|失败|过期/) */
  function materializeFailureMessage(error: unknown): string {
    if (error instanceof FetchApiError && error.status === 410) {
      return '该候选预览已过期,请重新选择或稍后重试。';
    }
    if (error instanceof FetchApiError && error.code === 'VOD_DETAIL_CHANGED') {
      return '目标内容已变化,请重新选择候选。';
    }
    return '候选处理失败,请稍后重试或重新选择。';
  }

  /** intent 载荷构造(carry 带 checkpoint;beginning/target_history 严格缺省字段) */
  function buildIntentPayload(
    stream: TransitionStream,
    selection: VodTransitionSelection,
    target: VodTransitionTarget,
    choice: VodTransitionChoice,
    mode: VodTransitionPositionMode,
    explicitEarlier: boolean,
  ): SwitchIntentRequestDto {
    const payload: SwitchIntentRequestDto = {
      fromSessionId: stream.sessionId,
      expectedGeneration: stream.generation,
      // T075:媒体故障恢复面经 options 注入 recover_switch(仅故障后 60s,窗口归协调器)
      action: actionRef.current,
      // I1:intent 目标=物化回包 registeredCandidateRef(非原始 candidateRef)
      targetCandidateRef: target.registeredCandidateRef,
      previewRevision: selection.candidate.previewRevision,
      positionMode: mode,
      confirmedAmbiguous: selection.candidate.matchConfidence === 'ambiguous',
      expectedSlotRevision: slotRevisionRef.current,
      operationKey: newOperationKey(),
    };
    if (mode === 'carry') {
      // beginning/target_history 禁止 sourceCheckpoint 与 allowEarlierAcceptedPosition 字段
      // (api.md §5 严格缺省;B3/B4 hasOwnProperty 钉面)
      payload.sourceCheckpoint = {
        expectedGeneration: choice.cursorGeneration,
        sampleSeq: choice.cursorSampleSeq,
      };
      if (explicitEarlier) {
        payload.allowEarlierAcceptedPosition = true;
      }
    }
    return payload;
  }

  /**
   * intent→stop→resolve 串行链(位置显式选择后):
   * - intent:同 key 重放(网络丢失)/slot 冲突恢复重提(新 key+新 revision,合计 ≤3)/
   *   SOURCE_PROGRESS_PENDING 重新展示确认面(不自动重试);
   * - stop:stopOnce 恰一次(泵吞网络错)→ 恢复读会话状态('ended'=正面终态确认;
   *   非终态不客户端阻断 —— 服务端 SOURCE_NOT_TERMINAL 409 兜底);
   * - resolve:严格 {mediaId,transitionIntentId}(禁 startMode);网络丢失同载荷重放
   *   (服务端已消费 intent 重放同后继);迟到 resolve 丢弃(T075 协调器接缝)。
   */
  async function runIntentChain(
    stream: TransitionStream,
    intentInput: { readonly mode: VodTransitionPositionMode; readonly explicitEarlier: boolean },
    facts: {
      readonly selection: VodTransitionSelection;
      readonly target: VodTransitionTarget;
      readonly choice: VodTransitionChoice;
    },
  ): Promise<void> {
    const { selection, target, choice } = facts;
    patch({ phase: 'creatingIntent', failure: null });
    let payload = buildIntentPayload(stream, selection, target, choice, intentInput.mode, intentInput.explicitEarlier);
    let reply: IntentReplyDto | null = null;
    for (let attempt = 1; attempt <= MAX_OPERATION_ATTEMPTS; attempt += 1) {
      try {
        reply = await privateFetch<IntentReplyDto>('/playback/transition-intents', {
          method: 'POST',
          body: payload,
          signal: stream.abort.signal,
        });
        break;
      } catch (error) {
        if (!streamAlive(stream) || isAbortError(error)) {
          return; // 切档/关闭/卸载:迟到/中止意图不回写
        }
        if (isNetworkError(error)) {
          if (attempt < MAX_OPERATION_ATTEMPTS) {
            continue; // 响应丢失:同 operationKey 同载荷原样重放(D3 语义)
          }
          patch({ phase: 'failed', failure: { kind: 'intent', recoverable: true, message: '换源请求未送达,可重试或取消换源。' } });
          return;
        }
        if (error instanceof FetchApiError && error.code === 'TRANSITION_SLOT_CONFLICT') {
          if (attempt < MAX_OPERATION_ATTEMPTS) {
            // 恢复 slot(api.md §6):重读当前 revision,新 key+新 expectedSlotRevision 有界重提
            try {
              const statusDto = await privateFetch<PlaybackStatusDto>(
                `/playback/sessions/${encodeURIComponent(stream.sessionId)}`,
                { signal: stream.abort.signal },
              );
              if (!streamAlive(stream)) {
                return;
              }
              const revision = statusDto?.transitionSlot?.revision;
              slotRevisionRef.current = typeof revision === 'number' ? revision : slotRevisionRef.current;
            } catch (statusError) {
              if (!streamAlive(stream) || isAbortError(statusError)) {
                return;
              }
              patch({ phase: 'failed', failure: { kind: 'intent', recoverable: true, message: '换源槽位冲突且状态恢复失败,可重试或取消换源。' } });
              return;
            }
            payload = buildIntentPayload(stream, selection, target, choice, intentInput.mode, intentInput.explicitEarlier);
            continue;
          }
          patch({ phase: 'failed', failure: { kind: 'intent', recoverable: true, message: '换源槽位冲突,请稍后重试或取消换源。' } });
          return;
        }
        if (error instanceof FetchApiError && error.code === 'SOURCE_PROGRESS_PENDING') {
          // ledger 前进(api.md §5):重新展示显式确认面,不自动换游标重试(B2b 钉面)
          patch({
            phase: 'selecting',
            choice: { ...choice, checkpointAccepted: false, requiresExplicitConfirm: true },
          });
          return;
        }
        patch({ phase: 'failed', failure: { kind: 'intent', recoverable: true, message: '换源请求被拒绝,可重试或取消换源。' } });
        return;
      }
    }
    if (reply === null) {
      return;
    }
    if (!streamAlive(stream)) {
      // 可创建后继的旧响应必须追查/清理,不能仅丢弃(ui.md §2;T075):
      // D2=不同 ui 操作号仲裁后旧流的后到 201 → 显式 cancel;E3=关闭播放器后迟到
      // 201 → 同 context cancel/失权 cleanup。流已废:绝不 stop/resolve。
      void traceIntentLoss(stream, reply.id);
      return;
    }
    intentRef.current = reply;
    // stopOnce 确认(正常 switch 旧源先 stop 到 ended;恰一次 /stop 由泵保证)
    patch({ phase: 'stoppingSource' });
    try {
      await stopRef.current();
    } catch {
      // 泵契约不拒绝;防御收口(不重试:stopOnce 幂等唯一 Promise)
      if (!streamAlive(stream)) {
        patch({ phase: 'failed', failure: { kind: 'stop', recoverable: false, message: '源播放停止未完成,请稍后重试或重新播放。' } });
        return;
      }
    }
    if (!streamAlive(stream)) {
      return;
    }
    // stop 响应丢失恢复读(C3:恢复状态读先于消费;'ended'=正面终态确认)
    let sourceTerminated: boolean | null = null;
    try {
      const statusDto = await privateFetch<PlaybackStatusDto>(
        `/playback/sessions/${encodeURIComponent(stream.sessionId)}`,
        { signal: stream.abort.signal },
      );
      if (!streamAlive(stream)) {
        return;
      }
      sourceTerminated = statusDto?.state === 'ended';
    } catch {
      if (!streamAlive(stream)) {
        return;
      }
      // 恢复读失败:不阻断消费(服务端消费检查兜底);可经 resolve 失败面重试
    }
    patch({ phase: 'resolvingTarget', sourceTerminated });
    await runResolve(stream);
  }

  /** 过渡消费(严格 {mediaId,transitionIntentId};网络丢失同载荷重放;409 上失败面) */
  async function runResolve(stream: TransitionStream): Promise<void> {
    const reply = intentRef.current;
    if (reply === null) {
      return;
    }
    const resolveBody = Object.freeze({ mediaId: reply.targetMediaId, transitionIntentId: reply.id });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const successor = await privateFetch<PlaybackStatusDto>('/playback/resolve', {
          method: 'POST',
          body: resolveBody,
          signal: stream.abort.signal,
        });
        if (!streamAlive(stream)) {
          // 迟到 resolve(流已被关闭/切档/新操作废弃):消费已发生、后继已建 ——
          // 弃管即无人回收;按输家语义追查(cancel→already_consumed+successor 显式
          // stop / 同 context 失权 cleanup,T075 ui.md §2),不回写本机状态
          void traceIntentLoss(stream, reply.id);
          return;
        }
        patch({ phase: 'done', successorSessionId: typeof successor?.id === 'string' ? successor.id : null });
        return;
      } catch (error) {
        if (!streamAlive(stream) || isAbortError(error)) {
          return;
        }
        if (isNetworkError(error) && attempt < 2) {
          continue; // 响应丢失:同载荷重放(服务端已消费 intent 重放同后继)
        }
        // 停后失败(源已 stop):不复活旧播放 —— 零 renew/不自动二次消费;显式重试出路(C4)
        patch({
          phase: 'failed',
          failure: { kind: 'resolve', recoverable: false, message: '切换播放失败,可重试或重新播放。' },
        });
        return;
      }
    }
  }

  /** 选候选(行点击):开启串行流 暂停确认→必要物化→目标历史→三选一等待 */
  const selectCandidate = useCallback(
    (candidate: SwitchCandidateDto): void => {
      const current = stateRef.current;
      if (!current.drawerOpen) {
        return;
      }
      // 不同 ui 操作号仲裁窗口(T075 D2;ui.md §2):selecting=常规发起;
      // creatingIntent=意图在途等待,允许换目标开新操作 —— 旧流凭流号守卫放弃,
      // 其后到 intent 响应由输家追查显式 cancel(不能仅丢弃)。intent 已建后段
      // (stoppingSource/resolvingTarget)与终态不重入(T074 接缝⑤保持)。
      if (current.phase !== 'selecting' && current.phase !== 'creatingIntent') {
        return;
      }
      const stream: TransitionStream = {
        id: streamSeqRef.current + 1,
        sessionId: sessionIdRef.current,
        generation: generationRef.current,
        abort: new AbortController(),
      };
      streamSeqRef.current = stream.id;
      streamRef.current = stream;
      slotRevisionRef.current = 0;
      intentRef.current = null;
      pendingChoiceRef.current = null;
      patch({
        phase: 'pausing',
        selection: { candidate },
        target: null,
        choice: null,
        failure: null,
        sourceTerminated: null,
        successorSessionId: null,
      });
      void runSelectionStream(stream, candidate);
    },
    [patch],
  );

  /** 串行流前半:暂停确认 → 必要物化(I1)→ 目标历史 → 进入三选一等待 */
  async function runSelectionStream(stream: TransitionStream, candidate: SwitchCandidateDto): Promise<void> {
    // 1. 串行暂停确认(carry checkpoint 唯一来源;周期样本不断、源播放保持)
    let checkpoint: AcceptedCheckpoint;
    try {
      checkpoint = await pauseRef.current();
    } catch {
      if (!streamAlive(stream)) {
        return;
      }
      pendingChoiceRef.current = null;
      patch({
        phase: 'failed',
        failure: { kind: 'pause', recoverable: true, message: '暂停保存进度失败,可取消换源后重试。' },
      });
      return;
    }
    if (!streamAlive(stream)) {
      return;
    }
    // 2. 必要物化(candidateRef 分支 → registeredCandidateRef;I1)
    patch({ phase: 'materializing' });
    let materialized: MaterializedDto;
    try {
      materialized = await postMaterialization(stream, candidate);
    } catch (error) {
      if (!streamAlive(stream) || isAbortError(error)) {
        return;
      }
      // 停源前失败可恢复(spec 场景 5):零 stop/零 resolve,源会话继续存活
      pendingChoiceRef.current = null;
      patch({
        phase: 'failed',
        failure: { kind: 'materialize', recoverable: true, message: materializeFailureMessage(error) },
      });
      return;
    }
    if (!streamAlive(stream)) {
      return;
    }
    const registeredCandidateRef =
      typeof materialized.registeredCandidateRef === 'string' && materialized.registeredCandidateRef !== ''
        ? materialized.registeredCandidateRef
        : null;
    if (registeredCandidateRef === null) {
      pendingChoiceRef.current = null;
      patch({
        phase: 'failed',
        failure: { kind: 'materialize', recoverable: true, message: '候选登记引用缺失,请重新选择候选。' },
      });
      return;
    }
    // 3. 目标历史(三选一依据;查询失败不虚构 —— 仅二选一)
    let hasTargetHistory = false;
    try {
      const titleProgress = await privateFetch<TitleProgressDto>(
        `/me/vod/titles/${encodeURIComponent(materialized.parentMediaId)}/progress`,
        { signal: stream.abort.signal },
      );
      if (!streamAlive(stream)) {
        return;
      }
      hasTargetHistory = titleProgress?.latest !== null && titleProgress?.latest !== undefined
        ? true
        : titleProgress?.resumeCandidate !== null && titleProgress?.resumeCandidate !== undefined;
    } catch {
      if (!streamAlive(stream)) {
        return;
      }
    }
    // 5. 串行流就绪:若用户在选择面上已预选位置,此刻按 checkpoint 纪律一次性决议
    // (直接传本帧事实 —— stateRef 随渲染更新,此刻尚滞后于上方 setState)
    const target: VodTransitionTarget = { registeredCandidateRef, targetMediaId: materialized.mediaId, hasTargetHistory };
    const choice: VodTransitionChoice = {
      checkpointAccepted: checkpoint.sessionAccepted,
      cursorGeneration: checkpoint.acceptedGeneration,
      cursorSampleSeq: checkpoint.acceptedSampleSeq,
      cursorPositionSeconds: checkpoint.acceptedPositionSeconds,
      requiresExplicitConfirm: !checkpoint.sessionAccepted,
    };
    patch({ phase: 'selecting', target, choice });
    applyPendingChoice(stream, target, choice);
  }

  /**
   * 预选位置决议(carry 纪律,api.md §5):
   * - carry + 已接受 checkpoint → 立即建意图(sourceCheckpoint=接受游标);
   * - carry + 非接受(含 409 后)→ 不自动提交(B2 钉面:静默提交=违规),丢弃预选并
   *   停留显式确认面 —— 用户点「使用已确认位置」方以新 key+allow=true 提交;
   * - beginning/target_history → 立即建意图(严格缺省 checkpoint 字段);
   * - conflict → 不可 carry(按钮禁用双保险)。
   */
  function applyPendingChoice(
    stream: TransitionStream,
    target: VodTransitionTarget,
    choice: VodTransitionChoice,
  ): void {
    const pending = pendingChoiceRef.current;
    if (pending === null || stateRef.current.selection === null) {
      return;
    }
    pendingChoiceRef.current = null;
    const selection = stateRef.current.selection;
    if (pending.mode === 'carry') {
      if (selection?.candidate.matchConfidence === 'conflict') {
        return;
      }
      if (choice.requiresExplicitConfirm) {
        return; // 非接受游标不自动 carry —— 显式确认面承担(B2)
      }
    }
    if (selection === null) {
      return;
    }
    void runIntentChain(stream, { mode: pending.mode, explicitEarlier: false }, { selection, target, choice });
  }

  /**
   * 位置三选一(选择即 positionMode;ui.md §4 出现时机不钉):
   * 串行流就绪(target/choice 已知)→ 立即决议;就绪前(pausing/materializing)→ 记为
   * 预选,流就绪时按 checkpoint 纪律一次性决议(applyPendingChoice)。carry 仅接受
   * checkpoint 且非 conflict;conflict 一律拒绝(按钮禁用双保险)。
   */
  const choosePosition = useCallback(
    (mode: VodTransitionPositionMode): void => {
      const current = stateRef.current;
      const stream = streamRef.current;
      if (stream === null || current.selection === null) {
        return;
      }
      const streamReady = current.phase === 'selecting' || (current.phase === 'failed' && current.failure?.kind === 'intent');
      if (!streamReady && current.phase !== 'pausing' && current.phase !== 'flushing' && current.phase !== 'materializing') {
        return; // 其余相位不受理(intent 已建后位置面收口;T075 协调器接缝另管)
      }
      if (mode === 'carry' && current.selection.candidate.matchConfidence === 'conflict') {
        return; // conflict 不能继承源位置(api.md §5)
      }
      if (streamReady && current.target !== null && current.choice !== null && current.selection !== null) {
        // 已就绪:即时决议(carry 非接受时 requireExplicitConfirm 面承担,不静默提交)
        if (mode === 'carry' && current.choice.requiresExplicitConfirm) {
          return;
        }
        void runIntentChain(stream, { mode, explicitEarlier: false }, {
          selection: current.selection,
          target: current.target,
          choice: current.choice,
        });
        return;
      }
      // 未就绪:记为预选(流就绪时决议;B2 非接受场景届时转显式确认面)
      pendingChoiceRef.current = { mode };
    },
    [],
  );

  /** 显式确认已展示游标(B2/B2b):新 operationKey+该游标+allowEarlierAcceptedPosition=true */
  const confirmEarlierPosition = useCallback((): void => {
    const current = stateRef.current;
    const stream = streamRef.current;
    if (stream === null || current.phase !== 'selecting') {
      return;
    }
    if (current.selection === null || current.target === null || current.choice === null) {
      return;
    }
    if (current.choice.checkpointAccepted || current.choice.requiresExplicitConfirm !== true) {
      return; // 已接受走 choosePosition('carry');非显式确认态不提交
    }
    if (current.selection.candidate.matchConfidence === 'conflict') {
      return;
    }
    void runIntentChain(stream, { mode: 'carry', explicitEarlier: true }, {
      selection: current.selection,
      target: current.target,
      choice: current.choice,
    });
  }, []);

  /** 重新选择(停前失败出路):清选择、重拉候选(用户显式动作,单发;不自动循环) */
  const reselect = useCallback((): void => {
    const current = stateRef.current;
    if (current.phase !== 'failed' || current.failure?.recoverable !== true) {
      return;
    }
    streamSeqRef.current += 1;
    streamRef.current?.abort.abort();
    streamRef.current = null;
    intentRef.current = null;
    pendingChoiceRef.current = null;
    patch({
      phase: 'selecting',
      selection: null,
      target: null,
      choice: null,
      failure: null,
      sourceTerminated: null,
      successorSessionId: null,
    });
    void loadCandidates();
  }, [loadCandidates, patch]);

  /** 停后消费失败重试(重新 resolve;用户显式动作,不自动) */
  const retryResolve = useCallback((): void => {
    const current = stateRef.current;
    const stream = streamRef.current;
    if (stream === null || current.phase !== 'failed' || current.failure?.kind !== 'resolve') {
      return;
    }
    patch({ phase: 'resolvingTarget', failure: null });
    void runResolve(stream);
  }, []);

  return {
    state,
    openDrawer,
    closeDrawer,
    selectCandidate,
    choosePosition,
    confirmEarlierPosition,
    reselect,
    retryResolve,
  };
}
