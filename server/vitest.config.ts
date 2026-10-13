import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    setupFiles: [fileURLToPath(new URL('./test/setup.ts', import.meta.url))],
  },
});
