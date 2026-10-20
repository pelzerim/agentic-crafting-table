import { test, expect, _electron as electron } from '@playwright/test';
import { choose } from './combobox.ts';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { openProjectPicker, projectEmptyPoint } from './project-picker.ts';

test('project skills launch native runs through UI and MCP, preserve retries and resume without reinvocation', async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-skills-ui-')), bin = join(directory, 'bin'), repo = join(directory, 'repo');
  await mkdir(bin); await mkdir(repo);
  for (const [command, file] of [['claude', 'native-agent'], ['codex', 'native-codex']]) await writeFile(join(bin, command), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve(`tests/fixtures/${file}.mjs`)).href)};\n`, { mode: 0o700 });
  const scrollbars = process.platform === 'darwin' ? ['-AppleShowScrollBars', 'WhenScrolling'] : [];
  const app = await electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbars], env: { ...process.env, ACT_TEST_DATA_DIR: directory, CODEX_FIXTURE_HOME: repo, PATH: `${bin}:${process.env.PATH}` } });
  const mcp = new Client({ name: 'skills-contract-test', version: '1' });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Create your first project' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Skill project');
    await page.getByLabel('Project summary', { exact: true }).fill('BILLING_BRIEF');
    await page.getByLabel('Project working directory', { exact: true }).fill(repo);
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    const read = async () => (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
    const projectId = (await read()).nodes[0].id;
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('dist/mcp-bridge.cjs')], env: { ...process.env as Record<string,string>, ACT_DATA_DIR: directory }, stderr: 'pipe' }));
    const call = async (name: string, args: Record<string, unknown>) => { const result = await mcp.callTool({ name, arguments: args }); expect(result.isError).not.toBe(true); return JSON.parse((result.content as { text: string }[])[0].text); };
    for (const provider of ['claude', 'codex']) {
      const sourceId = (await read()).nodes.find(node => node.resourceId)?.id;
      if (provider === 'claude') await openProjectPicker(page, 'Skill project');
      else {
        const point = await projectEmptyPoint(page, 'Skill project');
        const item = page.getByRole('article', { name: 'fixture-skill', exact: true }); await item.hover();
        const handle = (await item.getByRole('button', { name: 'Connect fixture-skill', exact: true }).boundingBox())!;
        await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
        await page.mouse.move(point.x, point.y, { steps: 10 }); await page.mouse.up();
      }
      await page.getByRole('button', { name: 'Run skill', exact: true }).click();
      const form = page.getByRole('form', { name: 'Run project skill' });
      await choose(form, 'Provider', provider);
      await expect(form.getByRole('option', { name: /fixture-skill/ })).toBeVisible();
      await expect(form.getByLabel('Skill working directory')).toHaveValue(repo);
      expect(await form.getByRole('option', { name: /exit/ }).count()).toBe(0);
      if (provider === 'codex') await expect(form.getByRole('option', { name: /disabled-skill/ })).toBeDisabled();
      const before = await form.boundingBox(), heading = await form.locator('.editor-heading').boundingBox();
      await page.mouse.move(heading!.x + 50, heading!.y + 12); await page.mouse.down(); await page.mouse.move(heading!.x + 100, heading!.y + 22, { steps: 5 }); await page.mouse.up();
      expect((await form.boundingBox())!.x).toBeGreaterThan(before!.x);
      await form.getByRole('option', { name: /fixture-skill/ }).click();
      await form.getByLabel('Skill arguments').fill('literal $(touch no) `no` "quotes"');
      await choose(form, 'Model', provider === 'claude' ? 'fable' : 'fixture-choice');
      if (provider === 'claude') await expect(form).toHaveScreenshot('project-skills.png', { mask: [form.getByLabel('Skill working directory')], animations: 'disabled' });
      await form.getByRole('button', { name: 'Run skill', exact: true }).click();
      await expect(form).toHaveCount(0);
      const graph = await read(), resource = graph.resources.find(resource => resource.data.provider === provider)!;
      const node = graph.nodes.find(node => node.resourceId === resource.id)!;
      expect(node.projectId).toBe(projectId); expect(resource.data.skill).toMatchObject({ name: 'fixture-skill' });
      if (provider === 'codex') expect(graph.links).toContainEqual(expect.objectContaining({ sourceId, targetId: node.id, kind: 'context' }));
      const sessionId = String(resource.data.sessionId);
      await page.locator(`article[data-item-id="${node.id}"]`).click();
      const item = page.locator(`[data-expanded-item-id="${node.id}"]`);
      await expect(item.locator('.xterm-accessibility')).toContainText(provider === 'claude' ? 'SKILL_PROMPT:/fixture-skill literal' : 'INITIAL_PROMPT:$fixture-skill literal');
      await expect(item.locator('.terminal-launch')).toContainText(provider === 'claude' ? 'claude · fable' : 'codex · fixture-choice');
      const first = await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId);
      const plan = JSON.parse(await readFile(join(directory, 'agent-launches', sessionId, 'plan.json'), 'utf8'));
      const original = plan.source.request;
      const replay = { projectId, requestId: original.requestId, nodeId: original.nodeId, resourceId: original.resourceId, expectedRevision: original.expectedRevision,
        ...original.data, position: original.position, ...(original.connection ? { connection: original.connection } : {}) };
      const replayed = await call('workspace_run_skill', replay);
      expect(replayed.session.pid).toBe(first.session.pid); expect((await read()).nodes.filter(node => node.resourceId)).toHaveLength(provider === 'claude' ? 1 : 2);
      const metadata = await call('workspace_skills', { projectId, provider });
      expect(metadata.skills.some((skill: {name:string}) => skill.name === 'fixture-skill')).toBe(true);
      await page.getByRole('button', { name: 'Stop session', exact: true }).click();
      await expect(item.locator('.native-terminal')).toHaveAttribute('data-session-state', 'exited');
      await page.getByRole('button', { name: 'Agent session menu' }).click();
      await page.getByRole('menuitem', { name: 'Resume / reconnect', exact: true }).click();
      await expect(item.locator('.xterm-accessibility')).toContainText(provider === 'claude' ? 'NATIVE_RESUMED:' : 'NATIVE_READY:');
      const resumed = (await read()).resources.find(item => item.id === resource.id)!;
      const resumedPlan = JSON.parse(await readFile(join(directory, 'agent-launches', String(resumed.data.sessionId), 'plan.json'), 'utf8'));
      expect(resumedPlan.launch.native?.initialPrompt).toBeUndefined(); expect(resumedPlan.launch.args.includes('--')).toBe(false);
      await page.getByRole('button', { name: 'Stop session', exact: true }).click();
      await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    }
  } finally {
    await mcp.close(); await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { const ended = once(client, 'disconnected', { signal: AbortSignal.timeout(7000) }); await client.call('admin.shutdown'); await ended; client.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
