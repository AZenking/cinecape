/**
 * 导入技术预算 —— 硬上限常量(T010)。
 * 数值唯一权威来源:docs/specs/003-media-catalog/research.md R2/R3;
 * 调整任何数值必须同步 research.md 与 apps/server/test/unit/config.spec.ts。
 *
 * 语义约定:
 * - 任一预算超限即整个导入失败并保留上次成功快照,不截断、不跳过(FR-005/FR-014);
 * - 这些限值是本项目设计约束,不是外部标准;
 * - M3U/XMLTV/NAS 的读取与解析消费这些常量,网络预算约束 safe-http-reader,
 *   队列/并发与 TTL 约束刷新执行器(见 tasks.md T013-T017/T021-T026)。
 */

/** 二进制单位换算辅助(KiB/MiB/分钟/小时 → 字节/毫秒)。 */
const KIB = 1024;
const MIB = 1024 * KIB;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export const IMPORT_BUDGETS = {
  /** M3U 播放列表:单文件 ≤10 MiB */
  M3U_MAX_BYTES: 10 * MIB,
  /** M3U 频道条目 ≤20000 */
  M3U_MAX_ENTRIES: 20000,
  /** M3U 单行 ≤64 KiB */
  M3U_MAX_LINE_BYTES: 64 * KIB,

  /** XMLTV 压缩传输 ≤32 MiB(gzip 计数与解压计数相互独立) */
  XMLTV_MAX_TRANSFER_BYTES: 32 * MIB,
  /** XMLTV 解压后 ≤128 MiB(不递归解压) */
  XMLTV_MAX_DECOMPRESSED_BYTES: 128 * MIB,
  /** XMLTV 节目 ≤500000 */
  XMLTV_MAX_PROGRAMMES: 500000,
  /** XMLTV 单字段 ≤64 KiB */
  XMLTV_MAX_FIELD_BYTES: 64 * KIB,
  /** XMLTV 元素嵌套 ≤32 层 */
  XMLTV_MAX_DEPTH: 32,

  /** NAS 每来源受支持文件 ≤100000 */
  NAS_MAX_FILES: 100000,
  /** NAS 目录深度 ≤64 */
  NAS_MAX_DEPTH: 64,
  /** NAS 单次扫描预算 ≤10 分钟 */
  NAS_SCAN_BUDGET_MS: 10 * MINUTE_MS,

  /** 远程读取总预算 ≤120 秒(含全部重定向跳) */
  NET_TOTAL_BUDGET_MS: 120000,
  /** 远程读取空闲超时 ≤15 秒 */
  NET_IDLE_TIMEOUT_MS: 15000,
  /** 重定向 ≤3 跳,每跳独立连接并重新校验 */
  NET_MAX_REDIRECTS: 3,

  /** 全进程同时执行中的导入任务 =1(单执行器,research R5) */
  IMPORT_GLOBAL_RUNNING: 1,
  /** 每来源同时执行中/待确认任务 =1(部分唯一锁,同来源互斥) */
  IMPORT_PER_SOURCE_ACTIVE: 1,
  /** 全局排队上限 =20,满载返回 429 IMPORT_QUEUE_FULL(Retry-After: 5) */
  IMPORT_QUEUE_CAPACITY: 20,
  /** 待确认快照 24 小时到期,到期清除暂存并将任务标记 expired */
  AWAITING_CONFIRMATION_TTL_MS: 24 * HOUR_MS,
} as const;

export type ImportBudgets = typeof IMPORT_BUDGETS;
