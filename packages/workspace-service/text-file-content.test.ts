import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from './server.ts';

test(`a text file's content read through the service is read from disk each time and never written into the workspace folder`, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'act-text-content-')), files = await mkdtemp(join(tmpdir(), 'act-text-content-files-'));
  const path = join(files, 'plan.md'), service = await startWorkspaceService(workspace);
  try {
    await writeFile(path, 'only-on-disk-first\n');
    await service.control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: (await service.control.read()).revision, actor: { kind: 'user', id: 'test' },
      commands: [{ type: 'item.add', id: 'file', resourceId: 'file-resource', pluginId: 'workspace.text', title: 'Plan', position: { x: 0, y: 0 }, data: { path } }] as never });
    for (const actionId of ['read', 'excerpt']) {
      const first = await service.resources.content('file', actionId, {});
      assert.equal((first.content as { text: string }).text, 'only-on-disk-first\n'); assert.equal(first.stale, false);
    }
    await writeFile(path, 'only-on-disk-second\n');
    for (const actionId of ['read', 'excerpt']) assert.equal(((await service.resources.content('file', actionId, {})).content as { text: string }).text, 'only-on-disk-second\n');
    await service.resources.context('file', AbortSignal.timeout(10_000));
  } finally { await service.close(); }
  try {
    for (const name of await readdir(workspace, { recursive: true })) {
      const saved = await readFile(join(workspace, name)).catch(() => Buffer.alloc(0));
      assert.equal(saved.includes('only-on-disk'), false, `${name} holds text of the file`);
    }
  } finally { await rm(workspace, { recursive: true, force: true }); await rm(files, { recursive: true, force: true }); }
});
