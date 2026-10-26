import { randomUUID } from 'node:crypto';
import { ProblemCode } from '@hmp/shared';
import type { Account, Household, NewAccount, NewHousehold } from '../../database/schema';
import { account, household } from '../../database/schema';
import { DomainError } from '../../common/domain-error';
import { getDb } from './db';

/**
 * 部署初始化服务(T036,005 research R2「初始化与首档案分为两个事务流程」):
 * - POST /setup/initialize 仅创建 Household + Account(account.credential_version 取
 *   0006 DDL 默认 1),**不注册设备、不签发会话、不下发 Cookie、不自动登录**;
 *   自动登录链路(registerDevice/issueSession/setSessionCookie)已从初始化路径真正移除;
 * - `BEGIN IMMEDIATE` 单事务:检查-写入原子完成,SQLite 写串行化下并发提交
 *   只可能有一方看到「零家庭」并成功,另一方在事务内复检后 409 回滚;
 *   账号 username_normalized 唯一索引作为并发兜底(冲突同样映射 409);
 * - 失败(任何一步抛错)整体回滚,不遗留半配置状态;
 * - 密码哈希由调用方在事务外预先计算(短事务,对齐既有惯例)。
 */

export interface InitializeDeploymentInput {
  householdName: string;
  defaultLanguage: string;
  timezone: string;
  username: string;
  /** argon2id 哈希,控制器在事务外预先计算;明文密码不进入本模块 */
  passwordHash: string;
}

function alreadyDone(): DomainError {
  return new DomainError(409, ProblemCode.INITIALIZATION_ALREADY_DONE, '本部署已完成初始化');
}

/** SQLite 唯一约束冲突(并发兜底):与「已初始化」同形 409,不区分暴露细节 */
function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT') === true;
}

/**
 * 初始化部署:BEGIN IMMEDIATE 单事务内创建唯一 Household + owner Account。
 * 已存在任何家庭数据时抛 409 且零写入;并发重复提交恰有一次成功(research R2)。
 */
export function initializeDeployment(input: InitializeDeploymentInput): { household: Household; account: Account } {
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

  try {
    return getDb().transaction(
      (tx) => {
        // 事务内复检(与 BEGIN IMMEDIATE 写锁共同保证并发下恰一次成功)
        if (tx.select({ id: household.id }).from(household).limit(1).get() !== undefined) {
          throw alreadyDone();
        }
        tx.insert(household).values(householdRow).run();
        tx.insert(account).values(accountRow).run();
        return {
          household: householdRow as Household,
          account: accountRow as Account,
        };
      },
      // T036 契约:BEGIN IMMEDIATE 单事务(写锁在事务开始即获取,并发提交串行判定)
      { behavior: 'immediate' },
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      // 并发窗口兜底:另一请求已插入同家庭/同用户名数据 → 与重复初始化同形 409
      throw alreadyDone();
    }
    throw error;
  }
}
