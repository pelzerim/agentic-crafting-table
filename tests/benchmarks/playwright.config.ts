import { defineConfig } from '@playwright/test';

// Comparison-only benchmarks: run by scripts/terminal-benchmark.mjs, never by CI
// or `npm run test:desktop` (whose testDir is tests/e2e).
export default defineConfig({
  testDir: '.', testMatch: '*.bench.ts', timeout: 20 * 60_000, workers: 1, fullyParallel: false,
  retries: 0, reporter: [['list']], outputDir: '../../test-results/benchmarks',
});
