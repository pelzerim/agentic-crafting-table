import test from 'node:test';
import assert from 'node:assert/strict';
import { staleWhileRefreshing } from './agent-providers.ts';

test('a stale model list is returned at once while one shared refresh replaces it', async () => {
  let time = 0, loads = 0, release!: () => void, failNext = false;
  const choice = staleWhileRefreshing(async () => {
    loads++;
    if (loads > 1) await new Promise<void>(resolve => { release = resolve; });
    if (failNext) throw new Error('codex failed');
    return `list ${loads}`;
  }, 1000, () => time);
  const [first, same] = await Promise.all([choice(), choice()]);
  assert.deepEqual([first, same, loads], ['list 1', 'list 1', 1], 'the first list is waited for, once');
  time = 500; assert.equal(await choice(), 'list 1'); assert.equal(loads, 1);
  time = 1500;
  assert.deepEqual(await Promise.all([choice(), choice()]), ['list 1', 'list 1'], 'stale, without waiting');
  assert.equal(loads, 2, 'one refresh for both');
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(await choice(), 'list 2');
  time = 3000; failNext = true;
  assert.equal(await choice(), 'list 2'); release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(await choice(), 'list 2', 'a failed refresh keeps the last list');
});
