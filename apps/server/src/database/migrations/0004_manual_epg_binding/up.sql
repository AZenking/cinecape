-- 0004_manual_epg_binding · 阶段 3 增补(US5,ADR-0008):单频道手动 EPG 绑定
-- 权威列定义:docs/specs/003-media-catalog/data-model.md「## 0004 增补:manual_epg_binding(设计,未实施)」
-- ⚠️ 本文件与 src/database/schema.ts 必须同步修改(schema.ts 仅为查询层类型);
--    禁止修改既有 0003 SQL(ADR-0008),media_source.epg_generation 以 ALTER TABLE ADD COLUMN 追加。
-- 执行环境:better-sqlite3(连接已开 foreign_keys = ON / WAL),由 migrate.ts 在事务内应用。
-- 语义:manual 保存即锁定(来源/频道成对);auto 为解除后的版本墓碑(不删行,防 ABA,
--       不代表另建自动匹配结果);version 无行读取为 0、首写 1、其后每次保存/解除 +1;
--       不回填既有数据 —— 既有频道无绑定行 = 自动行为不变,既有来源 generation 迁移后为 0
--       (已导入与否仍以 last_success_at 与实际 epg_channel 判断)。
-- 硬约束(宪章原则二/四):全表显式 household_id;复合外键以 (household_id, id) 唯一键为目标,
-- 禁止跨家庭关联;时间为 UTC。

-- 1) manual_epg_binding:(household_id, media_id) 复合主键,一媒体频道至多一行绑定。
--    不对 epg_channel 建 FK:EPG 窗口替换会删行,绑定目标必须挂在稳定的 media/source 上
--    (kind=epg 与非自引用由应用事务另校验)。
CREATE TABLE manual_epg_binding (
    household_id     TEXT NOT NULL REFERENCES household(id),
    media_id         TEXT NOT NULL,
    mode             TEXT NOT NULL,
    epg_source_id    TEXT,
    xmltv_channel_id TEXT,
    version          INTEGER NOT NULL,
    updated_at       TEXT NOT NULL,
    -- mode:manual = 家长保存的锁定绑定;auto = 解除后的墓碑(保留行防 ABA)
    CONSTRAINT manual_epg_binding_mode_check CHECK (mode IN ('manual', 'auto')),
    -- 成对规则:manual 时来源与频道必须成对非空;auto 墓碑两者均 NULL
    CONSTRAINT manual_epg_binding_target_pair_check CHECK (
        (mode = 'manual' AND epg_source_id IS NOT NULL AND xmltv_channel_id IS NOT NULL)
        OR (mode = 'auto' AND epg_source_id IS NULL AND xmltv_channel_id IS NULL)
    ),
    -- XMLTV 频道 ID 长度 1~255,大小写敏感(刻意不加 COLLATE NOCASE)
    CONSTRAINT manual_epg_binding_xmltv_channel_check CHECK (
        xmltv_channel_id IS NULL OR length(xmltv_channel_id) BETWEEN 1 AND 255
    ),
    -- version:首写 1,其后每次保存/解除 +1(无行读取为 0);墓碑不删除
    CONSTRAINT manual_epg_binding_version_check CHECK (version >= 1),
    -- 媒体归属:(household_id, media_id) → media_item(household_id, id),绑定不跨家庭
    FOREIGN KEY (household_id, media_id) REFERENCES media_item (household_id, id),
    -- EPG 来源归属:(household_id, epg_source_id) → media_source(household_id, id)
    -- (auto 墓碑两列为 NULL,复合外键按 MATCH SIMPLE 语义对 NULL 子键不校验)
    FOREIGN KEY (household_id, epg_source_id) REFERENCES media_source (household_id, id),
    PRIMARY KEY (household_id, media_id)
);

-- 2) media_source 追加 epg_generation:每次成功发布 EPG 窗口 +1(与节目替换同事务),
--    失败/中断不加;用 ALTER TABLE ADD COLUMN,不改 0003 文件(ADR-0008)。
--    既有已成功来源迁移后为 0,不以 generation>0 代替已导入判断。
ALTER TABLE media_source
    ADD COLUMN epg_generation INTEGER NOT NULL DEFAULT 0
    CONSTRAINT media_source_epg_generation_check CHECK (epg_generation >= 0);

-- 3) 查询辅助索引(最小必要):EPG 发布失效与绑定管理按 (household_id, epg_source_id)
--    精确定位受影响绑定;按家庭全量读取走主键前缀 (household_id, media_id),无需额外索引。
CREATE INDEX manual_epg_binding_household_source_key ON manual_epg_binding (household_id, epg_source_id);
