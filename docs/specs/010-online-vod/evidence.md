# 010 FR/SC 证据矩阵（T089 维护）

> 最后更新：2026-10-31（Asia/Shanghai）。维护任务：tasks.md **T089**（Phase 8 文档同步）；**T091**（Phase 8 终审）复核订正并追加 §2.1/§4。
> 诚实纪律：本文只记录**实际执行**的实现面与证据；Not-run 不计完成、不虚标 Verified。状态按 constitution `Accepted → Implementing → Verified` 流转，010 当前为 **Implementing（实现完成、验证中）**——SC-008 要求的真实浏览器+目标 Linux 容器证据（T088）未执行，整 feature 不满足 Verified。
>
> - **实现面**：已交付的测试文件+用例数；全量回归见 [evidence/release-checks.md](evidence/release-checks.md)（server unit **1484/1484** · contract **730/730** · web vitest **265/265**，2026-10-31）。
> - **证据**：真实执行的记录文档（evidence/ 目录）。
> - **Not-run**：真实环境采样未执行；各自的**单测/契约等价断言已全绿**，但 quickstart 要求的真实采样不存在，`evidence/us2-resume.md`、`us3-autoplay.md`、`us4-switch.md`、`runtime-network.md` 均未生成。

## 0. 总览

- **FR001–040**：40/40 有实现面且自动化断言全绿；无 FR 级 Not-run（真实采样类验收集中在 SC 层）。
- **SC001–008**：**0/8 完全 Verified**。7/8 有服务端或受控环境已执行证据（SC-001 服务端面、SC-002/003/004/005/006 契约面、SC-007 视觉层1），SC-008 整体 Not-run。
- **Not-run 清单**：T035（us1-browse 20 次搜索/每源 100 样本，spec 与证据文档均未生成）、T050（us2-resume 20 次±3s）、T066（us3-autoplay 真实连播 10 组）、T076（us4-switch 两真实来源 10 次 carry）、T088（runtime-network 目标 Linux 容器）5 项采样任务；[visual-accessibility.md](evidence/visual-accessibility.md) 2 项（awaitingGesture 真实交互、真实屏幕阅读器播报）；[us5-global.md](evidence/us5-global.md) Q9/Q7 e2e 用例 2–6（断言面就绪，本机 VPN fake-IP DNS 不具备稳定通过条件，干净 DNS 一条命令可复跑）；T077 的 `apps/web/test/vod-global-playback.spec.tsx` 未创建（该文件名下覆盖已部分落于 identity-purge/online-vod-global 断言面，见 §4 终审记录）。

## 1. FR 证据矩阵

「实现面」仅列主要钉面文件；各文件用例数为 `it()/test()` 计数。除单独标注外，状态均为 **已实现+自动化全绿**。

| FR | 需求摘要 | 实现面（测试文件+用例数） | 证据/Not-run 标注 |
| --- | --- | --- | --- |
| FR-001 | 来源配置/测试/改名/启停（Settings+当次密码） | `contract/online-vod-catalog.e2e-spec.ts` A 组（36 例文件）、`web/test/settings-vod-sources.spec.tsx`（6） | release-checks §0 |
| FR-002 | 游客搜索/浏览，无个人数据/凭据 | catalog B/C 组 + `contract/online-vod-auth-boundaries` A 组（21 例文件）+ `web/test/online-vod-catalog.spec.tsx`（13） | release-checks §0 |
| FR-003 | 区分无匹配/部分失败/全失败，有界分页/取消 | catalog B 组；`unit/online-vod/search-preview.spec.ts`（16）；`web/test/catalog-state.spec.tsx`（10）；budgets A 组 | [performance.md](evidence/performance.md) A1/A2 |
| FR-004 | 预览不扩库；认证意图才登记，成功即入公共目录 | `contract/online-vod-materialization.e2e-spec.ts`（18）+ `unit/online-vod/materialization-service.spec.ts`（13）；catalog 公共面 | release-checks §0 |
| FR-005 | 登记与重试结果原子；同 key 复用/异摘要冲突 | materialization A/C 组（每步故障回滚注入）；unit-of-work（6） | release-checks §0 |
| FR-006 | 成功结果 24h 重放，不依赖旧预览 | materialization A/B 组；`contract/online-vod-retention.e2e-spec.ts` A 组（9 例文件） | release-checks §0 |
| FR-007 | 配额上限明确拒绝；未引用登记 24h 后回收 | materialization B 组；retention A/B 组；`unit/online-vod/vod-retention-sweep.spec.ts`（15） | release-checks §0 |
| FR-008 | 家庭/Profile/context 隔离，客户端不可指定身份 | `contract/online-vod-transition-revocation.e2e-spec.ts` A/B 组（15 例文件）；auth-boundaries；`web/test/vod-identity-guards.spec.tsx`（5）+ `unit/identity-purge.spec.tsx`（9） | [us5-global.md](evidence/us5-global.md) §7 |
| FR-009 | 每目标独立服务端鉴权，测速成功不授予权限 | `unit/playback/authorization.spec.ts`（37）；next-transition C 组；security A 组 | release-checks §0 |
| FR-010 | 父子策略事实/名单覆盖语义（禁止优先等） | 既有 policy 套件（policy-authorization/-lists/-atomicity）+ `playback-policy-resource-rejection.e2e-spec.ts`（6）+ 010 catalog/materialization 内策略分支 | release-checks §0 |
| FR-011 | 分集身份与临时地址分离；不自动合并 | `unit/online-vod/provider-parser.spec.ts`（34）+ `episode-sequence.spec.ts`（21）+ `source-match.spec.ts`（31） | release-checks §0 |
| FR-012 | 定位/检查/交付同一有效输入，修订变化终止 | `unit/playback/vod-input-binding.spec.ts`（28）+ `vod-delivery-input.spec.ts`（13）；progress-resume A 组 | release-checks §0 |
| FR-013 | 陈旧输出/旧票据不生效；取消/回收有界可恢复 | transition-revocation A–C 组；`unit/playback/transition-cleanup.spec.ts`（12）+ `vod-lifecycle-watchdog.spec.ts`（17）；retention | release-checks §0 |
| FR-014 | 实际播放+首样本接受才建历史；seq 单调幂等 | `contract/online-vod-progress-resume.e2e-spec.ts` B/C 组（27 例文件）；`unit/personal/vod-progress-write.spec.ts`（12）+ `progress-write-machine.spec.ts`（15） | release-checks §0 |
| FR-015 | 投递确认/会话接受/历史更新分别表示 | progress-resume B 组（ProgressReply 8 键面；applied 只指历史写入）；`playback.controller.ts` 恰 3/8 键投影断言 | release-checks §0 |
| FR-016 | 普通源 operational 连续性续播 | `unit/online-vod/continuity-resume.spec.ts`（29） | Not-run：真实停止/重开采样属 T050 |
| FR-017 | 「可尝试续播」+确认失败原因展示 | continuity-resume + `web/test/vod-resume.spec.tsx`（9）；progress-resume resumeDisposition 面 | Not-run：真实落点±3s 属 T050/T088 |
| FR-018 | 续播只读本 Profile 历史；停止/重启/跨设备 | progress-resume A/C 组 + `unit/personal/progress-stop-resume.spec.ts`（11） | Not-run：20 次采样属 T050 |
| FR-019 | 自然完成/接近结尾/未完成可区分；末30秒仅提示 | `unit/playback/vod-completion.spec.ts`（32）+ `vod-start-position.spec.ts`（27） | 语义即「不因最后30秒强制从头」；真实验证属 T088 |
| FR-020 | 时长差异容差，禁止百分比映射 | continuity-resume + vod-start-position | Not-run：真实时长变化采样属 T050 |
| FR-021 | 起点恰一服务端依据，一次冻结 | `unit/playback/vod-start-position.spec.ts`（27）+ switch C 组 | release-checks §0 |
| FR-022 | 会话级结束结果，stop 终态不推导完成 | `contract/online-vod-finish.e2e-spec.ts` B/C 组（25 例文件）+ `unit/playback/vod-finish-service.spec.ts`（16） | release-checks §0 |
| FR-023 | 自然结束提示参与完成判断的资格条件 | finish B 组 + vod-completion | Not-run：真实连播资格采样属 T066 |
| FR-024 | 末段连续播放检查（0.5–2 倍速/seek 到尾/补报） | `unit/playback/phase-observation.spec.ts`（18）+ vod-completion + finish C 组 | Not-run：倍速/真实播放属 T066/T088 |
| FR-025 | 连播默认开、Profile 持久、同源同线确定下一集 | `contract/online-vod-next-transition.e2e-spec.ts` A/B 组（34 例文件）；`unit/online-vod/episode-sequence-publish.spec.ts`（5）；`unit/personal/vod-preferences.spec.ts`（8）；`web/test/vod-autoplay.spec.tsx`（21） | Not-run：真实连播属 T066 |
| FR-026 | 5 秒可取消倒计时；关开关/切档不启动 | next-transition B 组 + `web/test/vod-autoplay.spec.tsx`（21）+ [visual-accessibility.md](evidence/visual-accessibility.md) §3.4 | 真实浏览器倒计时交互层1已执行（视觉 §3.4） |
| FR-027 | 下一集独立授权；历史选择不自动覆盖 | next-transition A–C 组 + `web/test/vod-autoplay.spec.tsx`（历史询问面） | Not-run：真实受限下一集采样属 T066 |
| FR-028 | awaitingGesture「点击播放」；60s 释放 | finish A 组（observations/playbackStarted）+ `web/test/vod-autoplay.spec.tsx`（21）+ `vod-lifecycle-watchdog.spec.ts`（17） | **Not-run**：真实 NotAllowedError 交互证据（visual §3.7，组件级已钉面） |
| FR-029 | 换源候选/测速（≤3、无票无历史） | `contract/online-vod-switch.e2e-spec.ts` A/B 组（23 例文件）+ `unit/online-vod/switch-candidates.spec.ts`（22）+ `switch-probe.spec.ts`（14）；`web/test/vod-switch.spec.tsx`（25） | release-checks §0 |
| FR-030 | 匹配充分性（high/ambiguous/conflict） | `unit/online-vod/source-match.spec.ts`（31）+ switch A 组 + `web/test/vod-switch.spec.tsx`（徽标/禁用面） | [visual-accessibility.md](evidence/visual-accessibility.md) §3.3 |
| FR-031 | carry 只取本会话已接受样本（I2 checkpoint） | switch C 组 + progress-resume B 组 | Not-run：两真实来源 carry 采样属 T076 |
| FR-032 | 仅投递不得显示已保存；回退/从头提示 | switch C 组（SOURCE_PROGRESS_PENDING 面）+ `web/test/vod-switch.spec.tsx` | release-checks §0 |
| FR-033 | 可等待过渡结果；不重复载荷 | `unit/playback/transition-service.spec.ts`（18）+ `transition-store.spec.ts`（21）+ next-transition C 组；`web/test/playback/action-coordinator.spec.tsx`（5） | release-checks §0 |
| FR-034 | 停前失败可恢复；≤1s 保存尝试 | transition-switch（23）+ transition-resolve（15）；`unit/identity-purge.spec.tsx` + `web/test/e2e/online-vod-global.spec.ts` 用例 3/4（断言面） | **Not-run**：弱网退出/切档 e2e（us5-global §9.4 用例 3/4 未运行） |
| FR-035 | intent 绑定/60s TTL/消费重验 | next-transition A/B 组 + transition-revocation B 组 | release-checks §0 |
| FR-036 | 单后继 slot 整体成功/失败；显式替换 | transition-store（21）+ transition-revocation A 组 + next-transition C 组 | release-checks §0 |
| FR-037 | 重试返回原结果；取消输家找回/停止 | transition-revocation A 组（找回/cleanup）+ `unit/playback/transition-cleanup.spec.ts`（12） | release-checks §0 |
| FR-038 | carry 不合并历史；不自动轮换绕过策略 | switch C 组 + auth-boundaries/security 策略面 | release-checks §0 |
| FR-039 | 私有响应不进公共缓存；无来源/他档泄露 | `contract/online-vod-security.e2e-spec.ts`（18：SSRF/泄露/未知字段/大体积）+ `unit/online-vod/safe-upstream.spec.ts`（58，T091 执行复核） | [migration-recovery.md](evidence/migration-recovery.md) §0（日志脱敏） |
| FR-040 | 全局非阻塞播放；导航不断播；身份变化收口 | `web/test/vod-identity-guards.spec.tsx`（5：普通路由不清理/游客零个人键）+ `unit/identity-purge.spec.tsx`（9）+ `web/test/e2e/online-vod-global.spec.ts`（6 用例） | **Not-run**：20 次导航 e2e 断言面就绪、运行受阻（[us5-global.md](evidence/us5-global.md) §9.4/§10） |

实现面补充：010 契约套件合计 **259 例**（online-vod-* 12 文件，T091 逐文件计数复核一致）、`unit/online-vod` **273 例**（12 文件，执行口径，T091 复核——safe-upstream 44 it + 2 it.each 展开 = 58）、`unit/playback` vod-*/transition-* 相关 **≈250 例**、`unit/personal` vod 相关 **20 例**、web vitest 010 面约 **103 例**（上列 web 文件，T091 逐文件计数）；既有 policy/playback/公共面套件随 010 扩展同步扩展。全量口径以 release-checks 为准。

## 2. SC 证据矩阵

| SC | 内容摘要 | 已执行证据（样本/结果） | Not-run / 缺口 |
| --- | --- | --- | --- |
| SC-001 | 3 健康+1 超时源，19/20 搜索 ≤8s，部分失败区分 | 服务端期限/并发/预算面：[performance.md](evidence/performance.md)（A1 全链 8,340ms 落 8s 期限、A2 峰值在飞=3；12/12 绿×3 轮）+ catalog B 组 | **Not-run**：浏览器 20 次全量采样与脱敏 Network 证据（T035/T088 范围） |
| SC-002 | 续播 19/20 ±3s，含重启/两设备 | 等价断言：continuity-resume 29 + progress-resume 27 + vod-resume 9 + vod-start-position 27 全绿 | **Not-run**：T050 真实 20 次±3s 采样（us2-resume.md 未生成） |
| SC-003 | 10 组正常结束各只启动一次；负向组不误启动 | finish 25 + next-transition 34 + vod-autoplay 21 全绿；[visual-accessibility.md](evidence/visual-accessibility.md) §3.4–3.6 倒计时/意图链层1 交互 | **Not-run**：T066 真实连播 10 组；awaitingGesture 真实交互（visual §3.7） |
| SC-004 | 两来源 10 次 carry ±3s；冲突必重选/从头 | switch 23 + source-match 31 + switch-candidates 22 + vod-switch 25 全绿（冲突/歧义/时长回退钉面） | **Not-run**：T076 两真实来源 10 次 carry 采样（us4-switch.md 未生成） |
| SC-005 | 越权/旧响应全部拒绝；公共浏览泄漏 0 | auth-boundaries 21 + transition-revocation 15 + security 18（泄露面）+ identity 面全绿 | **Not-run**：真实浏览器 Network 零泄漏采样属 T088 |
| SC-006 | 并发/重复/竞争各 20 次，无半登记/重复后继/复活 | materialization 18（20 并发/每步故障）+ transition-revocation/next-transition（取消竞争/事务故障）+ retention 9 全绿 | **Not-run**：浏览器级重复关闭/StrictMode 复跑断言面待执行（[us5-global.md](evidence/us5-global.md) §5：2 枚缺陷已修，§10 断言面就绪） |
| SC-007 | 20 次导航不断播；≤1s 保存尝试；失败显示未同步 | [visual-accessibility.md](evidence/visual-accessibility.md) 层1 Playwright 6/6（两主题/键盘/响应式/非阻塞入口）；`online-vod-global.spec.ts` 6 用例断言面（≤1s 恰一次 stop 断言在案） | **Not-run**：20 次导航/弱网退出/切档/watchdog e2e 未跑通（[us5-global.md](evidence/us5-global.md) §9.4 用例 2–6；浮层遮挡已修、本机 VPN DNS 限制） |
| SC-008 | 真实浏览器+目标 Linux 容器证据；NAS/直播回归 | runtime 冒烟 465 断言含转码交付/直播面（release-checks §4.5）；E2E 10/12 套件绿；[migration-recovery.md](evidence/migration-recovery.md) 六项全过 | **Not-run（整体）**：T088 目标 Linux 容器真实 HLS/key/redirect/连播/carry 证据未执行（runtime-network.md 未生成）；verify:release 未全绿（knip、settings-access 回归、⑥b 环境限制，release-checks §5） |

### 2.1 SC001–008 可判定口径（T091 终审补充）

判定规则：每项 SC 分「已执行面（样本/成功数/时间/负向结果）」与「Not-run 面（等价断言引用 + Not-run 原因）」；±3s 类落点误差只有真实媒体管线采样能判定，单测/契约等价断言只证明语义规则，不冒充 ±3s 实测。

- **SC-001**（19/20 搜索 ≤8s）——已执行（服务端受控链，[performance.md](evidence/performance.md) 2026-10-31 13:45–13:46 三轮一致）：样本=受控上游全链矩阵非浏览器采样；**时间：A1 全链 8,340ms 落 8s 总期限**（下界断言钉期限真实生效）、A2 收窄预算 1,491ms、峰值在飞=3；成功数=budgets 12/12 绿 ×3 轮；部分失败=200 `partial=true`+reasons 非空、健康源结果照常（catalog B4 收窄 500ms partial / B6 全超时 504；search-preview A5/A6）；负向=零源位置泄漏+no-store。**Not-run**：浏览器 20 次×每源 100 样本与脱敏 Network 证据（T035 的 us1-browse.md / T088）；原因：真实浏览器采样任务未执行（spec 文件亦未创建），服务端等价断言见 performance.md §三映射表。
- **SC-002**（19/20 续播 ±3s）——**Not-run（T050）**：无真实停止/重开/跨设备采样，us2-resume.md 未生成，±3s 无实测。等价断言（全绿，unit 1484 / contract 730 基线内）：`continuity-resume.spec` 29（时长差异 max(30s,2%)、冻结后他设备更新不改起点、尾部未完成允许续播）+ `progress-resume` 契约 27（seq 跨 generation 单调、superseded applied=false）+ `vod-start-position` 27（恰一依据一次冻结）+ `vod-resume` 9（web 续播降级/失败不显成功）+ `progress-stop-resume` 11。Not-run 原因：±3s 落点需真实媒体时钟与真实重启，jsdom/契约面不可构造。
- **SC-003**（10 组正常结束各只启动一次；负向不误启动）——已执行（服务端+组件+受控浏览器层1）：finish 契约 25（final 先接受再判尾段、stale final 不连播、stop 先赢不升级）+ next-transition 34（单 slot、取消/消费 CAS、偏好消费时重验）+ `vod-autoplay` 21（receipt 驱动倒计时、重复事件不造会话）全绿；[visual-accessibility.md](evidence/visual-accessibility.md) §3.4–3.6（run22，16:00–16:02，6/6）：真实 6s MP4 自然播完 → 恰一次 finish → 倒计时 → **Esc 取消零 intent / 显式选择恰一次 intent / 到期自动恰一次 intent**（负向不误启动的层1实证）。**Not-run**：真实连播 10 组（T066，us3-autoplay.md 未生成）；awaitingGesture 真实 NotAllowedError 交互（visual §3.7：headless 无法构造前置，组件级由 vod-autoplay.spec 钉面）；缺集/受限/开关关闭负向组的真实连播采样。
- **SC-004**（两来源 10 次 carry ±3s；冲突必重选/从头）——**Not-run（T076）**：us4-switch.md 未生成，±3s 无实测。等价断言（全绿）：`switch` 契约 23（carry 只取本会话已接受样本、checkpoint 缺失/不等/明确旧游标拒绝）+ `source-match` 31（high/ambiguous/conflict、确认不提升冲突、不按列表下标对应）+ `switch-candidates` 22 + `vod-switch` 25（SOURCE_PROGRESS_PENDING 显式确认、时长差异回退面）。Not-run 原因：±3s 误差需两真实来源与真实媒体时钟。
- **SC-005**（越权/旧响应全部拒绝；公共浏览泄漏 0）——已执行（契约面）：auth-boundaries 21（Public/Settings/Profile 边界、CSRF、A→B→A、过期 grant、内网拒绝）+ transition-revocation 15（旧上下文同形拒绝、禁源/跨设备/ABA、清理标记阻断新票）+ security 18（SSRF、源位置/他档泄露、错误体脱敏、大体积 422）全绿；负向结果=上述拒绝面全部实测为拒。**Not-run**：真实浏览器 DevTools/Network 零泄漏采样（T088 范围）；原因：T088 未执行；等价面=security B1–B3 全链零源地址断言。
- **SC-006**（并发/重复/竞争无半登记/重复后继/复活）——已执行（契约面，故障注入式并发而非字面 20 次循环）：materialization 18（净配额并发、每步故障整体回滚、同 key 复用/异摘要冲突 409）+ transition-revocation 15 / next-transition 34（取消与消费 CAS 竞争、每步事务故障、consumed slot 不得第二后继）+ retention 9（先过期幂等、重复运行不破坏 FK）全绿。**Not-run**：浏览器级重复关闭/StrictMode 复跑 e2e（[us5-global.md](evidence/us5-global.md) §4.3 断言面就绪、§5 两枚缺陷已修、§10 复跑受本机 VPN fake-IP DNS 限制未取得通过运行）。
- **SC-007**（20 次导航不断播；≤1s 保存尝试；失败显示未同步）——已执行（受控浏览器层1）：[visual-accessibility.md](evidence/visual-accessibility.md) 层1 Playwright **6/6**（run22：播放期间公共导航可见可用、设置 PIN 门非阻塞、两主题/键盘/三视口）；`BOUNDED_SAVE_MS=1_000` 已落地（progress-controller.ts:120）且 `vod-switch` C1「stopOnce 恰一次确认」、`playback-progress-queue` 泵面单测全绿；≤1s 恰一次 `/stop` 断言已写入 `online-vod-global.spec.ts`（断言面在案未跑通）。**Not-run**：20 次导航/弱网退出/切档/watchdog e2e（us5-global §9.4：用例 2 300s 超时（浮层遮挡，§10.3 已修复）、用例 3–6 未运行；§10 lead 17:40 复跑用例 1 导入受 VPN fake-IP DNS 影响失败；干净 DNS 一条命令可复跑）。
- **SC-008**（真实浏览器+目标 Linux 容器证据；NAS/直播回归）——**Not-run（整体）**：T088 未执行，runtime-network.md 未生成；verify:release 门禁红（knip 128 项、settings-access 新增回归、⑥b 环境限制、playback-intent 既有缺陷，release-checks §5）。已执行的部分面（不构成 SC-008 通过）：runtime 冒烟 PASS 9 场景 465 断言（release-checks §4.5，含转码交付/直播面）、E2E 10/12 套件绿、[migration-recovery.md](evidence/migration-recovery.md) 六项全过（2026-10-31 13:08–13:17 fresh 执行）。完成条件=T088 重述（见 §4）。

## 3. 结论

- **实现完成**：US1–US5 服务端+web 面全部交付，FR001–040/SC001–008 的自动化断言面全绿（unit 1484 / contract 730 / web 265；六契约套件 259 例 + web 组件/单元面）。
- **验证中**：SC 层真实环境采样 **Not-run** 4 项任务（T050/T066/T076/T088）+ 视觉 2 项 + us5 e2e 用例 2–6；SC-008 整体未执行 → **010 不标 Verified**，维持 Implementing。
- 发布门禁当前**未全绿**（release-checks §5：knip 死导出待收口、settings-access e2e web 侧回归、⑥b 环境、playback-intent 既有缺陷），不得以文档同步替代修复。

## 4. T091 终审记录

- **执行**：T091 子代理，2026-10-31 19:34–19:51（Asia/Shanghai）。审计姿态=只复核与小幅订正、不虚标、不越权勾选未完成项；无 git 操作、无 commit/push。
- **方法**：① FR 矩阵引用测试文件逐个 `grep it()/test()` 计数 + 抽样真实执行（`safe-upstream.spec.ts` 单文件 58 passed；`unit/online-vod` 目录 273 passed）；② SC Verified/Not-run 分类逐条对照 5 份证据文档（performance / migration-recovery / visual-accessibility / release-checks / us5-global）；③ tasks.md 每 Phase 抽 2 项核对交付物存在与验证声明。
- **抽查样本**（Phase → 抽核 → 结果）：P1 T004 基线文档+DESIGN token（22 处）/T005 双 fixture ✓；P2 T007 migration 契约 21 例（migration-recovery §6 复跑 41 passed 旁证）/T016 unit-of-work 6 例+实现 ✓；P3 T031 三控制器/T033 两目录页（T022 36·T023 34·T032 13 计数一致）✓；P4 T040 progress-write/clock/T046 vod-personal.controller（T036 27·T037 29·T038 28·T047 队列 spec 在树）✓；P5 T058 finish service/T064 use-vod-autoplay（T051 25·T052 34·T053 21+32·T063 21 一致）✓；P6 T070 match rules+candidates service/T074 source-switcher（T067 23·T068 31·T069 25 一致；**T071 漏标→补勾**）✓；P7 T080 守卫面/T081 retention playback_started_at 收口（T082 spec 在树）✓；P8 T083 security 18/T085 budgets 12+performance.md（T086/T087/T089/T090 四文档在树、引用互相一致）✓。
- **回归复核（本审计执行，19:43–19:49）**：web vitest **265/265**、server contract **730/730**、server unit **1484/1484**，三链 exit 0，=release-checks 基线，树稳。
- **订正清单**（最小 diff）：
  1. FR-039：`safe-upstream.spec.ts` 44→**58**（本审计执行 58 passed；44 为 `it()` 源码数，58 为含 2 组 `it.each` 展开的执行数；performance.md §六原记 58 正确）。
  2. §0 Not-run 清单：补 **T035**（us1-browse 采样未执行且 spec/文档均未创建；原清单漏列，与 SC-001 行及 performance.md §六/§八口径冲突），采样任务 4→**5** 项；补记 T077 `vod-global-playback.spec.tsx` 未创建。
  3. §0：6/8→**7/8**（原句括号自列 7 项 SC，算术自相矛盾）。
  4. 实现面补充：`unit/online-vod` 250→**273**（执行口径，实测）；web 010 面约 98→**103**（上列文件逐文件计数）。
  5. tasks.md **T071 漏标→[X]**（实现+14 例单测在树全绿，注明依据）。
  6. tasks.md **T079 漏标→[X]**（BOUNDED_SAVE_MS/stopOnce 收口在树、web 265 覆盖单测面；e2e ≤1s 实测仍归 FR-034/T082 Not-run，不冒充）。
  7. tasks.md **T091 本项→[X]**（本记录即依据）。
- **虚标检查**：未发现虚标。T082 维持 [X]：e2e 套件+证据文档+2 枚真实缺陷修复已交付，残余（用例 2–6）已以 Not-run 如实登记于 §0/§3，环境阻塞与 T088 同源（VPN fake-IP DNS）；是否降级为未勾选属 lead 决策，本审计不改判。T090 维持 [X]：10 项命令全部实际执行且门禁红如实归档，符合其自身定义。
- **未完成项完成条件重述**（保持未勾选；各自取得真实环境证据后方可勾选）：
  - **T035**：创建 `apps/web/test/e2e/online-vod-browse.spec.ts` 执行 Q1/Q2（20 次 3健康+1超时搜索/每源 100 样本、≥19 次 ≤8s），生成 `evidence/us1-browse.md`（游客边界、物化 20 组故障/并发、脱敏 Network 证据）。当前两文件均不存在。
  - **T050**：`online-vod-resume.spec.ts` 执行 Q3/Q4，`us2-resume.md` 记录 20 次停止/重启/两设备恢复、≥19 次 ±3s 实测、两 Profile 负向与内容/时长变化回退 + 既有 NAS/直播独立回归。
  - **T066**：`online-vod-autoplay.spec.ts` 执行 Q5/Q7，`us3-autoplay.md` 记录自然结束 10 组各恰一次下一集、缺集/受限/开关/手势负向不误播、20 组不同 key 单后继/事务故障。
  - **T076**：`online-vod-switch.spec.ts` 执行 Q6/Q7，`us4-switch.md` 记录两真实来源 10 次 carry ±3s 实测、他设备不同历史、歧义确认/冲突/时长回退、20 组不同 key 与取消竞争 + 源地址脱敏 Network。
  - **T088**：按 quickstart 在真实浏览器+目标 Linux 容器完成播放（HLS/key/redirect、停止/重启续播、多集连播、两来源 carry、编解码/CPU/网络环境、私有字段零泄漏、真实 seek/续播落点），生成 `evidence/runtime-network.md`；前置含干净 DNS 环境（本机 VPN fake-IP DNS 同源阻塞 us5 e2e 用例 2–6 复跑）。
  - **T077 附加**：`apps/web/test/vod-global-playback.spec.tsx` 未创建（目标覆盖已部分落于 identity-purge/vod-identity-guards/online-vod-global 断言面）；完成条件=补齐该文件，或经 lead 确认改写任务指向既有覆盖面，二者居一后可勾选。
- **tasks.md 终态**：91 项 = **85 [X]** + **6 未勾选**（T035/T050/T066/T076/T077/T088）；010 维持 **Implementing**。
