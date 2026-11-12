-- 0009_channel_logos down:逆序删除(data-model §7)。索引随表 DROP 一并消失;
-- 两列均未被任何索引引用,列级命名 CHECK 随列一并消失,DROP COLUMN 合法
-- (better-sqlite3 13.0.3 打包 SQLite ≥3.35,与 0006/0007 down 先例一致)。
DROP TABLE channel_logo;
ALTER TABLE epg_channel DROP COLUMN icon_url;
ALTER TABLE source_entry DROP COLUMN logo_url;
