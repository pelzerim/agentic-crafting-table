import test from 'node:test';
import assert from 'node:assert/strict';
import { choiceInput, loadResourceChoices } from './choices.ts';
import type { JsonValue, ResourceChoices } from './types.ts';

const closing = { prompt: 'Close #42?', note: 'You can reopen it later.', action: 'Close pull request', text: { field: 'comment', label: 'Comment (optional)', maxLength: 20 } };
const choices: ResourceChoices = { current: '', context: { sourceResourceId: 'pr' }, options: [{ id: 'draft', label: 'Convert to draft' }, { id: 'close', label: 'Close pull request…', confirm: closing }] };
const services = (value: unknown) => ({ runAction: async () => value as JsonValue });

test('a confirmed option carries its optional text in its declared field, and only when non-empty', () => {
  assert.deepEqual({ ...choiceInput(choices, 'close', 'Superseded by #43'), requestId: '' }, { sourceResourceId: 'pr', value: 'close', comment: 'Superseded by #43', requestId: '' });
  for (const text of [undefined, '', '  \n']) assert.equal('comment' in choiceInput(choices, 'close', text), false);
  assert.equal('comment' in choiceInput(choices, 'draft', 'ignored'), false, 'options without a text field never send one');
  assert.throws(() => choiceInput(choices, 'close', 'x'.repeat(21)), /at most 20 characters/);
});

test('choices with a malformed confirmation are refused before anything is shown', async () => {
  assert.deepEqual(await loadResourceChoices(services(choices), 'pr.state.options'), choices);
  const bad = (confirm: unknown) => loadResourceChoices(services({ ...choices, options: [{ id: 'close', label: 'Close', confirm }] }), 'pr.state.options');
  for (const confirm of [{ action: 'Close' }, { prompt: 'Close?' }, { ...closing, text: { ...closing.text, field: 'value' } }, { ...closing, text: { ...closing.text, field: 'sourceResourceId' } },
    { ...closing, text: { ...closing.text, field: 'requestId' } }, { ...closing, text: { ...closing.text, maxLength: 0 } }, { ...closing, text: { ...closing.text, label: '' } }, { ...closing, prompt: 'x'.repeat(501) }])
    await assert.rejects(bad(confirm), /unavailable|inconsistent/, JSON.stringify(confirm));
});
