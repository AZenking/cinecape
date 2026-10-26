import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { env } from './config/env';
import { AppModule } from './app.module';
import { precheckForStartup } from './database/precheck';
import path from 'node:path';
import fs from 'node:fs';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';

async function bootstrap(): Promise<void> {
  // T007:启动路径在任何写连接、WAL 设置或迁移元数据创建之前先只读预检旧库;
  // 拒绝(旧已初始化库/损坏/未知)时以可判读原因退出,不打开目标库。
  const gate = precheckForStartup();
  if (!gate.allowed) {
    console.error(`[hmp-server] 启动拒绝(${gate.code}):${gate.reason}`);
    process.exitCode = 1;
    return;
  }
  if (gate.kind === 'fresh-empty') {
    console.log(`[hmp-server] ${gate.reason}`);
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['log', 'warn', 'error'] });
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  const webDir = path.resolve(__dirname, '../../web/dist');
  if (fs.existsSync(path.join(webDir, 'index.html'))) {
    app.useStaticAssets(webDir);
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method === 'GET' && req.path !== '/api' && !req.path.startsWith('/api/') && !path.extname(req.path)) {
        res.sendFile(path.join(webDir, 'index.html'));
      } else next();
    });
  }
  await app.listen(env.PORT);
  console.log(`[hmp-server] listening on :${env.PORT} (env=${env.NODE_ENV})`);
}

void bootstrap();
