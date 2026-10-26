/**
 * 404 页(T010;ui.md §1):未知路由显示可返回首页的 404,不跳转登录、
 * 不重定向旧档案页。挂在 PublicLayout 内(导航壳可见),简单实现即可。
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router';

export function NotFoundPage(): ReactNode {
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-16 text-center">
      <p className="text-sm font-medium tracking-widest text-muted">404</p>
      <h1 className="text-xl font-semibold text-foreground">页面不存在</h1>
      <p className="max-w-prose text-sm text-muted">你访问的地址不存在或已被移除。</p>
      <Link
        to="/"
        className="rounded px-1 text-sm font-medium text-accent underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        返回首页
      </Link>
    </section>
  );
}
