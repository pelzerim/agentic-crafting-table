import test from 'node:test';
import assert from 'node:assert/strict';
import { humanError } from './error-copy.ts';

test('app-written sentences stay as they are, without a Details disclosure', () => {
  assert.deepEqual(humanError('One of these items is no longer available.'), { message: 'One of these items is no longer available.' });
  assert.deepEqual(humanError('This connection changed after removal. Undo cannot replace it.'), { message: 'This connection changed after removal. Undo cannot replace it.' });
  assert.deepEqual(humanError('The PR is already merged on GitHub.'), { message: 'The PR is already merged on GitHub.' });
});

test('IPC wrappers are removed and the raw message moves behind Details', () => {
  const raw = "Error invoking remote method 'workspace:request': Error: This to-do is no longer available.";
  assert.deepEqual(humanError(raw), { message: 'This to-do is no longer available.', details: raw });
});

test('technical failures get human copy and keep the raw text as details', () => {
  const cases: [string, string][] = [
    ["Error invoking remote method 'item:move': TypeError: Cannot read properties of undefined (reading 'x')", 'That didn’t work. Your table is unchanged.'],
    ["spawn ENOENT: no such file or directory, chdir '/Users/someone/src/old'", 'A file or folder it needed is missing.'],
    ['EACCES: permission denied, open /tmp/x', 'Permission was denied.'],
    ['connect ECONNREFUSED /tmp/agent-crafting-table-1000/abc.sock', 'The workspace service isn’t responding.'],
    ['SqliteError: database is locked', 'The workspace database couldn’t be updated.'],
    ['fetch failed', 'Couldn’t reach the provider. Try again in a moment.'],
    ['Request timed out after 30000ms', 'It took too long to respond. Try again.'],
  ];
  for (const [raw, message] of cases) assert.deepEqual(humanError(raw), { message, details: raw }, raw);
});

test('an empty failure still says something', () => {
  assert.deepEqual(humanError(''), { message: 'That didn’t work. Your table is unchanged.' });
});
