-- 0012_programme_posters(020-tmdb-programme-posters,data-model.md §1/§2):
-- TMDB 节目海报标题级缓存 + epg_programme 两个引用列。
-- ⚠️ 本文件与 src/platform/database/schema.ts 必须同步修改;禁止修改既有 0001~0011 SQL。
-- 零回填:SQLite 无法复现中文标题归一化;旧 epg_programme 行在下次 EPG 刷新或
-- tmdb:backfill --backfill-keys 时补齐 poster_match_key。
-- 执行环境:better-sqlite3(连接已开 foreign_keys = ON / WAL),由 migrate.ts 在事务内应用。
-- 硬约束(宪章原则二/四):programme_poster 显式 household_id;时间为 UTC ISO-8601 TEXT;
-- 不设 user_version(与 0007~0011 同属代际 2 可回滚尾段,up/down 均保持 user_version=2)。

-- 1) epg_programme.poster_match_key:标题归一化键(缓存主键);通用栏目/空标题为 NULL。
ALTER TABLE epg_programme
    ADD COLUMN poster_match_key TEXT
    CONSTRAINT epg_programme_poster_match_key_check CHECK (
        poster_match_key IS NULL OR length(poster_match_key) BETWEEN 1 AND 255
    );

-- 2) epg_programme.poster_ref:不透明海报引用(32 位小写 hex);无海报为 NULL。
ALTER TABLE epg_programme
    ADD COLUMN poster_ref TEXT
    CONSTRAINT epg_programme_poster_ref_check CHECK (
        poster_ref IS NULL
        OR (length(poster_ref) = 32 AND poster_ref NOT GLOB '*[^0-9a-f]*')
    );

-- 3) 按家庭+标题键批量更新节目行(补全服务一次事务内回写)。
CREATE INDEX epg_programme_household_match_key_idx
    ON epg_programme (household_id, poster_match_key);

-- 4) programme_poster:每家庭每归一化标题一行;matched 持有 ref/poster_path,
--    no_match/failed 为负缓存(TTL 到期后重查);缓存跨 EPG 窗口替换保留。
CREATE TABLE programme_poster (
    household_id    TEXT NOT NULL REFERENCES household(id),
    match_key       TEXT NOT NULL,
    ref             TEXT,
    state           TEXT NOT NULL,
    tmdb_id         INTEGER,
    media_type      TEXT,
    title           TEXT,
    original_title  TEXT,
    poster_path     TEXT,
    release_date    TEXT,
    vote_average    REAL,
    popularity      REAL,
    match_score     REAL,
    year_hint       INTEGER,
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    expires_at      TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    CONSTRAINT programme_poster_pk PRIMARY KEY (household_id, match_key),
    CONSTRAINT programme_poster_state_check CHECK (state IN ('matched', 'no_match', 'failed')),
    CONSTRAINT programme_poster_match_key_check CHECK (length(match_key) BETWEEN 1 AND 255),
    CONSTRAINT programme_poster_ref_check CHECK (
        ref IS NULL OR (length(ref) = 32 AND ref NOT GLOB '*[^0-9a-f]*')
    ),
    CONSTRAINT programme_poster_state_fields_check CHECK (
        (state = 'matched'
            AND ref IS NOT NULL
            AND tmdb_id IS NOT NULL
            AND media_type IN ('movie', 'tv')
            AND poster_path IS NOT NULL)
        OR
        (state <> 'matched'
            AND ref IS NULL
            AND tmdb_id IS NULL
            AND poster_path IS NULL)
    ),
    CONSTRAINT programme_poster_poster_path_check CHECK (
        poster_path IS NULL
        OR (poster_path LIKE '/%' AND poster_path NOT LIKE '//%' AND length(poster_path) <= 512)
    ),
    CONSTRAINT programme_poster_year_hint_check CHECK (year_hint IS NULL OR year_hint BETWEEN 1900 AND 2100),
    CONSTRAINT programme_poster_attempts_check CHECK (attempts >= 0)
);

CREATE UNIQUE INDEX programme_poster_household_id_ref_key
    ON programme_poster (household_id, ref);

CREATE INDEX programme_poster_expiry_idx
    ON programme_poster (household_id, expires_at);