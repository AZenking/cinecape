# ADR-0023：时间处理统一采用 dayjs

- 状态：Accepted
- 日期：2026-11-13
- 适用版本：V1.0+
- 依据：ADR-0014（分层依赖矩阵）、005 data-model §8（EPG 日历日）、016 spec（服务端基准时间）
- 关联：[0020-epg-presentation-scale](0020-epg-presentation-scale.md)

## Context

前后端此前都没有统一的时间库：

- 服务端约 153 处原生 `Date`（`Date.now` / `toISOString` / `Date.parse`），EPG 日历日与 DST 日界依赖 `@internationalized/date`；
- 前端约 60 处原生 `Date`，EPG/直播展示依赖 `@internationalized/date`，历史与设置页又各自用 `Intl`；
- 设置域多处把服务端 UTC ISO 直接截成 `YYYY-MM-DD HH:mm` 展示（`slice(0, 19).replace('T', ' ')`），在中国时区下比本地时间早 8 小时（「上次同步」「最近活跃」等），是用户可见的真实缺陷。

产品决定：前后端时间处理统一采用 dayjs，避免同一语义出现多套写法。

## Decision

1. **两端各设唯一配置入口**，只有它能注册插件，业务代码禁止直接 `import dayjs from 'dayjs'`：
   - 前端 `src/shared/time/dayjs.ts`（`utc` + `timezone` 插件）；
   - 服务端 `src/platform/time/dayjs.ts`（`utc` + `timezone` 插件，导出 `toIso()`；
  `nowMs()` 因无消费方已于 2026-11-16 移除，取时仍走各上下文统一的 `Date.now()` / `liveNowMs()`）。
2. **边界格式不变**：存储与传输仍是 UTC ISO 字符串；`now` 仍由服务端每请求冻结一次（`liveNowMs()`），前端仍先经 `shared/time/server-clock` 校准。
3. **domain 层例外**：`src/contexts/*/domain/**` 不引入 dayjs（007 依赖矩阵禁止 domain → platform），纯函数继续只做 epoch ms 运算；EPG 日历日/DST 日界继续用 `@internationalized/date`（data-model §8 锁定），dayjs 不替代 `CalendarDate` 语义。
4. **platform 白名单修订**：应用层此前只允许 `platform/http-common|config`（ADR-0015 D3）。本 ADR 追加 `platform/time`——它无 IO、无状态，只封装 dayjs 配置与 `toIso/nowMs`；domain 仍禁止。
5. **展示必须显式时区**：跨时区展示一律 `dayjs(iso).tz(家庭 IANA 时区)`，未知时区返回占位（`—`），不用浏览器时区冒充；非法时区回退 UTC 并显式标注。
6. **设置域时间戳统一**：新增 `formatDateTimeInZone()`（`shared/time/format-datetime.ts`）与 `useHouseholdTimezone()`（设置域共享 hook，复用 `settings.household` 缓存），归档/上次同步/设备活跃/原始快照等全部按家庭时区展示。

## 迁移状态（渐进）

| 波次 | 范围 | 状态 |
|---|---|---|
| 1 | 两端依赖与配置入口；服务端 `now`/窗口 ISO 出口（live controller、public guide、guide-window）；设置域 5 个文件的时间戳 | ✅ 已完成 |
| 2 | 前端展示层：`live-format`（HH:mm/区间/时区偏移）已切 dayjs；历史时间、剩余文案待办 | ◐ 部分完成 |
| 3 | 服务端 application/interface 的 ISO 解析与格式化（非 domain） | 待办 |
| — | domain 纯函数与 EPG 日历日 | 保持原生 ms + `@internationalized/date` |

## Consequences

- 设置页时间戳不再早 8 小时；时区来源唯一（家庭设置），不再由浏览器时区决定。
- 每个设置页会多一次 `GET /settings/household`（与家庭设置页共享查询键与缓存，成本可忽略）；时区未就绪时显示占位而不是错误时间。
- 两端各多一个约 7 KB（gzip）的运行时依赖；禁止在 domain 层使用，避免破坏分层与领域纯度。
- 后续新增时间展示应优先复用 `formatDateTimeInZone` / `toIso`，不要再手写 `slice` 截取 ISO。