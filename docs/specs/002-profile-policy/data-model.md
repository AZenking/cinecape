# Data Model: ProfilePolicy（Proposed）

## profile_policy

| 字段 | 约束与语义 |
| --- | --- |
| household_id | 非空，引用 household.id |
| profile_id | 非空，与 household_id 组成主键；另 UNIQUE(profile_id)，每档案仅一行 |
| max_content_level | 非空整数 0～18，CHECK |
| allow_unrated | 非空整数 0/1，CHECK |
| allowed_media_ids / blocked_media_ids / allowed_channel_ids | 非空 JSON 数组文本，默认 []，CHECK json_valid 和 json_type=array |
| version | 非空正整数，默认 1，CHECK；整体配置保存时递增 |
| updated_at | 非空 UTC 时间字符串 |

给 profile 增加 UNIQUE(household_id,id) 作为复合外键目标；profile_policy(household_id,profile_id) 引用它。禁止把 household_id 只当冗余字段。无 account_id 副本，账号归属通过 Profile 校验，防止两份归属漂移。

数组元素是大小写敏感、长度 1～128 的不透明媒体标识，不预设第三阶段一定为 UUID；每数组去重后最多 1000 项。应用校验全部元素并去重排序，读取时重新解析验证；损坏不能当空数组或成人默认。不同名单交集保留，禁止优先。频道 ID 是阶段 3 MediaItem(type=channel) 的 id，不是源地址或 EPG 节目 id；Series/Episode 暂按自身 id 判定，不隐式继承系列允许，继承规则由阶段 3 另定。

名单与媒体 FK 留到媒体实体设计时确认；本阶段生产管理接口不允许写入名单。每次授权查询数据库最新策略，不引入缓存；三个数组只在当次判定转换为 Set。

## parent_verification_state

| 字段 | 约束与语义 |
| --- | --- |
| household_id / account_id | 复合主键，复合外键引用 account(household_id,id) |
| failed_attempts | 非空非负整数，默认 0 |
| locked_until | 可空 UTC 时间 |

不保存密码，不发放“永久解锁”标记。密码使用当前账号既有 password_hash 验证。错误 5 次后锁 5 分钟；锁定中不检查密码，返回 423；到期后重新计数；成功清零。异步哈希返回后在事务内重读状态，避免并发错误覆盖计数或正确请求绕过新锁定。成功验证与受保护写入在同一请求内完成，不跨请求复用；需在写入前重新校验会话仍有效。

## 内部 MediaPolicyFacts 契约（非数据库表/非公开请求）

householdId、mediaId、type(channel/movie/series/episode/video)、channelId（channel 时等于 mediaId）、contentLevel（0～18 或 null）、householdEnabled。只能由服务端目录适配器构造，类型无效和等级越界一律拒绝为事实损坏，未知外部分级在适配器明确映射为 null。

授权服务先验证 active Profile 可用与归属，查询家庭资源，再加载策略交给纯规则；返回 allowed 与内部 reason。禁止把详细跨家庭拒绝原因泄漏到对外响应。

## 迁移与状态

- 0002_profile_policy/up.sql：添加复合唯一索引、两个新表；按既有 Profile.type 回填默认策略（含 disabled）；如家庭存在 child，清空引用未设 PIN adult 的 active_profile_id，要求重新选择验证。保持会话令牌有效、身份与 PIN 不变。
- 新档案与策略同事务创建；策略编辑检查 expectedVersion，写失败不改变版本或名单。
- 停用只清活动上下文、保留策略；重新启用不重建默认值。
- down.sql：先删子表再删新增索引，保留全部阶段 1 业务数据。策略和家长失败计数会随 down 丢失，重新 up 得到默认策略；恢复原自定义策略须恢复升级前/回滚前备份。
- 含儿童的实例不得把降级到阶段 1 当作安全等价运行：旧版本不执行新策略。回滚演练必须离线临时库，生产恢复须停服并明确权限回退影响。
- 就绪与 drill 同步新表、版本；升级/回滚不操作用户真实家庭库。
