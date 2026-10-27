import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  bootstrapMainProfile,
  fetchSession,
  initializeSetup,
  loginRequest,
  logoutRequest,
  recoverMainProfilePin,
} from '../../src/features/auth/auth-api';
import { fetchSelectableProfiles } from '../../src/features/profiles/profiles-api';
import { isFetchApiError } from '../../src/shared/fetch';
import type { AccountSession, ProfileSummary } from '../../src/app/session-types';

/**
 * T026(006 · US2):会话与敏感动作数据访问层单测。
 *
 * 冻结契约(contracts/data-access.md「分层不变式」+ T026 任务行
 * 「fetch 调用统一走 privateFetch 档位」):
 * 1. 认证/会话端点(登录/初始化/首建/PIN 恢复/会话恢复/登出)与选档列表
 *   全部以 `privateFetch`(credentials:'same-origin')发起 —— 登录/首建的
 *   Set-Cookie 流程必须同源收发 Cookie,选档列表是登录会话作用域投影;
 * 2. 路径/方法/请求体与 005 contracts/api.md 一致(deviceType:'web' 由
 *   auth-api 统一注入,调用方不重复拼装);
 * 3. 非 2xx problem+json 以 FetchApiError 原样上抛(数据层不吞错、不转文案);
 * 4. 凭据不入查询缓存:本模块零 setQueryData/queryClient 参与(结构上经
 *   纯 privateFetch 薄包装保证,此处断言调用参数即全量外泄面)。
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sessionFixture(overrides: Partial<AccountSession> = {}): AccountSession {
  return {
    sessionId: 'session-1',
    account: { id: 'acc-1', username: 'admin', role: 'owner' },
    activeProfile: null,
    expiresAt: '2026-11-26T00:00:00.000Z',
    householdId: 'hh-1',
    bootstrapRequired: false,
    profileContextVersion: 1,
    ...overrides,
  };
}

function profileFixture(id: string): ProfileSummary {
  return {
    id,
    name: `档案-${id}`,
    avatar: null,
    type: 'adult',
    isDefault: false,
    isMain: id === 'main',
    pinProtected: false,
    status: 'active',
    createdAt: '2026-10-26T00:00:00.000Z',
    version: 1,
  };
}

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 断言第 n 次调用的基础要素:同源档位 + /api 前缀路径 + 方法 */
function expectCall(n: number, path: string, method: string): void {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit];
  expect(url.startsWith(`/api${path}`)).toBe(true);
  expect(init.method).toBe(method);
  // T026 核心档位约束:一律 same-origin(登录等 Set-Cookie 流程的前提)
  expect(init.credentials).toBe('same-origin');
}

describe('T026 认证/会话端点 · privateFetch 档位与请求契约', () => {
  it('loginRequest:POST /auth/login,请求体含用户名/密码/deviceType web(trim 由步骤负责)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(sessionFixture({ bootstrapRequired: true })));

    const session = await loginRequest({ username: 'admin', password: 'secret' });

    expectCall(0, '/auth/login', 'POST');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      username: 'admin',
      password: 'secret',
      deviceType: 'web',
    });
    expect(session.bootstrapRequired).toBe(true);
  });

  it('initializeSetup:POST /setup/initialize,请求体为家庭名/用户名/密码(凭据档位保持 same-origin 现状)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ initialized: true }, 201));

    await initializeSetup({ householdName: '我家', username: 'admin', password: 'secret' });

    expectCall(0, '/setup/initialize', 'POST');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      householdName: '我家',
      username: 'admin',
      password: 'secret',
    });
  });

  it('bootstrapMainProfile:POST /auth/bootstrap-profile,请求体为名称/6 位 PIN/当次密码(trim 由步骤负责)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(profileFixture('main'), 201));

    const profile = await bootstrapMainProfile({ name: '主档案', pin: '123456', ownerPassword: 'secret' });

    expectCall(0, '/auth/bootstrap-profile', 'POST');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ name: '主档案', pin: '123456', ownerPassword: 'secret' });
    expect(profile.isMain).toBe(true);
  });

  it('recoverMainProfilePin:POST /auth/main-profile/pin-recovery,204 空体返回 undefined', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await recoverMainProfilePin({ newPin: '654321', ownerPassword: 'secret' });

    expectCall(0, '/auth/main-profile/pin-recovery', 'POST');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ newPin: '654321', ownerPassword: 'secret' });
    expect(result).toBeUndefined();
  });

  it('fetchSession:GET /auth/session 且无请求体(恢复为硬请求,服务端唯一信任源)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(sessionFixture()));

    const session = await fetchSession();

    expectCall(0, '/auth/session', 'GET');
    expect(session.sessionId).toBe('session-1');
  });

  it('logoutRequest:POST /auth/logout(幂等 204)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await logoutRequest();

    expectCall(0, '/auth/logout', 'POST');
  });

  it('fetchSelectableProfiles:GET /profiles(会话作用域,same-origin 档)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([profileFixture('main'), profileFixture('kid')]));

    const profiles = await fetchSelectableProfiles();

    expectCall(0, '/profiles', 'GET');
    expect(profiles.map((item) => item.id)).toEqual(['main', 'kid']);
  });
});

describe('T026 错误通道 · FetchApiError 原样上抛(不吞错/不转文案)', () => {
  it('loginRequest 401(INVALID_CREDENTIALS):结构化 status/code 直通调用方', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 401, title: '未授权', code: 'INVALID_CREDENTIALS' }), {
        status: 401,
        headers: { 'Content-Type': 'application/problem+json' },
      }),
    );

    let caught: unknown = null;
    try {
      await loginRequest({ username: 'admin', password: 'wrong' });
    } catch (err) {
      caught = err;
    }
    expect(isFetchApiError(caught)).toBe(true);
    const error = caught as { status: number; code: string | null };
    expect(error.status).toBe(401);
    expect(error.code).toBe('INVALID_CREDENTIALS');
  });
});
