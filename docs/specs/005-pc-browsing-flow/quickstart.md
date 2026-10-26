# Quickstart Validation: 005 PC 公开浏览与观看体验

状态：Proposed。本文是未来实现完成后的验证指南，不是本次已执行结果。005功能尚未实现时，新接口应当不可用；现有测试通过不代表005完成。禁止对用户库执行down、drill或清理。

## 1. 前置条件

- 使用仓库锁定Node>=24、pnpm11.28.5及依赖；先审阅接受spec/plan/ADR0010～0012，再完成后续tasks。
- Linux/NAS或开发环境具备004要求的FFmpeg/ffprobe和受支持本地媒体；使用独立受控IPTV/XMLTV、临时NAS媒体目录，不下载或删除用户媒体。
- 实现阶段准备200频道、500点播、每频道每天48节目、7天共67,200节目夹具；覆盖无EPG频道、重叠、跨日与可用性变化。夹具生成任务由后续tasks创建，当前没有可执行的005夹具命令。
- 家庭至少两个Profile（主成人、儿童或普通档案）、两个PC浏览器上下文；Chrome/Edge/Firefox/Safari记录版本。自动化WebKit不等于真实Safari。

## 2. 全新独立环境启动

以下为当前仓库已有命令；应在005实现后用于其新代际，不能现在执行就宣称新流程存在。`mktemp`只建立独立目录，不对现有DATA_DIR做删除或复制覆盖。

```sh
cd /Volumes/Extends/DevCache/Projects/10-projects/14-epg/redRoad
corepack enable
pnpm install --frozen-lockfile
redroad_validation_dir="$(mktemp -d /tmp/redroad-005-validation.XXXXXX)"
DATA_DIR="$redroad_validation_dir" pnpm migration:up
DATA_DIR="$redroad_validation_dir" pnpm dev
```

启动前核对有效DATA_DIR确为上述临时目录；若其他进程占用3000/5173，使用实现支持的端口配置，不停止未知进程。开发前端默认5173、服务端3000/api；从前端同源代理测试Cookie与Origin。日志中确认schema generation2就绪；旧已初始化库必须明确拒绝，不能自动升级或清空。

## 3. 静态与自动化检查

### 基础阶段（T013）

后续实施建立verify:foundation独立入口，范围仅为Phase 1～2已有能力：
契约生成、lint、全workspace typecheck/build及服务器基础、前端组件、PC浏览器
骨架三类显式冒烟，每类至少发现并执行1项有效用例且全部通过。记录发现/执行/
通过数，验证临时库与只读拒旧库、游客骨架不强制登录、凭据/错误/取消行为和未实现
管理能力的拒绝；不得等待后续故事用例存在，也不得用零用例成功或跳过失败替代。
该入口只代表基础就绪，不代表005功能、runtime或全部SC验收。

### 最终阶段（T144）

以下现有命令及未来完整verify:release入口应在故事全部实施后执行。根test须覆盖
server及web，E2E、runtime为独立必需入口；核对每类测试发现与实际执行数非零、
必需用例无遗漏并全部通过。最终入口不得使用基础阶段测试过滤、passWithNoTests、
临时skip/only或忽略失败。除此之外，还须完成本指南的Network、真实浏览器、
性能、恢复及T149真人验收；未验证项不能靠自动化通过替代。

verify:foundation/verify:release尚待实施建立，本次没有新增或运行这些脚本。


```sh
cd /Volumes/Extends/DevCache/Projects/10-projects/14-epg/redRoad
pnpm gen:types
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @hmp/web test:e2e
pnpm test:runtime
```

实施必须将005契约生成纳入gen:types、将对应contract/runtime场景纳入现有入口。当前根test仅运行server，不能将它当作前端测试；前端Vitest/Testing Library与Playwright依赖、脚本和夹具需要后续tasks建立，完成后再按新增实际脚本执行，本文不虚构已存在的命令。

验证OpenAPI本身可在不改源码的情况下将类型输出到临时文件：

```sh
pnpm --filter @hmp/shared exec openapi-typescript /Volumes/Extends/DevCache/Projects/10-projects/14-epg/redRoad/docs/specs/005-pc-browsing-flow/contracts/openapi.yaml -o /tmp/redroad-005-contract-types.d.ts
```

类型生成只证明契约可被工具读取，不证明运行实现或授权正确。

## 4. 浏览器与Network主流程

| 场景 | 操作 | 必须看到的结果 |
| --- | --- | --- |
| 新账号 | 打开首页，配置家庭/账号，提交 | 201无自动会话与Set-Cookie，随后手动登录；不要求来源导入 |
| 首档案 | 首次登录，填写主档案名称/6位PIN/账号密码 | 只创建一主成人档案；随后选择/解锁，不自动激活 |
| 设置 | 主档案菜单→设置→PIN | 设置主体在服务端授权后才请求；15分钟固定TTL，刷新/返回不续期 |
| 敏感写 | 在授权期间修改来源、策略或档案 | 仍要求当次账号密码，错误或缺少密码写入失败 |
| 导入 | 添加受控IPTV/EPG/NAS，执行刷新 | 创建后有导入下一步；成功发布后可查看内容；失败不清旧目录 |
| 游客 | 退出并在无cookie上下文打开首页/目录/详情/直播/guide | 公共数据全部可用，响应无个人数据、源地址或票据；播放才引导登录 |
| 原目标 | 游客点频道播放，完成登录选档 | 继续原频道的当前直播，不重新找内容；取消则不发媒体请求 |
| 儿童观看 | 选受限Profile，打开被播放策略禁止的内容 | 公开元数据仍可看，播放拒绝且无内部策略细节 |
| 收藏 | A收藏频道，再切B及游客 | 仅A个人区有该收藏；重复收藏/取消幂等，迟到响应不串档 |
| 续播 | A设备观看至120秒正常停止；B设备同Profile从历史进详情 | 继续观看与从头播放可选，继续误差<=5秒，从头为0；另一Profile无该进度 |
| EPG | 切今天至+6日、滚动/返回/查看节目 | 频道/时间清晰、7天范围、缺数据占位，未来节目不是回看/预约 |
| 设置模块 | 七子菜单各完成代表性读写并重启 | 数据持久化、CAS拒绝旧版本、过期不提交草稿，无空菜单 |

用Network确认public不靠Session/Profile参数、me和settings不返回身份外数据、媒体每次仍走受控网关；只看页面文字不能作为后端验证证据。

## 5. 负向与竞态矩阵

1. 初始化并发两次、已有档案再bootstrap、恢复PIN伪造目标、普通档案直接请求settings均拒绝，无部分写入。
2. PIN验证进行中换档/改PIN/撤销会话，哈希结束不能签旧grant；A→B→A不能复活旧settings或旧playback/ticket/progress。
3. PIN连续5错锁5分钟，刷新/新会话/重启不清锁定；设置15分钟到期边界严格拒绝，不因GET/修改/刷新续期。
4. progress started未收到ACK时重试原seq/payload；周期与final不越过首次确认；首次确认前用户seek/重建音轨禁用或排队，确认后才推进generation，取消/空stop仍可用。已确认seq12后再送11，或12不同payload、旧generation、跨Profile和失效会话，均不得破坏位置。
5. 旧设备resolve晚准备、新设备已起播、旧设备迟到started/periodic，不能夺回历史写入权；新设备只解析但未起播不能抢占。向后seek120→30允许保存30，不取最大值。
6. 从头播放准备失败保留原120秒历史；成功playing后才更新为新位置。contentRevision变化、时长缩短或位置到结尾时不续用旧位置。
7. finalProgress与stop原子提交；无效final不部分写，空stop仍可结束。重复已终态stop不改历史；换档/退出之后旧请求不能补写。
8. guide家庭时区跨日、America/New_York 2026-03-08/2026-11-01分别23/25小时；跨日节目按交叠查询。过期日期409回今天，窗口/节目超额422不能静默截断。
9. 源文本中的脚本/外部图片凭据不执行、不直接加载；公共与个人响应no-store；限频429及Retry-After符合合同。

## 6. 性能、响应式与进度恢复

- 固定硬件、网络、浏览器版本及200/500/67,200数据，首屏<=3秒、切日/回现在<=2秒，20次至少19次通过。记录集合查询数、响应字节、首个可操作视图，不只测空目录或后端函数。
- 模拟正常局域网播放后异常关页/断开，跨设备恢复丢失<=15秒；断网期间已明确提示未同步，不声称保存失败的位置已持久化。
- PC宽1024/1280/1440/1920/2560、高768/1080，窄窗768、高600、200%缩放分别/组合检查。只有EPG内部允许横向滚动；所有弹窗提交、取消及设置导航可达。
- 键盘完成登录/首建/选档/设置/收藏/节目墙列表，焦点可见且关闭恢复；无隐藏焦点陷阱。四种真实PC浏览器均保留证据，未实测项如实标未验证。

### SC-002 首次使用者人工验收

自动化T035仅证明流程可执行，不能证明首次使用者完成率。T149另邀请至少5名首次使用者，
在相同PC/局域网环境、无操作指导下完成账号建立、手动登录、首档案与选档、返回原目标。
记录匿名编号、开始/完成时间、是否求助及成功结果；至少4名在3分钟内独立完成才通过。
仅记录脱敏结果，不采集账号密码或PIN。无法组织样本时将SC-002标未验证，不以自动化时长替代。

## 7. 新代际迁移与恢复演练

只对**另一个独立空临时目录**执行已有迁移指令；不要对上方已初始化验证目录或任何用户库down：

```sh
redroad_migration_drill_dir="$(mktemp -d /tmp/redroad-005-drill.XXXXXX)"
DATA_DIR="$redroad_migration_drill_dir" pnpm migration:up
DATA_DIR="$redroad_migration_drill_dir" pnpm migration:down
DATA_DIR="$redroad_migration_drill_dir" pnpm migration:up
```

上例仅验证空库0006 up/down/up。另用生成过收藏/历史的新代际临时库做停服一致性备份→复制恢复到第三个临时目录→匹配新版本启动；核对历史/收藏保留、活动播放中断、设置grant失效、旧票拒绝、源媒体哈希不变。只对临时副本演练故障和schema回退；不要求恢复旧版已初始化业务库到新流程。

旧版本库拒绝验证使用离线临时副本，操作前后校验其文件哈希不变；不得用真实旧库试启动写入。交付回退用旧镜像+旧目录匹配对，不使用新库喂旧镜像。不提供自动reset命令。

## 8. 证据归档与完成判定

实施后在本功能目录新增evidence.md，逐项列FR/SC、命令/浏览器步骤、时间、版本、数据集、结果及未验证项；不在本轮预建空白“已完成”证据。静态、unit/contract、runtime、Network/PC、恢复演练分别归档，旧001～004的Verified记录不能替代005。

本指南所有未来步骤均为待执行，只有实际证据满足才可将spec从Implementing标Verified。Plan阶段完成不代表编码、部署、迁移或用户验收完成。
