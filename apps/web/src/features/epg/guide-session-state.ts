/**
 * 节目单滚动/焦点会话快照(T025;FR-018、012 contracts/url-state.md §1 规则3):
 *
 * - 视口状态(滚动位置/焦点目标)**不进 URL、不写任何浏览器存储**(澄清 Q2、
 *   url-state §5「禁止为可恢复而在 localStorage/sessionStorage 新增键」):
 *   仅模块级内存 Map,随 SPA 会话存活;
 * - 详情面板打开前由宿主(GuidePage)写入「打开那一刻」的容器滚动锚与节目块 key;
 *   面板返回(关闭)时读出恢复——恢复由构造保证,不依赖「面板期间 DOM 恰好没动」;
 * - 页面刷新 = 全新文档,Map 自然为空 → 回缺省定位(FR-015 当前时刻附近),可接受。
 */

/** 一次详情打开前的节目单视口快照 */
export interface GuideSessionSnapshot {
  readonly scrollLeft: number;
  readonly scrollTop: number;
  /** 触发详情的节目块 key(墙内 data-programme-key;恢复焦点用,null=无可锚节目) */
  readonly focusKey: string | null;
}

/** 会话快照存储(模块级内存;键 = 滚动容器身份,当前节目单墙单一实例) */
const snapshots = new Map<string, GuideSessionSnapshot>();

/** 节目单墙的会话快照键(预留多容器扩展;当前仅此一键) */
export const GUIDE_WALL_SESSION_KEY = 'guide-wall';

/** 写入快照(详情面板打开前调用;同键覆盖,语义为「最近一次打开」) */
export function saveGuideSessionSnapshot(key: string, snapshot: GuideSessionSnapshot): void {
  snapshots.set(key, snapshot);
}

/** 取出并清除快照(恢复一次性生效;无快照返回 null) */
export function consumeGuideSessionSnapshot(key: string): GuideSessionSnapshot | null {
  const snapshot = snapshots.get(key) ?? null;
  if (snapshot !== null) {
    snapshots.delete(key);
  }
  return snapshot;
}
