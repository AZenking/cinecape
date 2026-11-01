/**
 * 连播 UI 面(010 T065;ui.md §3/§6 键盘可达面;player-view 挂载):
 *
 * - 倒计时面(data-testid="autoplay-countdown"):展示绑定目标(plan.label)与
 *   剩余秒(数字随 countdownDeadline 走;aria-hidden —— 屏幕阅读器不每秒重复整段
 *   消息,ui.md §3),「立即播放下一集」消费当前计划、「取消连播」终态收口;
 *   requireExplicitConfirm(计划过期/变化重新展示,ui.md §6)不定时不静默推进,
 *   仅显式确认按钮可前进;
 * - 历史询问面(autoplay-history-choice):目标有未完成历史时倒计时暂停
 *   (phase=awaiting_history_choice),「从上次位置继续」→ target_history、
 *   「从头播放」→ beginning —— 选择即 positionMode,不静默覆盖(api.md §5);
 * - 手势面(autoplay-gesture):自动播放策略拒绝(NotAllowedError)呈现,
 *   「点击播放」经注册的引擎 play() 恢复(拒绝期零伪造 started/零 playing 观测
 *   由泵保证);60s 期限只展示不自毁 —— 服务端 readyAt+60s 回收为准(api.md §7 I4);
 * - 键盘:三面按钮均为原生焦点可达(HeroUI Button/React Aria data-focus-visible);
 *   连播活跃期间 Esc=取消连播(终态,零 intent);
 * - 样式:媒体浮层 token(DESIGN.md 010 token 表 + 语义变量派生,无裸值;
 *   遮罩/描边/阴影/圆角与 video-player-skin.css 同源词汇)。
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Button } from '@heroui/react';
import type { Vod } from '@hmp/shared';
import type { VodAutoplayPhase, VodAutoplayPositionMode } from './use-vod-autoplay';

type NextPlanReplyDto = Vod.components['schemas']['NextPlanReply'];

export interface VodAutoplayOverlayProps {
  /** hook 状态机相位(决定倒计时/历史询问面是否呈现) */
  readonly phase: VodAutoplayPhase;
  /** 服务端计划快照(展示绑定目标 label;null=计划未决,不出面) */
  readonly plan: NextPlanReplyDto | null;
  /** 倒计时截止(epoch ms);null=无自动推进(显式确认面不展示秒数) */
  readonly countdownDeadline: number | null;
  /** true=仅显式确认推进(计划过期/变化重新展示,ui.md §6) */
  readonly requireExplicitConfirm: boolean;
  /** 引擎 play() NotAllowedError → awaitingGesture 面(video-player 回报) */
  readonly awaitingGesture: boolean;
  /** 取消连播(终态;Esc 同路) */
  readonly onCancel: () => void;
  /** 立即下一集(消费当前计划;显式确认模式同路) */
  readonly onConfirmImmediate: () => void;
  /** 目标历史询问显式位置选择(选择即 positionMode) */
  readonly onChoosePosition: (mode: VodAutoplayPositionMode) => void;
  /** 手势恢复(调用注册的引擎 play()) */
  readonly onResumeGesture: () => void;
}

/** 媒体浮层面板样式:全部 token 派生(DESIGN.md 010 token 表;无裸色值/任意值类) */
const PANEL_STYLE: CSSProperties = {
  backgroundColor: 'color-mix(in oklab, var(--overlay) 82%, transparent)',
  color: 'var(--foreground)',
  border: '1px solid var(--separator)',
  borderRadius: 'var(--hmp-media-card-radius)',
  boxShadow: 'var(--hmp-media-overlay-shadow)',
  backdropFilter: 'blur(10px)',
};

/** 倒计时剩余秒(随 countdownDeadline 每拍重算;null=无自动推进不展示) */
function useRemainingSeconds(deadline: number | null): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (deadline === null) {
      setRemaining(null);
      return;
    }
    const update = (): void => {
      setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    };
    update();
    const timer = setInterval(update, 250);
    return () => {
      clearInterval(timer);
    };
  }, [deadline]);
  return remaining;
}

/** 目标未完成历史摘要行(询问面展示续播依据;缺省不占位) */
function HistoryLine({ plan }: { plan: NextPlanReplyDto }): ReactNode {
  const history = plan.history;
  if (history === null || history === undefined || history.positionSeconds === undefined) {
    return null;
  }
  const minutes = Math.floor(history.positionSeconds / 60);
  return (
    <p className="text-foreground text-xs">
      {`上次看到 ${minutes} 分钟(共 ${Math.floor((history.durationSeconds ?? 0) / 60)} 分钟)`}
    </p>
  );
}

export function VodAutoplayOverlay({
  phase,
  plan,
  countdownDeadline,
  requireExplicitConfirm,
  awaitingGesture,
  onCancel,
  onConfirmImmediate,
  onChoosePosition,
  onResumeGesture,
}: VodAutoplayOverlayProps): ReactNode {
  const remainingSeconds = useRemainingSeconds(countdownDeadline);

  // 连播活跃期间 Esc=取消连播(ui.md §3 键盘操作面;终态零 intent)
  useEffect(() => {
    if (phase !== 'countdown' && phase !== 'awaiting_history_choice') {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [phase, onCancel]);

  return (
    <>
      {/* 倒计时面:展示绑定目标 + 剩余秒(aria-hidden) + 两条出路;显式确认模式无秒数 */}
      {phase === 'countdown' && plan !== null ? (
        <div
          role="group"
          aria-label="自动连播"
          data-testid="autoplay-countdown"
          className="absolute bottom-40 start-4 z-10 flex max-w-96 flex-col gap-2 p-3 text-sm"
          style={PANEL_STYLE}
        >
          <p className="text-foreground">
            {requireExplicitConfirm ? '下一集计划已更新,确认后播放:' : '接下来自动播放:'}
            <span className="font-medium">{plan.label}</span>
          </p>
          {remainingSeconds !== null ? (
            <p aria-hidden="true" data-testid="autoplay-countdown-seconds" className="text-foreground text-xs tabular-nums">
              {`${remainingSeconds} 秒后自动开始`}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" aria-label="立即播放下一集" onPress={onConfirmImmediate}>
              立即
            </Button>
            <Button size="sm" variant="ghost" aria-label="取消连播" onPress={onCancel}>
              取消
            </Button>
          </div>
        </div>
      ) : null}
      {/* 历史询问面:倒计时暂停,显式选择即 positionMode(不选择零 intent) */}
      {phase === 'awaiting_history_choice' && plan !== null ? (
        <div
          role="group"
          aria-label="连播播放位置确认"
          data-testid="autoplay-history-choice"
          className="absolute bottom-40 start-4 z-10 flex max-w-96 flex-col gap-2 p-3 text-sm"
          style={PANEL_STYLE}
        >
          <p className="text-foreground">
            下一集
            <span className="font-medium">{plan.label}</span>
            已有观看记录,选择从哪里开始:
          </p>
          <HistoryLine plan={plan} />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" onPress={() => onChoosePosition('target_history')}>
              从上次位置继续
            </Button>
            <Button size="sm" variant="ghost" onPress={() => onChoosePosition('beginning')}>
              从头播放
            </Button>
            <Button size="sm" variant="ghost" aria-label="取消连播" onPress={onCancel}>
              取消
            </Button>
          </div>
        </div>
      ) : null}
      {/* 手势面:NotAllowedError → 需要用户手势;只展示不自毁(服务端 60s 回收为准) */}
      {awaitingGesture ? (
        <div
          role="status"
          data-testid="autoplay-gesture"
          className="absolute bottom-56 start-4 z-10 flex max-w-96 flex-col gap-2 p-3 text-sm"
          style={PANEL_STYLE}
        >
          <p className="text-foreground">浏览器已拦截自动播放,请手动开始播放。</p>
          <div>
            <Button size="sm" variant="primary" onPress={onResumeGesture}>
              点击播放
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
