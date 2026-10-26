/**
 * 策略名单编辑器(T052,US3;三名单共用)。
 *
 * - 只展示与编辑本地草稿:逐项「移除」不改服务端,添加入口统一走
 *   ParentCandidatePicker(不接受手动输入任意 ID,延续 FR-013 的资源归属约束);
 * - 三名单由页面在「保存名单」时整体提交(契约 PUT lists 整体替换语义),
 *   保存中禁用移除,保证提交内容与所见草稿一致;
 * - ID 为不透明标识,等宽字体完整展示便于核对;列表限高滚动,最大 1000 项不撑破布局。
 */
import { Button } from '@heroui/react';

export interface PolicyListEditorProps {
  /** 名单标题,如「媒体允许名单」 */
  title: string;
  /** 一句话语义说明(禁止优先/儿童门槛等局限提示) */
  description: string;
  /** 当前草稿 ID 列表(保存前仅存在于本地) */
  ids: string[];
  /** 移除单项:仅修改草稿,不触发任何请求 */
  onRemove: (id: string) => void;
  /** 保存进行中禁用移除(防草稿与提交内容不一致) */
  isDisabled?: boolean;
}

export function PolicyListEditor({
  title,
  description,
  ids,
  onRemove,
  isDisabled = false,
}: PolicyListEditorProps) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-0.5 text-xs text-muted">{description}</p>
      {ids.length === 0 ? (
        <p className="mt-2 text-sm text-muted">空(未配置)</p>
      ) : (
        <ul className="mt-2 max-h-56 space-y-1.5 overflow-y-auto pr-1">
          {ids.map((id) => (
            <li
              key={id}
              className="flex items-center justify-between gap-2 rounded-md bg-default px-2 py-1"
            >
              <span className="min-w-0 break-all font-mono text-xs text-foreground">{id}</span>
              <Button
                size="sm"
                variant="ghost"
                isDisabled={isDisabled}
                onPress={() => onRemove(id)}
                aria-label={`从${title}移除 ${id}`}
              >
                移除
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-muted">{ids.length} 项(点「保存名单」后生效)</p>
    </div>
  );
}
