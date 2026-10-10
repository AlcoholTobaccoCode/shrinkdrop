import { defineConfig, devices } from '@playwright/test';

const chromePath = process.env.PLAYWRIGHT_CHROME_PATH ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'pnpm dev --host 127.0.0.1 --configLoader runner',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...(chromePath ? { launchOptions: { executablePath: chromePath } } : {}) } }]
});
