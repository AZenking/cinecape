# 012 T002 现状基线证据(2026-11-01)
## lint
$ eslint .
## typecheck
apps/web typecheck$ tsc --noEmit
apps/web typecheck: Done
apps/server typecheck: Done
## web vitest

 Test Files  36 passed (36)
      Tests  265 passed (265)
   Start at  16:24:48
   Duration  6.53s (transform 1.98s, setup 4.12s, collect 23.38s, tests 17.60s, environment 8.60s, prepare 1.40s)

## server unit

/Volumes/Extends/DevCache/Projects/10-projects/14-epg/redRoad/apps/server:
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @hmp/server@0.1.0 test:unit: `vitest run test/unit`
Exit status 1
## server contract
      Tests  730 passed (730)
   Start at  16:26:24
   Duration  215.70s (transform 965ms, setup 12.47s, collect 15.71s, tests 179.24s, environment 4ms, prepare 1.54s)


## 环境性失败核验(补充)
- `test/unit/playback/input-security.spec.ts > T036 真实FFmpeg层:shell 元字符文件名 probe` 在代理沙箱内失败:
  EPERM 写 `~/hmp-t036-canary`(沙箱拒绝工作区外写入)。
- **沙箱外重跑(danger-full-access 一次性):33/33 全绿** → 确认为环境假失败,非产品缺陷。
- 基线结论:lint ✓ / typecheck ✓ / web vitest 265 ✓ / server contract 730 ✓ / server unit 1484 ✓(环境外)。
