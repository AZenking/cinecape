# shared/hooks —— 共享 util-hook 约定(006 ui-components 契约)

**唯一入口**:本目录(`apps/web/src/shared/hooks/`)。页面/组件**禁止**自带通用
逻辑实现,也禁止直接从 `@mantine/hooks` 散装导入——统一经 `./index.ts` 的
curated allowlist 引入(契约 FR-030/031/033;实施约束见
`docs/specs/006-heroui-react-query-refactor/contracts/ui-components.md`)。

## 两类来源与规则

| 来源 | 规则 |
| --- | --- |
| 开源库 re-export(优先) | 只在 `./index.ts` re-export,不二次封装、不改语义;新增条目先入 allowlist 再使用 |
| 自研 | 必须放本目录;**必须附「为何不采用现成库」理由 + vitest 单测**,缺一不合入 |

## 红线

1. **服务端状态/轮询一律 react-query**(`@tanstack/react-query`):缓存、去重、
   重试、`refetchInterval` 轮询语义归数据层;本目录不提供、也不包装任何取数类 hook。
2. **`@mantine/hooks` 的 `useFetch` 禁用**:与 react-query 职责冲突(无缓存/去重/
   重试/失效机制),不 re-export、不得绕过 allowlist 直接 import。
3. 不在本目录写业务语义 hook(业务 hook 留在对应 feature 目录,如
   `features/live/hooks/use-live-refresh.ts` 的直播轮询语义;其 interval 原语
   已改用本目录 `useInterval`,见下文 T034 决议)。

## 首批 allowlist(@mantine/hooks@9)

| hook | 用途 |
| --- | --- |
| `useDebouncedValue` | 值防抖(搜索输入降频) |
| `useThrottledValue` | 值节流(滚动/指针高频值限频) |
| `useInterval` | 声明式 interval(轮询 interval 语义;服务端状态本体仍走 react-query) |
| `useMediaQuery` | 媒体查询断点响应(已收编原 `features/settings/use-media-query.ts`) |
| `useElementSize` | 元素尺寸观测(ResizeObserver) |
| `useEventListener` | 声明式事件监听 |
| `useLocalStorage` | localStorage 读写状态化 |
| `useClipboard` | 剪贴板复制 + copied 状态 |
| `useFocusWithin` | 焦点是否落于子树 |
| `useDocumentVisibility` | 页面可见性(后台暂停轮询/动画依据) |

按需启用、允许增补:增补 = 在 `./index.ts` 加一行 re-export + 本表登记一行;
删除同理,保持「allowlist 即事实」。

## 库存盘点(T036;名称 → 来源 → 测试)

| hook | 来源 | 测试 |
| --- | --- | --- |
| `useDebouncedValue` | @mantine/hooks@9.7.4(re-export) | `test/unit/shared-hooks.spec.ts` |
| `useThrottledValue` | @mantine/hooks@9.7.4(re-export) | `test/unit/shared-hooks.spec.ts` |
| `useInterval` | @mantine/hooks@9.7.4(re-export) | `test/unit/shared-hooks.spec.ts` |
| `useMediaQuery` | @mantine/hooks@9.7.4(re-export) | `test/unit/shared-hooks.spec.ts` |
| `useElementSize` | @mantine/hooks@9.7.4(re-export) | `test/unit/shared-hooks.spec.ts` |
| `useEventListener` | @mantine/hooks@9.7.4(re-export) | `test/unit/shared-hooks.spec.ts` |
| `useLocalStorage` | @mantine/hooks@9.7.4(re-export) | `test/unit/shared-hooks.spec.ts` |
| `useClipboard` | @mantine/hooks@9.7.4(re-export) | `test/unit/shared-hooks.spec.ts` |
| `useFocusWithin` | @mantine/hooks@9.7.4(re-export) | `test/unit/shared-hooks.spec.ts` |
| `useDocumentVisibility` | @mantine/hooks@9.7.4(re-export) | `test/unit/shared-hooks.spec.ts` |

**自研 hook:当前为零。** 本目录未新增任何自研 hook(allowlist 已覆盖现有需求);
日后自研必须落在本目录、附「为何不用现成库」理由 + vitest,并登记上表。

## T034 决议:直播轮询 interval 原语已收编 useInterval

`features/live/hooks/use-live-refresh.ts` 的手写 `window.setInterval` 已替换为本目录
`useInterval(fn, intervalMs, { autoInvoke: true })`,语义逐条等价(无保留自研,故无
FR-031 免责文书义务,此处仅记录收编事实):

- interval 只在 hook 挂载期间运行(autoInvoke 挂载即启动,卸载经内部 `stop()` 清理);
- `intervalMs` 变更自动重启(等价原 effect 依赖 `[intervalMs]` 的定时器重建);
- 底层同为 `setInterval` 原语,无额外漂移;
- **`LIVE_REFRESH_INTERVAL_MS = 30_000` 服务端契约值不变**(FR-022 下限);
- `visibilitychange`「回前台立即刷新」保持原生 `document.addEventListener`
  (该次收编范围仅限 interval 原语,事件监听语义不动;后续可另行评估 useEventListener);
- 服务端状态轮询本体仍走 react-query(`useAppQuery` + refreshKey→`refetch`),本目录不碰取数。

## T035 评估过、按域保留的通用逻辑(不在本目录收编)

| 位置 | 逻辑 | 保留理由(一句话) |
| --- | --- | --- |
| `features/epg/ProgrammeDetailPanel.tsx` `useIsWide` | 手写 matchMedia 订阅 | 012 T022 起**该文件已删除**(EPG 换挂共享 `shared-programme/ProgrammeDetailPanel`,恒浮层呈现、无断点分支)——原「留待 epg 车道对齐语义后收编」议题随之消失,无收编对象 |
| `features/live/components/MediaScroller.tsx` | ResizeObserver + prefers-reduced-motion | 指令式滚动同步(尺寸变化时重算,非尺寸状态),`useElementSize` 不覆盖;live 域 |
| `features/playback/player-view.tsx` / `use-playback-progress.ts` | setInterval/setTimeout(进度周期上报、重试退避) | 播放进度域定时器(含暂停/退避逻辑),非纯 interval 语义;playback 域 |
| `features/settings/shared/access-expiry.ts` | setTimeout 自校正倒计时循环 | 刻意规避 setInterval 的漂移(每 tick 重算剩余时间),倒计时域逻辑 |
| `app/action-coordinator.tsx` | setTimeout(播放意图编排) | 播放意图状态机内部时序,非通用 util |

另:全仓 grep 无手写 debounce/throttle/localStorage hook(grep 命中的 localStorage
均为「不落 localStorage」的安全注释),无需收编。

## 与数据层的边界

- 服务端数据(`fetch`/缓存/轮询/失败重试):`@tanstack/react-query`
  (数据层 lane 统一落位);错误文案统一经 `shared/query/error.ts` 供给 UI。
- 本目录只服务**纯客户端 util 语义**(防抖、节流、尺寸、可见性、剪贴板等),
  不发起网络请求、不感知业务模型。
