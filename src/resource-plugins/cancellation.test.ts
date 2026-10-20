import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResourcePluginRegistry } from './registry.ts';
import { ResourcePluginHost } from './host.ts';
import { bookmark } from './items/bookmark/definition.ts';
import type { ResourceSnapshot } from './types.ts';
const snapshot: ResourceSnapshot = { activity: 'idle', attention: 'none', connection: 'connected', label: 'Fixture', observedAt: '2026-09-26' };

test('host rejects late reads, actions and context after cancellation even when a connector ignores its signal', async () => {
  for (const operation of ['load', 'execute', 'getContext'] as const) {
    const registry = new ResourcePluginRegistry(); registry.register(bookmark); const host = new ResourcePluginHost(registry), controller = new AbortController();
    let resolve!: () => void; const ready = new Promise<void>(done => { resolve = done; }); let calls = 0;
    host.register(bookmark.id, {
      load: async () => { calls++; await ready; return snapshot; }, actions: () => [{ id: 'read', label: 'Read', readOnly: true }],
      execute: async () => { calls++; await ready; return { read: true }; },
      getContext: async resource => { calls++; await ready; return { resourceId: resource.id, title: resource.title, content: 'Private fixture context' }; },
    });
    const resource = registry.createRecord(bookmark.id, 'fixture', { title: 'Fixture', data: { url: 'https://example.com' } });
    const pending = operation === 'execute' ? host.execute(resource, 'read', {}, controller.signal) : host[operation](resource, controller.signal);
    controller.abort(); resolve(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(calls, 1);
    await assert.rejects(async () => host.load(resource, controller.signal), { name: 'AbortError' }); assert.equal(calls, 1);
  }
});

test('watch subscriptions cannot deliver observations after their host signal is aborted', async () => {
  const registry = new ResourcePluginRegistry(); registry.register(bookmark); const host = new ResourcePluginHost(registry), controller = new AbortController();
  const resource = registry.createRecord(bookmark.id, 'fixture', { title: 'Fixture', data: { url: 'https://example.com' } });
  let emit!: (snapshot: ResourceSnapshot) => void, finish!: () => void; const seen: ResourceSnapshot[] = [];
  host.register(bookmark.id, { load: async () => snapshot, watch: async (_resource, callback) => { emit = callback; await new Promise<void>(resolve => { finish = resolve; }); } });
  const pending = host.watch(resource, value => seen.push(value), controller.signal); emit(snapshot); controller.abort(); emit(snapshot); finish();
  await assert.rejects(pending, { name: 'AbortError' }); assert.deepEqual(seen, [snapshot]);
});

test('an uncooperative connector cannot hold the host caller after the request is cancelled', async () => {
  const registry = new ResourcePluginRegistry(); registry.register(bookmark); const host = new ResourcePluginHost(registry), controller = new AbortController();
  const resource = registry.createRecord(bookmark.id, 'fixture', { title: 'Fixture', data: { url: 'https://example.com' } });
  let rejectLate!: (error: Error) => void;
  host.register(bookmark.id, { load: () => new Promise((_, reject) => { rejectLate = reject; }) });
  const pending = host.load(resource, controller.signal); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); rejectLate(new Error('late provider error is consumed'));
});
