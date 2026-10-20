// Compares terminal performance for screen reader on/off and 10,000/5,000 lines of
// scrollback on a synthetic Claude-like session. Local, comparison-only; not CI.
//   npm run bench:terminal                    50,000 transcript lines, 2 runs each
//   BENCH_LINES=20000 BENCH_REPEATS=3 npm run bench:terminal
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
if (!process.argv.includes('--no-build')) run('npm', ['run', 'build']);
run('npx', ['playwright', 'test', '--config', 'tests/benchmarks/playwright.config.ts']);

const report = JSON.parse(await readFile('test-results/terminal-benchmark.json', 'utf8'));
const median = values => { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
const columns = {
  'stream ms': r => r.stream.ms, 'stream MB/s': r => r.stream.megabytesPerSecond, 'stream frame p95': r => r.stream.frames.p95,
  'stream frame max': r => r.stream.frames.max, 'stream frames >50ms': r => r.stream.frames.over50, 'stream long tasks ms': r => r.stream.longTasks.totalMs,
  'write p95': r => r.stream.writeP95, 'scroll ms/event': r => r.scroll.msPerEvent, 'scroll frame p95': r => r.scroll.frames.p95,
  'scroll frame max': r => r.scroll.frames.max, 'scroll long tasks ms': r => r.scroll.longTasks.totalMs, 'reopen ms': r => r.reopen.ms,
  'reopen replayed chars': r => r.reopen.replayedCharacters,
};
const variants = [...new Set(report.results.map(result => result.variant))];
console.log(`\nTerminal benchmark: ${report.lines} lines, ${report.repeats} run(s) each, ${report.machine.cpu} (${report.machine.platform}/${report.machine.arch}). Medians:\n`);
console.table(Object.fromEntries(variants.map(variant => {
  const runs = report.results.filter(result => result.variant === variant);
  return [variant, Object.fromEntries(Object.entries(columns).map(([name, pick]) => [name, Math.round(median(runs.map(pick)) * 10) / 10]))];
})));
