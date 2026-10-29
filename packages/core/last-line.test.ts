import test from 'node:test';
import assert from 'node:assert/strict';
import { LAST_LINE_LENGTH, agentLastLine, agentSaid } from './last-line.ts';

test('the last non-empty line of a message, without list or heading markers, fences or inline code ticks', () => {
  assert.equal(agentLastLine('Done.\n\nI pushed the fix to `main`.\n'), 'I pushed the fix to main.');
  assert.equal(agentLastLine('## Summary\n- first\n- **Second point** done'), 'Second point done');
  assert.equal(agentLastLine('```ts\nconst a = 1;\n```'), 'const a = 1;');
  assert.equal(agentLastLine('> quoted line'), 'quoted line');
  assert.equal(agentLastLine('   \n\n'), undefined);
  assert.equal(agentLastLine(''), undefined);
});

test('a long line is clipped to the row length with an ellipsis', () => {
  const line = agentLastLine('x'.repeat(400))!;
  assert.equal(line.length, LAST_LINE_LENGTH); assert.ok(line.endsWith('…'));
  assert.equal(agentLastLine('x'.repeat(LAST_LINE_LENGTH)), 'x'.repeat(LAST_LINE_LENGTH));
});

test('what an agent said is its recap when it has one, else its last line', () => {
  const recap = { text: 'I removed the flag; the PR is ready for your review.', at: '2026-09-30T14:23:09.455Z' };
  assert.equal(agentSaid({ lastLine: 'Done.', recap }), recap.text);
  assert.equal(agentSaid({ lastLine: 'Done.' }), 'Done.');
  assert.equal(agentSaid({ recap }), recap.text);
  assert.equal(agentSaid({}), undefined);
  assert.equal(agentSaid(undefined), undefined);
});
