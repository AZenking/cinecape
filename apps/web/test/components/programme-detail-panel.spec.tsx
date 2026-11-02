import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
// T005 落位目标:apps/web/src/features/shared-programme/ProgrammeDetailPanel.tsx
// 此刻尚不存在 —— 本文件预期红(vitest: Failed to resolve import;tsc: TS2307)。
import { ProgrammeDetailPanel } from '../../src/features/shared-programme/ProgrammeDetailPanel';

/**
 * T003(012 Foundational,先 FAIL)· 共享节目详情面板组件单测:
 * 直播首页三区(Now/Next/Groups)与 EPG 节目单必须挂载同一详情面板组件
 * (ui.md §2.1);本文件先于 T005 实现锚定行为契约,断言锚定 ui.md §2 六要素/
 * 四状态/焦点行为,不断言实现细节。
 *
 * 与现状两组件 props 对齐后的接口决定(供 T005 落位时实现):
 * - 受控 `open`(对齐 live 侧旧弹层的 open/onOpenChange;epg 版用
 *   target|null 表达开合,共享面板统一为显式 open + onClose);
 * - `channel: { name, logo? }`:六要素「频道名称+标识」需要 logo,epg/live 现状
 *   只有 channelTitle 字符串,宿主侧补传;
 * - `programme: { title, description, start, end } | null`:现状 DTO 字段名为
 *   startsAt/endsAt,共享面板归一为 start/end,宿主映射;null = 暂无节目数据;
 * - `status: 'now'|'upcoming'|'ended'|'none'` 由宿主裁决(取代现状
 *   serverNowIso 与起止比对的组件内推导),ui.md §2.3 四状态文案契约;
 * - `source?: 'now'|'next'|'guide'`:仅记录入口、不影响面板结构(data-model §2),
 *   面板结构断言不依赖它;
 * - 动作回调 `onPlay/onFavorite/onGuide/onClose` 均无参:频道身份(mediaId)由
 *   宿主闭包持有,保持 ui.md §1.4「频道语义、不锁定具体节目」;
 * - none 态主操作语义以现状组件为准:live 侧旧弹层在 programme=null
 *   时仍渲染「播放 …当前直播」按钮 → 共享面板在 status='none' 且频道可用时
 *   仍提供「播放当前频道」(ui.md §2.5「主操作仍可为播放当前频道」)。
 *
 * 运行环境:apps/web/vitest.config.ts —— jsdom + test/setup.ts(matchMedia/
 * ResizeObserver 垫片、jest-dom、逐例 cleanup)。
 */

/** T005 实现必须满足的 props 契约(结构化兼容即可,导出位置/命名由实现定) */
interface ProgrammeDetailPanelProps {
  readonly open: boolean;
  readonly channel: { readonly name: string; readonly logo?: string | null };
  readonly programme: {
    readonly title: string;
    readonly description: string | null;
    /** ISO 起始时刻(现状 DTO 的 startsAt,共享面板归一命名) */
    readonly start: string;
    /** ISO 结束时刻(现状 DTO 的 endsAt) */
    readonly end: string;
  } | null;
  readonly status: 'now' | 'upcoming' | 'ended' | 'none';
  readonly timezone: string;
  readonly source?: 'now' | 'next' | 'guide';
  readonly onPlay: () => void;
  readonly onFavorite: () => void;
  readonly onGuide: () => void;
  readonly onClose: () => void;
}

const TZ = 'Asia/Shanghai';
const CHANNEL = { name: '卫视频道 HD', logo: '/logo/hd.svg' } as const;

// 时刻均以 UTC 桩给,断言按家庭时区 Asia/Shanghai 的呈现(现状 live-format 语义)
const NOW_PROGRAMME = {
  title: '城市夜线',
  description: '深夜档纪实剧集,讲述城市夜间的故事。',
  start: '2026-11-04T12:00:00.000Z', // 家庭时区 20:00
  end: '2026-11-04T12:30:00.000Z', // 家庭时区 20:30 → 时长 30 分钟
} as const;

const UPCOMING_PROGRAMME = {
  title: '午夜剧场',
  description: null,
  start: '2026-11-04T05:00:00.000Z', // 家庭时区 13:00(开播时间)
  end: '2026-11-04T05:30:00.000Z',
} as const;

const ENDED_PROGRAMME = {
  title: '晨间新闻',
  description: null,
  start: '2026-11-04T08:00:00.000Z', // 家庭时区 16:00
  end: '2026-11-04T08:30:00.000Z',
} as const;

function panelProps(overrides: Partial<ProgrammeDetailPanelProps> = {}): ProgrammeDetailPanelProps {
  return {
    open: true,
    channel: CHANNEL,
    programme: NOW_PROGRAMME,
    status: 'now',
    timezone: TZ,
    source: 'guide',
    onPlay: vi.fn(),
    onFavorite: vi.fn(),
    onGuide: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

function renderPanel(props: ProgrammeDetailPanelProps): void {
  render(<ProgrammeDetailPanel {...props} />);
}

/** 受控宿主:带触发按钮的 open 状态(验证焦点入面板/Escape 恢复触发焦点) */
function ControlledHarness(base: ProgrammeDetailPanelProps): ReactNode {
  const [open, setOpen] = useState(base.open);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开节目详情
      </button>
      <ProgrammeDetailPanel
        {...base}
        open={open}
        onClose={() => {
          base.onClose();
          setOpen(false);
        }}
      />
    </>
  );
}

describe('T003 · 共享节目详情面板 ProgrammeDetailPanel(ui.md §2;T005 落位前预期红)', () => {
  it('六要素:频道名称+标识、节目标题+简介、起止时间+时长(家庭时区标注)、状态、主操作、次操作', () => {
    renderPanel(panelProps());

    // §2.2 呈现:浮层/抽屉(dialog 语义)。说明:HeroUI Modal 打开期间对背景做
    // aria-hidden(009 已知语义),「底层页面保持可见」指视觉层;触发按钮可达性
    // 断言在关闭态覆盖(见下方焦点/Escape 用例的受控宿主)。
    expect(screen.getByRole('dialog')).toBeVisible();
    // ① 频道名称 + 标识(logo 渲染为图片)
    expect(screen.getByText(CHANNEL.name)).toBeVisible();
    expect(document.querySelector(`img[src="${CHANNEL.logo}"]`)).toBeInTheDocument();
    // ② 节目标题 + 简介
    expect(screen.getByText(NOW_PROGRAMME.title)).toBeVisible();
    expect(screen.getByText(NOW_PROGRAMME.description)).toBeVisible();
    // ③ 起止时间(家庭时区 HH:mm–HH:mm)+ 时长 + 家庭时区标注文本
    expect(screen.getByText(/20:00\s*[–—-]\s*20:30/)).toBeVisible();
    expect(screen.getByText(/时长/).textContent).toMatch(/30\s*分钟/);
    const zoneNote = screen.getByText(/家庭时区/);
    expect(zoneNote.textContent).toContain(TZ);
    // ④ 状态文案:正在直播
    expect(screen.getByText('正在直播')).toBeVisible();
    // ⑤ 主操作(仅 now):「播放当前频道」,可用
    expect(screen.getByRole('button', { name: '播放当前频道' })).toBeEnabled();
    // ⑥ 次操作:收藏频道、查看节目单
    expect(screen.getByRole('button', { name: '收藏频道' })).toBeVisible();
    expect(screen.getByRole('button', { name: '查看节目单' })).toBeVisible();
  });

  it('now 状态:按下主操作「播放当前频道」触发 onPlay(频道语义,不锁定具体节目)', async () => {
    const props = panelProps();
    renderPanel(props);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '播放当前频道' }));
    expect(props.onPlay).toHaveBeenCalledTimes(1);
  });

  it('次操作:收藏频道/查看节目单各触发对应回调;收藏不触发播放(ui.md §1.5)', async () => {
    const props = panelProps();
    renderPanel(props);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '收藏频道' }));
    await user.click(screen.getByRole('button', { name: '查看节目单' }));
    expect(props.onFavorite).toHaveBeenCalledTimes(1);
    expect(props.onGuide).toHaveBeenCalledTimes(1);
    expect(props.onPlay).not.toHaveBeenCalled();
  });

  it('upcoming 状态:显示「即将开始」与开播时间,无播放主操作;主操作回落「查看节目单」(ui.md §1.6)', () => {
    renderPanel(
      panelProps({
        status: 'upcoming',
        programme: UPCOMING_PROGRAMME,
        source: 'next',
      }),
    );
    expect(screen.getByText('即将开始')).toBeVisible();
    // 开播时间断言精确匹配「开播」行的 13:00(时段区间 dd 文本为区间串,不会误匹配)
    expect(screen.getByText('13:00')).toBeVisible();
    expect(screen.queryByRole('button', { name: '播放当前频道' })).toBeNull();
    expect(screen.getByRole('button', { name: '查看节目单' })).toBeVisible();
  });

  it('ended 状态:显示「已结束」,无播放主操作(ui.md §1.6)', () => {
    renderPanel(
      panelProps({
        status: 'ended',
        programme: ENDED_PROGRAMME,
        source: 'guide',
      }),
    );
    expect(screen.getByText('已结束')).toBeVisible();
    expect(screen.queryByRole('button', { name: '播放当前频道' })).toBeNull();
  });

  it('none 状态:保留频道身份并显示「暂无节目单/暂无节目数据」;频道可用时主操作仍可播(以旧 live 弹层 programme=null 仍渲染播放按钮的语义为准,ui.md §2.5)', () => {
    // 现状对齐说明:live 侧旧弹层在 programme=null 时仍渲染
    // 「播放 {频道} 当前直播」按钮;ui.md §2.5 亦允许 none 态保留频道播放主操作。
    renderPanel(panelProps({ status: 'none', programme: null }));
    expect(screen.getByText(CHANNEL.name)).toBeVisible(); // 频道身份保留
    expect(screen.getByText('暂无节目数据')).toBeVisible(); // 状态文案
    expect(screen.getByText('暂无节目单')).toBeVisible(); // 无节目提示
    expect(screen.getByRole('button', { name: '播放当前频道' })).toBeVisible();
  });

  it('打开时焦点进入面板;关闭态不渲染面板(ui.md §2.2、§6.3)', async () => {
    // 受控宿主初始关闭:Modal 打开期间背景 aria-hidden(009 已知语义),触发按钮
    // 仅在关闭态可查;打开→焦点入面板,Escape→焦点恢复触发按钮(下方用例)。
    render(<ControlledHarness {...panelProps({ open: false })} />);
    const trigger = screen.getByRole('button', { name: '打开节目详情' });
    expect(screen.queryByRole('dialog')).toBeNull(); // 关闭态:面板不在文档中

    const user = userEvent.setup();
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(trigger).not.toHaveFocus(); // 焦点已移入面板
  });

  it('Escape 关闭面板并恢复触发元素焦点(ui.md §2.2、§6.3)', async () => {
    // 同一组 spy 传入受控宿主(断言对象与被调对象必须是同一个 onClose)
    const props = panelProps();
    render(<ControlledHarness {...panelProps({ ...props, open: false })} />);
    const trigger = screen.getByRole('button', { name: '打开节目详情' });
    const user = userEvent.setup();
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog');
    // React Aria 的 Escape 关闭要求按键冒泡经过 overlay:先等焦点移入面板(与真实 UX 一致)
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    await user.keyboard('{Escape}');
    expect(props.onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('面板打开期间刷新(props 更新):内容更新、面板不关闭、焦点不跳出(ui.md §2.4)', async () => {
    const props = panelProps();
    const { rerender } = render(<ProgrammeDetailPanel {...props} />);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    // 模拟 30s 刷新:同一面板实例数据更新(标题/简介变化)
    rerender(
      <ProgrammeDetailPanel
        {...props}
        programme={{
          title: '城市夜线(更新)',
          description: '刷新后的节目简介。',
          start: NOW_PROGRAMME.start,
          end: NOW_PROGRAMME.end,
        }}
      />,
    );

    expect(props.onClose).not.toHaveBeenCalled(); // 面板未被关闭
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByText('城市夜线(更新)')).toBeVisible(); // 内容已更新
    await waitFor(() => expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)); // 焦点仍在面板内
  });
});
