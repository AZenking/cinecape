-- 0011_channel_visibility (018-channel-customization, data-model.md §1/§2):
-- 逻辑频道显隐控制与自定义编辑支持基座：
-- 1) media_item 增补 visible 字段（默认 1，CHECK 0 或 1），并创建按家庭+类型+显隐的联合索引。
-- 2) channel_logo 扩展 source_kind CHECK 约束支持 'custom'，source_id 允许为空（支持人工自定义台标）。
-- 既有数据零影响：ALTER TABLE ... ADD COLUMN visible INTEGER NOT NULL DEFAULT 1 走 SQLite 快速路径。

-- 1) media_item.visible
ALTER TABLE media_item ADD COLUMN visible INTEGER NOT NULL DEFAULT 1;

-- 2) 索引：按家庭、媒体类型与显隐状态过滤
CREATE INDEX idx_media_item_household_type_visible ON media_item (household_id, type, visible);

-- 3) channel_logo 胜者注册表重构：放宽 source_kind 校验为 ('iptv', 'epg', 'custom')，source_id 允许为 NULL
ALTER TABLE channel_logo RENAME TO channel_logo_old;

CREATE TABLE channel_logo (
    household_id TEXT NOT NULL REFERENCES household(id),
    media_id     TEXT NOT NULL,
    ref          TEXT NOT NULL,
    upstream_url TEXT,
    source_kind  TEXT NOT NULL,
    source_id    TEXT,
    revision     INTEGER NOT NULL,
    revoked_at   TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    CONSTRAINT channel_logo_source_kind_check CHECK (source_kind IN ('iptv', 'epg', 'custom')),
    CONSTRAINT channel_logo_revision_check    CHECK (revision >= 1),
    CONSTRAINT channel_logo_tombstone_check   CHECK (revoked_at IS NULL OR upstream_url IS NULL),
    FOREIGN KEY (household_id, media_id) REFERENCES media_item (household_id, id) ON DELETE CASCADE,
    FOREIGN KEY (household_id, source_id) REFERENCES media_source (household_id, id)
);

INSERT INTO channel_logo (
    household_id, media_id, ref, upstream_url, source_kind, source_id, revision, revoked_at, created_at, updated_at
)
SELECT household_id, media_id, ref, upstream_url, source_kind, source_id, revision, revoked_at, created_at, updated_at
FROM channel_logo_old;

DROP TABLE channel_logo_old;

CREATE UNIQUE INDEX channel_logo_household_id_media_id_key ON channel_logo (household_id, media_id);
CREATE UNIQUE INDEX channel_logo_household_id_ref_key      ON channel_logo (household_id, ref);
