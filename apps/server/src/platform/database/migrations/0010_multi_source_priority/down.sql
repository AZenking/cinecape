-- 0010_multi_source_priority down:逆序删除。先 DROP 索引再 DROP 列(SQLite DROP COLUMN
-- 要求目标列不被任何索引/部分索引引用;better-sqlite3 13.0.3 打包 SQLite ≥3.35,
-- 与 0006/0007/0009 down 先例一致)。既有行自定义 priority 随列消失属破坏性回滚,
-- 正式回滚请使用 migrate.ts 每次 down 前自动生成的 VACUUM INTO 一致备份;
-- 不设 user_version(与 0009 同属代际 2 可回滚尾段,down 保持 user_version=2)。
DROP INDEX idx_media_source_household_kind_prio;
ALTER TABLE media_source DROP COLUMN priority;
