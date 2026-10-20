import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RotatingLog } from './rotating-log.ts';

test('diagnostic log bounds every file and keeps the newest bytes over rotation and restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'craft-logs-')), path = join(directory, 'service.log');
  try {
    const log = new RotatingLog(path, 1024, 2); log.write('old '.repeat(1500)); log.write('FINAL'); log.close();
    assert.equal(readdirSync(directory).length, 3);
    for (const file of readdirSync(directory)) { assert.ok(statSync(join(directory, file)).size <= 1024); assert.equal(statSync(join(directory, file)).mode & 0o777, 0o600); }
    assert.ok(readFileSync(path, 'utf8').endsWith('FINAL'));
    const reopened = new RotatingLog(path, 1024, 2); reopened.write(' · reopened'); reopened.close(); assert.ok(readFileSync(path, 'utf8').endsWith('FINAL · reopened'));
    assert.throws(() => reopened.write('lost'), /closed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('old oversized diagnostic logs keep a bounded tail without touching terminal data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'craft-log-upgrade-')), path = join(directory, 'service.log');
  try {
    writeFileSync(path, 'a'.repeat(2048) + 'old tail'); writeFileSync(join(directory, 'supervisor.sqlite'), 'never alter recordings');
    const log = new RotatingLog(path, 1024, 1); log.write('next'); log.close();
    assert.equal(statSync(path + '.1').size, 1024); assert.ok(readFileSync(path + '.1', 'utf8').endsWith('old tail')); assert.equal(readFileSync(path, 'utf8'), 'next'); assert.equal(readFileSync(join(directory, 'supervisor.sqlite'), 'utf8'), 'never alter recordings');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('diagnostic log rejects symlinks and unsafe rotation targets without modifying their contents', () => {
  const directory = mkdtempSync(join(tmpdir(), 'craft-log-safety-')), path = join(directory, 'service.log');
  try {
    const target = join(directory, 'target'); writeFileSync(target, 'protected'); symlinkSync(target, path); assert.throws(() => new RotatingLog(path), /regular file/); assert.equal(readFileSync(target, 'utf8'), 'protected');
    rmSync(path); const log = new RotatingLog(path, 1024, 1); symlinkSync(target, path + '.1'); log.write('a'.repeat(1024)); assert.throws(() => log.write('next'), /regular file/); log.close(); assert.equal(readFileSync(target, 'utf8'), 'protected');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('reducing diagnostic retention trims each retained tail and removes only excess backups', () => {
  const directory = mkdtempSync(join(tmpdir(), 'craft-log-policy-')), path = join(directory, 'service.log');
  try {
    writeFileSync(join(directory, 'recording'), 'KEEP_HISTORY');
    const log = new RotatingLog(path, 4096, 3); log.write('x'.repeat(15000) + 'LATEST');
    log.reconfigure(1024, 1); log.write('MORE'); log.close();
    assert.ok(statSync(path).size <= 1024); assert.ok(statSync(path + '.1').size <= 1024);
    assert.ok(readFileSync(path + '.1', 'utf8').endsWith('LATEST')); assert.equal(readFileSync(path, 'utf8'), 'MORE');
    assert.deepEqual(readdirSync(directory).sort(), ['recording', 'service.log', 'service.log.1']);
    assert.equal(readFileSync(join(directory, 'recording'), 'utf8'), 'KEEP_HISTORY');
    log.reconfigure(1024, 1); log.write('REOPENED'); log.close();
    assert.match(readFileSync(path, 'utf8'), /MOREREOPENED/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
