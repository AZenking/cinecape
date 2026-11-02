# 012 实施证据汇总(evidence.md)

**Date**: 2026-11-01 | **Spec**: [spec.md](spec.md)(Accepted,维护者 T001 确认)| **Tasks**: [tasks.md](tasks.md)(40/40)
**诚实纪律**:只记录实际执行的实现面与证据;Not-run 不计完成、不虚标 Verified。012 当前 **Implementing(实现完成、验证中)**——真实环境采样类验收(见 §3 Not-run)未执行,整 feature 不满足 Verified。

## 0. 总览

- **实现面**:T001–T040 全部执行;web 新增/触碰测试 **53 文件 372/372 全绿**(最终回归 T040 复跑);全仓 typecheck exit 0;lint 绿;零服务端改动、零迁移、零新增端点(api-reuse §4 承诺达成,server 基线 730 contract / 1484 unit 保持,引用 T002)。
- **架构结论(复用优先兑现)**:005/006/009/010 既有机制零语义改动完成接线;唯一新组件 = 共享节目详情面板(`features/shared-programme/ProgrammeDetailPanel.tsx`,T005,单测 9/9);live/epg 两处旧详情面板已删除(T016/T022)。

## 1. SC 证据矩阵

| SC | 验收 | 证据(自动化为主) | 状态 |
| --- | --- | --- | --- |
| SC-001 游客转化链路 | 三入口零请求 | `test/e2e/live-playback-chain.spec.ts` **4/4**(入口① /live 卡片、② guide 频道列「直播」、③ 首页导航两跳;每入口登录弹层 + /api/playback 与 /api/me 计数 0 + 取消废弃);「登录选档完成→回原目标→授权播放」段由 005 `playback-intent.spec`(已验收)与本仓库协调器单测(T007 13/13)承接 | 自动化绿 |
| SC-002 详情/链路一致 | 结构特征一致 | T006 用例 4(两入口 dialog 特征集相等)+ T003 组件级 9/9 + `live-upcoming-ended-no-play` 5/5(§1.6 门) | 自动化绿 |
| SC-003 安静刷新 | 刷新零打断 | `live-quiet-refresh.spec` 2/2(visibilitychange 真实契约路径;焦点/面板/分页保持)+ `use-live-refresh` 零改动声明;**≥10 分钟真实连续观察 Not-run** | 自动化绿/采样 Not-run |
| SC-004 EPG 状态保留 | URL 恢复/回到现在 | `guide-url-state.spec` 8/8 + e2e `guide-state-restore` 3/3(真实 Chromium);「回到现在不清筛选」契约更新(旧断言随新契约修订) | 自动化绿 |
| SC-005 播放连续性 | 退出恢复/切档失效 | `live-player-continuity` e2e 3/3×2(退出恢复 URL/筛选/滚动;浮层零中断);`live-identity-switch` 5/5(旧票据 404 同形负向、零重放) | 自动化绿 |
| SC-006 状态边界负向 | 零私有读取 | T006 三入口零请求 + T007 递归无凭据扫描/Storage spy + live-favorite-behavior 游客零请求 | 自动化绿 |
| SC-007 设置分组 | 边界表落位 | `settings-groups.spec` 7/7(「关于与帮助」不落位守卫、personal 空组隐藏、范围标注、路由不变) | 自动化绿 |
| SC-008 可访问性 | 键盘/焦点 | 自动化等价:焦点入面板/Escape 恢复(T003)、键盘滚动恢复(既有 guide-keyboard-scroll-restore)、focus-visible token 审计(T037 零裸值);**真实物理键盘+读屏采样 Not-run** | 自动化绿/采样 Not-run |
| SC-009 响应式 | 折叠可达 | `settings-interactions` 部分 + T035 修补(折叠面板限高可滚,200%/低高度);**200% 缩放真实浏览器走查 Not-run** | 部分/采样 Not-run |

## 2. 实现面清单(按故事)

- **US1**:T006 e2e 4/4;T007 13/13;T008 GuestActionNotice→startLogin;T009 `epg-channel-watch` 3/3(现状达标钉面);T010 `home-live-entry` 1/1(现状达标钉面);T011 ChannelTile 收藏会话分流 + `live-favorite-behavior` 3/3;T012 `live-upcoming-ended-no-play` 5/5(旧面板删除后覆盖转移至共享面板语义);T013 `live-authorize-rejection` 2/2 + 拒绝浮层重试入口最小修补。
- **US2**:T014 `live-home-structure` 8/8(6 红先行);T015 `live-quiet-refresh` 2/2;T016 宿主换挂+旧面板删除;T017 NowHero 进度补齐;T018 none 态卡片+面板;T019 hook 零改动。
- **US3**:T020 `guide-url-state` 8/8(3 红先行:非法日历日回落、回到现在保留 channelPage);T021 e2e 3/3(真实 Chromium);T022 GuidePage 宿主换挂+旧面板删除+残留清理;T023 autoPosition(同窗口刷新不重定位)+ 回到现在契约;T024 时区零改动核对;T025 `guide-session-state`(零 storage,含负向断言)。
- **US4**:T026 e2e 3/3×2(受控 ffmpeg HLS 上游真实链路);T027 `live-identity-switch` 5/5;T028 FR-020 六项逐条(新增 `use-playback-track-selection`/`playback-settings-overlay`,`playback-settings` 11/11);T029 `playback-retry-recovery` 3/3。
- **US5**:T030 `settings-groups` 7/7;T031 `settings-interactions` 7/7;T032/T033 分组元数据+分组渲染(general 归 household 决策);T034 审计(FR-026–028 测试锁定);T035 折叠面板限高修补。

## 3. Not-run / 登记缺口(诚实清单)

1. **SC-003 ≥10 分钟真实连续观察**、SC-008 真实物理键盘+读屏、SC-009 200% 缩放真实走查、quickstart 场景中「真实来源联调」与「共享设备场景」——自动化等价已覆盖断言面,真实环境采样 Not-run(T036/T038 记录)。
2. **登记缺口(超出 012 文件边界,不属本 feature 验收,移交属主)**:
   - 退出播放后焦点恢复落点在协调器播放面壳(009 框架属主;US4-T026 e2e 未虚断此项);
   - 播放面「当前节目名」无数据源、直播进度线对齐节目窗(需协调器传参/服务端进度能力,US4-T028 登记);
   - 退出登录(identity-menu)无二次确认(FR-027 字面缺口,features/profiles 属 005/011 领地;US5-T034 登记)。
3. **e2e 运行环境说明**:本机 3000/5173 被既有 dev 双服务占用,guide-state-restore 与 live-playback-chain 由既有栈复用跑通(真实数据,vite 热载含实现);live-player-continuity 以隔离种子栈(3001/5174)实跑;标准复跑命令已写入各 spec 头注释。

## 4. 门禁与合规

- T001:维护者显式接受(Accepted 留痕);T002:基线全绿(server unit 唯一失败经沙箱外重跑证实为环境假失败)。
- 边界红线全程遵守:010 点播入口零触碰(Q3);settings-unlock-gate 判定零改动(011);零新增端点/迁移/偏好项(Q1、api-reuse §2);意图/滚动零浏览器存储(Q2,T007/T025 负向断言);无裸值/硬编码色(T037 审计空)。
- 最终回归(T040):lint ✓ / typecheck exit 0 ✓ / web vitest 53 文件 372 ✓ / e2e 三套 10 用例 ✓ / server 基线引用 ✓(详见 [final-t040.md](../../apps/web/evidence/final-t040.md)、[baseline-t002.md](../../apps/web/evidence/baseline-t002.md))。
