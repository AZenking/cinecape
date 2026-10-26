/**
 * 播放测试夹具统一出口(T013,spec 004):US1/US2 契约测试经此桶导入;
 * 不修改既有 test/fixtures/index.ts(T013 文件边界),消费方直接
 * `import { seedPlaybackWorld, seedPlaybackSession } from '../fixtures/playback'`。
 */
export * from './playback-fixtures';
