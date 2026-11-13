/**
 * Static brand artwork: native image preserves the selected A2 composition.
 * 默认只出图(顶部导航用,产品要求去掉文字);`withText` 供设置侧栏等需要文字标识处使用。
 */
export function BrandLogo({ withText = false }: { readonly withText?: boolean } = {}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <img
        src={`${import.meta.env.BASE_URL}brand/cinecape-seal-a2.png`}
        alt=""
        width={36}
        height={36}
        className="h-9 w-9 shrink-0 rounded-lg object-contain"
      />
      {withText ? <span className="truncate">映岬 Cinecape</span> : null}
    </span>
  );
}
