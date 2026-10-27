import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentSession } from '../../common/current-session.decorator';
import type { SessionContext } from '../../common/current-session.decorator';
import { SameOriginGuard } from '../../common/same-origin/same-origin.guard';
import { SessionGuard } from '../../common/session.guard';
import { SettingsAccessGuard } from '../../common/settings-access/settings-access.guard';
import { StrictBodyPipe } from '../../common/strict-input/strict-pipes';
import { strictObject } from '../../common/strict-input/strict-schema';
import {
  createManagedProfile,
  listManagedProfiles,
  patchManagedProfile,
  transferMainProfile,
  type MainProfileReplyBody,
} from './settings-profiles.service';
import type { ProfileSummaryBody } from '../auth/account-session.dto';

/**
 * Profile 管理契约路由(T127,005 contracts/api.md §6;api.md §3「/profiles 只保留
 * 选档 GET/unlock/select,旧 POST/PATCH 移入 settings」):
 * - GET /settings/profiles:ProfileSummary[](Settings 边界);
 * - POST /settings/profiles:创建,当次密码(201 ProfileSummary);
 * - PATCH /settings/profiles/{profileId}:编辑/停用/PIN,expectedVersion CAS + 当次密码;
 * - PUT /settings/main-profile:主档案转移三项 CAS + 当次密码(200 MainProfileReply)。
 * 守卫链 SessionGuard + SettingsAccessGuard 承担 Session→角色/当前主 Profile→grant;
 * 严格入参 → 当次密码 → 重读身份/grant/归属/版本 → 事务由服务层承担(§7 次序)。
 */

/** 契约 B001CreateProfileRequest(pin 统一 6 位数字;ownerPassword 必填语义由服务层 403 表达) */
const createManagedProfileRequestSchema = strictObject({
  name: z.string().min(1).max(50),
  type: z.enum(['adult', 'child']),
  avatar: z.string().optional(),
  isDefault: z.boolean().default(false),
  pin: z.string().regex(/^[0-9]{6}$/, 'PIN 必须为 6 位数字').optional(),
  ownerPassword: z.string().optional(),
});

/** 契约 B001UpdateProfileRequest(新增 expectedVersion 必填;strictObject 未知字段拒绝) */
const patchManagedProfileRequestSchema = strictObject({
  expectedVersion: z.number().int().min(1),
  ownerPassword: z.string().optional(),
  name: z.string().min(1).max(50).optional(),
  avatar: z.string().optional(),
  isDefault: z.boolean().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  pin: z.string().regex(/^[0-9]{6}$/, 'PIN 必须为 6 位数字').optional(),
  clearPin: z.boolean().default(false),
});

/** 契约 MainProfileRequest(五键全部必填,additionalProperties:false) */
const mainProfileRequestSchema = strictObject({
  profileId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  expectedCurrentProfileVersion: z.number().int().min(1),
  expectedProfileVersion: z.number().int().min(1),
  ownerPassword: z.string().min(8).max(128),
});

@Controller('settings')
export class SettingsProfilesController {
  /** GET /settings/profiles:家庭全部档案的 ProfileSummary 白名单 */
  @Get('profiles')
  @UseGuards(SessionGuard, SettingsAccessGuard)
  list(@CurrentSession() context: SessionContext): ProfileSummaryBody[] {
    return listManagedProfiles(context.session.householdId, context.account.id);
  }

  /** POST /settings/profiles:创建档案(当次密码;201 ProfileSummary) */
  @Post('profiles')
  @HttpCode(201)
  @UseGuards(SameOriginGuard, SessionGuard, SettingsAccessGuard)
  async create(
    @CurrentSession() context: SessionContext,
    @Body(new StrictBodyPipe(createManagedProfileRequestSchema)) input: z.infer<typeof createManagedProfileRequestSchema>,
  ): Promise<ProfileSummaryBody> {
    return createManagedProfile(context, input);
  }

  /** PATCH /settings/profiles/{profileId}:编辑/停用/PIN(expectedVersion CAS + 当次密码) */
  @Patch('profiles/:profileId')
  @UseGuards(SameOriginGuard, SessionGuard, SettingsAccessGuard)
  async patch(
    @Param('profileId') profileId: string,
    @CurrentSession() context: SessionContext,
    @Body(new StrictBodyPipe(patchManagedProfileRequestSchema)) input: z.infer<typeof patchManagedProfileRequestSchema>,
  ): Promise<ProfileSummaryBody> {
    return patchManagedProfile(context, profileId, input);
  }

  /** PUT /settings/main-profile:主档案转移(三项 CAS;200 MainProfileReply) */
  @Put('main-profile')
  @UseGuards(SameOriginGuard, SessionGuard, SettingsAccessGuard)
  async transferMain(
    @CurrentSession() context: SessionContext,
    @Body(new StrictBodyPipe(mainProfileRequestSchema)) input: z.infer<typeof mainProfileRequestSchema>,
  ): Promise<MainProfileReplyBody> {
    return transferMainProfile(context, input);
  }
}
