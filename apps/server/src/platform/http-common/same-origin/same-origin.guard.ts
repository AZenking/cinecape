import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ProblemCode as ProblemCodeConst } from '@hmp/shared';
import { getConfig } from '@platform/config/env';
import { DomainError } from '@platform/http-common/domain-error';

/**
 * 同源校验(T009,005 contracts/api.md §1)——
 * 「所有写操作和带密码的查询必须校验同源 Origin(存在时必须与配置 origin 精确匹配),
 * 拒绝跨站 Cookie 请求与非 JSON 简单表单;无 Origin 的显式 Bearer 客户端仅按认证规则,
 * 不以 absence 放宽 Cookie 写入。」
 *
 * 判定规则(assertSameOrigin,可独立复用于服务层带密码查询):
 * 1. 未携带 Origin → 通过。absence 只表示「非浏览器/同源 GET」两种无法区分的形态,
 *    本校验不因此产生任何放行语义:Cookie 会话仍须经 SessionGuard 完整校验,
 *    不存在「无 Origin = 允许 Cookie 写入」的放宽;
 * 2. 携带 Origin → 与 env.PUBLIC_ORIGIN 逐字(归一化 origin 形态)精确匹配;
 *    未配置 PUBLIC_ORIGIN 属 fail-closed:携带 Origin 一律 403 拒绝;
 * 3. 写方法(POST/PUT/PATCH/DELETE)且请求体存在时,Content-Type 必须为
 *    application/json —— 拒绝 form/text 等简单表单型跨站写入;无体请求(如幂等
 *    DELETE)不检查 Content-Type。
 *
 * 挂载:由后续任务在新建控制器上 `@UseGuards(SessionGuard, SameOriginGuard)` 使用
 * (T009 不改既有控制器,不回退现有路由);Public 只读路由不挂本 Guard。
 */

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** 请求是否携带非空请求体(Content-Length 或 chunked Transfer-Encoding) */
function hasRequestBody(request: Request): boolean {
  const contentLength = request.headers['content-length'];
  if (typeof contentLength === 'string' && contentLength.trim() !== '' && Number(contentLength) > 0) {
    return true;
  }
  const transferEncoding = request.headers['transfer-encoding'];
  return typeof transferEncoding === 'string' && transferEncoding.trim() !== '';
}

/** Origin 存在时与配置 origin 精确匹配;写方法拒绝非 JSON 简单表单体 */
export function assertSameOrigin(request: Request): void {
  const originHeader = request.headers.origin;
  const origin = typeof originHeader === 'string' ? originHeader.trim() : '';
  if (origin !== '') {
    // 请求时读取(非模块加载期),契约测试的 setEnvOverride 注入真实生效
    const configured = getConfig().PUBLIC_ORIGIN;
    if (configured === '') {
      // fail-closed:未配置许可 origin 时,任何携带 Origin 的请求都不存在「精确匹配」
      throw new DomainError(403, ProblemCodeConst.FORBIDDEN, '服务未配置许可来源,已拒绝跨站请求');
    }
    if (origin !== configured) {
      throw new DomainError(403, ProblemCodeConst.FORBIDDEN, '请求来源与许可配置不符,已拒绝');
    }
  }
  const method = request.method.toUpperCase();
  if (WRITE_METHODS.has(method) && hasRequestBody(request)) {
    const contentTypeHeader = request.headers['content-type'];
    const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader.trim().toLowerCase() : '';
    if (contentType !== '' && !contentType.startsWith('application/json')) {
      throw new DomainError(400, ProblemCodeConst.VALIDATION_FAILED, '写操作仅接受 JSON 请求体');
    }
  }
}

@Injectable()
export class SameOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    assertSameOrigin(request);
    return true;
  }
}
