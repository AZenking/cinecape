-- 0004_manual_epg_binding · 回滚:仅删除本迁移新增的绑定表、其索引与 media_source.epg_generation 列,
-- 完整保留 0001~0003 的目录/节目/媒体身份/PIN/策略(与 0003 down 范围不同:目录数据不删)。
-- ⚠️ 手动绑定配置随表删除、行为回落自动模式:本迁移不宣称恢复手动配置或 generation 历史;
--    恢复原绑定与版本须使用停服下回滚前的一致性备份(ADR-0008「Migration and rollback」),
--    并核验 integrity_check/foreign_key_check。所有演练仅使用临时库与独立容器卷。
-- DROP COLUMN 依据:better-sqlite3 13.0.3 打包 SQLite 3.53.4(≥3.35),直接支持
-- ALTER TABLE ... DROP COLUMN,无需「建新表-拷贝-改名」模式。

-- 绑定表与其上的 manual_epg_binding_household_source_key 随表一并消失(无需单独 DROP INDEX);
-- 表内行指向 media_item/media_source 的外键在删除时必然满足,无跨表互相引用,无需延迟校验。
DROP TABLE manual_epg_binding;

-- 移除 epg_generation(该列未被任何索引/生成列引用,DROP COLUMN 合法);既有行数据不动。
ALTER TABLE media_source DROP COLUMN epg_generation;
