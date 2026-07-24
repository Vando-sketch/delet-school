import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.worktrees/**', 'worktrees/**'],
    env: {
      // Tests must exercise src/config/index.ts's own fallback defaults, not whatever the
      // developer machine's real .env happens to contain. Pointing dotenv at a path with no
      // file makes `import 'dotenv/config'` a no-op instead of leaking local overrides in.
      DOTENV_CONFIG_PATH: '/dev/null',
    },
  },
});
