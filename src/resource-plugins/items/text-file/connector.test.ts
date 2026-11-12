import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject, ResourceRecord } from '../../types.ts';
import { MAXIMUM_EXCERPT_CHARACTERS, MAXIMUM_EXCERPT_LINES, MAXIMUM_TEXT_FILE_BYTES, textFileConnector } from './connector.ts';

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'act-text-file-')));
  const resource = (path: string): ResourceRecord => ({ id: 'file-r', pluginId: 'workspace.text', schemaVersion: 1, title: 'File', data: { path } });
  const run = (path: string, action: string, input: JsonObject = {}, signal = AbortSignal.timeout(10_000)) => textFileConnector.execute!(resource(path), action, signal, { path, ...input }) as Promise<JsonObject>;
  return { directory, resource, run, path: (name: string) => join(directory, name), close() { rmSync(directory, { recursive: true, force: true }); } };
}

test('a read gives the text and its version, and a write against that version replaces the file', async () => {
  const f = fixture();
  try {
    const path = f.path('plan.md'); writeFileSync(path, '# Plan\n\nÜber café 🚀\n');
    const read = await f.run(path, 'read');
    assert.equal(read.state, 'present'); assert.equal(read.text, '# Plan\n\nÜber café 🚀\n'); assert.equal(read.size, statSync(path).size); assert.equal(read.modifiedAt, statSync(path).mtimeMs);
    const written = await f.run(path, 'write', { text: '# Plan\n\nDone\n', baseVersion: read.version });
    assert.equal(written.state, 'written'); assert.notEqual(written.version, read.version);
    assert.equal(readFileSync(path, 'utf8'), '# Plan\n\nDone\n');
    const again = await f.run(path, 'read');
    assert.equal(again.version, written.version); assert.equal(again.modifiedAt, written.modifiedAt); assert.equal(again.size, written.size);
    assert.equal((await f.run(path, 'write', { text: '', baseVersion: again.version })).state, 'written');
    assert.equal(readFileSync(path, 'utf8'), '', 'a file can be emptied');
  } finally { f.close(); }
});

test('a write against a version the file no longer has changes nothing and returns what is on disk', async () => {
  const f = fixture();
  try {
    const path = f.path('notes.txt'); writeFileSync(path, 'first');
    const read = await f.run(path, 'read');
    writeFileSync(path, 'changed outside');
    const conflict = await f.run(path, 'write', { text: 'mine', baseVersion: read.version });
    assert.equal(conflict.state, 'conflict'); assert.equal((conflict.disk as JsonObject).state, 'present'); assert.equal((conflict.disk as JsonObject).text, 'changed outside');
    assert.equal(readFileSync(path, 'utf8'), 'changed outside');
    assert.equal((await f.run(path, 'write', { text: 'mine' })).state, 'conflict', 'a write that expects no file does not replace one');
    const kept = await f.run(path, 'write', { text: 'mine', baseVersion: (conflict.disk as JsonObject).version });
    assert.equal(kept.state, 'written'); assert.equal(readFileSync(path, 'utf8'), 'mine');
  } finally { f.close(); }
});

test('the version follows the content, so a file touched without a change is still writable', async () => {
  const f = fixture();
  try {
    const path = f.path('touched.txt'); writeFileSync(path, 'same');
    const read = await f.run(path, 'read');
    utimesSync(path, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    assert.equal((await f.run(path, 'read')).version, read.version);
    assert.equal((await f.run(path, 'write', { text: 'next', baseVersion: read.version })).state, 'written');
  } finally { f.close(); }
});

test('a missing file reads as missing, is created by the first write and is not recreated against an old version', async () => {
  const f = fixture();
  try {
    const path = f.path('drafts/new/idea.md');
    assert.deepEqual(await f.run(path, 'read'), { state: 'missing' }); assert.deepEqual(await f.run(path, 'stat'), { state: 'missing' });
    const created = await f.run(path, 'write', { text: 'idea' });
    assert.equal(created.state, 'written'); assert.equal(readFileSync(path, 'utf8'), 'idea');
    rmSync(path);
    assert.deepEqual(await f.run(path, 'write', { text: 'idea, edited', baseVersion: created.version }), { state: 'conflict', disk: { state: 'missing' } });
    assert.equal(readdirSync(f.path('drafts/new')).length, 0);
  } finally { f.close(); }
});

test('binary content, an oversized file and a path that is not a regular file are refused', async () => {
  const f = fixture();
  try {
    const invalid = f.path('image.png'), zeros = f.path('data.bin'), large = f.path('large.log'), folder = f.path('folder');
    writeFileSync(invalid, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe])); writeFileSync(zeros, Buffer.from('text\0more')); mkdirSync(folder);
    writeFileSync(large, 'x'); truncateSync(large, MAXIMUM_TEXT_FILE_BYTES + 1);
    for (const path of [invalid, zeros]) assert.deepEqual(await f.run(path, 'read'), { state: 'refused', reason: 'Not a text file' });
    assert.deepEqual(await f.run(large, 'read'), { state: 'refused', reason: 'File is larger than 2 MB' });
    assert.deepEqual(await f.run(folder, 'read'), { state: 'refused', reason: 'Not a file' });
    assert.deepEqual(await f.run('relative/file.md', 'read'), { state: 'refused', reason: 'Path is not absolute' });
    assert.deepEqual(await f.run(folder, 'write', { text: 'mine' }), { state: 'refused', reason: 'Not a file' });
    assert.deepEqual(await f.run(invalid, 'write', { text: 'mine' }), { state: 'refused', reason: 'Not a text file' });
    const small = f.path('small.txt'); writeFileSync(small, 'small');
    const read = await f.run(small, 'read');
    assert.deepEqual(await f.run(small, 'write', { text: 'é'.repeat(MAXIMUM_TEXT_FILE_BYTES / 2 + 1), baseVersion: read.version }), { state: 'refused', reason: 'File is larger than 2 MB' });
    assert.equal(readFileSync(small, 'utf8'), 'small'); assert.equal(readFileSync(invalid).length, 6);
    truncateSync(large, MAXIMUM_TEXT_FILE_BYTES); writeFileSync(large, 'y'.repeat(MAXIMUM_TEXT_FILE_BYTES));
    assert.equal((await f.run(large, 'read')).state, 'present', 'the limit itself is allowed');
  } finally { f.close(); }
});

test('the cheap check reports the modification time and size without reading the content', async () => {
  const f = fixture();
  try {
    const path = f.path('watched.txt'); writeFileSync(path, 'one');
    const read = await f.run(path, 'read'), before = await f.run(path, 'stat');
    assert.deepEqual(before, { state: 'present', modifiedAt: read.modifiedAt, size: 3 });
    writeFileSync(path, 'three'); utimesSync(path, new Date('2026-03-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z'));
    assert.deepEqual(await f.run(path, 'stat'), { state: 'present', modifiedAt: Date.parse('2026-03-01T00:00:00Z'), size: 5 });
    chmodSync(path, 0o000);
    try { assert.equal((await f.run(path, 'stat')).state, 'present'); } finally { chmodSync(path, 0o600); }
  } finally { f.close(); }
});

test('an excerpt is the first lines of the file, cut at a line end, and says whether that is the whole file', async () => {
  const f = fixture();
  try {
    const short = f.path('short.md'), long = f.path('long.log'), wide = f.path('wide.min.js'), unbroken = f.path('unbroken.txt');
    writeFileSync(short, '# Plan\n\nNo line end at the end');
    assert.deepEqual(await f.run(short, 'excerpt'), { state: 'present', text: '# Plan\n\nNo line end at the end', complete: true, modifiedAt: statSync(short).mtimeMs, size: statSync(short).size });
    writeFileSync(long, Array.from({ length: MAXIMUM_EXCERPT_LINES + 5 }, (_, index) => `line ${index + 1}\n`).join(''));
    const first = await f.run(long, 'excerpt');
    assert.equal(first.complete, false); assert.equal((first.text as string).split('\n').length - 1, MAXIMUM_EXCERPT_LINES); assert.ok((first.text as string).endsWith(`line ${MAXIMUM_EXCERPT_LINES}\n`));
    assert.equal(first.size, statSync(long).size, 'the size is the file\'s, not the excerpt\'s');
    writeFileSync(wide, `${'a'.repeat(MAXIMUM_EXCERPT_CHARACTERS - 100)}\n${'b'.repeat(200)}\nlast\n`);
    assert.deepEqual([(await f.run(wide, 'excerpt')).text, (await f.run(wide, 'excerpt')).complete], [`${'a'.repeat(MAXIMUM_EXCERPT_CHARACTERS - 100)}\n`, false], 'a line that would pass the limit is left out whole');
    writeFileSync(unbroken, `${'x'.repeat(MAXIMUM_EXCERPT_CHARACTERS - 1)}🚀 and more`);
    const cut = await f.run(unbroken, 'excerpt');
    assert.equal(cut.text, 'x'.repeat(MAXIMUM_EXCERPT_CHARACTERS - 1), 'a first line longer than the limit is cut without splitting a character'); assert.equal(cut.complete, false);
    assert.deepEqual(await f.run(f.path('gone.md'), 'excerpt'), { state: 'missing' });
    assert.deepEqual(await f.run(f.directory, 'excerpt'), { state: 'refused', reason: 'Not a file' });
  } finally { f.close(); }
});

test('a write replaces the file in one step: no temporary file stays, the mode is kept and a link still points at its file', async () => {
  const f = fixture();
  try {
    const path = f.path('script.sh'), link = f.path('link.sh'); writeFileSync(path, '#!/bin/sh\n'); chmodSync(path, 0o750); symlinkSync(path, link);
    const read = await f.run(link, 'read');
    assert.equal((await f.run(link, 'write', { text: '#!/bin/sh\necho hi\n', baseVersion: read.version })).state, 'written');
    assert.equal(readFileSync(path, 'utf8'), '#!/bin/sh\necho hi\n'); assert.equal(statSync(path).mode & 0o777, 0o750);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.deepEqual(readdirSync(f.directory).sort(), ['link.sh', 'script.sh']);
  } finally { f.close(); }
});

test('a file that may not be written is refused and stays as it is', async () => {
  const f = fixture();
  try {
    const path = f.path('locked.md'); writeFileSync(path, 'first'); chmodSync(path, 0o444);
    const read = await f.run(path, 'read');
    assert.deepEqual(await f.run(path, 'write', { text: 'mine', baseVersion: read.version }), { state: 'refused', reason: 'No permission to write the file' });
    assert.equal(readFileSync(path, 'utf8'), 'first'); assert.equal(statSync(path).mode & 0o777, 0o444);
    assert.deepEqual(readdirSync(f.directory), ['locked.md']);
  } finally { f.close(); }
});

test('a file in a folder that takes no new files is written in place, and a missing one there is refused', async () => {
  const f = fixture(), folder = f.path('sealed');
  try {
    const path = join(folder, 'notes.md'); mkdirSync(folder); writeFileSync(path, 'first'); chmodSync(path, 0o640); chmodSync(folder, 0o555);
    const read = await f.run(path, 'read');
    const written = await f.run(path, 'write', { text: 'mine', baseVersion: read.version });
    assert.equal(written.state, 'written'); assert.equal(readFileSync(path, 'utf8'), 'mine'); assert.equal(statSync(path).mode & 0o777, 0o640);
    assert.equal((await f.run(path, 'read')).version, written.version); assert.equal(written.size, 4);
    assert.equal((await f.run(path, 'write', { text: 'mine, and longer than before', baseVersion: written.version })).state, 'written');
    assert.equal(readFileSync(path, 'utf8'), 'mine, and longer than before');
    assert.deepEqual(await f.run(join(folder, 'new.md'), 'write', { text: 'new' }), { state: 'refused', reason: 'No permission to write the file' });
    assert.deepEqual(await f.run(join(folder, 'deeper', 'new.md'), 'write', { text: 'new' }), { state: 'refused', reason: 'No permission to write the file' });
    assert.deepEqual(readdirSync(folder), ['notes.md']);
  } finally { chmodSync(folder, 0o755); f.close(); }
});

test('a relative link in a folder reached through a link gets its file where the system resolves it', async () => {
  const f = fixture();
  try {
    mkdirSync(f.path('real/sub'), { recursive: true }); symlinkSync('real/sub', f.path('shortcut')); symlinkSync('../daily.md', f.path('real/sub/today.md'));
    const link = f.path('shortcut/today.md');
    assert.equal((await f.run(link, 'read')).state, 'missing');
    assert.equal((await f.run(link, 'write', { text: '# Today\n' })).state, 'written');
    assert.equal(readFileSync(f.path('real/daily.md'), 'utf8'), '# Today\n'); assert.equal((await f.run(link, 'read')).text, '# Today\n');
    assert.deepEqual(readdirSync(f.directory).sort(), ['real', 'shortcut']);
  } finally { f.close(); }
});

test('a path behind more links than are followed is refused and every link stays', async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 18; index++) symlinkSync(`link-${index + 1}.md`, f.path(`link-${index}.md`));
    assert.equal((await f.run(f.path('link-0.md'), 'read')).state, 'missing');
    assert.deepEqual(await f.run(f.path('link-0.md'), 'write', { text: 'mine' }), { state: 'refused', reason: 'Too many links to follow' });
    assert.equal(readdirSync(f.directory).length, 18);
    assert.equal(readdirSync(f.directory).every(name => lstatSync(f.path(name)).isSymbolicLink()), true);
  } finally { f.close(); }
});

test('a link that points at no file gets its file on the first write and stays a link', async () => {
  const f = fixture();
  try {
    const link = f.path('today.md'), target = f.path('2031-01-01.md'); symlinkSync('2031-01-01.md', link);
    assert.equal((await f.run(link, 'read')).state, 'missing');
    assert.equal((await f.run(link, 'write', { text: '# Today\n' })).state, 'written');
    assert.equal(lstatSync(link).isSymbolicLink(), true); assert.equal(readFileSync(target, 'utf8'), '# Today\n');
    assert.deepEqual(readdirSync(f.directory).sort(), ['2031-01-01.md', 'today.md']);
  } finally { f.close(); }
});

test('an action that names a path the item no longer has is refused, and a write has to name its path', async () => {
  const f = fixture();
  try {
    const path = f.path('now.md'), before = f.path('before.md'); writeFileSync(path, 'same'); writeFileSync(before, 'same');
    const read = await f.run(before, 'read');
    const refusal = { state: 'refused', reason: 'The item now edits another file' };
    assert.deepEqual(await f.run(path, 'write', { path: before, text: 'mine', baseVersion: read.version }), refusal);
    assert.deepEqual(await f.run(path, 'read', { path: before }), refusal);
    assert.deepEqual(await f.run(path, 'stat', { path: before }), refusal);
    assert.equal(readFileSync(path, 'utf8'), 'same');
    await assert.rejects(textFileConnector.execute!(f.resource(path), 'write', AbortSignal.timeout(10_000), { text: 'mine', baseVersion: read.version }), /path the text was read from/);
    assert.equal((await textFileConnector.execute!(f.resource(path), 'read', AbortSignal.timeout(10_000)) as JsonObject).state, 'present');
  } finally { f.close(); }
});

test('a write whose caller has gone changes nothing', async () => {
  const f = fixture();
  try {
    const path = f.path('kept.txt'); writeFileSync(path, 'kept');
    const read = await f.run(path, 'read');
    await assert.rejects(f.run(path, 'write', { text: 'lost', baseVersion: read.version }, AbortSignal.abort()));
    assert.equal(readFileSync(path, 'utf8'), 'kept');
  } finally { f.close(); }
});

test('a path under ~ is read from the home directory', async () => {
  const f = fixture(), home = process.env.HOME;
  try {
    process.env.HOME = f.directory; writeFileSync(f.path('home.md'), 'at home');
    assert.equal((await f.run('~/home.md', 'read')).text, 'at home');
  } finally { process.env.HOME = home; f.close(); }
});

test('the saved snapshot names the file and its state but never holds the content', async () => {
  const f = fixture();
  try {
    const path = f.path('secret.md'); writeFileSync(path, 'content that stays on disk');
    const present = await textFileConnector.load(f.resource(path), AbortSignal.timeout(10_000));
    assert.equal(present.connection, 'connected'); assert.equal(present.label, path); assert.equal(present.error, undefined);
    assert.equal(JSON.stringify(present).includes('content that stays'), false);
    const missing = await textFileConnector.load(f.resource(f.path('gone.md')), AbortSignal.timeout(10_000));
    assert.equal(missing.error, 'File missing'); assert.equal(missing.connection, 'connected');
    assert.equal((await textFileConnector.load(f.resource(f.directory), AbortSignal.timeout(10_000))).error, 'Not a file');
  } finally { f.close(); }
});

test('an agent gets the path as context and never the content, reads freely and cannot write', async () => {
  const f = fixture();
  try {
    const path = f.path('context.ts'); writeFileSync(path, 'export const answer = 42;\n');
    assert.deepEqual(await textFileConnector.getContext!(f.resource(path), AbortSignal.timeout(10_000)), { resourceId: 'file-r', title: 'File', content: `Path: ${path}\n\nRead the file at this path for its content.` });
    assert.equal((await textFileConnector.getContext!(f.resource(f.path('gone.ts')), AbortSignal.timeout(10_000))).content, `Path: ${f.path('gone.ts')}\n\nFile missing`);
    assert.equal((await textFileConnector.getContext!(f.resource(f.directory), AbortSignal.timeout(10_000))).content, `Path: ${f.directory}\n\nNot a file`);
    const actions = textFileConnector.actions!(f.resource(path));
    assert.deepEqual(actions.map(action => [action.id, action.readOnly === true, action.humanOnly === true, action.actsForPerson === true]), [['read', true, false, false], ['excerpt', true, false, false], ['stat', true, false, false], ['write', false, false, true]]);
    assert.deepEqual(actions.filter(action => action.uncached).map(action => action.id), ['read', 'excerpt'], 'the host saves no result that holds text of the file');
    await assert.rejects(f.run(path, 'delete'), /Unknown action/);
  } finally { f.close(); }
});
