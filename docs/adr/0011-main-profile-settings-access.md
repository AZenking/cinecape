# ADR-0011：主 Profile 与设置访问授权

- 状态：Accepted（2026-10-26 维护者随规格005实施指令显式接受；替代关系自此生效，实施与证据见 specs/005 tasks.md/evidence.md）
- 依据：宪章1.2.0原则二/六；[规格005](../specs/005-pc-browsing-flow/spec.md)五项澄清、[数据模型](../specs/005-pc-browsing-flow/data-model.md)。
- 关联：ADR-0003的身份分工、ADR-0006的敏感写逐次账号密码验证保持有效。

## Context

设置入口需对应主Profile的PIN验证，当前只存在用于选档的一次性PIN授予。若要求零档案用户先解锁设置才能首建，会形成死锁；仅按Account owner授权又不能区分同会话中的儿童观看者。

## Proposed Decision

1. 主Profile是唯一active adult、已设6位PIN的档案标识，与isDefault分离，不赋予Account以外的管理角色。当前活动档案必须为主Profile才可签发和使用设置授权。
2. 初始化只建账号；首次登录无档案时，通过owner当次账号密码的窄用途bootstrap显式填写名称、设置PIN并建默认策略，不自动选档。已有任何档案不允许再次bootstrap。
3. 设置授予服务器持久保存，绑定DeviceSession、Profile与身份/PIN/主档案版本，成功验证后固定15分钟；刷新/返回可继续使用但不续期。到期、退出、换档、撤销、PIN变化、主档案转移、档案停用均失效。PIN重设/恢复还须同事务清空目标档案所有活动身份、增加contextVersion、终态化旧播放并撤票，之后重新选档。服务重启及备份恢复先撤销授予。
4. PIN选档和设置验证共用持久失败锁定，5次错误锁5分钟；选档授予不能替代设置授予。异步哈希后提交前再读快照，A→B→A不能复活旧授权。
5. 保留ADR-0006的每次敏感操作账号密码验证；本ADR不替代该决定，也不缓存长期家长密码验证态。管理读取还须SettingsGuard，管理写同时满足SettingsGuard及当次密码。
6. PIN首建与恢复只开放受限账号密码入口，不返回一般管理数据、不自动签设置授权；恢复后需新PIN重新验证。密码修改撤销全部旧账号会话和授予。
7. 默认15分钟与首次主Profile建立方式、逐次密码规则已由用户在规格澄清中确认；具体字段、错误、并发行为仍待本设计接受。

## Alternatives and consequences

不采用客户端unlocked、主档案自动管理员角色、复用一次性选档PIN授予、滑动TTL、PIN替代所有管理密码。用户可能选档与进入设置各输一次PIN，这是两个用途的独立验证；敏感写保留较重交互，符合用户选择A。

## Migration and rollback

新存储代际见ADR-0012，不要求旧Profile自动转换为主Profile。现有数据不清理，使用全新DATA_DIR首建。接受后同步001/002及相关管理契约：选档最小接口保留，管理迁入settings，过去的owner-only管理读取不再是新访问规则。历史Accepted ADR不因本提案自动变更状态。

## Acceptance and evidence

待接受。必须验证首次零档案并发、默认/成人标识不能替代管理权限、PIN锁定跨重启、A→B→A失效、15分钟边界、刷新不续期、验证中身份/PIN变化、恢复入口用途限制、逐次密码不被豁免。不得用纯前端路由测试替代服务端证据。
