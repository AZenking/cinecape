# ADR-0008：阶段 3 单频道手动 EPG 匹配

- 状态：Accepted（2026-10-25；维护者在实施会话中明确接受本 ADR 与规格 003 的 FR-023～026/SC-010 增补，随即进入实现；验收证据按 quickstart H 补齐）
- 关联：[规格 003](../specs/003-media-catalog/spec.md)、[实现方案](../specs/003-media-catalog/plan.md)、ADR-0007。
- 补充而非覆盖 ADR-0007：仅将原“无手动匹配/锁定”的范围扩展为单频道手动绑定，不引入完整工作台、模糊自动匹配、批量审批或独立队列。

## Context

IPTV tvg-id 与 XMLTV 频道 ID 不一致时自动匹配失败；家长需要参考 magi 搜索选择正确指南，且刷新不能覆盖。媒体/策略身份必须继续稳定，EPG 窗口替换不能删除家长配置。

## Decision proposal

1. 使用 media_id 为键的家庭绑定，manual 模式保存即锁定，来源/频道成对；可选同家庭任一已启用成功导入的 EPG，而非只限来源默认。manual 优先，invalid 保留且不回退。解除写 auto 墓碑，恢复原来源级精确匹配。
2. 借鉴 magi 的配对/版本/锁保护，但所有管理操作附加 redRoad 当次家长验证和家庭约束，元数据写入为一个事务；不复制其独立 canonical 更新。
3. 独立 binding version 防并发；解除不删行以免 ABA。候选携带 epgGeneration，EPG 成功发布时递增，保存候选后变化必须重查。绑定写与 catalog revision 原子递增；原待确认快照因此失效。
4. 新增 0004 迁移，禁止改既有 0003；只 FK 到稳定 media/source，不 FK 到会被替换的指南频道行。目标失效状态动态派生，恢复后同 ID 生效，不修改配置版本。
5. 普通节目查询先校验当前档案；手动设置不放宽内容权限。家长可从已验证候选管理隐藏频道；普通响应只展示模式/失效原因，不泄漏候选或源位置。

## Alternatives and consequences

把手动绑定写到 ephemeral EPG 行会在刷新时丢失；无锁手动模式和隐式自动回退使家长选择不可预测。独立版本和来源 generation 增加少量状态，但明确处理首次/解除/重配及候选过期。基线验收不覆盖此扩展，必须补SC-010与新任务证据。

## Migration and rollback

0004 up 创建绑定表和 media_source.epg_generation，既有频道保持自动；down 删除新增状态，原目录/媒体身份/策略不变，行为回落自动，手动设置需停服恢复备份才能恢复。临时库演练 up/down/up、备份恢复与检查，生产库不执行 drill。原 ADR-0007 正文和基线证据保留，本文件接受后才进入实现。
