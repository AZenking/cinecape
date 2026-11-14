import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { usePlayAction } from '../playback/use-play-action';
import { serverNowMs } from '../../shared/time/server-clock';
import type { ProgrammeOpenDetail } from '../live/components/ChannelTile';

/**
 * 节目单详情跳转规则(产品要求,2026-11-14):
 * - 正在直播(now):不计详情,直接拉起播放器播放该频道当前直播;
 * - 非直播(upcoming/ended/none):进入节目单详情页(/live/programmes/:channelId),
 *   不再打开抽屉;
 * - /live/guide 页面不在此规则内(该页保留自己的详情抽屉)。
 *
 * 状态按服务端基准钟 + 节目窗口现算,不信任入口传的 kind(避免列表快照过期)。
 */
export function useOpenProgramme(timezone: string | undefined): (ref: ProgrammeOpenDetail) => void {
  const navigate = useNavigate();
  const { play } = usePlayAction();

  return useCallback(
    (ref: ProgrammeOpenDetail): void => {
      const programme = ref.programme;
      const now = serverNowMs() ?? Date.now();
      let status: 'now' | 'upcoming' | 'ended' | 'none' = 'none';
      if (programme !== null) {
        const start = Date.parse(programme.startsAt);
        const end = Date.parse(programme.endsAt);
        if (Number.isFinite(start) && Number.isFinite(end)) {
          status = now < start ? 'upcoming' : now < end ? 'now' : 'ended';
        }
      }

      if (status === 'now') {
        play({
          mediaId: ref.mediaId,
          title: ref.channelTitle,
          startMode: 'beginning',
          posterRef: ref.channelPosterRef ?? null,
        });
        return;
      }

      void navigate(`/live/programmes/${ref.mediaId}`, {
        state: {
          channelTitle: ref.channelTitle,
          channelPosterRef: ref.channelPosterRef ?? null,
          groupLabel: ref.groupLabel,
          timezone: timezone ?? 'UTC',
          programme:
            programme === null
              ? null
              : {
                  title: programme.title,
                  description: programme.description,
                  posterRef: programme.posterRef ?? null,
                  startsAt: programme.startsAt,
                  endsAt: programme.endsAt,
                },
        },
      });
    },
    [navigate, play, timezone],
  );
}