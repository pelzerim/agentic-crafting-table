import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, WorkspaceControl } from './control.ts';
import type { CommandEnvelope } from './control.ts';

const agent = { kind: 'agent' as const, id: 'claude' }, user = { kind: 'user' as const, id: 'desktop' };
async function setup() {
  const control = new WorkspaceControl(new MemoryStore());
  let revision = 0, count = 0;
  const run = async (actor: CommandEnvelope['actor'], commands: CommandEnvelope['commands']) => {
    const { state } = await control.dispatch({ commandId: `c${count++}`, expectedRevision: revision, actor, commands }); revision = state.revision; return state;
  };
  await run(user, [{ type: 'item.add', id: 'claude', resourceId: 'claude-r', pluginId: 'agent.session', title: 'Claude', data: { sessionId: 'fixture', provider: 'claude' }, position: { x: 0, y: 0 } }]);
  return run;
}
const writer = (state: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>>>) => state.resources.find(resource => resource.id === 'note-r')!.data.writer as { kind: string; name: string; at: string } | undefined;

test('a note records the agent that last wrote its text, and only the host can set it', async () => {
  const run = await setup();
  let state = await run(agent, [{ type: 'item.add', id: 'note', resourceId: 'note-r', pluginId: 'workspace.note', data: { text: 'Annual plan notes', writer: { kind: 'agent', name: 'Forged', at: '2020-01-01T00:00:00.000Z' } }, position: { x: 400, y: 0 } }]);
  assert.equal(writer(state)?.kind, 'agent'); assert.equal(writer(state)?.name, 'Claude');
  assert.ok(Date.parse(writer(state)!.at) > Date.parse('2026-01-01'));
  const stamped = writer(state);
  state = await run(user, [{ type: 'item.update', id: 'note', data: { ...state.resources.find(resource => resource.id === 'note-r')!.data, paper: 'peach' } }]);
  assert.deepEqual(writer(state), stamped, 'a paper change keeps the byline');
  state = await run(user, [{ type: 'item.update', id: 'note', data: { text: 'Edited by me', paper: 'peach', writer: stamped! } }]);
  assert.equal(writer(state), undefined, 'a person rewriting the text removes the byline');
  state = await run({ kind: 'agent', id: 'mcp-client' }, [{ type: 'item.update', id: 'note', data: { text: 'Agent again' } }]);
  assert.equal(writer(state)?.name, 'Agent');
  state = await run(user, [{ type: 'item.add', id: 'mine', resourceId: 'mine-r', pluginId: 'workspace.note', data: { text: 'Mine', writer: 'Claude' }, position: { x: 800, y: 0 } }]);
  assert.equal(state.resources.find(resource => resource.id === 'mine-r')!.data.writer, undefined);
});
