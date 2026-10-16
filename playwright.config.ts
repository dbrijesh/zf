import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

const port = 8799;
const data = path.join(os.tmpdir(), `zf-e2e-${process.pid}`);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure', screenshot: 'only-on-failure', viewport: { width: 1600, height: 950 } },
  webServer: {
    command: 'npx tsx apps/api/src/main.ts',
    url: `http://localhost:${port}/api/v1/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { PORT: String(port), ZF_DATA_DIR: data, ZF_SEED: 'demo', ZF_SEED_LIVE: '0', ZF_SEED_BULK: '200', ZF_FORCE_HARNESS: 'fake', ZF_FAKE_DELAY_MS: '150', ZF_ADVISOR: 'rules', ZF_PUBLIC_URL: `http://localhost:${port}`, ZF_DEV_LOGIN: '1' },
  },
});