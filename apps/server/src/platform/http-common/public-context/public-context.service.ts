import { Injectable } from '@nestjs/common';
import { ProblemCode as ProblemCodeConst } from '@hmp/shared';
import { Database } from '@platform/database/database';
import { DomainError, PC_005_PROBLEM_CODES } from '@platform/http-common/domain-error';

/**
 * PublicContext 解析(T009,005 contracts/api.md §1/§2、data-model.md §9)——
 * 公开范围从「部署存储中的唯一 Household」服务端确定:
 * - 零家庭 → initialized=false(供 GET /setup/status 与 /public/context 使用,
 *   调用方以默认展示值投影,不伪装成已初始化);
 * - 恰一个家庭 → initialized=true,公开投影只含白名单字段(displayName/timezone/language);
 * - 多个家庭 → 部署配置损坏,503 STORAGE_GENERATION_UNSUPPORTED(§7 稳定码,
 *   单家庭部署模型不支持的存储形态);
 * - 存储不可读(表缺失/迁移未就绪等查询异常)→ 503 NOT_READY,绝不伪装成
 *   initialized=false(「初始化状态未知不得开放重复配置」)。
 *
 * 身份隔离:本服务**不读取任何请求输入**(不接收 Request 参数)——
 * query/body 携带 householdId 等匿名身份声明不影响公开范围;范围只来自服务端存储。
 */

/** 已初始化家庭的公开白名单字段(data-model §9:不含账号/Profile/来源) */
export interface PublicHouseholdScope {
  readonly householdId: string;
  readonly displayName: string;
  readonly timezone: string;
  readonly language: string;
}

export type PublicContextResolution =
  | { readonly kind: 'uninitialized' }
  | { readonly kind: 'ready'; readonly household: PublicHouseholdScope }
  | { readonly kind: 'householdCorruption' }
  | { readonly kind: 'storageUnavailable' };

/** 判定范围后供调用方投影的两种合法形态(503 形态以 DomainError 抛出) */
export type PublicContextScope =
  | { readonly initialized: false; readonly household: null }
  | { readonly initialized: true; readonly household: PublicHouseholdScope };

/** 公开家庭字段单查询(零/一/多家庭一次判定;排序仅保证多家庭时结果确定性) */
const HOUSEHOLDS_SQL =
  'SELECT id, name, timezone, default_language FROM household ORDER BY created_at ASC, id ASC';

interface HouseholdRow {
  id: string;
  name: string;
  timezone: string;
  default_language: string;
}

@Injectable()
export class PublicContextService {
  /** 只读解析:返回四态判定结果,不抛错(供调用方细粒度区分 503 原因) */
  resolve(): PublicContextResolution {
    let rows: HouseholdRow[];
    try {
      rows = Database.db.prepare(HOUSEHOLDS_SQL).all() as HouseholdRow[];
    } catch {
      // 表缺失/库未就绪等存储异常:状态未知,不得误判为未初始化
      return { kind: 'storageUnavailable' };
    }
    if (rows.length === 0) {
      return { kind: 'uninitialized' };
    }
    if (rows.length > 1) {
      return { kind: 'householdCorruption' };
    }
    const row = rows[0] as HouseholdRow;
    return {
      kind: 'ready',
      household: {
        householdId: row.id,
        displayName: row.name,
        timezone: row.timezone,
        language: row.default_language,
      },
    };
  }

  /**
   * 范围判定 + 503 抛错(供 /setup/status 与 public context 直接使用):
   * - 多家庭配置损坏 → 503 STORAGE_GENERATION_UNSUPPORTED(§7 稳定码,脱敏文案);
   * - 存储不可读 → 503 NOT_READY(既有码;状态未知 ≠ 未初始化);
   * - 其余返回 initialized 语义与白名单家庭字段。
   */
  requireScope(): PublicContextScope {
    const resolution = this.resolve();
    if (resolution.kind === 'householdCorruption') {
      throw new DomainError(
        503,
        PC_005_PROBLEM_CODES.STORAGE_GENERATION_UNSUPPORTED,
        '部署家庭数量与本代际单家庭模型不符,服务暂不可用',
      );
    }
    if (resolution.kind === 'storageUnavailable') {
      throw new DomainError(503, ProblemCodeConst.NOT_READY, '存储状态未知,暂不能判定初始化状态');
    }
    return resolution.kind === 'ready'
      ? { initialized: true, household: resolution.household }
      : { initialized: false, household: null };
  }
}
