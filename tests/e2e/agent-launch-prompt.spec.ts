import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openProjectPicker } from './project-picker.ts';

// A stand-in Claude CLI: it answers the capability probes, records its arguments and stays open.
const FAKE_CLAUDE = `
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.281 (prompt test fixture)'); process.exit(0); }
if (args.includes('--help')) { console.log('--append-system-prompt --session-id --resume --mcp-config --plugin-dir --system-prompt-snapshot --remote-control\\n  --permission-mode <mode> (choices: "auto", "default", "plan")'); process.exit(0); }
if (args.includes('--input-format')) {
  process.stdin.setEncoding('utf8');
  let buffer = '';
  process.stdin.on('data', chunk => {
    buffer += chunk;
    for (let at = buffer.indexOf('\\n'); at >= 0; at = buffer.indexOf('\\n')) {
      const frame = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { commands: [], models: [], agents: [] } } }));
    }
  });
  process.stdin.on('end', () => process.exit(0));
} else {
  writeFileSync(join(process.cwd(), 'fixture-args.json'), JSON.stringify(args));
  console.log('PROMPT_FIXTURE_READY');
  setInterval(() => {}, 1000);
}
`;

test('a new agent session starts with the prompt typed in its start form', async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), 'craft-launch-prompt-'));
  const bin = join(directory, 'bin'), repo = join(directory, 'repo');
  await mkdir(bin); await mkdir(repo);
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\n${FAKE_CLAUDE}`, { mode: 0o700 });
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory, PATH: `${bin}:${process.env.PATH}` } });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Create your first project' }).waitFor();
    await page.evaluate(async folder => {
      const { state } = await window.craftingTable.workspaceRead();
      await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' },
        commands: [{ type: 'project.create', id: crypto.randomUUID(), title: 'Prompt project', summary: 'Fixture project for the start prompt.', workingDirectory: folder, position: { x: 300, y: 200 } }] });
    }, repo);
    await openProjectPicker(page, 'Prompt project');
    await page.getByRole('button', { name: 'Agent session', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill('Prompted Claude');
    const prompt = page.getByLabel('Prompt (optional)', { exact: true });
    await prompt.fill('Explain how retries work in this repo.');
    await page.locator('form.item-creation').screenshot({ path: 'test-results/pr/new-agent-prompt.png' });
    // Command+Enter starts the session from the prompt, as the Start button does.
    await prompt.press('ControlOrMeta+Enter');
    await expect(page.getByRole('article', { name: 'Prompted Claude' })).toBeVisible();
    const launched = () => readFile(join(repo, 'fixture-args.json'), 'utf8').then(text => JSON.parse(text) as string[]).catch(() => [] as string[]);
    await expect.poll(launched, { timeout: 30_000 }).toContain('--');
    const args = await launched();
    const opening = args.at(-1)!;
    expect(opening).toContain('Your task');
    expect(opening).toContain('Explain how retries work in this repo.');
    expect(opening).not.toContain('wait for my choice');
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
