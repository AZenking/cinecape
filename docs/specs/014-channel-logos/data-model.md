# Data Model: 014-channel-logos

日期：2026-11-07。Proposed 设计；列/约束以迁移 `0009_channel_logos` 为准，实施以 tasks 冻结版为准。

## 0. 变更总览

| 对象 | 变更 | 性质 |
| --- | --- | --- |
| `source_entry` | +`logo_url TEXT NULL` | 列增补（IPTV 原始 Logo 地址，私有） |
| `epg_channel` | +`icon_url TEXT NULL` | 列增补（XMLTV 频道图标原始地址，私有） |
| `channel_logo`（新表） | — | 胜者注册表（media-catalog 域） |
| `media_item.poster_ref` | 复用，无结构变更 | 承载引用值；导入发布开始写值（此前恒 NULL） |

不变：`epg_programme`、`manual_epg_binding`、全部播放/个人/策略表；`refreshStageEntry` 载荷内新增 logo 字段（列内 JSON 载荷，无 DDL）。

## 1. 列定义与约束

### source_entry.logo_url

```text
logo_url TEXT NULL
CHECK (logo_url IS NULL OR (logo_url LIKE 'http://%' OR logo_url LIKE 'https://%')
       AND length(logo_url) BETWEEN 9 AND 2048)
```

- 写入方：IPTV 刷新发布（同事务写 source_entry 其余列）。
- 语义：本条目当前源里的原始 Logo 地址；解析层归一化产物（research R1），非法→NULL。
- 隐私：私有载荷，任何公共 DTO/投影不得输出本列。

### epg_channel.icon_url

```text
icon_url TEXT NULL
CHECK (同上形态)
```

- 写入方：XMLTV 刷新发布（epg_channel upsert 同事务）。
- 语义：该 XMLTV 频道首个 `<icon src>` 归一化产物；同上私有。

## 2. channel_logo（胜者注册表）

```text
channel_logo
  household_id TEXT NOT NULL  FK -> household.id（复合，显式家庭边界）
  media_id     TEXT NOT NULL  FK -> media_item(household_id, id) ON DELETE CASCADE
  ref          TEXT NOT NULL  -- 随机 128-bit 不透明令牌（如 32 字符 base64url/hex）
  upstream_url TEXT NULL      -- 私有上游地址；墓碑态必须为 NULL
  source_kind  TEXT NOT NULL  CHECK (source_kind IN ('iptv','epg'))
  source_id    TEXT NOT NULL  FK -> media_source(household_id, id)（来源证据）
  revision     INTEGER NOT NULL CHECK (revision >= 1)  -- 每次胜者内容变更 +1
  revoked_at   TEXT NULL      -- 墓碑时间（ISO-8601）；NULL=active
  created_at   TEXT NOT NULL
  updated_at   TEXT NOT NULL

UNIQUE (household_id, media_id)      -- 每频道至多一行（active 或墓碑）
UNIQUE (household_id, ref)           -- 引用家内唯一；解析按 ref 单查
CHECK (revoked_at IS NULL OR upstream_url IS NULL)  -- 墓碑不留地址
```

要点：
- `(household_id, media_id)` 唯一 ⇒ 墓碑占用该频道唯一行位，新胜者以**同行覆盖**方式写回（清 revoked_at、换 ref/url、revision+1）。
- `ON DELETE CASCADE`：频道媒体删除（源移除）时行消失，旧引用直接 404 同形——频道已不存在，无需「已失效」区分。
- 查询面：解析按 `(household_id, ref)` 索引单查；发布按 `(household_id, media_id)` 集合读写。查询次数不随频道数线性增长（对齐 live-projection 既有集合查询纪律）。

## 3. media_item.poster_ref 承载

- 值域变化：NULL（无 Logo，现状）→ 引用值（channel_logo.ref 原样）。
- 写入方：仅发布事务（sources/epg 参与者经 media-catalog 镜像方法）；人工不直接改。
- 一致性：引用值必须能在 channel_logo 解析到 active 行；发布事务保证同库同事务写入，无跨库窗口。
- 下游投影（零改动）：live.controller（`ChannelRowDto.posterRef`）、media-catalog `PublicMedia.posterRef`、favorites/个人区列表——照现有 select 透传。

## 4. 胜者合并规则（FR-003/R5 的存储视角）

判定输入：`source_entry.logo_url`（iptv 证据）、`epg_channel.icon_url`（epg 证据）、当前 channel_logo 行（source_kind/revoked 状态）。

| # | 场景 | 结果行 |
| --- | --- | --- |
| M1 | IPTV 发布：条目有 logo_url | active(iptv)；url 变化 ⇒ 旧行转墓碑后同行写新胜者（新 ref，revision+1） |
| M2 | IPTV 发布：条目无 logo_url 且当前 active(iptv) | 转墓碑；随后按 M3 逻辑尝试 epg 填补（同事务） |
| M3 | EPG 发布：频道已绑定且 icon_url 非空，且（无行 或 active(epg) 或 墓碑） | 写/复 active(epg)；已有同 url active(epg) ⇒ 无操作 |
| M4 | EPG 发布：icon_url 为空/绑定失效，且 active(epg) | 转墓碑 |
| — | 任何场景：当前 active(iptv) 且非 IPTV 发布 | 不动（epg 绝不覆盖 iptv） |

墓碑窗口：`revoked_at` ≤ now−7d 的行在任一发布事务内集合 DELETE（无后台任务）。

## 5. 生命周期状态机

```text
absent ──(M1/M3 写胜者)──> active(ref R1, rev n)
active ──(M1 换url/M2/M4 撤销)──> tombstone(ref R1, url=NULL, revoked_at=t)
tombstone ──(M1/M3 同行写新胜者)──> active(ref R2, rev n+1)
tombstone ──(发布事务 GC: revoked_at ≤ now−7d)──> (行删除; 引用 R1 此后 404 同形)
active ──(频道 media 删除, CASCADE)──> (行删除; 引用此后 404 同形)
```

解析面结果映射（详见 contracts/api.md）：
`(household_id, ref)` 命中 active → 200 取回；命中墓碑 → 410；未命中（未签发/伪造/跨家庭/GC 后）→ 404 同形。

## 6. 引用生成

- 形态：随机 128-bit，`crypto.randomBytes(16)` → 32 字符小写 hex（对齐项目「sha256 截断/十六进制」既有习惯，如 programme key）。
- 非确定性派生（不用 URL/HMAC）：避免泄漏上游结构，撤销即失效不依赖密钥。
- 同频道重复发布同一 URL（M3 无操作路径）不换 ref——保住浏览器缓存与 ref 稳定性（revision 不变）。

## 7. 迁移 0009_channel_logos

- up.sql：`ALTER TABLE source_entry ADD COLUMN logo_url ...`（含 CHECK，SQLite 以表重建或逐列 ADD + 命名 CHECK 依执行器约束，实施按既有迁移风格）；`ALTER TABLE epg_channel ADD COLUMN icon_url ...`；`CREATE TABLE channel_logo ...` + 索引。
- down.sql：逆序 DROP TABLE/DROP COLUMN。
- 零回填；迁移后系统行为与现状完全一致（poster_ref 全 NULL），Logo 下次刷新出现。
- 门禁：`migration:drill`（up→down→up 全应用）+ `VACUUM INTO` 备份 + 含新列数据的匹配版本备份恢复演练（宪章技术约束 3）。

## 8. 数据边界核验清单（宪章原则二/四）

- [x] channel_logo/两列均含或归属显式 household_id 边界（source_entry/epg_channel 本就在家庭复合键内）。
- [x] 引用解析以请求作用域家庭为准（PublicContextService），不信任客户端传递家庭。
- [x] 无 profile 维度、无个人数据；游客与登录呈现一致（ADR-0010）。
- [x] 上游 URL 仅存在于 server 私有列与发布事务内存；不进任何公共 DTO、日志、缓存键。
