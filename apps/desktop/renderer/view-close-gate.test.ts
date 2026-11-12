import test from 'node:test';
import assert from 'node:assert/strict';
import { ViewCloseGate } from './view-close-gate.ts';

const settle = () => new Promise(resolve => setImmediate(resolve));

test('leaving runs at once when nothing is open, no view is asked, or the view agrees', () => {
  const gate = new ViewCloseGate(), left: string[] = [];
  gate.request(undefined, () => false, () => true, () => left.push('nothing open'));
  gate.request('a', undefined, () => true, () => left.push('no one to ask'));
  gate.request('a', () => true, () => true, () => left.push('agreed'));
  gate.request('a', () => false, () => true, () => left.push('refused'));
  assert.deepEqual(left, ['nothing open', 'no one to ask', 'agreed']);
});

test('a view that answers later is left when it agrees and is still the open one', async () => {
  const gate = new ViewCloseGate(), left: string[] = [];
  let answer!: (agreed: boolean) => void;
  const later = () => new Promise<boolean>(resolve => { answer = resolve; });
  gate.request('a', later, () => true, () => left.push('agreed'));
  assert.equal(left.length, 0);
  answer(true); await settle();
  assert.deepEqual(left, ['agreed']);

  gate.request('a', later, () => true, () => left.push('refused'));
  answer(false); await settle();
  gate.request('a', later, () => false, () => left.push('closed meanwhile'));
  answer(true); await settle();
  assert.deepEqual(left, ['agreed']);
});

test('a view that is being asked takes no second request, and another view is asked for itself', async () => {
  const gate = new ViewCloseGate(), left: string[] = [], asked: string[] = [];
  const answers = new Map<string, (agreed: boolean) => void>();
  const later = (id: string) => { asked.push(id); return new Promise<boolean>(resolve => answers.set(id, resolve)); };
  gate.request('a', later, () => true, () => left.push('a'));
  gate.request('a', later, () => true, () => left.push('a again'));
  assert.deepEqual(asked, ['a']);
  gate.request('b', later, () => true, () => left.push('b'));
  assert.deepEqual(asked, ['a', 'b'], 'the first view was closed without its answer; the next one is asked');
  answers.get('b')!(true); await settle();
  assert.deepEqual(left, ['b']);
  gate.request('b', later, () => true, () => left.push('b again'));
  assert.deepEqual(asked, ['a', 'b', 'b'], 'an answered view is asked again the next time');
});
