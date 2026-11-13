-- 0013_source_governance(021-source-governance,spec.md/contracts/api.md):
-- 1) media_source 软删除(归档);2) 原始导入快照;3) 清理审计。
-- ⚠️ 本文件与 src/platform/database/schema.ts、database.ts、migrate.ts 必须同步修改;
-- 禁止修改 0001~0012 SQL。执行环境 better-sqlite3(foreign_keys=ON / WAL),由 migrate.ts 事务内应用。

-- 1) 来源归档(软删除):独立注册表,避免给 media_source 加列影响既有行。
--    有行=已归档;无行=active。常规列表/刷新准入/优先级投影做 NOT EXISTS 过滤。
CREATE TABLE source_archive (
    household_id TEXT NOT NULL REFERENCES household(id),
    source_id    TEXT NOT NULL,
    archived_at  TEXT NOT NULL,
    archived_by  TEXT,
    CONSTRAINT source_archive_pk PRIMARY KEY (household_id, source_id),
    CONSTRAINT source_archive_archived_at_check CHECK (length(archived_at) >= 20),
    CONSTRAINT source_archive_source_fk
        FOREIGN KEY (household_id, source_id)
        REFERENCES media_source (household_id, id)
);

CREATE INDEX idx_source_archive_household
    ON source_archive (household_id, archived_at);

-- 2) 原始导入快照:每个成功读取的 IPTV/EPG 源保存一份 gzip 原文,供治理页预览/下载。
--    内容统一 gzip 存储;byte_size/sha256 针对原始传输字节;refresh_id 不设外键,
--    避免清理过期刷新任务时被历史快照阻塞。
CREATE TABLE source_import_snapshot (
    id               TEXT PRIMARY KEY,
    household_id     TEXT NOT NULL REFERENCES household(id),
    source_id        TEXT NOT NULL,
    refresh_id       TEXT,
    kind             TEXT NOT NULL,
    content_encoding TEXT NOT NULL DEFAULT 'gzip',
    content          BLOB NOT NULL,
    byte_size        INTEGER NOT NULL,
    sha256           TEXT NOT NULL,
    captured_at      TEXT NOT NULL,
    CONSTRAINT source_import_snapshot_kind_check CHECK (kind IN ('iptv', 'epg')),
    CONSTRAINT source_import_snapshot_encoding_check CHECK (content_encoding = 'gzip'),
    CONSTRAINT source_import_snapshot_byte_size_check CHECK (byte_size >= 0),
    CONSTRAINT source_import_snapshot_sha256_check CHECK (
        length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    CONSTRAINT source_import_snapshot_captured_at_check CHECK (length(captured_at) >= 20),
    CONSTRAINT source_import_snapshot_source_fk
        FOREIGN KEY (household_id, source_id)
        REFERENCES media_source (household_id, id)
);

CREATE INDEX idx_source_import_snapshot_source
    ON source_import_snapshot (household_id, source_id, captured_at DESC);

CREATE INDEX idx_source_import_snapshot_captured
    ON source_import_snapshot (household_id, captured_at);

-- 3) 清理审计:每次真实清理一行(dry-run 不落库),用于治理页追责与回看。
CREATE TABLE governance_cleanup_run (
    id                TEXT PRIMARY KEY,
    household_id      TEXT NOT NULL REFERENCES household(id),
    actor_account_id  TEXT NOT NULL,
    target            TEXT NOT NULL,
    dry_run           INTEGER NOT NULL DEFAULT 0,
    deleted_count     INTEGER NOT NULL DEFAULT 0,
    bytes_freed       INTEGER NOT NULL DEFAULT 0,
    detail_json       TEXT,
    created_at        TEXT NOT NULL,
    CONSTRAINT governance_cleanup_run_target_check CHECK (
        target IN ('expired-programmes', 'stale-entries', 'snapshots', 'refresh-jobs', 'archived-sources')
    ),
    CONSTRAINT governance_cleanup_run_dry_run_check CHECK (dry_run IN (0, 1)),
    CONSTRAINT governance_cleanup_run_deleted_check CHECK (deleted_count >= 0),
    CONSTRAINT governance_cleanup_run_bytes_check CHECK (bytes_freed >= 0),
    CONSTRAINT governance_cleanup_run_detail_check CHECK (detail_json IS NULL OR json_valid(detail_json))
);

CREATE INDEX idx_governance_cleanup_run_household
    ON governance_cleanup_run (household_id, created_at DESC);