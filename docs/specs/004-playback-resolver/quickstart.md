# Quickstart validation — 004

状态：设计验收指南，不是通过记录。仅在spec/ADR接受、实现完成后执行。所有写入/迁移使用独立临时DATA_DIR，禁止对用户库运行down/drill。

## 环境

记录Node/pnpm、浏览器版本、Linux架构、CPU/内存、设备映射、FFmpeg版本/编译选项及编码器、hls.js锁版本、容器CPU/内存限制。基线4CPU/4GiB，不代表该硬件一定满足所有视频实时转换。准备私有临时NAS只读挂载、受控局域网HLS夹具及精确LAN许可；不使用真实凭据或公开版权视频。FFmpeg/ffprobe来自实施后镜像，本轮无安装命令。

## 静态与自动化

仓库根依次运行：

```sh
pnpm gen:types
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:runtime
```

gen:types在实施阶段接入独立播放契约后才包含本功能；记录实际命令输出/测试数量，003的历史数字不替代本轮证据。单测覆盖授权决策、格式计划、HLS全URI重写/SSRF、Range、配额CAS、计时/回收、字幕净化；契约覆盖contracts/api.md全部状态和越权矩阵。

## SC-001/005：基础真实播放

成人档案分别对受控HLS和NAS MP4 H.264/AAC起播各20次，>=19成功；逐次记录解析P95<=1s。真实浏览器连续播放>=15min跨两次续期，不重置位置；Network验证所有请求同源且无原URL/路径。续期复用session及任务，主动重播新session。

## SC-002/003：安全

对无/过期/撤销设备会话、未选/停用/PIN未解锁档案、儿童超龄/黑名单/频道名单外/未评级、跨家庭/无源、ticket过期/跨设备复制分别检查稳定拒绝。对manifest/segment/key/MAP/subtitle/Range逐项执行档案切换、策略收紧和注销后的下一次请求拒绝；禁用源停止继续交付。伪造assetId、generation、字幕路径、轨道ID、NAS符号链接、DNS重绑定/重定向、恶意清单和字幕均不得绕过。响应、控制台、日志扫描无源位置/ticket/stderr泄漏。用HEAD和Range同样复验。

## SC-004：记录

有效设备解析失败另记事件，不可见媒体ID为空；无效会话仅安全日志。owner密码查询设备记录，非owner/错误密码/跨家庭失败；普通观看者仅自己的播放状态。终止原因/时间齐全，重试stop不重复记录，30天保留清理不影响个人数据。

## SC-007/008/009：兼容与资源

按FR-014建立样本矩阵，至少覆盖5种容器、全部视频/音频编码及HEVC 8/10bit，禁止把非法容器组合算缺陷。每条样本有声有画15min，seek和续期；直接/转封装/仅音频/视频转换四路径均留浏览器与后端证据。Chromium/Firefox/Safari分别记录支持路径；Linux真实硬件加速及无硬件软件回退分别测，不以模拟进程代替。4K/HDR可直放则记录，否则友好提示且不转换。文字字幕内嵌/旁车SRT/VTT、关闭/换轨、恶意脚本不执行。

转换首帧<=30s、seek<=15s；注入超时/慢于实时场景按research R4终止。并发默认1及配置2，超额立即忙无排队，直接播放不占额度。测线程/CPU/RSS、每任务512MiB/全局2GiB和磁盘余量阈值，检查产物有界。暂停有心跳不误清理；stop/cancel、失败、权限失效立即发起终止，SIGTERM宽限5秒后强杀并确认退出，失联45秒判定后同样回收，退出后60秒删除产物；删除失败仍计预算且重试。崩溃/重启旧会话interrupted、无旧ticket恢复播放，清理后才能接新转换。

## SC-006：迁移与部署

独立临时库：0004备份→0005 up→构造播放→停转换→备份→down/up→逐值比较身份/PIN/策略/目录/EPG→恢复备份→校验记录恢复但ticket不可复活。迁移命令在独立DATA_DIR下使用现有pnpm migration:up/down/drill，先核对路径。integrity_check=ok、foreign_key_check无行。

构建linux/amd64和linux/arm64镜像，启动非root、只读NAS、私有写缓存；FFmpeg缺失/编码器缺失和0005必需列缺失分别验证能力错误及healthz 503，不导致目录静态文件或鉴权失效。硬件映射真实设备单独验证，仿真仅证明镜像启动。

### 部署命令与验证步骤（T057，对齐根目录 docker-compose.yml）

compose 已落实：非 root（镜像 `USER node`，uid/gid 1000）、`read_only: true` 根文件系统 + 具名卷 `hmp-data:/data`（SQLite/迁移备份/播放转换私有缓存）+ `/tmp` tmpfs、NAS `:ro` 只读绑定挂载示例、`/dev/dri` 硬件映射注释化（默认不启用）、`deploy.resources.limits` 4CPU/4GiB、无 `privileged`、无宿主 docker.sock。本节为执行脚本，非通过记录；镜像证据缺口见 evidence.md T057 节。

```sh
# 构建+启动（CMD 先对 /data 执行 migrate.js up 再起服务）
docker compose up -d --build

# 非 root 与只读根验证
docker compose exec app id                      # 期望 uid=1000(node) gid=1000(node)
docker compose exec app sh -c 'touch /usr/local/x'   # 期望失败:只读根
docker compose exec app sh -c 'touch /data/.rw && rm /data/.rw'   # 期望成功:私有卷可写
docker compose exec app sh -c 'touch /media/videos/x'  # 期望失败:NAS 只读挂载

# 迁移单独执行（迁移前服务须停止;down/drill 仅对独立临时 DATA_DIR,禁对用户库）
docker compose stop app
docker compose run --rm app sh -c 'node apps/server/dist/database/migrate.js up'    # down/drill 同形替换
docker compose start app

# 0005 必需列缺失 → healthz 503：对独立临时库以缺列形态启动
#   （用 0004 旧形态库副本,或临时副本 DROP 0005 必需列后挂为 hmp-data）
# 期望:GET /api/healthz → 503 RFC9457 code=NOT_READY;目录/鉴权等既有端点不失效,不自动补表。

# 缺 FFmpeg 能力失败：以不含 ffmpeg 的临时镜像（同 Dockerfile 去掉 apt 安装行）启动
# 期望:需转换的 resolve→session 进入 failed,稳定码 PLAYBACK_RESOURCE_UNAVAILABLE（进程无法启动）
#      或 PLAYBACK_FORMAT_UNSUPPORTED（编码器缺失,detail 携带兼容原因）;direct 可播内容、目录与鉴权不受影响。

# 双架构镜像构建（具备 registry 访问的环境;逐平台验证命令清单见 evidence.md T057 节）
docker buildx build --platform linux/amd64,linux/arm64 -t home-media-platform:local .
```

硬件映射（`/dev/dri`，VAAPI/QSV 仅 amd64 典型；NVENC 需宿主驱动与 nvidia-container-toolkit）默认注释、默认不启用；放开注释仅在真实 Linux 硬件上单独验证（归 T058），amd64 仿真不作为硬件加速证明，arm64 保持软件路径必验。

### 停止与迁移回退顺序（T061）

停止顺序：先停应用（compose 为 `docker compose stop app`；应用关闭钩子取消在途转换并确认子进程退出，避免活动会话/转换任务悬挂）→（如需回滚）仅对**独立临时 DATA_DIR** 执行 `migrate.ts down`——down 单次逆序回滚最近一条已应用迁移，连续执行即 0005→0001（`0005 down` 删除播放四表与 `device_household_id_id_key` 复合索引，0001–0004 数据零修改；播放记录随表删除、不自行恢复），**用户库禁止 down/drill**（compose 路径同形：stop → `compose run --rm` 迁移 → start，仅限临时卷）。up 顺序为 0001→0005（目录名字典序），drill=up→down→up；每次 up/down 自动 `VACUUM INTO` 生成停服一致性快照，备份恢复后旧票据不可复活（重启活动会话标 interrupted），逐值校验与演练记录见 evidence.md T056 节。

### 许可信息（T061）

- hls.js：锁定 1.7.3，Apache-2.0（完整构建，含音轨/字幕，禁用 light 版）。
- FFmpeg/ffprobe：部署镜像 bookworm `5.1.x`（当前 5.1.9），GPL 组件启用构建（`--enable-gpl`，含 libx264/libx265；各链接库按各自许可，libx264 为 GPL-2.0+）。应用仅以服务器子进程调用、不分发 FFmpeg 本体，无整体传染义务；**镜像再分发需按各组件许可逐项审查**。本机开发可用任意 ≥5 版本（参考环境 8.1.1），性能结论不得外推镜像 5.1.9。完整记录见 research.md「依赖版本锁定（T004）」节。

## Evidence

实施时创建evidence.md按SC-001～009逐项记录日期、命令/场景、期望/实际、日志/Network/浏览器证据、环境及限制；先失败测试再实现。缺浏览器、真实硬件或恢复证据保持未验收。不得在本轮预填通过。

补测定位关键帧前偏移时不闪回目标前画面；影片进度条不被120秒滚动窗口限制。Safari原生HLS连续跨两次ticket轮换必须留证；hls.js完整构建验证音轨/字幕，不使用light构建。暂停/有界预取不被性能看门狗误杀；硬件失败一次回退软件仍满足原准备期限。检查上游夹具接收请求没有应用Cookie或Bearer。

## 2026-10-25 分析修订回归

验证201为preparing且delivery/URL/过期时间为空，轮询ready后以expectedGeneration首次renew取票；GET不返回明文票。seek/重建音轨时旧票失效、同session进入preparing、ready后申请新票；保留暂停意图，纯字幕只改version。控制与浏览器分别注入renew先发后到、seek先提交等交错，旧expectedGeneration不写票、旧operationEpoch不覆盖新操作。多资源按处理成本→source_id→playback_source_id排序，不依赖未定义priority。迁移四表齐备再运行完整恢复测试；字段约束只以data-model.md为准。

## US3 浏览器场景清单（T048，2026-10-25）

状态：失败基线清单，不是通过记录。前端播放器（T049–T053）尚未实现，下表全部场景当前只能记录「未实现失败」；实施后必须以同一场景 ID、同一操作步骤在同一环境重跑，结果按 ID 回填 evidence.md（T054/T055）。本轮先记录失败基线，不以静态截图代替 Network：每个场景的判定证据以浏览器 DevTools Network 导出（HAR）中的请求/响应（方法、状态码、body 字段、时序）为准，截图仅辅助 UI 状态，任何场景不得以截图或 DOM 断言替代网络证据。

环境缺口（如实记录）：T048 编写会话无法启动真实 Chromium/Firefox/Safari 对真实服务执行完整 Network 链路（无浏览器夹具与受控上游），本清单即作为 T054/T055 的执行脚本交付；执行时的浏览器版本、设备/夹具可用性与缺口由 T054/T055 在 evidence.md「US3 浏览器链路」如实记录，执行前相关 SC 条目保持未验收，不得预填通过。

### 通用约定

- 前置：真实后端服务（非 mock、非静态截图）、独立临时 DATA_DIR、T032 夹具（apps/server/test/fixtures/playback/ 的 generate-media.mjs 生成样本与 manifest.json 索引）及受控局域网上游 HLS；不用真实凭据或公开版权视频。档案A=已解锁成人档案（owner），档案B=受限档案（超龄/黑名单样本）。
- Network 记录：DevTools Network 面板勾选 Preserve log 全程录制，场景结束导出 HAR，命名 `US3-xx_<浏览器>_<YYYYMMDD>.har`；截图命名 `US3-xx_<浏览器>_<步骤号>.png` 仅辅助定位。多设备场景每设备各导出一份 HAR。
- 可重复性：每场景至少连续执行 2 次且结果一致方可记录；失败基线轮（本轮）记录「操作无法执行：播放器未实现」即为该场景的失败证据。
- 判定字段语义（response 时序、expectedGeneration、operationEpoch、同形 404）以 contracts/api.md 为准，本文不复制字段约束。

### 场景表

| 场景 ID | 操作步骤（可重复，具体到点击与等待） | 期望结果：Network 面 / UI 面 | 验证浏览器 / 所需夹具 | 记录格式 | 当前状态 |
|---|---|---|---|---|---|
| US3-01 详情入口 | 1) 档案A登录，打开受控 HLS 频道详情页；2) 等待详情数据渲染完成；3) 点击「播放」按钮；4) 等待视频出声有画（≤10 秒）；5) 返回，打开 T032 NAS MP4 影片详情页重复 1–4 | Network：详情查询 200；点击后 POST /playback/resolve 201 且 body 为 preparing、delivery/ticketExpiresAt/playbackUrl 均空；GET /playback/sessions/{id} 轮询至 ready；以返回 generation 调 renew 200 取 TicketReply；全部分片请求指向同源 /playback/stream/… 且带 ticket，HAR 中无原源地址/上游主机、上游 HLS 收不到应用 Cookie/Bearer。UI：仅允许且可用媒体显示可用播放按钮并起播有声有画（FR-009） | Chromium/Firefox/Safari；T032 H.264/AAC HLS 样本 + NAS MP4 H.264/AAC | HAR（resolve→renew→分片全链时序）+ 截图步骤 3/4 | 未实现——T049–T053 实施后重跑 |
| US3-02 被禁 404 | 1) 档案B直接用地址栏进入被禁/超龄/黑名单频道与影片详情页；2) 观察入口与文案；3) 档案A对无源/停用源媒体详情页重复；4) 对上述媒体从开发者工具直接 POST /playback/resolve 复核 | Network：被禁/不可见/无源/跨家庭的 resolve 均 404 MEDIA_NOT_FOUND，各响应体同形（同一稳定码，逐字节可比对），无策略明细、无源位置；详情数据不返回被禁条目。UI：无播放按钮或统一「内容不存在或不可访问」，不出现任何策略拒绝原因 | Chromium/Firefox/Safari；T032 超龄/黑名单标记样本 + 停用源样本 | HAR（比对多组 404 响应体一致性）+ 截图 | 未实现——T049–T053 实施后重跑 |
| US3-03 准备/取消/超时 | 1) 档案A对需视频转码样本点击播放；2) preparing 期间观察状态与取消按钮（≥2 次轮询间隔）；3a) 点击「取消」；3b) 另一次不取消，改用上游限速/永不完成注入等待服务端准备超时 | Network：resolve 201 preparing 后按节奏出现 GET 轮询；3a) 取消后 POST /playback/sessions/{id}/stop 204（幂等），此后无 renew、无分片请求；3b) 轮询得到 504 PLAYBACK_PREPARE_TIMEOUT 或终态 failureCode，session 终态且永不签票。UI：显示「准备中」与可用取消按钮；取消回到详情页；超时显示稳定友好提示与重试入口，无 stderr/源信息 | Chromium/Firefox/Safari；T032 视频转码样本 + 上游慢速注入 | HAR（轮询节奏、stop 时点、504 响应）+ 截图 preparing 态与超时文案 | 未实现——T049–T053 实施后重跑 |
| US3-04 失败重试 | 1) 对必然探测失败的样本（T032 非法容器）点击播放；2) 等待轮询返回 failed；3) 记录失败文案；4) 点击「重试」；5) 观察重新解析 | Network：轮询返回 failed + 稳定 failureCode（如 PLAYBACK_FORMAT_UNSUPPORTED/422 族）；失败 session 不签票；重试产生新 session（新 id）的 resolve 201 并重新走 preparing→ready。UI：显示稳定码对应友好原因；重试后回到准备流程，不自动无限重试 | Chromium/Firefox/Safari；T032 非法容器样本 | HAR（failureCode 与新 session 建立证据）+ 截图失败文案 | 未实现——T049–T053 实施后重跑 |
| US3-05 档案切换销毁 | 1) 档案A对慢转码样本点击播放进入 preparing；2) 不等 ready，切换到档案B（profile/id 变化）；3) 等待旧 session 的 ready/renew 迟到响应到达；4) 检查此后网络活动 | Network：切换瞬间发出 stop 且轮询/定时器停止；旧代次 renew/seek 响应到达后客户端不再基于旧 session 发任何请求（无旧 ticket 分片）；若旧 expectedGeneration renew 已发出则 409 PLAYBACK_GENERATION_STALE 不写票；旧 operationEpoch 响应即便携带新 generation 也被丢弃。UI：播放器随档案切换销毁，旧代次响应不覆盖新界面、不复活播放 | Chromium/Firefox/Safari；T032 慢转码样本 | HAR（切换时间点后无旧 session 请求为关键证据）+ 截图 | 未实现——T049–T053 实施后重跑 |
| US3-06 续期连续性 | 1) 档案A起播样本；2) 连续播放 ≥15 分钟，跨越 ≥2 次默认 5 分钟凭据续期（到期前 60 秒触发）；3) 记录每次续期时刻与播放位置；4) 确认播放未中断、进度未重置；5) Safari 单独经原生 HLS 轮换入口复验 | Network：每次 POST renew 在 ticketExpiresAt 前 60 秒发出、expectedGeneration 匹配并 200 换票；分片在新旧 ticket 间平滑切换，无 401/403 中断；GET 不重签不复现旧票；positionSeconds 单调连续。UI：全程有声有画，不重置到 0、不黑屏重启（SC-001） | Chromium/Firefox/Safari（Safari 必须原生 HLS，不得仅以 hls.js 模拟）；T032 HLS 与 MP4 各 ≥15 分钟样本 | HAR（renew 时间点 + 分片连续性） | 未实现——T049–T053 实施后重跑 |
| US3-07 seek | 1) 起播 NAS MP4 影片并播放 ≥1 分钟；2) 在进度条拖拽/点击跳至目标位置（如 10:00）；3) 立即观察 preparing 过渡；4) 计时至画面恢复于目标位置（≤15 秒）；5) 强化：恢复前立刻再发一次 seek/换轨制造交错 | Network：POST seek 200 返回 preparing + 新 generation/version 且无票；旧 ticket 分片随即使 401/404 拒绝；ready 后以新 generation renew 200 取新票；seek→renew→新分片命中目标区间总时序 ≤15 秒；直播样本 seek 返回 400 PLAYBACK_SEEK_UNSUPPORTED。UI：进度条为影片逻辑时间，不闪回目标前画面；恢复于目标位置；直播不提供 seek | Chromium/Firefox/Safari；T032 MP4 + 转码样本 + 直播样本 | HAR（时序计时 + 旧票拒绝证据）+ 截图进度条 | 未实现——T049–T053 实施后重跑 |
| US3-08 字幕/音轨 | 1) 起播含多音轨/多字幕样本；2) 依次关闭字幕、选择另一字幕、再关闭；3) 切换音轨；4) 观察视频是否重启；5) 对恶意字幕样本确认文本不执行 | Network：纯字幕切换 PUT selection 200 仅 version+1、返回现状态，无 preparing、无新票、无重新初始化分片（不重启视频）；切换音轨 generation/version 各+1 进入 preparing 无票，ready 后 renew 新票并重建音轨；字幕响应 text/vtt 且恶意内容不以 HTML 执行。UI：字幕即时生效不黑屏；音轨切换经 preparing 后恢复；关闭/选择状态正确保持 | Chromium/Firefox 以 hls.js 完整构建（非 light）验证；Safari 经原生轨道菜单复验并记录差异；T032 多音轨/多字幕样本 + 恶意字幕样本 | HAR（selection 前后 version/generation 差异）+ 截图轨道菜单 | 未实现——T049–T053 实施后重跑 |
| US3-09 资源忙 | 1) 设备1（Chromium）对需转码样本起播并保持占用默认并发 1 的转换额度；2) 设备2（Firefox）对另一需转码样本点击播放；3) 观察设备2提示；4) 设备1点击停止后设备2手动重试；5) 以配置并发 2 重复 1–4 | Network：设备2立即收到稳定忙（503 PLAYBACK_CONVERSION_BUSY，经 resolve 拒绝或 session failureCode 呈现），无排队任务产生；直接播放样本同时不受影响可起播；设备1停止释放额度后设备2重试成功。UI：立即显示「资源忙/稍后重试」友好提示，无排队进度条，可手动重试 | Chromium + Firefox 双端交叉；两个不同 T032 转码样本 | 双设备各一份 HAR | 未实现——T049–T053 实施后重跑 |
| US3-10 停止/失联 | 1) 起播任一样本；2) 点击停止；3) 再次点击停止验证幂等；4) 从 HAR 复制停止前的某分片 URL 重放（copy as fetch）；5) 另起播放后直接关闭标签页模拟失联，45 秒后用新会话查询该 session | Network：POST stop 204 且重复 stop 幂等不重复记录；停止后旧 ticket 的 manifest/分片重放均 401/404；GET 返回终态但不再签票；失联后服务端按判定回收（回收时序细节归 T058 后端证据），浏览器侧旧响应不复活任何播放。UI：播放器释放回详情页，无自动复活/重启 | Chromium/Firefox/Safari；T032 任一可播样本 | HAR（stop 后旧 ticket 重放被拒为关键证据） | 未实现——T049–T053 实施后重跑 |

### 与 T054/T055 的衔接

- T049–T053 实施完成并通过自身单测后，T054/T055 按上表逐场景重跑：同一 ID、同一步骤、同一记录格式，不得增删场景或放宽期望；Safari 场景必须原生 HLS 实测。
- 重跑结果（含每场景 HAR、通过/失败、环境与限制）串行回填 evidence.md「US3 浏览器链路（T054/T055）」节；按 tasks.md 执行顺序约束，evidence.md 与 api.ts/runtime-smoke 不得并行编辑。
- 任一场景重跑失败即保持对应 SC 条目未验收并记录失败证据；缺浏览器/夹具的缺口由 T054/T055 如实记录，不得以静态截图或历史后端 HTTP 证据替代浏览器 Network 层验收。
