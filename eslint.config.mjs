// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.d.ts',
      'packages/shared/src/schema.d.ts',
      // 007-T025 证据工具(一次性采样/比对脚本,非交付代码,不入 lint 项目服务)
      'docs/specs/007-backend-ddd-restructure/evidence/snapshot-parity/*.mjs',
      // 008-T002: 纯度门禁脚本(allowDefaultProject 上限 8,按 007 证据工具先例走 ignores)
      'apps/server/scripts/**/*.mjs',
      // 可再生本地缓存,不入库(AGENTS.md 契约):HeroUI 文档缓存与 opencode 工具脚本,非交付代码
      '.heroui-docs/**',
      '.opencode/**',
      // heroui skill 安装产物内的工具脚本(.agents 版本入库存档但同属工具脚本,非交付代码)
      '**/.agents/skills/**/scripts/**',
      '**/.claude/skills/**',
      '**/.cursor/skills/**',
      // 一次性上游探针脚本(untracked 工具,非交付代码,沿 007 证据工具先例)
      'apps/server/scripts/probe-upstream.ts',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        // type-aware 规则(no-floating-promises)需要 project 定位;
        // projectService 自动发现 monorepo 各包 tsconfig(修复 pre-existing 损坏)
        projectService: {
          allowDefaultProject: [
            'eslint.config.mjs',
            // 007-T002: dependency-cruiser 审计配置(CJS,不在任何 tsconfig include 内)
            'apps/server/.dependency-cruiser.cjs',
            'apps/server/vitest.config.ts',
            'apps/web/vite.config.ts',
            'apps/web/vitest.config.ts',
            'apps/web/playwright.config.ts',
            'apps/server/test/runtime-smoke.mjs',
            'apps/server/test/fixtures/playback/generate-media.mjs',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // `_` 前缀参数为「占位/刻意未用」约定(settings-access.guard.ts 占位 authorize
      // 的 `_context` 等,T013 最小修复),与业务语义无关,不放宽其他未用检查。
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
