import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeJournal } from './journal.ts';
import { outputSuffix } from './output-tail.ts';
import { sessionPageSchema } from './protocol.ts';

test('terminal suffixes preserve whole Unicode characters at every byte boundary', () => {
  for (const data of ['🌲🌲', 'Grüße 世界', '界x🌲END']) {
    for (let budget = 1; budget <= Buffer.byteLength(data) + 1; budget++) {
      const tail = outputSuffix(data, budget);
      assert.ok(data.endsWith(tail)); assert.ok(Buffer.byteLength(tail) <= budget);
      assert.ok(!tail.includes('\uFFFD'));
    }
  }
});

test('v1 runtime journal migrates without discarding session identity or inventing missing history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-journal-upgrade-')), path = join(directory, 'supervisor.sqlite');
  const original = { id: 'old-session', requestId: 'old-request', state: 'exited', nodeId: 'old-node', cwd: directory };
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE owner (id INTEGER PRIMARY KEY, instance TEXT, pid INTEGER); CREATE TABLE sessions (id TEXT PRIMARY KEY, request_id TEXT UNIQUE, request TEXT, body TEXT); PRAGMA user_version=1');
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(original.id, original.requestId, '{}', JSON.stringify(original)); db.close();
  let journal = new RuntimeJournal(path, 'test');
  try {
    const backup = new DatabaseSync(path + '.before-v2.sqlite', { readOnly: true });
    assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 1);
    assert.equal(JSON.parse(String(backup.prepare('SELECT body FROM sessions').get()!.body)).id, original.id); backup.close();
    assert.deepEqual(journal.get(original.id), original);
    assert.equal(journal.get(original.id).recordingComplete, undefined);
    journal.append(original.id, [{ sequence: 100, data: 'old retained tail' }]);
    journal.append(original.id, [{ sequence: 100, data: 'duplicate' }, { sequence: 101, data: 'next' }]);
    journal.close(); journal = new RuntimeJournal(path, 'reopened');
    assert.deepEqual(journal.history(original.id, 0, 100), [{ sequence: 100, data: 'old retained tail' }]);
    assert.equal(journal.lastSequence(original.id), 101);
  } finally { journal.close(); await rm(directory, { recursive: true, force: true }); }
});

test('v2 runtime journal is backed up before enforcing deletion-aware version 3 readers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-journal-v3-')), path = join(directory, 'supervisor.sqlite');
  const db = new DatabaseSync(path);
  const session = { id: 'saved', requestId: 'request', nodeId: 'node', state: 'exited', recordingComplete: true };
  db.exec('CREATE TABLE owner (id INTEGER PRIMARY KEY, instance TEXT, pid INTEGER); CREATE TABLE sessions (id TEXT PRIMARY KEY, request_id TEXT UNIQUE, request TEXT, body TEXT); CREATE TABLE output (session_id TEXT, sequence INTEGER, data TEXT, PRIMARY KEY(session_id,sequence)); PRAGMA user_version=2');
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('saved', 'request', '{}', JSON.stringify(session));
  db.prepare('INSERT INTO output VALUES(?,?,?)').run('saved', 1, 'RETAINED'); db.close();
  const journal = new RuntimeJournal(path, 'test');
  try {
    assert.deepEqual(journal.get('saved'), session); assert.equal(journal.history('saved', 0, 1)[0].data, 'RETAINED');
    const backup = new DatabaseSync(path + '.before-v3.sqlite', { readOnly: true });
    assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 2); assert.equal(backup.prepare('SELECT data FROM output').get()!.data, 'RETAINED'); backup.close();
  } finally { journal.close(); }
  try {
    const upgraded = new DatabaseSync(path); assert.equal(upgraded.prepare('PRAGMA user_version').get()!.user_version, 3);
    upgraded.exec('PRAGMA user_version=4'); upgraded.close();
    assert.throws(() => new RuntimeJournal(path, 'older-reader'), /newer app version/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('history merges durable and pending output in bounded pages without forcing persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-journal-read-'));
  const journal = new RuntimeJournal(join(directory, 'supervisor.sqlite'), 'test');
  try {
    journal.reserve({ sessionId: 's', requestId: 'r', nodeId: 'n', workspaceId: 'w', cwd: directory, executable: '/bin/sh', args: [], cols: 80, rows: 24 });
    const chunks = Array.from({ length: 180 }, (_, i) => ({ sequence: i + 1, data: `line ${i}\n` }));
    journal.append('s', chunks.slice(0, 100));
    const pending = chunks.slice(100);
    assert.deepEqual(journal.history('s', 0, 180, pending), chunks.slice(0, 128));
    assert.deepEqual(journal.history('s', 128, 180, pending), chunks.slice(128));
    assert.deepEqual(journal.history('s', 95, 105, pending), chunks.slice(95, 105));
    assert.deepEqual(journal.history('s', 180, 180, pending), []);
    assert.equal(journal.lastSequence('s'), 100, 'reading does not trigger a durable write');
    journal.append('s', pending);
    assert.deepEqual(journal.history('s', 128, 180), chunks.slice(128), 'flushing changes no reader sequence');
    const large = Array.from({ length: 8 }, (_, i) => ({ sequence: 181 + i, data: 'x'.repeat(64 * 1024) }));
    const page = journal.history('s', 180, 188, large);
    assert.equal(page.length, 4); assert.equal(page.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.data), 0), 256 * 1024);
  } finally { journal.close(); await rm(directory, { recursive: true, force: true }); }
});

test('durable tail returns ordered recent output within byte and chunk budgets and respects deletion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-journal-tail-'));
  const journal = new RuntimeJournal(join(directory, 'supervisor.sqlite'), 'test');
  try {
    const request = { sessionId: 's', requestId: 'r', nodeId: 'n', workspaceId: 'w', cwd: directory, executable: '/bin/sh', args: [], cols: 80, rows: 24 };
    journal.reserve(request);
    assert.deepEqual(journal.tail('s', 256 * 1024, 4096), { chunks: [], bytes: 0, sequence: 0, truncated: false });
    const chunks = Array.from({ length: 5000 }, (_, i) => ({ sequence: i + 1, data: `line ${i}\n` }));
    journal.append('s', chunks);
    const tail = journal.tail('s', 256 * 1024, 4096);
    assert.deepEqual(tail.chunks, chunks.slice(-4096)); assert.equal(tail.sequence, 5000); assert.equal(tail.truncated, true);
    const large = Array.from({ length: 5 }, (_, i) => ({ sequence: 5001 + i, data: String(i).repeat(64 * 1024) }));
    journal.append('s', large);
    assert.deepEqual(journal.tail('s', 256 * 1024, 4096).chunks, large.slice(-4));
    assert.equal(journal.tail('s', 256 * 1024, 4096).bytes, 256 * 1024);
    const huge = '🌲'.repeat(100_000) + 'END';
    journal.append('s', [{ sequence: 5006, data: huge }]);
    const oversized = journal.tail('s', 256 * 1024, 4096);
    assert.equal(oversized.chunks.length, 1); assert.equal(oversized.chunks[0].sequence, 5006);
    assert.ok(oversized.bytes <= 256 * 1024); assert.ok(oversized.chunks[0].data.endsWith('END')); assert.equal(oversized.truncated, true);
    assert.equal(journal.history('s', 5005, 5006)[0].data, huge, 'tail trimming never modifies durable history');
    journal.update('s', { state: 'exited' }); journal.manage('s', 'archive'); journal.deleteRecording('s');
    assert.deepEqual(journal.tail('s', 256 * 1024, 4096), { chunks: [], bytes: 0, sequence: 0, truncated: false });
  } finally { journal.close(); await rm(directory, { recursive: true, force: true }); }
});

test('recording deletion is explicit, stopped-only and durable without forgetting launch identity or another recording', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-recording-cleanup-')), path = join(directory, 'supervisor.sqlite');
  let journal = new RuntimeJournal(path, 'test');
  try {
    const request = { sessionId: 's', requestId: 'r', nodeId: 'n', workspaceId: 'w', cwd: directory, executable: '/bin/sh', args: [], cols: 80, rows: 24 };
    journal.reserve(request); journal.append('s', [{ sequence: 1, data: 'private recording' }]);
    assert.throws(() => journal.deleteRecording('s'), { code: 'SESSION_RUNNING' });
    assert.equal(journal.history('s', 0, 10).length, 1);
    journal.reserve({ ...request, sessionId: 'other', requestId: 'other' }); journal.append('other', [{ sequence: 1, data: 'KEEP' }]);
    journal.update('s', { state: 'exited', native: { provider: 'codex', nativeSessionId: 'native-id', status: 'idle', observedAt: 'saved' } });
    assert.throws(() => journal.deleteRecording('s'), { code: 'SESSION_NOT_ARCHIVED' });
    journal.manage('s', 'archive'); journal.manage('s', 'remove');
    assert.equal(journal.recordings().recordings.find(entry => entry.id === 's')!.hasOutput, true, 'dismissed entries remain discoverable for storage cleanup');
    const deleted = journal.deleteRecording('s');
    assert.ok(deleted.recordingDeletedAt); assert.equal(deleted.native!.nativeSessionId, 'native-id');
    assert.deepEqual(journal.deleteRecording('s'), deleted);
    journal.append('s', [{ sequence: 1, data: 'late cached write' }]);
    assert.deepEqual(journal.history('s', 0, 10, [{ sequence: 1, data: 'late pending read' }]), []);
    assert.deepEqual(journal.history('s', 0, 10), []); assert.equal(journal.history('other', 0, 10)[0].data, 'KEEP');
    assert.equal(journal.reserve(request).fresh, false);
    journal.close(); journal = new RuntimeJournal(path, 'reopened');
    assert.deepEqual(journal.history('s', 0, 10), []); assert.equal(journal.get('s').recordingDeletedAt, deleted.recordingDeletedAt);
    const resumed = journal.reserve({ ...request, sessionId: 'resumed', requestId: 'resumed', predecessorId: 's' });
    assert.equal(resumed.session.recordingDeletedAt, undefined, 'a new native resume records its new output');
  } finally { journal.close(); await rm(directory, { recursive: true, force: true }); }
});

test('recording inventory is bounded and walks stable journal identities with metadata only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-recording-list-'));
  const journal = new RuntimeJournal(join(directory, 'supervisor.sqlite'), 'test');
  try {
    for (let i = 0; i < 45; i++) {
      journal.reserve({ sessionId: `s${i}`, requestId: `r${i}`, nodeId: 'n', workspaceId: 'w', cwd: '/PRIVATE_FOLDER', executable: '/bin/sh', args: ['PRIVATE_PROMPT'], cols: 80, rows: 24 });
      journal.append(`s${i}`, [{ sequence: 1, data: 'PRIVATE_OUTPUT' }]);
    }
    const first = journal.recordings(), second = journal.recordings(first.nextBefore), last = journal.recordings(second.nextBefore);
    assert.deepEqual([first.recordings.length, second.recordings.length, last.recordings.length], [20, 20, 5]);
    assert.equal(last.nextBefore, undefined); assert.equal(new Set([...first.recordings, ...second.recordings, ...last.recordings].map(entry => entry.id)).size, 45);
    assert.ok(first.allocatedBytes > 0); assert.ok(first.reusableBytes >= 0); assert.doesNotMatch(JSON.stringify(first), /PRIVATE/);
  } finally { journal.close(); await rm(directory, { recursive: true, force: true }); }
});

test('managed sessions archive and dismiss without losing history, deduplication or internal recovery visibility', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-journal-management-')), path = join(directory, 'supervisor.sqlite');
  let journal = new RuntimeJournal(path, 'test');
  try {
    const request = { sessionId: 's', requestId: 'r', nodeId: 'n', workspaceId: 'w', cwd: directory, executable: '/bin/sh', args: [], cols: 80, rows: 24 };
    journal.reserve(request);
    assert.equal(journal.managed().length, 1);
    assert.throws(() => journal.manage('s', 'remove'), { code: 'SESSION_RUNNING' });
    const archived = journal.manage('s', 'archive');
    assert.deepEqual(journal.manage('s', 'archive'), archived, 'exact retry does not change metadata');
    assert.equal(journal.managed().length, 0); assert.equal(journal.managed('archived').length, 1);
    assert.equal(journal.list().length, 1, 'shutdown/recovery still see archived processes');
    journal.update('s', { state: 'running', pid: 1234 });
    journal.append('s', [{ sequence: 1, data: 'retained recording' }]);
    journal.close(); journal = new RuntimeJournal(path, 'reopened');
    assert.equal(journal.managed('archived')[0].state, 'lost');
    assert.equal(journal.get('s').archivedAt, archived.archivedAt);
    journal.manage('s', 'restore'); assert.equal(journal.managed().length, 1);
    assert.throws(() => journal.manage('s', 'remove'), { code: 'SESSION_NOT_ARCHIVED' });
    journal.manage('s', 'archive');
    const removed = journal.manage('s', 'remove');
    assert.deepEqual(journal.manage('s', 'remove'), removed);
    assert.equal(journal.managed('all').length, 0);
    assert.throws(() => journal.manage('s', 'restore'), { code: 'SESSION_REMOVED' });
    journal.close(); journal = new RuntimeJournal(path, 'again');
    assert.equal(journal.managed('all').length, 0);
    assert.equal(journal.reserve(request).fresh, false, 'dismissal cannot relaunch a process on retry');
    assert.deepEqual(journal.history('s', 0, 1), [{ sequence: 1, data: 'retained recording' }]);
    assert.equal(journal.get('s').nodeId, 'n');
  } finally { journal.close(); await rm(directory, { recursive: true, force: true }); }
});

test('native resume inherits archive visibility while an explicit new run of a removed session is visible', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-journal-lineage-'));
  const journal = new RuntimeJournal(join(directory, 'supervisor.sqlite'), 'test');
  try {
    const request = { sessionId: 'first', requestId: 'first', nodeId: 'n', workspaceId: 'w', cwd: directory, executable: '/bin/sh', args: [], cols: 80, rows: 24 };
    journal.reserve(request); journal.update('first', { state: 'exited' }); const first = journal.manage('first', 'archive');
    const second = journal.reserve({ ...request, sessionId: 'second', requestId: 'second', predecessorId: 'first' });
    assert.equal(second.session.archivedAt, first.archivedAt); assert.equal(second.session.predecessorId, 'first');
    assert.equal(journal.managed().length, 0); assert.equal(journal.list().length, 2);
    assert.throws(() => journal.reserve({ ...request, sessionId: 'wrong', requestId: 'wrong', nodeId: 'other', predecessorId: 'first' }), /another item/);
    journal.manage('first', 'remove');
    const third = journal.reserve({ ...request, sessionId: 'third', requestId: 'third', predecessorId: 'first' });
    assert.equal(third.session.archivedAt, undefined); assert.equal(third.session.removedAt, undefined);
    assert.deepEqual(journal.managed().map(session => session.id), ['third']);
    const imported = journal.reserve({ ...request, sessionId: 'imported', requestId: 'imported', predecessorId: 'old-unavailable-runtime' });
    assert.equal(imported.fresh, true, 'native conversations remain resumable when the old runtime record is unavailable');
  } finally { journal.close(); await rm(directory, { recursive: true, force: true }); }
});

test('session pages filter current, ended and archived entries with counts and newest-ended-first paging', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-journal-page-')), journal = new RuntimeJournal(join(directory, 'supervisor.sqlite'), 'test');
  const pause = () => new Promise(resolve => setTimeout(resolve, 3));
  try {
    const reserve = (id: string) => journal.reserve({ sessionId: id, requestId: `r-${id}`, nodeId: 'n', workspaceId: 'w', cwd: directory, executable: '/bin/sh', args: [], cols: 80, rows: 24 });
    reserve('starting'); reserve('running'); journal.update('running', { state: 'running' });
    reserve('stopping'); journal.update('stopping', { state: 'running', stopRequestedAt: new Date().toISOString() });
    for (let index = 0; index < 55; index++) { reserve(`ended-${index}`); journal.update(`ended-${index}`, { state: (['exited', 'failed', 'lost'] as const)[index % 3] }); await pause(); }
    journal.update('ended-0', { exitCode: 0 });
    reserve('archived-running'); journal.update('archived-running', { state: 'running' }); journal.manage('archived-running', 'archive');
    reserve('archived-ended'); journal.update('archived-ended', { state: 'exited' }); journal.manage('archived-ended', 'archive');
    reserve('removed'); journal.update('removed', { state: 'exited' }); journal.manage('removed', 'archive'); journal.manage('removed', 'remove');
    const counts = { current: 3, ended: 55, archived: 2 };
    const current = journal.page({ view: 'current', offset: 0, limit: 50 });
    assert.deepEqual(current.sessions.map(session => session.id), ['starting', 'running', 'stopping']);
    assert.deepEqual(current.counts, counts); assert.equal(current.total, 3);
    const ended = journal.page({ view: 'ended', offset: 0, limit: 50 });
    assert.equal(ended.total, 55); assert.equal(ended.sessions.length, 50);
    assert.deepEqual(ended.sessions.slice(0, 3).map(session => session.id), ['ended-0', 'ended-54', 'ended-53']);
    assert.ok(ended.sessions.every(session => ['exited', 'failed', 'lost'].includes(session.state) && !session.archivedAt));
    const more = journal.page({ view: 'ended', offset: 50, limit: 50 });
    assert.deepEqual(more.sessions.map(session => session.id), ['ended-5', 'ended-4', 'ended-3', 'ended-2', 'ended-1']);
    assert.deepEqual(journal.page({ view: 'archived', offset: 0, limit: 50 }).sessions.map(session => session.id), ['archived-running', 'archived-ended']);
    // The broad lists keep their prior meaning for MCP and internal callers.
    assert.equal(journal.managed('active').length, 58); assert.equal(journal.managed('archived').length, 2); assert.equal(journal.list().length, 61);
  } finally { journal.close(); await rm(directory, { recursive: true, force: true }); }
});

test('the session page request defaults to the first 50 current sessions and bounds paging', () => {
  assert.deepEqual(sessionPageSchema.parse({}), { view: 'current', offset: 0, limit: 50 });
  assert.equal(sessionPageSchema.safeParse({ view: 'ended', limit: 0 }).success, false);
  assert.equal(sessionPageSchema.safeParse({ view: 'stopped' }).success, false);
  assert.equal(sessionPageSchema.safeParse({ view: 'ended', offset: -1 }).success, false);
});
