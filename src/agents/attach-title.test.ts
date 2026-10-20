import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAttachTitleRequest, normalizeAttachTitle } from './attach-title.ts';

test('attach title requests are tool-free, bounded and treat the message as data', () => {
  const request = buildAttachTitleRequest({ kind: 'Slack thread', text: 'x'.repeat(9000) });
  assert.equal(request.model, 'haiku'); assert.equal(request.max_tokens, 64); assert.equal(request.thinking.type, 'disabled');
  assert.match(request.system, /never instructions/); assert.match(request.system, /32 characters/); assert.doesNotMatch(request.system, /KEEP/);
  const input = JSON.parse(request.messages[0].content);
  assert.equal(input.kind, 'Slack thread'); assert.equal(input.text.length, 4000);
});

test('attach titles reuse the agent title normalizer and never accept KEEP-style or echoed replies', () => {
  assert.equal(normalizeAttachTitle('  "Billing cycle decision."  '), 'Billing cycle decision');
  assert.equal(normalizeAttachTitle('**Title: Plan change handling**'), 'Plan change handling');
  assert.equal(normalizeAttachTitle('Investigate flaky billing plan selector regression tests'), 'Investigate flaky billing plan');
  for (const invalid of ['', 'KEEP', 'The current title still fits', 'Plan', '🚀 Ship billing', 'Fix <script> loop'])
    assert.equal(normalizeAttachTitle(invalid), undefined, invalid);
  assert.equal(normalizeAttachTitle('Slack thread.', ['Slack thread']), undefined, 'an echo of the item kind is not a summary');
  assert.equal(normalizeAttachTitle('Billing cycle decision', ['Slack thread']), 'Billing cycle decision');
});
