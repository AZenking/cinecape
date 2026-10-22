import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Database } from '../../database/database';

/**
 * FR-001:健康检查 —— 服务与持久化存储均就绪才返回 200。
 * 未就绪返回 RFC 9457 503(code=NOT_READY)。
 */
@Controller('healthz')
export class HealthController {
  @Get()
  check(): { status: 'ok'; database: 'ok' } {
    if (!Database.isReady()) {
      throw new ServiceUnavailableException({
        type: 'https://homemedia.local/problems/not-ready',
        title: 'Service not ready',
        status: 503,
        code: 'NOT_READY',
        detail: '数据库未打开或迁移未应用',
      });
    }
    return { status: 'ok', database: 'ok' };
  }
}
