import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';

test('a permission prompt raised after the turn ended clears once it is answered, by subagent work or by the person', async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-permission-after-stop-')), bin = join(directory, 'bin'), cwd = join(directory, 'repo');
  await mkdir(bin); await mkdir(cwd);
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-agent.mjs')).href)};\n`, { mode: 0o700 });
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/sh', PATH: `${bin}:${process.env.PATH}` } });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Create your first project' }).waitFor();
    const projectId = randomUUID(), nodeId = randomUUID(), sessionId = randomUUID();
    await page.evaluate(async input => {
      let state = (await window.craftingTable.workspaceRead()).state;
      await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'project.create', id: input.projectId, title: 'Prompt project', summary: 'BILLING_BRIEF', position: { x: 300, y: 200 } }] });
      state = (await window.craftingTable.workspaceRead()).state;
      await window.craftingTable.resourceCreate({ requestId: input.sessionId, nodeId: input.nodeId, resourceId: crypto.randomUUID(), expectedRevision: state.revision, projectId: input.projectId, title: 'Claude', position: { x: 600, y: 200 }, pluginId: 'agent.session', data: { cwd: input.cwd, provider: 'claude', model: 'opus' } });
    }, { projectId, nodeId, sessionId, cwd });
    const terminal = async () => (await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).chunks.map(chunk => chunk.data).join('');
    const node = async () => {
      const found = (await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes.find(candidate => candidate.id === nodeId)!;
      return { activity: found.activity, attention: found.attention, note: found.attentionNote, summary: found.summary };
    };
    const asking = { activity: 'idle', attention: 'input', note: 'Agent needs permission', summary: 'Waiting for your input' };
    const ready = { activity: 'idle', attention: 'none', note: undefined, summary: 'Ready for your next prompt' };
    const type = (data: string) => page.evaluate(input => window.craftingTable.sessionInput(input.sessionId, input.data), { sessionId, data });
    await expect.poll(terminal).toContain('NATIVE_IDLE:');
    await expect.poll(node).toEqual(ready);

    await type('permission-after-stop\r');
    await expect.poll(node).toEqual(asking);
    await type('subagent-tool\r');
    await expect.poll(node, { timeout: 5_000 }).toEqual(ready);

    await type('permission-after-stop\r');
    await expect.poll(async () => (await terminal()).split('PERMISSION_DIALOG').length).toBe(3);
    await expect.poll(node).toEqual(asking);
    const prompted = Date.now();
    await type('\x1b[B');
    expect((await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session.decisiveInputAt).toBeLessThan(prompted);
    await type('1');
    expect((await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session.decisiveInputAt).toBeGreaterThanOrEqual(prompted);
    await page.waitForTimeout(8_000);
    expect(await node(), 'the terminal has not been quiet long enough').toEqual(asking);
    await expect.poll(node, { timeout: 40_000, intervals: [1_000] }).toEqual(ready);
  } finally {
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
