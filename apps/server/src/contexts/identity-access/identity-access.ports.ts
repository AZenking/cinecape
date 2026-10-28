/**
 * identity-access 发布面接口（contracts 白名单：应用服务接口 + 令牌 + 跨上下文类型）。
 * 方法签名与实现逐字一致（仅提取类型；本上下文服务为纯函数模块，实现对象在
 * identity-access.module.ts 以 useValue + satisfies 对齐本文件接口）。
 */
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import type { DeviceDtoBody } from './application/device.service';

/** parent-verification.service 发布面（消费方：跨上下文 verifyParentPassword） */
export interface IParentVerificationService {
  verifyParentPassword(context: SessionContext, password: string): Promise<void>;
}

/** bootstrap.service 发布面（消费方：跨上下文 requireManagementRole） */
export interface IBootstrapService {
  requireManagementRole(context: SessionContext): void;
}

/** device.service 发布面（消费方：settings settings-devices.controller） */
export interface IDeviceService {
  listHouseholdDevices(householdId: string): DeviceDtoBody[];
  revokeHouseholdDevice(householdId: string, deviceId: string): void;
}
