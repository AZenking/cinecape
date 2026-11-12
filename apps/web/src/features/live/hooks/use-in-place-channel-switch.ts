import { useCallback, useRef } from 'react';
import { useNavigate } from 'react-router';

/**
 * 就地换台编排(T017;015 research.md R4「纯客户端无刷新换台」、
 * contracts/routing-and-url-state.md §2.4「动态切台参数同步」、
 * data-model.md §3.1「Playing → Resolving 就地切流状态转移」、FR-013):
 *
 * 点击同类频道卡片的三步编排收口为本 Hook,LiveWatchPage 只消费:
 * 1. 立即以新 mediaId 发起播放(onActivate 由页面接 usePlayAction().play)——
 *    play() 新意图即时取代旧意图(ActionCoordinator 既有「准备中换目标」代次守卫),
 *    这就是就地换流的机制基础:页面组件与播放面浮层均不卸载、不整页重载;
 * 2. `navigate(`/live/watch/${mediaId}`, { replace: true })` 静默同步地址栏
 *    (replace 不产生历史条目,F5/分享 URL 语义与「正在看」一致);
 * 3. 顺序遵 R4:先起播后同步 URL;同一 mediaId 重复点击零操作(已是当前频道)。
 *
 * 页面侧反重入配套(T016):自动起播 effect 以「已激活频道 ref」守卫,
 * 由本 Hook 换台抵达的新 :channelId 不再触发第二次自动起播(意图已在此发起)。
 * 回调经 ref 镜像保持 switchTo 引用稳定,不影响下游 memo/依赖数组。
 */

export interface InPlaceChannelSwitchOptions {
  /** 当前路由 :channelId(useParams);undefined = 未挂载于路由参数(不守卫重复) */
  readonly activeChannelId: string | undefined;
  /**
   * 以目标频道发起播放(页面接 usePlayAction().play;title 为频道显示名,
   * 调用方拿不到时传 null,由页面以 channelId 兜底)。
   */
  readonly onActivate: (mediaId: string, title: string | null) => void;
}

export interface InPlaceChannelSwitchApi {
  /**
   * 就地换台:立即以新 mediaId 起播(新意图取代旧意图 = 换流)+ replace 静默同步
   * 地址栏;整页零重载。目标即当前频道时零操作。
   */
  readonly switchTo: (mediaId: string, title: string | null) => void;
}

export function useInPlaceChannelSwitch(options: InPlaceChannelSwitchOptions): InPlaceChannelSwitchApi {
  const { activeChannelId, onActivate } = options;
  const navigate = useNavigate();
  // onActivate 经 ref 镜像:switchTo 引用稳定,页面无须因其变化重连回调
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;

  const switchTo = useCallback(
    (mediaId: string, title: string | null): void => {
      if (mediaId === activeChannelId) {
        return; // 已是该频道:零操作(不重复发意图、不重复改地址)
      }
      // 1. 先起播(R4 步骤 1):新播放意图即时取代旧意图 = 就地换流
      onActivateRef.current(mediaId, title);
      // 2. 后同步地址(R4 步骤 3):replace 无历史条目,整页不重载、组件不卸载
      void navigate(`/live/watch/${encodeURIComponent(mediaId)}`, { replace: true });
    },
    [activeChannelId, navigate],
  );

  return { switchTo };
}
