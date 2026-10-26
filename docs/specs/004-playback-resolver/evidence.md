# Evidence Ledger: 004 播放解析与受控播放

**规则**: 本台账只记录实际执行结果。任何条目在对应验证真实运行通过前必须保持空白或标注「未执行/缺口」，不得预填通过。环境不可产生的证据（真实浏览器三内核、NAS 硬件加速、双架构容器等）如实保留缺口。

## SC 证据台账

| SC | 描述 | 证据指针 | 状态 |
|----|------|------|------|
| SC-001 | 解析 P95 ≤1s、起播成功 | T034 节（resolve→ready→renew→交付 HTTP 链、限频实测）、T047 节 S8（续期同 session/任务）、T059 节（六门禁全绿、runtime 445 断言两轮）；浏览器面 US3-01/06 待执行 | 未验收——后端达成（HTTP 解析/续期/交付链）；缺口：浏览器面（各 20 次起播 ≥19 成功、逐次 P95 ≤1s、≥15 分钟跨两次续期不重置位置、Network 同源，US3-01/06 未执行；004 resolve 逐次 P95 未记录） |
| SC-002 | 未授权/跨家庭拒绝且无泄漏 | T041 节（授权矩阵 34 用例+输入安全 33 用例+泄漏扫描 217 条聚合+S7 90 断言）；浏览器面 US3-02 待执行 | 未验收——后端达成（负向矩阵与零泄漏 HTTP 层全绿）；缺口：浏览器面（UI 门控/同形 404 展示，US3-02 未执行） |
| SC-003 | 票据绑定设备/session/generation，复制即拒 | T041 节（跨 session/过期/篡改/同家庭跨设备复制/换代旧票/终态票全 401；S7 切档案/收紧/注销后 manifest/segment/Range 下一请求全拒） | 未验收——后端达成（失效矩阵 HTTP 层 100% 拒绝）；缺口：浏览器面（旧票重放/停止后拒绝的浏览器呈现，US3-02/05/10 未执行） |
| SC-004 | 家长按设备查询播放记录 | T047 节（records e2e 14 用例+S9 54 断言、字段完整率 100% 双口径、retention 9/9、owner/非 owner/跨家庭负向全绿）、T046 组件交付+web 门禁 | 未验收——后端证据齐备（字段完整率 100%）；缺口：浏览器面（家长查询 UI 实操：密码输入/列表渲染/错误分流/翻页，T047 节如实记录，归 T054/T055 浏览器链路层） |
| SC-005 | 权限变化下一请求生效 | T041 节（C6/C7 策略、F1–F3 会话/档案、D3 源；lifecycle.spec 15s 后台复核→reclaim→cancel→60s 清理链单测钉死） | 未验收——后端达成；缺口：浏览器面（档案切换瞬间销毁播放器/旧代次响应不覆盖，US3-05 未执行） |
| SC-006 | 0005 迁移/恢复不破坏既有身份 | T056 节（独立临时库 up/备份恢复逐值一致/down/up/drill 全过、恢复票不复活 0 行）、T059 节（961/961 用例+runtime 445 断言、003 场景零回归）、T057 节（compose/Dockerfile 配置层交付+`docker compose config` PASS） | 未验收——迁移演练与全量回归达成；缺口：部署镜像面（T057：linux/amd64+arm64 镜像构建/启动/迁移/缺列 503/缺 FFmpeg 能力全部未实测，Docker Hub 不可达） |
| SC-007 | 四种处理路径（direct/remux/audio/video） | T034 节（四路径单测/契约+真实 FFmpeg `-c copy` remux）、T047 节 S8（audio/video_transcode 真实交付 73–215ms+BUSY 实证）、T032 夹具（5 容器×编码矩阵+非法/4K/HDR） | 未验收——后端四路径达成；缺口：浏览器面（每必验样本有声有画 ≥15 分钟、Chromium/Firefox/Safari 分内核路径，US3-01/06/07/08 未执行）+真实硬件（T058 G1/G2）+并发 2 稳态（G4） |
| SC-008 | 停止/失联/退出资源回收与记录可见性 | T047 节（S9 记录可见性/未认证不入记录）、T058 节（S8-5 停止取消、S8-6 失联 45s 回收、S8-8 重启 interrupted+孤儿清理；看门狗/磁盘/清理重试单测）、input-security（字幕越界/符号链接/脚本不执行） | 未验收——后端达成；缺口：浏览器面（字幕显示/音轨切换 UI、停止释放 UI，US3-08/10 未执行）+部署目标回收链复验（T058 G6） |
| SC-009 | 转换时限与性能不足稳定失败 | T058 节（S8 转码任务墙钟 73–215ms、seek 恢复 8–216ms ≪15s 预算两轮、BUSY/速度看门狗/磁盘上限/软件回退单测；macOS 软件路径） | 未验收——服务器侧计时达成（macOS 软件路径，不可外推镜像 5.1.9）；缺口：真实负载端到端（T058 G5）+真实硬件（G1/G2）+浏览器呈现（US3-03/04/09 未执行） |

> T060 逐 FR/SC 终验核对（判定规则、逐条层级与结论、保留未验收清单）见文末「## FR/SC 终验（T060）」节；本表不因 T059 门禁全绿改变验收结论（0 项 Verified）。

## 基线（T002，2026-10-25）

- **分支**: master；**HEAD**: f286c59db4b484c3f38f378de441b401dfacd91f
- **接受门禁**: 维护者已于 2026-10-25 接受 spec.md 与 ADR-0009（记录见 plan.md T001 节），授权实现。
- **已有脏文件（003 功能未提交更改，基线原样保留，不覆盖）**:
  - 修改：apps/server/.env.example、apps/server/package.json、apps/server/src/app.module.ts、apps/server/src/common/domain-error.ts、apps/server/src/common/problem-json.filter.ts、apps/server/src/config/env.schema.ts、apps/server/src/database/{database.ts,migrate.ts,schema.ts}、apps/server/src/modules/policy/policy.service.ts、apps/server/test/contract/policy-migration.e2e-spec.ts、apps/server/test/helpers.ts、apps/server/test/runtime-smoke.mjs、apps/server/test/unit/log-redaction.spec.ts、apps/server/vitest.config.ts、apps/web/src/App.tsx、apps/web/src/components/AppShell.tsx、apps/web/src/lib/api.ts、apps/web/src/pages/ProfilePolicy.tsx、docs/roadmap.md、packages/shared/package.json、packages/shared/src/{constants.ts,index.ts}、pnpm-lock.yaml
  - 未跟踪：apps/server/src/config/import-budgets.ts、apps/server/src/database/migrations/0003_media_catalog/、apps/server/src/database/migrations/0004_manual_epg_binding/、apps/server/src/modules/{catalog,epg,imports}/
- **基线验证结果（实际执行）**:
  - `pnpm lint`: PASS（exit 0）
  - `pnpm typecheck`: PASS（3 workspace 项目全部通过，exit 0）
  - `pnpm test`: PASS — 39 文件 / 460 用例全部通过（56.75s，exit 0）
  - `pnpm build`: PASS（shared/server/web 全部构建成功，exit 0；web 有 >500kB chunk 警告，非失败）
  - `pnpm test:runtime`: PASS（exit 0）— 205 断言；phase2 8 场景 + phase3 S1–S6 全部通过；HTTP P95 70ms（Apple M4 Pro/ARM64，浏览器渲染层证据标注待补）
- **环境**:
  - Node v24.19.0、pnpm 11.28.5、TypeScript ^5.8
  - FFmpeg/ffprobe 8.1.1（Homebrew，Apple clang 21.0.0，macOS 本机；非部署目标 Linux，硬件加速特性待部署证据）
  - 宿主: macOS（开发机）；部署目标 Docker/Linux NAS 证据为环境缺口

## US1 后端 checkpoint（T034，2026-10-25）

**T014–T016 后端用例：先失败后通过（TDD 留证）**
- T014 控制契约（playback-control.e2e-spec.ts，39 用例）：RED 39/39 失败（路由不存在形态：Nest 404 vs 预期稳定码）→ T031 接线后 **39/39 绿**。
- T015 HLS 代理单测 + 流契约（hls-proxy.spec 23 + playback-stream.e2e 21）：单测 RED 为模块装载失败 → **23/23 绿**（T021/T022）；流契约 RED 21/21（renew 404 / 404≠401 / NOT_FOUND≠MEDIA_NOT_FOUND）→ **21/21 绿**（T031）。
- T016 转换失败矩阵（conversion.spec，39 用例）：RED 34 失败/5 通过（T023–T027 模块缺失）→ **39/39 绿**（T023–T027 分批落地）。
- 注：验收 spec 曾有 2 处缺陷断言（control L438 对同一值断言 true 与 1 的 Object.is 矛盾；stream L556 断言 HEAD 响应可解析 body，违反 RFC 7231/Node 栈双侧抑制），经证实为测试笔误后由 Lead 按保留意图原则修正（存在性断言拆分；HEAD 仅断状态+头，body 断言由同用例 GET 覆盖）。

**真实 FFmpeg 四路径与 HTTP 结果**
- 环境：本机 FFmpeg/ffprobe 8.1.1（Homebrew，macOS arm64，GPL 构建 libx264/libx265/aac；非部署目标 Linux，镜像为 Debian bookworm ffmpeg 5.1.9——性能结论不可外推，见 T058 缺口）。
- 真实层证据（conversion.spec「真实FFmpeg层」，skipIf 无 ffmpeg，本机已执行）：ffprobe 事实提取与原始解析一致；`-c copy` 真实转封装 → HLS 单窗口产物 .m3u8/.ts 结构与字节存在性验证；产物经 ConversionStorageService 计入 bytes_on_disk 账本。
- 四处理路径在单测/契约层验证：direct（H.264 8bit yuv420p+AAC 直流，不占额度）、remux（-c copy，静音视频 audio=none）、audio_transcode（copy+aac 192k）、video_transcode（libx264+aac，硬件探测优先/失败软件回退一次共用原期限）。4K/HDR 需转换 → PLAYBACK_FORMAT_UNSUPPORTED 不降分辨率。
- HTTP 层：resolve 201 preparing/delivery=null → GET 轮询 ready → renew 取票（TTL 预算生效）→ 媒体网关 200/206/416/HEAD/断开取消/流后 failure_code 可轮询；限频 429+Retry-After 实测。
- 全量回归：`pnpm --filter @hmp/server test` **856/856（56 文件）0 失败**（基线 577 → +279）；`tsc --noEmit` 0 错误；`pnpm lint` 0 错误；`pnpm test:runtime` PASS（205 断言，003 场景无回归）。

**明确未完成（不得因 HTTP 通过标注）**
- SC-001/SC-007 浏览器层（Chromium/Firefox/Safari 真实起播、≥15 分钟跨两次续期、20 次起播成功率、Network 同源验证）：**未验收**，归 T048–T055。
- operationEpoch 浏览器丢弃语义：服务端侧已在 T014 验证（旧 generation renew 拒），浏览器丢弃归 T053–T055。
- 真实硬件加速/性能阈值（30 秒/15 秒实测）：归 T058。

## US2 负向矩阵（T041，2026-10-25）

**SC-002/003/005 后端负向证据（HTTP/服务层；浏览器层尚待 T048–T055 验收）**

- **授权矩阵（playback-authorization.e2e-spec.ts，34 用例全绿）**：
  - 会话维度：无/过期/撤销（logout+DB）/伪造 → 401 SESSION_INVALID；
  - 档案维度：未选 → 403；停用 → 403；PIN 绑定冲突 → 403 PROFILE_PIN_REQUIRED；锁定 → 423；
  - 策略维度：儿童超龄/黑名单/未评级/名单外频道 → 404 同形（与不存在媒体 problem 体逐字段一致）；收紧后 active session 的 GET/renew/媒体下一请求 → 404 且不签票；运行中流收紧后新请求 → 404；
  - 家庭/源维度：跨家庭 GET/stop/renew/媒体 → 404 PLAYBACK_NOT_FOUND 同形；无源/禁源 resolve 与媒体 → 404 同形（T037 裁决：家庭级零资源归一 404，消除 503/404 资源存在性探测通道）；
  - 票据维度：跨 session/过期/篡改 → 401；**同家庭跨设备复制票 → 401 TICKET_INVALID**（T037 新增设备绑定门）；**seek 换代旧票 → 401**（实时 generation 门 + 换代卫生撤销，T037）；**终态（ended/failed/interrupted）会话旧票 → 401**（T040 终态票门，data-model「终态票拒绝」；修复前 RED 复现证据留存）；
  - 异步提交授权变化：resolve 201 后注销/收紧/切档案 → 下一请求 401/404/403；
  - 幂等同形：stop/GET 幂等不放开归属（终态跨设备 GET 仍 404 同形）；nonce 枚举 200 伪造票全 401 同形；跨家庭枚举防护三类 id 体逐字段一致。
- **输入安全矩阵（input-security.spec.ts，33 用例全绿）**：DNS 重绑定（混合地址全量校验拒绝+连接钉扎）、redirect 每跳复验/二跳零凭据、嵌套清单零上游痕迹、上游 query 内嵌票据零泄漏、METHOD=NONE key 行 URI 剔除（T037）、NAS/字幕越界与符号链接（根内/根外双拒）、malformed probe 稳定失败零路径、shell 注入哨兵（`; rm -rf` 形态文件名真实 probe，$HOME 未动）、轨道伪造 9 形态 → 400、header 后错误脱敏（headersSent 零注入）、上游请求零应用认证（5 出站请求头恒等聚合）、pinnedLookup Node 20 autoSelectFamily 兼容修复（T038，名字型许可可用且逐 IP 复核保持）。
- **真实 HTTP 矩阵（runtime-smoke S7，+90 断言，总 295）**：direct+HLS 基线起播（清单/分片/MAP/key/字幕全链）→ 切档案 403 → 收紧策略 404 → 注销 401+旧票作废 → 停源 404 → Range 206/HEAD → 流中失败截断字节流无 JSON 注入+失败码可轮询；旧缓冲不计停止期限（每次拒绝后同 URL 立即重取必拒）。
- **泄漏扫描（T040）**：217 条捕获响应体+头聚合断言——无 NAS 路径指纹、无上游主机、无票明文（合法 playbackUrl 字段除外）、无 stderr 关键词；日志面五稳定码 message+ProblemJsonFilter 渲染样本+流后边界零写入。
- **US1 契约复跑（修复后）**：playback-control 39/39 + playback-stream 21/21；全量 **923/923（58 文件）0 失败**；`tsc` 0 错误；`pnpm lint` 0 错误；`pnpm test:runtime` PASS。
- **SC-005（权限变化下一请求生效）**：C6/C7（策略）、F1/F2/F3（会话/档案）、D3（源）全绿；后台 15s 复核→reclaim→supervisor.cancel→60s 清理链有单测钉死（lifecycle.spec）。

**明确未完成**：SC-002/003/005 的浏览器层负向（UI 门控/同形 404 展示）归 T048–T055；任何授权漏口已按矩阵关闭，无已知阻塞项。

## US2b 家长设备记录（T047，2026-10-26）

**SC-004 证据：后端 HTTP/服务层全绿；浏览器层缺口见本节末尾（如实保留）。**

- **记录域契约（playback-records.e2e-spec.ts，14 用例全绿，计入本节末全量 961）**：
  - 生成（T043 审计路径）：成功播放（resolve→ready→renew→首次 GET 媒体→stop）→ 恰 1 条 session（startedAt/endedAt 非空、failureCode=null、无源位置/票）；有效会话解析被拒（策略黑名单/可见但无启用源）→ 独立 failure 记录（stableCode=公开稳定码、mediaId 按可见性保留、不建播放会话）；不可见媒体解析失败 → mediaId=null 且不存客户端原始目标 ID；无效会话（伪造/过期）resolve → 401 且零记录行（仅脱敏安全日志语义）；异步准备失败只更新 session.failureCode、不产生 failure_event；重复 stop 幂等（ended_at 不变、无第二个结束事件）。
  - 查询（T044 控制器）：owner 当次密码 200 {items,nextCursor}；缺失/空串 → 403 PARENT_VERIFICATION_REQUIRED；错误 → 403 PARENT_VERIFICATION_FAILED；成功验证清零后仍可查；连错 5 次 → 423 PARENT_VERIFICATION_LOCKED 窗口（窗口内正确密码仍拒）；owner 会话撤销 → 401 SESSION_INVALID（先于密码校验）；跨家庭 deviceId 与不存在设备同形 404（密码正确仍拒，不可枚举）；非 owner 账号 → 403 FORBIDDEN；limit 0/101/负数/小数/非数字 → 400 VALIDATION_FAILED、未知字段拒绝；25 条混合记录分页（默认 20/limit 100/limit 7）走完全局 (时间,id) 倒序、同刻 id 决胜、无重复、到底 nextCursor=null；响应 no-store/no-referrer、体无源位置/路径/ticket/playbackUrl；同家庭另一设备记录不混入（精确 id 集合断言）。
- **记录字段完整率 100%（双重口径）**：①契约层——session 记录 13 键（kind/id/deviceId/mediaId/profileId/state/delivery/positionSeconds/createdAt/startedAt/endedAt/failureCode/playbackSourceId）与 failure 记录 6 键（kind/id/occurredAt/stableCode/profileId/mediaId）additionalProperties:false 精确键集断言；②runtime 层（S9）——13+6=19 个必需字段逐键语义断言（字符串键非空、startedAt/endedAt 为合法 ISO、failureCode 应空即空、playbackSourceId 为不透明串非路径/文件名、positionSeconds 为有限数），完整率 = 按语义非空计数/必需字段总数 = **100%**（两轮输出 `recordFieldCompletenessRate:100`）。
- **S9 runtime 真实 HTTP 场景（runtime-smoke.mjs T047，+54 断言，总 445；两轮全绿）**：独立记录设备 A（新登录=新 Device，renew 限频/家长验证计数与既有设备天然隔离）上 adult 档案成功播放（resolve→ready→renew→GET 媒体→stop）+ 同设备黑名单策略拒绝构造解析失败（S7-3 手法，复原名单）→ `POST /api/devices/{deviceA}/playback-records/query` 恰 2 条（1 session ended + 1 failure MEDIA_NOT_FOUND，(time,id) 倒序、nextCursor=null）；伪造 token resolve → 401 SESSION_INVALID 且记录集合逐 id 不变（未认证不入设备记录）；权限负向：错误密码 → 403 FAILED（全程恰 1 次 ≪ 5 次×5min 锁定阈值，前置清零计数解耦更早场景）、缺密码 → 403 REQUIRED（不计失败）、非 owner（admin 直改 role，用后即复）→ 403 FORBIDDEN（requireOwner 先于家长验证）、两个随机 deviceId → 404 响应体逐字段一致（同形）；device B（S2 第二登录既有设备，child 档案对黑名单 ch3 拒绝）自有 failure 恰 1 条、不混入 device A 查询、反向亦然；查询响应 Cache-Control no-store / Referrer-Policy no-referrer、体无 NAS 路径/文件名/票明文/密码回显。
- **保留清理（retention.spec.ts，9 用例全绿）**：审计 30 天边界（occurred_at ≤ now-30d 删，恰 30 天删/29 天留；31 天删）；过期票 24h 严格 lt 边界（恰 24h 保留）；活跃 session 的过期票不删、终态 session 过期票删、活跃 session/转换本体不受清理影响；陈旧 ended session 保留而同期 failure_event 删除（互不误删）；FK RESTRICT 不误删媒体身份（media/source_entry/playback_source 父级原样保留）；连续两次清理幂等零删除；每日节拍定时清理 + 单拍异常不中断——**30 天/24h/活跃保护口径不影响个人数据**。
- **SC-004 验收口径逐条对齐（quickstart「SC-004：记录」）**：有效设备解析失败另记事件 ✓（e2e 生成组 + S9 组 1）；不可见媒体 ID 为空 ✓（e2e「mediaId=null」）；无效会话仅安全日志 ✓（e2e 401 零记录行 + S9 组 3）；owner 密码查询、非 owner/错误密码/跨家庭失败 ✓（e2e 查询组 + S9 组 4/5）；普通观看者仅自己的播放状态 ✓（S7-2 跨档案 GET 会话 403 + T035 矩阵）；终止原因/时间齐全 ✓（startedAt/endedAt/failureCode 逐键断言，interrupted endedAt 见 S8-6）；重试 stop 不重复记录 ✓（e2e 幂等用例）；30 天保留清理不影响个人数据 ✓（retention 9/9）。
- **T046 web 入口（已交付）**：apps/web/src/components/playback/DevicePlaybackRecords.tsx + api.ts `queryDevicePlaybackRecords`（POST /devices/{id}/playback-records/query 类型与调用）+ Devices.tsx 设备行「播放记录」面板接入；错误分流：403（REQUIRED/FAILED）提示并清密码、423 锁定提示禁用输入、401 交现有会话处理、404 固定文案不泄漏设备存在性；密码仅存组件内存、失败即清、不渲染 playbackSourceId/位置等源信息；nextCursor「加载更多」翻页、键盘可达。门禁（本轮实测复验）：`tsc --noEmit`（server+web）0 错误、`pnpm build` 全部成功（web 仅既有 >500kB chunk 警告，非失败）。
- **浏览器 UI 验收缺口（如实记录）**：真实浏览器操作 DevicePlaybackRecords 组件（家长输入密码→记录列表渲染→错误分流提示→翻页）不在本轮能力内。分层说明：runtime 层以「API 即 UI 数据源」承担——记录查询 API 的鉴权/字段/负向/隔离已在 HTTP 层全强度验证（上列 S9 + e2e），UI 组件由 T046 交付并过 tsc/build 门禁；浏览器 Network/UI 层验收归 T054/T055 浏览器链路层（与 SC-001/002/003 的浏览器缺口同一批），相关 SC 条目浏览器面保持未验收。
- **US1→runtime 暴露缺口的时间线（诚实记录，2026-10-25→26）**：T033 S8 首轮暴露「转码管线未接线（resolve/seek 相位无真实转换交付）+ direct seek 无重回 ready」→ 修复落地 ResolverConversionLaunchPort（playback.module 装配绑定）/prepareRebuild/registerLocalWindow/localWindow 交付分派，conversion-delivery.spec.ts 15 例单测先钉桥接管线（reserve→spawn→首产物→ok/BUSY/超时）、resolver 转码准备、seek/换轨自动重回 ready、真实 bridge 全链与资产窗口登记 → S8 升级为全强度断言：audio/video_transcode 真实交付（转码任务行实测 73–215ms，本轮两轮实测 73/161ms 与 78/172ms；入口 200 + 带票分片字节 66176B/116184B）、额度满 BUSY 实证（会话 failed + failureCode=PLAYBACK_CONVERSION_BUSY，本轮两轮均真实触发）、终态票门 401 PLAYBACK_TICKET_INVALID、seek 恢复 9–215ms ≪15s 预算（本轮两轮实测 8/216ms 与 10/216ms，均达标）；总断言 295→391。T034 节的「HTTP 层」结论以此补强：转码交付与换代恢复已由运行构建真实承担，无降级分支。
- **全量数字（2026-10-26 实测，本轮 T047 验证门禁）**：`pnpm --filter @hmp/server test` **961/961（61 文件，81.0s）0 失败**（含 records e2e 14/14、retention 9/9）；`pnpm test:runtime` **两轮全绿，S1–S9 总断言 445**（S6=77/S7=90/S8=96/**S9=54**；前值 391 由本轮改动前基线运行复确认）；`tsc --noEmit` 0 错误；`pnpm build` 通过；`pnpm lint` 0 错误（含一并清理 runtime-smoke 既有 2 处 no-unused-vars :1705/:1716 —— 去赋值保留调用，行为不变）。环境同基线节（Node v24.19.0/macOS arm64/Apple M4 Pro，FFmpeg 8.1.1 Homebrew；部署目标 Linux 证据缺口仍归 T057/T058）。

## US3 浏览器链路（T054/T055）

**状态（2026-10-26，T054/T055 交付）**：本节交付三部分——①US3-01～10 浏览器链路执行框架（与 quickstart「US3 浏览器场景清单（T048）」同 ID、同步骤、同记录格式对齐）、②环境缺口如实记录、③实现依据与等效验证层分层说明。**全部 10 个场景待执行**：本会话未产生任何浏览器 Network 证据（无 HAR、无真实浏览器会话记录），凡涉浏览器层的 SC/FR 条目保持未验收，不预填结果。

### 执行框架（US3-01～10，全部待执行）

通用约定（承 quickstart T048「通用约定」与「与 T054/T055 的衔接」，原文权威，此处仅对齐不改动）：

- 同一场景 ID、同一操作步骤、同一记录格式逐场景重跑并回填本节，不得增删场景或放宽期望；判定证据一律以浏览器 DevTools Network 导出（HAR）中的请求/响应（方法、状态码、body 字段、时序）为准，截图仅辅助 UI 状态，不得以截图或 DOM 断言替代网络证据。
- 每场景至少连续执行 2 次且结果一致方可记录；执行时的浏览器版本、设备/夹具可用性与限制随回填如实登记。
- 前置统一为：真实后端 + web 服务（启动方式见「执行脚本指引」，禁 mock、禁静态截图替代）；独立临时 DATA_DIR；T032 夹具（apps/server/test/fixtures/playback/ 的 generate-media.mjs 生成样本与 manifest.json 索引）及受控局域网上游 HLS；不用真实凭据或公开版权视频。档案A=已解锁成人档案（owner），档案B=受限档案（超龄/黑名单样本）。
- Network 记录：DevTools Network 面板勾选 Preserve log 全程录制，场景结束导出 HAR，命名 `US3-xx_<浏览器>_<YYYYMMDD>.har`；截图命名 `US3-xx_<浏览器>_<步骤号>.png` 仅辅助定位；多设备场景每设备各导出一份 HAR。

#### US3-01 详情入口 — 待执行

- **前置**：档案A；T032 H.264/AAC 受控 HLS 样本（经受控局域网上游）+ T032 NAS MP4 H.264/AAC 样本（media roots 只读挂载）。
- **操作步骤**：quickstart T048 场景表 US3-01 步骤 1–5，原样执行（本节不复制、不放宽）。
- **Network 判定锚点（HAR）**：详情查询 200；点击后 `POST /playback/resolve` 201 且 body=preparing、delivery/ticketExpiresAt/playbackUrl 均空；`GET /playback/sessions/{id}` 轮询至 ready；以返回 generation 调 `POST …/renew` 200 取 TicketReply；分片请求全部指向同源 `/playback/stream/…` 且带 ticket；HAR 中无原源地址/上游主机；上游 HLS 收不到应用 Cookie/Bearer。
- **UI 判定**：仅允许且可用媒体显示可用播放按钮并起播有声有画（FR-009）。实现对照：MediaDetail 播放入口仅对 GET /media/{id} 加载成功的媒体渲染；usePlaybackSession `run()`＝resolve→1s 轮询→ready→renew 首票→交付分派（direct 原生 / hls.js 完整构建 / Safari 原生 HLS）。
- **浏览器分列**：Chromium＝待执行；Firefox＝待执行；Safari＝待执行。
- **记录格式**：`US3-01_<浏览器>_<YYYYMMDD>.har`（resolve→renew→分片全链时序）+ 截图步骤 3/4。

#### US3-02 被禁 404 — 待执行

- **前置**：档案B（对超龄/黑名单标记样本）；档案A（对无源/停用源媒体）；T032 超龄/黑名单标记样本 + 停用源样本。
- **操作步骤**：quickstart T048 场景表 US3-02 步骤 1–4，原样执行。
- **Network 判定锚点（HAR）**：被禁/不可见/无源/跨家庭的 resolve 均 404 MEDIA_NOT_FOUND，各响应体同形（同一稳定码，逐字节可比对），无策略明细、无源位置；详情数据不返回被禁条目。
- **UI 判定**：无播放按钮或统一同形文案，不出现任何策略拒绝原因。实现对照：MediaDetail 对详情同形 404 显示统一文案、错误分支不渲染任何播放入口；resolve 404 文案取 api.ts `PLAYBACK_ERROR_LABELS.MEDIA_NOT_FOUND`（「内容不存在或暂不可观看」）——执行时按「同形且无原因泄漏」判定。
- **浏览器分列**：Chromium＝待执行；Firefox＝待执行；Safari＝待执行。
- **记录格式**：HAR（多组 404 响应体一致性比对）+ 截图。

#### US3-03 准备/取消/超时 — 待执行

- **前置**：T032 视频转码样本（如 mov-hevc8-aac-vtranscode）+ 上游慢速/永不完成注入。
- **操作步骤**：quickstart T048 场景表 US3-03 步骤 1–3（3a 取消分支与 3b 超时分支各执行一轮），原样执行。
- **Network 判定锚点（HAR）**：resolve 201 preparing 后按 1s 节奏出现 GET 轮询；3a) 取消后 `POST …/stop` 204（幂等），此后无 renew、无分片请求；3b) 轮询得 504 PLAYBACK_PREPARE_TIMEOUT 或终态 failureCode，session 终态且永不签票。
- **UI 判定**：显示「准备中」与可用取消按钮；取消回到详情页；超时显示稳定友好提示与重试入口，无 stderr/源信息。实现对照：MediaPlayer preparing 覆盖层（Spinner「准备中…」）、PlaybackControls「内容准备中…」+取消→`controller.stop()`；hook 轮询间隔 1s、preparing 防御上限 180s；超时文案来自 `PLAYBACK_ERROR_LABELS.PLAYBACK_PREPARE_TIMEOUT`。
- **浏览器分列**：Chromium＝待执行；Firefox＝待执行；Safari＝待执行。
- **记录格式**：HAR（轮询节奏、stop 时点、504 响应）+ 截图 preparing 态与超时文案。

#### US3-04 失败重试 — 待执行

- **前置**：T032 非法容器样本（必然探测失败）。
- **操作步骤**：quickstart T048 场景表 US3-04 步骤 1–5，原样执行。
- **Network 判定锚点（HAR）**：轮询返回 failed + 稳定 failureCode（如 PLAYBACK_FORMAT_UNSUPPORTED/422 族）；失败 session 不签票；重试产生新 session（新 id）的 resolve 201 并重新走 preparing→ready。
- **UI 判定**：显示稳定码对应友好原因；重试后回到准备流程，不自动无限重试。实现对照：hook `fail(failureCode)`→`PLAYBACK_ERROR_LABELS` 文案；`controller.retry()`→startToken+1 重开新 resolve（新 session id）；组件自身无自动重试路径。
- **浏览器分列**：Chromium＝待执行；Firefox＝待执行；Safari＝待执行。
- **记录格式**：HAR（failureCode 与新 session 建立证据）+ 截图失败文案。

#### US3-05 档案切换销毁 — 待执行

- **前置**：T032 慢转码样本；档案A 起播后切至档案B。
- **操作步骤**：quickstart T048 场景表 US3-05 步骤 1–4，原样执行。
- **Network 判定锚点（HAR）**：切换瞬间发出 stop 且轮询/定时器停止；旧代次 renew/seek 迟到响应到达后客户端不再基于旧 session 发任何请求（无旧 ticket 分片）；旧 expectedGeneration renew 得 409 PLAYBACK_GENERATION_STALE 不写票；旧 operationEpoch 响应即便携带新 generation 也被丢弃。
- **UI 判定**：播放器随档案切换销毁，旧代次响应不覆盖新界面、不复活播放。实现对照：MediaDetail 以 activeProfileId 变化 effect 关闭播放面板 + 播放器 `key={profileId:mediaId}` 强制重挂载；hook 卸载清理＝abort 在途请求+清全部定时器+hls.destroy+移除媒体 src+补发 stop；runId 代次守卫作废旧代次全部在途响应，operationEpoch 守卫丢弃旧 epoch 的 renew/seek 响应。
- **浏览器分列**：Chromium＝待执行；Firefox＝待执行；Safari＝待执行。
- **记录格式**：HAR（切换时间点后无旧 session 请求为关键证据）+ 截图。

#### US3-06 续期连续性 — 待执行

- **前置**：档案A；**≥15 分钟自制 HLS 与 MP4 样本各一**（T032 缺省样本为 3 秒参数矩阵基线，不承载 15 分钟连续播放——见「T054 特定项」与「执行脚本指引」的准备说明）。
- **操作步骤**：quickstart T048 场景表 US3-06 步骤 1–5（含步骤 5 Safari 原生 HLS 轮换入口单独复验），原样执行。
- **Network 判定锚点（HAR）**：每次 `POST …/renew` 在 ticketExpiresAt 前 60 秒发出、expectedGeneration 匹配并 200 换票；分片在新旧 ticket 间平滑切换，无 401/403 中断；GET 不重签不复现旧票；positionSeconds 单调连续。
- **UI 判定**：连续播放 ≥15 分钟跨 ≥2 次续期全程有声有画，不重置到 0、不黑屏重启（SC-001）。实现对照：hook 按 ticketExpiresAt−60s（`PLAYBACK_RENEW_LEAD_SECONDS=60`）调度 renew，expectedGeneration 随会话核心；hls.js 轮换＝loadSource(新入口)+startLoad(当前位置)；原生 HLS/direct 轮换＝换 src+loadedmetadata 恢复逻辑位置（research R8）。
- **浏览器分列**：Chromium＝待执行；Firefox＝待执行；Safari＝待执行（**必须原生 HLS 实测，不得仅以 hls.js 模拟代替**）。
- **记录格式**：HAR（renew 时间点 + 分片连续性）；逐次记录续期时刻与播放位置。

#### US3-07 seek — 待执行

- **前置**：T032 MP4（NAS 影片）+ 转码样本 + 直播样本。
- **操作步骤**：quickstart T048 场景表 US3-07 步骤 1–5（含步骤 5 恢复前立刻再发 seek/换轨制造交错），原样执行。
- **Network 判定锚点（HAR）**：`POST …/seek` 200 返回 preparing + 新 generation/version 且无票；旧 ticket 分片随即使 401/404 拒绝；ready 后以新 generation renew 200 取新票；seek→renew→新分片命中目标区间总时序 ≤15 秒；直播样本 seek 返回 400 PLAYBACK_SEEK_UNSUPPORTED。
- **UI 判定**：进度条为影片逻辑时间，不闪回目标前画面；恢复于目标位置；直播不提供 seek。实现对照：PlaybackControls 影片逻辑进度条（durationSeconds，直播 null 不渲染进度条）+「将跳过目标前画面」提示（presentationStartSeconds）；hook seek＝发送前递增 operationEpoch→expectedVersion CAS→受理 preparing 挂起（hls stopLoad、撤销例行续期）→轮询接回 ready→新代 renew；恢复点＝positionSeconds−timelineOffsetSeconds 夹紧 presentationStartSeconds；409 竞态族丢弃意图不破坏当前播放。
- **浏览器分列**：Chromium＝待执行；Firefox＝待执行；Safari＝待执行。
- **记录格式**：HAR（时序计时 + 旧票拒绝证据）+ 截图进度条。

#### US3-08 字幕/音轨 — 待执行

- **前置**：T032 多音轨/多字幕样本 + 恶意字幕样本。
- **操作步骤**：quickstart T048 场景表 US3-08 步骤 1–5，原样执行。
- **Network 判定锚点（HAR）**：纯字幕切换 `PUT …/selection` 200 仅 version+1、返回现状态，无 preparing、无新票、无重新初始化分片（不重启视频）；切换音轨 generation/version 各+1 进入 preparing 无票，ready 后 renew 新票并重建音轨；字幕响应 text/vtt 且恶意内容不以 HTML 执行。
- **UI 判定**：字幕即时生效不黑屏；音轨切换经 preparing 后恢复；关闭/选择状态正确保持。实现对照：hook selectTracks 双轴必填回落（最近意图→default→首个已探测）；纯字幕切换不换代、现票仍有效仅刷新会话核心；音轨换代走 preparing 挂起链；PlaybackControls 字幕菜单（关闭/选择）与音轨菜单、「字幕切换中…不中断播放」/「正在切换音轨…」提示。
- **浏览器分列**：Chromium＝待执行（hls.js 完整构建，非 light）；Firefox＝待执行（hls.js 完整构建，非 light）；Safari＝待执行（经原生轨道菜单复验并记录与 hls.js 差异）。
- **记录格式**：HAR（selection 前后 version/generation 差异）+ 截图轨道菜单。

#### US3-09 资源忙 — 待执行

- **前置**：两个不同 T032 转码样本；设备1=Chromium、设备2=Firefox（双端交叉；步骤 5 以配置并发 2 重复一轮）。
- **操作步骤**：quickstart T048 场景表 US3-09 步骤 1–5，原样执行。
- **Network 判定锚点（HAR）**：设备2 立即收到稳定忙（503 PLAYBACK_CONVERSION_BUSY，经 resolve 拒绝或 session failureCode 呈现），无排队任务产生；直接播放样本同时不受影响可起播；设备1 stop 释放额度后设备2 重试成功。
- **UI 判定**：立即显示「资源忙/稍后重试」友好提示，无排队进度条，可手动重试。实现对照：`PLAYBACK_ERROR_LABELS.PLAYBACK_CONVERSION_BUSY`＝「当前播放任务较多，请稍后重试」，failed 文案+重试入口由 PlaybackControls 呈现；服务器侧 BUSY 语义已有 S8 实证（见「已完成的实现依据与等效验证层」），本场景验收其浏览器呈现面。
- **浏览器分列**：Chromium＝待执行；Firefox＝待执行；Safari＝—（T048 表本场景为 Chromium+Firefox 双端交叉，Safari 不在本场景必需列）。
- **记录格式**：双设备各一份 HAR。

#### US3-10 停止/失联 — 待执行

- **前置**：T032 任一可播样本。
- **操作步骤**：quickstart T048 场景表 US3-10 步骤 1–5（含 copy as fetch 重放停止前分片、关闭标签页模拟失联），原样执行。
- **Network 判定锚点（HAR）**：`POST …/stop` 204 且重复 stop 幂等不重复记录；停止后旧 ticket 的 manifest/分片重放均 401/404；GET 返回终态但不再签票；失联后服务端按判定回收（回收时序细节归 T058 后端证据），浏览器侧旧响应不复活任何播放。
- **UI 判定**：播放器释放回详情页，无自动复活/重启。实现对照：`stopPlaybackSession`/卸载清理＝补发 stop（幂等 204）+本地资源释放；心跳 15s 为活性信号、连续 3 次瞬时失败有界停止（≈45s 失联同量级）；终态收敛幂等，旧响应不能复活播放。
- **浏览器分列**：Chromium＝待执行；Firefox＝待执行；Safari＝待执行。
- **记录格式**：HAR（stop 后旧 ticket 重放被拒为关键证据）。

### 环境缺口（如实记录，2026-10-26）

**缺口本体**：本会话环境为 macOS 开发机，无真实 Chromium/Firefox/Safari 对真实服务的完整 Network 执行编排——无浏览器自动化夹具与受控上游启动编排、无 DevTools HAR 程序化采集、无 ≥15 分钟真实播放会话承载。T054/T055 要求的浏览器 Network 层验收本轮**一项都未执行**，逐项缺口如下（SC 台账节保持原样未改动，相关条目维持未验收）：

| 缺口项 | 缺口内容 | 对应场景 | 状态 |
|---|---|---|---|
| SC-001 浏览器面 | 解析 P95 ≤1s 逐次记录；HLS 与 NAS MP4 各 20 次起播 ≥19 成功；≥15 分钟连续播放跨两次续期不重置位置；Network 全程同源且无原 URL/上游主机 | US3-01/US3-06 | 未验收 |
| SC-002/003 浏览器面 | 被禁/无源/跨家庭的 UI 门控与同形 404 展示（响应体逐字节同形、无策略明细泄漏） | US3-02 | 未验收 |
| SC-005 浏览器负向 | 档案切换瞬间销毁播放器、旧代次响应不覆盖、切换时间点后无旧 session 请求 | US3-05 | 未验收 |
| SC-007 浏览器面 | 四处理路径（direct/remux/audio/video）真实起播有声有画各 ≥15 分钟；seek 与续期；Safari 原生 HLS 连续两次续期轮换（不得仅以 hls.js 模拟）；Chromium/Firefox/Safari 分内核支持路径记录 | US3-01/06/07/08 | 未验收 |
| SC-008 浏览器面 | 停止/失联后 UI 释放回详情页、旧票重放 401/404、无自动复活 | US3-10 | 未验收 |
| SC-009 浏览器面 | 准备超时/资源忙/性能不足的稳定文案与取消/重试体验 | US3-03/04/09 | 未验收 |
| FR-009/FR-010 浏览器验收 | 入口可见性与起播体验；准备/失败/忙/超时友好提示与取消/重试入口 | US3-01～05/09 | 未验收 |
| FR-014 浏览器侧 | 每必验样本「有声有画 15 分钟」须真实浏览器/真人会话承载 | US3-06/07（T055） | 未验收 |

执行约束重申（quickstart T048 衔接约定）：结果串行回填本节各场景「待执行」位并附 HAR/环境/限制；缺浏览器/夹具的缺口不得以静态截图或历史后端 HTTP 证据替代浏览器 Network 层验收；任一场景重跑失败即保持对应 SC 条目未验收并记录失败证据。

### 已完成的实现依据与等效验证层（实现完成 ≠ 浏览器验收）

**边界声明**：下列内容为代码实现事实与后端/HTTP 层等效证据，仅说明「实现已就绪、服务器侧行为已有实测」；它们不构成 T054/T055 要求的浏览器 Network 层验收，与浏览器证据分层记录、不得互相替代。

**前端组件实现要点（各场景 Network/UI 判定的预期来源）**：

- `apps/web/src/components/playback/usePlaybackSession.ts`（T053，会话状态机核心）：起播链 resolve→1s 轮询（abortable）→ready→renew 首票→交付分派；续期按 ticketExpiresAt 前 60s 调度、携带 expectedGeneration、稳定失败（GENERATION_STALE/ENDED/授权失效/404）收敛为文案停止、瞬时网络失败限一次立即重试；**operationEpoch 守卫**——seek/selection 发送前递增本地 epoch，响应（含 renew）仅当「发起时 epoch 仍等于当前 epoch 且 session/generation 链一致」才安装，旧请求即便返回 200/新 generation 也整体丢弃；**心跳 15s**（暂停继续；连续 3 次瞬时失败有界停止，≈45s 失联同量级）；**stop/cancel/unmount 补发 stop（幂等 204）**并释放本地资源（abort 在途、清定时器、hls.destroy、移除媒体 src）；runId 代次守卫作废旧会话全部在途响应（US3-05）；**ticket/playbackUrl/ticketExpiresAt 仅存内存 ref，不写 localStorage/sessionStorage/日志**。
- `MediaPlayer.tsx`（T050/T053 外壳）：交付分派 delivery=direct→原生 MP4；HLS 系→`Hls.isSupported()` 优先 hls.js 完整构建（禁 light，R1）→否则 Safari 原生 HLS 探测（`canPlayType('application/vnd.apple.mpegurl')`）；hls.js 轮换＝loadSource+startLoad(恢复位置)，原生 HLS/direct 轮换＝换 src+loadedmetadata 恢复逻辑位置；preparing 覆盖层与 failed/ended Alert（文案取 PLAYBACK_ERROR_LABELS）；原生 controls 不启用（进度条归 T051 逻辑时间轴）。
- `PlaybackControls.tsx`（T051）：影片逻辑进度条（duration=durationSeconds，直播 null 不渲染 seek）；seek 受理后「跳转中」禁用态、滑块保持目标位置不闪回；presentationStartSeconds>0 附加「将跳过目标前画面」提示；字幕关闭/选择与音轨切换菜单（当前选中态由 default+最近意图推断）；preparing 取消/failed 重试（文案一律 PLAYBACK_ERROR_LABELS，覆盖忙/超时/资源不足/性能不足各码）；键盘可达、role="status" aria-live 播报。
- `MediaDetail.tsx`（T052）：GET /media/{id} 对被禁/不可见/不存在/跨家庭/无可用资源统一同形 404→统一文案，错误分支不渲染播放入口（可见性门控以服务端为准）；播放面板 key=`${profileId}:${mediaId}`，档案/id 变化即卸载销毁并丢弃已捕获的 state/controller/mediaApi，旧代次意图无从发出；seek/selection 意图经 usePlaybackSession mediaApi 转发，页面不自行记账 version。
- `api.ts`（T049）：resolve/GET/renew/heartbeat/stop/selection/seek 全契约封装（renew 保留 session/generation 语义注释）；`PLAYBACK_RENEW_LEAD_SECONDS=60`；`PLAYBACK_ERROR_LABELS` 稳定码→中文友好文案全词表映射（`Record<PlaybackStableErrorCode|'MEDIA_NOT_FOUND', string>` 编译期逐码完备，未知码调用方兜底）；票安全约束（playbackUrl/ticketExpiresAt 不入 storage/日志）以文件注释钉死。
- **web 门禁（本轮实测）**：`tsc --noEmit` 0 错误、`pnpm build`（vite）成功（仅既有 >500kB chunk 警告，非失败）、`pnpm lint` 0 错误。

**后端 HTTP 层等效证据（引用本台账前文节，不重复）**：

- T034 节（US1 checkpoint）：playback-control 39 用例 + playback-stream 21 用例 e2e 全绿；resolve 201 preparing/delivery=null → GET 轮询 ready → renew 取票 → 媒体网关 200/206/416/HEAD/断开取消/流后 failure_code 可轮询；限频 429+Retry-After 实测；四处理路径单测/契约层验证。
- T041 节（US2 负向矩阵）：playback-authorization 34 用例 + input-security 33 用例 + runtime S7 真实 HTTP 90 断言（切档案/收紧策略/注销/停源后下一请求拒绝、同形 404、零泄漏扫描）——US3-02/05 浏览器负向场景的服务器侧对应层。
- T047 节（S8/S9 时间线）：S8 转码真实交付（audio/video_transcode 转码任务行实测 73–215ms、带票分片字节交付）、额度满 BUSY 实证（会话 failed + failureCode=PLAYBACK_CONVERSION_BUSY）、终态票门 401 PLAYBACK_TICKET_INVALID、seek 恢复两轮实测 8/216ms 与 10/216ms（预算 15s）；S9 记录域真实 HTTP 54 断言。
- 上述均为服务器/HTTP 层实测；浏览器 Network 面（同源入口、HAR 时序、UI 呈现）仍以本节 US3-01～10 执行为准。

### T054 特定项（FR-014 与性能预算的分层说明）

- **FR-014「每必验样本有声有画 15 分钟」**：T032 样本生成器已就绪（apps/server/test/fixtures/playback/generate-media.mjs + manifest.json 单一事实源：5 容器 × H.264/HEVC 8/10bit/MPEG-4 × AAC/AC3/EAC3/DTS 四路径 + 非法/4K/HDR 形态；缺省样本 3 秒/128×96 合成基线，参数与 probe 形态可复现）——但「15 分钟真实播放」须 ≥15 分钟样本由真实浏览器/真人会话承载，T032 样本不承载该时长；此项保持**未验收**（执行时按 US3-06/US3-07 以 ≥15 分钟自制样本承载，生成方式见「执行脚本指引」）。
- **转换首帧 ≤30s / seek ≤15s**：服务器侧预算证据已有——S8 实测转码任务行 73–215ms（起播面）、seek 恢复两轮 8/216ms 与 10/216ms（T047 节），均远低于预算；**此为服务器侧计时**。端到端浏览器首帧证据（US3-01 步骤 4 ≤10 秒出声有画、US3-07 步骤 4 ≤15 秒画面恢复的 HAR 计时）仍缺，保持**未验收**。
- **解析 P95 ≤1s**：HTTP 层有整体 runtime P95 基线（T002 节 70ms，003 场景口径）；004 resolve 的逐次 P95 记录归浏览器执行时（US3-01，20 次起播逐次记录），当前保持**未验收**。

### 执行脚本指引（供具备浏览器环境的维护者）

1. **环境登记**：记录浏览器版本（Chromium/Firefox/Safari 各自 about:version 或 user-agent）、Node/pnpm、FFmpeg 版本/编码器、CPU/内存/架构，对齐 quickstart「环境」节要求；确认非 mock、真实服务。
2. **夹具准备**：
   - `node apps/server/test/fixtures/playback/generate-media.mjs --out <目录>`——以 manifest.json 为单一事实源逐样本 lavfi 合成并 ffprobe 复核；产物与 manifest.instance.json 落 outDir、不入库；`--verify-only` 可复检既有产物。
   - **≥15 分钟样本（US3-06 与 FR-014 必需）**：T032 缺省样本仅 3 秒，需按同一 lavfi 合成手法另行生成 ≥15 分钟自制 HLS 与 MP4 各一（记录生成参数入证据）；受控局域网上游 HLS 按 quickstart 前置准备（私有临时只读上游，LAN 许可入服务端配置）。
3. **启动服务**（仓库根，全部使用独立临时 DATA_DIR，禁指向用户库）：
   - 迁移：对临时 DATA_DIR 执行 `pnpm migration:up`；
   - 后端：`pnpm --filter @hmp/server dev`（tsx watch，PORT 缺省 3000；`DATA_DIR`、`MEDIA_ROOTS`（如 `videos=<夹具目录>`）、`LAN_ALLOWED_TARGETS` 按夹具拓扑设置）；
   - 前端：`pnpm --filter @hmp/web dev`（vite，端口 5173，`/api` 代理至 `http://localhost:3000`，Cookie 同源依赖该代理保持）；
   - 可选冒烟：执行一轮 `pnpm test:runtime` 确认服务与夹具健康后再开浏览器。
4. **逐场景执行顺序**：按 T048 表序 US3-01→US3-10；每场景在干净 Network 记录下独立执行、至少连续 2 次且结果一致；US3-05 需档案A/B 双档案就绪，US3-06 需 ≥15 分钟样本（Safari 一轮必须原生 HLS），US3-09 需 Chromium+Firefox 双设备，US3-10 需在 DevTools 内 copy as fetch 重放旧分片。
5. **HAR 收集**：DevTools Network 勾选 Preserve log（+Disable cache）全程录制→场景结束 Save all as HAR→命名 `US3-xx_<浏览器>_<YYYYMMDD>.har`；截图 `US3-xx_<浏览器>_<步骤号>.png` 仅辅助；多设备各一份；判定以 HAR 请求/响应（方法/状态码/body 字段/时序）为准。
6. **回填与串行约束**：结果（含每场景 HAR 路径、环境与限制、失败证据）串行回填本节各场景「待执行」位；不得增删场景或放宽期望；与 api.ts/runtime-smoke 不得并行编辑（tasks.md 执行顺序约束）；任一场景失败即保持对应 SC 条目未验收；缺浏览器/夹具不得以静态截图或历史后端 HTTP 证据替代浏览器 Network 层验收。

## Polish（T056–T059）

T056–T059 已全部执行并回填，见以下子节。

### T056 迁移演练（2026-10-26）

**执行环境**：本机 macOS arm64；node v24.19.0；pnpm 11.28.5；sqlite3 CLI 3.54.0（/usr/bin/sqlite3）；better-sqlite3 13.0.3（migrate.ts 实际使用版本）。全部步骤使用 `mktemp -d` 生成的独立临时 DATA_DIR（下文脱敏写作 `$TMP`，实际为 /tmp 下随机目录），活动库 `<$TMP>/drill1/hmp.db`。**声明：本轮全部命令仅针对 os.tmpdir 独立临时库执行，未对任何用户库执行 down/drill/备份覆盖，未触碰仓库内 db 文件。**

**1. 建独立临时库并应用 0001–0005**（`DATA_DIR=$TMP/drill1 pnpm --filter @hmp/server exec tsx src/database/migrate.ts up`）：

```
[migrate] 命令=up 数据库=$TMP/drill1/hmp.db
[migrate] 已应用 0001_init / 0002_profile_policy / 0003_media_catalog / 0004_manual_epg_binding / 0005_playback
[migrate] 完成:共 5 条(备份: hmp.db.bak-…)
```

**2. 填充代表数据**（sqlite3 CLI，连接内 `PRAGMA foreign_keys=ON`，插入即验证外键）：household / account / profile / device / device_session / media_source(nas) / source_entry / media_item×2 / playback_source / playback_session×2（`interrupted`：ended_at 必填、failure_code 必空；`paused`：source+delivery 必非空）/ playback_ticket×2（expires_at>issued_at，其一指向 interrupted 会话且 revoked_at=NULL）/ playback_conversion / playback_failure_event 各 1–2 行，列值对齐各表 CHECK。插入后 `PRAGMA integrity_check`=ok、`PRAGMA foreign_key_check` 无行。

**3. 备份**：选 `VACUUM INTO`（与 migrate.ts 内建备份同语义），弃「直接复制 db+wal+shm 三件」：WAL 下 VACUUM INTO 产出单文件、已检查点的完整一致性快照，天然规避半写副本。先 `PRAGMA wal_checkpoint(TRUNCATE)`，再 `sqlite3 $DB "VACUUM INTO '$TMP/drill1/backup-t056.db'"`。备份 sha256=`bbb91f9281546aaa0b38bf14e658ad9a89b58ea52e303e4781df7da1d6d7c891`。

**4. 活动库变更**：备份后插入 `sess-t056-live`（state=`playing`、delivery=`direct`）+ `tkt-t056-live`，playback_session 2→3、playback_ticket 2→3。

**5. 恢复与校验**（`rm -f $DB-wal $DB-shm && cp backup-t056.db hmp.db`；执行前所有连接已关闭、wal 已 checkpoint 清零）：
- 恢复后库文件 sha256 与备份**逐字节一致**（`bbb91f92…d7c891`）；
- `PRAGMA integrity_check` → `ok`；`PRAGMA foreign_key_check` → 无行（`fk_violation_rows=0`）；
- **逐值比较 PASS**：对 13 张有数据表 + `_migrations` 以 `SELECT * ORDER BY rowid` 的 JSON dump 前后 `diff`，逐值一致；
- 备份后新插入的会话/票随恢复消失：`new_session_gone=YES`、`new_ticket_gone=YES`，行数回到 2/2；
- **恢复票不复活**（对齐 T006 playback-migration.e2e-spec.ts「备份恢复」用例口径，以库内容为准）：恢复后 `tkt-t056-01` 行在且 `revoked_at=NULL`，其载体 `sess-t056-01` state=`interrupted`（∉ ready/playing/paused，非活动载体）；按同款 issuable 谓词（`revoked_at IS NULL AND expires_at > 演练时刻 AND 载体 state IN ('ready','playing','paused')`）查询 → **0 行**。（备份点即 paused 的 `sess-t056-02` 系原代表数据原样恢复，非复活票；其票 `tkt-t056-02` 已于 00:45:02Z 过期，同样不可签发。）

**6. drill（另一独立临时目录）**（`DATA_DIR=$TMP/drill2 pnpm --filter @hmp/server exec tsx src/database/migrate.ts drill`，exit=0）：

```
[migrate] drill 阶段 1/3:up … 已应用 0001_init～0005_playback / 完成:共 5 条
[migrate] drill 阶段 2/3:down … 已回滚 0005_playback
[migrate] drill 阶段 3/3:up … 已应用 0005_playback / 完成:共 1 条
[migrate] drill 通过:已应用 [0001_init, 0002_profile_policy, 0003_media_catalog, 0004_manual_epg_binding, 0005_playback],表 [household, …, playback_session, playback_ticket, playback_conversion, playback_failure_event, _migrations] 全部存在
```

EXPECTED_TABLES 全 22 表（含 0005 四表）与 EXPECTED_COLUMNS 关键列校验在命令内通过。

**7. down 专项（在已填数据临时库 drill1）**：
- `… migrate.ts down` → `已回滚 0005_playback`（exit=0）；down 后：0005 四表全部消失（sqlite_master 仅余 0003 的 playback_source）、`device_household_id_id_key` 索引消失、`_migrations`=0001–0004、0001–0004 九张有数据表逐值 `diff` → **不变 PASS**；`integrity_check`=ok、`foreign_key_check` 无行；
- `… migrate.ts up` → `已应用 0005_playback`（exit=0）；再 up 后：四表恢复且全为 0 行（0005 不恢复播放数据，与 drill 终态等价）、EXPECTED_COLUMNS 关键列 session 6/6、ticket 2/2、conversion 4/4、failure_event 2/2 齐备、`device_household_id_id_key` 恢复、`_migrations` 回到 5 条、0001–0004 数据仍逐值不变 **PASS**。

每条 migrate.ts up/down 执行时各自生成 VACUUM INTO 备份（`hmp.db.bak-*`），全部位于临时目录、未入库。

### T057 部署配置（2026-10-26）

**已落实项（配置层交付；非镜像实测）**

- **docker-compose.yml（根目录，重写）**：
  - 非 root：镜像内 `USER node`（uid/gid 1000）承载，compose 不另设 user 字段（注释说明可显式 `user: "1000:1000"`）；
  - 只读根 + 私有写缓存：`read_only: true`、具名卷 `hmp-data:/data`（SQLite/迁移备份/播放转换私有 HLS 缓存，应用层预算 2GiB 全局/512MiB 任务/1GiB 余量阈值不变）、`tmpfs /tmp`；
  - NAS 只读：`./nas-media/videos:/media/videos:ro` 占位绑定（注释指向宿主 NAS 路径）+ `MEDIA_ROOTS: videos=/media/videos`；
  - 硬件显式映射：`/dev/dri` 设备映射**注释化默认不启用**（VAAPI/QSV 仅 amd64 典型 + render 组 gid 说明、NVENC 需 nvidia-container-toolkit、arm64 不假定硬件加速），均非特权传递；
  - cgroup 限制：`deploy.resources.limits` `cpus: '4.0'` / `memory: 4g`（quickstart 4CPU/4GiB 基线）；缓存限额由应用预算强制，不依赖容器层（注释说明）；
  - 环境变量示例：`DATA_DIR`、`DB_FILENAME`、`MEDIA_ROOTS`、`LAN_ALLOWED_TARGETS`（精确 host:port/CIDR 占位）、`PLAYBACK_CONVERSION_CONCURRENCY=1`、`PLAYBACK_SOFTWARE_THREADS=2`、`PLAYBACK_TICKET_TTL_SECONDS=300`；
  - 无 `privileged`、无宿主 docker.sock、无 `pid: host`；附加 `security_opt: no-new-privileges:true`。
- **Dockerfile 核对：本任务零改动**。runtime 阶段已有 `USER node`（L86）与 `apt-get install -y --no-install-recommends ffmpeg`（T004，L72–74，bookworm 5.1.x，ffmpeg+ffprobe 同包）；只读根兼容性核对：容器启动迁移（`migrate.js up`）、HEALTHCHECK fetch、转换缓存写入仅落 `/data` 与 `/tmp`，与 `read_only: true` 无冲突。
- **语法验证（实际执行）**：`docker compose config` PASS（exit 0；docker CLI 在位、Compose v5.5.0、daemon 29.8.2；daemon 不影响 config 渲染）。渲染确认 `read_only`/`tmpfs`/`limits(cpus 4, memory 4GiB)`/`readonly` bind 全部生效。
- **quickstart.md**：SC-006 节增补「部署命令与验证步骤（T057）」——compose 启动、非 root/只读根/只读 NAS 写测试、迁移单独执行（stop → `compose run migrate` → start）、缺列 503 与缺 FFmpeg 能力失败验证步骤、双架构构建命令。

**镜像证据缺口（如实记录；SC-006 部署部分保持未验收）**

- Docker Hub 不可达 2026-10-26 复现：`docker pull debian:bookworm-slim` → `Error response from daemon: Head "https://registry-1.docker.io/v2/library/debian/manifests/bookworm-slim": net/http: TLS handshake timeout`（与 T004 记录一致）；本机亦无 `home-media-platform:local` 缓存镜像。
- 因此 **linux/amd64 与 linux/arm64 的镜像构建、启动、迁移、缺列 503、缺 FFmpeg 能力失败全部未实测**，SC-006 部署证据保持未验收；硬件加速与 4CPU/4GiB 性能阈值归 T058 真实 Linux 实测。

**构建期复核命令清单（供具备 registry 访问的维护者逐项执行；amd64/arm64 各执行一遍）**

```sh
# 0) 双架构构建（各平台在对应原生主机或推 registry 后验证,不以仿真互代）
docker buildx build --platform linux/amd64 -t hmp:verify --load .
docker buildx build --platform linux/arm64 -t hmp:verify --load .

# 1) 非 root + ffprobe/ffmpeg 存在与版本/编码器（同一 ffmpeg 包提供两个可执行）
docker run --rm hmp:verify sh -c 'id; ffprobe -version | head -1; ffmpeg -version | sed -n 3p'
# 期望: uid=1000(node) gid=1000(node);ffprobe/ffmpeg 5.1.x;configuration 含 --enable-gpl --enable-libx264

# 2) 只读根 + 私有卷 + 只读 NAS 启动与迁移（独立临时卷,禁指向用户库）
docker volume create hmp-verify
docker run -d --name hmp-verify --read-only --tmpfs /tmp \
  -v hmp-verify:/data \
  --mount type=bind,src=<宿主NAS目录>,dst=/media/videos,readonly \
  -e MEDIA_ROOTS='videos=/media/videos' -e LAN_ALLOWED_TARGETS='<受控上游>' \
  -p 3000:3000 hmp:verify
docker exec hmp-verify id                                              # 期望 uid=1000(node)
docker exec hmp-verify sh -c 'touch /usr/x 2>/dev/null && echo FAIL || echo RO-OK'   # 期望 RO-OK（只读根）
docker exec hmp-verify sh -c 'touch /data/.rw && rm /data/.rw && echo DATA-OK'       # 期望 DATA-OK（私有卷可写）
docker exec hmp-verify sh -c 'touch /media/videos/x 2>/dev/null && echo FAIL || echo NAS-RO-OK'  # 期望 NAS-RO-OK
curl -f http://127.0.0.1:3000/api/healthz      # 期望 200 {status:ok,database:ok}（CMD 已先迁移 0005 up）

# 3) 缺列 503 场景模拟（CMD 会自动迁移,故以迁移后删列触发就绪检查失败）
docker exec -w /app hmp-verify node -e "require('better-sqlite3')('/data/hmp.db').exec('ALTER TABLE playback_session DROP COLUMN generation')"
curl -i http://127.0.0.1:3000/api/healthz      # 期望 503 RFC9457 code=NOT_READY;目录/鉴权既有端点不失效;不自动补列
# （恢复：docker restart hmp-verify 不可复原删列——复核后销毁临时卷重建即可）

# 4) 缺 FFmpeg 能力失败场景模拟
# 构建临时镜像：同 Dockerfile 删除 runtime 的 apt-get install ffmpeg 行
# 期望：需转换的 resolve → session failed，稳定码 PLAYBACK_RESOURCE_UNAVAILABLE（进程无法启动）
#       或 PLAYBACK_FORMAT_UNSUPPORTED（编码器缺失）；direct 可播内容、目录与鉴权不受影响；healthz 仍 200

# 5) cgroup 限制生效复核
docker inspect hmp-verify --format '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}'   # compose 路径经 deploy.limits 落到对应字段
docker stats --no-stream hmp-verify
# 清理：docker rm -f hmp-verify && docker volume rm hmp-verify
```

### T058 硬件与资源证据（2026-10-26）

**性质声明（仿真不作为硬件证明）**：本节只做一件事——把「已有实测」与「环境缺口」严格分开。本轮全部执行发生在 macOS arm64 开发机（Apple M4 Pro；本机 FFmpeg/ffprobe 8.1.1 Homebrew GPL 构建 libx264/libx265/aac；部署目标为镜像内 Debian bookworm **ffmpeg 5.1.9**——research「对 R4 预算的影响备注」明确 30 秒/15 秒等指标必须在 5.1.9 目标内实测，不得以本机 8.1.1 外推）。下列已实测为本机软件转码基线与假时钟/假进程单测，**均不构成真实 Linux 硬件加速、无硬件软件回退（arm64）或 4CPU/4GiB 容器基线的证据**；即便以 amd64 仿真（qemu）执行，也仅证明镜像启动，不作为硬件加速证明（quickstart SC-006 节同口径）。SC-007（硬件路径）/SC-009（资源判定）在 SC 台账维持「未验收」，本节零改动台账。

#### 1. 已实测（服务器侧，macOS arm64 本机；全部真实执行；非部署目标 Linux、非硬件加速证据）

**A. S8 runtime 真实 HTTP/FFmpeg 场景**（apps/server/test/runtime-smoke.mjs；`pnpm test:runtime` 两轮全绿、总断言 445，全量数字见 T047 节，此处仅列 T058 相关项）：

- **转码任务墙钟**（S8-1b/1c，:1648–1659）：audio/video_transcode 真实 ffmpeg 任务行 started_at→ended_at 实测 **73–215ms**（两轮 73/161ms 与 78/172ms）；带票分片字节 66176B/116184B 交付（全强度断言）。
- **并发=1 额度 BUSY 真实触发**（S8-4，:1784–1818；两轮并发 resolve 竞 reserve + 错峰注入）：挑战会话 failed + failureCode=**PLAYBACK_CONVERSION_BUSY**，winner 照常 ready（额度串行不连坐、无排队）。
- **seek 恢复 ≤15s**（S8-3 direct / S8-3b 转码真实重启，:1691/:1727）：两轮 direct **8/216ms**、转码 **10/216ms**，均远低于 15s 预算；转码 preparing 窗口 renew 409 PLAYBACK_NOT_READY。
- **失联 45s 回收**（S8-6，:1846–1866）：session→interrupted（endedAt 非空、failureCode 空）；旧票 URL GET 401 PLAYBACK_TICKET_INVALID；终态 renew 409 NOT_READY、旧票受 TTL 预算约束。
- **停止/取消**（S8-5，:1823–1838）：preparing 期 stop → 终态 ended、幂等且不再转 ready；corrupt 样本轮询至 failed + 稳定失败码（截头破坏 box 预期 PLAYBACK_FORMAT_UNSUPPORTED）。
- **重启恢复**（S8-8，:1891–1900）：recoverOnBoot——活动会话全 interrupted、私有根孤儿任务目录清理、目录/名单/EPG 数据保留、新 resolve→renew→GET 起播可用。

**B. 单测（假时钟/假进程层；`pnpm --filter @hmp/server test` 961/961 全绿，T047 节）——证明的是调度/判罚语义，不是真实 Linux 资源数值**：

- conversion.spec.ts「超时与速度看门狗」（:1379–）：首帧 30 秒无输出恰好一次终止（:1380）；seek 相位 15 秒硬超时 PLAYBACK_SEEK_TIMEOUT（:1395）；每 10 秒采样 30 秒窗口、连续 3 次 speed<1 且可播缓冲<8s → PLAYBACK_PERFORMANCE_INSUFFICIENT（:1410）；速度恢复 ≥1x 打断连续计数不判罚（:1436）；缓冲 ≥8s 不判罚（:1466）；主动暂停/有界预取节流期不采样判罚、恢复后重新武装完整 15 秒无输出期限（:1485/:1502）；非正常等待 15 秒无输出 → PLAYBACK_RESOURCE_UNAVAILABLE（:1524）。
- conversion.spec.ts「generation/取消/回收」（:1680–）：seek 升代旧任务 **SIGTERM→5 秒宽限→SIGKILL** 序列 + interrupted（:1681）；退出确认后才释放额度（:1712）；generation 私有目录互斥隔离（:1747）。
- conversion.spec.ts「磁盘上限」（:1598–）：任务 512MiB / 全局 2GiB / 数据卷余量 <1GiB 拒新转并停止续写（:1603/:1617/:1632/:1639）；**清理失败 pending 仍计预算、60 秒重试成功后释放**（:1650）。
- conversion.spec.ts「软件回退」（:1135–）：硬件启动失败 → 软件回退**一次**且共用原 30 秒期限（期限不重置，:1167）；硬件+软件均失败 → PLAYBACK_RESOURCE_UNAVAILABLE 最多 2 次 spawn（:1205）；探测不可用 → 直接软件路径仅一次 spawn（R7 arm64 不假定硬件，:1227）。
- lifecycle.spec.ts：**45 秒失联回收**链（:444）；15 秒心跳/暂停期心跳起算（:383/:405）；每 15 秒权限复核、拒绝即终止（:487/:511）；stop 幂等（:561/:582）；清理恰在 cleanupDelaySeconds 到期删除（:648）；**清理失败 pending 每 60 秒重试**（:667）；重启标 interrupted + 不按旧 PID 杀进程（:706/:743）；孤儿目录扫描、删除失败进 pending（:757）；关闭钩子取消转换、目录保留可用（:799）。
- retention.spec.ts（9/9 全绿）：30 天审计/24h 过期票清理、活跃 session/转换保护、幂等、每日节拍——详见 T047 节，不重复。

**C. 硬件探测实现事实**（apps/server/src/modules/playback/conversion-supervisor.service.ts）：

- detectHardwareBackend（:161–187）：进程级缓存探测一次；`ffmpeg -hide_banner -encoders` 输出匹配 `h264_<backend>`（5 秒超时；失败/无候选 → null）。平台候选表：darwin=[videotoolbox]、**linux=[vaapi, qsv, nvenc]**、win32=[nvenc, qsv, amf]——本机（macOS）探测候选即 videotoolbox；**Linux 部署目标为 VAAPI/QSV/NVENC**。
- hardware_backend 于任务进入 starting 时一次性补记 playback_conversion 行（:310/:338/:441）；S8 场景未对其取值断言，本机是否命中 videotoolbox 无单独记录——**不宣称本机硬件加速证据**。
- 探测 null → 直接软件路径（R7）；镜像（bookworm）构建无 videotoolbox/nvenc、vaapi/qsv 需部署侧 `/dev/dri` 传递（research FFmpeg 节与「对 R4 预算的影响备注」）——**硬件加速不进预算基线，R4 性能验收以软件路径为准，硬件失败按 R7 最多回退软件一次**。

#### 2. 环境缺口清单（macOS 开发机不可产生；全部未实测、未验收，2026-10-26）

| # | 缺口 | 需要的真实环境与度量 | 状态 |
|---|---|---|---|
| G1 | **真实 Linux 硬件加速实测** | VAAPI（Intel/AMD iGPU + /dev/dri render 设备）、QSV（Intel）、NVENC（宿主驱动 + nvidia-container-toolkit）各至少一台真实 Linux 主机：硬件编码真实转码起播、playback_conversion.hardware_backend=vaapi/qsv/nvenc 落库断言、30 秒/15 秒预算与速度看门狗行为 | 未验收 |
| G2 | **无硬件软件回退（arm64 必验）** | 无 /dev/dri 映射的真实 Linux arm64 主机：探测 null → 纯软件路径（R7），回退一次共用原期限、30 秒/15 秒在镜像 ffmpeg 5.1.9 下达标 | 未验收 |
| G3 | **4CPU/4GiB 基线资源画像** | compose limits（cpus '4.0'/memory 4g）cgroup 下逐任务记录：容器 CPU%、进程线程数、RSS、数据卷磁盘写入/余量曲线 | 未验收 |
| G4 | **并发 1/2 对比稳态** | PLAYBACK_CONVERSION_CONCURRENCY=1 与 =2 各一轮 ≥15 分钟多任务稳态：额度语义、资源占用、磁盘有界性对比 | 未验收 |
| G5 | **30 秒/15 秒真实负载端到端** | ≥15 分钟真实负载样本（T032 扩展）在部署目标：转换首帧 ≤30s、seek ≤15s 逐次计时、慢于实时注入判罚——本机 3 秒小样本 73–215ms/8–216ms 不可外推（5.1.9 vs 8.1.1） | 未验收 |
| G6 | **回收链部署目标复验** | SIGTERM 5s→SIGKILL、45 秒失联、退出 60 秒清理、删除失败 60 秒重试、重启 interrupted+孤儿清理——语义已由 A/B 实测钉死，部署目标未复跑 | 未验收 |

- SC 台账零改动：SC-007（含「Linux 真实硬件加速及无硬件软件回退分别测，不以模拟进程代替」）、SC-009（转换时限与性能不足稳定失败）维持「—/未验收」；S8/单测全量数字详见 T047 节，本节仅列项引用不重复计数。

#### 3. 维护者执行清单（具备真实 Linux 硬件后逐项执行并回填本节）

前置（复用既有交付，不新造入口）：T057 docker-compose.yml 基线（非 root、read_only 根 + hmp-data 卷、`cpus: '4.0'`/`memory: 4g`）；硬件开关＝**仅放开 compose 内 `/dev/dri` 注释化映射**（VAAPI/QSV：amd64 + 宿主 render 组 gid，`group_add: ["<render-gid>"]`；NVENC：nvidia-container-toolkit runtime）；arm64 主机保持无映射（G2）；样本按 T032 夹具同一 lavfi 手法扩展 **≥15 分钟自制样本**（生成参数入证据，与 US3-06 准备同款）。

1. **环境登记**：发行版/内核/CPU/内存/GPU 型号与驱动；`docker compose exec app sh -c 'ffmpeg -version | head -3; ffmpeg -hide_banner -encoders | grep -E "h264_(vaapi|qsv|nvenc)"'`。
2. **G1 硬件路径**：放开对应设备映射起播需转码样本；转码 ready 后查 `playback_conversion.hardware_backend`（sqlite）=vaapi/qsv/nvenc；逐任务记录墙钟与 30s/15s 达标。
3. **G2 软件回退**：arm64 无映射同轮复跑，断言 hardware_backend IS NULL 且软件路径达标；另以错误设备映射（如无 render 组权限）验证「硬件 spawn 失败 → 软件回退一次共用原期限」。
4. **G3/G4 资源画像**：`docker stats --no-stream`（CPU%/MEM）+ 容器内 `ps -o pid,nlwp,comm`（线程数）+ `grep VmRSS /proc/<pid>/status` + `df -h /data`（余量）逐任务采样；并发=1 与 =2 各 ≥15 分钟；核对任务 512MiB/全局 2GiB/余量 1GiB 行为与产物有界。
5. **G5 预算**：真实负载样本首帧 ≤30s、seek ≤15s 逐次计时；慢于实时注入触发速度看门狗（连续 3 次 speed<1 且缓冲 <8s → PLAYBACK_PERFORMANCE_INSUFFICIENT）。
6. **G6 回收链**：stop→SIGTERM 5 秒→SIGKILL 确认退出；断开心跳 45 秒判定回收；退出后 60 秒删除产物；人为制造删除失败（如临时置目录只读）验证 pending+60 秒重试；`docker compose restart` 验证 interrupted+孤儿清理+无旧票复活。
7. **判定与回填**：判据一律回 research R4/R7/R8 与 quickstart「SC-007/008/009：兼容与资源」数值，不得放宽；任何一项未执行即保持未验收；G1–G6 全部完成前 SC-007/SC-009 不得标验收；失败证据同样如实入账。

### T059 全仓回归（2026-10-26）

**性质声明**：本节六条门禁于本轮在仓库根依次真实执行（顺序与口径按 quickstart「静态与自动化」节），数字为命令实际输出回填，无预填。环境同 T002 基线节：Node v24.19.0、pnpm 11.28.5、macOS arm64 / Apple M4 Pro（runtime 硬件探测：darwin 27.0.0、12 CPU）、FFmpeg/ffprobe 8.1.1 Homebrew。分支 master、HEAD `f286c59db4b484c3f38f378de441b401dfacd91f`（与 T002 基线同 HEAD），工作区 003/004 全部未提交更改（81 项脏/未跟踪）基线原样保留。

**六命令逐项（实际执行）**

| # | 命令 | exit | 耗时 | 关键输出 |
|---|---|---|---|---|
| 1 | `pnpm gen:types` | 0 | 1.4s | openapi-typescript 7.13.0，4 份 schema 全部生成：001→`src/schema.d.ts`(21.5ms)、002→`policy-schema.d.ts`(19.5ms)、003→`catalog-schema.d.ts`(36.4ms)、**004→`playback-schema.d.ts`(25.9ms)**；已跟踪产物重新生成后 git 零 diff（无实质变化） |
| 2 | `pnpm lint` | 0 | 5.4s | `eslint .` 0 错误 |
| 3 | `pnpm typecheck` | 0 | 2.5s | 3 workspace 项目（shared/web/server）`tsc --noEmit` 全部通过 |
| 4 | `pnpm test` | 0 | 81.0s | vitest **61 文件 / 961 用例全部通过，0 失败** |
| 5 | `pnpm build` | 0 | 2.9s | shared / server / web 3 包全部构建成功（web vite ✓ built 2.03s，仅既有 >500kB chunk 警告，非失败） |
| 6 | `pnpm test:runtime` | 0 | 2m28.7s / 2m28.8s | **两轮全绿 PASS，总断言 445（两轮一致）**，见下 |

**test:runtime 两轮明细（phase2 8 场景 + phase3 S1–S9）**

- 两轮均 `result=PASS`、`phase2Scenarios=8`、`phase3Scenarios=S1–S9` 齐全、`assertionCount=445`；分项 S6=77 / S7=90 / S8=96 / S9=54（两轮一致）。
- 本轮实测抽样（两轮）：S5 总量 10005、搜索+翻页 20/20 次 ≤2s、HTTP p95 63.6/63.4ms；S8 转码任务行 75/176ms 与 74/165ms、seek 恢复 direct 8ms/转码 214ms 与 8ms/213ms（预算 15s）、额度满 BUSY 真实触发、终态票门旧票 401；S9 `recordFieldCompletenessRate=100`。
- **S1–S6（003 场景）无回归确认（两轮全绿）**：S1-source-loop（来源闭环：三来源导入/幂等刷新身份稳定/失败保留/禁用即时生效）、S2-catalog-matrix（目录矩阵：成人全量/儿童过滤/搜索翻页 total 一致/同形 404/无档案 403）、S3-epg-flow（EPG 全流程：counts/current+next/并发 409 SOURCE_BUSY/失败保留/重启 interrupted/手动重试）、S4-policy-lists（名单闭环：候选绕过/允许可见/再禁不可见/两设备下一请求生效）、S5-perf-baseline（性能基准：10005 条、19/20 ≤2s 参考线达标）、S6-manual-epg-binding（手动绑定：保存锁定/generation 双 409/解除 ABA/负向与泄漏反向断言）。
- 断言口径交叉验证：445 − S7/S8/S9（90+96+54=240，即 004 新增）= **205 = T002 基线 003 断言总数，逐数吻合**——003 场景在断言数层面零回归。

**vitest 侧 003 spec 清单核对（未删且保持通过：24 文件 / 303 用例）**

- catalog（5 文件 62 例）：catalog-candidates 9、catalog-api 6、catalog-migration 3、unit/catalog/batch-policy-context 10、unit/imports/catalog-diff 34；
- epg（7 文件 66 例）：epg-settings 7、epg-programmes 5、manual-epg-binding 15、manual-epg-migration 7、unit/epg/manual-binding 24、manual-programme-priority 4、candidate-ordering 4；
- imports（6 文件 133 例）：nas-scanner 20、safe-http-reader 29、refresh-executor 21、m3u.parser 22、nas-replacement 4、xmltv.parser 37；
- policy（6 文件 42 例）：policy-lists 10、policy-api 8、policy-authorization 5、policy-atomicity 5、policy-migration 5、unit/policy-rules 9。

**基线对照与 004 实际新增（诚实口径）**

| 口径 | T002 基线（2026-10-25） | 本轮 T059（2026-10-26） | 004 实际新增 |
|---|---|---|---|
| lint / typecheck / build | PASS | PASS（上表） | 门禁保持通过 |
| vitest | 39 文件 / 460 用例 | 61 文件 / 961 用例 | **+22 文件 / +501 用例**（961−460） |
| test:runtime | 205 断言（phase2+S1–S6） | 445 断言（phase2+S1–S9） | **+240 断言**（445−205，恰为 S7+S8+S9=90+96+54） |

**声明**：不借历史 456/460 用例宣称 004 通过——历史数字仅作回归基线；004 的通过证据是其自身的测试/场景/证据节（本台账 US1/US2/US2b 各 checkpoint 与 runtime S7/S8/S9），T059 只证明「全仓六门禁通过 + 003 场景无回归 + 新增数字真实」。

**遗留缺口（汇总，详见各节）**：浏览器 Network 层验收（US3-01～10 全部待执行，SC-001/002/003/005/007/008/009 浏览器面）、真实 Linux 硬件加速与资源画像（T058 缺口 G1–G6）、双架构镜像构建/启动/缺列 503/缺 FFmpeg 能力实测（T057 镜像证据缺口）均未验收——详见「US3 浏览器链路（T054/T055）」「T057 部署配置」「T058 硬件与资源证据」三节缺口清单；SC 台账不因本节门禁全绿而改动。

## FR/SC 终验（T060）

### T060 FR/SC 终验核对（2026-10-26）

**核对结论摘要**：FR-001～019 共 19 项——**10 项达成 Verified**（FR-001/002/003/004/006/008/011/012/016/019：实现+单测+契约+HTTP runtime 四层证据齐备）、**9 项部分达成**（FR-005/007/009/010/013/014/015/017/018：各含浏览器面/真实硬件/真实负载缺口，逐条见下表）。SC-001～009 共 9 项——**0 项 Verified，全部保持未验收**（SC 台账状态已精确化为「后端达成/浏览器或硬件或镜像缺口」实际组合）。整体判定：**004 实现完成（T059 六门禁全绿：vitest 961/961（61 文件）、runtime 445 断言两轮一致、003 场景零回归），Verified 未达成**——浏览器 Network 层（T054/T055 US3-01～10 全部待执行）、真实 Linux 硬件与资源画像（T058 G1–G6）、双架构镜像实测（T057，Docker Hub 不可达）三类环境缺口如实保留未验收。依据 ADR-0009 判定规则：「SC-001～009多层证据、容器双架构、真实硬件/浏览器通过后才能Verified」。

**判定规则**：FR 级以「实现+单测+契约+HTTP runtime」四层为基线；条目文本自身要求浏览器呈现、真实硬件或端到端真实负载的（FR-005 播放器续期连续性、FR-007 家长查询 UI、FR-009/010 入口与失败呈现、FR-013 准备/失败展示、FR-014 每样本有声有画 15 分钟、FR-015 真实硬件路径、FR-017 字幕/音轨实操、FR-018 端到端首帧），该层为附加必需层级，缺即「部分达成」。SC 级按 quickstart 各 SC 节要求的全部层级判定，任一层未过即保持未验收。本节只汇总引用本台账既有节证据，不新增执行结果、不重复计数。

#### 逐 FR 核对表

| FR | 证据指针（evidence 节/测试） | 已达成层级 | 缺口层级 | 结论 |
|---|---|---|---|---|
| FR-001 | T034（playback-control 39+playback-stream 21 契约）、T041（input-security 33 例：零上游痕迹/零应用认证/header 后脱敏；泄漏扫描 217 条响应聚合断言） | 实现+单测+契约+HTTP runtime | 无 | Verified |
| FR-002 | T017 授权管线实现、T041（授权矩阵 34 用例：会话/档案/PIN/策略/家庭/源全维度稳定码）、S7（异步提交授权变化下一请求拒绝）、S9（异步准备失败只更新 session 不产生 failure_event） | 实现+单测+契约+HTTP runtime | 无 | Verified |
| FR-003 | T035/T040（404 同形 problem 体逐字段一致、跨家庭枚举防护三类 id 体逐字段一致）、S7/S9（跨家庭/无源/停源同形 404，与不存在逐字段一致） | 实现+单测+契约+HTTP runtime | 无 | Verified |
| FR-004 | T019 resource-selection.spec（成本/稳定 ID/失败候选/总期限排序）、T016 conversion.spec 格式优先级、T034 HTTP（4K/HDR 需转换→PLAYBACK_FORMAT_UNSUPPORTED 不降分辨率） | 实现+单测+契约+HTTP runtime | 无 | Verified |
| FR-005 | T014（renew 复用 session/expectedGeneration 短事务 CAS/换代 409）、S8（续期同 session/任务、preparing 窗口 renew 409 NOT_READY）、T053 实现（到期前 60s 调度、operationEpoch 守卫） | 实现+单测+契约+HTTP runtime | 浏览器面：播放器自动续期与 ≥15 分钟跨两次续期不重置位置实测（US3-06 待执行） | 部分达成-缺口：浏览器面（US3-06） |
| FR-006 | playback-stream 21 例（票绑定设备/session/generation、过期、换代 401）、T041 票据维度矩阵、S7（manifest/segment/key/MAP/字幕/Range/HEAD 逐项在切档案/收紧策略/注销后下一请求全拒） | 实现+单测+契约+HTTP runtime | 无 | Verified |
| FR-007 | T047（records e2e 14 用例+S9 54 断言、字段完整率 100% 双口径、retention 9/9、owner 密码/锁定/跨家庭/非 owner 负向全绿）、T046 组件交付+web tsc/build 门禁 | 实现+单测+契约+HTTP runtime | 浏览器面：家长查询 UI 实操（T047 节如实记录缺口，归浏览器链路层） | 部分达成-缺口：浏览器面（家长查询 UI 实操；后端证据齐备） |
| FR-008 | T033/T041 S7（direct+HLS 同入口基线起播→切档案 403/收紧 404/注销 401/停源 404 同一矩阵）、T035 授权矩阵、T059（003 目录/EPG 回归不受影响） | 实现+单测+契约+HTTP runtime | 无（真实起播成功率归 SC-001 浏览器面记录，非本条四层义务） | Verified |
| FR-009 | T052 实现（仅可见可用媒体渲染入口、同形 404 统一文案、不渲染策略细节）、T035/S7 服务端同形 404、web 门禁 | 实现+服务端 HTTP | 浏览器面：入口可见性与被禁呈现实测（US3-01/02 待执行） | 部分达成-缺口：浏览器面（US3-01/02） |
| FR-010 | T049/T051 实现（PLAYBACK_ERROR_LABELS 稳定码→友好文案全词表、失败文案+取消/重试入口）、契约稳定错误（domain-error/problem-json.filter 单测） | 实现+单测+契约 | 浏览器面：失败/忙/超时/资源不足文案与取消重试呈现实测（US3-03/04/09 待执行） | 部分达成-缺口：浏览器面（US3-03/04/09） |
| FR-011 | S7（收紧策略→active session 的 GET/renew/媒体下一请求 404 不签票；注销 401+旧票作废；切档案 403）、lifecycle.spec（每 15 秒后台权限复核拒绝即终止） | 实现+单测+契约+HTTP runtime | 无 | Verified |
| FR-012 | T016/T034（direct→remux→audio→video 优先级、真实 FFmpeg `-c copy` 转封装、仅转换必要轨道）、S8（转码真实交付带票分片、direct 不占额）、T020 nas-reader/conversion-storage（只读校验、私有产物不公开静态路径） | 实现+单测+契约+HTTP runtime | 无 | Verified |
| FR-013 | T016 失败矩阵 39 例、S8（超时/取消/BUSY/失败码可轮询）、T050/T051 实现（preparing 覆盖层与失败文案） | 实现+单测+契约+HTTP runtime | 浏览器面：准备中展示与稳定失败原因呈现实测（US3-03/04 待执行） | 部分达成-缺口：浏览器面（US3-03/04） |
| FR-014 | T032 夹具（5 容器×H.264/HEVC 8/10bit/MPEG-4×AAC/AC3/EAC3/DTS+非法/4K/HDR 形态）、T016+真实 FFmpeg（macOS 8.1.1）、S8 四路径真实交付 | 实现+单测+契约+HTTP runtime（macOS 软件路径） | 浏览器面：每必验样本有声有画 ≥15 分钟+seek/续期（US3-06/07 待执行，≥15 分钟样本未生成）；真实硬件矩阵（T058 G1/G2）；镜像 ffmpeg 5.1.9 不可由本机 8.1.1 外推 | 部分达成-缺口：浏览器面 15 分钟样本+真实硬件（G1/G2） |
| FR-015 | conversion-supervisor 硬件探测实现（linux=[vaapi,qsv,nvenc] 候选表）、conversion.spec（硬件失败软件回退一次共用原期限、速度看门狗 PERFORMANCE_INSUFFICIENT、不自动降分辨率）、S8 macOS 软件路径真实转码 | 实现+单测+契约+HTTP runtime（软件回退语义，macOS） | 真实 Linux 硬件加速与无硬件软件回退实测（T058 G1/G2 未验收） | 部分达成-缺口：真实硬件路径实测（G1/G2） |
| FR-016 | repository.spec/conversion.spec（原子 reserve/并发不超额/退出确认后释放）、S8-4（并发 1 BUSY 真实触发：挑战会话 failed+PLAYBACK_CONVERSION_BUSY、winner 照常 ready、无排队）、S7/T059（direct 不占额、既有播放与目录不受影响） | 实现+单测+契约+HTTP runtime | 无（并发 >1 稳态资源画像归 SC-007/009 资源证据 T058 G4，非本条四层义务） | Verified |
| FR-017 | T030/T029 实现+单测（字幕净化/同 stem 旁车/越界与符号链接双拒、纯字幕只增 version 不换代）、input-security（恶意字幕/路径越界）、S7（字幕全链）、S8-3b（换轨换代恢复 8–216ms 保留位置） | 实现+单测+契约+HTTP runtime | 浏览器面：字幕显示/关闭与音轨切换实测（US3-08 待执行） | 部分达成-缺口：浏览器面（US3-08） |
| FR-018 | S8（转码任务墙钟 73–215ms 两轮、seek 恢复 direct 8/216ms 与转码 10/216ms ≪15s 预算）、conversion.spec（首帧 30s/seek 15s 看门狗判罚）、T051 实现（准备状态+取消） | 实现+单测+契约+HTTP runtime（服务器侧计时） | 端到端浏览器首帧 ≤30s 实测（US3-01/03 待执行）；真实负载 ≥15 分钟样本预算（T058 G5）；macOS 8.1.1 不可外推镜像 5.1.9 | 部分达成-缺口：端到端首帧实测（浏览器）+真实负载（G5） |
| FR-019 | lifecycle.spec（45s 失联/15s 心跳/权限复核/清理 60s 重试/重启 interrupted+孤儿目录/关闭钩子）、conversion.spec（SIGTERM 5s→SIGKILL、磁盘 512MiB/2GiB/1GiB 预算、清理失败 pending 60s 重试）、S8-5/6/8（停止取消/失联回收/重启恢复+新起播可用） | 实现+单测+契约+HTTP runtime | 无（部署目标回收链复验归 T058 G6，属 SC-009 部署证据缺口） | Verified |

#### 逐 SC 核对表

| SC | 证据指针 | 已达成层级 | 缺口层级 | 结论 |
|---|---|---|---|---|
| SC-001 | T034（resolve/renew/交付 HTTP 链）、T047 节 S8（续期同 session/任务）、T059（六门禁全绿、runtime 445 断言） | 后端四层（实现+单测+契约+HTTP runtime） | 浏览器面：各 20 次起播 ≥19 成功、逐次 P95 ≤1s、≥15 分钟跨两次续期不重置位置、Network 同源（US3-01/06 待执行；004 resolve 逐次 P95 未记录） | 未验收——后端达成/浏览器面缺口 |
| SC-002 | T041（授权矩阵 34+输入安全 33+泄漏扫描 217 条聚合+S7 90 断言） | 后端四层 | 浏览器面：UI 门控/同形 404 展示（US3-02 待执行） | 未验收——后端达成/浏览器面缺口 |
| SC-003 | T041（跨 session/过期/篡改/跨设备复制/换代/终态票全 401；S7 逐项下一请求拒绝矩阵） | 后端四层 | 浏览器面：旧票重放/停止后拒绝呈现（US3-02/05/10 待执行） | 未验收——后端达成/浏览器面缺口 |
| SC-004 | T047（records e2e 14+S9 54 断言、字段完整率 100%、retention 9/9、权限负向全绿）、T046 组件交付 | 后端四层 | 浏览器面：家长查询 UI 实操（密码输入/列表渲染/错误分流/翻页；T047 节如实记录） | 未验收——后端证据齐备/浏览器面缺口 |
| SC-005 | T041（C6/C7 策略、F1–F3 会话/档案、D3 源）、lifecycle.spec 15s 复核链 | 后端四层 | 浏览器面：档案切换销毁/旧代次响应不覆盖（US3-05 待执行） | 未验收——后端达成/浏览器面缺口 |
| SC-006 | T056（up/备份恢复逐值一致/down/up/drill、恢复票不复活）、T059（961/961+445 断言、003 零回归）、T057（配置层交付+compose config PASS） | 迁移演练+全量回归达成 | 部署镜像面：linux/amd64+arm64 构建/启动/迁移/缺列 503/缺 FFmpeg 能力全部未实测（T057，Docker Hub 不可达） | 未验收——迁移演练与全量回归达成/部署镜像缺口 |
| SC-007 | T032 夹具矩阵、T016+真实 FFmpeg remux、S8（audio/video 真实交付+BUSY）、T059 回归 | 后端四路径（direct/remux/audio/video） | 浏览器面：每样本有声有画 ≥15 分钟+三内核路径（US3-01/06/07/08）；真实硬件 G1/G2；并发 2 稳态 G4 | 未验收——后端四路径达成/浏览器+硬件缺口 |
| SC-008 | T047（S9 记录可见性）、T058（S8-5/6/8 停止/失联/重启恢复+回收单测）、input-security（字幕安全） | 后端四层 | 浏览器面：字幕/音轨 UI、停止释放 UI（US3-08/10）；部署目标回收复验（G6） | 未验收——后端达成/浏览器面+部署复验缺口 |
| SC-009 | T058（S8 转码 73–215ms、seek 8–216ms ≪15s、BUSY/看门狗/磁盘/回退单测；macOS 软件路径） | 服务器侧计时+判罚语义 | 真实负载端到端（G5）、真实硬件（G1/G2）、浏览器呈现（US3-03/04/09） | 未验收——服务器侧计时达成/真实负载+硬件+浏览器缺口 |

#### 保留未验收项清单（T060，2026-10-26）

1. **浏览器 Network 层（T054/T055，US3-01～10 全部待执行）**：SC-001/002/003/005/007/008/009 的浏览器面；FR-005（续期连续性）、FR-007（家长查询 UI 实操）、FR-009（入口可见性）、FR-010（失败呈现）、FR-013（准备/失败展示）、FR-014（每样本有声有画 15 分钟）、FR-017（字幕/音轨实操）、FR-018（端到端首帧）相关子层。执行脚本见「US3 浏览器链路（T054/T055）」节；缺浏览器/夹具不得以静态截图或历史 HTTP 证据替代。
2. **真实 Linux 硬件与资源画像（T058 G1–G6 全部未验收）**：SC-007（硬件路径+并发 2 稳态 G4）、SC-009（真实负载 30s/15s 预算 G5+部署复验 G6）、FR-015（硬件加速/软件回退实测 G1/G2）、FR-018（真实负载预算 G5）。
3. **双架构镜像实测（T057）**：SC-006 部署面——linux/amd64+arm64 镜像构建、启动、迁移、缺列 503、缺 FFmpeg 能力失败全部未实测（Docker Hub 不可达，2026-10-26 复现）。
4. **SC 台账语义**：SC-001～009 全部 9 项保持未验收（0 项 Verified），各行状态已精确化为「后端达成/浏览器或硬件或镜像缺口」实际组合；不引入任何未经对应层级实测的 Verified。

> 状态同步：spec.md Status、plan.md Status 与 ADR-0009 状态行已同步为「Accepted；实现完成，Verified 待浏览器/硬件/镜像证据（缺口见本节）」口径；checklists/requirements.md 16 项勾选维持只读未改动；tasks.md T060 勾选与任务清单不在本任务文件边界内、未改动。
