/**
 * settings 发布面（R2：跨上下文 import 的唯一合法落点）。
 * 白名单：应用服务接口 + 注入令牌 + 跨上下文必需类型；实现类禁止导出。
 */
export type { ISettingsAccessGrantService } from './settings.ports';
export { SETTINGS_ACCESS_GRANT_PORT } from './settings.tokens';

// —— 应用服务纯函数（T020 grep 实测跨上下文消费清单）——
export { requireValidSettingsGrant } from './application/settings-access-grant.service';
