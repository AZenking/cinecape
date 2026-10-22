# Research: 应用脚手架与身份基础(001-scaffold-identity-foundation)

- 日期:2026-10-22
- 输入:[spec.md](spec.md) · [宪章 1.0.1](../../../.specify/memory/constitution.md) · [领域模型 V1.1](../../../homeMediaDomainModel.md) · [ADR-0002](../../../docs/adr/0002-one-deployment-one-household.md) · [ADR-0003](../../../docs/adr/0003-constitution-alignment.md)
- 输出：选型已由 [ADR-0004](../../adr/0004-technology-stack.md) 接受；迁移与交付实施差异由 [ADR-0005](../../adr/0005-stage1-delivery-details.md) 补充。
- 版本号说明:写作时(2026-10)Node 24 为 Active LTS([nodejs.org](https://nodejs.org/en/blog/release/v24.22.1)),NestJS 12 已发布;具体小版本在实现时通过 `package.json`/lockfile 固定。

## D1 语言与运行时

- **Decision**: TypeScript(5.x,strict)+ Node.js 24 LTS。
- **Rationale**: 单语言贯通前后端,DTO/契约类型可共享(宪章要求领域核心不依赖前端框架,共享类型包是实现该解耦的最直接手段);家庭自托管媒体领域的成熟参照(Jellyfin Web、immich)均为 TS 生态;async I/O 模型贴合"低并发、长会话"的家庭场景。
- **Alternatives considered**: Go(单二进制分发好,但前后端两套类型、两套心智);Rust(资源占用最优,迭代与维护成本对本项目过高);JVM(内存占用与 NAS 场景不匹配)。

## D2 仓库结构与包管理

- **Decision**: pnpm(11.28.5)workspace monorepo:`apps/server`(API)、`apps/web`(前端)、`packages/shared`(契约类型/DTO)。
- **Rationale**: 宪章要求领域核心与 UI 解耦——`packages/shared` 让契约类型独立于两端;pnpm 硬链接省磁盘(NAS 常见小盘)且 workspace 协议成熟。
- **Alternatives considered**: 单包应用(前后端耦合在一个 package,违背解耦意图);Turborepo/Nx(当前仅 3 个包,缓存编排收益为零,不引入)。

## D3 后端框架

- **Decision**: NestJS(12.x,默认 Express 适配器)。
- **Rationale**: 模块系统与领域模型 §7 的模块边界(auth/household/profile/policy/media/playback/personalization)一一对应;Guard/Interceptor 是"服务端会话为唯一信任源"(FR-018)的横切强制点,避免每个接口手工校验;内置依赖注入与 e2e 测试设施,利于 SC-007 的负向测试门禁。
- **Alternatives considered**: Fastify/Hono 裸写(更轻,但模块纪律、DI、测试设施要自建,长期一致性差);Spring Boot(JVM,与 D1 冲突)。

## D4 数据库与 ORM/迁移

- **Decision**: SQLite(WAL 模式)+ better-sqlite3 驱动 + Drizzle ORM + 仓库 SQL 迁移执行器（ADR-0005）;每条迁移目录内配对 `up.sql`/`down.sql` 回滚脚本,迁移前自动备份 DB 文件,回滚路径必须实际演练(满足宪章"经测试验证的回滚方案")。
- **Rationale**: 单部署 = 单家庭(ADR-0002),SQLite 零运维、单文件备份、Docker 卷即可持久化;Jellyfin/Home Assistant 同路线验证过该场景;同步驱动在低并发下性能最好。显式 `household_id`(FR-006)由 schema 层唯一约束 + 查询构造器强制。
- **Alternatives considered**: PostgreSQL(能力过剩,家庭部署多维护一个进程,违背轻量约束);Prisma(迁移回滚路径弱于配对 down 脚本);Knex(无 schema 类型)。

## D5 会话与凭据机制

- **Decision**:
  - 会话凭证 = 32 字节 CSPRNG 不透明 token;DB 仅存 SHA-256(token) 哈希,明文只在签发时返回一次;
  - 传输通道:Web 用 httpOnly Cookie(`SameSite=Lax`,`Secure` 可配置以兼容家庭局域网 HTTP),TV/第三方客户端用 `Authorization: Bearer`;
  - 密码与 Profile PIN 均用 argon2id 哈希;
  - 会话 30 天滑动过期(每次认证使用刷新),绝对上限 90 天;PIN 锁定默认 5 次失败锁 5 分钟——两者均可经环境配置覆盖(落实 spec Assumptions 的待定数值)。
- **Rationale**: FR-010/011 要求注销与设备撤销**立即**生效、FR-018 要求服务端会话是唯一信任源——服务端会话表是满足这三条的最直接模型;JWT 天然难撤销,需要额外黑名单,反而更复杂。
- **Alternatives considered**: JWT + 刷新令牌(撤销需黑名单,复杂度更高);仅 Cookie(电视端接入不便);bcrypt(argon2id 是当前密码哈希最佳实践,抗 GPU 更强)。

## D6 前端与 UI 方向(回应"UI 参照")

- **Decision**: React 19 + Vite + Tailwind CSS v4;基础组件库采用 **HeroUI v3**(`@heroui/react` + `@heroui/styles`,2026-10-22 选型评审确认)——其底座为 React Aria Components,焦点环/键盘导航/`onPress` 统一鼠标·键盘·遥控器输入,直接服务 TV 友好方向;媒体特有组件(海报卡、Profile 档案卡、播放器控件)自建于同一 Tailwind v4 token 体系;播放器内核 hls.js + 原生 `<video>`(阶段 4 接入,本阶段仅预留)。
- **UI 参照(产品方向,不锁像素)**:
  - **Profile 选择页 → Netflix 档案选择页**:大头像卡片横向排列,点击进入个人空间;受 PIN 保护的档案带锁标记;
  - **媒体首页 → Netflix/Apple TV 海报墙**(阶段 3 起生效):横向分排、焦点滚动;
  - **儿童模式 → Netflix Kids / YouTube Kids**:大卡片、高饱和、无复杂导航、明确返回入口(FR-017 的界面模式落地);
  - 全局:暗色优先、10 英尺界面友好(焦点环清晰、点击目标 ≥ 44px)、移动端/平板/TV 三档响应式。
- **交互范式(市面参照,2026-10-22 选型评审补充,方向性不锁实现)**:
  - Profile 切换 = Netflix 式全屏档案页(入口)+ Apple TV 式角落头像下拉(进场后快速切换);
  - PIN 输入 = 3×4 数字键盘浮层,错误整排抖动清空,仅提示剩余次数(与 FR-015 一致);
  - 会话恢复 = 自动回到上次 Profile,被停用时静默回落默认档案 + 轻提示(FR-016 的体验化);
  - 媒体浏览(阶段 3)= 横向 Rail + 顶部导航(Netflix 式);IPTV/EPG 采用半屏迷你指南(频道×时间矩阵 + 右侧预览),管理页用侧边栏 + 网格;
  - 播放(阶段 4)= 暂停出控制条 + 进度缩略图预览、跳过片头、10s 快进退、自动连播倒计时;Web 键盘快捷键对齐 YouTube 范式;
  - TV 遥控(未来)= 方向键空间导航,候选库 Norigin Spatial Navigation(活跃维护);现在只需保证组件树成规整行列、交互统一走 onPress/焦点事件(HeroUI 的 React Aria 底座原生满足)。
- **Rationale**: 参照产品是家庭媒体场景的公认范式,成员认知成本最低;HeroUI v3 与已定栈完全同源(Tailwind v4 原生、无 Provider、CSS 动画零额外依赖、oklch 暗色主题),React Aria 底座是当前键盘/焦点管理最强的方案(有真实电视生产环境案例),阶段 1 的标准件(表单、PIN 弹窗、设备列表、Toast)直接覆盖;antd/MUI 等管理后台组件库与媒体消费场景不匹配。
- **Alternatives considered**: Vue 3 + Naive UI(生态同样可行,但 TS 全栈类型共享以 React 生态工具链更顺);shadcn/ui(组件源码进仓库、视觉自由度与生态最大,但 Base UI/Radix 基座偏鼠标指针交互,10 英尺焦点导航需自建,默认审美偏管理后台);React Aria Components 裸用 / 维持全自建(控制力最强,但阶段 1 即需手写全部标准件,成本不成比例 —— HeroUI 本身即 React Aria 的预样式封装,选它等于保留该底座而免掉自建成本)。

## D7 契约与类型共享

- **Decision**: `contracts/openapi.yaml`(OpenAPI 3.1,手写先行契约)→ `openapi-typescript` 生成类型到 `packages/shared`;服务端运行时校验用 zod DTO(与 OpenAPI 字段一一对应,契约测试保证一致);错误格式统一 RFC 9457 `application/problem+json`。
- **Rationale**: 契约先行符合宪章"代码实现规格"的顺序;生成类型消除前后端 DTO 漂移;problem+json 是标准化的错误语义,负向测试可直接断言。
- **Alternatives considered**: tRPC(强类型最好,但把契约绑定到 TS 实现,失去与未来 TV 原生客户端解耦的能力);手写 class-validator(与 OpenAPI 双份维护)。

## D8 配置管理

- **Decision**: zod schema 校验环境变量,启动时 fail-fast;提供 `.env.example`;任何密钥不进代码与镜像(FR-004)。
- **Alternatives considered**: 远程配置中心(单家庭场景过度设计)。

## D9 测试策略

- **Decision**: Vitest(单元)+ NestJS e2e(Supertest)做集成与契约测试;OpenAPI 契约断言;FR-019 全部负向场景必须自动化并纳入合并门禁(SC-007);SC-006 的迁移回滚用 CI 步骤实际执行 up→down→up 验证。
- **Rationale**: SQLite 文件级数据库无需容器化测试依赖,测试启动快;负向用例是宪章原则 I 的硬门禁。

## D10 交付形态

- **Decision**: 多阶段 Dockerfile(amd64 + arm64)+ `docker-compose.yml`(单服务 + 数据卷 `/data`:SQLite 文件与备份)+ 容器 healthcheck 探活 `/healthz`。
- **Rationale**: 宪章技术约束 1(Docker/Linux、主流 NAS、轻量);compose 单文件即"开箱可部署"(SC-001)。
- **Alternatives considered**: 裸进程 systemd 部署(作为 Docker 之外的文档化备选,不做一等交付);Kubernetes(严重过度设计)。

## 性能目标与约束(供 tasks 阶段拆解)

- 局域网内登录 p95 < 300ms;带会话校验的请求服务端额外开销 < 20ms;
- 容器内存预算 < 512MB;冷启动 < 10s;
- 运行时零外呼:无遥测、无强制云依赖(宪章原则 IV);
- 规模上限:1 Household / 1 Account / ≤ 20 Profiles / ≤ 50 Devices。

## 未决项

无 —— spec 中全部待定数值(会话时长、PIN 锁定)已在本文件给出可配置默认值。ADR-0004 已接受；2026-10-23 实施差异由 ADR-0005 补充。
