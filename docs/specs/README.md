# Feature Specs

这里存放按规格驱动开发编写的单个功能规格。每个规格只描述一个可交付能力，必须在实现前明确范围、契约、验收和验证方式。

## 命名

```text
NNNN-short-feature-name.md
```

例如：

```text
0001-profile-selection.md
0002-playback-resolve.md
```

## 状态

规格按以下状态流转：

```text
Proposed → Accepted → Implementing → Verified
                       └────────────→ Superseded
```

只有 `Accepted` 的规格可以作为实现承诺。

## 必填章节

- `Context`：为什么需要这个能力，谁受到影响；
- `Current State`：当前行为和已验证证据；
- `Scope`：明确包含和明确不包含的内容；
- `Domain Rules`：权限、幂等、空值、重复请求和失败路径；
- `Contract`：请求、响应、数据变化和兼容性；
- `Acceptance Criteria`：可判定的通过/失败条件；
- `Testing Plan`：单元、集成、运行时和 Network/Backend 证据；
- `Rollback`：代码、配置或数据迁移的撤回方式。

完整模板见 [`../spec-driven-development.md`](../spec-driven-development.md)。
