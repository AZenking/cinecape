import { ProblemCode } from '@hmp/shared';
import { DomainError, createDomainError } from '@platform/http-common/domain-error';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { requireManagementRole } from '@contexts/identity-access';
import { requireMainProfileTx } from '@contexts/settings/application/settings-access-grant.service';
import { settingsStore, type HouseholdRow, type SettingsTxStore } from '@contexts/settings/application/settings-store.port';

/**
 * 通用设置服务(T130,005 contracts/api.md §6 + data-model.md §2 household + FR-039;
 * 013-role-differentiated-settings/ADR-0017:家庭名/语言/时区修改属常规运维,免当次主账号密码):
 * - GET:HouseholdSettings 投影(name/language/timezone/version/mainProfileVersion);
 * - PATCH:{expectedVersion,name?/language?/timezone?} —— version CAS
 *   (「通用设置变更用 version CAS」);timezone 必须为运行环境认可的 IANA 时区
 *   (「timezone 必须是运行环境认可的 IANA 时区」);
 * - mainProfileVersion 随投影返回仅作只读展示;它只被主档案转移递增,本服务不改写。
 *
 * 事务纪律:IANA 校验在事务外;BEGIN IMMEDIATE 提交前重验
 * 权限快照(grant/会话/主档案)与 expectedVersion。高危单次密码仅保留于账号密码/
 * 主档案转移/设备撤销等不可逆操作。
 *
 * 008-repository-extraction(T012,ADR-0015 D1):数据访问经 SettingsStore 端口
 * (查询逐字迁往 infrastructure/settings-store.drizzle.ts;事务经 withTransaction
 * 端口,BEGIN IMMEDIATE 语义不变;内部 db 参数助手收敛为端口调用)。
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

function readHouseholdRow(db: SettingsTxStore, householdId: string): HouseholdRow {
  const row = db.findHouseholdRow(householdId);
  if (row === undefined) {
    // 会话有效但家庭行缺失:服务端数据不一致,按契约 404 不泄露细节
    throw new DomainError(404, ProblemCode.NOT_FOUND);
  }
  return row;
}

export function toHouseholdSettings(row: HouseholdRow): HouseholdSettingsBody {
  return {
    name: row.name,
    language: row.defaultLanguage,
    timezone: row.timezone,
    version: row.version,
    mainProfileVersion: row.mainProfileVersion,
  };
}

export function getHouseholdSettings(householdId: string): HouseholdSettingsBody {
  return toHouseholdSettings(readHouseholdRow(settingsStore(), householdId));
}

export interface PatchHouseholdInput {
  expectedVersion: number;
  name?: string;
  language?: string;
  timezone?: string;
}

export async function patchHouseholdSettings(context: SessionContext, input: PatchHouseholdInput): Promise<HouseholdSettingsBody> {
  requireManagementRole(context);
  // IANA 校验在事务外(013 起不再有当次密码验证步骤)
  if (input.timezone !== undefined && !isSupportedTimezone(input.timezone)) {
    throw new DomainError(400, ProblemCode.VALIDATION_FAILED, 'timezone 必须是运行环境认可的 IANA 时区');
  }
  return settingsStore().withTransaction(
    (tx) => {
      // 权限快照重验(grant/会话/主档案/三版本)
      requireMainProfileTx(tx, context);
      const row = readHouseholdRow(tx, context.session.householdId);
      if (row.version !== input.expectedVersion) {
        // 旧版本与伪造版本一律 409,不静默覆盖现值
        throw createDomainError('VERSION_CONFLICT');
      }
      tx.updateHouseholdRow(row.id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.language !== undefined ? { defaultLanguage: input.language } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        version: row.version + 1,
      });
      return toHouseholdSettings(readHouseholdRow(tx, context.session.householdId));
    },
    'immediate',
  );
}
