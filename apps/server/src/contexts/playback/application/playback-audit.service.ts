import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { ProblemCode } from '@hmp/shared';
import type { SessionContext } from '../../../common/current-session.decorator';
import { DomainError } from '../../../common/domain-error';
import { mediaItem, playbackFailureEvent, playbackSource, profile, sourceEntry } from '../../../database/schema';
import { getDb } from '@contexts/identity-access/infrastructure/db';

/**
 * 播放审计服务(T043,spec 004,US2b)—— resolve 拒绝写 playback_failure_event:
 *
 * 权威依据(先读后写):
 * - tasks.md T043:接入有效会话解析拒绝 failure_event;不可见标识不落库、不存客户端原 ID,
 *   不复制 ticket/位置/凭据到记录;
 * - data-model.md「## playback_failure_event」:仅有效设备会话可写;媒体不属于该家庭或
 *   不可见则 media_id=null,不存客户端原始目标 ID;不关联所选资源,不产生播放 session;
 * - T042 e2e「给 T043/T044 的实现要点」:仅认证成功的会话;stable_code=该次拒绝公开
 *   problem code(shared ProblemCode,如 MEDIA_NOT_FOUND);profile_id 取拒绝时激活档案
 *   (nullable);401 SESSION_INVALID 不写行;
 * - spec.md SC-004:不可见媒体失败不记录媒体标识;无效会话仅留脱敏安全日志且不写设备记录。
 *
 * 写入路径说明(为何不经 PlaybackRepository.recordFailureEvent):
 * - 仓储 recordFailureEvent 的 stable_code 守卫(isPlaybackStableErrorCode)仅接受
 *   PLAYBACK_* 词表,而本任务的 stable_code 权威是「该次拒绝的公开 problem code」
 *   (MEDIA_NOT_FOUND 等共享码);仓储 API 面被 repository.spec 钉死 21 方法禁止修改,
 *   故本服务经 getDb() 直插(playback-authorization/lifecycle 同款先例)。DDL CHECK 仅
 *   length(stable_code) >= 1,共享码形态合法。
 *
 * 「可见性」口径(与测试夹具语义一致,schema 无可见列):媒体行存在于本家庭
 * (media_item.household_id=会话家庭)且存在 present=1 的 source_entry 回链且挂有
 * playback_source —— 可见;不存在/跨家庭/孤立行(无条目无资源)一律 media_id=null。
 * 注意可见性不折叠策略判定:策略拒绝(黑名单/超龄)的可见媒体保留 media_id
 * (data-model 只排除「不属于该家庭或不可见」)。
 *
 * 接入点(最小侵入):PlaybackController.resolve 的 catch 回调 —— 授权/解析拒绝抛出的
 * DomainError 在此旁路落审计后原样重抛;authorization.service 与 resolver 保持零改动
 * (authorization.spec 37 用例与既有契约行为不受影响)。401 SESSION_INVALID(伪造/过期/
 * 撤销会话)与 400/429(resolve 之前的校验/限频路径)不落行;审计写入尽力而为 ——
 * 任何写入异常吞并,绝不改变客户端可见的拒绝响应。
 *
 * 成功 session 记录无需本服务补写:started_at 由仓储 markPlaying 在首次交付一次性写入、
 * ended_at 由 endSession/failSession/markInterrupted 终态迁移写入(US1/US2 既有路径),
 * 查询面(T044)直接读列即可。
 */

/** 审计写入入参(at 仅测试注入确定时刻用;缺省取当前时刻) */
export interface ResolveRejectionOptions {
  readonly at?: string;
}

@Injectable()
export class PlaybackAuditService {
  /**
   * 记录一次被拒的解析(仅认证成功的会话;401 SESSION_INVALID 不写行):
   * stable_code=拒绝的公开 problem code;profile_id=拒绝时激活档案(可确定时);
   * media_id 仅当请求媒体本家庭可见才落,否则 NULL(不存客户端原始目标 ID);
   * 不关联所选资源,不产生播放 session。审计尽力而为:写入异常吞并不重抛。
   */
  recordResolveRejection(context: SessionContext, requestedMediaId: string, error: unknown, options: ResolveRejectionOptions = {}): void {
    try {
      if (!(error instanceof DomainError)) {
        return; // 非领域错误(编程性异常)不属「解析拒绝」,不落审计
      }
      if (error.status === 401 || error.code === ProblemCode.SESSION_INVALID) {
        return; // 无效会话(伪造/过期/撤销):仅脱敏安全日志语义,不写设备记录
      }
      const householdId = context.session.householdId;
      getDb()
        .insert(playbackFailureEvent)
        .values({
          id: randomUUID(),
          householdId,
          deviceSessionId: context.session.id,
          deviceId: context.session.deviceId,
          profileId: this.resolvableProfileIdOrNull(householdId, context.session.activeProfileId),
          mediaId: this.visibleMediaIdOrNull(householdId, requestedMediaId),
          occurredAt: options.at ?? new Date().toISOString(),
          stableCode: error.code,
        })
        .run();
    } catch {
      // 审计尽力而为:FK 竞态/约束等任何写入异常不得改变客户端可见的拒绝响应
    }
  }

  /**
   * 拒绝时可确定的档案 ID:激活档案存在且归属会话家庭才落(复合 FK
   * (household_id,profile_id) → profile(household_id,id) 必须可满足);行已删除/
   * 跨家庭(防御)→ null。nullable 语义按 data-model(profile_id 可空)。
   */
  private resolvableProfileIdOrNull(householdId: string, activeProfileId: string | null): string | null {
    if (activeProfileId === null) {
      return null;
    }
    const row = getDb()
      .select({ id: profile.id })
      .from(profile)
      .where(and(eq(profile.householdId, householdId), eq(profile.id, activeProfileId)))
      .get();
    return row === undefined ? null : activeProfileId;
  }

  /**
   * 请求媒体的本家庭可见性(派生事实,夹具同口径):媒体行在本家庭 + present=1 条目
   * 回链 + 挂 playback_source。不满足任一(不存在/跨家庭/不可见孤立行)→ null,
   * 客户端原始目标 ID 不落库(不外泄不可见媒体标识,spec SC-004)。
   */
  private visibleMediaIdOrNull(householdId: string, requestedMediaId: string): string | null {
    const media = getDb()
      .select({ id: mediaItem.id })
      .from(mediaItem)
      .where(and(eq(mediaItem.householdId, householdId), eq(mediaItem.id, requestedMediaId)))
      .get();
    if (media === undefined) {
      return null;
    }
    const entry = getDb()
      .select({ id: sourceEntry.id })
      .from(sourceEntry)
      .where(
        and(
          eq(sourceEntry.householdId, householdId),
          eq(sourceEntry.mediaId, requestedMediaId),
          eq(sourceEntry.present, 1),
        ),
      )
      .get();
    if (entry === undefined) {
      return null;
    }
    const source = getDb()
      .select({ id: playbackSource.id })
      .from(playbackSource)
      .where(and(eq(playbackSource.householdId, householdId), eq(playbackSource.mediaItemId, requestedMediaId)))
      .get();
    return source === undefined ? null : requestedMediaId;
  }
}
