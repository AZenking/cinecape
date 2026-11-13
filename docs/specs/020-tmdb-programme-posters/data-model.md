# Data Model: 020-tmdb-programme-posters

日期：2026-11-13。列/约束以迁移 `0012_programme_posters` 为准；`schema.ts` 为查询层类型，必须与迁移同步。

## 0. 变更总览

| 对象 | 变更 | 性质 |
| --- | --- | --- |
| `programme_poster`（新表） | — | TMDB 标题级匹配缓存（EPG 域） |
| `epg_programme` | +`poster_match_key TEXT NULL` | 归一化标题键 |
| `epg_programme` | +`poster_ref TEXT NULL` | 不透明海报引用 |
| `epg_programme` | +`(household_id, poster_match_key)` 索引 | 按标题键批量写 ref |

不变：`manual_epg_binding`、`epg_channel`、`media_item`、播放/个人/策略表；无既有列语义变化。

## 1. `programme_poster`

```text
programme_poster
  household_id    TEXT NOT NULL  REFERENCES household(id)
  match_key       TEXT NOT NULL  -- 归一化标题键
  ref             TEXT NULL      -- 32 位小写 hex；matched 行必填
  state           TEXT NOT NULL  -- matched | no_match | failed
  tmdb_id         INTEGER NULL
  media_type      TEXT NULL      -- movie | tv
  title           TEXT NULL      -- TMDB 本地化标题
  original_title  TEXT NULL
  poster_path     TEXT NULL      -- TMDB 相对路径；matched 行必填
  release_date    TEXT NULL
  vote_average    REAL NULL
  popularity      REAL NULL
  match_score     REAL NULL
  year_hint       INTEGER NULL
  attempts        INTEGER NOT NULL DEFAULT 0
  last_attempt_at TEXT NULL
  expires_at      TEXT NOT NULL
  created_at      TEXT NOT NULL
  updated_at      TEXT NOT NULL
  PRIMARY KEY (household_id, match_key)
  UNIQUE (household_id, ref)
```

约束：

```sql
CHECK (state IN ('matched', 'no_match', 'failed'))
CHECK (length(match_key) BETWEEN 1 AND 255)
CHECK (ref IS NULL OR (length(ref) = 32 AND ref NOT GLOB '*[^0-9a-f]*'))
CHECK (
  (state = 'matched' AND ref IS NOT NULL AND tmdb_id IS NOT NULL
   AND media_type IN ('movie','tv') AND poster_path IS NOT NULL)
  OR
  (state <> 'matched' AND ref IS NULL AND tmdb_id IS NULL AND poster_path IS NULL)
)
CHECK (poster_path IS NULL OR (poster_path LIKE '/%' AND poster_path NOT LIKE '//%' AND length(poster_path) <= 512))
CHECK (year_hint IS NULL OR (year_hint BETWEEN 1900 AND 2100))
CHECK (attempts >= 0)
```

索引：

```sql
CREATE INDEX programme_poster_expiry_idx ON programme_poster (household_id, expires_at);
```

说明：
- `ref` 为随机 128-bit（`crypto.randomBytes(16).toString('hex')`），不可解码；仅 matched 行签发。
- 同 `(tmdb_id, poster_path)` 的刷新保留旧 ref，保住浏览器缓存；poster_path 变化才轮换，`epg_programme.poster_ref` 在同一事务更新。
- `expires_at` 为 UTC ISO；过期行不再下发，等待重查或 GC。
- `attempts/last_attempt_at` 用于诊断与失败节流；不作为公共 DTO。
- 负缓存/失败缓存也占一行（`ref=NULL`），避免反复请求。

## 2. `epg_programme` 增列

```sql
ALTER TABLE epg_programme ADD COLUMN poster_match_key TEXT
  CHECK (poster_match_key IS NULL OR length(poster_match_key) BETWEEN 1 AND 255);

ALTER TABLE epg_programme ADD COLUMN poster_ref TEXT
  CHECK (poster_ref IS NULL OR (length(poster_ref) = 32 AND poster_ref NOT GLOB '*[^0-9a-f]*'));

CREATE INDEX epg_programme_household_match_key_idx
  ON epg_programme (household_id, poster_match_key);
```

说明：
- `poster_match_key` 由标题归一化纯函数生成；通用栏目/空标题为 NULL。
- `poster_ref` 只存不透明引用，不存 TMDB ID/URL。
- 不建外键到 `programme_poster`：缓存行可被 GC；代理解析不到即 404，前端回退。
- EPG 重新发布时行会删除重建；发布事务按 `posterByTitle` 写入当前缓存命中的 ref；发布后补全再修正新标题。

## 3. 生命周期

```text
无缓存行 --(首次查询 matched)--> matched(ref R1, expires T+180d)
无缓存行 --(首次查询 no_match)--> no_match(expires T+30d)
无缓存行 --(查询失败)----------> failed(expires T+60m, attempts+1)
matched --(TTL 到期, 重查同 poster)--> matched(保留 R1, expires 续期)
matched --(TTL 到期, 重查不同 poster)--> matched(新 ref R2; 旧 R1 404)
matched --(TTL 到期, 重查 no_match)--> no_match(ref=NULL; 节目 ref 清空)
no_match --(TTL 到期, 重查 matched)--> matched(新 ref)
任意 --(expires_at < now-30d, 补全 GC)--> 删除行
```

## 4. 引用语义

- `matched` + `expires_at > now` + `poster_path` 有效 → 公共代理 200 返回图片。
- 未命中/跨家庭/格式非法/过期/非 matched/路径空 → 404 `NOT_FOUND` 同形。
- 上游图片读取失败/非图片/非 identity → 502 `PROGRAMME_POSTER_UPSTREAM_FAILED`。
- 上游超预算 → 504 `PROGRAMME_POSTER_UPSTREAM_TIMEOUT`。
- 浏览器缓存：`Cache-Control: public, max-age=86400`。

## 5. 迁移与回填

- `up.sql`：两列 + 索引 + 新表 + 索引。
- `down.sql`：先 `DROP INDEX` / `DROP TABLE`，再 `ALTER TABLE epg_programme DROP COLUMN`。
- 不做 SQL 归一化回填（SQLite 无法复现中文规则）；旧 `epg_programme` 行的 `poster_match_key` 由下次 EPG 刷新写入，或 CLI `--backfill-keys` 分批补齐。
- readiness：`database.ts` 的 `REQUIRED_COLUMNS` 增加 `epg_programme: ['poster_match_key','poster_ref']`、`programme_poster` 全列；就绪表清单增加 `programme_poster`。
- `migrate.ts` 的 `EXPECTED_TABLES`/`EXPECTED_COLUMNS` 同步；`precheck.ts` 的 `ROLLBACKABLE_TAIL_MIGRATIONS` 增加 `0012_programme_posters`。

## 6. 边界核验

- [x] `programme_poster` 显式 `household_id`；代理按请求作用域家庭解析。
- [x] 无 Profile 维度、无个人数据；游客与登录呈现一致。
- [x] 公共 DTO 只含 `posterRef`，不含 TMDB ID、API Key、上游 URL、标题匹配内部键。
- [x] 标题外发只发生在服务端补全任务；不在公共读路径。
- [x] 迁移可逆；旧数据不改写；无硬删除既有列。