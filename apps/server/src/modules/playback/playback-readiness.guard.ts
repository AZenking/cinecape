import { CanActivate, ServiceUnavailableException, Injectable } from '@nestjs/common';
import { Database } from '../../database/database';

/**
 * 播放域就绪门禁（T009 口径的业务端延伸）:
 * - healthz 已按 isReady() 返回 503(NOT_READY),但业务端点此前未设门——
 *   未就绪库(缺 0005 表/列)上 resolve 会以裸 SqliteError(≈500)暴露,而非稳定 Problem。
 * - 本门在播放控制器最前复用 healthz 同形 503 Problem(code=NOT_READY),
 *   fail-closed 且**绝不自动补表**;已就绪库零开销直通。
 * - 置于 SessionGuard 之前:未就绪属于服务级不可用,优先于认证语义。
 */
@Injectable()
export class PlaybackReadinessGuard implements CanActivate {
  canActivate(): boolean {
    if (!Database.isReady()) {
      throw new ServiceUnavailableException({
        type: 'https://homemedia.local/problems/not-ready',
        title: 'Service not ready',
        status: 503,
        code: 'NOT_READY',
        detail: '数据库未打开或迁移未应用',
      });
    }
    return true;
  }
}
