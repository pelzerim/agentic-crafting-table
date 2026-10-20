import test from 'node:test';
import assert from 'node:assert/strict';
import { RAIL_DWELL_MS, RailDwell, RailState } from './rail-state.ts';

test('one rail sheet at a time: pinning is exclusive, peeks cover a pinned tool and hand it back, Undermap clears all', () => {
  const rail = new RailState(), seen: unknown[] = [];
  rail.subscribe(() => seen.push({ ...rail.snapshot() }));
  rail.pin('todos'); assert.deepEqual(rail.snapshot(), { open: 'todos', pinned: 'todos' });
  rail.pin('inbox'); assert.deepEqual(rail.snapshot(), { open: 'inbox', pinned: 'inbox' }, 'pinning one unpins the other');
  rail.open('todos'); assert.equal(rail.snapshot().open, 'todos'); assert.equal(rail.snapshot().pinned, 'inbox');
  rail.close('todos'); assert.deepEqual(rail.snapshot(), { open: 'inbox', pinned: 'inbox' }, 'the peek ends and the pinned tool returns');
  rail.close('inbox'); assert.deepEqual(rail.snapshot(), { pinned: 'inbox' }, 'a pinned tool can be closed and stays pinned');
  rail.open('todos'); rail.close('todos'); assert.equal(rail.snapshot().open, undefined, 'a closed pinned tool does not reopen after a peek');
  rail.pin('todos'); rail.unpin('todos'); assert.deepEqual(rail.snapshot(), { open: 'todos' }, 'unpinning leaves it open until the pointer leaves');
  rail.unpin('inbox'); rail.close('inbox'); assert.deepEqual(rail.snapshot(), { open: 'todos' }, 'other tools cannot close or unpin it');
  rail.pin('inbox'); rail.clear(); assert.deepEqual(rail.snapshot(), {});
  const count = seen.length; rail.clear(); assert.equal(seen.length, count, 'no change, no notification');
});

test('a rail slot opens on hover only after the pointer rests on it, never while it passes along the rail', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let opened = 0;
  const dwell = new RailDwell(() => { opened++; });
  dwell.enter(10, 10); t.mock.timers.tick(100); dwell.move(10, 40); t.mock.timers.tick(200); dwell.leave();
  t.mock.timers.tick(1000); assert.equal(opened, 0, 'crossing the slot does not open it');
  dwell.enter(10, 10); dwell.move(11, 11); t.mock.timers.tick(RAIL_DWELL_MS - 1); assert.equal(opened, 0, 'a small tremor keeps the dwell running');
  t.mock.timers.tick(1); assert.equal(opened, 1);
  dwell.move(10, 60); t.mock.timers.tick(1000); assert.equal(opened, 1, 'one open per visit');
  dwell.leave(); dwell.enter(10, 10); dwell.click(); t.mock.timers.tick(1000); assert.equal(opened, 1, 'a click decides for this visit');
  dwell.leave(); dwell.enter(10, 10); dwell.dispose(); t.mock.timers.tick(1000); assert.equal(opened, 1);
});
