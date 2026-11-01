-- 0007_online_vod · 010 在线点播接入与追剧体验:来源/目录扩展、稳定映射、会话 ledger 扩展、
-- 物化幂等与单后继过渡(17 张新表 + 六张既有表扩展 + 三张既有表枚举 CHECK 重建)
-- 权威列定义:docs/specs/010-online-vod/data-model.md §1(通用约束)、§2(来源与目录)、
--   §4(物化幂等与配额)、§5(会话 ledger、历史及观测)、§6(固定输入、generation 及起点)、
--   §7(单后继槽与意图)、§10(I1–I5 / U1–U2 新增持久边界);契约冻结 2026-10-30。
-- ⚠️ 本文件与 src/platform/database/schema.ts 必须同步修改(schema.ts 仅为查询层类型);
--    禁止修改既有 0001~0006 SQL。迁移编号经 T002 冻结核验锁定为 0007(不写占号迁移)。
-- 执行环境:better-sqlite3(连接已开 WAL),由 migrate.ts 在事务内应用。
-- 硬约束(010 §1,宪章原则二/四):全部业务表显式 household_id;引用使用家庭复合 FK
--   (目标为父表 (household_id, id) 唯一索引),唯一键都带家庭;ID 服务端生成、不复用;
--   时间为 UTC ISO-8601 TEXT;整数 seq/revision >= 1(仅 next_plan.history_revision 无历史=0),
--   位置/时长有限非负、duration > 0;展示名 1–255,简介 <= 4096;upstreamVodId/lineKey/
--   episodeKey 1–255(NFC+trim 由写入路径执行,不得截断身份)。写入状态转换(幂等重放、
--   TTL/CAS、不可变快照、证据升降级 revision 语义等)由应用层执行;禁止触发器。
--
-- 枚举 CHECK 重建(§8):media_source(kind 加 vod)、source_entry(identity_kind 加 vod_episode)、
--   playback_source(location 放宽可空 + 判别联合)三表按 SQLite 官方 12-step 重建:
--   「建 _build 新表(新约束)→ 同主键完整回填 → DROP 旧表 → RENAME → 重建索引」。
--   ⚠️ 12-step 官方前提是 foreign_keys=OFF,但该 pragma 在事务内不可切换,而迁移 SQL 既会被
--   migrate.ts 在 FK 关闭连接上执行,也会被测试驱动/应用侧在 FK 开启连接的事务内原样执行
--   (迁移文件必须自足)。因此本文件不依赖任何 FK 连接开关,改为把 12-step 改写成
--   FK 开启下亦逐语句零违反的等价序列(§5.0 暂存/清空 → §5a~5c 重建回填 → 引用列还原/子表回填):
--   · 任一 DROP(含其隐式 DELETE)执行时,引用该表的全部子行已清空 → 无即时/延迟 FK 违反;
--   · 任一 INSERT/UPDATE 执行时,其引用的父行已全部就位 → 即时 FK 检查可满足;
--   · media_source ↔ source_refresh 互引用环(last_job_id/source_id)以「先 UPDATE last_job_id
--     = NULL 断边、重建后按 temp 暂存精确还原」消除,无需 defer_foreign_keys;
--   · 既有行零丢失:全部暂存/回填为逐列 SELECT * 全量拷贝(temp 表随事务提交/回滚消失,
--     不在库内遗留任何对象),提交后由 migrate.ts 对全库 PRAGMA foreign_key_check 复核兜底。
-- 回填(§8):旧静态 locator → locator_kind='static'(location 即 static_location,vod 引用为空);
--   旧 media 行 → media_role='standalone';个人扩展默认值:history.completed=0(旧静态历史
--   completed 默认 false,保留现有 canResume 语义)、evidence/continuity 为 NULL(旧记录不冒充
--   在线 continuity 证据)、ledger.continuity_revision=1。
-- 代际标记:readiness 门禁(T007/database.ts)以 user_version=2 + 迁移记录与目录一致判定就绪,
--   0007 属同一交付代际,末尾显式 `PRAGMA user_version = 2`(down 同值还原)。

-- ==========================================================================
-- 1) 来源与目录新表(data-model §2 / §4 / §10)
-- ==========================================================================

-- vod_source_config(§2):一源一行;kind=vod 且来源同家庭由应用事务校验
CREATE TABLE vod_source_config (
    household_id TEXT NOT NULL REFERENCES household(id),
    source_id    TEXT NOT NULL,
    adapter      TEXT NOT NULL,
    PRIMARY KEY (household_id, source_id),
    CONSTRAINT vod_source_config_adapter_check CHECK (adapter = 'apple-cms-json'),
    FOREIGN KEY (household_id, source_id) REFERENCES media_source (household_id, id)
);

-- media_relation(§2):kind=vod_episode 单层父子;child 唯一父;自环被 CHECK 拒绝,
-- 多层与父子角色/同 provider 标题归属为领域校验(应用事务);父没有 playback_source。
-- 数据模型 §2 字段面仅 parent/child/kind/sort_order(无独立 id/created_at):
-- 以 (household_id, child_id) 复合主键同时落实「child 唯一父」唯一约束与行身份。
CREATE TABLE media_relation (
    household_id TEXT NOT NULL REFERENCES household(id),
    parent_id    TEXT NOT NULL,
    child_id     TEXT NOT NULL,
    kind         TEXT NOT NULL,
    sort_order   INTEGER NOT NULL,
    CONSTRAINT media_relation_kind_check       CHECK (kind = 'vod_episode'),
    CONSTRAINT media_relation_sort_order_check CHECK (sort_order >= 1),
    CONSTRAINT media_relation_no_self_loop_check CHECK (parent_id <> child_id),
    PRIMARY KEY (household_id, child_id),
    FOREIGN KEY (household_id, parent_id) REFERENCES media_item (household_id, id),
    FOREIGN KEY (household_id, child_id)  REFERENCES media_item (household_id, id)
);

-- vod_title(§2):物化成功即公共目录,无 enrolledAt;(source,upstream_vod_id) 唯一,父媒体唯一
CREATE TABLE vod_title (
    id                     TEXT PRIMARY KEY NOT NULL,
    household_id           TEXT NOT NULL REFERENCES household(id),
    source_id              TEXT NOT NULL,
    upstream_vod_id        TEXT NOT NULL,
    parent_media_id        TEXT NOT NULL,
    current_detail_revision INTEGER NOT NULL,
    materialized_at        TEXT NOT NULL,
    CONSTRAINT vod_title_upstream_vod_id_check        CHECK (length(upstream_vod_id) BETWEEN 1 AND 255),
    CONSTRAINT vod_title_current_detail_revision_check CHECK (current_detail_revision >= 1),
    FOREIGN KEY (household_id, source_id)       REFERENCES media_source (household_id, id),
    FOREIGN KEY (household_id, parent_media_id) REFERENCES media_item (household_id, id)
);

-- vod_line(§2):重复/空 key 详情显示 unsupported;空 key 被长度 CHECK 拒绝
CREATE TABLE vod_line (
    id           TEXT PRIMARY KEY NOT NULL,
    household_id TEXT NOT NULL REFERENCES household(id),
    title_id     TEXT NOT NULL,
    line_key     TEXT NOT NULL,
    display_name TEXT NOT NULL,
    sort_order   INTEGER NOT NULL,
    CONSTRAINT vod_line_line_key_check     CHECK (length(line_key) BETWEEN 1 AND 255),
    CONSTRAINT vod_line_display_name_check CHECK (length(display_name) BETWEEN 1 AND 255),
    CONSTRAINT vod_line_sort_order_check   CHECK (sort_order >= 1),
    FOREIGN KEY (household_id, title_id) REFERENCES vod_title (household_id, id)
);

-- vod_episode(§2):不保存 source_entry_id(避免第二权威/循环必填),经 source_entry.media_id 与
-- playback_source.vod_episode_id 单向定位;verified 需完整证据,unverified 可 operational 续播。
-- continuity_revision 可空:unverified/无证据集不冒充 continuity 证据(应用层升降级语义)。
CREATE TABLE vod_episode (
    id                    TEXT PRIMARY KEY NOT NULL,
    household_id          TEXT NOT NULL REFERENCES household(id),
    line_id               TEXT NOT NULL,
    episode_key           TEXT NOT NULL,
    label                 TEXT NOT NULL,
    media_id              TEXT NOT NULL,
    content_version_state TEXT NOT NULL,
    evidence_kind         TEXT,
    evidence_digest       TEXT,
    schema_version        TEXT,
    continuity_revision   INTEGER,
    continuity_signature  TEXT,
    CONSTRAINT vod_episode_episode_key_check           CHECK (length(episode_key) BETWEEN 1 AND 255),
    CONSTRAINT vod_episode_label_check                 CHECK (length(label) BETWEEN 1 AND 255),
    CONSTRAINT vod_episode_content_version_state_check CHECK (content_version_state IN ('unverified', 'verified')),
    CONSTRAINT vod_episode_continuity_revision_check   CHECK (continuity_revision IS NULL OR continuity_revision >= 1),
    -- verified 需完整证据(kind/digest/schema_version/signature 齐备);unverified 允许缺省
    CONSTRAINT vod_episode_verified_evidence_check CHECK (
        content_version_state = 'unverified'
        OR (evidence_kind IS NOT NULL AND evidence_digest IS NOT NULL
            AND schema_version IS NOT NULL AND continuity_signature IS NOT NULL)
    ),
    FOREIGN KEY (household_id, line_id)  REFERENCES vod_line (household_id, id),
    FOREIGN KEY (household_id, media_id) REFERENCES media_item (household_id, id)
);

-- vod_detail_snapshot(§2):(title,revision) 唯一,不可变;所有地址私有,不进公共 DTO
CREATE TABLE vod_detail_snapshot (
    household_id             TEXT NOT NULL REFERENCES household(id),
    title_id                 TEXT NOT NULL,
    revision                 INTEGER NOT NULL,
    locator_revision         INTEGER NOT NULL,
    validated_private_payload TEXT NOT NULL,
    fetched_at               TEXT NOT NULL,
    expires_at               TEXT NOT NULL,
    PRIMARY KEY (household_id, title_id, revision),
    CONSTRAINT vod_detail_snapshot_revision_check         CHECK (revision >= 1),
    CONSTRAINT vod_detail_snapshot_locator_revision_check CHECK (locator_revision >= 1),
    CONSTRAINT vod_detail_snapshot_payload_json_check     CHECK (json_valid(validated_private_payload)),
    CONSTRAINT vod_detail_snapshot_expiry_check           CHECK (expires_at > fetched_at),
    FOREIGN KEY (household_id, title_id) REFERENCES vod_title (household_id, id)
);

-- vod_episode_sequence(§2):独立导航快照;状态 ordered/ambiguous/special;只同线明确 N+1,
-- 缺集/重复/季边界不能跳(应用层语义);「导航与身份分开」—— 数据模型未规定行级唯一约束,
-- 同一集不同 sequence_revision/状态快照按序落行(行身份为 rowid;detail_revision 与
-- sequence_revision 一同发布)
CREATE TABLE vod_episode_sequence (
    household_id      TEXT NOT NULL REFERENCES household(id),
    title_id          TEXT NOT NULL,
    line_id           TEXT NOT NULL,
    detail_revision   INTEGER NOT NULL,
    sequence_revision INTEGER NOT NULL,
    episode_id        TEXT NOT NULL,
    season_key        TEXT,
    ordinal           INTEGER NOT NULL,
    sequence_status   TEXT NOT NULL,
    CONSTRAINT vod_episode_sequence_detail_revision_check   CHECK (detail_revision >= 1),
    CONSTRAINT vod_episode_sequence_sequence_revision_check CHECK (sequence_revision >= 1),
    CONSTRAINT vod_episode_sequence_ordinal_check           CHECK (ordinal >= 1),
    CONSTRAINT vod_episode_sequence_status_check            CHECK (sequence_status IN ('ordered', 'ambiguous', 'special')),
    FOREIGN KEY (household_id, title_id)   REFERENCES vod_title (household_id, id),
    FOREIGN KEY (household_id, line_id)    REFERENCES vod_line (household_id, id),
    FOREIGN KEY (household_id, episode_id) REFERENCES vod_episode (household_id, id)
);

-- vod_materialization_operation(§4):唯一(household,device_session,context_version,operation_key);
-- 成功结果与资源同事务提交;固定 24h 保留、重放不延长;committed_at 为 NULL 表示未提交
CREATE TABLE vod_materialization_operation (
    id                          TEXT PRIMARY KEY NOT NULL,
    household_id                TEXT NOT NULL REFERENCES household(id),
    device_session_id           TEXT NOT NULL,
    profile_id                  TEXT NOT NULL,
    profile_context_version     INTEGER NOT NULL,
    operation_key               TEXT NOT NULL,
    request_digest              TEXT NOT NULL,
    parent_media_id             TEXT NOT NULL,
    selected_media_id           TEXT NOT NULL,
    selected_content_revision    INTEGER NOT NULL,
    selected_continuity_revision INTEGER NOT NULL,
    detail_revision             INTEGER NOT NULL,
    catalog_revision            INTEGER NOT NULL,
    result                      TEXT NOT NULL,
    committed_at                TEXT,
    expires_at                  TEXT NOT NULL,
    CONSTRAINT vod_materialization_operation_context_version_check            CHECK (profile_context_version >= 1),
    CONSTRAINT vod_materialization_operation_selected_content_revision_check  CHECK (selected_content_revision >= 1),
    CONSTRAINT vod_materialization_operation_selected_continuity_revision_check CHECK (selected_continuity_revision >= 1),
    CONSTRAINT vod_materialization_operation_detail_revision_check            CHECK (detail_revision >= 1),
    CONSTRAINT vod_materialization_operation_catalog_revision_check           CHECK (catalog_revision >= 1),
    CONSTRAINT vod_materialization_operation_result_json_check                CHECK (json_valid(result)),
    CONSTRAINT vod_materialization_operation_expiry_check                     CHECK (committed_at IS NULL OR expires_at > committed_at),
    FOREIGN KEY (household_id, device_session_id) REFERENCES device_session (household_id, id),
    FOREIGN KEY (household_id, profile_id)        REFERENCES profile (household_id, id),
    FOREIGN KEY (household_id, parent_media_id)   REFERENCES media_item (household_id, id),
    FOREIGN KEY (household_id, selected_media_id) REFERENCES media_item (household_id, id)
);

-- vod_registered_candidate(§10 I1):与物化结果同事务提交;唯一(家庭,operation_id,原 candidate_ref);
-- registered_candidate_ref 唯一可反查;至少 24h 保护映射/目标,过期按引用清理(应用层语义)
-- 010 收敛:原 candidate_ref 一列两用(唯一键组成列),别名旧列 source_candidate_ref 已删除
CREATE TABLE vod_registered_candidate (
    id                            TEXT PRIMARY KEY NOT NULL,
    household_id                  TEXT NOT NULL REFERENCES household(id),
    device_session_id             TEXT NOT NULL,
    profile_id                    TEXT NOT NULL,
    profile_context_version       INTEGER NOT NULL,
    registered_candidate_ref      TEXT NOT NULL,
    -- 原(临时)candidate_ref:数据模型 §10 I1 的唯一键组成列(临时候选仅存有界预览缓存,
    -- 失效不影响已提交结果重放)
    candidate_ref                 TEXT NOT NULL,
    source_session_id             TEXT NOT NULL,
    source_generation             INTEGER NOT NULL,
    preview_revision              INTEGER NOT NULL,
    target_media_id               TEXT NOT NULL,
    target_content_revision       INTEGER NOT NULL,
    target_continuity_revision    INTEGER NOT NULL,
    target_detail_revision        INTEGER NOT NULL,
    materialization_operation_id  TEXT NOT NULL,
    created_at                    TEXT NOT NULL,
    expires_at                    TEXT NOT NULL,
    CONSTRAINT vod_registered_candidate_context_version_check         CHECK (profile_context_version >= 1),
    CONSTRAINT vod_registered_candidate_source_generation_check       CHECK (source_generation >= 1),
    CONSTRAINT vod_registered_candidate_preview_revision_check        CHECK (preview_revision >= 1),
    CONSTRAINT vod_registered_candidate_target_content_revision_check CHECK (target_content_revision >= 1),
    CONSTRAINT vod_registered_candidate_target_continuity_revision_check CHECK (target_continuity_revision >= 1),
    CONSTRAINT vod_registered_candidate_target_detail_revision_check  CHECK (target_detail_revision >= 1),
    CONSTRAINT vod_registered_candidate_expiry_check                  CHECK (expires_at > created_at),
    FOREIGN KEY (household_id, device_session_id)            REFERENCES device_session (household_id, id),
    FOREIGN KEY (household_id, profile_id)                   REFERENCES profile (household_id, id),
    FOREIGN KEY (household_id, source_session_id)            REFERENCES playback_session (household_id, id),
    FOREIGN KEY (household_id, target_media_id)              REFERENCES media_item (household_id, id),
    FOREIGN KEY (household_id, materialization_operation_id) REFERENCES vod_materialization_operation (household_id, id)
);

-- 新表唯一键/辅助索引(与 schema.ts 的 uniqueIndex 一一对应;唯一键都带家庭)
-- child 唯一父由 (household_id, child_id) 复合主键落实(见上表定义)
CREATE UNIQUE INDEX vod_title_household_id_id_key ON vod_title (household_id, id);
CREATE UNIQUE INDEX vod_title_source_upstream_key ON vod_title (household_id, source_id, upstream_vod_id);
CREATE UNIQUE INDEX vod_title_parent_media_key ON vod_title (household_id, parent_media_id);
CREATE UNIQUE INDEX vod_line_household_id_id_key ON vod_line (household_id, id);
CREATE UNIQUE INDEX vod_line_title_line_key ON vod_line (household_id, title_id, line_key);
CREATE UNIQUE INDEX vod_episode_household_id_id_key ON vod_episode (household_id, id);
CREATE UNIQUE INDEX vod_episode_line_episode_key ON vod_episode (household_id, line_id, episode_key);
CREATE UNIQUE INDEX vod_episode_media_key ON vod_episode (household_id, media_id);
CREATE UNIQUE INDEX vod_materialization_operation_household_id_id_key ON vod_materialization_operation (household_id, id);
CREATE UNIQUE INDEX vod_materialization_operation_scope_key
    ON vod_materialization_operation (household_id, device_session_id, profile_context_version, operation_key);
CREATE UNIQUE INDEX vod_registered_candidate_household_id_id_key ON vod_registered_candidate (household_id, id);
-- 数据模型 §10 I1:唯一(家庭,operation_id,原 candidate_ref)(010 收敛:唯一键列即 candidate_ref)
CREATE UNIQUE INDEX vod_registered_candidate_operation_candidate_key
    ON vod_registered_candidate (household_id, materialization_operation_id, candidate_ref);

-- ==========================================================================
-- 2) 个人扩展表(data-model §5 / §10 U1)
-- ==========================================================================

-- profile_vod_preferences(§5):每 Profile 唯一;CAS;持久 version >= 1(未有行读取 0 仅为传输初值)
CREATE TABLE profile_vod_preferences (
    household_id           TEXT NOT NULL REFERENCES household(id),
    profile_id             TEXT NOT NULL,
    autoplay_next          INTEGER NOT NULL DEFAULT 1,
    switch_carry_position  INTEGER NOT NULL DEFAULT 1,
    version                INTEGER NOT NULL,
    PRIMARY KEY (household_id, profile_id),
    CONSTRAINT profile_vod_preferences_autoplay_next_check CHECK (autoplay_next IN (0, 1)),
    CONSTRAINT profile_vod_preferences_switch_carry_check  CHECK (switch_carry_position IN (0, 1)),
    CONSTRAINT profile_vod_preferences_version_check       CHECK (version >= 1),
    FOREIGN KEY (household_id, profile_id) REFERENCES profile (household_id, id)
);

-- profile_vod_preference_operation(§10 U1):唯一(家庭,device_session,context_version,operation_key);
-- 仅成功操作占 key(与偏好 CAS 同事务);result_json 为当时 Preferences;expires >= committed + 24h
CREATE TABLE profile_vod_preference_operation (
    id                      TEXT PRIMARY KEY NOT NULL,
    household_id            TEXT NOT NULL REFERENCES household(id),
    device_session_id       TEXT NOT NULL,
    profile_id              TEXT NOT NULL,
    profile_context_version INTEGER NOT NULL,
    operation_key           TEXT NOT NULL,
    request_digest          TEXT NOT NULL,
    result_json             TEXT NOT NULL,
    committed_at            TEXT NOT NULL,
    expires_at              TEXT NOT NULL,
    CONSTRAINT profile_vod_preference_operation_context_version_check CHECK (profile_context_version >= 1),
    CONSTRAINT profile_vod_preference_operation_result_json_check     CHECK (json_valid(result_json)),
    -- expires >= committed + 24h(julianday 差 >= 1 天;非法时间字符串一并拒绝)
    CONSTRAINT profile_vod_preference_operation_retention_check CHECK (
        julianday(expires_at) IS NOT NULL AND julianday(committed_at) IS NOT NULL
        AND julianday(expires_at) - julianday(committed_at) >= 1
    ),
    FOREIGN KEY (household_id, device_session_id) REFERENCES device_session (household_id, id),
    FOREIGN KEY (household_id, profile_id)        REFERENCES profile (household_id, id)
);

CREATE UNIQUE INDEX profile_vod_preference_operation_household_id_id_key
    ON profile_vod_preference_operation (household_id, id);
CREATE UNIQUE INDEX profile_vod_preference_operation_scope_key
    ON profile_vod_preference_operation (household_id, device_session_id, profile_context_version, operation_key);

-- ==========================================================================
-- 3) 播放扩展表(data-model §5 / §6 / §7 / §10)
-- ==========================================================================

-- playback_phase_observation(§5):最新 event_seq 幂等(session 内单调);不写个人历史;
-- 最高 2Hz/会话、playing 每 1s、固定 TTL(应用层限流/清理);尾锚 position/time 成对
CREATE TABLE playback_phase_observation (
    household_id                 TEXT NOT NULL REFERENCES household(id),
    session_id                   TEXT NOT NULL,
    generation                   INTEGER NOT NULL,
    event_seq                    INTEGER NOT NULL,
    digest                       TEXT NOT NULL,
    event_type                   TEXT NOT NULL,
    position_seconds             REAL NOT NULL,
    playback_rate                REAL NOT NULL,
    server_received_at           TEXT NOT NULL,
    tail_anchor_position_seconds REAL,
    tail_anchor_time             TEXT,
    delivered_seen               INTEGER NOT NULL,
    PRIMARY KEY (household_id, session_id, event_seq),
    CONSTRAINT playback_phase_observation_generation_check    CHECK (generation >= 1),
    CONSTRAINT playback_phase_observation_event_seq_check     CHECK (event_seq >= 1),
    CONSTRAINT playback_phase_observation_event_type_check    CHECK (event_type IN ('playing', 'pause', 'seeking', 'seeked', 'waiting', 'ratechange', 'error')),
    CONSTRAINT playback_phase_observation_position_check      CHECK (position_seconds >= 0),
    CONSTRAINT playback_phase_observation_rate_check          CHECK (playback_rate BETWEEN 0.5 AND 2),
    CONSTRAINT playback_phase_observation_delivered_seen_check CHECK (delivered_seen IN (0, 1)),
    CONSTRAINT playback_phase_observation_tail_anchor_pair_check CHECK (
        (tail_anchor_position_seconds IS NULL AND tail_anchor_time IS NULL)
        OR (tail_anchor_position_seconds IS NOT NULL AND tail_anchor_time IS NOT NULL)
    ),
    FOREIGN KEY (household_id, session_id) REFERENCES playback_session (household_id, id)
);

-- playback_finish_receipt(§5):session 唯一一份不可变终态;(家庭,device_session,context_version,
-- operation_key) 另有唯一幂等索引;position/duration 未知为 NULL,不以 0 冒充未知时长
CREATE TABLE playback_finish_receipt (
    household_id            TEXT NOT NULL REFERENCES household(id),
    session_id              TEXT NOT NULL,
    device_session_id       TEXT NOT NULL,
    profile_context_version INTEGER NOT NULL,
    generation              INTEGER NOT NULL,
    operation_key           TEXT NOT NULL,
    request_digest          TEXT NOT NULL,
    -- 数据模型 §5:终态 final_seq(010 收敛:规范命名唯一列,别名旧列 final_sample_seq 已删除)
    final_seq               INTEGER NOT NULL,
    final_session_accepted  INTEGER NOT NULL,
    history_applied         INTEGER NOT NULL,
    history_revision        INTEGER,
    session_completed       INTEGER NOT NULL,
    auto_next_eligible      INTEGER NOT NULL,
    reason                  TEXT NOT NULL,
    position_seconds        REAL,
    duration_seconds        REAL,
    ended_at                TEXT NOT NULL,
    content_revision        INTEGER NOT NULL,
    continuity_revision     INTEGER NOT NULL,
    locator_revision        INTEGER NOT NULL,
    PRIMARY KEY (household_id, session_id),
    CONSTRAINT playback_finish_receipt_context_version_check  CHECK (profile_context_version >= 1),
    CONSTRAINT playback_finish_receipt_generation_check       CHECK (generation >= 1),
    CONSTRAINT playback_finish_receipt_final_seq_check        CHECK (final_seq >= 1),
    CONSTRAINT playback_finish_receipt_final_accepted_check   CHECK (final_session_accepted IN (0, 1)),
    CONSTRAINT playback_finish_receipt_history_applied_check  CHECK (history_applied IN (0, 1)),
    CONSTRAINT playback_finish_receipt_history_revision_check CHECK (history_revision IS NULL OR history_revision >= 1),
    CONSTRAINT playback_finish_receipt_completed_check        CHECK (session_completed IN (0, 1)),
    CONSTRAINT playback_finish_receipt_auto_next_check        CHECK (auto_next_eligible IN (0, 1)),
    CONSTRAINT playback_finish_receipt_reason_check           CHECK (reason IN ('completed', 'stale_final', 'no_tail_observation', 'not_started', 'no_duration', 'not_completed', 'stopped_elsewhere')),
    CONSTRAINT playback_finish_receipt_position_check         CHECK (position_seconds IS NULL OR position_seconds >= 0),
    CONSTRAINT playback_finish_receipt_duration_check         CHECK (duration_seconds IS NULL OR duration_seconds > 0),
    CONSTRAINT playback_finish_receipt_content_revision_check    CHECK (content_revision >= 1),
    CONSTRAINT playback_finish_receipt_continuity_revision_check CHECK (continuity_revision >= 1),
    CONSTRAINT playback_finish_receipt_locator_revision_check    CHECK (locator_revision >= 1),
    FOREIGN KEY (household_id, session_id)        REFERENCES playback_session (household_id, id),
    FOREIGN KEY (household_id, device_session_id) REFERENCES device_session (household_id, id)
);

-- playback_next_plan(§10 I3):不可变、TTL 60s、有界;无 slot/epoch 写;history_revision 无历史=0
-- (仅表示快照时无历史,不是持久历史 revision);每设备 20 活计划上限与淘汰(应用层语义)
CREATE TABLE playback_next_plan (
    id                         TEXT PRIMARY KEY NOT NULL,
    -- 数据模型 §10:计划对外引用 ref(与 id 并列的稳定标识)
    ref                        TEXT,
    household_id               TEXT NOT NULL REFERENCES household(id),
    device_session_id          TEXT NOT NULL,
    profile_id                 TEXT NOT NULL,
    profile_context_version    INTEGER NOT NULL,
    from_session_id            TEXT NOT NULL,
    from_generation            INTEGER NOT NULL,
    action                     TEXT NOT NULL,
    target_media_id            TEXT NOT NULL,
    sequence_revision          INTEGER NOT NULL,
    detail_revision            INTEGER NOT NULL,
    target_content_revision    INTEGER NOT NULL,
    target_continuity_revision INTEGER NOT NULL,
    target_locator_revision    INTEGER NOT NULL,
    history_revision           INTEGER NOT NULL,
    history_choice_required    INTEGER NOT NULL,
    created_at                 TEXT NOT NULL,
    expires_at                 TEXT NOT NULL,
    CONSTRAINT playback_next_plan_context_version_check         CHECK (profile_context_version >= 1),
    CONSTRAINT playback_next_plan_from_generation_check         CHECK (from_generation >= 1),
    CONSTRAINT playback_next_plan_action_check                  CHECK (action IN ('next', 'manual_next')),
    CONSTRAINT playback_next_plan_sequence_revision_check       CHECK (sequence_revision >= 1),
    CONSTRAINT playback_next_plan_detail_revision_check         CHECK (detail_revision >= 1),
    CONSTRAINT playback_next_plan_target_content_revision_check CHECK (target_content_revision >= 1),
    CONSTRAINT playback_next_plan_target_continuity_revision_check CHECK (target_continuity_revision >= 1),
    CONSTRAINT playback_next_plan_target_locator_revision_check CHECK (target_locator_revision >= 1),
    CONSTRAINT playback_next_plan_history_revision_check        CHECK (history_revision >= 0),
    CONSTRAINT playback_next_plan_history_choice_check          CHECK (history_choice_required IN (0, 1)),
    CONSTRAINT playback_next_plan_expiry_check                  CHECK (expires_at > created_at),
    FOREIGN KEY (household_id, device_session_id) REFERENCES device_session (household_id, id),
    FOREIGN KEY (household_id, profile_id)        REFERENCES profile (household_id, id),
    FOREIGN KEY (household_id, from_session_id)   REFERENCES playback_session (household_id, id),
    FOREIGN KEY (household_id, target_media_id)   REFERENCES media_item (household_id, id)
);

-- playback_input_binding(§6):每 session/generation 至多一有效绑定;start_basis 三选一;
-- frozen_start_seconds 在 probe 后才冻结(NULL 合法);resolved_input_id 为私有不透明 ID,
-- 入口 URL/请求策略不入库;租约有界;cleanup_state 仅 pending/complete(与 playback_conversion 同规则)
CREATE TABLE playback_input_binding (
    id                   TEXT PRIMARY KEY NOT NULL,
    household_id         TEXT NOT NULL REFERENCES household(id),
    session_id           TEXT NOT NULL,
    generation           INTEGER NOT NULL,
    playback_source_id   TEXT NOT NULL,
    source_id            TEXT NOT NULL,
    locator_revision     INTEGER NOT NULL,
    detail_revision      INTEGER,
    content_revision     INTEGER NOT NULL,
    continuity_revision  INTEGER,
    evidence_state       TEXT,
    evidence_digest      TEXT,
    resolved_input_id    TEXT NOT NULL,
    resolved_at          TEXT NOT NULL,
    expires_at           TEXT NOT NULL,
    start_basis          TEXT NOT NULL,
    frozen_start_seconds REAL,
    -- T042(freeze-NULL 缺口修复,选项 b):持久冻结标记(NULL=尚未冻结;非 NULL=已冻结,
    -- frozen_start_seconds 本身取 NULL 亦属合法冻结结论)——「仅冻结一次」由该列守卫
    frozen_at            TEXT,
    cleanup_state        TEXT NOT NULL DEFAULT 'pending',
    -- 数据模型 §10:输入 cleanup 与 session 同规则(标记/原因/持久执行状态)
    cleanup_requested    INTEGER NOT NULL DEFAULT 0
        CONSTRAINT playback_input_binding_cleanup_requested_check CHECK (cleanup_requested IN (0, 1)),
    cleanup_reason       TEXT
        CONSTRAINT playback_input_binding_cleanup_reason_check CHECK (
            cleanup_reason IS NULL OR cleanup_requested = 1
        ),
    CONSTRAINT playback_input_binding_generation_check            CHECK (generation >= 1),
    CONSTRAINT playback_input_binding_locator_revision_check      CHECK (locator_revision >= 1),
    CONSTRAINT playback_input_binding_content_revision_check      CHECK (content_revision >= 1),
    CONSTRAINT playback_input_binding_detail_revision_check       CHECK (detail_revision IS NULL OR detail_revision >= 1),
    CONSTRAINT playback_input_binding_continuity_revision_check   CHECK (continuity_revision IS NULL OR continuity_revision >= 1),
    CONSTRAINT playback_input_binding_evidence_state_check        CHECK (evidence_state IS NULL OR evidence_state IN ('unverified', 'verified')),
    CONSTRAINT playback_input_binding_expiry_check                CHECK (expires_at > resolved_at),
    CONSTRAINT playback_input_binding_start_basis_check           CHECK (start_basis IN ('beginning', 'target_history', 'transition_carry')),
    CONSTRAINT playback_input_binding_frozen_start_check          CHECK (frozen_start_seconds IS NULL OR frozen_start_seconds >= 0),
    CONSTRAINT playback_input_binding_cleanup_state_check         CHECK (cleanup_state IN ('pending', 'complete')),
    FOREIGN KEY (household_id, session_id)         REFERENCES playback_session (household_id, id),
    FOREIGN KEY (household_id, playback_source_id) REFERENCES playback_source (household_id, id),
    FOREIGN KEY (household_id, source_id)          REFERENCES media_source (household_id, id)
);

-- playback_transition_intent(§7 + §10):同设备上下文操作 key 唯一;TTL 固定 60s 重试不续期;
-- carry 必填 position/duration/source_ledger_seq 与 source_checkpoint,beginning/target_history
-- 禁止这些字段(§10「仅 carry 必填」);next_plan 冻结快照随 next_plan_id 固定
CREATE TABLE playback_transition_intent (
    id                             TEXT PRIMARY KEY NOT NULL,
    household_id                   TEXT NOT NULL REFERENCES household(id),
    from_session_id                TEXT NOT NULL,
    from_generation                INTEGER NOT NULL,
    device_session_id              TEXT NOT NULL,
    profile_id                     TEXT NOT NULL,
    profile_context_version        INTEGER NOT NULL,
    action                         TEXT NOT NULL,
    target_media_id                TEXT NOT NULL,
    target_content_revision        INTEGER NOT NULL,
    target_continuity_revision     INTEGER NOT NULL,
    target_locator_revision        INTEGER NOT NULL,
    match_revision                 INTEGER NOT NULL,
    match_confidence               TEXT NOT NULL,
    confirmed_ambiguous            INTEGER NOT NULL,
    position_mode                  TEXT NOT NULL,
    carry_position_seconds         REAL,
    carry_duration_seconds         REAL,
    source_ledger_seq              INTEGER,
    source_checkpoint_generation   INTEGER,
    source_checkpoint_seq          INTEGER,
    allow_earlier_accepted_position INTEGER,
    finish_receipt_id              TEXT,
    operation_key                  TEXT NOT NULL,
    request_digest                 TEXT NOT NULL,
    slot_revision                  INTEGER NOT NULL,
    created_at                     TEXT NOT NULL,
    expires_at                     TEXT NOT NULL,
    status                         TEXT NOT NULL,
    successor_id                   TEXT,
    next_plan_id                   TEXT,
    plan_sequence_revision         INTEGER,
    plan_detail_revision           INTEGER,
    plan_history_revision          INTEGER,
    plan_history_choice_required   INTEGER,
    CONSTRAINT playback_transition_intent_from_generation_check    CHECK (from_generation >= 1),
    CONSTRAINT playback_transition_intent_context_version_check    CHECK (profile_context_version >= 1),
    CONSTRAINT playback_transition_intent_action_check             CHECK (action IN ('next', 'manual_next', 'switch', 'recover_switch')),
    CONSTRAINT playback_transition_intent_target_content_revision_check    CHECK (target_content_revision >= 1),
    CONSTRAINT playback_transition_intent_target_continuity_revision_check CHECK (target_continuity_revision >= 1),
    CONSTRAINT playback_transition_intent_target_locator_revision_check    CHECK (target_locator_revision >= 1),
    CONSTRAINT playback_transition_intent_match_revision_check     CHECK (match_revision >= 1),
    CONSTRAINT playback_transition_intent_match_confidence_check   CHECK (match_confidence IN ('high', 'ambiguous', 'conflict')),
    CONSTRAINT playback_transition_intent_confirmed_ambiguous_check CHECK (confirmed_ambiguous IN (0, 1)),
    CONSTRAINT playback_transition_intent_position_mode_check      CHECK (position_mode IN ('beginning', 'target_history', 'carry')),
    -- carry 三件套:仅 carry 必填、非 carry 必须为空
    CONSTRAINT playback_transition_intent_carry_fields_check CHECK (
        (position_mode = 'carry' AND carry_position_seconds IS NOT NULL
            AND carry_duration_seconds IS NOT NULL AND source_ledger_seq IS NOT NULL)
        OR (position_mode <> 'carry' AND carry_position_seconds IS NULL
            AND carry_duration_seconds IS NULL AND source_ledger_seq IS NULL)
    ),
    -- 来源检查点:carry 必填;非 carry 禁止(含 allow_earlier_accepted_position)
    CONSTRAINT playback_transition_intent_checkpoint_check CHECK (
        (position_mode = 'carry' AND source_checkpoint_generation IS NOT NULL AND source_checkpoint_seq IS NOT NULL)
        OR (position_mode <> 'carry' AND source_checkpoint_generation IS NULL
            AND source_checkpoint_seq IS NULL AND allow_earlier_accepted_position IS NULL)
    ),
    CONSTRAINT playback_transition_intent_checkpoint_generation_check CHECK (source_checkpoint_generation IS NULL OR source_checkpoint_generation >= 1),
    CONSTRAINT playback_transition_intent_checkpoint_seq_check        CHECK (source_checkpoint_seq IS NULL OR source_checkpoint_seq >= 1),
    CONSTRAINT playback_transition_intent_allow_earlier_check         CHECK (allow_earlier_accepted_position IS NULL OR allow_earlier_accepted_position IN (0, 1)),
    CONSTRAINT playback_transition_intent_slot_revision_check         CHECK (slot_revision >= 1),
    CONSTRAINT playback_transition_intent_expiry_check                CHECK (expires_at > created_at),
    CONSTRAINT playback_transition_intent_status_check                CHECK (status IN ('pending', 'cancelled', 'superseded', 'expired', 'consumed')),
    CONSTRAINT playback_transition_intent_plan_sequence_revision_check CHECK (plan_sequence_revision IS NULL OR plan_sequence_revision >= 1),
    CONSTRAINT playback_transition_intent_plan_detail_revision_check   CHECK (plan_detail_revision IS NULL OR plan_detail_revision >= 1),
    CONSTRAINT playback_transition_intent_plan_history_revision_check  CHECK (plan_history_revision IS NULL OR plan_history_revision >= 0),
    CONSTRAINT playback_transition_intent_plan_history_choice_check    CHECK (plan_history_choice_required IS NULL OR plan_history_choice_required IN (0, 1)),
    FOREIGN KEY (household_id, from_session_id)   REFERENCES playback_session (household_id, id),
    FOREIGN KEY (household_id, device_session_id) REFERENCES device_session (household_id, id),
    FOREIGN KEY (household_id, profile_id)        REFERENCES profile (household_id, id),
    FOREIGN KEY (household_id, target_media_id)   REFERENCES media_item (household_id, id),
    FOREIGN KEY (household_id, finish_receipt_id) REFERENCES playback_finish_receipt (household_id, session_id),
    FOREIGN KEY (household_id, successor_id)      REFERENCES playback_session (household_id, id),
    FOREIGN KEY (household_id, next_plan_id)      REFERENCES playback_next_plan (household_id, id)
);

-- playback_transition_slot(§7):唯一(household,from_session,generation);consumed 槽永久不能
-- 再建立第二后继;并发不同 operationKey 争用同槽(CAS 由应用层执行);持久 slot_revision >= 1
CREATE TABLE playback_transition_slot (
    household_id        TEXT NOT NULL REFERENCES household(id),
    from_session_id     TEXT NOT NULL,
    from_generation     INTEGER NOT NULL,
    slot_revision       INTEGER NOT NULL,
    status              TEXT NOT NULL,
    active_intent_id    TEXT,
    successor_session_id TEXT,
    PRIMARY KEY (household_id, from_session_id, from_generation),
    CONSTRAINT playback_transition_slot_from_generation_check CHECK (from_generation >= 1),
    CONSTRAINT playback_transition_slot_revision_check        CHECK (slot_revision >= 1),
    CONSTRAINT playback_transition_slot_status_check          CHECK (status IN ('open', 'reserved', 'consumed')),
    FOREIGN KEY (household_id, from_session_id)      REFERENCES playback_session (household_id, id),
    FOREIGN KEY (household_id, active_intent_id)     REFERENCES playback_transition_intent (household_id, id),
    FOREIGN KEY (household_id, successor_session_id) REFERENCES playback_session (household_id, id)
);

CREATE UNIQUE INDEX playback_next_plan_household_id_id_key ON playback_next_plan (household_id, id);
CREATE UNIQUE INDEX playback_input_binding_household_id_id_key ON playback_input_binding (household_id, id);
CREATE UNIQUE INDEX playback_input_binding_session_generation_key
    ON playback_input_binding (household_id, session_id, generation);
CREATE UNIQUE INDEX playback_transition_intent_household_id_id_key ON playback_transition_intent (household_id, id);
CREATE UNIQUE INDEX playback_transition_intent_scope_key
    ON playback_transition_intent (household_id, device_session_id, profile_context_version, operation_key);
CREATE UNIQUE INDEX playback_finish_receipt_operation_key
    ON playback_finish_receipt (household_id, device_session_id, profile_context_version, operation_key);

-- ==========================================================================
-- 4) 既有实体扩展(ALTER TABLE ADD COLUMN;列级命名 CHECK 随列声明,down 直接 DROP COLUMN)
-- ==========================================================================

-- media_item.media_role(010 T010,§2):旧记录 standalone(DEFAULT 即回填)。
-- 角色枚举在 SQL 层落实;「父 movie/series/video、子 episode」的父子角色配对属领域校验,
-- 由应用事务执行(data-model §1:写入状态转换/领域校验由应用层执行),不在此设 CHECK。
ALTER TABLE media_item
    ADD COLUMN media_role TEXT NOT NULL DEFAULT 'standalone'
    CONSTRAINT media_item_media_role_check CHECK (media_role IN ('standalone', 'vod_title', 'vod_episode'));

-- playback_session(010 T013,§10):独立起播标记(与 ledger.session_started/started_at 分离)
-- 与持久 cleanup 标记/原因/执行状态;标记先阻止新票/资产,网络与进程取消在提交后执行(应用层)
ALTER TABLE playback_session
    ADD COLUMN playback_started_at TEXT;
ALTER TABLE playback_session
    ADD COLUMN cleanup_requested INTEGER NOT NULL DEFAULT 0
    CONSTRAINT playback_session_cleanup_requested_check CHECK (cleanup_requested IN (0, 1));
ALTER TABLE playback_session
    ADD COLUMN cleanup_reason TEXT
    CONSTRAINT playback_session_cleanup_reason_check CHECK (
        cleanup_reason IS NULL OR cleanup_requested = 1
    );
ALTER TABLE playback_session
    ADD COLUMN cleanup_state TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT playback_session_cleanup_state_check CHECK (cleanup_state IN ('pending', 'complete'));

-- playback_progress_state(010 T012,§5):会话 ledger 扩展;seq 跨 generation 递增、
-- 新有效样本先更新 ledger 再按 epoch 决定历史、superseded 仍 sessionAccepted=true、
-- stale 不更新、与历史同事务 —— 均为应用事务语义;数据库层落实列域。
-- 010 收敛:游标列即数据模型 §5 规范命名 ledger_position/ledger_duration
-- (别名旧列 ledger_position_seconds/ledger_duration_seconds 已删除)
ALTER TABLE playback_progress_state
    ADD COLUMN continuity_revision INTEGER NOT NULL DEFAULT 1
    CONSTRAINT playback_progress_state_continuity_revision_check CHECK (continuity_revision >= 1);
ALTER TABLE playback_progress_state
    ADD COLUMN ledger_position REAL
    CONSTRAINT playback_progress_state_ledger_position_check CHECK (ledger_position IS NULL OR ledger_position >= 0);
ALTER TABLE playback_progress_state
    ADD COLUMN ledger_duration REAL
    CONSTRAINT playback_progress_state_ledger_duration_check CHECK (
        ledger_duration IS NULL OR ledger_duration > 0
    );
ALTER TABLE playback_progress_state
    ADD COLUMN ledger_generation INTEGER
    CONSTRAINT playback_progress_state_ledger_generation_check CHECK (
        ledger_generation IS NULL OR ledger_generation >= 1
    );
ALTER TABLE playback_progress_state
    ADD COLUMN ledger_accepted_at TEXT;
ALTER TABLE playback_progress_state
    ADD COLUMN session_started INTEGER NOT NULL DEFAULT 0
    CONSTRAINT playback_progress_state_session_started_check CHECK (session_started IN (0, 1));

-- profile_viewing_history(010 T012,§5):旧静态历史 completed 默认 false(DEFAULT 0)但保留现有
-- canResume 语义;continuity/evidence 为 NULL —— 旧记录不冒充在线 continuity 证据
ALTER TABLE profile_viewing_history
    ADD COLUMN continuity_revision INTEGER
    CONSTRAINT profile_viewing_history_continuity_revision_check CHECK (
        continuity_revision IS NULL OR continuity_revision >= 1
    );
ALTER TABLE profile_viewing_history
    ADD COLUMN evidence_state TEXT
    CONSTRAINT profile_viewing_history_evidence_state_check CHECK (
        evidence_state IS NULL OR evidence_state IN ('unverified', 'verified')
    );
ALTER TABLE profile_viewing_history
    ADD COLUMN evidence_digest TEXT;
ALTER TABLE profile_viewing_history
    ADD COLUMN completed INTEGER NOT NULL DEFAULT 0
    CONSTRAINT profile_viewing_history_completed_check CHECK (completed IN (0, 1));

-- ==========================================================================
-- 5) 枚举 CHECK 重建(§8):建 _build → 完整回填 → DROP 旧表 → RENAME → 重建索引
--    (FK 开启下亦逐语句零违反的 12-step 等价序列;提交后全库 foreign_key_check 复核)
-- ==========================================================================

-- 5.0) 引用子表暂存与清空:凡引用 media_source / source_entry / playback_source 的既有表
--      (含 media_source↔source_refresh 互引用环两侧)先以 temp 表全量暂存、再按叶→根序
--      清空,使三张重建表在各自 DROP(隐式 DELETE)时刻的全部引用子行为空 —— FK 开启下
--      亦无即时/延迟违反;temp 表随事务结束消失,零丢失由 5a~5c 回填与 5.2 回填保证。
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

-- 清空(叶→根):每个被删行自身的全部子行均已先清空;
-- media_source↔source_refresh 环以「先断 last_job_id 边」破解(置 NULL 永不违反 FK)。
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

-- 5a) media_source:kind 加 vod;vod 必须 remote_url 非空、NAS 根目录及 EPG 绑定为空;
--     新增 locator_revision(启停均 +1 防 ABA,应用层语义),既有行回填 1
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
    -- 010 增补(010 T010,§2):>=1,启停失效防 ABA
    locator_revision        INTEGER NOT NULL DEFAULT 1,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL,
    CONSTRAINT media_source_kind_check CHECK (kind IN ('iptv', 'epg', 'nas', 'vod')),
    CONSTRAINT media_source_name_check CHECK (length(name) BETWEEN 1 AND 100),
    -- remote_url:iptv/epg/vod 必填,nas 必为 null(vod 必须远程可定位)
    CONSTRAINT media_source_remote_url_check CHECK (
        (kind IN ('iptv', 'epg', 'vod') AND remote_url IS NOT NULL)
        OR (kind = 'nas' AND remote_url IS NULL)
    ),
    -- root_key/relative_directory:仅 nas 必填,其他类型(含 vod)必为 null
    CONSTRAINT media_source_nas_root_check CHECK (
        (kind = 'nas' AND root_key IS NOT NULL AND relative_directory IS NOT NULL)
        OR (kind IN ('iptv', 'epg', 'vod') AND root_key IS NULL AND relative_directory IS NULL)
    ),
    CONSTRAINT media_source_private_access_check CHECK (private_access_approved IN (0, 1)),
    -- epg_source_id:仅 iptv 可有值(vod/NAS 绑定为空由本约束一并保证)
    CONSTRAINT media_source_epg_source_kind_check CHECK (epg_source_id IS NULL OR kind = 'iptv'),
    CONSTRAINT media_source_enabled_check CHECK (enabled IN (0, 1)),
    CONSTRAINT media_source_version_check CHECK (version >= 1),
    CONSTRAINT media_source_epg_generation_check CHECK (epg_generation >= 0),
    CONSTRAINT media_source_locator_revision_check CHECK (locator_revision >= 1),
    -- 同家庭自引用:epg_source_id 必须指向同家庭来源(目标唯一索引已存在)
    FOREIGN KEY (household_id, epg_source_id) REFERENCES media_source (household_id, id),
    -- last_job_id 仅记录同家庭来源的成功任务(0003 同规则)
    FOREIGN KEY (household_id, last_job_id) REFERENCES source_refresh (household_id, id)
);

-- 完整回填(既有行零丢失);locator_revision 回填 1(revision >= 1 起点)。
-- epg_source_id(自引用→media_source 本表)与 last_job_id(→source_refresh)先置 NULL:
-- 回填时目标行尚未就位(本表/source_refresh 为空),置 NULL 永不违反 FK,还原见下方 UPDATE。
INSERT INTO media_source_build (
    id, household_id, kind, name, remote_url, root_key, relative_directory,
    private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id,
    epg_generation, locator_revision, created_at, updated_at
)
SELECT
    id, household_id, kind, name, remote_url, root_key, relative_directory,
    private_access_approved, NULL, enabled, version, last_success_at, NULL,
    epg_generation, 1, created_at, updated_at
FROM temp._stage_media_source;

DROP TABLE media_source;
ALTER TABLE media_source_build RENAME TO media_source;
CREATE UNIQUE INDEX media_source_household_id_id_key ON media_source (household_id, id);

-- 引用列还原(按 temp 暂存逐行精确还原;目标行此时已全部就位,即时 FK 检查可满足):
-- 先还原自引用 epg_source_id(本表行已齐),再回填 source_refresh,后还原 last_job_id
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

-- 5b) source_entry:identity_kind 加 vod_episode(摘要覆盖稳定定位,不含 URL;同源同子项
--     由既有唯一索引保证;present 为存在性权威 —— 均应用层语义)
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
    -- ADD COLUMN ... CONSTRAINT 形态逐字同构 —— 表级 CHECK 会令后续 DROP COLUMN 该列
    -- 时残留引用而重解析失败)
    group_title         TEXT
        CONSTRAINT source_entry_group_title_check CHECK (
            group_title IS NULL
            OR (group_title = trim(group_title) AND length(group_title) BETWEEN 1 AND 100)
        ),
    CONSTRAINT source_entry_identity_kind_check CHECK (
        identity_kind IN ('tvg_id', 'url', 'path', 'vod_episode')
    ),
    -- SHA-256 十六进制摘要:64 位小写十六进制字符(0003 同规则,vod 摘要同域)
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

-- 完整回填(列集合与 0006 终态一致,零丢失;行取自 5.0 暂存 —— 本表行已于清空阶段移除)
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

-- source_entry 的引用子表回填(父表已就位;refresh_stage_entry→source_refresh、
-- epg_programme→epg_channel 均已在 5a 就绪)
INSERT INTO refresh_stage_entry SELECT * FROM temp._stage_refresh_stage_entry;
INSERT INTO epg_programme SELECT * FROM temp._stage_epg_programme;

-- 5c) playback_source:判别联合(010 T011,§2)。location 放宽可空 = static 分支的
--     static_location;online 分支 location 为空(地址私有于 vod_detail_snapshot)、
--     vod_episode_id 非空且 protocol=hls;旧数据全部回填 static。entry 仍唯一资源。
CREATE TABLE playback_source_build (
    id              TEXT PRIMARY KEY NOT NULL,
    household_id    TEXT NOT NULL REFERENCES household(id),
    source_id       TEXT NOT NULL,
    source_entry_id TEXT NOT NULL,
    media_item_id   TEXT NOT NULL,
    protocol        TEXT NOT NULL,
    location        TEXT,
    mime_type       TEXT,
    priority        INTEGER NOT NULL DEFAULT 100,
    requires_proxy  INTEGER NOT NULL DEFAULT 0,
    -- 010 增补:定位器判别(static|online);旧数据回填 static,新 static 写入可省略
    locator_kind    TEXT NOT NULL DEFAULT 'static',
    vod_episode_id  TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    CONSTRAINT playback_source_protocol_check CHECK (protocol IN ('hls', 'dash', 'file', 'flv', 'http')),
    CONSTRAINT playback_source_priority_check CHECK (priority >= 0),
    CONSTRAINT playback_source_proxy_check    CHECK (requires_proxy IN (0, 1)),
    CONSTRAINT playback_source_locator_kind_check CHECK (locator_kind IN ('static', 'online')),
    -- 判别联合:static → location 非空/vod 引用空;online → 相反且 protocol=hls
    CONSTRAINT playback_source_locator_discriminator_check CHECK (
        (locator_kind = 'static' AND location IS NOT NULL AND vod_episode_id IS NULL)
        OR (locator_kind = 'online' AND location IS NULL AND vod_episode_id IS NOT NULL AND protocol = 'hls')
    ),
    FOREIGN KEY (household_id, source_id)       REFERENCES media_source (household_id, id),
    FOREIGN KEY (household_id, source_entry_id) REFERENCES source_entry (household_id, id),
    FOREIGN KEY (household_id, media_item_id)   REFERENCES media_item (household_id, id),
    FOREIGN KEY (household_id, vod_episode_id)  REFERENCES vod_episode (household_id, id)
);

-- 完整回填 + 旧静态 locator 回填 static(vod 引用为空;行取自 5.0 暂存)
INSERT INTO playback_source_build (
    id, household_id, source_id, source_entry_id, media_item_id, protocol, location,
    mime_type, priority, requires_proxy, locator_kind, vod_episode_id, created_at, updated_at
)
SELECT
    id, household_id, source_id, source_entry_id, media_item_id, protocol, location,
    mime_type, priority, requires_proxy, 'static', NULL, created_at, updated_at
FROM temp._stage_playback_source;

DROP TABLE playback_source;
ALTER TABLE playback_source_build RENAME TO playback_source;
CREATE UNIQUE INDEX playback_source_household_id_id_key ON playback_source (household_id, id);
CREATE UNIQUE INDEX playback_source_entry_key ON playback_source (household_id, source_entry_id);

-- 5.2) 会话族引用子表回填(根→叶:playback_session 先于其 ticket/conversion/progress);
--      profile_viewing_history 不引用任何重建表,未参与暂存/清空,不受本节影响
INSERT INTO playback_session SELECT * FROM temp._stage_playback_session;
INSERT INTO playback_ticket SELECT * FROM temp._stage_playback_ticket;
INSERT INTO playback_conversion SELECT * FROM temp._stage_playback_conversion;
INSERT INTO playback_progress_state SELECT * FROM temp._stage_playback_progress_state;

-- 5.3) 暂存清理:temp 表随事务提交/回滚自动消失,此处显式 DROP 释放内存句柄
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

-- 6) 代际标记:readiness 门禁要求 user_version=2 + 迁移记录与目录一致(0007 属同一交付代际;
--    down 同值还原,空库 up→down→up 可重复演练)
PRAGMA user_version = 2;
