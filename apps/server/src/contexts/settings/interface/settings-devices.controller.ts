import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { PlaybackRecordPageDto } from '@contexts/settings/application/settings-devices.service';
import { CurrentSession } from '@platform/http-common/current-session.decorator';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { SameOriginGuard } from '@platform/http-common/same-origin/same-origin.guard';
import { SessionGuard } from '@platform/http-common/session.guard';
import { SettingsAccessGuard } from '@platform/http-common/settings-access/settings-access.guard';
import { StrictBodyPipe } from '@platform/http-common/strict-input/strict-pipes';
import { strictObject } from '@platform/http-common/strict-input/strict-schema';
import { parseBody } from '@contexts/identity-access';
import { listDevices, queryDevicePlaybackRecords, revokeDevice } from '@contexts/settings/application/settings-devices.service';

/**
 * 设备与会话契约路由(T130,005 contracts/api.md §6「devices 三组」;api.md §8
 * 「不保留旧 /devices 管理入口」):
 * - GET /settings/devices:设备列表(Settings 边界);
 * - POST /settings/devices/{deviceId}/revoke:{ownerPassword} → 204(撤销目标设备
 *   所有会话和授予;未知/跨家庭 deviceId 与不存在同形 404,不泄露归属);
 * - POST /settings/devices/{deviceId}/playback-records/query:经必要再验证的播放记录
 *   (当次密码;不能用作个人历史)。记录响应显式 no-store/no-referrer。
 */

/** 契约 OwnerPasswordRequest(openapi components/schemas) */
const ownerPasswordRequestSchema = strictObject({
  ownerPassword: z.string().min(8).max(128),
});

/** 契约 PlaybackRecordQueryRequest(strict;ownerPassword 必填语义由服务层 403 表达) */
const recordsQueryRequestSchema = strictObject({
  ownerPassword: z.string().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

/** 设备列表不接受任何 query 参数(未知 query 键一律 400,api.md §1) */
const noQuerySchema = z.strictObject({});

@Controller('settings')
@UseGuards(SessionGuard, SettingsAccessGuard)
export class SettingsDevicesController {
  /** GET /settings/devices:当前家庭设备列表(含已撤销,revokedAt 标注) */
  @Get('devices')
  list(@Query() query: unknown, @CurrentSession() context: SessionContext): ReturnType<typeof listDevices> {
    parseBody(noQuerySchema, query);
    return listDevices(context.session.householdId);
  }

  /** POST /settings/devices/{deviceId}/revoke:当次密码;204(幂等) */
  @Post('devices/:deviceId/revoke')
  @HttpCode(204)
  @UseGuards(SameOriginGuard)
  async revoke(
    @Param('deviceId') deviceId: string,
    @Body(new StrictBodyPipe(ownerPasswordRequestSchema))
    input: z.infer<typeof ownerPasswordRequestSchema>,
    @CurrentSession() context: SessionContext,
  ): Promise<void> {
    await revokeDevice(context, deviceId, input);
  }

  /** POST /settings/devices/{deviceId}/playback-records/query:当次密码;200 记录页(脱敏) */
  @Post('devices/:deviceId/playback-records/query')
  @HttpCode(200)
  @UseGuards(SameOriginGuard)
  async queryRecords(
    @Param('deviceId') deviceId: string,
    @Body(new StrictBodyPipe(recordsQueryRequestSchema))
    input: z.infer<typeof recordsQueryRequestSchema>,
    @Res({ passthrough: true }) res: Response,
    @CurrentSession() context: SessionContext,
  ): Promise<PlaybackRecordPageDto> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return queryDevicePlaybackRecords(context, deviceId, input);
  }
}
