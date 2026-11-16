import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentInstallation } from './agent-installation.ts';

test('installation checks distinguish missing CLIs and expose no executable paths', () => {
  assert.deepEqual(agentInstallation(() => '/fixture/bin/claude', () => undefined), [
    { id: 'claude', name: 'Claude', installed: true }, { id: 'codex', name: 'Codex', installed: false },
  ]);
  assert.deepEqual(agentInstallation(() => undefined, () => '/fixture/bin/codex'), [
    { id: 'claude', name: 'Claude', installed: false }, { id: 'codex', name: 'Codex', installed: true },
  ]);
});
