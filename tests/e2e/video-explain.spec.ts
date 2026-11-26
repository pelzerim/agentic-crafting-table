import { test } from './visual-fixture.ts';
import { expect } from '@playwright/test';
import type { Locator } from '@playwright/test';

test('Explain in video is on pull request and agent menus with no setup, and the pull request entry hides while its agent is off', async ({ visual: { page } }) => {
  const pr = page.getByRole('article', { name: 'Plan switcher', exact: true }), agent = page.getByRole('article', { name: 'Claude · implementation', exact: true });
  const entries = async (item: Locator) => {
    await item.click({ button: 'right' }); await page.getByRole('menuitem').first().waitFor();
    const labels = await page.getByRole('menuitem').allTextContents();
    await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0);
    return labels;
  };
  const list = await entries(pr);
  expect(list.indexOf('Explain in video')).toBe(list.indexOf('Explain architecture') + 1);
  expect(await entries(agent)).toContain('Explain what you built in video');

  const write = (patch: object) => page.evaluate(async patch => { const current = await window.craftingTable.settingsRead(); await window.craftingTable.settingsWrite({ expectedRevision: current.revision, value: { ...current.value, ...patch } }); }, patch);
  await write({ agentProviders: { claude: false, codex: false, opencode: false, pi: false, gemini: false, grok: false }, videoSkill: { provider: 'codex', skillId: 'demo-video', name: 'demo-video' } });
  await expect.poll(() => entries(pr)).not.toContain('Explain in video');
  expect(await entries(agent)).toContain('Explain what you built in video');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Agents', exact: true }).locator(':scope > .settings-tree-row').click();
  await expect(page.getByText('Codex is turned off, so the pull request entry is hidden until it is on again.')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Video maker' })).toHaveValue('demo-video');
  await expect(page.getByText('No unsaved changes')).toBeVisible();
  expect(await page.evaluate(async () => (await window.craftingTable.settingsRead()).value.videoSkill)).toEqual({ provider: 'codex', skillId: 'demo-video', name: 'demo-video' });
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Video maker' })).toHaveValue('Built-in');
  await expect(page.getByRole('button', { name: 'Clear', exact: true })).toHaveCount(0);
});
