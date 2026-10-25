import { expect, type Page } from '@playwright/test';
import { test } from './visual-fixture.ts';

const apply = (page: Page, command: Record<string, unknown>) => page.evaluate(async command => {
  const { state } = await window.craftingTable.workspaceRead();
  await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), actor: { kind: 'user', id: 'test' }, expectedRevision: state.revision, commands: [command as never] });
}, command);
const summary = (page: Page) => page.getByRole('article', { name: 'Claude · implementation', exact: true }).locator('.card-summary');

test(`a large agent card shows the line the agent ended its turn on; a medium card keeps its summary`, async ({ visual: { page } }) => {
  await expect(summary(page)).toContainText('Updating the plan switcher');
  await apply(page, { type: 'node.update', id: 'agent', lastLine: 'Tests pass; the PR is ready for review.' });
  await expect(summary(page)).toContainText('Tests pass; the PR is ready for review.');
  await expect(summary(page)).not.toContainText('Updating the plan switcher');
  await expect(summary(page)).toHaveAttribute('data-said', 'true');
  await apply(page, { type: 'node.resize', id: 'agent', size: 'medium' });
  await expect(summary(page)).toContainText('Updating the plan switcher');
  await expect(summary(page)).not.toHaveAttribute('data-said');
  await apply(page, { type: 'node.resize', id: 'agent', size: 'large' });
  await apply(page, { type: 'node.update', id: 'agent', lastLine: null });
  await expect(summary(page)).toContainText('Updating the plan switcher');
});
