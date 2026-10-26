/**
 * 路由占位页(T010)。
 *
 * Phase 2 仅保证公共地址可达(`/`、`/vod`、`/media/:id`、`/live`、`/live/guide`
 * 与 `/settings/*` 守卫插槽);真实页面由各故事任务在既有路由上接入,不新建壳:
 * - `/`、`/vod`、`/media/:id` → T026(US1,features/home、features/catalog);
 * - `/live`、`/live/guide` → T067(US5)与 US6(features/live);
 * - `/settings/*` → US7(SettingsLayout + 路由守卫;最终权限仍由服务端校验)。
 * 占位页不发起任何请求、不虚构业务数据。
 */
import type { ReactNode } from 'react';

export interface PlaceholderPageProps {
  /** 页面标题(真实页面接入前的占位文案) */
  title: string;
  /** 可选说明(注明归属任务,便于审阅与冒烟) */
  description?: string;
}

export function PlaceholderPage({ title, description }: PlaceholderPageProps): ReactNode {
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-16 text-center">
      <h1 className="text-xl font-semibold text-foreground">{title}</h1>
      {description ? <p className="max-w-prose text-sm text-muted">{description}</p> : null}
    </section>
  );
}
