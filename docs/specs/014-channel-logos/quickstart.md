# Quickstart: 014-channel-logos 验证指南

日期：2026-11-07。区分「既有可运行检查」与「实现后新增场景」；实现完成前，§3/§4 场景**不存在**，不得伪造已运行。

## 1. 前置条件

- Node >=24、pnpm（仓库 `.nvmrc`/`engines`）；本地已初始化部署实例（至少一个家庭）。
- 一份含 `tvg-logo` 属性的 IPTV M3U 源（可用公开样例改写，构造 3 类频道：有 logo / 无 logo / logo 地址失效）。
- 一份含频道 `<icon>` 的 XMLTV 源（用于 EPG 兜底路径）。
- 管理员身份可在设置中配置 IPTV 与 EPG 源（013 后的设置入口）。

## 2. 既有可运行检查（实现前后均有效）

```bash
pnpm typecheck && pnpm lint
pnpm test                                  # server 单元/契约（Vitest）
pnpm --filter @hmp/web exec vitest run     # web 组件测试
pnpm migration:drill                       # up→down→up 回滚演练（0009 实现后覆盖新迁移）
pnpm gen:types                             # 014 openapi 源接入后校验类型生成
```

## 3. 实现后新增：自动化场景（对应契约清单，未实现不存在）

| 场景 | 层级 | 关联 |
| --- | --- | --- |
| 解析捕获/归一化/坏数据丢弃（M3U tvg-logo、XMLTV icon） | 单元 | FR-001/002/010，SC-005 |
| 胜者合并 M1–M4（iptv 必胜、epg 受限填补、撤销、墓碑 GC） | 单元（发布事务级） | FR-003/009，SC-004 |
| 代理端点五类稳定错误 + 字节透传 + 无上游泄漏 + 缓存头 | 契约（Supertest） | FR-005/006，SC-003；清单见 [api.md §4](contracts/api.md) |
| 组件回退链 6 断言（含 GuideWall img=0 守护） | 组件（Testing Library） | FR-007/008/012，SC-002/SC-006；清单见 [ui.md §4](contracts/ui.md) |
| 迁移 0009 up/down/drill + 备份恢复演练 | 迁移证据 | 宪章技术约束 3 |

## 4. 实现后新增：端到端手工验证（运行时/真实浏览器证据）

1. **US1 主视觉**：导入含 tvg-logo 的源 → 打开 `/live` 与首页直播区块 → 有 Logo 频道显示 Logo；刷新 3 次无闪变。游客窗口（无痕）同样可见（FR-011）。
2. **US2 回退**：同源的「无 logo 频道」显示渐变底板+首字；把源中某频道 logo 改为失效地址并刷新 → 该频道回退底板，无裂图（DevTools Network 可见 502/410，页面无错误提示）。
3. **US4 源同步**：删除源中某频道 logo 属性并刷新 → 该频道回退底板；直接 `curl -i /public/media/logos/<旧ref>` → 410（墓碑窗口内）。换回新地址刷新 → 新 Logo，旧 ref 410。
4. **US3 节目单**：打开节目单 → 频道列头小 Logo；时间轴节目格 0 图片（Elements 面板搜索 `<img`）；收藏频道条目同规则。
5. **US5 泄漏检查**：DevTools Network 全量扫描——所有 Logo 请求均指向 `/public/media/logos/…` 同源路径，0 个第三方地址；对任意伪造 ref `curl` → 404 与「目录不存在」响应形态一致。
6. **缓存行为**：同一频道二次进入直播墙 → DevTools Network 显示 `(disk cache)` 或 304，无上游回源放大（引用键控 max-age=300）。

## 5. 已知边界（验证时不要误判为缺陷）

- 迁移 0009 后、首次源刷新前：所有频道仍无 Logo（零回填是设计行为）。
- Logo 上游本身不可达时：导入成功但该频道回退底板（SC-005 的对照面）。
- `max-age` 窗口内源刚刷新：浏览器可能短暂显示旧 Logo（≤300s），之后收敛；这不是闪变缺陷。

## 6. 证据归档约定（实现阶段执行）

新增证据写入本目录 `evidence.md` / `evidence/`（沿 010 结构）：迁移演练输出、契约测试全量结果、真实浏览器截图/录屏（US1–US5 各至少 1 份）、泄漏扫描记录。宪章要求多层证据：单元 ≠ 运行时 ≠ 真实契约，逐层留证后才可宣称 Verified。
