import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: '**/*.e2e.ts', fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:4197', trace: 'retain-on-failure', colorScheme: 'light', reducedMotion: 'reduce' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1100 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
  webServer: { command: 'bun run dev --port 4197', url: 'http://127.0.0.1:4197', reuseExistingServer: false },
});
