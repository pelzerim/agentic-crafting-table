import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../workspace-service/server.ts';
import { connectWorkspace } from '../workspace-service/client.ts';
import { settingsSchema } from '../core/settings.ts';
import type { SupportReport } from './support-report.ts';
import { supportReport } from './support-report.ts';
import { emptyState } from '../core/control.ts';
import type { SessionRecord } from '../session-runtime/protocol.ts';

test('support aggregation excludes native session identities, errors and terminal paths', () => {
  const session: SessionRecord = { id: 'PRIVATE_SESSION', requestId: 'PRIVATE_REQUEST', nodeId: 'PRIVATE_NODE', workspaceId: 'PRIVATE_WORKSPACE', cwd: '/PRIVATE_CWD', state: 'failed', error: 'PRIVATE_TERMINAL', cols: 80, rows: 24, createdAt: 'PRIVATE_CREATED', updatedAt: 'PRIVATE_UPDATED', native: { provider: 'codex', nativeSessionId: 'PRIVATE_NATIVE', status: 'error', observedAt: 'PRIVATE_OBSERVATION' } };
  const report = supportReport(emptyState(), settingsSchema.parse({}), [], [session]);
  assert.equal(report.sessions.available, true); assert.equal(report.sessions.counts.failed, 1); assert.doesNotMatch(JSON.stringify(report), /PRIVATE|sessionId|cwd|observedAt/);
});

test('support RPC contains only allowlisted counts/versions and settings validate and survive restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-support-'));
  let service = await startWorkspaceService(directory, undefined, undefined, {}), client = await connectWorkspace(directory);
  try {
    await service.control.dispatch({ commandId: 'private', expectedRevision: 0, actor: { kind: 'user', id: 'PRIVATE_ACTOR' }, commands: [
      { type: 'project.create', id: 'PRIVATE_ID', title: 'PRIVATE_TITLE', workingDirectory: '/PRIVATE_PATH', position: { x: 1, y: 2 } },
      { type: 'item.add', id: 'PRIVATE_ITEM', resourceId: 'PRIVATE_RESOURCE', pluginId: 'web.link', title: 'PRIVATE_LINK', data: { url: 'https://private.invalid/SECRET' }, position: { x: 3, y: 4 } },
    ] });
    service.store.enqueueJob('PRIVATE_JOB', { action: 'private', nodeId: 'PRIVATE_ITEM', arguments: { prompt: 'PRIVATE_PROMPT' } });
    const initial = service.store.readSettings(); assert.deepEqual(initial.value.diagnostics, { fileMiB: 1, backups: 2 });
    const value = { ...initial.value, diagnostics: { fileMiB: 4, backups: 1 }, connections: [{ id: 'PRIVATE_CONNECTION', providerId: 'github', account: 'PRIVATE_ACCOUNT', enabled: true, isDefault: true }] };
    await client.call('settings.write', { expectedRevision: initial.revision, value });
    for (const diagnostics of [{ fileMiB: 0, backups: 1 }, { fileMiB: 17, backups: 1 }, { fileMiB: 1, backups: 6 }, { fileMiB: 1.2, backups: 1 }, { fileMiB: 1, backups: 1, path: 'PRIVATE_PATH' }]) assert.equal(settingsSchema.safeParse({ ...value, diagnostics }).success, false);
    await assert.rejects(client.call('settings.write', { expectedRevision: initial.revision, value }), /changed elsewhere/);
    const report = await client.call<SupportReport>('diagnostics.report');
    assert.deepEqual(report.workspace, { projects: 1, items: 1, resources: 1, links: 0, todos: 0, archived: 0 });
    assert.equal(report.jobs.queued, 1); assert.equal(report.sessions.available, false); assert.deepEqual(report.connections, { configured: 1, enabled: 1 });
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|private.invalid|SECRET|prompt|credential|cwd/);
    assert.deepEqual(report.diagnostics, { fileMiB: 4, backups: 1, terminalRecordings: 'preserved' });
    client.close(); await service.close(); service = await startWorkspaceService(directory, undefined, undefined, {}); client = await connectWorkspace(directory);
    assert.deepEqual(service.store.readSettings().value.diagnostics, value.diagnostics);
    assert.deepEqual((await client.call<SupportReport>('diagnostics.report')).workspace, report.workspace);
  } finally { client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
