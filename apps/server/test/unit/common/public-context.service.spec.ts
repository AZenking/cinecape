import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProblemCode as ProblemCodeConst } from '@hmp/shared';
import { PublicContextService } from '../../../src/common/public-context/public-context.service';
import { DomainError, PC_005_PROBLEM_CODES } from '../../../src/common/domain-error';
import { Database } from '../../../src/database/database';
import { startFreshApp, cleanupRigs, type TestRig } from '../../helpers';

/**
 * T009 PublicContext 解析(005 contracts/api.md §1/§2,data-model §9)——
 * - 零家庭 → uninitialized / initialized=false(不伪装已初始化);
 * - 唯一家庭 → ready + 白名单字段(displayName/timezone/language);
 * - 多家庭 → 配置损坏:requireScope 抛 503 STORAGE_GENERATION_UNSUPPORTED;
 * - 存储不可读(表缺失)→ storageUnavailable / 503 NOT_READY,不误判为未初始化。
 *
 * 服务不接收任何请求输入:匿名身份声明(query/body householdId)无法影响范围
 * (接口签名即无 request 参数,架构性保证)。
 */

function insertHousehold(id: string, name: string): void {
  Database.db
    .prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)')
    .run(id, name, '2026-01-01T00:00:00.000Z');
}

describe('PublicContextService(唯一 Household 公开范围)', () => {
  let rig: TestRig;
  let service: PublicContextService;

  beforeAll(async () => {
    rig = await startFreshApp({ prefix: 'hmp-t009-pubctx-' });
    service = new PublicContextService();
  });

  afterAll(async () => {
    await cleanupRigs();
  });

  it('零家庭 → initialized=false(未初始化语义)', () => {
    expect(service.resolve()).toEqual({ kind: 'uninitialized' });
    expect(service.requireScope()).toEqual({ initialized: false, household: null });
  });

  it('唯一家庭 → initialized=true + 白名单公开字段(无账号/Profile/来源)', () => {
    insertHousehold('hh-1', '幸福之家');
    const scope = service.requireScope();
    expect(scope.initialized).toBe(true);
    if (scope.initialized) {
      expect(scope.household).toEqual({
        householdId: 'hh-1',
        displayName: '幸福之家',
        timezone: 'Asia/Shanghai',
        language: 'zh-CN',
      });
    }
    expect(service.resolve()).toEqual({
      kind: 'ready',
      household: {
        householdId: 'hh-1',
        displayName: '幸福之家',
        timezone: 'Asia/Shanghai',
        language: 'zh-CN',
      },
    });
  });

  it('多家庭 → 配置损坏 503 STORAGE_GENERATION_UNSUPPORTED(稳定码,不伪装未初始化)', () => {
    insertHousehold('hh-2', '多余之家');
    expect(service.resolve()).toEqual({ kind: 'householdCorruption' });
    try {
      service.requireScope();
      throw new Error('多家庭应当 503(测试夹具错误)');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      const domain = error as DomainError;
      expect(domain.status).toBe(503);
      expect(domain.code).toBe(PC_005_PROBLEM_CODES.STORAGE_GENERATION_UNSUPPORTED);
      // 脱敏:不携带家庭 ID/名称/内部路径
      expect(domain.detail).not.toContain('hh-');
    }
  });

  it('存储不可读(表缺失)→ 503 NOT_READY,状态未知不得伪装 initialized=false', () => {
    Database.db.exec('DROP TABLE household');
    expect(service.resolve()).toEqual({ kind: 'storageUnavailable' });
    try {
      service.requireScope();
      throw new Error('存储故障应当 503(测试夹具错误)');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      const domain = error as DomainError;
      expect(domain.status).toBe(503);
      expect(domain.code).toBe(ProblemCodeConst.NOT_READY);
    }
    void rig;
  });
});
