/**
 * 统一播放入口(T054;005 US3)—— 所有页面共享的 play 面与共享 PlayButton:
 *
 * - 所有播放入口(首页收藏/历史占位、直播卡片、频道/节目详情、点播详情)只经同一
 *   usePlayAction 发起(T053 唯一状态机在 app/action-coordinator,此处仅消费面,
 *   不另建第二个全局状态机);
 * - 游客点击进入登录选档意图,仅选档完成后才发起 resolve(登录期间目标失效由
 *   服务端按最新状态重判,US3 场景 5);
 * - startMode 占位(beginning|resume);进度数据与继续/从头按钮语义由 US4 补全。
 */
export { usePlayAction } from '../../app/action-coordinator';
export type { PlayActionApi, PlayActionRequest } from '../../app/action-coordinator';
export { PlayButton } from './play-button';
