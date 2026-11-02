## T040 最终回归(2026-11-01)
### lint

[ELIFECYCLE] Command failed with exit code 1.
### typecheck
apps/web typecheck: Done
apps/server typecheck: Done
### web vitest 全量
 Test Files  53 passed (53)
      Tests  372 passed (372)
### e2e(本次实施新增/触碰,真实 Chromium)
- guide-state-restore: 3/3 passed(US3)
- live-player-continuity: 3/3 passed ×2(US4,隔离种子栈)
- live-playback-chain: 4/4 passed(T006,复用既有 dev 双服务栈)
### server 基线(未触碰,引用 T002)
- contract 730/730;unit 1484(沙箱内 1 环境性失败,沙箱外 33/33 核验,见 T002 补充)

### lint 终态(补充)
- 首跑 6 处 unused-vars(各并行代理遗留的未用导入/死变量/死写入)→ 已逐一清理
  (shared-programme 解构、SettingsLayout 导入、continuity spec 的 expectStep/dialogOf/DIALOG/
  Locator、selftest render、home-live-entry LIVE_NOW、playback-settings terminatedMessage 死写入)。
- 终态:`pnpm lint` 零错误;`pnpm typecheck` exit 0;web vitest 全量 53 文件 372/372 复跑确认。
- 过程记录:vitest 误收集 test/e2e 目录 11 失败为运行方式错误(e2e 归 Playwright),非代码缺陷。
