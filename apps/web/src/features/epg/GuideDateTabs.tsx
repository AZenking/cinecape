import type { ReactNode } from 'react';
import { guideDateLabel } from './guide-time';

/**
 * 7 日期 Tab(T116;FR-026「今天及未来 6 天,共 7 天」、ui.md §6):
 * - 仅渲染服务端 allowedDates(今天~today+6,家庭时区),不本地推断;
 * - 今天(集合首项)附「今天」标注;选中态 aria-pressed(原生 button,不冒充 tab 语义);
 * - 家庭时区标注由父级头部统一显示(此处只呈现日期)。
 */

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
    <div role="group" aria-label="节目单日期" className="flex flex-wrap items-center gap-1">
      {allowedDates.map((date, index) => {
        const isSelected = selected === date || (selected === undefined && index === 0);
        const label = index === 0 ? `${guideDateLabel(date, timezone)}(今天)` : guideDateLabel(date, timezone);
        return (
          <button
            key={date}
            type="button"
            aria-pressed={isSelected}
            disabled={disabled}
            onClick={() => {
              onSelect(date);
            }}
            className={`rounded border px-2.5 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
              isSelected
                ? 'border-accent bg-accent/15 font-medium text-foreground'
                : 'border-border text-muted hover:text-foreground'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
