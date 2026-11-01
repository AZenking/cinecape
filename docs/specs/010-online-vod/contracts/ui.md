# 010 UI与前端状态契约（Proposed）

**当前基线**：宪章1.5.0、heroui-react skill固定3.0.1、安装包@heroui/react及@heroui/styles 3.2.6、根目录[DESIGN.md](../../../../DESIGN.md)。本轮读取skill用于设计约束；未指定具体组件props，实施前必须按skill流程获取所用组件和主题官方v3文档，记录版本/获取日期；不能混用v2 Provider/API，也不能把本轮视为组件API或视觉运行验收完成。

颜色、表面、文字、焦点和危险状态采用官方语义token；间距/字体/圆角采用标准尺度，不能在业务组件复制裸值或任意值类。媒体浮层尺寸等项目尺度先在DESIGN.md集中定义并确认；文档不授权自行发明主题。所有状态同时有文字/图标，不只靠颜色；适用明暗主题、键盘与响应式布局均需运行时视觉证据。本轮未修改DESIGN.md或宪章。

## 1. 页面

- /vod：媒体库/在线搜索切换；URL保留mode/q/searchId/cursor，过期保留q不复用旧cursor。部分失败/全部失败/空结果/截断不同；public查询不夹带Profile历史。
- /vod/titles/:titleRef：临时详情、线路/选集；游客可看；播放进入已有登录/选档流程，回到同一候选但过期须重选。物化成功跳稳定/media/:parentId，失败不跳。
- /media/:id：父影片分集分页，子项单独播放；本Profile latest/resumeCandidate/nextAction单独查询。canAttemptResume显示“继续观看”，进入播放后可能显示时长/版本变化回退；始终有从头播放。
- 设置来源：使用现有授权/密码流程，vod配置/测试/启停，无全量扫描按钮，后端也拒绝对应动作。策略父子候选树保留既有允许名单解释。
- 历史：按Profile，分集带父/线/集标签；完成与接近结尾区分，已下架记录可看自己的摘要但不能播放；不得出现其他Profile状态。

## 2. 全局协调器及命令泵

ActionCoordinator为唯一全局播放身份/控制器，沿用009修正案A的非模态浮层：页面导航/设置入口可用；路由变化不卸载、不发stop；明确退出才关闭。HeroUI控件、可访问标签/焦点、已有样式token；播放容器不另引入阻塞模态。

新增内部控制子状态：idle→pausing/flushing→selecting/preparingIntent→stoppingSource→resolvingTarget→playing|awaitingGesture|unavailable。它是ActionCoordinator内部状态，不是第二播放器。操作上下文含Session/Profile/contextVersion/sessionId/generation/uiOperationRevision，每个await后核对；可创建后继的旧响应必须追查/清理，不能仅丢弃。

ProgressController以session为生命周期，generation变化只更新phase；seq分配在入队时递增且唯一，样本载荷一旦发送不变；有界队列合并尚未分配seq的periodic，保留started/pause/final因果。暂停等待返回ProgressReply，只有sessionAccepted才更新会话位置；historyApplied/applied控制“已同步历史”提示。superseded显示历史由其他设备更新，本机位置仍可carry。

finish与stopOnce拥有唯一Promise及不可变final载荷，禁止自然ended监听、退出按钮、hook清理各自生成一份。finish成功后unmount仅回收本地事件，不再补final；generation更新不能发session stop。排队超时换源可取消/从头/旧已接受位置，普通退出1s后结束UI及旧身份，提示未同步。

## 3. 连播

仅收到FinishReceipt.autoNextEligible才倒计时5s；cancel/立即下一集/关闭连播均可键盘操作，屏幕阅读器不每秒重复整段消息。下一集有历史时暂停倒计时让用户选位置。消费时服务器重验偏好，关闭按钮结果丢失时不自动推进，优先恢复偏好状态。

play() NotAllowedError→awaitingGesture，显示“下一集已就绪，点击播放”；不伪造started，非致命媒体格式错误，不自动再下一集。readyAt起60s未获得服务端playbackStarted确认释放会话；timer不因heartbeat/票续期续命。点击恢复先校验当前身份/票据，已失效则新准备。

## 4. 换源

播放器内抽屉列当前线路/跨源候选，默认最多3候选测速，可取消。显示首响应延迟，不标“真实带宽/最快画质”。high默认carry；ambiguous具体目标+版本警告确认；conflict不允许源位置。目标有自己历史则三个清楚选择：接当前播放位置/继续目标记录/从头。

停源前错误可恢复原播放；停后错误显示重试或重新播放原源，不能继续用旧ticket。发生媒体故障时提供60s recover_switch路径，过期明确新播放，不制造旧源权限。取消返回already_consumed时等待找回后继并stop；用户另选只能在清理结果后对新session/新明确播放发起，不循环消费旧槽。

## 5. 缓存及边界

query keys公共域用家庭部署上下文/locatorRevision/ref；Profile域含服务端验证Profile和contextVersion，不缓存裸用户名状态。切档/退出清个人缓存、倒计时、测速和意图；旧请求AbortSignal取消且结果回写带身份守卫。公共搜索继续可用，不要求设置grant。

导航普通卸载页面不取消全局播放，但退出应用/明确关闭播放器走统一stop。全局播放器关闭焦点回到原播放按钮或当前页面合理位置；列表分页恢复不自动开播。测试保留既有playback-surface/video等稳定选择器，不依赖阻塞模态背景失活。

## 6. 审查修订交互

换源先以candidateRef物化取得registeredCandidateRef，再使用已确认来源checkpoint创建意图。pause超时显示“等待保存 / 使用已确认位置X / 从头”，旧位置选择必须带该确切游标；游标前进则更新提示并重新选择，不静默替换。

连播倒计时前取nextPlanRef，展示绑定目标；有未完成历史暂停倒计时，用户明确选继续/从头。计划过期或NEXT_PLAN_CHANGED重新显示目标/历史并确认，不能把先前点击自动套到新目标。probe后历史变化导致失败，提示重新选择，不自动连跳。

完整结果找回因内容失权失败时直接对已知intent调用cleanup，不需要后继ID；收到cleanup_pending显示正在关闭，可重试，禁止启动替代会话直到清理确认或明确新操作；切档由服务端撤销兜底，不借旧context清理。

已播放但duration未知显示进度不可保存，playing确认解除等待手势，不显示已保存、不生成历史。seek按seekCapability及实际seekable范围展示：client仅媒体定位和观测复位，server_rebuild才更新generation；本地续播/携带定位失败不能显示成功，提示从头或重选。
