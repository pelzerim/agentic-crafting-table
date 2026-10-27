import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile, link, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pruneComparisons } from './comparison-pruning.ts';

const HOUR = 60 * 60 * 1000;
async function checkout(root: string, id: string, at: number, options: { manifest?: boolean } = {}) {
  const folder = join(root, 'comparisons', id), repository = join(folder, 'repository');
  await mkdir(join(repository, '.git', 'objects'), { recursive: true });
  await writeFile(join(repository, 'code.ts'), 'x'.repeat(1000));
  await link(join(root, 'git-cache', 'fixture', 'repo.git', 'objects', 'pack'), join(repository, '.git', 'objects', 'pack'));
  await writeFile(join(folder, `review-${id}.md`), 'request');
  if (options.manifest !== false) { await writeFile(join(folder, 'comparison.json'), '{}'); await utimes(join(folder, 'comparison.json'), at / 1000, at / 1000); }
  await utimes(folder, at / 1000, at / 1000);
  return folder;
}

test('old finished checkouts lose their repository and manifest; young, unfinished, non-UUID folders and the cache stay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'act-prune-'));
  try {
    const cache = join(root, 'git-cache', 'fixture', 'repo.git', 'objects');
    await mkdir(cache, { recursive: true }); await writeFile(join(cache, 'pack'), 'p'.repeat(5000));
    const now = Date.now(), young = randomUUID(), old = randomUUID(), unfinished = randomUUID(), bare = randomUUID();
    await checkout(root, young, now - 10 * 60_000);
    const pruned = await checkout(root, old, now - 2 * HOUR);
    await checkout(root, unfinished, now - 2 * HOUR);
    await checkout(root, bare, now - 3 * HOUR, { manifest: false });
    await mkdir(join(root, 'comparisons', 'not-a-request', 'repository'), { recursive: true });
    await utimes(join(root, 'comparisons', 'not-a-request'), (now - 5 * HOUR) / 1000, (now - 5 * HOUR) / 1000);
    const asked: string[] = [];
    const result = await pruneComparisons(root, { finished: id => { asked.push(id); return id !== unfinished; }, now });
    assert.deepEqual(result.pruned.sort(), [old, bare].sort());
    assert.equal(result.bytes, 2000);
    assert.deepEqual(await readdir(pruned), [`review-${old}.md`]);
    assert.deepEqual(await readdir(join(root, 'comparisons', bare)), [`review-${bare}.md`]);
    assert.deepEqual((await readdir(join(root, 'comparisons', young))).sort(), ['comparison.json', 'repository', `review-${young}.md`]);
    assert.deepEqual((await readdir(join(root, 'comparisons', unfinished))).sort(), ['comparison.json', 'repository', `review-${unfinished}.md`]);
    assert.deepEqual(await readdir(join(root, 'comparisons', 'not-a-request')), ['repository']);
    assert.equal(asked.includes(young), false); assert.equal(asked.includes('not-a-request'), false);
    assert.equal((await stat(join(cache, 'pack'))).size, 5000);
    assert.deepEqual(await pruneComparisons(root, { finished: id => id !== unfinished, now }), { pruned: [], bytes: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a missing comparisons folder prunes nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'act-prune-'));
  try { assert.deepEqual(await pruneComparisons(root, { finished: () => true, now: Date.now() }), { pruned: [], bytes: 0 }); }
  finally { await rm(root, { recursive: true, force: true }); }
});
