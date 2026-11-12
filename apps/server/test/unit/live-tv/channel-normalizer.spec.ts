import { describe, expect, it } from 'vitest';
import { normalizeChannelKey, normalizeChannelName } from '@contexts/live-tv/domain/channel-normalizer';

/**
 * T005(US 016-research R1/R2 Level 4;data-model §1.2 normalized_key)频道名归一化纯函数:
 * - R1:多直播源聚合,M3U 条目名清洗噪音后缀(`[4K]`/`1080P`/`HEVC`/`高清`/`[IPv6]`/`(备份)` 等)
 *   后命中相同规范化 key 即合并为同一逻辑频道的备用线路;
 * - R2 Level 4:tvg-id 未命中时,对频道名与 EPG 库频道名做「去除标点、大小写、常见清晰度后缀」
 *   的归一化比对;
 * - normalized_key 语义:data-model §1.2 示例 `"cctv1"`、`"zhejiang"`(小写、无分隔符的一串)。
 * 本文件逐条钉死纯函数行为:确定性、幂等(normalize(normalize(x)) == normalize(x))、零 IO,
 * 短词(hd/sd 等)词边界匹配,严禁误伤 shenzhen/hdnews 类词内字母。
 */

describe('频道名归一化 normalizeChannelName(T005)', () => {
  describe('任务书词表与聚合同键(R1 清洗规则)', () => {
    it('`CCTV-1 综合 1080P` 与 `CCTV-1综合` 归一为同键 cctv1综合(清晰度后缀剔除、分隔符连成一串)', () => {
      // 源 A「CCTV-1 综合 1080P」必须与源 B「CCTV-1综合」命中同一 key,才能合并为备用线路
      expect(normalizeChannelName('CCTV-1 综合 1080P')).toBe('cctv1综合');
      expect(normalizeChannelName('CCTV-1综合')).toBe('cctv1综合');
      expect(normalizeChannelName('CCTV-1 综合 1080P')).toBe(normalizeChannelName('CCTV-1综合'));
    });

    it('`[4K] CCTV-1` → cctv1(包裹性括注段整段剔除,段内噪音词不外泄)', () => {
      // [4K] 是括注段,先整段移除;残留空白随后由分隔符步骤吃掉
      expect(normalizeChannelName('[4K] CCTV-1')).toBe('cctv1');
    });

    it('`CCTV1 HEVC` → cctv1(编码后缀剔除)', () => {
      expect(normalizeChannelName('CCTV1 HEVC')).toBe('cctv1');
    });

    it('`CCTV-1 [IPv6] [备份]` → cctv1(多括注段一次性剔除)', () => {
      // IPv6(协议)与 [备份](来源标记)均为噪音;两次 R1 聚合的典型语料
      expect(normalizeChannelName('CCTV-1 [IPv6] [备份]')).toBe('cctv1');
    });

    it('`东方卫视 4K 超清` → 东方卫视(中英混排清晰度中缀词全部剔除)', () => {
      expect(normalizeChannelName('东方卫视 4K 超清')).toBe('东方卫视');
    });

    it('`浙江卫视 蓝光 1080P` → 浙江卫视;`浙江超高清` → 浙江(长词先于高清匹配,不残留「超」字)', () => {
      // 蓝光/1080P 与 超高清(必须先于「高清」整词剔除,否则残留「超」)
      expect(normalizeChannelName('浙江卫视 蓝光 1080P')).toBe('浙江卫视');
      expect(normalizeChannelName('浙江超高清')).toBe('浙江');
      expect(normalizeChannelName('浙江高清')).toBe('浙江');
      expect(normalizeChannelName('浙江标清')).toBe('浙江');
    });

    it('`凤凰中文·资讯` → 凤凰中文资讯(中点分隔符连成一串)', () => {
      expect(normalizeChannelName('凤凰中文·资讯')).toBe('凤凰中文资讯');
    });

    it('`cctv4k`(字母数字直连)→ cctv:数字开头噪音词允许紧邻字母前缀', () => {
      // IPTV 垃圾后缀常见形态;数字开头词仅被「数字前邻」阻挡
      expect(normalizeChannelName('cctv4k')).toBe('cctv');
      expect(normalizeChannelName('CCTV4K超高清')).toBe('cctv');
    });
  });

  describe('词边界防误伤(严禁伤及词内字母)', () => {
    it('`Shenzhen HD` → shenzhen:HD 剔除而 Shenzhen 完整保留', () => {
      // hd 短词必须整词匹配;shenzhen 词内不含独立 hd,不受影响
      expect(normalizeChannelName('Shenzhen HD')).toBe('shenzhen');
    });

    it('`HDNEWS` 不被误伤 → hdnews(后邻为字母,判为词内片段)', () => {
      expect(normalizeChannelName('HDNEWS')).toBe('hdnews');
    });

    it('`XUHD`/`44K` 类词内片段同样保留(前邻同类字符阻挡)', () => {
      // 字母开头噪音词被字母前邻阻挡(uhd 位于 x 之后);
      // 数字开头噪音词被数字前邻阻挡(4k 位于 4 之后),避免撕开真实词形
      expect(normalizeChannelName('XUHD')).toBe('xuhd');
      expect(normalizeChannelName('44K')).toBe('44k');
    });

    it('`CCTV-1HD` → cctv1:数字-字母直连交界处 HD 仍判定为清晰度后缀', () => {
      // 任务书钉死用例:字母开头噪音词允许紧邻数字前缀(与 hdnews 的区分在「后邻」)
      expect(normalizeChannelName('CCTV-1HD')).toBe('cctv1');
    });
  });

  describe('全半角/大小写/中文标点', () => {
    it('全角 `ｃｃｔｖ－１` 与半角 `CCTV-1` 归一为同键 cctv1', () => {
      expect(normalizeChannelName('ｃｃｔｖ－１')).toBe('cctv1');
      expect(normalizeChannelName('CCTV-1')).toBe('cctv1');
      expect(normalizeChannelName('ｃｃｔｖ－１')).toBe(normalizeChannelName('CCTV-1'));
    });

    it('`湖南卫视（金鹰）` 与 `湖南卫视` 归一为同键(全角圆括注段剔除)', () => {
      expect(normalizeChannelName('湖南卫视（金鹰）')).toBe('湖南卫视');
      expect(normalizeChannelName('湖南卫视(金鹰)')).toBe('湖南卫视');
      expect(normalizeChannelName('湖南卫视【金鹰】')).toBe('湖南卫视');
    });

    it('大小写不敏感:`CCTV-1` / `cctv-1` / `Cctv-1` 同键', () => {
      expect(normalizeChannelName('cctv-1')).toBe('cctv1');
      expect(normalizeChannelName('Cctv-1')).toBe('cctv1');
    });

    it('全角空格与制表符等空白一律剔除(`CCTV-1　综合` → cctv1综合)', () => {
      expect(normalizeChannelName('CCTV-1\u3000综合')).toBe('cctv1综合');
      expect(normalizeChannelName('\tCCTV-1\n综合\r')).toBe('cctv1综合');
    });
  });

  describe('退化输入(调用方按「无法归一化」处理)', () => {
    it('空串 → 空串', () => {
      expect(normalizeChannelName('')).toBe('');
    });

    it('纯符号串 → 空串(全部为分隔符/标点,无身份信息)', () => {
      expect(normalizeChannelName('---::：___···||')).toBe('');
    });

    it('纯空白/BOM → 空串', () => {
      expect(normalizeChannelName('   ')).toBe('');
      expect(normalizeChannelName('\uFEFF\u3000\t')).toBe('');
    });

    it('纯括注/纯噪音词 → 空串(如 `[备份]`、`4K`、`超高清`)', () => {
      // 段内无身份信息时整串归空,由调用方(聚合/匹配层)按无法归一化处理
      expect(normalizeChannelName('[备份]')).toBe('');
      expect(normalizeChannelName('4K')).toBe('');
      expect(normalizeChannelName('超高清')).toBe('');
    });
  });

  describe('纯函数性质(确定性/幂等/别名)', () => {
    // 覆盖全部词表边界与退化形态的疑难语料
    const trickyInputs = [
      'CCTV-1 综合 1080P',
      '[4K] CCTV-1',
      'CCTV1 HEVC',
      'CCTV-1 [IPv6] [备份]',
      '东方卫视 4K 超清',
      'Shenzhen HD',
      'HDNEWS',
      'XUHD',
      '44K',
      'CCTV-1HD',
      'cctv4k',
      '4k1080p',
      '浙江超高清',
      '凤凰中文·资讯',
      'CCTV5+',
      '湖南卫视（金鹰）',
      'ｃｃｔｖ－１',
      '---::：___···||',
      '   ',
      '',
      '\uFEFF[备份]\u3000',
    ];

    it('幂等:normalize(normalize(x)) == normalize(x)(覆盖疑难语料)', () => {
      for (const input of trickyInputs) {
        const once = normalizeChannelName(input);
        expect(normalizeChannelName(once)).toBe(once);
      }
    });

    it('确定性:同输入两次调用同输出', () => {
      for (const input of trickyInputs) {
        expect(normalizeChannelName(input)).toBe(normalizeChannelName(input));
      }
    });

    it('别名导出:normalizeChannelKey 与 normalizeChannelName 同一实现(research R1 / T005 两处命名)', () => {
      expect(normalizeChannelKey).toBe(normalizeChannelName);
      expect(normalizeChannelKey('CCTV-1 综合 1080P')).toBe('cctv1综合');
    });
  });

  describe('保守边界(刻意不做,防止误合并)', () => {
    it('`+` 保留:CCTV5+ 与 CCTV5 归一为不同键(体育赛事频道是独立频道,不可误合并)', () => {
      // 全角＋(U+FF0B)转半角 + 后同样保留,两处写法同键
      expect(normalizeChannelName('CCTV5+')).toBe('cctv5+');
      expect(normalizeChannelName('CCTV-5+体育')).toBe('cctv5+体育');
      expect(normalizeChannelName('ＣＣＴＶ５＋')).toBe('cctv5+');
      expect(normalizeChannelName('CCTV5+')).not.toBe(normalizeChannelName('CCTV5'));
    });

    it('频道号类前缀不做处理(保守决策):`01 CCTV-1` → 01cctv1', () => {
      // 任务书规则 5:保守不剥离频道号前缀;此处钉死现行为,若后续放开须同步修改
      expect(normalizeChannelName('01 CCTV-1')).toBe('01cctv1');
    });

    it('装饰符号(★ 等 Unicode 符号)剔除但 `&` 保留:Hallmark&Kino 身份不被撕裂', () => {
      expect(normalizeChannelName('★CCTV-5★')).toBe('cctv5');
      expect(normalizeChannelName('Hallmark&Kino')).toBe('hallmark&kino');
    });
  });
});
