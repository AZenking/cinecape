/**
 * 010 T018 — SafeUpstreamPort:可复用有界安全上游读取的发布端口(纯契约)。
 *
 * 事实来源:docs/specs/010-online-vod/contracts/internal-ports.md §1「SafeUpstreamPort
 * 行:协议/DNS/每跳重定向/内网许可/timeout/byteBudget/AbortSignal;不从他上下文
 * private HTTP 文件导入」与 §3「ffmpeg 不能绕过 SafeUpstream 校验直接对任意嵌套
 * 地址联网」。消费方:sources(导入刷新)、online-vod(CMS 搜索/详情/预览)、
 * playback(probe/HLS 代理/key/片段/测速)。
 *
 * 本文件是纯 TS 契约面:零运行时依赖(唯一 import 为 platform/config 的 LanTarget
 * 类型),不含任何网络/定时器实现;实现与传输细节见同目录 safe-upstream-reader.ts。
 *
 * 预算缺省说明(R4 取舍):.dependency-cruiser.cjs R4 禁止 platform→contexts,
 * 因此本文件不能运行时导入 contexts/online-vod/domain/vod-budgets.ts 的
 * VOD_BUDGETS;VOD 缺省预算以「镜像常量 + 测试对照锁定」方式落在本文件
 * (VOD_SAFE_UPSTREAM_BUDGETS / VOD_SAFE_UPSTREAM_NESTED_BUDGETS),数值逐一对照
 * VOD_BUDGETS 契约值,漂移即 test/unit/online-vod/safe-upstream.spec.ts 失败。
 */

import type { Readable } from 'node:stream';
import type { LanTarget } from '@platform/config/env.schema';

/* ------------------------------------------------------------------ */
/* 基础输入类型                                                        */
/* ------------------------------------------------------------------ */

/** 部署级精确许可条目(env.LAN_ALLOWED_TARGETS 解析产物;空列表 = 默认拒绝) */
export type UpstreamAllowedTarget = LanTarget;

/** 注入式 DNS 解析器(测试注入 stub;生产用 node:dns promises 缺省实现) */
export interface UpstreamDnsResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

/** 可注入时钟(结构兼容 test/fixtures 的 ManualClock;缺省真实时间) */
export interface UpstreamClock {
  now(): number;
  delay(ms: number): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* 预算结构                                                            */
/* ------------------------------------------------------------------ */

/** 单次读取的时间/重定向预算(每跳独立连接并重新校验) */
export interface UpstreamTimeBudgets {
  /** 全部跳(含解析与重定向)的总时长上限 ms */
  totalTimeoutMs: number;
  /** 连接空闲(建连/响应头/数据块任一活动重置窗口)上限 ms */
  idleTimeoutMs: number;
  /** 手动逐跳重定向跳数上限 */
  maxRedirects: number;
}

/** 嵌套读取级别(HLS 多级读取:清单→变体清单→片段→密钥) */
export type UpstreamNestedLevel = 'manifest' | 'variant' | 'segment' | 'key';

/**
 * 嵌套预算:manifest→variant→segment→key 各级单响应字节上限 + 嵌套链累计字节
 * 总量 + 链总时限。供 playback HLS 多级读取(T044)与 online-vod 预览按级取预算。
 */
export interface UpstreamNestedBudgets {
  readonly perLevelMaxBytes: Readonly<Record<UpstreamNestedLevel, number>>;
  /** 嵌套链全部级累计字节上限(跨级总量) */
  readonly totalMaxBytes: number;
  /** 嵌套链总时长上限 ms(覆盖全部级) */
  readonly totalTimeoutMs: number;
}

/* ------------------------------------------------------------------ */
/* VOD 缺省预算镜像(数值来源:VOD_BUDGETS,见文件头「R4 取舍」)          */
/* ------------------------------------------------------------------ */

const MIB = 1024 * 1024;

/**
 * VOD 上游读取缺省预算(镜像 contexts/online-vod/domain/vod-budgets.ts):
 * - totalTimeoutMs = VOD_BUDGETS.search.totalTimeoutMs = preview.totalTimeoutMs = 8000;
 * - maxBytes = VOD_BUDGETS.preview.maxBytes = detail.maxBytes = 4MiB;
 * - idleTimeoutMs / maxRedirects 沿用 IMPORT 传输预算(传输层常量,契约不含)。
 */
export const VOD_SAFE_UPSTREAM_BUDGETS = {
  totalTimeoutMs: 8_000,
  idleTimeoutMs: 15_000,
  maxRedirects: 3,
  maxBytes: 4 * MIB,
} as const;

/**
 * VOD 嵌套预算缺省:各级单响应上限锚定预览/详情 4MiB 契约值,总量 = 预览 4MiB,
 * 链总时限 = 预览 8s。播放面(playback)可在装配时按 PLAYBACK_BUDGETS.hlsUpstream
 * 收紧或改配;本缺省保证 VOD 路径在不传预算时仍有契约界。
 */
export const VOD_SAFE_UPSTREAM_NESTED_BUDGETS: UpstreamNestedBudgets = {
  perLevelMaxBytes: {
    manifest: 4 * MIB,
    variant: 4 * MIB,
    segment: 4 * MIB,
    key: 4 * MIB,
  },
  totalMaxBytes: 4 * MIB,
  totalTimeoutMs: 8_000,
};

/* ------------------------------------------------------------------ */
/* 稳定错误码与失败形态                                                 */
/* ------------------------------------------------------------------ */

/**
 * 稳定错误码(字符串值与旧 sources 读取器逐字一致,保证回归兼容):
 * - SOURCE_TARGET_DENIED:协议外/命中拒绝类别/未列入部署精确许可/Location 非法;
 * - SOURCE_REDIRECT_LIMIT:重定向跳数超预算;
 * - SOURCE_BUDGET_EXCEEDED:总时长/读取字节超预算;
 * - SOURCE_IDLE_TIMEOUT:连接空闲超预算;
 * - SOURCE_DNS_INVALID:DNS 解析失败、结果为空或含非法地址文本;
 * - SOURCE_ABORTED:外部 AbortSignal 中止;
 * - SOURCE_REMOTE_UNREACHABLE:传输层失败(message 只保留 error.name)。
 */
export type SafeUpstreamErrorCode =
  | 'SOURCE_TARGET_DENIED'
  | 'SOURCE_REDIRECT_LIMIT'
  | 'SOURCE_BUDGET_EXCEEDED'
  | 'SOURCE_IDLE_TIMEOUT'
  | 'SOURCE_DNS_INVALID'
  | 'SOURCE_ABORTED'
  | 'SOURCE_REMOTE_UNREACHABLE';

/* (010 T090 knip 清理:原 SafeUpstreamFailureShape 结构化失败形态已删除——零消费,失败统一以 RemoteReadFailure Error 子类承载) */
/* ------------------------------------------------------------------ */
/* 请求与结果                                                          */
/* ------------------------------------------------------------------ */

/** 单次有界安全读取请求(internal-ports §1 全量维度) */
export interface SafeUpstreamOpenRequest {
  /** 目标 URL;userinfo 不参与许可匹配也不进入请求 */
  url: string;
  /** 部署级精确许可列表;缺省(未传)= 空列表 = 默认拒绝 */
  allowedTargets?: readonly UpstreamAllowedTarget[];
  /** 单次响应体字节上限;超限中止连接并 BUDGET_EXCEEDED;缺省不限 */
  byteBudget?: number;
  /** 时间/重定向预算;缺省 = IMPORT 传输预算(旧 sources 行为) */
  timeBudgets?: UpstreamTimeBudgets;
  /** 外部中止信号;中止即 SOURCE_ABORTED 并销毁连接 */
  signal?: AbortSignal;
  /** 注入 DNS 解析器(测试 stub);缺省 node:dns promises */
  resolver?: UpstreamDnsResolver;
  /** 注入时钟驱动空闲/总预算(测试);缺省真实时间 */
  clock?: UpstreamClock;
}

/** 打开的受控上游流:原始响应流(不解压/不改写)+ 透传元数据与溯源事实 */
export interface SafeUpstreamStreamHandle {
  stream: Readable;
  contentType: string | null;
  contentEncoding: string | null;
  /** 重定向后的最终 URL(无重定向时 = 请求 URL) */
  finalUrl: string;
  /** 实际跟随的重定向跳数 */
  redirectsFollowed: number;
  /** 消费方结束:清理预算计时与中止监听,销毁连接 */
  close(): Promise<void>;
}

/** 有界全量读取结果(字节预算内完整响应体) */
export interface SafeUpstreamReadResult {
  bytes: Buffer;
  contentType: string | null;
  contentEncoding: string | null;
  finalUrl: string;
  redirectsFollowed: number;
}

/* ------------------------------------------------------------------ */
/* 端口接口与装配令牌                                                  */
/* ------------------------------------------------------------------ */

/**
 * SafeUpstreamPort:sources/online-vod/playback 共用的有界安全上游读取端口。
 * 协议/DNS/每跳重定向/内网许可/timeout/byteBudget/AbortSignal 全部在实现内强制;
 * ffmpeg 等不得绕过本端口对任意嵌套地址联网(internal-ports §3)。
 */
export interface SafeUpstreamPort {
  /** 打开受控上游读取流(流式消费:片段/测速/大清单) */
  open(request: SafeUpstreamOpenRequest): Promise<SafeUpstreamStreamHandle>;
  /** 有界全量读取(CMS JSON/清单/key 等小体积响应) */
  read(request: SafeUpstreamOpenRequest): Promise<SafeUpstreamReadResult>;
}

/** NestJS/手工装配注入令牌(module 根以 useFactory 绑定实现) */
export const SAFE_UPSTREAM_PORT = Symbol('SAFE_UPSTREAM_PORT');

/* ------------------------------------------------------------------ */
/* 嵌套预算记账(供 HLS 多级读取)                                       */
/* ------------------------------------------------------------------ */

/**
 * 嵌套预算台账:跨 manifest→variant→segment→key 各级累计字节,超总量即中止
 * ledger.signal(后续读取立即 ABORTED);链总时限到期同样中止。
 */
export interface NestedBudgetLedger {
  /** 已记账累计字节(失败读取不计账) */
  readonly spentBytes: number;
  /** 剩余可用字节(总量 - 已记账) */
  readonly remainingBytes: number;
  /** 指定级别的单响应字节上限 */
  levelBudget(level: UpstreamNestedLevel): number;
  /** 记账:总量内 true;超总量返回 false 并中止 ledger.signal */
  charge(bytes: number): boolean;
  /** 台账中止信号:总量耗尽或链总时限到期即 aborted */
  readonly signal: AbortSignal;
  /** 取消链总时限计时并解除监听(链结束/取消时调用) */
  dispose(): void;
}
