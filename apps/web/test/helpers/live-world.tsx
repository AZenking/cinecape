/**
 * 012 T004 · 直播测试「世界」夹具:三态会话工厂 + Provider 包装 render。
 *
 * 面向 012 直播故事单测(T006/T007/T014/T015/T020 等)提供:
 * - LIVE_SESSION_STATES:三态类型化常量——guest(游客)/ authed-no-profile(已登录
 *   未选档)/ authed-with-profile(已选主档案);
 * - liveSessionFixture(state):AccountSession DTO 夹具(沿用 session-provider.spec /
 *   vod-identity-guards 的服务端 DTO 形状:session-1/acc-1/admin/profile-a/hh-1,
 *   不含任何真实凭据——令牌在 httpOnly Cookie,会话 DTO 本就无凭据字段);
 * - installLiveSessionMock(state):按状态布线 GET /api/auth/session——游客 = 401
 *   problem(与真实恢复失败同形),已登录 = 200 会话 DTO;其余请求委托给「安装那一刻」
 *   的既有 global fetch(可与测试自身的路由式 vi.stubGlobal mock 组合);
 * - renderLiveWorld(ui, options):QueryClientProvider(独立内存 client,retry:false,
 *   复用 helpers/query-test-utils 的 createTestQueryClient)+ SessionProvider +
 *   MemoryRouter 一键挂载,并自动安装会话 mock;
 * - LiveSessionProbe:会话身份探针(status:profileId 文本),供 waitFor 断言恢复完成。
 *
 * 组合顺序(重要):本文件的网络布线包装「安装那一刻」的 global fetch。若测试需要
 * 更多端点路由,先经 vi.stubGlobal 安装自身路由 mock,再调 renderLiveWorld /
 * installLiveSessionMock(会话 mock 包在其外,会话与业务请求各得其所)。
 *
 * 会话形状依据:src/app/session-provider.tsx(restoring/anonymous/authenticated、
 * GET /auth/session 恢复、activeProfile 为空仍为 authenticated)、
 * src/app/session-types.ts(AccountSession/ProfileSummary 契约投影)。
 * authed-no-profile 取 bootstrapRequired=true(零档案家庭待首建,BootstrapProfile
 * 契约);「有档案但未选档」场景可经 overrides 覆盖该字段。
 */

import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { SessionProvider, useSession } from '../../src/app/session-provider';
import type { AccountSession, ProfileSummary } from '../../src/app/session-types';
import { createTestQueryClient } from './query-test-utils';

/** 三态会话档位(T004):游客 / 已登录未选档 / 已选主档案 */
export type LiveSessionState = 'guest' | 'authed-no-profile' | 'authed-with-profile';

/** 三态类型化常量:调用点以 LIVE_SESSION_STATES.xxx 显式声明被测身份 */
export const LIVE_SESSION_STATES = {
  guest: 'guest',
  authedNoProfile: 'authed-no-profile',
  authedWithProfile: 'authed-with-profile',
} as const satisfies Record<string, LiveSessionState>;

/** 主档案夹具(与 session-provider.spec / vod-identity-guards 同形状,便于断言复用) */
const MAIN_PROFILE: ProfileSummary = {
  id: 'profile-a',
  name: '妈妈',
  avatar: null,
  type: 'adult',
  isDefault: true,
  isMain: true,
  pinProtected: false,
  status: 'active',
  createdAt: '2026-10-26T00:00:00.000Z',
  version: 1,
};

/**
 * 三态会话 DTO 工厂。
 * - guest → null(无会话 DTO;恢复以 401 problem 表达,见 installLiveSessionMock);
 * - authed-no-profile → activeProfile=null 且 bootstrapRequired=true(零档案待首建);
 * - authed-with-profile → 已选主档案 profile-a。
 * overrides 可逐字段覆盖(如 profileContextVersion、bootstrapRequired)。
 */
export function liveSessionFixture(
  state: Exclude<LiveSessionState, 'guest'>,
  overrides?: Partial<AccountSession>,
): AccountSession;
export function liveSessionFixture(
  state: LiveSessionState,
  overrides?: Partial<AccountSession>,
): AccountSession | null;
export function liveSessionFixture(
  state: LiveSessionState,
  overrides: Partial<AccountSession> = {},
): AccountSession | null {
  if (state === LIVE_SESSION_STATES.guest) {
    return null;
  }
  return {
    sessionId: 'session-1',
    account: { id: 'acc-1', username: 'admin', role: 'owner' },
    activeProfile: state === LIVE_SESSION_STATES.authedWithProfile ? MAIN_PROFILE : null,
    expiresAt: '2026-11-26T00:00:00.000Z',
    householdId: 'hh-1',
    bootstrapRequired: state === LIVE_SESSION_STATES.authedNoProfile,
    profileContextVersion: 1,
    ...overrides,
  };
}

/** 2xx JSON 响应(session-provider.spec 同款最小工具) */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** RFC 9457 problem+json 响应(401=SESSION_INVALID 与真实恢复失败同形) */
function problemResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ status, code, title: code }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

/**
 * 以描述符级保存/还原方式替换 globalThis.fetch(不用 vi.stubGlobal,避免
 * unstubAllGlobals 连带清掉测试自身的 stub;还原后 vitest 自身的记账不受影响)。
 * 注意:本工具在各夹具文件内就地实现(不抽公共模块),保持每个夹具自包含。
 */
function stubGlobalFetch(replacement: typeof globalThis.fetch): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', {
    value: replacement,
    writable: true,
    configurable: true,
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(globalThis, 'fetch', descriptor);
    } else {
      delete (globalThis as { fetch?: unknown }).fetch;
    }
  };
}

/** 会话恢复请求判定:GET 请求且路径以 /auth/session 结尾(与 SessionProvider 恢复端点一致) */
function isSessionRestoreRequest(url: string, init: RequestInit | undefined): boolean {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    return false;
  }
  try {
    return new URL(url, 'http://redroad.invalid').pathname.endsWith('/auth/session');
  } catch {
    return false;
  }
}

export interface LiveSessionMockHandle {
  /** 安装时声明的三态档位 */
  readonly state: LiveSessionState;
  /** 还原安装前的 global fetch(描述符级;不影响 vi.stubGlobal 记账) */
  restore(): void;
}

/**
 * 按三态布线 GET /api/auth/session(其余请求委托给安装时的既有 global fetch;
 * 无既有实现时一律 404 problem——夹具世界内不允许意外出网)。restore() 还原。
 */
export function installLiveSessionMock(state: LiveSessionState): LiveSessionMockHandle {
  const previous = typeof globalThis.fetch === 'function' ? globalThis.fetch : undefined;
  const wrapper: typeof globalThis.fetch = (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (isSessionRestoreRequest(url, init)) {
      if (state === LIVE_SESSION_STATES.guest) {
        return Promise.resolve(problemResponse(401, 'SESSION_INVALID'));
      }
      return Promise.resolve(jsonResponse(liveSessionFixture(state)));
    }
    if (previous !== undefined) {
      return previous(input, init);
    }
    return Promise.resolve(problemResponse(404, 'NOT_FOUND'));
  };
  const restore = stubGlobalFetch(wrapper);
  return { state, restore };
}

export interface RenderLiveWorldOptions {
  /** 三态会话(必填:调用点显式声明被测身份,不设缺省) */
  session: LiveSessionState;
  /** MemoryRouter 初始地址;缺省 ['/live'](012 直播世界缺省落点) */
  initialEntries?: string[];
  /** 注入既有 QueryClient;缺省新建 createTestQueryClient()(retry:false 内存实例) */
  client?: QueryClient;
  /** 额外包装(如 ActionCoordinator/SettingsAccessProvider),包在 MemoryRouter 内、ui 外 */
  decorate?: (children: ReactNode) => ReactNode;
}

export interface LiveWorldResult extends RenderResult {
  /** 本例内存 QueryClient(缓存断言/手工 setQueryData 用) */
  client: QueryClient;
  /** 本例声明的三态档位 */
  readonly sessionState: LiveSessionState;
  /** 还原 renderLiveWorld 安装的会话 mock(建议用例尾/afterEach 调用) */
  restore(): void;
}

/**
 * 包装 render:QueryClientProvider(独立内存 client)+ SessionProvider +
 * MemoryRouter 一键挂载,并安装 options.session 对应的会话 mock。
 * 返回结果含 client(缓存断言)与 restore()(卸下会话 mock)。
 */
export function renderLiveWorld(
  ui: ReactNode,
  options: RenderLiveWorldOptions,
): LiveWorldResult {
  const client = options.client ?? createTestQueryClient();
  const restore = installLiveSessionMock(options.session).restore;
  const view = render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <MemoryRouter initialEntries={options.initialEntries ?? ['/live']}>
          {options.decorate ? options.decorate(ui) : ui}
        </MemoryRouter>
      </SessionProvider>
    </QueryClientProvider>,
  );
  return { ...view, client, sessionState: options.session, restore };
}

/** 会话身份探针:渲染 `status:profileId`(等待 SessionProvider 恢复到目标身份) */
export function LiveSessionProbe(): ReactNode {
  const session = useSession();
  return (
    <span data-testid="live-session">
      {session.status}:{session.session?.activeProfile?.id ?? 'none'}
    </span>
  );
}
