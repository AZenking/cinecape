# 010 验证指南

> **实施状态更新（2026-10-31，T089）**：本文原为设计阶段验收步骤清单；010 已实施完成（US1–US5 服务端+web，自动化测试全绿，见 [evidence/release-checks.md](evidence/release-checks.md)），本文保留 Q1–Q9 与审查补充验收集作为**验收步骤定义**，并在各节标注当前执行状态：**已执行**（自动化/组件/受控环境面，证据见 [evidence/](evidence/) 与 [evidence.md](evidence.md) 矩阵）与 **Not-run**（真实环境采样：T050 续播 20 次±3s、T066 真实连播 10 组、T076 两真实来源 10 次 carry、T088 目标 Linux 容器）。Not-run 项不代表失败，是尚未具备真实环境采样；缺这些证据不标 Verified。

## 前提与边界

Q1–Q9 场景所需的服务端接口、fixture 与测试已在实现面交付。执行验收时仍不能对当前用户业务库跑迁移或重置。使用独立DATA_DIR副本、固定测试家庭/两个Profile/两设备、3健康+1超时的受控来源样本；真实源另由维护者在设置页配置，不将URL/密码写入文档/截图/日志。

需要Node>=24、pnpm11、工作区依赖及可用ffmpeg/probe；SC008需Linux目标容器及真实浏览器。环境变量、端口、Docker部署沿用仓库已有运行文档，不猜测新开关。

## 可运行命令与当前结果

从仓库根执行（010 实施后这些命令覆盖 010 新增面；最近一轮全绿结果与命令/退出码见 [evidence/release-checks.md](evidence/release-checks.md)）：

```sh
pnpm gen:types                      # 6 份 OpenAPI → shared DTO（含 010 vod-schema.d.ts）✅
pnpm lint                           # ✅（T090 曾修复一处 JSX 注释位语法错误后全绿）
pnpm -r typecheck                   # ✅
pnpm --filter @hmp/server test:unit     # 1484/1484（89 文件）✅
pnpm --filter @hmp/server test:contract # 730/730（63 文件）✅
pnpm --filter @hmp/web test:vitest      # 265/265（36 文件）✅
pnpm --filter @hmp/server audit:boundaries # ✅
pnpm --filter @hmp/server audit:purity     # ✅
pnpm build                          # ✅
```

开发启动：

```sh
pnpm dev
```

完整发布门禁及浏览器回归（`pnpm --filter @hmp/web test:e2e`、`pnpm verify:release`）：T090 已实际执行并如实归档——verify:release **未全绿**：⑥b fresh-deployment-loop 受本机 VPN fake-IP DNS 环境限制、⑥c playback-intent 为既有缺陷（HEAD 同点同错）、⑥c settings-access 为 web 侧新增回归、⑥ audit:orphans(knip) 有 010 树新增死导出待收口；E2E 12 套件中 10 绿。明细与逐类归因见 [evidence/release-checks.md](evidence/release-checks.md)。010 专属 e2e `test/e2e/online-vod-global.spec.ts`（6 用例，Q9/Q7 断言面）不在该脚本套件清单内，断言面就绪但本机 VPN DNS 环境下未稳定通过（[evidence/us5-global.md](evidence/us5-global.md) §10）。

独立临时DATA_DIR配置确认后才运行`pnpm migration:drill`；先在匹配版本副本验证旧业务保留/备份恢复。普通用户目录、旧库和原始媒体不能作为演练清理对象（T086 演练已按此完成，见 [evidence/migration-recovery.md](evidence/migration-recovery.md)）。契约检查使用[API](contracts/api.md)及[状态协议](contracts/playback-state.md)。

## Q1 公开检索与设置（SC001/005）

> 状态：服务端契约面**已执行**（`online-vod-catalog.e2e-spec.ts` 36 例 + `online-vod-budgets.e2e-spec.ts` A1/A2 期限/并发 + `online-vod-auth-boundaries.e2e-spec.ts` 21 例，全绿）；20 次浏览器全量采样与脱敏 Network 证据 **Not-run**（T035/T088 范围）。

管理员完成Settings验证，添加3健康+1超时源。游客20次搜索，每源100样本，>=19次8s内看到结果及部分失败。全部失败区别于无匹配。翻页重试/取消/10min失效，检查没有个人字段/源URL/凭据。游客/普通Profile/过期grant/缺密码修改来源均拒绝；禁用立即阻止新播放，改名不杀活动播放。

## Q2 物化原子与幂等（SC006）

> 状态：**已执行**（`online-vod-materialization.e2e-spec.ts` 18 例含每步故障回滚注入 + `unit/online-vod/materialization-service.spec.ts` 13 例，全绿）。

游客详情不增永久条目。认证点击播放，完整父/子/资源一起出现；故障注入每个写入步骤及进程commit前后，不留半成品。成功响应丢失后等预览过期，同操作24h内恢复原ID；新key同目标复用；异payload冲突，禁权/内容变化拒绝。20次并发不重复身份/突破配额。幂等期内清理不得删目标。

## Q3 会话接受与历史抢占（SC002/005）

> 状态：**已执行**（`online-vod-progress-resume.e2e-spec.ts` 27 例：resolve/progress 接受/superseded 与 generation 面，全绿；applied 只指历史写入、sessionAccepted 独立返回）。

设备A、B同Profile同媒体。A started后B更新epoch，A发送合法pause：sessionAccepted=true、applied=false/superseded，A ledger为自己的位置，Profile历史保留B。重复最新seq无新revision、异payload409、stale不前进。跨generation seq不归零；旧代样本不能接受，也不能触发整个session stop。换Profile、A→B→A、撤销/禁源旧请求全部拒绝。

## Q4 真实续播（SC002/008）

> 状态：服务端/组件等价断言**已执行**（`unit/online-vod/continuity-resume.spec.ts` 29 例 + `online-vod-progress-resume.e2e-spec.ts` + `apps/web/test/vod-resume.spec.tsx` 9 例，全绿）；**20 次真实停止/重开±3s 采样 Not-run**（T050，`evidence/us2-resume.md` 未生成）。

20次同源同线停止/重开，含部署重启及另一设备重新认证。至少19次首帧逻辑位置在最后确认位置±3s，不用未确认媒体currentTime作承诺。token更新保持身份；年份/季/版本/continuity变化、时长超过容差、未知duration回退并提示。尾部未完成仍可尝试，completed不能自动续到结尾。准备失败保留历史；静态NAS既有续播单独回归。

## Q5 finish、自动下一集与手势（SC003/008）

> 状态：finish/receipt/next-plans/intent 契约面与组件面**已执行**（`online-vod-finish.e2e-spec.ts` 25 例 + `online-vod-next-transition.e2e-spec.ts` 34 例 + `apps/web/test/vod-autoplay.spec.tsx` 21 例，全绿）；**10 组真实连播 Not-run**（T066，`evidence/us3-autoplay.md` 未生成）；awaitingGesture 真实浏览器交互证据 Not-run（[evidence/visual-accessibility.md](evidence/visual-accessibility.md) §3.7，组件级已钉面）。

用有序3集：自然结束处理final后生成receipt，即使上次周期样本离尾8s也不误拒绝；普通stop204不授予资格（实际语义：stop 204 仅终态，不补写 final；自然完成资格由 finish receipt 独立记录）。superseded会话可完成并next但不覆盖他设备历史。重复finish/stop竞争，receipt不可升级或重写。0.5/1/2倍速、短片、seek到尾、暂停/缓冲/断网缺观测分别验证，证据不足给手动下一集。

10次正常结束各只启动正确下一集一次；倒计时取消/关闭偏好/切档/缺集/重复号/季边界/下一集禁止不误启动；下一集有历史需用户选择。浏览器阻止play时显示点击播放，未playing无started；60s超时释放且不自动跳集。

## Q6 便捷换源（SC004/006）

> 状态：候选/测速/switch 消费契约与组件面**已执行**（`online-vod-switch.e2e-spec.ts` 23 例 + `unit/online-vod/switch-candidates.spec.ts` 22 例 + `switch-probe.spec.ts` 14 例 + `apps/web/test/vod-switch.spec.tsx` 25 例，全绿）；**两真实来源 10 次 carry±3s 采样 Not-run**（T076，`evidence/us4-switch.md` 未生成）。

两个来源同一集、高匹配10次carry首帧误差<=3s；选择时先确认A会话pause接受，不读其他设备历史。歧义确认、冲突禁carry、目标有历史三选项、时长差异回退从头。最多3候选测试，抓包不向客户端返回片段/URL/票据且无历史。停前失败恢复仍有效来源；停后失败重建而非复活。媒体故障后60s recover_switch有效，撤销/禁权/修订故障不得借恢复旁路。

## Q7 过渡并发/失联（SC005/006/007）

> 状态：服务端并发/撤销/清理契约面**已执行**（`online-vod-transition-revocation.e2e-spec.ts` 15 例 + `online-vod-retention.e2e-spec.ts` 9 例，全绿）；浏览器级断网退出/多标签 20 组采样 Not-run（[evidence/us5-global.md](evidence/us5-global.md) §0：Q7 e2e Not-run、单测等价断言清单见其 §7）。

不同operationKey/多标签对同来源generation发起不同目标20组：只能一次成功后继。pending替换使旧intent失效；cancel先赢不建档，consume先赢返回后继并显式stop不需要的目标。响应丢失重放找回同session，失败后不重消费旧槽。消费事务每步故障均无孤立epoch/session。

身份在intent创建后变更、开关在倒计时后关闭、源禁用再启用、目标版本变化均阻止消费。60s到期不续TTL；关闭页面/断网1s后继续退出并提示未同步。前端失联/重启watchdog回收preparing/awaitingGesture及旧输入。

## Q8 迁移/恢复与隐私（SC005/006/008）

> 状态：**已执行**（隔离副本六项演练全过 + `online-vod-migration.e2e-spec.ts` 21 例 + `online-vod-security.e2e-spec.ts` 18 例 SSRF/泄露/预算面，见 [evidence/migration-recovery.md](evidence/migration-recovery.md)「未执行项：无」）。

只用隔离副本，记录旧账号/策略/来源/历史/静态资源摘要，升级后保持。空临时库up/down/up；非空在线业务down须拒绝破坏性操作，按匹配备份/镜像恢复演练，所有旧会话/意图/grant不得复活。清理幂等/意图/会话FK保护，不能删历史释放配额；故障日志无私有地址。CMS/重定向/manifest/key/segment/ffmpeg/测速分别验证内网和协议拒绝。

## Q9 全局前端及证据归档（SC007/008）

> 状态：视觉/键盘/两主题/响应式层1 Playwright 交互 6/6 **已执行**（[evidence/visual-accessibility.md](evidence/visual-accessibility.md)，2 项 Not-run 诚实标注）；**20 次导航不断播、弱网退出/切档 ≤1s、watchdog 面的 e2e Not-run**（[evidence/us5-global.md](evidence/us5-global.md)：断言面就绪，本机 VPN fake-IP DNS 环境不具备稳定通过条件，干净 DNS 一条命令可复跑）。

按宪章1.5.0、heroui-react固定3.0.1及根DESIGN.md核验v3 API、语义token与适用主题、键盘、响应式的运行时视觉证据；具体组件/主题官方文档在实施前获取并留日期。

20次路由导航不中断全局播放/心跳/进度；设置入口仍可用、焦点正确。session级泵保证同seq载荷不变，final只一次，generation变化不卸载stop；退出/切档等待<=1s。失效响应如可能建后继必须查回并清理。

记录每个SC的样本数、成功数、耗时、首帧/冻结逻辑位置及误差、浏览器/容器/CPU/编解码环境、测试报告与脱敏Network证据。FR/SC 逐项证据矩阵见 [evidence.md](evidence.md)（T089 维护，含 Not-run 诚实标注）。真实源失败、硬件不支持与软件断言分开记录；缺真实续播/连播/两源切换证据（T050/T066/T076/T088 Not-run），010 不标 Verified。

## 审查补充验收集

> 状态（2026-10-31）：I1–I5/U1/U2 各条的服务端契约与单元等价断言**已执行**并全绿——I1 候选物化（materialization spec + catalog spec）、I2 暂停丢响应/carry checkpoint（progress-resume + switch spec）、I3 下一集计划变化（next-transition spec）、I4 起播确认/未知时长（finish spec + auth/retention 面）、I5 失权清理（transition-revocation spec）、U1 偏好幂等（catalog spec + personal-data 面）、U2 本地 seek 语义（finish/progress spec + web vod 面）；其中涉及真实 HLS 落点±3s 的采样属 **Not-run**（T050/T076/T088）。

1. I1：仅使用switch-candidates返回字段完成候选物化→登记引用→intent；注入物化响应丢失/预览过期，成功重放恢复相同引用。
2. I2：暂停ACK丢失重发同seq/载荷；创建carry缺checkpoint或ledger不等必须拒绝；用户选择明确旧接受游标后成功，ledger前进要求重新确认。
3. I3：倒计时及历史选择中修改序列/目标历史，创建/消费返回NEXT_PLAN_CHANGED；probe前更新历史使后继failed；旧计划不得启动另一个目标。成功消费重放不受原计划TTL影响。
4. I4：未知duration且已交付/playing确认，超过readyAt60s继续播放但无个人历史/完成/carry；未playing、仅heartbeat/renew仍回收。测试观测与watchdog CAS竞争。
5. I5：消费成功响应丢失后禁源，完整查询拒绝但原context cleanup可停止关联后继；cleanup响应丢失/进程重启可恢复；跨设备/Profile/ABA均拒绝，目标新票/资产被清理标记阻断。
6. U1：偏好A写成功、B更新后重放A仅回原响应；GET仍为B；异摘要409、并发CAS、24h保留及过期清理。
7. U2：真实HLS在seekable范围内本地定位，generation不变/seq递增，seek后立即ended不得连播；NAS服务端重建generation递增旧票失效；直播无seek；本地resume/carry落点误差±3秒，否则明确失败。

此集映射SC002–008及tasks审查补充；所有证据缺失仍保持未完成，不因文档修订视为验收通过。
