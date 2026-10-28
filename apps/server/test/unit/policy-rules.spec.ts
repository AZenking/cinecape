import { describe, expect, it } from 'vitest';
import {
  evaluatePolicy,
  type MediaPolicyFacts,
  type PolicyJudgment,
} from '@contexts/policy/domain/policy.rules';

/**
 * T015(US2 单元):纯判定核心 evaluatePolicy —— spec「策略判定表」全分支 + 边缘组合。
 * 纯函数:无 I/O、无框架依赖;输入由服务端构造(facts 仅服务端目录适配器可造)。
 * reason 约定(contracts/api.md):RESOURCE_UNAVAILABLE / POLICY_UNAVAILABLE / MEDIA_BLOCKED /
 * CHANNEL_NOT_ALLOWED / UNRATED_DENIED / UNRATED_ALLOWED / MEDIA_ALLOWED / LEVEL_ALLOWED / LEVEL_EXCEEDED。
 */

function factsOf(overrides: Partial<MediaPolicyFacts> = {}): MediaPolicyFacts {
  return {
    householdId: 'h1',
    mediaId: 'movie-1',
    type: 'movie',
    channelId: null,
    contentLevel: 10,
    householdEnabled: true,
    ...overrides,
  };
}

function policyOf(overrides: Partial<PolicyJudgment> = {}): PolicyJudgment {
  return {
    maxContentLevel: 12,
    allowUnrated: false,
    allowedMediaIds: [],
    blockedMediaIds: [],
    allowedChannelIds: [],
    ...overrides,
  };
}

describe('evaluatePolicy 判定表(纯函数矩阵)', () => {
  it('表2/表3:家庭禁用资源 → RESOURCE_UNAVAILABLE(先于策略缺失);策略缺失 → POLICY_UNAVAILABLE', () => {
    expect(evaluatePolicy(policyOf(), 'child', factsOf({ householdEnabled: false })).reason).toBe('RESOURCE_UNAVAILABLE');
    expect(evaluatePolicy(null, 'child', factsOf({ householdEnabled: false })).reason).toBe('RESOURCE_UNAVAILABLE');
    expect(evaluatePolicy(null, 'child', factsOf())).toStrictEqual({ allowed: false, reason: 'POLICY_UNAVAILABLE' });
    expect(evaluatePolicy(null, 'adult', factsOf()).reason).toBe('POLICY_UNAVAILABLE');
  });

  it('表4/场景1:同一媒体允许∩禁止 → 禁止优先(成人/儿童一致)', () => {
    const policy = policyOf({ allowedMediaIds: ['movie-1'], blockedMediaIds: ['movie-1'] });
    expect(evaluatePolicy(policy, 'child', factsOf())).toStrictEqual({ allowed: false, reason: 'MEDIA_BLOCKED' });
    expect(evaluatePolicy(policy, 'adult', factsOf()).reason).toBe('MEDIA_BLOCKED');
  });

  it('表7/场景2:已评级超限媒体在允许名单 → 允许(覆盖普通等级上限,reason=MEDIA_ALLOWED)', () => {
    const policy = policyOf({ maxContentLevel: 12, allowedMediaIds: ['movie-1'] });
    const over = factsOf({ contentLevel: 18 });
    expect(evaluatePolicy(policy, 'child', over)).toStrictEqual({ allowed: true, reason: 'MEDIA_ALLOWED' });
    expect(evaluatePolicy(policy, 'adult', over).reason).toBe('MEDIA_ALLOWED');
  });

  it('表6/场景3:未评级媒体在允许名单仍禁止(allowUnrated=false);开启后允许(UNRATED_ALLOWED)', () => {
    const policy = policyOf({ allowUnrated: false, allowedMediaIds: ['movie-1'] });
    const unrated = factsOf({ contentLevel: null });
    expect(evaluatePolicy(policy, 'child', unrated)).toStrictEqual({ allowed: false, reason: 'UNRATED_DENIED' });
    expect(evaluatePolicy(policy, 'adult', unrated).reason).toBe('UNRATED_DENIED');

    const allowUnrated = policyOf({ allowUnrated: true, allowedMediaIds: ['movie-1'] });
    expect(evaluatePolicy(allowUnrated, 'child', unrated)).toStrictEqual({ allowed: true, reason: 'UNRATED_ALLOWED' });
    // 未评级不受等级上限影响:max=0 且未加入允许名单,开启开关仍允许
    expect(evaluatePolicy(policyOf({ allowUnrated: true, maxContentLevel: 0 }), 'child', unrated).reason).toBe(
      'UNRATED_ALLOWED',
    );
  });

  it('表5/场景4:儿童频道不在允许名单 → CHANNEL_NOT_ALLOWED(即使等级满足;空名单=全部不可访问)', () => {
    const policy = policyOf({ maxContentLevel: 18, allowUnrated: true });
    const channel = factsOf({ mediaId: 'ch-9', type: 'channel', channelId: 'ch-9', contentLevel: 8 });
    expect(evaluatePolicy(policy, 'child', channel)).toStrictEqual({ allowed: false, reason: 'CHANNEL_NOT_ALLOWED' });

    // 在名单中仍检查未评级/等级规则(必要条件,非充分)
    const whitelisted = policyOf({ allowUnrated: false, allowedChannelIds: ['ch-9'] });
    expect(evaluatePolicy(whitelisted, 'child', factsOf({ mediaId: 'ch-9', type: 'channel', channelId: 'ch-9', contentLevel: 8 })).reason).toBe(
      'LEVEL_ALLOWED',
    );
    expect(
      evaluatePolicy(whitelisted, 'child', factsOf({ mediaId: 'ch-9', type: 'channel', channelId: 'ch-9', contentLevel: null })).reason,
    ).toBe('UNRATED_DENIED');
    // 白名单频道 + 媒体允许名单覆盖等级
    expect(
      evaluatePolicy(
        policyOf({ maxContentLevel: 0, allowedChannelIds: ['ch-9'], allowedMediaIds: ['ch-9'] }),
        'child',
        factsOf({ mediaId: 'ch-9', type: 'channel', channelId: 'ch-9', contentLevel: 15 }),
      ).reason,
    ).toBe('MEDIA_ALLOWED');
  });

  it('成人不受频道允许名单限制,但仍受禁止/未评级/等级约束', () => {
    const channel = factsOf({ mediaId: 'ch-x', type: 'channel', channelId: 'ch-x', contentLevel: 12 });
    expect(evaluatePolicy(policyOf(), 'adult', channel)).toStrictEqual({ allowed: true, reason: 'LEVEL_ALLOWED' });
    expect(evaluatePolicy(policyOf({ allowUnrated: false }), 'adult', factsOf({ ...channel, contentLevel: null })).reason).toBe(
      'UNRATED_DENIED',
    );
    expect(evaluatePolicy(policyOf({ blockedMediaIds: ['ch-x'] }), 'adult', channel).reason).toBe('MEDIA_BLOCKED');
    expect(evaluatePolicy(policyOf({ maxContentLevel: 11 }), 'adult', channel).reason).toBe('LEVEL_EXCEEDED');
  });

  it('表8/表9:等级边界 0 与 18;空允许名单不表示"允许所有"', () => {
    expect(evaluatePolicy(policyOf({ maxContentLevel: 0 }), 'child', factsOf({ contentLevel: 0 }))).toStrictEqual({
      allowed: true,
      reason: 'LEVEL_ALLOWED',
    });
    expect(evaluatePolicy(policyOf({ maxContentLevel: 0 }), 'child', factsOf({ contentLevel: 1 })).reason).toBe(
      'LEVEL_EXCEEDED',
    );
    expect(evaluatePolicy(policyOf({ maxContentLevel: 18 }), 'child', factsOf({ contentLevel: 18 })).reason).toBe(
      'LEVEL_ALLOWED',
    );
    // 电影(非频道)不受儿童频道名单影响;空允许名单 → 走普通等级规则
    expect(evaluatePolicy(policyOf({ maxContentLevel: 10 }), 'child', factsOf({ contentLevel: 12 })).reason).toBe(
      'LEVEL_EXCEEDED',
    );
    expect(evaluatePolicy(policyOf({ maxContentLevel: 12 }), 'child', factsOf({ contentLevel: 12 })).reason).toBe(
      'LEVEL_ALLOWED',
    );
  });

  it('series/episode 按自身 id 判定,不隐式继承系列允许', () => {
    const policy = policyOf({ maxContentLevel: 5, allowedMediaIds: ['series-1'] });
    const episode = factsOf({ mediaId: 'episode-1', type: 'episode', contentLevel: 8 });
    expect(evaluatePolicy(policy, 'child', episode)).toStrictEqual({ allowed: false, reason: 'LEVEL_EXCEEDED' });
    expect(evaluatePolicy(policyOf({ blockedMediaIds: ['episode-1'] }), 'child', episode).reason).toBe('MEDIA_BLOCKED');
    expect(evaluatePolicy(policyOf({ allowedMediaIds: ['episode-1'] }), 'child', episode).reason).toBe('MEDIA_ALLOWED');
  });

  it('损坏事实(类型无效/等级越界/channelId 不一致/跨家庭)→ 抛出内部错误,绝不静默放行', () => {
    const policy = policyOf();
    expect(() => evaluatePolicy(policy, 'child', factsOf({ type: 'playlist' as MediaPolicyFacts['type'] }))).toThrowError();
    expect(() => evaluatePolicy(policy, 'child', factsOf({ contentLevel: 19 }))).toThrowError();
    expect(() => evaluatePolicy(policy, 'child', factsOf({ contentLevel: -1 }))).toThrowError();
    // channel 时 channelId 必须等于 mediaId;非 channel 不得携带 channelId
    expect(() =>
      evaluatePolicy(policy, 'child', factsOf({ type: 'channel', channelId: 'other' })),
    ).toThrowError();
    expect(() => evaluatePolicy(policy, 'child', factsOf({ channelId: 'movie-1' }))).toThrowError();
    // 媒体标识为空串 → 事实损坏
    expect(() => evaluatePolicy(policy, 'child', factsOf({ mediaId: '' }))).toThrowError();
  });
});
