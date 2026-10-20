// Explicit read-only GitHub/Git capture gate, with no model calls or provider writes.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GitHubClient } from '../packages/provider-runtime/github.ts';
import { githubCredentials, githubTransport } from '../packages/provider-runtime/github-transport.ts';
import { captureGitComparison } from '../packages/provider-runtime/git-comparison.ts';
import { fetchGitHubComparison } from '../packages/provider-runtime/github-comparison.ts';
if (process.env.ACT_LIVE_GITHUB !== '1') throw new Error('Set ACT_LIVE_GITHUB=1 for the read-only native comparison check.');
const target = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(process.env.ACT_GITHUB_PR_URL ?? '');
if (!target) throw new Error('Set ACT_GITHUB_PR_URL to a github.com pull request your account can read.');
const directory = await mkdtemp(join(tmpdir(), 'act-live-comparison-')), signal = AbortSignal.timeout(120_000);
try {
  const credentials = githubCredentials(), account = (await credentials.accounts(signal)).find(account => account.active && account.available); assert.ok(account);
  const api = new GitHubClient(githubTransport(account.login, credentials)), identity = { owner: target[1], repo: target[2], number: Number(target[3]) };
  const pr = await api.pull(identity, signal), input = { repository: `${identity.owner}/${identity.repo}`, number: identity.number, baseTipSha: pr.base.sha, headSha: pr.head.sha }, requestId = randomUUID();
  const captured = await captureGitComparison(directory, requestId, input, fetchGitHubComparison(account.login, credentials), signal);
  assert.equal(captured.changedFiles.length, pr.changed_files); assert.ok(captured.diff.length > 0);
  assert.deepEqual(await captureGitComparison(directory, requestId, input, async () => { throw new Error('Replayed capture fetched again'); }, signal), captured);
  console.log(JSON.stringify({ nativeGitComparison: true, changedFiles: captured.changedFiles.length, diffBytes: Buffer.byteLength(captured.diff), replay: true, providerWrites: 0, modelCalls: 0 }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await rm(directory, { recursive: true, force: true }); }
