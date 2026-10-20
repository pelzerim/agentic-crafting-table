import { defineConfig } from '@playwright/test';

// Journeys read terminal text from xterm's accessibility tree, which exists only
// while screen reader support is on. Launches report assistive technology unless a
// test pins ACT_TEST_ASSISTIVE_TECH=0 to exercise the default.
process.env.ACT_TEST_ASSISTIVE_TECH ??= '1';
// Journeys and their screenshots draw plain neighborhoods whatever the setting says; a biome
// journey launches with ACT_TEST_NEIGHBORHOOD_STYLE='' so the setting decides.
process.env.ACT_TEST_NEIGHBORHOOD_STYLE ??= 'plain';

export default defineConfig({
  testDir: './tests/e2e', timeout: 30_000, workers: 1, fullyParallel: false,
  forbidOnly: Boolean(process.env.CI), retries: 0, updateSnapshots: 'none',
  snapshotPathTemplate: '{testDir}/../visual/baselines/{platform}/{arg}{ext}',
  expect: { toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css', threshold: .2, maxDiffPixels: 50 } },
  reporter: [['list'], ['html', { open: 'never' }]], use: { trace: 'retain-on-failure' },
});
