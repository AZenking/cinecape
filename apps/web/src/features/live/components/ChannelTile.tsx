import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@heroui/react';
import type { ChannelRowDto, ExperienceProgrammeDto } from '@hmp/shared';
import { formatRangeInZone, formatTimeInZone } from '../live-format';
import { PlayButton } from '../../playback/use-play-action';
import { useSession } from '../../../app/session-provider';
import { FavoriteStarButton } from '../../favorites/favorite-star-button';

/**
 * 直播频道瓦片卡(Netflix 式 16:9 瓦片;T069/T070/T071 演进,FR-021/023/024、ui.md §5/§8):
 * - 16:9 频道标识底板:频道无海报是常态,封面缺失时以频道首字底板呈现
 *   (frontend-home-live-epg-design.md §4.3「图可降级为频道 Logo 底板」;
 *   渐变角度/光斑位置由稳定 media.id 散列决定,同一频道跨刷新不闪变,颜色只用语义 token);
 * - 瓦片承载状态:左上「正在直播/即将播放」标注(红点 + 文字,错误不只靠颜色),
 *   正在直播时底板底部附当前节目进度线(红色 = 直播/时间线语义,见 §2 视觉约定);
 * - 显示频道名称、分组、当前/下一节目及起止时间(家庭时区、等宽数字);
 * - 无节目频道显示「暂无节目」明确占位,占位可点开详情面板(共享面板 none 态,
 *   保留频道身份 +「暂无节目单」,012 T018);播放入口保留(可用性不由 EPG 决定,FR-023);
 * - 点击节目标题/时间打开节目时段详情(频道与起止时间;不伪装可播放未来节目,FR-024);
 * - 播放按钮与收藏按钮分离:播放经共享 PlayButton 走 US3 统一受控播放
 *   (usePlayAction;游客点击进入登录选档意图,选档完成前零 /playback/ 请求);
 *   收藏按会话分流(012 T011、ui.md §1.5):已选档 → 共享 FavoriteStarButton 仅执行
 *   收藏变更(PUT/DELETE /me/favorites/channels,幂等;乐观行内翻面,成功不触发播放);
 *   游客/未选档 → onRequireAuth 登录引导(GuestActionNotice),零请求零部分写入。
 * - 悬停/键盘聚焦(cards focus-within)轻微抬升;动效仅悬停反馈,尊重 reduced-motion
 *   (全局基线见 shared/theme/a11y.css);
 * - 长节目名 .hmp-truncate + title 提供完整可读名称;时间 .hmp-tabular-nums。
 */

/**
 * 节目时段详情回调载荷(即将播放/当前节目共用;打开频道/节目信息):
 * programme 为 null 表示无节目单频道(current/next 双 null,FR-012/T018)——
 * 宿主按 none 态打开共享详情面板。
 */
export interface ProgrammeOpenDetail {
  readonly mediaId: string;
  readonly channelTitle: string;
  readonly groupLabel: string;
  readonly programme: ExperienceProgrammeDto | null;
  readonly kind: 'current' | 'upcoming';
}

export type OpenProgrammeHandler = (input: ProgrammeOpenDetail) => void;

export interface ChannelTileProps {
  readonly row: ChannelRowDto;
  /** 服务端同步快照时区(家庭时区标注与换算唯一依据) */
  readonly timezone: string;
  /** 服务端快照 now(计算当前节目进度线;缺省/无效时不画进度,不臆造本地时钟) */
  readonly nowIso: string | null;
  /** 节目时段详情回调(即将播放/当前节目共用;打开频道/节目信息) */
  readonly onOpenProgramme: OpenProgrammeHandler;
  /** 游客收藏:进入登录选档提示(收藏属 US4;播放不经此,走共享 PlayButton) */
  readonly onRequireAuth: (actionLabel: string) => void;
}

/** djb2 散列:底板渐变角度与光斑位置由稳定 id 派生(伪随机但跨刷新不变) */
function hashOf(key: string): number {
  let hash = 5381;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash << 5) + hash + key.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

/**
 * 当前节目进度 0..1(以服务端快照 now 计;无 now/区间无效/时刻解析失败返回 null)。
 * 导出供 NowHero 复用(012 T017:FR-010 六信息之「进度」,同一快照语义)。
 */
export function progressOf(startsAt: string, endsAt: string, nowIso: string | null): number | null {
  if (nowIso === null) {
    return null;
  }
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(now) || end <= start) {
    return null;
  }
  return Math.min(1, Math.max(0, (now - start) / (end - start)));
}

export function ChannelTile({ row, timezone, nowIso, onOpenProgramme, onRequireAuth }: ChannelTileProps): ReactNode {
  const channelTitle = row.media.title;
  const hasCurrent = row.current !== null;
  const hasNext = row.next !== null;
  const hash = hashOf(row.media.id);
  const plateAngle = 100 + (hash % 140);
  const glowOnRight = hash % 2 === 1;
  const progress = hasCurrent && row.current !== null ? progressOf(row.current.startsAt, row.current.endsAt, nowIso) : null;

  // 收藏会话分流(012 T011):仅「已登录且已选档」直接执行收藏;游客/未选档走登录引导
  const session = useSession();
  const activeProfile = session.status === 'authenticated' ? (session.session?.activeProfile ?? null) : null;
  // 墙面无收藏态数据源(ChannelRowDto 不含 favorited):会话内本地翻面,
  // 服务端真值以收藏页/个人区列表为准(成功经 onChanged 收敛,失败由数据层回滚)
  const [wallFavorited, setWallFavorited] = useState(false);

  return (
    <article
      className="group relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface transition duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-lg hover:shadow-background/60 focus-within:-translate-y-0.5 focus-within:border-accent/40"
      aria-label={`频道 ${channelTitle}`}
    >
      {/* 16:9 频道标识底板(无海报常态降级;装饰节点一律 aria-hidden,可读名由 article 承担) */}
      <div
        className="relative aspect-video w-full overflow-hidden bg-surface-secondary"
        style={{ background: `linear-gradient(${plateAngle}deg, var(--surface-secondary) 0%, var(--surface-tertiary) 55%, var(--surface) 100%)` }}
      >
        <span
          aria-hidden="true"
          className={`absolute -bottom-12 h-36 w-36 rounded-full bg-accent/15 blur-3xl transition duration-300 group-hover:bg-accent/25 ${
            glowOnRight ? '-right-8' : '-left-8'
          }`}
        />
        <span
          aria-hidden="true"
          className="absolute inset-0 flex select-none items-center justify-center text-6xl font-black leading-none text-foreground/5 transition duration-300 group-hover:text-foreground/10"
        >
          {channelTitle.slice(0, 1)}
        </span>

        {/* 状态标注:红点 + 文字(错误不只靠颜色);上左角。
            无节目频道状态签用「暂无排期」而非「暂无节目单」:信息区已有「暂无节目」
            明确占位(FR-023),措辞不得构成其子串,避免「暂无节目」文本查询歧义。 */}
        <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-background/75 px-1.5 py-0.5 text-xs text-foreground backdrop-blur-sm">
          {hasCurrent ? (
            <>
              <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
              正在直播
            </>
          ) : hasNext ? (
            '即将播放'
          ) : (
            '暂无排期'
          )}
        </span>

        {/* 播放/收藏恒驻底板右下(可见性不随悬停变化,避免触控/键盘丢失入口) */}
        <div className="absolute bottom-2 right-2 flex items-center gap-1">
          {activeProfile !== null ? (
            /* 已选档:收藏即收藏——共享星标组件幂等 PUT/DELETE + 乐观行内翻面,
               与播放零关联(§1.5「收藏成功为行内反馈,不得触发播放」) */
            <span className="inline-flex items-center rounded bg-background/70 backdrop-blur-sm">
              <FavoriteStarButton
                mediaId={row.media.id}
                title={channelTitle}
                favorited={wallFavorited}
                size="sm"
                onChanged={(_mediaId, next) => {
                  setWallFavorited(next);
                }}
              />
            </span>
          ) : (
            /* 游客/未选档:登录引导(GuestActionNotice),零请求零部分写入 */
            <Button
              size="sm"
              variant="ghost"
              isIconOnly
              aria-label={`收藏 ${channelTitle}`}
              className="bg-background/70 backdrop-blur-sm"
              onPress={() => {
                onRequireAuth(`收藏 ${channelTitle}`);
              }}
            >
              ☆
            </Button>
          )}
          <PlayButton
            mediaId={row.media.id}
            title={channelTitle}
            size="sm"
            label="播放"
            ariaLabel={`播放 ${channelTitle} 当前直播`}
          />
        </div>

        {/* 当前节目进度线(红 = 直播/时间线;只描述服务端快照,不臆测本地时钟) */}
        {progress !== null ? (
          <span
            aria-hidden="true"
            className="absolute bottom-0 left-0 h-0.5 w-full bg-background/40"
          >
            <span className="block h-full bg-accent" style={{ width: `${Math.round(progress * 100)}%` }} />
          </span>
        ) : null}
      </div>

      {/* 信息区:频道名 / 分组 / 当前节目 / 下一节目 */}
      <div className="flex min-w-0 flex-col gap-1.5 p-3">
        <h3 className="hmp-truncate text-sm font-semibold text-foreground" title={channelTitle}>
          {channelTitle}
        </h3>
        <p className="hmp-truncate text-xs text-muted" title={row.groupLabel}>
          {row.groupLabel}
        </p>

        {hasCurrent && row.current !== null ? (
          <button
            type="button"
            className="min-w-0 rounded p-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            onClick={(event) => {
              event.preventDefault();
              onOpenProgramme({
                mediaId: row.media.id,
                channelTitle,
                groupLabel: row.groupLabel,
                programme: row.current as ExperienceProgrammeDto,
                kind: 'current',
              });
            }}
          >
            <span className="block min-w-0 text-sm text-foreground" title={row.current.title}>
              <span className="hmp-truncate align-middle">{row.current.title}</span>
            </span>
            <span className="hmp-tabular-nums mt-1 block text-xs text-muted">
              {formatRangeInZone(row.current.startsAt, row.current.endsAt, timezone)}
            </span>
          </button>
        ) : (
          /* 无节目占位可点开共享详情面板(none 态:保留频道身份 +「暂无节目单」,
             主操作仍可播放当前直播,FR-012/012 T018;焦点环同相邻节目按钮) */
          <button
            type="button"
            data-testid="no-programme"
            className="min-w-0 rounded p-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            onClick={(event) => {
              event.preventDefault();
              onOpenProgramme({
                mediaId: row.media.id,
                channelTitle,
                groupLabel: row.groupLabel,
                programme: null,
                kind: 'current',
              });
            }}
          >
            <span className="block text-sm text-muted">暂无节目</span>
          </button>
        )}

        {hasNext && row.next !== null ? (
          <button
            type="button"
            className="min-w-0 rounded p-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            onClick={(event) => {
              event.preventDefault();
              onOpenProgramme({
                mediaId: row.media.id,
                channelTitle,
                groupLabel: row.groupLabel,
                programme: row.next as ExperienceProgrammeDto,
                kind: 'upcoming',
              });
            }}
          >
            <span className="block min-w-0 text-sm text-muted" title={row.next.title}>
              <span className="me-1 rounded bg-surface-secondary px-1 text-xs">即将播放</span>
              <span className="hmp-truncate align-middle">{row.next.title}</span>
            </span>
            <span className="hmp-tabular-nums mt-1 block text-xs text-muted">
              {formatTimeInZone(row.next.startsAt, timezone)} 开始 · 至 {formatTimeInZone(row.next.endsAt, timezone)}
            </span>
          </button>
        ) : null}
      </div>
    </article>
  );
}
