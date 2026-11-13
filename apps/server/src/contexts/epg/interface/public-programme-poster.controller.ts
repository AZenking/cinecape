import { Body, Controller, Get, Inject, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ProblemCode } from '@hmp/shared';
import { DomainError } from '@platform/http-common/domain-error';
import { PublicContextService } from '@platform/http-common/public-context/public-context.service';
import { RateLimitGuard } from '@platform/http-common/rate-limit/rate-limit.guard';
import { RateLimit } from '@platform/http-common/rate-limit/rate-limit.decorator';
import { StrictBodyPipe, StrictQueryPipe } from '@platform/http-common/strict-input/strict-pipes';
import { strictObject } from '@platform/http-common/strict-input/strict-schema';
import { EPG_PROGRAMME_POSTER_PROXY_PORT } from '@contexts/epg/epg.tokens';
import type { ProgrammePosterContent } from '@contexts/epg/application/programme-poster-proxy.service';

/**
 * 020 — 公共节目海报同源代理（contracts/api.md §2）：
 * GET /public/media/programme-posters/:posterRef
 *
 * 公开只读，不挂 SessionGuard；家庭由 PublicContextService 服务端确定。
 * 业务语义（404/502/504）在 application 层完成；本控制器只透传。
 * 成功响应 image/* 原字节 + Cache-Control: public, max-age=86400
 * （显式覆盖全局 no-store，与 010/014 海报/Logo 代理同款）。
 */

const PUBLIC_EMPTY_QUERY_SCHEMA = strictObject({});
const PUBLIC_EMPTY_BODY_SCHEMA = z.preprocess((value: unknown) => value ?? {}, strictObject({}));

@Controller('public')
@UseGuards(RateLimitGuard)
export class PublicProgrammePosterController {
  constructor(
    @Inject(EPG_PROGRAMME_POSTER_PROXY_PORT)
    private readonly posterProxy: {
      fetch(command: { readonly householdId: string; readonly posterRef: string }): Promise<ProgrammePosterContent>;
    },
    @Inject(PublicContextService) private readonly publicContext: PublicContextService,
  ) {}

  @Get('media/programme-posters/:posterRef')
  @RateLimit('mediaImage')
  async poster(
    @Param('posterRef') posterRef: string,
    @Query(new StrictQueryPipe(PUBLIC_EMPTY_QUERY_SCHEMA)) _query: Record<string, never>,
    @Body(new StrictBodyPipe(PUBLIC_EMPTY_BODY_SCHEMA)) _body: Record<string, never>,
    @Res() res: Response,
  ): Promise<void> {
    const scope = this.publicContext.requireScope();
    if (!scope.initialized) {
      throw new DomainError(404, ProblemCode.NOT_FOUND);
    }
    const content = await this.posterProxy.fetch({
      householdId: scope.household.householdId,
      posterRef,
    });
    res.setHeader('Content-Type', content.contentType);
    res.setHeader('Content-Length', String(content.bytes.byteLength));
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.status(200);
    res.end(content.bytes);
  }
}