import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject, ResourceRecord } from '../../types.ts';
import { textFileConnector } from './connector.ts';
import { OpenTextFile, OpenTextFiles, type RunFileAction } from './open-file.ts';

/** An open file over the real connector, in a temporary folder. `calls` lists the connector actions it ran. */
function fixture(name = 'plan.md') {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'act-open-text-file-'))), path = join(directory, name);
  const resource: ResourceRecord = { id: 'file-r', pluginId: 'workspace.text', schemaVersion: 1, title: 'File', data: { path } };
  const calls: string[] = [], changes: boolean[] = [];
  let hold: Promise<void> | undefined;
  const run: RunFileAction = async (actionId, input) => {
    calls.push(actionId);
    if (actionId === 'write') await hold;
    return textFileConnector.execute!(resource, actionId, AbortSignal.timeout(10_000), input) as Promise<JsonObject>;
  };
  const file = new OpenTextFile(path, run, textReplaced => changes.push(textReplaced));
  return { path, file, run, calls, changes, editItemPath(next: string) { resource.data.path = next; }, holdWrites(until: Promise<void>) { hold = until; }, close() { rmSync(directory, { recursive: true, force: true }); } };
}
const laterModified = (path: string, at: string) => utimesSync(path, new Date(at), new Date(at));

test('an edit is saved against the version the text was read at, and the next save against the version that wrote', async () => {
  const f = fixture();
  try {
    writeFileSync(f.path, '# Plan\n');
    await f.file.load();
    assert.equal(f.file.status, 'present'); assert.equal(f.file.text, '# Plan\n'); assert.equal(f.file.unsaved, false);
    assert.deepEqual(f.changes, [true], 'the text that was read replaces the empty one');
    f.file.edit('# Plan\n\nOne\n');
    assert.equal(f.file.unsaved, true);
    await f.file.save();
    assert.equal(readFileSync(f.path, 'utf8'), '# Plan\n\nOne\n'); assert.equal(f.file.unsaved, false);
    f.file.edit('# Plan\n\nOne\nTwo\n'); await f.file.save();
    assert.equal(readFileSync(f.path, 'utf8'), '# Plan\n\nOne\nTwo\n'); assert.equal(f.file.changedOnDisk, undefined); assert.equal(f.file.saveError, '');
    assert.equal(f.changes.filter(Boolean).length, 1, 'a save never replaces the text being edited');
  } finally { f.close(); }
});

test('a save with nothing to save writes nothing', async () => {
  const f = fixture();
  try {
    writeFileSync(f.path, 'same');
    await f.file.load(); await f.file.save();
    f.file.edit('other'); f.file.edit('same'); await f.file.save();
    assert.deepEqual(f.calls, ['read']);
  } finally { f.close(); }
});

test('a check reads the file only when its time or size changed, and a touch without a change leaves the text alone', async () => {
  const f = fixture();
  try {
    writeFileSync(f.path, 'one');
    await f.file.load(); await f.file.check(); await f.file.check();
    assert.deepEqual(f.calls, ['read', 'stat', 'stat']);
    laterModified(f.path, '2031-01-01T00:00:00Z');
    await f.file.check(); await f.file.check();
    assert.deepEqual(f.calls, ['read', 'stat', 'stat', 'stat', 'read', 'stat']); assert.deepEqual(f.changes, [true]);
    f.file.edit('two'); await f.file.save();
    assert.equal(readFileSync(f.path, 'utf8'), 'two', 'the version follows the content, so the touched file is still writable');
    await f.file.check();
    assert.deepEqual(f.calls.slice(-2), ['write', 'stat'], 'its own write is not read back');
  } finally { f.close(); }
});

test('a change on disk replaces the text quietly while there are no unsaved edits', async () => {
  const f = fixture();
  try {
    writeFileSync(f.path, 'first');
    await f.file.load();
    writeFileSync(f.path, 'changed outside'); laterModified(f.path, '2031-01-01T00:00:00Z');
    await f.file.check();
    assert.equal(f.file.text, 'changed outside'); assert.equal(f.file.unsaved, false); assert.equal(f.file.changedOnDisk, undefined);
    assert.deepEqual(f.changes, [true, true]);
    f.file.edit('changed outside, then here'); await f.file.save();
    assert.equal(readFileSync(f.path, 'utf8'), 'changed outside, then here');
  } finally { f.close(); }
});

test('a change on disk beside unsaved edits waits for a decision: reload takes the disk, keep mine writes over it', async () => {
  for (const decision of ['reload', 'keepMine'] as const) {
    const f = fixture();
    try {
      writeFileSync(f.path, 'first');
      await f.file.load();
      f.file.edit('mine');
      writeFileSync(f.path, 'changed outside'); laterModified(f.path, '2031-01-01T00:00:00Z');
      await f.file.check();
      assert.equal(f.file.changedOnDisk?.state === 'present' && f.file.changedOnDisk.text, 'changed outside'); assert.equal(f.file.text, 'mine');
      await f.file.save(); await f.file.check();
      assert.equal(readFileSync(f.path, 'utf8'), 'changed outside', 'nothing is written while the decision is open');
      assert.equal(f.calls.includes('write'), false);
      await f.file[decision]();
      assert.equal(f.file.changedOnDisk, undefined); assert.equal(f.file.unsaved, false);
      assert.equal(f.file.text, decision === 'reload' ? 'changed outside' : 'mine');
      assert.equal(readFileSync(f.path, 'utf8'), decision === 'reload' ? 'changed outside' : 'mine');
    } finally { f.close(); }
  }
});

test('a save that finds the file changed since the last check changes nothing and asks', async () => {
  const f = fixture();
  try {
    writeFileSync(f.path, 'first');
    await f.file.load();
    writeFileSync(f.path, 'changed outside');
    f.file.edit('mine'); await f.file.save();
    assert.equal(readFileSync(f.path, 'utf8'), 'changed outside');
    assert.equal(f.file.changedOnDisk?.state === 'present' && f.file.changedOnDisk.text, 'changed outside'); assert.equal(f.file.unsaved, true);
    writeFileSync(f.path, 'changed outside again'); laterModified(f.path, '2031-01-01T00:00:00Z');
    await f.file.check();
    assert.equal(f.file.changedOnDisk?.state === 'present' && f.file.changedOnDisk.text, 'changed outside again', 'the open decision follows the disk');
    await f.file.keepMine();
    assert.equal(readFileSync(f.path, 'utf8'), 'mine');
  } finally { f.close(); }
});

test('a missing file is created on request, and a file that appears is read', async () => {
  const f = fixture('drafts/idea.md');
  try {
    await f.file.load();
    assert.equal(f.file.status, 'missing');
    f.file.edit('typed into nothing'); await f.file.save();
    assert.equal(existsSync(f.path), false, 'only Create makes the file');
    await f.file.create();
    assert.equal(f.file.status, 'present'); assert.equal(readFileSync(f.path, 'utf8'), ''); assert.equal(f.file.text, '');
    f.file.edit('idea'); await f.file.save();
    assert.equal(readFileSync(f.path, 'utf8'), 'idea');

    const appearing = fixture();
    try {
      await appearing.file.load(); writeFileSync(appearing.path, 'appeared');
      await appearing.file.check();
      assert.equal(appearing.file.status, 'present'); assert.equal(appearing.file.text, 'appeared');
      rmSync(appearing.path); await appearing.file.check();
      assert.equal(appearing.file.status, 'missing'); assert.equal(appearing.file.text, '');
    } finally { appearing.close(); }
  } finally { f.close(); }
});

test('a file deleted beside unsaved edits is recreated by keep mine and gone after reload', async () => {
  for (const decision of ['reload', 'keepMine'] as const) {
    const f = fixture();
    try {
      writeFileSync(f.path, 'first');
      await f.file.load(); f.file.edit('mine'); rmSync(f.path);
      await f.file.check();
      assert.deepEqual(f.file.changedOnDisk, { state: 'missing' });
      await f.file[decision]();
      assert.equal(f.file.status, decision === 'reload' ? 'missing' : 'present'); assert.equal(f.file.changedOnDisk, undefined);
      assert.equal(existsSync(f.path) && readFileSync(f.path, 'utf8'), decision === 'reload' ? false : 'mine');
    } finally { f.close(); }
  }
});

test('a file this item cannot edit says why, and edits to it go nowhere', async () => {
  const f = fixture('image.png');
  try {
    writeFileSync(f.path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]));
    await f.file.load();
    assert.equal(f.file.status, 'refused'); assert.equal(f.file.refusal, 'Not a text file');
    f.file.edit('text'); await f.file.save();
    assert.equal(readFileSync(f.path).length, 6);
    writeFileSync(f.path, 'now text'); laterModified(f.path, '2031-01-01T00:00:00Z');
    await f.file.check();
    assert.equal(f.file.status, 'present'); assert.equal(f.file.text, 'now text');
  } finally { f.close(); }
});

test('a file that becomes uneditable beside unsaved edits keeps the edits and reports the reason', async () => {
  const f = fixture();
  try {
    writeFileSync(f.path, 'first');
    await f.file.load(); f.file.edit('mine');
    writeFileSync(f.path, Buffer.from('bin\0ary')); laterModified(f.path, '2031-01-01T00:00:00Z');
    await f.file.check();
    assert.equal(f.file.text, 'mine'); assert.equal(f.file.status, 'present'); assert.equal(f.file.saveError, 'Not a text file');
  } finally { f.close(); }
});

test('text typed while a save is under way stays unsaved and goes out with the next save', async () => {
  const f = fixture();
  try {
    writeFileSync(f.path, 'first');
    await f.file.load();
    let release!: () => void;
    f.holdWrites(new Promise<void>(resolve => { release = resolve; }));
    f.file.edit('second'); const saving = f.file.save(), checking = f.file.check();
    while (!f.calls.includes('write')) await new Promise(resolve => setImmediate(resolve));
    f.file.edit('second, third');
    release(); await saving; await checking;
    assert.equal(readFileSync(f.path, 'utf8'), 'second'); assert.equal(f.file.text, 'second, third'); assert.equal(f.file.unsaved, true);
    assert.equal(f.file.changedOnDisk, undefined, 'a check queued behind the save sees the version that save wrote');
    await f.file.save();
    assert.equal(readFileSync(f.path, 'utf8'), 'second, third'); assert.equal(f.file.unsaved, false);
  } finally { f.close(); }
});

test('a failed action is reported and leaves the text for another try', async () => {
  let fail = false;
  const store = { text: 'first', version: 'v1' };
  const file = new OpenTextFile('/plan.md', async (actionId, input) => {
    if (fail) throw new Error('Workspace service is not running');
    if (actionId === 'write') { store.text = String(input?.text); store.version = 'v2'; return { state: 'written', version: 'v2', modifiedAt: 2, size: store.text.length }; }
    return actionId === 'stat' ? { state: 'present', modifiedAt: 1, size: 5 } : { state: 'present', text: store.text, version: store.version, modifiedAt: 1, size: 5 };
  }, () => {});
  await file.load();
  fail = true; file.edit('mine'); await file.save(); await file.check();
  assert.equal(file.saveError, 'Workspace service is not running'); assert.equal(file.text, 'mine'); assert.equal(file.unsaved, true);
  fail = false; await file.save();
  assert.equal(store.text, 'mine'); assert.equal(file.saveError, '');

  fail = true;
  const unread = new OpenTextFile('/plan.md', async () => { throw new Error('Workspace service is not running'); }, () => {});
  await unread.load();
  assert.equal(unread.status, 'refused'); assert.equal(unread.refusal, 'Workspace service is not running');
});

test('a disk change that is undone before the decision closes the decision and lets the edits save', async () => {
  const f = fixture();
  try {
    writeFileSync(f.path, 'first');
    await f.file.load(); f.file.edit('mine');
    writeFileSync(f.path, 'changed outside'); laterModified(f.path, '2031-01-01T00:00:00Z');
    await f.file.check();
    assert.equal(f.file.changedOnDisk?.state, 'present');
    writeFileSync(f.path, 'first'); laterModified(f.path, '2031-01-02T00:00:00Z');
    await f.file.check();
    assert.equal(f.file.changedOnDisk, undefined); assert.equal(f.file.text, 'mine');
    await f.file.save();
    assert.equal(readFileSync(f.path, 'utf8'), 'mine');
  } finally { f.close(); }
});

test('edits undone back to the saved text while a decision is open close the decision and take the disk', async () => {
  const f = fixture();
  try {
    writeFileSync(f.path, 'first');
    await f.file.load(); f.file.edit('mine');
    writeFileSync(f.path, 'changed outside'); laterModified(f.path, '2031-01-01T00:00:00Z');
    await f.file.check();
    assert.equal(f.file.changedOnDisk?.state, 'present');
    f.file.edit('first');
    assert.equal(f.file.text, 'first', 'the text is not replaced while the editor is still handing over the edit');
    await f.file.check();
    assert.equal(f.file.changedOnDisk, undefined); assert.equal(f.file.text, 'changed outside'); assert.equal(f.file.unsaved, false);
    assert.equal(f.changes.at(-1), true);
    assert.equal(f.calls.includes('write'), false);
  } finally { f.close(); }
});

test('saving over the disk writes the edits over a change that waits for a decision, and over one not seen yet', async () => {
  const f = fixture();
  try {
    writeFileSync(f.path, 'first');
    await f.file.load();
    f.file.edit('mine');
    writeFileSync(f.path, 'changed outside'); laterModified(f.path, '2031-01-01T00:00:00Z');
    await f.file.check();
    assert.equal(f.file.changedOnDisk?.state, 'present');
    await f.file.saveOverDisk();
    assert.equal(readFileSync(f.path, 'utf8'), 'mine'); assert.equal(f.file.unsaved, false); assert.equal(f.file.changedOnDisk, undefined);

    f.file.edit('mine again');
    writeFileSync(f.path, 'changed outside, not seen');
    await f.file.saveOverDisk();
    assert.equal(readFileSync(f.path, 'utf8'), 'mine again'); assert.equal(f.file.unsaved, false); assert.equal(f.file.changedOnDisk, undefined);

    const writes = f.calls.filter(call => call === 'write').length;
    await f.file.saveOverDisk();
    assert.equal(f.calls.filter(call => call === 'write').length, writes, 'nothing unsaved writes nothing');
  } finally { f.close(); }
});

test('saving over the disk writes a deleted file again', async () => {
  const f = fixture();
  try {
    writeFileSync(f.path, 'first');
    await f.file.load();
    f.file.edit('mine');
    rmSync(f.path);
    await f.file.saveOverDisk();
    assert.equal(readFileSync(f.path, 'utf8'), 'mine'); assert.equal(f.file.unsaved, false); assert.equal(f.file.status, 'present');
  } finally { f.close(); }
});

test('discarding drops the unsaved edits, an open decision and a save error for what the disk holds now', async () => {
  const f = fixture();
  try {
    writeFileSync(f.path, 'first');
    await f.file.load();
    f.file.edit('mine');
    await f.file.discard();
    assert.equal(f.file.text, 'first'); assert.equal(f.file.unsaved, false); assert.equal(readFileSync(f.path, 'utf8'), 'first');
    assert.equal(f.changes.at(-1), true, 'the view is told the text was replaced');

    f.file.edit('mine');
    writeFileSync(f.path, 'changed outside'); laterModified(f.path, '2031-01-01T00:00:00Z');
    await f.file.check();
    await f.file.discard();
    assert.equal(f.file.text, 'changed outside'); assert.equal(f.file.changedOnDisk, undefined); assert.equal(f.file.unsaved, false);

    const failing = new OpenTextFile(f.path, async (actionId, input) => { if (actionId === 'write') throw new Error('disk full'); return f.run(actionId, input); }, () => {});
    await failing.load();
    failing.edit('not written'); await failing.save();
    assert.equal(failing.saveError, 'disk full');
    await failing.discard();
    assert.equal(failing.text, 'changed outside'); assert.equal(failing.saveError, ''); assert.equal(failing.unsaved, false);
  } finally { f.close(); }
});

test('a closed view saves its edits, and the next view of the file starts from the disk', async () => {
  const f = fixture(), files = new OpenTextFiles();
  try {
    writeFileSync(f.path, 'first');
    const file = files.open('file-r', f.path, f.run, () => {});
    await file.check();
    file.edit('mine');
    await files.close('file-r', f.path, file, true);
    assert.equal(readFileSync(f.path, 'utf8'), 'mine');
    const next = files.open('file-r', f.path, f.run, () => {});
    assert.notEqual(next, file); assert.equal(next.status, 'loading');
    await next.check();
    assert.equal(next.text, 'mine'); assert.equal(next.unsaved, false);
  } finally { f.close(); }
});

test('edits closed without saving while a change on disk waits for a decision are there in the next view, with the decision', async () => {
  const f = fixture(), files = new OpenTextFiles();
  try {
    writeFileSync(f.path, 'first');
    const closedViewChanges: boolean[] = [], nextViewChanges: boolean[] = [];
    const file = files.open('file-r', f.path, f.run, textReplaced => closedViewChanges.push(textReplaced));
    await file.check();
    file.edit('mine');
    writeFileSync(f.path, 'changed outside'); laterModified(f.path, '2031-01-01T00:00:00Z');
    await file.check();
    await files.close('file-r', f.path, file, false);
    assert.equal(readFileSync(f.path, 'utf8'), 'changed outside'); assert.equal(f.calls.includes('write'), false);
    const told = closedViewChanges.length;

    const next = files.open('file-r', f.path, f.run, textReplaced => nextViewChanges.push(textReplaced));
    assert.equal(next, file); assert.equal(next.text, 'mine'); assert.equal(next.unsaved, true);
    assert.equal(next.changedOnDisk?.state === 'present' && next.changedOnDisk.text, 'changed outside');
    await next.keepMine();
    assert.equal(readFileSync(f.path, 'utf8'), 'mine');
    assert.equal(closedViewChanges.length, told, 'the closed view hears nothing more'); assert.ok(nextViewChanges.length > 0);
    await files.close('file-r', f.path, next, false);
    assert.notEqual(files.open('file-r', f.path, f.run, () => {}), file, 'a file with nothing unsaved is not kept');
  } finally { f.close(); }
});

test('a closed view writes its edits over a change on disk, whether the change waited for a decision or not', async () => {
  const f = fixture(), files = new OpenTextFiles();
  try {
    writeFileSync(f.path, 'first');
    const file = files.open('file-r', f.path, f.run, () => {});
    await file.check();
    file.edit('mine');
    writeFileSync(f.path, 'changed outside'); laterModified(f.path, '2031-01-01T00:00:00Z');
    await file.check();
    assert.equal(file.changedOnDisk?.state, 'present');
    await files.close('file-r', f.path, file, true);
    assert.equal(readFileSync(f.path, 'utf8'), 'mine');
    const next = files.open('file-r', f.path, f.run, () => {});
    assert.notEqual(next, file, 'edits that are on disk are not kept');
    await next.check();

    writeFileSync(f.path, 'changed outside, not seen');
    next.edit('mine again');
    await files.close('file-r', f.path, next, true);
    assert.equal(readFileSync(f.path, 'utf8'), 'mine again');
    assert.notEqual(files.open('file-r', f.path, f.run, () => {}), next);
  } finally { f.close(); }
});

test('edits a closing view could not write are there in the next view, which can save them where nothing on disk changed', async () => {
  const f = fixture(), files = new OpenTextFiles();
  try {
    writeFileSync(f.path, 'first');
    const writes: string[] = [];
    const failing = files.open('file-r', f.path, async (actionId, input) => { if (actionId === 'write') { writes.push(String(input?.text)); throw new Error('disk full'); } return f.run(actionId, input); }, () => {});
    await failing.check();
    failing.edit('not written');
    await files.close('file-r', f.path, failing, true);
    assert.deepEqual(writes, ['not written'], 'a write that fails is not tried again');
    const afterFailure = files.open('file-r', f.path, f.run, () => {});
    assert.equal(afterFailure, failing); assert.equal(afterFailure.text, 'not written'); assert.equal(afterFailure.saveError, 'disk full');
    await afterFailure.check();
    assert.equal(readFileSync(f.path, 'utf8'), 'first', 'taking the file back writes nothing');
    await afterFailure.save();
    assert.equal(readFileSync(f.path, 'utf8'), 'not written'); assert.equal(afterFailure.saveError, ''); assert.equal(afterFailure.unsaved, false);
  } finally { f.close(); }
});

test('a view closed without saving writes nothing, and its edits are there in the next view', async () => {
  const f = fixture(), files = new OpenTextFiles();
  try {
    writeFileSync(f.path, 'first');
    const file = files.open('file-r', f.path, f.run, () => {});
    await file.check();
    file.edit('mine');
    await files.close('file-r', f.path, file, false);
    const next = files.open('file-r', f.path, f.run, () => {});
    assert.equal(next, file); assert.equal(next.text, 'mine'); assert.equal(next.unsaved, true);
    await next.check(); await next.check();
    assert.equal(readFileSync(f.path, 'utf8'), 'first'); assert.equal(f.calls.includes('write'), false);
  } finally { f.close(); }
});

test('a view opened while the closing save is still writing shows the edits and never an older file', async () => {
  const f = fixture(), files = new OpenTextFiles();
  try {
    writeFileSync(f.path, 'first');
    const file = files.open('file-r', f.path, f.run, () => {});
    await file.check();
    let release!: () => void;
    f.holdWrites(new Promise(resolve => { release = resolve; }));
    file.edit('mine');
    const closing = files.close('file-r', f.path, file, true);
    const next = files.open('file-r', f.path, f.run, () => {});
    assert.equal(next, file); assert.equal(next.text, 'mine');
    release(); await closing; await next.check();
    assert.equal(readFileSync(f.path, 'utf8'), 'mine'); assert.equal(next.unsaved, false); assert.equal(next.changedOnDisk, undefined);
    await files.close('file-r', f.path, next, true);
    assert.notEqual(files.open('file-r', f.path, f.run, () => {}), file);
  } finally { f.close(); }
});

test('each item keeps its own file', async () => {
  const f = fixture(), files = new OpenTextFiles();
  try {
    writeFileSync(f.path, 'first');
    const file = files.open('file-r', f.path, f.run, () => {});
    await file.check();
    file.edit('mine');
    await files.close('file-r', f.path, file, false);
    assert.notEqual(files.open('other-r', f.path, f.run, () => {}), file);
    assert.equal(files.open('file-r', f.path, f.run, () => {}), file);
  } finally { f.close(); }
});

test('edits closed after the item was pointed at another file reach neither file and wait for the first one', async () => {
  const f = fixture(), files = new OpenTextFiles(), other = `${f.path}.other`;
  try {
    writeFileSync(f.path, 'same'); writeFileSync(other, 'same');
    const file = files.open('file-r', f.path, f.run, () => {});
    await file.check();
    file.edit('mine');
    f.editItemPath(other);
    await files.close('file-r', f.path, file, true);
    assert.equal(readFileSync(other, 'utf8'), 'same'); assert.equal(readFileSync(f.path, 'utf8'), 'same');
    assert.equal(file.saveError, 'The item now edits another file');
    const next = files.open('file-r', other, f.run, () => {});
    assert.notEqual(next, file); await next.check();
    assert.equal(next.text, 'same'); assert.equal(next.changedOnDisk, undefined);
    await files.close('file-r', other, next, true);
    f.editItemPath(f.path);
    assert.equal(files.open('file-r', f.path, f.run, () => {}), file);
    await file.save();
    assert.equal(readFileSync(f.path, 'utf8'), 'mine'); assert.equal(file.saveError, '');
  } finally { f.close(); }
});

test('edits kept for one path are not handed to a view of the item at another path', async () => {
  const f = fixture(), files = new OpenTextFiles();
  try {
    writeFileSync(f.path, 'first');
    const file = files.open('file-r', f.path, f.run, () => {});
    await file.check();
    file.edit('mine');
    await files.close('file-r', f.path, file, false);
    assert.notEqual(files.open('file-r', `${f.path}.other`, f.run, () => {}), file);
    assert.equal(files.open('file-r', f.path, f.run, () => {}), file);
  } finally { f.close(); }
});
