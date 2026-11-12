import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GuideWindowDto } from '@hmp/shared';
import { GuideChannelList } from '../../src/features/epg/GuideChannelList';
import { resetServerClockForTests } from '../../src/shared/time/server-clock';

/**
 * GuideChannelList 替代视图组件测试(T118 改后契约;ui.md §6/015 ui-layout §3.2/016 spec):
 * - 当前节目行:LIVE 语义(aria-label 含「正在直播」)、进度条(服务端基准钟推进,
 *   width 百分比 ∈ (0%,100%))、剩余文案「还剩」;点击当前行 = 直接播放
 *   (onPlayChannel,mediaId+title),不走 onSelectProgramme;
 * - 即将播出行:点击 = onSelectProgramme;第一条未来行含「分钟后开播」倒计时文案;
 * - 已结束节目:折叠进 <details>(role=group,默认收起),summary 文案「已结束」;
 * - onPlayChannel 仅当前行可触发,未来/已结束行不得触发播放。
 *
 * 时间约定:组件经 useServerNow 取服务端基准钟,测试环境不校准时钟
 * (beforeEach resetServerClockForTests 保证 offset=null)→ nowMs=null 回落
 * 响应快照 data.now(固定 ISO),断言完全离线可复算;无 tick 依赖,
 * 不需要 fake timers、不 mock fetch。夹具时区 America/New_York,与浏览器时区解耦。
 */

/* ---------------- 夹具:固定 NOW + 频道A 四档节目 ---------------- */

const TZ = 'America/New_York';
const NOW_ISO = '2026-11-04T12:05:00.000Z'; // 07:05 EST(固定快照,当前节目窗中点偏前)

/** 节目项(与 GuideWindowDto.channels[].programmes[] 投影一致) */
function programme(key: string, title: string, startsAt: string, endsAt: string) {
  return { key, title, description: null, startsAt, endsAt };
}

/** 频道项(posterRef=null → 不渲染 Logo 身份盒,聚焦行交互断言) */
function channelOf(id: string, title: string, programmes: ReturnType<typeof programme>[]) {
  return {
    media: {
      id,
      type: 'channel' as const,
      title,
      description: null,
      posterRef: null,
      contentLevel: null,
      availability: 'available' as const,
    },
    programmes,
  };
}

/** 频道A:已结束一档 + 当前(now∈[start,end))+ 未来两档(服务端已按时间排序) */
const DATA: GuideWindowDto = {
  date: '2026-11-04',
  timezone: TZ,
  now: NOW_ISO,
  allowedDates: ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10'],
  from: '2026-11-04T05:00:00.000Z',
  to: '2026-11-05T05:00:00.000Z',
  page: 1,
  pageSize: 20,
  totalChannels: 1,
  catalogRevision: 9,
  channels: [
    channelOf('ch-a', '频道甲', [
      programme('pg-ended', '已结束节目', '2026-11-04T11:00:00.000Z', '2026-11-04T12:00:00.000Z'),
      programme('pg-current', '午间直播', '2026-11-04T12:00:00.000Z', '2026-11-04T13:00:00.000Z'),
      programme('pg-future-1', '晚间剧场', '2026-11-04T15:00:00.000Z', '2026-11-04T16:00:00.000Z'),
      programme('pg-future-2', '深夜电影', '2026-11-04T16:00:00.000Z', '2026-11-04T17:00:00.000Z'),
    ]),
  ],
};

/** 挂载组件(每例新 mock 回调,互不泄漏) */
function renderList(): { onPlayChannel: ReturnType<typeof vi.fn>; onSelectProgramme: ReturnType<typeof vi.fn> } {
  const onPlayChannel = vi.fn();
  const onSelectProgramme = vi.fn();
  render(<GuideChannelList data={DATA} selectedKey={null} onPlayChannel={onPlayChannel} onSelectProgramme={onSelectProgramme} />);
  return { onPlayChannel, onSelectProgramme };
}

beforeEach(() => {
  // 清零服务端钟模块级状态:保持未校准 → 组件回落 data.now 快照(确定性)
  resetServerClockForTests();
});

afterEach(() => {
  cleanup();
});

describe('GuideChannelList · 当前行(直播语义/进度/剩余文案/点击=直接播放)', () => {
  it('当前行含「正在直播」aria-label、LIVE 标识、「还剩」剩余文案与可见进度条', () => {
    renderList();
    const currentButton = screen.getByRole('button', { name: /正在直播/ });
    expect(within(currentButton).getByText('LIVE')).toBeInTheDocument();
    expect(currentButton.textContent).toContain('还剩');
    // 产品要求:当前档要有明显进度 —— 内联宽度百分比进度条(0 < p < 100)
    const bar = currentButton.querySelector('span[style*="width"]') as HTMLElement | null;
    expect(bar, '当前行应渲染进度条').not.toBeNull();
    const percent = Number.parseFloat(bar?.style.width ?? '');
    expect(percent).toBeGreaterThan(0);
    expect(percent).toBeLessThan(100);
  });

  it('点击当前行按钮 → onPlayChannel(mediaId+title)恰调一次,onSelectProgramme 不被调', async () => {
    const user = userEvent.setup();
    const { onPlayChannel, onSelectProgramme } = renderList();
    await user.click(screen.getByRole('button', { name: /正在直播/ }));

    expect(onPlayChannel).toHaveBeenCalledTimes(1);
    // onPlayChannel 为位置参数 (mediaId, channelTitle)——与 GuideWall 频道列/当前块同一签名
    expect(onPlayChannel).toHaveBeenCalledWith('ch-a', '频道甲');
    expect(onSelectProgramme).not.toHaveBeenCalled();
  });
});

describe('GuideChannelList · 即将播出行(点击=onSelectProgramme/倒计时文案)', () => {
  it('第一条未来行含「分钟后开播」倒计时;点击 → onSelectProgramme,onPlayChannel 不被调', async () => {
    const user = userEvent.setup();
    const { onPlayChannel, onSelectProgramme } = renderList();

    // 第一条未来行 = 晚间剧场(now 12:05 → start 15:00Z,倒计时非零分钟)
    const futureButton = screen.getByRole('button', { name: /晚间剧场/ });
    expect(futureButton.textContent).toContain('分钟后开播');

    await user.click(futureButton);
    expect(onSelectProgramme).toHaveBeenCalledTimes(1);
    expect(onSelectProgramme).toHaveBeenCalledWith(
      expect.objectContaining({ mediaId: 'ch-a', channelTitle: '频道甲', programme: expect.objectContaining({ key: 'pg-future-1', title: '晚间剧场' }) }),
    );
    expect(onPlayChannel).not.toHaveBeenCalled();
  });
});

describe('GuideChannelList · 已结束节目(折叠 details)', () => {
  it('已结束节目位于 <details>(summary「已结束(N)」)内且默认折叠', () => {
    renderList();
    // jsdom 对关闭态 <details> 不稳定暴露 role=group,经 summary 文本反查宿主元素
    const summary = screen.getByText(/已结束\(\d+\)/);
    const ended = summary.closest('details') as HTMLDetailsElement | null;
    expect(ended, '已结束组应为原生 <details>').not.toBeNull();
    expect(ended?.tagName).toBe('DETAILS');
    expect(ended?.hasAttribute('open'), '已结束组默认折叠').toBe(false);
    expect(within(ended as HTMLElement).getByText('已结束节目')).toBeInTheDocument();
  });
});

describe('GuideChannelList · 播放门禁(onPlayChannel 仅当前行)', () => {
  it('未来行与已结束行点击均不触发 onPlayChannel', async () => {
    const user = userEvent.setup();
    const { onPlayChannel } = renderList();

    await user.click(screen.getByRole('button', { name: /深夜电影/ }));
    await user.click(screen.getByRole('button', { name: /已结束节目/ }));
    expect(onPlayChannel).not.toHaveBeenCalled();
  });
});
