/**
 * profile 发布面接口（contracts 白名单：应用服务接口 + 令牌 + 跨上下文类型）。
 * 方法签名与实现逐字一致（仅提取类型；实现对象在 profile.module.ts 以
 * useValue + satisfies 对齐本文件接口）。
 */
import type { Db } from '@contexts/identity-access';
import type { PinFailureState } from './application/pin.service';

/** identity-transition 发布面（消费方：identity-access / settings） */
export interface IIdentityTransitionService {
  clearDeviceSessionsProfile(
    tx: Db,
    input: { householdId: string; deviceSessionIds: string[]; profileId: string },
  ): void;
}

/** pin.service 发布面（消费方：identity-access bootstrap / settings PIN 校验） */
export interface IPinService {
  readonly PIN_STATE_CLEARED: PinFailureState;
  isPinLocked(pinLockedUntil: string | null, now: Date): boolean;
  registerPinFailure(state: PinFailureState, now: Date, maxAttempts: number, lockMinutes: number): PinFailureState;
  revokeUnlockGrantsForProfile(profileId: string): void;
}

/** profile.service 发布面（消费方：settings profiles 管理） */
export interface IProfileService {
  swapDefault<T extends { id: string }>(
    profiles: T[],
    targetId: string,
  ): Array<Omit<T, 'isDefault'> & { isDefault: boolean }>;
  assertNotLastActiveProfile(activeOtherCount: number): void;
}
