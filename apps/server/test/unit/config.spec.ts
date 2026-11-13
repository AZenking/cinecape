import { describe, expect, it } from 'vitest';
import { loadEnv } from '@platform/config/env.schema';
import { IMPORT_BUDGETS } from '@platform/config/import-budgets';

/** 用最小环境源直接驱动 loadEnv(不经 .env 文件与进程环境,互不污染)。 */
function parseEnv(extra: Record<string, string>): ReturnType<typeof loadEnv> {
  return loadEnv({ NODE_ENV: 'test', ...extra });
}

describe('MEDIA_ROOTS 解析(T010/research R4:rootKey→只读挂载绝对路径)', () => {
  it('合法映射按 rootKey→绝对路径解析并冻结', () => {
    const env = parseEnv({ MEDIA_ROOTS: 'videos=/mnt/nas/videos, Nas-2_3=/volume1/media ' });
    expect(env.MEDIA_ROOTS).toEqual({ videos: '/mnt/nas/videos', 'Nas-2_3': '/volume1/media' });
    expect(Object.isFrozen(env.MEDIA_ROOTS)).toBe(true);
  });

  it('缺省为空映射(未授权任何 NAS 根)', () => {
    expect(parseEnv({}).MEDIA_ROOTS).toEqual({});
  });

  it('相对路径拒绝', () => {
    expect(() => parseEnv({ MEDIA_ROOTS: 'videos=relative/path' })).toThrow(/不是绝对路径/);
    expect(() => parseEnv({ MEDIA_ROOTS: 'videos=..' })).toThrow(/不是绝对路径/);
  });

  it('重复 rootKey 拒绝', () => {
    expect(() => parseEnv({ MEDIA_ROOTS: 'videos=/a,videos=/b' })).toThrow(/重复/);
  });

  it('包含「..」的路径段拒绝(含首尾段)', () => {
    expect(() => parseEnv({ MEDIA_ROOTS: 'videos=/mnt/../etc' })).toThrow(/「\.\.」段/);
    expect(() => parseEnv({ MEDIA_ROOTS: 'videos=/mnt/parent/..' })).toThrow(/「\.\.」段/);
    expect(() => parseEnv({ MEDIA_ROOTS: 'videos=../..' })).toThrow(/不是绝对路径|「\.\.」段/);
  });

  it('空值拒绝', () => {
    expect(() => parseEnv({ MEDIA_ROOTS: 'videos=' })).toThrow(/路径为空/);
  });

  it('缺少「=」、非法 rootKey(含超长)拒绝', () => {
    expect(() => parseEnv({ MEDIA_ROOTS: 'just-a-key' })).toThrow(/缺少「=」/);
    expect(() => parseEnv({ MEDIA_ROOTS: 'bad.key=/mnt/a' })).toThrow(/rootKey 非法/);
    expect(() => parseEnv({ MEDIA_ROOTS: `k${'x'.repeat(64)}=/mnt/a` })).toThrow(/rootKey 非法/);
  });

  it('多个非法条目的错误聚合在一次 fail-fast 报告中', () => {
    try {
      parseEnv({ MEDIA_ROOTS: 'a=relative,b=/ok,c=' });
      expect.unreachable();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('MEDIA_ROOTS');
      expect(message).toContain('不是绝对路径');
      expect(message).toContain('路径为空');
    }
  });
});

describe('LAN_ALLOWED_TARGETS 精确许可解析(T010/research R3:无「允许全部内网」开关)', () => {
  it('host、host:port、IPv4/IPv6 字面量与 CIDR、[IPv6]:port 解析为结构化条目', () => {
    const env = parseEnv({
      LAN_ALLOWED_TARGETS:
        'nas.local, nas.local:5000 ,192.168.1.10,192.168.1.0/24,fd00::5,[fd00::7]:8080,fdaa::/16',
    });
    expect(env.LAN_ALLOWED_TARGETS).toEqual([
      { kind: 'host', host: 'nas.local' },
      { kind: 'hostPort', host: 'nas.local', port: 5000 },
      { kind: 'host', host: '192.168.1.10' },
      { kind: 'cidr', family: 4, address: '192.168.1.0', prefixLength: 24 },
      { kind: 'host', host: 'fd00::5' },
      { kind: 'hostPort', host: 'fd00::7', port: 8080 },
      { kind: 'cidr', family: 6, address: 'fdaa::', prefixLength: 16 },
    ]);
    expect(Object.isFrozen(env.LAN_ALLOWED_TARGETS)).toBe(true);
  });

  it('缺省为空列表(默认拒绝全部远程目标)', () => {
    expect(parseEnv({}).LAN_ALLOWED_TARGETS).toEqual([]);
  });

  it('通配符与「允许全部」拒绝:*、*.lan、host:*、0.0.0.0/0、::/0 及任意 /0', () => {
    expect(() => parseEnv({ LAN_ALLOWED_TARGETS: '*' })).toThrow(/通配符/);
    expect(() => parseEnv({ LAN_ALLOWED_TARGETS: '*.lan' })).toThrow(/通配符/);
    expect(() => parseEnv({ LAN_ALLOWED_TARGETS: '10.0.0.*' })).toThrow(/通配符/);
    expect(() => parseEnv({ LAN_ALLOWED_TARGETS: 'nas.local:*' })).toThrow(/通配符/);
    expect(() => parseEnv({ LAN_ALLOWED_TARGETS: '0.0.0.0/0' })).toThrow(/通配 CIDR/);
    expect(() => parseEnv({ LAN_ALLOWED_TARGETS: '::/0' })).toThrow(/通配 CIDR/);
    expect(() => parseEnv({ LAN_ALLOWED_TARGETS: '10.0.0.0/0' })).toThrow(/通配 CIDR/);
  });

  it('CIDR 结构非法、主机名/端口非法与空条目、重复条目拒绝', () => {
    expect(() => parseEnv({ LAN_ALLOWED_TARGETS: 'foo/24' })).toThrow(/CIDR 地址不是合法/);
    expect(() => parseEnv({ LAN_ALLOWED_TARGETS: '192.168.1.0/33' })).toThrow(/前缀长度超出/);
    expect(() => parseEnv({ LAN_ALLOWED_TARGETS: 'fd00::/129' })).toThrow(/前缀长度超出/);
    expect(() => parseEnv({ LAN_ALLOWED_TARGETS: '192.168.1.0/24/x' })).toThrow(/不是合法 CIDR/);
    expect(() => parseEnv({ LAN_ALLOWED_TARGETS: '0.0.0.0' })).toThrow(/未指定地址/);
    expect(() => parseEnv({ LAN_ALLOWED_TARGETS: '::' })).toThrow(/未指定地址/);
    expect(() => parseEnv({ LAN_ALLOWED_TARGETS: '999' })).toThrow(/纯数字/);
    expect(() => parseEnv({ LAN_ALLOWED_TARGETS: 'bad_host' })).toThrow(/不是合法主机名/);
    expect(() => parseEnv({ LAN_ALLOWED_TARGETS: 'nas.local:0' })).toThrow(/端口非法/);
    expect(() => parseEnv({ LAN_ALLOWED_TARGETS: 'nas.local:65536' })).toThrow(/端口非法/);
    expect(() => parseEnv({ LAN_ALLOWED_TARGETS: 'nas.local:080' })).toThrow(/端口非法/);
    expect(() => parseEnv({ LAN_ALLOWED_TARGETS: 'nas.local,,backup.local' })).toThrow(/为空/);
    expect(() => parseEnv({ LAN_ALLOWED_TARGETS: 'nas.local,nas.local' })).toThrow(/重复/);
    expect(() => parseEnv({ LAN_ALLOWED_TARGETS: 'fd00::1:fd00::2' })).toThrow(/无法识别/);
  });
});

describe('导入技术预算常量(T010;数值唯一权威:research.md R2/R3)', () => {
  it('逐项等于 research 数值', () => {
    const KIB = 1024;
    const MIB = 1024 * KIB;
    // M3U:10 MiB / 20000 条 / 单行 64 KiB
    expect(IMPORT_BUDGETS.M3U_MAX_BYTES).toBe(10 * MIB);
    expect(IMPORT_BUDGETS.M3U_MAX_ENTRIES).toBe(20000);
    expect(IMPORT_BUDGETS.M3U_MAX_LINE_BYTES).toBe(64 * KIB);
    // XMLTV:传输 32 MiB / 解压 128 MiB / 500000 节目 / 单字段 64 KiB / 32 层
    expect(IMPORT_BUDGETS.XMLTV_MAX_TRANSFER_BYTES).toBe(32 * MIB);
    expect(IMPORT_BUDGETS.XMLTV_MAX_DECOMPRESSED_BYTES).toBe(128 * MIB);
    expect(IMPORT_BUDGETS.XMLTV_MAX_PROGRAMMES).toBe(500000);
    expect(IMPORT_BUDGETS.XMLTV_MAX_FIELD_BYTES).toBe(64 * KIB);
    expect(IMPORT_BUDGETS.XMLTV_MAX_DEPTH).toBe(32);
    // NAS:100000 文件 / 深度 64 / 扫描 10 分钟
    expect(IMPORT_BUDGETS.NAS_MAX_FILES).toBe(100000);
    expect(IMPORT_BUDGETS.NAS_MAX_DEPTH).toBe(64);
    expect(IMPORT_BUDGETS.NAS_SCAN_BUDGET_MS).toBe(10 * 60 * 1000);
    // 网络:总预算 120 秒 / 空闲 15 秒 / 重定向 ≤3
    expect(IMPORT_BUDGETS.NET_TOTAL_BUDGET_MS).toBe(120000);
    expect(IMPORT_BUDGETS.NET_IDLE_TIMEOUT_MS).toBe(15000);
    expect(IMPORT_BUDGETS.NET_MAX_REDIRECTS).toBe(3);
    // 并发与队列:全局执行 1 / 每来源 1 / 排队 20 / 待确认 24h
    expect(IMPORT_BUDGETS.IMPORT_GLOBAL_RUNNING).toBe(1);
    expect(IMPORT_BUDGETS.IMPORT_PER_SOURCE_ACTIVE).toBe(1);
    expect(IMPORT_BUDGETS.IMPORT_QUEUE_CAPACITY).toBe(20);
    expect(IMPORT_BUDGETS.AWAITING_CONFIRMATION_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('键集合完整(防止静默增删预算项)', () => {
    expect(Object.keys(IMPORT_BUDGETS).sort()).toEqual(
      [
        'M3U_MAX_BYTES',
        'M3U_MAX_ENTRIES',
        'M3U_MAX_LINE_BYTES',
        'XMLTV_MAX_TRANSFER_BYTES',
        'XMLTV_MAX_DECOMPRESSED_BYTES',
        'XMLTV_MAX_PROGRAMMES',
        'XMLTV_MAX_FIELD_BYTES',
        'XMLTV_MAX_DEPTH',
        'NAS_MAX_FILES',
        'NAS_MAX_DEPTH',
        'NAS_SCAN_BUDGET_MS',
        'NET_TOTAL_BUDGET_MS',
        'NET_IDLE_TIMEOUT_MS',
        'NET_MAX_REDIRECTS',
        'IMPORT_GLOBAL_RUNNING',
        'IMPORT_PER_SOURCE_ACTIVE',
        'IMPORT_QUEUE_CAPACITY',
        'AWAITING_CONFIRMATION_TTL_MS',
      ].sort(),
    );
  });
});

describe('020 TMDB 配置', () => {
  it('默认关闭、默认节流与 TTL 上限', () => {
    const env = parseEnv({});
    expect(env.TMDB_API_KEY).toBe('');
    expect(env.TMDB_READ_ACCESS_TOKEN).toBe('');
    expect(env.TMDB_LANGUAGE).toBe('zh-CN');
    expect(env.TMDB_REGION).toBe('CN');
    expect(env.TMDB_MAX_LOOKUPS_PER_RUN).toBe(300);
    expect(env.TMDB_LOOKUP_INTERVAL_MS).toBe(150);
    expect(env.TMDB_RUN_BUDGET_MS).toBe(90000);
    expect(env.TMDB_MATCHED_TTL_DAYS).toBe(180);
    expect(env.TMDB_NEGATIVE_TTL_DAYS).toBe(30);
    expect(env.TMDB_FAILURE_TTL_MINUTES).toBe(60);
  });

  it('TTL 硬上限 180 天；间隔/上限/地区/基址非法拒绝', () => {
    expect(() => parseEnv({ TMDB_MATCHED_TTL_DAYS: '181' })).toThrow(/环境配置校验失败/);
    expect(() => parseEnv({ TMDB_LOOKUP_INTERVAL_MS: '5001' })).toThrow(/环境配置校验失败/);
    expect(() => parseEnv({ TMDB_MAX_LOOKUPS_PER_RUN: '1001' })).toThrow(/环境配置校验失败/);
    expect(() => parseEnv({ TMDB_REGION: 'CHN' })).toThrow(/环境配置校验失败/);
    expect(() => parseEnv({ TMDB_API_BASE_URL: 'https://user:pass@example.com/3' })).toThrow(
      /环境配置校验失败/,
    );
    expect(() => parseEnv({ TMDB_IMAGE_BASE_URL: 'ftp://example.com' })).toThrow(/环境配置校验失败/);
  });
});
