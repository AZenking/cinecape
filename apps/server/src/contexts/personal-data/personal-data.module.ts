import { Module } from '@nestjs/common';
import { MeController } from '@contexts/personal-data/interface/me.controller';
// 010 T046:在线点播个人面控制器(装配必需最小增量 —— 控制器注册行;服务为纯函数模块)
import { VodPersonalController } from '@contexts/personal-data/interface/vod-personal.controller';
// 013:个人偏好面控制器(GET/PUT /api/profile/preferences,ADR-0017 零门禁直达)
import { ProfilePreferencesController } from '@contexts/personal-data/interface/profile-preferences.controller';
import { ProgressClockService } from '@contexts/personal-data/application/progress-clock.service';
import { ProgressWriteService } from '@contexts/personal-data/application/progress-write.service';
import { bindPersonalDataStore } from '@contexts/personal-data/application/personal-data-store.port';
import { drizzlePersonalDataStore } from '@contexts/personal-data/infrastructure/personal-data-store.drizzle';
import {
  PERSONAL_DATA_STORE,
  PROGRESS_CLOCK_PORT,
  PROGRESS_WRITE_PORT,
} from '@contexts/personal-data/personal-data.tokens';

/**
 * 个人数据模块(T097/T098/T099/T100/T101,005 US4):
 *
 * - MeController:/me/favorites/** 与 /me/history/**(Session→CurrentProfile 边界,
 *   写操作叠 SameOriginGuard);服务为纯函数模块(对齐 profile/household 惯例);
 * - ProgressClockService:点播 resolve 的 epoch 短事务分配 + progress_state 绑定 +
 *   续播冻结读取端口(由 PlaybackModule 引入本模块后经装配桥接注入 resolver);
 * - ProgressWriteService:进度写入状态机(progress 端点与 stop final 协作共用)。
 *
 * ⚠️ 注册:app.module.ts 的 imports 数组需加入 `PersonalModule`(本任务不改
 * app.module.ts,注册行见最终报告;PlaybackModule 已直接 import 本模块,
 * 因此 progress/stop/resolve 链路无需等待该注册行)。
 *
 * 007-T021:发布面 exports 对齐令牌 —— 类 provider 保留(本上下文 MeController 及
 * 内部装配仍按类引用注入),令牌经 useExisting 别名到同一实例(useClass/useFactory
 * 会产生第二实例,违反行为零变化:epoch 分配与写入状态机均为有状态服务);
 * exports 仅发布令牌,playback 侧类引用注入同步改为 @Inject(令牌)(T021 最小编译/
 * 启动修复,逐条记录)。
 *
 * 008-repository-extraction(T005,ADR-0015 D1):装配期绑定仓储 seam ——
 * PERSONAL_DATA_STORE provider 实例化时经 bindPersonalDataStore 注入 Drizzle 实现
 * (惰性 getDb 解析,Database 单例重开安全);不经 HTTP 暴露,不导出。
 */
@Module({
  // 010 T046:VodPersonalController(GET /me/vod/titles/:parentId/progress;授权次序与
  // MeController 同链 SessionGuard→CurrentProfileGuard —— 装配最小增量,行为见控制器文件头)
  controllers: [MeController, VodPersonalController, ProfilePreferencesController],
  providers: [
    {
      provide: PERSONAL_DATA_STORE,
      useFactory: () => bindPersonalDataStore(drizzlePersonalDataStore()),
    },
    ProgressClockService,
    ProgressWriteService,
    { provide: PROGRESS_CLOCK_PORT, useExisting: ProgressClockService },
    { provide: PROGRESS_WRITE_PORT, useExisting: ProgressWriteService },
  ],
  exports: [PROGRESS_CLOCK_PORT, PROGRESS_WRITE_PORT],
})
export class PersonalDataModule {}
