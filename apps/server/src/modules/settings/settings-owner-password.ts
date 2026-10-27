import { ProblemCode } from '@hmp/shared';
import { DomainError } from '../../common/domain-error';
import type { SessionContext } from '../../common/current-session.decorator';
import { verifyParentPassword } from '../auth/parent-verification.service';

/**
 * 设置写路径的当次密码统一入口(T125~T130;ADR-0011「逐次密码不豁免」):
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
