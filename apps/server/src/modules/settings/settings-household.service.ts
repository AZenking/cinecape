import { eq } from 'drizzle-orm';
import { ProblemCode } from '@hmp/shared';
import { household } from '../../database/schema';
import { DomainError, createDomainError } from '../../common/domain-error';
import type { SessionContext } from '../../common/current-session.decorator';
import { getDb, type Db } from '@contexts/identity-access/infrastructure/db';
import { requireManagementRole } from '@contexts/identity-access/application/bootstrap.service';
import { verifyOwnerPassword } from './settings-owner-password';
import { requireValidSettingsGrantTx } from './settings-access-grant.service';

/**
 * 通用设置服务(T130,005 contracts/api.md §6 + data-model.md §2 household + FR-039):
 * - GET:HouseholdSettings 投影(name/language/timezone/version/mainProfileVersion);
 * - PATCH:{expectedVersion,ownerPassword 必填,name?/language?/timezone?} ——
 *   当次密码 + version CAS(「通用设置变更用 version CAS」);
 *   timezone 必须为运行环境认可的 IANA 时区(「timezone 必须是运行环境认可的 IANA 时区」);
 * - mainProfileVersion 随投影返回仅作只读展示;它只被主档案转移递增,本服务不改写。
 *
 * 事务纪律:密码验证与 IANA 校验在事务外;BEGIN IMMEDIATE 提交前重验
 * credential 快照以外的权限快照(grant/会话/主档案)与 expectedVersion。
 */

/** 契约 HouseholdSettings(openapi components/schemas) */
export interface HouseholdSettingsBody {
  name: string;
  language: string;
  timezone: string;
  version: number;
  mainProfileVersion: number;
}

/** 运行环境认可的 IANA 时区(Node ICU 全集;候选必须精确命中,大小写敏感) */
export function isSupportedTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function readHouseholdRow(db: Db, householdId: string) {
  const row = db.select().from(household).where(eq(household.id, householdId)).get();
  if (row === undefined) {
    // 会话有效但家庭行缺失:服务端数据不一致,按契约 404 不泄露细节
    throw new DomainError(404, ProblemCode.NOT_FOUND);
  }
  return row;
}

export function toHouseholdSettings(row: ReturnType<typeof readHouseholdRow>): HouseholdSettingsBody {
  return {
    name: row.name,
    language: row.defaultLanguage,
    timezone: row.timezone,
    version: row.version,
    mainProfileVersion: row.mainProfileVersion,
  };
}

export function getHouseholdSettings(householdId: string): HouseholdSettingsBody {
  return toHouseholdSettings(readHouseholdRow(getDb(), householdId));
}

export interface PatchHouseholdInput {
  expectedVersion: number;
  ownerPassword?: string;
  name?: string;
  language?: string;
  timezone?: string;
}

export async function patchHouseholdSettings(context: SessionContext, input: PatchHouseholdInput): Promise<HouseholdSettingsBody> {
  requireManagementRole(context);
  const db = getDb();
  // 当次密码(缺失 403 REQUIRED;既有错误计数/锁定)在事务外;IANA 校验同样在事务外
  await verifyOwnerPassword(context, input.ownerPassword);
  if (input.timezone !== undefined && !isSupportedTimezone(input.timezone)) {
    throw new DomainError(400, ProblemCode.VALIDATION_FAILED, 'timezone 必须是运行环境认可的 IANA 时区');
  }
  return db.transaction(
    (tx) => {
      // 权限快照重验(grant/会话/主档案/三版本)
      requireValidSettingsGrantTx(tx, context);
      const row = readHouseholdRow(tx, context.session.householdId);
      if (row.version !== input.expectedVersion) {
        // 旧版本与伪造版本一律 409,不静默覆盖现值
        throw createDomainError('VERSION_CONFLICT');
      }
      tx
        .update(household)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.language !== undefined ? { defaultLanguage: input.language } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          version: row.version + 1,
        })
        .where(eq(household.id, row.id))
        .run();
      return toHouseholdSettings(readHouseholdRow(tx, context.session.householdId));
    },
    { behavior: 'immediate' },
  );
}
