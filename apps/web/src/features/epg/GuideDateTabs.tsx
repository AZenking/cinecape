import type { ReactNode } from 'react';
import { ToggleButton } from '@heroui/react';
import { guideDateLabel } from './guide-time';

/**
 * 7 日期 Tab(T116;FR-026「今天及未来 6 天,共 7 天」、ui.md §6):
 * - 仅渲染服务端 allowedDates(今天~today+6,家庭时区),不本地推断;
 * - 每个日期胶囊两行:上行 = 相对标签/星期(今天|明天|后天|周X),下行 = M月D日;
 *   上行是**视觉辅助**,可读名仍由两行文本自然拼接,故 textContent 恒含
 *   「M月D日」与首枚「今天」(url-state/e2e 以 textContent 正则解析日期,契约不变);
 * - 选中态 = HeroUI ToggleButton 原生 aria-pressed(React Aria useToggleButton
 *   落在原生 <button> 上,测试/e2e 以 aria-pressed 针面不变);选中视觉走组件
 *   data-selected 语义态(accent-soft 底 + accent-soft 前景),不另造裸色值;
 * - 外层保留 <div role="group" aria-label="节目单日期">(不用 ToggleButtonGroup:
 *   容器自带 role 会与既有 group 锚点重复嵌套);
 * - 单行不换行 + 横向滚动:窄窗(390)下胶囊条可横滑,避免把页头/工具栏撑成多行
 *   (日期是匀速排布的时间条,横滑语义与 EPG 时间轴一致);
 * - 家庭时区标注由父级头部统一显示(此处只呈现日期)。
 */

/** 星期标签(日历日的星期与时区无关:按 UTC 构造同名日期取 getUTCDay) */
function weekdayLabel(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) {
    return '';
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return '';
  }
  return `周${'日一二三四五六'[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? ''}`;
}

/** 胶囊上行标签:前三天用相对说法(今天/明天/后天),其余用星期 */
function relativeLabel(date: string, index: number): string {
  if (index === 0) {
    return '今天';
  }
  if (index === 1) {
    return '明天';
  }
  if (index === 2) {
    return '后天';
  }
  return weekdayLabel(date);
}

export interface GuideDateTabsProps {
  /** 服务端允许日期(今天~today+6;升序) */
  readonly allowedDates: readonly string[];
  readonly timezone: string;
  readonly selected: string | undefined;
  readonly disabled?: boolean;
  readonly onSelect: (date: string) => void;
}

export function GuideDateTabs({ allowedDates, timezone, selected, disabled = false, onSelect }: GuideDateTabsProps): ReactNode {
  return (
    <div
      role="group"
      aria-label="节目单日期"
      className="flex min-w-0 flex-nowrap items-stretch gap-1 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {allowedDates.map((date, index) => {
        const isSelected = selected === date || (selected === undefined && index === 0);
        const dateLabel = guideDateLabel(date, timezone);
        const topLabel = relativeLabel(date, index);
        return (
          <ToggleButton
            key={date}
            size="sm"
            isSelected={isSelected}
            isDisabled={disabled}
            onPress={() => {
              onSelect(date);
            }}
            className="h-10 shrink-0 rounded-lg px-2.5"
            aria-label={`${topLabel} ${dateLabel}`}
          >
            <span className="flex flex-col items-center leading-none">
              <span
                className={`flex items-center gap-1 text-[10px] font-medium tracking-wide ${
                  isSelected ? 'text-accent' : 'text-muted'
                }`}
              >
                {index === 0 ? <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" /> : null}
                {topLabel}
              </span>
              <span className={`mt-0.5 hmp-tabular-nums text-[11px] ${isSelected ? 'text-foreground font-semibold' : 'text-foreground/80'}`}>
                {dateLabel}
              </span>
            </span>
          </ToggleButton>
        );
      })}
    </div>
  );
}