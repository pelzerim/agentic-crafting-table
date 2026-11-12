import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { createQuitQuestion, type QuitQuestionWindow } from './quit-question.ts';

function fakeWindow(id: number) {
  const sent: Array<{ channel: string; value: { id: number } }> = [];
  const webContents = Object.assign(new EventEmitter(), { id, destroyed: false, isDestroyed() { return webContents.destroyed; }, send(channel: string, value: { id: number }) { sent.push({ channel, value }); } });
  return { sent, webContents, window: { isDestroyed: () => webContents.destroyed, webContents } satisfies QuitQuestionWindow };
}
function fixture(...ids: number[]) {
  const windows = ids.map(fakeWindow), shown: number[] = [];
  const question = createQuitQuestion({ windows: () => windows.map(each => each.window), show: window => shown.push(window.webContents.id), acknowledgeWithinMs: 30, showAfterMs: 15 });
  return { windows, shown, question };
}
const pending = async (answer: Promise<boolean>) => await Promise.race([answer, wait(60).then(() => 'pending' as const)]);

test('no window agrees to quit', async () => {
  assert.equal(await fixture().question.ask(), true);
});

test('each window is asked once, and the quit goes on when every window agrees', async () => {
  const { windows: [first, second], shown, question } = fixture(1, 2);
  const answer = question.ask();
  assert.deepEqual(first.sent.map(each => each.channel), ['app:before-quit']);
  assert.deepEqual(second.sent.map(each => each.channel), ['app:before-quit']);
  const { id } = first.sent[0].value;
  question.answer(1, { id, answer: 'asking' }); question.answer(1, { id, answer: true });
  question.answer(2, { id, answer: 'asking' }); question.answer(2, { id, answer: true });
  assert.equal(await answer, true);
  assert.equal(shown.length, 0);
});

test('one window that refuses keeps the app open', async () => {
  const { windows: [first, second], question } = fixture(1, 2);
  const answer = question.ask(), { id } = first.sent[0].value;
  question.answer(1, { id, answer: true }); question.answer(2, { id, answer: false });
  assert.equal(await answer, false);
  assert.equal(second.sent.length, 1);
});

test('a window that does not acknowledge the question agrees', async () => {
  const { shown, question } = fixture(1);
  assert.equal(await question.ask(), true);
  assert.equal(shown.length, 0);
});

test('a window that takes its time is shown, and its answer is waited for', async () => {
  const { windows: [only], shown, question } = fixture(1);
  const answer = question.ask(), { id } = only.sent[0].value;
  question.answer(1, { id, answer: 'asking' });
  assert.equal(await pending(answer), 'pending');
  assert.deepEqual(shown, [1]);
  question.answer(1, { id, answer: false });
  assert.equal(await answer, false);
});

for (const gone of ['destroyed', 'render-process-gone', 'did-navigate']) {
  test(`a window whose page is gone while it asks agrees (${gone})`, async () => {
    const { windows: [only], question } = fixture(1);
    const answer = question.ask(), { id } = only.sent[0].value;
    question.answer(1, { id, answer: 'asking' });
    only.webContents.emit(gone);
    assert.equal(await answer, true);
    assert.equal(only.webContents.listenerCount(gone), 0);
  });
}

test('a destroyed window is not asked', async () => {
  const { windows: [only], question } = fixture(1);
  only.webContents.destroyed = true;
  assert.equal(await question.ask(), true);
  assert.equal(only.sent.length, 0);
});

test('an answer from another window, to another question or of another shape is ignored', async () => {
  const { windows: [only], question } = fixture(1);
  const answer = question.ask(), { id } = only.sent[0].value;
  question.answer(1, { id, answer: 'asking' });
  question.answer(2, { id, answer: false }); question.answer(1, { id: id + 1, answer: false });
  question.answer(1, { id, answer: 'no' }); question.answer(1, null); question.answer(1, 'false');
  assert.equal(await pending(answer), 'pending');
  question.answer(1, { id, answer: true });
  assert.equal(await answer, true);
  // A late answer changes nothing and the next question has its own id.
  question.answer(1, { id, answer: false });
  const next = question.ask();
  assert.notEqual(only.sent[1].value.id, id);
  question.answer(1, { id, answer: false });
  question.answer(1, { id: only.sent[1].value.id, answer: true });
  assert.equal(await next, true);
});
