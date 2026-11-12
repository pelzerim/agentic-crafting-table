import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject, ResourceRecord } from '../../types.ts';
import { CloseQuestion } from './close-question.ts';
import { textFileConnector } from './connector.ts';
import { OpenTextFile, type RunFileAction } from './open-file.ts';

const UNSAVED = 'Unsaved, really close?';

/** A close question on an open file over the real connector, in a temporary folder. The file holds `saved`
 * and the editor `edited`. `prompt` lists what the view was told to show; `hold` makes the named action wait;
 * `waitMs` is how long the question waits for a save. */
async function fixture({ edited = 'mine', shown = true, waitMs }: { edited?: string; shown?: boolean; waitMs?: number } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'act-close-question-'))), path = join(directory, 'plan.md');
  const resource: ResourceRecord = { id: 'file-r', pluginId: 'workspace.text', schemaVersion: 1, title: 'File', data: { path } };
  const calls: string[] = [], prompt: string[] = [], held = new Map<string, Promise<void>>();
  const run: RunFileAction = async (actionId, input) => {
    calls.push(actionId);
    await held.get(actionId);
    return textFileConnector.execute!(resource, actionId, AbortSignal.timeout(10_000), input) as Promise<JsonObject>;
  };
  writeFileSync(path, 'saved');
  const file = new OpenTextFile(path, run, () => {});
  await file.load();
  file.edit(edited);
  const question = new CloseQuestion(file, { show: text => prompt.push(`show ${text}`), hide: agreed => prompt.push(`hide ${agreed}`), busy: busy => prompt.push(`busy ${busy}`) }, waitMs);
  const view = { shown };
  return {
    path, file, question, calls, prompt, view,
    confirmClose: (saveAutomatically: boolean) => question.confirmClose({ saveAutomatically, shown: () => view.shown }),
    onDisk: () => readFileSync(path, 'utf8'),
    hold(actionId: string) { let release!: () => void; held.set(actionId, new Promise<void>(resolve => { release = resolve; })); return () => { held.delete(actionId); release(); }; },
    close() { chmodSync(path, 0o644); rmSync(directory, { recursive: true, force: true }); },
  };
}
const settled = () => new Promise(resolve => setTimeout(resolve, 20));
/** Waits until `check` no longer throws; its last error fails the test. */
async function eventually(check: () => void, withinMs = 3000) {
  for (const end = Date.now() + withinMs; ; await new Promise(resolve => setTimeout(resolve, 5))) {
    try { return check(); } catch (error) { if (Date.now() > end) throw error; }
  }
}
/** The answer, or 'no answer' when there is none in time. */
const answered = (answer: boolean | Promise<boolean>, withinMs = 3000) => Promise.race([answer, new Promise<string>(resolve => setTimeout(() => resolve('no answer'), withinMs))]);

test('a view with nothing unsaved closes without a save and without a question', async () => {
  const f = await fixture({ edited: 'saved' });
  try {
    assert.equal(f.confirmClose(true), true); assert.equal(f.confirmClose(false), true);
    assert.deepEqual(f.calls, ['read']); assert.deepEqual(f.prompt, []);
  } finally { f.close(); }
});

test('with edits saved automatically a close saves them and asks nothing', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.confirmClose(true), true);
    assert.equal(f.onDisk(), 'mine'); assert.deepEqual(f.prompt, []);
  } finally { f.close(); }
});

test('with edits saved automatically a close writes over a change on disk', async () => {
  const f = await fixture();
  try {
    writeFileSync(f.path, 'theirs, and longer'); await f.file.check();
    assert.equal(f.file.changedOnDisk?.state, 'present');
    assert.equal(await f.confirmClose(true), true);
    assert.equal(f.onDisk(), 'mine'); assert.deepEqual(f.prompt, []);
  } finally { f.close(); }
});

test('a close whose save does not reach the disk asks with the reason, and Cancel keeps the view open', async () => {
  const f = await fixture();
  try {
    chmodSync(f.path, 0o444);
    const answer = f.confirmClose(true);
    await eventually(() => assert.deepEqual(f.prompt, ['show Not saved: No permission to write the file. Really close?']));
    f.question.cancel();
    assert.equal(await answer, false);
    assert.deepEqual(f.prompt.slice(1), ['hide false']); assert.equal(f.onDisk(), 'saved'); assert.equal(f.file.unsaved, true);
  } finally { f.close(); }
});

test('without saving automatically a close asks and writes nothing, and one question answers everyone who asked', async () => {
  const f = await fixture();
  try {
    const first = f.confirmClose(false), second = f.confirmClose(false), third = f.confirmClose(true);
    assert.deepEqual(f.prompt, [`show ${UNSAVED}`]);
    assert.deepEqual(f.calls, ['read']);
    f.question.cancel();
    assert.deepEqual(await Promise.all([first, second, third]), [false, false, false]);
    assert.equal(f.onDisk(), 'saved');
  } finally { f.close(); }
});

test('Save and close writes the edits, over a change on disk too, and the view closes', async () => {
  const f = await fixture();
  try {
    writeFileSync(f.path, 'theirs, and longer'); await f.file.check();
    const answer = f.confirmClose(false);
    f.question.saveAndClose();
    assert.equal(await answer, true);
    assert.equal(f.onDisk(), 'mine');
    assert.deepEqual(f.prompt, [`show ${UNSAVED}`, 'busy true', 'busy false', 'hide true']);
  } finally { f.close(); }
});

test('Save and close that does not reach the disk keeps the question open with the reason', async () => {
  const f = await fixture();
  try {
    chmodSync(f.path, 0o444);
    const answer = f.confirmClose(false);
    f.question.saveAndClose();
    await eventually(() => assert.deepEqual(f.prompt, [`show ${UNSAVED}`, 'busy true', 'busy false', 'show Not saved: No permission to write the file. Really close?']));
    f.question.closeWithoutSaving();
    assert.equal(await answer, true);
    assert.equal(f.file.unsaved, false); assert.equal(f.file.text, 'saved'); assert.equal(f.file.saveError, '');
  } finally { f.close(); }
});

test('Close without saving drops the edits for what the disk holds', async () => {
  const f = await fixture();
  try {
    const answer = f.confirmClose(false);
    f.question.closeWithoutSaving();
    assert.equal(await answer, true);
    assert.equal(f.onDisk(), 'saved'); assert.equal(f.file.text, 'saved'); assert.equal(f.file.unsaved, false);
    assert.equal(f.calls.includes('write'), false);
  } finally { f.close(); }
});

test('two closes asked while the closing save runs get one save, one question and one answer', async () => {
  const f = await fixture();
  try {
    chmodSync(f.path, 0o444);
    const release = f.hold('write'), first = f.confirmClose(true), second = f.confirmClose(true);
    release();
    await eventually(() => assert.deepEqual(f.prompt, ['show Not saved: No permission to write the file. Really close?']));
    f.question.cancel();
    assert.deepEqual(await Promise.all([answered(first), answered(second)]), [false, false]);
    await settled();
    assert.deepEqual(f.prompt.slice(1), ['hide false']);
    assert.equal(f.calls.filter(call => call === 'write').length, 1);
  } finally { f.close(); }
});

test('a view that is not shown cannot ask: it agrees, after a save when edits are saved automatically', async () => {
  const off = await fixture({ shown: false }), on = await fixture({ shown: false }), failing = await fixture({ shown: false });
  try {
    assert.equal(off.confirmClose(false), true);
    assert.deepEqual(off.calls, ['read']); assert.equal(off.file.unsaved, true);
    assert.equal(await on.confirmClose(true), true);
    assert.equal(on.onDisk(), 'mine');
    chmodSync(failing.path, 0o444);
    assert.equal(await failing.confirmClose(true), true);
    assert.equal(failing.file.unsaved, true);
    assert.deepEqual([...off.prompt, ...on.prompt, ...failing.prompt], []);
  } finally { off.close(); on.close(); failing.close(); }
});

test('a view hidden while its closing save runs does not ask afterwards', async () => {
  const f = await fixture();
  try {
    chmodSync(f.path, 0o444);
    const release = f.hold('write'), answer = f.confirmClose(true);
    f.view.shown = false; release();
    assert.equal(await answer, true);
    assert.deepEqual(f.prompt, []);
  } finally { f.close(); }
});

test('a view that closes anyway while its closing save runs is not asked afterwards', async () => {
  const f = await fixture();
  try {
    chmodSync(f.path, 0o444);
    const release = f.hold('write'), answer = f.confirmClose(true);
    f.question.agree(); release();
    assert.equal(await answered(answer), true);
    assert.deepEqual(f.prompt, []);
  } finally { f.close(); }
});

test('a view that closes anyway answers its open question with yes', async () => {
  const f = await fixture();
  try {
    const answer = f.confirmClose(false);
    f.question.agree();
    assert.equal(await answer, true);
    assert.deepEqual(f.prompt, [`show ${UNSAVED}`, 'hide true']);
    f.question.agree(); f.question.cancel();
    assert.deepEqual(f.prompt.length, 2, 'no question is open any more');
  } finally { f.close(); }
});

test('a view that closes while the answer runs gets no second answer', async () => {
  const f = await fixture();
  try {
    const release = f.hold('write'), answer = f.confirmClose(false);
    f.question.saveAndClose();
    f.question.agree();
    assert.equal(await answer, true);
    release();
    await eventually(() => assert.deepEqual(f.prompt, [`show ${UNSAVED}`, 'busy true', 'hide true', 'busy false']));
    assert.equal(f.onDisk(), 'mine');
  } finally { f.close(); }
});

test('Cancel while the answer runs is ignored: the answer already given stands', async () => {
  const f = await fixture();
  try {
    const release = f.hold('read'), answer = f.confirmClose(false);
    f.question.closeWithoutSaving();
    f.question.cancel();
    release();
    assert.equal(await answer, true);
    assert.equal(f.file.text, 'saved'); assert.equal(f.file.unsaved, false);
    assert.deepEqual(f.prompt, [`show ${UNSAVED}`, 'busy true', 'busy false', 'hide true']);
  } finally { f.close(); }
});

test('edits typed while the closing save runs are saved by the next save, without a question', async () => {
  const f = await fixture();
  try {
    const release = f.hold('write'), answer = f.confirmClose(true);
    await eventually(() => assert.equal(f.calls.includes('write'), true));
    f.file.edit('mine, and more'); release();
    assert.equal(await answered(answer), true);
    assert.deepEqual(f.prompt, []);
    assert.equal(f.onDisk(), 'mine, and more'); assert.equal(f.file.unsaved, false);
  } finally { f.close(); }
});

test('edits typed while Save and close runs are saved too', async () => {
  const f = await fixture();
  try {
    const release = f.hold('write'), answer = f.confirmClose(false);
    f.question.saveAndClose();
    await eventually(() => assert.equal(f.calls.includes('write'), true));
    f.file.edit('mine, and more'); release();
    assert.equal(await answered(answer), true);
    assert.equal(f.onDisk(), 'mine, and more');
  } finally { f.close(); }
});

const UNFINISHED = 'Not saved: the save has not finished. Really close?';

test('a closing save that does not finish in time asks with that reason, and the person can still close', async () => {
  const f = await fixture({ waitMs: 300 });
  const release = f.hold('write');
  try {
    const asked = Date.now(), answer = f.confirmClose(true);
    await settled();
    if (Date.now() - asked < 300) assert.deepEqual(f.prompt, []);
    await eventually(() => assert.deepEqual(f.prompt, [`show ${UNFINISHED}`]));
    f.question.closeWithoutSaving();
    assert.equal(await answered(answer), true);
    assert.deepEqual(f.prompt.slice(1), ['busy true', 'busy false', 'hide true']);
  } finally { release(); await settled(); f.close(); }
});

test('Save and close that does not finish in time keeps the question open with that reason', async () => {
  const f = await fixture({ waitMs: 30 });
  const release = f.hold('write');
  try {
    const answer = f.confirmClose(false);
    f.question.saveAndClose();
    await eventually(() => assert.deepEqual(f.prompt, [`show ${UNSAVED}`, 'busy true', 'busy false', `show ${UNFINISHED}`]));
    f.question.cancel();
    assert.equal(await answer, false);
  } finally { release(); await settled(); f.close(); }
});

test('a view that is not shown agrees when its closing save does not finish in time', async () => {
  const f = await fixture({ shown: false, waitMs: 30 });
  const release = f.hold('write');
  try {
    assert.equal(await answered(f.confirmClose(true)), true);
    assert.deepEqual(f.prompt, []);
  } finally { release(); await settled(); f.close(); }
});
