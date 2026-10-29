import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRecaps, RECAP_BATCH, RECAP_MISSING_RETRY_MS, recapFiles } from './agent-recaps.ts';
import { MemoryStore, WorkspaceControl } from '../core/control.ts';
import type { WorkspaceCommand, CommandEnvelope } from '../core/control.ts';

const recapLine = (timestamp: string, content: string) => JSON.stringify({ type: 'system', subtype: 'away_summary', content: `${content} (disable recaps in /config)`, timestamp }) + '\n';

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'act-agent-recaps-')), projects = join(directory, 'projects', '-tmp-work');
  await mkdir(projects, { recursive: true });
  const control = new WorkspaceControl(new MemoryStore()), files = recapFiles(directory), reads: string[] = [], dispatched: WorkspaceCommand[][] = [];
  const counted = { ...files, read: (file: string) => { reads.push(file); return files.read(file); } };
  const dispatch = control.dispatch.bind(control);
  control.dispatch = (envelope: CommandEnvelope) => { dispatched.push(envelope.commands); return dispatch(envelope); };
  let changed = 0;
  const recaps = new AgentRecaps(control, async () => { changed++; }, () => true, counted);
  const agent = async (id: string, fields: Record<string, unknown> = {}, provider = 'claude') => {
    const nativeSessionId = randomUUID(), state = await control.read();
    await control.apply({ type: 'item.add', id, resourceId: `${id}-r`, pluginId: 'agent.session', title: id, position: { x: state.nodes.length * 400, y: 0 }, data: { provider, sessionId: randomUUID(), nativeSessionId } }, state.revision);
    if (Object.keys(fields).length) await control.apply({ type: 'node.update', id, ...fields } as WorkspaceCommand, (await control.read()).revision);
    return { file: join(projects, `${nativeSessionId}.jsonl`) };
  };
  const node = async (id: string) => (await control.read()).nodes.find(node => node.id === id)!;
  return { directory, control, recaps, agent, node, reads, dispatched, changes: () => changed };
}

test('a recap newer than the turn end is set on the agent; an older one is not and clears a stale one', async () => {
  const { directory, recaps, agent, node, changes } = await setup();
  try {
    const fresh = await agent('fresh', { activity: 'idle', turnEndedAt: '2026-09-30T14:00:00.000Z' });
    await writeFile(fresh.file, recapLine('2026-09-30T14:23:09.455Z', 'The PR is ready for your review.'));
    const stale = await agent('stale', { activity: 'idle', turnEndedAt: '2026-09-30T15:00:00.000Z', recap: { text: 'Old', at: '2026-09-30T14:10:00.000Z' } });
    await writeFile(stale.file, recapLine('2026-09-30T14:10:00.000Z', 'Old'));
    await recaps.tick();
    assert.deepEqual((await node('fresh')).recap, { text: 'The PR is ready for your review.', at: '2026-09-30T14:23:09.455Z' });
    assert.equal((await node('stale')).recap, undefined);
    assert.equal(changes(), 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an unchanged transcript is not read again, and a grown one is', async () => {
  const { directory, recaps, agent, node, reads, dispatched } = await setup();
  try {
    const { file } = await agent('agent', { activity: 'idle', turnEndedAt: '2026-09-30T14:00:00.000Z' });
    await writeFile(file, recapLine('2026-09-30T14:10:00.000Z', 'First recap.'));
    await recaps.tick(); await recaps.tick();
    assert.equal(reads.length, 1); assert.equal(dispatched.length, 1, 'an unchanged recap writes nothing');
    await appendFile(file, recapLine('2026-09-30T14:40:00.000Z', 'Second recap.'));
    await recaps.tick();
    assert.equal(reads.length, 2); assert.equal((await node('agent')).recap?.text, 'Second recap.');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('working, archived and non-Claude agents are skipped', async () => {
  const { directory, control, recaps, agent, node, reads } = await setup();
  try {
    const working = await agent('working', { activity: 'working', turnEndedAt: '2026-09-30T14:00:00.000Z' });
    const archived = await agent('archived', { activity: 'idle', turnEndedAt: '2026-09-30T14:00:00.000Z' });
    const codex = await agent('codex', { activity: 'idle' }, 'codex');
    for (const { file } of [working, archived, codex]) await writeFile(file, recapLine('2026-09-30T14:10:00.000Z', 'A recap.'));
    await control.apply({ type: 'node.archive', id: 'archived' }, (await control.read()).revision);
    await recaps.tick();
    for (const id of ['working', 'archived', 'codex']) assert.equal((await node(id)).recap, undefined, id);
    assert.equal(reads.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('one tick writes at most one batch of capped size; the rest follow on the next tick', async () => {
  const { directory, recaps, agent, control, dispatched } = await setup();
  try {
    for (let index = 0; index < RECAP_BATCH + 5; index++) {
      const { file } = await agent(`agent-${index}`, { activity: 'idle', turnEndedAt: '2026-09-30T14:00:00.000Z' });
      await writeFile(file, recapLine('2026-09-30T14:10:00.000Z', `Recap ${index}.`));
    }
    await recaps.tick();
    assert.deepEqual(dispatched.map(batch => batch.length), [RECAP_BATCH]);
    await recaps.tick();
    assert.deepEqual(dispatched.map(batch => batch.length), [RECAP_BATCH, 5]);
    assert.equal((await control.read()).nodes.filter(node => node.recap).length, RECAP_BATCH + 5);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a transcript that is not found is looked for again only after a while, not on every tick', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'act-agent-recaps-missing-'));
  try {
    const control = new WorkspaceControl(new MemoryStore()), files = recapFiles(directory), finds: string[] = [];
    let now = 0;
    const recaps = new AgentRecaps(control, async () => {}, () => true, { ...files, find: (sessionId: string) => { finds.push(sessionId); return files.find(sessionId); } }, () => now);
    const state = await control.read();
    await control.apply({ type: 'item.add', id: 'agent', resourceId: 'agent-r', pluginId: 'agent.session', title: 'agent', position: { x: 0, y: 0 }, data: { provider: 'claude', sessionId: randomUUID(), nativeSessionId: randomUUID() } }, state.revision);
    await recaps.tick(); await recaps.tick();
    assert.equal(finds.length, 1);
    now += RECAP_MISSING_RETRY_MS;
    await recaps.tick();
    assert.equal(finds.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
