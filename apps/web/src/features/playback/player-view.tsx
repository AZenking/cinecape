/**
 * 播放器视图(T055;005 US3/T104 US4)—— 复用 004 受控网关输出与 video.js(内置 VHS)消费:
 *
 * - 交付分派:`delivery === 'direct'` 为 NAS 文件直读入口(媒体文件本体)→ 原生
 *   `<video src>`;其余(hls_proxy/remux/audio_transcode/video_transcode)入口是同源
 *   HLS 清单 → video.js 内置 VHS 消费(ADR-0009:不新增转码承诺,仅消费受控网关产物);
 * - 安装绑定:本组件只以 props 收到当前 intentId 代次批准的会话面(协调器守卫),
 *   组件随意图面卸载,旧代次结果不可能安装到新播放器;
 * - 续播安装(US4 T101):presentationStartSeconds > 0 时首次安装即定位(direct 置
 *   currentTime;VHS 消费经原影片逻辑时间轴同值定位),不先播放零点再跳转;
 * - 存活保持:15 秒 heartbeat(位置取自媒体元素、暂停意图随拍上报;暂停心跳照发,
 *   004 R5:paused ≠ 失联);授权/会话/上下文失效(401/403/404)→ onTerminated 稳定
 *   提示,由协调器落 unavailable 面 —— 不展示内部策略或源位置;
 * - 进度上报(US4 T104):usePlaybackProgress 挂接 —— 首次实际 playing 上报 started
 *   (ACK 前同 seq/payload 重试、禁用 seek 与重建输出的音轨切换)、10 秒周期 + 暂停
 *   立即、卸载携 finalProgress 停止(未确认时空 stop + 未保存提示);断网保留最后
 *   成功值并提示同步失败;换档/退出废弃在途请求;
 * - 票据续期:到期前 60 秒 renew(004 TicketReply 语义),成功经 onRenew 上报协调器
 *   换装新入口 URL:direct 保存当前位置换 src 后恢复;video.js 换源续装
 *   (媒体元素不动);旧票按原有效期失效、不撤销(004);
 * - URL/票据不写入 localStorage,页面不向第三方发送 referrer(全局 no-referrer)。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isFetchApiError, privateFetch } from '../../shared/fetch';
import { usePlaybackProgress } from './use-playback-progress';
import { VideoPlayer } from './video-player';

/** 心跳节拍(004 lifecycle.heartbeatIntervalSeconds;前端发起) */
const HEARTBEAT_MS = 15_000;
/** 提前续期秒数(004 PLAYBACK_RENEW_LEAD_SECONDS 同值) */
const RENEW_LEAD_SECONDS = 60;

export interface PlayerViewProps {
  readonly sessionId: string;
  readonly generation: number;
  readonly playbackUrl: string;
  readonly ticketExpiresAt: string;
  readonly delivery: string | null;
  /** 服务端冻结的起播位置秒(US4 resume;beginning/无有效进度为 0) */
  readonly presentationStartSeconds?: number;
  /** 服务端拒绝心跳/换票(授权、会话或上下文失效)时的稳定终止回调 */
  readonly onTerminated: (message: string) => void;
  /** 续期成功换装(协调器更新意图面 → 新 URL props 重新安装,位置保持) */
  readonly onRenew: (url: string, expiresAt: string) => void;
}

export function PlayerView({
  sessionId,
  generation,
  playbackUrl,
  ticketExpiresAt,
  delivery,
  presentationStartSeconds = 0,
  onTerminated,
  onRenew,
}: PlayerViewProps): ReactNode {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /** 换装(续期)时待恢复的位置(direct 换 src 后回填;VHS 换源续装回填) */
  const resumeAtRef = useRef<number | null>(null);
  /** 续播安装是否已应用(仅首次安装定位;换装/续期不重复定位) */
  const presentationAppliedRef = useRef(false);
  /** 未保存提示(未确认 started 即停止;进度同步失败提示) */
  const [notice, setNotice] = useState<string | null>(null);

  // 稳定回调面:父层回调以 ref 转发,定时器/安装效果不因父层重渲染重排
  const terminatedRef = useRef(onTerminated);
  terminatedRef.current = onTerminated;
  const renewRef = useRef(onRenew);
  renewRef.current = onRenew;

  // 进度上报队列(US4 T104;started ACK 前禁用 seek 与重建输出的音轨切换)
  const progress = usePlaybackProgress({
    sessionId,
    generation,
    videoRef,
    onUnsavedProgress: () => {
      setNotice('播放进度未保存,本次观看不会进入观看历史。');
    },
    onRejected: (message) => {
      terminatedRef.current(message);
    },
  });

  // 1. 源安装与引擎生命周期由 <VideoPlayer> 承担(video.js 初始化/换源/销毁;
  //    换装(续期)时的位置捕获在 onRenew 回调内完成,回填仍由下方 restore 监听执行)

  // 2. 位置恢复与续播安装(换装完成即回填,不回零;首次安装按服务端冻结位置定位)
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    const restore = (): void => {
      const resumeAt = resumeAtRef.current;
      if (resumeAt !== null && Number.isFinite(resumeAt) && resumeAt > 0) {
        video.currentTime = resumeAt;
      } else if (!presentationAppliedRef.current && Number.isFinite(presentationStartSeconds) && presentationStartSeconds > 0) {
        // 续播安装(T101):服务端冻结位置(direct/VHS 同一影片逻辑时间轴)
        video.currentTime = presentationStartSeconds;
      }
      presentationAppliedRef.current = true;
      resumeAtRef.current = null;
    };
    video.addEventListener('loadedmetadata', restore, { once: true });
    return () => {
      video.removeEventListener('loadedmetadata', restore);
    };
    // presentationStartSeconds 随首次安装面冻结;换装(续期)不重读
  }, [playbackUrl, presentationStartSeconds]);

  // 3. 心跳(15 秒节拍;失效即终止)
  useEffect(() => {
    if (sessionId === '' || ticketExpiresAt === '') {
      return;
    }
    const timer = setInterval(() => {
      const video = videoRef.current;
      void privateFetch<void>(`/playback/sessions/${encodeURIComponent(sessionId)}/heartbeat`, {
        method: 'POST',
        body: {
          positionSeconds: Number.isFinite(video?.currentTime) ? Math.max(0, video?.currentTime ?? 0) : 0,
          paused: video?.paused ?? false,
        },
      }).catch((error: unknown) => {
        if (isFetchApiError(error) && (error.status === 401 || error.status === 403 || error.status === 404)) {
          terminatedRef.current('播放已终止,请重新发起播放。');
        }
        // 网络抖动:下一拍自然重试(失联阈值 45 秒容忍缺拍)
      });
    }, HEARTBEAT_MS);
    return () => {
      clearInterval(timer);
    };
    // 稳定回调经 ref 转发(见下);会话身份变化时本组件随意图面卸载
    // 依赖面刻意收窄:稳定回调经 ref 转发;playbackUrl/generation 变化即换装
  }, [sessionId]);

  // 4. 票据续期(到期前 60 秒;成功经 onRenew 上报协调器换装)
  useEffect(() => {
    if (sessionId === '' || ticketExpiresAt === '') {
      return;
    }
    const expiresAtMs = Date.parse(ticketExpiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return;
    }
    const fireIn = Math.max(expiresAtMs - RENEW_LEAD_SECONDS * 1000 - Date.now(), 0);
    const timer = setTimeout(() => {
      void privateFetch<{ playbackUrl: string; ticketExpiresAt: string; generation: number }>(
        `/playback/sessions/${encodeURIComponent(sessionId)}/renew`,
        { method: 'POST', body: { expectedGeneration: generation } },
      )
        .then((ticket) => {
          resumeAtRef.current = videoRef.current?.currentTime ?? null;
          renewRef.current(ticket.playbackUrl, ticket.ticketExpiresAt);
        })
        .catch((error: unknown) => {
          if (isFetchApiError(error) && (error.status === 401 || error.status === 403 || error.status === 404)) {
            terminatedRef.current('播放授权已失效,请重新发起播放。');
          }
          // 其余失败:旧票在原有效期前仍可交付,不终止播放
        });
    }, fireIn);
    return () => {
      clearTimeout(timer);
    };
    // 稳定回调经 ref 转发(见下)
    // 依赖面刻意收窄:稳定回调经 ref 转发;playbackUrl/generation 变化即换装
  }, [sessionId, generation, ticketExpiresAt]);


  return (
    <div className="relative h-full w-full">
      <VideoPlayer
        videoRef={videoRef}
        src={playbackUrl}
        mimeType={delivery === 'direct' ? null : 'application/x-mpegURL'}
        onFatalError={() => {
          terminatedRef.current('播放流中断,请重新发起播放。');
        }}
      />
      {/* 进度协议状态提示(未保存/同步失败;不遮挡控制条,错误不只靠颜色) */}
      {progress.syncFailed ? (
        <p role="alert" data-testid="progress-sync-failed" className="absolute bottom-16 start-4 rounded bg-black/70 px-2 py-1 text-xs text-white">
          进度同步失败,已保留上次成功保存的位置,网络恢复后自动重试。
        </p>
      ) : null}
      {notice !== null ? (
        <p role="status" data-testid="progress-notice" className="absolute bottom-24 start-4 rounded bg-black/70 px-2 py-1 text-xs text-white">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
