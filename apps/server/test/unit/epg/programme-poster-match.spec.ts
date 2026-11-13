import { describe, expect, it } from 'vitest';
import { normalizeProgrammeTitle } from '@contexts/epg/domain/programme-title';
import {
  isWellFormedPosterPath,
  matchProgrammePoster,
  type TmdbPosterCandidate,
} from '@contexts/epg/domain/programme-poster-match';

function candidate(overrides: Partial<TmdbPosterCandidate> = {}): TmdbPosterCandidate {
  return {
    id: 1,
    mediaType: 'movie',
    title: '流浪地球2',
    originalTitle: '流浪地球2',
    posterPath: '/a.jpg',
    releaseDate: '2023-01-22',
    voteAverage: 7.5,
    popularity: 50,
    adult: false,
    ...overrides,
  };
}

describe('020 · TMDB 候选匹配', () => {
  it('标题完全相等才接受', () => {
    const normalized = normalizeProgrammeTitle('流浪地球2 (2023)');
    expect(matchProgrammePoster(normalized, [candidate()])?.tmdbId).toBe(1);
    expect(matchProgrammePoster(normalized, [candidate({ title: '流浪地球', originalTitle: '流浪地球' })])).toBeNull();
  });

  it('原题完全相等也接受', () => {
    const normalized = normalizeProgrammeTitle('The Matrix');
    const match = matchProgrammePoster(normalized, [
      candidate({ id: 603, title: '黑客帝国', originalTitle: 'The Matrix', releaseDate: '1999-03-31' }),
    ]);
    expect(match?.tmdbId).toBe(603);
    expect(match?.title).toBe('黑客帝国');
  });

  it('年份冲突宁缺毋滥', () => {
    const normalized = normalizeProgrammeTitle('沙丘 (2021)');
    const match = matchProgrammePoster(normalized, [
      candidate({ id: 438631, title: '沙丘', originalTitle: 'Dune', releaseDate: '2021-09-15' }),
      candidate({ id: 841, title: '沙丘', originalTitle: 'Dune', releaseDate: '1984-12-14' }),
    ]);
    expect(match?.tmdbId).toBe(438631);
  });

  it('无年份提示时按 popularity/releaseDate/id 确定性决胜', () => {
    const normalized = normalizeProgrammeTitle('沙丘');
    const match = matchProgrammePoster(normalized, [
      candidate({ id: 2, title: '沙丘', originalTitle: 'Dune', releaseDate: '1984-12-14', popularity: 10 }),
      candidate({ id: 1, title: '沙丘', originalTitle: 'Dune', releaseDate: '2021-09-15', popularity: 100 }),
    ]);
    expect(match?.tmdbId).toBe(1);
  });

  it('过滤 person/adult/无海报/非法海报路径', () => {
    const normalized = normalizeProgrammeTitle('流浪地球2');
    expect(
      matchProgrammePoster(normalized, [
        candidate({ mediaType: 'person' }),
        candidate({ adult: true }),
        candidate({ posterPath: null }),
        candidate({ posterPath: '//evil.example/a.jpg' }),
        candidate({ posterPath: 'https://evil.example/a.jpg' }),
      ]),
    ).toBeNull();
  });

  it('通用栏目不参与匹配', () => {
    const normalized = normalizeProgrammeTitle('新闻联播');
    expect(matchProgrammePoster(normalized, [candidate({ title: '新闻联播' })])).toBeNull();
  });

  it('非法 posterPath 规范', () => {
    expect(isWellFormedPosterPath('/abc.jpg')).toBe(true);
    expect(isWellFormedPosterPath('/abc.webp')).toBe(true);
    expect(isWellFormedPosterPath('//abc.jpg')).toBe(false);
    expect(isWellFormedPosterPath('/../abc.jpg')).toBe(false);
    expect(isWellFormedPosterPath('/abc.svg')).toBe(false);
    expect(isWellFormedPosterPath(null)).toBe(false);
  });
});