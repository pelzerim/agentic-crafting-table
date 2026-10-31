import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { killPty, parseWindowsProcesses, stopProcessTree } from './process-tree.ts';

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function shell(script: string) {
  const child = spawn('/bin/sh', ['-c', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  const [line] = await once(child.stdout, 'data') as [Buffer];
  return { child, reported: Number(line.toString().trim()) };
}

const posixOnly = { skip: process.platform === 'win32' };
test('a process that exits on request is not forced, and settling stops its descendants', posixOnly, async () => {
  const { child, reported } = await shell('sleep 30 & echo $!; wait');
  const signals: NodeJS.Signals[] = [];
  const tree = stopProcessTree({ pid: child.pid!, kill(signal) { signals.push(signal); child.kill(signal); } });
  await once(child, 'exit');
  tree.settle();
  await delay(1100);
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(isAlive(reported), false);
});

test('a process that ignores the request is forced after the grace period', posixOnly, async () => {
  const { child } = await shell(`trap '' TERM; echo 0; while :; do sleep 1; done`);
  const tree = stopProcessTree({ pid: child.pid!, kill: signal => child.kill(signal) });
  const [, signal] = await once(child, 'exit');
  tree.settle();
  assert.equal(signal, 'SIGKILL');
});

test('a preserved process is left running', posixOnly, async () => {
  const { child, reported } = await shell('sleep 30 & echo $!; wait');
  const tree = stopProcessTree({ pid: child.pid!, kill: signal => child.kill(signal) }, [reported]);
  await once(child, 'exit');
  tree.settle();
  assert.equal(isAlive(reported), true);
  process.kill(reported, 'SIGKILL');
});

test('a Windows parent younger than its child is a reused ID, not a parent', () => {
  const listed = parseWindowsProcesses('10 4 500\r\n20 10 600\r\n30 10 400\r\n\r\nnoise\r\n');
  assert.deepEqual(listed.map(process => [process.pid, process.parent]), [[10, 4], [20, 10], [30, 0]]);
});

test('a Windows pseudo-terminal is stopped once and is never sent a signal', () => {
  const calls: (string | undefined)[] = [], pty = { kill(signal?: string) { calls.push(signal); } };
  killPty(pty, 'SIGTERM', 'win32'); killPty(pty, 'SIGKILL', 'win32');
  assert.deepEqual(calls, [undefined]);
  killPty(pty, 'SIGTERM', 'linux');
  assert.deepEqual(calls, [undefined, 'SIGTERM']);
});

test('on Windows a process and its descendants are stopped', { skip: process.platform !== 'win32' }, async () => {
  const child = spawn(process.execPath, ['-e', `const { spawn } = require('node:child_process'); const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); console.log(kid.pid); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'ignore'] });
  const [line] = await once(child.stdout, 'data') as [Buffer], descendant = Number(String(line).trim());
  const tree = stopProcessTree({ pid: child.pid!, kill: signal => child.kill(signal) });
  await once(child, 'exit'); tree.settle();
  await delay(200);
  assert.equal(isAlive(descendant), false);
});
