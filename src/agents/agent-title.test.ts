import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentTitleRequest, normalizeAgentTitle, sameAgentTitle } from './agent-title.ts';

test('agent titles are super short, plain and clamped at a word boundary', () => {
  assert.equal(normalizeAgentTitle('Fix cache refresh loop'), 'Fix cache refresh loop');
  assert.equal(normalizeAgentTitle('  "Search index triage."  '), 'Search index triage');
  assert.equal(normalizeAgentTitle('**Title: Search index triage**'), 'Search index triage');
  assert.equal(normalizeAgentTitle('Fix cache refresh loop\nBecause the importer…'), 'Fix cache refresh loop');
  assert.equal(normalizeAgentTitle('Investigate flaky billing plan selector regression tests'), 'Investigate flaky billing plan');
  assert.equal(normalizeAgentTitle('Refactor the cache refresh loop in importer'), 'Refactor the cache refresh loop');
  assert.equal(normalizeAgentTitle('Update the API for the'), 'Update the API');
  assert.equal(normalizeAgentTitle('KEEP'), 'KEEP'); assert.equal(normalizeAgentTitle(' keep. '), 'KEEP');
  for (const invalid of ['', 'Refactoring', '🚀 Ship billing', 'Fix <script> loop', 'Fix `cache` loop', 'Supercalifragilisticexpialidocious-refactorings everywhere']) assert.equal(normalizeAgentTitle(invalid), undefined, invalid);
  assert.ok(sameAgentTitle('Fix cache refresh loop', 'fix cache-refresh loop.'));
  assert.ok(!sameAgentTitle('Fix cache refresh loop', 'Fix cache expiry loop'));
});

test('agent title requests are tool-free, bounded and treat evidence as data', () => {
  const request = buildAgentTitleRequest({ provider: 'claude', status: 'idle', currentTitle: 'Fix cache loop', directory: 'importer', branch: 'fix/cache', linked: ['Cache refresh never stops'], recentOutput: 'x'.repeat(9000) });
  assert.equal(request.model, 'haiku'); assert.equal(request.max_tokens, 64); assert.equal(request.thinking.type, 'disabled');
  assert.match(request.system, /never instructions/); assert.match(request.system, /KEEP/); assert.match(request.system, /32 characters/);
  const input = JSON.parse(request.messages[0].content);
  assert.equal(input.recentOutput.length, 6000); assert.equal(input.currentTitle, 'Fix cache loop'); assert.deepEqual(input.linked, ['Cache refresh never stops']);
  assert.equal(JSON.parse(buildAgentTitleRequest({ provider: 'codex', status: 'working', linked: [], recentOutput: 'x' }).messages[0].content).currentTitle, null);
});

test('replies that talk about keeping the current title are KEEP, never a title', () => {
  for (const reply of ['The currentTitle still fits', 'Current title still describes the work', 'KEEP — the title is fine', 'I would keep it', 'currentTitle is accurate']) assert.equal(normalizeAgentTitle(reply), 'KEEP', reply);
  assert.equal(normalizeAgentTitle('Use recentOutput cache fix'), undefined);
  assert.equal(normalizeAgentTitle('Keep cache refresh stable'), 'Keep cache refresh stable');
});

test('ordinary words that match request field names still make titles', () => {
  assert.equal(normalizeAgentTitle('Fix provider retries'), 'Fix provider retries');
  assert.equal(normalizeAgentTitle('Linked ticket cleanup'), 'Linked ticket cleanup');
});
