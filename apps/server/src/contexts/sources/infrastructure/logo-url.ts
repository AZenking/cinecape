/**
 * Logo 地址解析层归一化(014 research R1;M3U tvg-logo 与 XMLTV icon src 的唯一共享实现):
 * - trim 后长度 9~2048(下界 9 与迁移 0009 两列 CHECK 的 length BETWEEN 9 AND 2048 一致,
 *   避免「解析层放行、发布层撞 CHECK」导致导入失败;实施注记见 research R1);
 * - 仅接受 http:// / https:// scheme(大小写不敏感,与 CHECK 的 LIKE 口径一致),
 *   原文保留不转小写(大小写/query 是上游地址的一部分);
 * - 不满足一律归 null:Logo 是装饰性证据,坏数据按缺失处理(FR-010 绝不让解析失败
 *   或抛错),不截断伪造合法地址。
 * 两侧解析器(T014 M3U / T032 XMLTV)均经本函数归一化,禁止各自复制第二份判定。
 */

/** 值域下界(与 0009 source_entry.logo_url / epg_channel.icon_url CHECK 一致) */
export const LOGO_URL_MIN_LENGTH = 9;

/** 值域上界(与 0009 两列 CHECK 一致) */
export const LOGO_URL_MAX_LENGTH = 2048;

/**
 * 归一化 Logo 地址:trim 后 9~2048 字符且仅 http/https scheme;非法一律 null(绝不抛错)。
 */
export function normalizeLogoUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length < LOGO_URL_MIN_LENGTH || trimmed.length > LOGO_URL_MAX_LENGTH) {
    return null;
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}
