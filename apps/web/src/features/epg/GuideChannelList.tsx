import type { ReactNode } from 'react';
import type { ExperienceProgrammeDto, GuideWindowDto } from '@hmp/shared';
import { Chip } from '@heroui/react';
import { Star } from 'lucide-react';
import { ChannelLogo } from '../live/components/channel-logo';
import { formatRangeInZone, formatTimeInZone } from './guide-time';
import { pickCurrentProgramme } from './GuideWall';
import { useServerNow } from '../../shared/time/use-server-now';

/**
 * 按频道列表替代视图(T118;ui.md §6;015 §3.2.2;服务端基准钟条款):
 * - 参考 Planby (https://github.com/karolkozer/planby) 的网格设计模式并映射为语义列表
 *   (仅借鉴设计模式,零依赖/零源码引用,license 约束见 docs/frontend-home-live-epg-design.md §6):
 *   行 = 频道(频道身份 logo/首字回退 + 名称 + 直播脉冲),当前节目 = 「特色行」
 *   (大标题 + 起止区间 + LIVE 徽章 + 底部实时进度条 + 剩余时间文案),
 *   即将播出 = 按时间升序紧凑行,已结束 = 折叠进原生 <details>(不删数据);
 * - 时间来源:组件内统一 useServerNow()(tickMs 默认 15s,进度条/剩余文案随 tick 推进,
 *   服务端基准钟条款:禁止裸 Date.now());未校准回落 Date.parse(data.now);
 *   当前节目选取(pickCurrentProgramme,R8:start<=now<end 取 startsAt 最近、同起点 key 升序)、
 *   进度、剩余文案、倒计时全部使用同一 nowMs;
 * - 点击分流(015 §3.2.2):当前节目特色行 = 直播语义,点击直接起播该频道当前直播
 *   (onPlayChannel 统一入口,游客先登录、登录前零媒体流请求,与 GuideWall 的 NOW
 *   相交块同一分流);即将播出/已结束行保持 onSelectProgramme 详情面板路径
 *   (FR-024:未来节目禁止直接播放,不伪装可播);
 * - 无障碍:ul/li + 原生 button 语义列表;aria-label 含频道、标题、起止、状态
 *   (正在直播的当前行 aria 含「正在直播」);已结束折叠用原生 <details>/<summary>
 *   (键盘/无 JS 语义友好);节目标题按不可信内容文本渲染(React 文本转义,不注入 HTML);
 * - 等宽数字 hmp-tabular-nums;焦点 focus-visible:ring-2 focus-visible:ring-focus;
 * - 频道列头小尺寸频道身份标识(014 T026,ui.md §2 接入点 3、spec US3-1):posterRef
 *   直接取自 GuideWindowDto.channels[].media.posterRef;有 Logo → 固定尺寸身份盒内渲染
 *   ChannelLogo(加载中/失败由组件内首字回退层兜底);无 Logo → 不渲染身份盒(FR-008);
 * - 空频道保留「暂无节目」,频道不隐藏(FR-026);样式只用语义 token
 *   (012 ui.md §3、016 spec),z 序仅用合法序列。
 */

export interface GuideChannelListProps {
  readonly data: GuideWindowDto;
  readonly selectedKey: string | null;
  readonly onSelectProgramme: (ref: { mediaId: string; channelTitle: string; programme: ExperienceProgrammeDto }) => void;
  /** 点击当前节目(直播语义)直接起播该频道当前直播(015 §3.2.2 统一入口) */
  readonly onPlayChannel: (mediaId: string, channelTitle: string) => void;
  /** 已收藏频道 id 集合(列表视图频道名旁打星标) */
  readonly favoriteIds?: ReadonlySet<string>;
}

/** 稳定空集合 */
const EMPTY_FAVORITE_IDS: ReadonlySet<string> = new Set<string>();

/** 剩余时间文案:≥1 分钟「还剩 X 分钟」;不足 1 分钟「还剩 X 秒」;非正数回落「即将结束」 */
function remainingLabel(endsAtMs: number, nowMs: number): string {
  const remainMs = endsAtMs - nowMs;
  if (remainMs <= 0) {
    return '即将结束';
  }
  if (remainMs < 60_000) {
    return `还剩 ${Math.max(1, Math.ceil(remainMs / 1000))} 秒`;
  }
  return `还剩 ${Math.ceil(remainMs / 60_000)} 分钟`;
}

/** 距开播倒计时文案:≥1 分钟「X 分钟后开播」;不足 1 分钟「即将开播」 */
function countdownLabel(startsAtMs: number, nowMs: number): string {
  const untilMs = startsAtMs - nowMs;
  if (untilMs <= 0) {
    return '即将开播';
  }
  if (untilMs < 60_000) {
    return '即将开播';
  }
  return `${Math.ceil(untilMs / 60_000)} 分钟后开播`;
}

/** 节目时长(分钟,向上取整;用于即将播出紧凑行的「时长 X 分钟」) */
function durationLabel(programme: ExperienceProgrammeDto): string {
  const startMs = Date.parse(programme.startsAt);
  const endMs = Date.parse(programme.endsAt);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    return '';
  }
  return `时长 ${Math.ceil((endMs - startMs) / 60_000)} 分钟`;
}

export function GuideChannelList({
  data,
  selectedKey,
  onSelectProgramme,
  onPlayChannel,
  favoriteIds = EMPTY_FAVORITE_IDS,
}: GuideChannelListProps): ReactNode {
  // 服务端基准钟:组件内单一时间来源(ticking,默认 15s 推进);未校准回落响应快照 now
  const { nowMs: tickingNowMs } = useServerNow();
  const nowMs = tickingNowMs ?? Date.parse(data.now);

  return (
    <div className="flex flex-col gap-4 p-4">
      {data.channels.map((channel) => {
        const current = pickCurrentProgramme(channel.programmes, nowMs);
        const startsAtMsOf = (p: ExperienceProgrammeDto): number => Date.parse(p.startsAt);
        const endsAtMsOf = (p: ExperienceProgrammeDto): number => Date.parse(p.endsAt);
        // 即将播出:now <= start,按时间升序(服务端已排序,前端保持)
        const upcoming = channel.programmes.filter((p) => {
          const s = startsAtMsOf(p);
          return !Number.isNaN(s) && s > nowMs;
        });
        // 已结束:end <= now(保持原序,折叠展示不删数据)
        const ended = channel.programmes.filter((p) => {
          const e = endsAtMsOf(p);
          return !Number.isNaN(e) && e <= nowMs;
        });

        return (
          <section key={channel.media.id} aria-label={`频道 ${channel.media.title}`} className="min-w-0 rounded-xl border border-border/60 bg-surface p-3 shadow-xs">
            <h3 className="mb-2 flex items-center gap-2 border-b border-border/40 pb-2 text-sm font-medium text-foreground">
              {/* 列头小尺寸身份标识(014 T026):固定尺寸盒不参与行高(US3-1);
                  装饰节点 aria-hidden,可读名由列头文字承担 */}
              {channel.media.posterRef !== null ? (
                <span aria-hidden="true" className="relative inline-flex size-5 shrink-0 overflow-hidden rounded-sm">
                  <ChannelLogo
                    key={channel.media.posterRef}
                    posterRef={channel.media.posterRef}
                    channelTitle={channel.media.title}
                    fallbackClassName="text-xs font-black leading-none text-foreground/10"
                  />
                </span>
              ) : null}
              <span className="hmp-truncate font-semibold" title={channel.media.title}>
                {channel.media.title}
              </span>
              {favoriteIds.has(channel.media.id) ? (
                <span className="flex shrink-0 items-center gap-1 text-xs font-normal text-accent">
                  <Star aria-hidden="true" className="size-3.5 fill-current" />
                  已收藏
                </span>
              ) : null}
              {current !== null ? (
                <span className="flex items-center gap-1.5 text-xs font-normal text-accent">
                  <span className="size-1.5 rounded-full bg-accent animate-pulse" />
                  正在直播
                </span>
              ) : null}
            </h3>

            {channel.programmes.length === 0 ? (
              <p className="text-xs text-muted">暂无节目</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {/* 当前节目特色行(Planby 特色行模式):点击 = 直接起播该频道当前直播 */}
                {current !== null ? (() => {
                  const endsAtMs = endsAtMsOf(current);
                  const startsAtMs = startsAtMsOf(current);
                  const liveProgress =
                    endsAtMs > startsAtMs
                      ? Math.min(100, Math.max(0, ((nowMs - startsAtMs) / (endsAtMs - startsAtMs)) * 100))
                      : 0;
                  const range = formatRangeInZone(current.startsAt, current.endsAt, data.timezone);
                  const live = selectedKey === current.key;
                  return (
                    <li>
                      <button
                        type="button"
                        aria-label={`频道 ${channel.media.title},正在直播,${current.title},${range},${remainingLabel(endsAtMs, nowMs)}`}
                        title={`${current.title} ${range}`}
                        onClick={() => {
                          onPlayChannel(channel.media.id, channel.media.title);
                        }}
                        className={`hmp-tabular-nums relative block w-full overflow-hidden rounded-lg border px-3 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                          live
                            ? 'border-accent bg-accent/25 shadow-xs'
                            : 'border-accent/70 bg-accent/10 hover:bg-accent/20'
                        }`}
                      >
                        {/* 底部实时进度条:随 useServerNow tick 推进(产品要求保留可见进度) */}
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute bottom-0 left-0 h-1 rounded-b-lg bg-accent"
                          style={{ width: `${liveProgress}%` }}
                        />
                        <span className="flex items-center gap-1.5">
                          <span className="hmp-truncate min-w-0 text-sm font-semibold text-foreground" title={current.title}>
                            {current.title}
                          </span>
                          {/* LIVE 徽章:文字承载语义,不以颜色为唯一区分 */}
                          <Chip aria-hidden="true" color="success" size="sm" variant="soft" className="h-4 shrink-0 px-1 text-3xs">
                            LIVE
                          </Chip>
                        </span>
                        <span className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                          <span>{range}</span>
                          <span className="text-accent">{remainingLabel(endsAtMs, nowMs)}</span>
                        </span>
                      </button>
                    </li>
                  );
                })() : null}

                {/* 即将播出:按时间升序紧凑行;第一条附「X 分钟后开播」倒计时(随 tick 更新) */}
                {upcoming.map((programme, index) => {
                  const startsAtMs = startsAtMsOf(programme);
                  const range = formatRangeInZone(programme.startsAt, programme.endsAt, data.timezone);
                  const startLabel = formatTimeInZone(programme.startsAt, data.timezone);
                  const countdown = index === 0 ? countdownLabel(startsAtMs, nowMs) : durationLabel(programme);
                  return (
                    <li key={programme.key}>
                      <button
                        type="button"
                        aria-label={`频道 ${channel.media.title},即将播出,${programme.title},${range}${countdown === '' ? '' : `,${countdown}`}`}
                        title={`${programme.title} ${range}`}
                        onClick={() => {
                          // FR-024:未来节目禁止直接播放,保持详情面板路径
                          onSelectProgramme({ mediaId: channel.media.id, channelTitle: channel.media.title, programme });
                        }}
                        className={`hmp-tabular-nums flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                          selectedKey === programme.key
                            ? 'border-accent bg-accent/25 text-foreground shadow-xs'
                            : 'border-border/60 bg-surface-secondary/40 text-muted hover:border-foreground/30 hover:bg-surface-secondary/70 hover:text-foreground'
                        }`}
                      >
                        <span className="shrink-0 font-medium text-foreground">{startLabel}</span>
                        <span className="hmp-truncate min-w-0 font-medium" title={programme.title}>
                          {programme.title}
                        </span>
                        {countdown !== '' ? (
                          <span className="ml-auto shrink-0 text-muted">{countdown}</span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}

                {/* 已结束:降透明度,折叠进原生 <details>(键盘/无 JS 语义友好;不删数据) */}
                {ended.length > 0 ? (
                  <li>
                    <details className="rounded-lg border border-border/40 bg-surface-secondary/30">
                      <summary className="hmp-tabular-nums cursor-pointer select-none px-2.5 py-1.5 text-xs text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                        已结束({ended.length})
                      </summary>
                      <ul className="flex flex-col gap-1 px-2.5 pb-1.5">
                        {ended.map((programme) => {
                          const range = formatRangeInZone(programme.startsAt, programme.endsAt, data.timezone);
                          return (
                            <li key={programme.key}>
                              <button
                                type="button"
                                aria-label={`频道 ${channel.media.title},已结束,${programme.title},${range}`}
                                title={`${programme.title} ${range}`}
                                onClick={() => {
                                  onSelectProgramme({ mediaId: channel.media.id, channelTitle: channel.media.title, programme });
                                }}
                                className={`hmp-tabular-nums flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs opacity-60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-focus hover:opacity-100 ${
                                  selectedKey === programme.key
                                    ? 'bg-accent/25 text-foreground'
                                    : 'text-muted hover:bg-surface-secondary hover:text-foreground'
                                }`}
                              >
                                <span className="shrink-0">{range}</span>
                                <span className="hmp-truncate min-w-0 font-medium" title={programme.title}>
                                  {programme.title}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                  </li>
                ) : null}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
