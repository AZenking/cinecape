/**
 * 连播开关(010 T065;全局设置,ui.md §3/§5 语义取本地门并注释):
 *
 * - 语义选择:客户端「本地门」—— 关闭时 FinishReceipt 回执不再进入
 *   useVodAutoplay(不倒计时/不取计划/不建意图);服务端偏好
 *   (GET /me/vod/preferences,autoplayNext)是消费时的重验事实(api.md §5,
 *   use-vod-autoplay 已实现),本地门只提前收口 UI,两者相与;
 * - 持久化:localStorage 键 `hmp.vod.autoplayNext`('1'/'0',缺省开)。仅存
 *   UI 偏好布尔,不含凭据/身份/票据/URL(会话令牌与播放票据的既有禁令不受影响);
 * - 归属:Provider 由 ActionCoordinator(全局播放唯一协调器,ui.md §2)挂载;
 *   开关状态 UI 入口在播放面头部(非阻塞),本地门读取在 PlayerView;
 *   独立成模块避免 app↔features 循环导入。
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/** localStorage 键(仅布尔偏好;'0'=关,缺省开) */
const STORAGE_KEY = 'hmp.vod.autoplayNext';

export interface VodAutoplayPreferenceApi {
  /** 连播开关当前值(true=开) */
  readonly autoplayNextEnabled: boolean;
  /** 切换开关(状态 + localStorage 持久;持久失败仅本次会话内存生效) */
  readonly setAutoplayNextEnabled: (enabled: boolean) => void;
}

function readStoredEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true; // 存储不可用(隐私模式等):缺省开,服务端偏好消费时仍重验
  }
}

const VodAutoplayPreferenceContext = createContext<VodAutoplayPreferenceApi | null>(null);

export function VodAutoplayPreferenceProvider({ children }: { children: ReactNode }): ReactNode {
  const [autoplayNextEnabled, setEnabledState] = useState<boolean>(readStoredEnabled);
  const setAutoplayNextEnabled = useCallback((enabled: boolean): void => {
    setEnabledState(enabled);
    try {
      window.localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
    } catch {
      // 持久化失败不阻塞开关:本次会话内存生效,下次启动回缺省
    }
  }, []);
  const value = useMemo(
    () => ({ autoplayNextEnabled, setAutoplayNextEnabled }),
    [autoplayNextEnabled, setAutoplayNextEnabled],
  );
  return <VodAutoplayPreferenceContext.Provider value={value}>{children}</VodAutoplayPreferenceContext.Provider>;
}

/** 开关状态入口(播放面头部开关按钮;必须位于 Provider 内) */
export function useVodAutoplayPreference(): VodAutoplayPreferenceApi {
  const value = useContext(VodAutoplayPreferenceContext);
  if (value === null) {
    throw new Error('useVodAutoplayPreference 必须在 <VodAutoplayPreferenceProvider>(ActionCoordinator)内使用');
  }
  return value;
}

/** 本地门读取(PlayerView;无 Provider 的直挂环境缺省开,服务端偏好仍为准) */
export function useOptionalAutoplayNextEnabled(): boolean {
  const value = useContext(VodAutoplayPreferenceContext);
  return value?.autoplayNextEnabled ?? true;
}
