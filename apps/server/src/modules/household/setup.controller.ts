import { Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  buildSessionDto,
  issueSession,
  setSessionCookie,
  type SessionDtoBody,
} from '../auth/session.service';
import { registerDevice } from '../auth/device.service';
import { hashPassword } from '../auth/password.service';
import { parseBody } from '../auth/validation';
import { initializeHousehold, isInitialized } from './household.service';

/** 契约 InitializeRequest(components/schemas/InitializeRequest) */
const initializeRequestSchema = z.object({
  householdName: z.string().min(1).max(100),
  defaultLanguage: z.string().default('zh-CN'),
  timezone: z.string().default('Asia/Shanghai'),
  username: z.string().min(3).max(64),
  password: z.string().min(8).max(128),
});

/**
 * 初始化向导契约(T018,security: [] 无会话要求):
 * - GET /setup/status:前端向导入口判断(查 household 表有无行);
 * - POST /setup/initialize:事务内创建唯一 Household + owner Account(密码仅存哈希),
 *   成功后自动为请求设备建立会话并返回 SessionDto(同登录响应,含 Set-Cookie,FR-008);
 *   已初始化时 409 INITIALIZATION_ALREADY_DONE。
 */
@Controller('setup')
export class SetupController {
  @Get('status')
  status(): { initialized: boolean } {
    return { initialized: isInitialized() };
  }

  @Post('initialize')
  @HttpCode(201)
  async initialize(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionDtoBody> {
    const input = parseBody(initializeRequestSchema, body);
    const passwordHash = await hashPassword(input.password);

    const created = initializeHousehold({
      householdName: input.householdName,
      defaultLanguage: input.defaultLanguage,
      timezone: input.timezone,
      username: input.username,
      passwordHash,
    });

    // 初始化请求视为发起设备:契约 InitializeRequest 无设备字段,
    // 按服务端默认注册 web 类型设备(data-model.md §device 说明)
    const device = registerDevice({ householdId: created.household.id, type: 'web', name: null });
    const issued = issueSession({
      householdId: created.household.id,
      accountId: created.account.id,
      deviceId: device.id,
    });
    setSessionCookie(response, issued);
    return buildSessionDto(issued, {
      id: created.account.id,
      householdId: created.household.id,
      username: created.account.username,
      // 插入时固定为 owner;account.role 的 DB CHECK 保证仅 owner|admin
      role: created.account.role as 'owner' | 'admin',
    });
  }
}
