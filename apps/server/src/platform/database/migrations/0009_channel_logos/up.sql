-- 0009_channel_logos(014-channel-logos,data-model.md §1/§2/§7):
-- 频道 Logo 数据链路基座 —— 两列私有原始地址增补 + 胜者注册表 channel_logo。
-- ⚠️ 本文件与 src/platform/database/schema.ts 必须同步修改(schema.ts 仅为查询层类型);
--    禁止修改既有 0001~0008 SQL。零回填:迁移后系统行为与现状完全一致(poster_ref 全 NULL),
--    Logo 随下次刷新出现(data-model §7)。
-- 执行环境:better-sqlite3(连接已开 foreign_keys = ON / WAL),由 migrate.ts 在事务内应用。
-- 硬约束(宪章原则二/四):channel_logo 显式 household_id 边界;复合外键以 (household_id, id)
--   唯一键为目标,禁止跨家庭关联;时间为 UTC ISO-8601 TEXT;不设 user_version(与 0007/0008
--   同属代际 2 可回滚尾段,up/down 均保持 user_version=2)。

-- 1) source_entry.logo_url(data-model §1):IPTV 原始 Logo 地址,私有载荷(任何公共 DTO/
--    投影不得输出)。列级命名 CHECK 随列声明(0006/0007 先例:被删列时约束一并消失,
--    down 直接 DROP COLUMN;表级 CHECK 会令 DROP COLUMN 残留引用而重解析失败)。
--    解析层归一化产物:仅 http(s) scheme 且 length 9~2048,非法→NULL(写入路径职责)。
ALTER TABLE source_entry
    ADD COLUMN logo_url TEXT
    CONSTRAINT source_entry_logo_url_check CHECK (
        logo_url IS NULL
        OR (
            (logo_url LIKE 'http://%' OR logo_url LIKE 'https://%')
            AND length(logo_url) BETWEEN 9 AND 2048
        )
    );

-- 2) epg_channel.icon_url(data-model §1):XMLTV 频道首个 <icon src> 归一化产物,同形态
--    CHECK,同上私有。
ALTER TABLE epg_channel
    ADD COLUMN icon_url TEXT
    CONSTRAINT epg_channel_icon_url_check CHECK (
        icon_url IS NULL
        OR (
            (icon_url LIKE 'http://%' OR icon_url LIKE 'https://%')
            AND length(icon_url) BETWEEN 9 AND 2048
        )
    );

-- 3) channel_logo(data-model §2):胜者注册表(media-catalog 域)。每频道至多一行
--    (UNIQUE (household_id, media_id) ⇒ 墓碑占用行位,新胜者同行覆盖);解析按
--    (household_id, ref) 单查。ref 为随机 128-bit 不透明令牌(32 字符小写 hex,应用层);
--    墓碑态 revoked_at 非空时 upstream_url 必须为 NULL;频道媒体删除经复合外键
--    ON DELETE CASCADE 行消失,旧引用 404 同形。合并规则 M1~M4/墓碑 GC 为应用事务语义。
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

CREATE UNIQUE INDEX channel_logo_household_id_media_id_key ON channel_logo (household_id, media_id);
CREATE UNIQUE INDEX channel_logo_household_id_ref_key      ON channel_logo (household_id, ref);
