import { expect } from '@playwright/test';
import { join } from 'node:path';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { openDiagnosticSessions } from './session-navigation.ts';
import { test, openTerminal } from './visual-fixture.ts';

test('Sessions separates Current, Ended and Archived, shows newest ended first and pages with Show more', async ({ visual: { app, page } }) => {
  test.setTimeout(90_000);
  await openTerminal(page);
  const running = (await page.locator('.terminal-surface').getAttribute('data-terminal-id'))!;
  const directory = await app.evaluate(({ app }) => app.getPath('userData'));
  const supervisor = await connectSupervisor(join(directory, 'runtime'));
  const ended = Array.from({ length: 53 }, (_, index) => `ended-${String(index).padStart(2, '0')}`);
  try {
    for (const id of [...ended, 'archived-entry']) {
      await supervisor.call('sessions.launch', { sessionId: id, requestId: `request-${id}`, nodeId: `node-${id}`, workspaceId: 'fixture', executable: '/bin/sh', args: ['-c', 'exit 0'], cwd: directory });
      await expect.poll(async () => (await supervisor.call<{ session: { state: string } }>('sessions.read', { sessionId: id })).session.state).toBe('exited');
    }
    await supervisor.call('sessions.manage', { sessionId: 'archived-entry', action: 'archive' });
  } finally { supervisor.close(); }

  await page.getByRole('button', { name: 'Back to project' }).click();
  await openDiagnosticSessions(page);
  const views = page.getByRole('group', { name: 'Session views' });
  await expect(views.getByRole('button', { name: 'Current sessions' })).toHaveAttribute('aria-pressed', 'true');
  await expect(views.getByRole('button', { name: 'Current sessions' }).locator('.settings-count')).toHaveText('1');
  await expect(views.getByRole('button', { name: 'Ended sessions' }).locator('.settings-count')).toHaveText('53');
  await expect(views.getByRole('button', { name: 'Archived sessions' }).locator('.settings-count')).toHaveText('1');
  const current = page.getByRole('list', { name: 'Current sessions' });
  await expect(current.locator('[data-session-id]')).toHaveCount(1);
  await expect(current.locator(`[data-session-id="${running}"]`)).toContainText('running');
  await expect(page.getByRole('button', { name: 'Show more', exact: true })).toHaveCount(0);

  await views.getByRole('button', { name: 'Ended sessions' }).click();
  const endedList = page.getByRole('list', { name: 'Ended sessions' }), rows = endedList.locator('[data-session-id]');
  await expect(rows).toHaveCount(50);
  await expect(rows.first()).toHaveAttribute('data-session-id', 'ended-52');
  await expect(rows.nth(49)).toHaveAttribute('data-session-id', 'ended-03');
  await expect(endedList.locator(`[data-session-id="${running}"], [data-session-id="archived-entry"]`)).toHaveCount(0);
  await expect(rows.first().getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Show more', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/session-views-show-more.png' });
  await page.getByRole('button', { name: 'Show more', exact: true }).click();
  await expect(rows).toHaveCount(53);
  await expect(rows.last()).toHaveAttribute('data-session-id', 'ended-00');
  await expect(page.getByRole('button', { name: 'Show more', exact: true })).toHaveCount(0);

  // Archiving from Ended moves the entry and updates every count.
  await endedList.locator('[data-session-id="ended-52"]').getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(rows).toHaveCount(52);
  await expect(views.getByRole('button', { name: 'Ended sessions' }).locator('.settings-count')).toHaveText('52');
  await expect(views.getByRole('button', { name: 'Archived sessions' }).locator('.settings-count')).toHaveText('2');
  await views.getByRole('button', { name: 'Archived sessions' }).click();
  const archived = page.getByRole('list', { name: 'Archived sessions' }).locator('[data-session-id]');
  await expect(archived).toHaveCount(2);
  await expect(page.getByRole('list', { name: 'Archived sessions' }).locator('[data-session-id="archived-entry"]')).toContainText('exited');

  // Stopping a current session moves it to Ended.
  await views.getByRole('button', { name: 'Current sessions' }).click();
  await current.locator(`[data-session-id="${running}"]`).getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(current.locator('[data-session-id]')).toHaveCount(0);
  await expect(current).toContainText('No current sessions');
  await views.getByRole('button', { name: 'Ended sessions' }).click();
  await expect(rows.first()).toHaveAttribute('data-session-id', running);
});
