-- 0003_media_catalog · 阶段 3 迁移:媒体目录与来源(9 张新表 + 存量家庭 catalog_state 回填)
-- 权威列定义:docs/specs/003-media-catalog/data-model.md
-- ⚠️ 本文件与 src/database/schema.ts 必须同步修改(schema.ts 仅为查询层类型)。
-- 执行环境:better-sqlite3(连接已开 foreign_keys = ON / WAL),由 migrate.ts 在事务内应用。
-- 硬约束(宪章原则二/四):全部新表显式 household_id 边界;复合外键以 (household_id, id)
-- 或既有唯一键为目标,禁止跨家庭 source/entry/media/job/EPG 关联;时间为 UTC;
-- 文件大小/mtimeNs 以十进制文本保存,避免 JS 整数精度截断。

-- 1) 复合外键目标补充:device_session(household_id, id)
--    source_refresh.initiator_session_id 的复合外键目标(与 0002 的 profile_household_id_id_key 同规则)
CREATE UNIQUE INDEX device_session_household_id_id_key ON device_session (household_id, id);

-- 2) catalog_state:家庭目录修订。主键即 household_id(一家庭一行),
--    每次目录发布/来源配置变更/人工元数据修改加一;只读查询与策略编辑不动它。
CREATE TABLE catalog_state (
    household_id TEXT PRIMARY KEY NOT NULL REFERENCES household(id),
    revision     INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT catalog_state_revision_check CHECK (revision >= 1)
);

-- 3) media_source:家庭媒体来源(iptv / epg / nas)。无硬删除,禁用保留引用;
--    remote_url 为私有字段,不直接进入 DTO/日志。kind 创建后不可转换由应用层保证(无变更入口)。
CREATE TABLE media_source (
    id                      TEXT PRIMARY KEY NOT NULL,
    household_id            TEXT NOT NULL REFERENCES household(id),
    kind                    TEXT NOT NULL,
    name                    TEXT NOT NULL,
    remote_url              TEXT,
    root_key                TEXT,
    relative_directory      TEXT,
    private_access_approved INTEGER NOT NULL DEFAULT 0,
    epg_source_id           TEXT,
    enabled                 INTEGER NOT NULL DEFAULT 1,
    version                 INTEGER NOT NULL DEFAULT 1,
    last_success_at         TEXT,
    last_job_id             TEXT,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL,
    CONSTRAINT media_source_kind_check CHECK (kind IN ('iptv', 'epg', 'nas')),
    CONSTRAINT media_source_name_check CHECK (length(name) BETWEEN 1 AND 100),
    -- remote_url:iptv/epg 必填,nas 必为 null
    CONSTRAINT media_source_remote_url_check CHECK (
        (kind IN ('iptv', 'epg') AND remote_url IS NOT NULL)
        OR (kind = 'nas' AND remote_url IS NULL)
    ),
    -- root_key/relative_directory:仅 nas 必填,其他类型必为 null(root_key 须在部署 MEDIA_ROOTS 内)
    CONSTRAINT media_source_nas_root_check CHECK (
        (kind = 'nas' AND root_key IS NOT NULL AND relative_directory IS NOT NULL)
        OR (kind IN ('iptv', 'epg') AND root_key IS NULL AND relative_directory IS NULL)
    ),
    CONSTRAINT media_source_private_access_check CHECK (private_access_approved IN (0, 1)),
    -- epg_source_id:仅 iptv 可有值(须同家庭 kind=epg 且非自引用,由应用事务额外校验;
    --   允许关联暂时禁用的 EPG,观看时无节目)
    CONSTRAINT media_source_epg_source_kind_check CHECK (epg_source_id IS NULL OR kind = 'iptv'),
    CONSTRAINT media_source_enabled_check CHECK (enabled IN (0, 1)),
    CONSTRAINT media_source_version_check CHECK (version >= 1),
    -- 同家庭自引用:epg_source_id 必须指向同家庭来源(目标唯一索引见文件末尾)
    FOREIGN KEY (household_id, epg_source_id) REFERENCES media_source (household_id, id),
    -- last_job_id 仅记录同家庭来源的成功任务(目标表在本语句之后创建,
    -- SQLite 外键延迟到 DML 时解析,同一迁移内合法)
    FOREIGN KEY (household_id, last_job_id) REFERENCES source_refresh (household_id, id)
);

-- 4) media_item:家庭媒体条目。type 在非频道四类间可改,channel 与非 channel 禁止互转、
--    人工标题/类型不被普通刷新覆盖 —— 均由应用层保证;不建立 Series/Episode 层级。
CREATE TABLE media_item (
    id               TEXT PRIMARY KEY NOT NULL,
    household_id     TEXT NOT NULL REFERENCES household(id),
    type             TEXT NOT NULL,
    title            TEXT NOT NULL,
    description      TEXT,
    poster_ref       TEXT,
    content_level    INTEGER,
    title_overridden INTEGER NOT NULL DEFAULT 0,
    type_overridden  INTEGER NOT NULL DEFAULT 0,
    version          INTEGER NOT NULL,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    CONSTRAINT media_item_type_check CHECK (type IN ('channel', 'movie', 'series', 'episode', 'video')),
    CONSTRAINT media_item_title_check CHECK (length(title) BETWEEN 1 AND 255),
    CONSTRAINT media_item_description_check CHECK (description IS NULL OR length(description) <= 4096),
    -- 等级:null(未评级)或 0~18 整数;未知外部等级不导入内部等级
    CONSTRAINT media_item_content_level_check CHECK (content_level IS NULL OR content_level BETWEEN 0 AND 18),
    CONSTRAINT media_item_title_overridden_check CHECK (title_overridden IN (0, 1)),
    CONSTRAINT media_item_type_overridden_check CHECK (type_overridden IN (0, 1)),
    CONSTRAINT media_item_version_check CHECK (version >= 1)
);

-- 5) source_refresh:持久刷新任务。仅存 initiator 账号/会话 ID,不存密码/token;
--    状态机 queued → running → succeeded/awaiting_confirmation/failed,
--    awaiting_confirmation → succeeded/discarded/expired/stale,queued/running 重启恢复 → interrupted。
CREATE TABLE source_refresh (
    id                   TEXT PRIMARY KEY NOT NULL,
    household_id         TEXT NOT NULL REFERENCES household(id),
    source_id            TEXT NOT NULL,
    initiator_account_id TEXT NOT NULL,
    initiator_session_id TEXT NOT NULL,
    operation_key        TEXT NOT NULL,
    status               TEXT NOT NULL,
    version              INTEGER NOT NULL,
    source_version       INTEGER NOT NULL,
    baseline_revision    INTEGER NOT NULL,
    snapshot_digest      TEXT,
    item_count           INTEGER,
    summary_json         TEXT,
    error_code           TEXT,
    created_at           TEXT NOT NULL,
    started_at           TEXT,
    finished_at          TEXT,
    expires_at           TEXT,
    CONSTRAINT source_refresh_status_check CHECK (status IN (
        'queued', 'running', 'succeeded', 'failed',
        'awaiting_confirmation', 'interrupted', 'discarded', 'expired', 'stale'
    )),
    CONSTRAINT source_refresh_version_check           CHECK (version >= 1),
    CONSTRAINT source_refresh_source_version_check    CHECK (source_version >= 1),
    CONSTRAINT source_refresh_baseline_revision_check CHECK (baseline_revision >= 1),
    CONSTRAINT source_refresh_item_count_check        CHECK (item_count IS NULL OR item_count >= 0),
    CONSTRAINT source_refresh_summary_json_check      CHECK (summary_json IS NULL OR json_valid(summary_json)),
    -- 任务/快照/发起者全部绑定同家庭资源,禁止跨家庭关联
    FOREIGN KEY (household_id, source_id)            REFERENCES media_source (household_id, id),
    FOREIGN KEY (household_id, initiator_account_id) REFERENCES account (household_id, id),
    FOREIGN KEY (household_id, initiator_session_id) REFERENCES device_session (household_id, id)
);

-- 6) source_entry:来源条目(身份稳定键)。摘要为 SHA-256(类型标签 + 完整标识,
--    tvg-id/路径大小写敏感、URL 不删 query、不做名称回退);条目消失仅改 present,重现复用 media_id。
CREATE TABLE source_entry (
    id                  TEXT PRIMARY KEY NOT NULL,
    household_id        TEXT NOT NULL REFERENCES household(id),
    source_id           TEXT NOT NULL,
    identity_kind       TEXT NOT NULL,
    identity_digest     TEXT NOT NULL,
    media_id            TEXT,
    upstream_channel_id TEXT,
    present             INTEGER NOT NULL DEFAULT 1,
    last_seen_job_id    TEXT,
    first_seen_at       TEXT NOT NULL,
    last_seen_at        TEXT NOT NULL,
    missing_since       TEXT,
    file_size_text      TEXT,
    file_mtime_ns       TEXT,
    CONSTRAINT source_entry_identity_kind_check CHECK (identity_kind IN ('tvg_id', 'url', 'path')),
    -- SHA-256 十六进制摘要:64 位小写十六进制字符
    CONSTRAINT source_entry_identity_digest_check CHECK (
        length(identity_digest) = 64 AND identity_digest NOT GLOB '*[^0-9a-f]*'
    ),
    CONSTRAINT source_entry_present_check CHECK (present IN (0, 1)),
    -- file_size_text/file_mtime_ns:非空时必须为十进制文本(仅 NAS 来源写入;空串非法)
    CONSTRAINT source_entry_file_size_check CHECK (
        file_size_text IS NULL OR (length(file_size_text) >= 1 AND file_size_text NOT GLOB '*[^0-9]*')
    ),
    CONSTRAINT source_entry_file_mtime_check CHECK (
        file_mtime_ns IS NULL OR (length(file_mtime_ns) >= 1 AND file_mtime_ns NOT GLOB '*[^0-9]*')
    ),
    FOREIGN KEY (household_id, source_id)        REFERENCES media_source (household_id, id),
    FOREIGN KEY (household_id, media_id)         REFERENCES media_item (household_id, id),
    FOREIGN KEY (household_id, last_seen_job_id) REFERENCES source_refresh (household_id, id)
);

-- 7) playback_source:播放资源记录(私有 location,不下发播放 URL;协议仅描述资源类型)。
--    首期每条目至多一个资源;三元组 (source, entry, media) 一致性由复合外键共同绑定同家庭。
CREATE TABLE playback_source (
    id              TEXT PRIMARY KEY NOT NULL,
    household_id    TEXT NOT NULL REFERENCES household(id),
    source_id       TEXT NOT NULL,
    source_entry_id TEXT NOT NULL,
    media_item_id   TEXT NOT NULL,
    protocol        TEXT NOT NULL,
    location        TEXT NOT NULL,
    mime_type       TEXT,
    priority        INTEGER NOT NULL DEFAULT 100,
    requires_proxy  INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    CONSTRAINT playback_source_protocol_check CHECK (protocol IN ('hls', 'dash', 'file', 'flv', 'http')),
    CONSTRAINT playback_source_priority_check CHECK (priority >= 0),
    CONSTRAINT playback_source_proxy_check    CHECK (requires_proxy IN (0, 1)),
    FOREIGN KEY (household_id, source_id)       REFERENCES media_source (household_id, id),
    FOREIGN KEY (household_id, source_entry_id) REFERENCES source_entry (household_id, id),
    FOREIGN KEY (household_id, media_item_id)   REFERENCES media_item (household_id, id)
);

-- 8) epg_channel:XMLTV 频道。唯一键即 (household_id, source_id, xmltv_channel_id),
--    同时作为 epg_programme 复合外键目标;XMLTV 频道 ID 不与平台 media_id 混用。
CREATE TABLE epg_channel (
    household_id     TEXT NOT NULL REFERENCES household(id),
    source_id        TEXT NOT NULL,
    xmltv_channel_id TEXT NOT NULL,
    display_name     TEXT NOT NULL,
    conflicted       INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT epg_channel_conflicted_check CHECK (conflicted IN (0, 1)),
    PRIMARY KEY (household_id, source_id, xmltv_channel_id),
    FOREIGN KEY (household_id, source_id) REFERENCES media_source (household_id, id)
);

-- 9) epg_programme:XMLTV 节目。时间为 UTC ISO-8601 文本(字符串序即时间序),
--    结束必须严格大于开始;完全相同节目按唯一键去重,时间重叠由应用标 conflicted。
CREATE TABLE epg_programme (
    id               TEXT PRIMARY KEY NOT NULL,
    household_id     TEXT NOT NULL REFERENCES household(id),
    source_id        TEXT NOT NULL,
    xmltv_channel_id TEXT NOT NULL,
    title            TEXT NOT NULL,
    description      TEXT,
    starts_at        TEXT NOT NULL,
    ends_at          TEXT NOT NULL,
    CONSTRAINT epg_programme_title_check CHECK (length(title) BETWEEN 1 AND 255),
    CONSTRAINT epg_programme_description_check CHECK (description IS NULL OR length(description) <= 4096),
    CONSTRAINT epg_programme_window_check CHECK (ends_at > starts_at),
    -- 复合外键绑定 epg_channel:频道与来源必须同家庭一致
    FOREIGN KEY (household_id, source_id, xmltv_channel_id)
        REFERENCES epg_channel (household_id, source_id, xmltv_channel_id)
);

-- 10) refresh_stage_entry:解析结果私有暂存(payload 内位置等仍为私有信息),
--     分批写入、按 (household_id, refresh_id, entry_key) 归属本次任务,不进入浏览查询。
--     kind 由各导入适配器(M3U/XMLTV/NAS)定义,规格未固定枚举,数据库层不设 CHECK。
CREATE TABLE refresh_stage_entry (
    household_id TEXT NOT NULL REFERENCES household(id),
    refresh_id   TEXT NOT NULL,
    entry_key    TEXT NOT NULL,
    kind         TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (household_id, refresh_id, entry_key),
    CONSTRAINT refresh_stage_entry_payload_json_check CHECK (json_valid(payload_json)),
    FOREIGN KEY (household_id, refresh_id) REFERENCES source_refresh (household_id, id)
);

-- 唯一约束(与 schema.ts 的 uniqueIndex 一一对应;(household_id, id) 同时是复合外键目标)
CREATE UNIQUE INDEX media_source_household_id_id_key   ON media_source (household_id, id);
CREATE UNIQUE INDEX media_item_household_id_id_key     ON media_item (household_id, id);
CREATE UNIQUE INDEX source_refresh_household_id_id_key ON source_refresh (household_id, id);
CREATE UNIQUE INDEX source_entry_household_id_id_key   ON source_entry (household_id, id);
CREATE UNIQUE INDEX playback_source_household_id_id_key ON playback_source (household_id, id);
CREATE UNIQUE INDEX epg_programme_household_id_id_key  ON epg_programme (household_id, id);
-- 身份稳定键:同家庭同来源同类型同摘要唯一(重复 IPTV 身份拒绝,不以最后一条覆盖)
CREATE UNIQUE INDEX source_entry_identity_key ON source_entry (household_id, source_id, identity_kind, identity_digest);
-- 媒体→条目反查:目录可用性关联(present 条目×启用来源×有效资源)按 (household_id, media_id) 精确定位,
-- 避免万条目录下逐条 EXISTS 退化为家庭全表扫描(SC-005 实测 8s→9ms;亦加速发布事务 mark missing)
CREATE INDEX source_entry_household_media_key ON source_entry (household_id, media_id);
-- 首期每条目至多一个播放资源
CREATE UNIQUE INDEX playback_source_entry_key ON playback_source (household_id, source_entry_id);
-- 幂等键:同家庭 operation_key 唯一(同语义重试返回原任务)
CREATE UNIQUE INDEX source_refresh_operation_key ON source_refresh (household_id, operation_key);
-- 运行锁:同 (household_id, source_id) 在 queued/running/awaiting_confirmation 至多一个(部分唯一索引)
CREATE UNIQUE INDEX one_active_refresh_per_source ON source_refresh (household_id, source_id)
    WHERE status IN ('queued', 'running', 'awaiting_confirmation');
-- 完全相同节目去重(不同记录时间重叠不算重复,由应用标 conflicted)
CREATE UNIQUE INDEX epg_programme_slot_key ON epg_programme (household_id, source_id, xmltv_channel_id, starts_at, ends_at);

-- 11) 存量回填:每个既有 Household 一行 catalog_state(revision=1;全新部署无家庭时为空集,
--     后续 initializeHousehold 事务内自行插入唯一 catalog_state,重复初始化不重置修订)
INSERT INTO catalog_state (household_id) SELECT id FROM household;
