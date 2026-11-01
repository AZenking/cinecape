import { describe, expect, it } from 'vitest';
import {
  evaluateEffectiveMediaPolicy,
  type ChildMediaFacts,
  type ParentChildMediaFacts,
  type ParentMediaFacts,
} from '@contexts/policy/domain/effective-media-policy';
import type { EffectiveMediaPolicyPort } from '@contexts/policy/application/effective-media-policy.port';
import {
  evaluatePolicy,
  type MediaPolicyFacts,
  type PolicyJudgment,
} from '@contexts/policy/domain/policy.rules';
import {
  createFixtureWorld,
  FIXTURE_TITLE_KEYS,
  type FixtureProfilePolicyStub,
} from '../../fixtures/online-vod/fixture-world';

/**
 * T009(010 Phase 2)测试先行 —— 父子有效策略行为契约(TDD 红阶段)。
 *
 * ⚠️ 计划内红(文件顶部声明):被测模块
 *   - `@contexts/policy/domain/effective-media-policy`(本文件第 1 条 import;领域纯函数)
 *   - `@contexts/policy/application/effective-media-policy.port`(第 2 条 import;类型面契约)
 *   由 T017 创建。当前阶段预期:
 *   1. `pnpm --filter @hmp/server typecheck` 恰好出现两条 TS2307(上述两个模块不存在),
 *      除这两条计划内红外零其他错误;
 *   2. `vitest run` 本文件预期收集失败(模块未找到);
 *   3. eslint 零错误。
 *   本文件即行为契约:T017 实现须使本文件全绿,且不得改变旧入口
 *   `evaluatePolicy`(policy.rules)的任何静态判定结果(见「静态媒体旧行为回归」节)。
 *
 * 判定顺序契约(权威:ADR-0006「 Proposed Decision 2」+ ADR-0016 第 3 条 + 010 spec FR-010):
 * 父子有效策略逐条复用 ADR0006 单媒体判定顺序,首条命中即结束,对每个子项成对判定:
 *   表2 家庭可用性:parent 或 child 任一 householdEnabled=false → RESOURCE_UNAVAILABLE
 *       (最先判定,先于策略损坏);
 *   表3 策略缺失/损坏(归一 null)→ POLICY_UNAVAILABLE 默认拒绝,绝不静默放行;
 *   表4 禁止优先:parent 或 child 任一 id ∈ blockedMediaIds → MEDIA_BLOCKED
 *       (FR-010「父或子显式禁止优先」;父 ∈ 允许名单不能救回被禁子项);
 *   表6 未评级独立:父子有效等级为 null(两侧均未评级)→ 仅按 allowUnrated 给
 *       UNRATED_ALLOWED / UNRATED_DENIED;允许名单永不覆盖未评级;
 *   表7 允许名单覆盖等级上限(仅已评级):parent 与 child 双双 ∈ allowedMediaIds →
 *       MEDIA_ALLOWED。单边命中不覆盖(不隐式继承系列允许,对齐既有
 *       policy-rules.spec「episode 按自身 id 判定」);名单命中也绝不是必要条件;
 *   表8/9 等级:父子有效等级取较严(两侧已评级取 max;仅一方有等级则继承它 ——
 *       FR-010「父子有效等级取较严格者,只有一方有等级时继承它」;继承后按已评级
 *       走表6/7,未评级策略仅当两侧均无等级时触发)→ ≤ maxContentLevel 给
 *       LEVEL_ALLOWED,否则 LEVEL_EXCEEDED。
 * vod 父子无频道(data-model §2:父 movie/series/video、子 episode),表5 儿童频道
 * 白名单不在父子面;静态/频道行为仍由旧入口 evaluatePolicy 承担(FR-010「其他媒体规则不变」)。
 *
 * 输入形态契约(T009 第 7 条):服务端父子事实 = 纯值对象(householdId + parentId +
 * children 列表 + 父子角色),仅可由服务端目录侧构造,客户端不可提供任何事实。
 * profile/policy 夹具形态取自 test/fixtures/online-vod/fixture-world.ts(零依赖),
 * stub → 判定视图映射约定:unratedBlocked ↔ allowUnrated 取反;
 * maxRating general/mature ↔ ADR0006 默认等级 12/18;名单键仅作不透明媒体标识。
 */

/* ------------------------------------------------------------------ */
/* 夹具构造(纯对象;形态对齐既有 policy-rules.spec.ts)                  */
/* ------------------------------------------------------------------ */

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

function parentOf(overrides: Partial<ParentMediaFacts> = {}): ParentMediaFacts {
  return { mediaId: 'series-1', role: 'series', contentLevel: 10, householdEnabled: true, ...overrides };
}

function childOf(overrides: Partial<ChildMediaFacts> = {}): ChildMediaFacts {
  return { mediaId: 'episode-1', role: 'episode', contentLevel: 8, householdEnabled: true, ...overrides };
}

/** parentId/children 列表形态(data-model §2:父 movie/series/video、子 episode) */
function groupOf(
  parent: Partial<ParentMediaFacts> = {},
  children: ChildMediaFacts[] = [childOf()],
): ParentChildMediaFacts {
  return { householdId: 'h1', parent: parentOf(parent), children };
}

/** 旧入口静态单媒体事实(静态回归节用;与 parentOf 同源不同类型) */
function staticFactsOf(overrides: Partial<MediaPolicyFacts> = {}): MediaPolicyFacts {
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

/** 父轴事实 → 旧入口 MediaPolicyFacts(父轴与静态单媒体同构的兼容面证据) */
function parentToFacts(householdId: string, parent: ParentMediaFacts): MediaPolicyFacts {
  return {
    householdId,
    mediaId: parent.mediaId,
    type: parent.role,
    channelId: null,
    contentLevel: parent.contentLevel,
    householdEnabled: parent.householdEnabled,
  };
}

/** fixture-world 策略 stub → PolicyJudgment(报告给 T017 的服务端映射约定) */
function judgmentFromStub(stub: FixtureProfilePolicyStub): PolicyJudgment {
  return {
    maxContentLevel: stub.maxRating === 'mature' ? 18 : 12,
    allowUnrated: !stub.unratedBlocked,
    allowedMediaIds: [...stub.allowedTitleKeys],
    blockedMediaIds: [...stub.blockedTitleKeys],
    allowedChannelIds: [],
  };
}

/* ------------------------------------------------------------------ */
/* T009 第 6 条:静态媒体旧行为回归(旧入口,3–4 个代表断言)             */
/* ------------------------------------------------------------------ */

describe('静态媒体旧行为回归(T009:旧入口 evaluatePolicy 判定结果不得改变)', () => {
  it('禁止优先 / 名单覆盖等级 / 未评级独立 / 策略损坏默认拒绝,与既有 policy-rules.spec 同构', () => {
    // 表4:允许∩禁止 → 禁止优先
    expect(
      evaluatePolicy(
        policyOf({ allowedMediaIds: ['movie-1'], blockedMediaIds: ['movie-1'] }),
        'child',
        staticFactsOf(),
      ),
    ).toStrictEqual({ allowed: false, reason: 'MEDIA_BLOCKED' });
    // 表7:超限已评级媒体在允许名单 → 覆盖普通等级上限
    expect(
      evaluatePolicy(policyOf({ allowedMediaIds: ['movie-1'] }), 'child', staticFactsOf({ contentLevel: 18 })),
    ).toStrictEqual({ allowed: true, reason: 'MEDIA_ALLOWED' });
    // 表6:未评级独立按 allowUnrated(允许名单不覆盖)
    expect(
      evaluatePolicy(
        policyOf({ allowUnrated: false, allowedMediaIds: ['movie-1'] }),
        'child',
        staticFactsOf({ contentLevel: null }),
      ),
    ).toStrictEqual({ allowed: false, reason: 'UNRATED_DENIED' });
    // 表3:策略缺失/损坏(授权入口归一 null)→ 默认拒绝
    expect(evaluatePolicy(null, 'child', staticFactsOf())).toStrictEqual({
      allowed: false,
      reason: 'POLICY_UNAVAILABLE',
    });
  });

  it('等级边界 0 与 18 保持 LEVEL_ALLOWED/LEVEL_EXCEEDED;空名单不表示允许所有', () => {
    expect(evaluatePolicy(policyOf({ maxContentLevel: 0 }), 'child', staticFactsOf({ contentLevel: 0 }))).toStrictEqual({
      allowed: true,
      reason: 'LEVEL_ALLOWED',
    });
    expect(evaluatePolicy(policyOf({ maxContentLevel: 18 }), 'child', staticFactsOf({ contentLevel: 18 })).allowed).toBe(
      true,
    );
    expect(evaluatePolicy(policyOf({ maxContentLevel: 0 }), 'child', staticFactsOf({ contentLevel: 1 })).reason).toBe(
      'LEVEL_EXCEEDED',
    );
    expect(evaluatePolicy(policyOf(), 'child', staticFactsOf({ contentLevel: 13 })).reason).toBe('LEVEL_EXCEEDED');
  });
});

/* ------------------------------------------------------------------ */
/* T009 第 1–5 条:父子有效策略(ADR0006 顺序逐条复用)                  */
/* ------------------------------------------------------------------ */

describe('evaluateEffectiveMediaPolicy 父子判定(ADR0006 顺序,首条命中即结束)', () => {
  it('表2:家庭可用性最先——父不可用全组拒绝;单子不可用仅该子拒绝;先于禁止与策略损坏', () => {
    // 父不可用 + 策略同时缺失:按表2 先报 RESOURCE_UNAVAILABLE(不是 POLICY_UNAVAILABLE)
    expect(evaluateEffectiveMediaPolicy(null, groupOf({ householdEnabled: false }))).toStrictEqual({
      parent: { allowed: false, reason: 'RESOURCE_UNAVAILABLE' },
      children: [{ allowed: false, reason: 'RESOURCE_UNAVAILABLE' }],
    });
    // 单子不可用:仅该子拒绝,兄弟子项与父轴不受牵连
    const mixed = groupOf({}, [childOf({ mediaId: 'episode-1' }), childOf({ mediaId: 'episode-2', householdEnabled: false })]);
    expect(evaluateEffectiveMediaPolicy(policyOf(), mixed)).toStrictEqual({
      parent: { allowed: true, reason: 'LEVEL_ALLOWED' },
      children: [
        { allowed: true, reason: 'LEVEL_ALLOWED' },
        { allowed: false, reason: 'RESOURCE_UNAVAILABLE' },
      ],
    });
    // 可用性先于禁止优先:不可用子项即使被禁止也按 RESOURCE_UNAVAILABLE 报告
    expect(evaluateEffectiveMediaPolicy(policyOf({ blockedMediaIds: ['episode-2'] }), mixed).children).toStrictEqual([
      { allowed: true, reason: 'LEVEL_ALLOWED' },
      { allowed: false, reason: 'RESOURCE_UNAVAILABLE' },
    ]);
  });

  it('表3/T009-5:策略缺失或损坏(归一 null)→ 全组 POLICY_UNAVAILABLE,绝不静默放行', () => {
    expect(evaluateEffectiveMediaPolicy(null, groupOf())).toStrictEqual({
      parent: { allowed: false, reason: 'POLICY_UNAVAILABLE' },
      children: [{ allowed: false, reason: 'POLICY_UNAVAILABLE' }],
    });
  });

  it('T009-1 禁止优先:父或子任一 id 在禁止名单即拒;父在允许名单也不能救回被禁子项', () => {
    // 子被禁:父同时在允许名单(父轴 MEDIA_ALLOWED),子项仍 MEDIA_BLOCKED —— 表4 先于表7
    const parentAllowedChildBlocked = policyOf({ allowedMediaIds: ['series-1'], blockedMediaIds: ['episode-1'] });
    expect(evaluateEffectiveMediaPolicy(parentAllowedChildBlocked, groupOf())).toStrictEqual({
      parent: { allowed: true, reason: 'MEDIA_ALLOWED' },
      children: [{ allowed: false, reason: 'MEDIA_BLOCKED' }],
    });
    // 父被禁:父轴与全部子项随之被禁(显式禁止优先,FR-010)
    expect(
      evaluateEffectiveMediaPolicy(
        policyOf({ blockedMediaIds: ['series-1'] }),
        groupOf({}, [childOf(), childOf({ mediaId: 'episode-2' })]),
      ),
    ).toStrictEqual({
      parent: { allowed: false, reason: 'MEDIA_BLOCKED' },
      children: [
        { allowed: false, reason: 'MEDIA_BLOCKED' },
        { allowed: false, reason: 'MEDIA_BLOCKED' },
      ],
    });
  });

  it('T009-2 未评级独立:父子均未评级时仅按 allowUnrated;允许名单永不覆盖未评级', () => {
    const unratedPair = groupOf({ contentLevel: null }, [childOf({ contentLevel: null })]);
    expect(evaluateEffectiveMediaPolicy(policyOf({ allowUnrated: false }), unratedPair)).toStrictEqual({
      parent: { allowed: false, reason: 'UNRATED_DENIED' },
      children: [{ allowed: false, reason: 'UNRATED_DENIED' }],
    });
    // 名单命中不覆盖未评级:两侧都在允许名单,仍 UNRATED_DENIED(表6 先于表7)
    expect(
      evaluateEffectiveMediaPolicy(policyOf({ allowedMediaIds: ['series-1', 'episode-1'] }), unratedPair).children,
    ).toStrictEqual([{ allowed: false, reason: 'UNRATED_DENIED' }]);
    // allowUnrated=true → 允许,且不受等级上限影响
    expect(
      evaluateEffectiveMediaPolicy(policyOf({ allowUnrated: true, maxContentLevel: 0 }), unratedPair).children,
    ).toStrictEqual([{ allowed: true, reason: 'UNRATED_ALLOWED' }]);
  });

  it('表7(名单目标扩展):父与子双双命中允许名单才覆盖等级上限;单边命中不覆盖', () => {
    const overCap = groupOf({ contentLevel: 16 }, [childOf({ contentLevel: 18 })]);
    // 双命中 → 已评级名单覆盖生效
    expect(evaluateEffectiveMediaPolicy(policyOf({ allowedMediaIds: ['series-1', 'episode-1'] }), overCap)).toStrictEqual({
      parent: { allowed: true, reason: 'MEDIA_ALLOWED' },
      children: [{ allowed: true, reason: 'MEDIA_ALLOWED' }],
    });
    // T009-4 仅父有名单:父自身覆盖,子仍按等级拒绝(不隐式继承系列允许)
    expect(evaluateEffectiveMediaPolicy(policyOf({ allowedMediaIds: ['series-1'] }), overCap)).toStrictEqual({
      parent: { allowed: true, reason: 'MEDIA_ALLOWED' },
      children: [{ allowed: false, reason: 'LEVEL_EXCEEDED' }],
    });
    // 仅子有名单:子不能借父未命中越过等级上限
    expect(evaluateEffectiveMediaPolicy(policyOf({ allowedMediaIds: ['episode-1'] }), overCap).children).toStrictEqual([
      { allowed: false, reason: 'LEVEL_EXCEEDED' },
    ]);
  });

  it('T009-3 非空允许名单未命中目标但等级 ≤ 上限 → 仍允许(名单不是必要白名单)', () => {
    expect(evaluateEffectiveMediaPolicy(policyOf({ allowedMediaIds: ['other-movie-1', 'other-movie-2'] }), groupOf()))
      .toStrictEqual({
        parent: { allowed: true, reason: 'LEVEL_ALLOWED' },
        children: [{ allowed: true, reason: 'LEVEL_ALLOWED' }],
      });
    // 频道允许名单对 vod 父子面无作用(episode 非频道,表5 不在父子面):命中也不放行超限子项
    expect(
      evaluateEffectiveMediaPolicy(policyOf({ allowedChannelIds: ['series-1', 'episode-1'], maxContentLevel: 0 }), groupOf())
        .children,
    ).toStrictEqual([{ allowed: false, reason: 'LEVEL_EXCEEDED' }]);
  });

  it('T009-4 父子等级取严:有效等级=两侧较严者(方向无关);父轴保持单媒体语义', () => {
    // 父 8 / 子 16:有效 16 —— cap 12 拒、cap 16 边界过
    const pair = groupOf({ contentLevel: 8 }, [childOf({ contentLevel: 16 })]);
    expect(evaluateEffectiveMediaPolicy(policyOf({ maxContentLevel: 12 }), pair).children).toStrictEqual([
      { allowed: false, reason: 'LEVEL_EXCEEDED' },
    ]);
    expect(evaluateEffectiveMediaPolicy(policyOf({ maxContentLevel: 16 }), pair).children).toStrictEqual([
      { allowed: true, reason: 'LEVEL_ALLOWED' },
    ]);
    // 父 16 / 子 8:同样取 16(取严与父/子方向无关)
    expect(
      evaluateEffectiveMediaPolicy(policyOf({ maxContentLevel: 12 }), groupOf({ contentLevel: 16 }, [childOf({ contentLevel: 8 })]))
        .children,
    ).toStrictEqual([{ allowed: false, reason: 'LEVEL_EXCEEDED' }]);
    // 父轴不受子轴取严影响:父自身 8≤12 允许,子轴取严 16>12 拒绝
    const asymmetric = evaluateEffectiveMediaPolicy(policyOf({ maxContentLevel: 12 }), pair);
    expect(asymmetric.parent).toStrictEqual({ allowed: true, reason: 'LEVEL_ALLOWED' });
    expect(asymmetric.children).toStrictEqual([{ allowed: false, reason: 'LEVEL_EXCEEDED' }]);
  });

  it('T009-4 单边等级继承:仅一方有等级时继承它——按已评级判定,不触发未评级策略', () => {
    // 父 8 / 子未评级:有效 8;即使 allowUnrated=false 也不按 UNRATED_DENIED
    const inherited = groupOf({ contentLevel: 8 }, [childOf({ contentLevel: null })]);
    expect(
      evaluateEffectiveMediaPolicy(policyOf({ allowUnrated: false, maxContentLevel: 12 }), inherited),
    ).toStrictEqual({
      parent: { allowed: true, reason: 'LEVEL_ALLOWED' },
      children: [{ allowed: true, reason: 'LEVEL_ALLOWED' }],
    });
    // 父未评级 / 子 16:有效 16 —— cap 12 拒绝(继承方向无关)
    const fromChild = groupOf({ contentLevel: null }, [childOf({ contentLevel: 16 })]);
    expect(
      evaluateEffectiveMediaPolicy(policyOf({ allowUnrated: true, maxContentLevel: 12 }), fromChild).children,
    ).toStrictEqual([{ allowed: false, reason: 'LEVEL_EXCEEDED' }]);
    // 继承后按已评级走名单覆盖:两侧命中允许名单可越过继承等级的上限
    expect(
      evaluateEffectiveMediaPolicy(
        policyOf({ allowUnrated: true, maxContentLevel: 8, allowedMediaIds: ['series-1', 'episode-1'] }),
        fromChild,
      ).children,
    ).toStrictEqual([{ allowed: true, reason: 'MEDIA_ALLOWED' }]);
  });

  it('父轴与旧入口 evaluatePolicy 同构(新入口兼容面:复用同一判定核心的直接证据)', () => {
    const parent = parentOf({ mediaId: 'movie-1', role: 'movie', contentLevel: 14 });
    const judgment = policyOf({ maxContentLevel: 12, allowedMediaIds: ['movie-1'] });
    const viaParentAxis = evaluateEffectiveMediaPolicy(judgment, {
      householdId: 'h1',
      parent,
      children: [childOf()],
    }).parent;
    expect(viaParentAxis).toStrictEqual(evaluatePolicy(judgment, 'child', parentToFacts('h1', parent)));
  });

  it('T009-5 损坏事实(非法等级/损坏结构)→ 稳定抛错(含「损坏」可识别语义),绝不静默放行', () => {
    const policy = policyOf();
    // 非法等级:越界与非整数(parent/child 同规;内部等级为 0–18 整数或 null)
    expect(() => evaluateEffectiveMediaPolicy(policy, groupOf({}, [childOf({ contentLevel: 19 })]))).toThrowError(/损坏/);
    expect(() => evaluateEffectiveMediaPolicy(policy, groupOf({ contentLevel: -1 }))).toThrowError(/损坏/);
    expect(() => evaluateEffectiveMediaPolicy(policy, groupOf({}, [childOf({ contentLevel: 7.5 })]))).toThrowError(/损坏/);
    // 损坏结构:父子角色非法(data-model §2:父 movie/series/video、子 episode)
    expect(() =>
      evaluateEffectiveMediaPolicy(policy, groupOf({ role: 'episode' as ParentMediaFacts['role'] })),
    ).toThrowError(/损坏/);
    expect(() =>
      evaluateEffectiveMediaPolicy(policy, groupOf({}, [childOf({ role: 'movie' as ChildMediaFacts['role'] })])),
    ).toThrowError(/损坏/);
    // 空标识 / 父子自环 / 子项 mediaId 重复(media_id 全局唯一,自环为关系损坏)
    expect(() => evaluateEffectiveMediaPolicy(policy, groupOf({ mediaId: '' }))).toThrowError(/损坏/);
    expect(() =>
      evaluateEffectiveMediaPolicy(policy, groupOf({ mediaId: 'same-1' }, [childOf({ mediaId: 'same-1' })])),
    ).toThrowError(/损坏/);
    expect(() =>
      evaluateEffectiveMediaPolicy(policy, groupOf({}, [childOf({ mediaId: 'episode-1' }), childOf({ mediaId: 'episode-1' })])),
    ).toThrowError(/损坏/);
  });
});

/* ------------------------------------------------------------------ */
/* EffectiveMediaPolicyPort 端口契约(T017 建议签名的类型面钉子)        */
/* ------------------------------------------------------------------ */

describe('EffectiveMediaPolicyPort 端口契约(internal-ports:发布端口=领域纯函数的提升)', () => {
  it('输入服务端父子事实+最新策略目标,输出 allow/deny+原因;与直接调用领域函数同结果', () => {
    // 红阶段显式标注(避免派生隐式 any):与建议 EffectiveMediaPolicyInput 同构,
    // T017 落地后端口输入应与本结构一致(字段:householdId/profileId/policy/facts)。
    const port: EffectiveMediaPolicyPort = {
      evaluate: (input: { householdId: string; profileId: string; policy: PolicyJudgment | null; facts: ParentChildMediaFacts }) =>
        evaluateEffectiveMediaPolicy(input.policy, input.facts),
    };
    // 策略损坏(null)经端口面仍默认拒绝
    expect(
      port.evaluate({ householdId: 'h1', profileId: 'profile-1', policy: null, facts: groupOf() }),
    ).toStrictEqual({
      parent: { allowed: false, reason: 'POLICY_UNAVAILABLE' },
      children: [{ allowed: false, reason: 'POLICY_UNAVAILABLE' }],
    });
    // 正常策略:端口面与领域函数同构
    expect(port.evaluate({ householdId: 'h1', profileId: 'profile-1', policy: policyOf(), facts: groupOf() })).toStrictEqual(
      evaluateEffectiveMediaPolicy(policyOf(), groupOf()),
    );
  });
});

/* ------------------------------------------------------------------ */
/* T009 第 7 条:在线父子事实输入形态(纯对象夹具 + fixture-world stub) */
/* ------------------------------------------------------------------ */

describe('在线父子事实输入形态(parentId/children 列表与父子角色)', () => {
  it('movie/series/video 父 + episode 子的多子项列表按输入顺序对齐输出', () => {
    const judgment = policyOf({ maxContentLevel: 12, allowUnrated: false });
    const children = [
      childOf({ mediaId: 'ep-1', contentLevel: 6 }),
      childOf({ mediaId: 'ep-2', contentLevel: 14 }),
      childOf({ mediaId: 'ep-3', contentLevel: null }),
    ];
    for (const role of ['movie', 'series', 'video'] as const) {
      const decision = evaluateEffectiveMediaPolicy(
        judgment,
        groupOf({ mediaId: `parent-${role}`, role, contentLevel: null }, children),
      );
      // 父未评级:各子项单边继承自身等级;双未评级才走未评级策略
      expect(decision.children).toStrictEqual([
        { allowed: true, reason: 'LEVEL_ALLOWED' },
        { allowed: false, reason: 'LEVEL_EXCEEDED' },
        { allowed: false, reason: 'UNRATED_DENIED' },
      ]);
      // 父轴只看父自身事实(未评级 + allowUnrated=false)
      expect(decision.parent).toStrictEqual({ allowed: false, reason: 'UNRATED_DENIED' });
    }
  });

  it('fixture-world 策略 stub 映射:儿童 stub 未评级拒绝;成人 stub 放行;父 allow/子 block 按名单', () => {
    const world = createFixtureWorld();
    const [adult, child] = world.profiles;
    const unratedPair = groupOf({ contentLevel: null }, [childOf({ contentLevel: null })]);

    // 儿童 stub(unratedBlocked=true)→ 未评级父子对拒绝
    expect(evaluateEffectiveMediaPolicy(judgmentFromStub(child.policy), unratedPair).children).toStrictEqual([
      { allowed: false, reason: 'UNRATED_DENIED' },
    ]);
    // 成人 stub(unratedBlocked=false)→ 同一组允许
    expect(evaluateEffectiveMediaPolicy(judgmentFromStub(adult.policy), unratedPair).children).toStrictEqual([
      { allowed: true, reason: 'UNRATED_ALLOWED' },
    ]);

    // 父 allow / 子 block:夹具名单键仅作不透明策略目标
    // 父 = 儿童 stub 允许名单内的标题键(已评级 12);子 = 儿童 stub 禁止名单内的标题键
    const pair = groupOf(
      { mediaId: FIXTURE_TITLE_KEYS.threeEpisodeSerial, contentLevel: 12 },
      [childOf({ mediaId: FIXTURE_TITLE_KEYS.echoTheatrical, contentLevel: 12 })],
    );
    expect(evaluateEffectiveMediaPolicy(judgmentFromStub(child.policy), pair)).toStrictEqual({
      parent: { allowed: true, reason: 'MEDIA_ALLOWED' },
      children: [{ allowed: false, reason: 'MEDIA_BLOCKED' }],
    });
  });
});
