-- 0011_channel_visibility down: 逆序回滚。
-- 恢复 channel_logo 原始 CHECK 约束与 source_id NOT NULL。
-- 删除 media_item.visible 列与联合索引。

ALTER TABLE channel_logo RENAME TO channel_logo_new;

CREATE TABLE channel_logo (
    household_id TEXT NOT NULL REFERENCES household(id),
    media_id     TEXT NOT NULL,
    ref          TEXT NOT NULL,
    upstream_url TEXT,
    source_kind  TEXT NOT NULL,
    source_id    TEXT NOT NULL,
    revision     INTEGER NOT NULL,
    revoked_at   TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    CONSTRAINT channel_logo_source_kind_check CHECK (source_kind IN ('iptv', 'epg')),
    CONSTRAINT channel_logo_revision_check    CHECK (revision >= 1),
    CONSTRAINT channel_logo_tombstone_check   CHECK (revoked_at IS NULL OR upstream_url IS NULL),
    FOREIGN KEY (household_id, media_id) REFERENCES media_item (household_id, id) ON DELETE CASCADE,
    FOREIGN KEY (household_id, source_id) REFERENCES media_source (household_id, id)
);

INSERT INTO channel_logo (
    household_id, media_id, ref, upstream_url, source_kind, source_id, revision, revoked_at, created_at, updated_at
)
SELECT household_id, media_id, ref, upstream_url, source_kind, COALESCE(source_id, ''), revision, revoked_at, created_at, updated_at
FROM channel_logo_new
WHERE source_kind IN ('iptv', 'epg');

DROP TABLE channel_logo_new;

CREATE UNIQUE INDEX channel_logo_household_id_media_id_key ON channel_logo (household_id, media_id);
CREATE UNIQUE INDEX channel_logo_household_id_ref_key      ON channel_logo (household_id, ref);

DROP INDEX idx_media_item_household_type_visible;
ALTER TABLE media_item DROP COLUMN visible;
