import test from 'node:test';
import assert from 'node:assert/strict';
import { VIEW_BOUNDS_LIMIT, mergeViewBounds, patchItemViewState, sameViewBounds, splitViewBounds } from './item-view-bounds.ts';
import { viewSchema } from '../../../packages/core/control.ts';

test('saved bounds split into places and sizes; a half-saved pair is ignored', () => {
  assert.deepEqual(splitViewBounds({ a: { x: 10, y: 20, width: 700, height: 500 }, b: { x: 5, y: 6 }, c: { width: 300, height: 200 }, d: { x: 1 }, e: { height: 9 } }),
    { positions: { a: { x: 10, y: 20 }, b: { x: 5, y: 6 } }, sizes: { a: { width: 700, height: 500 }, c: { width: 300, height: 200 } } });
  assert.deepEqual(splitViewBounds(undefined), { positions: {}, sizes: {} });
});

test('saving replaces the shown items, keeps other layers and drops items that are gone', () => {
  const saved = { a: { x: 1, y: 1, width: 400, height: 300 }, below: { width: 500, height: 400 }, gone: { x: 9, y: 9 } };
  assert.deepEqual(mergeViewBounds(saved, new Set(['a', 'b']), new Set(['a', 'b', 'below']), { b: { x: 3, y: 4 } }, { b: { width: 600, height: 450 } }),
    { below: { width: 500, height: 400 }, b: { x: 3, y: 4, width: 600, height: 450 } }, 'a was reset on this canvas, so its entry goes');
  assert.ok(sameViewBounds(mergeViewBounds(undefined, new Set(), new Set(), {}, {}), undefined));
  assert.ok(!sameViewBounds({ a: { x: 1, y: 2 } }, { a: { x: 1, y: 3 } }));
});

test('the saved list is bounded and the view schema accepts it', () => {
  const ids = Array.from({ length: VIEW_BOUNDS_LIMIT + 5 }, (_, index) => `n${index}`), sizes = Object.fromEntries(ids.map(id => [id, { width: 400, height: 300 }]));
  const merged = mergeViewBounds(undefined, new Set(ids), new Set(ids), {}, sizes);
  assert.equal(Object.keys(merged).length, VIEW_BOUNDS_LIMIT); assert.ok(merged[ids.at(-1)!]);
  assert.deepEqual(viewSchema.parse({ itemViewBounds: { a: { x: -20.5, y: 3, width: 640, height: 480 } } }).itemViewBounds, { a: { x: -20.5, y: 3, width: 640, height: 480 } });
  assert.equal(viewSchema.parse({}).itemViewBounds, undefined);
});

test('an item view saves its own state beside the bounds: null removes a key, gone items are dropped, the schema bounds it', () => {
  const saved = { a: { jobsRail: 'folded' }, gone: { jobsRail: 'folded' }, b: { tab: 'files' } }, existing = new Set(['a', 'b']);
  assert.deepEqual(patchItemViewState(saved, 'b', { wrap: true }, existing), { a: { jobsRail: 'folded' }, b: { tab: 'files', wrap: true } });
  assert.deepEqual(patchItemViewState(saved, 'a', { jobsRail: null }, existing), { b: { tab: 'files' } }, 'an emptied item goes');
  assert.deepEqual(patchItemViewState(undefined, 'gone', { jobsRail: 'folded' }, existing), {}, 'an item that no longer exists saves nothing');
  assert.deepEqual(viewSchema.parse({ itemViewState: { a: { jobsRail: 'folded', wrap: true, width: 3 } } }).itemViewState, { a: { jobsRail: 'folded', wrap: true, width: 3 } });
  assert.throws(() => viewSchema.parse({ itemViewState: { a: { jobsRail: { nested: true } } } }));
  assert.throws(() => viewSchema.parse({ itemViewState: { a: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`k${index}`, true])) } }));
});
