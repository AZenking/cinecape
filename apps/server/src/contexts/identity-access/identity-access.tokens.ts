/**
 * identity-access 注入令牌集中地（contracts/internal-context-contracts.md §5）。
 *
 * 令牌面 = 跨上下文被消费的应用服务（T020 grep 实测消费清单）：
 * - parent-verification.service（verifyParentPassword）：epg / live-tv / media-catalog /
 *   personal-data / playback / profile / settings 消费；
 * - bootstrap.service（requireManagementRole）：同上；
 * - device.service（listHouseholdDevices / revokeHouseholdDevice）：settings 消费。
 *
 * 本上下文服务为纯函数模块（见 identity-access.module.ts 头注释惯例），无 @Injectable
 * 类；令牌绑定经 useValue 函数束（T021，`satisfies` 对齐对应接口），消费方迁移（T022）
 * 时或经本上下文 index.ts 直接导入函数（R2 合法），或 @Inject(令牌)。
 *
 * infrastructure 纯函数工具（db / password / token）与 interface 层助手（validation /
 * account-session.dto）非应用服务，不经令牌发布，仅经 index.ts 函数/类型再导出
 * （getDb 惰性语义禁止工厂期缓存，见 index.ts 注释）。
 */
export const IDENTITY_ACCESS_PARENT_VERIFICATION_PORT = Symbol('IDENTITY_ACCESS_PARENT_VERIFICATION_PORT');
export const IDENTITY_ACCESS_BOOTSTRAP_PORT = Symbol('IDENTITY_ACCESS_BOOTSTRAP_PORT');
export const IDENTITY_ACCESS_DEVICE_PORT = Symbol('IDENTITY_ACCESS_DEVICE_PORT');
