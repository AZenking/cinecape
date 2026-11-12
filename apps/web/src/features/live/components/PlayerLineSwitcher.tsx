/**
 * 播放器 OSD 线路切换菜单(T021;016 contracts/ui-experience.md §3):纯呈现组件。
 *
 * - HeroUI v3 `Dropdown`(文档:.heroui-docs/react components/(collections)/dropdown.mdx,
 *   3.2.6 实测 API:Dropdown 触发子 + Dropdown.Popover + Dropdown.Menu/Item/Label/
 *   Description;禁 v2 记忆):触发钮 = HeroUI Button(Radio 图标 + 当前线路 label),
 *   菜单项 = 线路 label(Label)+ 来源提供方次行(Description)+ 选中项 Check 图标
 *   (text-accent);
 * - 键盘可达由 HeroUI Dropdown 自带(focus 管理/Enter/Esc/箭头),触发钮附
 *   aria-label「切换播放线路」与 MenuTrigger 注入的 aria-haspopup/aria-expanded;
 * - 无多线路语义(lines < 2)返回 null —— 单线路无换线面(不渲染零内容,不占位);
 * - 选择回调只上报 lineId:是否发起新 resolve(新 session 契约语义)由编排层
 *   (action-coordinator 全局播放面,015 架构裁决)决定,本组件零副作用。
 */
import type { ReactNode } from 'react';
import { Button, Description, Dropdown, Label } from '@heroui/react';
import { Check, Radio } from 'lucide-react';
import type { StreamLineDto } from '@hmp/shared';

export interface PlayerLineSwitcherProps {
  /** 可用线路清单(resolve 201 投影;priority ASC 契约排序) */
  readonly lines: readonly StreamLineDto[];
  /** 当前选中线路(null/未命中 = 触发钮降级为通用文案,不渲染选中 Check) */
  readonly selectedLineId: string | null;
  /** 手动换线上报(仅 lineId;编排层据此发起新播放意图) */
  readonly onSelect: (lineId: string) => void;
}

export function PlayerLineSwitcher({ lines, selectedLineId, onSelect }: PlayerLineSwitcherProps): ReactNode {
  // 单线路/无线路:无换线面(spec US3「播放器内挂载两条不同流源的线路」才提供菜单)
  if (lines.length < 2) {
    return null;
  }
  const current =
    lines.find((candidate) => candidate.lineId === selectedLineId) ?? null;
  return (
    <Dropdown>
      {/* 触发钮(ui-experience §3:size sm + 图标 + 当前线路 label;v3 无 flat 变体,
          以 secondary 扁平面变体对齐 —— 3.2.6 API 以文档/类型为准) */}
      <Button size="sm" variant="secondary" aria-label="切换播放线路" className="shrink-0">
        <Radio className="h-4 w-4" aria-hidden="true" />
        {current?.label ?? '选择线路'}
      </Button>
      <Dropdown.Popover placement="bottom end" className="min-w-[220px]">
        <Dropdown.Menu
          aria-label="播放线路列表"
          onAction={(key) => {
            onSelect(String(key));
          }}
        >
          {lines.map((candidate) => (
            <Dropdown.Item key={candidate.lineId} id={candidate.lineId} textValue={candidate.label}>
              {/* 选中态对勾(仅当前线路;text-accent 语义 token,ui-experience §3) */}
              <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
                {candidate.lineId === selectedLineId ? <Check className="h-4 w-4 text-accent" /> : null}
              </span>
              <div className="flex flex-col">
                <Label>{candidate.label}</Label>
                <Description>{candidate.sourceTitle}</Description>
              </div>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
