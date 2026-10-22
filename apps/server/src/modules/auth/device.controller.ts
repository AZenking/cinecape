import { Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard } from '../../common/session.guard';
import { CurrentSession } from '../../common/current-session.decorator';
import type { SessionContext } from '../../common/current-session.decorator';
import { parseParam } from './validation';
import {
  listHouseholdDevices,
  revokeHouseholdDevice,
  type DeviceDtoBody,
} from './device.service';

/** 契约 parameters:deviceId 为 UUID(format: uuid) */
const deviceIdSchema = z.uuid();

/**
 * 设备管理(T035/FR-011/012):GET /devices + POST /devices/{deviceId}/revoke。
 * 严格 Guard 会话信任源;家庭边界一律取自服务端会话(FR-006/FR-018),
 * 不接受客户端传入 householdId。
 */
@Controller('devices')
@UseGuards(SessionGuard)
export class DeviceController {
  /** 当前家庭设备列表(含已撤销,revokedAt 标注) */
  @Get()
  list(@CurrentSession() context: SessionContext): DeviceDtoBody[] {
    return listHouseholdDevices(context.session.householdId);
  }

  /** 契约:撤销成功 204,重复撤销同样 204(幂等);不存在/他家庭 → 404 */
  @Post(':deviceId/revoke')
  @HttpCode(204)
  revoke(
    @CurrentSession() context: SessionContext,
    @Param('deviceId') deviceId: string,
  ): void {
    revokeHouseholdDevice(
      context.session.householdId,
      parseParam(deviceIdSchema, deviceId, 'deviceId'),
    );
  }
}
