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
}

export type CoordinatorAction =
  | { type: 'start'; step: Exclude<AuthStep, 'idle'>; returnTo?: string | null; entry: string }
  /** 同一意图内分步推进(initialize→login、bootstrap→picker、picker→selectionPin 等) */
  | { type: 'goto'; step: Exclude<AuthStep, 'idle'> }
  | { type: 'cancel' }
  | { type: 'complete' }
  | { type: 'autoOpen'; wantsInitialize: boolean }
  | { type: 'targetProfile'; profileId: string | null };

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
      // 清意图与凭据、回 idle(原页面即当前页面,无导航);自动弹窗机会视为已消费
      return {
        ...state,
        step: 'idle',
        generation: state.generation + 1,
        formEpoch: state.formEpoch + 1,
        autoOpenChecked: true,
        targetProfileId: null,
      };
    case 'complete':
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
    default:
      return state;
  }
}

/** 旧回调守卫:捕获代次 ≠ 当前代次即失效(FR-013 同源语义:仅最新意图可继续) */
export function isStaleIntent(state: CoordinatorState, capturedGeneration: number): boolean {
  return capturedGeneration !== state.generation;
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
