# Quickstart: 端到端验证指南

**Feature**: `006-heroui-react-query-refactor` | **Date**: 2026-10-27
**Spec**: [spec.md](./spec.md) | **Contracts**: [contracts/](./contracts/)

> 本指南是验收运行手册：每个场景标注其证明的成功标准（SC）。
> 实现细节见 tasks.md（`/speckit-tasks` 产出，本命令不创建）。

## 前置条件

```bash
pnpm install                # Node >= 24, pnpm 11
pnpm dev                    # 并行启动 server(:3000) 与 web(Vite)
# 依赖服务：NAS 媒体源为可选——目录/播放场景需要可用媒体源或测试数据
```

## 场景 0：基线采集（迁移开始前一次性执行）

```bash
pnpm --filter @hmp/web build && du -sk apps/web/dist && \
  find apps/web/dist -name '*.js' -exec ls -l {} + | awk '{s+=$5} END {print s" bytes"}'
grep -rn --include='*.tsx' --include='*.ts' -E '<(select|dialog|datalist)\b|alert\(|confirm\(|prompt\(' apps/web/src | wc -l   # 预期 8（7 select + 1 alert）
```

记录构建产物体积与原生控件计数，作为 SC-002/SC-009 的对比基线。

## 场景 1：控件统一扫描（SC-001）

```bash
grep -rn --include='*.tsx' --include='*.ts' -E '<(select|dialog|datalist|progress|meter)\b|alert\(|confirm\(|prompt\(' apps/web/src
# 预期：无输出（计数 = 0）
```

人工走查：设置 6 个子页 + EPG 指南页，确认下拉均为组件库 `Select`
（键盘可开合、焦点可见），主档变更提示为 `AlertDialog`（文案与调整前一致）。

## 场景 2：缓存与刷新行为（SC-003、Q2 分档）

1. 浏览型：打开媒体目录 → 滚动加载 → 进入详情 → 返回目录：**立即呈现**无整页加载；
   DevTools Network 中可见后台刷新请求，完成后数据无缝更新、无布局跳动。
2. 设置型：进入"设置 → 来源"：**每次**先呈现加载态再渲染最新数据
   （Network 中必有新请求；重复进入不发缓存旧值）。
3. 共享缓存：指南页与播放页引用同一频道数据时，Network 中该数据仅请求一次。

## 场景 3：乐观更新与回滚（SC-007、Q1 分档）

1. 详情页点击收藏星标：**立即**变亮（先于网络返回）；Network 请求成功后状态保持。
2. DevTools 切 Offline 后点击收藏：界面**自动回滚**为未收藏并弹出统一提示；
   恢复 Online 后可重试成功。
3. 设置表单保存：按钮呈等待态，服务端 200 后才更新显示；双击不产生重复请求。

## 场景 4：身份隔离（SC-005，负向安全）

1. 档案 A 收藏 2 部影片、产生播放进度 → 切换档案 B：收藏/历史/继续观看均无 A 的数据。
2. 切档瞬间（DevTools 限速 Slow 3G）触发历史页加载后立即切档：慢响应返回后
   界面不出现 A 的数据（在途结果被丢弃）。
3. 退出登录：公共浏览正常；重新登录档案 C：仅见 C 的数据。
4. 会话过期（手动清除会话 Cookie 后操作个人页）：统一引导重新登录，无半失效状态。

## 场景 5：错误态与重试（SC-004）

```bash
# 停掉 server（Ctrl-C pnpm dev 中 server 侧）后刷新目录页
```

预期：统一错误态 + 重试按钮（含服务端问题详情文案映射），无白屏、无未处理异常；
重启 server 后点击重试恢复。公共页与个人页行为一致。

## 场景 6：自动化验收（SC-001/002/005/007/009）

```bash
pnpm typecheck && pnpm lint
pnpm --filter @hmp/web test            # vitest：含数据层单测（域清除/401/乐观回滚）与负向用例
pnpm --filter @hmp/web test:e2e        # Playwright：US1–US3 场景 + 跨档案泄漏/未认证/过期响应负向用例
pnpm --filter @hmp/web build           # 体积对比基线：首屏关键路径增幅 ≤ 15%（SC-009）
```

## 通过判据

- 场景 1 计数 = 0；场景 2–5 行为与分档规则一致；场景 6 全绿且体积达标。
- 任一失败 → 不满足合并前质量门禁（宪法），修复后重跑本指南。
