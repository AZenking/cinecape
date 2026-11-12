// 临时诊断脚本:真实 env + 真实读取链路探测(用完即删)
import { getConfig } from '../src/platform/config/env';
import { openRemoteSource } from '../src/platform/upstream/safe-upstream-reader';

async function main(): Promise<void> {
  const cfg = getConfig();
  const targets = cfg.LAN_ALLOWED_TARGETS;
  console.log('[probe] 条目数:', targets.length);
  console.log('[probe] 含 public 条目:', targets.some((t) => t.kind === 'public'));

  const url = 'https://vip.dytt-network.com/20260921/39826_735b3580/index.m3u8';
  try {
    const opened = await openRemoteSource(url, { allowedTargets: targets });
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) {
      chunks.push(chunk as Buffer);
      if (chunks.reduce((sum, c) => sum + c.length, 0) > 65536) break;
    }
    void opened.close();
    const body = Buffer.concat(chunks).toString('utf8');
    console.log('[probe] 读取成功 bytes=', body.length, 'finalUrl=', opened.finalUrl);
    console.log('[probe] body 头 80 字符:', JSON.stringify(body.slice(0, 80)));
  } catch (err) {
    const failure = err as { name?: string; message?: string; code?: string };
    console.log('[probe] 读取失败:', failure.name, failure.code ?? '', failure.message);
  }
}

void main();
