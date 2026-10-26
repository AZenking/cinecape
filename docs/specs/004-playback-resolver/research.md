# Research: Playback Resolver

日期：2026-10-25；状态 Proposed。以下数值是项目设计预算，均需实施后实测，不是工具默认值或已取得的性能证据。

## R1 交付与能力

Decision：同源网关；HLS H.264/AAC，NAS 可兼容MP4直接Range；其余按 probe 结果依次选择复制轨道转封装、仅音频转换、必要视频转换，输出 H.264 8-bit yuv420p/AAC HLS。默认统一保守客户端能力集，不依赖客户端报告授权；可做浏览器功能检测选择原生HLS或hls.js，不向客户端发送源位置。4K/HDR仅尽力直放，不能误当SDR转码处理。

Rationale：浏览器支持取决于容器、编码、系统和MSE组合；统一保守输出覆盖1080p必验范围。Alternatives：全部视频转码浪费资源；容器后缀推断能力不可靠；全格式直放无法满足HEVC/DTS兼容。

## R2 会话、凭据与续期

Decision：随机256-bit opaque ticket，服务端仅存hash，TTL默认300秒（部署60～900秒）；同时必须提供原设备Cookie/Bearer且当前档案等于绑定档案。每次请求从可信数据库重验；清单子资源均映射为受控opaque asset ID。续期默认提前60秒，复用播放会话/转换任务，只换ticket，签发使用expectedGeneration事务比较及客户端operationEpoch；首次ready后同端点签票，preparing不签票；主动重新播放才新建session。凭据过期、旧generation、权限拒绝均失败关闭。

Rationale：仅凭短URL无法防止复制跨设备；续期新建任务会耗尽并发。Alternatives：签名URL单独充当认证、只检查到期、每次续期重启转码均不采用。

## R3 安全HLS和NAS输入

Decision：上游HTTP由应用层受控读取，复用导入的精确LAN许可原则，并扩展流式backpressure/取消，不能直接复用其整文件缓冲预算。每次DNS/redirect验证，禁止FFmpeg直接抓远程URL；NAS通过验证过的只读文件描述符输入，拒绝越界/符号链接且核对size/mtime，子进程以参数数组、shell=false启动，禁用网络协议和任意嵌套外部引用。探测及字幕也沿用边界。

HLS支持普通/多变体直播、相对URI、初始化MAP、byte-range、AES-128 identity key的授权代理；重写所有可获取URI，包括子清单、segment、key、MAP和媒体轨，验证每级目标。拒绝DRM/SAMPLE-AES、未知URI扩展、循环、data/file等协议，不透传原文。嵌套<=4、单清单<=2MiB、每清单URI<=10000、redirect<=3、连接/首字节<=15秒；流请求空闲15秒中止；key<=16字节且必须长度合法；分片单响应<=64MiB，超过失败。客户端断开取消上游，有限背压，不整片常驻内存。上游状态/错误映射稳定码，不透传Location、Set-Cookie、server细节。Range只允许单区间，206/416标准语义，HEAD无响应体。

Rationale：清单重写只覆盖segment会泄漏key或绕过SSRF；字节流代理与导入有不同预算。Alternatives：把原HLS交给浏览器或FFmpeg网络直连均不采用。

## R4 转换资源与时限

Decision：并发默认1，可配置1～8，所有remux/transcode共用原子额度，不排队；probe独立并发2、队列最多8，超额忙。ffprobe上限10秒/输出1MiB；选轨只接受服务器返回ID。软件转码每任务最多2线程（可配1～8）；默认固定最高1080p、不自动降分辨率、视频目标8Mbps（上限12Mbps）、音频AAC 192kbps，转封装不重编码。

私有滚动HLS窗口120秒、目标分片4秒；每任务缓存上限512MiB、全局2GiB、剩余磁盘低于1GiB禁止新转换并停止继续写入，返回PLAYBACK_STORAGE_LIMIT。缓存窗口前后seek创建新generation并从目标位置启动，不因旧分片缺失跳回开头；所有jump都保留同一session且串行换代，不同时占两个转换额度。转封装同样受磁盘预算；暂停时有界预取后暂停生产，续播恢复，paused心跳不等于失联。

首次准备30秒、seek15秒是硬超时。开始后每10秒计算最近30秒输出媒体时长/墙钟时间，连续3次小于1且可播放缓冲<8秒则停止并返回PLAYBACK_PERFORMANCE_INSUFFICIENT；避免仅以初始瞬时speed误杀。实测前不宣称任何CPU实时性能达标。

Rationale：提供可二元验证的资源/性能边界。Alternatives：无限预转整片、无限排队、自动降到480p不符合已选范围。CPU线程并非硬CPU/内存隔离；发布部署提供cgroup CPU/内存限制，默认验收容器4 CPU/4GiB，实测失败要调整实现或记录阻断，不放宽成功标准。

## R5 生命周期与崩溃

Decision：前端每15秒heartbeat（暂停也发）；45秒无心跳判失联。stop/cancel/失败/权限失效立即终止任务，SIGTERM后5秒SIGKILL；释放额度在确认退出后，不能未退出就启动新进程。终止后60秒内清理目录，失败每60秒重试并保持cleanup_state=pending，磁盘占用仍计预算；启动时将活动session/job标interrupted并扫本实例私有根，不使用旧PID杀无关进程；清理完成才接受新转换。session ID不可复用、产物不跨档案共享。心跳和媒体请求均可触发权限失效回收，后台每15秒复核活动任务的授权。

Rationale：离线页不能留下永续转码；不能以回收失败释放磁盘账本。Alternatives：仅依赖浏览器stop信号、不记录任务状态、重启自动恢复旧授权均不采用。

## R6 字幕、轨道与记录

Decision：内嵌SRT/SubRip/WebVTT及影片同stem的.srt/.vtt旁车，只读且<=5MiB；最多32条音轨/字幕轨，probe超限提示不支持；SRT转换WebVTT，文本仅作为字幕显示，禁HTML脚本。无ASS特效/图片字幕/烧录。默认音轨，字幕默认关闭；音轨切换如需转换复用session并换generation、保存position，旧请求409。owner+当次密码POST查询设备播放记录，no-store；普通观看者只能读自己的播放session。记录留30天，每日清理；失败事件媒体不可见则media_id=null，无效会话不入设备记录。日志不记录原路径、URL、query ticket或FFmpeg原始stderr；只保留稳定码/脱敏技术摘要。

Alternatives：读取任意旁车路径、任意客户端轨道索引、默认暴露所有profile记录均不采用。

## R7 迁移与交付

Decision：仅新增0005，必需表/列就绪缺失503；停服一致备份，down删除004新增播放状态，保留001～003目录/身份/策略/EPG；down/up不恢复播放记录，恢复需备份。迁移前禁止活动转换，退出清理后执行。FFmpeg系统包和hls.js实施阶段锁版本并核验解码/编码器；硬件优先Linux VAAPI/QSV（显式render设备）、可选NVENC，缺失回退软件；arm64不能假定通用硬件加速，软件路径必验。不得以amd64仿真证明硬件编码可用。

Alternatives：改旧迁移、打包所有厂商驱动、特权容器均不采用。

## Primary references

研究依据：

- [FFmpeg command reference](https://ffmpeg.org/ffmpeg.html)：streamcopy与选择性编码、seek的关键帧限制、机器可读progress、硬件能力受构建与设备驱动约束。
- [FFmpeg HLS muxer](https://ffmpeg.org/ffmpeg-formats.html#hls-2)：初始化片、分片窗口与删除；滚动窗口不是整片VOD随机定位方案。
- [hls.js official project](https://github.com/video-dev/hls.js)：MSE/原生HLS检测，音轨/字幕需完整构建，不能用light版本替代。
- [hls.js HlsConfig](https://hlsjs.video-dev.org/api-docs/hls.js.hlsconfig)：fetchSetup/xhrSetup等加载配置。
- [RFC 8216](https://www.rfc-editor.org/rfc/rfc8216.html)：variant/rendition、MAP、key和分片引用必须全部纳入代理。

具体决策是上述能力与本项目需求的设计推导，数值不是官方推荐。版本及编译特性由实施证据固定。

## R8 时间轴、续期与回退细节

Decision：保留完整影片duration与逻辑position；滚动HLS只代表当前生产窗口，不伪装成完整VOD。seek经控制端点换generation，从源关键帧之前开始时返回 timelineOffsetSeconds、presentationStartSeconds；播放器丢弃/跳过目标前画面，按逻辑影片时间显示，必要时转码才能实现准确定位。默认进度控件由应用时间轴驱动，不能仅依赖HLS seekable范围。

hls.js使用完整构建与自定义加载入口，子资源请求时取得当前有效ticket；原生HLS由客户端到期前设置新入口URL并恢复逻辑位置，不能假定可为原生video设置Bearer header，浏览器路径统一Cookie。清单中嵌入的旧ticket有原TTL；新入口及清单用新ticket，轮换连续性须Safari实测；无法跨两次续期连续播放即验收失败，不放宽标准。主应用Cookie/Authorization绝不转发上游，源凭据仅由该源的私有配置决定。

硬件初始化或编码失败最多回退软件一次，仍受原30秒/15秒期限；已开始交付后不做隐藏无限重试。检测转码速度时排除主动暂停、按生产窗口节流与客户端暂停，否则会把正常背压误判为性能不足。15秒无输出且并非上述正常等待时停止任务并返回资源/转换稳定失败；SIGTERM有5秒宽限，quickstart相应按启动终止与确认退出分别计时。

Alternatives：把窗口位置当影片位置、续期新建转换、无限切换硬件/软件，均不采用。

## R9 分析问题闭合

Decision：接受/准备/交付分离为preparing/ready/playing；模型可空字段与状态约束见data-model.md；同成本不引入未定义priority，使用处理成本+稳定ID排序。模型只保留一个权威定义，任务引用章节。seek/音轨重建进入preparing且旧generation拒绝，renew事务CAS与客户端操作代次共同阻止交错结果覆盖。Alternatives：同步等待probe无法保障解析延迟，准备前猜测delivery不可靠，复制多份模型易漂移，均不采用。

## 依赖版本锁定（T004，2026-10-25）

### hls.js

- **精确版本**：`hls.js@1.7.3`（`pnpm --filter @hmp/web add hls.js` 安装；apps/web/package.json 记为 `^1.7.3`，pnpm-lock.yaml 解析锁定 `hls.js@1.7.3`，无额外依赖）。
- **完整版确认**：npm 包 dist 同时含完整构建 `hls.mjs`/`hls.js`（含 alt-audio 音轨与字幕轨支持）与精简版 `hls.light.*`；`import Hls from 'hls.js'` 默认入口指向完整构建。R1/R8 要求的音轨/字幕能力依赖完整版，禁止改用 light 版。
- **许可证**：Apache-2.0（LICENSE 文件：Copyright (c) 2017 Dailymotion；其中 src/remux/mp4-generator.js 与 src/demux/exp-golomb.ts 派生自 videojs-contrib-hls，Copyright (c) 2013-2015 Brightcove，同为 Apache-2.0）。纯浏览器 JS，无原生依赖，不触及 R4 服务器资源预算。

### FFmpeg

**本机参考环境（macOS arm64，Homebrew，仅作能力参考，非部署目标）**

- 版本：`ffmpeg version 8.1.1`（ffprobe 同版本随装），Apple clang 21 构建。
- configuration 行：`--enable-shared --enable-pthreads --enable-version3 --enable-ffplay --enable-gpl --enable-libsvtav1 --enable-libopus --enable-libx264 --enable-libmp3lame --enable-libdav1d --enable-libvmaf --enable-libvpx --enable-libx265 --enable-openssl --enable-videotoolbox --enable-audiotoolbox --enable-neon`。
- **许可证结论**：含 `--enable-gpl` → 本机二进制整体按 GPL 分发（`--enable-version3` + Apache-2.0 的 OpenSSL 3 组合，实际 GPLv3+）。本机仅开发使用、不分发，无合规负担。
- **编码器**（encoders 过滤）：`libx264`（H.264 软编）、`libx264rgb`、`libx265`（HEVC 软编）、`h264_videotoolbox`、`hevc_videotoolbox`、`prores_videotoolbox`、`aac`（原生软编）、`aac_at`（AudioToolbox）；无 nvenc/vaapi/qsv（macOS 本就不提供）。
- **解码器**（decoders 过滤）：`h264`、`hevc`（软解，Main/Main10 覆盖 8/10bit，frame+slice 多线程，可选 videotoolbox 硬解）、`aac`/`aac_fixed`/`aac_latm`、`ac3`、`eac3`、`dca`（DTS，含 core_only 选项）。HEVC 10bit（Main10）由同一 hevc 解码器覆盖，无需额外组件。
- **硬件加速**：本机仅 VideoToolbox（编码 h264/hevc/prores + 解码侧可选设备）。部署目标为 Linux，VideoToolbox 结论不适用。

**部署目标镜像（node:24-bookworm-slim = Debian 12 bookworm）**

- 安装方式：runtime 阶段 `apt-get install -y --no-install-recommends ffmpeg`（已加入根目录 Dockerfile；不特权、不自编译；bookworm 无单独 ffprobe 包，**同一 `ffmpeg` 包同时提供 `/usr/bin/ffmpeg` 与 `/usr/bin/ffprobe`**，ffprobe 可用性由包内容保证）。
- 版本来源：Debian 发行版仓库（bookworm main + security），当前 `7:5.1.9-0+deb12u1`（初版 `7:5.1.7-0+deb12u1`，经 security 更新至 5.1.9；随 apt 安全更新浮动，主版本固定 5.1.x）。
- 编译特性：Debian 发行版构建启用 GPL 组件（含 libx264/libx265），提供 H.264/HEVC 软件编码；许可证为 GPL 组件启用版的主程序 + 各链接库独立许可（libx264 GPL-2.0+ 等）。仅服务器以子进程调用，不分发 FFmpeg 本体。镜像内复核命令：`ffmpeg -version | sed -n 3p` 应见 `--enable-gpl --enable-libx264`。
- 解码/编码可用性（按 bookworm 构建预期）：解码 h264/hevc(8/10bit)/aac/ac3/eac3/dts 软解齐备；编码含 libx264、libx265、原生 aac（无 libfdk_aac，R4 的 AAC 目标用原生 aac 编码器即可）；无 videotoolbox/nvenc；vaapi/qsv 解码器存在但需硬件与驱动（见下）。
- 验证状态：本开发环境无法访问 Docker Hub（registry-1.docker.io 不可达，`docker pull debian:bookworm-slim` 失败），镜像层未实测；上述为发行版打包事实 + 构建期复核命令（`docker build -t hmp:verify . && docker run --rm hmp:verify sh -c 'ffprobe -version | head -1 && ffmpeg -version | sed -n 3p'`）。

### 双架构支持（linux/amd64 与 linux/arm64）

- `node:24-bookworm-slim` 官方镜像清单含 linux/amd64 与 linux/arm64（Dockerfile 头注本就按 amd64/arm64 设计）。
- Debian bookworm 的 `ffmpeg`（7:5.1.9-0+deb12u1）对 amd64、arm64（及 armhf/ppc64el/s390x 等）均有官方构建，apt 双架构直接可用；libx264/libx265 等依赖库双架构同样有发行版构建。无需交叉编译或第三方静态构建。
- 硬件加速不属于双架构保证：VAAPI/QSV 是 amd64 侧典型能力且需部署侧传递 `/dev/dri` 设备（非特权配置）；arm64 不假定通用硬件加速，软件路径双架构必验（与 R7 一致）。

### 对 R4 预算的影响备注

1. **版本基线差异（最重要）**：镜像内是 FFmpeg 5.1.9，本机参考是 8.1.1。R4 的首次准备 30 秒/seek 15 秒硬超时、10 秒窗口 speed 采样、1080p 8Mbps 2 线程实时性等指标必须在目标镜像内以 5.1.9 实测，不得用本机 8.1.1 数据外推（老版本软编/软解性能通常更低，5.1 与 8.1 的 x264 版本与调度也有差异）。
2. **编码路径成立**：发行版 GPL 构建含 libx264 → H.264/yuv420p 软编路径无需自编译；AAC 用原生 aac 编码器（LGPL）。R4 的 2 线程/任务限制在 x264 上按 `threads` 参数落实。
3. **镜像体积**：ffmpeg 及依赖（libavcodec59/libavformat59/libavfilter8、x264/x265、libvpx 等）预计为 bookworm-slim 镜像新增约 250~350MB 磁盘占用（以实际构建为准）。这只影响镜像分发体积，不影响 R4 的运行时缓存预算（512MiB/任务、2GiB 全局、1GiB 数据卷余量阈值针对数据卷）。
4. **probe 预算不变**：ffprobe 来自同一 Debian 包，10 秒/1MiB 输出上限、并发 2/队列 8 的 probe 预算照旧；5.1.x 的 probe 输出格式与 8.x 兼容解析路径需在实施时以样本文件验证。
5. **硬件加速不进预算基线**：本机 VideoToolbox 结果不适用；R4 性能验收以软件路径为准，VAAPI/QSV 仅作 amd64 部署侧可选加速（需 `/dev/dri` 设备映射，非特权），失败按 R7 最多回退软件一次。
6. **并发额度不受影响**：apt 安装仅改变镜像内容，转换任务原子额度（默认 1）与队列策略不变。
