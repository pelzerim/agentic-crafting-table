import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import test from 'node:test';

test('a hook gives up by itself when it never gets an answer, so no process stays behind', { timeout: 8_000 }, async t => {
  const hook = spawn(process.execPath, [join(import.meta.dirname, 'agent-hook.ts'), 'directory', 'node', 'session', 'launch'], { stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(() => hook.kill('SIGKILL'));
  const [code] = await once(hook, 'exit');
  assert.equal(code, 0);
});
