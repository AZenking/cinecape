import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  coordinatorReducer,
  createInitialCoordinatorState,
  isStaleIntent,
  sanitizeReturnTarget,
  type CoordinatorState,
  type PlayTarget,
} from '../src/app/action-coordinator-core';
import { ActionCoordinator, usePlayAction } from '../src/app/action-coordinator';
import { SettingsAccessProvider } from '../src/features/settings/settings-access-provider';
import { liveChannelRows } from './helpers/live-data';
import { LIVE_SESSION_STATES, LiveSessionProbe, renderLiveWorld } from './helpers/live-world';
import { installNetworkCounter } from './helpers/network-assertions';

/**
 * 012 T007 · 直播播放意图在统一协调器中的生命周期契约(核对型测试)。
 *
 * 权威:docs/specs/012-live-settings-experience/data-model.md §1(播放意图生命周期表,
 * 逐行断言)+ tasks.md T007。机制载体 = app/action-coordinator-core.ts(005 T043/T053
 * 已交付,本规格零新增字段,仅核对直播入口的填充与消费):
 * - 意图填充:游客/未选档点击播放(playDefer)→ 暂存 intentId/target,登录/选档意图
 *   (start)携带 returnTo/entry;选档完成前意图保留、playback 恒为 null(零 authorize);
 *   登录+选档完成后消费(complete 保留暂存 → 同一 intentId playStart 续跑);
 * - 代次守卫:仅最新 intentId 可 authorize→prepare;旧回调(旧 intentId 的 patch/end、
 *   旧 generation)被拒 —— reducer 返回同一引用,结构上不能起播旧内容(FR-013);
 * - returnTo 白名单:外部 URL / javascript: / 协议相对一律回落首页(FR-010);
 * - 取消废弃:cancel 清空暂存意图(不自动播放);废弃意图结构上不可复活(序号守卫);
 * - 无凭据/零持久化:全状态逐键扫描无 password/token/credential/PIN 类字段;整个流程
 *   对 localStorage/sessionStorage 零写入(Q2);
 * - 身份失效清除:登出/换档路径(playEnd/cancel)后旧意图不可再推进。
 *
 * 写法:优先直接 import action-coordinator-core 纯函数做 reducer 级测试(快且稳);
 * 消费面仅一条 renderLiveWorld 锚定 —— 游客经 usePlayAction 播放直播频道进入登录弹层,
 * 授权前零 /playback/ 与 /me/ 请求(Network 断言工具,T004 夹具)。
 * 动作序列与消费面同形:playDefer/playStart 由 play() 以 playbackIntentSeq+1 发号,
 * 游客路径经 startLogin 进登录意图(entry=header-login),未选档路径进选档意图(entry=play)。
 */

// ---------------------------------------------------------------------------
// 夹具与助手
// ---------------------------------------------------------------------------

/** 直播频道播放目标(T004 live-data 桩:例牌新闻台;直播恒 beginning,无续播语义) */
function liveChannelTarget(): PlayTarget {
  const row = liveChannelRows()[0];
  if (row === undefined) {
    throw new Error('live-data 夹具异常:频道行缺失');
  }
  return { mediaId: row.media.id, title: row.media.title, startMode: 'beginning' };
}

/**
 * 游客点击直播频道的意图填充态(与 action-coordinator play() 游客分支同形):
 * playDefer 暂存播放意图 → startLogin 发起登录意图(returnTo=/live,entry=header-login)
 * → 登录成功进选档(goto picker,同意图分步)。
 */
function deferredGuestState(): CoordinatorState {
  const target = liveChannelTarget();
  let state = createInitialCoordinatorState();
  state = coordinatorReducer(state, { type: 'playDefer', intentId: state.playbackIntentSeq + 1, target });
  state = coordinatorReducer(state, { type: 'start', step: 'login', returnTo: '/live', entry: 'header-login' });
  state = coordinatorReducer(state, { type: 'goto', step: 'picker' });
  return state;
}

/** 完整生命周期态:游客暂存 → 登录/选档完成 → 同一 intentId 续跑 authorize→prepare→playing */
function fullLifecycleState(): CoordinatorState {
  const target = liveChannelTarget();
  let state = deferredGuestState();
  state = coordinatorReducer(state, { type: 'complete' });
  state = coordinatorReducer(state, { type: 'playStart', intentId: 1, target });
  state = coordinatorReducer(state, {
    type: 'playPatch',
    intentId: 1,
    patch: { phase: 'preparing', sessionId: 'ps-live-1', playbackGeneration: 1 },
  });
  state = coordinatorReducer(state, {
    type: 'playPatch',
    intentId: 1,
    patch: {
      phase: 'playing',
      delivery: 'hls_proxy',
      playbackUrl: '/api/playback/stream/ps-live-1/1/index.m3u8?ticket=t',
      ticketExpiresAt: '2026-11-01T13:00:00.000Z',
    },
  });
  return state;
}

/** 凭据类字段名模式(password/token/credential/PIN/secret;凭据只存在于表单内存,不进状态机) */
const CREDENTIAL_KEY_PATTERN = /password|passwd|pwd|token|credential|secret|pin/i;

/** 递归收集状态对象全部键路径(含 playback/pendingPlay 嵌套) */
function collectStateKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectStateKeys(item, `${prefix}[${index}]`));
  }
  return Object.entries(value).flatMap(([key, child]) => [
    prefix === '' ? key : `${prefix}.${key}`,
    ...collectStateKeys(child, prefix === '' ? key : `${prefix}.${key}`),
  ]);
}

// ---------------------------------------------------------------------------
// 消费面探针(renderLiveWorld):播放入口按钮 + 播放意图只读面
// ---------------------------------------------------------------------------

function LivePlayProbe(): ReactNode {
  const { play, playback } = usePlayAction();
  const target = liveChannelTarget();
  return (
    <div>
      <LiveSessionProbe />
      <span data-testid="phase">{playback?.phase ?? '-'}</span>
      <span data-testid="target">{playback?.target.mediaId ?? '-'}</span>
      <button
        type="button"
        data-testid="play-live"
        onClick={() => play({ mediaId: target.mediaId, title: target.title })}
      >
        播放例牌新闻台
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1 · 意图填充(data-model §1 intentId/target/returnTo/entry 行 + 生命周期「创建」)
// ---------------------------------------------------------------------------

describe('T007 · 意图填充:游客播放暂存意图并进入登录/选档分支', () => {
  it('游客点击直播频道:playDefer 暂存 intentId/target;登录/选档意图携带 returnTo 与 entry;选档完成前意图保留且零 authorize(playback 恒 null)', () => {
    const target = liveChannelTarget();
    let state = createInitialCoordinatorState();

    // 游客播放:playDefer 暂存(弹层前零 authorize;playbackIntentSeq 单调发号)
    state = coordinatorReducer(state, { type: 'playDefer', intentId: 1, target });
    expect(state.pendingPlay).toEqual({ intentId: 1, target });
    expect(state.playback).toBeNull();
    expect(state.playbackIntentSeq).toBe(1);

    // 消费面同形:进入登录意图,原目标与入口随意图保存(returnTo 已过白名单)
    state = coordinatorReducer(state, { type: 'start', step: 'login', returnTo: '/live', entry: 'header-login' });
    expect(state.step).toBe('login');
    expect(state.returnTo).toBe('/live');
    expect(state.entry).toBe('header-login');
    expect(state.intentId).toBe(1); // 动作序号与播放序号各自单调

    // 登录成功 → 选档:goto 同意图分步(不递增意图/代次),暂存意图保留
    const generationAtLogin = state.generation;
    state = coordinatorReducer(state, { type: 'goto', step: 'picker' });
    expect(state.step).toBe('picker');
    expect(state.generation).toBe(generationAtLogin);
    expect(state.pendingPlay).toEqual({ intentId: 1, target });

    // PIN 档:targetProfile + selectionPin 分步期间同样保留;播放面始终为空(零 authorize)
    state = coordinatorReducer(state, { type: 'targetProfile', profileId: 'profile-a' });
    state = coordinatorReducer(state, { type: 'goto', step: 'selectionPin' });
    expect(state.step).toBe('selectionPin');
    expect(state.pendingPlay).toEqual({ intentId: 1, target });
    expect(state.playback).toBeNull();
  });

  it('已登录未选档点击播放:进入选档分支(entry=play);complete 完成选档后暂存意图保留(待续跑)', () => {
    const target = liveChannelTarget();
    let state = createInitialCoordinatorState();
    state = coordinatorReducer(state, { type: 'playDefer', intentId: 1, target });
    state = coordinatorReducer(state, {
      type: 'start',
      step: 'picker',
      returnTo: '/live/guide?date=2026-11-01',
      entry: 'play',
    });
    expect(state.step).toBe('picker');
    expect(state.entry).toBe('play');
    expect(state.returnTo).toBe('/live/guide?date=2026-11-01');

    // 选档成功事务(complete):回到 idle、暂存意图保留 —— 协调器随后续跑原目标
    state = coordinatorReducer(state, { type: 'complete' });
    expect(state.step).toBe('idle');
    expect(state.pendingPlay).toEqual({ intentId: 1, target });
  });

  it('选档完成后续跑:complete 保留暂存 → 同一 intentId playStart 进入 authorize 起点 → prepare → playing;pendingPlay 清空(已消费)', () => {
    const target = liveChannelTarget();
    let state = deferredGuestState();
    state = coordinatorReducer(state, { type: 'complete' });
    const generationAfterComplete = state.generation;
    expect(isStaleIntent(state, generationAfterComplete)).toBe(false); // 续跑链捕获的最新代次

    // 续跑守卫(pendingPlay.intentId === intentId)放行:暂存意图以原号进入 authorize
    state = coordinatorReducer(state, { type: 'playStart', intentId: 1, target });
    expect(state.playback?.intentId).toBe(1);
    expect(state.playback?.phase).toBe('authorizing');
    expect(state.playback?.target).toEqual(target);
    expect(state.pendingPlay).toBeNull();

    // authorize → prepare → playing(patch 字段与消费面 runPlayback 同形)
    state = coordinatorReducer(state, {
      type: 'playPatch',
      intentId: 1,
      patch: { phase: 'preparing', sessionId: 'ps-live-1', playbackGeneration: 1 },
    });
    expect(state.playback?.phase).toBe('preparing');
    expect(state.playback?.sessionId).toBe('ps-live-1');
    state = coordinatorReducer(state, {
      type: 'playPatch',
      intentId: 1,
      patch: {
        phase: 'playing',
        delivery: 'hls_proxy',
        playbackUrl: '/api/playback/stream/ps-live-1/1/index.m3u8?ticket=t',
        ticketExpiresAt: '2026-11-01T13:00:00.000Z',
      },
    });
    expect(state.playback?.phase).toBe('playing');
    expect(state.playback?.playbackUrl).toContain('/api/playback/stream/');
    // 完成回调之后的同代次内,续跑链不被误判过期
    expect(isStaleIntent(state, generationAfterComplete)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2 · 代次守卫(data-model §1 intentId 行:仅最新 intentId 可 authorize→prepare)
// ---------------------------------------------------------------------------

describe('T007 · 代次守卫:仅最新意图可推进,旧回调结构上不能起播', () => {
  it('并发两次 play:新意图覆盖旧意图;旧 intentId 的准备结果与关闭请求被拒(reducer 返回同一引用)', () => {
    const targetA: PlayTarget = { mediaId: 'live-a', title: '频道A', startMode: 'beginning' };
    const targetB: PlayTarget = { mediaId: 'live-b', title: '频道B', startMode: 'beginning' };
    let state = createInitialCoordinatorState();
    state = coordinatorReducer(state, { type: 'playStart', intentId: 1, target: targetA });
    expect(state.playback?.intentId).toBe(1);

    // 准备中换目标:新 play(playStart 2 > 1)即时取代旧意图
    state = coordinatorReducer(state, { type: 'playStart', intentId: 2, target: targetB });
    expect(state.playback?.intentId).toBe(2);
    expect(state.playback?.target.mediaId).toBe('live-b');
    expect(state.playbackIntentSeq).toBe(2);
    const afterSwitch = state;

    // 旧意图(1)迟到的准备结果:整体忽略 —— 引用不变,结构上不能改写新意图
    state = coordinatorReducer(state, {
      type: 'playPatch',
      intentId: 1,
      patch: {
        phase: 'playing',
        sessionId: 'ps-old',
        playbackUrl: '/api/playback/stream/ps-old/index.m3u8',
      },
    });
    expect(state).toBe(afterSwitch);
    // 旧意图的关闭请求同样被拒(不得误关新播放面)
    state = coordinatorReducer(state, { type: 'playEnd', intentId: 1 });
    expect(state).toBe(afterSwitch);

    // 仅最新 intentId 可推进 authorize→prepare→playing,播放面只属于新目标
    state = coordinatorReducer(state, {
      type: 'playPatch',
      intentId: 2,
      patch: { phase: 'preparing', sessionId: 'ps-b', playbackGeneration: 3 },
    });
    state = coordinatorReducer(state, {
      type: 'playPatch',
      intentId: 2,
      patch: {
        phase: 'playing',
        delivery: 'hls_proxy',
        playbackUrl: '/api/playback/stream/ps-b/3/index.m3u8?ticket=t',
        ticketExpiresAt: '2026-11-01T13:00:00.000Z',
      },
    });
    expect(state.playback?.target.mediaId).toBe('live-b');
    expect(state.playback?.playbackUrl).toContain('ps-b');
  });

  it('弹层代次:取消/新动作递增 generation 后旧回调 isStaleIntent=true;同代次内不误伤', () => {
    let state = deferredGuestState();
    const captured = state.generation; // runPlayback/performSelect 在提交时捕获

    // 期间用户取消并再发起新动作:代次前进,旧回调失效
    state = coordinatorReducer(state, { type: 'cancel' });
    state = coordinatorReducer(state, { type: 'start', step: 'login', returnTo: '/live', entry: 'header-login' });
    expect(isStaleIntent(state, captured)).toBe(true);
    expect(isStaleIntent(state, state.generation)).toBe(false);

    // 结构面:cancel 后暂存槽已清、播放面为空,旧 intentId 的补写也被拒
    const afterRestart = state;
    state = coordinatorReducer(state, { type: 'playPatch', intentId: 1, patch: { phase: 'preparing' } });
    expect(state).toBe(afterRestart);
  });
});

// ---------------------------------------------------------------------------
// 3 · returnTo 白名单(data-model §1 returnTo 行;FR-010 拒绝开放重定向)
// ---------------------------------------------------------------------------

describe('T007 · returnTo 白名单:应用内路径放行,外部目标回落首页', () => {
  it('应用内路径放行:直播 /live、/live/guide(含查询参数)与 /、/vod、/media/、/settings', () => {
    expect(sanitizeReturnTarget('/live')).toBe('/live');
    expect(sanitizeReturnTarget('/live/guide')).toBe('/live/guide');
    expect(sanitizeReturnTarget('/live/guide?date=2026-11-01&channelPage=2')).toBe('/live/guide?date=2026-11-01&channelPage=2');
    expect(sanitizeReturnTarget('/')).toBe('/');
    expect(sanitizeReturnTarget('/vod?type=movie&page=2')).toBe('/vod?type=movie&page=2');
    expect(sanitizeReturnTarget('/media/abc')).toBe('/media/abc');
    expect(sanitizeReturnTarget('/settings/account')).toBe('/settings/account');
  });

  it('外部 URL / javascript: / 协议相对 / 非白名单路径一律拒绝回落首页;start 落库的 returnTo 同经白名单', () => {
    expect(sanitizeReturnTarget('http://evil.example/callback')).toBe('/');
    expect(sanitizeReturnTarget('https://evil.example')).toBe('/');
    expect(sanitizeReturnTarget('javascript:alert(1)')).toBe('/');
    expect(sanitizeReturnTarget('//evil.example/live')).toBe('/');
    expect(sanitizeReturnTarget('/admin/backdoor')).toBe('/');
    expect(sanitizeReturnTarget('')).toBe('/');
    expect(sanitizeReturnTarget(null)).toBe('/');
    expect(sanitizeReturnTarget(undefined)).toBe('/');

    // 意图填充路径同样受白名单:恶意 returnTo 经 start 落库为首页,complete 后仍不外跳
    const target = liveChannelTarget();
    let state = createInitialCoordinatorState();
    state = coordinatorReducer(state, { type: 'playDefer', intentId: 1, target });
    state = coordinatorReducer(state, {
      type: 'start',
      step: 'login',
      returnTo: 'http://evil.example/callback',
      entry: 'header-login',
    });
    expect(state.returnTo).toBe('/');
    state = coordinatorReducer(state, { type: 'complete' });
    expect(state.returnTo).toBe('/');
  });
});

// ---------------------------------------------------------------------------
// 4 · 取消废弃(data-model §1 生命周期:取消登录/选档即废弃,不自动播放)
// ---------------------------------------------------------------------------

describe('T007 · 取消废弃:登录/选档取消即废弃暂存意图,不自动播放', () => {
  it('cancel 清空暂存意图且全程无 authorize;废弃意图结构上不可复活,新播放换新序号', () => {
    let state = deferredGuestState();
    const captured = state.generation;
    expect(state.pendingPlay).not.toBeNull();

    // 取消登录:暂存播放意图一并废弃(零 authorize),旧回调代次失效
    state = coordinatorReducer(state, { type: 'cancel' });
    expect(state.step).toBe('idle');
    expect(state.pendingPlay).toBeNull();
    expect(state.playback).toBeNull();
    expect(isStaleIntent(state, captured)).toBe(true);

    // 结构上不可复活:pendingPlay 已清,deferredSelf 不成立,旧号 playStart 被序号守卫拒绝
    const afterCancel = state;
    state = coordinatorReducer(state, { type: 'playStart', intentId: 1, target: liveChannelTarget() });
    expect(state).toBe(afterCancel);

    // 序号单调:废弃意图号不复用;重新点击播放 → 新序号 2 才被接受
    state = coordinatorReducer(state, { type: 'playDefer', intentId: 2, target: liveChannelTarget() });
    expect(state.pendingPlay?.intentId).toBe(2);
    expect(state.playbackIntentSeq).toBe(2);

    // 迟到的完成回调不复活旧意图:complete 不清新暂存,旧号仍被拒
    state = coordinatorReducer(state, { type: 'complete' });
    expect(state.pendingPlay?.intentId).toBe(2);
    const beforeOldResume = state;
    state = coordinatorReducer(state, { type: 'playStart', intentId: 1, target: liveChannelTarget() });
    expect(state).toBe(beforeOldResume);
    expect(state.playback).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5 · 无凭据/零持久化(data-model §1 target 行「不含凭据/令牌」+ 生命周期「绝不写入
//     localStorage/sessionStorage」,Q2)
// ---------------------------------------------------------------------------

describe('T007 · 无凭据字段与零浏览器存储写入', () => {
  it('协调器全状态逐键扫描:初始态与完整生命周期态均不含 password/token/credential/PIN 类字段', () => {
    const initial = createInitialCoordinatorState();
    const full = fullLifecycleState();
    for (const state of [initial, full]) {
      const credentialKeys = collectStateKeys(state).filter((key) => CREDENTIAL_KEY_PATTERN.test(key));
      expect(credentialKeys).toEqual([]);
    }

    // 播放目标保持最小面:仅 mediaId/title/startMode,不含凭据或外部 URL 目标
    expect(Object.keys(liveChannelTarget()).sort()).toEqual(['mediaId', 'startMode', 'title'].sort());
    // 播放面字段集固定(known set;ticketExpiresAt 为到期时刻,非凭据值)
    const playback = full.playback;
    expect(playback).not.toBeNull();
    expect(Object.keys(playback ?? {}).sort()).toEqual(
      [
        'intentId',
        'target',
        'phase',
        'sessionId',
        'playbackGeneration',
        'playbackUrl',
        'ticketExpiresAt',
        'delivery',
        'presentationStartSeconds',
        'message',
      ].sort(),
    );
  });

  it('整个游客→选档→续跑→废弃流程对 localStorage/sessionStorage 零写入(Storage.prototype spy 全程未触发)', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem');
    try {
      const target = liveChannelTarget();
      let state = deferredGuestState();
      state = coordinatorReducer(state, { type: 'complete' });
      state = coordinatorReducer(state, { type: 'playStart', intentId: 1, target });
      state = coordinatorReducer(state, {
        type: 'playPatch',
        intentId: 1,
        patch: { phase: 'preparing', sessionId: 'ps-live-1', playbackGeneration: 1 },
      });
      state = coordinatorReducer(state, {
        type: 'playPatch',
        intentId: 1,
        patch: {
          phase: 'playing',
          delivery: 'hls_proxy',
          playbackUrl: '/api/playback/stream/ps-live-1/1/index.m3u8?ticket=t',
          ticketExpiresAt: '2026-11-01T13:00:00.000Z',
        },
      });
      state = coordinatorReducer(state, { type: 'playEnd', intentId: 1 });
      state = coordinatorReducer(state, { type: 'cancel' });

      // 含受控网关入口 URL(playbackUrl)在内,全程零持久化写入
      expect(state.playback).toBeNull();
      expect(setItemSpy).not.toHaveBeenCalled();
      expect(removeItemSpy).not.toHaveBeenCalled();

      // 探针:证明 spy 确已在位(Storage.prototype 同时覆盖 localStorage 与 sessionStorage)
      window.localStorage.setItem('t007-spy-probe', '1');
      expect(setItemSpy).toHaveBeenCalledTimes(1);
      expect(window.sessionStorage.getItem('t007-spy-probe')).toBeNull();
    } finally {
      vi.restoreAllMocks();
      window.localStorage.clear();
    }
  });
});

// ---------------------------------------------------------------------------
// 6 · 身份失效清除(data-model §1 生命周期「身份失效即清除」+ §6 换档/退出行)
// ---------------------------------------------------------------------------

describe('T007 · 身份失效清除:登出/换档后旧意图不可再推进', () => {
  it('播放面意图随身份失效终止:playEnd 清除后,旧 intentId 的补写与重复终止均被拒;新身份播放换新号', () => {
    let state = fullLifecycleState(); // playing 意图 1(例牌新闻台)
    expect(state.playback?.phase).toBe('playing');

    // 登出/换档路径:terminatePlaybackIntent 唯一收口 = playEnd 废弃在途播放意图
    state = coordinatorReducer(state, { type: 'playEnd', intentId: 1 });
    expect(state.playback).toBeNull();

    // 终止后旧意图不可复活:僵尸 URL 补写与重复 playEnd 均被拒(引用不变)
    const afterRevoke = state;
    state = coordinatorReducer(state, {
      type: 'playPatch',
      intentId: 1,
      patch: { phase: 'playing', playbackUrl: '/api/playback/stream/zombie/index.m3u8' },
    });
    expect(state).toBe(afterRevoke);
    state = coordinatorReducer(state, { type: 'playEnd', intentId: 1 });
    expect(state).toBe(afterRevoke);

    // 新身份下的播放是新意图:换新序号才被接受,播放面绑定新目标
    const nextTarget: PlayTarget = { mediaId: 'live-b', title: '频道B', startMode: 'beginning' };
    state = coordinatorReducer(state, { type: 'playStart', intentId: 2, target: nextTarget });
    expect(state.playback?.intentId).toBe(2);
    expect(state.playback?.target.mediaId).toBe('live-b');
  });

  it('暂存意图在登出后不可再推进:取消废弃 → 迟到选档回调代次失效;重新登录完成也不复活旧号', () => {
    let state = deferredGuestState(); // 游客暂存 1 → 登录 → 选档
    const captured = state.generation;

    // 选档步骤中登出/会话撤销:弹层取消收口,暂存意图废弃
    state = coordinatorReducer(state, { type: 'cancel' });
    expect(state.pendingPlay).toBeNull();
    expect(isStaleIntent(state, captured)).toBe(true); // 迟到 performSelect 不可回填身份

    const afterLogout = state;
    state = coordinatorReducer(state, { type: 'playStart', intentId: 1, target: liveChannelTarget() });
    expect(state).toBe(afterLogout);

    // 即便重新登录完成(complete),旧暂存意图仍不可复活 —— 需重新点击播放(新序号)
    state = coordinatorReducer(state, { type: 'start', step: 'login', returnTo: '/live', entry: 'header-login' });
    state = coordinatorReducer(state, { type: 'complete' });
    expect(state.pendingPlay).toBeNull();
    const stillDead = state;
    state = coordinatorReducer(state, { type: 'playStart', intentId: 1, target: liveChannelTarget() });
    expect(state).toBe(stillDead);

    state = coordinatorReducer(state, { type: 'playDefer', intentId: 2, target: liveChannelTarget() });
    expect(state.pendingPlay?.intentId).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 7 · 消费面锚定(renderLiveWorld):游客 usePlayAction → 登录弹层、授权前零请求
// ---------------------------------------------------------------------------

describe('T007 · 消费面锚定:游客经 usePlayAction 发起直播播放', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('游客在 /live 点击播放:进入登录弹层、零 /playback/ 与 /me/ 请求;取消后仍零请求且弹层不重开(不自动播放)', async () => {
    // 夹具世界:仅 /setup/status 应答 initialized=true(登录分支);其余一律 404 problem
    const fetchMock = vi.fn();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const pathname = new URL(url, 'http://redroad.invalid').pathname;
      if (method === 'GET' && pathname.endsWith('/setup/status')) {
        return new Response(JSON.stringify({ initialized: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ status: 404, code: 'NOT_FOUND', title: 'NOT_FOUND' }), {
        status: 404,
        headers: { 'Content-Type': 'application/problem+json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    // 先装测试路由 mock,再装计数器(包装叠加);renderLiveWorld 的会话 mock 包在最外层
    const counter = installNetworkCounter();
    const world = renderLiveWorld(<LivePlayProbe />, {
      session: LIVE_SESSION_STATES.guest,
      initialEntries: ['/live'],
      decorate: (ui) => (
        <SettingsAccessProvider>
          <ActionCoordinator>{ui}</ActionCoordinator>
        </SettingsAccessProvider>
      ),
    });
    try {
      await waitFor(() => expect(screen.getByTestId('live-session').textContent).toBe('anonymous:none'));

      // 游客点击直播频道播放:进入登录意图弹层,播放面保持为空(零 authorize)
      fireEvent.click(screen.getByTestId('play-live'));
      await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
      expect(screen.getByRole('heading', { name: '登录' })).toBeVisible();
      expect(screen.getByTestId('phase').textContent).toBe('-');
      expect(screen.getByTestId('target').textContent).toBe('-');
      expect(counter.counts.playback).toBe(0);
      expect(counter.counts.personal).toBe(0);

      // 取消登录:弹层关闭、意图废弃;不自动播放、不重复弹窗,仍零 /playback/ 与 /me/ 请求
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByTestId('phase').textContent).toBe('-');
      expect(screen.getByTestId('target').textContent).toBe('-');
      expect(counter.counts.playback).toBe(0);
      expect(counter.counts.personal).toBe(0);
    } finally {
      world.restore();
      counter.restore();
    }
  });
});
