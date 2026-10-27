/**
 * 选档档案列表数据访问(T026;006 contracts/data-access.md 分层不变式)。
 *
 * - GET /profiles 的唯一端点出口:选档步骤(features/profiles/profile-picker-step)
 *   经此触网,传输一律 `privateFetch`(credentials:'same-origin')—— 列表是
 *   登录会话(已认证未选档)作用域的投影,服务端按当前会话推导,非匿名公共数据;
 * - 不走 useAppQuery 的理由(记录):shared/query/keys.ts 键工厂(本任务只读)
 *   无「选档列表」键;该列表为会话作用域的敏感前置数据,进入共享查询缓存有
 *   跨身份残留风险(原则三/六),现行「挂载即取 + 失败重试」无需 SWR 语义;
 * - 错误保持 `FetchApiError` 原样上抛,401/网络失败的文案分流由步骤呈现。
 */
import { privateFetch } from '../../shared/fetch';
import type { ProfileSummary } from '../../app/session-types';

/**
 * GET /profiles:当前登录会话可选档案的 ProfileSummary 投影(FR-008)。
 * 含禁用档案(status !== 'active',置灰不可选);选择动作不在本模块
 * (选档/PIN 解锁由协调器执行,confirmed 语义,不缓存凭据)。
 */
export function fetchSelectableProfiles(): Promise<ProfileSummary[]> {
  return privateFetch<ProfileSummary[]>('/profiles');
}
