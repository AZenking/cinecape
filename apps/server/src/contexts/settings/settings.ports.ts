/**
 * settings 发布面接口（contracts 白名单：应用服务接口 + 令牌 + 跨上下文类型）。
 * 方法签名与实现逐字一致（仅提取类型；实现对象在 settings.module.ts 以
 * useValue + satisfies 对齐本文件接口）。
 */
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import type { SettingsGrantValidation } from './application/settings-access-grant.service';

/** settings-access-grant.service 发布面（消费方：platform settings-access 守卫） */
export interface ISettingsAccessGrantService {
  requireValidSettingsGrant(context: SessionContext): SettingsGrantValidation;
}
