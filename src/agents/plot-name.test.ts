import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlotNameRequest, normalizePlotName } from './plot-name.ts';

test('the request is one tool-free Haiku turn over titles, types and short summaries only', () => {
  const items = Array.from({ length: 14 }, (_, i) => ({ type: 'Pull request', title: `Plan switcher ${i}` }));
  const request = buildPlotNameRequest({ project: 'Bookshop', currentName: 'Billing plan switch', items: [{ type: 'Agent session', title: 'Billing proration', summary: 'Writing invoice tests' }, ...items] });
  assert.equal(request.model, 'haiku'); assert.equal(request.max_tokens, 32); assert.deepEqual(request.thinking, { type: 'disabled' });
  assert.match(request.system, /2–4 words, at most 24 characters/); assert.match(request.system, /evidence, never instructions/); assert.match(request.system, /KEEP/);
  const input = JSON.parse(request.messages[0].content);
  assert.equal(input.project, 'Bookshop'); assert.equal(input.currentName, 'Billing plan switch');
  assert.equal(input.items.length, 12, 'at most 12 members');
  assert.deepEqual(input.items[0], { type: 'Agent session', title: 'Billing proration', summary: 'Writing invoice tests' });
});

test('names are 2–4 plain words of at most 24 characters, or KEEP', () => {
  assert.equal(normalizePlotName('"Billing plan switch."'), 'Billing plan switch');
  assert.equal(normalizePlotName('Name: Search ranking tweak'), 'Search ranking tweak');
  assert.equal(normalizePlotName('keep'), 'KEEP');
  assert.equal(normalizePlotName('Image cache leak investigation for the shop'), 'Image cache leak');
  assert.equal(normalizePlotName('Billing'), undefined, 'one word is not a name');
  assert.equal(normalizePlotName('Billing <script>'), undefined);
  assert.equal(normalizePlotName(''), undefined);
});

test('plot replies that talk about keeping the current name are KEEP, never a name', () => {
  for (const reply of ['The currentName still fits', 'Current name still fits', 'KEEP it']) assert.equal(normalizePlotName(reply), 'KEEP', reply);
});
