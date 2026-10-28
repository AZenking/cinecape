-- 0001_init · 首版迁移:household / account / profile / device / device_session
-- 权威列定义:docs/specs/001-scaffold-identity-foundation/data-model.md
-- ⚠️ 本文件与 src/platform/database/schema.ts 必须同步修改(schema.ts 仅为查询层类型)。
-- 执行环境:better-sqlite3(连接已开 foreign_keys = ON / WAL),由 migrate.ts 在事务内应用。

CREATE TABLE household (
    id               TEXT PRIMARY KEY NOT NULL,
    name             TEXT NOT NULL,
    default_language TEXT NOT NULL DEFAULT 'zh-CN',
    timezone         TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    created_at       TEXT NOT NULL
);

CREATE TABLE account (
    id                  TEXT PRIMARY KEY NOT NULL,
    household_id        TEXT NOT NULL REFERENCES household(id),
    username            TEXT NOT NULL,
    username_normalized TEXT NOT NULL,
    password_hash       TEXT NOT NULL,
    role                TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    CONSTRAINT account_role_check CHECK (role IN ('owner', 'admin'))
);

CREATE TABLE profile (
    id               TEXT PRIMARY KEY NOT NULL,
    household_id     TEXT NOT NULL REFERENCES household(id),
    account_id       TEXT NOT NULL REFERENCES account(id),
    name             TEXT NOT NULL,
    avatar           TEXT,
    type             TEXT NOT NULL,
    is_default       INTEGER NOT NULL DEFAULT 0,
    pin_hash         TEXT,
    status           TEXT NOT NULL,
    failed_pin_count INTEGER NOT NULL DEFAULT 0,
    pin_locked_until TEXT,
    created_at       TEXT NOT NULL,
    CONSTRAINT profile_type_check       CHECK (type IN ('adult', 'child')),
    CONSTRAINT profile_status_check     CHECK (status IN ('active', 'disabled')),
    CONSTRAINT profile_is_default_check CHECK (is_default IN (0, 1)),
    -- 归属一致性(实现评审修正):复合 FK 保证 account_id 与 household_id 同属一个 account,
    -- 严禁用 UNIQUE(household_id, account_id) 表达 —— 那会把每家庭 Profile 压成 1 行,
    -- 与 Account 1──N Profile 矛盾(data-model.md 已同步修正)。
    FOREIGN KEY (household_id, account_id) REFERENCES account (household_id, id)
);

CREATE TABLE device (
    id           TEXT PRIMARY KEY NOT NULL,
    household_id TEXT NOT NULL REFERENCES household(id),
    name         TEXT,
    type         TEXT NOT NULL,
    last_seen_at TEXT,
    revoked_at   TEXT,
    created_at   TEXT NOT NULL,
    CONSTRAINT device_type_check CHECK (type IN ('web', 'mobile', 'tv', 'nas', 'other'))
);

CREATE TABLE device_session (
    id                TEXT PRIMARY KEY NOT NULL,
    household_id      TEXT NOT NULL REFERENCES household(id),
    account_id        TEXT NOT NULL REFERENCES account(id),
    device_id         TEXT NOT NULL REFERENCES device(id),
    token_hash        TEXT NOT NULL,
    active_profile_id TEXT REFERENCES profile(id),
    expires_at        TEXT NOT NULL,
    revoked_at        TEXT,
    last_active_at    TEXT NOT NULL,
    created_at        TEXT NOT NULL
);

-- 唯一约束(与 schema.ts 的 uniqueIndex 一一对应)
CREATE UNIQUE INDEX account_username_normalized_key ON account (username_normalized);
CREATE UNIQUE INDEX account_household_id_key        ON account (household_id); -- ADR-0002:每 household 最多 1 个主 Account
-- 复合外键目标:profile(household_id, account_id) → account(household_id, id)
CREATE UNIQUE INDEX account_household_id_id_key     ON account (household_id, id);
-- FR-013:每 household 至多一个"可用默认"Profile(部分唯一索引)
-- 注:profile 归属一致性由上方复合外键 (household_id, account_id) → account(household_id, id) 承担。
CREATE UNIQUE INDEX one_default_profile ON profile (household_id) WHERE is_default = 1 AND status = 'active';
CREATE UNIQUE INDEX device_session_token_hash_key   ON device_session (token_hash);
