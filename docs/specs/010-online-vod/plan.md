# Implementation Plan: 在线点播接入与追剧体验

**Branch**: 实际checkout=`master`，HEAD=`cb3b39e`；setup-plan报告的功能标识=`010-online-vod`，未创建/切换Git分支。 | **Date**: 2026-10-29 | **Spec**: [spec.md](spec.md)

**Input**: `docs/specs/010-online-vod/spec.md`（Proposed），包含40项需求与8项成功标准。
**Constitution baseline**: 工作区宪章1.5.0（2026-10-29）；规划期间外部更新后已重核技术约束5–8。

**Status**: 实施完成（2026-10-31）：Phase0/1 设计经维护者确认（T002 冻结）后按 ADR0016/spec Accepted 门禁交付实现，US1–US5 服务端与 web 面代码及自动化测试全绿；验证中——真实环境证据部分 Not-run（T050/T066/T076/T088），不满足 Verified。逐项证据见 [evidence.md](evidence.md) 与 [evidence/](evidence/)，发布门禁状态见 [evidence/release-checks.md](evidence/release-checks.md)。

## Summary

添加Apple CMS在线来源、公开搜索/临时详情、认证后的整片物化、受控HLS播放，交付普通源operational续播、同源同线自动下一集和用户主动便捷换源。保持Household资源边界、Profile个人数据与当前上下文版本、005 epoch/seq和009全局非阻塞播放面。

关键设计：领域所有者通过显式事务工作集共享短事务；会话ledger与Profile历史写入分离；新增finish receipt而不把stop 204当自然完成；每来源generation一个单后继槽；过渡消费与新会话/epoch创建原子提交；统一服务端起点冻结。技术依据及替代方案见[research.md](research.md)，精确模型及协议见[data-model.md](data-model.md)、[API](contracts/api.md)、[状态协议](contracts/playback-state.md)、[内部边界](contracts/internal-ports.md)、[UI](contracts/ui.md)。

## Technical Context

**Language/Version**: TypeScript ^5.8，Node >=24，pnpm 11.28.5（仓库声明）。
**Primary Dependencies**: NestJS ^12、Drizzle ^0.44/better-sqlite3 ^13、Zod ^4；React ^19、HeroUI 3.2.6、TanStack Query ^5、Video.js ^8；复用已有ffmpeg/probe及受控资产交付。
**Storage**: 同部署SQLite；业务新表及复合家庭FK；临时有界内存搜索/预览缓存；会话输入私有快照与持久回收标记；历史长期留存不依赖会话TTL。
**Testing**: Vitest3、Supertest/Nest TestingModule、Testing Library、Playwright；真实Linux容器+浏览器Network/媒体时间证据。
**Target Platform**: PC浏览器；自托管Docker/Linux NAS；单部署单家庭，保留多家庭隔离键。
**Project Type**: NestJS后端+React Web+shared契约的现有pnpm workspace。
**Performance Goals**: SC001的3健康+1超时源/每源100样本下19/20搜索<=8s；SC002续播19/20误差<=3s；SC004换源10/10<=3s；退出保存尝试<=1s。
**Constraints**: 仅标准VOD HLS；全部输入预算和取消受控；无任意客户端URL/起点/Profile；内网默认拒绝；无强制云依赖；不同源历史不合并；应用/领域不值导入数据库或他上下文私有模块。
**Scale/Scope**: 10个启用源、5000父影片/100000子项、搜索20项/页/2000项快照、详情最多20线路/单线2000/总5000项/4MiB；3测速候选；5个用户故事。配额是明确初值，不是现有容量实测结论。

## Constitution Check

| Gate | Phase0前 | Phase1后 | 依据/后续动作 |
| --- | --- | --- | --- |
| 当前授权为设计，不编码 | PASS | PASS | 用户显式plan；仅文档变化 |
| Spec/新ADR已Accepted的实施前门禁 | **ERROR：未通过实施门禁** | **ERROR：仍未通过** | spec及[ADR0016](../../adr/0016-online-vod-playback-transitions.md)均Proposed；不自动接受，不启动tasks实施 |
| Household/Account/Profile隔离 | 设计约束通过 | 设计通过，运行待验 | 所有表/缓存/意图含家庭；个人状态含Profile；来源上下文版本防ABA |
| 公共浏览/受控播放、设置再验证 | 设计约束通过 | 设计通过，负向证据待验 | 公共仅元数据；目标每次授权；设置仍Settings+当次密码 |
| DDD/仓储与跨界 | 需设计新事务发布端口 | 设计通过，ADR接受前禁实施 | 无跨私表依赖；UnitOfWork只控制连接，各上下文贡献仓储；不修改全局seam |
| NAS/隐私与旧数据 | PASS | 设计通过，迁移证据待验 | 不继承005空库豁免；保留业务、匹配版本备份恢复 |
| UI基线与视觉入口 | 需核对当前宪章 | 设计约束通过，视觉运行待验 | HeroUI v3安装版3.2.6；heroui-react固定3.0.1；DESIGN.md与语义token；实施前取官方组件/主题文档并记录日期 |
| 类型/测试/运行/迁移门禁 | 未运行 | 未运行，不宣称通过 | 文档解析不代替应用或设备验收 |

模板“Accepted spec”条目是进入实现的硬门禁，本计划不将其豁免或标绿。宪章要求编码前接受，而本次用户明确授权文档规划，因此允许形成Proposed设计供评审；若请求进入实施，必须先解决ERROR，不以本计划自动继续。无已知需要牺牲宪章原则的设计偏离。

> **实施期更新（2026-10-30/31，历史行不改）**：上表 Phase0前/Phase1后 两列为规划时点记录。维护者已于 2026-10-30 对 T001 门禁确认接受（spec.md Acceptance Record、ADR0016 状态行、[T002 冻结](#2026-10-30-审查修订与产品确认)），实施前门禁 ERROR 解除后进入实施；「类型/测试/运行/迁移门禁」已在实现后真实执行——单元/契约/web 全绿（1484/730/265），迁移演练全过（[evidence/migration-recovery.md](evidence/migration-recovery.md)），发布门禁 verify:release 未全绿（knip 清理、settings-access e2e 回归、⑥b 环境限制，见 [evidence/release-checks.md](evidence/release-checks.md)）。

## Project Structure

### Documentation (this feature)

```text
docs/specs/010-online-vod/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── api.md
│   ├── playback-state.md
│   ├── internal-ports.md
│   └── ui.md
└── checklists/requirements.md
```

另新增 [ADR0016](../../adr/0016-online-vod-playback-transitions.md)（规划时为 Proposed，2026-10-30 经维护者确认 Accepted；实施备注见该文末节）。任务清单已生成并随审查修订，见[tasks.md](tasks.md)；机器可读契约选择见contracts/api.md“交付格式”。

### Source Code (repository root，未来实施路径)

```text
apps/server/src/contexts/
├── online-vod/{domain,application,infrastructure,interface}/   # 新上下文
├── sources/          # vod配置/条目与登记发布参与者
├── media-catalog/    # 父子媒体及公共可用性/列表投影
├── policy/           # 有效父子事实/名单匹配
├── playback/         # 固定输入、finish、slot/intent及授权
└── personal-data/    # session ledger、进度/历史/偏好
apps/server/src/platform/database/  # UnitOfWork基础设施、迁移/schema
apps/server/src/platform/           # 可复用有界安全网络读取
apps/web/src/app/                   # ActionCoordinator继续唯一入口
apps/web/src/features/{catalog,playback,history,settings}/
packages/shared/src/                # 后续生成类型/问题注册
apps/server/test/{unit,contract}/
apps/web/test/                      # progress队列/过渡/全局播放及e2e
```

**Structure Decision**: 新业务只加online-vod上下文，其他所有者扩展发布接口；装配根接合用例而非让上下文循环注入。既有ADR0015 seam留给旧路径，新跨事务用例不通过全局重绑加入事务。前端扩展已有协调器，禁止第二全局播放器、路由导航卸载或另起LibreTV身份体系。

## Phase 0 — Research closure

R1–R10均已选择方案并记录Rationale/Alternatives；研究代理对R5–R8的并发模型进行了只读设计复核，未重复代码探索。CodeGraph负责现有结构取证；包清单/ADR负责技术与治理来源。原研究选择已有推荐；本轮产品待确认取舍见末节，不能视为已接受；真实源/硬件可用性是后续验证条件，不冒充已证明。

## Phase 1 — Design and contracts

1. 数据与迁移：[data-model.md](data-model.md)明确关系、约束、修订、配额、幂等TTL、历史保留和回收保护。
2. 公共/管理/个人/播放接口：[contracts/api.md](contracts/api.md)逐端点输入输出、授权、错误及幂等；旧stop 204不改。
3. 三种起点、finish、seq/generation及slot并发：[contracts/playback-state.md](contracts/playback-state.md)。
4. 事务工作集、依赖/取消/安全读取：[contracts/internal-ports.md](contracts/internal-ports.md)。
5. UI一致性/焦点/个人缓存及等待手势：[contracts/ui.md](contracts/ui.md)。
6. 运行指南：[quickstart.md](quickstart.md)区分现有可运行检查与实现后新增场景，不伪造新增测试已存在。

## 实施排序（仅依赖层次，不是任务清单）

先接受spec/ADR与契约扩展 → 迁移和事务发布/策略投影 → 来源adapter/搜索预览/物化 → ledger/finish/输入版本 → slot/intent和起点 → 前端命令泵/续播 → 连播/换源/测速 → 独立库与真实浏览器/Linux证据。不能先叠页面再补授权与并发。

## Requirements coverage

逐 FR/SC 的实现面（测试文件+用例数）、证据文档引用与 Not-run 诚实标注见 [evidence.md](evidence.md) 证据矩阵（T089 维护）；下表保留规划期的主要设计产物映射。

| 需求 | 主要设计产物 | 验证 |
| --- | --- | --- |
| FR001–007 | data-model来源/物化；api公共/Settings | quickstart Q1/Q2/Q8，SC001/006 |
| FR008–013 | policy/internal ports/输入修订 | Q3/Q7/Q8，SC005/008 |
| FR014–021 | ledger/起点/续播 | Q3/Q4，SC002/004 |
| FR022–028 | finish/观测/next/awaitingGesture | Q5，SC003 |
| FR029–032 | switch候选/测速/carry | Q6，SC004/005 |
| FR033–040 | 命令泵/slot/取消/重放/恢复 | Q6/Q7/Q9，SC005–008 |

## Complexity Tracking

没有被豁免的宪章违规。跨领域一致性及新增finish并非已有能力，需ADR接受与定向验证。复合约束、事务工作集和会话ledger增加复杂度，是保障三项体验的必要成本；不借此重构全仓seam或所有旧接口。

## Validation status

**实施完成后更新（2026-10-31）**：规划期文档检查（链接、章节、端点对应、无占位）已随 T001–T004 完成；实施面按 tasks.md T001–T090 交付：

- 自动化全绿：`gen:types`（6 份 OpenAPI → shared DTO，含 010 vod-schema）、`lint`、`typecheck`、`build`、server unit **1484/1484**（89 文件）、server contract **730/730**（63 文件）、web vitest **265/265**（36 文件）、`audit:boundaries`、`audit:purity`、runtime 冒烟 465 断言——命令与退出码见 [evidence/release-checks.md](evidence/release-checks.md)。
- 证据已归档：性能/预算（[evidence/performance.md](evidence/performance.md)）、迁移与恢复（[evidence/migration-recovery.md](evidence/migration-recovery.md)）、视觉与可访问性（[evidence/visual-accessibility.md](evidence/visual-accessibility.md)，2 项 Not-run 诚实标注）、US5 全局面（[evidence/us5-global.md](evidence/us5-global.md)，Q9/Q7 断言面就绪 + Not-run 诚实标注）、发布检查（[evidence/release-checks.md](evidence/release-checks.md)）。
- **未通过/未执行（如实）**：`verify:release` 未全绿——⑥b fresh-deployment-loop 受本机 VPN fake-IP DNS 环境限制、⑥c playback-intent 为既有缺陷、⑥c settings-access 为 web 侧新增回归、⑥ audit:orphans(knip) 有 010 树新增死导出待收口；FR/SC 矩阵中 **Not-run** 项：T050 真实环境续播 20 次±3s、T066 真实连播 10 组、T076 两真实来源 10 次 carry、T088 目标 Linux 容器播放（各自单测等价断言全绿）。
- 状态结论：**Implementing（实现完成、验证中）**，不满足 Verified；不能视为已通过真实播放验收。逐项 FR/SC 证据矩阵见 [evidence.md](evidence.md)。

## 2026-10-30 审查修订与产品确认

I1–I5先收口：候选ref物化→精确来源checkpoint→不可变下一集计划→独立起播标记→最小清理入口；随后补U1偏好操作记录及U2定位能力。新增工作集保持原限界上下文所有权、短事务与网络在事务外；无播放鉴权放宽。同步ADR0016及quickstart，tasks保留T001–T091编号并逐项扩充，不新增实现授权。

**T002 冻结确认（2026-10-30）**：维护者在实施会话中对 T001 门禁询问明确答复"继续/接受"，并确认下表 7 项取舍全部按推荐方案冻结（spec/ADR 已记 Accepted，contracts/api.md 头部有冻结记录）；不得默选替代方案，确认不同方案须先同步 spec/API/model/tasks。

| 待确认取舍 | 推荐方案（已写入Proposed契约供评审） | 理由与体验代价 |
| --- | --- | --- |
| I1 候选登记入口 | materializations增加candidateRef严格分支 | 避免前端拼接隐藏键，复用既有原子发布；增加一个请求分支 |
| I2 暂停保存超时 | 不自动回退；用户选择明确的已接受位置或从头 | 避免显示保留当前位置却跳回旧位置；弱网多一次选择 |
| I3 下一集/历史变化 | 冻结计划，变化后重新确认；probe前历史变化则本次准备失败 | 防止确认串目标或静默覆盖其他设备新历史；少量并发场景需要重试 |
| I4 未知时长 | 允许播放，以独立playing确认保活，显示进度不可保存 | 不误杀可播放来源；第一期不承诺这类输入续播/完成/自动连播 |
| I5 失权后清理 | 仅同设备/Profile/context可无内容放行地取消/停止关联后继 | 满足取消闭环同时不泄漏目标、不恢复权限；增加持久清理分支 |
| U1 偏好幂等 | 返回当次原响应，UI另GET当前值；绝不回写旧偏好 | 保证重放可验证且避免覆盖后来操作；重放值可能不是当前值 |
| U2 HLS定位 | 第一期浏览器本地seek，服务端仅既有支持范围 | 控制范围并保持输入/generation协议；不支持可靠定位的源从头或提示重选 |

上述取舍已于 2026-10-30 由维护者确认冻结（见上方 T002 冻结确认）。确认不同方案须先同步spec/API/model/tasks，不能由实现者临场选择。第一期交付仍是普通CMS的operational停止/重启/同Profile跨设备续播、同线确定下一集、用户主动换源；不是全格式、无时长续播、自动跨源故障转移或媒体一致性证明。
