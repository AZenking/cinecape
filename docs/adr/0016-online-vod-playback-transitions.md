# ADR-0016：在线点播连续性、会话进度及单后继播放过渡

- 状态：**Accepted**（2026-10-30，维护者在实施会话中对 T001 门禁询问明确答复"继续/接受"；提案 2026-10-29 随010规划提出）。
- 关联：[010 spec](../specs/010-online-vod/spec.md)、[plan](../specs/010-online-vod/plan.md)、[research](../specs/010-online-vod/research.md)；ADR0006/0007/0009/0010/0012/0014/0015。

## Context

用户要求普通采集源具备可用续播、连播和便捷换源，仍保留Profile及播放鉴权。现有resolve建档后另绑epoch，progress把superseded表示为历史未写，stop204不表达完成，前端generation变更重置队列/卸载最终保存；直接叠新体验会产生错误carry、重复后继或旧身份回写。

## Proposed Decision

1. 新增online-vod协议上下文，sources/media-catalog/policy/playback/personal-data所有权不合并。资源登记通过各所有者发布的transaction-aware端口共享短事务，网络在事务外。平台UnitOfWork只持连接、事务及工厂，application不接ORM值，不重绑全局seam。
2. 稳定定位与内容证据分离。Apple CMS保持unverified，但满足稳定身份/结构、未完成历史及本次可信时长可operational续播；明示无提示媒体替换无法完全检测。content/continuity修订变化拒绝旧绑定；不把匹配置信度用于授权。
3. 父子有效策略保留ADR0006顺序：禁止优先、未评级独立、已评级允许名单覆盖等级上限、未命中仍可按等级通过。公共元数据不按Profile过滤；新播放目标每次独立鉴权。来源改名不终止，启停改变定位版本防ABA。
4. 会话ledger与Profile历史epoch写入权独立。superseded有效样本更新自己session位置但不覆盖新owner历史；保持旧applied字段历史含义、追加sessionAccepted。seq跨generation递增；个人记录只在合法实际started后产生。
5. 普通stop204保留。新增finish receipt和自然完成产品观测，final接受/历史应用/完成资格分别记录，完成与session终态同事务。不会把ended或客户端事件当授权证明。superseded可在本设备合法连播而不写他设备owner历史。
6. 每来源session/generation一个持久单后继slot。intent创建/消费重验身份上下文/来源/目标/偏好，消费和target session+epoch/ledger同事务。pending可CAS取消/替换，消费后原槽不可创建第二后继。来源停止后可按专用只读上下文授权next，不复用活动控制授权；媒体故障允许短期手动recover_switch，权限故障不允许恢复旁路。
7. 起点只选beginning、target_history、transition_carry之一，在本次probe后冻结一次；carry来自来源session接受样本而不是Profile最新历史或客户端位置。换源不合并历史/内部身份，不自动无限轮换。
8. 全局ActionCoordinator/009非阻塞面不变，新增awaitable session命令泵；generation切换不重置seq或停止session。浏览器拒绝自动播放显示点击播放，60s未实际起播回收，无虚假历史。

## Scope of extensions（仅接受后生效）

- ADR0007：增加vod按需完整影片发布，不改变IPTV/NAS完整扫描语义。
- ADR0006：仅增加父子事实/名单匹配目标，旧允许名单优先级不替代。
- ADR0009/0012：扩展在线输入、operational续播、finish/ledger和过渡；原受控交付、epoch单历史写入者、seq幂等、stop204、身份版本要求保留。005新接口/字段须同步OpenAPI/shared与测试，不暗改旧消费者。
- ADR0015：扩展显式纯TS工作集以加入同一物理事务，不撤销仓储隔离/审计，不为新代码授权全局service locator或跨私表。
- 009呈现形态及全局导航行为不替代。

本ADR不继承005的清库/不迁移例外；新迁移保留现有家庭、媒体与个人数据。

## Alternatives and consequences

- 强制全片指纹才续播：无法满足普通源第一期体验；采用明确operational风险而不降低鉴权。
- 引入整套LibreTV/替换播放器：产生重复身份和历史，范围扩大；沿用现有Video.js及Resolver。
- 共享Profile历史作carry：另一设备可改变起点；使用会话ledger。
- 仅operationKey/客户端取消：不同key仍可建多个后继；采用slot及取消输家找回清理。
- 全局seam换事务句柄或online-vod直写其他表：违反边界且有竞态；发布端口+工作集增加显式接口成本。
- 将stop改200/增加completed播放状态：破坏既有停止与生命周期语义；新增finish receipt更清楚。

代价：新数据/契约/工作集和迁移、观测频率及实际源验收工作增加；不声称一套元数据规则可以证明媒体字节一致或真实用户完整观看。

## Acceptance prerequisites / Migration and rollback

接受前联合评审spec及contracts中的来源/父子策略、finish/进度扩展、slot/intent原子性和当前受影响ADR；不得通过本文件自我接受。实施时同步005精确契约、shared类型和既有客户端消费，保留静态/直播行为。

空临时库up/down/up、包含旧业务的副本升级、非空在线down拒绝及备份+匹配镜像恢复；禁止原业务库试验。恢复中旧会话/grant/intent失效，历史保留。真实Linux/浏览器续播/连播/两源carry及跨Profile负向证据齐全后才能Verified。

## 2026-10-30 审查补充（提出时为 Proposed；同日随维护者 T002 确认并入 Accepted 决策，内容不变）

候选ref直接物化并事务返回登记映射；carry绑定精确已接受checkpoint；next绑定不可变序列/历史计划，变化重新确认；playing起播标记独立于可保存进度；同设备/Profile/context最小cleanup允许失权后撤销关联后继但不授予播放。偏好成功响应24h持久幂等，重放不倒写当前值。第一期HLS仅本地seek、服务端重建保持原范围。精确契约以010 API/model/state为准，产品推荐与体验代价见plan末节；未确认及未接受前不实施。

## 2026-10-31 实施备注（T089 追记；不改变上述决策与接受记录）

本 ADR 决策已按 010 任务 T001–T090 实施交付，Scope of extensions 各项落地口径：

- online-vod 协议上下文、事务工作集与 UnitOfWork 端口：已实现（`apps/server/src/contexts/online-vod/`，边界审计 `audit:boundaries`/`audit:purity` 绿）。
- operational 续播/内容-连续性修订分离、会话 ledger 与 Profile 历史写入权独立（`applied` 只指历史写入、`sessionAccepted` 独立视图）：已实现并有契约面覆盖（`online-vod-progress-resume.e2e-spec.ts` 等）。
- finish receipt 与普通 stop 204 分离（stop 仍 204 无资格；自然完成资格由 FinishReceipt 独立记录）：已实现（`online-vod-finish.e2e-spec.ts`）。
- 每来源单后继 slot/intent、消费原子性、取消输家找回与 cleanup：已实现（`online-vod-next-transition.e2e-spec.ts`、`online-vod-transition-revocation.e2e-spec.ts`）。
- 起点三选一冻结、carry 只取来源会话接受样本：已实现（`online-vod-switch.e2e-spec.ts`）。
- 0007_online_vod 迁移与恢复演练：已执行（[010 evidence/migration-recovery.md](../specs/010-online-vod/evidence/migration-recovery.md)，隔离副本六项全过、用户库零触碰）。
- 「Acceptance prerequisites」所列真实 Linux/浏览器续播/连播/两源 carry 证据：**Not-run**（010 T050/T066/T076/T088，各自单测等价断言全绿）——按本 ADR 原文，Verified 条件尚未满足，010 维持 Implementing。

实施证据矩阵与逐项引用见 [010 evidence.md](../specs/010-online-vod/evidence.md)。
