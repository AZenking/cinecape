import { ProblemCode } from '@hmp/shared';
import { DomainError } from '@platform/http-common/domain-error';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { verifyParentPassword } from '@contexts/identity-access';

/**
 * 高危写路径的当次密码统一入口(013-role-differentiated-settings/ADR-0017 起,范围收窄为
 * 「不可逆高危操作」:PATCH /settings/profiles/{id} 的 PIN 变更分支(pin/clearPin)与
 * PUT /settings/main-profile 主档案转移;常规运维(来源/目录/策略/家庭设置/档案创建等)
 * 已全部摘除当次密码闸,不再调用本入口):
 * - 缺失/空串 → 403 PARENT_VERIFICATION_REQUIRED(严格入参之后的当次密码段);
 * - 非空 → verifyParentPassword(错误 403 FAILED / 连续 5 次锁定 423 LOCKED,
 *   沿用既有持久错误计数;成功清零;不发放任何可复用验证态);
 * - 密码只在当次请求 body,不进入地址/日志/持久存储。
 */
export async function verifyOwnerPassword(context: SessionContext, ownerPassword: string | undefined): Promise<void> {
  if (ownerPassword === undefined || ownerPassword === '') {
    throw new DomainError(403, ProblemCode.PARENT_VERIFICATION_REQUIRED, '需要主账号密码完成家长验证');
  }
  await verifyParentPassword(context, ownerPassword);
}
