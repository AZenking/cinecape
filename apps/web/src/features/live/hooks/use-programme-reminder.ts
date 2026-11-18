import { useCallback, useEffect, useState } from 'react';
import { Toast } from '@heroui/react';

/**
 * 节目开播提醒(2026-11-18 设计稿铃铛入口)。
 *
 * 现状约束:服务端没有提醒/推送领域,本期只做**页面会话内的轻量提醒**——
 * - 预约状态存 localStorage(按节目 key 去重),刷新/返回首页后仍保留;
 * - 预约后若本页停留在开播时刻之前,到点用 HeroUI Toast 提示;
 * - 不在页面里时不会推送(没有 Service Worker/Notification 授权链),文案不承诺站外提醒。
 */

const STORAGE_KEY = 'hmp.live.programme-reminders';

function readKeys(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writeKeys(keys: readonly string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // 隐私模式/配额不足:预约只在当前会话内生效,不阻断卡片交互
  }
}

export interface ProgrammeReminder {
  readonly reminded: boolean;
  readonly toggle: () => void;
}

export function useProgrammeReminder(
  programmeKey: string | null,
  title: string,
  startsAt: string | null,
): ProgrammeReminder {
  const [reminded, setReminded] = useState(() => programmeKey !== null && readKeys().includes(programmeKey));

  /* 卡片换档(同一位置渲染不同节目)时按新 key 重读,避免旧预约态残留 */
  useEffect(() => {
    setReminded(programmeKey !== null && readKeys().includes(programmeKey));
  }, [programmeKey]);

  const toggle = useCallback((): void => {
    if (programmeKey === null) {
      return;
    }
    const keys = new Set(readKeys());
    if (keys.has(programmeKey)) {
      keys.delete(programmeKey);
      setReminded(false);
      Toast.toast.info(`已取消《${title}》开播提醒`);
    } else {
      keys.add(programmeKey);
      setReminded(true);
      Toast.toast.success(`已预约《${title}》开播提醒`);
    }
    writeKeys([...keys]);
  }, [programmeKey, title]);

  /* 页面驻留期间到点提醒(仅一次;离开页面即清理) */
  useEffect(() => {
    if (!reminded || startsAt === null) {
      return;
    }
    const delay = Date.parse(startsAt) - Date.now();
    if (!Number.isFinite(delay) || delay <= 0 || delay > 2_147_483_647) {
      return;
    }
    const timer = window.setTimeout(() => {
      Toast.toast.info(`《${title}》即将开始`);
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [reminded, startsAt, title]);

  return { reminded, toggle };
}