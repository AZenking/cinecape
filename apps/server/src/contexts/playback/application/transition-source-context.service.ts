/**
 * 过渡来源只读上下文授权服务(010-online-vod T059,US3;application 层纯类,单测直构)。
 *
 * 职责(T059 tasks.md 原文):同上下文终态只读来源授权 —— 原设备/Profile/context 校验
 * → 来源 session 只读事实;禁止复用活动控制授权重发旧源票/不复活控制授权。
 * data-model §7 口径:「来源停止后按专用只读上下文授权 next」。
 *
 * 权威契约(contracts/playback-state.md §5 逐字,实现侧不自创语义):
 * - 「终态来源不能沿用后续会拒绝终态的活动控制管线;现有 authorizeControl 本身负责
 *   身份/策略,并非活动态判断。新增 SourceTransitionContextPort 只读历史绑定/receipt/
 *   ledger 并验证当前身份、当前源及策略;绝不重新发源票。创建与消费均检查;
 *   A→B→A 的 contextVersion 不等即 404」;
 * - internal-ports.md §1 PlaybackTransitionSourcePort:「终态也可读合法来源上下文;
 *   不会重新授权旧源媒体交付」;
 * - data-model.md §7 消费事务首步:「来源只读上下文授权+目标最新策略/版本+偏好 →
 *   intent/slot CAS → …」(本服务即首步的持久授权面;策略/偏好判定归 T060/T061)。
 *
 * 授权语义(本服务输出的全部能力):
 * - 只读:返回来源会话上下文/历史输入绑定/finish receipt/ledger 接受游标的**事实投影**,
 *   供 next/manual_next 创建(next 需 receipt.autoNextEligible)与消费(终态校验)判定;
 * - 终态可读:来源 ended/failed 仍可读合法上下文(活动态/终态资格判定是调用方逻辑,
 *   本服务不拒绝终态来源 —— 「manual_next 允许 started 活动/正常 ended;next 来自 finish」);
 * - 零票据:返回类型不含任何票面/token/私有入口/交付材料,无签发路径 —— 「绝不重新发
 *   源票」「不复活控制授权」由类型面钉死(本文件不 import 票据/交付服务,输出无凭证字段);
 * - 同形 404:会话不存在/跨家庭/跨设备/跨 Profile/context 不等(A→B→A)一律同一
 *   DomainError(404 PLAYBACK_NOT_FOUND),不可借错误判别存在性。
 *
 * 消费方:T060 playback-transition.service(创建/取消路径)、T061 resolver 过渡分支
 * (消费事务首步);装配于 playback.module.ts(工厂 provider,注入过渡持久端口)。
 */
import { ProblemCode } from '@hmp/shared';
import { DomainError } from '@platform/http-common/domain-error';
import type {
  FinishReceiptRow,
  PlaybackTransitionStore,
  SourceBindingRow,
  SourceLedgerCheckpointRow,
} from '@contexts/playback/application/playback-transition-store.port';

/** 授权请求面:调用方当前身份(服务端推导,绝不取自请求体)+ 来源会话引用 */
export interface TransitionSourceContextRequest {
  readonly householdId: string;
  /** 当前设备会话(请求身份;必须与来源会话同设备) */
  readonly deviceSessionId: string;
  /** 当前 Profile(必须与来源会话同 Profile) */
  readonly profileId: string;
  /** 当前身份上下文版本(A→B→A 不等即 404;playback-state §5) */
  readonly profileContextVersion: number;
  /** 来源播放会话 id */
  readonly fromSessionId: string;
}

/**
 * 只读来源上下文事实(授权成功产物):全部为判定输入,不含任何票据/交付/私有地址材料。
 * 授权不等于放行播放 —— 活动态资格(next 需终态+receipt;manual_next 先停再消费)、
 * 目标策略与偏好由调用方在创建/消费时另行重验(「创建与消费均检查」)。
 */
export interface ReadonlyTransitionSourceContext {
  readonly fromSessionId: string;
  readonly generation: number;
  readonly state: string;
  readonly mediaId: string;
  readonly endedAt: string | null;
  /** 历史输入绑定(来源代的合法上下文事实;未起播/未绑定为 undefined) */
  readonly inputBinding: SourceBindingRow | undefined;
  /** finish 回执(next 资格判定的唯一来源;无回执=auto next 不具备资格) */
  readonly finishReceipt: FinishReceiptRow | undefined;
  /** ledger 接受游标(carry 精确 checkpoint 基准;US4 消费,本面只读) */
  readonly ledgerCheckpoint: SourceLedgerCheckpointRow | undefined;
}

export class TransitionSourceContextService {
  constructor(private readonly store: PlaybackTransitionStore) {}

  /**
   * 同上下文只读来源授权:校验来源会话归属(家庭/设备/Profile/context 全等)后返回
   * 来源只读事实。任一失配(含不存在)一律 404 同形 —— 「A→B→A 的 contextVersion
   * 不等即 404」,不可借错误判别存在性。
   *
   * ⚠️ 本方法不签发任何票据/授权凭证:返回值即全部能力(只读事实);调用方不得将其
   * 作为控制授权/交付授权使用(活动控制管线 authorizeControl 与本面互不复用 ——
   * 「禁止复用活动控制授权重发旧源票」)。
   */
  authorizeReadonlySourceContext(request: TransitionSourceContextRequest): ReadonlyTransitionSourceContext {
    const session = this.store.findSourceSessionContext(request.householdId, request.fromSessionId);
    // 同形 404:不存在/跨设备/跨 Profile/context 不等共用同一形态(身份失配不得判别存在性)
    if (
      session === undefined ||
      session.deviceSessionId !== request.deviceSessionId ||
      session.profileId !== request.profileId ||
      session.profileContextVersion !== request.profileContextVersion
    ) {
      throw new DomainError(404, ProblemCode.PLAYBACK_NOT_FOUND, '播放会话不存在');
    }
    return {
      fromSessionId: session.id,
      generation: session.generation,
      state: session.state,
      mediaId: session.mediaId,
      endedAt: session.endedAt,
      inputBinding: this.store.findSourceActiveBinding(
        request.householdId,
        request.fromSessionId,
        session.generation,
      ),
      finishReceipt: this.store.findFinishReceiptBySession(request.householdId, request.fromSessionId),
      ledgerCheckpoint: this.store.findSourceLedgerCheckpoint(request.householdId, request.fromSessionId),
    };
  }
}
