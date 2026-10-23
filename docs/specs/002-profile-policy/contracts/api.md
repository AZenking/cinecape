# 阶段 2 接口契约草案

状态：Proposed；统一前缀 `/api`，沿用 001 Cookie/Bearer 会话与 RFC 9457 problem。实施前将本草案转为 OpenAPI 3.1，并生成独立的 policy-schema.d.ts；本轮不改生成脚本或共享代码。

## GET /profiles/{profileId}/policy

SessionGuard → owner → requireOwnedProfile；不要求 activeProfile 等于管理目标。成功 200：`{profileId,maxContentLevel,allowUnrated,allowedMediaIds,blockedMediaIds,allowedChannelIds,version,updatedAt}`，所有字段必有；布尔/整数/数组与 data-model 一致。不返回 householdId、凭据或验证计数。

## PUT /profiles/{profileId}/policy

请求严格只允许 `{ownerPassword,expectedVersion,policy:{maxContentLevel,allowUnrated}}`。密码非空，expectedVersion 正整数；两个 policy 字段必须齐全。当前阶段替换可编辑配置，三个名单由服务端原样保留，不能由请求覆盖或清空。成功 200 返回完整 PolicyDto，version 加一（相同值保存仍加一）。未通过验证、校验错误或版本冲突不得改变任何策略；失败密码会按设计更新验证计数。

后续名单编辑须阶段 3 新增契约，接受真实资源选择并验证 Household；本契约不默许未来任意字段。

## 既有身份接口变化（需更新 001 契约，不能只改前端）

- POST /profiles：增加 ownerPassword 必填；其他字段沿用；服务端原子创建默认策略，响应 ProfileDto 保持原结构。
- PATCH /profiles/{profileId}：增加 ownerPassword 必填；包含 pin/clearPin 的现有行为不变，但写入前必须家长验证。type 仍不可编辑。
- POST /profiles/{profileId}/select：允许可选 ownerPassword；当目标 adult、无 PIN 且家庭存在 child（含 disabled）时必填并验证。设 PIN 目标仍需原有一次性解锁授予，ownerPassword 不替代 PIN。child 选择沿用现有规则。
- 新增策略接口严格拒绝未知字段；既有身份接口继续忽略不受信任的未知身份字段，以服务端会话为准，保留阶段 1 防篡改语义。
- 所有新增密码不回显；不得拼接进 URL、请求头或本地持久化。浏览器弹窗当次提交后清空；服务端沿用 password 敏感键日志脱敏。

## 统一错误与判定次序

| 条件 | 状态 / code |
| --- | --- |
| 无效、过期、撤销会话 | 401 SESSION_INVALID |
| 非 owner 管理 | 403 FORBIDDEN |
| 格式非法、未知字段、无效等级/版本 | 400 VALIDATION_FAILED（沿用既有 parseBody / ProblemCode） |
| 密码缺失 | 403 PARENT_VERIFICATION_REQUIRED |
| 密码错误（含触发锁定的第 5 次） | 403 PARENT_VERIFICATION_FAILED；后续请求返回锁定 |
| 验证锁定窗口内（包含正确密码） | 423 PARENT_VERIFICATION_LOCKED |
| 目标不存在或不属当前家庭/账号 | 404 NOT_FOUND，同形 |
| 当前档案未选或停用（授权服务） | 403 ACTIVE_PROFILE_REQUIRED |
| 策略缺失/损坏 | 503 POLICY_UNAVAILABLE，拒绝访问并提示修复，不能创建宽松默认 |
| expectedVersion 与当前不同 | 409 POLICY_VERSION_CONFLICT |

读取按身份→角色→目标→策略。管理写入按身份→角色→格式→家长验证→目标→版本→事务保存。select 沿用目标归属/可用性优先，再验证需要的 PIN/密码。锁定错误可给重试秒数，不暴露密码/哈希。跨家庭资源在未来授权入口与不存在统一对外 NOT_FOUND，详细 reason 仅用于内部测试/脱敏诊断。

## 内部授权契约（不开放为生产 HTTP API）

- authorizeCurrentProfile(sessionContext, mediaId, trustedResourceReader)：重新确认会话仍有效，读取 activeProfile 与最新策略和可信资源，返回决定；不接受外部 profileId/householdId/rating。
- evaluatePolicy(policy, profileType, facts)：纯函数，返回 `{allowed,reason}`；reason 覆盖 RESOURCE_UNAVAILABLE、POLICY_UNAVAILABLE、MEDIA_BLOCKED、CHANNEL_NOT_ALLOWED、UNRATED_DENIED、UNRATED_ALLOWED（未评级且 allowUnrated 放行，实现期补充枚举）、MEDIA_ALLOWED、LEVEL_ALLOWED、LEVEL_EXCEEDED。
- 资源读取必须基于会话 Household 查询，即使客户端知道跨家庭 mediaId，也不能读出资源事实或 URL。
- 测试夹具通过测试专用模块装配资源适配器；禁止生产注册测试路由；阶段 3 才提供真实资源 reader。
