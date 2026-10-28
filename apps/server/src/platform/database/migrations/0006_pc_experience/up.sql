-- 0006_pc_experience · 数据代际 2(schema generation 2):PC 公开浏览与个人观看体验
-- 权威列定义:docs/specs/005-pc-browsing-flow/data-model.md §1(通用约束与代际)、
--   §2(现有实体扩展)、§3 settings_access_grant、§4 profile_channel_favorite、
--   §5 profile_progress_clock、§6 playback_progress_state、§7 profile_viewing_history、
--   §8(programme 补索引部分)。
-- ⚠️ 本文件与 src/platform/database/schema.ts 必须同步修改(schema.ts 仅为查询层类型);
--    禁止修改既有 0001~0005 SQL。本代际仅对全新安装的空业务库应用(data-model §1:
--    拒绝旧已初始化库,不能先删数据再尝试升级);旧库在迁移/启动入口被只读预检拒绝
--    (src/platform/database/precheck.ts,T007)。
-- 执行环境:better-sqlite3(连接已开 foreign_keys = ON / WAL),由 migrate.ts 在事务内应用。
-- 硬约束(宪章原则二/四):全部新表显式 household_id;复合外键以 (household_id, id) 唯一键
--   为目标,禁止跨家庭关联;时间为 UTC ISO-8601 TEXT(字符串序即时间序);禁止触发器。
-- 代际标记:文件末尾 `PRAGMA user_version = 2;`(user_version 为库头 cookie 写入,事务性 ——
--   失败随事务回滚);down.sql 恢复 user_version = 1(down 后与旧代际标记一致,可再次 up)。

-- 复合外键目标确认(data-model §1「新增FK所需的profile/playback_session等父表
-- (household_id,id)复合唯一索引须在0006中显式确认或补齐」)。逐一核验结果:全部既有,
-- 0006 不补建任何父表复合唯一索引 ——
--   profile(household_id, id)          → 0002 profile_household_id_id_key(UNIQUE)
--   device_session(household_id, id)   → 0003 device_session_household_id_id_key(UNIQUE)
--   media_item(household_id, id)       → 0003 media_item_household_id_id_key(UNIQUE)
--   playback_session(household_id, id) → 0005 playback_session_household_id_id_key(UNIQUE)

-- 1) 既有实体扩展(data-model §2)。逐列以 ALTER TABLE ADD COLUMN 追加(0004 先例),
--    列级命名 CHECK 随列声明(被删列时约束一并消失,down 直接 DROP COLUMN);
--    0006 仅用于全新空库,既有行不受影响,DEFAULT 与 data-model 原文一致。
ALTER TABLE household
    ADD COLUMN version INTEGER NOT NULL DEFAULT 1
    CONSTRAINT household_version_check CHECK (version >= 1);
-- 主档案转移版本:不因普通页面读取递增(应用层语义,数据库仅约束下限)
ALTER TABLE household
    ADD COLUMN main_profile_version INTEGER NOT NULL DEFAULT 1
    CONSTRAINT household_main_profile_version_check CHECK (main_profile_version >= 1);

-- 密码改动递增,并在同一事务撤销该账号全部 device_session 与设置授予(应用层语义)
ALTER TABLE account
    ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 1
    CONSTRAINT account_credential_version_check CHECK (credential_version >= 1);

-- is_main 主档案标记(BOOLEAN,0/1);其两条列级 CHECK:
--   profile_is_main_check        —— 布尔域
--   profile_main_profile_check   —— 主档案必须 type=adult,status=active,pin_hash IS NOT NULL
-- 两者均声明在 is_main 列上(down 删列时随之移除,无须 12-step 重建)。
ALTER TABLE profile
    ADD COLUMN is_main INTEGER NOT NULL DEFAULT 0
    CONSTRAINT profile_is_main_check CHECK (is_main IN (0, 1))
    CONSTRAINT profile_main_profile_check CHECK (
        is_main = 0 OR (type = 'adult' AND status = 'active' AND pin_hash IS NOT NULL)
    );
ALTER TABLE profile
    ADD COLUMN pin_version INTEGER NOT NULL DEFAULT 1
    CONSTRAINT profile_pin_version_check CHECK (pin_version >= 1);
ALTER TABLE profile
    ADD COLUMN version INTEGER NOT NULL DEFAULT 1
    CONSTRAINT profile_version_check CHECK (version >= 1);

-- 主档案唯一索引:每家庭至多一个 is_main=1(data-model §2 唯一索引 (household_id) WHERE is_main=1)
CREATE UNIQUE INDEX one_main_profile ON profile (household_id) WHERE is_main = 1;

-- 设备会话身份上下文版本:实际 activeProfile 改变/清空/失效回落时递增(应用层语义)
ALTER TABLE device_session
    ADD COLUMN profile_context_version INTEGER NOT NULL DEFAULT 1
    CONSTRAINT device_session_profile_context_version_check CHECK (profile_context_version >= 1);

-- 播放会话身份上下文版本:resolve 时从可信 DeviceSession 捕获;每次控制/renew/交付/进度写入
-- 必须等于当前 DeviceSession 版本(应用层重验)。ADD COLUMN NOT NULL 需 DEFAULT(0006 仅用于
-- 全新空库,无既有行需要回填,DEFAULT 1 即代际 2 起点版本)。
ALTER TABLE playback_session
    ADD COLUMN profile_context_version INTEGER NOT NULL DEFAULT 1
    CONSTRAINT playback_session_profile_context_version_check CHECK (profile_context_version >= 1);

-- 内容修订:同一 NAS 身份文件可信 size/mtime 变化时,导入发布事务递增;普通标题/分级修改
-- 只改既有 version(区分职责,应用层语义)
ALTER TABLE media_item
    ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 1
    CONSTRAINT media_item_content_revision_check CHECK (content_revision >= 1);

-- 来源条目发布分组(M3U group-title):TEXT NULL。存储值域约束 —— 已归一化(trim 后
-- 1~100 字符;空白为 NULL 的归一化本身由导入发布写入路径执行,T146),禁止未归一化值入库。
ALTER TABLE source_entry
    ADD COLUMN group_title TEXT
    CONSTRAINT source_entry_group_title_check CHECK (
        group_title IS NULL
        OR (group_title = trim(group_title) AND length(group_title) BETWEEN 1 AND 100)
    );

-- 2) settings_access_grant(data-model §3):设置访问授予。联合主键 (household_id, device_session_id)
--    每设备会话一行;授予本身无 bearer,浏览器仅收到 expiresAt 元数据;失效后不再恢复
--    (revoked_at 不可清除复用,应用层语义);固定 15 分钟不滑动、启动时撤销全部授予、
--    每次读取/写入重验各版本 —— 均为应用事务语义,数据库层落实列域与同家庭复合FK。
CREATE TABLE settings_access_grant (
    household_id            TEXT NOT NULL REFERENCES household(id),
    device_session_id       TEXT NOT NULL,
    profile_id              TEXT NOT NULL,
    -- 创建时的设备会话身份版本
    profile_context_version INTEGER NOT NULL,
    -- 创建时当前主档案 PIN 版本
    pin_version             INTEGER NOT NULL,
    -- 创建时家庭主档案版本
    main_profile_version    INTEGER NOT NULL,
    issued_at               TEXT NOT NULL,
    expires_at              TEXT NOT NULL,
    revoked_at              TEXT,
    PRIMARY KEY (household_id, device_session_id),
    CONSTRAINT settings_access_grant_context_version_check       CHECK (profile_context_version >= 1),
    CONSTRAINT settings_access_grant_pin_version_check           CHECK (pin_version >= 1),
    CONSTRAINT settings_access_grant_main_profile_version_check  CHECK (main_profile_version >= 1),
    -- 正区间守护(expires_at = issued_at + 15 分钟由应用层保证;与 playback_ticket_expiry_check 同规则)
    CONSTRAINT settings_access_grant_expiry_check CHECK (expires_at > issued_at),
    FOREIGN KEY (household_id, device_session_id) REFERENCES device_session (household_id, id),
    FOREIGN KEY (household_id, profile_id)        REFERENCES profile (household_id, id)
);

-- 3) profile_channel_favorite(data-model §4):频道收藏。三元联合主键,Profile/Media 同家庭
--    复合FK;媒体必须为 channel、添加时可用、created_at 首次收藏固定不更新、DELETE 不存在
--    亦 204 —— 应用事务语义,数据库层不设跨表 CHECK。
CREATE TABLE profile_channel_favorite (
    household_id TEXT NOT NULL REFERENCES household(id),
    profile_id   TEXT NOT NULL,
    media_id     TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (household_id, profile_id, media_id),
    FOREIGN KEY (household_id, profile_id) REFERENCES profile (household_id, id),
    FOREIGN KEY (household_id, media_id)   REFERENCES media_item (household_id, id)
);

-- 4) profile_progress_clock(data-model §5):点播写入权时钟。每次点播 resolve 接受时短事务
--    分配 epoch 并递增;直播不分配;可跳号,不可重置,不接受客户端指定 —— 应用事务语义。
CREATE TABLE profile_progress_clock (
    household_id TEXT NOT NULL REFERENCES household(id),
    profile_id   TEXT NOT NULL,
    next_epoch   INTEGER NOT NULL,
    PRIMARY KEY (household_id, profile_id),
    CONSTRAINT profile_progress_clock_next_epoch_check CHECK (next_epoch >= 1),
    FOREIGN KEY (household_id, profile_id) REFERENCES profile (household_id, id)
);

-- 5) playback_progress_state(data-model §6):活动播放的进度状态,随临时 session 清理。
--    started/last_sample_seq/last_generation 等写入状态转换(首次 started 确认、seq/generation
--    重试语义)由应用事务执行;数据库层落实列域与三向同家庭复合FK。
CREATE TABLE playback_progress_state (
    household_id            TEXT NOT NULL REFERENCES household(id),
    playback_session_id     TEXT NOT NULL,
    profile_id              TEXT NOT NULL,
    media_id                TEXT NOT NULL,
    -- clock 分配值(>0;整数域即 >= 1)
    candidate_epoch         INTEGER NOT NULL,
    -- resolve/可信输入快照的内容修订
    content_revision        INTEGER NOT NULL,
    -- resolve 时身份上下文版本,与 playback_session 和当前 DeviceSession 一致
    profile_context_version INTEGER NOT NULL,
    -- 首次有效客户端 playing 上报后 true(0/1 布尔)
    started                 INTEGER NOT NULL DEFAULT 0,
    -- 会话生命周期内单调序号,换轨/seek/重渲染不重置;初始 0
    last_sample_seq         INTEGER NOT NULL DEFAULT 0,
    -- 最后一个已接受样本的规范化摘要
    last_sample_digest      TEXT,
    -- 最后接受的 playback generation
    last_generation         INTEGER NOT NULL,
    -- 最后样本 applied/reason/revision,供相同序号重试稳定返回(应用层编码)
    last_result             TEXT,
    PRIMARY KEY (household_id, playback_session_id),
    CONSTRAINT playback_progress_state_candidate_epoch_check   CHECK (candidate_epoch >= 1),
    CONSTRAINT playback_progress_state_content_revision_check  CHECK (content_revision >= 1),
    CONSTRAINT playback_progress_state_context_version_check   CHECK (profile_context_version >= 1),
    CONSTRAINT playback_progress_state_started_check           CHECK (started IN (0, 1)),
    CONSTRAINT playback_progress_state_last_sample_seq_check   CHECK (last_sample_seq >= 0),
    CONSTRAINT playback_progress_state_last_generation_check   CHECK (last_generation >= 1),
    FOREIGN KEY (household_id, playback_session_id) REFERENCES playback_session (household_id, id),
    FOREIGN KEY (household_id, profile_id)          REFERENCES profile (household_id, id),
    FOREIGN KEY (household_id, media_id)            REFERENCES media_item (household_id, id)
);

-- 6) profile_viewing_history(data-model §7):点播观看历史。writer_playback_session_id 为
--    不透明 ID TEXT,刻意不设 FK(避免审计清理临时 session 影响历史);历史不随 session
--    清理、档案停用不硬删除 —— 应用层保留策略。
CREATE TABLE profile_viewing_history (
    household_id               TEXT NOT NULL REFERENCES household(id),
    profile_id                 TEXT NOT NULL,
    media_id                   TEXT NOT NULL,
    -- 当前媒体历史写入权代次
    writer_epoch               INTEGER NOT NULL,
    -- 不透明 ID TEXT,无强引用临时 session 的 FK
    writer_playback_session_id TEXT NOT NULL,
    -- 当前 owner 已接受序号
    last_sample_seq            INTEGER NOT NULL,
    -- 该位置对应的内容修订
    content_revision           INTEGER NOT NULL,
    -- 影片逻辑时间秒(REAL;有限非负)
    position_seconds           REAL NOT NULL,
    -- nullable;已可信探测后为有限非负
    duration_seconds           REAL,
    -- 服务端接受有效观看活动时间;客户端不能指定排序时间(应用层语义)
    last_viewed_at             TEXT NOT NULL,
    -- 实际更新递增
    revision                   INTEGER NOT NULL,
    PRIMARY KEY (household_id, profile_id, media_id),
    CONSTRAINT profile_viewing_history_writer_epoch_check      CHECK (writer_epoch >= 1),
    CONSTRAINT profile_viewing_history_last_sample_seq_check   CHECK (last_sample_seq >= 0),
    CONSTRAINT profile_viewing_history_content_revision_check  CHECK (content_revision >= 1),
    CONSTRAINT profile_viewing_history_position_check          CHECK (position_seconds >= 0),
    CONSTRAINT profile_viewing_history_duration_check          CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
    -- 位置不超过可信时长
    CONSTRAINT profile_viewing_history_position_duration_check CHECK (
        duration_seconds IS NULL OR position_seconds <= duration_seconds
    ),
    CONSTRAINT profile_viewing_history_revision_check          CHECK (revision >= 1),
    FOREIGN KEY (household_id, profile_id) REFERENCES profile (household_id, id),
    FOREIGN KEY (household_id, media_id)   REFERENCES media_item (household_id, id)
);

-- 7) 查询辅助索引(与 schema.ts 的 index/uniqueIndex 一一对应):
--    收藏键集分页(data-model §4):(created_at DESC, media_id DESC),前导
--    (household_id, profile_id) 圈定个人范围。
CREATE INDEX profile_channel_favorite_profile_listed_key
    ON profile_channel_favorite (household_id, profile_id, created_at DESC, media_id DESC);
-- 历史列表(data-model §7):(household_id, profile_id, last_viewed_at DESC, media_id DESC)
CREATE INDEX profile_viewing_history_profile_recent_key
    ON profile_viewing_history (household_id, profile_id, last_viewed_at DESC, media_id DESC);

-- programme 补索引确认(data-model §8:(household_id, source_id, xmltv_channel_id, starts_at, ends_at)):
-- 0003 的 UNIQUE INDEX epg_programme_slot_key 恰以同五列声明(唯一约束必然携带等价索引),
-- EPG 窗口查询所需的 (household_id, source_id, xmltv_channel_id) 前缀等值 + starts_at/ends_at
-- 范围已完整覆盖;同列重复索引只会加倍最大表(EPG 排期)的每次发布写入代价,故确认即可,
-- 不重复创建(任务摘要要求"补索引",实现按"索引存在性"逐字核验,见 schema.ts 同注释)。

-- 8) 代际标记:数据代际 2(up 全部 DDL 成功后设置;事务内执行,失败随事务回滚)
PRAGMA user_version = 2;
