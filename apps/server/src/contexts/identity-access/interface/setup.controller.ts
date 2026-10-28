import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { PublicContextService } from '@platform/http-common/public-context/public-context.service';
import { RateLimitGuard } from '@platform/http-common/rate-limit/rate-limit.guard';
import { RateLimit } from '@platform/http-common/rate-limit/rate-limit.decorator';
import { SameOriginGuard } from '@platform/http-common/same-origin/same-origin.guard';
import { StrictBodyPipe } from '@platform/http-common/strict-input/strict-pipes';
import { strictObject } from '@platform/http-common/strict-input/strict-schema';
import { hashPassword } from '@contexts/identity-access/infrastructure/password.service';
import { initializeDeployment } from '@contexts/identity-access/application/setup.service';

/**
 * 初始化契约(T036,005 contracts/api.md §3 + research R2;FR-006/007):
 * - GET /setup/status(Public):`{initialized}`;存储未知/故障 503(requireScope),
 *   绝不把「状态未知」伪装成 initialized=false —— 初始化状态未知不得开放重复配置;
 *   挂 RateLimit('public')(公共读取每 IP 120 次/分钟);
 * - POST /setup/initialize(Public+同源):仅创建 Household+Account,
 *   201 `{initialized:true}` —— 无 Set-Cookie、无设备注册、不自动登录、
 *   无 sessionToken;请求体未知字段(含来源/节目单导入字段)一律 400;
 *   重复初始化 409;存储未知 503。
 */

/** 契约 B001InitializeRequest(原家庭/账号字段;strictObject 拒绝一切未知字段) */
const initializeRequestSchema = strictObject({
  householdName: z.string().min(1).max(100),
  defaultLanguage: z.string().default('zh-CN'),
  timezone: z.string().default('Asia/Shanghai'),
  username: z.string().min(3).max(64),
  password: z.string().min(8).max(128),
});

@Controller('setup')
export class SetupController {
  // 本仓库运行时(esbuild/tsx)不产出 design:paramtypes 元数据,构造注入不可用;
  // PublicContextService 为无状态只读解析服务,直接实例化(与 DI 单例行为一致)。
  private readonly publicContext = new PublicContextService();

  /** 存储未知/故障 → requireScope 抛 503,不返回任何 initialized 形态 */
  @Get('status')
  @UseGuards(RateLimitGuard)
  @RateLimit('public')
  status(): { initialized: boolean } {
    const scope = this.publicContext.requireScope();
    return { initialized: scope.initialized };
  }

  @Post('initialize')
  @HttpCode(201)
  @UseGuards(SameOriginGuard)
  async initialize(
    @Body(new StrictBodyPipe(initializeRequestSchema))
    input: z.infer<typeof initializeRequestSchema>,
  ): Promise<{ initialized: true }> {
    // 存储未知同样 503:初始化状态未知不得开放重复配置(FR-006)
    this.publicContext.requireScope();
    // argon2 哈希在事务外完成(BEGIN IMMEDIATE 短事务)
    const passwordHash = await hashPassword(input.password);
    initializeDeployment({
      householdName: input.householdName,
      defaultLanguage: input.defaultLanguage,
      timezone: input.timezone,
      username: input.username,
      passwordHash,
    });
    // 契约:201 {initialized:true};无 Set-Cookie、无设备注册、不自动登录
    return { initialized: true };
  }
}
