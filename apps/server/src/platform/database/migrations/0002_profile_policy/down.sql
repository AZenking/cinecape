-- 0002_profile_policy · 回滚:删除阶段 2 新增数据,保留全部阶段 1 业务数据。
-- ⚠️ 自定义策略与家长验证计数随 down 丢失,重新 up 恢复默认策略;
--    恢复自定义策略须使用升级前备份(quickstart「升级、回滚、恢复」)。
--    含儿童家庭的实例不得把降级到阶段 1 视为安全等价运行(旧版本不执行新策略)。

DROP TABLE parent_verification_state;
DROP TABLE profile_policy;
DROP INDEX profile_household_id_id_key;
