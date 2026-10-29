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

const RECAP = 'I removed the legacy flag and the PR is ready for your review.';

/** The scripted native agent stands in for Claude; the recap is a fixture line in a temporary Claude config folder. */
test('an idle agent whose transcript gains a recap shows it in Needs me and on its large card; a new prompt clears it', async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-agent-recap-')), bin = join(directory, 'bin'), cwd = join(directory, 'repo');
  const claudeConfig = join(directory, 'claude-config'), transcripts = join(claudeConfig, 'projects', '-tmp-repo');
  await mkdir(bin); await mkdir(cwd); await mkdir(transcripts, { recursive: true });
  await writeFile(join(claudeConfig, '.claude.json'), '{}');
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-agent.mjs')).href)};\n`, { mode: 0o700 });
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory, CLAUDE_CONFIG_DIR: claudeConfig, SHELL: '/bin/sh', PATH: `${bin}:${process.env.PATH}` } });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Create your first project' }).waitFor();
    const projectId = randomUUID(), nodeId = randomUUID(), sessionId = randomUUID();
    await page.evaluate(async input => {
      let state = (await window.craftingTable.workspaceRead()).state;
      await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'project.create', id: input.projectId, title: 'Recap project', summary: 'BILLING_BRIEF', position: { x: 300, y: 200 } }] });
      state = (await window.craftingTable.workspaceRead()).state;
      await window.craftingTable.resourceCreate({ requestId: input.sessionId, nodeId: input.nodeId, resourceId: crypto.randomUUID(), expectedRevision: state.revision, projectId: input.projectId, title: 'Claude', position: { x: 600, y: 200 }, pluginId: 'agent.session', data: { cwd: input.cwd, provider: 'claude', model: 'opus' } });
    }, { projectId, nodeId, sessionId, cwd });
    const read = () => page.evaluate(() => window.craftingTable.workspaceRead());
    const node = async () => (await read()).state.nodes.find(candidate => candidate.id === nodeId)!;
    const terminal = async () => (await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).chunks.map(chunk => chunk.data).join('');
    const type = (data: string) => page.evaluate(input => window.craftingTable.sessionInput(input.sessionId, input.data), { sessionId, data });
    await expect.poll(terminal, { timeout: 30_000 }).toContain('NATIVE_IDLE:');
    await expect.poll(async () => (await node()).turnEndedAt).toBeTruthy();
    const opened = (await node()).turnEndedAt;
    await type('finish the flag removal\r');
    await expect.poll(async () => (await node()).turnEndedAt, { message: 'the turn has ended' }).not.toBe(opened);
    await page.evaluate(async id => {
      const { state } = await window.craftingTable.workspaceRead();
      await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: [{ type: 'node.resize', id, size: 'large' }] });
    }, nodeId);
    const card = page.locator(`[data-item-id="${nodeId}"]`).locator('.card-summary');
    await expect(card).toBeVisible();

    const nativeSessionId = String((await read()).state.resources.find(resource => resource.data.sessionId === sessionId)!.data.nativeSessionId);
    await writeFile(join(transcripts, `${nativeSessionId}.jsonl`), [
      JSON.stringify({ type: 'user', timestamp: new Date(Date.now() - 60_000).toISOString(), message: { role: 'user', content: 'finish the flag removal' } }),
      JSON.stringify({ type: 'system', subtype: 'away_summary', content: `${RECAP} (disable recaps in /config)`, timestamp: new Date().toISOString(), sessionId: nativeSessionId, uuid: randomUUID() }),
    ].join('\n') + '\n');
    await expect.poll(async () => (await node()).recap?.text, { timeout: 45_000, intervals: [1_000] }).toBe(RECAP);

    await expect(card).toContainText(RECAP);
    await expect(card).toHaveAttribute('data-said', 'true');
    await page.getByRole('button', { name: /^Needs me(: \d+)?$/ }).click();
    const row = page.getByRole('dialog', { name: 'Needs me', exact: true }).locator('.attention-row').filter({ hasText: RECAP });
    await expect(row.locator('.attention-summary')).toHaveText(RECAP);
    await expect(row.locator('.attention-summary')).toHaveAttribute('data-said', 'true');
    await page.keyboard.press('Escape');

    await type('work\r');
    await expect.poll(async () => (await node()).recap).toBeUndefined();
    await expect(card).not.toContainText(RECAP);
  } finally {
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
