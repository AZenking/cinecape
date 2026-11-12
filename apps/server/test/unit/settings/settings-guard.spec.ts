import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { Database } from '@platform/database/database';
import { DomainError } from '@platform/http-common/domain-error';
import { validateSessionToken } from '@platform/http-common/session.guard';
import { hashToken } from '@contexts/identity-access';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { INITIALIZE_BODY, cleanupRigs, cookiePairOf, initialize, login, startFreshApp } from '../../helpers';
import { SettingsGuard } from '@contexts/settings/infrastructure/settings.guard';

/**
 * T004 · SettingsGuard 单元测试(013-role-differentiated-settings;真实 DB 行)。
 *
 * 新守卫语义(ADR-0017):SessionGuard 之后的会话上下文 + 逐请求查库核验
 * activeProfile.isMain === 1,不再依赖 X-Settings-Grant-Token / settings_access_grant:
 * 1. 主管理员(is_main = 1 且 active)→ 放行,有无 Ticket 头均不影响;
 * 2. 非主档案 / 儿童档案 → 403 FORBIDDEN(SettingsForbiddenError);
 * 3. 未选档(activeProfileId = null)→ 403 FORBIDDEN;
 * 4. 会话上下文缺失(SessionGuard 未先行)→ 401 SESSION_INVALID fail-closed;
 * 5. 库内 is_main 被改写后,即使会话上下文不变也立即拒绝(逐请求以库内现值为准)。
 */

interface Rig {
  adminContext: SessionContext;
  memberContext: SessionContext;
  childContext: SessionContext;
  mainProfileId: string;
}

async function setupRig(): Promise<Rig> {
  const rig = await startFreshApp({ prefix: 'hmp-013-guard-' });
  expect((await initialize(rig.app)).status).toBe(201);
  const server = rig.app.getHttpServer();

  const adminLogin = await login(rig.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(adminLogin.status).toBe(200);
  const adminCookie = cookiePairOf(adminLogin);
  const bootstrapped = await request(server)
    .post('/api/auth/bootstrap-profile')
    .set('Cookie', adminCookie)
    .send({ name: '妈妈', pin: '111111', ownerPassword: INITIALIZE_BODY.password });
  expect(bootstrapped.status, JSON.stringify(bootstrapped.body)).toBe(201);
  const mainProfileId = (bootstrapped.body as { id: string }).id;
  const unlock = await request(server).post(`/api/profiles/${mainProfileId}/unlock`).set('Cookie', adminCookie).send({ pin: '111111' });
  expect(unlock.status).toBe(200);
  const select = await request(server).post(`/api/profiles/${mainProfileId}/select`).set('Cookie', adminCookie).send({});
  expect(select.status).toBe(200);
  const adminContext = validateSessionToken((adminLogin.body as { sessionToken: string }).sessionToken, { hashToken });

  // 普通成员 + 儿童档案(经管理路由创建,零 PIN);各自独立会话选档
  const laterContexts: SessionContext[] = [];
  for (const [name, type] of [
    ['成员', 'adult'],
    ['小朋友', 'child'],
  ] as const) {
    const created = await request(server)
      .post('/api/settings/profiles')
      .set('Cookie', adminCookie)
      .send({ name, type });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const profileId = (created.body as { id: string }).id;
    const memberLogin = await login(rig.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
    expect(memberLogin.status).toBe(200);
    const picked = await request(server)
      .post(`/api/profiles/${profileId}/select`)
      .set('Cookie', cookiePairOf(memberLogin))
      .send({});
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    laterContexts.push(validateSessionToken((memberLogin.body as { sessionToken: string }).sessionToken, { hashToken }));
  }

  return { adminContext, memberContext: laterContexts[0]!, childContext: laterContexts[1]!, mainProfileId };
}

function stubContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request as unknown as Request,
      getResponse: () => undefined,
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

function sessionRequest(context: SessionContext | undefined, headers: Record<string, string> = {}): Record<string, unknown> {
  return { headers, ...(context === undefined ? {} : { hmpSessionContext: context }) };
}

function codeOf(error: unknown): string {
  const response = (error as ForbiddenException).getResponse() as { code?: string };
  return response.code ?? '';
}

describe('T004 · SettingsGuard(013,真实 DB 行)', () => {
  const guard = new SettingsGuard();

  afterEach(async () => {
    await cleanupRigs();
  });

  it('主管理员(is_main=1,active)放行;有无 X-Settings-Grant-Token 头均不影响', async () => {
    const rig = await setupRig();
    expect(guard.canActivate(stubContext(sessionRequest(rig.adminContext)))).toBe(true);
    expect(
      guard.canActivate(stubContext(sessionRequest(rig.adminContext, { 'x-settings-grant-token': 'forged' }))),
    ).toBe(true);
  });

  it('非主档案 403 FORBIDDEN;儿童档案同样 403', async () => {
    const rig = await setupRig();
    expect(() => guard.canActivate(stubContext(sessionRequest(rig.memberContext)))).toThrow(ForbiddenException);
    try {
      guard.canActivate(stubContext(sessionRequest(rig.memberContext)));
      expect.unreachable('应拒绝');
    } catch (error) {
      expect(codeOf(error)).toBe('FORBIDDEN');
    }
    expect(() => guard.canActivate(stubContext(sessionRequest(rig.childContext)))).toThrow(ForbiddenException);
  });

  it('未选档(activeProfileId = null)403 FORBIDDEN', async () => {
    const rig = await setupRig();
    const context = {
      ...rig.adminContext,
      session: { ...rig.adminContext.session, activeProfileId: null },
    } as SessionContext;
    expect(() => guard.canActivate(stubContext(sessionRequest(context)))).toThrow(ForbiddenException);
  });

  it('会话上下文缺失(SessionGuard 未先行)401 SESSION_INVALID fail-closed', async () => {
    await setupRig();
    expect(() => guard.canActivate(stubContext(sessionRequest(undefined)))).toThrow(DomainError);
    try {
      guard.canActivate(stubContext(sessionRequest(undefined)));
      expect.unreachable('应拒绝');
    } catch (error) {
      expect((error as DomainError).status).toBe(401);
      expect((error as DomainError).code).toBe('SESSION_INVALID');
    }
  });

  it('库内 is_main 改写后逐请求立即拒绝(零缓存零放行窗口)', async () => {
    const rig = await setupRig();
    Database.db.prepare('UPDATE profile SET is_main = 0 WHERE id = ?').run(rig.mainProfileId);
    expect(() => guard.canActivate(stubContext(sessionRequest(rig.adminContext)))).toThrow(ForbiddenException);
  });
});
