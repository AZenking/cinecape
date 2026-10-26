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
