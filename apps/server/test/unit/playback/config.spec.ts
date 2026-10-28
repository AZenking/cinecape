import { describe, expect, it } from 'vitest';
import { loadEnv } from '@platform/config/env.schema';
import {
  PLAYBACK_BUDGETS,
  createPlaybackBudgets,
  ticketTtlMs,
} from '@platform/config/playback-budgets';

/**
 * 播放解析技术预算(T010,spec 004)。
 * 数值唯一权威来源:docs/specs/004-playback-resolver/research.md R2/R3/R4/R5/R6/R8
 * 与 contracts/api.md;调整任何数值必须同步 research.md 与本文件。
 */

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

/** 用最小环境源直接驱动 loadEnv → createPlaybackBudgets(不经 .env 文件与进程环境,互不污染)。 */
function parseBudgets(extra: Record<string, string>) {
  return createPlaybackBudgets(loadEnv({ NODE_ENV: 'test', ...extra }));
}

/** 断言注入非法值时在 zod 层启动拒绝(loadEnv fail-fast,错误信息含变量名)。 */
function expectEnvRejected(name: string, value: string): void {
  try {
    loadEnv({ NODE_ENV: 'test', [name]: value });
    expect.unreachable(`期望 ${name}=${value} 被启动拒绝`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain('环境配置校验失败');
    expect(message).toContain(name);
  }
}

describe('播放预算默认值(T010/research R2-R8:env 未注入时逐项等于 research 数值)', () => {
  it('conversion:并发 1、软件线程 2、视频 8Mbps(上限 12Mbps)、音频 192kbps、目标 1080p(R4)', () => {
    expect(PLAYBACK_BUDGETS.conversion.concurrency).toBe(1);
    expect(PLAYBACK_BUDGETS.conversion.softwareThreadsPerTask).toBe(2);
    expect(PLAYBACK_BUDGETS.conversion.videoTargetBitrateBps).toBe(8_000_000);
    expect(PLAYBACK_BUDGETS.conversion.videoMaxBitrateBps).toBe(12_000_000);
    expect(PLAYBACK_BUDGETS.conversion.audioTargetBitrateBps).toBe(192_000);
    expect(PLAYBACK_BUDGETS.conversion.targetHeightPx).toBe(1080);
  });

  it('probe:独立并发 2、队列 8、ffprobe 10 秒/输出 1MiB(R4)', () => {
    expect(PLAYBACK_BUDGETS.probe.concurrency).toBe(2);
    expect(PLAYBACK_BUDGETS.probe.queueCapacity).toBe(8);
    expect(PLAYBACK_BUDGETS.probe.timeoutSeconds).toBe(10);
    expect(PLAYBACK_BUDGETS.probe.maxOutputBytes).toBe(1 * MIB);
  });

  it('ticket:TTL 300 秒(5 分钟)、续期提前 60 秒、过期票 24 小时清理(R2/api.md)', () => {
    expect(PLAYBACK_BUDGETS.ticket.ttlSeconds).toBe(300);
    expect(PLAYBACK_BUDGETS.ticket.renewLeadSeconds).toBe(60);
    expect(PLAYBACK_BUDGETS.ticket.expiredRetentionSeconds).toBe(24 * 60 * 60);
    expect(ticketTtlMs(PLAYBACK_BUDGETS)).toBe(300 * 1000);
  });

  it('storage:任务缓存 512MiB、全局 2GiB、磁盘余量 1GiB(R4)', () => {
    expect(PLAYBACK_BUDGETS.storage.perTaskCacheMaxBytes).toBe(512 * MIB);
    expect(PLAYBACK_BUDGETS.storage.globalCacheMaxBytes).toBe(2 * GIB);
    expect(PLAYBACK_BUDGETS.storage.minDiskFreeBytes).toBe(1 * GIB);
  });

  it('lifecycle:心跳 15 秒、失联 45 秒、授权复核 15 秒、退出清理 60 秒、失败重试 60 秒、记录保留 30 天(R5/R6)', () => {
    expect(PLAYBACK_BUDGETS.lifecycle.heartbeatIntervalSeconds).toBe(15);
    expect(PLAYBACK_BUDGETS.lifecycle.heartbeatLostSeconds).toBe(45);
    expect(PLAYBACK_BUDGETS.lifecycle.authRecheckSeconds).toBe(15);
    expect(PLAYBACK_BUDGETS.lifecycle.cleanupDelaySeconds).toBe(60);
    expect(PLAYBACK_BUDGETS.lifecycle.cleanupRetrySeconds).toBe(60);
    expect(PLAYBACK_BUDGETS.lifecycle.recordRetentionDays).toBe(30);
  });

  it('watchdog:首次准备 30 秒、seek 15 秒、速度采样 10 秒/窗口 30 秒/连续 3 次/缓冲 8 秒、无输出 15 秒、SIGTERM 宽限 5 秒(R4/R8)', () => {
    expect(PLAYBACK_BUDGETS.watchdog.prepareTimeoutSeconds).toBe(30);
    expect(PLAYBACK_BUDGETS.watchdog.seekTimeoutSeconds).toBe(15);
    expect(PLAYBACK_BUDGETS.watchdog.speedSampleIntervalSeconds).toBe(10);
    expect(PLAYBACK_BUDGETS.watchdog.speedWindowSeconds).toBe(30);
    expect(PLAYBACK_BUDGETS.watchdog.speedFailConsecutiveSamples).toBe(3);
    expect(PLAYBACK_BUDGETS.watchdog.minPlayableBufferSeconds).toBe(8);
    expect(PLAYBACK_BUDGETS.watchdog.noOutputTimeoutSeconds).toBe(15);
    expect(PLAYBACK_BUDGETS.watchdog.sigtermGraceSeconds).toBe(5);
  });

  it('timeline:目标分片 4 秒、滚动窗口 120 秒(R4)', () => {
    expect(PLAYBACK_BUDGETS.timeline.targetSegmentSeconds).toBe(4);
    expect(PLAYBACK_BUDGETS.timeline.rollingWindowSeconds).toBe(120);
  });

  it('hlsUpstream:嵌套 4、清单 2MiB、URI 10000、redirect 3、首字节 15 秒、空闲 15 秒、片 64MiB、key 16 字节(R3)', () => {
    expect(PLAYBACK_BUDGETS.hlsUpstream.maxPlaylistNestingDepth).toBe(4);
    expect(PLAYBACK_BUDGETS.hlsUpstream.maxPlaylistBytes).toBe(2 * MIB);
    expect(PLAYBACK_BUDGETS.hlsUpstream.maxUrisPerPlaylist).toBe(10000);
    expect(PLAYBACK_BUDGETS.hlsUpstream.maxRedirects).toBe(3);
    expect(PLAYBACK_BUDGETS.hlsUpstream.firstByteTimeoutSeconds).toBe(15);
    expect(PLAYBACK_BUDGETS.hlsUpstream.idleTimeoutSeconds).toBe(15);
    expect(PLAYBACK_BUDGETS.hlsUpstream.maxSegmentBytes).toBe(64 * MIB);
    expect(PLAYBACK_BUDGETS.hlsUpstream.maxKeyBytes).toBe(16);
  });

  it('subtitles:旁车字幕 5MiB、轨道上限 32(R6)', () => {
    expect(PLAYBACK_BUDGETS.subtitles.maxSidecarBytes).toBe(5 * MIB);
    expect(PLAYBACK_BUDGETS.subtitles.maxTrackCount).toBe(32);
  });

  it('request/rateLimit:JSON 体 16KiB、控制 30 每分钟、renew 10 每分钟(api.md)', () => {
    expect(PLAYBACK_BUDGETS.request.jsonBodyMaxBytes).toBe(16 * KIB);
    expect(PLAYBACK_BUDGETS.rateLimit.controlPerDevicePerMinute).toBe(30);
    expect(PLAYBACK_BUDGETS.rateLimit.renewPerMinute).toBe(10);
  });

  it('顶层分组键集合完整(防止静默增删预算域)', () => {
    expect(Object.keys(PLAYBACK_BUDGETS).sort()).toEqual(
      [
        'conversion',
        'probe',
        'ticket',
        'storage',
        'lifecycle',
        'watchdog',
        'timeline',
        'hlsUpstream',
        'subtitles',
        'request',
        'rateLimit',
      ].sort(),
    );
  });
});

describe('env 可调项注入生效(T010/research R2/R4:经既有 zod envSchema 校验)', () => {
  it('PLAYBACK_CONVERSION_CONCURRENCY 范围 1~8,注入后覆盖默认 1', () => {
    expect(parseBudgets({ PLAYBACK_CONVERSION_CONCURRENCY: '1' }).conversion.concurrency).toBe(1);
    expect(parseBudgets({ PLAYBACK_CONVERSION_CONCURRENCY: '8' }).conversion.concurrency).toBe(8);
  });

  it('PLAYBACK_SOFTWARE_THREADS 范围 1~8,注入后覆盖默认 2', () => {
    expect(parseBudgets({ PLAYBACK_SOFTWARE_THREADS: '1' }).conversion.softwareThreadsPerTask).toBe(1);
    expect(parseBudgets({ PLAYBACK_SOFTWARE_THREADS: '8' }).conversion.softwareThreadsPerTask).toBe(8);
  });

  it('PLAYBACK_TICKET_TTL_SECONDS 范围 60~900,注入后覆盖默认 300 并反映到 ticketTtlMs', () => {
    const lower = parseBudgets({ PLAYBACK_TICKET_TTL_SECONDS: '60' });
    const upper = parseBudgets({ PLAYBACK_TICKET_TTL_SECONDS: '900' });
    expect(lower.ticket.ttlSeconds).toBe(60);
    expect(upper.ticket.ttlSeconds).toBe(900);
    expect(ticketTtlMs(upper)).toBe(900 * 1000);
  });

  it('三者缺省时回落默认 1/2/300', () => {
    const budgets = parseBudgets({});
    expect(budgets.conversion.concurrency).toBe(1);
    expect(budgets.conversion.softwareThreadsPerTask).toBe(2);
    expect(budgets.ticket.ttlSeconds).toBe(300);
  });
});

describe('env 可调项非法值启动拒绝(T010:zod 层 fail-fast,loadEnv 抛错)', () => {
  it('低于/高于范围拒绝:并发与线程 0/9,TTL 0/59/901', () => {
    expectEnvRejected('PLAYBACK_CONVERSION_CONCURRENCY', '0');
    expectEnvRejected('PLAYBACK_CONVERSION_CONCURRENCY', '9');
    expectEnvRejected('PLAYBACK_SOFTWARE_THREADS', '0');
    expectEnvRejected('PLAYBACK_SOFTWARE_THREADS', '9');
    expectEnvRejected('PLAYBACK_TICKET_TTL_SECONDS', '0');
    expectEnvRejected('PLAYBACK_TICKET_TTL_SECONDS', '59');
    expectEnvRejected('PLAYBACK_TICKET_TTL_SECONDS', '901');
  });

  it('非整数拒绝', () => {
    expectEnvRejected('PLAYBACK_CONVERSION_CONCURRENCY', '1.5');
    expectEnvRejected('PLAYBACK_SOFTWARE_THREADS', '2.5');
    expectEnvRejected('PLAYBACK_TICKET_TTL_SECONDS', '300.5');
  });

  it('非法文本与空串拒绝(abc、负数、空字符串)', () => {
    expectEnvRejected('PLAYBACK_CONVERSION_CONCURRENCY', 'abc');
    expectEnvRejected('PLAYBACK_CONVERSION_CONCURRENCY', '-1');
    expectEnvRejected('PLAYBACK_CONVERSION_CONCURRENCY', '');
    expectEnvRejected('PLAYBACK_SOFTWARE_THREADS', 'abc');
    expectEnvRejected('PLAYBACK_SOFTWARE_THREADS', '-2');
    expectEnvRejected('PLAYBACK_TICKET_TTL_SECONDS', 'abc');
    expectEnvRejected('PLAYBACK_TICKET_TTL_SECONDS', '-300');
    expectEnvRejected('PLAYBACK_TICKET_TTL_SECONDS', '');
  });
});
