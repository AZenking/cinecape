/**
 * 012 T004 自检(保留性冒烟;后续任务绿后可删):
 * 钉夹具自身契约,不钉业务行为——
 * 1) 三态会话工厂可经 renderLiveWorld render,SessionProvider 恢复到预期身份
 *    (guest → anonymous / authed-no-profile → authenticated 无档案 /
 *    authed-with-profile → authenticated 主档案);
 * 2) installNetworkCounter 可计数:playback 与 /me 前缀分别累加、其余路径忽略、
 *    restore 还原安装前的 fetch 引用;
 * 3) live-data 桩形状完整:四态节目时间窗自洽、≥3 组 × 每组 ≥2 频道、至少一频道
 *    无节目数据、快照时区为家庭时区 Asia/Shanghai。
 */
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { privateFetch, publicFetch } from '../../src/shared/fetch';
import {
  LIVE_ENDED_PROGRAMME,
  LIVE_GROUPS,
  LIVE_NOW,
  LIVE_PROGRAMME_STATES,
  LIVE_TEST_TIMEZONE,
  LIVE_UPCOMING_PROGRAMME,
  liveChannelPage,
  liveGroupPage,
  liveProgrammes,
} from './live-data';
import { LIVE_SESSION_STATES, LiveSessionProbe, liveSessionFixture, renderLiveWorld } from './live-world';
import type { LiveSessionState } from './live-world';
import { installNetworkCounter } from './network-assertions';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ────────────────────────── 1 · 三态会话工厂 ──────────────────────────

/** 逐态断言:世界 render 后 SessionProvider 恢复到 `status:profileId` 预期文本 */
async function expectWorldRestoresTo(session: LiveSessionState, expected: string): Promise<void> {
  const world = renderLiveWorld(<LiveSessionProbe />, { session });
  try {
    await waitFor(() => {
      expect(screen.getByTestId('live-session').textContent).toBe(expected);
    });
  } finally {
    world.restore();
  }
}

describe('012 T004 · 三态会话工厂(renderLiveWorld)', () => {
  it('guest:GET /auth/session 401 → anonymous,无档案', async () => {
    await expectWorldRestoresTo(LIVE_SESSION_STATES.guest, 'anonymous:none');
  });

  it('authed-no-profile:200 且 activeProfile=null → authenticated,无档案', async () => {
    await expectWorldRestoresTo(LIVE_SESSION_STATES.authedNoProfile, 'authenticated:none');
  });

  it('authed-with-profile:200 主档案 → authenticated:profile-a', async () => {
    await expectWorldRestoresTo(LIVE_SESSION_STATES.authedWithProfile, 'authenticated:profile-a');
  });

  it('会话 DTO 工厂:guest=null;未选档 bootstrapRequired=true;已选档带主档案', () => {
    expect(liveSessionFixture(LIVE_SESSION_STATES.guest)).toBeNull();
    const noProfile = liveSessionFixture(LIVE_SESSION_STATES.authedNoProfile);
    expect(noProfile.activeProfile).toBeNull();
    expect(noProfile.bootstrapRequired).toBe(true);
    const withProfile = liveSessionFixture(LIVE_SESSION_STATES.authedWithProfile);
    expect(withProfile.activeProfile?.id).toBe('profile-a');
    expect(withProfile.bootstrapRequired).toBe(false);
    // overrides 逐字段覆盖(profileContextVersion 场景)
    expect(
      liveSessionFixture(LIVE_SESSION_STATES.authedWithProfile, { profileContextVersion: 2 })
        .profileContextVersion,
    ).toBe(2);
  });
});

// ────────────────────────── 2 · Network 计数器 ──────────────────────────

describe('012 T004 · installNetworkCounter 计数与还原', () => {
  it('playback 与 /me 前缀分别计数,其余路径忽略;委托实现照常应答', async () => {
    const delegate = vi.fn(async () => jsonResponse({ ok: true }));
    const counter = installNetworkCounter({ fetch: delegate });
    try {
      await privateFetch('/playback/resolve', { method: 'POST', body: { mediaId: 'media-1' } });
      await privateFetch('/playback/sessions/session-a/stop', { method: 'POST' });
      await privateFetch('/me/vod/preferences');
      await publicFetch('/public/live/groups');
      expect(counter.counts.playback).toBe(2);
      expect(counter.counts.personal).toBe(1);
      // 全部 4 次请求都抵达委托(计数器只旁路统计,不吞请求)
      expect(delegate).toHaveBeenCalledTimes(4);
    } finally {
      counter.restore();
    }
  });

  it('restore 还原安装前的 globalThis.fetch 引用', () => {
    const before = globalThis.fetch;
    const counter = installNetworkCounter({ fetch: async () => jsonResponse({}) });
    expect(globalThis.fetch).not.toBe(before);
    counter.restore();
    expect(globalThis.fetch).toBe(before);
  });

  it('包装既有 global mock:先 stubGlobal 路由、后装计数器,两层叠加', async () => {
    const routeMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/me/favorites')) {
        return jsonResponse({ items: [] });
      }
      return jsonResponse({});
    });
    const previous = globalThis.fetch;
    globalThis.fetch = routeMock;
    const counter = installNetworkCounter();
    try {
      await privateFetch('/me/favorites');
      expect(counter.counts.personal).toBe(1);
      expect(counter.counts.playback).toBe(0);
      expect(routeMock).toHaveBeenCalledTimes(1);
    } finally {
      counter.restore();
      globalThis.fetch = previous;
    }
  });
});

// ────────────────────────── 3 · 直播数据桩形状 ──────────────────────────

describe('012 T004 · live-data 数据桩', () => {
  it('四态节目时间窗自洽:now 覆盖 LIVE_NOW、upcoming 在未来、ended 在过去、none=null', () => {
    const { now, upcoming, ended, none } = LIVE_PROGRAMME_STATES;
    expect(now.startsAt <= LIVE_NOW && LIVE_NOW < now.endsAt).toBe(true);
    expect(upcoming.startsAt > LIVE_NOW).toBe(true);
    expect(ended.endsAt <= LIVE_NOW).toBe(true);
    expect(none).toBeNull();
    // 指定样本与四态表同源
    expect(LIVE_UPCOMING_PROGRAMME).toBe(LIVE_PROGRAMME_STATES.upcoming);
    expect(LIVE_ENDED_PROGRAMME).toBe(LIVE_PROGRAMME_STATES.ended);
  });

  it('多频道分组:≥3 组、每组 ≥2 频道、至少一频道无节目数据;快照时区=家庭时区', () => {
    const groupPage = liveGroupPage();
    const channelPage = liveChannelPage();
    expect(groupPage.items.length).toBeGreaterThanOrEqual(3);
    expect(groupPage.timezone).toBe(LIVE_TEST_TIMEZONE);
    expect(LIVE_GROUPS.length).toBeGreaterThanOrEqual(3);
    for (const group of groupPage.items) {
      const rows = channelPage.items.filter((row) => row.groupKey === group.key);
      expect(rows.length, `分组 ${group.key} 至少 2 频道`).toBeGreaterThanOrEqual(2);
    }
    const withoutProgrammes = channelPage.items.filter(
      (row) => row.current === null && row.next === null,
    );
    expect(withoutProgrammes.length, '至少一频道无节目数据').toBeGreaterThanOrEqual(1);
    expect(channelPage.timezone).toBe(LIVE_TEST_TIMEZONE);
  });

  it('Programmes 快照桩:档位映射节目、ended 样本可入快照、时区与 now 就位', () => {
    const ended = liveProgrammes({ current: 'ended', next: 'none' });
    expect(ended.current).toBe(LIVE_ENDED_PROGRAMME);
    expect(ended.next).toBeNull();
    expect(ended.now).toBe(LIVE_NOW);
    expect(ended.timezone).toBe(LIVE_TEST_TIMEZONE);
    const world = liveProgrammes();
    expect(world.current).toBe(LIVE_PROGRAMME_STATES.now);
    expect(world.next).toBe(LIVE_UPCOMING_PROGRAMME);
  });

  it('探针组件可独立使用(ReactNode 形状冒烟)', () => {
    const probe: ReactNode = <LiveSessionProbe />;
    expect(probe).not.toBeNull();
  });
});
