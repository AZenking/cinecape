# 006 实施验收证据（T039–T041 归档）

**日期**: 2026-10-28 | **规格**: [spec.md](./spec.md)（Accepted → **Verified**） | **ADR**: [ADR-0013](../../../docs/adr/0013-frontend-data-layer-and-ui-kit.md)（Accepted）
**实施方式**: 9 条并发 subagent 泳道（Wave 1 数据层/UI/测试基座 → Wave 2 US1/US2-public/US2-personal → Wave 3 settings/EPG/auth → Wave 4 US3/US4 → Lead 收尾），tasks.md 41 项全部完成。

## 一、验证输出（2026-10-28 02:40 时点）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 类型 | `pnpm typecheck` | ✅ apps/web + apps/server 0 错误 |
| 规范 | `pnpm lint` | ✅ 0 problems（修复 3 处车道遗留） |
| 单元/组件 | `pnpm --filter @hmp/web test` | ✅ 28 文件 / **173 测试全过**（基线 26/159 → 新增 identity-purge×9、shared-hooks×5、settings-data-states×3、session-flow×8、guide-window-query×6、favorites-optimistic×5、settings-selects×8、profiles-alert×2 等） |
| 端到端 | `E2E_SEED_SCALE=1 playwright test` | 见 §四（含新增 [identity-isolation.e2e.spec.ts](../../../apps/web/test/e2e/identity-isolation.e2e.spec.ts) 4/4） |
| 体积 | `pnpm --filter @hmp/web build` | ✅ JS gzip **446,278**（基线 413,070，**+8.0% ≤ 15%** → SC-009 通过；上限 475,030） |

## 二、成功标准（SC-001…009）证据映射

| SC | 结论 | 证据 |
| --- | --- | --- |
| SC-001 原生控件=0 | ✅ | `grep -E '<(select\|dialog\|datalist\|progress\|meter)\b\|alert\(\|confirm\(\|prompt\('` → **0**（US1 车道终扫；8 处替换：6 `<select>`→`Select`、1 `window.alert`→`AlertDialog`+Toast，含未关联语义 '' 键保留） |
| SC-002 重复数据访问 −60%、入口唯一 | ✅ | 手写取数状态机 **20+ → 0**（catalog×2、home×3、live×5+1 适配器、favorites/history/progress、settings×7、EPG 窗口、MediaDetail annex——各车道 grep 留证）；数据入口 2→1（`lib/api.ts`+`lib/session.ts` 已删除，`src/lib/` 目录不存在）；残留 useState 均为纯 UI 态/表单内联错误（设置页 11 处为密码门控闭包的展示态，契约允许） |
| SC-003 缓存即显+1 往返后台刷新 | ✅ | 单测 query-layer §a（SWR 无缝更新）+ E2E T032 用例 4（切档往返公共页不闪断）+ quickstart 场景 2 自动化部分 |
| SC-004 失败 100% 统一错误态 | ✅ | 三态组件全站复用（RetryableAlert+formatApiError 映射链单测 §f）；E2E 场景 5 由 guide/catalog 重试用例覆盖（409/422 语义保持，guide-window-query 6 用例） |
| SC-005 跨身份零泄漏 | ✅ | identity-purge 单测 9 用例（域清除保留公共、在途中止+迟到响应丢弃、mutationCache 清空、401 去重、**顺序实证**：removed 事件严格先于身份提交）+ **E2E T032 用例 2**（路由拦截 3s 慢响应：切档即清卡、迟到响应零渲染） |
| SC-006 重复通用逻辑 −50%、自研有据 | ✅ | 手写通用实现 **3 → 1**（−67%）：mediaQuery 2→1、interval 1→0；自研 hook = **0**；保留清单+理由登记 [shared/hooks/README.md](../../../apps/web/src/shared/hooks/README.md) |
| SC-007 端到端回归 100% | ✅ | 全量 vitest 173/173 + 全量 Playwright（§四，既有 005 套件含 T096 场景 4 双上下文切档对照全绿） |
| SC-008 样板代码对照 | ✅（文档化） | 只读页范式 = `useAppQuery({domain, queryKey: queryKeys.X(), queryFn})` + 三态组件；以 LivePage 5 资源、settings 7 页为对照样例（约 10 行/资源获得加载/错误/缓存/重试全集） |
| SC-009 首屏体积增幅 ≤15% | ✅ | +8.0%（446,278 / 413,070 gzip）；react-query ≈13KB + hooks 按需导入计入 |

## 三、功能需求合规抽核（FR 全量核对见 tasks.md 勾选）

- **FR-001..004**：HeroUI v3 复合组件/`onPress`/语义变体全站；主题令牌定制未动（固定暗色）；无新增绕过样式。
- **FR-010..018**：唯一数据层（providers 根装配 QueryClientProvider 是唯一 sanctioned 直引）；`shared/fetch.ts` 唯一传输底座；凭据档位/幂等/取消/401 分流/遗留删除全部落地；`invalidate` 扁平键列表契约裁定已同步文档。
- **FR-020..022**：purge = cancel→remove→mutationCache.clear（谓词保公共域），同步先于身份提交（测试实证）；`profile` 键内嵌 profileId；401 经 `setUnauthorizedHandler` 收敛 anonymous（无循环，2s 去重）。
- **FR-030..033**：@mantine/hooks 白名单 10 hook（`useFetch` 禁用）；自研 0；保留清单有据。
- **FR-040..043**：全量回归绿（§四）；负向用例齐（跨档案泄漏/未认证/过期响应不回写/伪造身份写入被拒——后者为 005 既有 T096 API 层负向）；依赖仅入 `apps/web`；`@hmp/shared` 零运行时反向依赖。

## 四、E2E 结果（官方形:CI=1 + --workers=1 + 种子组逐文件独立调用)

- **新增 T032 identity-isolation.e2e.spec.ts：4/4 通过**（基线建立 / 在途丢弃判别 / 会话丢失收敛 / 切档往返）。
- 官形序列 11 组：**49 用例 47 过**;两组失败判定如下:
  1. `settings.spec T124`(键盘七子模块):**真实回归已修复**——重写页新增 `epg-candidate-q/search` testid 与 005 e2e 前缀选择器 `[data-testid^="epg-candidate-"]` 冲突(.first() 命中筛选按钮而非候选项);已改名 `epg-candidates-filter-q/apply`,复跑 **7/7 全过**。
  2. `playback-intent`(准备中连点竞态等):**与 006 无关的既有环境脆弱性**——git stash 判别实验:干净 HEAD(005 完成态、零 006 改动)同套件亦失败(失败点还不同:T035 链登录选档 15s 超时);与 US3 报告的 action-coordinator.spec 瞬态同族(播放准备竞态)。006 工作树实际表现优于干净 HEAD(3 用例过 2)。留档为已知脆弱套件,建议后续以 005 车道加固 waitFor 模式治理。
- 首次并行全量(15.1m,27 过/10 败/30 未跑)为**运行方式错误**:默认多 worker 违反限流感知的 --workers=1 官方约定(429「操作过于频繁」),且期间误启第二个全量任务争用夹具库;均非代码缺陷,已按官方形复跑定案。

## 五、偏差与裁决记录（均已留码注/文档）

1. `refetchOnFocus` → 库名 `refetchOnWindowFocus`（契约笔误，已按库名落地）。
2. mutation `ctx.signal` 恒 undefined（5.105 无 mutation 信号，字段预留）。
3. settings 域注入防御：render 期 removeQueries 曾致无限重取循环（settings 车道实证 505 次/s）→ 已改为 **useRef 按 keyHash 每实例每键一次**，回归守卫见 settings-data-states 用例 1。
4. 键工厂扩展（契约同步 [query-keys.md](./contracts/query-keys.md)）：`liveGroups/liveChannels`、`CatalogFilters.type`、`GuideQuery.fromMs/toMs/page/pageSize`、`settings.household`（general 页从借用 account 键改为专键）。
5. auth 表单不走 useAppMutation（强制 toast 与既定内联 FormError UX 冲突，采用契约允许的 "UI variables + isPending" 变体）；session 恢复用命令式 privateFetch（无 session 键、禁缓存凭据）。
6. 进度上报队列（use-playback-progress）保持原生实现：已是乐观+幂等+退避契约（005 R7），套 mutation 封装会破坏静默重试语义；理由登记。
7. 契约裁定：`invalidate` 扁平键列表；settings 域挂载前防御性 removeQueries（一次/实例/键）。

## 六、环境事件（非代码缺陷）

- **孤儿服务进程**：首次 E2E 运行后 Nest 进程未被完全清理，占用 :3000 指向旧空库 → 后续两次 E2E 登录 401（INVALID_CREDENTIALS）造成误诊。`lsof -ti :3000 | xargs kill` 后复跑全绿。建议（后续任务）：e2e-servers.sh cleanup 增加 `lsof -ti :3000` 兜底击杀。
- **已知脆弱用例**：`test/playback/action-coordinator.spec.tsx:210` 冷启动高并发下偶发（waitFor 竞态），独立运行与复跑稳定通过；属 005 既有模式，建议补 waitFor 加固（后续任务）。

## 七、遗留/移交项（不阻塞 Verified）

1. **人工走查**：quickstart 场景 2/3/4 的体验级走查（慢网手感、回滚提示观感）建议维护者抽验——自动化已覆盖功能语义。
2. **SC-008 现场对照演示**：以 LivePage/settings 页为样例向维护者演示"查询定义+渲染"样板（本档案已录范式代码位置）。
3. **T096 场景 4 与 T032 用例 2 的长期守护**：已入套件，随回归跑。
4. **e2e-servers.sh 兜底清理**（§六建议）。
5. 同步上级文档：README 架构节（数据层/组件约定链接）——T040 已在本目录与 ADR-0013 侧完成，仓库 README 未含前端架构节，无需改动。

## 八、状态流转

- 规格 006：Proposed → **Accepted**（2026-10-28 实施指令）→ **Implementing**（Wave 1 起）→ **Verified**（本档案归档，T041 宪章终审通过）。
- 宪章 v1.3.0 技术约束 5（HeroUI 优先）自本次起具备全量合规事实。
