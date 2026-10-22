import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { env } from './config/env';
import { AppModule } from './app.module';
import path from 'node:path';
import fs from 'node:fs';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';

async function bootstrap(): Promise<void> {
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
