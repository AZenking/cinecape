# Feature Specification: 应用脚手架与身份基础(Identity Foundation)

**005 替代标注（2026-10-26）**: 规格005 与 ADR-0010/0011 已接受——本规格的"初始化后自动注册设备并签发会话（自动登录）"流程及旧管理路径（`/sources`、`/catalog`、`/devices` 管理入口）由005替代：初始化仅创建 Household+Account 不发会话，管理能力迁入 `/api/settings/*`。认证、会话、设备会话语义及逐次密码验证继续有效（ADR-0006 不废弃）。
**Feature Branch**: `001-scaffold-identity-foundation`

**Created**: 2026-10-22

**Status**: Verified（2026-10-23 重新验收；此前不完整的 Verified 已撤回，Phase 7 修正后以 65 测试、真实进程/浏览器、迁移恢复与双架构容器证据重新确认；见 [evidence.md](evidence.md)）

**Governance**: Follow `.specify/memory/constitution.md`. Link accepted ADRs before implementation; use Proposed → Accepted → Implementing → Verified (or Superseded).

**Related ADRs**:

- [ADR-0002 一次部署实例对应一个 Household](../../../docs/adr/0002-one-deployment-one-household.md)(Accepted)——本规格的初始化与资源边界约束直接遵循该决策;
- [ADR-0003 宪章对齐](../../../docs/adr/0003-constitution-alignment.md)(Accepted)——身份归属、规格目录与 ADR 门禁遵循该决策;
- [ADR-0004 技术栈](../../adr/0004-technology-stack.md) 与 [ADR-0005 实施补充](../../adr/0005-stage1-delivery-details.md)（Accepted）；迁移执行器及同源交付按实施补充执行。
- 宪章合规性:本规格落实宪章原则 II(三层身份隔离)、原则 I(负向验收条件)与技术约束(显式 `household_id`、幂等、可回滚迁移、Docker/Linux 交付)。

**Input**: User description: "开始第一步 —— 按路线图实施阶段 1:应用脚手架与身份基础"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 首次启动:初始化家庭并登录(Priority: P1)

家庭管理员把平台部署到 NAS 后启动服务,完成一次性初始化:创建唯一的家庭(Household)和主账号(Account)。随后使用用户名和密码登录,系统为这台设备建立设备会话,管理员能看到自己的家庭信息和成员 Profile 列表。到这里,"一个家庭拥有一个可登录的主账号"这一闭环成立。

**Why this priority**: 没有可启动的服务和可登录的主账号,后续一切能力(Profile、策略、媒体、播放)都无法开始。这是路线图阶段 1 完成条件的前半句。

**Independent Test**: 在全新环境中启动服务,完成初始化并创建家庭与主账号,随后用正确凭据登录,应获得有效设备会话并能读取家庭信息与 Profile 列表。仅完成本故事即可向用户交付"平台已可用"的价值。

**Acceptance Scenarios**:

1. **Given** 全新部署且尚未初始化, **When** 部署者执行初始化流程并提交家庭名称与管理员凭据, **Then** 系统创建唯一 Household(显式 `household_id` 边界)与 owner 角色的主 Account,密码仅以哈希形式保存。
2. **Given** 已完成初始化, **When** 再次尝试执行初始化(创建第二个家庭或第二个主账号), **Then** 系统拒绝并保持原有数据不变(遵循 ADR-0002:一次部署对应一个 Household)。
3. **Given** 已存在主 Account, **When** 用户提交正确的用户名和密码, **Then** 系统验证凭据成功,为当前设备创建 DeviceSession,会话绑定同一 Household 下的 Account 与 Device,并带有明确的过期时间。
4. **Given** 已存在主 Account, **When** 用户提交错误密码或使用的账号不存在, **Then** 系统返回统一的失败提示(不区分"账号不存在"与"密码错误"),且不创建会话。
5. **Given** 任意接口或导出数据, **When** 检查响应内容, **Then** 密码哈希与 PIN 哈希永不出现。

---

### User Story 2 - 选择与切换观看 Profile(含 PIN 保护)(Priority: P2)

登录后,家庭成员在 Profile 列表中选择"现在是谁在观看"。管理员可以创建、编辑、停用 Profile,可为受保护 Profile 设置 PIN。切换 Profile 时,服务端校验目标 Profile 属于当前家庭和当前主账号、未被停用,受 PIN 保护的 Profile 还必须先验证 PIN;全部通过后由服务端把该会话的当前观看者更新为目标 Profile。

**Why this priority**: Profile 是 V1 一切个人数据与内容策略的边界。没有服务端控制的"当前观看者",后续阶段(策略、个人数据)都失去锚点。这是路线图阶段 1 完成条件的后半句。

**Independent Test**: 以有效设备会话调用选择 Profile,验证服务端会话上下文更新;对受 PIN 保护的 Profile,在不提供/提供错误 PIN 时切换必须失败。不依赖媒体或策略功能即可完整测试。

**Acceptance Scenarios**:

1. **Given** 管理员已登录, **When** 创建成人或儿童 Profile(含名称、类型,可选头像、PIN、是否默认), **Then** Profile 归属当前 Household 与当前 Account,`account_id` 与 `household_id` 一致。
2. **Given** 已存在多个 Profile, **When** 把某个 Profile 设为默认, **Then** 该 Household 内最多只有一个默认 Profile;设置新默认时旧默认自动取消。
3. **Given** 已存在至少一个可用 Profile, **When** 尝试停用当前唯一可用 Profile, **Then** 系统拒绝(一个 Household 至少保留一个可用 Profile)。
4. **Given** 会话尚未选择 Profile, **When** 用户选择一个属于当前 Household、当前 Account 且未停用的 Profile, **Then** 服务端更新该会话的当前观看者,后续请求以新上下文执行。
5. **Given** 目标 Profile 受 PIN 保护, **When** 用户先解锁(提交正确 PIN)再选择, **Then** 切换成功;提交错误 PIN 时切换失败,连续失败达到上限后在一段时间内拒绝再次尝试(不泄露剩余次数之外的额外信息)。
6. **Given** 某 Profile 已被停用, **When** 任何会话尝试选择它, **Then** 系统拒绝;若它是某会话的当前观看者,该会话的当前观看者上下文被清除并要求重新选择。
7. **Given** 客户端在请求参数、请求体或本地存储中伪造不属于当前 Household/Account 的 `profile_id`, **When** 服务端处理请求, **Then** 一律以服务端会话校验结果为准,伪造请求被拒绝且不返回目标 Profile 的任何数据。

---

### User Story 3 - 会话生命周期:恢复、注销与设备撤销(Priority: P3)

日常使用中,用户关闭页面或重启设备后再次打开,只要会话仍有效就无需重新登录;用户也可以主动退出登录;管理员可以在设备管理中撤销某台设备,使其所有会话立即失效,该设备之后必须重新认证才能使用。

**Why this priority**: 会话的可恢复与可撤销决定日常体验与安全底线(丢失设备可远程踢出),但它建立在故事 1、2 之上,因此排第三。

**Independent Test**: 登录后记录会话凭证;重启服务后用该凭证恢复登录态;注销后同一凭证立即失效;撤销设备后该设备全部凭证失效。三个动作可分别独立验证。

**Acceptance Scenarios**:

1. **Given** 用户持有未过期、未撤销的会话凭证, **When** 重新打开服务并出示该凭证, **Then** 登录状态恢复,先前选择的当前观看者(若未被停用)保持不变。
2. **Given** 会话已超过过期时间, **When** 用户出示该凭证, **Then** 系统拒绝并要求重新登录。
3. **Given** 用户主动退出登录, **When** 注销完成, **Then** 该设备会话立即失效,同一凭证再次使用被拒绝。
4. **Given** 管理员撤销某台设备, **When** 该设备上的任意会话随后访问受保护能力, **Then** 全部被拒绝,该设备必须重新认证;对同一撤销请求的重复提交不产生额外副作用(幂等)。
5. **Given** 服务重启, **When** 系统恢复运行, **Then** 身份数据(Household、Account、Profile、Device、DeviceSession 及其状态)完整保留,无需重新初始化。

---

### Edge Cases

- 同一台设备先后登录多次:允许多个并发会话;注销只影响当前会话,撤销影响该设备全部会话。
- 会话恰好在校验瞬间过期:结果必须与"已过期"一致,不得出现短暂的放行窗口。
- 目标 Profile 属于其他 Household(伪造 `household_id` / `profile_id`):拒绝且不泄露存在性以外的任何信息。
- 同时把两个 Profile 分别设为默认:后到达的请求要么失败要么使前者自动取消,任何时刻最多一个默认。
- PIN 连续错误达到上限:锁定期间即使 PIN 正确也拒绝,锁定自动解除后可重试。
- 数据库迁移执行到一半中断:必须能通过已验证的回滚方案恢复到一致状态,身份数据不出现半初始化状态。
- 停用"正被某会话用作当前观看者"的 Profile:该会话上下文立即失效,不得继续以该 Profile 身份读写数据。

## Requirements *(mandatory)*

### Functional Requirements

**初始化与部署骨架**

- **FR-001**: 系统 MUST 作为一个单一部署实例启动,并提供健康检查能力,用于确认服务与持久化存储均就绪。
- **FR-002**: 系统 MUST 提供一次性初始化流程,创建唯一 Household(名称,可选默认语言、时区)与一个 owner 角色主 Account。
- **FR-003**: 初始化完成后,系统 MUST 拒绝创建第二个 Household 或第二个主 Account(ADR-0002)。
- **FR-004**: 部署相关配置(服务端口、持久化连接、密钥等)MUST 通过环境或配置注入,不得将密钥硬编码在代码或镜像中。
- **FR-005**: 身份数据 MUST 持久化保存;持久化结构的变更 MUST 通过向前兼容的迁移执行,且迁移必须具备经过验证的回滚方案(宪章技术约束 3)。
- **FR-006**: 所有身份数据表 MUST 保留显式 `household_id`,所有家庭资源查询 MUST 携带 Household 边界(领域模型 §4)。

**认证与会话**

- **FR-007**: 系统 MUST 支持以用户名和密码登录;密码仅保存哈希,任何接口响应、日志或导出数据 MUST NOT 包含密码哈希或 PIN 哈希。
- **FR-008**: 登录成功 MUST 为发起设备创建 DeviceSession,绑定同一 Household 下的 Account 与 Device,并记录过期时间;登录失败 MUST 返回统一错误,不泄露账号是否存在。
- **FR-009**: 系统 MUST 支持设备注册(设备名称与类型:web / mobile / tv / nas / other),设备身份由服务端记录,不得仅依赖客户端上报的浏览器特征。
- **FR-010**: 持有未过期、未撤销会话凭证的客户端 MUST 能恢复登录态;过期或被撤销的凭证 MUST 被拒绝并要求重新登录。
- **FR-011**: 注销 MUST 立即使当前设备会话失效;设备撤销 MUST 立即使该设备的全部会话失效。
- **FR-012**: 会话创建、恢复、注销与设备撤销等状态变更 MUST 具备幂等性或可安全重试(重复执行不产生额外副作用)。

**Profile 管理与切换**

- **FR-013**: 主 Account MUST 能创建、编辑、停用 Profile;Profile 包含名称、类型(adult/child)、可选头像、可选 PIN、是否默认;一个 Household MUST 始终保留至少一个可用 Profile,且最多一个默认 Profile。
- **FR-014**: 选择 Profile 时,系统 MUST 校验目标 Profile 属于当前会话的 Household 与 Account 且未被停用;通过后由服务端更新该会话的当前观看者。
- **FR-015**: 受 PIN 保护的 Profile MUST 在切换前通过 PIN 验证;PIN 连续错误达到上限后 MUST 在一段时间内拒绝再次尝试。
- **FR-016**: 停用某 Profile 时,若它是任何会话的当前观看者,系统 MUST 使这些会话的当前观看者上下文失效。
- **FR-017**: `adult/child` 类型在本阶段仅决定界面模式与默认体验,系统 MUST NOT 将其作为任何访问授权的依据(授权属于阶段 2 的 ProfilePolicy)。

**服务端边界(负向要求,宪章原则 I)**

- **FR-018**: 所有身份相关判定 MUST 以服务端会话为信任源;客户端传入的 `profile_id`、`household_id`、本地存储或 URL 参数不得单独作为授权依据。
- **FR-019**: 系统 MUST 拒绝以下越权请求并返回明确失败:使用无效/过期/已撤销会话访问受保护能力;访问不属于当前 Household 或当前 Account 的 Profile;伪造身份标识篡改会话上下文。
- **FR-020**: 系统 MUST 为上述全部负向场景提供可自动执行的测试证据(单元/集成契约测试),并纳入合并前质量门禁。

### Key Entities *(include if feature involves data)*

概念定义以 [领域模型 V1.1](../../../homeMediaDomainModel.md) §3 为准,本阶段实现其中身份部分:

- **Household**: 顶层资源边界;名称、默认语言、时区;V1 一次部署实例对应一个 Household。
- **Account**: 登录主体;用户名、密码哈希、角色(owner/admin);V1 每个 Household 恰好一个主要 Account;不承载任何个人观看数据。
- **Profile**: 观看者档案;归属 Account 并保留显式 `household_id`;名称、类型(adult/child)、可选头像、可选 PIN 哈希、是否默认、是否停用;个人数据与策略的未来锚点。
- **Device**: 家庭设备;名称、类型(web/mobile/tv/nas/other)、最近活跃时间;由服务端注册。
- **DeviceSession**: 设备经认证后的会话;绑定 Household + Account + Device,持有可选的当前观看者(Profile),含过期时间与撤销标记;`accountId`、`deviceId`、`activeProfileId` 必须同属一个 Household。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 全新环境下,部署者从启动服务到完成初始化并成功登录,全流程可在 10 分钟内完成。
- **SC-002**: 使用正确凭据登录,3 秒内返回有效设备会话;会话恢复请求 1 秒内返回结果。
- **SC-003**: 使用无效、过期或已撤销会话访问任何受保护能力,拒绝率 100%。
- **SC-004**: 全部越权/篡改负向用例(伪造 `profile_id`、`household_id`、使用他人会话、绕过 PIN)通过率 100%,且不泄露目标资源数据。
- **SC-005**: 服务重启后,全部身份数据与会话状态完整保留;重复执行初始化被 100% 拒绝。
- **SC-006**: 迁移脚本可在全新环境重复执行成功,且回滚路径经过实际执行验证;回滚后系统可再次迁移到最新状态。
- **SC-007**: 身份边界的单元测试与集成契约测试 100% 通过,其中必须包含 FR-019 列出的全部负向场景,并作为合并前质量门禁执行。

## Assumptions

- 单一部署实例、单一 Household、单一主 Account 是 V1 固定前提(ADR-0002);多家庭、多登录账号明确不做。
- 登录方式为本阶段仅支持用户名 + 密码;第三方登录(SSO/OAuth2)、邮箱验证不做。
- DeviceSession 采用长期会话以避免日常重复登录;具体有效期与续期策略属于技术细节,由技术计划(research/plan)确定。
- PIN 错误锁定采用合理默认值(如连续 5 次失败锁定 5 分钟),最终数值在技术计划中确认并保持可配置。
- 本阶段不包含忘记密码自助重置;单家庭自托管场景下,管理员可通过部署环境(配置或维护命令)重置主账号凭据,具体方式由技术计划确定。
- Profile 数量无业务上限,仅受界面与运维合理性约束。
- 运行时、包管理器、数据库选型等属于本功能技术计划阶段(speckit-plan)的决策,须沉淀技术选型 ADR 后再实现;本规格不预设。
- 阶段 1 不实现 ProfilePolicy 内容判定、媒体目录与播放(阶段 2-4 范围),但身份数据结构必须为它们预留边界(显式 `household_id`、Profile 归属约束)。
