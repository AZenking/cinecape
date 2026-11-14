/**
 * 020 TMDB 节目海报：候选匹配纯函数（零 IO）。
 *
 * 保守策略（research R3）：只接受候选 title/original_title 归一化后与查询键
 * **完全相等**的 movie/tv；过滤 person/adult/无海报；年份冲突（差 >1）拒绝；
 * 多候选按确定性顺序决胜，避免同一节目在不同刷新中换海报。
 */

import { normalizeProgrammeTitle, type NormalizedProgrammeTitle } from './programme-title';

/** TMDB 检索结果的归一化输入（客户端已做最小结构校验；此处仍防御性过滤）。 */
export interface TmdbPosterCandidate {
  readonly id: number;
  readonly mediaType: string;
  readonly title: string;
  readonly originalTitle: string | null;
  readonly posterPath: string | null;
  /** 16:9 剧照(TMDB backdrop_path);优先于 2:3 海报,满足节目单 16:9 展示 */
  readonly backdropPath?: string | null;
  readonly releaseDate: string | null;
  readonly voteAverage: number | null;
  readonly popularity: number | null;
  readonly adult: boolean;
}

/** 接受后的匹配结果（写入 programme_poster；不直接进公共 DTO）。 */
export interface ProgrammePosterMatch {
  readonly tmdbId: number;
  readonly mediaType: 'movie' | 'tv';
  readonly title: string;
  readonly originalTitle: string | null;
  readonly posterPath: string;
  readonly releaseDate: string | null;
  readonly voteAverage: number | null;
  readonly popularity: number | null;
  readonly matchScore: number;
}

/** poster_path 必须为 TMDB 相对路径（防止代理阶段出现绝对 URL/协议相对 URL）。 */
export function isWellFormedPosterPath(value: string | null | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 2 &&
    value.length <= 512 &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    /^\/[A-Za-z0-9._-]+\.(?:jpg|jpeg|png|webp)$/i.test(value)
  );
}

function yearOf(releaseDate: string | null): number | null {
  if (releaseDate === null) {
    return null;
  }
  const match = /^(\d{4})/.exec(releaseDate);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  return Number.isInteger(year) && year >= 1900 && year <= 2100 ? year : null;
}

function popularityOf(value: number | null): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function scoreOf(
  normalized: NormalizedProgrammeTitle,
  candidate: TmdbPosterCandidate,
  titleExact: boolean,
  candidateYear: number | null,
): number {
  let score = titleExact ? 100 : 90;
  if (normalized.yearHint !== null && candidateYear !== null && candidateYear === normalized.yearHint) {
    score += 20;
  }
  score += Math.min(10, Math.log10(popularityOf(candidate.popularity) + 1) * 2);
  return score;
}

/**
 * 从 TMDB 候选中选出唯一匹配；无法确定返回 null。
 * 同输入同输出：排序稳定（score/popularity/releaseDate/id）。
 */
export function matchProgrammePoster(
  normalized: NormalizedProgrammeTitle,
  candidates: readonly TmdbPosterCandidate[],
): ProgrammePosterMatch | null {
  if (normalized.matchKey === null) {
    return null;
  }

  const accepted: Array<{
    readonly candidate: TmdbPosterCandidate;
    readonly mediaType: 'movie' | 'tv';
    readonly titleExact: boolean;
    readonly candidateYear: number | null;
    readonly score: number;
    /** 实际下发的图片相对路径(backdrop 优先 / poster 回退) */
    readonly imagePath: string;
  }> = [];

  for (const candidate of candidates) {
    if (candidate.mediaType !== 'movie' && candidate.mediaType !== 'tv') {
      continue;
    }
    if (candidate.adult) {
      continue;
    }
    // 优先 16:9 backdrop;缺失时回退 2:3 海报(展示层统一按 16:9 容器裁切)
    const imagePath = candidate.backdropPath ?? candidate.posterPath;
    if (!isWellFormedPosterPath(imagePath)) {
      continue;
    }
    if (typeof candidate.title !== 'string' || candidate.title.trim() === '') {
      continue;
    }

    const candidateYear = yearOf(candidate.releaseDate);
    if (
      normalized.yearHint !== null &&
      candidateYear !== null &&
      Math.abs(candidateYear - normalized.yearHint) > 1
    ) {
      // 年份冲突：宁可不匹配，也不下发错误海报
      continue;
    }

    const titleKey = normalizeProgrammeTitle(candidate.title).matchKey;
    const originalKey =
      candidate.originalTitle === null ? null : normalizeProgrammeTitle(candidate.originalTitle).matchKey;

    const titleExact = titleKey !== null && titleKey === normalized.matchKey;
    const originalExact = originalKey !== null && originalKey === normalized.matchKey;
    if (!titleExact && !originalExact) {
      continue;
    }

    accepted.push({
      candidate,
      mediaType: candidate.mediaType,
      titleExact,
      candidateYear,
      score: scoreOf(normalized, candidate, titleExact, candidateYear),
      imagePath: imagePath as string,
    });
  }

  if (accepted.length === 0) {
    return null;
  }

  accepted.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    const leftPopularity = popularityOf(left.candidate.popularity);
    const rightPopularity = popularityOf(right.candidate.popularity);
    if (leftPopularity !== rightPopularity) {
      return rightPopularity - leftPopularity;
    }
    const leftDate = left.candidate.releaseDate ?? '';
    const rightDate = right.candidate.releaseDate ?? '';
    if (leftDate !== rightDate) {
      return leftDate < rightDate ? 1 : -1;
    }
    return left.candidate.id - right.candidate.id;
  });

  const winner = accepted[0]!;
  return {
    tmdbId: winner.candidate.id,
    mediaType: winner.mediaType,
    title: winner.candidate.title,
    originalTitle: winner.candidate.originalTitle,
    posterPath: winner.imagePath,
    releaseDate: winner.candidate.releaseDate,
    voteAverage: winner.candidate.voteAverage,
    popularity: winner.candidate.popularity,
    matchScore: winner.score,
  };
}