import { Module } from '@nestjs/common';
import { MeController } from './interface/me.controller';
import { ProgressClockService } from './application/progress-clock.service';
import { ProgressWriteService } from './application/progress-write.service';

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
 */
@Module({
  controllers: [MeController],
  providers: [ProgressClockService, ProgressWriteService],
  exports: [ProgressClockService, ProgressWriteService],
})
export class PersonalDataModule {}
