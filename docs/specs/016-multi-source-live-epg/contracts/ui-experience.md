# UI Experience & Component Contracts (016-multi-source-live-epg)

**Feature**: 多直播源聚合与多 EPG 源级联匹配及前端实时呈现  
**Spec Reference**: `docs/specs/016-multi-source-live-epg/spec.md`  
**Governing Principles**: 宪章原则五 (HeroUI v3 优先, 禁用原生控件), 原则九 (统一使用 `lucide-react`)

---

## 1. 频道卡片当前节目与进度条 (`ChannelCard`)

在 `apps/web/src/features/live/components/channel-card.tsx` 或对应卡片组件中集成当前节目与进度微条：

### 1.1 组件视觉结构
```
┌───────────────────────────────────────────────┐
│ [Logo] CCTV-1 综合              [● LIVE] 65%  │
│                                               │
│ 正在播出: 新闻联播                             │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━┈┈┈┈┈┈┈┈┈┈┈┈┈        │
│ 下一档: 19:30 天气预报 / 焦点访谈               │
└───────────────────────────────────────────────┘
```

### 1.2 关键规范
- **进度条实现**：使用 HeroUI v3 的 `<Progress size="sm" color="primary" value={progressPercent} aria-label="节目播放进度" />`，**严禁使用原生 `<progress>` 元素**。
- **降级呈现**：当 `current == null` 时：
  - 标题显示：“暂无节目单”；
  - 进度条隐藏或替换为柔和的浅灰背景底线；
  - 禁用状态不扩散到卡片整体，卡片依然响应悬停 `▶ 播放` 动作。

---

## 2. 智能事件定时器 Hook (`useCurrentProgramme`)

### 2.1 Hook 契约定义
```typescript
export interface UseCurrentProgrammeOptions {
  readonly initialCurrent: ExperienceProgrammeDto | null;
  readonly initialNext: ExperienceProgrammeDto | null;
  /** 当节目到点翻转后触发的静默刷新回调 */
  readonly onProgrammeAdvance?: () => void;
}

export interface UseCurrentProgrammeResult {
  readonly current: ExperienceProgrammeDto | null;
  readonly next: ExperienceProgrammeDto | null;
  /** 0 ~ 100 范围的平滑数值 */
  readonly progressPercent: number;
  /** 格式化后的剩余时间文本 (如 "还剩 12 分钟") */
  readonly remainingText: string;
}
```

### 2.2 运作机制
1. **进度计算**：内部启动一个轻量 15 秒间隔的本地计时器更新 `progressPercent`，完全不发网络请求；
2. **事件驱动推进**：基于 `current.end` 与本地系统时间的差值设置单次 `setTimeout`：
   ```ts
   const msUntilEnd = Math.max(0, new Date(current.end).getTime() - Date.now());
   const timer = setTimeout(() => {
     // 1. 本地状态立刻将 next 提升为 current
     advanceToNextProgramme();
     // 2. 异步触发 SWR 拉取后续节目更新 next
     onProgrammeAdvance?.();
   }, msUntilEnd + 1000);
   ```

---

## 3. 播放器 OSD 线路切换面板 (`PlayerLineSwitcher`)

在 Screen 4 一体化播放页（`apps/web/src/features/live/pages/`）的播放器底栏控制区增加“线路”下拉菜单：

### 3.1 组件规范
- 使用 HeroUI v3 的 `<Dropdown>`、`<DropdownTrigger>`、`<DropdownMenu>` 和 `<DropdownItem>`。
- 触发按钮：
  ```tsx
  <Button
    size="sm"
    variant="flat"
    startContent={<Radio className="w-4 h-4" />}
  >
    {currentLine.label}
  </Button>
  ```
- 列表项包含：
  - 线路标签（如 `线路 1 [1080P]`）；
  - 来源提供方（如 `电信主源`）；
  - 当前选中对勾图标（`<Check className="w-4 h-4 text-primary" />`）。
