/**
 * 播放设置浮层轨道选择 hook(012 T028 修补;FR-020 第 4 项、FR-023、ui.md §4.4/§4.5):
 *
 * - 会话内当前控制:音轨/字幕经既有 PUT /playback/sessions/:id/selection(004 契约
 *   原子换轨;本规格不新增服务端端点);清晰度为服务端探测交付的只读事实(无质量
 *   阶梯端点 —— 红线「不新增端点/偏好项」,只展示当前值不提供切换);
 * - 恰一会话:selection 仅打当前 sessionId,响应不换会话;重建输出的音轨切换
 *   generation+1 → 轮询**同一会话**至 ready 后以新代 renew 换票(onTicket 换装,
 *   位置由外层捕获回填)—— 零第二 /playback/resolve、零并行会话(FR-020 末项同源);
 * - CAS 与代次:expectedVersion 取探针快照 version(提交成功随响应 PlaybackDto
 *   推进,onStatusPatch 回写);409 PLAYBACK_VERSION_CONFLICT 刷新一次会话状态
 *   (版本/轨道同步)后允许重试,不自动重发提交;本地代次经 generationRef 追踪
 *   (续期定时器读它,避免重建换轨后携旧代 renew 撞 PLAYBACK_GENERATION_STALE);
 * - 幂等/单飞:pending 在途忽略新提交;started ACK 前禁用重建输出的音轨切换
 *   (canSwitchTracks 泵门,005 T104 同源);纯字幕切换不重建输出、不受此门限制;
 * - 初始值(FR-017):初始使用默认音轨(tracks.audio 中 default=true)、不自动开启
 *   字幕(subtitle=null);会话身份变化即重置(旧会话选择不迁移);
 * - 失败呈现稳定文案(不含内部码/策略细节),媒体继续播放(纯字幕零中断;重建
 *   输出窗内旧输出按票据原有效期,失败经既有终止面收口)。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Vod } from '@hmp/shared';
import { isFetchApiError, privateFetch } from '../../shared/fetch';

type PlaybackDto = Vod.components['schemas']['PlaybackDto'];
type PlaybackTracks = PlaybackDto['tracks'];

/** 会话状态刷新预算(重建音轨后 ready 轮询;与协调器 prepare 预算同口径) */
const REBUILD_POLL_BUDGET_MS = 30_000;
const REBUILD_POLL_MS = 500;

/** 交付模式 → 当前清晰度展示标签(服务端探测事实的只读投影;不含源细节) */
export const DELIVERY_LABEL: Record<string, string> = {
  direct: '源文件直读',
  hls_proxy: 'HLS 直转',
  remux: '转封装',
  audio_transcode: '音频转码',
  video_transcode: '视频转码',
};

export interface PlaybackTrackSelectionOptions {
  readonly sessionId: string;
  /** 本意图初始会话代(协调器播放面;重建换轨后由本 hook 追踪推进) */
  readonly generation: number;
  /** 探针快照 version(selection CAS 依据;null=探针未回写,提交闭门) */
  readonly version: number | null;
  /** 探针快照轨道(探测未完成为空数组;null=快照未回) */
  readonly tracks: PlaybackTracks | null;
  /** 进度泵 started ACK 前 false(重建输出音轨闭门;hook 经 ref 读最新值) */
  readonly canSwitchTracks: boolean;
  /** 当前媒体位置秒(selection.positionSeconds;媒体元素事实) */
  readonly getPositionSeconds: () => number;
  /** 重建换轨后新票换装(url/expiresAt 上报协调器换装;generation 为新票代) */
  readonly onTicket: (url: string, expiresAt: string, generation: number) => void;
  /** 提交/冲突刷新后回写探针快照(version/tracks;后续 CAS 不读旧值) */
  readonly onStatusPatch: (patch: {
    readonly version: number;
    readonly tracks: PlaybackTracks;
  }) => void;
}

export interface PlaybackTrackSelectionApi {
  readonly open: boolean;
  readonly toggle: () => void;
  readonly close: () => void;
  /** 提交在途(单飞门;UI 禁用重复提交) */
  readonly pending: boolean;
  /** 稳定失败文案(null=无) */
  readonly failure: string | null;
  readonly tracks: PlaybackTracks | null;
  /** 当前音轨(初始=服务端默认轨;成功提交后=所选轨) */
  readonly activeAudioId: string | null;
  /** 当前字幕(null=关闭;初始恒关闭,FR-017) */
  readonly activeSubtitleId: string | null;
  /** 重建输出音轨是否放行(泵 ACK 门;UI 禁用面) */
  readonly canSwitchAudio: boolean;
  readonly selectAudio: (trackId: string) => void;
  readonly selectSubtitle: (trackId: string | null) => void;
  /** 本地追踪的当前会话代(外层续期定时器读它;重建换轨后即新代) */
  readonly generationRef: { readonly current: number };
}

export function usePlaybackTrackSelection(options: PlaybackTrackSelectionOptions): PlaybackTrackSelectionApi {
  const { sessionId, generation, version, tracks, canSwitchTracks, getPositionSeconds, onTicket, onStatusPatch } =
    options;

  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [activeAudioId, setActiveAudioId] = useState<string | null>(null);
  const [activeSubtitleId, setActiveSubtitleId] = useState<string | null>(null);

  // 本地代次追踪:协调器播放面代次 prop 不随 renew/重建换轨更新(其 onRenew 仅换装
  // URL),重建音轨 generation+1 后外层续期若仍携旧代将撞 409 GENERATION_STALE ——
  // 本 hook 持 ref 推进,续期定时器与 renew 载荷一律读最新值。
  const generationRef = useRef<number>(generation);
  generationRef.current = generation;
  // 稳定面:props/回调经 ref 读取,提交链不因重渲染重排
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const versionRef = useRef<number | null>(version);
  versionRef.current = version;
  const canSwitchRef = useRef(canSwitchTracks);
  canSwitchRef.current = canSwitchTracks;
  const positionRef = useRef(getPositionSeconds);
  positionRef.current = getPositionSeconds;
  const ticketRef = useRef(onTicket);
  ticketRef.current = onTicket;
  const statusPatchRef = useRef(onStatusPatch);
  statusPatchRef.current = onStatusPatch;
  const pendingRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // 会话身份变化:选择态整体重置(旧会话的当前轨不迁移;浮层关闭)
  useEffect(() => {
    setActiveAudioId(null);
    setActiveSubtitleId(null);
    setOpen(false);
    setFailure(null);
    setPending(false);
    pendingRef.current = false;
  }, [sessionId]);

  // 初始当前音轨 = 服务端默认轨(FR-017;仅初始缺位时落位,提交后不覆盖)
  useEffect(() => {
    if (activeAudioId !== null || tracks === null) {
      return;
    }
    const defaulted = tracks.audio.find((track) => track.default) ?? tracks.audio[0];
    if (defaulted !== undefined) {
      setActiveAudioId(defaulted.id);
    }
  }, [tracks, activeAudioId]);

  /** 提交链:决议 true=已接受(响应已回写快照);失败/闭门/会话已换=false。
   *  当前轨选择态**只在接受后落位** —— 失败保留原选择,用户可直接重试(409 冲突
   *  刷新版本后重提),不做乐观回滚。 */
  const submit = useCallback(async (audioTrackId: string, subtitleTrackId: string | null): Promise<boolean> => {
    if (pendingRef.current || !aliveRef.current) {
      return false; // 单飞门:在途提交忽略新选择
    }
    const currentVersion = versionRef.current;
    if (currentVersion === null) {
      setFailure('播放状态尚未就绪,请稍后再试。');
      return false;
    }
    const submittedSessionId = sessionIdRef.current;
    pendingRef.current = true;
    setPending(true);
    setFailure(null);
    const abort = new AbortController();
    try {
      const dto = await privateFetch<PlaybackDto>(
        `/playback/sessions/${encodeURIComponent(submittedSessionId)}/selection`,
        {
          method: 'PUT',
          signal: abort.signal,
          body: {
            expectedVersion: currentVersion,
            positionSeconds: positionRef.current(),
            audioTrackId,
            subtitleTrackId,
          },
        },
      );
      // 会话已换/已卸载:迟到响应不回写(旧会话结果不得安装到新播放器)
      if (!aliveRef.current || sessionIdRef.current !== submittedSessionId) {
        return false;
      }
      if (dto === null || typeof dto !== 'object' || typeof dto.version !== 'number') {
        setFailure('切换未完成,请稍后重试。');
        return false;
      }
      statusPatchRef.current({ version: dto.version, tracks: dto.tracks });
      if (typeof dto.generation === 'number' && dto.generation !== generationRef.current) {
        // 重建输出音轨:同会话换代 —— 轮询 ready 后以新代 renew 换票(零第二 resolve)
        generationRef.current = dto.generation;
        const deadline = Date.now() + REBUILD_POLL_BUDGET_MS;
        let renewed = false;
        while (Date.now() < deadline) {
          await new Promise((resolve) => {
            setTimeout(resolve, REBUILD_POLL_MS);
          });
          if (!aliveRef.current || sessionIdRef.current !== submittedSessionId) {
            return false;
          }
          let status: PlaybackDto | null = null;
          try {
            status = await privateFetch<PlaybackDto>(
              `/playback/sessions/${encodeURIComponent(submittedSessionId)}`,
              { signal: abort.signal },
            );
          } catch {
            continue; // 单次查询失败不终止轮询(下一拍重试;受预算约束)
          }
          if (!aliveRef.current || sessionIdRef.current !== submittedSessionId) {
            return false;
          }
          if (status.state === 'ready' || status.state === 'playing') {
            const ticket = await privateFetch<{ playbackUrl: string; ticketExpiresAt: string; generation: number }>(
              `/playback/sessions/${encodeURIComponent(submittedSessionId)}/renew`,
              { method: 'POST', signal: abort.signal, body: { expectedGeneration: status.generation } },
            );
            if (!aliveRef.current || sessionIdRef.current !== submittedSessionId) {
              return false;
            }
            generationRef.current = ticket.generation;
            ticketRef.current(ticket.playbackUrl, ticket.ticketExpiresAt, ticket.generation);
            renewed = true;
            break;
          }
          if (status.state === 'failed' || status.state === 'ended' || status.state === 'interrupted') {
            break; // 终态:不再轮询(票据已随旧代失效,经既有终止面收口)
          }
          // preparing:继续下一拍
        }
        if (!renewed && aliveRef.current && sessionIdRef.current === submittedSessionId) {
          setFailure('音轨切换未完成,播放可能即将中断,请重新发起播放。');
          return false;
        }
        return renewed;
      }
      // 纯字幕切换(或同代音轨):version/tracks 已回写,无票面变化 —— 播放零中断
      return true;
    } catch (error) {
      if (!aliveRef.current || sessionIdRef.current !== submittedSessionId) {
        return false;
      }
      if (isFetchApiError(error) && error.status === 409) {
        // CAS 冲突:刷新一次会话事实(版本/轨道同步)后允许手动重试,不自动重发
        try {
          const status = await privateFetch<PlaybackDto>(
            `/playback/sessions/${encodeURIComponent(submittedSessionId)}`,
          );
          if (aliveRef.current && sessionIdRef.current === submittedSessionId && status !== null && typeof status === 'object') {
            statusPatchRef.current({ version: status.version, tracks: status.tracks });
          }
        } catch {
          // 刷新失败:保留失败文案即可
        }
        setFailure('播放状态已变化,请重试。');
        return false;
      }
      setFailure('切换未完成,请稍后重试。');
      return false;
    } finally {
      if (aliveRef.current && sessionIdRef.current === submittedSessionId) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }, []);

  const selectAudio = useCallback(
    (trackId: string): void => {
      if (!canSwitchRef.current) {
        setFailure('播放尚未确认开始,音轨切换暂不可用。');
        return;
      }
      const audio = activeAudioId;
      if (audio === trackId) {
        return; // 同轨重复提交零请求
      }
      const subtitle = activeSubtitleId;
      // 当前轨只在接受后落位(失败保留原选择,可直接重试)
      void submit(trackId, subtitle).then((accepted) => {
        if (accepted && aliveRef.current) {
          setActiveAudioId(trackId);
        }
      });
    },
    [activeAudioId, activeSubtitleId, submit],
  );

  const selectSubtitle = useCallback(
    (trackId: string | null): void => {
      const audio = activeAudioId;
      if (audio === null) {
        setFailure('播放状态尚未就绪,请稍后再试。');
        return;
      }
      if (activeSubtitleId === trackId) {
        return; // 同值重复提交零请求(含关闭)
      }
      void submit(audio, trackId).then((accepted) => {
        if (accepted && aliveRef.current) {
          setActiveSubtitleId(trackId);
        }
      });
    },
    [activeAudioId, activeSubtitleId, submit],
  );

  const toggle = useCallback((): void => {
    setOpen((previous) => !previous);
  }, []);
  const close = useCallback((): void => {
    setOpen(false);
  }, []);

  return {
    open,
    toggle,
    close,
    pending,
    failure,
    tracks,
    activeAudioId,
    activeSubtitleId,
    canSwitchAudio: canSwitchTracks,
    selectAudio,
    selectSubtitle,
    generationRef,
  };
}
