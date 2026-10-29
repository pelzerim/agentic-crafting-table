import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RECAP_LENGTH, RECAP_TAIL_BYTES, newestRecap, readRecap } from './recaps.ts';
import { findClaudeTranscript } from './transcripts.ts';

const recap = (timestamp: string, content: string, subtype = 'away_summary') => JSON.stringify({ type: 'system', subtype, content, timestamp, sessionId: '00000000-0000-4000-8000-000000000021', uuid: '00000000-0000-4000-8000-000000000022' });
const user = (timestamp: string, content: string) => JSON.stringify({ type: 'user', timestamp, message: { role: 'user', content } });

test('the newest away summary of a transcript, without the recap setting hint', () => {
  const lines = [
    user('2026-09-30T14:00:00.000Z', 'Remove the legacy flag'),
    recap('2026-09-30T14:10:00.000Z', 'I removed the flag. (disable recaps in /config)'),
    recap('2026-09-30T14:23:09.455Z', 'I removed the flag and the PR is ready for your review.  (disable recaps in /config)  '),
    recap('2026-09-30T14:30:00.000Z', 'A compact boundary', 'compact_boundary'),
    'not json',
    '{"type":"system","subtype":"away_summary","content":42,"timestamp":"2026-09-30T15:00:00.000Z"}',
    '{"type":"system","subtype":"away_summary","content":"No time"}',
  ];
  assert.deepEqual(newestRecap(lines), { text: 'I removed the flag and the PR is ready for your review.', at: '2026-09-30T14:23:09.455Z' });
});

test('newest is by time, not by position', () => {
  assert.equal(newestRecap([recap('2026-09-30T15:00:00.000Z', 'Later'), recap('2026-09-30T14:00:00.000Z', 'Earlier')])?.text, 'Later');
});

test('a transcript without a recap, or with an empty one, has none', () => {
  assert.equal(newestRecap([user('2026-09-30T14:00:00.000Z', 'Hello')]), undefined);
  assert.equal(newestRecap([recap('2026-09-30T14:00:00.000Z', '  (disable recaps in /config)')]), undefined);
});

test('a recap is redacted and capped on a word boundary', () => {
  const secret = newestRecap([recap('2026-09-30T14:00:00.000Z', 'I set GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwx in the env.')])!;
  assert.ok(!secret.text.includes('ghp_abcdefghijklmnopqrstuvwx'), secret.text);
  const long = newestRecap([recap('2026-09-30T14:00:00.000Z', `${'word '.repeat(300)}end`)])!;
  assert.ok(long.text.length <= RECAP_LENGTH, String(long.text.length));
  assert.ok(long.text.endsWith('word…'), long.text.slice(-20));
  assert.equal(newestRecap([recap('2026-09-30T14:00:00.000Z', 'Short\n\nand   spaced')])?.text, 'Short and spaced');
});

test('only the tail of a large transcript is read', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'act-recaps-'));
  try {
    const file = join(directory, 'session.jsonl'), filler = user('2026-09-30T13:00:00.000Z', 'x'.repeat(1000));
    const early = recap('2026-09-30T13:30:00.000Z', 'Early recap beyond the tail');
    const body = [early, ...Array.from({ length: Math.ceil(RECAP_TAIL_BYTES / filler.length) + 10 }, () => filler), recap('2026-09-30T14:00:00.000Z', 'Recent recap')];
    await writeFile(file, body.join('\n') + '\n');
    assert.deepEqual(await readRecap(file), { text: 'Recent recap', at: '2026-09-30T14:00:00.000Z' });
    await writeFile(file, [early, ...body.slice(1, -1)].join('\n') + '\n');
    assert.equal(await readRecap(file), undefined, 'a recap before the tail is not read');
    await writeFile(file, recap('2026-09-30T14:00:00.000Z', 'Small file'));
    assert.equal((await readRecap(file))?.text, 'Small file');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the transcript is found asynchronously by session id in any project folder', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'act-recap-find-'));
  try {
    const id = '00000000-0000-4000-8000-000000000023';
    assert.equal(await findClaudeTranscript(id, directory), undefined, 'no projects folder');
    await mkdir(join(directory, 'projects', '-tmp-other'), { recursive: true }); await mkdir(join(directory, 'projects', '-tmp-work'));
    await writeFile(join(directory, 'projects', '-tmp-work', `${id}.jsonl`), '');
    assert.equal(await findClaudeTranscript(id, directory), join(directory, 'projects', '-tmp-work', `${id}.jsonl`));
    assert.equal(await findClaudeTranscript('../../etc/passwd', directory), undefined);
    assert.equal(await findClaudeTranscript('00000000-0000-4000-8000-000000000099', directory), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
