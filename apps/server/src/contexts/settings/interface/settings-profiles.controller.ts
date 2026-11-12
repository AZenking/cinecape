import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentSession } from '@platform/http-common/current-session.decorator';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { SameOriginGuard } from '@platform/http-common/same-origin/same-origin.guard';
import { SessionGuard } from '@platform/http-common/session.guard';
import { SettingsGuard } from '@contexts/settings/infrastructure/settings.guard';
import { StrictBodyPipe } from '@platform/http-common/strict-input/strict-pipes';
import { strictObject } from '@platform/http-common/strict-input/strict-schema';
import {
  createManagedProfile,
  listManagedProfiles,
  patchManagedProfile,
  transferMainProfile,
  type MainProfileReplyBody,
} from '@contexts/settings/application/settings-profiles.service';
import type { ProfileSummaryBody } from '@contexts/identity-access';

/**
 * Profile 管理契约路由(T127,005 contracts/api.md §6;api.md §3「/profiles 只保留
 * 选档 GET/unlock/select,旧 POST/PATCH 移入 settings」;013-role-differentiated-settings/
 * ADR-0017:创建档案属常规运维免当次密码;编辑仅 PIN 变更(pin/clearPin)保留单次密码,
 * 纯 name/avatar/isDefault/status 免密码;主档案转移为不可逆高危操作保留单次密码):
 * - GET /settings/profiles:ProfileSummary[](Settings 边界);
 * - POST /settings/profiles:创建(201 ProfileSummary;013 起免当次密码);
 * - PATCH /settings/profiles/{profileId}:编辑/停用/PIN,expectedVersion CAS + 条件密码闸
 *   (仅 pin/clearPin 时要求 ownerPassword,schema 保持 optional);
 * - PUT /settings/main-profile:主档案转移三项 CAS + 单次当次密码(200 MainProfileReply)。
 * 守卫链 SessionGuard + SettingsGuard 承担 Session→角色/当前主 Profile→grant;
 * 严格入参 → (条件)当次密码 → 重读身份/grant/归属/版本 → 事务由服务层承担(§7 次序)。
 */

/** 契约 B001CreateProfileRequest(pin 统一 6 位数字;013 起免当次密码,ownerPassword 不再入契约) */
const createManagedProfileRequestSchema = strictObject({
  name: z.string().min(1).max(50),
  type: z.enum(['adult', 'child']),
  avatar: z.string().optional(),
  isDefault: z.boolean().default(false),
  pin: z.string().regex(/^[0-9]{6}$/, 'PIN 必须为 6 位数字').optional(),
});

/** 契约 B001UpdateProfileRequest(新增 expectedVersion 必填;strictObject 未知字段拒绝;
 *  ownerPassword 保持 optional —— 仅请求携带 pin/clearPin 时由服务层要求) */
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
  @UseGuards(SessionGuard, SettingsGuard)
  list(@CurrentSession() context: SessionContext): ProfileSummaryBody[] {
    return listManagedProfiles(context.session.householdId, context.account.id);
  }

  /** POST /settings/profiles:创建档案(013 起免当次密码;201 ProfileSummary) */
  @Post('profiles')
  @HttpCode(201)
  @UseGuards(SameOriginGuard, SessionGuard, SettingsGuard)
  async create(
    @CurrentSession() context: SessionContext,
    @Body(new StrictBodyPipe(createManagedProfileRequestSchema)) input: z.infer<typeof createManagedProfileRequestSchema>,
  ): Promise<ProfileSummaryBody> {
    return createManagedProfile(context, input);
  }

  /** PATCH /settings/profiles/{profileId}:编辑/停用/PIN(expectedVersion CAS;仅 pin/clearPin 要求当次密码) */
  @Patch('profiles/:profileId')
  @UseGuards(SameOriginGuard, SessionGuard, SettingsGuard)
  async patch(
    @Param('profileId') profileId: string,
    @CurrentSession() context: SessionContext,
    @Body(new StrictBodyPipe(patchManagedProfileRequestSchema)) input: z.infer<typeof patchManagedProfileRequestSchema>,
  ): Promise<ProfileSummaryBody> {
    return patchManagedProfile(context, profileId, input);
  }

  /** PUT /settings/main-profile:主档案转移(三项 CAS + 单次当次密码;200 MainProfileReply) */
  @Put('main-profile')
  @UseGuards(SameOriginGuard, SessionGuard, SettingsGuard)
  async transferMain(
    @CurrentSession() context: SessionContext,
    @Body(new StrictBodyPipe(mainProfileRequestSchema)) input: z.infer<typeof mainProfileRequestSchema>,
  ): Promise<MainProfileReplyBody> {
    return transferMainProfile(context, input);
  }
}
