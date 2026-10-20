// Explicit read-only native authentication/API gate; ordinary CI uses HTTP fixtures.
import assert from 'node:assert/strict';
import { GitHubClient } from '../packages/provider-runtime/github.ts';
import { githubCredentials, githubTransport } from '../packages/provider-runtime/github-transport.ts';
if (process.env.ACT_LIVE_GITHUB !== '1') throw new Error('Set ACT_LIVE_GITHUB=1 to read a real PR using GitHub CLI credentials.');
if (!process.env.ACT_GITHUB_PR_URL) throw new Error('Set ACT_GITHUB_PR_URL to a github.com pull request your account can read.');
const url = new URL(process.env.ACT_GITHUB_PR_URL);
const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
assert.ok(url.origin === 'https://github.com' && !url.username && !url.password && match, 'Expected a github.com pull request URL');
const identity = { owner: match[1], repo: match[2], number: Number(match[3]) }, signal = AbortSignal.timeout(30_000);
try {
  const credentials = githubCredentials(), accounts = await credentials.accounts(signal), account = accounts.find(account => account.active && account.available);
  assert.ok(account, 'No active GitHub account');
  const client = new GitHubClient(githubTransport(account.login, credentials));
  const viewer = await client.viewer(signal); assert.equal(viewer.login.toLowerCase(), account.login.toLowerCase());
  const pr = await client.pull(identity, signal);
  const [files, comments, reviews] = await Promise.all([client.files(identity, signal), client.comments(identity, signal), client.reviews(identity, signal)]);
  const current = await client.pull(identity, signal); assert.equal(current.head.sha, pr.head.sha, 'PR changed during the read; rerun');
  assert.equal(files.length, pr.changed_files, 'GitHub did not return every changed file');
  console.log(JSON.stringify({ url: url.href, title: pr.title, state: pr.state, files: files.length, comments: comments.length, reviews: reviews.length, comparisonStable: true, credentialSource: account.credentialSource }));
} catch (error) { console.error(error.message); process.exitCode = 1; }

// Exercise the same service, URL import and persisted content used by UI/MCP.
if (!process.exitCode) {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const { startWorkspaceService } = await import('../packages/workspace-service/server.ts');
  const { connectWorkspace } = await import('../packages/workspace-service/client.ts');
  const directory = await mkdtemp(join(tmpdir(), 'act-live-github-'));
  let service, client;
  try {
    service = await startWorkspaceService(directory, undefined, undefined, { assignments: [] }); client = await connectWorkspace(directory);
    const accounts = await client.call('connections.accounts', { providerId: 'github' });
    const account = accounts.find(account => account.active && account.available); assert.ok(account);
    const settings = await client.call('settings.read');
    await client.call('settings.write', { expectedRevision: settings.revision, value: { ...settings.value, connections: [{ id: 'live-read', providerId: 'github', account: account.id, enabled: true, isDefault: true }] } });
    const nodeId = randomUUID(), resourceId = randomUUID();
    await client.call('apply', { commandId: randomUUID(), expectedRevision: 0, actor: { kind: 'agent', id: 'capability-gate' }, commands: [{ type: 'item.add', id: nodeId, resourceId, pluginId: 'github.pull-request', title: 'Registered before lookup', data: identity, position: { x: 0, y: 0 } }] });
    const request = { requestId: randomUUID(), nodeId: randomUUID(), resourceId: randomUUID(), expectedRevision: 1, title: 'URL lookup', pluginId: 'github.pull-request', data: { url: url.href }, position: { x: 100, y: 100 } };
    const attached = await client.call('item.create', request); assert.equal(attached.nodeId, nodeId); assert.equal(attached.resourceId, resourceId);
    const snapshot = await client.call('runtime.run', { action: 'resource.read', nodeId });
    assert.ok(snapshot.title); const pull = snapshot.detail.pull;
    const files = await client.call('runtime.run', { action: 'resource.content', nodeId, arguments: { actionId: 'files', input: { head: pull.head.sha, base: pull.base.sha } } });
    assert.equal(files.content.files.length, pull.changed_files);
    client.close(); await service.close(); service = await startWorkspaceService(directory, undefined, undefined, { assignments: [] }); client = await connectWorkspace(directory);
    const reopened = await client.call('runtime.run', { action: 'resource.read', nodeId }); assert.deepEqual(reopened, snapshot);
    assert.deepEqual(await client.call('item.create', request), attached);
    const saved = await client.call('read'); assert.equal(saved.state.nodes.length, 1); assert.equal(saved.state.resources.length, 1);
    console.log(JSON.stringify({ serviceUrlImport: true, existingAgentItemReused: true, persistentContent: true, replayWithoutDuplicates: true, files: files.content.files.length, title: snapshot.title }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { client?.close(); await service?.close(); await rm(directory, { recursive: true, force: true }); }
}
