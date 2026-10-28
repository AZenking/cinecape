/**
 * identity-access 发布面（R2：跨上下文 import 的唯一合法落点）。
 *
 * 白名单（contracts/internal-context-contracts.md）：应用服务接口 + 注入令牌 +
 * 跨上下文必需类型/纯函数；实现类、repository、schema、controller 禁止导出。
 * 本文件仅再导出（不新增实现）；消费方深路径迁移属 T022。
 */
export type { IBootstrapService, IDeviceService, IParentVerificationService } from './identity-access.ports';
export {
  IDENTITY_ACCESS_BOOTSTRAP_PORT,
  IDENTITY_ACCESS_DEVICE_PORT,
  IDENTITY_ACCESS_PARENT_VERIFICATION_PORT,
} from './identity-access.tokens';

// —— 应用服务纯函数（T020 grep 实测跨上下文消费清单）——
export { requireManagementRole } from './application/bootstrap.service';
export { verifyParentPassword } from './application/parent-verification.service';
export { listHouseholdDevices, revokeHouseholdDevice, type DeviceDtoBody } from './application/device.service';

// —— 非应用服务面：跨上下文消费的基础设施纯函数/类型再导出 ——
// getDb 必须保持惰性调用语义（Database 单例 close 后重开自动换包装，禁止工厂期缓存），
// 故不以 DI 令牌发布，仅函数/类型再导出。
export { getDb, type Db } from '@platform/database/drizzle';
export { hashPassword, verifyPassword } from './infrastructure/password.service';
export { generateToken, hashToken } from './infrastructure/token.service';
export { parseBody } from './interface/validation';
// T022a 补面：profile/settings 经发布面消费的会话构造纯函数（实现零改动）
export { buildAccountSession, toProfileSummary, type AccountSessionBody, type ProfileSummaryBody } from './interface/account-session.dto';
