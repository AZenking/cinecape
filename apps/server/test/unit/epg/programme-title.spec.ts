import { describe, expect, it } from 'vitest';
import { normalizeProgrammeTitle, posterMatchKeyOf } from '@contexts/epg/domain/programme-title';

describe('020 · 节目标题归一化', () => {
  it('中文标题：去书名号/年份/季集/清晰度，保留年份提示', () => {
    const result = normalizeProgrammeTitle('《流浪地球2》（2023） 第1集 高清');
    expect(result.matchKey).toBe('流浪地球2');
    expect(result.yearHint).toBe(2023);
    expect(result.reason).toBeNull();
  });

  it('英文标题：去标点/年份，大小写无关', () => {
    const result = normalizeProgrammeTitle('Spider-Man: No Way Home (2021)');
    expect(result.matchKey).toBe('spidermannowayhome');
    expect(result.yearHint).toBe(2021);
  });

  it('栏目前缀与首尾语言标签剥离', () => {
    expect(posterMatchKeyOf('电影：沙丘 (2021) 国语')).toBe('沙丘');
    expect(posterMatchKeyOf('【高清】流浪地球 中字')).toBe('流浪地球');
    expect(posterMatchKeyOf('流浪地球 高清 国语')).toBe('流浪地球');
  });

  it('季集标记剥离', () => {
    expect(posterMatchKeyOf('狂飙 第12集')).toBe('狂飙');
    expect(posterMatchKeyOf('权力的游戏 第八季')).toBe('权力的游戏');
    expect(posterMatchKeyOf('The Last of Us S01E03')).toBe('thelastofus');
    expect(posterMatchKeyOf('Some Show EP04')).toBe('someshow');
  });

  it('通用栏目/空标题/太短：不参与匹配', () => {
    expect(posterMatchKeyOf('新闻联播')).toBeNull();
    expect(posterMatchKeyOf('天气预报')).toBeNull();
    expect(posterMatchKeyOf('节目预告')).toBeNull();
    expect(posterMatchKeyOf('电视剧')).toBeNull();
    expect(posterMatchKeyOf('剧场')).toBeNull();
    expect(posterMatchKeyOf('宣传片')).toBeNull();
    expect(posterMatchKeyOf('动画片剧场')).toBeNull();
    expect(posterMatchKeyOf('第1集')).toBeNull();
    expect(posterMatchKeyOf('   ')).toBeNull();
    expect(posterMatchKeyOf('A')).toBeNull();
  });

  it('超长键拒绝，避免缓存主键/索引越界', () => {
    expect(posterMatchKeyOf('长'.repeat(300))).toBeNull();
  });

  it('同输入同输出，确定性', () => {
    const a = normalizeProgrammeTitle('《沙丘》（2021） 国语 高清');
    const b = normalizeProgrammeTitle('《沙丘》（2021） 国语 高清');
    expect(a).toEqual(b);
  });

  it('保留不是噪声的括号副标题', () => {
    // 括号内容不是质量/语言/年份/季集标签 → 保留，避免误删正式副标题
    const result = normalizeProgrammeTitle('Mission: Impossible (Dead Reckoning)');
    expect(result.matchKey).toBe('missionimpossibledeadreckoning');
  });

  it('栏目槽位/集数前缀与括号集数剥离（真实 EPG 形态）', () => {
    expect(posterMatchKeyOf('1001夜剧场:生万物(4)')).toBe('生万物');
    expect(posterMatchKeyOf('上午剧场:伪装者(22)')).toBe('伪装者');
    expect(posterMatchKeyOf('36集连续剧：信者无敌（17）')).toBe('信者无敌');
    expect(posterMatchKeyOf('10集纪录片:舞乐新疆第二季(4-7)')).toBe('舞乐新疆');
    expect(posterMatchKeyOf('战狼·战狼（2）')).toBe('战狼战狼');
  });

  it('八位日期前缀剥离，但 4 位片名年份不误伤', () => {
    expect(posterMatchKeyOf('20170921《辉煌中国》协调发展')).toBe('辉煌中国协调发展');
    expect(posterMatchKeyOf('1917')).toBe('1917');
    expect(posterMatchKeyOf('流浪地球2')).toBe('流浪地球2');
  });
});