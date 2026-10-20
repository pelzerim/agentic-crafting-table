import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentCoordinator } from './agents.ts';
import { WorkspaceControl } from '../core/control.ts';
import { SqliteStore } from './sqlite-store.ts';

const ID = '00000000-0000-4000-8000-000000000042', URL = `https://claude.ai/code/artifact/${ID}`;
async function fixture(agentData: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'craft-agent-artifacts-'));
  const store = new SqliteStore(join(directory, 'workspace.sqlite')), control = new WorkspaceControl(store);
  const processSessionId = randomUUID(), nativeSessionId = randomUUID();
  await control.dispatch({ commandId: 'setup', expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'project.create', id: 'project', title: 'Billing', position: { x: 0, y: 0 } },
    { type: 'item.add', id: 'pr', resourceId: 'pr-r', pluginId: 'github.pull-request', title: 'Plan switcher', projectId: 'project', position: { x: 100, y: 100 }, data: { owner: 'fixture', repo: 'billing', number: 42 } },
    { type: 'item.add', id: 'agent', resourceId: 'agent-r', pluginId: 'agent.session', title: 'Claude', projectId: 'project', position: { x: 400, y: 200 }, data: { provider: 'claude', sessionId: processSessionId, nativeSessionId, ...agentData } },
  ] });
  const coordinator = new AgentCoordinator(directory, {} as any, control, {} as any, { prepare: async () => ({}) } as any, async () => {}, store);
  let at = 0;
  const publish = (artifact: Record<string, unknown>, binding: { processSessionId?: string } = {}) => coordinator.hook({ nodeId: 'agent', processSessionId: binding.processSessionId ?? processSessionId, nativeSessionId, observedAt: ++at, event: 'PostToolUse', toolName: 'Artifact', artifact });
  const artifacts = async () => { const state = await control.read(); return state.nodes.filter(node => state.resources.find(resource => resource.id === node.resourceId)?.pluginId === 'claude.artifact')
    .map(node => ({ node, resource: state.resources.find(resource => resource.id === node.resourceId)!, links: state.links.filter(link => link.targetId === node.id || link.sourceId === node.id) })); };
  return { control, store, processSessionId, publish, artifacts, async close() { store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('a published artifact appears next to its agent, connected to it and to its single connected PR, once', async () => {
  const f = await fixture();
  try {
    const state = await f.control.read();
    await f.control.apply({ type: 'link.save', link: { id: 'pr-agent', sourceId: 'pr', targetId: 'agent', kind: 'context' } }, state.revision);
    await f.publish({ url: URL });
    let [artifact, ...rest] = await f.artifacts();
    assert.equal(rest.length, 0);
    assert.equal(artifact.node.title, 'Claude artifact · 00000000'); assert.equal(artifact.node.projectId, 'project');
    assert.ok(artifact.node.position.y > 200 && Math.abs(artifact.node.position.x - 400) < 200);
    assert.deepEqual(artifact.resource.data, { url: URL, artifactId: ID, sessionId: f.processSessionId, sourcePrId: 'pr' });
    assert.deepEqual(artifact.links.map(link => [link.sourceId, link.targetId, link.kind]).sort(), [['agent', artifact.node.id, 'reference'], ['pr', artifact.node.id, 'reference']]);
    await f.publish({ url: `${URL}?v=2`, title: 'Plan switcher flow' });
    [artifact, ...rest] = await f.artifacts();
    assert.equal(rest.length, 0); assert.equal(artifact.node.title, 'Plan switcher flow'); assert.equal(artifact.links.length, 2);
    const renamed = await f.control.read();
    await f.control.apply({ type: 'node.update', id: artifact.node.id, title: 'My name' }, renamed.revision);
    await f.publish({ url: URL, title: 'Agent rename' });
    assert.equal((await f.artifacts())[0].node.title, 'My name', 'a person’s rename is kept');
  } finally { await f.close(); }
});

test('an architecture run records the PR revision and links the source PR', async () => {
  const f = await fixture({ architecture: { key: 'pr-architecture:x', sourcePrId: 'pr', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) } });
  try {
    await f.publish({ url: URL, title: 'Plan switcher architecture' });
    const [artifact] = await f.artifacts();
    assert.equal(artifact.resource.data.headSha, 'a'.repeat(40)); assert.equal(artifact.resource.data.sourcePrId, 'pr');
    assert.ok(artifact.links.some(link => link.sourceId === 'pr' && link.targetId === artifact.node.id));
    assert.ok(artifact.links.some(link => link.sourceId === 'agent' && link.targetId === artifact.node.id));
  } finally { await f.close(); }
});

test('an artifact already on the map is reused; ambiguous PRs, stale sessions and invalid URLs attach nothing extra', async () => {
  const f = await fixture();
  try {
    let state = await f.control.read();
    await f.control.dispatch({ commandId: 'pasted', expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [
      { type: 'item.add', id: 'pasted', resourceId: 'pasted-r', pluginId: 'claude.artifact', title: 'Pasted earlier', projectId: 'project', position: { x: 900, y: 0 }, data: { url: URL, artifactId: ID } },
      { type: 'item.add', id: 'pr2', resourceId: 'pr2-r', pluginId: 'github.pull-request', title: 'Other', projectId: 'project', position: { x: 100, y: 400 }, data: { owner: 'fixture', repo: 'billing', number: 43 } },
      { type: 'link.save', link: { id: 'l1', sourceId: 'agent', targetId: 'pr', kind: 'reference' } },
      { type: 'link.save', link: { id: 'l2', sourceId: 'agent', targetId: 'pr2', kind: 'reference' } },
    ] });
    await f.publish({ url: URL, title: 'Agent title' });
    const [artifact, ...rest] = await f.artifacts();
    assert.equal(rest.length, 0); assert.equal(artifact.node.id, 'pasted'); assert.equal(artifact.node.title, 'Pasted earlier');
    assert.deepEqual(artifact.links.map(link => [link.sourceId, link.targetId]), [['agent', 'pasted']]);
    state = await f.control.read();
    await f.publish({ url: 'https://claude.ai/artifact/other' }, { processSessionId: randomUUID() });
    await assert.rejects(f.publish({ url: `https://claude.ai.example.com/code/artifact/${ID}` }));
    assert.equal((await f.control.read()).revision, state.revision);
  } finally { await f.close(); }
});

test('an artifact the agent added itself before the publication was seen is reused, not added again', async () => {
  const f = await fixture();
  try {
    const state = await f.control.read();
    await f.control.dispatch({ commandId: 'mine', expectedRevision: state.revision, actor: { kind: 'agent', id: 'agent' }, commands: [
      { type: 'item.add', id: 'artifact-mine', resourceId: 'mine-r', pluginId: 'claude.artifact', title: 'Plan switcher flow', data: { url: `${URL}?v=1`, artifactId: ID }, links: [{ otherId: 'agent', kind: 'reference', newItemIs: 'target' }] }] });
    await f.publish({ url: URL, title: 'Published title' });
    const [artifact, ...rest] = await f.artifacts();
    assert.equal(rest.length, 0); assert.equal(artifact.node.id, 'artifact-mine'); assert.equal(artifact.node.title, 'Plan switcher flow');
    assert.deepEqual(artifact.links.map(link => [link.sourceId, link.targetId]), [['agent', 'artifact-mine']]);
    const again = await f.control.read();
    await f.control.dispatch({ commandId: 'mine-again', expectedRevision: again.revision, actor: { kind: 'agent', id: 'agent' }, commands: [
      { type: 'item.add', id: 'artifact-again', resourceId: 'again-r', pluginId: 'claude.artifact', title: 'Again', data: { url: URL, artifactId: ID }, links: [{ otherId: 'agent', kind: 'reference', newItemIs: 'target' }] }] });
    assert.deepEqual((await f.artifacts()).map(entry => entry.node.id), ['artifact-mine']);
  } finally { await f.close(); }
});
