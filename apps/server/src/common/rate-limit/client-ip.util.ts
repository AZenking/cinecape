import type { Request } from 'express';
import { getConfig } from '../../config/env';

/**
 * 限频客户端标识(T009,005 contracts/api.md §1「公共读取每连接 IP」「代理信任
 * 显式配置」)——
 *
 * - env.TRUST_PROXY=false(默认):只取 TCP 连接地址,完全忽略 X-Forwarded-For
 *   等转发头(直连部署下转发头可被任意客户端伪造,不可作为计数依据);
 * - env.TRUST_PROXY=true:取 X-Forwarded-For 首项(最右侧代理之前链路的客户端地址);
 *   部署侧必须保证仅可信代理能设置该头,这是显式配置的部署承诺;
 * - 两者都取不到时返回 'unknown'(全体共享一个桶,fail-closed 方向:宁可误限不可漏限)。
 *
 * DeviceSession 维度不走本文件:由守卫从 SessionGuard 写入的会话上下文取 session.id。
 */
export function clientIpOf(request: Request): string {
  if (getConfig().TRUST_PROXY) {
    const forwarded = request.headers['x-forwarded-for'];
    const firstHop =
      typeof forwarded === 'string'
        ? forwarded
        : Array.isArray(forwarded)
          ? (forwarded[0] ?? '')
          : '';
    const candidate = firstHop.split(',')[0]?.trim() ?? '';
    if (candidate !== '') {
      return candidate;
    }
  }
  return request.socket?.remoteAddress ?? 'unknown';
}
