import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { canonical } from '../core/control.ts';
import { sessionPath } from '../platform/shell.ts';
import { pullKey } from './github.ts';

const sha = z.string().regex(/^[a-f0-9]{40}$/i);
export const comparisonInput = z.object({ repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().positive(), baseTipSha: sha, headSha: sha });
export type ComparisonInput = z.infer<typeof comparisonInput>;
export interface GitComparison extends ComparisonInput { baseSha: string; changedFiles: string[]; diff: string; cwd: string; digest: string }
export type GitCommand = (args: string[], environment?: NodeJS.ProcessEnv) => Promise<string>;
export type FetchComparison = (git: GitCommand, input: ComparisonInput, signal: AbortSignal) => Promise<void>;
const MAX_DIFF = 2 * 1024 * 1024, LOCK_STALE_MS = 10 * 60_000;
const digest = (value: Omit<GitComparison, 'digest'>) => createHash('sha256').update(canonical(value)).digest('hex');
class GitFailure extends Error {}
const chains = new Map<string, Promise<unknown>>();

/** Serializes cache use per repository across concurrent captures in this process
 * (promise chain) and other processes (exclusive lockfile). A lock whose owner
 * process is gone, or that outlived every bounded git step, is reclaimed. */
async function locked<T>(file: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  const run = (chains.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const owner = JSON.stringify({ pid: process.pid, at: Date.now(), nonce: randomUUID() });
    for (;;) {
      signal.throwIfAborted();
      try { await writeFile(file, owner, { flag: 'wx', mode: 0o600 }); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const held = await readFile(file, 'utf8').catch(() => ''), modified = (await stat(file).catch(() => undefined))?.mtimeMs ?? Date.now();
      let stale = Date.now() - modified > LOCK_STALE_MS;
      try { const { pid } = JSON.parse(held) as { pid: number }; if (pid === process.pid) stale = true; else process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH' || (held && !(error as NodeJS.ErrnoException).code)) stale = true; }
      if (stale && (await readFile(file, 'utf8').catch(() => '')) === held) await rm(file, { force: true });
      else await delay(100, undefined, { signal });
    }
    try { return await work(); } finally { if ((await readFile(file, 'utf8').catch(() => '')) === owner) await rm(file, { force: true }); }
  });
  const tail = run.catch(() => {}); chains.set(file, tail);
  void tail.then(() => { if (chains.get(file) === tail) chains.delete(file); });
  return run;
}

/** No caller working tree, repository config, hooks, filters, credentials or
 * executable PR content are reused. A bounded complete git diff is mandatory;
 * REST patches may be missing/truncated and are never substituted.
 *
 * Objects are fetched into a shared, bare, fetch-only cache per repository so a
 * repeated capture downloads only missing objects. Every capture still performs
 * the authenticated fetch of its exact revisions, so the selected account must
 * read the repository each time. The per-request repository is a local clone
 * whose objects are hardlinked (never alternates): it has no link back to the
 * cache, writes in it cannot reach the cache, and later cache maintenance cannot
 * remove objects a running review uses. Nothing is ever deleted from the cache
 * except a whole corrupt cache, which is moved aside and fetched fully once. */
export async function captureGitComparison(directory: string, requestId: string, raw: ComparisonInput, fetch: FetchComparison, signal: AbortSignal): Promise<GitComparison> {
  z.string().uuid().parse(requestId); const input = comparisonInput.parse(raw);
  const [owner, repo] = input.repository.split('/'); pullKey({ owner, repo, number: input.number });
  const folder = join(directory, 'comparisons', requestId), cwd = join(folder, 'repository'), manifest = join(folder, 'comparison.json');
  const cacheParent = join(directory, 'git-cache', owner.toLowerCase()), cache = join(cacheParent, `${repo.toLowerCase()}.git`);
  try {
    const saved: GitComparison = JSON.parse(await readFile(manifest, 'utf8')), { digest: expected, ...content } = saved;
    if (canonical(comparisonInput.parse(saved)) !== canonical(input) || saved.cwd !== cwd || digest(content) !== expected) throw new Error('Saved review comparison does not match this request');
    // A checkout removed after its review finished is rebuilt from the cache.
    if (await stat(cwd).then(info => info.isDirectory(), () => false)) return saved;
    await rm(manifest, { force: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  signal.throwIfAborted(); await mkdir(folder, { recursive: true, mode: 0o700 }); await mkdir(cacheParent, { recursive: true, mode: 0o700 });
  const environment: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(environment, { PATH: await sessionPath(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' });
  const runner = (directory: string, base: NodeJS.ProcessEnv, flags: string[]): GitCommand => async (args, extra = {}) => {
    signal.throwIfAborted();
    try {
      return (await promisify(execFile)('git', ['-c', `core.hooksPath=${devNull}`, '-c', 'core.autocrlf=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'credential.helper=', ...flags, ...args],
        { cwd: directory, env: { ...environment, ...base, ...extra }, signal, timeout: 120_000, maxBuffer: MAX_DIFF + 64 * 1024 })).stdout;
    } catch (error) {
      signal.throwIfAborted();
      // Git errors can contain authorization headers or private source. Never
      // persist/log the raw command exception, stderr or environment.
      if ((error as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('PR comparison exceeds the review size limit; no partial review was started');
      throw new GitFailure(`Could not ${args.find(arg => !arg.startsWith('-') && !arg.includes('=')) ?? 'run git for'} the isolated PR comparison. Check access and retry.`);
    }
  };
  // The cache is addressed only through GIT_DIR, so a damaged cache can never
  // resolve to an enclosing repository. It is never gc'd, pruned or checked out.
  const cached = runner(cache, { GIT_DIR: cache }, ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'transfer.unpackLimit=1']), git = runner(cwd, {}, []);
  const discard = async () => { const aside = `${cache}.discarded-${randomUUID()}`; await rename(cache, aside).catch(() => {}); await rm(aside, { recursive: true, force: true }); };
  let existed = true;
  const prepare = () => locked(`${cache}.lock`, signal, async () => {
    existed = await stat(join(cache, 'objects')).then(() => true, () => false);
    if (!existed) { await rm(cache, { recursive: true, force: true }); await mkdir(cache, { mode: 0o700 }); await cached(['init', '--bare', '--quiet', '--template=']); }
    await fetch(cached, input, signal); signal.throwIfAborted();
    if ((await cached(['rev-parse', '--is-shallow-repository'])).trim() !== 'false') { await discard(); throw new Error('PR history is incomplete; no partial review was started'); }
    for (const commit of new Set([input.baseTipSha, input.headSha])) await cached(['update-ref', `refs/cache/${commit}`, commit]);
    // Only unfinished private capture directories can be replaced on retry.
    await rm(cwd, { recursive: true, force: true }); await mkdir(cwd, { mode: 0o700 });
    await git(['-c', 'protocol.file.allow=always', 'clone', '--quiet', '--local', '--no-checkout', '--no-tags', '--template=', cache, '.']);
    await git(['remote', 'remove', 'origin']);
  });
  const compare = async () => {
    for (const commit of [input.baseTipSha, input.headSha]) if ((await git(['rev-parse', '--verify', `${commit}^{commit}`])).trim() !== commit) throw new Error('Fetched PR revisions did not match the captured comparison');
    if ((await git(['rev-parse', '--is-shallow-repository'])).trim() !== 'false') throw new Error('PR history is incomplete; no partial review was started');
    const bases = (await git(['merge-base', '--all', input.baseTipSha, input.headSha])).trim().split('\n');
    if (bases.length !== 1 || !sha.safeParse(bases[0]).success) throw new Error('PR comparison has no unique merge base');
    const baseSha = bases[0];
    const changedFiles = (await git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', baseSha, input.headSha, '--'])).split('\0').filter(Boolean);
    const diff = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--full-index', baseSha, input.headSha, '--']);
    if (!changedFiles.length || !diff.trim()) throw new Error('This PR has no changes to review');
    if (changedFiles.length > 3000 || Buffer.byteLength(diff) > MAX_DIFF) throw new Error('PR comparison exceeds the review size limit; no partial review was started');
    await git(['checkout', '--quiet', '--detach', '--force', input.headSha]);
    for (const [name, commit] of [['base', input.baseTipSha], ['head', input.headSha]]) await git(['update-ref', `refs/review/${name}`, commit]);
    return { ...input, baseSha, changedFiles, diff, cwd };
  };
  let value: Omit<GitComparison, 'digest'>;
  try { await prepare(); value = await compare(); } catch (error) {
    // Sanitized git failures cannot tell corruption from access or network
    // errors, so an existing cache is discarded only when it fails its own check.
    if (!(error instanceof GitFailure) || !existed) throw error;
    const healthy = await locked(`${cache}.lock`, signal, () => cached(['fsck', '--connectivity-only', '--no-dangling', '--no-progress']).then(() => true, async () => { signal.throwIfAborted(); await discard(); return false; }));
    if (healthy) throw error;
    await prepare(); value = await compare();
  }
  const result = { ...value, digest: digest(value) };
  await writeFile(manifest + '.tmp', JSON.stringify(result), { mode: 0o600 }); await rename(manifest + '.tmp', manifest);
  return result;
}
