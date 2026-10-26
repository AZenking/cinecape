/**
 * 海报占位块(T037/T038)。
 *
 * 契约 Media.poster 恒为 null,首期不加载外部海报、无第三方地址;
 * 占位以标题首字符 + 中性底色渲染(003 contracts/api.md「观看目录」),
 * 纯展示不参与交互,故 aria-hidden。
 */

/** 标题首字符(按码位切分,兼容代理对);空标题回退为「·」 */
function titleInitial(title: string): string {
  const trimmed = title.trim();
  const first = [...trimmed][0];
  return first ?? '·';
}

export function MediaPosterPlaceholder({
  title,
  className = '',
}: {
  title: string;
  /** 尺寸类由调用方决定(目录卡片小图 / 详情页大图) */
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={`flex shrink-0 select-none items-center justify-center overflow-hidden rounded-lg bg-default font-semibold text-muted ${className}`}
    >
      {titleInitial(title)}
    </div>
  );
}
