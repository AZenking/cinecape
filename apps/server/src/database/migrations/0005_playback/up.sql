-- 0005_playback · 阶段 4 迁移:播放会话 / 播放票据 / 播放转换 / 播放失败事件(4 张新表)
-- 权威列定义:docs/specs/004-playback-resolver/data-model.md
--   「## playback_session」「## playback_ticket」「## playback_conversion」
--   「## playback_failure_event」四节 +「## 验证与恢复」节
-- ⚠️ 本文件与 src/database/schema.ts 必须同步修改(schema.ts 仅为查询层类型);
--    禁止修改既有 0001~0004 SQL。
-- 执行环境:better-sqlite3(连接已开 foreign_keys = ON / WAL),由 migrate.ts 在事务内应用。
-- 硬约束(宪章原则二/四):全部新表显式 household_id;复合外键以 (household_id, id) 唯一键
-- 为目标,禁止跨家庭关联;时间为 UTC ISO-8601 TEXT(字符串序即时间序)。
-- 语义:状态机(preparing→ready/failed/ended/interrupted、终态不可复活、seek/重建输出
--       升 generation、纯字幕切换仅升 version 等)由应用层执行;数据库层只落实 data-model
--       明示的 CHECK(枚举/可空性/数值下限/终态时间戳),不设状态转换触发器。
--       0005 up 对原表数据零修改;down 删除本阶段表、其索引与 device 复合外键目标索引。

-- 1) 复合外键目标补充:device(household_id, id)
--    playback_session.device_id 与 playback_failure_event.device_id 的复合外键目标
--    (与 0002 profile_household_id_id_key / 0003 device_session_household_id_id_key 同规则)
CREATE UNIQUE INDEX device_household_id_id_key ON device (household_id, id);

-- 2) playback_session:播放会话。绑定 device_session/device/profile/media 后不可改变;
--    source 与 delivery 在初始 preparing 允许为空(准备阶段按排序尝试候选),ready/playing/paused
--    必须非空;终态保留已确定值,准备失败仍可为空(禁止补造源或 delivery)。
--    created_at 为请求被接受,started_at 为首次媒体交付(可能永不发生,之后不重置);
--    desired_paused 保留 seek/换轨时的暂停意图(heartbeat.paused 更新)。
CREATE TABLE playback_session (
    id                TEXT PRIMARY KEY NOT NULL,
    household_id      TEXT NOT NULL REFERENCES household(id),
    device_session_id TEXT NOT NULL,
    device_id         TEXT NOT NULL,
    profile_id        TEXT NOT NULL,
    media_id          TEXT NOT NULL,
    playback_source_id TEXT,
    state             TEXT NOT NULL,
    delivery          TEXT,
    generation        INTEGER NOT NULL,
    version           INTEGER NOT NULL,
    -- 影片逻辑时间秒(REAL:API 契约 positionSeconds 为 number,可含小数;非负)
    position_seconds  REAL NOT NULL,
    audio_track_id    TEXT,
    subtitle_track_id TEXT,
    desired_paused    INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    started_at        TEXT,
    ended_at          TEXT,
    last_heartbeat_at TEXT NOT NULL,
    failure_code      TEXT,
    CONSTRAINT playback_session_state_check CHECK (state IN (
        'preparing', 'ready', 'playing', 'paused', 'ended', 'failed', 'interrupted'
    )),
    -- delivery 合法五值;preparing/终态可为 NULL(准备失败禁止补造)
    CONSTRAINT playback_session_delivery_check CHECK (
        delivery IS NULL
        OR delivery IN ('direct', 'hls_proxy', 'remux', 'audio_transcode', 'video_transcode')
    ),
    -- 准备完成方可交付:活动三态必须同时确定源与交付模式
    CONSTRAINT playback_session_source_delivery_check CHECK (
        state NOT IN ('ready', 'playing', 'paused')
        OR (playback_source_id IS NOT NULL AND delivery IS NOT NULL)
    ),
    CONSTRAINT playback_session_generation_check CHECK (generation >= 1),
    CONSTRAINT playback_session_version_check    CHECK (version >= 1),
    CONSTRAINT playback_session_position_check   CHECK (position_seconds >= 0),
    -- 布尔:0 = 播放器应继续播放(默认),1 = 播放器应保持暂停
    CONSTRAINT playback_session_desired_paused_check CHECK (desired_paused IN (0, 1)),
    -- ended_at 在终态(ended/failed/interrupted)必填,活动态必空
    CONSTRAINT playback_session_ended_at_check CHECK (
        (state IN ('ended', 'failed', 'interrupted') AND ended_at IS NOT NULL)
        OR (state NOT IN ('ended', 'failed', 'interrupted') AND ended_at IS NULL)
    ),
    -- 失败码仅 failed 非空(双向)
    CONSTRAINT playback_session_failure_code_check CHECK (
        (state = 'failed' AND failure_code IS NOT NULL)
        OR (state <> 'failed' AND failure_code IS NULL)
    ),
    -- 会话五要素全部绑定同家庭,禁止跨家庭关联
    -- (device 复合外键目标唯一索引见文件头部 1);playback_source_id 为 NULL 时
    -- 复合外键按 MATCH SIMPLE 语义不校验)
    FOREIGN KEY (household_id, device_session_id) REFERENCES device_session (household_id, id),
    FOREIGN KEY (household_id, device_id)         REFERENCES device (household_id, id),
    FOREIGN KEY (household_id, profile_id)        REFERENCES profile (household_id, id),
    FOREIGN KEY (household_id, media_id)          REFERENCES media_item (household_id, id),
    FOREIGN KEY (household_id, playback_source_id) REFERENCES playback_source (household_id, id)
);

-- 3) playback_ticket:播放票据。随机 256bit ticket 只在创建/续期响应出现一次,会话侧
--    仅存 hash 无法复现明文 URL;续期写新行,旧票原过期时间不变;seek/重建输出的换轨
--    升 generation 后旧 generation 无论 TTL 都不可用(应用层以会话当前 generation 过滤)。
CREATE TABLE playback_ticket (
    id           TEXT PRIMARY KEY NOT NULL,
    household_id TEXT NOT NULL REFERENCES household(id),
    session_id   TEXT NOT NULL,
    token_hash   TEXT NOT NULL,
    issued_at    TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    generation   INTEGER NOT NULL,
    revoked_at   TEXT,
    CONSTRAINT playback_ticket_generation_check CHECK (generation >= 1),
    -- 票据有效期必须为正区间(相等亦拒绝)
    CONSTRAINT playback_ticket_expiry_check CHECK (expires_at > issued_at),
    -- 票据归属同家庭会话,禁止跨家庭取票
    FOREIGN KEY (household_id, session_id) REFERENCES playback_session (household_id, id)
);

-- 4) playback_conversion:每会话每代至多一条转换记录。无队列:BEGIN IMMEDIATE 内按全部
--    reserved~stopping 行计算全局额度再 reserve;spawn 失败补偿释放;唯一单实例执行器
--    负责回收,重启先标 interrupted。output_*_codec 为非空服务器输出编码标识
--    (静音合法视频的 output_audio_codec 为 'none',不设枚举 CHECK);
--    cleanup_state 仅 pending/complete,目录删除成功才 complete,无第三枚举。
CREATE TABLE playback_conversion (
    id                 TEXT PRIMARY KEY NOT NULL,
    household_id       TEXT NOT NULL REFERENCES household(id),
    session_id         TEXT NOT NULL,
    generation         INTEGER NOT NULL,
    mode               TEXT NOT NULL,
    state              TEXT NOT NULL,
    hardware_backend   TEXT,
    output_video_codec TEXT NOT NULL,
    output_audio_codec TEXT NOT NULL,
    started_at         TEXT,
    ended_at           TEXT,
    failure_code       TEXT,
    cleanup_state      TEXT NOT NULL DEFAULT 'pending',
    bytes_on_disk      INTEGER NOT NULL DEFAULT 0,
    last_progress_at   TEXT,
    CONSTRAINT playback_conversion_mode_check CHECK (mode IN ('remux', 'audio_transcode', 'video_transcode')),
    CONSTRAINT playback_conversion_state_check CHECK (state IN (
        'reserved', 'probing', 'starting', 'running', 'stopping', 'ended', 'failed', 'interrupted'
    )),
    CONSTRAINT playback_conversion_generation_check CHECK (generation >= 1),
    -- ended_at 在终态(ended/failed/interrupted)必填(data-model 未要求非终态为空,不加强约束)
    CONSTRAINT playback_conversion_ended_at_check CHECK (
        state NOT IN ('ended', 'failed', 'interrupted') OR ended_at IS NOT NULL
    ),
    -- 失败码仅 failed 必填、其余为空(双向)
    CONSTRAINT playback_conversion_failure_code_check CHECK (
        (state = 'failed' AND failure_code IS NOT NULL)
        OR (state <> 'failed' AND failure_code IS NULL)
    ),
    -- 目录删除成功才 complete;删除失败仍为 pending,不存在 cleanup_pending 第三枚举
    CONSTRAINT playback_conversion_cleanup_state_check CHECK (cleanup_state IN ('pending', 'complete')),
    CONSTRAINT playback_conversion_bytes_check CHECK (bytes_on_disk >= 0),
    -- 转换归属同家庭会话,禁止跨家庭转换
    FOREIGN KEY (household_id, session_id) REFERENCES playback_session (household_id, id)
);

-- 5) playback_failure_event:播放失败事件(审计)。仅有效设备会话可写;媒体不属于该家庭
--    或不可见则 media_id = NULL(不存客户端原始目标 ID);不关联所选资源,不产生播放 session。
CREATE TABLE playback_failure_event (
    id                TEXT PRIMARY KEY NOT NULL,
    household_id      TEXT NOT NULL REFERENCES household(id),
    device_session_id TEXT NOT NULL,
    device_id         TEXT NOT NULL,
    profile_id        TEXT,
    media_id          TEXT,
    occurred_at       TEXT NOT NULL,
    stable_code       TEXT NOT NULL,
    -- 稳定失败码为非空字符串(审计聚合键;具体码表由应用层定义)
    CONSTRAINT playback_failure_event_stable_code_check CHECK (length(stable_code) >= 1),
    -- 事件四要素全部绑定同家庭,禁止跨家庭写入
    -- (profile_id/media_id 为 NULL 时复合外键按 MATCH SIMPLE 语义不校验)
    FOREIGN KEY (household_id, device_session_id) REFERENCES device_session (household_id, id),
    FOREIGN KEY (household_id, device_id)         REFERENCES device (household_id, id),
    FOREIGN KEY (household_id, profile_id)        REFERENCES profile (household_id, id),
    FOREIGN KEY (household_id, media_id)          REFERENCES media_item (household_id, id)
);

-- 唯一约束与查询辅助索引(与 schema.ts 的 index/uniqueIndex 一一对应;
-- (household_id, id) 同时是 playback_ticket/playback_conversion 的复合外键目标)
CREATE UNIQUE INDEX playback_session_household_id_id_key ON playback_session (household_id, id);
-- token_hash 全局唯一:hash 反查票据入口(device_session_token_hash_key 同规则)
CREATE UNIQUE INDEX playback_ticket_token_hash_key ON playback_ticket (token_hash);
-- 设备维度查询:恢复/清理按 (household_id, device_id, created_at, id) 定位会话
CREATE INDEX playback_session_household_device_key ON playback_session (household_id, device_id, created_at, id);
-- 档案隔离查询:按 profile 过滤播放记录(前导 (household_id, profile_id))
CREATE INDEX playback_session_household_profile_key ON playback_session (household_id, profile_id, created_at, id);
-- 转换唯一性:每会话每代至多一条转换记录(UNIQUE(household_id,session_id,generation),
-- 单实例执行器以本键幂等回收)
CREATE UNIQUE INDEX playback_conversion_session_generation_key
    ON playback_conversion (household_id, session_id, generation);
-- 失败事件审计检索:按设备时间序定位(household_id, device_id, occurred_at, id)
CREATE INDEX playback_failure_event_household_device_time_key
    ON playback_failure_event (household_id, device_id, occurred_at, id);
