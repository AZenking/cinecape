# 迁移与恢复演练证据(T086 · 0007_online_vod)

**Feature**: 010-online-vod · **Task**: T086(Phase 8 证据任务;依赖 T084 ✓ / T014 ✓)
**执行时间**: 2026-10-31 13:08–13:17 +08:00(本文 UTC 时刻均来自执行时 `date -u` 实采;+08:00 = UTC+8)
**执行环境**: macOS 27.2(Build 26B123)· arm64(Apple Silicon)· Node v24.19.0 · pnpm 11.28.5 · tsx 4.23.15 · better-sqlite3 13.0.3
**说明**: 本轮工作区未 commit,git 历史不可用;本文全部结论以**本会话 fresh 执行**为准(命令+退出码+输出均实采)。T014/T081 期间的多轮 `migration:drill` 历史记录与本轮 fresh 结果一致,仅作旁证引用。

---

## 0. 结论矩阵

| # | 演练项 | 结果 | 关键证据 |
|---|--------|------|----------|
| 1 | 隔离旧业务副本升级(0006 形态+旧行 → CLI up 0007 → 逐值核对 → down → 还原核对 → 再 up) | ✅ 通过 | rigA:up/down/up 全部 exit 0;既有列快照逐值一致(up 前=up 后=down 后=再 up 后);回填 B1~B7 全 0 异常 |
| 2 | 空库 up→down→up(CLI migration:up/down 三连)+ drill 一次 | ✅ 通过 | rigB:三连全 exit 0,终态 7 条迁移已应用/44 表/uv=2;rigB2:`migration:drill` exit 0,`drill 通过` |
| 3 | 非空在线业务 down 拒绝(exit 1+稳定消息+字节级不变) | ✅ 通过 | rigC:exit 1,稳定守卫消息;hmp.db sha256 前后一致(`d95eb1b6…`),表/行/迁移记录原样 |
| 4 | 升级前备份 + 匹配镜像恢复(migrate.ts pre-up 备份语义) | ✅ 通过 | rigD:up 前自动 `VACUUM INTO` 备份与升级前状态逻辑等价;在线足迹使 down 被拒(exit 1)后以备份镜像恢复,恢复后状态与升级前逐值一致 |
| 5 | 旧 session/grant/intent 不复活 + 账号/历史/NAS/IPTV/EPG 摘要保留 | ✅ 通过 | rigA/rigD:旧 session 保留且 `playback_started_at` NULL/`cleanup_state='pending'`;过期 grant 未续命;intent/slot/binding/next_plan/receipt/observation 全 0 行;历史 completed=0 且 continuity/evidence NULL |
| 6 | 用户库零触碰(apps/server/data) | ✅ 确认 | 演练前后 shasum/size/mtime/目录清单逐项一致(§7) |
| 7 | 既有测试套件 fresh 复跑(旁证) | ✅ 通过 | `online-vod-migration.e2e-spec.ts`(21)+ `migration-0006.spec.ts`(20)= 41 passed(§6) |

「未执行」项:**无**。任务要求的六个演练面(§1~§5+§7)全部在隔离副本上真实执行;未在当前用户库执行任何演练(禁令遵守,见 §7)。

---

## 1. 方法与环境形态

### 1.1 隔离声明

- 全部演练在系统临时目录 `/tmp/t086-migration-recovery-59Cm6B/`(mktemp 生成,演练后已清理,见 §8)内进行;每个场景独立 rig 目录,`DATA_DIR` 环境变量显式指向该目录,数据库文件名用默认 `hmp.db`。
- CLI 一律从 `apps/server/` 执行 `pnpm migration:<up|down|drill>`(= `tsx src/platform/database/migrate.ts <cmd>`);`migrate.ts` 输出的 `命令=<command> 数据库=<path>` 行证明每次实际打开的库路径均在 `/tmp/.../rigs/<rig>/` 下,无一次指向 `apps/server/data`。
- `apps/server/.env` 未设置 `DATA_DIR`(演练前已核验),进程环境变量优先,CLI 不可能回落到用户库。

### 1.2 「旧业务副本」构造方法

0006 形态库用**直驱 SQL** 构造(临时脚本 `build-old-copy.mjs`,不入仓库):以 better-sqlite3 打开空文件,按 `migrate.ts applyUp` 的同语义逐个执行仓库内 `0001_init`~`0006_pc_experience` 的 `up.sql`(事务外 `foreign_keys=OFF` → 事务内 exec+写 `_migrations` → `ON` → `foreign_key_check` 复核),再直写 SQL 种入旧行(写法与 21/21 全绿的 `test/contract/online-vod-migration.e2e-spec.ts` `injectStage6` 同源,并按任务要求补 NAS 源、EPG 频道/排期、刷新任务、手工绑定、进度状态与**已过期** settings grant):

| 种子面 | 行数 | 内容摘要 |
|--------|------|----------|
| 账号/身份 | household 1,account 1(owner),profile 2(adult 主档 + child),device 1,device_session 1 | 家庭「T086隔离家庭甲」 |
| 来源 | media_source 3 行:kind=epg / kind=iptv(挂 epg_source_id)/ **kind=nas**(root_key+relative_directory) | NAS/IPTV 摘要保留核对载体 |
| EPG | epg_channel 1,epg_programme 1,manual_epg_binding 1(manual) | 12-step 重建中经 temp 暂存/清空/回填的表 |
| 目录 | media_item 2(channel),source_entry 1(tvg_id),playback_source 1(http 静态定位器),catalog_state 1 | 静态 locator/角色回填载体 |
| 刷新 | source_refresh 1(succeeded),media_source.last_job_id 已回连 | up 中「先断 last_job_id 边再精确还原」路径载体 |
| 播放/个人 | playback_session 1(preparing),playback_progress_state 1,profile_progress_clock 1,profile_viewing_history 1(position 12.5/duration 100/revision 1) | 历史/ledger 回填载体 |
| 授权 | settings_access_grant 1(**issued 2026-10-30T08:00Z / expires 2026-10-30T08:15Z,已过期**) | 「grant 不复活」核对载体 |

构造后基线(rigA 与 rigD 同法独立构造):`user_version=2`、`_migrations` 恰为 0001~0006、27 表、`integrity_check=ok`、`foreign_key_check` 空 —— 即 precheck 判定矩阵中的 `generation2-vod-rolled-back` 形态,门禁允许 CLI 重新 up 0007。

### 1.3 核对方法

- **既有列逐值快照**:对 12 张既有表的「0007 不许改值列清单」(对齐 T007 spec `LEGACY_SNAPSHOT_COLUMNS`)做 `SELECT … ORDER BY rowid` 全行快照,up/down/再 up 前后 JSON 逐字节比对。
- **回填 7 项(B1~B7)**:升级后以只读 SQL 断言异常计数=0:
  | 项 | 断言 | up.sql 锚点 |
  |----|------|-------------|
  | B1 | `media_item` 无 `media_role<>'standalone'` 行(DEFAULT 回填) | up.sql:581-585 |
  | B2 | `playback_source` 无 `locator_kind<>'static'` 或 `vod_episode_id` 非空行(旧静态定位器回填 static) | up.sql:866-872 |
  | B3 | `media_source` 无 `locator_revision<>1` 行(既有行回填 1) | up.sql:734-742 |
  | B4 | `profile_viewing_history` 无 `completed<>0` 行(旧静态历史默认 false) | up.sql:642-645 |
  | B5 | 历史行 `continuity_revision/evidence_state/evidence_digest` 全 NULL(旧记录不冒充在线 continuity 证据) | up.sql:630-641 |
  | B6 | `playback_progress_state` 无 `continuity_revision<>1 OR session_started<>0 OR ledger_* 非空` 行(ledger 扩展列默认值) | up.sql:606-628 |
  | B7 | `playback_session` 无 `playback_started_at` 非空 / `cleanup_requested<>0` / `cleanup_reason` 非空 / `cleanup_state<>'pending'` 行 | up.sql:587-599 |
- **不复活面**:升级/恢复后核对 `playback_transition_intent`、`playback_transition_slot`、`playback_input_binding`、`playback_next_plan`、`playback_finish_receipt`、`playback_phase_observation` 行数=0(不凭空造行);`_migrations` 恰为目录全量、无重复;17 张 vod 新表在纯旧数据副本上全 0 行。
- **完整性**:每步 `PRAGMA integrity_check`=`ok` 且 `foreign_key_check` 空。

---

## 2. 项 1:隔离旧业务副本升级 → 核对 → down → 还原核对 → 再 up(rigA)

命令形态(每次均记录 `date -u` 起止与退出码):

```bash
cd apps/server
DATA_DIR=/tmp/t086-migration-recovery-59Cm6B/rigs/rigA pnpm migration:up     # ① 升级
DATA_DIR=/tmp/t086-migration-recovery-59Cm6B/rigs/rigA pnpm migration:down   # ③ 回滚
DATA_DIR=/tmp/t086-migration-recovery-59Cm6B/rigs/rigA pnpm migration:up     # ⑤ 再升级
```

| 步 | UTC 时刻 | 命令 | exit | 关键输出 |
|----|----------|------|------|----------|
| ① up | 05:08:36Z | `migration:up` | 0 | `预检通过(generation2-vod-rolled-back)…可重新应用 0007_online_vod` → `已应用 0007_online_vod` → `完成:共 1 条(备份: hmp.db.bak-1793423316537)` |
| ② 核对 | 05:08:58Z | check-after-up + 快照 diff | 0 | B1~B7 全 0;44 表;17 张 vod 新表全 0 行;`integrity_check=ok`;**既有列快照与升级前逐值一致(YES)** |
| ③ down | 05:09:09→05:09:10Z | `migration:down` | 0 | `预检通过(generation2-ready)` → `已回滚 0007_online_vod`(旧数据无在线足迹,守卫放行)→ `完成(备份: hmp.db.bak-1793423350355)` |
| ④ 还原核对 | 05:09:17Z | 快照 diff | — | `user_version=2`、`_migrations` 恰为 0001~0006、27 表、17 张 vod 表 **ABSENT**;**既有列快照与最初逐值一致(YES)**;NAS/IPTV/EPG 源行数 1/1/1 |
| ⑤ 再 up | 05:09:24→05:09:25Z | `migration:up` | 0 | `预检通过(generation2-vod-rolled-back)` → `已应用 0007_online_vod`(备份 hmp.db.bak-1793423365157) |
| ⑥ 终核 | 05:09:25Z | check-after-up + 快照 diff | 0 | B1~B7 再次全 0;44 表;`applied` 末位 `0007_online_vod`;**既有列快照与最初逐值一致(YES)** |

**断言要点**:① 升级零数据丢失(12 张既有表逐值不变,含 NAS/IPTV/EPG 摘要、历史 position/duration、source_refresh 互引用还原);② 回填 7 项全部按 data-model §8 落位;③ down 是对称等价回滚(27 表原样恢复、0007 对象全部消失、既有值不动);④ 再升级幂等(结果与①一致)。方法备注:①③⑤ 的 0007 up/down 全部由 CLI 驱动;0001~0006 基座为 §1.2 直驱 SQL(理由:空库 CLI up 会一次应用全部 7 条,无法停在 0006 形态)。

---

## 3. 项 2:空库 up→down→up 三连 + drill(rigB / rigB2)

```bash
cd apps/server
DATA_DIR=/tmp/t086-migration-recovery-59Cm6B/rigs/rigB  pnpm migration:up     # 05:09:39Z exit 0
DATA_DIR=/tmp/t086-migration-recovery-59Cm6B/rigs/rigB  pnpm migration:down   # 05:09:39→40Z exit 0
DATA_DIR=/tmp/t086-migration-recovery-59Cm6B/rigs/rigB  pnpm migration:up     # 05:09:40Z exit 0
DATA_DIR=/tmp/t086-migration-recovery-59Cm6B/rigs/rigB2 pnpm migration:drill  # 05:09:46→47Z exit 0
```

- 三连输出:`fresh-empty` → 逐条 `已应用 0001…0007`(`完成:共 7 条`);`generation2-ready` → `已回滚 0007_online_vod`;`generation2-vod-rolled-back` → `已应用 0007_online_vod`。代际标记全程 `user_version=2`(0007 与 0006 同属交付代际 2,down 亦还原 2)。
- rigB 终态断言(exit 0):`_migrations` 恰为目录全量 7 条、44 表(含 `_migrations`;与 migrate.ts `EXPECTED_TABLES` 一致)、B1~B7 断言通过、integrity/FK 干净。
- rigB2 `migration:drill` 一次通过:输出 `drill 通过:已应用 [0001_init, …, 0007_online_vod],表 [household, …, _migrations] 全部存在`(44 表逐一列出)。

---

## 4. 项 3:非空在线业务 down 拒绝(rigC)

```bash
cd apps/server
DATA_DIR=…/rigs/rigC pnpm migration:up                    # 05:10:40Z exit 0(空库全 7 条)
node seed-vod.mjs …/rigC/hmp.db                           # 05:10:41Z 种在线足迹
shasum -a 256 …/rigC/hmp.db                               # sha256(before)
DATA_DIR=…/rigs/rigC pnpm migration:down                  # 05:10:52→53Z
```

- 在线足迹:`media_source(kind='vod')` 1 行 + `vod_source_config` 1 行(adapter='apple-cms-json')+ `profile_vod_preferences` 1 行 —— 恰好同时命中守卫的「守卫表非空」与「既有表在线足迹」两类判据。
- **down 结果**:exit **1**;稳定错误消息(逐字):

  > `[down] 在线点播业务数据非空,拒绝破坏性回滚 0007_online_vod(vod_source_config=1, profile_vod_preferences=1, media_source(kind=vod)=1);正式回滚请使用升级前一致备份+匹配镜像(010 data-model §8),临时空库方可 down 演练`

- **字节级不变**:sha256 `d95eb1b626cb072f1c3b0757803f70553e4cfa1d06a5f6c75eadb2570f26fe1b`(size 675840)拒绝前后完全一致;状态摘要逐项一致(`_migrations` 7 条、44 表、vod 行 1/1 原样)。守卫在应用 down.sql **之前**抛错(migrate.ts `assertDownAllowed`,L542-568),未删表未删列。
- 如实记录:CLI down 每次先做 `VACUUM INTO` 备份再评估守卫(migrate.ts L586),故拒绝时目录新增了兄弟备份文件 `hmp.db.bak-1793423453089`;库文件本身字节未动。

---

## 5. 项 4+5:升级前备份 + 匹配镜像恢复 + 恢复后不复活(rigD)

**机制**(migrate.ts,`cmdUp`/`cmdDown` 首行 `createBackup`,L446-457):任何 up/down 前先 `VACUUM INTO '<db>.bak-<Date.now()>'` 生成一致性快照(WAL 下即已检查点的完整镜像);正式回滚路径 = 升级前一致备份 + 匹配镜像(down 被守卫拒绝时,这是 data-model §8 指定的唯一回滚方式)。

执行序列(全部实采):

| 步 | UTC 时刻 | 动作 | 结果 |
|----|----------|------|------|
| 1 | 05:11:51Z | 构造旧业务副本(同 §1.2),sha256 `e7f4c2de…`,快照 D0 | 27 表/6 条迁移/uv=2 |
| 2 | 05:11:51Z | `migration:up` → **自动产出升级前备份 `hmp.db.bak-1793423511586`**,exit 0 | 0007 已应用 |
| 3 | 05:12:01Z | 只读核对备份:与 D0 **legacy+state 逐项一致**(`legacy-identical=true`、`state-identical=true`;含 27 表/6 条记录/uv=2) | 备份=升级前一致快照 |
| 4 | 05:12:01Z | 种在线足迹 → `migration:down` | exit **1**,守卫拒绝(同 §4 消息)→ 演练「down 不可用」的生产形态 |
| 5 | 05:12:13Z | **匹配镜像恢复**:`cp hmp.db.bak-1793423511586 hmp.db && rm -f hmp.db-wal hmp.db-shm` | 恢复后 sha256 `f40094b7…` == 备份文件 sha256(逐字节一致) |
| 6 | 05:12:13Z | 只读核对恢复库:与 D0 `legacy-identical=true`、`state-identical=true`(27 表/6 条/uv=2/17 张 vod 表 ABSENT/`integrity_check=ok`) | 回到升级前一致状态 |
| 7 | 05:12:22Z | `migration:up`(门禁判定 `generation2-vod-rolled-back`,允许重新升级),exit 0 | 0007 重新应用(新备份 bak-1793423542881) |
| 8 | 05:12:22Z | 恢复→再升级后不复活核对(check-after-up,exit 0) | 见下 |

**恢复后再升级的不复活/保留断言**(逐项实测值):

- 旧 session(1 行)保留且不被起播/清理污染:`playback_started_at=NULL`、`cleanup_requested=0`、`cleanup_reason=NULL`、`cleanup_state='pending'`(B7=0);
- 过期 grant 保留且未续命:`issued_at=2026-10-30T08:00:00.000Z`、`expires_at=2026-10-30T08:15:00.000Z`(早于当前时刻,仍为过期,未复活任何设置权限);
- 观看历史保留且不冒充在线证据:`completed=0`、`continuity_revision/evidence_state/evidence_digest=NULL`、`position_seconds=12.5`、`duration_seconds=100`、`revision=1`;
- 意图/槽/固定输入/计划/回执/观测 6 面:**0 行**(恢复不伪造任何在途播放状态);`_migrations` 恰 7 条无重复;B1~B7 全 0;44 表;`foreign_key_check` 空。

如实标注:① `VACUUM INTO` 备份是**逻辑等价**快照(VACUUM 重建页布局),与升级前库「逐值一致」但**不承诺字节一致**;镜像恢复用 `cp 备份文件 → 库文件`,故恢复后库与备份文件字节一致(sha256 相同)。② 备份内含幂等表/历史等业务数据的**保密控制**按 data-model §8 执行:本轮 rigD 升级前本无 vod 业务数据,备份不涉及私有定位器;全部备份仅存在于 `/tmp` 隔离 rig 目录并随 §8 清理销毁。

---

## 6. 既有证据源的 fresh 复跑(旁证)

- `2026-10-31T05:12:32Z → 05:12:36Z`,`apps/server` 内执行:
  `pnpm vitest run test/contract/online-vod-migration.e2e-spec.ts test/unit/migration-0006.spec.ts`
  → **Test Files 2 passed, Tests 41 passed(41),exit 0**(`online-vod-migration.e2e-spec.ts` 21 用例 + `migration-0006.spec.ts` 20 用例),全部使用 `os.tmpdir()` 隔离 rig(输出可见 `/var/folders/.../T/hmp-0006-ready-*/…hmp.db` 路径)。
- 历史旁证:T014/T081 期间多轮 `migration:drill`(隔离副本 up→down→up、44 表、非空在线 down 拒绝)与本轮 fresh 结果一致;因工作区未 commit 无 git 哈希可引,以本文 fresh 执行为权威。

## 7. 用户库零触碰声明

- 演练前(05:08:05Z)与演练后(05:12:42Z)对 `apps/server/data` 取证:`hmp.db` sha256 **`3214dc4168f87106c31595aaf88f4f9950bf527e6aa72a120f85cef0bb3ab6c6`**、size **18079744**、mtime **2026-10-30T12:16:35Z** 前后完全一致;目录 26 项文件清单(名称+大小)逐项一致。
- 全部 CLI 输出的 `数据库=` 行均指向 `/tmp/t086-migration-recovery-59Cm6B/rigs/<rig>/hmp.db`;**未在当前用户库执行任何演练**,未向 `apps/server/data` 写入或删除任何文件。

## 8. 可复现性与清理

- 复现路径:按 §1.2 造副本 → §2/§3/§4/§5 命令逐条执行(把 `/tmp/t086-migration-recovery-59Cm6B` 换成新的 `mktemp -d` 目录即可);核对脚本逻辑已在上文完整描述(B1~B7 断言 SQL、快照列清单、恢复步骤),不依赖仓库外产物。
- 清理(2026-10-31T05:16:31Z 执行,`rm -rf /tmp/t086-migration-recovery-59Cm6B` 前确认目标路径为该 mktemp 目录):rigA/rigB/rigB2/rigC/rigD 全部副本、`*.bak-*` 备份与工具脚本一并销毁(复核:目录已不存在);仓库内本任务**仅新增本文档**,未改任何代码/测试/迁移文件。
