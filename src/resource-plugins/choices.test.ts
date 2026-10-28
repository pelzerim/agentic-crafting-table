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

const takeover = { prompt: 'Auto deploy run #7 from here?', action: 'Start auto deploy', pick: { field: 'catchUp', label: 'Phases that already ran', options: [
  { id: 'validate', label: 'Validate what shipped first', note: 'Validated before the next gate.', plan: [{ name: 'staging', text: 'deployed 14:12 · validate now', tone: 'do' as const }], foot: 'One validation (staging) before production.' },
  { id: 'accept', label: 'Start from the next phase', plan: [{ name: 'staging', text: 'counts as accepted, not validated', tone: 'risk' as const }] }] } };
const picking: ResourceChoices = { current: '', context: { sourceResourceId: 'rollout', from: 'here' }, options: [{ id: 'arm', label: 'Start auto deploy', confirm: takeover }] };

test('a confirmation with a pick sends the picked option in its declared field, the first one unless another was picked', async () => {
  assert.deepEqual({ ...choiceInput(picking, 'arm'), requestId: '' }, { sourceResourceId: 'rollout', from: 'here', value: 'arm', catchUp: 'validate', requestId: '' });
  assert.equal(choiceInput(picking, 'arm', undefined, 'accept').catchUp, 'accept');
  assert.throws(() => choiceInput(picking, 'arm', undefined, 'other'), /unavailable/);
  assert.equal((await loadResourceChoices(services(picking), 'options', 'github.rollout.autoDeploy')).options[0].confirm?.pick?.options.length, 2);
  for (const pick of [{ ...takeover.pick, field: 'value' }, { ...takeover.pick, field: 'from' }, { ...takeover.pick, options: [] }, { ...takeover.pick, options: [{ id: '', label: 'x' }] }, { ...takeover.pick, options: [{ id: 'a', label: 'x', plan: [{ name: 'p', text: 'y'.repeat(301) }] }] }])
    await assert.rejects(loadResourceChoices(services({ ...picking, options: [{ id: 'arm', label: 'Start auto deploy', confirm: { ...takeover, pick } }] }), 'options', 'github.rollout.autoDeploy'), /inconsistent/, JSON.stringify(pick));
});

/** Answers each ask in turn with the given value, or throws when it is an Error; records the inputs. */
function asked(...answers: unknown[]) {
  const inputs: unknown[] = [];
  return { inputs, runAction: async (_operation: string, input: unknown) => { inputs.push((input as { input: unknown }).input); const answer = answers.shift(); if (answer instanceof Error) throw answer; return answer as JsonValue; } };
}
const settled = () => new Promise(resolve => setTimeout(resolve, 0));

test('a cached answer resolves at once and a differing live answer replaces it', async () => {
  const live = { ...choices, options: [choices.options[0]] }, service = asked({ ...choices, cachedAt: 1 }, live), refreshed: ResourceChoices[] = [];
  const shown = await loadResourceChoices(service, 'pr.state.options', undefined, value => refreshed.push(value));
  assert.equal(shown.cachedAt, 1);
  assert.deepEqual(shown.options, choices.options);
  await settled();
  assert.deepEqual(service.inputs, [{ cached: true }, { refresh: true }]);
  assert.deepEqual(refreshed, [live]);
});

test('a live answer equal to the cached one, or a failed refresh, leaves the cached menu alone', async () => {
  for (const second of [{ ...choices }, new Error('GitHub is down'), { ...choices, options: [] }]) {
    const service = asked({ ...choices, cachedAt: 1 }, second), refreshed: ResourceChoices[] = [];
    await loadResourceChoices(service, 'pr.state.options', undefined, value => refreshed.push(value));
    await settled(); await settled();
    assert.equal(service.inputs.length, 2);
    assert.deepEqual(refreshed, [], JSON.stringify(second));
  }
});

test('an answer without cachedAt is the live one and is not asked again', async () => {
  const service = asked(choices), refreshed: ResourceChoices[] = [];
  assert.deepEqual(await loadResourceChoices(service, 'pr.state.options', undefined, value => refreshed.push(value)), choices);
  await settled();
  assert.deepEqual(service.inputs, [{ cached: true }]);
  assert.deepEqual(refreshed, []);
});

test('choices with a malformed confirmation are refused before anything is shown', async () => {
  assert.deepEqual(await loadResourceChoices(services(choices), 'pr.state.options'), choices);
  const bad = (confirm: unknown) => loadResourceChoices(services({ ...choices, options: [{ id: 'close', label: 'Close', confirm }] }), 'pr.state.options');
  for (const confirm of [{ action: 'Close' }, { prompt: 'Close?' }, { ...closing, text: { ...closing.text, field: 'value' } }, { ...closing, text: { ...closing.text, field: 'sourceResourceId' } },
    { ...closing, text: { ...closing.text, field: 'requestId' } }, { ...closing, text: { ...closing.text, maxLength: 0 } }, { ...closing, text: { ...closing.text, label: '' } }, { ...closing, prompt: 'x'.repeat(501) }])
    await assert.rejects(bad(confirm), /unavailable|inconsistent/, JSON.stringify(confirm));
});
