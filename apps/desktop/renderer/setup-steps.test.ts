import test from 'node:test';
import assert from 'node:assert/strict';
import { providerSetupSteps } from './setup-steps.ts';
import { linearSetupHint, linearSetupSteps } from '../../../packages/provider-runtime/linear-connection.ts';

test('declared setup steps win over the plain-text hint', () => {
  assert.deepEqual(providerSetupSteps({ setupHint: linearSetupHint, setupSteps: linearSetupSteps }), linearSetupSteps);
});

test('legacy numbered hints become steps with their Terminal command attached', () => {
  const steps = providerSetupSteps({ setupHint: linearSetupHint });
  assert.equal(steps.length, 4);
  assert.match(steps[0].text, /^In Linear, open Settings/);
  assert.equal(steps[1].command, 'security add-generic-password -U -s dev.agentcraftingtable.linear -a default -w');
  assert.match(steps[1].text, /Keep -w last/);
  assert.match(steps[3].text, /Browser-based sign-in is not available yet\.$/);
});

test('a one-paragraph hint stays one step and `$` lines are commands', () => {
  assert.deepEqual(providerSetupSteps({ setupHint: 'Uses GitHub CLI accounts. To add one, run gh auth login.' }), [{ text: 'Uses GitHub CLI accounts. To add one, run gh auth login.' }]);
  assert.deepEqual(providerSetupSteps({ setupHint: '1. Sign in:\n$ notion auth login\n2. Connect.' }), [{ text: 'Sign in:', command: 'notion auth login' }, { text: 'Connect.' }]);
});
