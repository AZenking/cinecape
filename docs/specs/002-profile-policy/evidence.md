# Evidence — 002-profile-policy(实施期证据记录)

状态:实施中(Implementing)。以下记录 2026-10-23 实际执行的命令与结果;未执行项如实标注,不以其他证据替代。

## 自动化门禁(T029)

执行时间:2026-10-23 12:20 前后,工作区 redRoad @ master(未提交变更)。

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 静态检查 | `pnpm lint` | ✅ 0 error |
| 类型检查 | `pnpm -r typecheck`(shared/server/web) | ✅ 0 error |
| 单元+契约 | `pnpm --filter @hmp/server test`(vitest) | ✅ **15 文件 / 109 用例全通过**(阶段 1 的 65 用例回归全绿,含 us1/us2/us3/readiness 原负向断言;新增 44 用例:迁移 5、家长验证 5、策略 API 8、原子性 5、判定矩阵 9、授权入口 5、保护 5、锁定 2) |
| 构建 | `pnpm build`(server dist + migrations + web) | ✅ |
| 真实 HTTP 冒烟 | `pnpm test:runtime`(编译产物 + 独立临时库 + 真实进程) | ✅ PASS,loginP95=31ms;场景含:迁移 drill/幂等 up、SPA/API 路由、初始化/登录、PIN 拒绝/解锁/选择、**家长验证策略保存/版本冲突 409/锁定 423**、**进程重启持久化(策略+会话)**、备份恢复 integrity、登出幂等 |

## 升级 / 回滚 / 恢复演练(T027,真实数据)

执行时间:2026-10-23 12:19–12:26。方法:`git worktree add /tmp/hmp-stage1 76bdcc2`(阶段 1 提交)构建阶段 1 服务器,以真实 HTTP 初始化/登录并创建档案(成人有 PIN/无 PIN、儿童、停用儿童)与活动会话;随后用当前工作区(阶段 2)执行迁移与校验。

| 步骤 | 结果 |
| --- | --- |
| 阶段 1 播种(HTTP) | ✅ 4 档案 201,无 PIN 成人与儿童 select 200,有 PIN 成人未解锁 403(阶段 1 语义) |
| `migration:up`(0002) | ✅ 已应用,自动备份 `hmp.db.bak-1792729139559` |
| 回填校验 | ✅ 4 档案(含停用儿童)各 1 条默认策略:成人 18/allowUnrated=1、儿童 12/0、version=1 |
| 上下文清空 | ✅ 引用「无码成人」的会话 active_profile_id 被清空;「儿童」会话上下文保留;身份/PIN/状态不变;`integrity_check=ok` |
| 阶段 2 服务器保存自定义策略 | ✅ PUT 策略(家长验证通过)→ 儿童 max=7/version=2(200) |
| `migration:down` | ✅ 策略/验证表删除;阶段 1 数据完整(4 档案/2 会话/1 账号);integrity ok |
| 再次 `migration:up` | ✅ 策略恢复默认(儿童 12/v1)——自定义值随 down 丢失,与设计一致 |
| 恢复回滚前备份 | ✅ 以 down 前自动备份覆盖 → 儿童自定义策略(7/v2)恢复,integrity ok |

结论:SC-006 的升级/回滚/恢复数据路径已由真实数据证明;演练全程离线临时目录,未触碰用户真实库。

## 容器证据(T028,2026-10-23 13:43–13:5x,OrbStack/Docker 29.4.0)

镜像:仓库 Dockerfile 多阶段构建(builder 编译 → runtime 非 root);`linux/arm64` 原生构建 + `linux/amd64` 平台仿真构建(宿主 Apple Silicon)。

| 场景(quickstart「容器与证据」) | arm64 结果 |
| --- | --- |
| 镜像构建 | ✅ `home-media-platform:t28-arm64`(501MB;`pnpm fetch` → frozen install → shared/server/web 构建) |
| 非 root 启动 | ✅ `docker exec id` → `uid=1000(node)` |
| 独立卷首次启动自动升级 | ✅ 具名卷 `hmp-t28-data` 空库 → entrypoint `migrate.js up` → `_migrations = 0001_init,0002_profile_policy`,`/api/healthz=200` |
| 阶段 1 SPA/API 回归 | ✅ `/` 200(SPA);`/setup/initialize` 201;登录/建档案(含 ownerPassword 验证)正常 |
| 阶段 2 策略链路(容器内真实服务) | ✅ PUT 策略(家长验证)→ `lvl=6/v=2`;错误密码 403 |
| 持久化重启 | ✅ `docker restart` → 健康恢复且策略 `lvl=6/v=2` 保留 |
| 缺新表 → healthz 503 | ✅ DROP `profile_policy` → `/api/healthz=503` |
| 缺迁移记录 → healthz 503 | ✅ DELETE `_migrations` 行 → `/api/healthz=503` |

amd64(仿真)构建与启动冒烟:✅ `home-media-platform:t28-amd64`(489MB,`--platform linux/amd64`,宿主 arm64 仿真)—— 非 root(uid=1000)启动、空卷自动升级 healthz=200、SPA 200、儿童档案默认策略 `12/v1` 读取正常。验证后容器/卷/临时镜像已清理,未触碰用户数据。

## 结论

SC-001～SC-007 全部具备对应层级证据(契约/单元 → 真实 HTTP → 真实浏览器 → 真实容器;升级/回滚/恢复经离线演练);规格按宪章流转 Implementing → **Verified**(2026-10-23)。

## 真实浏览器验证(T026,2026-10-23 12:21–12:24)

环境:真实服务(编译产物,独立临时 DATA_DIR/端口 45990)+ ego-browser(Chromium)驱动真实页面;服务端与浏览器均为真实进程,无 mock。

| 场景(quickstart「真实 HTTP 与浏览器」) | 结果 |
| --- | --- |
| 初始化向导 → 自动登录 → 档案选择页 | ✅ 表单提交成功,会话建立 |
| 创建儿童档案 → 家长验证弹窗:错误密码 → 弹窗内「验证未通过」,档案不创建;正确密码 → 「已创建档案」+ 列表出现儿童行 | ✅(FR-004/FR-010) |
| 内容策略页:目标/版本展示、等级 0～18 表单、未评级开关、三名单只读 +「媒体目录接入后可配置」与未评级/频道名单局限说明 | ✅(FR-010/FR-013) |
| 修改等级 9 → 保存 → 家长验证通过 → 「已保存」;整页重载后等级 9 保留,API 复核 `maxContentLevel=9/version=2` | ✅(FR-009/SC-001) |
| 浏览器存储检查:localStorage 仅 `hmp_bearer`(既有一次性令牌兜底键),不含任何密码 | ✅(FR-014) |
| 篡改 localStorage(伪造 `hmp_role=admin`、等级 0/1)→ 重载 → 服务端策略与页面展示均为 9/v2,客户端状态无效 | ✅(SC-003) |
| 连续 5 次错误密码 → 每次弹窗内「验证未通过」;第 6 次 → 「家长验证已锁定」(423 UX);期间表单输入(等级 8)保留 | ✅(FR-011/FR-010 保存失败保留输入) |

浏览器侧未逐项执行的子场景(无 PIN 成人切换弹窗、双浏览器会话冲突),其服务端行为已由契约测试与冒烟覆盖;后续人工验收可在同环境按 quickstart 第 2/5 项补做并追加记录。

## 环境备注

- Node v24.19.0 / pnpm 11.28.5 / macOS(Apple Silicon);浏览器为 ego-browser(Chromium)。
- 阶段 1 基线:git 76bdcc2;阶段 2 实现为当前工作区未提交变更(待宪章门禁通过后提交)。
- 全部演练使用独立临时目录与端口,验证结束已清理;未触碰任何用户真实数据。
