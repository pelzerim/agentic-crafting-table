import test from 'node:test';
import assert from 'node:assert/strict';
import { splitReference } from './reference.ts';
import { plotFallbackName } from './plots.ts';

test('a title that leads with a ticket reference splits into the reference and the rest', () => {
  assert.deepEqual(splitReference('BIL-128 · Plan changes'), { reference: 'BIL-128', rest: 'Plan changes' });
  assert.deepEqual(splitReference('APP2-7 · Split · the importer'), { reference: 'APP2-7', rest: 'Split · the importer' });
  assert.deepEqual(splitReference('  ENG-1 ·  Trim me  '), { reference: 'ENG-1', rest: 'Trim me' });
});

test('titles without a leading reference, or with nothing after it, stay whole', () => {
  for (const title of ['Plan changes', 'BIL-128', 'BIL-128 · ', 'BIL-128 Plan changes', 'bil-128 · Plan changes', 'Fix BIL-128 · Plan changes', '#48 · Plan switcher', 'A-1 · Too short a key', ''])
    assert.equal(splitReference(title), undefined, title);
});

test('plot names read the same ticket references', () => {
  assert.equal(plotFallbackName(['BIL-128 · Plan changes', 'BIL-128 follow-up']), 'BIL-128 · 2 items');
});
