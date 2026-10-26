import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { DomainError, PC_005_PROBLEM_CODES } from '../domain-error';

/**
 * SettingsAccessGuard 占位(T009,005 contracts/api.md §1 Settings 边界;US7 填充)——
 *
 * 目标授权次序(api.md §7「一般设置主体次序」,US7 实现):
 *   存储就绪 → Session → 角色(owner/admin)+ 当前主 Profile → 有效 settings grant
 *   → 严格入参 → 当次密码(敏感操作)→ 重读身份/grant/目标归属/版本 → 事务。
 *
 * T009 只交付可挂载的 fail-closed 占位:任何请求一律 403 SETTINGS_ACCESS_REQUIRED
 * (§7 新码),「未实现授权判定」是明确拒绝而非放行 —— 未实现的设置能力保持拒绝
 * (Phase 2 Checkpoint 语义)。
 *
 * US7 扩展点约定(勿破坏):
 * - 类名 SettingsAccessGuard / 文件名 settings-access.guard.ts 保持不变,
 *   各设置控制器继续 `@UseGuards(SessionGuard, SettingsAccessGuard)` 挂载;
 * - 判定逻辑全部写在 protected authorize()(可注入 grant/pin 服务后改写,
 *   或改为类构造注入 —— 挂载方无需变更);
 * - SETTINGS_PIN_REQUIRED(需 PIN 验证)/SETTINGS_ACCESS_EXPIRED(grant 过期)
 *   等稳定码已在 common/domain-error.ts 登记,US7 直接使用;
 * - 占位期禁止在本 Guard 内放行或缓存任何授权事实。
 */
@Injectable()
export class SettingsAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return this.authorize(context);
  }

  /** 授权判定唯一入口(US7 在此填充;占位实现一律拒绝) */
  protected authorize(_context: ExecutionContext): boolean {
    throw new DomainError(
      403,
      PC_005_PROBLEM_CODES.SETTINGS_ACCESS_REQUIRED,
      '设置访问授权判定尚未实现',
    );
  }
}
