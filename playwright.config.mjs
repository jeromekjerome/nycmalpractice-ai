import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  fullyParallel: true,
  // Capped: with the default (half the CPU cores) busy machines timed out page loads; nycinjury.ai caps at 3.
  workers: 2,
  use: {
    baseURL: 'http://127.0.0.1:4178',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    headless: true,
  },
  webServer: {
    command: 'node server.js',
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: false,
    env: {
      // No local .env is loaded: dotenv is pointed at an empty file, so the server runs only with the settings here.
      DOTENV_CONFIG_PATH: fileURLToPath(new URL('./test/no-settings.env', import.meta.url)),
      DOTENV_CONFIG_QUIET: 'true',
      PORT: '4178',
      NODE_ENV: 'development',
      DISABLE_BACKGROUND_JOBS: '1',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/testdb',
      OPENAI_API_KEY: 'test-openai-key',
      // Empty, so that the real key in a local .env (dotenv leaves a set variable alone) is never loaded.
      ANTHROPIC_API_KEY: '',
      GEMINI_API_KEY: '',
      APP_URL: 'http://127.0.0.1:4178',
      STRIPE_SECRET_KEY: 'sk_test_123',
      STRIPE_PRICE_ID: 'price_test_123',
      STRIPE_MONTHLY_PRICE_ID: 'price_test_123',
      TWILIO_ACCOUNT_SID: '',
      TWILIO_AUTH_TOKEN: '',
      TWILIO_PHONE_NUMBER: '',
    },
  },
});
