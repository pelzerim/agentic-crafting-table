import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileSummary, recordCpuProfile } from './cpu-profile.ts';

const frame = (functionName: string, url: string, lineNumber: number) => ({ functionName, url, lineNumber, columnNumber: 0, scriptId: '1' });

test('a profile summary ranks functions by their own time, each sample lasting until the next, with the file name and line only', () => {
  const profile = {
    nodes: [
      { id: 1, callFrame: frame('(root)', '', -1), children: [2, 3] },
      { id: 2, callFrame: frame('decodeState', 'file:///Applications/App.app/Contents/Resources/app.asar/dist/workspace-service.cjs', 955), children: [] },
      { id: 3, callFrame: frame('', 'node:internal/timers', 10), children: [] },
      { id: 4, callFrame: frame('decodeState', 'file:///Applications/App.app/Contents/Resources/app.asar/dist/workspace-service.cjs', 955), children: [] },
    ],
    startTime: 0, endTime: 10_000,
    samples: [2, 2, 3, 4, 1],
    timeDeltas: [1000, 2000, 3000, 1000, 500],
  };
  assert.deepEqual(profileSummary(profile, 2), {
    durationMs: 10,
    top: [
      { name: 'decodeState', file: 'workspace-service.cjs', line: 956, selfMs: 5.5, share: .55 },
      { name: '(anonymous)', file: 'timers', line: 11, selfMs: 1, share: .1 },
    ],
  });
});

test('a recording finds the function that keeps the thread busy and saves the profile privately', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-cpu-profile-'));
  try {
    let stop = false;
    const busyForProfileTest = () => { const end = performance.now() + 20; let x = 0; while (performance.now() < end) for (let step = 0; step < 100_000; step++) x += Math.sqrt(x + 1); return x; };
    const spin = () => { if (stop) return; busyForProfileTest(); setImmediate(spin); };
    spin();
    const result = await recordCpuProfile(400, directory, () => new Date('2026-11-02T15:20:00.000Z'));
    stop = true;
    assert.equal(result.file, join(directory, 'workspace-service-2026-11-02T15-20-00-000Z.cpuprofile'));
    assert.equal((await stat(result.file)).mode & 0o777, 0o600);
    assert.ok(JSON.parse(await readFile(result.file, 'utf8')).nodes.length > 0);
    assert.equal(result.top[0]?.file, 'cpu-profile.test.ts', JSON.stringify(result.top.slice(0, 5)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('only one recording runs at a time, and the length is bounded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-cpu-profile-'));
  try {
    const first = recordCpuProfile(200, directory);
    await assert.rejects(recordCpuProfile(200, directory), /already recording/);
    await first;
    await assert.rejects(recordCpuProfile(0, directory), /between/);
    await assert.rejects(recordCpuProfile(120_001, directory), /between/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
