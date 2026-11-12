# Evidence: 014-channel-logos

日期：2026-11-07。规格状态：Implementing（Accepted 见 spec.md Acceptance Record）。本档案只记录真实运行结果；未产生的证据明确标注 Not-run，不伪造。

## 1. 实施范围与交付方式

按 [tasks.md](tasks.md) 以多 subagent 并行实施（Wave 1–4），Lead 逐波核验真实测试输出并勾选。实现与自动化测试全部交付；运行时/真实浏览器证据待人工执行（见 §4）。

## 2. 自动化证据（全部为本会话真实运行）

### 2.1 静态与类型

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 全仓 typecheck | `pnpm typecheck` | **exit 0**（shared/server/web 三包 Done） |
| 全仓 lint | `pnpm lint` | 014 触及面 **0 错误**（详见 §2.5 残留） |
| server tsc | `apps/server && pnpm exec tsc --noEmit` | exit 0 |

### 2.2 迁移与边界

| 项 | 证据 |
| --- | --- |
| `migration:up`（临时 DATA_DIR） | exit 0，0001–0009 全应用 + VACUUM INTO 备份 |
| `migration:drill` | exit 0：up→down→up 全应用；终态表清单含 channel_logo（EXPECTED_TABLES/EXPECTED_COLUMNS 与 database.ts REQUIRED_COLUMNS/isReady 均已登记 0009） |
| CHECK 边界实测 | NULL/9/2048/https 通过；8 字符、2049、ftp:// 拒绝 |
| 约束实测 | 墓碑同行覆盖合法；墓碑留 url、source_kind='rss'、revision=0 被 CHECK 拒绝；跨家庭复合 FK 拒绝；(hh,media)/(hh,ref) UNIQUE 拒绝；DELETE media_item → channel_logo CASCADE |
| `audit:boundaries` | r2 跨上下文深导入 **0 条**（media-catalog/index.ts 发布面收敛后消除）；r1 4→2（logo.service.ts 014 引入已修；poster.service.ts ×2 为 010 顺延既有，留档不扩大） |
| `pnpm gen:types` | EXIT=0，logo-schema.d.ts 生成（7 份契约 d.ts，其余哈希幂等） |

### 2.3 新增自动化测试（全部先写先失败→实现后绿）

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| test/unit/imports/m3u.parser.tvg-logo.spec.ts | 9 | FR-001/010 捕获与归一化矩阵 |
| test/unit/imports/refresh-publish-channel-logos.spec.ts | 6 | M1 合并、revision/ref 稳定、FR-010 整批成功、GC、NAS 恒无 |
| test/unit/imports/xmltv.parser.icon.spec.ts | 13 | FR-002 捕获矩阵 + 归一化共享实现 |
| test/unit/imports/channel-logo-merge-rules.spec.ts | 14 | M3×6/M4×4/M2×3 + EPG-GC；「epg 不覆盖 iptv」钉住；旧引用 resolve='revoked' 410 数据形态 |
| test/unit/imports/channel-logo-refresh-convergence.spec.ts | 5 | SC-004 四版刷新收敛 + SC-005 坏 logo 对照 |
| test/unit/catalog/logo-ref.spec.ts | 4 | 引用形态与重签 |
| test/unit/catalog/channel-logo-participants.spec.ts | 15 | 参与者五方法 + CHECK/FK/回滚无半状态/ref 冲突重签 |
| test/unit/catalog/logo.service.spec.ts | 7 | 解析/有界读取/错误映射全分支（fake upstream） |
| test/contract/public-media-logos.e2e-spec.ts | 12 | happy path×3、上游失败族×3、墓碑 410/GC 后 404 同形、伪造与跨家庭 404 逐字段同形、429+Retry-After（真实打满 121 次）、泄漏面总断言（≥14 响应体 0 上游片段） |
| web test/features/live/channel-logo.spec.tsx | 16 | 回退链不变量 + 加载态 + z 序 + 互斥 + onError 恢复 + 加载中可交互 |
| web test/features/live/channel-logo-us3.spec.tsx | 5 | 节目单列头行高不变 + 收藏有/无 Logo |
| web（同 spec 内） | — | **SC-006 范围守护：GuideWall/GuideScrollContainer 渲染 img=0** |

### 2.4 全量测试（最终态）

| 套件 | 结果 |
| --- | --- |
| `pnpm test`（server 全量 unit+contract） | **165/166 文件绿，2334 passed / 1 skipped**；唯一红文件 `test/unit/playback/input-security.spec.ts:910` = 向 `$HOME` 写 canary 被会话文件沙箱 EPERM 拒绝（**环境性失败**，playback 域 014 零改动；迁移实施期已独立标记同一结论）。此前 3 失败为 online-vod-migration.e2e 硬编码迁移清单缺 0009（014 引入回归，已修复：FULL_CHAIN 纳入 0009、0009 先行回滚后 0008 破坏性拒绝语义按新栈序重排，21/21 绿） |
| web 全量（`vitest run`） | **63 文件 / 428 测试全绿** |
| 既有回归抽查 | imports/catalog/epg/live 模块 25 文件 373 测全绿；契约回归（import-channel-groups/import-content-revision/refresh-content-revision/public-guide/public-live/manual-epg-migration）全绿 |

### 2.5 残留（如实留档，非 014 代码债务）

- `pnpm lint` 全仓残余 2 处 unused-vars：`settings-access-guard.matrix.spec.ts`（M）、`settings-preferences.e2e-spec.ts`（??）——**013 遗留未提交工作**的文件，非 014 触及面，按「不扩大范围」处置留档。
- `audit:boundaries` exit 2：poster.service.ts ×2 为 010 顺延既有（logo.service.ts 已按其同款结构端口先例修复为 0）。
- `verify:release` 未全绿：既有门禁缺口（010 evidence.md 已记录同类未全绿），非 014 引入；poster.service 处置后 ④a 可复用 logo.service 留下的样板。
- 限频测试基建提示：logo 守卫的限频计数表走 Nest DI 实例（非 sharedRateLimitService 单例），rate-limit-evidence spec 的清窗方式在同装配形态下可能无效（evidence spec 未暴露因无非 429 断言掩盖）——后续改该 spec 时留意。

## 3. 运行时 / 真实浏览器证据

| 任务 | 状态 | 说明 |
| --- | --- | --- |
| T020（US1 真实源导入呈现） | **Not-run** | 需真实 IPTV 源与人工浏览器操作（quickstart §4-1） |
| T024（US2 失效 logo 回退） | **Not-run** | quickstart §4-2 |
| T029（US3 节目单/收藏） | **Not-run** | quickstart §4-4 |
| T035（US4 刷新收敛 curl 410） | **Not-run** | quickstart §4-3 |
| T038（US5 网络扫描泄漏） | **Not-run** | quickstart §4-5 |

宪章原则一：仅单元/契约测试**不能**替代运行时与真实浏览器证据——上表完成前 spec 不得流转 Verified（quickstart §3 场景已全部自动化通过，§4 场景待执行）。

## 4. 结论

- **实现完成**：US1–US5 服务端与 web 代码 + 自动化测试全绿（typecheck/lint/迁移/边界/单测/契约）。
- **验收未完成**：运行时与真实浏览器证据 Not-run；spec 维持 Implementing，不宣称 Verified。
- 发布门禁缺口均为既有遗留（010 poster r1、verify:release 既有未全绿项），014 未新增任何门禁红线。

## 5. 实施期呈现修订（2026-11-08，维护者指令）

- 卡片主视觉取消「底板大首字」，改为右上角 `ChannelIdentityBadge`（Logo → 名称 chip 回退，长名截断 + HeroUI Tooltip 全名），ChannelTile/NowHero 接入；ChannelLogo 保留给小尺寸身份盒。契约记录见 [ui.md §1a](contracts/ui.md) 与 [spec.md 实施期呈现修订](spec.md)。
- 测试改写：channel-logo.spec.tsx 16 用例（badge 状态机/接入/回退/SC-006 守护）+ us3 5 用例不变；live-home-structure 六信息断言改 ≥1（角标名称 chip 与信息层各一次）。web 全量 **63 文件 / 428 测试全绿**；触及文件 lint/typecheck 干净。
- HeroUI Tooltip 悬浮展开属 overlay 管理器行为，jsdom 不可模拟——自动化钉「布线存在」（`data-slot="tooltip-trigger"`），展开归运行时证据（并入 T020/T024/T029/T035/T038 的真实浏览器核对清单）。
