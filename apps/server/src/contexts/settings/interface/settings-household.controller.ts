import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentSession } from '@platform/http-common/current-session.decorator';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { SameOriginGuard } from '@platform/http-common/same-origin/same-origin.guard';
import { SessionGuard } from '@platform/http-common/session.guard';
import { SettingsAccessGuard } from '@platform/http-common/settings-access/settings-access.guard';
import { StrictBodyPipe } from '@platform/http-common/strict-input/strict-pipes';
import { strictObject } from '@platform/http-common/strict-input/strict-schema';
import {
  getHouseholdSettings,
  patchHouseholdSettings,
  type HouseholdSettingsBody,
} from '@contexts/settings/application/settings-household.service';

/**
 * 通用设置契约路由(T130,005 contracts/api.md §6;FR-039):
 * - GET /settings/household:HouseholdSettings 投影(Settings 边界,逐请求重检);
 * - PATCH /settings/household:{expectedVersion,ownerPassword 必填,name?/language?/
 *   timezone?} —— 当次密码 + version CAS;unknown 字段 400。
 */

/** 契约 PatchHouseholdRequest(openapi components/schemas;ownerPassword 必填) */
const patchHouseholdRequestSchema = strictObject({
  expectedVersion: z.number().int().min(1),
  ownerPassword: z.string().min(8).max(128),
  name: z.string().min(1).max(100).optional(),
  language: z.string().min(1).max(35).optional(),
  timezone: z.string().min(1).max(100).optional(),
});

@Controller('settings')
export class SettingsHouseholdController {
  @Get('household')
  @UseGuards(SessionGuard, SettingsAccessGuard)
  getHouseholdSettings(@CurrentSession() context: SessionContext): HouseholdSettingsBody {
    return getHouseholdSettings(context.session.householdId);
  }

  @Patch('household')
  @UseGuards(SameOriginGuard, SessionGuard, SettingsAccessGuard)
  async patchHousehold(
    @CurrentSession() context: SessionContext,
    @Body(new StrictBodyPipe(patchHouseholdRequestSchema)) input: z.infer<typeof patchHouseholdRequestSchema>,
  ): Promise<HouseholdSettingsBody> {
    return patchHouseholdSettings(context, input);
  }
}
