import { eq } from 'drizzle-orm';
import { createDomainError, type DomainError } from '@platform/http-common/domain-error';
import type { PlaybackBudgets } from '@platform/config/playback-budgets';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { getDb, generateToken, hashToken } from '@contexts/identity-access';
import { deviceSession, playbackSession, playbackTicket } from '@platform/database/schema';
import { isPlaybackTerminalSessionState } from '@contexts/playback/domain/playback.types';
import type { PlaybackAuthorizationService } from '@contexts/playback/application/playback-authorization.service';
import type { PlaybackRepository } from '@contexts/playback/infrastructure/playback.repository';
import type { PlaybackErr, PlaybackTicketView } from '@contexts/playback/domain/playback.types';

/**
 * 播放票据服务(T018,spec 004)—— 256-bit opaque 票的签发与续期:
 *
 * - 票据明文只在本次响应出现一次(contracts/api.md TicketReply):随机 256bit
 *   crypto 随机数经 base64url 编码(与 SessionGuard 设备令牌同 generateToken/hashToken
 *   算法);库中仅落 sha256 hash(playback_ticket.token_hash,UNIQUE),会话侧无法复现明文 URL;
 * - 状态门槛(经仓储既有短事务语义,不在此重复判定):仅 ready/playing/paused 可签发;
 *   preparing → 409 PLAYBACK_NOT_READY;终态 → ended 409 PLAYBACK_ENDED、
 *   failed/interrupted 409 PLAYBACK_NOT_READY(terminalGuardCode 集中映射,T011 已钉死);
 * - generation CAS:expectedGeneration 在签发票的短事务内与库内当前代比较
 *   (playback.repository.issueTicket),不一致返回 PLAYBACK_GENERATION_STALE 且不写票行;
 * - 续期=新票新行:issued_at/expires_at/generation 独立落行;不创建 session/转换、
 *   不递增 version/generation;旧票原 expires_at 不变且不撤销(过期清理走 T045);
 * - TTL = budgets.ticket.ttlSeconds(默认 5 分钟,60~900 可调);提前续期秒数以
 *   PLAYBACK_RENEW_LEAD_SECONDS 常量导出(与 budgets.ticket.renewLeadSeconds 同值,
 *   供前端 T050 客户端轮询逻辑使用);
 * - 授权集成:authorizeControl(会话归属/绑定档案/策略/家庭资源)→ revalidate(提交前
 *   重验,防异步授权窗口变更)→ 短事务签发;任一授权拒绝抛稳定 DomainError 且不签票。
 *   ready 前无票由本服务的仓储门槛保证(T019 resolver 的 preparing 会话在此被拒);
 * - 流入口票校验(validateStreamTicket,T037 裁决 ②):hash → 撤销 → TTL → session 绑定 →
 *   终态票门(T040,回收会话旧票立即失效)→ 设备会话/实时 generation 绑定
 *   (api.md「媒体端点」鉴权链的票段集中于此);
 * - playbackUrl 仅服务端同源路径(无源地址/位置),query 携带 opaque ticket;
 *   访问日志经 common/log-redaction.util 的 redactQueryTicket 统一脱敏(T012)。
 */

/** 提前续期秒数(客户端逻辑,T050 播放器在到期前该秒数发起 renew);与 budgets.ticket.renewLeadSeconds 同源同值 */
export const PLAYBACK_RENEW_LEAD_SECONDS = 60;

/** renew 响应(contracts/api.md TicketReply):URL 携带 opaque ticket,明文仅出现这一次 */
export interface TicketReply {
  readonly playbackUrl: string;
  readonly ticketExpiresAt: string;
  readonly generation: number;
}

export interface IssueOrRenewOptions {
  /** 签发时刻(UTC ISO-8601;缺省 now。测试注入确定时钟) */
  readonly at?: string;
}

/** 入口资产段:清单/首片资产 ID 由 T022 映射层签发,入口清单使用固定 'index' 资产名 */
const ENTRY_ASSET_ID = 'index';

/** 同源播放入口 URL(无源地址/位置;query ticket 由日志层脱敏) */
function buildPlaybackUrl(sessionId: string, generation: number, token: string): string {
  return `/api/playback/stream/${sessionId}/${generation}/${ENTRY_ASSET_ID}?ticket=${token}`;
}

/** 仓储领域失败 → 稳定 DomainError(DOMAIN_PROBLEM_REGISTRY 集中携带 status) */
function playbackErrToDomainError(result: PlaybackErr): DomainError {
  return createDomainError(result.code, result.detail);
}

export class PlaybackTicketService {
  constructor(
    private readonly repository: PlaybackRepository,
    private readonly authorization: PlaybackAuthorizationService,
    private readonly budgets: PlaybackBudgets,
  ) {}

  /**
   * 签发或续期票据(首次 ready 后申请与提前 60 秒续期共用本入口,api.md renew 行):
   *
   * 1. authorizeControl:会话归属(非本设备统一 404 PLAYBACK_NOT_FOUND)/绑定档案仍是
   *    当前档案(403)/最新策略与家庭可用资源(404/503)——任一拒绝不签票;
   * 2. revalidate:提交前重验(api.md:renew 最终提交前重验授权,防异步授权窗口变更),
   *    全链实时重跑,不缓存授权正结果;
   * 3. 短事务签发(仓储 issueTicket):状态门槛 + expectedGeneration CAS + 新票新行,
   *    旧票一律不动;CAS 失败 409 PLAYBACK_GENERATION_STALE 且不写票行。
   *
   * @param sessionId          播放会话 id
   * @param expectedGeneration 客户端持有的当前代(换代即拒:seek/重建换轨后旧代不可签)
   * @param context            SessionGuard 校验后的可信会话上下文
   * @param options            at 注入(测试确定时钟)
   */
  async issueOrRenew(
    sessionId: string,
    expectedGeneration: number,
    context: SessionContext,
    options: IssueOrRenewOptions = {},
  ): Promise<TicketReply> {
    const grant = await this.authorization.authorizeControl(context, sessionId);
    // 提交前重验:authorizeControl 与签发之间授权事实可能变化(策略收紧/会话撤销/换档案)
    await this.authorization.revalidate(
      grant.snapshot.deviceSessionId,
      grant.snapshot.profileId,
      grant.snapshot.mediaId,
    );
    // 明文仅存在于本调用返回值;库中只有 sha256 hash(对齐仓储/夹具 hashToken 算法)
    const token = generateToken();
    const issued = this.repository.issueTicket(sessionId, {
      expectedGeneration,
      tokenHash: hashToken(token),
      ttlSeconds: this.budgets.ticket.ttlSeconds,
      at: options.at,
    });
    if (!issued.ok) {
      throw playbackErrToDomainError(issued);
    }
    const ticket: PlaybackTicketView = issued.value;
    return {
      playbackUrl: buildPlaybackUrl(ticket.sessionId, ticket.generation, token),
      ticketExpiresAt: ticket.expiresAt,
      generation: ticket.generation,
    };
  }

  /**
   * 流媒体入口票校验(T037 裁决 ②/E1+E3 根修;api.md「媒体端点」鉴权链的票段权威实现):
   *
   * 1. sha256(token) 查 playback_ticket 行(明文不入库,仅存 hash;与签发同 hashToken 算法)
   *    → 行不存在/已撤销 → 401 PLAYBACK_TICKET_INVALID;
   * 2. TTL:恰好过期 = 已过期(过期先行 → 401 PLAYBACK_TICKET_EXPIRED);
   * 3. session 绑定:票行.session_id === 请求路径 sessionId(跨 session → 401 INVALID);
   * 4. 终态票门(T040;data-model「## playback_ticket」节末「终态票拒绝」):join
   *    playback_session 实时行后,state ∈ 终态(ended/failed/interrupted)→ 401
   *    PLAYBACK_TICKET_INVALID —— 会话被生命周期回收(stop 落 ended、45 秒失联/重启恢复/
   *    权限复核拒绝落 interrupted、媒体故障落 failed)后,回收前签出的未撤销未过期票
   *    立即失效,授权事实恢复(设备重新可达、授权重验通过)亦不得让旧票继续取流;
   *    preparing 不在拒绝集:签发门槛仅 ready/playing/paused 可签票(仓储守卫),
   *    preparing 会话不存在有效票,而「active 后 seek 换代」的旧代票已被实时 generation
   *    门(步骤 7)拒绝 —— 「preparing 会话的有效票」在本实现中自然不可达,故不新增
   *    preparing 拒绝(避免与「ready 后签票」语义重复设门);
   * 5. 家庭边界先于设备绑定:请求设备会话与播放会话跨家庭(或请求会话行不存在)→ 404
   *    PLAYBACK_NOT_FOUND 同形 —— 与 authorizeControl「非本设备会话统一 404」同口径,
   *    家庭归属不得因持有有效票而降级为票据错误(跨家庭矩阵行 D1 保持 404 同形);
   * 6. 设备会话绑定(E1 根修):同家庭内该 session 归属的 device_session_id !== 当前请求
   *    设备会话 id → 401 PLAYBACK_TICKET_INVALID —— 票不可复制到同账号其他设备
   *    (api.md 媒体端点「绑定 session/device/profile」);
   * 7. 实时 generation 绑定(E3 根修):票行.generation === 请求路径 generation 且 ===
   *    playback_session 行当前实时 generation —— 旧代票立即失效,无论会话 ready/preparing
   *    (api.md seek 行「旧票立即失效」),不符 → 401 INVALID。
   *
   * 库内事实全部实时读取(getDb 直查,authorization/lifecycle 同款先例,不扩仓储 API 面),
   * 不缓存任何正结果;票据维度拒绝统一 401 同形,不泄露存在性。
   */
  validateStreamTicket(
    token: string,
    bound: { readonly sessionId: string; readonly generation: number; readonly deviceSessionId: string },
  ): void {
    const row = getDb().select().from(playbackTicket).where(eq(playbackTicket.tokenHash, hashToken(token))).get();
    if (row === undefined || row.revokedAt !== null) {
      throw createDomainError('PLAYBACK_TICKET_INVALID');
    }
    if (!(Date.parse(row.expiresAt) > Date.now())) {
      throw createDomainError('PLAYBACK_TICKET_EXPIRED');
    }
    if (row.sessionId !== bound.sessionId) {
      throw createDomainError('PLAYBACK_TICKET_INVALID');
    }
    const session = getDb().select().from(playbackSession).where(eq(playbackSession.id, bound.sessionId)).get();
    if (session === undefined) {
      throw createDomainError('PLAYBACK_TICKET_INVALID');
    }
    // 终态票门(T040;data-model「## playback_ticket」节末「终态票拒绝」):被生命周期
    // 回收(ended/failed/interrupted)会话的未撤销未过期旧票立即失效 —— 授权事实恢复
    // 后亦不得经本网关继续取流。preparing 不新增拒绝:签发门槛仅 ready/playing/paused,
    // preparing 无票可校验;换代旧票由下方实时 generation 门拒绝,该状态自然不可达。
    if (isPlaybackTerminalSessionState(session.state)) {
      throw createDomainError('PLAYBACK_TICKET_INVALID');
    }
    // 家庭边界先于设备绑定(请求设备会话行经 SessionGuard 必存在,此处防御性同形 404)
    const requester = getDb()
      .select({ householdId: deviceSession.householdId })
      .from(deviceSession)
      .where(eq(deviceSession.id, bound.deviceSessionId))
      .get();
    if (requester === undefined || requester.householdId !== session.householdId) {
      // 跨家庭:404 PLAYBACK_NOT_FOUND 同形(api.md 控制行「跨设备/家庭 session 统一 404」)
      throw createDomainError('PLAYBACK_NOT_FOUND');
    }
    if (session.deviceSessionId !== bound.deviceSessionId) {
      // 同家庭跨设备:票设备绑定失败 → 401 TICKET_INVALID(E1)
      throw createDomainError('PLAYBACK_TICKET_INVALID');
    }
    // 路径代与票代一致 + 票代与会话当前实时代一致(旧代票立即失效的单一权威判定)
    if (row.generation !== bound.generation || row.generation !== session.generation) {
      throw createDomainError('PLAYBACK_TICKET_INVALID');
    }
  }
}
