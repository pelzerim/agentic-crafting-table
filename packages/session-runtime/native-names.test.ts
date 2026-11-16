import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_NAME_TAIL_BYTES, nativeName, newestClaudeName, readClaudeName } from './native-names.ts';

const line = (entry: Record<string, unknown>) => JSON.stringify(entry);

test('the newest custom title is the name; AI titles and broken lines are not', () => {
  assert.equal(newestClaudeName([
    line({ type: 'custom-title', customTitle: 'Fix login', sessionId: 's' }),
    line({ type: 'ai-title', aiTitle: 'Table context offer', sessionId: 's' }),
    '{"type":"custom-title","customTitle":',
    line({ type: 'custom-title', customTitle: ' Login redirect ', sessionId: 's' }),
    line({ type: 'user', message: { content: 'say "custom-title" please' } }),
  ]), 'Login redirect');
  assert.equal(newestClaudeName([line({ type: 'ai-title', aiTitle: 'Table context offer' })]), undefined);
});

test('only a name within the tail Claude reads counts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'act-native-names-'));
  try {
    const file = join(directory, 'session.jsonl'), filler = line({ type: 'assistant', text: 'x'.repeat(1000) }) + '\n';
    await writeFile(file, line({ type: 'custom-title', customTitle: 'Buried' }) + '\n' + filler.repeat(Math.ceil(CLAUDE_NAME_TAIL_BYTES / filler.length) + 1));
    assert.equal(await readClaudeName(file), undefined);
    await writeFile(file, filler.repeat(80) + line({ type: 'custom-title', customTitle: 'Fix login' }) + '\n');
    assert.equal(await readClaudeName(file), 'Fix login');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a name sent to a CLI is one trimmed line of at most 200 characters', () => {
  assert.equal(nativeName('  Fix\n login  '), 'Fix login');
  assert.equal(nativeName('a'.repeat(300)).length, 200);
});
