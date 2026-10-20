// Opt-in paid/native gate. Two small local synthetic reviews; no GitHub writes,
// private code, existing workspace data, or user working-tree changes.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import electron from 'electron';
import { startWorkspaceService } from '../packages/workspace-service/server.ts';
import { connectWorkspace } from '../packages/workspace-service/client.ts';
import { connectSupervisor } from '../packages/session-runtime/client.ts';
import { captureGitComparison } from '../packages/provider-runtime/git-comparison.ts';
if (process.env.ACT_LIVE_REVIEWS !== '1') throw new Error('Set ACT_LIVE_REVIEWS=1 to run bounded real native reviews; this may consume provider usage.');
const directory = await mkdtemp(join(tmpdir(), 'act-live-reviews-')), repository = join(directory, 'source'); await mkdir(repository);
const git = (...args) => execFileSync('git', ['-c', 'user.name=Local fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: repository, encoding: 'utf8' }).trim();
let service, client, supervisor;
try {
  git('init', '-q'); await writeFile(join(repository, 'arithmetic.js'), 'export function divide(a, b) { return a / b; }\n'); git('add', '.'); git('commit', '-qm', 'base'); const baseTipSha = git('rev-parse', 'HEAD');
  await writeFile(join(repository, 'arithmetic.js'), 'export function divide(a, b) { return a + b; }\n'); git('add', '.'); git('commit', '-qm', 'change'); const headSha = git('rev-parse', 'HEAD');
  const source = { async freeze() { return { comparison: { repository: 'local/synthetic', number: 1, baseTipSha, headSha }, title: 'Synthetic arithmetic refactor', description: 'Intended behavior: divide(a,b) returns a divided by b. Preserve behavior.', url: 'https://example.invalid/local-review' }; },
    capture: (directory, id, source, signal) => captureGitComparison(directory, id, source.comparison, async run => { await run(['-c', 'protocol.file.allow=always', 'fetch', '--quiet', repository, baseTipSha, headSha]); }, signal) };
  service = await startWorkspaceService(directory, undefined, { directory: join(directory, 'runtime'), executable: electron, entrypoint: resolve('dist/session-supervisor.cjs'), electronRuntime: true }, { assignments: [], reviews: { 'github.pull-request': source } });
  await service.control.dispatch({ commandId: 'fixture', expectedRevision: 0, actor: { kind: 'user', id: 'live-gate' }, commands: [{ type: 'item.add', id: 'pr', resourceId: 'pr-resource', pluginId: 'github.pull-request', title: 'Local synthetic review', data: { owner: 'local', repo: 'synthetic', number: 1 }, position: { x: 0, y: 0 } }] });
  client = await connectWorkspace(directory);
  for (const provider of ['codex', 'claude']) {
    const requestId = randomUUID(), started = Date.now();
    await client.call('runtime.run', { action: `pr.review.${provider}`, nodeId: 'pr', arguments: { requestId } });
    let session;
    while (Date.now() - started < 120_000) {
      const [status] = await client.call('runtime.run', { action: 'pr.review.status', nodeId: 'pr', arguments: { requestId } });
      if (status.state === 'failed') throw new Error(`${provider} preparation failed: ${status.error}`);
      if (status.sessionId) {
        supervisor ??= await connectSupervisor(join(directory, 'runtime'));
        session = await supervisor.call('sessions.read', { sessionId: status.sessionId });
        if (!['starting', 'running'].includes(session.session.state)) break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (session && ['starting', 'running'].includes(session.session.state)) await supervisor.call('sessions.stop', { sessionId: session.session.id });
    assert.equal(session?.session.state, 'exited', `${provider} did not finish within the two-minute live gate`);
    const output = session.chunks.map(chunk => chunk.data).join('');
    assert.equal(session.session.exitCode, 0, `${provider} failed: ${output.slice(-2000)}`);
    assert.match(output, /arithmetic|divide/i); assert.equal(session.session.readOnly, true);
    assert.equal(git('status', '--porcelain'), '');
    const item = (await service.control.read()).resources.find(resource => resource.data.sessionId === session.session.id);
    assert.equal(item.pluginId, 'code.review'); assert.equal(item.data.headSha, headSha);
    console.log(JSON.stringify({ provider, model: item.data.model, nativeReview: true, elapsedMs: Date.now() - started, exitCode: session.session.exitCode, preservedSource: true, providerWrites: 0 }));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  client?.close(); await service?.close();
  supervisor ??= await connectSupervisor(join(directory, 'runtime')).catch(() => undefined);
  if (supervisor) { await supervisor.call('admin.shutdown').catch(() => {}); supervisor.close(); await new Promise(resolve => setTimeout(resolve, 300)); }
  await rm(directory, { recursive: true, force: true });
}
