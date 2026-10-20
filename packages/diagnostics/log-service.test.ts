import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runLoggedService } from './log-service.ts';

test('service diagnostics capture both streams, bounded crash output, and restart independently of recordings', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'craft-service-log-')), entrypoint = join(directory, 'service.mjs');
  try {
    writeFileSync(join(directory, 'scrollback.json'), 'PRIVATE RECORDING');
    writeFileSync(entrypoint, String.raw`process.stdout.write('a'.repeat(20000)); process.stderr.write('CRASH_SENTINEL\n'); process.exitCode = 7;`);
    assert.equal(await runLoggedService({ directory, entrypoint, limit: 1024 }), 7);
    const combined = [2, 1, 0].map(index => readFileSync(join(directory, `service.log${index ? '.' + index : ''}`), 'utf8')).join('');
    assert.match(combined, /CRASH_SENTINEL/); assert.match(combined, /Service stopped \(7\)/); assert.doesNotMatch(combined, /PRIVATE RECORDING/);
    for (const suffix of ['', '.1', '.2']) assert.ok(statSync(join(directory, 'service.log' + suffix)).size <= 1024);
    assert.equal(statSync(join(directory, 'diagnostic-owner.sqlite')).mode & 0o777, 0o600);
    writeFileSync(entrypoint, `process.stderr.write('RESTART_OK\\n');`);
    assert.equal(await runLoggedService({ directory, entrypoint, limit: 1024 }), 0);
    assert.match(readFileSync(join(directory, 'service.log'), 'utf8'), /RESTART_OK/);
    assert.equal(readFileSync(join(directory, 'scrollback.json'), 'utf8'), 'PRIVATE RECORDING');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('simultaneous log owners never launch a second service or rotate the active writer', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'craft-service-owner-')), entrypoint = join(directory, 'service.mjs'), pidPath = join(directory, 'pid');
  let pid: number | undefined, running: Promise<number> | undefined;
  try {
    writeFileSync(entrypoint, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.stdout.write('ONE_SERVICE\\n'); setInterval(()=>{},1000);`);
    running = runLoggedService({ directory, entrypoint });
    const deadline = Date.now() + 3000;
    while (!existsSync(pidPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    pid = Number(readFileSync(pidPath, 'utf8'));
    while (!readFileSync(join(directory, 'service.log'), 'utf8').includes('ONE_SERVICE') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(readFileSync(join(directory, 'service.log'), 'utf8'), /ONE_SERVICE/);
    assert.equal(await runLoggedService({ directory, entrypoint }), 0);
    assert.equal(Number(readFileSync(pidPath, 'utf8')), pid);
    process.kill(pid, 'SIGTERM'); await running; running = undefined; pid = undefined;
    assert.equal(readFileSync(join(directory, 'service.log'), 'utf8').match(/ONE_SERVICE/g)?.length, 1);
    const db = new DatabaseSync(join(directory, 'diagnostic-owner.sqlite')); assert.equal(db.prepare('SELECT * FROM owner').all().length, 0); db.close();
  } finally {
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    if (running) await running;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('service spawn failures are bounded diagnostics and release ownership for a later attempt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'craft-service-spawn-'));
  try {
    assert.equal(await runLoggedService({ directory, entrypoint: 'unused', executable: join(directory, 'missing') }), 1);
    assert.match(readFileSync(join(directory, 'service.log'), 'utf8'), /could not start \(ENOENT\)/);
    const db = new DatabaseSync(join(directory, 'diagnostic-owner.sqlite')); assert.equal(db.prepare('SELECT * FROM owner').all().length, 0); db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('private child policy updates persist so a larger retained tail survives the next log-owner startup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'craft-log-settings-')), entrypoint = join(directory, 'service.mjs');
  try {
    writeFileSync(entrypoint, `import {DatabaseSync} from 'node:sqlite';
      process.send({kind:'diagnostic-policy',policy:{fileMiB:2,backups:0}});
      const until=Date.now()+5000; const timer=setInterval(()=>{
        const db=new DatabaseSync(${JSON.stringify(join(directory, 'diagnostic-owner.sqlite'))}); db.exec('PRAGMA busy_timeout=2000'); const row=db.prepare('SELECT body FROM policy WHERE id=1').get(); db.close();
        if(row && JSON.parse(row.body).fileMiB===2) { clearInterval(timer); process.stdout.write('RETAIN_ME'+ 'x'.repeat(1500000),()=>process.disconnect()); }
        else if(Date.now()>until) { clearInterval(timer); process.disconnect(); process.exitCode=1; }
      },10);`);
    assert.equal(await runLoggedService({ directory, entrypoint }), 0);
    assert.match(readFileSync(join(directory, 'service.log'), 'utf8'), /RETAIN_ME/);
    writeFileSync(entrypoint, `process.stdout.write('REOPENED');`);
    assert.equal(await runLoggedService({ directory, entrypoint }), 0);
    assert.match(readFileSync(join(directory, 'service.log'), 'utf8'), /RETAIN_ME/); assert.match(readFileSync(join(directory, 'service.log'), 'utf8'), /REOPENED/);
    assert.ok(statSync(join(directory, 'service.log')).size > 1024 * 1024);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('log-owner startup finishes retention cleanup interrupted after saving the new policy', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'craft-log-policy-crash-')), entrypoint = join(directory, 'service.mjs');
  try {
    const db = new DatabaseSync(join(directory, 'diagnostic-owner.sqlite'));
    db.exec('CREATE TABLE policy (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    db.prepare('INSERT INTO policy VALUES(1,?)').run(JSON.stringify({ fileMiB: 1, backups: 0 })); db.close();
    // The policy commit survived, but old diagnostic files still need trimming.
    writeFileSync(join(directory, 'service.log'), 'x'.repeat(2 * 1024 * 1024));
    writeFileSync(join(directory, 'service.log.1'), 'OLD_BACKUP');
    writeFileSync(join(directory, 'scrollback.json'), 'KEEP_RECORDING');
    writeFileSync(entrypoint, `process.stdout.write('RESTART_OK');`);
    assert.equal(await runLoggedService({ directory, entrypoint }), 0);
    assert.equal(existsSync(join(directory, 'service.log.1')), false);
    assert.ok(statSync(join(directory, 'service.log')).size <= 1024 * 1024);
    assert.equal(readFileSync(join(directory, 'scrollback.json'), 'utf8'), 'KEEP_RECORDING');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
