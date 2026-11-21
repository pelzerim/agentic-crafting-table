import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mountVideoNotes } from './notes.ts';
import type { JsonObject } from '../../types.ts';

// Just enough of the DOM for the panel.
class Element {
  textContent = ''; className = ''; type = ''; placeholder = ''; title = ''; value = ''; maxLength = 0; hidden = false; readOnly = false; disabled = false;
  selectionStart = 0; selectionEnd = 0; dataset: Record<string, string> = {}; children: Element[] = [];
  onclick?: () => unknown; oninput?: () => unknown; onchange?: () => unknown;
  readonly tag: string;
  constructor(tag: string) { this.tag = tag; }
  setAttribute() {} focus() {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; if (this.tag === 'select' && !children.some(child => child.value === this.value)) this.value = children[0]?.value ?? ''; }
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  setRangeText(text: string, start: number, end: number) { this.value = this.value.slice(0, start) + text + this.value.slice(end); this.selectionStart = this.selectionEnd = start + text.length; }
}
const document = { createElement: (tag: string) => new Element(tag) } as unknown as Document;
const settle = () => new Promise(resolve => setImmediate(resolve));
// The fingerprint is hashed off the main thread, so a fixed number of turns can be too few under load.
const until = async (ready: () => unknown) => { for (let turn = 0; turn < 500 && !ready(); turn++) await settle(); };
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function panel(notes: string) {
  const saves: { patch: JsonObject; expect?: JsonObject; done: ReturnType<typeof deferred<boolean>> }[] = [], actions: ReturnType<typeof deferred<void>>[] = [];
  let observe!: (data: JsonObject) => void;
  const time = { next: deferred<number | undefined>() };
  const view = mountVideoNotes(document, { id: 'clip-r', pluginId: 'workspace.video', schemaVersion: 1, title: 'clip', data: { source: 'https://youtu.be/dQw4w9WgXcQ', notes } } as never, {
    saveData: (patch: JsonObject, expect?: JsonObject) => { const done = deferred<boolean>(); saves.push({ patch, expect, done }); return done.promise; },
    observeData: (listener: (data: JsonObject) => void) => { observe = listener; return () => {}; },
    observeRelated: (listener: (items: unknown[]) => void) => { listener([{ nodeId: 'agent', title: 'Listener', summary: '', activity: 'idle', attention: 'none', typeName: 'Agent', resource: { pluginId: 'agent.session', data: { sessionId: 's1' } } }]); return () => {}; },
    runAction: () => { const done = deferred<void>(); actions.push(done); return done.promise; },
    openResource() {},
  } as never, { time: () => time.next.promise, seek: async () => {} });
  const root = view.element as unknown as Element, text = view.text as unknown as Element;
  const button = (label: string) => { const find = (node: Element): Element | undefined => node.tag === 'button' && node.textContent === label ? node : node.children.map(find).find(Boolean); return find(root)!; };
  const type = (value: string) => { text.value += value; text.oninput!(); };
  const feedback = () => root.children.find(child => child.tag === 'small')!.textContent;
  return { view, text, saves, actions, time, observe: (data: JsonObject) => observe(data), button, type, feedback };
}

test('drafts whose queued saves fail stay on screen, and the panel never reports them saved', async () => {
  const notes = panel('Start');
  notes.type(' one'); void notes.view.flush();
  notes.type(' two'); void notes.view.flush();
  await settle();
  notes.saves[0].done.reject(new Error('offline'));
  await settle();
  notes.observe({ notes: 'Start' });
  notes.saves[1].done.reject(new Error('offline'));
  await settle(); await settle();
  assert.equal(notes.text.value, 'Start one two');
  const closing = notes.view.flush();
  await settle();
  notes.saves[2].done.reject(new Error('offline'));
  assert.equal(await closing, false, 'closing stays blocked');
  assert.equal(notes.text.value, 'Start one two');
});

test('after notes change elsewhere no queued save replaces them until the person chooses', async () => {
  const notes = panel('Start');
  notes.type(' one'); void notes.view.flush();
  notes.type(' two'); void notes.view.flush();
  notes.observe({ notes: 'Newer elsewhere' });
  await settle();
  assert.deepEqual(notes.saves[0].expect, { notes: 'Start' });
  notes.saves[0].done.resolve(false);
  await settle(); await settle();
  assert.equal(notes.saves.length, 1, 'the second draft is never written');
  assert.match(notes.feedback(), /changed elsewhere/);
  notes.type(' three');
  assert.equal(await notes.view.flush(), false);
  assert.equal(notes.saves.length, 1, 'typing does not resume autosave');
  notes.button('Keep my draft').onclick!();
  await settle();
  assert.deepEqual([notes.saves[1].patch.notes, notes.saves[1].expect], ['Start one two three', { notes: 'Newer elsewhere' }]);
});

test('while a send waits for the agent the draft cannot change, and Sent records the draft the agent got', async () => {
  const notes = panel('Draft');
  notes.view.setActive(true);
  const stamping = notes.button('Add time').onclick!() as Promise<void>;
  void notes.button('Send to agent ▸').onclick!();
  notes.time.next.resolve(5);
  await stamping;
  assert.equal(notes.button('Add time').disabled, true);
  await until(() => notes.actions.length);
  notes.actions[0].resolve();
  await until(() => notes.saves.length);
  assert.equal(notes.text.value, 'Draft', 'the time read before the send was dropped');
  assert.equal((notes.saves[0].patch.notesSent as { fingerprint: string }).fingerprint, createHash('sha256').update('Draft').digest('hex'));
});
