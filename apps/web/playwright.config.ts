import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run the real web app + worker against a dedicated database (thrift_e2e), reseeded with
 * reference + illustrative demo data before the run (see e2e/start-stack.sh). Uses the pre-installed Chromium when available.
 */
const PORT = Number(process.env.E2E_PORT ?? 3200);
const DB = process.env.E2E_DATABASE_URL ?? 'postgres://thrift:thrift@localhost:5432/thrift_e2e';
const executablePath = process.env.PW_CHROMIUM_PATH ?? (process.env.PLAYWRIGHT_BROWSERS_PATH ? '/opt/pw-browsers/chromium' : undefined);

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'], launchOptions: executablePath ? { executablePath } : {} } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], launchOptions: executablePath ? { executablePath } : {} } },
  ],
  webServer: {
    command: 'bash e2e/start-stack.sh',
    url: `http://localhost:${PORT}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: { E2E_PORT: String(PORT), E2E_DATABASE_URL: DB },
  },
});
