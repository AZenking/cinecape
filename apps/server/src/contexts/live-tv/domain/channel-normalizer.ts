/**
 * 频道名称归一化(T005;016-research R1 清洗规则 / R2 Level 4 归一化比对、data-model §1.2
 * normalized_key 语义 —— 示例 "cctv1"、"zhejiang"):
 * - R1(多直播源聚合):M3U 条目名经本函数清除噪音后缀(`[4K]`/`1080P`/`HEVC`/`[IPv6]`/`(备份)`
 *   等)后命中相同 key,同一 Household 下自动合并为同一逻辑频道的备用线路;
 * - R2 Level 4(tvg-id 未命中时的兜底):对频道名与 EPG 库频道名做「去除标点、大小写、
 *   常见清晰度后缀」的归一化比对,作为别名映射表的归一化基准键;
 * - 归一化管线(全部确定性):BOM/零宽字符 → 全角转半角 → 小写 → 括注段整段剔除 →
 *   清晰度/编码/协议噪音词剔除(词边界防误伤)→ 分隔符与标点剔除(连成一串);
 * - 幂等:normalize(normalize(x)) == normalize(x)(输出形态必为「小写字母/数字/保留标点
 *   +/& + CJK」,重入各步骤均为不动点);结果为空串表示「无法归一化」,由调用方处理。
 *
 * 本模块为领域层纯函数:零 IO、零框架依赖(宪章原则 4/6)。
 *
 * 保守不做项(刻意保留,防止误合并/误拆分):
 * - 频道号类前缀(如 "01 CCTV-1" → "01cctv1"):无可靠判据,剥离收益低、误伤风险高;
 * - `+`、`&` 保留于键内:CCTV5+ 是独立于 CCTV5 的体育赛事频道,`+` 属频道身份而非噪音;
 * - 未做 NFC 折叠与本地别名映射(R2 Level 4 的别名表属持久化增强,非本纯函数职责)。
 */

/** 全角 → 半角偏移量(U+FF01–U+FF5E 减此值映射到 U+0021–U+007E) */
const FULLWIDTH_OFFSET = 0xfee0;

/** 不可见噪音字符:BOM/零宽字符/双向控制符/软连字符(爬取源常见,绝非频道身份) */
const INVISIBLE_PATTERN = /[\u{FEFF}\u{200B}-\u{200F}\u{2060}\u{00AD}]/gu;

/** 包裹性噪音段:对称括注([备份]/(金鹰)/【超清】;全角括号已在宽度折叠后归一为半角) */
const BRACKET_SEGMENT_PATTERN = /\[[^\][]*\]|\([^()]*\)|【[^【】]*】/g;

/** CJK 清晰度词(长词在前防残字:超高清 必须先于 高清 整词剔除,否则残留「超」) */
const CJK_NOISE_TOKENS = ['超高清', '高清', '超清', '标清', '蓝光'];

/** ASCII 清晰度/编码/协议噪音词(小写形态;长度降序排列保证同位最长优先匹配) */
const ASCII_NOISE_TOKENS = [
  '1080p',
  '1080i',
  '720p',
  '540p',
  '480p',
  'hevc',
  'h265',
  'h264',
  'ipv6',
  'ipv4',
  'uhd',
  'fhd',
  'avc',
  '4k',
  '8k',
  'hd',
  'sd',
];

/** 噪音词总表(长词在前);边界判定由替换回调逐处执行,正则本身不加词边界 */
const NOISE_TOKEN_PATTERN = new RegExp([...CJK_NOISE_TOKENS, ...ASCII_NOISE_TOKENS].join('|'), 'g');

/** 分隔符与标点:全部 Unicode 标点(P)与符号(S)及空白;保留例外见 KEEP_PUNCTUATION */
const SEPARATOR_PATTERN = /[\p{P}\p{S}\s]/gu;

/** 刻意保留于归一化键内的标点(频道身份而非噪音):CCTV5+ 的 `+`、Hallmark&Kino 的 `&` */
const KEEP_PUNCTUATION = new Set(['+', '&']);

/**
 * 频道名称归一化:返回多源聚合(R1)与 EPG 级联匹配(R2 Level 4)共用的规范化匹配键。
 * 确定性纯函数:同输入恒同输出;幂等(normalize(normalize(x)) == normalize(x));零 IO。
 * 结果为空串表示「无法归一化」(纯噪音/纯符号输入),由调用方按未匹配处理。
 */
export function normalizeChannelName(rawName: string): string {
  // 1) BOM/零宽字符剔除;2) 全角转半角(含全角空格);3) 大小写统一
  let text = rawName.replace(INVISIBLE_PATTERN, '');
  text = text.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - FULLWIDTH_OFFSET));
  text = text.replace(/\u3000/g, ' ');
  text = text.toLowerCase();
  // 4) 括注段整段剔除(循环解除嵌套,如 [a[b]c] 两轮后清空)
  text = removeBracketSegments(text);
  // 5) 清晰度/编码/协议噪音词剔除(逐处词边界判定 + 循环至不动点,处理边界解除后的连锁)
  text = removeNoiseTokens(text);
  // 6) 分隔符与标点剔除(保留 + 与 &,余者连成一串)
  text = text.replace(SEPARATOR_PATTERN, (ch) => (KEEP_PUNCTUATION.has(ch) ? ch : ''));
  return text;
}


/** 循环剔除对称括注段至不动点:单轮只摘最内层,嵌套括注多轮收敛 */
function removeBracketSegments(text: string): string {
  let current = text;
  for (;;) {
    const next = current.replace(BRACKET_SEGMENT_PATTERN, '');
    if (next === current) {
      return next;
    }
    current = next;
  }
}

/** 逐处执行词边界判定并剔除噪音词;循环至不动点(边界解除后新暴露的噪音词继续收敛) */
function removeNoiseTokens(text: string): string {
  let current = text;
  for (;;) {
    const next = current.replace(NOISE_TOKEN_PATTERN, (match, offset: number, whole: string) =>
      isRemovableNoise(whole, offset, match) ? '' : match,
    );
    if (next === current) {
      return next;
    }
    current = next;
  }
}

/**
 * 单处噪音词命中是否可剔除(词边界防误伤核心):
 * - CJK 清晰度词无词边界概念,直接剔除;
 * - ASCII 词「后邻」为字母或数字时判为词内片段,保留(防 shenzhen/hdnews/4knews 误伤);
 * - ASCII 词「前邻」按词形区分:字母开头词(hd/sd/fhd/uhd/hevc/…)仅被字母前邻阻挡
 *   ——允许紧邻数字(cctv-1hd → cctv1);数字开头词(4k/8k/1080p/…)仅被数字前邻阻挡
 *   ——允许紧邻字母(cctv4k → cctv),两者互不误伤。
 */
function isRemovableNoise(whole: string, offset: number, match: string): boolean {
  const before = offset > 0 ? whole[offset - 1]! : '';
  const after = offset + match.length < whole.length ? whole[offset + match.length]! : '';
  // CJK 噪音词(码点 > 0x7F):无词边界概念
  if (match.charCodeAt(0) > 0x7f) {
    return true;
  }
  const blockedAfter = /[a-z0-9]/.test(after);
  const blockedBefore = /^[0-9]$/.test(match[0]!) ? /[0-9]/.test(before) : /[a-z]/.test(before);
  return !blockedBefore && !blockedAfter;
}
