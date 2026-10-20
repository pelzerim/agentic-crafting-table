import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewTranscript } from './review-transcript.ts';
import { questionReview } from '../../tests/fixtures/review-findings.ts';

const stream = (...events: object[]) => events.map(event => JSON.stringify(event)).join('\n');

test('a Claude event stream becomes readable progress, tool calls and a result summary', () => {
  const lines = reviewTranscript(`REVIEW_STARTED:claude:opus\n${stream(
    { type: 'system', subtype: 'init', cwd: '/tmp/review/', model: 'claude-opus', tools: ['Read', 'Grep'] },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: ' Reading the change. ' }, { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/review/repository/src/a.ts', offset: 40 } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'CONFIG_KEY', path: '/tmp/review/repository' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'file body' }, { type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'File does not exist.' }] }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: questionReview }] } },
    { type: 'rate_limit_event' },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 12, duration_ms: 125_000, result: '', structured_output: questionReview })}\n{"type":"assis`);
  assert.deepEqual(lines, [
    { kind: 'plain', text: 'REVIEW_STARTED:claude:opus' },
    { kind: 'start', text: 'Started · claude-opus', detail: 'Tools: Read, Grep' },
    { kind: 'text', text: 'Reading the change.' },
    { kind: 'tool', text: 'Read repository/src/a.ts', detail: 'from line 40' },
    { kind: 'tool', text: 'Grep CONFIG_KEY', detail: 'in repository' },
    { kind: 'error', text: 'Tool error', detail: 'File does not exist.' },
    { kind: 'tool', text: 'Returned findings', detail: '1 finding' },
    { kind: 'done', text: 'Finished · 12 turns · 2 min 5 s', detail: '1 finding' },
  ]);
});

test('errors, single json results and non-Claude output', () => {
  assert.deepEqual(reviewTranscript(stream({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 40, result: 'Stopped early' })),
    [{ kind: 'error', text: 'Ended with error_max_turns · 40 turns', detail: 'Stopped early' }]);
  assert.deepEqual(reviewTranscript(stream({ type: 'result', subtype: 'success', is_error: false, result: 'All good.' })), [{ kind: 'done', text: 'Finished', detail: 'All good.' }]);
  assert.equal(reviewTranscript('## Review complete\n\n- a text review'), undefined);
  assert.equal(reviewTranscript(JSON.stringify(questionReview)), undefined);
});
