import { eq } from 'drizzle-orm';
import { ProblemCode } from '@hmp/shared';
import type { Household } from '@platform/database/schema';
import { household } from '@platform/database/schema';
import { DomainError } from '@platform/http-common/domain-error';
import { getDb } from '@contexts/identity-access/infrastructure/db';

/**
 * Household 聚合(T018):
 * - 一次性初始化守卫(FR-002/003,ADR-0002):一次部署至多一个 Household;
 * - GET /household 从服务端会话边界读取(FR-006 显式 household_id)。
 * 初始化用例(POST /setup/initialize)由 setup.service.initializeDeployment 承载;
 * 007-T031 清理:旧 initializeHousehold/isInitialized 全仓零消费,已删除。
 */

/** HouseholdDto 响应体(契约 components/schemas/HouseholdDto) */
export interface HouseholdDtoBody {
  id: string;
  name: string;
  defaultLanguage: string;
  timezone: string;
  createdAt: string;
}

export function getHousehold(householdId: string): Household {
  const row = getDb().select().from(household).where(eq(household.id, householdId)).get();
  if (row === undefined) {
    // 会话本身有效但家庭行缺失属服务端数据不一致,按契约 404 不泄露跨家庭信息
    throw new DomainError(404, ProblemCode.NOT_FOUND);
  }
  return row;
}

/** 白名单式输出:password_hash 永不出现在 DTO(FR-007/场景5) */
export function toHouseholdDto(row: Household): HouseholdDtoBody {
  return {
    id: row.id,
    name: row.name,
    defaultLanguage: row.defaultLanguage,
    timezone: row.timezone,
    createdAt: row.createdAt,
  };
}
