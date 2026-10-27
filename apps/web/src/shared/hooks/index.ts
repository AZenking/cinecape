/**
 * 共享 util-hook 唯一出口(006 ui-components 契约「共享 Hooks 契约」,FR-030/031/033)。
 *
 * 定位与红线(详见 ./README.md):
 * - 服务端状态/轮询一律 react-query(@tanstack/react-query),本目录不提供、
 *   也不包装任何取数类 hook;
 * - `@mantine/hooks` 的 `useFetch` 禁用(取数语义与 react-query 冲突,且无缓存/
 *   去重/重试),不在此 re-export;
 * - 本文件只做开源库 re-export(curated allowlist),不自研实现;
 *   自研 hook 必须放本目录并附「为何不采用现成库」理由 + vitest 单测。
 */

/**
 * @mantine/hooks@9 curated allowlist(只 re-export,不二次封装):
 *
 * - useDebouncedValue      值防抖(搜索输入等高频值降频)
 * - useThrottledValue      值节流(滚动/指针等高频值限频)
 * - useInterval            声明式 interval(已收编 use-live-refresh 的 interval 原语,
 *                            30s 契约值不变;服务端状态轮询本体仍走 react-query refetchInterval)
 * - useMediaQuery          媒体查询断点响应(已收编:原 features/settings/use-media-query.ts
 *                            已删除,消费方 SettingsLayout 经本出口引入)
 * - useElementSize         元素尺寸观测(ResizeObserver)
 * - useEventListener       声明式事件监听(自动随依赖挂/卸)
 * - useLocalStorage        localStorage 读写状态化(SSR 安全)
 * - useClipboard           剪贴板复制(+ copied 状态)
 * - useFocusWithin         焦点是否落于子树(组合键/焦点区判断)
 * - useDocumentVisibility  页面可见性(后台暂停轮询/动画的依据)
 */
export {
  useClipboard,
  useDebouncedValue,
  useDocumentVisibility,
  useElementSize,
  useEventListener,
  useFocusWithin,
  useInterval,
  useLocalStorage,
  useMediaQuery,
  useThrottledValue,
} from '@mantine/hooks';
