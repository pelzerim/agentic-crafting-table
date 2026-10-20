import test from 'node:test';
import assert from 'node:assert/strict';
import { blockMarkdown, blockTree, savedBlocks } from './items/notion-page/blocks.ts';

const block = (type: string, text: string, extra: Record<string, unknown> = {}) => ({ type, text, depth: 0, ...extra });

test('Notion blocks map onto the shared Markdown vocabulary', () => {
  assert.equal(blockMarkdown(block('to_do', '[x] Keep the current cycle', { markdown: 'Keep the **current** cycle', checked: true })), '- [x] Keep the **current** cycle');
  assert.equal(blockMarkdown(block('to_do', '[ ] Confirm', { markdown: 'Confirm', checked: false })), '- [ ] Confirm');
  assert.equal(blockMarkdown(block('heading_1', 'Plan', { markdown: 'Plan' })), '## Plan');
  assert.equal(blockMarkdown(block('numbered_list_item', 'Second', { markdown: 'Second' }), 2), '2. Second');
  assert.equal(blockMarkdown(block('quote', 'Line', { markdown: 'a\nb' })), '> a\n> b');
  assert.equal(blockMarkdown(block('code', 'scheduleNextCycle(plan)', { markdown: '`x`', language: 'typescript' })), '```typescript\nscheduleNextCycle(plan)\n```');
  assert.equal(blockMarkdown(block('code', 'a ``` b')), '````\na ``` b\n````');
});

test('saved copies from before rich text are escaped and keep their to-do state', () => {
  assert.equal(blockMarkdown(block('to_do', '[x] Ship <b>it</b> *now*')), '- [x] Ship &lt;b&gt;it&lt;/b&gt; \\*now\\*');
  assert.equal(blockMarkdown(block('paragraph', '1. not a list')), '1\\. not a list');
});

test('blocks nest under the nearest shallower block', () => {
  const tree = blockTree(savedBlocks([block('toggle', 'A'), { ...block('to_do', 'B'), depth: 1 }, { ...block('paragraph', 'C'), depth: 2 }, block('paragraph', 'D'), 'bad', { type: 'x' }]));
  assert.deepEqual(tree.map(node => [node.block.text, node.children.map(child => [child.block.text, child.children.map(grand => grand.block.text)])]), [['A', [['B', ['C']]]], ['D', []]]);
});
