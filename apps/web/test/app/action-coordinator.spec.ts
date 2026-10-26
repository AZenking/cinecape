import { describe, expect, it } from 'vitest';
import {
  createInitialCoordinatorState,
  coordinatorReducer,
  isStaleIntent,
  sanitizeReturnTarget,
  validateBootstrapInput,
  validatePinInput,
  type CoordinatorState,
} from '../../src/app/action-coordinator-core';

/**
 * T034(005 US2 前端单元测试,先 FAIL):ActionCoordinator 意图状态机(纯逻辑层)。
 * 权威:docs/specs/005-pc-browsing-flow/contracts/ui.md §3(意图状态机图,逐字对照)
 * + spec FR-010(取消返回原页面、拒绝开放重定向)+ FR-030(首建校验名称与 6 位数字 PIN):
 * - uninitialized → initialize → login;noProfile+bootstrapRequired → bootstrap →
 *   picker → selectionPin;
 * - 每动作保存 intentId/原目标/入口;新动作递增代次,旧回调不可重开弹层或触发播放;
 * - 取消清 intentId 与表单凭据、返回原页面、不自动重开;
 * - 返回目标仅接受本应用白名单内部路径,外部/非白名单目标被拒绝(不开放重定向)。
 */

function stateWith(step: Exclude<CoordinatorState['step'], 'idle'>): CoordinatorState {
  let state = createInitialCoordinatorState();
  state = coordinatorReducer(state, { type: 'start', step, returnTo: '/vod?q=x', entry: 'header-login' });
  // start 已把 step 置为目标步;此处强制覆盖以构造任意中间态
  return { ...state, step };
}

describe('T034 · 意图状态机(ui.md §3 逐字对照)', () => {
  it('uninitialized → initialize → login:setup 未初始化时登录入口先走 initialize,201 后显式进入 login(不自动登录)', () => {
    let state = createInitialCoordinatorState();
    expect(state.step).toBe('idle');

    state = coordinatorReducer(state, { type: 'start', step: 'initialize', returnTo: '/vod', entry: 'auto-uninitialized' });
    expect(state.step).toBe('initialize');
    expect(state.intentId).toBe(1);
    expect(state.generation).toBe(1);
    expect(state.entry).toBe('auto-uninitialized');

    // 初始化成功 → 显式登录(同代次内步骤切换,不新建意图)
    state = coordinatorReducer(state, { type: 'goto', step: 'login' });
    expect(state.step).toBe('login');
    expect(state.intentId).toBe(1);
    expect(state.generation).toBe(1);
  });

  it('noProfile+bootstrapRequired → bootstrap → picker → selectionPin:单 Modal 分步切换', () => {
    let state = stateWith('bootstrap');
    expect(state.step).toBe('bootstrap');

    state = coordinatorReducer(state, { type: 'goto', step: 'picker' });
    expect(state.step).toBe('picker');

    state = coordinatorReducer(state, { type: 'goto', step: 'selectionPin' });
    expect(state.step).toBe('selectionPin');

    // 同一意图内步骤推进不递增 intentId/generation
    expect(state.intentId).toBe(1);
    expect(state.generation).toBe(1);
  });

  it('新动作递增代次与 intentId,并重置表单凭据代次;返回目标被重新白名单校验', () => {
    let state = stateWith('picker');
    expect(state.formEpoch).toBe(1);

    state = coordinatorReducer(state, { type: 'start', step: 'login', returnTo: '/live', entry: 'header-login' });
    expect(state.intentId).toBe(2);
    expect(state.generation).toBe(2);
    expect(state.formEpoch).toBe(2); // 表单凭据随新动作清空(换 key 重挂载)
    expect(state.returnTo).toBe('/live');
  });

  it('取消:清意图与表单凭据回到 idle(用户本就停留在原页面,无需导航),不自动重开', () => {
    let state = stateWith('login');
    state = coordinatorReducer(state, { type: 'cancel' });
    expect(state.step).toBe('idle');
    expect(state.formEpoch).toBe(2); // 凭据清空信号递增
    // 旧意图的 intentId 不再增长使用;后续任何旧回调凭 generation 失效
    expect(state.generation).toBe(2);

    // 取消后 setup 弹窗不自动重开(不重复弹窗)
    state = coordinatorReducer(state, { type: 'autoOpen', wantsInitialize: true });
    expect(state.step).toBe('idle');
  });

  it('未初始化弹窗:启动检查一次;用户取消后 setupDismissed 阻止自动重开', () => {
    let state = createInitialCoordinatorState();
    state = coordinatorReducer(state, { type: 'autoOpen', wantsInitialize: true });
    expect(state.step).toBe('initialize');
    expect(state.autoOpenChecked).toBe(true);

    state = coordinatorReducer(state, { type: 'cancel' });
    expect(state.step).toBe('idle');

    // 再触发启动检查(如路由切换):不重复弹窗
    state = coordinatorReducer(state, { type: 'autoOpen', wantsInitialize: true });
    expect(state.step).toBe('idle');
  });

  it('旧回调代次守卫:isStaleIntent 对旧 generation 返回 true(不可重开弹层/触发后续动作)', () => {
    let state = stateWith('login');
    const capturedGeneration = state.generation; // 提交时捕获

    // 用户取消后再发起新动作 → 代次前进
    state = coordinatorReducer(state, { type: 'cancel' });
    state = coordinatorReducer(state, { type: 'start', step: 'login', returnTo: '/', entry: 'header-login' });

    expect(isStaleIntent(state, capturedGeneration)).toBe(true);
    expect(isStaleIntent(state, state.generation)).toBe(false);
  });
});

describe('T034 · 返回目标白名单(FR-010 拒绝开放重定向)', () => {
  it('仅接受本应用白名单内部路径', () => {
    expect(sanitizeReturnTarget('/vod?type=movie&page=2')).toBe('/vod?type=movie&page=2');
    expect(sanitizeReturnTarget('/media/abc')).toBe('/media/abc');
    expect(sanitizeReturnTarget('/live/guide')).toBe('/live/guide');
    expect(sanitizeReturnTarget('/')).toBe('/');
    expect(sanitizeReturnTarget('/')).toBe('/');
  });

  it('外部/协议相对/非白名单目标一律拒绝并回落首页', () => {
    expect(sanitizeReturnTarget('https://evil.example/callback')).toBe('/');
    expect(sanitizeReturnTarget('//evil.example')).toBe('/');
    expect(sanitizeReturnTarget('javascript:alert(1)')).toBe('/');
    expect(sanitizeReturnTarget('/admin/backdoor')).toBe('/');
    expect(sanitizeReturnTarget('')).toBe('/');
    expect(sanitizeReturnTarget(null)).toBe('/');
    expect(sanitizeReturnTarget(undefined)).toBe('/');
  });
});

describe('T034 · 首建表单校验(FR-030:名称 + 6 位数字 PIN)', () => {
  it('合法输入通过', () => {
    expect(validateBootstrapInput({ name: '妈妈', pin: '123456', ownerPassword: 'password-123' })).toBeNull();
  });

  it('名称与 PIN 逐字段拒绝', () => {
    expect(validateBootstrapInput({ name: '', pin: '123456', ownerPassword: 'password-123' })).toMatchObject({ field: 'name' });
    expect(validateBootstrapInput({ name: 'x'.repeat(51), pin: '123456', ownerPassword: 'password-123' })).toMatchObject({ field: 'name' });
    expect(validateBootstrapInput({ name: '妈妈', pin: '12345', ownerPassword: 'password-123' })).toMatchObject({ field: 'pin' });
    expect(validateBootstrapInput({ name: '妈妈', pin: '12345a', ownerPassword: 'password-123' })).toMatchObject({ field: 'pin' });
    expect(validateBootstrapInput({ name: '妈妈', pin: '', ownerPassword: 'password-123' })).toMatchObject({ field: 'pin' });
    expect(validateBootstrapInput({ name: '妈妈', pin: '123456', ownerPassword: '' })).toMatchObject({ field: 'ownerPassword' });
  });

  it('选档 PIN 输入校验:6 位数字才放行提交', () => {
    expect(validatePinInput('654321')).toBeNull();
    expect(validatePinInput('12345')).toMatchObject({ field: 'pin' });
    expect(validatePinInput('abcd')).toMatchObject({ field: 'pin' });
  });
});
