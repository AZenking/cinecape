import { useState } from 'react';
import type { ReactNode } from 'react';

/**
 * 020 节目海报装饰/内容图（shared-programme）。
 *
 * - `posterRef` 为服务端下发的 32 位小写 hex 不透明引用；null=不渲染，宿主自行回退频道 Logo/首字；
 * - 加载失败只隐藏自身，不产生裂图/占位框；
 * - `loading="lazy"` + `decoding="async"`；墙内仅可见块渲染（宿主已有窗口化）；
 * - `posterRef` 变化时重置失败状态，旧图不残留；
 * - 装饰场景（墙/列表）`alt="" aria-hidden`；详情场景由宿主传 `decorative=false` 并提供可读 alt。
 *
 * HeroUI 无「失败即隐形」的媒体组件；本组件按 014 ChannelLogo 先例以原生 `<img>` 实现
 * （非交互装饰/内容节点，不触原生交互控件禁令；语义 token 由宿主容器提供）。
 */
export interface ProgrammePosterProps {
  readonly posterRef: string | null;
  /** 节目标题：仅用于详情 alt；装饰场景忽略 */
  readonly title: string;
  /** 默认 true：装饰图 alt="" + aria-hidden；详情场景传 false */
  readonly decorative?: boolean;
  readonly className?: string;
}

interface PosterPhase {
  readonly ref: string | null;
  readonly failed: boolean;
}

export function ProgrammePoster({
  posterRef,
  title,
  decorative = true,
  className,
}: ProgrammePosterProps): ReactNode {
  const [phase, setPhase] = useState<PosterPhase>({ ref: posterRef, failed: false });
  if (posterRef !== phase.ref) {
    setPhase({ ref: posterRef, failed: false });
  }
  if (posterRef === null || posterRef === undefined || phase.failed) {
    return null;
  }
  return (
    <img
      src={`/api/public/media/programme-posters/${encodeURIComponent(posterRef)}`}
      alt={decorative ? '' : `${title} 海报`}
      aria-hidden={decorative ? 'true' : undefined}
      loading="lazy"
      decoding="async"
      className={className}
      onError={() => {
        setPhase({ ref: posterRef, failed: true });
      }}
    />
  );
}