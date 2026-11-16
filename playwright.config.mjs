import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: ['**/ui.spec.mjs', '**/refresh-ui.spec.mjs', '**/pending-import-ui.spec.mjs', '**/job-discovery-ui.spec.mjs', '**/design-ui.spec.mjs'],
  timeout: 90_000,
  expect: { timeout: 8_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: { viewport: { width: 1366, height: 1000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } }
  ]
});
