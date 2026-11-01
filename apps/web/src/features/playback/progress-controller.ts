import { isFetchApiError, isAbortError, privateFetch } from '../../shared/fetch';
import type { Vod } from '@hmp/shared';

/**
 * 播放进度命令泵(010 T048;playback-state.md §1/§2/§4/§7、ui.md §2、api.md §1/§4):
 *
 * - 生命周期=session:同 session 内 generation 更新只更新 phase(不卸载、不重置 seq、
 *   不触发 session stop);sessionId 变化/组件卸载由 hook 层 dispose 兜底;
 * - seq 分配器 session 级唯一:入队即分配单调序号(不归零),重试/排队不改写已发送
 *   载荷;stale 恢复按服务端 acceptedSampleSeq 对齐(ledger 前进需重新选择,不原
 *   seq 原载荷撞同一堵墙);
 * - 2xx≠接受:ProgressReply.sessionAccepted 才推进确认游标;按「字段存在与否」
 *   兼容 8 键(vod_episode)/3 键投影(standalone/channel)与 204 空体;
 * - superseded(sessionAccepted=true/applied=false):按接受处理(ack、不重发
 *   started),historyApplied=false 供「历史已由其他设备更新」提示;
 * - 有界队列:未发送的 periodic 合并保留最新位置(序号已分配不重复),started/pause
 *   因果保留;样本载荷一经发送不可变(不可变载荷,丢响应原样重试);
 * - awaitable 命令:pauseAndFlush 暂停立即入队并按序等待确认,决议为该 pause 样本
 *   的精确服务端接受游标(§5 carry 输入);stopOnce 唯一 Promise+不可变 final 载荷,
 *   恰一次 /stop,卸载兜底复用同一 Promise;
 * - 统一收口(010 T079;playback-state §4/ui.md §2/api.md §7 I5):退出登录/切档/
 *   卸载走同一命令面 —— 身份撤销(sessionId 失效)经 revoke():abort 在途+立即
 *   stopOnce,绝不等待保存(身份撤销不能被保存阻塞;自然结束已请求时唯一 final
 *   仍由 finish 命令收口,不补第二 stop);有界保存 boundedSave():pauseAndFlush
 *   竞速 1s 超时即放弃(仅放弃「等待」,不撤销泵内按序确认/重试);保存收口三态
 *   saved/superseded/failed/delivery-only 经 onSaveOutcome 暴露 —— 保存失败提示与
 *   superseded(会话已接受但历史由他设备写入,本机位置仍可 carry)、仅投递(无任何
 *   已确认保存的空停)严格区分,绝不混同。撤销后旧身份零补报:stopped 后不入队/
 *   不派发/不重试/不观测(T048 泵守卫),离线亦不缓存重放(服务端身份撤销事务+
 *   watchdog 兜底,客户端只发唯一卫生 /stop);
 * - finish 队列(010 T064;api.md §4):自然 ended 触发唯一 finish 命令 —— 一次性
 *   分配 final seq 的不可变载荷(operationKey UUID/cause=natural_end),网络失败以
 *   原载荷原样重试,回执(FinishReceipt)经 onFinishReceipt 上报(连播资格唯一入口);
 *   重复 ended 幂等(不重复 finish/不造第二会话);ended 即停周期链并不再入队新样本,
 *   final 不越过未决已分配样本;finish 已发起后卸载不补 stop/final(ui.md §2 一次
 *   final:回执已取得或重试在途,均由该唯一 Promise 收口);
 * - observations 通道:seeking 先于 seeked(尾段证据复位),eventSeq 每 generation
 *   独立单调;本地 seek 不换 generation(客户端媒体 API 定位,I4);真实 playing
 *   媒体事件上报 event=playing 观测(api.md §7 I4:服务端以其原子设置
 *   playback_started_at,是 readyAt+60s 未起播期限的唯一客户端解除通道)—— 不 gate
 *   在 started ACK 之后:手势恢复后真实 playing 即上报,拒绝期媒体从未 playing 故
 *   零伪造。
 */

/** FinishReceipt(自然结束回执;finish 队列决议面,api.md §4) */
export type FinishReceiptDto = Vod.components['schemas']['FinishReceipt'];

/** 服务端接受游标(pauseAndFlush 决议面;api.md §1 ProgressReply 接受字段) */
export interface AcceptedCheckpoint {
  /** 本次等待是否被服务端会话接受(2xx≠接受:只有它才算确认) */
  readonly sessionAccepted: boolean;
  /** 服务端最后接受的样本序号(精确接受游标;api.md §5 carry 输入) */
  readonly acceptedSampleSeq: number;
  /** 服务端最后接受的位置秒;null=尚无接受位置 */
  readonly acceptedPositionSeconds: number | null;
  /** 接受游标所在代次 */
  readonly acceptedGeneration: number;
}

type SampleReason = 'started' | 'periodic' | 'pause';

/** 线上载荷(入队即冻结;重试/排队不改写 —— 样本一经发送不可变) */
interface SamplePayload {
  readonly sampleSeq: number;
  readonly expectedGeneration: number;
  readonly positionSeconds: number;
  readonly reason: SampleReason;
}

/** 泵内样本:载荷 + 等待者簿记(等待者是内部调度面,不上网)。
 * payload 字段仅允许「未发送的排队 periodic 合并」替换(见 enqueue);载荷对象
 * 一经入队即冻结,已发送样本的载荷永不改写(不可变载荷,丢响应原样重试)。 */
interface Sample {
  payload: SamplePayload;
  readonly waiters: Array<(checkpoint: AcceptedCheckpoint) => void>;
  readonly failures: Array<(error: unknown) => void>;
}

/** ProgressReply 原始形态(8 键/3 键投影/204 空体统一按字段存在与否解析) */
type RawReply = Partial<Vod.components['schemas']['ProgressReply']> | undefined;

/** 解析后的回复事实(缺省键按「未携带=不否定」投影:3 键/空体不等于 stale) */
interface ParsedReply {
  readonly sessionAccepted: boolean;
  readonly applied: boolean;
  readonly sessionStarted: boolean;
  readonly acceptedSampleSeq: number | null;
  readonly acceptedPositionSeconds: number | null;
  readonly acceptedGeneration: number | null;
}

export interface ProgressControllerCallbacks {
  /** started 确认面变化(sessionAccepted+sessionStarted;2xx 本身不等于确认) */
  readonly onStartedAcked?: (acked: boolean) => void;
  /** 断网/同步失败面变化(保留最后成功值;恢复后原 seq/payload 重试) */
  readonly onSyncFailed?: (failed: boolean) => void;
  /** 历史应用面变化(ProgressReply.applied;superseded → false) */
  readonly onHistoryApplied?: (applied: boolean) => void;
  /** 未确认 started 即停止(空 stop)时的用户提示 */
  readonly onUnsavedProgress?: () => void;
  /** 服务端稳定拒绝(授权/会话/冲突)时的终止提示 */
  readonly onRejected?: (message: string) => void;
  /** 自然结束回执到达(唯一 finish 命令决议;连播资格事实唯一入口,T064) */
  readonly onFinishReceipt?: (receipt: FinishReceiptDto) => void;
  /** 保存收口三态变化(010 T079):有界保存决议/空停投递时发布 —— saved/superseded/
   *  failed/delivery-only 供 UI 区分提示(保存失败≠superseded≠仅投递) */
  readonly onSaveOutcome?: (outcome: PlaybackSaveOutcome) => void;
}

/** 上报节拍与重试参数(005 T104 既有节奏;测试经全局 fetch mock 断言行为) */
const PERIOD_MS = 10_000;
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 2_000;

/**
 * 有界保存窗口(010 T079;ui.md §2「普通退出1s后结束UI及旧身份」/playback-state §4
 * 「普通退出/切档仅等1s」):退出/关闭路径对保存确认的等待上限 —— 超时即放弃等待,
 * 绝不让身份撤销或 UI 收口被保存阻塞。
 */
export const BOUNDED_SAVE_MS = 1_000;

/**
 * 保存收口三态+确认面(010 T079;ui.md §2/playback-state §2/§4):
 *
 * - saved:保存已确认(sessionAccepted 且存在接受游标);
 * - superseded:会话已接受但历史未由本会话写入(他设备更新;本机位置仍可 carry,
 *   依 historyApplied=false 判定)—— 绝不显示「已同步到个人历史」,也绝不是保存失败;
 * - failed:保存未确认(有界窗口超时/断网/稳定拒绝)——「进度未同步」提示唯一依据;
 * - delivery-only:仅投递(无任何已确认保存事实,如未确认 started 的空 stop)——
 *   与保存失败区分:不是「存了但没存上」,而是「本就无可保存,仅命令已送达」。
 */
export type PlaybackSaveOutcome = 'saved' | 'superseded' | 'failed' | 'delivery-only';

function readPosition(video: HTMLVideoElement | null, fallback: number): number {
  const value = video?.currentTime;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isNetworkError(error: unknown): boolean {
  return !isAbortError(error) && !isFetchApiError(error);
}

/** 按字段存在与否解析回复(投影只裁键不改值:缺键≠false,T092 恰 3 键回归兼容) */
function parseReply(raw: RawReply): ParsedReply {
  const body = raw !== null && typeof raw === 'object' ? raw : {};
  return {
    sessionAccepted: body.sessionAccepted !== false,
    applied: body.applied !== false,
    sessionStarted: body.sessionStarted !== false,
    acceptedSampleSeq: typeof body.acceptedSampleSeq === 'number' ? body.acceptedSampleSeq : null,
    acceptedPositionSeconds:
      typeof body.acceptedPositionSeconds === 'number' ? body.acceptedPositionSeconds : null,
    acceptedGeneration: typeof body.acceptedGeneration === 'number' ? body.acceptedGeneration : null,
  };
}

export class ProgressController {
  private readonly sessionId: string;
  private readonly callbacks: ProgressControllerCallbacks;

  /** phase 上下文(仅被 setPhase 更新;样本入队时刻取值,载荷冻结) */
  private generation = 0;
  /** session 级 seq 分配器(入队即分配;stale 时对齐服务端游标,不倒退) */
  private seq = 0;
  /** eventSeq 每 generation 独立(setPhase 重置;与 sampleSeq 不互代) */
  private eventSeq = 0;

  private video: HTMLVideoElement | null = null;
  private inFlight: Sample | null = null;
  private readonly queue: Sample[] = [];
  private readonly abortRef: { current: AbortController | null } = { current: null };
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private periodTimer: ReturnType<typeof setInterval> | null = null;
  private retryAttempts = 0;
  private disposed = false;

  /** started 确认(sessionAccepted+sessionStarted;确认前禁用 seek/音轨切换) */
  private acked = false;
  private syncFailed = false;
  private historyApplied = true;
  /** 观测位置(确认前为回弹基准;确认后随 timeupdate/seek 前进) */
  private lastKnownTime = 0;
  /** 最后会话接受游标(stale 恢复/carry 输入;ledger 语义按回复事实维护) */
  private readonly accepted: {
    seq: number;
    position: number | null;
    generation: number | null;
  } = { seq: 0, position: null, generation: null };

  /** requestStop 标记(不再入队;不发网络) */
  private stopped = false;
  /** stopOnce 唯一命令(唯一 Promise + 不可变 final 载荷;恰一次 /stop) */
  private stopCommand: { readonly promise: Promise<void> } | null = null;

  /** 自然结束已请求(ended 触发;停周期链,不再入队新样本,暂停命令收口) */
  private finishRequested = false;
  /** finish 唯一命令(唯一 Promise + 不可变载荷;重复 ended 幂等,恰一次网络链) */
  private finishCommand: { readonly promise: Promise<FinishReceiptDto> } | null = null;
  /** finish 重试定时器(独立于进度样本重试;dispose 不清除 —— final 保存优先) */
  private finishRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private finishAttempts = 0;
  /** finish 已决议(回执取得;重试链收口) */
  private finishSettled = false;

  /** 最近一次保存收口三态(010 T079 状态面;null=尚无收口事实) */
  private saveOutcomeState: PlaybackSaveOutcome | null = null;

  private detachVideo: (() => void) | null = null;

  constructor(sessionId: string, callbacks: ProgressControllerCallbacks = {}) {
    this.sessionId = sessionId;
    this.callbacks = callbacks;
  }

  /* ---------------- 生命周期与 phase ---------------- */

  /** generation 更新只更新 phase:不重置 seq/队列/确认面,不发 session stop(§7) */
  setPhase(generation: number): void {
    if (this.generation === generation) {
      return;
    }
    this.generation = generation;
    // eventSeq 每 generation 独立单调(playback-state §1;与 sampleSeq 不互代)
    this.eventSeq = 0;
  }

  /** 绑定媒体元素(事件监听由泵持有;元素随播放器换装保持同一容器)。
   *  重复 attach 幂等:先摘旧监听与周期拍再重装(T082:StrictMode 双挂载重入认领
   *  同一控制器时 attach 二次调用,不得叠加周期定时器造成双倍样本)。 */
  attach(video: HTMLVideoElement | null): void {
    this.detachVideo?.();
    this.detachVideo = null;
    if (this.periodTimer !== null) {
      clearInterval(this.periodTimer);
      this.periodTimer = null;
    }
    this.video = video;
    if (video !== null) {
      // const 别名:闭包内保持非空收窄(监听仅绑在已 attach 的元素上)
      const element = video;
      const onPlaying = (): void => {
        this.lastKnownTime = readPosition(element, this.lastKnownTime);
        // I4:真实 playing 观测(服务端以其原子设置 playback_started_at,解除
        // readyAt+60s 未起播期限的唯一客户端通道)。不 gate 在 started ACK 之后:
        // 手势恢复后立即上报;拒绝期媒体从未 playing,零伪造。
        this.observe('playing', this.lastKnownTime);
        // 首次实际 playing 上报 started(已确认/已有分配序号后的 playing 不重发)
        if (!this.acked && this.inFlight === null && this.seq === 0) {
          this.enqueue('started', this.lastKnownTime);
        }
      };
      const onEnded = (): void => {
        // 自然结束(T064 finish 队列触发;位置在 ended 时刻冻结)
        this.lastKnownTime = readPosition(element, this.lastKnownTime);
        this.beginNaturalFinish();
      };
      const onPause = (): void => {
        this.lastKnownTime = readPosition(element, this.lastKnownTime);
        // 暂停立即上报(未确认时入队,不越过未确认 started)
        this.enqueue('pause', this.lastKnownTime);
      };
      const onSeeking = (): void => {
        if (!this.acked) {
          // ACK 前禁用用户 seek:回弹到确认前位置(确认后恢复执行)
          element.currentTime = this.lastKnownTime;
          return;
        }
        // 本地 seek 不换 generation:先发 seeking 观测(重置尾段证据),进度同代有序上报
        this.lastKnownTime = readPosition(element, this.lastKnownTime);
        this.observe('seeking', this.lastKnownTime);
      };
      const onSeeked = (): void => {
        if (!this.acked) {
          return;
        }
        this.lastKnownTime = readPosition(element, this.lastKnownTime);
        this.observe('seeked', this.lastKnownTime);
      };
      const onTimeUpdate = (): void => {
        if (this.acked) {
          this.lastKnownTime = element.currentTime;
        }
      };
      element.addEventListener('playing', onPlaying);
      element.addEventListener('ended', onEnded);
      element.addEventListener('pause', onPause);
      element.addEventListener('seeking', onSeeking);
      element.addEventListener('seeked', onSeeked);
      element.addEventListener('timeupdate', onTimeUpdate);
      this.detachVideo = (): void => {
        element.removeEventListener('playing', onPlaying);
        element.removeEventListener('ended', onEnded);
        element.removeEventListener('pause', onPause);
        element.removeEventListener('seeking', onSeeking);
        element.removeEventListener('seeked', onSeeked);
        element.removeEventListener('timeupdate', onTimeUpdate);
      };
    }
    this.periodTimer = setInterval(() => {
      // 周期样本:未确认/在途期间入队(未发送的 periodic 合并,确认后按序上报)
      this.enqueue('periodic', readPosition(this.video, this.lastKnownTime));
    }, PERIOD_MS);
  }

  /** 生命周期终点(组件卸载/会话切换):本地回收 + 兜底复用 stopOnce 的同一 Promise 与载荷 */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.detachVideo?.();
    this.detachVideo = null;
    this.clearTimers();
    this.collectTerminalCommand();
  }

  /**
   * 同步本地回收(T082 StrictMode 双挂载修复面):abort 在途请求 + 摘媒体监听 +
   * 停周期拍 —— 「旧会话请求立即失效」契约保持同步;**不发终局网络命令**。
   * 终局命令(stopOnce 唯一 Promise)由调用方经 collectTerminal() 决定时机
   * (延迟一拍以吸收 StrictMode 同步 remount,或立即收口)。
   */
  disposeLocal(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.detachVideo?.();
    this.detachVideo = null;
    this.clearTimers();
    this.abortRef.current?.abort();
  }

  /** 终局命令收口(公开面;供延迟一拍的卸载兜底调用):唯一 /stop 或唯一 finish */
  collectTerminal(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.clearTimers();
    }
    this.collectTerminalCommand();
  }

  /**
   * 身份撤销收口(010 T079;api.md §7 I5/playback-state §4/§8):sessionId 失效
   * (退出登录/切档/会话撤销)与卸载兜底走**同一命令面** —— abort 在途 + 立即
   * stopOnce,绝不等待任何保存(身份撤销不能被保存阻塞);自然结束已请求时唯一
   * final 仍由 finish 命令收口(不补第二 stop,ui.md §2 一次 final)。
   *
   * 撤销后旧身份零补报(T048 泵守卫显式化):stopped 后样本不再入队(enqueue null)、
   * 不派发、断网不重试、观测静默 —— 离线亦无补报队列可重放。服务端身份撤销事务+
   * watchdog 兜底负责清理,客户端只发唯一卫生 /stop。
   */
  revoke(): void {
    this.dispose();
  }

  /** 终局命令收集:唯一 /stop 或唯一 finish(恰一次网络面;幂等) */
  private collectTerminalCommand(): void {
    if (this.sessionId === '') {
      return;
    }
    if (this.finishRequested) {
      // 自然结束已请求:唯一 final 由 finish 命令收口 —— 不补 stop(ui.md §2 一次
      // final;E2 回执后卸载零补 final/stop)。尚未启动时立即启动(卸载不再等队列)。
      this.maybeStartFinish();
      return;
    }
    if (this.finishCommand === null) {
      // 卸载/身份撤销兜底=同 stopOnce 命令(不另生成 final;ui.md §2/playback-state §7)
      void this.stopOnce();
    }
  }

  /** 主动停止:仅标记(后续样本不再入队),网络 stop 由 stopOnce/卸载兜底统一发送 */
  requestStop(): void {
    this.stopped = true;
  }

  /* ---------------- awaitable 命令 ---------------- */

  /**
   * 暂停并按序等待确认:pause 立即入队(唯一分配)→ 在途/排队样本按序确认 →
   * 决议为该 pause 样本的服务端接受游标(stale 时 sessionAccepted=false 原样返回
   * 服务端恢复游标;ui.md §2/api.md §5)。
   */
  pauseAndFlush(): Promise<AcceptedCheckpoint> {
    if (this.disposed || this.stopped || this.finishRequested || this.sessionId === '') {
      return Promise.resolve(this.checkpoint(true));
    }
    const sample = this.enqueue('pause', readPosition(this.video, this.lastKnownTime));
    if (sample === null) {
      return Promise.resolve(this.checkpoint(true));
    }
    return new Promise<AcceptedCheckpoint>((resolve, reject) => {
      sample.waiters.push(resolve);
      sample.failures.push(reject);
    });
  }

  /**
   * 有界保存(010 T079;playback-state §4「仅等1s」/ui.md §2「普通退出1s」):
   * pauseAndFlush 竞速 1s 超时 —— 超时即放弃**等待**(泵内该样本仍按序确认/重试,
   * 不被撤销),决议为当前非严格 checkpoint;身份撤销(revoke)绝不等待本方法。
   * 永不 reject(稳定拒绝已经 onRejected 上报);决议同时在状态面发布三态结果
   * (saved/superseded/failed/delivery-only,经 onSaveOutcome 供 UI 区分提示)。
   */
  boundedSave(timeoutMs: number = BOUNDED_SAVE_MS): Promise<AcceptedCheckpoint> {
    if (this.disposed || this.stopped || this.finishRequested || this.sessionId === '') {
      // 无可入队样本(已收口/已停止):三态按「最后已确认保存事实」结算(无接受
      // 游标 → 仅投递),不伪造任何本轮保存事实
      const checkpoint = this.checkpoint(false);
      this.publishSaveOutcome(checkpoint, false);
      return Promise.resolve(checkpoint);
    }
    const flush = this.pauseAndFlush();
    return new Promise<AcceptedCheckpoint>((resolve) => {
      const settleBounded = (checkpoint: AcceptedCheckpoint, attempted: boolean): void => {
        clearTimeout(timer);
        this.publishSaveOutcome(checkpoint, attempted);
        resolve(checkpoint);
      };
      const timer = setTimeout(() => {
        // 有界放弃:超时即放弃等待(不阻塞任何收口路径);此刻无可确认事实
        settleBounded(this.checkpoint(false), true);
      }, timeoutMs);
      void flush.then(
        (checkpoint) => {
          settleBounded(checkpoint, true);
        },
        () => {
          // 稳定拒绝:有界放弃(拒绝提示已由 onRejected 承担)
          settleBounded(this.checkpoint(false), true);
        },
      );
    });
  }

  /** 最近一次保存收口三态(T079 状态面只读投影;null=尚无收口事实) */
  get saveOutcome(): PlaybackSaveOutcome | null {
    return this.saveOutcomeState;
  }

  /**
   * 幂等停止:唯一 Promise;并发调用复用同一命令与不可变 final 载荷,恰一次 /stop
   * (未确认 started 即空 stop,不伪造 final)。卸载兜底复用同一 Promise。
   */
  stopOnce(): Promise<void> {
    const existing = this.stopCommand;
    if (existing !== null) {
      return existing.promise;
    }
    this.stopped = true;
    this.clearTimers();
    // 终止在途进度请求:final/空 stop 不得越过未决样本的重复回写(取消旧代样本)
    this.abortRef.current?.abort();
    // 队列中未发送样本随会话终止废弃;其等待者以当前接受游标尽力结算(不悬挂)
    const pending = this.queue.splice(0, this.queue.length);
    pending.forEach((sample) => this.settle(sample, this.checkpoint(false)));
    const inFlight = this.inFlight;
    this.inFlight = null;
    if (inFlight !== null) {
      // 在途样本等待者:请求已中止,以当前接受游标结算(不再等待网络)
      this.settle(inFlight, this.checkpoint(false));
    }
    const command: { promise: Promise<void> } = { promise: Promise.resolve() };
    this.stopCommand = command;
    if (this.acked) {
      // final 载荷构造后不可变(恰一次分配 final seq;不因并发 stopOnce 重复生成)
      const payload = Object.freeze({
        finalProgress: {
          sampleSeq: this.allocateSeq(),
          expectedGeneration: this.generation,
          positionSeconds: Math.max(readPosition(this.video, this.accepted.position ?? 0), 0),
        },
      });
      command.promise = privateFetch<void>(this.url('stop'), { method: 'POST', body: payload }).catch(
        () => undefined,
      );
    } else {
      // 未确认 started 即停止:空 stop + 未保存提示(不伪造 final);三态面发布
      // 「仅投递」—— 本就无可保存事实,与保存失败/superseded 严格区分(T079)
      this.publishSaveOutcome(this.checkpoint(false), false);
      command.promise = privateFetch<void>(this.url('stop'), { method: 'POST', body: {} })
        .then(() => {
          this.callbacks.onUnsavedProgress?.();
        })
        .catch(() => {
          this.callbacks.onUnsavedProgress?.();
        });
    }
    return command.promise;
  }

  /* ---------------- finish 队列(010 T064;api.md §4) ---------------- */

  /** 请求一次性 operationKey(UUID;finish 行/IntentRequest 同一身份语义) */
  private newOperationKey(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  /**
   * 自然结束入口(ended 触发):停周期链、不再入队新样本;唯一 finish 命令幂等 ——
   * 重复 ended 不重复 finish、不造第二会话(E1/spec 场景 4)。
   */
  private beginNaturalFinish(): void {
    if (this.finishRequested) {
      return;
    }
    this.finishRequested = true;
    // 收到 finish 即停周期链(api.md §4):周期拍与后续观测/样本全部收口
    if (this.periodTimer !== null) {
      clearInterval(this.periodTimer);
      this.periodTimer = null;
    }
    this.maybeStartFinish();
  }

  /**
   * 启动唯一 finish 命令:等待已分配样本完成后再发(final 不越过未决 started);
   * 载荷恰一次构造并冻结(final seq 唯一分配,重试/重复 ended 不改写)。
   */
  private maybeStartFinish(): void {
    if (!this.finishRequested || this.finishCommand !== null) {
      return;
    }
    // 已分配样本完成后才允许 final(api.md §4);卸载后不再等待(final 保存优先)
    if (!this.disposed && (this.inFlight !== null || this.queue.length > 0)) {
      return;
    }
    const payload = Object.freeze({
      operationKey: this.newOperationKey(),
      finalProgress: Object.freeze({
        sampleSeq: this.allocateSeq(),
        expectedGeneration: this.generation,
        positionSeconds: Math.max(readPosition(this.video, this.lastKnownTime), 0),
      }),
      cause: 'natural_end' as const,
    });
    const command: { readonly promise: Promise<FinishReceiptDto> } = {
      promise: this.postFinish(payload),
    };
    this.finishCommand = command;
    // 回执上报(连播资格唯一入口);稳定拒绝已定性:无回执 → 连播不推进(不悬挂)
    void command.promise.then((receipt) => {
      this.callbacks.onFinishReceipt?.(receipt);
    });
  }

  /** finish 网络链:网络失败以原载荷原样重试(唯一 Promise 不可变载荷,E2) */
  private postFinish(payload: {
    readonly operationKey: string;
    readonly finalProgress: {
      readonly sampleSeq: number;
      readonly expectedGeneration: number;
      readonly positionSeconds: number;
    };
    readonly cause: 'natural_end';
  }): Promise<FinishReceiptDto> {
    return new Promise<FinishReceiptDto>((resolve, reject) => {
      const attempt = (): void => {
        void privateFetch<FinishReceiptDto>(this.url('finish'), { method: 'POST', body: payload })
          .then((receipt) => {
            this.finishSettled = true;
            resolve(receipt);
          })
          .catch((error: unknown) => {
            if (this.finishSettled) {
              return;
            }
            if (isNetworkError(error)) {
              // 断网:同 operationKey/载荷原样重试(退避;不可变载荷逐字节一致)
              this.finishRetryTimer = setTimeout(
                () => {
                  this.finishRetryTimer = null;
                  if (!this.finishSettled) {
                    attempt();
                  }
                },
                Math.min(RETRY_MIN_MS * 2 ** this.finishAttempts, RETRY_MAX_MS),
              );
              this.finishAttempts += 1;
              return;
            }
            // 服务端稳定拒绝(硬非法/已记录):不重试;无回执 → 连播资格不推进
            reject(error);
          });
      };
      attempt();
    });
  }

  /* ---------------- 队列与发送 ---------------- */

  private allocateSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private url(action: 'progress' | 'stop' | 'observations' | 'finish'): string {
    return `/playback/sessions/${encodeURIComponent(this.sessionId)}/${action}`;
  }

  /**
   * 入队即唯一分配序号;在途/退避期间排队(不越过未确认 started)。
   * 未发送的 periodic 合并保留最新位置(序号已分配不重复);pause/started 因果保留。
   */
  private enqueue(reason: SampleReason, positionSeconds: number): Sample | null {
    if (this.stopped || this.disposed || this.finishRequested || this.sessionId === '') {
      return null;
    }
    const merged = reason === 'periodic' ? this.lastQueuedPeriodic() : null;
    if (merged !== null) {
      // 合并:仅改写「尚未发送」的排队 periodic 的位置(载荷一经发送不可变不受影响)
      merged.payload = Object.freeze({
        sampleSeq: merged.payload.sampleSeq,
        expectedGeneration: this.generation,
        positionSeconds,
        reason,
      });
      return merged;
    }
    const sample: Sample = {
      payload: Object.freeze({
        sampleSeq: this.allocateSeq(),
        expectedGeneration: this.generation,
        positionSeconds,
        reason,
      }),
      waiters: [],
      failures: [],
    };
    if (this.inFlight !== null) {
      this.queue.push(sample);
      return sample;
    }
    this.dispatch(sample);
    return sample;
  }

  private lastQueuedPeriodic(): Sample | null {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const sample = this.queue[index];
      if (sample?.payload.reason === 'periodic') {
        return sample;
      }
    }
    return null;
  }

  private dispatch(sample: Sample): void {
    const controller = new AbortController();
    this.abortRef.current = controller;
    this.inFlight = sample;
    void privateFetch<RawReply>(this.url('progress'), {
      method: 'POST',
      body: sample.payload,
      signal: controller.signal,
    })
      .then((reply) => {
        this.handleReply(sample, reply);
      })
      .catch((error: unknown) => {
        this.handleFailure(sample, error, controller);
      });
  }

  /** 回复事实处理:accepted 推进游标;stale 游标不动并对齐分配器;superseded 按接受 */
  private handleReply(sample: Sample, raw: RawReply): void {
    if (this.disposed || this.inFlight !== sample) {
      // 迟到响应/被中止样本:不回写、不重试(playback-state §8 旧响应守卫)
      return;
    }
    const reply = parseReply(raw);
    this.inFlight = null;
    this.retryAttempts = 0;
    this.setSyncFailed(false);
    this.setHistoryApplied(reply.applied);
    if (!reply.sessionAccepted) {
      // stale:确认游标不动;按服务端最后接受游标对齐分配器恢复(不原 seq 原载荷重试)
      if (reply.acceptedSampleSeq !== null) {
        this.seq = Math.max(this.seq, reply.acceptedSampleSeq);
      }
      this.settle(sample, {
        sessionAccepted: false,
        acceptedSampleSeq: reply.acceptedSampleSeq ?? sample.payload.sampleSeq,
        acceptedPositionSeconds: reply.acceptedPositionSeconds,
        acceptedGeneration: reply.acceptedGeneration ?? this.generation,
      });
      this.pump();
      return;
    }
    // accepted(含 superseded:sessionAccepted=true/applied=false —— 不重发 started)
    this.accepted.seq = Math.max(this.accepted.seq, reply.acceptedSampleSeq ?? sample.payload.sampleSeq);
    this.accepted.position = reply.acceptedPositionSeconds ?? sample.payload.positionSeconds;
    this.accepted.generation = reply.acceptedGeneration ?? sample.payload.expectedGeneration;
    if (sample.payload.reason === 'started' && !this.acked) {
      // startedAcked 依据 sessionAccepted+sessionStarted(2xx 本身不等于确认)
      this.acked = reply.sessionStarted;
      this.callbacks.onStartedAcked?.(this.acked);
    }
    this.settle(sample, this.checkpoint(true));
    this.pump();
  }

  private handleFailure(sample: Sample, error: unknown, controller: AbortController): void {
    if (this.disposed || controller.signal.aborted || this.inFlight !== sample) {
      return;
    }
    if (isNetworkError(error)) {
      // 断网:保留最后成功值,原 seq/payload 原样重试(退避;不推进 seq)
      this.setSyncFailed(true);
      this.retryTimer = setTimeout(
        () => {
          this.retryTimer = null;
          // 旧身份零补报守卫(T079 显式化):已收口/已停止即断链 —— 离线不重试、
          // 不缓存重放(服务端撤销事务+watchdog 兜底,客户端不发旧身份补报)
          if (!this.disposed && !this.stopped && this.inFlight === sample) {
            this.dispatch(sample);
          }
        },
        Math.min(RETRY_MIN_MS * 2 ** this.retryAttempts, RETRY_MAX_MS),
      );
      this.retryAttempts += 1;
      return;
    }
    // 服务端稳定拒绝:终止重试,上报稳定提示(不静默丢样本)
    this.inFlight = null;
    sample.failures.forEach((reject) => reject(error));
    if (isFetchApiError(error)) {
      this.callbacks.onRejected?.('进度保存已被服务端拒绝,播放将终止。');
    }
  }

  /** 推进队列:无在途时取队首发送(停止后不再发送) */
  private pump(): void {
    if (this.inFlight !== null || this.stopped || this.disposed) {
      return;
    }
    const next = this.queue.shift();
    if (next === undefined) {
      // 队列清空:等待中的自然 finish 可以启动(不让 final 越过未决已分配样本)
      this.maybeStartFinish();
      return;
    }
    this.dispatch(next);
  }

  /* ---------------- observations 通道 ---------------- */

  /** seeking 先于 seeked(I4 尾段证据复位);playing 为 60s 期限解除通道;eventSeq 每 generation 独立单调 */
  private observe(event: 'seeking' | 'seeked' | 'playing', positionSeconds: number): void {
    if (this.stopped || this.disposed || this.finishRequested) {
      return;
    }
    this.eventSeq += 1;
    const payload = Object.freeze({
      eventSeq: this.eventSeq,
      expectedGeneration: this.generation,
      event,
      positionSeconds,
      playbackRate: this.video?.playbackRate ?? 1,
    });
    void privateFetch<unknown>(this.url('observations'), { method: 'POST', body: payload }).catch(
      () => undefined,
    );
  }

  /* ---------------- 内部面 ---------------- */

  private checkpoint(strict: boolean): AcceptedCheckpoint {
    return {
      sessionAccepted: strict,
      acceptedSampleSeq: this.accepted.seq,
      acceptedPositionSeconds: this.accepted.position,
      acceptedGeneration: this.accepted.generation ?? this.generation,
    };
  }

  /**
   * 保存收口三态判定(010 T079):以「是否存在已确认保存事实」与「历史是否由本
   * 会话写入」区分 —— 保存失败绝不与 superseded(历史他设备写入)/仅投递(无保存
   * 事实)混同。attempted=false 表示本轮未发起保存(已收口/空停),按最后已确认
   * 事实结算,不谎报本轮失败。
   */
  private saveOutcomeFor(checkpoint: AcceptedCheckpoint, attempted: boolean): PlaybackSaveOutcome {
    if (checkpoint.acceptedSampleSeq === 0) {
      // 从无接受游标:无任何已确认保存事实(未确认 started 即空停)→ 仅投递
      return 'delivery-only';
    }
    if (attempted && !checkpoint.sessionAccepted) {
      // 本轮等待未确认(有界超时/断网/稳定拒绝)→「进度未同步」提示唯一依据
      return 'failed';
    }
    // 已确认保存;历史是否由本会话写入决定 saved/superseded(superseded 仍可 carry)
    return this.historyApplied ? 'saved' : 'superseded';
  }

  /** 三态发布(仅变化时回调;状态面供 UI 区分提示,T079) */
  private publishSaveOutcome(checkpoint: AcceptedCheckpoint, attempted: boolean): void {
    const outcome = this.saveOutcomeFor(checkpoint, attempted);
    if (this.saveOutcomeState !== outcome) {
      this.saveOutcomeState = outcome;
      this.callbacks.onSaveOutcome?.(outcome);
    }
  }

  private settle(sample: Sample, checkpoint: AcceptedCheckpoint): void {
    sample.waiters.forEach((resolve) => resolve(checkpoint));
    sample.waiters.length = 0;
    sample.failures.length = 0;
  }

  private setSyncFailed(failed: boolean): void {
    if (this.syncFailed !== failed) {
      this.syncFailed = failed;
      this.callbacks.onSyncFailed?.(failed);
    }
  }

  private setHistoryApplied(applied: boolean): void {
    if (this.historyApplied !== applied) {
      this.historyApplied = applied;
      this.callbacks.onHistoryApplied?.(applied);
    }
  }

  private clearTimers(): void {
    if (this.periodTimer !== null) {
      clearInterval(this.periodTimer);
      this.periodTimer = null;
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
