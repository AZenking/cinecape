import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { ProblemCode } from '@hmp/shared';
import type { Account, Household, NewAccount, NewHousehold } from '../../../database/schema';
import { account, household } from '../../../database/schema';
import { DomainError } from '../../../common/domain-error';
import { getDb } from '@contexts/identity-access/infrastructure/db';

/**
 * Household 聚合(T018):
 * - 一次性初始化守卫(FR-002/003,ADR-0002):一次部署至多一个 Household;
 * - GET /household 从服务端会话边界读取(FR-006 显式 household_id)。
 */

export interface InitializeInput {
  householdName: string;
  defaultLanguage: string;
  timezone: string;
  username: string;
  /** argon2id 哈希由调用方在事务外预先计算(短事务) */
  passwordHash: string;
}

/** HouseholdDto 响应体(契约 components/schemas/HouseholdDto) */
export interface HouseholdDtoBody {
  id: string;
  name: string;
  defaultLanguage: string;
  timezone: string;
  createdAt: string;
}

function alreadyDone(): DomainError {
  return new DomainError(409, ProblemCode.INITIALIZATION_ALREADY_DONE, '本部署已完成初始化');
}

export function isInitialized(): boolean {
  return getDb().select({ id: household.id }).from(household).limit(1).get() !== undefined;
}

export function getHousehold(householdId: string): Household {
  const row = getDb().select().from(household).where(eq(household.id, householdId)).get();
  if (row === undefined) {
    // 会话本身有效但家庭行缺失属服务端数据不一致,按契约 404 不泄露跨家庭信息
    throw new DomainError(404, ProblemCode.NOT_FOUND);
  }
  return row;
}

/**
 * 初始化:检查-写入在同一事务内完成(SQLite 写串行化,无竞态窗口);
 * 已存在任何家庭数据时抛 409 且不产生任何写入(原数据保持不变,场景2)。
 */
export function initializeHousehold(input: InitializeInput): { household: Household; account: Account } {
  if (isInitialized()) {
    throw alreadyDone();
  }
  const now = new Date().toISOString();
  const householdRow: NewHousehold = {
    id: randomUUID(),
    name: input.householdName,
    defaultLanguage: input.defaultLanguage,
    timezone: input.timezone,
    createdAt: now,
  };
  const accountRow: NewAccount = {
    id: randomUUID(),
    householdId: householdRow.id,
    username: input.username,
    usernameNormalized: input.username.toLowerCase(), // 防枚举查询列(大小写不敏感唯一)
    passwordHash: input.passwordHash,
    role: 'owner',
    createdAt: now,
  };

  return getDb().transaction((tx) => {
    if (tx.select({ id: household.id }).from(household).limit(1).get() !== undefined) {
      throw alreadyDone();
    }
    tx.insert(household).values(householdRow).run();
    tx.insert(account).values(accountRow).run();
    return {
      household: householdRow as Household,
      account: accountRow as Account,
    };
  });
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
