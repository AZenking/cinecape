-- 0013_source_governance down:逆序删除。
DROP INDEX idx_governance_cleanup_run_household;
DROP TABLE governance_cleanup_run;

DROP INDEX idx_source_import_snapshot_captured;
DROP INDEX idx_source_import_snapshot_source;
DROP TABLE source_import_snapshot;

DROP INDEX idx_source_archive_household;
DROP TABLE source_archive;