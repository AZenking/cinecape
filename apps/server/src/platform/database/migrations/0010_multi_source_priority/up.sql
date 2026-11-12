-- 0010_multi_source_priority(016-multi-source-live-epg,data-model.md §1.1):
-- 多直播源聚合与多 EPG 源级联匹配基座 —— media_source 单列增补 priority + 排序索引。
-- ⚠️ 本文件与 src/platform/database/schema.ts 必须同步修改(schema.ts 仅为查询层类型);
--    禁止修改既有 0001~0009 SQL。零回填语义:ADD COLUMN ... DEFAULT 100 走 SQLite ALTER
--    快速路径(不重写既有行),既有行读取时呈现默认值 100,历史源完全向后兼容。
-- 执行环境:better-sqlite3(连接已开 foreign_keys = ON / WAL),由 migrate.ts 在事务内应用。
-- 硬约束(宪章原则二/四):索引以显式 household_id 打头(家庭边界);priority 数值越小
--   优先级越高(如 10 优于 50 优于 100),kind='epg' 时参与级联回退裁决,kind='iptv'
--   可作默认线路起播权重(裁决/权重均为应用层语义,DDL 不设 CHECK);不设 user_version
--   (与 0007/0008/0009 同属代际 2 可回滚尾段,up/down 均保持 user_version=2)。

-- 1) media_source.priority(data-model §1.1 逐字):INTEGER NOT NULL DEFAULT 100;
--    既有行经 DEFAULT 兜底为 100(与 schema.ts 查询层 default(100) 一致)。
ALTER TABLE media_source ADD COLUMN priority INTEGER NOT NULL DEFAULT 100;

-- 2) 排序索引(data-model §1.1 逐字,索引名与 schema.ts 声明一致):按家庭、源类型与
--    优先级升序检索。
CREATE INDEX idx_media_source_household_kind_prio
ON media_source(household_id, kind, priority ASC);
