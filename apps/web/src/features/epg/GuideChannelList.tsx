import type { ReactNode } from 'react';
import type { GuideWindowDto } from '@hmp/shared';
import { formatRangeInZone } from './guide-time';
import { pickCurrentProgramme } from './GuideWall';

/**
 * 按频道列表替代视图(T118;ui.md §6):
 * - 复用同一 GuideWindow 响应(不另发请求);每频道节目按时间排序(服务端已排序,前端保持);
 * - 空档与无节目频道显示「暂无节目」,频道不隐藏(FR-026);
 * - 原生 button + 语义列表(ul/li);节目按钮可读标签含频道、标题、起止;
 *   不声明尚未实现的 ARIA grid(契约 §6);
 * - 节目标题/简介按不可信内容渲染(React 文本转义)。
 */

export interface GuideChannelListProps {
  readonly data: GuideWindowDto;
  readonly selectedKey: string | null;
  readonly onSelectProgramme: (ref: { mediaId: string; channelTitle: string; programme: GuideWindowDto['channels'][number]['programmes'][number] }) => void;
}

export function GuideChannelList({ data, selectedKey, onSelectProgramme }: GuideChannelListProps): ReactNode {
  const nowMs = Date.parse(data.now);
  return (
    <div className="flex flex-col gap-4 p-3">
      {data.channels.map((channel) => {
        const current = pickCurrentProgramme(channel.programmes, nowMs);
        return (
          <section key={channel.media.id} aria-label={`频道 ${channel.media.title}`} className="min-w-0">
            <h3 className="mb-1 flex items-center gap-2 text-sm font-medium text-foreground">
              <span className="hmp-truncate" title={channel.media.title}>
                {channel.media.title}
              </span>
              {current !== null ? <span className="text-xs font-normal text-accent">正在直播:{current.title}</span> : null}
            </h3>
            {channel.programmes.length === 0 ? (
              <p className="text-xs text-muted">暂无节目</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {channel.programmes.map((programme) => {
                  const range = formatRangeInZone(programme.startsAt, programme.endsAt, data.timezone);
                  return (
                    <li key={programme.key}>
                      <button
                        type="button"
                        aria-label={`频道 ${channel.media.title},${programme.title},${range}${current?.key === programme.key ? ',正在直播' : ''}`}
                        title={`${programme.title} ${range}`}
                        onClick={() => {
                          onSelectProgramme({ mediaId: channel.media.id, channelTitle: channel.media.title, programme });
                        }}
                        className={`hmp-tabular-nums max-w-64 rounded border px-2 py-1 text-left text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                          selectedKey === programme.key
                            ? 'border-accent bg-accent/20 text-foreground'
                            : 'border-border bg-surface-secondary text-muted hover:text-foreground'
                        }`}
                      >
                        <span className="hmp-truncate block" title={programme.title}>
                          {programme.title} {range}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
