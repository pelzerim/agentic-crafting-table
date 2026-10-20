import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRANSCRIPT_LIMIT, claudeTranscript, readTranscriptDays, sliceTranscript, transcriptEvidence } from './transcripts.ts';
import { redactSecrets } from './activity-summary.ts';

const inUtc = async <T>(run: () => T | Promise<T>) => {
  const previous = process.env.TZ; process.env.TZ = 'UTC';
  try { return await run(); } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
};
const user = (timestamp: string, content: unknown, extra: object = {}) => JSON.stringify({ type: 'user', timestamp, message: { role: 'user', content }, ...extra });
const assistant = (timestamp: string, content: unknown[]) => JSON.stringify({ type: 'assistant', timestamp, message: { role: 'assistant', content } });
const lines = [
  user('2026-10-12T23:50:00.000Z', 'Look at the flaky retry test'),
  assistant('2026-10-12T23:55:00.000Z', [{ type: 'text', text: 'The retry test races the clock.' }]),
  user('2026-10-13T08:00:00.000Z', 'Why are cart totals off by a cent?'),
  assistant('2026-10-13T08:01:00.000Z', [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'tool_use', name: 'Bash', input: { command: 'rg timeout' } }]),
  user('2026-10-13T08:01:30.000Z', [{ type: 'tool_result', tool_use_id: 't1', content: 'FULL RAW TOOL OUTPUT '.repeat(50) }]),
  assistant('2026-10-13T08:02:00.000Z', [{ type: 'tool_use', name: 'Bash', input: {} }, { type: 'tool_use', name: 'Edit', input: {} }]),
  user('2026-10-13T08:02:30.000Z', [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'Error: cart has no rounding field' }]),
  assistant('2026-10-13T08:03:00.000Z', [{ type: 'text', text: 'Found it: the cart rounds each line before it adds them up. export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwx' }]),
  user('2026-10-13T08:04:00.000Z', '<system-reminder>injected</system-reminder>Fix it and add a test', {}),
  user('2026-10-13T08:04:10.000Z', 'Caveat: meta', { isMeta: true }),
  user('2026-10-13T08:05:00.000Z', 'subagent prompt', { isSidechain: true }),
  JSON.stringify({ type: 'summary', summary: 'Cart totals' }),
  'not json',
  user('2026-10-14T09:00:00.000Z', 'Ship it'),
];

test('a day slice holds that local day only: prompts, final replies and tool names, not thinking or raw tool output', () => inUtc(() => {
  const slices = sliceTranscript(lines, new Set(['2026-10-13']));
  assert.deepEqual([...slices.keys()], ['2026-10-13']);
  const day = slices.get('2026-10-13')!;
  assert.equal(day.prompts, 2); assert.equal(day.replies, 1); assert.deepEqual(day.tools, { Bash: 2, Edit: 1 });
  const text = transcriptEvidence(day);
  assert.match(text, /^\[08:00\] Me: Why are cart totals off by a cent\?/);
  assert.match(text, /\[08:02\] Tool error: Error: cart has no rounding field/);
  assert.match(text, /\[08:04\] Me: Fix it and add a test/);
  assert.match(text, /Tools used: Bash ×2, Edit ×1$/);
  for (const absent of ['flaky retry', 'private reasoning', 'FULL RAW TOOL OUTPUT', 'injected', 'Caveat', 'subagent prompt', 'Ship it', 'ghp_abcdefghijklmnopqrstuvwx']) assert.ok(!text.includes(absent), absent);
}));

test('local days follow the machine time zone', async () => {
  const previous = process.env.TZ; process.env.TZ = 'Pacific/Auckland';
  try { assert.deepEqual([...sliceTranscript(lines, new Set(['2026-10-13', '2026-10-12'])).keys()], ['2026-10-13']); }
  finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('evidence is redacted and capped, keeping the first ask and the latest work', () => inUtc(() => {
  const long = [user('2026-10-13T07:00:00.000Z', 'The original ask'), ...Array.from({ length: 400 }, (_, index) => assistant(`2026-10-13T08:${String(index % 60).padStart(2, '0')}:00.000Z`, [{ type: 'text', text: `Step ${index} ${'detail '.repeat(20)}` }])), user('2026-10-13T10:00:00.000Z', 'The last word')];
  const text = transcriptEvidence(sliceTranscript(long, new Set(['2026-10-13'])).get('2026-10-13')!);
  assert.ok(text.length <= TRANSCRIPT_LIMIT, String(text.length));
  assert.match(text, /The original ask/); assert.match(text, /The last word/); assert.match(text, /earlier lines left out/);
}));

test('redaction covers environment-style and provider tokens', () => {
  const text = redactSecrets('export STRIPE_SECRET_KEY=sk_live_value\nMY_API_TOKEN: abc123\nkey AIzaSyA1234567890abcdefghijklmnopqrstuv glpat-abcdefghijklmnopqrstu\npassword=hunter2 kept words');
  for (const secret of ['sk_live_value', 'abc123', 'AIzaSy', 'glpat-', 'hunter2']) assert.ok(!text.includes(secret), secret);
  assert.match(text, /export \[redacted credential\]/);
});

test('the transcript is found by session id in any project folder and read for the asked days', () => inUtc(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'act-transcripts-'));
  try {
    const id = '00000000-0000-4000-8000-000000000013';
    await mkdir(join(directory, 'projects', '-tmp-elsewhere'), { recursive: true }); await mkdir(join(directory, 'projects', '-tmp-work'));
    await writeFile(join(directory, 'projects', '-tmp-work', `${id}.jsonl`), lines.join('\n') + '\n');
    const file = claudeTranscript(id, directory)!;
    assert.match(file, /-tmp-work/);
    assert.equal(claudeTranscript('../../etc/passwd', directory), undefined); assert.equal(claudeTranscript('00000000-0000-4000-8000-000000000099', directory), undefined);
    const days = await readTranscriptDays(file, new Set(['2026-10-13', '2026-10-14']));
    assert.deepEqual([...days.keys()].sort(), ['2026-10-13', '2026-10-14']); assert.equal(days.get('2026-10-14')!.prompts, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
}));
