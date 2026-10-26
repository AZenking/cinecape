-- 0005_playback · 回滚:仅删除本迁移新增的播放表、其索引与 device 复合外键目标索引,
-- 完整保留 0001~0004 的身份/PIN/策略/目录/EPG/绑定数据(data-model「验证与恢复」:
-- down 删除本阶段表及索引,对原表数据零修改)。
-- ⚠️ 播放记录随表删除、不自行恢复;再次 up 会创建空播放表,不恢复原会话/票据/转换记录;
--    完整恢复须使用停服下回滚前的一致性备份,并核验 integrity_check/foreign_key_check
--    与原播放数据。旧 ticket 即使经备份恢复,也因重启会话标 interrupted 而不可播放。
--    所有演练仅使用临时库与独立容器卷。

-- 先删子表后删父表:playback_ticket / playback_conversion 均以
-- playback_session(household_id, id) 为复合外键目标,子表先行删除后父表隐式 DELETE
-- 不触发外键失败;随表删除的索引一并消失(无需单独 DROP)。
-- playback_failure_event 的复合外键目标为 0001~0004 既有表(device_session/device/profile/
-- media_item),删除顺序不受限;playback_conversion 须先于其父表 playback_session 删除。
DROP TABLE playback_ticket;
DROP TABLE playback_conversion;
DROP TABLE playback_failure_event;
DROP TABLE playback_session;

-- device_session 先例(0003 down):本迁移为既有表新增的唯一索引须显式删除
-- (0001~0004 数据不受影响;引用它的 playback_session/playback_failure_event 已先行删除)
DROP INDEX device_household_id_id_key;
