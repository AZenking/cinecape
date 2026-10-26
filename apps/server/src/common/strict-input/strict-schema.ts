import { z } from 'zod';
import { ProblemCode as ProblemCodeConst } from '@hmp/shared';
import { DomainError } from '../domain-error';

/**
 * 严格入参工具(T009,005 contracts/api.md §1「未知 JSON/query 字段一律拒绝,
 * 不能通过 householdId/profileId/isAdmin 解锁或扩大权限」)——
 *
 * 用法(后续任务统一走本文件,不得使用宽松 z.object 直接解析外部输入):
 *   const schema = strictObject({ name: z.string().min(1) });
 *   // 控制器:@Post() create(@Body(new StrictBodyPipe(schema)) input: {name: string})
 *   // 查询: @Get() list(@Query(new StrictQueryPipe(listQuerySchema)) query: ...)
 *
 * 未知键由 zod unrecognized_keys 捕获 → 400 VALIDATION_FAILED,detail 携带
 * issue 摘要(键名可判读,不含任何值内容,凭据类值不回显)。
 */

/** zod 4 strictObject 的 shape 形态(从 zod 自身导出,避免硬编码内部类型) */
type StrictShape = Parameters<typeof z.strictObject>[0];

/** 严格对象:未知键一律拒绝(等价 z.strictObject;统一入口便于审计与未来调整策略) */
export function strictObject<S extends StrictShape>(shape: S): ReturnType<typeof z.strictObject<S>> {
  return z.strictObject(shape);
}

/** 校验失败 detail:仅 issue 路径与消息摘要(与既有 parseBody 口径一致) */
function issueDetail(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * 严格解析:未知字段/非法值 → 400 VALIDATION_FAILED。
 * source 仅用于 detail 前缀定位(body/query),不进入错误码。
 */
export function parseStrict<T>(schema: z.ZodType<T>, input: unknown, source: 'body' | 'query' = 'body'): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DomainError(400, ProblemCodeConst.VALIDATION_FAILED, `${source}: ${issueDetail(result.error)}`);
  }
  return result.data;
}
