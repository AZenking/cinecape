import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProgrammePoster } from '../../../src/features/shared-programme/programme-poster';

const REF = '0123456789abcdef0123456789abcdef';

describe('020 · ProgrammePoster', () => {
  it('按不透明 ref 请求同源代理，详情场景可读 alt', () => {
    render(<ProgrammePoster posterRef={REF} title="沙丘" decorative={false} />);
    const img = screen.getByRole('img', { name: '沙丘 海报' });
    expect(img.getAttribute('src')).toBe(`/api/public/media/programme-posters/${REF}`);
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('decoding')).toBe('async');
  });

  it('装饰场景 alt="" + aria-hidden', () => {
    const { container } = render(<ProgrammePoster posterRef={REF} title="沙丘" />);
    const img = container.querySelector('img');
    expect(img?.getAttribute('alt')).toBe('');
    expect(img?.getAttribute('aria-hidden')).toBe('true');
  });

  it('ref=null 不渲染；加载失败隐藏自身', () => {
    const { container, rerender } = render(<ProgrammePoster posterRef={null} title="沙丘" />);
    expect(container.querySelector('img')).toBeNull();

    rerender(<ProgrammePoster posterRef={REF} title="沙丘" />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    fireEvent.error(img!);
    expect(container.querySelector('img')).toBeNull();
  });

  it('ref 变化重置失败状态并请求新地址', () => {
    const { container, rerender } = render(<ProgrammePoster posterRef={REF} title="沙丘" />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();

    const next = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    rerender(<ProgrammePoster posterRef={next} title="沙丘" />);
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe(`/api/public/media/programme-posters/${next}`);
  });
});
