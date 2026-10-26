import { type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { parseStrict } from './strict-schema';

/**
 * 严格入参管道(T009)—— JSON body 与 query 的未知属性一律 400 VALIDATION_FAILED
 * (005 contracts/api.md §1)。挂在对应参数上,只处理目标参数类型,其余原样放行:
 *
 *   @Post('login')
 *   login(@Body(new StrictBodyPipe(loginSchema)) input: LoginInput) { ... }
 *
 *   @Get('media')
 *   list(@Query(new StrictQueryPipe(mediaQuerySchema)) query: MediaQuery) { ... }
 *
 * 管道只做「严格解析」;body 大小上限(16KiB/64KiB/512KiB)属传输层预算,
 * 由各路由任务按 api.md §1 配置,不在本管道职责内。
 */
export class StrictBodyPipe<T> implements PipeTransform {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown, metadata: ArgumentMetadata): T {
    if (metadata.type !== 'body') {
      return value as T;
    }
    return parseStrict(this.schema, value, 'body');
  }
}

/** 严格 query 管道:未知 query 键一律 400(与 StrictBodyPipe 同一判定核心) */
export class StrictQueryPipe<T> implements PipeTransform {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown, metadata: ArgumentMetadata): T {
    if (metadata.type !== 'query') {
      return value as T;
    }
    return parseStrict(this.schema, value, 'query');
  }
}
