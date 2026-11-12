/**
 * 共享异步状态 UI + 轻反馈(006 ui-components 契约,FR-011)——
 * home/catalog/settings 公共区唯一复用出口;错误不只靠颜色
 * (role=alert + 文字 + 重试按钮),空结果区分「暂无内容」与「无匹配结果」(FR-004)。
 * 现基于 HeroUI v3 组件(加载态 Skeleton/Spinner、错误态 Alert+Button、
 * 空态 EmptyState、轻反馈 Toast),导出名与 props 契约对 005 调用方保持源兼容。
 */
export { LoadingSpinner } from './loading';
export { MediaGridSkeleton } from './skeleton';
export { EmptyCatalogState, NoMatchState } from './states';
export { RetryableAlert } from './retryable-alert';
export { AppToastRegion, useAppToast } from './toast';
export type { AppToast } from './toast';
export { PinField } from './pin-field';
export type { PinFieldProps } from './pin-field';
export { PublicNav, PUBLIC_NAV_ITEMS } from './global-nav';
