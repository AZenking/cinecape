import { describe, expect, it } from 'vitest';
import { VOD_BUDGETS, type VodDetailBudget } from '@contexts/online-vod/domain/vod-budgets';
import {
  normalizeIdentity,
  providerIdentityEquals,
  ProviderParseError,
  type ParsedVodEpisode,
  type ParsedVodLine,
  type ParsedVodSearchItem,
  type ParsedVodTitleDetail,
  type ProviderParseErrorCode,
} from '@contexts/online-vod/domain/provider-model';
import {
  extractLines,
  parseDetail,
  parseDetailDocument,
  parseSearchList,
} from '@contexts/online-vod/infrastructure/apple-cms.adapter';
import {
  buildAppleCmsListDocument,
  createGappedDuplicateWorld,
  createThreeEpisodeSerialWorld,
  createVersionConflictWorld,
  type AppleCmsVodItem,
} from '../../fixtures/online-vod/fixture-upstream';

/**
 * 010 T023(测试先行)—— Apple CMS 解析器契约钉面(计划内红,待 T025 转绿)。
 *
 * ⚠️ 计划内红(文件顶部声明):被测模块由 T025 创建,当前不存在——
 *   - `@contexts/online-vod/domain/provider-model`(身份规范化/解析值类型/拒绝错误,纯领域);
 *   - `@contexts/online-vod/infrastructure/apple-cms.adapter`(wire 对象 → 解析值的纯函数)。
 * 当前阶段预期(对齐 vod-parent-child-policy.spec.ts 的 T009 先例):
 *   1. `vitest run test/unit/online-vod/provider-parser.spec.ts` 收集期失败(模块不存在);
 *   2. `pnpm --filter @hmp/server typecheck` 恰好新增两条 TS2307(上述两模块),零其他错误;
 *   3. eslint 零错误。
 * 本文件即 T025 行为契约:实现须使本文件全绿,且只允许通过上述两模块导出面满足。
 *
 * 被测范围(tasks.md T025 原文):Apple CMS JSON 搜索/详情/多线 HLS 定位解析,
 * 基础证据 unverified;逐字保留「upstreamVodId/lineKey/episodeKey 1–255,NFC+trim
 * 不得截断身份」「简介纯文本<=4096」;预算和完整性校验失败整体拒绝。
 * 解析器为纯函数:输入 wire 对象(夹具 T005 形态)+ 预算,输出纯值;零真实网络。
 * HTTP/字节预算属 T018 传输层(SafeUpstream),不在本契约钉面内。
 *
 * 键推导契约(wire 只承载 label+url,见 fixture-upstream.ts 头注;本文件钉死唯一自洽推导):
 *   - upstreamVodId = String(vod_id)(wire 数值 → 字符串身份);
 *   - lineKey       = NFC+trim(vod_play_from `$$$` 段显示名);
 *   - episodeKey    = NFC+trim(`名称$地址` 的名称段 label,按首个 `$` 分割);
 *   - 身份为字符串级:'第01集' ≠ '第1集',绝不数值化;NFC 之外零折叠(不做 NFKC
 *     宽度折叠/大小写折叠,data-model §1 只约定 NFC+trim);
 *   - URL 不参与身份:签名 token 变化只体现为 locator 数据(见 G 组,data-model §3
 *     「URL token/采集时间变化不加 [catalogRevision]」「不因签名URL变化单独推进 [sequenceRevision]」);
 *   - 同一语义键归一相等:世界二种子层镜像线(lineKey 'main' 同、显示名异)在 wire 上
 *     是三条不同显示名线,不构成 wire 级重复;wire 级重复 = 归一后同名 `$$$` 段
 *     (fixture-upstream 头注「重复键/重复线路在 wire 上表现为重复段」),由 B 组以
 *     定制 wire 钉死;世界二在 wire 级实际提供的是重复集键('第02集'×2)与缺集形态。
 *
 * 失败语义(T025「整体拒绝」钉死为抛 ProviderParseError —— 纯 Error 子类,
 * 对齐 vod-budgets.ts 惯例「interface 层负责翻译为 HTTP 语义」;budget_exceeded 即 api §2
 * 「超限422整次失败」的 422 语义载体):
 *   - identity_key_invalid   键/标题名 NFC+trim 后 >255 或标题名空 → 整体拒绝,绝不截断;
 *   - integrity_violation    code!==1 / list 缺失 / 条目缺 vod_id|vod_name / 详情缺 play
 *                            字段 / from-url 段数错位 / 单集地址空 → 整体拒绝,绝不判
 *                            missing、绝不静默标 unsupported(data-model §3「失败/截断不发布」);
 *   - protocol_unsupported   播放地址非绝对 http(s)(ftp/相对/伪协议)→ 整体拒绝
 *                            (api §2 源根地址「只接受http(s)并校验」同口径延伸到上游定位地址);
 *   - budget_exceeded        超 detail.maxLines(20)/maxEpisodesPerLine(2000)/
 *                            maxEpisodesTotal(5000)→ 422 语义整体拒绝;
 *   - field_length_exceeded  简介纯文本 >4096 → 整体拒绝(不截断;data-model §1)。
 * 显示级 unsupported(解析成功,仅条目标记;data-model §2「重复/空 key 详情显示 unsupported」):
 *   - 线:空 key 或归一后重复 key 的镜像段(第 2+ 次出现)→ 整线 status=unsupported,
 *     其全部集 unsupported/identity_ambiguous;不合并、保序;首现保持 candidate
 *     (依据:夹具世界二注释「镜像线→该线 unsupported」,首线为 well-formed 主线,
 *     保守语义只需剥夺镜像线的定位资格,不需要连带降级主线);
 *   - 集:label 空(episodeKey=null)或同线归一后重复 key(两处都标)→
 *     status=unsupported, reason=identity_ambiguous;
 *   - format_unsupported 在解析层不产生:格式/协议问题一律整体拒绝,该枚举值留给上层
 *     定位/probe 阶段(api §1 VodPreview.reason 三值枚举的第三值)。
 *
 * 用例↔契约映射:基线=世界一 happy path 锁面;A 身份规范化(data-model §1);B 线路
 * (data-model §2 vod_line「(title_id,line_key)唯一;重复/空key详情显示unsupported」);
 * C 分集(§2 vod_episode「(line_id,episode_key)唯一」+ T023 原文「不把第01集自动等价为
 * 第1集」);D 同名不同版本(世界三/api §1 SwitchCandidate.versionLabel);E 完整性与协议
 * (T025 原文「预算和完整性校验失败整体拒绝」);F 预算(vod-budgets.ts detail 组 +
 * api §2「最多20线路/单线2000/合计5000/4MiB,超限422整次失败」);G URL token
 * (data-model §3)。
 */

/* ------------------------------------------------------------------ */
/* 夹具世界与常量(纯构造,零网络)                                        */
/* ------------------------------------------------------------------ */

const SERIAL_ORIGIN = 'http://127.0.0.1:18081';

/** 世界一:三集连续剧(同线明确 N+1,happy path 基线) */
const serialWorld = createThreeEpisodeSerialWorld(SERIAL_ORIGIN);
/** 世界二:缺集(01/02/04)+ 备用线重复集键('第02集'×2)+ 三条不同名线 */
const gappedWorld = createGappedDuplicateWorld('http://127.0.0.1:18082');
/** 世界三:同名版本冲突两端(2019 剧场版 / 2023 导演剪辑版) */
const theatricalWorld = createVersionConflictWorld('http://127.0.0.1:18081', 'theatrical');
const directorsCutWorld = createVersionConflictWorld('http://127.0.0.1:18083', 'directors-cut');

/** 详情级预算(T019 vod-budgets detail 组:20 线/单线 2000/总 5000/4MiB) */
const detailBudgets: { budgets: VodDetailBudget } = { budgets: VOD_BUDGETS.detail };

/** 定制 wire 单集段 */
interface CustomEpisode {
  label: string;
  url: string;
}

/** 定制 wire 线段 */
interface CustomLine {
  name: string;
  episodes: readonly CustomEpisode[];
}

/** 定制条目缺省集地址(绝对 http(s),scheme 校验通过) */
const EP_URL = `${SERIAL_ORIGIN}/vod/hls/custom/master.m3u8`;

function episode(label: string, url: string = EP_URL): CustomEpisode {
  return { label, url };
}

/** 以世界一片目为模板重写线格式构造定制 wire 条目(其余字段继承模板) */
function customItem(input: { lines: readonly CustomLine[] }, overrides: Partial<AppleCmsVodItem> = {}): AppleCmsVodItem {
  const playFrom = input.lines.map((line) => line.name).join('$$$');
  const playUrl = input.lines
    .map((line) => line.episodes.map((seg) => `${seg.label}$${seg.url}`).join('#'))
    .join('$$$');
  return { ...serialWorld.item, vod_play_from: playFrom, vod_play_url: playUrl, ...overrides };
}

/** 世界一片目的集定位地址首段替换为带轮转 sign token 的地址(G 组用) */
function retokenizedSerialItem(): AppleCmsVodItem {
  const playUrl = serialWorld.item.vod_play_url
    .split('$$$')
    .map((lineSegment) => lineSegment
      .split('#')
      .map((segment, index) => (index === 0 ? `${segment}?sign=rotated-token` : segment))
      .join('#'))
    .join('$$$');
  return { ...serialWorld.item, vod_play_url: playUrl };
}

/* ------------------------------------------------------------------ */
/* 断言辅助                                                            */
/* ------------------------------------------------------------------ */

/** 断言运行抛出指定 code 的 ProviderParseError(整体拒绝语义载体) */
function expectProviderReject(code: ProviderParseErrorCode, run: () => unknown): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught, `预期抛 ProviderParseError(${code}),实际:${String(caught)}`).toBeInstanceOf(ProviderParseError);
  expect((caught as ProviderParseError).code).toBe(code);
}

/** 取搜索条目(带类型收窄;缺条目即测试失败) */
function requireItem(items: readonly ParsedVodSearchItem[], index: number): ParsedVodSearchItem {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`解析结果缺条目 index=${index}`);
  }
  return item;
}

/** 剥离 locator 后的详情视图(G 组:除 locator 外逐项相等) */
function withoutLocators(detail: ParsedVodTitleDetail): ParsedVodTitleDetail {
  return {
    ...detail,
    lines: detail.lines.map((line: ParsedVodLine) => ({
      ...line,
      episodes: line.episodes.map(({ locatorUrl: _locatorUrl, ...episodeView }: ParsedVodEpisode) => episodeView),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* 基线:世界一 happy path 锁面                                          */
/* ------------------------------------------------------------------ */

describe('基线:世界一(三集连续剧)解析锁面', () => {
  it('正常详情 wire → identity/title/synopsis/year/evidence=unverified/单线三候选集/locator=详情播放入口', () => {
    const detail = parseDetail(serialWorld.item, detailBudgets);
    expect(detail.identity).toEqual({
      upstreamVodId: '1001',
      name: 'fixture·星尘信使',
      year: '2024',
      version: null,
    });
    expect(detail.title).toBe('fixture·星尘信使');
    expect(detail.year).toBe('2024');
    expect(detail.synopsis).toBe(serialWorld.seed.synopsis ?? null);
    expect(detail.evidence).toBe('unverified'); // T025:基础证据恒 unverified
    expect(detail.lines).toHaveLength(1);
    const line = detail.lines[0];
    expect(line?.lineKey).toBe('fixture正片');
    expect(line?.displayName).toBe('fixture正片');
    expect(line?.sortOrder).toBe(1);
    expect(line?.status).toBe('candidate');
    expect(line?.episodes.map((ep: ParsedVodEpisode) => [ep.episodeKey, ep.label, ep.status, ep.reason])).toEqual([
      ['第01集', '第01集', 'candidate', null],
      ['第02集', '第02集', 'candidate', null],
      ['第03集', '第03集', 'candidate', null],
    ]);
    expect(line?.episodes[0]?.locatorUrl).toBe(`${SERIAL_ORIGIN}/vod/hls/1001/ep-01/master.m3u8`);
  });

  it('搜索列表(brief 形态,播放字段为空)正常解析:空播放字段不影响搜索级解析', () => {
    const items = parseSearchList(buildAppleCmsListDocument([serialWorld.briefItem, gappedWorld.briefItem]));
    expect(items).toHaveLength(2);
    expect(items.map((item: ParsedVodSearchItem) => item.identity.upstreamVodId)).toEqual(['1001', '1002']);
    expect(items[0]?.title).toBe('fixture·星尘信使');
    expect(items[0]?.year).toBe('2024');
    expect(items[0]?.remarks).toBe('连载完毕 共3集');
  });
});

/* ------------------------------------------------------------------ */
/* A. 身份规范化(NFC+trim,1–255,不得截断身份)                          */
/* ------------------------------------------------------------------ */

describe('A. 身份规范化:data-model §1「NFC+trim 不得截断身份」', () => {
  it('normalizeIdentity 仅做 NFC 归一 + 首尾 trim;不做宽度/大小写折叠(NFKC/小写化都超出契约)', () => {
    // NFC:分解序列(e + U+0301)归一为组合字符(U+00E9)
    expect(normalizeIdentity('cafe\u0301')).toBe('caf\u00e9');
    // trim:ASCII 空白/制表符/全角空格(U+3000,JS trim 语义内)
    expect(normalizeIdentity('  \t第01集\u3000')).toBe('第01集');
    // 仅 NFC:全角不折叠为半角、数字不折算
    expect(normalizeIdentity('Ｍain')).toBe('Ｍain');
    expect(normalizeIdentity('Ｍain')).not.toBe('Main');
    expect(normalizeIdentity('１')).toBe('１');
    expect(normalizeIdentity('１')).not.toBe('1');
  });

  it('NFC/trim 落到解析键:线名/集名/标题名带首尾空白与分解序列时,暴露归一后的键与展示名', () => {
    const item = customItem(
      {
        lines: [
          {
            name: '  cafe\u0301线\u3000', // 分解 NFC + 首尾空白
            episodes: [{ label: ' 第01集 ', url: EP_URL }],
          },
        ],
      },
      { vod_name: '  星尘信使\u3000' },
    );
    const detail = parseDetail(item, detailBudgets);
    expect(detail.title).toBe('星尘信使');
    expect(detail.identity.name).toBe('星尘信使');
    expect(detail.lines).toHaveLength(1);
    expect(detail.lines[0]?.lineKey).toBe('caf\u00e9线');
    expect(detail.lines[0]?.displayName).toBe('caf\u00e9线');
    expect(detail.lines[0]?.episodes[0]?.episodeKey).toBe('第01集');
    expect(detail.lines[0]?.episodes[0]?.label).toBe('第01集');
  });

  it('1–255 边界:255(NFC 后)合法且逐字保留;256 → identity_key_invalid 整体拒绝且任何位置不截断', () => {
    const key255 = 'k'.repeat(255);
    const ok = parseDetail(customItem({ lines: [{ name: key255, episodes: [episode('第1集')] }] }), detailBudgets);
    expect(ok.lines[0]?.lineKey).toBe(key255);
    expect(ok.lines[0]?.lineKey).toHaveLength(255);

    const key256 = 'k'.repeat(256);
    expectProviderReject('identity_key_invalid', () =>
      parseDetail(customItem({ lines: [{ name: key256, episodes: [episode('第1集')] }] }), detailBudgets),
    );
    // 不得截断:归一层不得把 256 截成 255 冒充合法身份
    expect(normalizeIdentity(key256)).toHaveLength(256);
    // 集键同口径:256 字符 label 同样整体拒绝
    expectProviderReject('identity_key_invalid', () =>
      parseDetail(customItem({ lines: [{ name: '线', episodes: [episode('e'.repeat(256))] }] }), detailBudgets),
    );
  });

  it('1–255 按 NFC 归一后的长度计:原始超 255 个 UTF-16 单元、归一后 ≤255 的键合法', () => {
    // 128 组 e+U+0301(原始 256 单元)NFC 后为 128 字符 → 合法
    const decomposed128 = 'e\u0301'.repeat(128);
    const detail = parseDetail(
      customItem({ lines: [{ name: decomposed128, episodes: [episode('第1集')] }] }),
      detailBudgets,
    );
    expect(detail.lines[0]?.lineKey).toBe('\u00e9'.repeat(128));
    expect(detail.lines[0]?.lineKey).toHaveLength(128);
  });

  it('归一不得制造两个身份:分解/组合是同一语义键(归一相等 → 判重复);宽度异形是不同键(不误判重复)', () => {
    // 分解与组合归一后相等 → 第二条为重复 key 镜像线(unsupported),不是新的候选身份
    const sameKey = parseDetail(
      customItem({
        lines: [
          { name: 'caf\u00e9线', episodes: [episode('第1集')] },
          { name: 'cafe\u0301线', episodes: [episode('第2集')] },
        ],
      }),
      detailBudgets,
    );
    expect(sameKey.lines).toHaveLength(2); // 不合并
    expect(sameKey.lines[0]?.status).toBe('candidate');
    expect(sameKey.lines[1]?.status).toBe('unsupported');
    expect(sameKey.lines[1]?.lineKey).toBe('caf\u00e9线');
    // 全角 Ｍain 与半角 Main 是不同键(NFC 不折叠宽度)→ 两条都是独立候选线
    const distinctKeys = parseDetail(
      customItem({
        lines: [
          { name: 'Main', episodes: [episode('第1集')] },
          { name: 'Ｍain', episodes: [episode('第2集')] },
        ],
      }),
      detailBudgets,
    );
    expect(distinctKeys.lines).toHaveLength(2);
    for (const line of distinctKeys.lines) {
      expect(line.status).toBe('candidate');
    }
  });

  it('标题名空(vod_name 纯空白)→ identity_key_invalid 整体拒绝(标题身份无空形态)', () => {
    expectProviderReject('identity_key_invalid', () =>
      parseSearchList(buildAppleCmsListDocument([{ ...serialWorld.briefItem, vod_name: '  \u3000' }])),
    );
  });
});

/* ------------------------------------------------------------------ */
/* B. 线路:空/重复 key、超长展示名、保序                                 */
/* ------------------------------------------------------------------ */

describe('B. 线路:data-model §2 vod_line「重复/空 key 详情显示 unsupported」', () => {
  it('extractLines 按 wire 形态 $$$/#/$ 拆线;线键=归一线显示名;线与集全保序(sortOrder=wire 位置,1 起)', () => {
    const lines = extractLines(gappedWorld.item, { budgets: VOD_BUDGETS.detail });
    expect(lines.map((line: ParsedVodLine) => line.lineKey)).toEqual(['fixture主线', 'fixture备用线路', 'fixture镜像线路']);
    expect(lines.map((line: ParsedVodLine) => line.sortOrder)).toEqual([1, 2, 3]);
    expect(lines[0]?.episodes.map((ep: ParsedVodEpisode) => ep.episodeKey)).toEqual(['第01集', '第02集', '第04集']);
    expect(lines[0]?.episodes.map((ep: ParsedVodEpisode) => ep.status)).toEqual(['candidate', 'candidate', 'candidate']);
  });

  it('世界二 wire 实况:三条不同显示名线各为独立候选线(种子层镜像线不构成 wire 级重复,见文件头键推导契约)', () => {
    const detail = parseDetail(gappedWorld.item, detailBudgets);
    expect(detail.lines.map((line: ParsedVodLine) => line.status)).toEqual(['candidate', 'candidate', 'candidate']);
  });

  it('空线路 key(vod_play_from 空/纯空白段)→ 该线 unsupported(lineKey=null),不整体失败', () => {
    const detail = parseDetail(
      customItem({
        lines: [
          { name: 'fixture正片', episodes: [episode('第1集')] },
          { name: '', episodes: [episode('第2集')] }, // 空名段
          { name: '   ', episodes: [episode('第3集')] }, // 纯空白段,trim 后同为空
        ],
      }),
      detailBudgets,
    );
    expect(detail.lines).toHaveLength(3);
    expect(detail.lines[0]?.status).toBe('candidate');
    for (const line of detail.lines.slice(1)) {
      expect(line.status).toBe('unsupported');
      expect(line.lineKey).toBeNull();
      for (const ep of line.episodes) {
        expect(ep.status).toBe('unsupported');
        expect(ep.reason).toBe('identity_ambiguous');
      }
    }
  });

  it('重复 line_key(归一后同名段)→ 镜像线整线 unsupported、不合并;首现保持 candidate(夹具世界二注释「镜像线→该线 unsupported」)', () => {
    const detail = parseDetail(
      customItem({
        lines: [
          { name: 'fixture正片', episodes: [episode('第1集')] },
          { name: 'fixture正片 ', episodes: [episode('第2集')] }, // trim 后与首线同名 → 重复 key
        ],
      }),
      detailBudgets,
    );
    expect(detail.lines).toHaveLength(2);
    expect(detail.lines[0]?.status).toBe('candidate');
    expect(detail.lines[1]?.status).toBe('unsupported');
    expect(detail.lines[1]?.sortOrder).toBe(2); // 不合并且保序
    expect(detail.lines[1]?.episodes[0]?.status).toBe('unsupported');
    expect(detail.lines[1]?.episodes[0]?.reason).toBe('identity_ambiguous');
  });

  it('线显示名 >255(NFC+trim 后)→ identity_key_invalid 整体拒绝(展示名 1–255 + 不得截断身份;不可标 unsupported 后仍落超长列)', () => {
    expectProviderReject('identity_key_invalid', () =>
      parseDetail(customItem({ lines: [{ name: 'n'.repeat(256), episodes: [episode('第1集')] }] }), detailBudgets),
    );
  });
});

/* ------------------------------------------------------------------ */
/* C. 分集:重复 key、第01集≠第1集、缺集不猜补、空 label                  */
/* ------------------------------------------------------------------ */

describe('C. 分集:data-model §2 vod_episode「(line_id,episode_key)唯一」+ T023 原文', () => {
  it('同线重复 episode_key → 两处都 unsupported/identity_ambiguous;跨线同 key 不受影响(key 作用域=线);特典不牵连', () => {
    const detail = parseDetail(gappedWorld.item, detailBudgets);
    const main = detail.lines[0];
    const backup = detail.lines[1];
    // 主线 '第02集' 正常候选(与备用线同 label 不同线,互不影响)
    expect(main?.episodes[1]?.episodeKey).toBe('第02集');
    expect(main?.episodes[1]?.status).toBe('candidate');
    expect(main?.episodes[1]?.reason).toBeNull();
    // 备用线两个 '第02集' → 两处都 ambiguous,都不合并丢弃
    const duplicated = backup?.episodes.slice(0, 2) ?? [];
    expect(duplicated).toHaveLength(2);
    for (const ep of duplicated) {
      expect(ep.status).toBe('unsupported');
      expect(ep.reason).toBe('identity_ambiguous');
      expect(ep.episodeKey).toBe('第02集');
    }
    // 同线特典 SP00 不受牵连
    expect(backup?.episodes[2]?.episodeKey).toBe('特典·制作花絮');
    expect(backup?.episodes[2]?.status).toBe('candidate');
    expect(backup?.episodes[2]?.reason).toBeNull();
  });

  it('缺集世界不猜补、不重排:01/02/04 原样输出,无第03集、不重编为 1/2/3(T023 原文;data-model §2 缺集不能跳)', () => {
    const detail = parseDetail(gappedWorld.item, detailBudgets);
    const main = detail.lines[0];
    expect(main?.episodes).toHaveLength(3);
    expect(main?.episodes.map((ep: ParsedVodEpisode) => ep.episodeKey)).toEqual(['第01集', '第02集', '第04集']);
    expect(main?.episodes.map((ep: ParsedVodEpisode) => ep.status)).toEqual(['candidate', 'candidate', 'candidate']);
    // 不自动造第 03 集
    expect(main?.episodes.some((ep: ParsedVodEpisode) => ep.episodeKey === '第03集')).toBe(false);
  });

  it('不把第01集自动等价为第1集:字符串级身份,不数值化、不合并、不重写(T023 原文钉死)', () => {
    expect(normalizeIdentity('第01集')).not.toBe(normalizeIdentity('第1集'));
    const detail = parseDetail(
      customItem({
        lines: [{ name: 'fixture正片', episodes: [episode('第1集'), episode('第01集')] }],
      }),
      detailBudgets,
    );
    const episodes = detail.lines[0]?.episodes ?? [];
    expect(episodes).toHaveLength(2);
    expect(episodes.map((ep: ParsedVodEpisode) => ep.episodeKey)).toEqual(['第1集', '第01集']);
    for (const ep of episodes) {
      expect(ep.status).toBe('candidate');
      expect(ep.reason).toBeNull();
    }
  });

  it('label 空/纯空白 → 该集 unsupported/identity_ambiguous 且 episodeKey=null,解析不整体失败', () => {
    const detail = parseDetail(
      customItem({
        lines: [{ name: 'fixture正片', episodes: [episode('第1集'), episode(''), episode('  ')] }],
      }),
      detailBudgets,
    );
    const episodes = detail.lines[0]?.episodes ?? [];
    expect(episodes).toHaveLength(3);
    expect(episodes[0]?.status).toBe('candidate');
    expect(episodes[1]).toMatchObject({ episodeKey: null, status: 'unsupported', reason: 'identity_ambiguous' });
    expect(episodes[2]).toMatchObject({ episodeKey: null, status: 'unsupported', reason: 'identity_ambiguous' });
  });

  it('wire 语法:名称$地址按首个 $ 分割,地址含 $ 时不得被吞进 label($ 为名称/地址保留分隔符)', () => {
    const urlWithDollar = `${SERIAL_ORIGIN}/vod/hls/custom/p$a/master.m3u8`;
    const detail = parseDetail(
      customItem({ lines: [{ name: 'fixture正片', episodes: [{ label: '第1集', url: urlWithDollar }] }] }),
      detailBudgets,
    );
    const ep = detail.lines[0]?.episodes[0];
    expect(ep?.episodeKey).toBe('第1集');
    expect(ep?.locatorUrl).toBe(urlWithDollar);
    expect(ep?.status).toBe('candidate');
  });
});

/* ------------------------------------------------------------------ */
/* D. 同名不同版本:年份/版本后缀参与标题身份                              */
/* ------------------------------------------------------------------ */

describe('D. 版本身份:同名不同版本解析为不同 title 身份(世界三)', () => {
  it('搜索列表:同名两端并存不合并,身份按 upstreamVodId+年份+版本相异(api §1 SwitchCandidate.versionLabel 语义)', () => {
    const items = parseSearchList(buildAppleCmsListDocument([theatricalWorld.briefItem, directorsCutWorld.briefItem]));
    expect(items).toHaveLength(2);
    const theatrical = requireItem(items, 0);
    const directorsCut = requireItem(items, 1);
    expect(theatrical.identity.name).toBe(directorsCut.identity.name); // 同名:'fixture·回声双城'
    expect(theatrical.identity.upstreamVodId).toBe('1003');
    expect(directorsCut.identity.upstreamVodId).toBe('2003');
    expect(theatrical.identity.year).toBe('2019');
    expect(directorsCut.identity.year).toBe('2023');
    expect(theatrical.identity.version).toBe('剧场版');
    expect(directorsCut.identity.version).toBe('导演剪辑版');
    expect(providerIdentityEquals(theatrical.identity, directorsCut.identity)).toBe(false);
  });

  it('详情:同名两端解析为不同 title 身份;无版本/年份字段时身份分量为 null(世界一对照)', () => {
    const theatrical = parseDetail(theatricalWorld.item, detailBudgets);
    const directorsCut = parseDetail(directorsCutWorld.item, detailBudgets);
    expect(theatrical.identity.name).toBe('fixture·回声双城');
    expect(directorsCut.identity.name).toBe('fixture·回声双城');
    expect(theatrical.identity.year).toBe('2019');
    expect(directorsCut.identity.year).toBe('2023');
    expect(theatrical.identity.version).toBe('剧场版');
    expect(directorsCut.identity.version).toBe('导演剪辑版');
    expect(providerIdentityEquals(theatrical.identity, directorsCut.identity)).toBe(false);
    // 对照:有年份、无版本 → version=null
    const serial = parseDetail(serialWorld.item, detailBudgets);
    expect(serial.identity.year).toBe('2024');
    expect(serial.identity.version).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* E. 完整性与协议失败:整体拒绝,绝不判 missing                          */
/* ------------------------------------------------------------------ */

describe('E. 完整性/协议:T025「预算和完整性校验失败整体拒绝」', () => {
  it('列表信封截断:code!==1 / list 字段缺失 / 条目缺 vod_id → integrity_violation 整体拒绝', () => {
    const good = buildAppleCmsListDocument([serialWorld.briefItem]);
    expectProviderReject('integrity_violation', () => parseSearchList({ ...good, code: 0 }));
    expectProviderReject('integrity_violation', () =>
      parseSearchList({ ...good, list: undefined as unknown as AppleCmsVodItem[] }),
    );
    expectProviderReject('integrity_violation', () =>
      parseSearchList(buildAppleCmsListDocument([{ ...serialWorld.briefItem, vod_id: undefined as unknown as number }])),
    );
  });

  it('详情条目缺 play 字段(空 vod_play_from/vod_play_url)→ integrity_violation 整体拒绝(钉死「整体拒绝」分支:不判 missing、不产出空线详情;依据 data-model §3「失败/截断不发布」)', () => {
    expectProviderReject('integrity_violation', () =>
      parseDetail({ ...serialWorld.item, vod_play_from: '', vod_play_url: '' }, detailBudgets),
    );
    expectProviderReject('integrity_violation', () =>
      parseDetail({ ...serialWorld.item, vod_play_url: '' }, detailBudgets),
    );
  });

  it('单集地址缺失(label$url 空 url 段)→ integrity_violation 整体拒绝(同上钉死依据,不标 unsupported)', () => {
    expectProviderReject('integrity_violation', () =>
      parseDetail(customItem({ lines: [{ name: 'fixture正片', episodes: [episode('第1集', '')] }] }), detailBudgets),
    );
  });

  it('线格式段错位(from 与 url 段数不一致,截断形态)→ integrity_violation', () => {
    expectProviderReject('integrity_violation', () =>
      parseDetail(
        {
          ...serialWorld.item,
          vod_play_from: 'fixture正片$$$fixture备用线路',
          vod_play_url: ['第1集', '第2集', '第3集'].map((label) => `${label}$${EP_URL}`).join('$$$'),
        },
        detailBudgets,
      ),
    );
  });

  it('详情信封:parseDetailDocument 对 code!==1 / 空 list / 多条目 → integrity_violation(详情响应必须恰含所请求一部影片);正常信封解包与直接条目解析等值', () => {
    const envelope = buildAppleCmsListDocument([serialWorld.item]);
    expectProviderReject('integrity_violation', () => parseDetailDocument({ ...envelope, code: 0 }, detailBudgets));
    expectProviderReject('integrity_violation', () => parseDetailDocument({ ...envelope, list: [] }, detailBudgets));
    expectProviderReject('integrity_violation', () =>
      parseDetailDocument(buildAppleCmsListDocument([serialWorld.item, gappedWorld.item]), detailBudgets),
    );
    expect(parseDetailDocument(envelope, detailBudgets)).toEqual(parseDetail(serialWorld.item, detailBudgets));
  });

  it('协议失败:播放地址非绝对 http(s)(ftp/相对/伪协议)→ protocol_unsupported 整体拒绝(api §2「只接受http(s)」同口径)', () => {
    for (const url of ['ftp://127.0.0.1:18081/x/master.m3u8', '/vod/hls/relative/master.m3u8', 'javascript:alert(1)']) {
      expectProviderReject('protocol_unsupported', () =>
        parseDetail(customItem({ lines: [{ name: 'fixture正片', episodes: [episode('第1集', url)] }] }), detailBudgets),
      );
    }
  });

  it('https 合法:https 定位地址正常解析为 candidate(白名单为 http(s) 二者,非 http-only)', () => {
    const detail = parseDetail(
      customItem({
        lines: [{ name: 'fixture正片', episodes: [episode('第1集', 'https://vod.example.test/master.m3u8')] }],
      }),
      detailBudgets,
    );
    expect(detail.lines[0]?.episodes[0]?.status).toBe('candidate');
  });
});

/* ------------------------------------------------------------------ */
/* F. 预算:超 detail 上限 → 422 语义整体拒绝                             */
/* ------------------------------------------------------------------ */

describe('F. 预算:vod-budgets detail 组 + api §2「超限422整次失败」(budget_exceeded 载体)', () => {
  it('线数 >detail.maxLines(20)→ budget_exceeded;恰 20 条线合法', () => {
    const lines21 = Array.from({ length: 21 }, (_, index) => ({
      name: `线路${String(index + 1).padStart(2, '0')}`,
      episodes: [episode(`第${index + 1}集`)],
    }));
    expectProviderReject('budget_exceeded', () => parseDetail(customItem({ lines: lines21 }), detailBudgets));
    const ok = parseDetail(customItem({ lines: lines21.slice(0, 20) }), detailBudgets);
    expect(ok.lines).toHaveLength(20);
  });

  it('单线集数 >detail.maxEpisodesPerLine(2000)→ budget_exceeded;恰 2000 合法', () => {
    const many = Array.from({ length: 2001 }, (_, index) => episode(`第${index + 1}集`));
    expectProviderReject('budget_exceeded', () =>
      parseDetail(customItem({ lines: [{ name: 'fixture正片', episodes: many }] }), detailBudgets),
    );
    const ok = parseDetail(
      customItem({ lines: [{ name: 'fixture正片', episodes: many.slice(0, 2000) }] }),
      detailBudgets,
    );
    expect(ok.lines[0]?.episodes).toHaveLength(2000);
    expect(ok.lines[0]?.episodes[0]?.status).toBe('candidate');
  });

  it('合计集数 >detail.maxEpisodesTotal(5000)→ budget_exceeded(3 线 × 2000 = 6000,单线均不超限)', () => {
    const perLine = Array.from({ length: 2000 }, (_, index) => episode(`第${index + 1}集`));
    const lines = ['线路一', '线路二', '线路三'].map((name) => ({ name, episodes: perLine }));
    expectProviderReject('budget_exceeded', () => parseDetail(customItem({ lines }), detailBudgets));
  });

  it('简介纯文本 >4096 → field_length_exceeded 整体拒绝(钉死「拒绝超限」最保守形态,data-model §1「简介纯文本<=4096」逐字;4096 恰界合法;不截断)', () => {
    const ok = parseDetail(
      { ...serialWorld.item, vod_blurb: 'a'.repeat(4096), vod_content: `<p>${'a'.repeat(4096)}</p>` },
      detailBudgets,
    );
    expect(ok.synopsis).toBe('a'.repeat(4096));
    expectProviderReject('field_length_exceeded', () =>
      parseDetail(
        { ...serialWorld.item, vod_blurb: 'a'.repeat(4097), vod_content: `<p>${'a'.repeat(4097)}</p>` },
        detailBudgets,
      ),
    );
  });

  it('简介无内容(vod_blurb/vod_content 均空)→ synopsis=null', () => {
    const detail = parseDetail({ ...serialWorld.item, vod_blurb: '', vod_content: '' }, detailBudgets);
    expect(detail.synopsis).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* G. URL token 更新:只体现为 locator,不改变身份/键/状态                 */
/* ------------------------------------------------------------------ */

describe('G. URL token 更新:data-model §3「URL token 变化不加 catalogRevision/不单独推进 sequenceRevision」', () => {
  it('同片目仅集定位地址的 sign token 变化 → identity 相等、除 locator 外逐项相等、locator 反映新 token、不引入任何 unsupported', () => {
    const before = parseDetail(serialWorld.item, detailBudgets);
    const after = parseDetail(retokenizedSerialItem(), detailBudgets);
    expect(providerIdentityEquals(before.identity, after.identity)).toBe(true);
    expect(withoutLocators(after)).toEqual(withoutLocators(before)); // 键/标签/状态/顺序逐项不变
    const beforeUrl = before.lines[0]?.episodes[0]?.locatorUrl;
    const afterUrl = after.lines[0]?.episodes[0]?.locatorUrl;
    expect(afterUrl).not.toBe(beforeUrl);
    expect(afterUrl).toContain('sign=rotated-token');
    // token 变化不是格式/协议问题:全部集保持 candidate
    expect(after.lines[0]?.episodes.every((ep: ParsedVodEpisode) => ep.status === 'candidate')).toBe(true);
  });

  it('键不携带 URL 信息:地址变化前后 lineKey/episodeKey 逐字符相等(键基于 wire 标签,不基于地址)', () => {
    const keysOf = (detail: ParsedVodTitleDetail): unknown =>
      detail.lines.map((line: ParsedVodLine) => [line.lineKey, line.episodes.map((ep: ParsedVodEpisode) => ep.episodeKey)]);
    expect(keysOf(parseDetail(retokenizedSerialItem(), detailBudgets))).toEqual(keysOf(parseDetail(serialWorld.item, detailBudgets)));
  });
});

describe('H. 海报地址(vod_pic):展示级解析,丢弃不整体拒绝', () => {
  it('合法 http(s) vod_pic:NFC+trim 后逐字透传(搜索与详情同口径)', () => {
    const pic = ' http://img.example.com/pic/星尘.jpg ';
    const items = parseSearchList(buildAppleCmsListDocument([{ ...serialWorld.briefItem, vod_pic: pic }]));
    const detail = parseDetail(
      customItem({ lines: [{ name: serialWorld.item.vod_play_from, episodes: [episode('第01集')] }] }, { vod_pic: pic }),
      detailBudgets,
    );
    expect(items[0]?.posterUrl).toBe('http://img.example.com/pic/星尘.jpg');
    expect(detail.posterUrl).toBe('http://img.example.com/pic/星尘.jpg');
  });

  it('缺失/空白 vod_pic → null(上游未给不制造,不判完整性失败)', () => {
    const items = parseSearchList(buildAppleCmsListDocument([serialWorld.briefItem]));
    expect(items[0]?.posterUrl).toBeNull();
    const blank = parseSearchList(buildAppleCmsListDocument([{ ...serialWorld.briefItem, vod_pic: '   ' }]));
    expect(blank[0]?.posterUrl).toBeNull();
    const detail = parseDetail(
      customItem({ lines: [{ name: serialWorld.item.vod_play_from, episodes: [episode('第01集')] }] }),
      detailBudgets,
    );
    expect(detail.posterUrl).toBeNull();
  });

  it('非 http(s) 海报地址 → 丢弃置 null(展示降级,不触发 protocol_unsupported 整体拒绝)', () => {
    const items = parseSearchList(buildAppleCmsListDocument([{ ...serialWorld.briefItem, vod_pic: 'ftp://img.example.com/pic.jpg' }]));
    expect(items[0]?.posterUrl).toBeNull();
    expect(items).toHaveLength(1);
  });

  it('超 2048 海报地址 → 丢弃置 null(展示降级,不判 field_length_exceeded)', () => {
    const long = `https://img.example.com/${'a'.repeat(2100)}.jpg`;
    const items = parseSearchList(buildAppleCmsListDocument([{ ...serialWorld.briefItem, vod_pic: long }]));
    expect(items[0]?.posterUrl).toBeNull();
  });
});
