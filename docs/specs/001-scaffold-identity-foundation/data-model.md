# Data Model: 应用脚手架与身份基础(001)

- 日期:2026-10-22
- 权威来源:[领域模型 V1.1 §3/§4](../../../homeMediaDomainModel.md)(概念定义);本文件给出关系实现与约束细节;字段命名在数据库层用 snake_case,DTO 层用稳定领域字段(领域模型 §6 接口约束)。
- 宪章强制:每张表保留显式 `household_id`(ADR-0003 §3);本阶段无个人数据表,阶段 5 表接入时必须同时携带 `household_id` + `profile_id`。

## 实体关系总览

```text
household 1 ──── 1 account          (V1 恰好一个主 Account,ADR-0002)
household 1 ──── N profile          (profile 同时带 account_id,与 household 一致)
account   1 ──── N profile
household 1 ──── N device
account   1 ──── N device_session
device    1 ──── N device_session
device_session N ─── 0..1 profile   (active_profile_id,服务端维护)
```

## 表定义

### household

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | TEXT (UUID v4) | PK | |
| name | TEXT | NOT NULL | 家庭名称 |
| default_language | TEXT | NOT NULL DEFAULT 'zh-CN' | 可选初始化项 |
| timezone | TEXT | NOT NULL DEFAULT 'Asia/Shanghai' | IANA 时区 |
| created_at | TEXT (ISO-8601) | NOT NULL | |

约束:全表最多 1 行 —— 应用层事务内初始化守卫(FR-003)；不宣称存在 singleton_check 视图/触发器，直接写库不属于受支持接口;初始化完成后 `POST /setup/initialize` 永久返回 409。

### account

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | TEXT (UUID v4) | PK | |
| household_id | TEXT | NOT NULL FK→household.id | 显式家庭边界 |
| username | TEXT | NOT NULL | 登录名,大小写不敏感唯一 |
| username_normalized | TEXT | UNIQUE NOT NULL | lower(username),防枚举查询列 |
| password_hash | TEXT | NOT NULL | argon2id;**永不出现在任何 DTO/日志** |
| role | TEXT | CHECK IN ('owner','admin') | V1 仅 owner |
| created_at | TEXT | NOT NULL | |

约束:每 household 最多 1 行(UNIQUE(household_id) —— ADR-0002 的数据库化)。

### profile

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | TEXT (UUID v4) | PK | |
| household_id | TEXT | NOT NULL FK→household.id | |
| account_id | TEXT | NOT NULL FK→account.id | 必须与 household_id 同属一致(复合 FK + 应用校验,负向测试覆盖) |
| name | TEXT | NOT NULL | |
| avatar | TEXT | NULL | 预留(URL 或资源 id) |
| type | TEXT | CHECK IN ('adult','child') | 仅界面模式,非授权依据(FR-017) |
| is_default | INTEGER(0/1) | NOT NULL DEFAULT 0 | 每 household 至多 1 个可用默认 |
| pin_hash | TEXT | NULL | argon2id;NULL = 无 PIN |
| status | TEXT | CHECK IN ('active','disabled') | |
| failed_pin_count | INTEGER | NOT NULL DEFAULT 0 | PIN 锁定计数 |
| pin_locked_until | TEXT | NULL | 锁定窗口截止时间 |
| created_at | TEXT | NOT NULL | |

约束与索引:
- Profile→Account 归属一致性(实现评审修正 2026-10-22):复合外键 `(household_id, account_id)` REFERENCES `account(household_id, id)`,account 上配套 `UNIQUE(household_id, id)`;**严禁**用 `UNIQUE(household_id, account_id)` 唯一约束表达 —— 那会在 account 每家庭唯一之上把 Profile 压缩成每家庭 1 行,与 Account 1──N Profile 直接矛盾;
- 部分唯一索引:`CREATE UNIQUE INDEX one_default_profile ON profile(household_id) WHERE is_default = 1 AND status = 'active'`(最多一个默认,FR-013);
- "至少一个可用 Profile"(FR-013)无法用纯约束表达 → 应用层事务内校验:停用最后一个 active Profile 必须失败(单测覆盖);
- PIN 锁定窗口:验证前先检查 `pin_locked_until`,锁定期间即使 PIN 正确也拒绝(FR-015);成功验证后 `failed_pin_count` 清零。

### device

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | TEXT (UUID v4) | PK | |
| household_id | TEXT | NOT NULL FK→household.id | |
| name | TEXT | NULL | 用户可改的展示名 |
| type | TEXT | CHECK IN ('web','mobile','tv','nas','other') | NOT NULL |
| last_seen_at | TEXT | NULL | 会话活动时刷新 |
| revoked_at | TEXT | NULL | 非空 = 已撤销(FR-011) |
| created_at | TEXT | NOT NULL | |

说明:设备身份由服务端注册/协商记录,不依赖 User-Agent(领域模型 §3.4);V1 首次登录自动注册,type 由客户端声明 + 服务端默认 web。

### device_session

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | TEXT (UUID v4) | PK | 会话标识(非凭证) |
| household_id | TEXT | NOT NULL FK→household.id | |
| account_id | TEXT | NOT NULL FK→account.id | 与 household_id 一致 |
| device_id | TEXT | NOT NULL FK→device.id | 与 household_id 一致 |
| token_hash | TEXT | UNIQUE NOT NULL | SHA-256(32B CSPRNG token);**明文 token 不落库** |
| active_profile_id | TEXT | NULL FK→profile.id | 服务端维护的当前观看者(领域模型 §3.4) |
| expires_at | TEXT | NOT NULL | 滑动 30 天,绝对上限 90 天(可配置) |
| revoked_at | TEXT | NULL | 注销/设备撤销写入 |
| last_active_at | TEXT | NOT NULL | 滑动续期依据 |
| created_at | TEXT | NOT NULL | |

约束与索引:
- 复合一致性:`accountId`、`deviceId`、`activeProfileId` 必须同属一行 household(FR-014 的数据库锚点;负向测试伪造跨家庭 profile_id 必须失败);
- `active_profile_id` 指向的 Profile 必须为 active —— Profile 被停用时**同事务**清空所有引用它的 `active_profile_id`(FR-016);
- 校验顺序(单一实现点,Guard 内):token 哈希查找 → `revoked_at IS NULL` → `expires_at > now` → 设备未撤销 → 归属一致;任何一步失败一律 401,无放行窗口(边界用例:恰好过期 = 已过期)。

## 状态转换

### device_session

```text
(登录) → active ──过期──→ expired(终态,行保留供审计)
            ├──注销──→ revoked(revoked_at)
            ├──设备撤销──→ revoked(revoked_at)
            └──滑动续期──→ active(expires_at/last_active_at 前移,绝对上限封顶)
```

幂等语义(FR-012):注销已注销的会话 = 无变更成功;撤销已撤销设备 = 无变更成功;重复登录创建新会话(允许多并发会话,见 spec Edge Cases)。

### profile

```text
active ──停用──→ disabled(最后可用拒绝;引用会话清空 active_profile_id)
disabled ──启用──→ active(重新满足默认唯一索引)
```

PIN 锁定:`failed_pin_count < 5 → 验证;失败 +1;达到 5 → pin_locked_until = now + 5min`;锁定窗口内一律拒绝;窗口过后允许重试,成功即清零。

## 迁移与回滚(research D4 落地)

- 仓库迁移执行器按 `apps/server/src/database/migrations/NNNN_name/up.sql` 与 `down.sql` 成对执行，决策见 ADR-0005；
- 迁移执行器流程:`VACUUM INTO hmp.db.bak-<timestamp>` → 应用 up → 记录版本;回滚 = 执行 down(或从备份恢复,二路均须演练,SC-006);
- 首版迁移 `0001_init` 建立上述全部表与索引。

## 宪章核对

- ✅ 每表显式 `household_id`,查询强制携带(ADR-0003);
- ✅ 个人数据边界预留:本阶段无个人表,`active_profile_id` 是唯一 profile 关联且由服务端维护;
- ✅ 密码/PIN/令牌仅存哈希;DTO 白名单式输出(FR-007);
- ✅ 迁移向前兼容 + 经测试回滚(宪章技术约束 3)。
