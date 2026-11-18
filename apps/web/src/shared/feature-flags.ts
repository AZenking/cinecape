/**
 * 前端功能开关(产品分期门禁)。
 *
 * v1 只做直播:页面上所有「点播」入口隐藏,代码与后端能力全部保留——
 * 关闭时仅隐藏入口/重定向内容页,不删除组件、不删路由、不删接口调用。
 * 需要恢复点播时把 VOD_ENABLED 改回 true 即可(无其它改动)。
 *
 * 覆盖的隐藏面:
 * - 公共导航「点播」项(PublicNav,设置页顶栏共用同一源);
 * - 首页「点播」入口卡(A-2 公共区);
 * - 首页个人区「点播观看历史」分区(收藏频道保留);
 * - 内容路由 `/vod`、`/vod/titles/:titleRef`、`/media/:id` → 重定向到 /live;
 * - 设置侧栏「NAS/点播」入口(路由保留,管理员仍可深链直达配置页)。
 *
 * 不在隐藏范围(保持可用):播放器内部的点播播放路径、播放设置里的
 * 「自动播放下一集」偏好、后端点播接口与数据模型——它们不构成 v1 的点播**入口**。
 */
export const VOD_ENABLED = false;

/** 便于条件渲染的语义化别名(读起来更像产品语言) */
export const isVodVisible = VOD_ENABLED;

/**
 * 个人偏好设置开关(播放体验 / 界面外观)。
 *
 * v1 暂未接入生效链路:这两个页面写入的字段(defaultAudioLanguage /
 * defaultSubtitleLanguage / autoPlayNext / themeMode / posterDensity)
 * 目前没有任何消费方——播放器音轨/字幕是会话内临时选择,主题固定暗色,
 * 海报密度属于点播海报墙。用户改了不会生效,先隐藏入口与深链。
 *
 * 恢复方式:把开关改回 true。页面组件、路由、接口与注册表均保留;
 * 真正恢复前需先让播放链路与主题读取这些偏好(见 AGENTS/ADR 记录)。
 */
export const PERSONAL_PREFS_ENABLED = false;

/** 语义化别名(设置侧栏/深链守卫共用) */
export const isPersonalPrefsVisible = PERSONAL_PREFS_ENABLED;
