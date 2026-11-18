/**
 * ActionCoordinator 意图状态机 —— 纯逻辑层(T043;ui.md §3 逐字对照 + FR-010/FR-030)。
 *
 * 状态机(单受控 Modal 分步切换,不同时叠出多弹层):
 * ```text
 * idle
 * ├── (启动检查未初始化,setupDismissed 未置位)→ initialize → login
 * ├── loginRequested / anonymousPlay → login
 * └── authenticatedAction
 *     ├── noProfile + bootstrapRequired → bootstrap → picker
 *     ├── noProfile → picker → selectionPin(需要时)
 *     └── (play/favorite/settings 属 US3+,经同机扩展)
 * ```
 * - 每动作保存 intentId/原目标(returnTo)/入口(entry);新动作递增 generation,
 *   旧回调凭 isStaleIntent 失效(不可重开已取消弹层、不可触发播放/回填);
 * - 取消/完成:清表单凭据(formEpoch 递增,表单以 key 重挂载即清内存)、回到 idle
 *   (用户本就停留在原页面,无需导航)、标记自动弹窗机会已消费(不重复弹窗);
 * - 返回目标仅接受本应用白名单内部路径,外部/协议相对/非白名单一律回落首页
 *   (FR-010 拒绝开放重定向)。
 * 本文件不依赖 React/DOM,供组件与纯逻辑单测共用。
 */
import type { StreamLineDto } from '@hmp/shared';

/** 统一弹层的步骤(单 Modal 内内容切换) */
export type AuthStep =
  | 'idle'
  | 'setup-unavailable'
  | 'initialize'
  | 'login'
  | 'bootstrap'
  | 'picker'
  | 'selectionPin'
  | 'pinRecovery';

/**
 * 播放意图目标(T053;US3 统一受控播放):所有入口只携带同一最小目标面。
 * startMode 占位(beginning|resume);进度数据与继续/从头按钮语义由 US4 补全。
 */
export interface PlayTarget {
  readonly mediaId: string;
  readonly title: string;
  readonly startMode: 'beginning' | 'resume';
  /** 频道/影片标识 logo 引用(海报链路 posterRef;标题栏呈现「logo + 名称」用,
   *  可缺省 —— 缺省时回退首字徽标,不参与任何请求体) */
  readonly posterRef?: string | null;
  /**
   * 指定物理线路 ID(016 T020/T021;api.md §2.1 可选 lineId):OSD 手动换线与
   * 容灾续接时携带,缺省由服务端按 priority ASC/isDefault 优选。
   */
  readonly lineId?: string;
}

/** 播放意图阶段(ui.md §3:play → authorize → prepare → playing;拒绝落 unavailable) */
export type PlaybackPhase = 'authorizing' | 'preparing' | 'playing' | 'ended' | 'unavailable';

/** 播放意图状态(单一意图槽;新意图覆盖旧意图,旧回调凭 intentId+generation 失效) */
export interface PlaybackIntentState {
  /** 播放意图号:每次 play 发起递增;仅最新 intentId 可 authorize→prepare→playing(FR-013) */
  readonly intentId: number;
  readonly target: PlayTarget;
  readonly phase: PlaybackPhase;
  /** resolve 接受后的播放会话 ID(authorize 前 null) */
  readonly sessionId: string | null;
  /** 服务端会话代(renew/安装面绑定;准备完成前 null) */
  readonly playbackGeneration: number | null;
  /** 受控网关入口 URL(renew 成功后安装;仅服务端同源相对路径,不落 localStorage) */
  readonly playbackUrl: string | null;
  readonly ticketExpiresAt: string | null;
  /** 探测确定的交付模式(native direct 或 video.js/VHS 消费) */
  readonly delivery: string | null;
  /**
   * 服务端冻结的起播位置秒(T101,005 US4 resume):ready 状态读取;direct 交付由
   * 播放器安装时定位,转换交付经 presentationStart 安装。beginning/无有效进度恒 0。
   */
  readonly presentationStartSeconds: number | null;
  /** 面向观看者的稳定提示(授权拒绝/资源不可用;不含内部策略与源位置) */
  readonly message: string | null;
  /**
   * 该频道可用线路清单(016 api.md §2.1;resolve 201 投影落 state,playPatch 可更新):
   * 供 OSD 手动换线与自动容灾顺位消费;空数组 = 无多线路语义(单线路/影片)。
   */
  readonly lines: readonly StreamLineDto[];
  /** 本次解析实际选中线路(016 api.md §2.1;null = 线路未定/无多线路语义) */
  readonly selectedLineId: string | null;
}

export interface CoordinatorState {
  step: AuthStep;
  /** 动作序号:每次新动作(start)递增 */
  intentId: number;
  /** 代次:新动作与取消/完成都递增;异步回调凭捕获值失效 */
  generation: number;
  /** 原业务目标(白名单校验后的内部路径);选档成功后回这里或首页 */
  returnTo: string;
  /** 调用入口(如 header-login / auto-uninitialized),供诊断与测试 */
  entry: string;
  /** 未初始化弹窗被用户取消后不再自动重开(不重复弹窗) */
  setupDismissed: boolean;
  /** 启动期 /setup/status 自动检查只消费一次 */
  autoOpenChecked: boolean;
  /** 表单凭据清空信号:递增后表单以 key 重挂载,内存中的密码/PIN 即被丢弃 */
  formEpoch: number;
  /** picker/selectionPin 正在操作的目标档案 */
  targetProfileId: string | null;
  /** 播放意图序号源:playStart/playDefer 各递增一次,保证 intentId 单调 */
  playbackIntentSeq: number;
  /** 当前播放意图(null = 无播放面);playing 态由协调器全屏挂载播放器 */
  playback: PlaybackIntentState | null;
  /** 游客/未选档播放意图暂存:登录选档完成后由协调器续跑;取消/关闭弹层即清(不自动播放) */
  pendingPlay: { readonly intentId: number; readonly target: PlayTarget } | null;
}

export type CoordinatorAction =
  | { type: 'start'; step: Exclude<AuthStep, 'idle'>; returnTo?: string | null; entry: string }
  /** 同一意图内分步推进(initialize→login、bootstrap→picker、picker→selectionPin 等) */
  | { type: 'goto'; step: Exclude<AuthStep, 'idle'> }
  | { type: 'cancel' }
  | { type: 'complete' }
  | { type: 'autoOpen'; wantsInitialize: boolean }
  | { type: 'targetProfile'; profileId: string | null }
  /** 发起播放意图(authorize 起点;intentId 必须严格大于当前序号,保证仅最新意图有效) */
  | { type: 'playStart'; intentId: number; target: PlayTarget }
  /** 播放意图阶段推进/结果写入;intentId 不匹配即整体忽略(旧回调不得改写新意图) */
  | { type: 'playPatch'; intentId: number; patch: Partial<Omit<PlaybackIntentState, 'intentId' | 'target'>> }
  /**
   * 原地换装改写目标面(直播节目单切台/OSD 手动换线):与 playPatch 同款意图守卫,
   * 只替换 target,相位与其余会话面全部保持。
   *
   * 为什么单独一个动作而不是扩展 playPatch:playPatch 的类型刻意
   * `Omit<..., 'intentId' | 'target'>` —— 目标面只在 playStart 建立,阶段推进不得
   * 篡改「在播的是谁」。而就地切台/换线的语义恰是「同一意图内换内容」:不新建意图
   * (新建会经 playStart 把相位推到 authorizing/preparing,播放面随之卸载 ——
   * 真机表现为播放器关闭后重新加载),只在新会话就绪时原子改写目标面。
   */
  | { type: 'playRetarget'; intentId: number; target: PlayTarget }
  /** 关闭/废弃播放意图(用户退出或身份失效;intentId 不匹配则忽略) */
  | { type: 'playEnd'; intentId: number }
  /** 游客/未选档播放意图暂存(选档完成后续跑;取消不自动播放) */
  | { type: 'playDefer'; intentId: number; target: PlayTarget };

export function createInitialCoordinatorState(): CoordinatorState {
  return {
    step: 'idle',
    intentId: 0,
    generation: 0,
    returnTo: '/',
    entry: '',
    setupDismissed: false,
    autoOpenChecked: false,
    formEpoch: 0,
    targetProfileId: null,
    playbackIntentSeq: 0,
    playback: null,
    pendingPlay: null,
  };
}

export function coordinatorReducer(state: CoordinatorState, action: CoordinatorAction): CoordinatorState {
  switch (action.type) {
    case 'start':
      return {
        ...state,
        step: action.step,
        intentId: state.intentId + 1,
        generation: state.generation + 1,
        returnTo: sanitizeReturnTarget(action.returnTo ?? '/'),
        entry: action.entry,
        formEpoch: state.formEpoch + 1,
        targetProfileId: null,
      };
    case 'goto':
      return { ...state, step: action.step };
    case 'cancel':
      // 清意图与凭据、回 idle(原页面即当前页面,无导航);自动弹窗机会视为已消费。
      // 暂存播放意图一并废弃:取消登录/选档绝不自动播放(FR-010/FR-013)
      return {
        ...state,
        step: 'idle',
        generation: state.generation + 1,
        formEpoch: state.formEpoch + 1,
        autoOpenChecked: true,
        targetProfileId: null,
        pendingPlay: null,
      };
    case 'complete':
      // 完成登录/选档;暂存播放意图保留 —— 协调器在同一选档成功事务后续跑原目标播放
      // (US3 场景 1:继续原目标;取消路径才清空)
      return {
        ...state,
        step: 'idle',
        generation: state.generation + 1,
        formEpoch: state.formEpoch + 1,
        autoOpenChecked: true,
        targetProfileId: null,
      };
    case 'autoOpen': {
      // 启动期只检查一次;用户取消过 setup 弹窗则不再自动重开(不重复弹窗)
      if (state.autoOpenChecked || state.setupDismissed) {
        return { ...state, autoOpenChecked: true };
      }
      if (!action.wantsInitialize) {
        return { ...state, autoOpenChecked: true };
      }
      return {
        ...state,
        autoOpenChecked: true,
        step: 'initialize',
        entry: 'auto-uninitialized',
        intentId: state.intentId + 1,
        generation: state.generation + 1,
        formEpoch: state.formEpoch + 1,
      };
    }
    case 'targetProfile':
      return { ...state, targetProfileId: action.profileId };
    case 'playStart': {
      // 仅接受「更新的意图」或「暂存续跑的同一意图」:旧/重复回调不得覆盖最新意图(FR-013)
      const deferredSelf = state.pendingPlay !== null && state.pendingPlay.intentId === action.intentId;
      if (action.intentId <= state.playbackIntentSeq && !deferredSelf) {
        return state;
      }
      return {
        ...state,
        playbackIntentSeq: action.intentId,
        playback: {
          intentId: action.intentId,
          target: action.target,
          phase: 'authorizing',
          sessionId: null,
          playbackGeneration: null,
          playbackUrl: null,
          ticketExpiresAt: null,
          delivery: null,
          presentationStartSeconds: null,
          message: null,
          lines: [],
          selectedLineId: null,
        },
        pendingPlay: null,
      };
    }
    case 'playPatch': {
      // 意图守卫在 reducer 内收口:非当前意图的迟到结果结构上无法改写新意图
      if (state.playback === null || state.playback.intentId !== action.intentId) {
        return state;
      }
      return { ...state, playback: { ...state.playback, ...action.patch } };
    }
    case 'playRetarget': {
      // 与 playPatch 同一意图守卫:旧回调/旧意图不得改写当前在播目标
      if (state.playback === null || state.playback.intentId !== action.intentId) {
        return state;
      }
      // 只换 target:phase 与会话面由同批次 playPatch 写入,期间保持 playing
      return { ...state, playback: { ...state.playback, target: action.target } };
    }
    case 'playEnd': {
      if (state.playback === null || state.playback.intentId !== action.intentId) {
        return state;
      }
      return { ...state, playback: null };
    }
    case 'playDefer': {
      if (action.intentId <= state.playbackIntentSeq) {
        return state;
      }
      return {
        ...state,
        playbackIntentSeq: action.intentId,
        pendingPlay: { intentId: action.intentId, target: action.target },
      };
    }
    default:
      return state;
  }
}

/** 旧回调守卫:捕获代次 ≠ 当前代次即失效(FR-013 同源语义:仅最新意图可继续) */
export function isStaleIntent(state: CoordinatorState, capturedGeneration: number): boolean {
  return capturedGeneration !== state.generation;
}

// ---------------------------------------------------------------------------
// 播放面线路容灾顺位(016 T020;research.md R4 / data-model.md §3.1)
// ---------------------------------------------------------------------------

/**
 * 容灾顺位选择(016 T020 纯函数;编排层防死循环的单一事实源):
 *
 * - 候选 = `isEnabled !== false` 的线路,按 `priority` ASC 稳定排序(数值越小越优先,
 *   api.md §2.1 契约排序;同权重保持输入序);
 * - 跳过 `attemptedIds`(跨容灾意图累积的已尝试线路,由编排层 ref 维护)与
 *   `selectedLineId`(当前刚失败的线路);
 * - 返回第一条未尝试线路;全部试尽(或无多线路语义)返回 `null`,上层落回既有
 *   缺省错误通道(unavailable / 60s recover 窗口),绝不无限循环。
 */
export function selectNextLine(
  lines: readonly StreamLineDto[],
  selectedLineId: string | null,
  attemptedIds: ReadonlySet<string>,
): StreamLineDto | null {
  const excluded = new Set(attemptedIds);
  if (selectedLineId !== null) {
    excluded.add(selectedLineId);
  }
  const ordered = lines
    .map((candidate, index) => ({ candidate, index }))
    .filter((entry) => entry.candidate.isEnabled !== false)
    .sort((a, b) => a.candidate.priority - b.candidate.priority || a.index - b.index);
  for (const entry of ordered) {
    if (!excluded.has(entry.candidate.lineId)) {
      return entry.candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 返回目标白名单(FR-010)
// ---------------------------------------------------------------------------

/** 本应用内部路径白名单(与 ui.md §1 公共地址一致) */
const INTERNAL_PATH_PREFIXES = ['/', '/vod', '/media/', '/live', '/settings'] as const;

/**
 * 白名单校验:仅接受本应用内部路径;外部 URL、协议相对地址、非白名单路径
 * 一律回落首页 —— 不形成开放重定向。
 */
export function sanitizeReturnTarget(target: string | null | undefined): string {
  if (typeof target !== 'string' || target === '') {
    return '/';
  }
  if (!target.startsWith('/') || target.startsWith('//')) {
    return '/';
  }
  const path = target.split(/[?#]/)[0] ?? '/';
  const allowed = INTERNAL_PATH_PREFIXES.some((prefix) =>
    prefix === '/' ? path === '/' : path.startsWith(prefix),
  );
  return allowed ? target : '/';
}

// ---------------------------------------------------------------------------
// 表单校验(FR-030:首建名称 + 6 位数字 PIN;PIN/密码仅表单内存)
// ---------------------------------------------------------------------------

export interface FieldIssue {
  field: 'name' | 'pin' | 'ownerPassword';
  message: string;
}

/** 首建表单校验:档案名称 1~50 字符、PIN 恰 6 位数字、当次密码非空 */
export function validateBootstrapInput(input: {
  name: string;
  pin: string;
  ownerPassword: string;
}): FieldIssue | null {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 50) {
    return { field: 'name', message: '请输入 1~50 个字符的档案名称' };
  }
  if (!/^\d{6}$/.test(input.pin)) {
    return { field: 'pin', message: 'PIN 必须为 6 位数字' };
  }
  if (input.ownerPassword.length < 1) {
    return { field: 'ownerPassword', message: '请输入当前账号密码' };
  }
  return null;
}

/** 选档/恢复 PIN 输入校验:6 位数字 */
export function validatePinInput(pin: string): FieldIssue | null {
  if (!/^\d{6}$/.test(pin)) {
    return { field: 'pin', message: 'PIN 必须为 6 位数字' };
  }
  return null;
}
