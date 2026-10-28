-- 0003_media_catalog · 回滚:仅删除本阶段新建的表、索引与 catalog_state 初始化数据,
-- 完整保留阶段 1/2 的身份(Household/Account/Profile/Device/Session)、PIN 与策略值。
-- ⚠️ 媒体 ID 失效后策略引用保留为失效引用,不自行清空或重建已清除允许项
--    (data-model.md「迁移与回滚」);再次 up 会创建空目录,不恢复原媒体 ID 或指南;
--    完整恢复须使用停服下回滚前的一致性备份,并核验 integrity_check/foreign_key_check
--    与原策略版本、目录 ID。所有演练仅使用临时库与独立容器卷。

-- media_source.last_job_id 与 source_refresh.source_id 互为外键:按任意顺序 DROP 都会在
-- 隐式 DELETE 时触发即时外键校验;延迟到事务提交再统一校验(提交时本阶段表已全部删除,
-- 存留表无指向新表的外键,必然通过)。仅影响本事务,不影响连接全局配置。
PRAGMA defer_foreign_keys = ON;

-- 先删子表后删父表(随表删除的索引一并消失,无需单独 DROP)
DROP TABLE refresh_stage_entry;
DROP TABLE epg_programme;
DROP TABLE epg_channel;
DROP TABLE playback_source;
DROP TABLE source_entry;
DROP TABLE source_refresh;
DROP TABLE media_item;
DROP TABLE media_source;
DROP TABLE catalog_state;

-- device_session 为阶段 1 既有表,其上的本阶段唯一索引须显式删除(阶段 1/2 数据不受影响)
DROP INDEX device_session_household_id_id_key;
