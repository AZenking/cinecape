import { createHash } from 'node:crypto';
import { createDomainError } from '@platform/http-common/domain-error';
import { readResumeFreezePosition } from '@contexts/personal-data/application/history.service';
import { personalDataStore } from '@contexts/personal-data/application/personal-data-store.port';
import type { IProgressClockService } from '@contexts/personal-data/application/ports';

/**
 * 点播写入权时钟与 resolve 绑定(T099,005 data-model.md §5/§6、api.md §5 resolve):
 *
 * - profile_progress_clock(household,profile,next_epoch ≥1):每次点播 resolve 接受时
 *   在短事务分配一个 epoch 并递增;直播不分配;可跳号,不可重置,不接受客户端指定
 *   (epoch 只由服务端分配,任何输入面都没有 epoch 字段);
 * - playback_progress_state:resolve 只建状态(candidate_epoch/content_revision/
 *   profile_context_version),不写可见历史 —— 历史仅首次有效 started 后产生;
 * - 状态机与样本写入规则见 progress-write.service.ts;本文件只承担「分配 + 绑定」
 *   与 playbook 侧共享的只读判定。
 *
 * 008-repository-extraction(T005):数据访问经 PersonalDataStore 端口(ADR-0015 D1,
 * 查询逐字迁移至 infrastructure/personal-data-store.drizzle.ts;epoch 短事务经
 * withTransaction 端口原样保留「分配 + 绑定」原子性)。
 */

/** 规范化载荷摘要(同 seq 同载荷重试幂等、异载荷 409 的判定基准) */
export function progressSampleDigest(input: {
  readonly expectedGeneration: number;
  readonly positionSeconds: number;
  readonly reason: string;
}): string {
  // 规范化:number 以可逆十进制文本编码(规避 -0/科学计数法差异),键序固定
  const payload = JSON.stringify({
    g: input.expectedGeneration,
    p: Object.is(input.positionSeconds, -0) ? '-0' : String(input.positionSeconds),
    r: input.reason,
  });
  return createHash('sha256').update(`hmp-progress\u0000${payload}`, 'utf8').digest('hex');
}

/** 上次样本结果(playback_progress_state.last_result 编码形态) */
export interface StoredSampleResult {
  readonly applied: boolean;
  readonly reason: 'accepted' | 'duplicate' | 'stale_sample' | 'superseded';
  readonly historyRevision: number | null;
}

export function encodeStoredResult(result: StoredSampleResult): string {
  return JSON.stringify(result);
}

export function decodeStoredResult(raw: string): StoredSampleResult | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && 'applied' in parsed && 'reason' in parsed) {
      const candidate = parsed as Partial<StoredSampleResult>;
      if (
        typeof candidate.applied === 'boolean' &&
        typeof candidate.reason === 'string' &&
        ['accepted', 'duplicate', 'stale_sample', 'superseded'].includes(candidate.reason) &&
        (candidate.historyRevision === null || typeof candidate.historyRevision === 'number')
      ) {
        return {
          applied: candidate.applied,
          reason: candidate.reason as StoredSampleResult['reason'],
          historyRevision: candidate.historyRevision,
        };
      }
    }
  } catch {
    // 损坏行按无缓存结果处理(重新走完整写入路径)
  }
  return null;
}

/**
 * resolve 绑定端口(PlaybackResolverService 经构造注入调用;T099):
 * 点播 resolve 接受时在短事务分配 epoch 并创建 progress_state(不写历史)。
 * 直播(channel)不调用本端口。
 */
export interface PlaybackProgressBindPort {
  bindVodResolveCandidate(input: {
    readonly householdId: string;
    readonly profileId: string;
    readonly mediaId: string;
    readonly playbackSessionId: string;
    readonly profileContextVersion: number;
  }): void;
}

/** 续播冻结读取端口(resolver 在可信 probe 后调用;实现见 history.service) */
export interface PlaybackResumePositionPort {
  readResumeFreeze(input: {
    readonly householdId: string;
    readonly profileId: string;
    readonly mediaId: string;
    readonly probeDurationSeconds: number | null;
  }): number;
}

/** 信任时长端口(ProgressWriteService 使用:probe 事实 → 历史 fallback 由本注册表收口) */
export interface PersonalPlaybackFactsPort {
  trustedDurationSeconds(sessionId: string, generation: number): number | null;
}

/** 装配注册表(PlaybackModule 工厂注入 resolver 桥;PersonalModule 只读,避免模块环) */
const personalFactsRegistry: { port: PersonalPlaybackFactsPort | null } = { port: null };

/** PlaybackModule 装配时注册(生产仅一次;测试可重注册/置 null) */
export function registerPersonalPlaybackFactsPort(port: PersonalPlaybackFactsPort | null): void {
  personalFactsRegistry.port = port;
}

/** probe 事实优先、历史可信时长兜底的统一时长读取 */
export function personalTrustedDurationSeconds(sessionId: string, generation: number): number | null {
  return personalFactsRegistry.port?.trustedDurationSeconds(sessionId, generation) ?? null;
}

/** ProgressClockService:epoch 短事务分配 + resolve 状态绑定(PlaybackModule/单测共用) */
export class ProgressClockService implements PlaybackProgressBindPort, PlaybackResumePositionPort, IProgressClockService {
  /**
   * 点播 resolve 绑定(短事务,原子):
   * 1) profile_progress_clock 行不存在则建(next_epoch=2,分配 1);存在则
   *    分配 = next_epoch 且 next_epoch+1(可跳号不可重置:任何失败回滚都不回退);
   * 2) 写 playback_progress_state(candidate_epoch/content_revision/profile_context_version,
   *    started=false,last_sample_seq=0,last_generation=resolve 代);
   * 3) 绝不写 profile_viewing_history(resolve 只接受,未起播不算观看)。
   */
  bindVodResolveCandidate(input: {
    readonly householdId: string;
    readonly profileId: string;
    readonly mediaId: string;
    readonly playbackSessionId: string;
    readonly profileContextVersion: number;
  }): void {
    personalDataStore().withTransaction((tx) => {
      // 媒体修订(同家庭权威事实;授权已放行,行必在 —— 防御分支仍 fail-closed)
      const mediaRevision = tx.findMediaContentRevision(input.householdId, input.mediaId);
      if (mediaRevision === undefined) {
        throw createDomainError('MEDIA_NOT_FOUND');
      }
      // epoch 短分配(同一事务,保证「分配 + 绑定」原子;clock 行随 Profile 长期存在)
      const nextEpoch = tx.findProgressClockNextEpoch(input.householdId, input.profileId);
      let allocated: number;
      if (nextEpoch === undefined) {
        allocated = 1;
        tx.insertProgressClockRow(input.householdId, input.profileId, allocated + 1);
      } else {
        allocated = nextEpoch;
        tx.bumpProgressClockNextEpoch(input.householdId, input.profileId);
      }
      // 会话代次(resolve 时刻 generation=1;防御读取,行缺失按绑定失败回滚)
      const generation = tx.findSessionGeneration(input.householdId, input.playbackSessionId);
      if (generation === undefined) {
        throw createDomainError('PLAYBACK_NOT_FOUND');
      }
      tx.insertProgressStateRow({
        householdId: input.householdId,
        playbackSessionId: input.playbackSessionId,
        profileId: input.profileId,
        mediaId: input.mediaId,
        candidateEpoch: allocated,
        contentRevision: mediaRevision,
        profileContextVersion: input.profileContextVersion,
        started: 0,
        lastSampleSeq: 0,
        lastSampleDigest: null,
        lastGeneration: generation,
        lastResult: null,
      });
    });
  }

  /** 续播冻结读取(委托 history.service 的唯一实现;端口对 resolver 暴露) */
  readResumeFreeze(input: {
    readonly householdId: string;
    readonly profileId: string;
    readonly mediaId: string;
    readonly probeDurationSeconds: number | null;
  }): number {
    // 延迟 require 造成的循环风险不存在(history.service 不 import 本文件);
    // 静态导入直接委托,冻结规则单一实现点。
    return readResumeFreezePosition(input);
  }
}

/** 延迟绑定 history.service 的冻结读取(独立函数,便于单测打点) */

/** 历史写入权判定(供 progress-write.service 使用;data-model §7 转换 2) */
export function writeRightOf(input: {
  readonly history: { readonly writerEpoch: number; readonly writerPlaybackSessionId: string } | null;
  readonly candidateEpoch: number;
  readonly playbackSessionId: string;
}): 'acquire' | 'owner' | 'superseded' {
  if (input.history === null) {
    return 'acquire';
  }
  if (input.candidateEpoch > input.history.writerEpoch) {
    return 'acquire'; // 较新已起播意图胜出(可跳号;epoch 只增不减)
  }
  if (input.history.writerPlaybackSessionId === input.playbackSessionId) {
    return 'owner'; // 同 owner 继续
  }
  return 'superseded'; // 旧 candidate:applied=false/superseded,不终止其合法播放
}
