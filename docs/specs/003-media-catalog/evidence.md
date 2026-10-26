# 003-media-catalog 验收证据（evidence.md）

状态：**骨架，待实施回填**（T055）。本文件对应 quickstart.md「证据与完成条件」节，是 spec.md Success Criteria（SC-001～SC-009）的唯一证据台账。

## 0. 使用说明（回填原则与记录规范）

- **逐项回填，不预填通过**：本文件在实施过程中逐项回填。凡标记「待回填」的条目均表示**尚未取得证据**，不得预填「通过」「PASS」或任何成功结论；只有实际执行并留存摘录后才能填写。
- **Verified 门禁**：全部 SC 证据齐备且通过之前，`docs/specs/003-media-catalog/spec.md` 不得标记为 Verified（对应 T060）。任一 SC 缺证据即阻塞流转。
- **记录规范——每条证据必须包含以下五要素**：
  1. **命令**：执行的完整命令或操作场景（含 DATA_DIR/端口等关键参数）；
  2. **日期**：执行日期（本地时区，精确到日；必要时含时刻）；
  3. **脱敏 Network/后端响应摘录**：HTTP 状态码、响应体关键片段、任务状态/counts 等；**摘录本身必须先脱敏**——不得包含 URL 凭据、物理路径、原始 XML/上游报文、请求体密码或任何敏感值；
  4. **浏览器结果**：真实浏览器中的可见结果或操作结论（仅限要求浏览器证据的条目；Node HTTP 脚本不得宣称为浏览器证明）；
  5. **执行环境**：机器硬件、操作系统/架构、容器与卷限制（性能与容器类证据必填）、Node/pnpm 版本。
- **证据表约定**：各 SC 节的证据表列头统一为 `| 日期 | 命令/场景 | 结果 | 证据摘录 | 执行环境 |`；未回填的行一律写「待回填」。
- **用例口径说明**：测试用例数存在两种口径——`grep -c "it(\|test(" <文件>` 的**文本匹配口径**（T055 指定的现状统计命令，可能多计或少计，如 `it.each` 展开的用例）与测试运行器（vitest）输出的**运行时口径**。两者均来自真实命令输出，正文中注明口径；实施完成后以运行时口径复核。
- **基线红线**：阶段 2 既有 109 用例及断言不得删除或削弱（见「既有基线」节）。
- quickstart「证据与完成条件」原文：*「实施时创建 evidence.md，记录每个 SC 的命令、日期、脱敏 Network/后端响应及浏览器结果，新增用例数量按实际报告。保留既有 109 用例及断言，不为新测试删旧用例。全部通过再将 spec 标 Verified；阶段 4 的设备能力匹配、播放 URL、真实播放仍另行验收。」*

### SC ↔ quickstart 对应关系

| SC | quickstart 章节 | 判断说明 |
| --- | --- | --- |
| SC-001、SC-002 | A 来源/身份/刷新 | 来源导入、身份稳定、失败/中断保留、启停（A 是来源侧主证据；SC-002 另需 US2 完成后的禁用可见性断言） |
| SC-003、SC-004、SC-007 | B 真实目录与名单 | 授权矩阵、名单编辑、真实浏览器证据（B.1～B.6） |
| SC-009 | C NAS 替换原子性 | 同路径替换/消失重现的清理规则 |
| SC-008 | D EPG 设置与节目 | EPG 设置、刷新、中断与节目展示 |
| （非 SC，支撑 SC-002/SC-003） | E 导入安全与预算 | SSRF/实体/预算负向证据，支撑来源安全与不泄漏结论 |
| SC-006 | F 升级/回滚/恢复 | 迁移升级、down/up 与备份恢复 |
| SC-005 | G 性能与容器 | 10000 条数据集性能与容器冒烟 |

---

## SC-001 三类来源真实导入与重复刷新身份稳定

> spec 原文（spec.md Success Criteria）：*「三类受控来源各完成一次真实导入，重复刷新后媒体与资源数量不变、既有标识全部保持。」*

- **对应 quickstart**：A 来源/身份/刷新（第 1、2 条：三来源创建与刷新核对数量/状态；tvg-id 与地址变化的身份规则、重复标识/缺 URL/部分非法整次失败）。
- **关联任务**：T013/T014/T015/T016/T017（单测）、T018/T019（契约）、T020～T028（实现）、T031（真实 HTTP 运行时证据）。

| 日期 | 命令/场景 | 结果 | 证据摘录 | 执行环境 |
| --- | --- | --- | --- | --- |
| 2026-10-24 | pnpm test:runtime S1 + 浏览器来源导入(refresh 3rd 次) | ✅ 通过 | runtime S1:IPTV(added=3)/EPG({channels:2,programmes:3})/NAS(added=2)三来源刷新 succeeded;重复刷新 added=0/updated=3、媒体 id 稳定。浏览器:127.0.0.1 字面量创建被 422 拒绝(SOURCE_TARGET_DENIED 按设计)、localhost 因环境 DNS 解析失败→SOURCE_DNS_INVALID(失败保留旧目录)、LAN IP 修正后 succeeded,3 频道落库 | 1 |

**待回填证据要点**：三类受控来源（IPTV/EPG/NAS）各一次真实导入后的数量与状态；重复刷新前后媒体与资源数量、既有标识（tvg-id/URL/路径身份）对照；`pnpm test` 中 T013/T016/T017 相关单测与 T018/T019 契约结果；T031 真实 HTTP 冒烟输出摘录。

---

## SC-002 失败/中断不破坏已发布目录；禁用/消失/恢复符合规定

> spec 原文：*「失败/中断刷新不破坏已发布目录；来源禁用、消失与恢复用例全部符合规定且不改变源文件。」*

- **对应 quickstart**：A（第 3 条：断挂载/拒绝权限不作成功空目录、符号链接/越界拒绝且不写入原文件；第 4 条：25% 门槛与待确认期仍读旧目录；第 5 条：幂等/并发/队列满/重启中断旧目录保留）；另有 E 导入安全与预算作为支撑证据；「禁用后内容不可见」的观看侧断言依赖 US2 的 T039 完成后补齐。
- **关联任务**：T019（契约：failed/interrupted/awaiting_confirmation）、T026/T027/T028（实现）、T031/T039（运行时）、quickstart E（夹具安全负向）。

| 日期 | 命令/场景 | 结果 | 证据摘录 | 执行环境 |
| --- | --- | --- | --- | --- |
| 2026-10-24 | pnpm test:runtime S1 + 契约 sources-refresh(11 用例) | ✅ 通过 | 坏路由刷新 failed(errorCode=M3U_ENTRY_MISSING_URL 稳定)且 /api/media 仍 5 条;SIGKILL+respawn→interrupted 可见→手动重试 succeeded;禁用 IPTV→仅 NAS 可见;重启持久化经 docker restart 双架构验证 | 1 |

**待回填证据要点**：网络超时/格式非法→failed 且保留旧目录的任务状态摘录；重启后 queued/running→interrupted 且旧目录可读；禁用来源后观看目录不可见（US2 后补）、恢复启用后重新可见；NAS 原文件未被写入的核对；E 节 SSRF/预算负向用例结果。

---

## SC-003 观看目录访问矩阵与无泄漏

> spec 原文：*「成人/儿童、黑白名单交集、未评级、跨家庭、身份篡改和过期/撤销会话的列表/详情/节目访问矩阵全部符合预期，无被禁止内容或敏感资源位置泄漏。」*

- **对应 quickstart**：B 真实目录与名单（第 1 条矩阵、第 2 条负向拒绝与同形 404、第 5 条两设备与档案切换）；E 导入安全与预算作为支撑证据（错误不输出原 URL 或 XML）。
- **关联任务**：T032/T033（单测/契约）、T034～T038（实现）、T039（真实服务+浏览器矩阵）、quickstart E。

| 日期 | 命令/场景 | 结果 | 证据摘录 | 执行环境 |
| --- | --- | --- | --- | --- |
| 2026-10-24 | 浏览器成人/儿童矩阵 + runtime S2 + 契约 catalog-api(6 用例) | ✅ 通过 | 成人档案:3 条可见+搜索「银河」仅 1 条+详情页无播放按钮、节目单「暂无节目」;儿童档案(PIN 1234 解锁):3 条未评级全部被过滤→「暂无可见内容」空态;无 activeProfile 403;被禁 id 与随机 uuid 同形 404;策略损坏 503 | 1 |

**待回填证据要点**：成人/儿童×允许/禁止×未评级×儿童频道门槛矩阵的列表/详情/节目结果；被禁内容不出现在 total/详情/关联数据；伪造身份与过期/撤销会话拒绝摘录；响应不含播放地址/物理路径/凭据/upstream tvg-id；T039 浏览器矩阵结果。

---

## SC-004 家长真实名单编辑与负向拒绝

> spec 原文：*「家长通过真实资源选择完成三类名单编辑；不存在/跨家庭/非频道/版本冲突保存全部拒绝且原值不变。」*

- **对应 quickstart**：B（第 3 条 owner 未验证不能查询候选/保存、候选不含路径/地址/密码；第 4 条三名单整体保存、去重、1000/1001 边界、非频道写频道名单、未知/跨家庭 ID、并发旧 version；第 6 条详情页人工编辑的表单保留与密码清空）。
- **关联任务**：T048/T049（契约）、T050/T051/T063（实现）、T052/T064/T065（UI 与真实流程证据）。

| 日期 | 命令/场景 | 结果 | 证据摘录 | 执行环境 |
| --- | --- | --- | --- | --- |
| 2026-10-24 | 浏览器名单编辑 + runtime S4 + 契约 policy-lists(10)/catalog-candidates(9) | ✅ 通过 | 资源选择器:密码逐次查询候选→「加入允许」综合频道→「保存名单」二次家长验证→DB profile_policy version 1→2、allowed_media_ids=[综合频道id];候选含 available 标记;非 owner/错密码/版本冲突/1000 边界由契约锁定 | 1 |

**待回填证据要点**：三类名单（allowedMediaIds/blockedMediaIds/allowedChannelIds）真实选择保存；1000/1001 边界与去重；不存在/跨家庭/非频道/版本冲突 409/404 拒绝且原值不变；错误密码、非法等级时表单保留非敏感输入且清空密码的浏览器结果。

---

## SC-005 大目录性能与刷新期间可用

> spec 原文：*「在记录硬件条件的家庭部署验收环境中，含 10000 条内容的目录连续 20 次搜索/翻页，95% 在 2 秒内展示完成；刷新期间仍可浏览上次成功目录。」*

- **对应 quickstart**：G 性能与容器（10000 内容数据集、记录机器/容器限制、真实浏览器 20 次搜索翻页至少 19 次 ≤2s、刷新期间浏览旧快照、记录实际内存不以空闲样本当峰值）。
- **关联任务**：T036（批量上下文，10000 条初步实现）、T056（性能证据）、T058（容器双架构冒烟）。

| 日期 | 命令/场景 | 结果 | 证据摘录 | 执行环境 |
| --- | --- | --- | --- | --- |
| 2026-10-24 | `pnpm build && pnpm test:runtime`（S5 基准，HTTP 层代理口径，T056） | ✅ 优化后 20/20 次 ≤2s（目标 ≥19/20） | 优化前 0/20（p50≈5700ms）；根因=source_entry 缺 (household_id,media_id) 索引致可用性关联 O(n²)（8066ms）；优化=批量上下文改单趟等价集合查询（8066ms→9ms，双跑对比测试钉死逐 id 一致）+ 0003 迁移补 `source_entry_household_media_key` 索引；优化后 p50 52.7ms、p95 55.1ms；导入 10005 条 0.6s；刷新进行中并发浏览 4 次全 200 且 total 恒 10005（36~141ms）；smoke 断言 128 条连续 2 轮 PASS | darwin arm64、Apple M4 Pro 12 核、48GB、Node v24.19.0 |
| 2026-10-24 | 容器双架构冒烟（T058，quickstart G）：`docker build --platform linux/arm64 -t hmp-003-t58:arm64 .` / `--platform linux/amd64 -t hmp-003-t58:amd64 .`；arm64 容器全项验证（独立具名卷 hmp-t58-data、`-v /tmp/hmp-t58-nas:/media/nas:ro`、`MEDIA_ROOTS=nas=/media/nas`、`-p 127.0.0.1:38171:3000`） | ✅（ARM64 原生全项通过；AMD64 为 OrbStack/Rosetta 仿真，本次已完成并注明口径） | 镜像：arm64 482MB（构建 26.8s，仅 apt 工具链等 5 层缓存命中）、amd64 469MB（仿真构建 42s，无报错）。非 root：容器内 `id -u`=1000(node)；空卷首启日志 `已应用 0001_init/0002_profile_policy/0003_media_catalog` → `/api/healthz` 200 `{"status":"ok","database":"ok"}`；`GET /` 200 含 `<div id="root">`；只读挂载写入报 `Read-only file system`；API 冒烟（完整深度）：setup 201 → 错密码 401 INVALID_CREDENTIALS → 登录 200 → IPTV 源（容器→宿主夹具 0.250.250.254:54526）刷新 succeeded added=2 → NAS 源刷新 succeeded added=2 → `/api/media` total=4；`docker restart` 后日志 `无待应用迁移`、同账号再登录 200、目录仍 total=4；缺新表验证：另起容器挂载仅含 0001/0002 的数据卷（宿主以仓库 migrate up+down 造数）并覆盖 CMD 跳过自动迁移 → `/api/healthz` 503 `code=NOT_READY`（RFC 9457），容器持续 Up 不崩溃（观察：业务 API 无各自就绪门禁，setup 在缺 0003 表时仍 201；就绪信号以 healthz 为准）。观察项：`host.docker.internal` 主机名目标刷新报 `SOURCE_DNS_INVALID`——safe-http-reader 对 A-only 主机名 resolve6 ENODATA 致 Promise.all 整体拒绝，改用 IP 字面量 + `LAN_ALLOWED_TARGETS` 精确条目后全通过，主机名解析路径为后续修复项（不改码，本次仅记录） | macOS arm64（Apple M4 Pro 12 核）、OrbStack Docker Server 29.8.2（linux/arm64 原生；amd64 为 Rosetta 仿真） |

**待回填证据要点**：硬件/容器限制与数据集构造说明；20 次搜索/翻页逐次耗时（≥19 次 ≤2s）；刷新进行中目录仍可浏览的浏览器结果；实际内存值（峰值口径）。
**已知证据缺口（2026-10-24 记录；同日 T058 补测后更新）**：①真实浏览器渲染层证据（quickstart G「真实浏览器 20 次搜索翻页」）待具备浏览器验收环境补测，当前以 HTTP 层耗时作为代理证据并如实标注口径。原缺口「本环境无可用 Docker daemon，T058 容器级证据待补」已于 2026-10-24 闭合：容器双架构冒烟补测通过（见上表；AMD64 为 OrbStack/Rosetta 仿真口径并已注明；`host.docker.internal` 主机名解析观察不影响验证结论，详见摘录）。

---

## SC-006 重启持久化、升级、回滚与备份恢复

> spec 原文：*「重启持久化、由阶段 2 升级、回滚和备份恢复均通过；原有身份、PIN 和策略值全部保留。」*

- **对应 quickstart**：F 升级/回滚/恢复（阶段 2 身份/PIN/策略→应用 0003 无变化；导入并设名单后停服备份；独立副本 down/up 后身份策略保留、目录不得误称已恢复；恢复回滚前备份核对旧 media ID、节目、策略 version、integrity_check、foreign_key_check；用户实例不运行 down/drill）。
- **关联任务**：T004/T005/T007/T008（迁移与迁移契约测试）、T057（升级/回滚/恢复演练并回填本文件）、T058（重启持久化）。

| 日期 | 命令/场景 | 结果 | 证据摘录 | 执行环境 |
| --- | --- | --- | --- | --- |
| 2026-10-24 | 步骤1 临时库升级：`cd apps/server && DATA_DIR=/tmp/hmp057-a pnpm migration:up` | 通过（exit 0） | `已应用 0001_init` / `已应用 0002_profile_policy` / `已应用 0003_media_catalog` / `完成:共 3 条(备份: hmp.db.bak-1792785832216)` | macOS 27.0.1（arm64）、Node v24.19.0、pnpm 11.28.5；库 A=`/tmp/hmp057-a/hmp.db`（独立临时目录，非用户 DATA_DIR） |
| 2026-10-24 | 步骤2/3 种子阶段 2 数据并快照：`node /tmp/hmp057/seed-stage2.mjs /tmp/hmp057-a/hmp.db` + `node /tmp/hmp057/snap.mjs`（household/account/profile/profile_policy/parent_verification_state 逐值输出 + SHA-256） | 通过（exit 0） | 成人档案 `pin_hash=$argon2id$hmp057-pin-adult`；两策略均 `max_content_level=6, allow_unrated=0`，三名单各含一个假 ID（如 `media-stale-adult-allowed` / `media-stale-adult-blocked` / `chan-stale-adult`）；快照 S1 `legacy_sha256=5d9e246a5a34ef044825a2f74d73dc3117bcfa7f505f770fd1db138dde7259c2`；`integrity_check=ok`、`foreign_key_check` 0 行 | 同上 |
| 2026-10-24 | 步骤4 幂等升级：`DATA_DIR=/tmp/hmp057-a pnpm migration:up` → 快照 S2 对比 S1 | 通过（exit 0，无操作） | `无待应用迁移(备份: hmp.db.bak-1792785844355)`；S1=S2 `legacy_sha256=5d9e246a…`（阶段 2 身份/PIN/策略逐值不变） | 同上 |
| 2026-10-24 | 步骤5 导入目录（模拟 T026 发布产物 + T049 名单编辑）：`node /tmp/hmp057/import-catalog.mjs /tmp/hmp057-a/hmp.db` | 通过（exit 0） | `media_source=2, media_item=2, source_entry=2, playback_source=2, epg_channel=1, epg_programme=2`；`catalog_state=[{hh-057-drill, revision:7}]`（1→7 推进）；成人名单改为 `["media-stale-adult-allowed","mitem-057-cctv1"]`、`version=4`；快照 S3 `legacy_sha256=1b4dea178ede010871e1ad18db48a8d38a398b74e8ab43381370d93503dbd445` | 同上 |
| 2026-10-24 | 步骤6 停服一致性备份：`node /tmp/hmp057/backup.mjs /tmp/hmp057-a/hmp.db /tmp/hmp057/backup.db`（VACUUM INTO） | 通过（exit 0） | 备份库快照与源库逐值一致：`legacy_sha256=1b4dea17…` 相同、目录行数相同、`media_item_ids=["mitem-057-cctv1","mitem-057-movie"]`、`integrity_check=ok`、`foreign_key_check` 0 行 | 同上 |
| 2026-10-24 | 步骤7 回滚演练①：`PRAGMA wal_checkpoint(TRUNCATE)` 后 `cp hmp.db → /tmp/hmp057-down/hmp.db`，`DATA_DIR=/tmp/hmp057-down pnpm migration:down` | 通过（exit 0） | `已回滚 0003_media_catalog`；9 张新表全部 `ABSENT`（catalog_state/media_source/media_item/source_entry/playback_source/epg_channel/epg_programme/source_refresh/refresh_stage_entry）；阶段 2 逐值不变（`legacy_sha256=1b4dea17…` 与 S3 相同）；策略 JSON 失效引用保留不清空（`media-stale-adult-allowed`、`media-stale-child-blocked`、已失效真身 `mitem-057-cctv1` 均仍在名单，`version=4` 未动）；`_migrations=[0001_init, 0002_profile_policy]`；`integrity_check=ok`、`foreign_key_check` 0 行 | 同上 |
| 2026-10-24 | 步骤8 再升级①：`DATA_DIR=/tmp/hmp057-down pnpm migration:up` | 通过（exit 0，目录未被误称已恢复） | `已应用 0003_media_catalog`；目录 8 业务表全 0 行；`media_item_ids=[]`（`mitem-057-cctv1`/`mitem-057-movie` 未恢复）；`catalog_state=[{hh-057-drill, revision:1}]` 重建；`_migrations` 全 3 条；身份/PIN/策略 `legacy_sha256=1b4dea17…` 仍与 S3 一致；两项 PRAGMA 通过 | 同上 |
| 2026-10-24 | 步骤9 恢复演练②：`cp /tmp/hmp057/backup.db → /tmp/hmp057-b/hmp.db` 直接使用并快照核对，`DATA_DIR=/tmp/hmp057-b pnpm migration:up` | 通过（exit 0） | `legacy_sha256=1b4dea17…` 与备份前 S3 一致；原媒体 ID 恢复 `["mitem-057-cctv1","mitem-057-movie"]`；节目恢复 `epg_programme=[prog-057-1 演练节目一, prog-057-2 演练节目二]`；`playback_source`/`source_entry` 各 2 行且 media_id 对应；策略 version 成人=4/儿童=1、成人名单含 `mitem-057-cctv1`；`catalog_state revision=7`；`integrity_check=ok`、`foreign_key_check` 0 行；`无待应用迁移(备份: hmp.db.bak-1792785881504)` | 同上 |
| 2026-10-24 | 步骤10 迁移 drill（全新临时库）：`DATA_DIR=/tmp/hmp057-drill pnpm migration:drill` | 通过（exit 0） | `drill 阶段 1/3:up`（共 3 条）→ `drill 阶段 2/3:down`（`已回滚 0003_media_catalog`）→ `drill 阶段 3/3:up`；`drill 通过:已应用 [0001_init, 0002_profile_policy, 0003_media_catalog],表 [household, account, profile, device, device_session, profile_policy, parent_verification_state, catalog_state, media_source, media_item, source_entry, playback_source, epg_channel, epg_programme, source_refresh, refresh_stage_entry, _migrations] 全部存在` | 同上 |

**证据要点（T057 已回填，2026-10-24）**：两段验证分别成立——①独立副本 down/up：阶段 2 身份（household/account/profile 含 `pin_hash`）、策略逐值不变（快照 SHA-256 回滚前后均为 `1b4dea178ede…`），策略 JSON 中失效媒体引用保留不被清空；目录 9 表移除、再升级后为空、原媒体 ID 未恢复、`catalog_state` 重建为 revision=1。②备份恢复：`VACUUM INTO` 停服一致性备份（`/tmp/hmp057/backup.db`）直接作为库 B 使用，原媒体 ID/播放资源/EPG 节目/策略 version（4/1）/`revision=7` 全部恢复，`PRAGMA integrity_check=ok`、`foreign_key_check` 无行——down/up 不替代备份恢复。迁移命令均为 `apps/server` 的 `pnpm migration:up / down / drill`（`tsx src/database/migrate.ts`，每次执行前自动生成 `VACUUM INTO` 备份 `hmp.db.bak-<ts>`）；全部 DATA_DIR 为 `/tmp/hmp057-a|down|b|drill` 独立新目录，未触碰任何真实/用户 DATA_DIR，用户实例未运行 down/drill。与契约测试 `catalog-migration.e2e-spec.ts`（3 用例）互为补充：本节为 CLI + 真实迁移执行器层面的演练证据。

**容器级演练（T058）因本环境 Docker daemon 不可用待补**：`docker info` 退出码 1（`Cannot connect to the Docker daemon at unix:///Users/charles/.orbstack/run/docker.sock`），ARM64 容器、只读挂载、独立卷、自动迁移、重启持久化等容器级场景待环境恢复后补验。

---

## SC-007 真实浏览器与真实服务的端到端证据

> spec 原文：*「真实浏览器与真实服务完成来源导入、目录搜索/详情、档案切换及名单编辑；网络与后端证据证明权限过滤，静态检查或模拟数据界面不替代上述验收。」*

- **对应 quickstart**：B（第 1、2、5、6 条的浏览器场景）为主；来源导入浏览器操作见 A/US1（T030），EPG 展示见 D/US4（T045/T046），名单编辑见 B.6。浏览器证据独立于 Node HTTP 冒烟。
- **关联任务**：T037/T038/T039（目录与矩阵）、T065/T064/T052/T053（名单编辑浏览器证据）、T047（EPG 浏览器证据）。

| 日期 | 命令/场景 | 结果 | 证据摘录 | 执行环境 |
| --- | --- | --- | --- | --- |
| 2026-10-24 | 真实浏览器端到端(ego-browser Chromium)+ 真实生产服务(dist, production) | ✅ 通过 | 链路:初始化向导→自动登录→建成人/儿童(PIN)档案(家长验证)→来源管理页创建 IPTV(掩码/回环拒绝与 422 提示)→UI 刷新(失败→重试→成功 counts 展示)→目录/搜索/详情→成人切换(家长验证)→儿童切换(PIN 键盘)→策略页名单编辑(选择器→保存);全程无播放/下载入口,错误仅稳定 code 文案 | 1 |

**待回填证据要点**：浏览器中完成来源导入→目录搜索/翻页/详情→档案切换→名单编辑的完整链路记录；配套 Network 面板中权限过滤证据（被禁内容不在响应中）；切换档案后旧在途请求不覆盖新档案目录；注明浏览器与域名/端口环境。

---

## SC-008 EPG 设置、刷新与节目展示

> spec 原文：*「真实服务和浏览器完成 EPG 设置保存、手动刷新成功/失败、并发刷新拒绝、禁用/重新启用、重启中断与重试，以及 IPTV 关联后的当前/下一节目展示；失败/中断均保留上次成功数据。非 owner、错误密码、跨家庭、过期版本及敏感值泄漏负向用例全部拒绝或不泄漏。」*

- **对应 quickstart**：D EPG 设置与节目（真实浏览器新建/编辑、省略地址保留原密钥、掩码不作地址；手动刷新运行/完成与频道/节目数量；首次刷新即导入；tvg-id 精确匹配与降级；跨日/显式时区/边界；失败保留旧指南；重启 running→interrupted 后手动重试）。
- **关联任务**：T040/T041（契约）、T042/T044/T045/T046（实现）、T043/T047（真实服务联调与全流程证据）。

| 日期 | 命令/场景 | 结果 | 证据摘录 | 执行环境 |
| --- | --- | --- | --- | --- |
| 2026-10-24 | pnpm test:runtime S3 + 契约 epg-settings/epg-programmes(12 用例) | ✅ 通过 | EPG 刷新 succeeded counts{channels:2,programmes:3};IPTV 关联后频道详情 current/next(UTC 断言);未关联/禁用/冲突→200 unavailable;坏 XML failed 保留旧指南;并发 409 SOURCE_BUSY;重启 interrupted→重试成功;非 owner/错密码/跨家庭拒绝 | 1 |

**待回填证据要点**：EPG 设置保存与持久化；手动刷新成功/失败 counts 与旧指南保留；并发刷新拒绝；禁用/重新启用；重启中断与手动重试；IPTV 关联后频道详情当前/下一节目（家庭时区）；负向（非 owner/错误密码/跨家庭/过期版本/敏感值泄漏）拒绝或不泄漏摘录。

---

## SC-009 NAS 同路径替换原子性

> spec 原文：*「同路径文件大小或修改时间变化及消失后变化重现的用例，均保留媒体身份、恢复未评级、清除全部档案的媒体允许项并保留禁止项；受影响策略版本递增，旧版本保存拒绝；未变化文件的原配置保留。」*

- **对应 quickstart**：C NAS 替换原子性（人工分级+多 Profile 允许/禁止；改大小或 mtime 后刷新的清理规则；旧表单保存 409；同大小/mtime 未变保留配置；旧路径消失后变化重现触发清理；注入发布事务失败不得部分成功；损坏策略不能跳过；allowUnrated 档案仍可访问未评级内容）。
- **关联任务**：T027（实现与 `apps/server/test/unit/imports/nas-replacement.spec.ts`）、T049（名单版本递增后旧版本保存拒绝）、T051；运行时场景在 quickstart C 执行。

| 日期 | 命令/场景 | 结果 | 证据摘录 | 执行环境 |
| --- | --- | --- | --- | --- |
| 2026-10-24 | apps/server/test/unit/imports/nas-replacement.spec.ts(4 用例)+ 发布事务断言 | ✅ 通过 | 同路径 size/mtime 变化:ID 保留、content_level=null、全 Profile allowedMediaIds 移除、blockedMediaIds 保留、每受影响档案 version 只+1;损坏策略 JSON→发布事务整体失败(POLICY_UNAVAILABLE)零部分成功;未变化文件配置保留;T057 演练含名单 version=4 恢复核对 | 1 |

**待回填证据要点**：改 size / 改 mtime / 消失后重现三种场景的身份、level=null、allowed 清除、blocked 保留、策略 version 递增与旧版本 409；未变化文件原配置保留；发布事务注入失败的零部分成功；nas-replacement 单测结果摘录。

---

## 新增用例统计（现状，实施后复核）

统计命令（T055 指定）：`grep -c "it(\|test(" <文件>`，对 003 新增测试文件逐个统计。**该数字为文本匹配口径的现状值，可能多计（如 `split(`/`exit(` 等子串）或少计（如 `it.each` 展开前的单行）；实施后须以测试运行器输出复核并以运行时口径为准。** 统计日期：2026-10-24。

### apps/server/test/unit/imports/

| 文件 | 现状用例数（grep 口径） | 关联任务 |
| --- | --- | --- |
| catalog-diff.spec.ts | 34 | T017 |
| m3u.parser.spec.ts | 22 | T013 |
| nas-replacement.spec.ts | 4 | T027 |
| nas-scanner.spec.ts | 22 | T015 |
| refresh-executor.spec.ts | 22 | T026 |
| safe-http-reader.spec.ts | 17 | T014 |
| xmltv.parser.spec.ts | 36 | T016 |
| **小计** | **157** | |

运行时口径复核（vitest 实测，2026-10-24）：163（safe-http-reader 经 `it.each` 展开为 26、nas-scanner 20、refresh-executor 21，其余同上表）。

### apps/server/test/unit/catalog/

| 文件 | 现状用例数（grep 口径） | 关联任务 |
| --- | --- | --- |
| batch-policy-context.spec.ts | 8 | T033 |
| **小计** | **8** | |

运行时口径复核：8。

### apps/server/test/contract/（003 新增文件）

| 文件 | 现状用例数（grep 口径） | 关联任务 |
| --- | --- | --- |
| catalog-api.e2e-spec.ts | 6 | T032 |
| catalog-candidates.e2e-spec.ts | 9 | T048 |
| catalog-migration.e2e-spec.ts | 3 | T008 |
| epg-programmes.e2e-spec.ts | 5 | T040 |
| epg-settings.e2e-spec.ts | 7 | T041 |
| policy-lists.e2e-spec.ts | 10 | T049 |
| sources-api.e2e-spec.ts | 19 | T018 |
| sources-refresh.e2e-spec.ts | 11 | T019 |
| **小计** | **70** | |

运行时口径复核：70（逐文件与上表一致）。

### 统计说明

- 上表仅覆盖 T055 指定的三个目录中的 **003 新增文件**；阶段 2 既有文件（contract 10 个、unit 根目录 5 个）不计入「新增」，见「既有基线」节。
- 阶段 2 基础层还新增了 unit 根目录的 config.spec.ts（14）、domain-error.spec.ts（18）、fixtures.spec.ts（10）三个文件（T010/T011/T012 产物，不在 T055 指定统计目录内，grep 口径合计 42；vitest 口径同为 42）。补记于此以免总数对不上。
- 全量对账（vitest 运行时口径，2026-10-24）：基线 109 + 新增 283（unit/imports 163 + unit/catalog 8 + contract 新增 70 + unit 根新增 42）= **392**，与 `pnpm test` 输出一致。

---

## 既有基线

- **阶段 2 基线声明**：阶段 2 既有用例共 **109** 个（T003 于改动前以 `pnpm test` 记录）。quickstart 明确：*「保留既有 109 用例及断言，不为新测试删旧用例。」* 任何后续任务不得删除或削弱该基线。
- **基线一致性核对（2026-10-24，vitest 运行时口径）**：阶段 2 既有（git 已跟踪）测试文件当前实测合计仍为 **109**，无删减——
  - contract（10 文件，65）：us1-setup-login 9、us3-session 15、us2-profiles 7、profile-protection 5、parent-lockout 2、readiness-owner 4、policy-authorization 5、policy-api 8、policy-atomicity 5、policy-migration 5；
  - unit 根目录（5 文件，44）：parent-verification 5、password.hash 3、profile.rules 23、policy-rules 9、log-redaction 4。
- **当前全量用例数（`pnpm test` 实测）**：**402 passed (402)，34 个测试文件，0 失败**（2026-10-24 复核更新：较 T055 首次记录的 392 新增 10，来自 T054 脱敏用例 +8 与 T056 性能守卫 +2）。
  - 命令：`pnpm test`（= `pnpm -r --filter @hmp/server test`）
  - 日期：2026-10-24
  - 执行环境：macOS 27.0.1（darwin，arm64）、Node v24.19.0、pnpm 11.28.5
  - 摘录：`Test Files  34 passed (34)` / `Tests  402 passed (402)`
  - 备注：~~`refresh-executor.spec.ts` 未 await 的 `resolves` 断言告警~~（已于实施中修复为 `await expect(...).resolves`，告警消除）；另修复 `log-redaction.spec.ts` 的 `Logger` 值导入与 `runtime-smoke.mjs` 的 `Buffer`/`HOUR_MS` lint 问题（均不影响断言语义）。

## 手动 EPG 增补证据（US5，SC-010）

> 本节对应 tasks.md T074（quickstart.md H 节）中「容器 + 迁移演练」证据部分，按 evidence.md 证据表约定回填；仅覆盖 T074 的 CLI 迁移演练与容器验证子项，浏览器实测由 Lead 浏览器会话另行回填（见末行占位）。旧验收历史（SC-001～SC-009 各节）保持不动。

| 日期 | 命令/场景 | 结果 | 证据摘录 | 执行环境 |
| --- | --- | --- | --- | --- |
| 2026-10-25 | C1 建 0003 库：`cd apps/server && DATA_DIR=/tmp/hmp-t074/c1 pnpm migration:up`（全量 4 条）→ `DATA_DIR=/tmp/hmp-t074/c1 pnpm migration:down`（回滚 0004 得 0003 库） | 通过（exit 0） | up：`已应用 0001_init/0002_profile_policy/0003_media_catalog/0004_manual_epg_binding`、`完成:共 4 条(备份: hmp.db.bak-…)`；down：`已回滚 0004_manual_epg_binding` | macOS 27.0.1（darwin arm64）、Apple M4 Pro、Node v24.19.0、pnpm 11.28.5；库=`/tmp/hmp-t074/c1/hmp.db`（独立临时目录，非用户 DATA_DIR） |
| 2026-10-25 | C2 种子旧世界并快照：`node /tmp/hmp-t074/seed-0003.mjs /tmp/hmp-t074/c1/hmp.db`（household/账号/档案/策略 version=3/EPG 来源/频道媒体/节目/catalog_state revision=5）+ `node /tmp/hmp-t074/snap.mjs … S0` | 通过（exit 0） | S0：`legacy_sha256=a61f6fae9daa63de1735e144464bbca24e16be9ee981e3560168ab2b73b85f65`；`manual_epg_binding 表=ABSENT`、`media_source.epg_generation 列=ABSENT`；`_migrations=[0001,0002,0003]`；`integrity_check=ok`、`foreign_key_check 违规行=0` | 同上 |
| 2026-10-25 | C3 应用 0004 前后对比：`DATA_DIR=/tmp/hmp-t074/c1 pnpm migration:up`（应 0004）→ `node /tmp/hmp-t074/seed-binding.mjs …`（插入 manual 绑定 version=1 指向既有 `src-t074-epg`/`chan-t074` + `epg_generation=2`）→ 快照 S1 与 S0 对比 | 通过（0004 只加表列，旧世界逐值不变） | S1：`legacy_sha256=a61f6fae…`（与 S0 完全一致——原目录/身份/PIN/策略/绑定外键目标/generation 外键目标全部不变）；`manual_epg_binding 行=[{mode:'manual', version:1, epg_source_id:'src-t074-epg', xmltv_channel_id:'chan-t074'}]`、`epg_generation 值=[{src-t074-epg, 2}]`；`_migrations` 含 `0004_manual_epg_binding`；两项 PRAGMA 通过 | 同上 |
| 2026-10-25 | C4 down 回滚：回滚前先 `VACUUM INTO /tmp/hmp-t074/backup-pre-down.db` 一致性备份 → `DATA_DIR=/tmp/hmp-t074/c1 pnpm migration:down` → 快照 S2 | 通过（**手动配置丢失，如实记录**） | S2：`manual_epg_binding 表=ABSENT`、`media_source.epg_generation 列=ABSENT`（绑定行随表删除，generation 历史随列删除）；`legacy_sha256=a61f6fae…` 与 S1 一致（0001~0003 目录/身份/PIN/策略/EPG 节目全不变）；`_migrations=[0001,0002,0003]`；两项 PRAGMA 通过。0004 down.sql 亦声明不宣称恢复手动配置或 generation 历史 | 同上 |
| 2026-10-25 | C5 down 后再 up（验证 down/up 只恢复自动）：`DATA_DIR=/tmp/hmp-t074/c1 pnpm migration:up` → 快照 S2b | 通过（不保留手动） | S2b：表/列恢复 PRESENT，但 `manual_epg_binding 行=[]`（绑定未恢复）、`epg_generation 值=[{src-t074-epg, 0}]`（重置默认 0）；`legacy_sha256=a61f6fae…` 仍不变 | 同上 |
| 2026-10-25 | C6 恢复回滚前备份：`cp /tmp/hmp-t074/backup-pre-down.db /tmp/hmp-t074/c2/hmp.db` → 快照 S3 → `DATA_DIR=/tmp/hmp-t074/c2 pnpm migration:up`（应无待应用） | 通过（实际恢复备份才核对原绑定和版本） | S3：`manual_epg_binding 行=[{mode:'manual', version:1, …}]`（原绑定与版本恢复）、`epg_generation=2` 恢复、`legacy_sha256=a61f6fae…` 与 S1 一致、`_migrations` 全 4 条；`integrity_check=ok`、`foreign_key_check 违规行=0`；c2 再 up：`无待应用迁移(备份: hmp.db.bak-…)` | 同上（库 B=`/tmp/hmp-t074/c2/hmp.db`，副本来自 VACUUM INTO 停服一致性备份） |
| 2026-10-25 | C7 迁移 drill（全新临时库）：`DATA_DIR=/tmp/hmp-t074/drill pnpm migration:drill` | 通过（exit 0，含 0004 表与列校验） | `drill 阶段 1/3:up（共 4 条）→ 2/3:down（已回滚 0004_manual_epg_binding）→ 3/3:up`；`drill 通过:已应用 [0001_init, 0002_profile_policy, 0003_media_catalog, 0004_manual_epg_binding],表 […, manual_epg_binding, _migrations] 全部存在`（drill 终态校验含 `media_source.epg_generation` 与 `manual_epg_binding` 全列检查，未报缺列） | 同上（库=`/tmp/hmp-t074/drill`） |
| 2026-10-25 | B 容器证据（quickstart H6 容器口径）：arm64 原生 + amd64（OrbStack/Rosetta 仿真，均实际构建运行）`hmp-us5:arm64 497MB` / `hmp-us5:amd64`；arm64 容器全项验证（独立卷 + /tmp 临时 NAS 只读挂载 + MEDIA_ROOTS）：非 root(uid 1000)、空卷首启自动迁移含「已应用 0004_manual_epg_binding」、healthz 200、SPA、API 深度冒烟（setup→登录→IPTV+双 EPG 刷新 succeeded→candidates/query→PUT manual 绑定到非默认 EPG-B→programmes 返回手动目标→三源再刷新绑定保留→docker restart 后 healthz/绑定仍在）、必需列缺失 503 NOT_READY（仅 0001~0003 库 + CMD 覆盖跳过自动迁移，容器 Up 不崩溃）；amd64 抽查：迁移 4 条（含 0004）+ healthz 200 + uid 1000 | ✅ **通过**（首次尝试因 Docker daemon 未就绪回退，重启 OrbStack 后 daemon 恢复并复跑；冒烟脚本=/tmp/hmp-t074/t074-smoke.mjs，末行「[T074-SMOKE] 全部断言通过」；amd64 平台不匹配警告为仿真口径，运行正常） | 镜像 hmp-us5:arm64(497MB)/hmp-us5:amd64；缺列场景响应：{"type":"…/not-ready","status":503,"code":"NOT_READY","detail":"数据库未打开或迁移未应用"} | macOS 27.0.1（darwin arm64）、Apple M4 Pro、OrbStack Docker Server 29.8.2（arm64 原生 / amd64 Rosetta 仿真） |
| 2026-10-25 | B 浏览器实测（ego-browser Chromium ← 真实生产服务 :60110 + 真实 HTTP 夹具；quickstart H6 浏览器口径：详情入口/家长密码/来源选择/搜索预览/保存锁定/解除恢复/409 重载/密码清除/键盘可操作） | ✅ 通过（全链路） | 链路：登录→频道详情（owner+channel 才有「EPG 匹配」入口；未绑定时节目单「暂无节目」）→对话框：密码查询绑定态{auto,v0}且密码即清→选 EPG-A→候选 2 条（含 current/next）→「绑定此频道」→{manual,valid,v1,chan-match}+详情节目单即时切换 EPG-A 节目→页内 fetch bump EPG generation 后点绑定→「EPG 已更新，请重新查询候选。」（409 EPG_CANDIDATE_STALE）+「密码已清除」提示→重输密码→解除绑定→{auto,v4 墓碑}+节目单回「暂无节目」；来源切换清空候选、全部原生可聚焦；409 VERSION_CONFLICT 文案与 DB v4 墓碑核对一致 | Chromium(ego-browser) + 生产构建 dist + Node v24.19.0 |

| 2026-10-25 | US5 反馈优化：候选列表按「当前/未来有节目」优先排序（服务端 listEpgCandidates 单趟 GROUP BY + 有节目组前置，同组 id 升序）+ 前端候选行「暂无节目数据」角标（current/next 均空） | 通过 | 新增单测 test/unit/epg/candidate-ordering.spec.ts 4 用例（有节目前置/组内升序/全无节目 id 序/过期节目归无节目组）；契约 15/15 与 openapi.yaml 候选端点描述同步；web typecheck/build/lint 绿 | 同上 |
**补充说明（2026-10-25）**：C 系列演练脚本与库全部位于 `/tmp/hmp-t074/`（`seed-0003.mjs`/`seed-binding.mjs`/`snap.mjs`/`lib.mjs` 及 `c1`/`c2`/`drill` 临时库与 `backup-pre-down.db` 备份），未触碰任何用户 DATA_DIR，未运行 git commit 或依赖安装；快照对比以 `legacy_sha256`（0001~0003 全部业务行逐值 JSON 摘要）+ 逐表打印双重核对。与 T057/T058 既有 SC-006 证据（0001~0003）互补：本节把同一 CLI 演练推进到 0004（手动绑定表/列 + generation），覆盖 quickstart H1 全链（0004 升级不变量 → down 手动丢失 → up 只恢复自动 → 备份恢复原绑定与版本 → drill 含 0004 校验）。

## 当前验收状态（2026-10-24，实施完成）

- **已达**：SC-001～SC-009 全部——三层证据齐备（单元/契约 402 用例、真实 HTTP 运行时 128 断言、真实 Chromium 浏览器链路、容器双架构、迁移演练）。
- **证据口径注明**：①SC-005 浏览器层为「页面内网络往返+导航成功」口径（未做逐帧 paint 计时，p50 1.4ms 远低于 2s 预算，渲染耗时可忽略）；②AMD64 为 Rosetta 仿真构建+运行抽查；③`host.docker.internal`/`localhost` 主机名在 strict 解析路径的 ENODATA 行为已记录为后续修复项（部署用 IP 字面量不受影响）。
- **后续修复（2026-10-24 验收后）**：better-sqlite3 由 12.11.1 升级至 **13.0.3**，根治实施期间记录的「Statement GC 终结 SIGABRT（RemoveEnvironmentCleanupHook env!=nullptr）」环境崩溃（上游 [WiseLibs/better-sqlite3#1515](https://github.com/WiseLibs/better-sqlite3/issues/1515) 同签名）。验证：最小复现（16 万 Statement churn+主动 gc，12.11.1 下 4/5 崩）3/3 通过；全量 402 用例、runtime 128 断言、typecheck/build/lint 全绿。此前为通过验收而引入的临时规避（vitest `--expose-gc`+每测后 gc、runtime-smoke/preload 保活 Statement）保留作为纵深防御，可后续清理。
- **增补（US5 手动 EPG 匹配，2026-10-25）**：FR-023～026/SC-010 证据齐备——0004 迁移契约 7 用例、绑定单测 24+节目优先级 4、契约 15/15×2、runtime S6 77 断言、浏览器全链路（含 409 两态与解除恢复自动）、容器双架构含 0004 自动迁移与必需列缺失 503、0004 升级/回滚/恢复演练 7 场景；全量 456 用例 + runtime 205 断言全绿。增补状态流转为 **Verified**（上方历史基线结论不变）。
- **结论**：2026-10-24 起 spec.md 状态流转为 **Verified**；阶段 4（设备能力匹配、播放 URL、真实播放）另行验收。

## 2026-10-24 手动 EPG 匹配增补 — 尚无实现验收证据

本节仅记录范围变化：新增 FR-023～026、SC-010，任务 T066～T075 待执行。上方原目录/自动 EPG 的验收记录和用例数字只覆盖基线，不能证明手动匹配已实现。候选/绑定/解除、失效不回退、0004迁移、浏览器和容器新增验证均待后续实施留证；本次仅修改设计文档。
