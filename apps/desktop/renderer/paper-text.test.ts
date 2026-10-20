import test from 'node:test';
import assert from 'node:assert/strict';
import { indentList, sourceOffset, taskProgress, toggleChecklist, toggleTask, wrapSelection } from './paper-text.ts';

test('a click on rendered text maps back to the same place in the source', () => {
  const source = 'API compatibility\nKeep **/v1/plans** stable.\n- [x] Freeze shape\n- [ ] Version fields';
  assert.equal(sourceOffset(source, 'API compatibility\nKeep ', '/'), source.indexOf('/v1/plans'));
  assert.equal(sourceOffset('API compatibility\nKeep stable', 'API compatibility\nKeep ', 's'), 'API compatibility\nKeep '.length);
  assert.equal(sourceOffset(source, 'API compatibility\nKeep /v1/pl', 'a'), source.indexOf('/v1/plans') + 6);
  assert.equal(sourceOffset(source, 'API compatibility\nKeep /v1/plans stable.\nFreeze shape\n', 'V'), source.indexOf('Version'));
  assert.equal(sourceOffset(source, 'API compatibility\nKeep /v1/plans stable.\nFreeze shape\nVersion fields', undefined), source.length);
  assert.equal(sourceOffset(source, '', 'A'), 0);
  assert.equal(sourceOffset('日本語 note', '日本', '語'), '日本'.length);
});

test('checklists toggle per line and keep the caret on its text', () => {
  assert.deepEqual(toggleChecklist('Buy milk', 3, 3), { from: 0, to: 8, insert: '- [ ] Buy milk', start: 9, end: 9 });
  assert.deepEqual(toggleChecklist('- Buy milk', 4, 4), { from: 0, to: 10, insert: '- [ ] Buy milk', start: 8, end: 8 });
  assert.deepEqual(toggleChecklist('- [x] Buy milk', 8, 8), { from: 0, to: 14, insert: 'Buy milk', start: 2, end: 2 });
  assert.deepEqual(toggleChecklist('Title\none\ntwo', 7, 12), { from: 6, to: 13, insert: '- [ ] one\n- [ ] two', start: 13, end: 24 });
});

test('Tab indents and outdents list lines only', () => {
  assert.deepEqual(indentList('- one\n- two', 8, 8, false), { from: 6, to: 11, insert: '  - two', start: 10, end: 10 });
  assert.deepEqual(indentList('- one\n  - two', 10, 10, true), { from: 6, to: 13, insert: '- two', start: 8, end: 8 });
  assert.equal(indentList('Plain line', 3, 3, false), undefined);
  assert.equal(indentList('- top', 3, 3, true), undefined);
});

test('bold and emphasis wrap the selection or open an empty pair at the caret', () => {
  assert.deepEqual(wrapSelection('Keep stable', 5, 11, '**'), { from: 5, to: 11, insert: '**stable**', start: 7, end: 13 });
  assert.deepEqual(wrapSelection('Keep ', 5, 5, '_'), { from: 5, to: 5, insert: '__', start: 6, end: 6 });
});

test('a checkbox toggles its own line in the source, skipping code blocks', () => {
  const text = 'Rollout\n- [x] Flag\n```\n- [ ] not a task\n```\n  * [ ] Preview\n- [ ] Email';
  assert.equal(toggleTask(text, 1), text.replace('* [ ] Preview', '* [x] Preview'));
  assert.equal(toggleTask(text, 0), text.replace('- [x] Flag', '- [ ] Flag'));
  assert.equal(toggleTask(text, 2), text.replace('- [ ] Email', '- [x] Email'));
  assert.equal(toggleTask(text, 3), text);
  assert.deepEqual(taskProgress(text), { done: 1, total: 3 });
  assert.deepEqual(taskProgress('No tasks'), { done: 0, total: 0 });
});
