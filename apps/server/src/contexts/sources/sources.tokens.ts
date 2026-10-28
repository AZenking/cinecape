/**
 * sources 注入令牌集中地（contracts §5）。
 *
 * 令牌面 = 跨上下文被消费的应用服务（T020 grep 实测消费清单）：
 * - RefreshExecutorService（类，settings settings-sources.controller 注入；有状态串行
 *   执行器，令牌绑定必须 useExisting 别名到既有类 provider —— useClass/useFactory 会
 *   产生第二执行循环，违反行为零变化）；
 * - sources.service（createSource / listSources / listSourceRoots / updateSource /
 *   requestSourceRefresh / getSourceRefresh / confirmSourceRefresh / discardSourceRefresh）：
 *   settings 消费（纯函数模块惯例，令牌绑定经 useValue 函数束）。
 *
 * domain/source-target.validation 纯函数与 infrastructure/nas-scanner 类型为跨上下文
 * 必需面，经 index.ts 再导出（非令牌面）。
 */
export const REFRESH_EXECUTOR_PORT = Symbol('REFRESH_EXECUTOR_PORT');
export const SOURCES_SERVICE_PORT = Symbol('SOURCES_SERVICE_PORT');
