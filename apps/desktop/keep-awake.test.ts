import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkAwake } from './keep-awake.ts';

test('the work hold is held only while the setting is on and a live board item is working', () => {
  const held = new Set<number>(); let next = 0; const types: string[] = [];
  const awake = createWorkAwake({ start: type => { types.push(type); held.add(++next); return next; }, stop: id => held.delete(id) });
  const AT = '2026-11-10T00:00:00.000Z';
  const working = [{ id: 'a', activity: 'idle' }, { id: 'b', activity: 'working' }], archived = [{ id: 'c', activity: 'working', archivedAt: AT }];
  const archivedProject = [{ id: 'p', archivedAt: AT }, { id: 'd', projectId: 'p', activity: 'working' }];
  awake.nodes(working); assert.equal(held.size, 0, 'setting off does not hold');
  awake.setting(true); assert.equal(held.size, 1); assert.deepEqual(types, ['prevent-app-suspension']);
  awake.nodes(working); assert.equal(next, 1, 'starts once while still needed');
  awake.nodes(archived); assert.equal(held.size, 0, 'an archived working item does not hold');
  awake.nodes(archivedProject); assert.equal(held.size, 0, 'a working item in an archived project does not hold');
  awake.nodes([{ id: 'e', activity: 'working', rework: { note: 'Fix F1', since: AT } }]); assert.equal(held.size, 0, 'a rework note left on an item does not hold');
  awake.nodes(working); assert.equal(held.size, 1);
  awake.nodes([{ id: 'a', activity: 'idle' }, { id: 'b', activity: 'complete' }]); assert.equal(held.size, 0, 'an idle board does not hold');
  awake.nodes([{ id: 'a', activity: 'idle' }], 1); assert.equal(held.size, 1, 'a working item below the map holds');
  awake.nodes(working); awake.disconnected(); assert.equal(held.size, 0, 'a lost workspace connection releases the hold');
  awake.nodes(working); assert.equal(held.size, 1, 'the next snapshot restores it');
  awake.release(); assert.equal(held.size, 0);
});
