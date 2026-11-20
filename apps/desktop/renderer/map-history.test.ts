import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapHistory } from './map-history.ts';
import type { UndoStep } from '../../../packages/core/map-undo.ts';

const snap = (x: number) => ({ position: { x, y: 0 }, projectId: 'acme', archived: false });

test('a step is the commit receipt, and an undo files the step it undid while a new change lands', async () => {
  const sent: UndoStep[] = [];
  let finish!: (value: { applied?: UndoStep; reverted: number; skipped: number }) => void;
  const history = createMapHistory(() => ({ active: () => true, notify() {}, fail(message) { throw new Error(message); }, refresh: async () => {},
    revert: async step => { sent.push(step); return new Promise(resolve => { finish = resolve; }); } }));
  const move = { items: [{ id: 'a', before: snap(0), after: snap(300) }], links: [], plots: [] };
  await history.track('Move', async () => ({ receipt: move }));
  const undoing = history.undo();
  await history.track('Drag', async () => ({ receipt: { items: [{ id: 'b', before: snap(0), after: snap(50) }], links: [], plots: [] } }));
  assert.deepEqual(sent, [{ label: 'Move', ...move }], 'only what the commit returned, never another write on the map');
  finish({ applied: sent[0], reverted: 1, skipped: 0 });
  await undoing;
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
