import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2).map((arg) => arg.replace(/^apps\/server\//, ''));
const result = spawnSync('vitest', ['run', ...args], { stdio: 'inherit' });
process.exit(result.status ?? 0);
