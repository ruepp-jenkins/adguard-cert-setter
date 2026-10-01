import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  retries: 0,
  reporter: 'html',
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && node dist/server/main.js',
    url: 'http://127.0.0.1:4173/health',
    reuseExistingServer: !process.env.CI,
    env: {
      APP_HOST: '127.0.0.1',
      APP_PORT: '4173',
      APP_DATA_DIR: './test-results/e2e-data',
      APP_USERNAME: 'admin',
      APP_PASSWORD_HASH:
        '$argon2id$v=19$m=19456,t=2,p=1$zpvR/wFFOUEeKEUJij4uRg$TH8CUzZgzEbwU+j9+Yf4nb5XOJLelpkZ8fAAG87uKKQ',
    },
  },
});
