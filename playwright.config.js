import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT || 4173);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 300_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  // 静的サーバーはテストと同じプロセスで起動する(scripts/serve.mjs)
  globalSetup: './tests/e2e/global-setup.js',
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    // タブレットサイズ(iPad Air / iPad Pro 11 インチの縦向き)
    viewport: { width: 820, height: 1180 },
    deviceScaleFactor: 2,
    locale: 'ja-JP',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
