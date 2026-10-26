/**
 * 播放器视图(T055;005 US3)—— 复用 004 受控网关输出与 hls.js 消费:
 *
 * - 交付分派:`delivery === 'direct'` 为 NAS 文件直读入口(媒体文件本体)→ 原生
 *   `<video src>`;其余(hls_proxy/remux/audio_transcode/video_transcode)入口是同源
 *   HLS 清单 → hls.js 消费(ADR-0009:不新增转码承诺,仅消费受控网关产物);
 * - 安装绑定:本组件只以 props 收到当前 intentId 代次批准的会话面(协调器守卫),
 *   组件随意图面卸载,旧代次结果不可能安装到新播放器;
 * - 存活保持:15 秒 heartbeat(位置取自媒体元素、暂停意图随拍上报;暂停心跳照发,
 *   004 R5:paused ≠ 失联);授权/会话/上下文失效(401/403/404)→ onTerminated 稳定
 *   提示,由协调器落 unavailable 面 —— 不展示内部策略或源位置;
 * - 票据续期:到期前 60 秒 renew(004 TicketReply 语义),成功经 onRenew 上报协调器
 *   换装新入口 URL:direct 保存当前位置换 src 后恢复;hls.js loadSource 续装
 *   (媒体元素不动);旧票按原有效期失效、不撤销(004);
 * - 退出清理:卸载即销毁 hls 实例、清空全部定时器(final 进度保存与 started 确认
 *   协议归 US4;stop 由协调器在关闭路径统一补发);
 * - URL/票据不写入 localStorage,页面不向第三方发送 referrer(全局 no-referrer)。
 */
import { useEffect, useRef, type ReactNode } from 'react';
import Hls from 'hls.js';
import { isFetchApiError, privateFetch } from '../../shared/fetch';

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
  onTerminated,
  onRenew,
}: PlayerViewProps): ReactNode {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /** 换装(续期)时待恢复的位置(direct 换 src 后回填;hls.js 续装回填) */
  const resumeAtRef = useRef<number | null>(null);

  // 稳定回调面:父层回调以 ref 转发,定时器/安装效果不因父层重渲染重排
  const terminatedRef = useRef(onTerminated);
  terminatedRef.current = onTerminated;
  const renewRef = useRef(onRenew);
  renewRef.current = onRenew;

  // 1. 源安装(随 playbackUrl/generation 变化换装;位置保持)
  useEffect(() => {
    const video = videoRef.current;
    if (video === null || playbackUrl === '') {
      return;
    }
    let destroyed = false;
    let hls: Hls | null = null;
    resumeAtRef.current = video.currentTime > 0 ? video.currentTime : null;
    if (delivery !== 'direct' && Hls.isSupported()) {
      hls = new Hls({ enableWorker: false });
      hls.loadSource(playbackUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!destroyed && data.fatal) {
          terminatedRef.current('播放流中断,请重新发起播放。');
        }
      });
    } else {
      // direct 或环境不支持 MSE:入口即媒体文件本体,原生消费
      video.src = playbackUrl;
      video.load();
      // 自动播放被策略拒绝时保持用户手势可控;环境无媒体实现(jsdom)时静默跳过
      const playPromise = typeof video.play === 'function' ? video.play() : undefined;
      if (playPromise !== undefined && typeof playPromise.catch === 'function') {
        playPromise.catch(() => undefined);
      }
    }
    return () => {
      destroyed = true;
      if (hls !== null) {
        hls.destroy();
      }
      video.removeAttribute('src');
      video.load();
    };
    // 稳定回调经 ref 转发;playbackUrl/generation 变化即换装
    // 依赖面刻意收窄:稳定回调经 ref 转发;playbackUrl/generation 变化即换装
  }, [playbackUrl, generation, delivery]);

  // 2. 位置恢复(换装完成即回填,不回零)
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    const restore = (): void => {
      const resumeAt = resumeAtRef.current;
      if (resumeAt !== null && Number.isFinite(resumeAt) && resumeAt > 0) {
        video.currentTime = resumeAt;
      }
      resumeAtRef.current = null;
    };
    video.addEventListener('loadedmetadata', restore, { once: true });
    return () => {
      video.removeEventListener('loadedmetadata', restore);
    };
  }, [playbackUrl]);

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
    <video
      ref={videoRef}
      data-testid="playback-video"
      className="h-full w-full bg-black"
      controls
      playsInline
      preload="auto"
      aria-label="播放器"
    />
  );
}
