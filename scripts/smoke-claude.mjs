// Explicitly enabled provider check. Never imported by ordinary tests or CI.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import electronPath from 'electron';
import { _electron as electron } from '@playwright/test';
import { startWorkspaceService } from '../packages/workspace-service/server.ts';
import { SessionCoordinator } from '../packages/workspace-service/sessions.ts';
import { prepareClaude, probeClaude } from '../packages/session-runtime/claude.ts';
import { connectSupervisor } from '../packages/session-runtime/client.ts';

if (process.env.ACT_LIVE_CLAUDE !== '1') throw new Error('Set ACT_LIVE_CLAUDE=1 to enable two bounded model calls using your installed Claude account.');
const directory = await mkdtemp(join(tmpdir(), 'craft-live-claude-')), repo = join(directory, 'repo');
await mkdir(repo); await mkdir('test-results', { recursive: true });
const runtime = { directory: join(directory, 'runtime'), executable: electronPath, entrypoint: resolve('dist/session-supervisor.cjs'), electronRuntime: true };
const service = await startWorkspaceService(directory, undefined, runtime);
const sessions = new SessionCoordinator(service.store, service.control, runtime, async () => {});
let app;
const report = { version: '', printCalls: [], interactive: false };
const allowed = ['workspace_read', 'workspace_plugins', 'workspace_apply', 'workspace_run'].map(tool => `mcp__crafting_table__${tool}`).join(',');
const printFlags = ['--print', '--output-format', 'json', '--max-budget-usd', '0.75', '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--allowedTools', allowed];
async function until(read, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out waiting for native Claude');
}
async function print(plan, prompt) {
  plan.launch.args = [...printFlags, ...plan.launch.args, ...(prompt ? ['--', prompt] : [])];
  await sessions.launchPrepared(plan);
  const finished = await until(async () => { const snapshot = await sessions.runtime.call('sessions.read', { sessionId: plan.requestId }); return snapshot.session.state === 'exited' && snapshot; });
  const output = finished.chunks.map(chunk => chunk.data).join('');
  const lines = output.split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return undefined; } });
  const result = lines.find(line => line?.type === 'result');
  if (!result) throw new Error(`Claude returned no JSON result (exit ${finished.session.exitCode})`);
  report.printCalls.push({ subtype: result.subtype, sessionId: result.session_id, costUSD: result.total_cost_usd });
  assert.equal(result.is_error, false, `Claude result: ${result.subtype}`);
  assert.equal(finished.session.exitCode, 0);
  return result;
}
try {
  const capability = await probeClaude(); report.version = capability.version;
  console.log(`Live native check: ${capability.version}; two print calls capped at $0.75 each.`);
  await service.control.apply({ type: 'project.create', id: 'live-project', title: 'Disposable Claude check', summary: 'A local integration test. The project color is amber.', position: { x: 0, y: 0 } }, 0);
  const nonce = `MAPLE-${randomUUID().slice(0, 8)}`, nodeId = randomUUID();
  const request = { requestId: randomUUID(), nodeId, resourceId: randomUUID(), expectedRevision: 1, pluginId: 'agent.session', title: 'Live Claude check', projectId: 'live-project', position: { x: 340, y: 0 }, data: { provider: 'claude', model: 'haiku', cwd: repo,
    task: `This is a bounded local integration test. Remember this code for our next turn: ${nonce}. Use only crafting_table MCP tools. Do not contact GitHub or run commands. Read this table and acknowledge current context. Add a github.pull-request map item with id live-fixture-pr, resourceId live-fixture-resource, owner fixture, repo local-only, number 482, title Live smoke PR, in this project at x=660,y=100. It represents a fixture URL, not a real PR. Connect it to your own agent node with one reference link. Reply READY with the remembered code and the project color from the brief. Then stop.` } };
  const plan = prepareClaude({ request, state: await service.control.read(), directory, runtime, capability });
  const first = await print(plan);
  assert.ok(first.result.includes(nonce)); assert.match(first.result, /amber/i);
  const state = await service.control.read();
  const pr = state.nodes.find(node => node.id === 'live-fixture-pr');
  assert.equal(pr?.projectId, 'live-project');
  assert.ok(state.links.some(link => [link.sourceId, link.targetId].includes(nodeId) && [link.sourceId, link.targetId].includes(pr.id)));
  assert.ok(service.store.listJobs().some(job => job.input.action === 'agent.context' && job.state === 'succeeded'));
  const resume = prepareClaude({ request: { ...request, requestId: randomUUID(), expectedRevision: state.revision, data: {} }, state, directory, runtime, capability, resumeNodeId: nodeId });
  const second = await print(resume, 'Without reading files or making changes, reply with the remembered code from our previous turn. Then stop.');
  assert.ok(second.result.includes(nonce)); assert.equal(second.session_id, first.session_id);
  await writeFile('test-results/live-claude-report.json', JSON.stringify(report, null, 2));
  console.log('Real MCP registration, context acknowledgement and ended-conversation resume passed.');
  app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  const page = await app.firstWindow();
  await page.getByRole('article', { name: 'Live Claude check' }).click();
  await page.getByRole('button', { name: 'Resume / reconnect' }).click();
  const interactive = await until(async () => { const state = await service.control.read(); const saved = state.resources.find(resource => resource.id === request.resourceId); return saved.data.sessionId !== resume.requestId && saved; });
  const native = await until(async () => {
    const snapshot = await sessions.runtime.call('sessions.read', { sessionId: interactive.data.sessionId });
    const output = snapshot.chunks.map(chunk => chunk.data).join('');
    return /Accessing[\s\S]*workspace|Claude[\s\S]*Code|Welcome[\s\S]*back/.test(output) && snapshot;
  }, 30_000);
  assert.equal(native.session.state, 'running');
  await page.screenshot({ path: 'test-results/live-claude.png' });
  report.interactive = true;
  report.hooksObserved = Boolean((await service.control.read()).resources.find(resource => resource.id === request.resourceId).data.nativeStartedAt);
  await writeFile('test-results/live-claude-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await app?.close(); await sessions.close(); await service.close();
  const client = await connectSupervisor(runtime.directory).catch(() => undefined);
  if (client) { const stopped = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await stopped; client.close(); }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(error => { console.error(`Temporary data cleanup: ${error.code}`); });
}
