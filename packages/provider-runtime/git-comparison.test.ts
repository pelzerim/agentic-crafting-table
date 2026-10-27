import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { captureGitComparison } from './git-comparison.ts';
import { pruneComparisons } from './comparison-pruning.ts';
import { fetchGitHubComparison } from './github-comparison.ts';
import type { FetchComparison, GitComparison } from './git-comparison.ts';

test('isolated review captures the merge-base diff, complete binary changes and immutable replay without touching the source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'act-comparison-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); await writeFile(join(root, 'code.txt'), 'original\n'); git('add', '.'); git('commit', '-qm', 'base'); const baseSha = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'feature'); await writeFile(join(root, 'code.txt'), 'review this\n'); await writeFile(join(root, 'image.bin'), Buffer.from([0, 1, 2, 3])); git('add', '.'); git('commit', '-qm', 'feature'); const headSha = git('rev-parse', 'HEAD');
    git('checkout', '-q', '--detach', baseSha); await writeFile(join(root, 'base-only.txt'), 'not part of PR\n'); git('add', '.'); git('commit', '-qm', 'base advances'); const baseTipSha = git('rev-parse', 'HEAD');
    const input = { repository: 'fixture/repo', number: 7, baseTipSha, headSha }, id = randomUUID();
    const comparison = await captureGitComparison(root, id, input, async run => { await run(['-c', 'protocol.file.allow=always', 'fetch', '--quiet', root, baseTipSha, headSha]); }, new AbortController().signal);
    assert.equal(comparison.baseSha, baseSha); assert.deepEqual(comparison.changedFiles, ['code.txt', 'image.bin']); assert.match(comparison.diff, /GIT binary patch/); assert.doesNotMatch(comparison.diff, /base-only/);
    assert.equal(await readFile(join(comparison.cwd, 'code.txt'), 'utf8'), 'review this\n'); assert.equal(git('rev-parse', 'HEAD'), baseTipSha); assert.equal(await readFile(join(root, 'code.txt'), 'utf8'), 'original\n');
    assert.deepEqual(await captureGitComparison(root, id, input, async () => { throw new Error('must not fetch again'); }, new AbortController().signal), comparison);
    await assert.rejects(captureGitComparison(root, id, { ...input, headSha: baseTipSha }, async () => {}, new AbortController().signal), /does not match/);
    const manifest = join(root, 'comparisons', id, 'comparison.json'); await writeFile(manifest, JSON.stringify({ ...comparison, diff: 'tampered' }));
    await assert.rejects(captureGitComparison(root, id, input, async () => {}, new AbortController().signal), /does not match/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('GitHub comparison pins the head and never puts credentials in args or persisted config', async () => {
  const calls: { args: string[]; environment?: NodeJS.ProcessEnv }[] = [], headSha = 'a'.repeat(40), signal = new AbortController().signal;
  const fetch = fetchGitHubComparison('fixture', { accounts: async () => [], token: async account => { assert.equal(account, 'fixture'); return 'sensitive'; } });
  const input = { repository: 'fixture/repo', number: 7, baseTipSha: 'b'.repeat(40), headSha };
  await fetch(async (args, environment) => { calls.push({ args, environment }); return args[0] === 'rev-parse' ? headSha : ''; }, input, signal);
  assert.equal(calls[0].args.includes('https://github.com/fixture/repo.git'), true); assert.doesNotMatch(JSON.stringify(calls.map(call => call.args)), /sensitive|Authorization/);
  assert.equal(calls[0].environment?.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraHeader'); assert.equal(calls[1].environment, undefined);
  await assert.rejects(fetch(async () => 'c'.repeat(40), input, signal), /PR changed/);
  await assert.rejects(fetch(async () => '', { ...input, repository: 'fixture/..' }, signal), /valid GitHub/);
});

test('shallow history and an oversized diff refuse capture rather than producing a partial review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'act-comparison-limits-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); await writeFile(join(root, 'code.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base'); const baseTipSha = git('rev-parse', 'HEAD');
    await writeFile(join(root, 'code.txt'), 'line\n'.repeat(460_000)); git('add', '.'); git('commit', '-qm', 'large'); const headSha = git('rev-parse', 'HEAD');
    const input = { repository: 'fixture/repo', number: 7, baseTipSha, headSha }, signal = new AbortController().signal;
    await assert.rejects(captureGitComparison(root, randomUUID(), input, async run => { await run(['-c', 'protocol.file.allow=always', 'fetch', '--quiet', '--depth=1', `file://${root}`, headSha, baseTipSha]); }, signal), /history is incomplete/);
    await assert.rejects(captureGitComparison(root, randomUUID(), input, async run => { await run(['-c', 'protocol.file.allow=always', 'fetch', '--quiet', root, baseTipSha, headSha]); }, signal), /size limit/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function remoteFixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix)), source = join(root, 'source'), data = join(root, 'data');
  execFileSync('git', ['init', '-q', source]);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: source, encoding: 'utf8' }).trim();
  for (let index = 0; index < 60; index++) { await writeFile(join(source, `file-${index % 12}.txt`), `revision ${index}\n`); git('add', '.'); git('commit', '-qm', `history ${index}`); }
  const base = git('rev-parse', 'HEAD');
  const pull = async (number: number, file: string) => { git('checkout', '-q', '--detach', base); await writeFile(join(source, file), `pull ${number}\n`); git('add', '.'); git('commit', '-qm', `pull ${number}`); const head = git('rev-parse', 'HEAD'); git('update-ref', `refs/pull/${number}/head`, head); return head; };
  const fetch = (log: string[] = []): FetchComparison => async (run, input) => { log.push('start'); await run(['-c', 'protocol.file.allow=always', 'fetch', '--quiet', '--no-tags', source, input.baseTipSha, `+refs/pull/${input.number}/head:refs/review/head`]); log.push('end'); };
  const cache = join(data, 'git-cache', 'fixture', 'repo.git'), inPack = () => Number(/in-pack: (\d+)/.exec(execFileSync('git', ['count-objects', '-v'], { env: { ...process.env, GIT_DIR: cache }, encoding: 'utf8' }))![1]);
  return { root, source, data, git, base, pull, fetch, cache, inPack };
}
const listFiles = async (directory: string): Promise<string[]> => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? listFiles(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();

test('a shared repository cache makes later captures incremental with results identical to the source repository and isolated working copies', async () => {
  const f = await remoteFixture('act-comparison-cache-'), signal = new AbortController().signal;
  try {
    const firstHead = await f.pull(1, 'file-3.txt');
    const first = await captureGitComparison(f.data, randomUUID(), { repository: 'Fixture/Repo', number: 1, baseTipSha: f.base, headSha: firstHead }, f.fetch(), signal);
    const cached = f.inPack(); assert.ok(cached > 150, `full history cached (${cached})`);
    assert.equal(first.baseSha, f.base); assert.equal(first.diff, f.git('diff', '--no-renames', '--binary', '--full-index', f.base, firstHead, '--') + '\n');
    const secondHead = await f.pull(2, 'added.txt');
    const second = await captureGitComparison(f.data, randomUUID(), { repository: 'fixture/repo', number: 2, baseTipSha: f.base, headSha: secondHead }, f.fetch(), signal);
    const incremental = f.inPack(); assert.ok(incremental - cached <= 6, `only objects of the new commit were fetched (${incremental - cached})`);
    assert.deepEqual(second.changedFiles, ['added.txt']); assert.equal(await readFile(join(second.cwd, 'added.txt'), 'utf8'), 'pull 2\n');
    const again = await captureGitComparison(f.data, randomUUID(), { repository: 'fixture/repo', number: 1, baseTipSha: f.base, headSha: firstHead }, f.fetch(), signal);
    const content = ({ cwd, digest, ...rest }: GitComparison) => (assert.ok(cwd && digest), rest); assert.deepEqual(content(again), { ...content(first), repository: 'fixture/repo' });
    const work = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Agent', '-c', 'user.email=agent@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: second.cwd, encoding: 'utf8' }).trim();
    assert.equal(work('rev-parse', 'HEAD'), secondHead);
    assert.throws(() => work('config', '--get-regexp', '^remote\\.')); assert.equal(work('rev-parse', 'refs/review/base'), f.base);
    await assert.rejects(stat(join(second.cwd, '.git', 'objects', 'info', 'alternates')));
    const before = await listFiles(f.cache); await writeFile(join(second.cwd, 'agent.txt'), 'agent\n'); work('add', '.'); work('commit', '-qm', 'agent'); work('gc', '--quiet', '--prune=now');
    assert.deepEqual(await listFiles(f.cache), before); assert.equal(f.inPack(), incremental);
    execFileSync('git', ['fsck', '--no-progress'], { env: { ...process.env, GIT_DIR: f.cache } });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a pruned checkout, or one whose repository went missing, is rebuilt from the cache with the same comparison', async () => {
  const f = await remoteFixture('act-comparison-pruned-'), signal = new AbortController().signal;
  try {
    const head = await f.pull(1, 'file-3.txt'), id = randomUUID(), input = { repository: 'fixture/repo', number: 1, baseTipSha: f.base, headSha: head };
    const first = await captureGitComparison(f.data, id, input, f.fetch(), signal), folder = join(f.data, 'comparisons', id);
    await writeFile(join(folder, `review-${id}.md`), 'request');
    const cache = await listFiles(f.cache);
    assert.deepEqual(await pruneComparisons(f.data, { finished: () => true, now: Date.now() + 1000, minAgeMs: 0 }).then(result => result.pruned), [id]);
    assert.deepEqual(await listFiles(f.cache), cache);
    assert.deepEqual(await captureGitComparison(f.data, id, input, f.fetch(), signal), first);
    assert.equal(await readFile(join(first.cwd, 'file-3.txt'), 'utf8'), 'pull 1\n'); assert.equal(await readFile(join(folder, `review-${id}.md`), 'utf8'), 'request');
    await rm(first.cwd, { recursive: true, force: true });
    assert.deepEqual(await captureGitComparison(f.data, id, input, f.fetch(), signal), first);
    assert.equal(await readFile(join(first.cwd, 'file-3.txt'), 'utf8'), 'pull 1\n');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('concurrent captures of one repository serialize on the cache lock and both succeed', async () => {
  const f = await remoteFixture('act-comparison-lock-'), signal = new AbortController().signal, log: string[] = [];
  try {
    const heads = [await f.pull(1, 'one.txt'), await f.pull(2, 'two.txt')];
    const results = await Promise.all(heads.map((headSha, index) => captureGitComparison(f.data, randomUUID(), { repository: 'fixture/repo', number: index + 1, baseTipSha: f.base, headSha }, f.fetch(log), signal)));
    assert.deepEqual(log, ['start', 'end', 'start', 'end']); assert.deepEqual(results.map(result => result.changedFiles), [['one.txt'], ['two.txt']]);
    await assert.rejects(stat(`${f.cache}.lock`));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a lock left by a dead process is reclaimed while a live holder is waited for until cancellation', async () => {
  const f = await remoteFixture('act-comparison-stale-');
  try {
    const headSha = await f.pull(1, 'one.txt'), input = { repository: 'fixture/repo', number: 1, baseTipSha: f.base, headSha };
    await captureGitComparison(f.data, randomUUID(), input, f.fetch(), new AbortController().signal);
    await writeFile(`${f.cache}.lock`, JSON.stringify({ pid: process.ppid, at: Date.now() }));
    const controller = new AbortController(); setTimeout(() => controller.abort(), 300);
    await assert.rejects(captureGitComparison(f.data, randomUUID(), input, f.fetch(), controller.signal), { name: 'AbortError' });
    await writeFile(`${f.cache}.lock`, JSON.stringify({ pid: spawnSync(process.execPath, ['-e', '']).pid, at: Date.now() }));
    assert.equal((await captureGitComparison(f.data, randomUUID(), input, f.fetch(), new AbortController().signal)).baseSha, f.base);
    await assert.rejects(stat(`${f.cache}.lock`));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a corrupt cache is discarded and fetched fully once, while a healthy cache survives a failed fetch', async () => {
  const f = await remoteFixture('act-comparison-heal-'), signal = new AbortController().signal;
  try {
    const headSha = await f.pull(1, 'one.txt'), input = { repository: 'fixture/repo', number: 1, baseTipSha: f.base, headSha };
    await captureGitComparison(f.data, randomUUID(), input, f.fetch(), signal);
    await assert.rejects(captureGitComparison(f.data, randomUUID(), input, async run => { await run(['fetch', '--quiet', join(f.root, 'missing'), f.base]); }, signal), /^Error: Could not fetch the isolated PR comparison/);
    const packs = join(f.cache, 'objects', 'pack'), files = await readdir(packs); assert.ok(files.length >= 2, 'healthy cache retained');
    for (const file of files) await rm(join(packs, file), { force: true });
    const log: string[] = [], healed = await captureGitComparison(f.data, randomUUID(), input, f.fetch(log), signal);
    assert.equal(healed.baseSha, f.base); assert.deepEqual(log, ['start', 'start', 'end']); assert.deepEqual(healed.changedFiles, ['one.txt']); assert.ok(f.inPack() > 150);
    assert.deepEqual((await readdir(join(f.data, 'git-cache', 'fixture'))).sort(), ['repo.git']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('GitHub credentials stay out of the cache, working copy, manifest and failures of a real capture', async () => {
  const f = await remoteFixture('act-comparison-token-'), signal = new AbortController().signal, token = 'ghs_sensitiveFixtureToken', encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
  try {
    const headSha = await f.pull(3, 'three.txt'), credentials = { accounts: async () => [], token: async () => token };
    const local = (remote: string): FetchComparison => (run, input, abort) => fetchGitHubComparison('fixture', credentials, () => remote)((args, environment) => run(['-c', 'protocol.file.allow=always', ...args], environment), input, abort);
    const comparison = await captureGitComparison(f.data, randomUUID(), { repository: 'fixture/repo', number: 3, baseTipSha: f.base, headSha }, local(f.source), signal);
    assert.deepEqual(comparison.changedFiles, ['three.txt']);
    for (const file of await listFiles(f.data)) { const text = await readFile(file, 'latin1'); assert.equal(text.includes(token) || text.includes(encoded), false, file); }
    const failure = await captureGitComparison(f.data, randomUUID(), { repository: 'fixture/repo', number: 3, baseTipSha: f.base, headSha }, local(join(f.root, 'missing')), signal).catch(error => error as Error);
    assert.ok(failure instanceof Error); assert.doesNotMatch(`${failure.message} ${failure.stack} ${JSON.stringify(failure)}`, new RegExp(`${token}|${encoded}|Authorization`));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
