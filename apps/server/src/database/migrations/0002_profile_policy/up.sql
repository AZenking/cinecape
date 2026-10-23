-- 0002_profile_policy · 阶段 2迁移:profile_policy / parent_verification_state
-- 权威列定义:docs/specs/002-profile-policy/data-model.md
-- ⚠️ 本文件与 src/database/schema.ts 必须同步修改(schema.ts 仅为查询层类型)。
-- 执行环境:better-sqlite3(连接已开 foreign_keys = ON / WAL),由 migrate.ts 在事务内应用。

-- 1) profile 复合唯一键:profile_policy(household_id, profile_id) 复合外键的目标
--    (household_id 在 profile 已有普通列;此处补 (household_id, id) 唯一以便复合 FK 引用)
CREATE UNIQUE INDEX profile_household_id_id_key ON profile (household_id, id);

-- 2) ProfilePolicy:一档案一策略(复合主键 + UNIQUE(profile_id)),显式 household 边界(宪章原则二)
CREATE TABLE profile_policy (
    household_id        TEXT NOT NULL REFERENCES household(id),
    profile_id          TEXT NOT NULL,
    max_content_level   INTEGER NOT NULL,
    allow_unrated       INTEGER NOT NULL,
    allowed_media_ids   TEXT NOT NULL DEFAULT '[]',
    blocked_media_ids   TEXT NOT NULL DEFAULT '[]',
    allowed_channel_ids TEXT NOT NULL DEFAULT '[]',
    version             INTEGER NOT NULL DEFAULT 1,
    updated_at          TEXT NOT NULL,
    PRIMARY KEY (household_id, profile_id),
    CONSTRAINT profile_policy_unique_profile UNIQUE (profile_id),
    CONSTRAINT profile_policy_level_check   CHECK (max_content_level BETWEEN 0 AND 18),
    CONSTRAINT profile_policy_unrated_check CHECK (allow_unrated IN (0, 1)),
    CONSTRAINT profile_policy_version_check CHECK (version >= 1),
    CONSTRAINT profile_policy_allowed_json_check  CHECK (json_valid(allowed_media_ids)  AND json_type(allowed_media_ids)  = 'array'),
    CONSTRAINT profile_policy_blocked_json_check  CHECK (json_valid(blocked_media_ids)  AND json_type(blocked_media_ids)  = 'array'),
    CONSTRAINT profile_policy_channel_json_check  CHECK (json_valid(allowed_channel_ids) AND json_type(allowed_channel_ids) = 'array'),
    FOREIGN KEY (household_id, profile_id) REFERENCES profile (household_id, id)
);

-- 3) 家长验证状态:账号范围失败计数与锁定(不存密码;密码仍以 account.password_hash 校验)
CREATE TABLE parent_verification_state (
    household_id    TEXT NOT NULL,
    account_id      TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    TEXT,
    PRIMARY KEY (household_id, account_id),
    CONSTRAINT parent_verification_attempts_check CHECK (failed_attempts >= 0),
    FOREIGN KEY (household_id, account_id) REFERENCES account (household_id, id)
);

-- 4) 存量回填:每个档案(含 disabled)一条默认策略 —— adult 18/允许未评级,child 12/禁止未评级(FR-002)
INSERT INTO profile_policy
    (household_id, profile_id, max_content_level, allow_unrated,
     allowed_media_ids, blocked_media_ids, allowed_channel_ids, version, updated_at)
SELECT
    p.household_id,
    p.id,
    CASE p.type WHEN 'adult' THEN 18 ELSE 12 END,
    CASE p.type WHEN 'adult' THEN 1 ELSE 0 END,
    '[]', '[]', '[]',
    1,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM profile p;

-- 5) 升级安全(FR-012/边缘):家庭存在任一儿童档案(含停用)时,清空引用未设 PIN 成人的
--    活动会话上下文,要求重新选择并验证;会话令牌与身份数据不变
UPDATE device_session
SET active_profile_id = NULL
WHERE active_profile_id IS NOT NULL
  AND active_profile_id IN (
      SELECT p.id
      FROM profile p
      WHERE p.type = 'adult'
        AND p.pin_hash IS NULL
        AND p.household_id IN (SELECT DISTINCT household_id FROM profile WHERE type = 'child')
  );
