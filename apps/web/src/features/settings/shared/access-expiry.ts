/**
 * 授权过期统一处理(T135,005 contracts/ui.md §7 + FR-040/FR-041;013 ADR-0017 演进):
 *
 * - 管理主体/写入请求得到 403 时统一经 handleAccessLost() 立即隐藏管理主体、终止轮询
 *   (Provider 状态驱动):013 新契约为 403 FORBIDDEN(SettingsGuard isMain 校验);
 *   旧契约 403 SETTINGS_ACCESS_REQUIRED / SETTINGS_ACCESS_EXPIRED 过渡期兼容;
 *   重新选档为主管理员后 Provider 状态翻转,模块重挂硬请求重读现值;草稿不自动提交;
 * - 013/ADR-0017:常规管理运维(来源/策略/家庭设置/档案基本编辑等)免当次密码,
 *   请求体不携带 ownerPassword;单次密码仅保留于高危面(撤销设备/档案 PIN 编辑/
 *   主档案转移)——错误分类中 'password' 分支仅服务这些保留流程,保持原行为;
 * - 改密/主档案转移「成功回调不再继续读取设置主体」:两种操作完成后由页面直接
 *   收尾(notifyPasswordChanged / notifyMainProfileTransferred),不再发起任何
 *   settings 读请求(会话/授予已在服务端失效)。
 */
import { useEffect, useRef } from 'react';
import { isFetchApiError } from '../../../shared/fetch';
import { isAccessLostErrorCode, useSettingsAccess } from '../settings-access-provider';

/** 设置授权丢失错误(403 + FORBIDDEN / SETTINGS_ACCESS_*;判定单点在 Provider) */
export function isAccessLostError(error: unknown): boolean {
  return (
    isFetchApiError(error) && error.status === 403 && isAccessLostErrorCode(error.code)
  );
}

export type SettingsWriteFailureKind =
  | 'access-lost' // 403 FORBIDDEN / SETTINGS_ACCESS_*:立即隐藏主体/终止轮询
  | 'busy' // 409 SOURCE_BUSY:同源已有同步任务,等待而非重读现值
  | 'conflict' // 409:提示冲突,重读现值,不静默覆盖
  | 'password' // 403/423 家长验证 REQUIRED/FAILED/LOCKED(非授权丢失码);013/ADR-0017
  // 起仅高危保留流程可达此分支(撤销设备/档案 PIN/主档案转移),常规运维流程
  // 已免当次密码,不再产生该类失败
  | 'not-found'
  | 'validation'
  | 'error';

/** 服务端错误 → 页面统一处置分类 */
export function classifySettingsWriteError(error: unknown): SettingsWriteFailureKind {
  if (isAccessLostError(error)) {
    return 'access-lost';
  }
  if (isFetchApiError(error)) {
    if (error.status === 409) {
      // 同源并发同步不是版本问题:提示等待任务结束,别让用户误以为要重试
      return error.code === 'SOURCE_BUSY' ? 'busy' : 'conflict';
    }
    if (error.status === 404) {
      return 'not-found';
    }
    if (error.status === 400) {
      return 'validation';
    }
    if (error.status === 403 || error.status === 423) {
      return 'password';
    }
  }
  return 'error';
}

/**
 * 授权感知轮询(T134:任务状态轮询「授权失效即终止」):
 * - 仅在 settings 解锁状态轮询;status 离开 unlocked(过期/撤销)立即停止;
 * - 回调抛出 access-lost 时同样停止并触发 handleAccessLost;
 * - 组件卸载清理;intervalMs 仅控制节奏,授权事实永远以服务端为准。
 */
export function useSettingsPolling(callback: () => Promise<void>, options: { intervalMs: number; enabled: boolean }): void {
  const access = useSettingsAccess();
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const accessLostRef = useRef(access.handleAccessLost);
  accessLostRef.current = access.handleAccessLost;
  const { intervalMs, enabled } = options;
  const unlocked = access.status === 'unlocked';

  useEffect(() => {
    if (!enabled || !unlocked) {
      return undefined;
    }
    let cancelled = false;
    let timer = 0;
    const tick = (): void => {
      void (async () => {
        if (cancelled) {
          return;
        }
        try {
          await callbackRef.current();
        } catch (error) {
          if (isAccessLostError(error)) {
            accessLostRef.current();
            return; // 授权失效:立即终止轮询
          }
          // 业务失败(任务失败等)不终止轮询,由页面呈现
        }
        if (!cancelled) {
          timer = window.setTimeout(tick, intervalMs);
        }
      })();
    };
    timer = window.setTimeout(tick, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, unlocked, intervalMs]);
}

/** 改密/主档案转移成功后的统一收尾提示(成功回调不再读取设置主体) */
export const POST_IDENTITY_CHANGE_NOTICE = {
  password: '密码已修改:旧会话与设置解锁已全部失效,请使用新密码重新登录。本页不再读取设置。',
  mainProfile: '主档案转移已完成:设置授权已全部失效。请关闭设置并在身份菜单重新选档验证,系统不会静默激活新主档案。',
} as const;
