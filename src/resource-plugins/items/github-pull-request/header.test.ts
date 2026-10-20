import test from 'node:test';
import assert from 'node:assert/strict';
import { autoValidates, pullHeader, pullViewIdentity } from './header.ts';

const now = new Date(2026, 8, 30, 14, 0).getTime();
const pull = (extra: Record<string, unknown> = {}) => ({ number: 42, state: 'open', merged: false, draft: false, changed_files: 1, additions: 24, deletions: 6, updated_at: new Date(now - 2 * 60_000).toISOString(), ...extra });

test('the chip carries lifecycle only; review state moves to the meta line', () => {
  assert.deepEqual(pullHeader(pull(), 'approved', 'fixture/billing', now), { chip: { label: 'Open', tone: 'green' }, meta: ['#42', 'fixture/billing', '✓ Approved', '1 file +24 −6', 'updated 2 min ago'], primary: 'merge' });
  assert.deepEqual(pullHeader(pull({ merged: true, state: 'closed' }), 'merged', 'fixture/billing', now).chip, { label: 'Merged', tone: 'violet' });
  assert.deepEqual(pullHeader(pull({ state: 'closed' }), 'closed', 'fixture/billing', now).chip, { label: 'Closed', tone: 'red' });
  assert.deepEqual(pullHeader(pull({ draft: true }), 'draft', 'fixture/billing', now).chip, { label: 'Draft', tone: 'neutral' });
  assert.equal(pullHeader(pull({ merged: true, state: 'closed' }), 'merged', 'fixture/billing', now).meta[2], undefined);
});

test('one primary action follows the pull request state', () => {
  assert.equal(pullHeader(pull(), 'approved', 'r', now).primary, 'merge');
  for (const status of ['open', 'changes-requested', 'checks-failing', 'draft']) assert.equal(pullHeader(pull(), status, 'r', now).primary, 'review', status);
  assert.equal(pullHeader(pull(), 'open', 'r', now).meta[2], 'Review required');
  assert.equal(pullHeader(pull(), 'queued', 'r', now).primary, undefined);
  assert.equal(pullHeader(pull({ merged: true, state: 'closed' }), 'merged', 'r', now).primary, undefined);
  assert.deepEqual(pullHeader(undefined, undefined, 'fixture/billing', now), { chip: undefined, meta: ['fixture/billing'], primary: undefined });
});

test('Auto validate is on unless the pull request stores autoValidate: false, and toggling it keeps the open view mounted', () => {
  const record = (data: Record<string, unknown> = {}) => ({ id: 'pr', pluginId: 'github.pull-request', schemaVersion: 1, title: 'PR', connectionId: 'github', data: { owner: 'acme', repo: 'app', number: 42, ...data } });
  assert.equal(autoValidates(record()), true);
  assert.equal(autoValidates(record({ autoValidate: true })), true);
  assert.equal(autoValidates(record({ autoValidate: false })), false);
  assert.equal(pullViewIdentity(record({ autoValidate: false })), pullViewIdentity(record()));
  assert.notEqual(pullViewIdentity(record({ number: 43 })), pullViewIdentity(record()));
  assert.notEqual(pullViewIdentity({ ...record(), connectionId: 'other' }), pullViewIdentity(record()));
});
