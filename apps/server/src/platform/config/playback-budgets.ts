/**
 * 播放解析技术预算 —— 硬上限常量与可调项(T010,spec 004)。
 * 数值唯一权威来源:docs/specs/004-playback-resolver/research.md R2/R3/R4/R5/R6/R8
 * 与 contracts/api.md(票据 TTL/体限制/限频);
 * 调整任何数值必须同步 research.md 与 apps/server/test/unit/playback/config.spec.ts。
 *
 * 语义约定:
 * - 可调项(转换并发/软件线程/票据 TTL)从既有 env 机制读取(envSchema zod 校验),
 *   低于/高于范围或非法值在启动时 fail-fast(loadEnv 拒绝),不提供运行时开关;
 * - 其余预算为编译期常量;超限行为映射 contracts/api.md 稳定错误码
 *   (如 PLAYBACK_CONVERSION_BUSY/PLAYBACK_STORAGE_LIMIT/PLAYBACK_PERFORMANCE_INSUFFICIENT);
 * - 时间量以秒为单位导出,毫秒派生统一走 ticketTtlMs() 等工具,避免调用方手写换算。
 */
import { getConfig } from './env';
import type { Env } from './env.schema';

/** 二进制单位换算辅助(KiB/MiB/GiB → 字节)。 */
const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

/** 由已校验 Env 构造播放预算(测试注入用;生产用下方 PLAYBACK_BUDGETS 默认单例)。 */
export function createPlaybackBudgets(env: Env) {
  return {
    /** 转换与输出目标(research R4):并发额度与软件线程可调,码率/分辨率为固定目标。 */
    conversion: {
      /** 全局转换并发额度(所有 remux/transcode 共用,超额不排队直接忙):1~8,默认 1 */
      concurrency: env.PLAYBACK_CONVERSION_CONCURRENCY,
      /** 软件转码每任务线程上限(落实为 x264 threads,非硬隔离,部署侧 cgroup 限额):1~8,默认 2 */
      softwareThreadsPerTask: env.PLAYBACK_SOFTWARE_THREADS,
      /** 视频目标码率 8Mbps */
      videoTargetBitrateBps: 8_000_000,
      /** 视频码率硬上限 12Mbps(不自动降分辨率) */
      videoMaxBitrateBps: 12_000_000,
      /** AAC 音频目标码率 192kbps */
      audioTargetBitrateBps: 192_000,
      /** 统一保守输出目标 1080p(不自动降级) */
      targetHeightPx: 1080,
    },

    /** 探测预算(research R4):独立于转换额度,超额忙。 */
    probe: {
      /** ffprobe 独立并发 */
      concurrency: 2,
      /** probe 排队上限,满载返回忙 */
      queueCapacity: 8,
      /** ffprobe 硬超时 */
      timeoutSeconds: 10,
      /** ffprobe 单次输出上限 1MiB */
      maxOutputBytes: 1 * MIB,
    },

    /** 播放票据(research R2/api.md):opaque ticket,TTL 可调,续期只换票不重建任务。 */
    ticket: {
      /** 票据 TTL 秒数(默认 5 分钟):60~900,默认 300 */
      ttlSeconds: env.PLAYBACK_TICKET_TTL_SECONDS,
      /** 到期前提前续期秒数 */
      renewLeadSeconds: 60,
      /** 过期票保留时长(此后随每日清理删除;服务端只存 hash) */
      expiredRetentionSeconds: 24 * 60 * 60,
    },

    /** 缓存与磁盘预算(research R4):针对数据卷。 */
    storage: {
      /** 每任务 HLS 滚动缓存上限 512MiB */
      perTaskCacheMaxBytes: 512 * MIB,
      /** 全局缓存上限 2GiB */
      globalCacheMaxBytes: 2 * GIB,
      /** 剩余磁盘低于 1GiB 禁止新转换并停止写入(PLAYBACK_STORAGE_LIMIT) */
      minDiskFreeBytes: 1 * GIB,
    },

    /** 生命周期与监督(research R5/R6)。 */
    lifecycle: {
      /** 前端心跳间隔(暂停也发) */
      heartbeatIntervalSeconds: 15,
      /** 无心跳判失联秒数 */
      heartbeatLostSeconds: 45,
      /** 后台复核活动任务授权间隔 */
      authRecheckSeconds: 15,
      /** 任务退出后清理目录的最长等待 */
      cleanupDelaySeconds: 60,
      /** 清理失败的重试间隔(保持 cleanup_state=pending,占用仍计预算) */
      cleanupRetrySeconds: 60,
      /** 设备播放记录保留天数(每日清理) */
      recordRetentionDays: 30,
    },

    /** 性能与存活的看门狗时限(research R4/R8):硬超时,不做隐藏重试。 */
    watchdog: {
      /** 首次准备硬超时(硬件失败回退软件一次仍受此限) */
      prepareTimeoutSeconds: 30,
      /** seek 恢复硬超时 */
      seekTimeoutSeconds: 15,
      /** 转码速度采样间隔 */
      speedSampleIntervalSeconds: 10,
      /** 速度计算窗口(最近 N 秒输出媒体时长/墙钟) */
      speedWindowSeconds: 30,
      /** 连续低于 1x 的采样次数阈值(排除暂停/背压误判) */
      speedFailConsecutiveSamples: 3,
      /** 可播放缓冲低于该秒数且连续欠速才判 PLAYBACK_PERFORMANCE_INSUFFICIENT */
      minPlayableBufferSeconds: 8,
      /** 无输出且非正常等待时终止任务的秒数 */
      noOutputTimeoutSeconds: 15,
      /** SIGTERM 后宽限秒数,超时 SIGKILL(确认退出后才释放额度) */
      sigtermGraceSeconds: 5,
    },

    /** 滚动 HLS 时间轴(research R4/R8):窗口只代表当前生产段,不伪装完整 VOD。 */
    timeline: {
      /** 目标分片时长 */
      targetSegmentSeconds: 4,
      /** 私有滚动窗口时长 */
      rollingWindowSeconds: 120,
    },

    /** HLS 上游受控读取预算(research R3):应用层代理,禁止 FFmpeg 直连远程。 */
    hlsUpstream: {
      /** 多变体/媒体清单嵌套上限 */
      maxPlaylistNestingDepth: 4,
      /** 单清单字节上限 2MiB */
      maxPlaylistBytes: 2 * MIB,
      /** 每清单 URI 上限 */
      maxUrisPerPlaylist: 10000,
      /** 每请求重定向上限,每跳重新验证 */
      maxRedirects: 3,
      /** 连接/首字节超时 */
      firstByteTimeoutSeconds: 15,
      /** 流式读取空闲中止超时 */
      idleTimeoutSeconds: 15,
      /** 单分片响应上限 64MiB,超过失败 */
      maxSegmentBytes: 64 * MIB,
      /** AES-128 identity key 长度上限 16 字节且必须合法 */
      maxKeyBytes: 16,
    },

    /** 字幕与轨道预算(research R6)。 */
    subtitles: {
      /** 旁车 .srt/.vtt 只读上限 5MiB */
      maxSidecarBytes: 5 * MIB,
      /** 音轨/字幕轨合计上限,probe 超限提示不支持 */
      maxTrackCount: 32,
    },

    /** 控制请求预算(contracts/api.md)。 */
    request: {
      /** JSON 控制请求体上限 16KiB */
      jsonBodyMaxBytes: 16 * KIB,
    },

    /** 解析控制限频(contracts/api.md):超限 429 + Retry-After;媒体分片不套用。 */
    rateLimit: {
      /** resolve/seek/selection 每设备每分钟 */
      controlPerDevicePerMinute: 30,
      /** renew 每会话每分钟 */
      renewPerMinute: 10,
    },
  };
}

export type PlaybackBudgets = ReturnType<typeof createPlaybackBudgets>;

/** 生产默认单例:import 即经既有 env 机制 fail-fast(非法可调项阻止启动)。 */
export const PLAYBACK_BUDGETS: PlaybackBudgets = createPlaybackBudgets(getConfig());

/** 票据 TTL 的毫秒派生(定时器/过期比较统一走此工具,避免调用方手写换算)。 */
export function ticketTtlMs(budgets: PlaybackBudgets = PLAYBACK_BUDGETS): number {
  return budgets.ticket.ttlSeconds * 1000;
}
