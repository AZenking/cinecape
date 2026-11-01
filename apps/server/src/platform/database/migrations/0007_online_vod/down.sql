-- 0007_online_vod · 回滚:仅删除本迁移新增的 17 张表、还原三张既有表的枚举 CHECK 重建与
-- 六张既有表的扩展列;代际标记保持 user_version = 2(0006 up 后的原值,readiness 门禁同源),
-- 完整保留 0001~0006 的身份/策略/目录/EPG/绑定/播放/个人体验数据(down 对既有行零丢失)。
-- ⚠️ 非空在线 down 拒绝(010 data-model §8):任何在线点播业务数据(vod_*/过渡/幂等/观测/回执/
--    偏好等新表行,或 media_source kind='vod'、media_item media_role<>'standalone'、
--    source_entry identity_kind='vod_episode'、playback_source locator_kind='online' 足迹)
--    存在时,本回滚属破坏性删除 —— 由 migrate.ts 在应用本文件前拒绝(错误退出,不做任何修改);
--    正式回滚采用升级前一致备份 + 匹配镜像,新在线业务另导出留存。临时空库可 down(演练)。
-- ⚠️ 个人观看历史/进度随扩展列删除仅丢失 010 新增列(continuity/evidence/completed),
--    基础历史列原样保留;完整恢复须使用停服下回滚前的一致性备份,并核验
--    integrity_check / foreign_key_check。down/恢复只对独立临时目录执行,
--    不在当前用户库执行任何演练。
-- 重建方式同 up.sql:建 _build → 完整回填 → DROP 旧表 → RENAME → 重建索引(SQLite 12-step
-- 改写为 FK 开启下亦逐语句零违反的等价序列:引用子表先暂存清空、父行就位后再回填;
-- 不依赖任何 foreign_keys 连接开关,提交后仍由 migrate.ts 全库 foreign_key_check 复核);
-- 既有子表(playback_session → playback_source,source_refresh / epg_channel /
-- manual_epg_binding → media_source 等)按表名引用,重建后指向同名新表,行与键不变。
-- DROP COLUMN 依据:better-sqlite3 13.0.3 打包 SQLite ≥3.35(与 0006 down 先例一致);
-- 被删列的列级命名 CHECK 随列一并消失,均未被任何索引引用,DROP COLUMN 合法。

-- 1) 引用子表暂存与清空(与 up.sql §5.0 同机制,镜像回滚):凡引用 media_source /
--    source_entry / playback_source 的既有表先全量暂存至 temp、再叶→根清空,使三张
--    还原重建的 DROP(隐式 DELETE)时刻引用子行为空;media_source↔source_refresh
--    互引用环以「先 UPDATE last_job_id = NULL 断边、还原后按暂存精确还原」消除。
--    FK 开启连接上亦逐语句零违反;temp 表随事务结束消失,既有行零丢失。
--    ⚠️ 17 张新表的 DROP 必须排在本节与三表还原重建(§4)之后:FK=ON 下,仍带
--    vod_episode 外键的 0007 形态 playback_source 在 vod_episode 被删后连 DML 都无法
--    预编译(no such table);先将其重建回 0006 形态,再删新表,顺序即自洽。
CREATE TEMP TABLE _stage_media_source        AS SELECT * FROM media_source;
CREATE TEMP TABLE _stage_source_refresh      AS SELECT * FROM source_refresh;
CREATE TEMP TABLE _stage_epg_channel         AS SELECT * FROM epg_channel;
CREATE TEMP TABLE _stage_epg_programme       AS SELECT * FROM epg_programme;
CREATE TEMP TABLE _stage_refresh_stage_entry AS SELECT * FROM refresh_stage_entry;
CREATE TEMP TABLE _stage_manual_epg_binding  AS SELECT * FROM manual_epg_binding;
CREATE TEMP TABLE _stage_source_entry        AS SELECT * FROM source_entry;
CREATE TEMP TABLE _stage_playback_source     AS SELECT * FROM playback_source;
CREATE TEMP TABLE _stage_playback_session    AS SELECT * FROM playback_session;
CREATE TEMP TABLE _stage_playback_ticket     AS SELECT * FROM playback_ticket;
CREATE TEMP TABLE _stage_playback_conversion AS SELECT * FROM playback_conversion;
CREATE TEMP TABLE _stage_playback_progress_state AS SELECT * FROM playback_progress_state;

UPDATE media_source SET last_job_id = NULL;
DELETE FROM epg_programme;
DELETE FROM epg_channel;
DELETE FROM refresh_stage_entry;
DELETE FROM manual_epg_binding;
DELETE FROM playback_ticket;
DELETE FROM playback_conversion;
DELETE FROM playback_progress_state;
DELETE FROM playback_session;
DELETE FROM playback_source;
DELETE FROM source_entry;
DELETE FROM source_refresh;
DELETE FROM media_source;

-- 2) media_source 还原 0006 终态(kind 不含 vod,无 locator_revision;
--    在线足迹非空时已由 migrate.ts 拒绝,此处既有行必为 iptv/epg/nas)
CREATE TABLE media_source_build (
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
    -- 0004 增补(ADR-0008)
    epg_generation          INTEGER NOT NULL DEFAULT 0,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL,
    CONSTRAINT media_source_kind_check CHECK (kind IN ('iptv', 'epg', 'nas')),
    CONSTRAINT media_source_name_check CHECK (length(name) BETWEEN 1 AND 100),
    -- remote_url:iptv/epg 必填,nas 必为 null
    CONSTRAINT media_source_remote_url_check CHECK (
        (kind IN ('iptv', 'epg') AND remote_url IS NOT NULL)
        OR (kind = 'nas' AND remote_url IS NULL)
    ),
    -- root_key/relative_directory:仅 nas 必填,其他类型必为 null
    CONSTRAINT media_source_nas_root_check CHECK (
        (kind = 'nas' AND root_key IS NOT NULL AND relative_directory IS NOT NULL)
        OR (kind IN ('iptv', 'epg') AND root_key IS NULL AND relative_directory IS NULL)
    ),
    CONSTRAINT media_source_private_access_check CHECK (private_access_approved IN (0, 1)),
    CONSTRAINT media_source_epg_source_kind_check CHECK (epg_source_id IS NULL OR kind = 'iptv'),
    CONSTRAINT media_source_enabled_check CHECK (enabled IN (0, 1)),
    CONSTRAINT media_source_version_check CHECK (version >= 1),
    CONSTRAINT media_source_epg_generation_check CHECK (epg_generation >= 0),
    FOREIGN KEY (household_id, epg_source_id) REFERENCES media_source (household_id, id),
    FOREIGN KEY (household_id, last_job_id) REFERENCES source_refresh (household_id, id)
);

-- 完整回填(既有行零丢失;行取自 §1.5 暂存)。epg_source_id(自引用)与 last_job_id
-- (→source_refresh,尚未回填)先置 NULL,还原见下方 UPDATE。
INSERT INTO media_source_build (
    id, household_id, kind, name, remote_url, root_key, relative_directory,
    private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id,
    epg_generation, created_at, updated_at
)
SELECT
    id, household_id, kind, name, remote_url, root_key, relative_directory,
    private_access_approved, NULL, enabled, version, last_success_at, NULL,
    epg_generation, created_at, updated_at
FROM temp._stage_media_source;

DROP TABLE media_source;
ALTER TABLE media_source_build RENAME TO media_source;
CREATE UNIQUE INDEX media_source_household_id_id_key ON media_source (household_id, id);

-- 引用列还原(目标行已全部就位):先还原自引用 epg_source_id,回填 source_refresh,
-- 后还原 last_job_id;再回填 media_source 其余引用子表
UPDATE media_source SET epg_source_id = (
    SELECT s.epg_source_id FROM temp._stage_media_source AS s
    WHERE s.household_id = media_source.household_id AND s.id = media_source.id
);
INSERT INTO source_refresh SELECT * FROM temp._stage_source_refresh;
UPDATE media_source SET last_job_id = (
    SELECT s.last_job_id FROM temp._stage_media_source AS s
    WHERE s.household_id = media_source.household_id AND s.id = media_source.id
);
INSERT INTO epg_channel SELECT * FROM temp._stage_epg_channel;
INSERT INTO manual_epg_binding SELECT * FROM temp._stage_manual_epg_binding;

-- 3) source_entry 还原 0006 终态(identity_kind 不含 vod_episode,其余列/约束逐字同 0006)
CREATE TABLE source_entry_build (
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
    -- 0006 增补(005 data-model §2):M3U 发布分组;CHECK 保持列级(与 0006 up 的
    -- ADD COLUMN ... CONSTRAINT 形态逐字同构 —— 表级 CHECK 会令 0006 down 的
    -- DROP COLUMN group_title 残留引用而重解析失败)
    group_title         TEXT
        CONSTRAINT source_entry_group_title_check CHECK (
            group_title IS NULL
            OR (group_title = trim(group_title) AND length(group_title) BETWEEN 1 AND 100)
        ),
    CONSTRAINT source_entry_identity_kind_check CHECK (
        identity_kind IN ('tvg_id', 'url', 'path')
    ),
    CONSTRAINT source_entry_identity_digest_check CHECK (
        length(identity_digest) = 64 AND identity_digest NOT GLOB '*[^0-9a-f]*'
    ),
    CONSTRAINT source_entry_present_check CHECK (present IN (0, 1)),
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

INSERT INTO source_entry_build (
    id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id,
    present, last_seen_job_id, first_seen_at, last_seen_at, missing_since,
    file_size_text, file_mtime_ns, group_title
)
SELECT
    id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id,
    present, last_seen_job_id, first_seen_at, last_seen_at, missing_since,
    file_size_text, file_mtime_ns, group_title
FROM temp._stage_source_entry;

DROP TABLE source_entry;
ALTER TABLE source_entry_build RENAME TO source_entry;
CREATE UNIQUE INDEX source_entry_household_id_id_key ON source_entry (household_id, id);
CREATE UNIQUE INDEX source_entry_identity_key
    ON source_entry (household_id, source_id, identity_kind, identity_digest);
CREATE INDEX source_entry_household_media_key ON source_entry (household_id, media_id);

-- source_entry 的引用子表回填(父表已就位)
INSERT INTO refresh_stage_entry SELECT * FROM temp._stage_refresh_stage_entry;
INSERT INTO epg_programme SELECT * FROM temp._stage_epg_programme;

-- 4) playback_source 还原 0006 终态(location 恢复 NOT NULL;无 locator_kind/vod_episode_id;
--    在线足迹非空时已由 migrate.ts 拒绝,此处既有行必为静态定位)
CREATE TABLE playback_source_build (
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

INSERT INTO playback_source_build (
    id, household_id, source_id, source_entry_id, media_item_id, protocol, location,
    mime_type, priority, requires_proxy, created_at, updated_at
)
SELECT
    id, household_id, source_id, source_entry_id, media_item_id, protocol, location,
    mime_type, priority, requires_proxy, created_at, updated_at
FROM temp._stage_playback_source;

DROP TABLE playback_source;
ALTER TABLE playback_source_build RENAME TO playback_source;
CREATE UNIQUE INDEX playback_source_household_id_id_key ON playback_source (household_id, id);
CREATE UNIQUE INDEX playback_source_entry_key ON playback_source (household_id, source_entry_id);

-- 4.5) 17 张新表(此刻全部为空且无任何既有表引用;子表在前;间互外键:
--      vod_registered_candidate→operation、slot→intent、intent→receipt/next_plan、
--      sequence→episode/line、episode→line、line→title)。排在此处的原因见 §1 注。
DROP TABLE vod_registered_candidate;
DROP TABLE playback_transition_slot;
DROP TABLE playback_transition_intent;
DROP TABLE playback_next_plan;
DROP TABLE playback_finish_receipt;
DROP TABLE playback_phase_observation;
DROP TABLE playback_input_binding;
DROP TABLE vod_episode_sequence;
DROP TABLE vod_detail_snapshot;
DROP TABLE vod_episode;
DROP TABLE vod_line;
DROP TABLE vod_title;
DROP TABLE vod_materialization_operation;
DROP TABLE profile_vod_preference_operation;
DROP TABLE profile_vod_preferences;
DROP TABLE vod_source_config;
DROP TABLE media_relation;

-- 会话族引用子表回填(根→叶;行含 010 扩展列,下方第 5 节 DROP COLUMN 时随列移除)
INSERT INTO playback_session SELECT * FROM temp._stage_playback_session;
INSERT INTO playback_ticket SELECT * FROM temp._stage_playback_ticket;
INSERT INTO playback_conversion SELECT * FROM temp._stage_playback_conversion;
INSERT INTO playback_progress_state SELECT * FROM temp._stage_playback_progress_state;

-- 暂存清理(temp 表亦随事务结束自动消失)
DROP TABLE temp._stage_media_source;
DROP TABLE temp._stage_source_refresh;
DROP TABLE temp._stage_epg_channel;
DROP TABLE temp._stage_epg_programme;
DROP TABLE temp._stage_refresh_stage_entry;
DROP TABLE temp._stage_manual_epg_binding;
DROP TABLE temp._stage_source_entry;
DROP TABLE temp._stage_playback_source;
DROP TABLE temp._stage_playback_session;
DROP TABLE temp._stage_playback_ticket;
DROP TABLE temp._stage_playback_conversion;
DROP TABLE temp._stage_playback_progress_state;

-- 5) 既有表扩展列(列级命名 CHECK 随列消失;均未被任何索引引用,DROP COLUMN 合法)

-- media_item.media_role(旧记录 standalone;回滚后恢复全部 standalone 原状)
ALTER TABLE media_item DROP COLUMN media_role;

-- playback_session(010 T013,§10):起播标记与持久清理三列
-- (cleanup_reason 的配对 CHECK 引用 cleanup_requested,须先删 reason 再删 requested)
ALTER TABLE playback_session DROP COLUMN playback_started_at;
ALTER TABLE playback_session DROP COLUMN cleanup_reason;
ALTER TABLE playback_session DROP COLUMN cleanup_requested;
ALTER TABLE playback_session DROP COLUMN cleanup_state;

-- playback_progress_state(010 T012,§5):会话 ledger 扩展列(含数据模型规范命名的
-- ledger_position/ledger_duration 两列;010 收敛:别名旧列 *_seconds 已自 up 本体删除,
-- 本节与 up 列面逐列对称)
ALTER TABLE playback_progress_state DROP COLUMN continuity_revision;
ALTER TABLE playback_progress_state DROP COLUMN ledger_position;
ALTER TABLE playback_progress_state DROP COLUMN ledger_duration;
ALTER TABLE playback_progress_state DROP COLUMN ledger_generation;
ALTER TABLE playback_progress_state DROP COLUMN ledger_accepted_at;
ALTER TABLE playback_progress_state DROP COLUMN session_started;

-- profile_viewing_history(010 T012,§5):仅丢 010 新增列,基础历史列原样保留
ALTER TABLE profile_viewing_history DROP COLUMN continuity_revision;
ALTER TABLE profile_viewing_history DROP COLUMN evidence_state;
ALTER TABLE profile_viewing_history DROP COLUMN evidence_digest;
ALTER TABLE profile_viewing_history DROP COLUMN completed;

-- 6) 代际标记:还原 0006 up 后原值 2(readiness 门禁以 user_version=2 + 记录与目录一致判定;
--    down 到 0006 终态后可再次 up 0007,空库 up→down→up 可重复演练)
PRAGMA user_version = 2;
