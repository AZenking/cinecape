import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { StreamLineDto } from '@hmp/shared';
import { PlayerLineSwitcher } from '../../../src/features/live/components/PlayerLineSwitcher';

/**
 * T021(016 US3;ui-experience.md §3 PlayerLineSwitcher 规范)组件单测:
 * - 多线路(≥2)渲染下拉触发钮(Radio 图标 + 当前线路 label)与全部线路菜单项
 *   (label + sourceTitle 次行 + 选中项 Check 图标 text-accent);
 * - 选中回调携带所点线路 lineId;
 * - 单线路/无线路返回 null(单线路无换线面);
 * - 键盘可达:触发钮 aria-label「切换播放线路」+ aria-haspopup,Enter 开启菜单
 *   (HeroUI Dropdown 自带键盘交互,此处钉语义面防回归)。
 */

function line(overrides: Partial<StreamLineDto> = {}): StreamLineDto {
  return {
    lineId: 'line-1',
    sourceId: 'src-telecom',
    sourceTitle: '电信主源',
    label: '线路 1 [1080P]',
    priority: 10,
    isDefault: true,
    isEnabled: true,
    ...overrides,
  };
}

const LINES: readonly StreamLineDto[] = [
  line(),
  line({ lineId: 'line-2', sourceId: 'src-unicom', sourceTitle: '联通备用', label: '线路 2 [4K]', priority: 20, isDefault: false }),
];

function renderSwitcher(props: Partial<Parameters<typeof PlayerLineSwitcher>[0]> = {}): { onSelect: (lineId: string) => void } {
  const onSelect = vi.fn();
  render(
    <PlayerLineSwitcher
      lines={props.lines ?? LINES}
      selectedLineId={props.selectedLineId ?? 'line-1'}
      onSelect={props.onSelect ?? onSelect}
    />,
  );
  return { onSelect };
}

async function openMenu(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '切换播放线路' }));
  // 菜单项经 Popover 门户渲染,等一拍
  await screen.findByText('线路 2 [4K]');
}

describe('T021 · PlayerLineSwitcher(OSD 线路切换菜单)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('多线路:触发钮显示当前线路 label + Radio 图标;菜单列出全部线路(label + sourceTitle)', async () => {
    renderSwitcher();
    const trigger = screen.getByRole('button', { name: '切换播放线路' });
    expect(trigger.textContent).toContain('线路 1 [1080P]');
    // lucide Radio 图标挂载于触发钮
    expect(trigger.querySelector('.lucide-radio')).not.toBeNull();

    await openMenu();
    // 全部线路:label 与来源次行都在场(线路 1 同时出现于触发钮与菜单项,计 2 处)
    expect(screen.getAllByText('线路 1 [1080P]')).toHaveLength(2);
    expect(screen.getByText('线路 2 [4K]')).toBeInTheDocument();
    expect(screen.getByText('电信主源')).toBeInTheDocument();
    expect(screen.getByText('联通备用')).toBeInTheDocument();
    // 菜单项结构:role=menuitem × 线路数,选中项内含 Check
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);
  });

  it('选中态:仅当前线路渲染 Check 图标(text-accent)', async () => {
    const { container } = render(
      <PlayerLineSwitcher lines={LINES} selectedLineId="line-1" onSelect={() => undefined} />,
    );
    expect(container.querySelector('.lucide-check')).toBeNull(); // 菜单未开:无 Check
    await openMenu();
    const checks = document.querySelectorAll('.lucide-check');
    expect(checks).toHaveLength(1);
    expect(checks[0]?.classList.contains('text-accent')).toBe(true);
    // Check 挂在选中项(线路 1)所在菜单项内
    const checkItem = checks[0]?.closest('[role="menuitem"]');
    expect(checkItem?.textContent).toContain('线路 1 [1080P]');
  });

  it('选择回调:点击其它线路项,onSelect 携带该线路 lineId', async () => {
    const { onSelect } = renderSwitcher();
    await openMenu();
    fireEvent.click(screen.getByText('线路 2 [4K]'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('line-2');
  });

  it('单线路:返回 null(单线路无换线面);空线路清单同样 null', () => {
    const { container } = render(
      <PlayerLineSwitcher lines={[line()]} selectedLineId="line-1" onSelect={() => undefined} />,
    );
    expect(container).toBeEmptyDOMElement();
    const empty = render(
      <PlayerLineSwitcher lines={[]} selectedLineId={null} onSelect={() => undefined} />,
    );
    expect(empty.container).toBeEmptyDOMElement();
  });

  it('键盘可达:触发钮 aria-haspopup 指向菜单;Enter 开启菜单(HeroUI 键盘交互)', async () => {
    renderSwitcher();
    const trigger = screen.getByRole('button', { name: '切换播放线路' });
    // RAC MenuTrigger 注入菜单语义(3.10 实测闭合态 aria-haspopup="true";aria-controls 随开启注入)
    expect(trigger.getAttribute('aria-haspopup')).not.toBeNull();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.keyUp(trigger, { key: 'Enter' });
    await screen.findByText('线路 2 [4K]');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).not.toBeNull();
  });

  it('selectedLineId 未命中线路清单:触发钮降级为通用文案,不渲染选中 Check', async () => {
    render(
      <PlayerLineSwitcher lines={LINES} selectedLineId={null} onSelect={() => undefined} />,
    );
    expect(screen.getByRole('button', { name: '切换播放线路' }).textContent).toContain('选择线路');
    await openMenu();
    expect(document.querySelectorAll('.lucide-check')).toHaveLength(0);
  });
});
