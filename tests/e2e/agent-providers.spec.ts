import { openProjectPicker } from './project-picker.ts';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A stand-in `pi`: it answers the probe and then shows the arguments the table started it with.
const FIXTURE_PI = `#!/bin/sh
case "$1" in --version) echo "0.0.0-fixture"; exit 0;; --help) echo "--session-id --append-system-prompt --model"; exit 0;; esac
echo "PI_FIXTURE_ARGS: $*"
exec cat
`;

test('AGENT-01b: an agent CLI turned on in Settings is offered in the start form and runs in its terminal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-agent-providers-')), bin = join(directory, 'bin'), repo = join(directory, 'repo');
  await mkdir(bin); await mkdir(repo); await writeFile(join(bin, 'pi'), FIXTURE_PI, { mode: 0o700 });
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory, PATH: `${bin}:${process.env.PATH}` } });
  try {
    const page = await app.firstWindow();

    const startForm = async () => { await openProjectPicker(page, 'Agents project'); await page.getByRole('button', { name: 'Agent session', exact: true }).click(); };
    const providers = page.getByRole('radiogroup', { name: 'Provider' });

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('treeitem', { name: 'Agents', exact: true }).locator(':scope > .settings-tree-row').click();
    await page.getByRole('treeitem', { name: 'Pi', exact: true }).click();
    const offer = page.getByRole('group', { name: 'Pi settings' }).getByLabel('Enabled', { exact: true }).first();
    await expect(offer).not.toBeChecked(); await offer.check();
    await expect(page.getByRole('group', { name: 'Pi settings' })).toContainText('Not available');
    await page.screenshot({ path: 'test-results/pr/agent-providers-settings.png' });
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    expect((await page.evaluate(() => window.craftingTable.settingsRead())).value.agentProviders).toEqual({ claude: true, codex: true, opencode: false, pi: true, gemini: false, grok: false });

    await page.getByRole('button', { name: 'Create your first project' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Agents project');
    await page.getByLabel('Project working directory', { exact: true }).fill(repo);
    await page.getByRole('button', { name: 'Create project', exact: true }).click();

    await startForm();
    await expect(providers.getByRole('radio')).toHaveCount(3);
    await providers.getByRole('radio', { name: 'Pi', exact: true }).check();
    await expect(providers.locator('label').filter({ has: page.getByRole('radio', { name: 'Pi', exact: true }) }).locator('svg.brand-pi')).toBeVisible();
    await expect(page.getByLabel('Model', { exact: true })).toHaveValue('default');
    await page.screenshot({ path: 'test-results/pr/agent-providers-start-form.png' });
    await page.getByLabel('Title', { exact: true }).fill('Pi helper');
    await page.getByRole('button', { name: 'Start Pi', exact: true }).click();
    await expect(page.getByRole('article', { name: 'Pi helper', exact: true }).locator('.item-glyph.brand-pi')).toBeVisible();
    await page.getByRole('article', { name: 'Pi helper', exact: true }).click();
    await expect(page.locator('.xterm-accessibility')).toContainText('PI_FIXTURE_ARGS: --session-id');
    await expect(page.locator('.xterm-accessibility')).toContainText('no crafting table tools');
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
