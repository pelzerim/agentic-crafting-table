import { openProjectPicker } from './project-picker.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, readFile, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';

test('scripted native agent receives context, registers a PR through MCP, reconnects and resumes', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-agent-loop-'));
  const bin = join(directory, 'bin'), repo = join(directory, 'repo');
  await mkdir(bin); await mkdir(repo);
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(resolve('tests/fixtures/native-agent.mjs')).href)};\n`, { mode: 0o700 });
  const nativeConfig = join(directory, 'claude-history'), otherRepo = join(directory, 'other-repo'), importedId = randomUUID();
  const nativeFolder = join(nativeConfig, 'projects', otherRepo.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(otherRepo); await mkdir(nativeFolder, { recursive: true });
  await writeFile(join(nativeFolder, `${importedId}.jsonl`), JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: importedId, cwd: otherRepo, isSidechain: false, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Earlier terminal conversation' } }) + '\n');
  await writeFile(join(otherRepo, 'fixture-conversation.json'), JSON.stringify({ nativeId: importedId }));
  const env = { ...process.env, ACT_TEST_DATA_DIR: directory, CLAUDE_CONFIG_DIR: nativeConfig, PATH: `${bin}:${process.env.PATH}` };
  let app = await electron.launch({ args: ['.'], env });
  try {
    let page = await app.firstWindow();
    await page.evaluate(async () => { const current = await window.craftingTable.settingsRead(); await window.craftingTable.settingsWrite({ expectedRevision: current.revision, value: { ...current.value, claude: { ...current.value.claude, remoteControl: true, arguments: ['--effort', 'high'] } } }); });
    await page.getByRole('button', { name: 'Create your first project' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Agent project');
    await page.getByLabel('Project summary', { exact: true }).fill('BILLING_BRIEF');
    await page.getByLabel('Project working directory', { exact: true }).fill(repo);
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await page.evaluate(async () => {
      const { state } = await window.craftingTable.workspaceRead(), projectId = state.nodes.find(node => !node.resourceId)!.id;
      await window.craftingTable.workspaceApply({ commandId: 'opening-context-fixture', expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands: [
        { type: 'item.add', id: 'opening-pr', resourceId: 'opening-pr-r', pluginId: 'github.pull-request', title: 'Existing billing PR', projectId, position: { x: 950, y: 400 }, data: { owner: 'fixture', repo: 'local-only', number: 41 } },
        { type: 'item.create', id: 'opening-review', projectId, position: { x: 1200, y: 400 }, resource: { id: 'opening-review-r', pluginId: 'code.review', schemaVersion: 1, title: 'Completed billing review', data: { provider: 'claude', model: 'opus', sourcePrId: 'opening-pr', sessionId: 'fixture-no-process', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) } } },
        { type: 'node.update', id: 'opening-review', activity: 'complete', summary: 'Review finished; inspect findings' },
        { type: 'item.add', id: 'opening-z-note', resourceId: 'opening-note-r', pluginId: 'workspace.note', title: 'Review follow-up', projectId, position: { x: 1400, y: 400 }, data: { text: 'Consider downgrade edge cases after reading the review.' } },
        { type: 'link.save', link: { id: 'opening-review-pr', sourceId: 'opening-review', targetId: 'opening-pr', kind: 'reference', label: '' } },
        { type: 'link.save', link: { id: 'opening-note-review', sourceId: 'opening-z-note', targetId: 'opening-review', kind: 'reference', label: '' } },
      ] });
    });
    await openProjectPicker(page, 'Agent project');
    await page.getByRole('button', { name: 'Agent session', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New session', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('searchbox', { name: 'Find a saved session' })).toHaveCount(0);
    await expect(page.getByRole('listbox', { name: 'Saved sessions' })).toHaveCount(0);
    await page.getByLabel('Title', { exact: true }).fill('Scripted Claude');
    await page.getByRole('button', { name: 'Continue session', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toBeDisabled();
    await expect(page.getByLabel('Working directory', { exact: true })).toHaveCount(0);
    await page.getByRole('option', { name: /Earlier terminal conversation/ }).click();
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await expect(page.getByRole('listbox', { name: 'Saved sessions' })).toHaveCount(0);
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Scripted Claude');
    await page.screenshot({ path: 'test-results/new-agent-form.png' });
    await expect(page.getByLabel('Working directory', { exact: true })).toHaveValue(repo);
    await expect(page.getByLabel('Task', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Project brief override (optional)', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
    await page.getByRole('article', { name: 'Scripted Claude' }).click();
    await expect(page.locator('.xterm-accessibility')).toContainText('NATIVE_IDLE:');
    await expect(page.locator('.xterm-accessibility')).toContainText('What next (scripted fixture)');
    const opening = JSON.parse(await readFile(join(repo, 'fixture-opening-context.json'), 'utf8'));
    expect(opening.prompt).toContain('wait for my choice'); expect(opening.prompt).toContain('captured revision');
    // Nothing is connected to this new agent yet: project items are brief background, not its context.
    expect(opening.context.hierarchy.entries).toEqual([]);
    expect(opening.context.hierarchy.projectItems.map((item: { nodeId: string }) => item.nodeId).sort()).toEqual(['opening-pr', 'opening-review', 'opening-z-note']);
    expect(opening.prompt).toContain('connected to this agent');
    expect(opening.hook.hookSpecificOutput.additionalContext).toContain('Review follow-up');
    expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes.some(node => node.id === 'fixture-pr')).toBe(false);
    expect(JSON.parse(await readFile(join(repo, 'fixture-flags.json'), 'utf8'))).toEqual({ remoteControl: true, permissionMode: 'auto', effort: 'high' });
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('REGISTER_FIXTURE_PR\n');
    await expect.poll(async () => (await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes.some(node => node.id === 'fixture-pr')).toBe(true);

    const state = (await page.evaluate(() => window.craftingTable.workspaceRead())).state;
    const node = state.nodes.find(node => node.title === 'Scripted Claude')!;
    const resource = state.resources.find(resource => resource.id === node.resourceId)!;
    const sessionId = String(resource.data.sessionId);
    await expect.poll(async () => (await page.evaluate(() => window.craftingTable.workspaceRead())).state.links).toContainEqual(expect.objectContaining({ sourceId: 'fixture-pr', targetId: node.id, kind: 'reference' }));
    expect(state.nodes.find(node => node.id === 'fixture-pr')?.projectId).toBe(node.projectId);
    await page.getByRole('region', { name: 'Scripted Claude' }).click();
    const surface = page.locator('.terminal-surface');
    const mount = await surface.getAttribute('data-mount-id');
    await expect.poll(async () => (await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).chunks.map(chunk => chunk.data).join('')).toContain('NATIVE_IDLE:');
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    await page.keyboard.type('typed-in-native-terminal\n');
    await expect.poll(() => readFile(join(repo, 'fixture-input.txt'), 'utf8').catch(() => '')).toBe('typed-in-native-terminal');
    await expect.poll(async () => (await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes.find(item => item.id === node.id)?.activity).toBe('idle');
    await expect(surface).toHaveAttribute('data-mount-id', mount!); // Status hooks cannot remount xterm.
    const status = async () => { const item = (await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes.find(item => item.id === node.id); return [item?.activity, item?.summary]; };
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('background\n');
    await expect.poll(status).toEqual(['working', 'Waiting on 1 subagent']);
    await page.keyboard.type('background-done\n');
    await expect.poll(status).toEqual(['idle', 'Ready for your next prompt']);
    const original = await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId);
    const menu = page.getByRole('button', { name: 'Agent session menu' });
    await menu.focus(); await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Resume / reconnect', exact: true })).toBeFocused();
    await page.keyboard.press('End'); await expect(page.getByRole('menuitem', { name: 'Add system prompt' })).toBeFocused();
    await expect(page.getByRole('menu', { name: 'Agent session actions' })).toHaveScreenshot('agent-session-menu.png');
    await page.keyboard.press('Escape'); await expect(menu).toBeFocused();
    await expect(page.getByRole('menu', { name: 'Agent session actions' })).toHaveCount(0);
    await menu.click(); await page.locator('.terminal-surface').click();
    await expect(page.getByRole('menu', { name: 'Agent session actions' })).toHaveCount(0);
    // A permission prompt is not an input boundary: queuing never types or confirms it.
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('wait-for-input\n');
    await expect.poll(async () => (await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes.find(item => item.id === node.id)?.attention).toBe('input');
    await menu.click(); await page.getByRole('menuitem', { name: 'Add system prompt' }).click();
    await expect(page.locator('.terminal-prompt-status')).toContainText('Queued for your next prompt');
    expect(await readFile(join(repo, 'fixture-input.txt'), 'utf8')).toBe('typed-in-native-terminal');
    expect(await readFile(join(repo, 'fixture-injected-context.json'), 'utf8').catch(() => '')).toBe('');
    expect((await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session.pid).toBe(original.session.pid);
    await menu.click(); await expect(page.getByRole('menuitem', { name: 'Add system prompt' })).toBeDisabled();
    await page.keyboard.press('Escape');
    // The reference is resolved at delivery, not frozen when the menu was clicked.
    await page.evaluate(async projectId => {
      const state = (await window.craftingTable.workspaceRead()).state;
      await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), actor: { kind: 'user', id: 'test' }, expectedRevision: state.revision, commands: [{ type: 'node.update', id: projectId!, summary: 'BILLING_BRIEF UPDATED_BEFORE_DELIVERY' }] });
    }, node.projectId);
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('receive-context\n');
    await expect(page.locator('.terminal-prompt-status')).toContainText('acknowledged by Claude');
    const injected = JSON.parse(await readFile(join(repo, 'fixture-injected-context.json'), 'utf8'));
    expect(injected.text).toContain('immediately register its URL');
    expect(injected.reference.projectSummary).toContain('UPDATED_BEFORE_DELIVERY');
    expect(injected.reference).not.toHaveProperty('guide');
    expect((await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session.pid).toBe(original.session.pid);
    await expect(surface).toHaveAttribute('data-mount-id', mount!);
    await page.getByRole('button', { name: 'Agent session menu' }).click();
    await page.getByRole('menuitem', { name: 'Resume / reconnect', exact: true }).click();
    expect((await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session.pid).toBe(original.session.pid);
    await exitWithoutShutdown(app); app = await electron.launch({ args: ['.'], env }); page = await app.firstWindow();
    await page.getByRole('article', { name: 'Scripted Claude' }).click();
    expect((await page.evaluate(id => window.craftingTable.sessionRead(id), sessionId)).session.pid).toBe(original.session.pid);
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('exit\n');
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'exited');
    await page.evaluate(async () => { const current = await window.craftingTable.settingsRead(); await window.craftingTable.settingsWrite({ expectedRevision: current.revision, value: { ...current.value, claude: { ...current.value.claude, autoMode: false } } }); });
    await page.getByRole('button', { name: 'Agent session menu' }).click();
    await page.getByRole('menuitem', { name: 'Resume / reconnect', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.craftingTable.workspaceRead())).state.resources.find(item => item.id === resource.id)?.data.sessionId).not.toBe(sessionId);
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'running');
    await expect.poll(async () => {
      const saved = (await page.evaluate(() => window.craftingTable.workspaceRead())).state.resources.find(item => item.id === resource.id)!;
      const current = await page.evaluate(id => window.craftingTable.sessionRead(id), String(saved.data.sessionId));
      return current.chunks.map(chunk => chunk.data).join('');
    }).toContain(`NATIVE_RESUMED:${resource.data.nativeSessionId}`);
    expect(JSON.parse(await readFile(join(repo, 'fixture-flags.json'), 'utf8')).permissionMode).toBe('default');
    expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state.nodes.filter(node => node.id === 'fixture-pr')).toHaveLength(1);
    // Stop must preserve an alternate-screen application despite its teardown bytes.
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('screen\n');
    await expect(page.locator('.xterm-accessibility')).toContainText('RETAIN_THIS_NATIVE_SCREEN');
    await page.getByRole('button', { name: 'Stop session', exact: true }).click();
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'exited');
    await expect(page.locator('.xterm-accessibility')).toContainText('RETAIN_THIS_NATIVE_SCREEN');
    await page.getByRole('button', { name: 'Agent session menu' }).click();
    await expect(page.getByRole('menuitem', { name: 'History', exact: true })).toHaveCount(0);
    await expect(page.getByRole('slider', { name: 'Recording position' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Add system prompt' })).toBeDisabled();
    await expect(page.getByRole('menu', { name: 'Agent session actions' })).toContainText('Resume the session');
    await page.keyboard.press('Escape');
    await exitWithoutShutdown(app); app = await electron.launch({ args: ['.'], env }); page = await app.firstWindow();
    await page.getByRole('article', { name: 'Scripted Claude' }).click();
    await expect(page.locator('.native-terminal')).toHaveAttribute('data-session-state', 'exited');
    await expect(page.locator('.xterm-accessibility')).toContainText('RETAIN_THIS_NATIVE_SCREEN');
    await page.screenshot({ path: 'test-results/scripted-agent.png' });
    await page.getByRole('button', { name: 'Back to project' }).click();
    await openProjectPicker(page, 'Agent project');
    await page.getByRole('button', { name: 'Agent session', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill('Idle Claude');
    await page.getByLabel('Model', { exact: true }).selectOption('fable');
    await expect(page.getByLabel('Working directory', { exact: true })).toHaveValue(repo);
    await expect(page.getByLabel('Task', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Start Claude', exact: true }).click();
    await page.getByRole('article', { name: 'Idle Claude' }).click();
    await expect(page.locator('.map-card.expanded .native-terminal')).toHaveAttribute('data-session-state', 'running');
    await expect(page.locator('.map-card.expanded .xterm-accessibility')).toContainText('NATIVE_IDLE:');
    await page.getByRole('button', { name: 'Back to project' }).click();
    await openProjectPicker(page, 'Agent project');
    await page.getByRole('button', { name: 'Agent session', exact: true }).click();
    await page.getByRole('button', { name: 'Continue session', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Find a saved session' }).fill('Earlier terminal');
    await page.getByRole('option', { name: /Earlier terminal conversation/ }).click();
    await page.screenshot({ path: 'test-results/saved-session-picker.png' });
    await page.getByRole('button', { name: 'Resume session', exact: true }).click();
    await page.getByRole('article', { name: 'Earlier terminal conversation' }).click();
    await expect(page.locator('.map-card.expanded .xterm-accessibility')).toContainText(`NATIVE_RESUMED:${importedId}`);
    const imported = (await page.evaluate(() => window.craftingTable.workspaceRead())).state.resources.find(item => item.data.nativeSessionId === importedId)!;
    expect(imported.data.cwd).toBe(await realpath(otherRepo));
    expect(imported.data.model).toBe('native');
    const beforeReconnect = await page.evaluate(id => window.craftingTable.sessionRead(id), String(imported.data.sessionId));
    await page.getByRole('button', { name: 'Back to project' }).click();
    await openProjectPicker(page, 'Agent project');
    await page.getByRole('button', { name: 'Agent session', exact: true }).click();
    await page.getByRole('button', { name: 'Continue session', exact: true }).click();
    await page.getByRole('option', { name: /Earlier terminal conversation/ }).click();
    await page.getByRole('button', { name: 'Resume session', exact: true }).click();
    await expect(page.getByRole('form', { name: 'New item' })).toHaveCount(0);
    expect((await page.evaluate(() => window.craftingTable.workspaceRead())).state.resources.filter(item => item.data.nativeSessionId === importedId)).toHaveLength(1);
    expect((await page.evaluate(id => window.craftingTable.sessionRead(id), String(imported.data.sessionId))).session.pid).toBe(beforeReconnect.session.pid);


  } finally {
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { const disconnected = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await disconnected; client.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
