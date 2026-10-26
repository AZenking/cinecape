# Research: 媒体目录与来源

日期：2026-10-23。研究完成；以下是技术设计选择，不是实现或验收证据。已完成一项只读子研究：Node 导入、XMLTV 解析与网络边界；仓库调用关系由主任务直接核对。

## R1 复用现有服务和策略核心

**Decision**：保留 Node 24 / NestJS 12 / SQLite / Drizzle / React 19 / HeroUI v3。新增来源、目录、刷新三个服务模块，不引入 Redis、独立 Worker 或第二数据库。
**Rationale**：现有 `authorizeCurrentProfile(context,mediaId,reader)` 已重读当前档案、策略；`evaluatePolicy` 是纯核心；`verifyParentPassword` 已实现账号级 5 次/5 分钟锁定。`writePolicyLists` 当前无版本参数和资源校验，不能直接暴露为名单 HTTP 写入口。
**Alternatives considered**：复制 magi 的队列/匹配工作台增加部署成本；重新写策略会产生两套授权规则。

## R2 有界流式解析

**Decision**：M3U 采用 UTF-8 流式解码与逐行状态机，支持明确的 Extended M3U 字段；XMLTV 新增 `sax` strict 流式解析（实施时锁定实际安装版本）。启用 strictEntities，拒绝 DOCTYPE、自定义实体、畸形 XML、过深嵌套；禁止外部实体解析。使用 Node zlib 流处理 gzip，压缩前后独立计数，不递归解压。
**Rationale**：不把整份节目指南构建成 DOM，保持 NAS 内存预算；HTTP 200 不等于合法播放列表/XMLTV。M3U8 在本期是频道列表输入，HLS 分片清单不是频道目录，无 EXTINF 频道记录时拒绝作为频道列表。
**Alternatives considered**：通用 XML-to-object 整文档解析会放大内存；播放器依赖不适合目录导入。宽松跳过非法条目违反 FR-005，必须整次失败。
**Sources**：[sax 官方文档](https://github.com/isaacs/sax-js)、[Node zlib](https://nodejs.org/api/zlib.html)。

初始技术上限：M3U 10 MiB、20000 条、单行 64 KiB；XMLTV 压缩传输 32 MiB、解压 128 MiB、500000 节目、单字段 64 KiB、32 层嵌套；NAS 每来源 100000 个受支持文件、目录深度 64。网络总预算 120 秒、空闲 15 秒、重定向最多 3 跳；NAS 扫描预算 10 分钟。超限失败并保留旧快照。为防累积存储，最多一个执行中任务（全进程），每来源最多一个执行中/待确认任务；待确认快照 24 小时到期。限值是本项目设计，不是外部标准。

## R3 远程读取与局域网授权

**Decision**：Node http/https 的 custom lookup 固定已验证 IP；保留原 hostname 的 Host/TLS 验证。每次请求和重定向均重新解析并校验全部 A/AAAA，规范化 IPv4-mapped IPv6。拒绝 loopback、link-local、unspecified、multicast、元数据目标和混合非法解析；不跟随自动重定向、不继承环境代理。局域网须同时满足部署环境精确主机/端口/IP 许可和来源上的家长明确批准；不提供“允许全部内网”开关。
**Rationale**：只校验 URL 文本无法阻止 DNS 重绑定或重定向绕过；NAS 家庭源必须可以通过精确许可接入。每跳采用独立连接，避免复用绕过目标校验。
**Alternatives considered**：普通 fetch 自动重定向没有完整的目标固定策略；仅靠前端校验无效。
**Sources**：[Node 24 HTTP](https://nodejs.org/docs/latest-v24.x/api/http.html)、[OWASP SSRF](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)。

远程地址/播放地址可能携带密钥，数据库和暂存表留在私有卷，日志仅输出稳定 code、来源/任务 id 和数量，不输出原地址、解析器原文或请求体；用户信息/查询值/路径不回显。来源编辑地址省略表示保留，显式替换必须提交新完整地址，不将掩码写回。请求头编辑不在本期。

## R4 NAS 只读扫描与稳定身份

**Decision**：部署者用只读挂载和 `MEDIA_ROOTS`（rootKey→绝对路径）授权根，来源只选 rootKey 和根内 relativeDirectory。拒绝绝对子路径、..、空字节、所有符号链接；逐层 lstat/realpath 校验根边界。只记录相对路径、大小与 mtime 纳秒，异步扫描让出事件循环；不打开整部媒体、不计算内容哈希。
**Rationale**：兼容容器挂载，避免用户任意索引宿主机。身份 = 来源内精确相对路径，文件变化按 FR-022 清允许项；同大小同时间替换是明确局限。
**Alternatives considered**：inode 跨挂载不稳定；全文件哈希昂贵且与已确认范围相冲突。此阶段不读媒体字节，也不提供文件下载，不能把扫描根校验当作未来播放文件访问的全部防护。

## R5 刷新先暂存、后原子发布

**Decision**：刷新请求验证家长身份后创建持久任务并立即 202；同一 Nest 进程的串行执行器异步读取/解析、分批暂存。发布时单个同步 SQLite 事务写媒体/资源/节目、missing 状态、NAS 分级与名单清理、策略版本、来源成功统计及任务终态。任务捕获 source.version 与家庭 catalogRevision，发布必须二者仍匹配；使用幂等 operationKey，重试返回原任务，不重复导入。
**Rationale**：解析阶段不占写事务，浏览旧快照；全局单执行器限制 NAS 负载。待确认不自动发布；确认重新验证 owner、任务版本、快照 hash、来源版本和目录修订。
**Alternatives considered**：逐条修改可见目录会留下半成品；删除重建破坏名单身份；队列服务不符合部署约束。

重启将 queued/running 标记 interrupted，过期待确认标记 expired；成功快照不变，用户手动重试。单来源待确认可 discard 后重新刷新；不实现自动调度/自动恢复执行。批准后的任务重新验证发起会话仍有效；会话撤销/设备撤销则失败，不保存密码到任务。

## R6 频道/EPG 身份与人工配置保护

**Decision**：按用户已确认：同 IPTV 来源先 tvg-id，否则完整 stream URL；重复身份拒绝，无 URL 拒绝，无名称兜底。标识键对潜在带凭据 URL 使用 SHA-256，原地址只存私有资源字段。每来源条目映射到稳定 UUID MediaItem，不跨来源自动合并。EPG 独立源、IPTV 选一 EPG；精确匹配 tvg-id，冲突不关联。
**Rationale**：沿用 magi 的主要身份规则和 LibreTV 的来源级 EPG 配置，避免不确定继承名单。不同来源同名不自动去重。
**Alternatives considered**：复制 magi 跨来源 merge key、模糊匹配、手动锁定/审批在原范围未纳入；2026-10-24 新增单频道手动锁定，完整审批仍排除。原项目同时存在旧重建流程，不将旧代码当作本项目迁移规则。

XMLTV 时间必须携带合法时区，统一 UTC 存储，响应 ISO 时间由界面按 Household 时区展示。channel id 重复或单频道节目时间重叠归为冲突，该频道显示暂无节目；缺必要字段/非法时间使整个导入失败。节目只保留刷新时刻前 24 小时至后 7 天且与该窗口相交的节目；“过期 EPG”依据当前时刻是否仍有有效节目，不承诺仅缓存刷新时间可证明可用。

## R7 目录批量授权与名单写入

**Decision**：详情用现有 authorizeCurrentProfile + 真实 ResourceReader；列表在单次同步读取事务中取得最新有效会话、档案、策略和家庭资源集合，复用相同 evaluatePolicy 顺序，再搜索/排序/分页/计数。不得先分页后过滤。初始实现可对 10000 条有界候选做内存判定，以 SC-005 实测决定是否需要等价 SQL 下推；不提前复制规则进 SQL。
**Rationale**：避免逐项异步授权的 N+1 查询和在翻页计数泄漏禁止内容。名单查询另走家长验证入口；不提供通用客户端上传 facts 的授权接口。
**Alternatives considered**：owner 绕过观看权限、前端过滤都不允许；将 SQL 判断与规则核心分叉难以保持一致。

新增独立 PUT 名单接口，同事务校验资源归属、频道类型、策略 expectedVersion 后替换三名单。现有等级 PUT 保持不改名单；共享同一个策略版本。NAS 文件变化发布事务从最新策略中删允许项，保留禁止项；每受影响档案只加一次版本。

## 研究结论

设计未知项均已给出选择和替代方案，无待用户回答的业务歧义。解析依赖实际版本和性能数值在实施期锁定/测量，不伪造为本轮验收。技术决策沉淀于 [ADR-0007](../../adr/0007-media-catalog-import.md)，实施前需接受新 ADR。

## R8 单频道手动 EPG 绑定（2026-10-24 增补）

**Decision**：借鉴 magi 的来源+频道配对、乐观版本和人工锁保护；保存即 manual 锁定，显式解除才 auto；目标失效保留配置，不隐式恢复自动。
**Rationale**：刷新不能覆盖家长选择；重建指南窗口不能级联删除绑定。候选查询可选择本家庭其他 EPG，修复 tvg-id 不同；仍不改变观看权限。media_id 独立于 source/epg 字段，保留既有名单和分级。
**Alternatives considered**：复制 magi 的可选 locked=false/全局候选/分步更新 canonical 会增加模糊状态和越权/部分提交风险。限定只选默认 EPG 无法处理跨指南人工修正，故手动模式允许同家庭任一已启用成功导入的 EPG。删除绑定行再创建会产生 version ABA，故解除写 auto 墓碑。
**Source evidence**：本轮只读 `magi/apps/api/src/application/output-composition/update-manual-epg-binding.use-case.ts`（来源/频道配对、版本冲突、清空）、`apps/web/src/features/dashboard/channels/epg-match-dialog.tsx`（搜索分页、选择/清除、锁定）和 `apps/worker/src/application/operation-safety/apply-epg-match.use-case.ts`（应用时重新跳过锁定）。原实现证据不是 redRoad 验收，不复制其独立 canonical 写入或前端库。
**Consequences**：新增 0004 表和 EPG generation，候选在查询后若导入变化则重新选；绑定修改推进 catalog revision，使旧待确认刷新失效。见 ADR-0008；本轮不锁定新依赖、不新增业务源文件。
