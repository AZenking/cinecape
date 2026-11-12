import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GuideScrollContainer } from '../../src/features/epg/GuideScrollContainer';

/**
 * 节目墙拖拽平移(产品要求:按住拖动横向/纵向查看)。
 *
 * 行为契约:
 * - 位移 ≤ 4px 视为点击,不进入拖拽(保证节目块可正常点击);
 * - 超过阈值进入拖拽:内容跟随指针反向滚动(scrollLeft = 起始值 − dx);
 * - 拖拽结束后的第一次 click 被抑制(松手不应误触发节目块/播放按钮);
 * - 触屏(pointerType=touch)不接管,交给原生惯性滚动。
 *
 * jsdom 无布局:scrollLeft/scrollTop 可写但不会因内容溢出而自动出现滚动条,
 * 因此直接断言属性赋值结果。
 */

function renderContainer(children: React.ReactNode = <div style={{ width: 4000, height: 2000 }} />): HTMLElement {
  render(
    <GuideScrollContainer ariaLabel="节目墙">
      {children}
    </GuideScrollContainer>,
  );
  return screen.getByRole('region', { name: '节目墙' });
}

function pointerEvent(type: string, init: { pointerId?: number; pointerType?: string; clientX?: number; clientY?: number; button?: number }): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    pointerId: init.pointerId ?? 1,
    pointerType: init.pointerType ?? 'mouse',
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    button: init.button ?? 0,
  });
  return event;
}

describe('GuideScrollContainer · 拖拽平移', () => {
  afterEach(() => {
    cleanup();
  });

  it('拖动超过阈值:横向/纵向跟随指针平移', () => {
    const el = renderContainer();
    el.scrollLeft = 500;
    el.scrollTop = 200;

    fireEvent(el, pointerEvent('pointerdown', { clientX: 800, clientY: 400 }));
    // 位移 100px(向右拖 → 内容左移,scrollLeft 减小)
    fireEvent(el, pointerEvent('pointermove', { clientX: 700, clientY: 350 }));

    expect(el.scrollLeft).toBe(600);
    expect(el.scrollTop).toBe(250);
  });

  it('位移小于阈值视为点击:不改变滚动位置', () => {
    const el = renderContainer();
    el.scrollLeft = 500;

    fireEvent(el, pointerEvent('pointerdown', { clientX: 800, clientY: 400 }));
    fireEvent(el, pointerEvent('pointermove', { clientX: 798, clientY: 399 }));

    expect(el.scrollLeft).toBe(500);
  });

  it('拖拽结束后的第一次 click 被抑制,其后 click 正常放行', () => {
    const onClick = vi.fn();
    const el = renderContainer(<button type="button" onClick={onClick}>节目块</button>);

    fireEvent(el, pointerEvent('pointerdown', { clientX: 800, clientY: 400 }));
    fireEvent(el, pointerEvent('pointermove', { clientX: 650, clientY: 400 }));
    fireEvent(el, pointerEvent('pointerup', { clientX: 650, clientY: 400 }));

    // 松手产生的 click:被抑制
    fireEvent.click(screen.getByRole('button', { name: '节目块' }));
    expect(onClick).not.toHaveBeenCalled();

    // 下一次点击正常触发
    fireEvent.click(screen.getByRole('button', { name: '节目块' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('触屏指针不接管(保持原生滚动)', () => {
    const el = renderContainer();
    el.scrollLeft = 500;

    fireEvent(el, pointerEvent('pointerdown', { pointerType: 'touch', clientX: 800, clientY: 400 }));
    fireEvent(el, pointerEvent('pointermove', { pointerType: 'touch', clientX: 600, clientY: 400 }));

    expect(el.scrollLeft).toBe(500);
  });
});