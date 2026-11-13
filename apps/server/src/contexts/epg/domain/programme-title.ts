/**
 * 020 TMDB 节目海报：标题归一化纯函数（零 IO、零框架）。
 *
 * 目标：让同一节目在不同 EPG 源/频道/刷新中的标题收敛到稳定的 matchKey，
 * 供 programme_poster 缓存主键与 TMDB 完全匹配使用；同时保留可检索的
 * searchQuery 与年份提示。
 *
 * 规则（data-model §2 / research R2）：
 * - NFKC（全角→半角）、折叠空白；
 * - 提取并去掉括号年份（记录 yearHint）；
 * - 去掉括号内的清晰度/语言/季集/年份噪声标签；
 * - 去掉栏目前缀（电影：/电视剧：/…）；
 * - 去掉季集标记（第N集/第N季/SxxExx/EPxx）；
 * - 去掉带分隔符的首尾质量/语言标签；
 * - matchKey = searchQuery 去标点/空白/符号并小写；用于精确比较与缓存主键；
 * - 通用栏目停用表 → matchKey=null（不请求 TMDB、不写缓存）。
 *
 * 保守原则：不做模糊/拼音/别名匹配；无法确定宁可不匹配。
 */

/** 通用栏目/非影视节目标题（归一化后的精确键；只做精确匹配，避免误伤《新闻女郎》等）。 */
const NON_TITLE_KEYS: ReadonlySet<string> = new Set([
  '新闻联播',
  '新闻直播间',
  '新闻30分',
  '朝闻天下',
  '晚间新闻',
  '午间新闻',
  '新闻夜航',
  '天气预报',
  '焦点访谈',
  '今日说法',
  '东方时空',
  '共同关注',
  '国际时讯',
  '体育新闻',
  '体坛快讯',
  '财经新闻',
  '第一时间',
  '交易时间',
  '股市',
  '广告',
  '购物',
  '电视购物',
  '电视剧',
  '连续剧',
  '电影',
  '剧场',
  '纪录片',
  '动画片',
  '动画片剧场',
  '动漫',
  '综艺',
  '戏曲',
  '栏目',
  '专题',
  '专题片',
  '宣传片',
  '精彩节目',
  '黄金剧场',
  '经典剧场',
  '晚间剧场',
  '午夜剧场',
  '上午剧场',
  '下午剧场',
  '阳光剧场',
  '清晨剧场',
  '下午茶剧场',
  '白天剧场',
  '纪录时间',
  '中国新闻',
  '转播中央台新闻联播',
  '转播中央新闻联播',
  '中华人民共和国国歌',
  '创收栏目',
  '节目预告',
  '下集预告',
  '下节预告',
  '节目预告片',
  '休息一下',
  '测试',
  '暂无节目',
  '敬请收看',
  '本台节目',
  '中间广告',
  '天气',
  '新闻',
  '资讯',
]);

/** 质量/语言/来源标签（括号内或带分隔符的首尾出现时剥离）。 */
const NOISE_TAGS: readonly string[] = [
  '4K',
  '8K',
  'UHD',
  'HD',
  'FHD',
  '1080P',
  '720P',
  '2160P',
  '高清',
  '超清',
  '蓝光',
  '完整版',
  '未删减',
  '国语',
  '粤语',
  '中字',
  '双语',
  '重播',
  '首播',
  '直播',
  '新片',
  '热播',
  '推荐',
  '抢先版',
  'TS',
  'TC',
  'HDTV',
  'WEB-DL',
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TAG_ALT = NOISE_TAGS.map(escapeRegExp).join('|');
const TAG_ONLY = new RegExp(`^(?:${TAG_ALT})$`, 'i');
const TRAILING_TAG = new RegExp(`[\\s\\-–—_/|·:：,，]+(?:${TAG_ALT})\\s*$`, 'i');
const LEADING_TAG = new RegExp(`^(?:${TAG_ALT})[\\s\\-–—_/|·:：,，]+`, 'i');
const YEAR_IN_BRACKETS = /[（([【]\s*((?:19|20)\d{2})\s*[）)\]】]/;
const BRACKET_SEGMENT = /[（([【]\s*([^）)\]】]{0,48})\s*[）)\]】]/g;
const CATEGORY_PREFIX =
  /^(?:\d+\s*集)?(?:电视剧|连续剧|电影|纪录片|动画片|动漫|综艺|戏曲|专题片|栏目|剧场)\s*[:：]\s*/;
/** 「上午剧场:伪装者(22)」「1001夜剧场:生万物(4)」等栏目槽位前缀 */
const SLOT_PREFIX = /^[^:：]{1,14}(?:剧场|影院|影视频)\s*[:：]\s*/;
/** 八位日期前缀（20170921《辉煌中国》…）；避免误伤 4 位年份片名 */
const DATE_PREFIX = /^(?:19|20)\d{6}(?=\D)/;
const EPISODE_MARKERS: readonly RegExp[] = [
  /第\s*[0-9一二三四五六七八九十百零两]+\s*[集期话回]/g,
  /第\s*[0-9一二三四五六七八九十百零两]+\s*季/g,
  /\bS\d{1,2}\s*E\d{1,3}\b/gi,
  /\bS\d{1,2}\b/gi,
  /\bEP?\s*\d{1,4}\b/gi,
];
const LEADING_PUNCT = /^[\s\-–—_/|·:：,，.。!！?？、]+/;
const TRAILING_PUNCT = /[\s\-–—_/|·:：,，.。!！?？、]+$/;
const KEY_NOISE = /[\s\p{P}\p{S}]+/gu;

/** 括号内容是否为可剥离的噪声（年份/标签/季集标记，或短内容只由标签组成）。 */
function isNoiseBracket(content: string): boolean {
  const text = content.normalize('NFKC').trim();
  if (text === '') {
    return true;
  }
  if (/^(?:19|20)\d{2}$/.test(text)) {
    return true;
  }
  if (TAG_ONLY.test(text)) {
    return true;
  }
  // 纯集数/集数区间：(4)、（17）、(4-7)
  if (/^\d{1,3}$/.test(text) || /^\d{1,3}\s*[-–—]\s*\d{1,3}$/.test(text)) {
    return true;
  }
  if (EPISODE_MARKERS.some((pattern) => new RegExp(pattern.source, pattern.flags.replace('g', '')).test(text))) {
    return true;
  }
  // 短括号内只含已知标签/分隔符（如「高清 中字」「1080P 国语」）
  if (text.length <= 16) {
    const stripped = text
      .split(/[\s\-–—_/|·:：,，+]+/)
      .filter((part) => part !== '')
      .filter((part) => !TAG_ONLY.test(part));
    if (stripped.length === 0) {
      return true;
    }
  }
  return false;
}

function stripNoiseBrackets(text: string): string {
  return text.replace(BRACKET_SEGMENT, (full, content: string) => (isNoiseBracket(content) ? ' ' : full));
}

function stripTitlePrefixes(text: string): string {
  let next = text;
  for (let guard = 0; guard < 4; guard += 1) {
    const trimmed = next
      .replace(DATE_PREFIX, '')
      .replace(SLOT_PREFIX, '')
      .replace(CATEGORY_PREFIX, '')
      .trim();
    if (trimmed === next) {
      break;
    }
    next = trimmed;
  }
  return next;
}

function stripTagsAtEdges(text: string): string {
  let next = text;
  // 循环处理「标题 - 高清 - 国语」这类多重尾标签；正则非 global 避免 lastIndex 状态。
  for (let guard = 0; guard < 6; guard += 1) {
    const trimmed = next.replace(TRAILING_TAG, '').replace(LEADING_TAG, '');
    if (trimmed === next) {
      break;
    }
    next = trimmed;
  }
  return next;
}

function stripEpisodeMarkers(text: string): string {
  let next = text;
  for (const pattern of EPISODE_MARKERS) {
    next = next.replace(pattern, ' ');
  }
  return next;
}

/** 归一化结果；matchKey=null 表示明确不参与匹配（空/通用栏目/过长）。 */
export interface NormalizedProgrammeTitle {
  /** 精确比较/缓存主键；null=不参与匹配 */
  readonly matchKey: string | null;
  /** 提供给 TMDB 检索的文本；matchKey=null 时为 null */
  readonly searchQuery: string | null;
  /** 从括号年份提取的提示；无则 null */
  readonly yearHint: number | null;
  /** 明确拒绝的原因（诊断/测试用；不进入公共 DTO） */
  readonly reason: 'empty' | 'too_long' | 'non_title' | null;
}

/**
 * 归一化节目标题。纯函数：同输入同输出，不读取时钟/环境/数据库。
 */
export function normalizeProgrammeTitle(raw: string): NormalizedProgrammeTitle {
  if (typeof raw !== 'string') {
    return { matchKey: null, searchQuery: null, yearHint: null, reason: 'empty' };
  }
  let text = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');

  const yearMatch = YEAR_IN_BRACKETS.exec(text);
  const yearHint = yearMatch === null ? null : Number(yearMatch[1]);

  text = stripNoiseBrackets(text);
  text = stripTitlePrefixes(text);
  text = stripEpisodeMarkers(text);
  text = stripTagsAtEdges(text);
  text = text.replace(LEADING_PUNCT, '').replace(TRAILING_PUNCT, '');
  text = text.replace(/\s+/g, ' ').trim();

  if (text === '') {
    return { matchKey: null, searchQuery: null, yearHint, reason: 'empty' };
  }

  const matchKey = text.toLowerCase().replace(KEY_NOISE, '');
  if (matchKey.length < 2) {
    return { matchKey: null, searchQuery: null, yearHint, reason: 'empty' };
  }
  if (matchKey.length > 255) {
    return { matchKey: null, searchQuery: null, yearHint, reason: 'too_long' };
  }
  if (NON_TITLE_KEYS.has(matchKey)) {
    return { matchKey: null, searchQuery: null, yearHint, reason: 'non_title' };
  }

  return { matchKey, searchQuery: text, yearHint, reason: null };
}

/** 便捷函数：仅取缓存/匹配键；null=不参与匹配。 */
export function posterMatchKeyOf(raw: string): string | null {
  return normalizeProgrammeTitle(raw).matchKey;
}