import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapHistory } from './map-history.ts';
import type { UndoStep } from '../../../packages/core/map-undo.ts';

const snap = (x: number) => ({ position: { x, y: 0 }, projectId: 'acme', archived: false });

test('a step is the commit receipt, and an undo files the step it undid while a new change lands', async () => {
  const sent: UndoStep[] = [], notices: string[] = [];
  let finish!: (value: { applied?: UndoStep; reverted: number; skipped: number }) => void;
  const history = createMapHistory(() => ({ active: () => true, notify(text) { notices.push(text); }, fail(message) { throw new Error(message); }, refresh: async () => {},
    revert: async step => { sent.push(step); return new Promise(resolve => { finish = resolve; }); } }));
  const move = { items: [{ id: 'a', before: snap(0), after: snap(300) }], links: [], plots: [] };
  await history.track('Move', async () => ({ receipt: move }));
  const undoing = history.undo();
  await history.track('Drag', async () => ({ receipt: { items: [{ id: 'b', before: snap(0), after: snap(50) }], links: [], plots: [] } }));
  assert.deepEqual(sent, [{ label: 'Move', ...move }], 'only what the commit returned, never another write on the map');
  finish({ applied: sent[0], reverted: 1, skipped: 0 });
  await undoing;
  const redoing = history.redo();
  assert.deepEqual([sent.length, notices.at(-1)], [1, 'Nothing to redo'], 'the drag made during the undo cleared redo, and the undo never refills it');
  await redoing;
  void history.undo();
  assert.equal(sent[1].label, 'Drag', 'the drag stays undoable');
  finish({ reverted: 1, skipped: 0 });
});

test('a step whose undo fails twice is dropped, so older steps stay reachable', async () => {
  const sent: string[] = [], failed: string[] = [];
  const history = createMapHistory(() => ({ active: () => true, notify() {}, fail(message) { failed.push(message); },
    revert: async step => { sent.push(step.label); if (step.label === 'Archive') throw new Error('Restore the project first'); return { applied: step, reverted: 1, skipped: 0 }; }, refresh: async () => {} }));
  await history.track('Move', async () => ({ receipt: { items: [{ id: 'a', before: snap(0), after: snap(300) }], links: [], plots: [] } }));
  await history.track('Archive', async () => ({ receipt: { items: [{ id: 'a', before: snap(300), after: { ...snap(300), archived: true } }], links: [], plots: [] } }));
  await history.undo();
  await history.undo();
  await history.undo();
  assert.deepEqual([sent, failed], [['Archive', 'Archive', 'Move'], ['Restore the project first', 'Restore the project first']]);
});

test('an undo whose request fails keeps its step', async () => {
  const sent: string[] = [], failed: string[] = [];
  let down = true;
  const history = createMapHistory(() => ({ active: () => true, notify() {}, fail(message) { failed.push(message); }, refresh: async () => {},
    revert: async step => { sent.push(step.label); if (down) throw new Error('Connection lost'); return { applied: step, reverted: 1, skipped: 0 }; } }));
  await history.track('Move', async () => ({ receipt: { items: [{ id: 'a', before: snap(0), after: snap(300) }], links: [], plots: [] } }));
  await history.undo();
  down = false;
  await history.undo();
  assert.deepEqual([sent, failed], [['Move', 'Move'], ['Connection lost']]);
});

test('an undo that landed is filed for redo even when reading the map back fails', async () => {
  const sent: string[] = [], failed: string[] = [];
  const history = createMapHistory(() => ({ active: () => true, notify() {}, fail(message) { failed.push(message); }, refresh: async () => { throw new Error('Read failed'); },
    revert: async (step, direction) => { sent.push(`${direction}:${step.label}`); return { applied: step, reverted: 1, skipped: 0 }; } }));
  await history.track('Move', async () => ({ receipt: { items: [{ id: 'a', before: snap(0), after: snap(300) }], links: [], plots: [] } }));
  await history.undo();
  await history.redo();
  assert.deepEqual([sent, failed], [['undo:Move', 'redo:Move'], ['Read failed', 'Read failed']]);
});

test('an Undo button reverses its own change after keyboard undo and redo replaced its step, and the other steps stay in order', async () => {
  const sent: string[] = [];
  // Like the service, each reversal answers with a new copy of what it put back.
  const history = createMapHistory(() => ({ active: () => true, notify() {}, fail(message) { throw new Error(message); }, refresh: async () => {},
    revert: async (step, direction) => { sent.push(`${direction}:${step.label}`); return { applied: structuredClone(step), reverted: 1, skipped: 0 }; } }));
  const step = (label: string, id: string) => history.trackStep(label, async () => ({ receipt: { items: [{ id, before: snap(0), after: snap(300) }], links: [], plots: [] } }));
  await step('Move', 'a');
  const archived = await step('Archive', 'n');
  await history.undo();
  await history.redo();
  await step('Drag', 'b');
  await history.undo(archived);
  await history.undo(archived);
  for (let i = 0; i < 2; i++) await history.undo();
  for (let i = 0; i < 3; i++) await history.redo();
  assert.deepEqual(sent, ['undo:Archive', 'redo:Archive', 'undo:Archive', 'undo:Drag', 'undo:Move', 'redo:Move', 'redo:Drag', 'redo:Archive']);
});
