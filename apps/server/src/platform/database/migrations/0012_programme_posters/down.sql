-- 0012_programme_posters down:逆序删除(data-model §5)。
-- 先删表/索引,再删 epg_programme 两列(列级命名 CHECK 随列消失;
-- better-sqlite3 13.0.3 打包 SQLite ≥3.35,与 0009/0011 down 先例一致)。
DROP INDEX programme_poster_expiry_idx;
DROP INDEX programme_poster_household_id_ref_key;
DROP TABLE programme_poster;

DROP INDEX epg_programme_household_match_key_idx;
ALTER TABLE epg_programme DROP COLUMN poster_ref;
ALTER TABLE epg_programme DROP COLUMN poster_match_key;