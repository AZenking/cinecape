# Quickstart & Verification Guide: 频道中心制与物理流/EPG源彻底解耦架构

**Feature**: `017-channel-centric-architecture`
**Created**: 2026-11-09

本指南提供全链路验证本功能端到端工作流的测试与运行用例。

---

## 1. 前置准备 (Prerequisites)

确保项目在根目录下正确配置环境依赖：
```bash
export PATH=$PATH:/opt/homebrew/bin
pnpm install
```

---

## 2. 验证场景一：服务端同名物理流自动汇聚至逻辑频道

### 目标
证明导入多个包含相同频道名称的 M3U 源时，系统不会创建多个重复频道，而是聚合为单个 `media_item` 并生成多条 `playback_source` 线路。

### 执行命令
```bash
pnpm --filter @hmp/server test apps/server/test/unit/catalog/multi-stream-aggregation.spec.ts
```

### 预期结果
- 测试全部通过（4/4 passed）；
- 验证同名频道在同一 Household 下自动合并为「单 `media_item` + 多 `source_entry` 线路」；
- 验证线路优先级计算正确（来源优先级 + 清晰度加权分）；
- 验证重导入幂等无重复插入。

---

## 3. 验证场景二：五级级联 EPG 确定性解析

### 目标
证明无论是否存在手动绑定，系统都能在多 EPG 源环境下依照宪法原则七的级联阶梯（手动锁定 > 精确 tvg-id > 源权重优先 > 频道别名归一 > 兜底降级）准确无 N+1 查询地输出节目排期。

### 执行命令
```bash
pnpm --filter @hmp/server test apps/server/test/unit/epg/cascading-epg-resolution.spec.ts
```

### 预期结果
- 测试用例覆盖 L1 到 L5 全部层级，并全部通过；
- 手动绑定失效时显式停链，不向下隐式回退；
- 内存归一化计算毫秒级完成。

---

## 4. 验证场景三：前端播放器多线路切换与断流容灾

### 目标
验证前端在播放逻辑频道时，控制栏正常列出聚合线路，当首选流发生网络错误或断流时，协调器自动在 5 秒内切换至次选线路。

### 执行命令
```bash
pnpm --filter @hmp/web test apps/web/test/features/live/player-line-switcher.spec.tsx apps/web/test/features/live/playback-failover.spec.tsx
```

### 预期结果
- 模拟断流事件触发 `PlaybackFailoverCoordinator`；
- 播放器请求第二线路并继续渲染，给出自动容灾切换提示；
- 测试 100% 通过。

---

## 5. 验证场景四：管理后台频道资产工作台与全源 EPG 绑定弹窗

### 目标
验证管理后台彻底废除旧式 1:1 直播源关联，以频道为主表，支持查看线路数量与在 Modal 中跨任意 EPG 源搜索绑定。

### 执行命令
```bash
pnpm --filter @hmp/web test apps/web/test/settings/settings-epg-page.spec.tsx apps/web/test/settings/settings-selects.spec.tsx
```

### 预期结果
- 页面正确列出频道、线路 Chip 及当前绑定状态；
- EPG 绑定弹窗使用 HeroUI Modal 渲染，无原生 select 违宪控件；
- 能够自由切换目标 EPG 源并成功提交绑定。

---

## 6. 验证场景五：全系统静态类型检查与代码规范

### 执行命令
```bash
pnpm typecheck
```

### 预期结果
- `@hmp/shared`, `@hmp/server`, `@hmp/web` 全部通过类型检查，零错误。
