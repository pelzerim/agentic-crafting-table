import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryNotice } from './recovery-notice.ts';

const entry = (state: 'pending' | 'restored' | 'failed' | 'skipped') => ({ sessionId: `s-${state}`, nodeId: 'n', title: 'Session', kind: 'agent' as const, continueWork: false, requestId: 'r', state });
test('closing the app never announces an empty "0 sessions restored"', () => {
  assert.equal(recoveryNotice({ phase: 'closing', entries: [entry('pending'), entry('skipped')] }, '').identity, undefined);
  assert.equal(recoveryNotice({ phase: 'closed', entries: [entry('pending')] }, '').identity, undefined);
  assert.equal(recoveryNotice({ phase: 'open', entries: [entry('skipped')] }, '').identity, undefined);
  assert.equal(recoveryNotice({ phase: 'recovering', entries: [] }, '').identity, undefined, 'a startup with nothing to resume stays quiet');
});
test('real recovery outcomes are still announced', () => {
  assert.equal(recoveryNotice({ phase: 'open', entries: [entry('restored'), entry('pending')] }, '').title, '1 session restored');
  assert.equal(recoveryNotice({ phase: 'open', entries: [entry('failed')] }, '').title, 'Some sessions need attention');
  assert.equal(recoveryNotice({ phase: 'recovering', entries: [entry('pending')] }, '').title, 'Resuming your workspace…');
  assert.ok(recoveryNotice(undefined, 'Socket closed').identity);
});
