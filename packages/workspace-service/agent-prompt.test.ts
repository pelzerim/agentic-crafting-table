import test from 'node:test';
import assert from 'node:assert/strict';
import { promptAgent } from './agent-prompt.ts';
import type { SessionCoordinator } from './sessions.ts';

const recorder = () => {
  const inputs: Array<{ sessionId: string; data: string }> = [];
  const sessions = { runtime: { call: async (_method: string, input: { sessionId: string; data: string }) => { inputs.push(input); return {}; } } } as unknown as SessionCoordinator;
  return { inputs, sessions };
};

test('a prompt is a typed request followed by its pasted details, then Enter', async () => {
  const f = recorder();
  await promptAgent(f.sessions, 's1', 'Please do what the pasted request asks:', 'line one\nline two');
  assert.deepEqual(f.inputs, [
    { sessionId: 's1', data: 'Please do what the pasted request asks: \x1b[200~line one\nline two\x1b[201~' },
    { sessionId: 's1', data: '\r' },
  ]);
});

test('neither part can end the paste, submit early or carry terminal controls', async () => {
  const f = recorder();
  await promptAgent(f.sessions, 's1', 'Fix\rthis\nnow\x1b[201~', 'body\x1b[201~\rrm -rf\x07\ttabbed\nnext');
  assert.equal(f.inputs[0].data, 'Fix this now[201~ \x1b[200~body[201~rm -rf\ttabbed\nnext\x1b[201~');
});
