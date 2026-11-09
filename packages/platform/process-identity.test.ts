import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import { isProcessRunning, processStart } from './process-identity.ts';

test('a recorded process runs only while its ID still names the process that started then', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const started = processStart(child.pid!);
    assert.ok(started);
    assert.equal(isProcessRunning(child.pid!, started), true);
    assert.equal(isProcessRunning(child.pid!, `${started}-earlier`), false, 'a reused ID names a different process');
    assert.equal(isProcessRunning(child.pid!, null), true, 'an owner recorded without a start time cannot be told apart from a reused ID');
  } finally { child.kill(); await once(child, 'exit'); }
  assert.equal(processStart(child.pid!), undefined);
  assert.equal(isProcessRunning(child.pid!, null), false);
});

test('a thread ID is not a process, although Linux accepts signals for it', { skip: process.platform !== 'linux' }, () => {
  const thread = readdirSync('/proc/self/task').map(Number).find(id => id !== process.pid);
  assert.ok(thread, 'Node.js runs helper threads');
  assert.doesNotThrow(() => process.kill(thread, 0));
  assert.equal(processStart(thread), undefined);
  assert.equal(isProcessRunning(thread, null), false);
});

test('an invalid recorded ID is refused', () => {
  for (const pid of [0, -1, 1.5, Number.NaN]) assert.throws(() => processStart(pid), /Invalid process ID/);
});
