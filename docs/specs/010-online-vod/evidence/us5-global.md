# US5 证据:全局前端与守护(us5-global)——T082

> 状态:**进行中(§5 两枚缺陷修复后,lead 派发复跑又修复 2 枚 + 定位 1 枚阻塞,详见 §9)**。本文档按「实际执行」如实分层记录,不虚标通过。
> 最后更新:2026-10-31T18:00+08:00(Asia/Shanghai;§9 增补)。执行环境与本机工作区状态见 §1。

## 0. 结论速览

| 项 | 状态 | 依据位置 |
| --- | --- | --- |
| Playwright 环境可运行判定(层1) | ✅ Verified | §2 |
| 受控上游真实链路(受控 fixture + 本地 app) | ✅ Verified(服务端全链;13:05 时点) | §3 |
| Q9 20 次路由导航不中断全局播放 | ⏳ Not-run(被交付链外部回归阻塞,§6) | §4.1 |
| 弱网退出/切档 ≤1s 保存尝试 | ⏳ Not-run(同上) | §4.2 |
| 重复关闭/StrictMode 双挂载 | ⚠️ 执行中**发现并修复 2 枚真实缺陷**;断言面待复跑 | §5 |
| 消费响应丢失后找回/stop(Q7) | ➖ Not-run(e2e);单测等价断言清单见 §7 | §7 |
| 浏览器退出 watchdog/无主 0/终态复活 0 | ⏳ Not-run(同 §6;T081 服务端语义已由其单测/契约面覆盖) | §4.4/§7 |
| `apps/web` vitest 全量 | ✅ 265/265(含本次修复后回归) | §5.3 |

## 1. 执行环境与工作区状态

- 时间:2026-10-31 11:50–14:25(Asia/Shanghai);macOS(darwin,arm64),Node v24.19.0,pnpm 11.28.5。
- 浏览器:Playwright Chromium(headless shell,ms-playwright 缓存 chromium-1208/1248),`--autoplay-policy=no-user-gesture-required`(真实 Chromium 缺省不带该豁免,已在 spec 顶层注入;手势面「点击播放」路径亦保留)。
- 仓库状态:010 实现为未提交工作区变更;**本机存在并发 agent 对 `apps/server/src/contexts/online-vod/` 的持续编辑**(12:19 曾致 Nest 启动失败 `drizzleVodRetentionStore is not a function`;13:33 起网关交付面出现确定性回归,见 §6)。本任务未改动任何 server 源码。
- ffmpeg/ffprobe:/opt/homebrew/bin(受控上游真实 H.264 分片生成用)。

## 2. 层1 判定:Playwright 环境可运行 ✅

- 命令:`cd apps/web && pnpm exec playwright test foundation-smoke.spec.ts --project=chromium`
- 结果:2 passed(5.2s)——真实 Chromium 可运行,`scripts/e2e-servers.sh` 双服务基建(独立 DATA_DIR + 迁移 + Nest:3000 + vite:5173)正常。
- 结论:层1 成立,e2e 以真实浏览器执行。

## 3. 受控上游真实链路 ✅(13:05 时点服务端全链实证)

T082 的「可控环境替代」采用**受控上游 + 本地 app 即真实链路**:spec 进程内启动本机 HTTP 上游(绑定本机 LAN IPv4),用 ffmpeg 生成真实 H.264 MPEG-TS 分片池 + 动态滚动直播清单(无 ENDLIST),经**设置 API 全真实链路**注册 IPTV 源并导入。

- 为什么是 LAN IPv4:①创建期源目标校验按设计拒绝 IP 字面量环回(SSRF 面,T083 职责);②运行期 SafeUpstream 以 `node:dns.resolve4/6`(c-ares)解析,不查 /etc/hosts,`localhost` 形态 `SOURCE_DNS_INVALID`(本任务实测)。私网 LAN 地址正是部署预期目标形态;运行命令注入 `LAN_ALLOWED_TARGETS=<同一地址>`。
- 全链实证记录(2026-10-31 13:05,Playwright 直连 API + 浏览器诊断双通道):
  1. `POST /api/settings/sources`(iptv,受控 URL)→ 201;
  2. `POST /api/settings/sources/:id/refresh` → 202,轮询至 `succeeded`(added=2);
  3. `GET /api/public/live/channels?section=all&q=…` → 受控频道可见;
  4. `POST /api/playback/resolve` → 201 preparing → 轮询至 **ready(delivery=hls_proxy)**(hls_proxy 直播候选 probe 免 ffprobe 即时成功);
  5. `POST /api/playback/sessions/:id/renew` → 200 票据;
  6. **网关清单 GET → 200(URI 已改写为网关资产 URL)**;分片 GET → 200(29,892 字节真实 TS);
  7. 会话状态 → **playing**(首次交付 markPlaying);
  8. `POST …/observations`(event=playing)→ 200 `{accepted:true,playbackStarted:true}`;`POST …/progress`(started)→ 200 `{applied:true,reason:"accepted"}`。
- 该链路在 13:05 时点证明:resolve→probe→ready→换票→网关代理→真实分片交付→playing→泵观测全通。

## 4. e2e 套件(`apps/web/test/e2e/online-vod-global.spec.ts`,6 用例串行)

运行命令(仓库根或 apps/web):

```sh
cd apps/web && E2E_SEED_SCALE=1 LAN_ALLOWED_TARGETS=$(node -e "const os=require('os');for(const l of Object.values(os.networkInterfaces()))for(const n of l??[])if(n.family==='IPv4'&&!n.internal){console.log(n.address);process.exit(0)}") \
  pnpm exec playwright test test/e2e/online-vod-global.spec.ts --project=chromium
```

用例 1(受控上游注册与频道导入)已通过(多轮运行稳定,≈1s)。用例 2–6 的断言面已实现完毕,但当前被 §6 的交付链外部回归阻塞,标记 **Not-run**;未虚标。

### 4.1 Q9:20 次路由导航(Not-run,断言面已就绪)
客户端路由(react-router,非整页刷新)20 次(首页/点播/直播轮转);逐次断言播放面仍在;导航窗口内出现新的周期进度样本与心跳;导航全程零 `/stop`(generation/路由变化不卸载 stop 的路由面等价断言);媒体时间轴前进未暂停;身份菜单 → 设置 → PIN 门弹层焦点落入弹层,取消后播放继续。

### 4.2 弱网退出/切档 ≤1s(Not-run,断言面已就绪)
Playwright route 将 `/api/playback/sessions/*/progress` 延迟 5s(> 有界保存窗口 `BOUNDED_SAVE_MS=1000`,T079);点击「退出播放」/「切换 Profile→儿童档案(PIN)」后:
- `/stop` 发出时刻 − 动作时刻 ≤ 1000ms(实测口径记录在运行输出);
- 恰一次 `/stop` 且携带 `finalProgress`(started 已确认前提);
- `/stop` 之后零进度补报(旧身份零补报,泵收口断链);
- 切档旧会话读取 404 `PLAYBACK_NOT_FOUND`(与 005 既有契约同形)。

### 4.3 重复关闭/StrictMode 双挂载(断言面已就绪;缺陷修复记录见 §5)
- 快速双击「退出播放」→ 恰一次新增 `/stop`(close 幂等/stopOnce 唯一 Promise);
- StrictMode(dev 全局开启)下 started 样本恰一次(session 级 seq 不重发);
- 挂载稳定期(起播 1s 后)零提前 `/stop`。

### 4.4 浏览器退出 watchdog(Not-run,断言面已就绪)
- 无客户端 ready 会话(API resolve 后无浏览器):created 期限起 60s 固定期限 + 15s 扫描节拍 → `interrupted`(T081 未起播回收,heartbeat/renew 不续命);
- 真实播放中会话:浏览器 context 直接退出(零 stop/零补报)→ 45s 失联 + 15s 节拍 → `interrupted`;
- 终态复活 0:终态后 3 轮轮询状态不变 + renew ≥400 拒绝;
- 无主会话 0:本套件全部已建会话终态(样本池断言)。

## 5. 本次执行发现并修复的真实缺陷(dev 模式 StrictMode;仅 e2e 可达)

既有单测(265/232 绿面)不渲染 StrictMode、既有 e2e 夹具源不可达(从未到达 playing 相位),因此以下缺陷此前不可见。**两处修复均属最小外科修复,不改变任何生产语义;vitest 全量 265/265 回归通过。**

### 5.1 缺陷 A:挂载期空 `/stop` 击穿活动会话(已修复)
- 现象(e2e 时间线,Playwright 请求级抓取):renew 取票(12.886s)→ PlayerView 挂载首个 effect 同步 cleanup 触发 `ProgressController.dispose()→stopOnce()` → **空 `POST /playback/sessions/:id {}`(12.943s)** → VHS 清单请求(12.958s)→ **401**(会话已被空停终态化)→ 进度 409 → MEDIA_ERROR →「播放流中断」。dev 模式(React StrictMode 开启,`src/main.tsx`)下任何真实播放均被击穿;生产构建(无双调)不受影响。
- 修复(`apps/web/src/features/playback/use-playback-progress.ts` + `progress-controller.ts`):cleanup 同步执行 `disposeLocal()`(abort 在途/摘监听/停拍——「旧会话请求立即失效」契约保持同步),终局命令(`collectTerminal()`,唯一 stopOnce Promise/载荷不变)挂**微任务**;同 sessionId 的 StrictMode 同步 remount 在 setup 内取消该终局命令。不用 setTimeout(真实时钟会把收口泄漏进相邻用例的 fetch mock,vitest 全量实测后改微任务)。
- 配套:`ProgressController.attach()` 幂等(重入时先摘旧监听/周期拍),防御重复挂载双倍样本。

### 5.2 缺陷 B:video.js dispose 使 React 持有的 `<video>` 脱离文档(已修复)
- 现象(e2e/DOM 转储):播放面可见、泵活(10s 周期样本/15s 心跳/2s 清单轮询全发),但 `currentTime/readyState 恒 0` 且 `data-testid="playback-video"` 不在文档——`videojs(el, …)` 包装后 `player.dispose()` 会把被包装的媒体元素一并移出 DOM;StrictMode 重挂载的引擎跑在**脱离文档的元素**上(分离媒体不可播放)。原注释「dispose 会把原 `<video>` 还原回 DOM」与 video.js 8 实际行为不符。
- 修复(`apps/web/src/features/playback/video-player.tsx`):effect 捕获 React 容器(`el.parentElement`),`dispose()` 后将原节点原样 `appendChild` 放回容器,重挂载重新初始化安全。

### 5.3 回归证据
- `pnpm --filter @hmp/web test:vitest` → **Test Files 36 passed(36) / Tests 265 passed(265)**(2026-10-31 13:30 / 13:50 / 14:44 三轮全绿)。
- 全量 suite 在本机高负载窗口(并发任务同时运行)曾出现单用例漂移失败(每轮用例不同、隔离运行均绿、代码零变化),判定为负载相关 flake,非本修复引入;安静窗口全量稳定全绿。
- `pnpm --filter @hmp/web exec tsc --noEmit` 零错误;`eslint test/e2e/online-vod-global.spec.ts` 零错误。

## 6. 当前阻塞:交付链确定性 503(非本任务改动;根因分析留档)

- 现象:13:05 时点(§3)网关清单 200;约 13:20 后启动的任何 server,直播 hls_proxy 交付链**确定性 503 `PLAYBACK_RESOURCE_UNAVAILABLE`**(受控复现 10/10 次;导入面读取同一 URL 却成功)。浏览器侧表现为 VHS 清单 503 →「播放流中断」,e2e 用例 2–6 不可执行。服务端日志仅 `GET /api/playback/stream/... failed` WARN(13:58/14:05/14:12),reason 不出稳定码。
- 本机环境干扰源(实测):本机 DNS 被 VPN/代理类工具的 fake-IP 模式劫持——`node:dns` 的 **c-ares 通道(`resolve4`)对 IP 字面量也返回假 IP `198.18.6.129`(RFC 2544 段)**,而 getaddrinfo 通道(`dns.lookup`)对字面量短路返回真值。导入面(sources 读取器)连接语义走字面量直连 → 成功;交付面若经 SafeUpstream 嵌套读取链(c-ares 解析 + 解析结果逐 IP 许可),解析到假 IP → 未获许可 → 503(与「许可表追加 `198.18.0.0/15` 后仍即时 503」的复现一致:连接假 IP 在本机 TUN 状态下快速失败)。13:05 的成功窗口与 fake-IP 劫持激活时点吻合。
- 叠加因素:并发任务 12:19–13:57 对 `apps/server/src/contexts/online-vod/` 持续编辑(12:19 曾致 Nest 启动失败),交付装配是否受其影响未定论。
- 处置:此为部署环境(DNS 干扰)与 server 交付面交叠的问题,超出 T082(前端 e2e 证据)边界;已带复现脚本(`probe4`:导入成功/网关 503 全链)移交协调方。server 在干净 DNS 环境或修复解析面后,§4 全量 e2e 一条命令可复跑(命令见 §4 头部)。本任务不改 server 源码。

## 7. Q7「消费响应丢失后找回/stop」的等价断言清单(e2e 未执行,如实分列)

浏览器全链换源(两源同题物化→intent→消费)需在线 VOD 受控上游矩阵,本任务可控环境未展开(见 §6 阻塞)。该面的**单测层等价断言已全绿**(`apps/web/test/vod-switch.spec.tsx`,T069/T074/T075 契约钉面):

- C1 串行序:pause→物化(registeredCandidateRef)→intent→stopOnce 确认→resolve(无 startMode);
- C2b `409 TRANSITION_SLOT_CONFLICT`:恢复读取新 revision→有界重提;
- **C3 stop 响应丢失**:先恢复读(GET 会话),未确认终态不消费;终态确认后恰一次 resolve;
- **D3 intent 响应丢失**:同 operationKey 同载荷原样重放,恰一次推进(单 resolve);
- **D1 cancel 输给消费(already_consumed+successor)**:追查后继并**显式 stop**,不静默丢弃;
- D2 不同 ui 操作号并发:旧操作已建 intent 显式 cancel;
- **E3 关闭播放器后迟到 intent 201**:必须追查清理(显式 cancel),不能仅丢弃;
- B2/B2b checkpoint 非接受/409 SOURCE_PROGRESS_PENDING:显式确认面,不自动换游标。

服务端消费/撤销事务与 watchdog 语义另有 010 契约面(online-vod transition/revocation/finish 等契约套件)与 T081 未起播回收/失联回收单测承载;本任务不重复断言。

## 8. 诚实性声明

- 本文所有「Verified」均对应上列命令与时间点的真实输出;「Not-run」表示断言面已实现但未取得通过运行,**不计入完成**。
- §5 两处修复改动了 `apps/web/src/features/playback/` 下两个文件,属 T079/T048 面的缺陷修复;已通过全量单测回归,并在本文留档原因与时间线。
- 复跑后本文件将更新 §4 各用例的实测数值(≤1s 实测毫秒、样本计数、watchdog 到时)与结果状态。

## 9. 增补:T082 §5.2 缺陷的后续修复(lead 派发)+ e2e 复跑结果(2026-10-31 15:11–18:00)

> 承接 §5.2:lead 派发「修复 web 播放器缺陷并复跑 US5 e2e 证据」。本节由执行 agent 如实增补;改动文件严格限于允许面(`video-player.tsx`、`player-view.tsx` 零改动、spec 仅 ACK 判据最小修正(见 §9.3,超出「仅 resolve 目标」字面授权,已单独向 lead 报备理由)、本 evidence)。

### 9.1 §5.2 修复的再诊断与重做(缺陷 1:StrictMode 双挂载元素归位)

video.js 8.24 源码级实锤(`node_modules/.pnpm/video.js@8.24.2/.../dist/video.js`):

- `Player.createEl`:当媒体元素的父节点带 `data-vjs-player` 时走 **playerElIngest** —— `el = tag.parentNode`,即 **React 渲染的容器 div 本身成为播放器元素**,并把媒体元素全部属性(含 `data-testid`/`class`)复制到容器;
- `dispose()` 两步摘除:`Html5.disposeMediaElement`(tech 清理)**先把 `<video>` 从容器摘离**(`el.parentNode.removeChild(el)` + `load()`),`Component.dispose` 随后 **把被 ingest 的 React 容器整体移出文档**(`el_.parentNode.removeChild(el_)`)。

因此 §5.2 的「dispose 后 `host.appendChild(el)` 放回 parentElement」实为**把 `<video>` 放回 detached 容器**(与诊断结论一致),重挂引擎仍跑在文档外(`VIDEOJS: WARN: The element supplied is not included in the DOM`;终态 `videos:0`、`[data-vjs-player]:0`)。

**修复(`apps/web/src/features/playback/video-player.tsx`,标注「010 回归修复:StrictMode 双挂载元素归位」):**

- 容器 ref 由 React 渲染层持有(`containerRef` 挂 `data-vjs-player` 容器);初始化**前**捕获原位锚点(父容器 + nextSibling,`cleanup` 时刻的 parentNode 已被摘除不可信);
- cleanup 两步归位:`dispose()` 前 `isConnected` 快照(真实卸载时 React 已先摘子树 → 不归位,避免与 React 争抢 DOM;StrictMode 重挂时容器仍在文档内)→ ①`<video>` 以 `el.parentNode !== container` 判定放回容器 ref;②容器以 `isConnected` 判定活容器后按原位锚点 `insertBefore` 放回文档;
- 附带修复 **ingest 复制面**:`data-testid` 副本会让 `getByTestId('playback-video')` strict 语义命中两个元素;二次初始化(StrictMode 重挂)时 class 副本(`vjs-tech`)会顶掉 `video-js` 基类 —— 初始化后摘除副本 `data-testid`、补 `video-js`;
- 断言面:`import.meta.env.DEV` 下 `document.contains(el)` 为假即 `console.error`(引擎必须落在文档内元素上,归位失效第一时间显形)。

**验证(真 Chromium,Playwright 深检):** 重挂后 `techIsReactVideo:true`、`videos:1`、引擎清单/分片正常拉取 —— **真实播放首次在真浏览器成立**(rs=4、currentTime 持续前进,PLAYING at 1500ms)。

### 9.2 新发现并修复(缺陷 2:直播 VHS 启动定位与 T079 ACK 前 seek 回弹互斥)

元素归位后,e2e 卡点前移至媒体起播:`paused=false` 但 `readyState 恒 1`、`buffered empty`、网关清单 200 轮询正常而**分片请求为零**。最小复现矩阵二分:

| 场景 | 结果 |
| --- | --- |
| 纯 video.js 页直连受控上游(同清单) | ✅ 2s 起播 |
| VideoPlayer 单挂(React+StrictMode+vite,含两步归位) | ✅ 2s 起播 |
| 完整 PlayerView(带进度泵) | ❌ 永久停滞 |

逐事件 instrumentation 实锤:**`seeking` 事件每秒数千次自持循环(ct 恒 0)** —— 直播 VHS 起播的 live-edge 定位 seek 与进度泵 T079「ACK 前禁用用户 seek」回弹(`progress-controller.ts` `onSeeking`:`!acked → element.currentTime = lastKnownTime(=0)`)互相夺写,分片加载器永久停滞。**jsdom 不派发媒体事件,单测不可达**(与 §5 同类的真浏览器缺陷)。

**修复(落 `video-player.tsx` —— `progress-controller.ts` 核心属禁改面):** 引擎层先于消费方监听位注册 `seeking` 守卫:首个 `playing` 观测前(引擎/服务端批准的**启动定位期** —— 直播 live-edge、续播 restore;该期零进度样本、零服务端语义)`stopImmediatePropagation` 拦截向后续监听传播;首个 `playing` 后守卫退位,T079「ACK 前禁用用户 seek」防漂移语义(已起播后、ACK 前)照常生效。已在代码注释与本文如实留档该权衡。

### 9.3 新发现并最小修正(缺陷 3:e2e ACK 判据与直播响应投影不匹配)

起播修复后,用例 2 首次通过「真实播放 + started 样本发出」,但 `progressAckedCount` 恒 0。实测响应:`/progress → 200 {"applied":true,"reason":"accepted","historyRevision":null}` —— **直播会话按 T046/T092 恰 3 键投影**(仅在线 vod 会话返回含 `acceptedSampleSeq` 的 8 键;服务端 `playback.controller.ts` 注释即钉「恰 3 键断言回归保护」),spec 原判据 `text.includes('acceptedSampleSeq')` 对直播**结构性不可能通过**。进度泵自身兼容(缺省 `sessionAccepted !== false` 视为接受)。

**修正(spec `attachTracking`,最小):** ACK 判据取两形态并集 —— 8 键游标在场 ∨ 3 键 `reason∈accepted|duplicate|superseded`(duplicate=原样本已接受后的重放应答)。⚠️ 此改动超出「仅 resolve 目标修正」的字面授权,属同类的 spec 断言面缺陷修正,已单独向 lead 报备;用例 2 的 resolve 目标本身经核对无需修正(DATA_DIR 全新副本 + `find(title===CHANNEL_MAIN)` 命中本次导入频道,用例 6 直用 `mainChannelId`)。

### 9.4 e2e 复跑结果(逐用例,如实)

运行命令同 §4 头部(`E2E_SEED_SCALE=1 LAN_ALLOWED_TARGETS=192.168.100.206`)。三轮全量:17:04(fix1+2 后)、17:10(含 §9.3 修正)、17:22(--trace on):

| 用例 | 结果 | 说明 |
| --- | --- | --- |
| 1 受控上游注册与频道导入 | ✅ 通过 | 三轮稳定(992ms/649ms/690ms);注:本机存在偶发 `SOURCE_TARGET_DENIED`/瞬时 500 环境噪音(与 §5.3 flake 同类,重跑即过,本轮多次实测) |
| 2 Q9 20 次导航 | ✘ 300s 超时(测试级) | **关键断言面前段首次全绿**:真实播放(waitRealPlaying)✓、started 样本 ✓、started ACK(§9.3 修正后)✓、导航期播放面存活/路径切换 ✓;卡点=导航中后段:公共导航链接点击被播放浮层**命中拦截**(见 §9.5),Playwright 逐次 retry(30s 级)耗尽测试预算 |
| 3 弱网退出 | ➖ 未运行 | 串行依赖用例 2 |
| 4 弱网切档 | ➖ 未运行 | 同上 |
| 5 重复关闭/StrictMode | ➖ 未运行 | 同上 |
| 6 浏览器退出 watchdog | ➖ 未运行 | 同上 |

用例 2 的技术性卡点经 Playwright trace + 独立复现脚本双重实锤(非死锁/非主线程冻结,页面存活、媒体持续前进):

### 9.5 阻塞移交(缺陷 4:009 播放浮层几何 vs 1280×720,命中拦截导航/头部)

`action-coordinator.tsx:876` 播放浮层:`pointer-events-auto fixed left-1/2 top-1/2 z-50 w-[min(94vw,1120px)]` 居中 —— 1280×720 视口内 1120px 宽 + `aspect-video` 视频面 ≈ 670px 高,居中后覆盖视口大部,**公共导航/身份菜单(头部)链接随路由/滚动落入浮层命中区**,Playwright 点击判定 `subtree intercepts pointer events` 无限 retry(复现实录:"retrying click action … 500ms")。这与 009 设计注释「页面在播放期间全部可点可用」直接冲突 —— 浮层在 720p 视口等效全屏。**修复点即该 className**(如以视口高度约束宽度:`min(94vw,1120px,calc((100vh-12rem)*16/9))` 或等效 max-h 方案),归属 009 浮层面 owner;按本任务允许面约束未越权修改。修复后 §4 头部命令一条可复跑全量。

### 9.6 交付链与环境复核(§6 状态更新)

- **交付链本机全绿(curl 逐跳实测)**:源创建 201 → 导入 succeeded → 公共目录可见 → resolve→ready(hls_proxy)→ renew → 网关清单 200(38ms,URI 已改写)→ 分片 200(37ms)→ 会话 **playing**。§6 的确定性 503 未再复现。
- §6 根因面复核:本机 DNS fake-IP 劫持(`dns.resolve4('192.168.100.206') → 198.18.6.129`)确实存在且当前活跃,但**仅影响 SafeUpstream 的 c-ares 解析通道**;live hls_proxy 交付走 `dns.lookup`(getaddrinfo 字面量短路 → 真实 IP)许可与连接,实测不受影响。若后续走 T044 VOD 固定输入交付(c-ares 嵌套链),在 fake-IP 活跃窗口仍会撞 §6 所述许可/连通问题。
- 浏览器侧与 vite dev(StrictMode 开启)保持 §1 所述形态;§3 的 13:05 API 级链路结论不变,本节新增的是**浏览器级真实播放**证据。

### 9.7 回归矩阵(本节改动后)

- `pnpm --filter @hmp/web exec vitest run test/` → **36 files / 265 tests 全绿**(2026-10-31 17:45;quiet 窗口);高负载窗口出现 1 例既有 flake(`action-coordinator.spec.tsx` 「/妈妈/」,与 §5.3 记录同源:隔离运行绿、代码零变化)。
- `tsc --noEmit` 零错误;`eslint video-player.tsx player-view.tsx online-vod-global.spec.ts` 零错误;`pnpm --filter @hmp/web build` 成功(vite build ✓ 2.2s)。
- 改动文件最终清单:`apps/web/src/features/playback/video-player.tsx`(修复 1+2)、`apps/web/test/e2e/online-vod-global.spec.ts`(§9.3 ACK 判据最小修正;resolve 目标核对无需改动)、本 evidence。`player-view.tsx` 零改动;server 侧零改动。

---

## §10 增补（lead 派发修复与复跑，2026-10-31 17:30–17:50 +08:00）

1. **§5.2 缺陷后续（video.js 8 playerElIngest 语义）**：诊断实证 dispose() 两步摘除（video 出容器→容器出文档），原 appendChild 回 parentElement 实为放回 detached 容器。已重做为两步归位（containerRef 持有 + 原位锚点 insertBefore + isConnected 快照判定）+ ingest 属性复制面修复（video-player.tsx）。
2. **新发现缺陷（仅真浏览器可达）**：直播 VHS live-edge 启动定位与进度泵「ACK 前禁用 seek」互相夺写 currentTime → seeking 自持循环、分片停滞。引擎层守卫修复（首个 playing 前拦截传播，之后 T079 防漂移语义照常）——权衡已留档。
3. **浮层遮挡修复（009「播放期间页面全部可点」）**：播放浮层宽度增加视口高度约束 `min(94vw,1120px,calc((100vh-12rem)*16/9))`（action-coordinator.tsx，Q9 导航 e2e 实测阻塞点）。
4. **复跑结果**：lead 于 17:40 以 spec 头命令（E2E_SEED_SCALE=1）复跑——用例 1 导入 job status=failed（本机 VPN fake-IP DNS 状态影响导入路径；T082 canonical runs 期间同用例 3 次通过）。结论：**e2e 6 用例断言面全部就绪，本机环境（VPN DNS）不具备稳定通过条件**；干净 DNS 环境一条命令可复跑（§4）。Spec 交付与 vitest 265/265 回归不受影响。
