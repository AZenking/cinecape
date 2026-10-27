/**
 * T019(006 · US2):查询键工厂契约单测(contracts/query-keys.md)。
 *
 * 冻结契约(contracts/query-keys.md + 任务钉死的 API):
 * 1. 同参同键:参数对象按结构相等(而非引用相等)参与键;
 * 2. 异参异键:任何参数差异都不得命中同一缓存条目;
 * 3. 域 = 键首段:'public' | 'profile' | 'settings' 三段式前缀是硬约束,
 *   是切档/登出/401 域级清除的前缀匹配基础;
 * 4. 个人键必须内嵌 profileId(FR-021);
 * 5. 键可 JSON 序列化(参数对象置于末位,日期用 'YYYY-MM-DD' 字符串);
 * 6. 键内不含函数值(键要作为结构化哈希输入与跨端可持久化的纯数据)。
 *
 * 参数对象的具体形状由键工厂的入参类型决定(实现期定稿),这里经
 * `Parameters<...>` 反推类型并用 Partial 展开构造,只关注键的结构行为,
 * 不与 @hmp/shared 具体契约字段耦合。
 */

import { describe, expect, it } from 'vitest';
import { queryKeys } from '../../src/shared/query/keys';

// ── 从冻结 API 反推参数类型(不预设 @hmp/shared 字段形状) ──────────────
type CatalogFilters = Parameters<typeof queryKeys.public.catalog>[0];
type GuideQuery = Parameters<typeof queryKeys.public.guide>[0];
type EpgQuery = Parameters<typeof queryKeys.public.epg>[0];
type HistoryPage = Parameters<ReturnType<typeof queryKeys.profile>['history']>[0];

/** Partial 展开构造:允许测试只给出语义所需的字段子集(类型层保证可断言) */
function build<T>(patch: Partial<T>): T {
  return { ...patch } as T;
}

describe('T019 查询键工厂 · 同参同键(结构相等)', () => {
  it('catalog:两次独立构造的等值筛选对象 → 同一键', () => {
    const first = queryKeys.public.catalog(
      build<CatalogFilters>({ date: '2026-10-28', channelId: 'c1' }),
    );
    const second = queryKeys.public.catalog(
      build<CatalogFilters>({ date: '2026-10-28', channelId: 'c1' }),
    );
    expect(second).toEqual(first);
    // 字段书写顺序不影响结构相等(react-query 结构化哈希的语义前提)
    const reordered = queryKeys.public.catalog(
      build<CatalogFilters>({ channelId: 'c1', date: '2026-10-28' }),
    );
    expect(reordered).toEqual(first);
  });

  it('guide:嵌套参数对象同样按结构相等入键', () => {
    const a = queryKeys.public.guide(build<GuideQuery>({ date: '2026-10-28', channelId: 'c1' }));
    const b = queryKeys.public.guide(build<GuideQuery>({ date: '2026-10-28', channelId: 'c1' }));
    expect(b).toEqual(a);
  });

  it('history:分页参数两次构造 → 同一键', () => {
    const profile = queryKeys.profile('p1');
    expect(profile.history(build<HistoryPage>({ page: 2 }))).toEqual(
      profile.history(build<HistoryPage>({ page: 2 })),
    );
  });
});

describe('T019 查询键工厂 · 异参异键', () => {
  it('catalog:日期或频道任一不同 → 键不同', () => {
    const base = queryKeys.public.catalog(
      build<CatalogFilters>({ date: '2026-10-28', channelId: 'c1' }),
    );
    const otherDate = queryKeys.public.catalog(
      build<CatalogFilters>({ date: '2026-10-29', channelId: 'c1' }),
    );
    const otherChannel = queryKeys.public.catalog(
      build<CatalogFilters>({ date: '2026-10-28', channelId: 'c2' }),
    );
    expect(otherDate).not.toEqual(base);
    expect(otherChannel).not.toEqual(base);
  });

  it('guide/epg:参数对象整体不同 → 键不同', () => {
    const guideA = queryKeys.public.guide(build<GuideQuery>({ date: '2026-10-28', channelId: 'c1' }));
    const guideB = queryKeys.public.guide(build<GuideQuery>({ date: '2026-10-29', channelId: 'c1' }));
    expect(guideB).not.toEqual(guideA);

    const epgA = queryKeys.public.epg(build<EpgQuery>({ date: '2026-10-28' }));
    const epgB = queryKeys.public.epg(build<EpgQuery>({ date: '2026-10-29' }));
    expect(epgB).not.toEqual(epgA);
  });

  it('media/progress:资源 id 不同 → 键不同;profileId 不同 → 键不同', () => {
    expect(queryKeys.public.media('m1')).not.toEqual(queryKeys.public.media('m2'));
    expect(queryKeys.profile('p1').progress('m1')).not.toEqual(
      queryKeys.profile('p1').progress('m2'),
    );
    expect(queryKeys.profile('p1').favorites()).not.toEqual(queryKeys.profile('p2').favorites());
  });
});

describe('T019 查询键工厂 · 域前缀(键首段)', () => {
  it('三域键的首段恒为 public/profile/settings', () => {
    expect(queryKeys.public.context()[0]).toBe('public');
    expect(queryKeys.public.catalog(build<CatalogFilters>({}))[0]).toBe('public');
    expect(queryKeys.public.media('m1')[0]).toBe('public');
    expect(queryKeys.public.live()[0]).toBe('public');
    expect(queryKeys.profile('p1').favorites()[0]).toBe('profile');
    expect(queryKeys.profile('p1').progress('m1')[0]).toBe('profile');
    expect(queryKeys.settings.account()[0]).toBe('settings');
    expect(queryKeys.settings.epg()[0]).toBe('settings');
  });

  it('settings 六个键首段均为 settings、第二段为资源名', () => {
    const settingsKeys = [
      queryKeys.settings.account(),
      queryKeys.settings.profiles(),
      queryKeys.settings.policy(),
      queryKeys.settings.sources(),
      queryKeys.settings.devices(),
      queryKeys.settings.epg(),
    ];
    for (const key of settingsKeys) {
      expect(key[0]).toBe('settings');
      expect(typeof key[1]).toBe('string');
    }
    // 相互不同,防止设置子页间缓存串键
    expect(new Set(settingsKeys.map((key) => JSON.stringify(key))).size).toBe(settingsKeys.length);
  });
});

describe('T019 查询键工厂 · 个人键内嵌 profileId', () => {
  it('favorites/history/progress 的第二段 = profileId', () => {
    const profile = queryKeys.profile('p1');
    expect(profile.favorites()).toEqual(['profile', 'p1', 'favorites']);
    expect(profile.history(build<HistoryPage>({ page: 1 }))).toEqual([
      'profile',
      'p1',
      'history',
      build<HistoryPage>({ page: 1 }),
    ]);
    expect(profile.progress('m1')).toEqual(['profile', 'p1', 'progress', 'm1']);
  });
});

describe('T019 查询键工厂 · 可序列化与纯数据', () => {
  /** 递归断言键内无函数值(键必须是结构化哈希可处理的纯数据) */
  function expectNoFunctions(value: unknown): void {
    expect(typeof value).not.toBe('function');
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value as Record<string, unknown>)) {
        expectNoFunctions(item);
      }
    }
  }

  it.each([
    ['public.context', () => queryKeys.public.context()],
    ['public.catalog', () => queryKeys.public.catalog(build<CatalogFilters>({ date: '2026-10-28', channelId: 'c1' }))],
    ['public.guide', () => queryKeys.public.guide(build<GuideQuery>({ date: '2026-10-28', channelId: 'c1' }))],
    ['public.epg', () => queryKeys.public.epg(build<EpgQuery>({ date: '2026-10-28' }))],
    ['profile.favorites', () => queryKeys.profile('p1').favorites()],
    ['profile.history', () => queryKeys.profile('p1').history(build<HistoryPage>({ page: 2 }))],
    ['settings.policy', () => queryKeys.settings.policy()],
  ])('%s:JSON 往返稳定且不含函数', (__name, makeKey) => {
    const key = makeKey() as readonly unknown[];
    expectNoFunctions(key);
    const roundTrip = JSON.parse(JSON.stringify(key)) as unknown;
    expect(roundTrip).toEqual(key);
  });
});
