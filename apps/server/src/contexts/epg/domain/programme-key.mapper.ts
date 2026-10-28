export { programmeKeyOf } from '@contexts/live-tv';

/**
 * programme 公共不透明 key 映射(T114;005 data-model.md §8):
 *
 * 「programme 公共 key 由内部 ID 经不透明映射生成,不下发源或 XMLTV ID。」
 *
 * 归属说明(报告口径):本映射**复用 US5 live 实现的同一函数**(T063 在
 * modules/live/live-projection.service.ts 提取的 `programmeKeyOf`,内部 ID →
 * sha256 截断 `pg-` 前缀),此处 re-export 作为 EPG guide 侧的唯一引用点,
 * 不复制第二套哈希实现;两种引用(live 直引 / 本 mapper)在
 * test/unit/epg/guide-window-query.spec.ts 用同值断言钉住。
 */
