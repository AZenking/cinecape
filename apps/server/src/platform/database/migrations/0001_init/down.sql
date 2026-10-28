-- 0001_init · 回滚:完整 DROP(逆序)+ DROP 索引,可回滚到空业务表状态
-- (_migrations 表与对应版本行由 migrate.ts 的执行器管理,不在本文件职责内)。
-- ⚠️ 本文件与 src/database/schema.ts / 0001_init/up.sql 必须同步修改。

DROP INDEX IF EXISTS device_session_token_hash_key;
DROP INDEX IF EXISTS one_default_profile;
DROP INDEX IF EXISTS account_household_id_id_key;
DROP INDEX IF EXISTS account_household_id_key;
DROP INDEX IF EXISTS account_username_normalized_key;

DROP TABLE IF EXISTS device_session;
DROP TABLE IF EXISTS device;
DROP TABLE IF EXISTS profile;
DROP TABLE IF EXISTS account;
DROP TABLE IF EXISTS household;
