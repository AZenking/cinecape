/**
 * 换源抽屉 UI 面(010 T074;ui.md §4/§6、api.md §1/§5;player-view 挂载 —— 播放器内
 * 抽屉,「不退出播放器重搜」):
 *
 * - 入口(播放面内「换源」按钮)由 player-view 承担;本组件承担抽屉内容:
 *   候选列表(data-testid="vod-switch-candidates" 容器/行 "vod-switch-candidate",
 *   行含 title 与 sourceLabel;匹配徽标 "vod-switch-confidence" 文本为枚举值;
 *   测速延迟 "vod-switch-latency" 为首响应延迟 ms,timeout 行显示「超时」不可达态,
 *   不标带宽/画质)、版本警告("vod-switch-version-warning",ambiguous/conflict)、
 *   位置三选一(「接当前播放位置」carry/「继续目标记录」target_history/「从头播放」
 *   beginning)、「取消换源」;
 * - checkpoint 纪律(api.md §5/ui.md §6):pause 非接受或 409 SOURCE_PROGRESS_PENDING
 *   → 显式确认面:展示已确认游标,仅「使用已确认位置」按钮以新 key+该游标+
 *   allowEarlierAcceptedPosition=true 提交,同面保留从头出路,不静默换游标重试;
 * - 失败恢复(ui.md §4):停源前失败(候选/暂停/物化)可恢复 —— 源播放保持,展示
 *   可恢复错误与「重新选择」出路(选择按钮禁用,避免对过期候选重发);停源后失败
 *   (resolve)不复活旧源 —— 展示「重试」(重新消费,显式)或取消换源;
 * - 样式:媒体浮层 token(DESIGN.md 010 token 表 + 语义变量派生,无裸值;与
 *   vod-autoplay-overlay 同源词汇),HeroUI v3 Button/React Aria 键盘可达。
 */
import type { CSSProperties, ReactNode } from 'react';
import { Button } from '@heroui/react';
import type { Vod } from '@hmp/shared';
import type { VodTransitionApi, VodTransitionState } from './use-vod-transition';

type SwitchCandidateDto = Vod.components['schemas']['SwitchCandidate'];
type ProbeResultDto = Vod.components['schemas']['ProbeResult'];

export interface VodSourceSwitcherProps {
  /** use-vod-transition 状态机 API(状态面+动作回调) */
  readonly transition: VodTransitionApi;
}

/** 媒体浮层面板样式:全部 token 派生(DESIGN.md 010 token 表;与 autoplay 浮层同源) */
const PANEL_STYLE: CSSProperties = {
  backgroundColor: 'color-mix(in oklab, var(--overlay) 88%, transparent)',
  color: 'var(--foreground)',
  border: '1px solid var(--separator)',
  borderRadius: 'var(--hmp-media-card-radius)',
  boxShadow: 'var(--hmp-media-overlay-shadow)',
  backdropFilter: 'blur(10px)',
};

/** 测速不可达态稳定文案(api.md §1 ProbeResult;不标带宽/画质) */
const PROBE_STATUS_TEXT: Record<Exclude<ProbeResultDto['status'], 'reachable'>, string> = {
  timeout: '超时',
  incompatible: '不兼容',
  unavailable: '不可达',
};

/** 匹配徽标语义色(状态同时有文字,不只靠颜色) */
function confidenceClassName(matchConfidence: SwitchCandidateDto['matchConfidence']): string {
  if (matchConfidence === 'conflict') {
    return 'text-danger';
  }
  if (matchConfidence === 'ambiguous') {
    return 'text-warning';
  }
  return 'text-success';
}

/** 候选行(行可点即选择;只元数据 —— 无源内部 ID/地址,FR-029) */
function CandidateRow({
  candidate,
  probe,
  pickable,
  selected,
  onPick,
}: {
  candidate: SwitchCandidateDto;
  probe: ProbeResultDto | null;
  pickable: boolean;
  selected: boolean;
  onPick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      data-testid="vod-switch-candidate"
      onClick={onPick}
      disabled={!pickable}
      aria-pressed={selected}
      className="flex w-full flex-col gap-0.5 rounded-md border border-transparent px-2 py-1.5 text-start hover:border-separator focus-visible:outline-2 focus-visible:outline-offset-1 aria-pressed:border-separator"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="truncate text-foreground">{candidate.title}</span>
        <span data-testid="vod-switch-confidence" className={`text-xs ${confidenceClassName(candidate.matchConfidence)}`}>
          {candidate.matchConfidence}
        </span>
      </span>
      <span className="flex items-center justify-between gap-2 text-xs text-foreground">
        <span className="truncate">
          {`${candidate.label} · ${candidate.sourceLabel} · ${candidate.lineLabel}`}
        </span>
        {probe !== null && probe.status === 'reachable' && typeof probe.latencyMs === 'number' ? (
          <span data-testid="vod-switch-latency" className="shrink-0 tabular-nums">{`${probe.latencyMs} ms`}</span>
        ) : null}
        {probe !== null && probe.status !== 'reachable' ? (
          <span className="shrink-0">{PROBE_STATUS_TEXT[probe.status]}</span>
        ) : null}
      </span>
    </button>
  );
}

/** 已确认游标展示秒数(展示格式不钉,精确游标以 intent 载荷为准) */
function cursorSeconds(positionSeconds: number | null): string {
  if (positionSeconds === null || !Number.isFinite(positionSeconds)) {
    return '未知';
  }
  return `${Math.floor(positionSeconds)} 秒`;
}

export function VodSourceSwitcher({ transition }: VodSourceSwitcherProps): ReactNode {
  const state: VodTransitionState = transition.state;
  const selection = state.selection;
  const target = state.target;
  const choice = state.choice;
  const failure = state.failure;
  const selectedConfidence = selection?.candidate.matchConfidence ?? null;
  const conflict = selectedConfidence === 'conflict';
  /** 显式确认面:非接受 checkpoint(含 409 后重新展示)—— carry 仅可经确认按钮提交 */
  const explicitConfirm = choice !== null && choice.requiresExplicitConfirm;
  /**
   * 位置三选一面(ui.md §4 出现时机不钉):选中候选即呈现(carry/从头元数据即时可得,
   * 「继续目标记录」待目标历史查询落定)—— 串行流就绪前的位置点击由 hook 记为预选,
   * 就绪时按 checkpoint 纪律一次性决议;intent 失败重试同样经本面。选择提交后的串行
   * 相位(creatingIntent/stoppingSource/resolvingTarget)面保持呈现(B2「同面提供从头
   * 出路」;重复点击由 hook 相位守卫拒收),done 收口后隐藏。
   */
  const showChoiceFace =
    selection !== null &&
    (state.phase === 'pausing' ||
      state.phase === 'flushing' ||
      state.phase === 'materializing' ||
      state.phase === 'selecting' ||
      state.phase === 'creatingIntent' ||
      state.phase === 'stoppingSource' ||
      state.phase === 'resolvingTarget' ||
      failure?.kind === 'intent' ||
      failure?.kind === 'materialize');
  /** 物化失败骨架:选择面保留但全部禁用(过期候选不重发),出路=重新选择 */
  const showMaterializeFailure = state.phase === 'failed' && failure?.kind === 'materialize';
  /** 停后消费失败:重试(重新 resolve)或取消换源,不复活旧源 */
  const showResolveFailure = state.phase === 'failed' && failure?.kind === 'resolve';
  /** 候选可点:selecting 常规选择;creatingIntent 为不同 ui 操作号仲裁窗口(T075 D2 ——
   *  意图在途等待时允许换目标开新操作,旧流后到响应由 hook 输家追查显式 cancel) */
  const pickable = state.phase === 'selecting' || state.phase === 'creatingIntent';
  const streamBusy =
    state.phase === 'pausing' ||
    state.phase === 'flushing' ||
    state.phase === 'materializing' ||
    state.phase === 'creatingIntent' ||
    state.phase === 'stoppingSource' ||
    state.phase === 'resolvingTarget';

  return (
    <div
      role="group"
      aria-label="换源"
      style={PANEL_STYLE}
      className="absolute bottom-16 end-3 z-10 flex max-h-[80%] w-80 flex-col gap-2 overflow-auto p-3 text-sm"
    >
      <p className="font-medium text-foreground">换源到其他线路/来源</p>

      {/* 候选列表(容器先行呈现;加载/失败状态在其内表达) */}
      <div data-testid="vod-switch-candidates" className="flex flex-col gap-1">
        {state.candidates === null && state.candidatesLoading ? (
          <p role="status" className="text-xs text-foreground">正在获取候选…</p>
        ) : null}
        {state.candidates !== null
          ? state.candidates.map((candidate) => (
              <CandidateRow
                key={candidate.candidateRef}
                candidate={candidate}
                probe={state.probes[candidate.candidateRef] ?? null}
                pickable={pickable}
                selected={selection?.candidate.candidateRef === candidate.candidateRef}
                onPick={() => transition.selectCandidate(candidate)}
              />
            ))
          : null}
      </div>

      {/* 候选获取失败(停前可恢复):重试出路 */}
      {failure?.kind === 'candidates' ? (
        <div className="flex items-center justify-between gap-2">
          <p role="alert" className="text-xs text-danger">{failure.message}</p>
          <Button size="sm" variant="ghost" onPress={transition.reselect}>
            重试
          </Button>
        </div>
      ) : null}

      {/* 串行流进度(相位即状态;同时有文字) */}
      {streamBusy ? (
        <p role="status" data-testid="vod-switch-progress" className="text-xs text-foreground">
          {state.phase === 'pausing' || state.phase === 'flushing'
            ? '正在暂停并保存当前进度…'
            : state.phase === 'materializing'
              ? '正在准备目标内容…'
              : state.phase === 'creatingIntent'
                ? '正在建立切换意图…'
                : state.phase === 'stoppingSource'
                  ? `正在停止原播放${state.sourceTerminated === true ? '(已确认停止)' : ''}…`
                  : '正在准备新播放…'}
        </p>
      ) : null}

      {/* 版本警告(ambiguous/conflict 选中;词面含「版本」,api.md §5/ui.md §4) */}
      {showChoiceFace && selection !== null && (selectedConfidence === 'ambiguous' || selectedConfidence === 'conflict') ? (
        <p role="alert" data-testid="vod-switch-version-warning" className="text-xs text-warning">
          {`版本信息需确认:${
            selection.candidate.matchReasons.length > 0
              ? selection.candidate.matchReasons.join(';')
              : '该候选与当前内容的版本可能不一致'
          }${selectedConfidence === 'conflict' ? ';该候选不能继承当前播放位置' : ',确认后才能继续'}`}
        </p>
      ) : null}

      {/* 暂停非接受/409 后显式确认面:展示已确认游标,不静默提交(B2/B2b) */}
      {explicitConfirm && choice !== null && !showMaterializeFailure ? (
        <p role="status" className="text-xs text-foreground">
          {`暂停保存未获服务端确认,当前已确认位置为 ${cursorSeconds(choice.cursorPositionSeconds)}(游标 seq ${choice.cursorSampleSeq})。可选择使用该已确认位置,或从头播放。`}
        </p>
      ) : null}

      {/* 位置三选一(ui.md §4 出现时机不钉;目标有历史才出现「继续目标记录」;
          物化失败时按钮全禁用 —— 过期候选不重发,出路见下方「重新选择」) */}
      {showChoiceFace && selection !== null ? (
        <div className="flex flex-col gap-1.5">
          {explicitConfirm && choice !== null ? (
            <Button size="sm" variant="primary" onPress={transition.confirmEarlierPosition}>
              {`使用已确认位置(${cursorSeconds(choice.cursorPositionSeconds)})`}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              isDisabled={conflict || showMaterializeFailure}
              onPress={() => transition.choosePosition('carry')}
            >
              接当前播放位置
            </Button>
          )}
          {target?.hasTargetHistory ? (
            <Button
              size="sm"
              variant="ghost"
              isDisabled={showMaterializeFailure}
              onPress={() => transition.choosePosition('target_history')}
            >
              继续目标记录
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            isDisabled={showMaterializeFailure}
            onPress={() => transition.choosePosition('beginning')}
          >
            从头播放
          </Button>
        </div>
      ) : null}

      {/* 停源前失败提示(物化等;源播放保持,零 stop/零 resolve) */}
      {failure !== null && (failure.kind === 'materialize' || failure.kind === 'pause' || failure.kind === 'intent') ? (
        <p role="alert" data-testid="vod-switch-failure" className="text-xs text-danger">
          {failure.message}
        </p>
      ) : null}
      {showMaterializeFailure ? (
        <div>
          <Button size="sm" variant="ghost" onPress={transition.reselect}>
            重新选择
          </Button>
        </div>
      ) : null}

      {/* 停后消费失败(终态):重试=重新消费(显式);不复活旧播放(C4) */}
      {showResolveFailure ? (
        <div className="flex items-center gap-2">
          <p role="alert" data-testid="vod-switch-failure" className="text-xs text-danger">
            {failure?.message ?? '切换播放失败,可重试或重新播放。'}
          </p>
          <Button size="sm" variant="ghost" onPress={transition.retryResolve}>
            重试
          </Button>
        </div>
      ) : null}
      {state.phase === 'failed' && failure?.kind === 'stop' ? (
        <p role="alert" data-testid="vod-switch-failure" className="text-xs text-danger">
          {failure.message}
        </p>
      ) : null}

      {/* 切换完成(status;后继会话接管为 T075 协调器接缝) */}
      {state.phase === 'done' ? (
        <p role="status" data-testid="vod-switch-done" className="text-xs text-success">
          已切换,正在准备新播放。
        </p>
      ) : null}

      <div className="flex justify-end">
        <Button size="sm" variant="ghost" aria-label="取消换源" onPress={transition.closeDrawer}>
          取消换源
        </Button>
      </div>
    </div>
  );
}
