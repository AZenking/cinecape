# Quickstart: 007-backend-ddd-restructure 验证指南

**用途**: 端到端验证「结构对齐完成且行为零变化、零遗留」。每步期望结果为二元可判定项；任何一步失败即停止并修复，不得带病前进。
**前置阅读**: [plan.md](./plan.md) · [research.md](./research.md) · [data-model.md](./data-model.md) · [contracts/](./contracts/)

## 前置条件

- Node.js >= 24（`.nvmrc`）、pnpm 11；
- 依赖已安装：`pnpm install`（postinstall 会执行 `gen:types` 并构建 `@hmp/shared`）；
- 开工前置：本规格已 Accepted，结构方案 ADR 已 Accepted（宪章原则五门槛）。

## 每迁移步的循环验证（research.md D6 序列）

```bash
pnpm --filter @hmp/server typecheck        # 期望: 0 错误
pnpm lint                                  # 期望: 0 错误 0 阻断警告
pnpm --filter @hmp/server test             # 期望: unit + contract 全部通过（含安全负向用例）
```

期望的附加判定：

- `git diff` 中 controller 路由、DTO 形状、Problem JSON、守卫逻辑**零改动**（对照 [contracts/external-http-invariants.md](./contracts/external-http-invariants.md)）；
- 测试文件仅出现导入路径类机械修改，断言语义不变。

## 审计验证（结构对齐与零遗留红线）

审计工具由 tasks 阶段接入（devDeps: dependency-cruiser + knip，scripts 命名以 tasks 为准）：

```bash
pnpm --filter @hmp/server audit:boundaries  # 期望: 分层/跨上下文/框架渗漏违规 = 0
pnpm --filter @hmp/server audit:orphans     # 期望: 孤儿文件/死导出/死依赖 = 0
```

## 全量终验（实现完成时）

```bash
pnpm install && pnpm gen:types            # 期望: @hmp/shared 契约类型产物与迁移前一致（git diff 为空）
pnpm typecheck && pnpm lint && pnpm build # 期望: 全绿
pnpm --filter @hmp/server test            # 期望: 全部通过
pnpm test:runtime                         # 期望: 运行时冒烟通过
pnpm migration:drill                      # 期望: 空库 up/down/up 通过，迁移目录内容零修改
pnpm --filter @hmp/server audit:boundaries && pnpm --filter @hmp/server audit:orphans  # 期望: 0
```

人工/半自动终验清单：

1. **零遗留清点**：全库检索被注释的旧实现、迁移占位标记（TODO/FIXME 中属于本次迁移的）、临时绕行垫片 → 计数为 0；
2. **规则合规清单**：[nestjs-best-practices-compliance.md](./nestjs-best-practices-compliance.md) 40/40 条均有结论，"已记录偏离"均附 ADR 链接；
3. **文档同步**：规格状态流转（Implementing → Verified）、结构方案 ADR、本目录证据文件在同一原子变更中提交；
4. **响应快照抽查**：迁移前后对全部控制器路由的抽样响应对比留档（运行时证据层）。

## 故障排查速查

| 症状 | 首查 |
|---|---|
| 审计报深导入违规 | 该 import 是否应走目标上下文 `index.ts` 发布面（contracts/internal-context-contracts.md） |
| 审计报框架渗漏 | 该文件是否误留在 domain/application；或该「纯函数」实际依赖了加密/IO 库应归 infrastructure |
| 契约测试失败 | 是否顺手改了路由/DTO/错误语义 → 还原；映射归类错误导致行为变化 → 修归类 |
| knip 报孤儿文件 | 是迁移遗留 → 删除；是测试辅助 → 走测试例外通道并留痕 |
