# Quickstart & Verification Guide: 逻辑频道显隐控制与名称台标自定义编辑

**Feature**: `018-channel-customization`
**Created**: 2026-11-09

本指南提供全链路验证频道显隐控制、自定义重命名与 Logo 自定义设置的测试与运行用例。

---

## 1. 验证场景一：频道显隐切换与前台自动过滤

### 目标
验证在后台将频道切换为隐藏后，该频道立刻从 `GET /public/live/channels` 响应中被排除，切换回显示后即刻恢复。

### 执行命令
```bash
export PATH=$PATH:/opt/homebrew/bin
pnpm --filter @hmp/server test apps/server/test/contract/channel-visibility.e2e-spec.ts
```

### 预期结果
- 测试用例通过；
- `visible = 0` 时，公共直播接口不包含该频道；
- `visible = 1` 时，公共直播接口正常包含该频道。

---

## 2. 验证场景二：自定义名称与 Logo 更新防刷新覆盖

### 目标
证明通过 `PATCH /catalog/media/{id}` 修改频道名称（置 `title_overridden = 1`）和 Logo 后，无论后续上游 M3U 执行多少次刷新同步，人工编辑的标题和 Logo 均保持不变。

### 执行命令
```bash
pnpm --filter @hmp/server test apps/server/test/contract/channel-customization.e2e-spec.ts
```

### 预期结果
- 验证人工标题在 M3U 刷新后不被覆盖；
- 验证自定义台标在 M3U 刷新后不被覆盖。

---

## 3. 验证场景三：管理后台工作台 HeroUI Switch 与编辑 Modal 交互

### 目标
验证在「频道资产」工作台列表中：
1. 列表行渲染 HeroUI `Switch`，点击可直接发送 PATCH 更新显隐状态；
2. 点击「编辑」按钮打开 HeroUI `Modal`，支持输入新标题与新 Logo URL；
3. 输入 Logo URL 后右侧即时渲染图片预览。

### 执行命令
```bash
pnpm --filter @hmp/web test apps/web/test/settings/settings-channel-workbench.spec.tsx
```

### 预期结果
- 组件无原生 `<select>` / `<dialog>` 违宪控件；
- Switch 切换与 Modal 保存交互测试 100% 通过。

---

## 4. 验证场景四：全系统静态类型检查与代码规范

### 执行命令
```bash
pnpm typecheck
```

### 预期结果
- `@hmp/shared`, `@hmp/server`, `@hmp/web` 全部通过，零错误。
