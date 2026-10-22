# ADR-0005：阶段 1 迁移与单服务交付实施补充

- 状态：Accepted
- 日期：2026-10-23
- 补充：[ADR-0004](0004-technology-stack.md)；其中迁移工具与交付细节以本文为准，其余选型继续有效。
- 关联：[规格 001](../specs/001-scaffold-identity-foundation/spec.md)
- 背景：维护者要求收尾阶段 1、按 Spec Kit 对齐验收状态并提交。复核发现设计文档与实际迁移实现不同，容器也缺少前端与启动迁移链。

## Decision

1. Drizzle 保持查询和类型映射职责。首期迁移采用仓库内执行器，按 `database/migrations/NNNN_name/up.sql`、`down.sql` 配对执行，通过 `_migrations` 记录版本；不宣称已使用未安装的 drizzle-kit。
2. 每次迁移前使用 SQLite `VACUUM INTO` 生成一致性备份，单条迁移与版本记录同事务；回滚演练仅使用独立临时数据库，不能对用户实例执行 drill。
3. 生产构建复制 SQL 到 dist，容器以 node 用户先执行向前迁移、成功后启动 API；失败即退出。Nest 服务同源提供 Web 静态资源与 SPA 页面，未知 `/api/*` 仍返回 API 404。
4. 就绪检查必须同时验证数据库连接、迁移版本及业务表。数据库可连接不代表可服务；缺版本或缺表返回 503 NOT_READY。
5. 主账号管理 Profile 的要求落实为服务端 owner 校验和前端 owner 路由。成人/儿童 Profile 类型不赋予管理员权限。
6. 本阶段 ID 使用 Node `crypto.randomUUID()` 生成 UUID v4；未落地的 UUID v7、迁移触发器和撤销 reason 列不作为已实现能力。

## Alternatives and consequences

引入 drizzle-kit 并替换既有可回滚执行器会扩大当前交付变更；首期使用显式 SQL 与版本记录更便于验证。代价是 SQL 与查询 schema 需同步维护，新增迁移时必须更新就绪与迁移测试。一个进程提供前后端简化 NAS 部署，后续独立前端部署可通过新计划演进。

## Migration and rollback

本补充不修改既有业务表或用户数据。交付回滚使用此前镜像及迁移前备份；运行前确认该镜像支持目标数据库版本。已有 ADR 历史正文保留，当前状态及证据以规格 001 的 evidence.md 为准。
