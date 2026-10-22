# 验收证据:应用脚手架与身份基础(001)

## 当前验收结论（2026-10-23，Phase 7 收尾）

此前 2026-10-22 的 Verified 包含未实测容器与未落实 owner 路由，已在本轮撤回并重新验收。以下为本轮结果；后面的记录仅用于历史追溯。

| 门禁 / 标准 | 当前证据 | 结果 |
| --- | --- | --- |
| 静态与构建 | pnpm lint、pnpm typecheck、pnpm build、git diff --check | 通过 |
| SC-001 初始化可用 | 全新临时数据库，编译后的同源服务提供 /setup；Ego 完成家庭/主账号初始化并自动登录 | 通过 |
| SC-002 登录性能 | pnpm test:runtime 真实 HTTP 连续 20 次登录，最终回归 p95=44ms（本机，同时运行双架构构建；不含镜像下载） | 通过 |
| SC-003/004/007 身份与负向门禁 | 7 文件 / 65 用例，含新增迁移缺失/未知版本/缺表、非 owner 创建编辑与伪造 role 拒绝 | 通过 |
| SC-005 重启持久化 | runtime-smoke 真实停止/启动进程后原 token 与 Active Profile 恢复；ARM64 容器重启后原会话恢复 | 通过 |
| SC-006 迁移与恢复 | runtime-smoke 在临时库执行 up→down→up、重复 up、SQLite backup 副本重新打开与 integrity_check=ok | 通过 |
| Docker/Linux | ARM64、AMD64 镜像构建；两架构均以 uid=1000(node) 启动并返回 healthz=200；ARM64 前端 SPA/JS 静态资源与重启持久化验证 | 通过（AMD64 在 ARM 主机上仿真） |
| 容器预算 | ARM64 空闲采样约 71 MiB，低于 512 MiB；不将空闲采样宣称为压力测试 | 通过（冒烟范围） |

真实浏览器使用独立域名 `hmp-stage1-qa.localhost:3181` 与独立临时数据库，未操作用户的 localhost:3000/5173 家庭实例。完成：初始化、创建默认成人档案、RadioGroup 选择儿童并创建 PIN 档案、错误 PIN 拒绝与剩余次数、正确 PIN 解锁选择、页面刷新恢复、退出、错误凭据提示、正确凭据登录、设备撤销确认与已撤销状态。没有使用 mock API 作为本轮主流程证据。

可重复运行：`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:runtime`。容器命令为 `docker build -t home-media-platform:stage1-qa .` 和增加 `--platform linux/amd64` 的同等构建；运行测试绑定独立端口及独立卷，不使用正式 hmp-data。

设计差异由 [ADR-0005](../../adr/0005-stage1-delivery-details.md) 记录。当前剩余边界：生产 bundle 约 620 kB，Vite 提示可拆分；未验证实体 Android TV 遥控器或实体 NAS，本规格只交付 Web 身份基础，硬件适配不作为已完成能力。镜像首次拉取曾遇 Docker Hub EOF，重试成功。

## 2026-10-23 HeroUI v3 组件修正回归

- 修正范围：Checkbox 组合结构、RadioGroup 互斥选择、Form 提交、原生按钮档案卡、PIN 捕获阶段键盘处理、弹窗保存失败保留输入，以及 v3 主题变量和语义色。遵循既有 US1/US2；接口、数据库及权限契约无变化。
- `pnpm --filter @hmp/web typecheck`、`pnpm exec eslint apps/web/src`、`pnpm --filter @hmp/web build` 与 `git diff --check` 通过。构建仍有大于 500 kB 的分块提示。
- 全仓 `pnpm lint` 未通过：server/vitest.config.ts、web/vite.config.ts、根 eslint.config.mjs 不在 ESLint project service 识别范围；本次未调整这些配置。
- Ego 浏览器使用内存模拟 API 验证：默认复选框切换后提交 isDefault=true；创建表单 Enter 提交；名称保存中取消被禁用、Esc 保留弹窗；模拟 PATCH 500 后名称和弹窗内错误提示均保留；档案卡键盘 Enter 可打开 PIN 弹窗。
- PIN 数字、退格通过 DOM 合成 keydown 验证，输入 1234、退格、5 后提交模拟接口收到 pin=1235；Ego 的数字键注入未产生对应 DOM keydown，不能将合成事件验证等同于实体键盘或遥控器验收。
- 上述模拟写请求未发送到真实后端；尚未验证 Android TV 遥控器、真实后端保存失败及本轮修改后的完整登录/初始化端到端链路。

- 日期:2026-10-22
- 性质:宪章原则 I 要求的多层证据(静态检查 / 单元 / 集成契约 / 运行时 / 网络)汇总留档
- 历史结论：曾标记 SC-001～007 全部满足；容器与 owner 校验证据不足，已由上方 2026-10-23 收敛验收取代。

## 1. 静态检查(T043 门禁)

| 检查 | 结果 |
| --- | --- |
| `tsc --noEmit`(server / web / shared) | 0 错误 |
| `eslint apps/server/src apps/server/test apps/web/src` | 0 问题(含类型感知规则 no-floating-promises) |
| `vite build`(web) | ✓ 1790 modules |

## 2. 自动化测试(SC-007 / T038)

全量 `vitest run`(Lead 于 2026-10-22 23:11 独立复跑):**6 文件 / 61 用例 100% 通过**

| 套件 | 用例 | 覆盖 |
| --- | --- | --- |
| us1-setup-login.e2e | 9 | FR-002/003/007/008/009、统一 401、Cookie 通道、无会话 401 |
| us2-profiles.e2e | 7 | FR-013/014/015/016、默认互换、最后可用 409、停用级联、伪造字段忽略 |
| us3-session.e2e | 15 | FR-005/010/011/012、滑动续期+绝对上限、恰好过期=已过期、注销/撤销幂等、重启持久化、跨家庭 404 同形 |
| password.hash.spec | 3 | argon2id 正误、明文不落库 |
| profile.rules.spec | 23 | PIN 状态机(计数/锁定窗口/过期重置)、默认互换纯函数、部分唯一索引与复合外键(权威 SQL 重放) |
| log-redaction.spec | 4 | 敏感键脱敏(password/pin/token/secret/authorization/cookie)、循环引用安全、纯函数性 |

**T038 负向完备性审计**(FR-019 逐条核对,全部有自动化用例):

| FR-019 场景 | 证据位置 |
| --- | --- |
| 无效/伪造令牌 | us3 c2、us1 无会话 401 |
| 过期会话 | us3 b1/b2(含恰好过期边界) |
| 已注销会话 | us3 c1 |
| 设备撤销后全会话 | us3 d1/d2 |
| 跨家庭 Profile 访问 | us2 d(404 与"不存在"逐字段同形,不泄露存在性) |
| 伪造 householdId/profileId/请求体注入 | us2 g(zod 剥离 + 会话信任源) |
| 绕过 PIN(未解锁 select) | us2 e(PROFILE_PIN_REQUIRED;授予一次性消费) |
| PIN 锁定窗口内正确 PIN | us2 e(423)+ unit 状态机 |
| 停用档案再选/引用 | us2 d/f + e2e 冒烟 |
| 响应泄露凭据哈希 | us1 场景 5、us2 a(断言无 pinHash/argon2 串)+ log-redaction.spec |

## 3. 迁移与回滚(SC-006 / T039)

`migration:drill`(2026-10-22 23:1x,全新 DATA_DIR):up → down → up 三阶段 exit 0;
down 后仅剩空 `_migrations`,up 后 6 表 + 命名索引(含复合外键目标 `account_household_id_id_key`、部分唯一索引 `one_default_profile`)完整恢复;
每次迁移前 `VACUUM INTO` 备份生成且可打开。复合外键拦截跨家庭 Profile、部分唯一索引拒绝双默认 —— 均有单测以权威 up.sql 内存重放验证。

## 4. 运行时与网络证据(SC-001~005,T040)

真实 HTTP 冒烟(`tsx dist` 启动 + curl,quickstart 场景 1-3 全流程):

- **场景 1(初始化+登录)**:status false → initialize 201(43 字符一次性 token、role=owner、activeProfile=null、Set-Cookie hmp_session HttpOnly)→ 重复 initialize **409 problem+json**(INITIALIZATION_ALREADY_DONE,Content-Type 正确)→ 错误密码与不存在账号统一 **401 INVALID_CREDENTIALS** → Cookie 访问 /household 200 → 无会话 401
- **场景 2(Profile 与 PIN)**:创建 adult(默认)/child(PIN)→ 默认互换后全局唯一 → select-adult 200 → select-child 未解锁 403 PROFILE_PIN_REQUIRED → 错误 PIN ×5 全 403(第 5 次触发锁定)→ 锁定窗口内正确 PIN **423 PROFILE_PIN_LOCKED** → 停用会话当前观看档案 → `/auth/session` activeProfile 级联清空为 null
- **场景 3(会话生命周期)**:第二设备登录 → 用其撤销初始化设备 → 被撤设备会话立即 401、执行者不受影响 → 重复 revoke 204 → logout 204 → 重复 logout **204(幂等)** → 注销后 401
- **重启持久化**:us3 f1 用例(AppModule 同 DATA_DIR 重建)验证身份数据与会话状态完整保留

## 5. 性能采样(SC-002 关联,T042)

- 登录 ×10(本机,argon2id 全程):min 27ms / **中位 28ms** / max 30ms —— 远优于"局域网 p95 < 300ms"目标
- 会话恢复(带滑动续期写):同数量级(未见 >10ms 增量)
- 容器内存预算(<512MB)与镜像构建:Docker daemon 未运行(OrbStack 未启动),`docker compose config -q` 语法校验通过,**完整镜像构建待 daemon 可用后补充执行**

## 6. 历史已知边界（以当前验收结论为准）

1. 设备策略:每次登录新建 Device 行(无 deviceId 入参,契约限制);设备合并/去重属后续增强
2. ProfileManage 页 owner 专属收紧以 TODO 标注(当前所有登录者可见管理页,写操作权限模型属阶段 2 一并处理)
3. SessionDto 未暴露当前设备 id,Devices 页无法标记"本机"(契约限制)
4. 解锁授予表为进程内存实现(单实例前提下成立;多实例须外置,ADR-0002 已锁定单实例)
