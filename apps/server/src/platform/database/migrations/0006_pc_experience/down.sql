-- 0006_pc_experience · 回滚:仅删除本迁移新增的五张表、索引与既有表扩展列,代际标记回落 1,
-- 完整保留 0001~0005 的身份/PIN/策略/目录/EPG/绑定/播放数据(down 对原表行数据零修改)。
-- ⚠️ 个人观看数据(收藏/历史/进度状态/时钟/设置授予)随表删除、不自行恢复;再次 up 创建空表;
--    完整恢复须使用停服下回滚前的一致性备份,并核验 integrity_check/foreign_key_check。
--    down/恢复只对独立临时目录执行(data-model §1),真实旧目录与源媒体不在删除范围。
-- DROP COLUMN 依据:better-sqlite3 13.0.3 打包 SQLite ≥3.35,直接支持 ALTER TABLE ... DROP COLUMN
-- (与 0004 down 先例一致);被删列的列级命名 CHECK 随列一并消失,无须 12-step 重建。
--   例外:引用 is_main 的部分唯一索引 one_main_profile 必须先显式删除 ——
--   SQLite 对"被索引引用的列"执行 DROP COLUMN 会报错(DROP INDEX 先行)。
-- 顺序:先删子表后删父目标;五张新表之间无相互外键(playback_progress_state 指向的
-- playback_session 属 0005,不在本次删除范围),随表索引一并消失,无需单独 DROP。

-- 1) 五张新表
DROP TABLE profile_viewing_history;
DROP TABLE playback_progress_state;
DROP TABLE profile_progress_clock;
DROP TABLE profile_channel_favorite;
DROP TABLE settings_access_grant;

-- 2) profile 主档案标记:先删部分唯一索引,再删 is_main(其列级 CHECK 一并移除)
DROP INDEX one_main_profile;
ALTER TABLE profile DROP COLUMN is_main;
ALTER TABLE profile DROP COLUMN pin_version;
ALTER TABLE profile DROP COLUMN version;

-- 3) 其余既有表扩展列(列级 CHECK 随列消失;均未被任何索引引用,DROP COLUMN 合法)
ALTER TABLE household DROP COLUMN version;
ALTER TABLE household DROP COLUMN main_profile_version;
ALTER TABLE account DROP COLUMN credential_version;
ALTER TABLE device_session DROP COLUMN profile_context_version;
ALTER TABLE playback_session DROP COLUMN profile_context_version;
ALTER TABLE media_item DROP COLUMN content_revision;
ALTER TABLE source_entry DROP COLUMN group_title;

-- 4) 代际标记回落 1(down 后与旧代际标记一致,可再次 up)
PRAGMA user_version = 1;
