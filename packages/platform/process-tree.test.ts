import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { stopProcessTree } from './process-tree.ts';

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function shell(script: string) {
  const child = spawn('/bin/sh', ['-c', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  const [line] = await once(child.stdout, 'data') as [Buffer];
  return { child, reported: Number(line.toString().trim()) };
}

test('a process that exits on request is not forced, and settling stops its descendants', async () => {
  const { child, reported } = await shell('sleep 30 & echo $!; wait');
  const signals: NodeJS.Signals[] = [];
  const tree = stopProcessTree({ pid: child.pid!, kill(signal) { signals.push(signal); child.kill(signal); } });
  await once(child, 'exit');
  tree.settle();
  await delay(1100);
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(isAlive(reported), false);
});

test('a process that ignores the request is forced after the grace period', async () => {
  const { child } = await shell(`trap '' TERM; echo 0; while :; do sleep 1; done`);
  const tree = stopProcessTree({ pid: child.pid!, kill: signal => child.kill(signal) });
  const [, signal] = await once(child, 'exit');
  tree.settle();
  assert.equal(signal, 'SIGKILL');
});

test('a preserved process is left running', async () => {
  const { child, reported } = await shell('sleep 30 & echo $!; wait');
  const tree = stopProcessTree({ pid: child.pid!, kill: signal => child.kill(signal) }, [reported]);
  await once(child, 'exit');
  tree.settle();
  assert.equal(isAlive(reported), true);
  process.kill(reported, 'SIGKILL');
});
