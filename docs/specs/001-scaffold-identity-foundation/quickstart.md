# Quickstart: 应用脚手架与身份基础(001)

- 日期:2026-10-22
- 用途:实现完成后,按本指南端到端验证规格 001 的全部验收标准(SC-001~SC-007)。命令为验证脚本,不含实现代码;实现细节见 [tasks.md](tasks.md)(由 /speckit-tasks 生成)与 [contracts/openapi.yaml](contracts/openapi.yaml)。

## 前置条件

- Node.js 24 LTS + pnpm 11.28.5（与根 package.json 的 packageManager 一致）；或仅 Docker（部署验证）；
- 端口 3000 未占用;`apps/server/.env` 已从 `.env.example` 复制并按需修改(默认值即可跑通)。

## 启动

```bash
# 方式 A:本地开发
pnpm install
pnpm migration:up                    # 建表(首版迁移)
pnpm dev                              # 并行启动 server(:3000) 与 web(:5173)

# 方式 B:容器交付(宪章交付验证)
docker compose up --build
```

就绪判据:`curl -fsS http://localhost:3000/api/healthz` 返回 `{"status":"ok","database":"ok"}`(FR-001)。

## 验证场景

以下 curl 序列逐条对应规格验收;`$BASE=http://localhost:3000/api`,`$CB` 为携带会话 Cookie 的参数(`-b hmp_session=...` 或 `-H "Authorization: Bearer $TOKEN"`)。

### 场景 1:首次初始化与登录(US1 → SC-001/002/005)

1. `GET /setup/status` → `{"initialized":false}`;
2. `POST /setup/initialize` 提交家庭名、用户名、密码 → `201` 返回 SessionDto,响应含 `sessionToken`(仅此一次)、无任何哈希字段;
3. 立即重复 `POST /setup/initialize` → `409`,code=`INITIALIZATION_ALREADY_DONE`,数据不变(FR-003);
4. 用正确凭据 `POST /auth/login` → `200` SessionDto;错误密码与不存在用户 → 均为同一 `401` problem(code 相同),无法区分(FR-008);
5. 全程用 grep 检查各响应体不含 `password` 哈希、`pin` 哈希、token 明文以外的凭据痕迹(FR-007)。

预期:全新环境从启动到完成本场景 ≤ 10 分钟;登录响应 < 3s(SC-001/002)。

### 场景 2:Profile 管理与切换(US2 → SC-004)

1. 以会话 `POST /profiles` 创建 child Profile(带 pin=`1234`)→ `201`;再创建一个 adult → `201`;
2. 将第二个设为默认 → 列表中默认唯一;再设第一个为默认 → 旧的自动取消(FR-13 场景 2);
3. `POST /profiles/{childId}/select` 不带 PIN → `403`(受 PIN 保护);`POST /profiles/{childId}/unlock` 错误 PIN 连续 5 次 → 第 5 次起 `423`;等锁定窗口过(或用测试配置缩短)后正确 PIN → `200`,再 select → `200` SessionDto.activeProfile 更新(FR-014/015);
4. 停用该 child Profile(它是某会话的 active)→ `200`,且该会话 `GET /auth/session` 中 `activeProfile: null`(FR-016);停用仅剩的最后可用 Profile → `409`(FR-013);
5. **负向**:伪造不存在的 `profileId`、伪造其他家庭的 `profileId`(测试夹具注入第二家庭数据)→ 均 `404` 且响应无目标 Profile 数据;请求体塞 `householdId`/`profileId` 字段尝试越权 → 被忽略,一律以会话为准(FR-018/019)。

### 场景 3:会话生命周期(US3 → SC-003/005)

1. 登录记录 token;`GET /auth/session` → `200`;重启服务进程后再次调用 → `200` 且 activeProfile 保持(未停用时)(SC-005);
2. 在独立测试实例中将 `SESSION_TTL_DAYS` 调为 `0.000023148148`（约 2 秒），等过期后调用 → `401`（FR-010）；不得改动正在使用的家庭实例。
3. `POST /auth/logout` → `204`;旧凭证再访问 → `401`;重复 logout → 仍 `204`(幂等,FR-012);
4. 新登录后,经第二会话 `POST /devices/{deviceId}/revoke` → `204`;原设备全部会话立即 `401`;重复 revoke → 仍 `204`(FR-011/012)。

### 场景 4:迁移与回滚(SC-006)

```bash
pnpm build
pnpm test:runtime # 在临时目录执行 up→down→up、幂等 up 与备份恢复检查，不操作用户数据库
```

预期:三个命令全部成功;down 后库结构回到上一版本,up 后回到最新;任一迁移失败时 `hmp.db.bak-*` 备份存在且可恢复。全新空目录重复执行 up 亦成功(可重复)。

### 场景 5:自动化测试门禁(SC-007)

```bash
pnpm lint && pnpm typecheck      # 静态检查零阻断
pnpm test                       # 单元 + 契约 e2e,含 FR-019 全部负向用例
```

预期:100% 通过;负向用例清单(无效/过期/撤销会话、跨家庭 profile、伪造标识、绕过 PIN)在测试报告中可见并逐条对应 FR-019。

## 验收映射

| 场景 | 覆盖 | 对应 SC |
| --- | --- | --- |
| 1 初始化与登录 | FR-001~004/007/008 | SC-001/002/005 |
| 2 Profile 与切换(含负向) | FR-009/013~019 | SC-004 |
| 3 会话生命周期 | FR-005/010~012 | SC-003/005 |
| 4 迁移演练 | FR-005/006 | SC-006 |
| 5 测试门禁 | FR-020 | SC-007 |

全部通过后,规格状态方可流转 `Implementing → Verified`(宪章工作流),并在同一变更中更新文档与 ADR 状态。
