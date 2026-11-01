/**
 * OnlineVodLocationPort(010 T042,US2;contracts/internal-ports.md §1/§3)。
 *
 * 端口语义(§1 逐字):「online-vod 发布业务接口,网络由基础设施实现|playback 授权后
 * 获取 ResolvedVodInput,期望定位/内容/连续性版本+统一截止/取消;不返回公共 DTO」。
 *
 * ResolvedVodInput(§3 逐字):「包含 resource/source/locator/detail/content/continuity
 * revision、证据、私有入口、resolvedAt/expiresAt 和请求策略ID;playback registry 持有
 * 会话引用/租约。probe、HLS代理、ffmpeg输入/seek 均用该 ID,不各自重读最新 location」。
 *
 * 私有性边界(双重声明,返回类型 + JSDoc):
 * - ResolvedVodInput 是 playback 私有值对象(data-model §6「resolved_input/playback
 *   私有…不对客户端公开」),其 entryUrl 字段为**上游入口地址**——只允许经受控交付面
 *   (SafeUpstream/HLS 代理/已验证 ffmpeg 输入通路,§3)消费;
 * - 本端口的任何返回值/错误信息都不得进入公共 DTO、响应体、日志或审计记录;
 *   结构化日志只含脱敏 ID(resolvedInputId/sourceId/sessionId)与稳定错误码
 *   (internal-ports §4「不输出原URL/payload」)。
 *
 * 固定输入语义(T042,经 VodInputBindingSink 落库,data-model §6 逐字):
 * - 「每 session/generation 最多一有效绑定」;
 * - 「frozen_start_seconds(nullable直到probe)」:绑定落库即 NULL,probe 后由 T041
 *   经 playback InputBindingTx.freezeStartSeconds 冻结一次(NULL 起点亦属合法冻结);
 * - 「start_basis(beginning/target_history/transition_carry)」三值随绑定落库;
 * - 「首次定位允许一次替换未接受的probe输入」归 store replaceUnacceptedProbeInput;
 * - 新代沿用输入不暗换最新地址:resolveVodInput 同 session/generation 幂等固定,
 *   上游网络解析全程恰一次(地址轮换后重入不重读)。
 *
 * 实现绑定归 online-vod.module(T042 起;令牌 ONLINE_VOD_LOCATION_PORT);实现类不经
 * index.ts 导出,playback 只消费本文件纯 TS 类型。
 *
 * 010 T090 knip 清理:T042 参考实现 application/location.service.ts 已删除——实际
 * 运行路径由 T043 ResolverVodInputBridge(playback/application/playback-vod-resolve
 * .providers,经 playback-input-store 落固定绑定)+ T072 store 直取承担;本文件保留
 * 为契约/类型发布面(ResolvedVodInput 语义与私有性纪律的唯一权威声明)。
 */

/* ------------------------------------------------------------------ */
/* 值模型                                                                */
/* ------------------------------------------------------------------ */

/** 起点依据三值(data-model §6;与 playback StartBasis 同域,契约面独立声明) */
export type VodStartBasis = 'beginning' | 'target_history' | 'transition_carry';

/**
 * 上游网络解析事实(io.resolveUpstream seam 返回;网络由基础设施/既有交付面实现,
 * 在事务外执行)。entryUrl 为私有入口地址,只在本值对象与私有绑定间流转。
 */
export interface VodResolvedInputFacts {
  /** 私有入口地址(⚠️ 绝不进入公共 DTO/日志/任何持久行) */
  readonly entryUrl: string;
  readonly locatorRevision: number;
  readonly detailRevision: number | null;
  readonly contentRevision: number;
  readonly continuityRevision: number | null;
  readonly evidenceState: 'unverified' | 'verified';
  readonly evidenceDigest: string;
  /** 输入租约有界(秒;expiresAt = resolvedAt + leaseSeconds) */
  readonly leaseSeconds: number;
}

/**
 * 交给 io.resolveUpstream 的私有定位(经 vod_detail_snapshot.validated_private_payload
 * 私有载荷提取;只经此 seam 交给受控交付面,不落日志)。
 */
export interface VodPrivateLocator {
  readonly entryLocatorUrl: string;
}

/**
 * 期望修订面(§1「期望定位/内容/连续性版本」;省略维度不参与失配判定)。
 * 失配即拒绝(VOD_DETAIL_CHANGED 409,准备转 failed 需新 resolve,data-model §3)。
 */
export interface VodLocationExpectedRevisions {
  readonly locatorRevision: number;
  readonly detailRevision?: number | null;
  readonly contentRevision: number;
  readonly continuityRevision?: number | null;
}

/** 定位命令(playback 授权后发起;统一截止/取消由调用方经 deadline/signal 传入) */
export interface VodLocationCommand {
  readonly householdId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly mediaId: string;
  /** 本次会话起点依据(消费过渡/起点计算确定;三值随私有绑定落库) */
  readonly startBasis: VodStartBasis;
  readonly expected: VodLocationExpectedRevisions;
  /** 请求策略 ID(§3「固定请求策略/修订」;仅随私有绑定/私有值对象流转,不进公共 DTO) */
  readonly requestPolicyId: string;
  /** 统一截止(ms 时间戳;网络面在此前完成或超时失败,事务内不等待) */
  readonly deadlineAtMs?: number;
  /** 取消信号(任务取消/会话终止时中断在途解析) */
  readonly signal?: AbortSignal;
}

/**
 * ResolvedVodInput —— playback 私有值对象(§3;⚠️ 不返回公共 DTO:本类型不得出现在
 * 任何 Controller 返回面/响应映射/日志插值中;entryUrl 仅经受控交付面消费)。
 */
export interface ResolvedVodInput {
  /** 私有不透明输入 ID:probe/HLS代理/ffmpeg输入/seek 统一消费点(§3) */
  readonly resolvedInputId: string;
  readonly sourceId: string;
  readonly mediaId: string;
  /** 私有入口地址(⚠️ 绝不进入公共 DTO/日志/任何持久行) */
  readonly entryUrl: string;
  readonly locatorRevision: number;
  readonly detailRevision: number | null;
  readonly contentRevision: number;
  readonly continuityRevision: number | null;
  readonly evidenceState: 'unverified' | 'verified';
  readonly evidenceDigest: string;
  readonly resolvedAt: string;
  /** 输入租约有界(§6「租约必须可取消/有界」);过期进入 failed,不在分片中间换源 */
  readonly expiresAt: string;
  readonly requestPolicyId: string;
}

/**
 * 私有绑定落库 seam(playback 侧 VOD 固定输入 store 的窄接口;组合根由
 * playback/infrastructure/playback-input-store.drizzle 适配,T043 接线)。
 * 语义即 data-model §6:唯一绑定/frozen NULL 直到 probe/start_basis 三值。
 */
export interface VodInputBindingSink {
  resolveVodInput(
    command: { householdId: string; sessionId: string; generation: number; sourceId: string },
    io: { resolveUpstream: () => Promise<VodResolvedInputFacts> },
  ): Promise<{ resolvedInputId: string }>;
  bindFixedInput(
    command: { householdId: string; sessionId: string; generation: number; sourceId: string; startBasis: VodStartBasis },
    io: { resolveUpstream: () => Promise<VodResolvedInputFacts> },
  ): Promise<{ bindingId: string }>;
}

/* ------------------------------------------------------------------ */
/* 端口                                                                  */
/* ------------------------------------------------------------------ */

/**
 * OnlineVodLocationPort:授权后按 mediaId + 期望修订解析固定 ResolvedVodInput 并落
 * 私有绑定。实现方(online-vod)经 T027 store/vod 表取私有 locator;网络解析在事务外
 * 经 io.resolveUpstream(既有交付面/SafeUpstream)执行;解析事实冻结为本次输入,
 * 重复消费不重读最新 location(§3「不各自重读」)。
 */
export interface OnlineVodLocationPort {
  resolveVodInput(
    command: VodLocationCommand,
    io: { resolveUpstream: (locator: VodPrivateLocator) => Promise<VodResolvedInputFacts> },
  ): Promise<ResolvedVodInput>;
}
