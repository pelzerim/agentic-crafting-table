import { openProjectPicker } from './project-picker.ts';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { slackProviders, slackSelected, slackUrl } from '../fixtures/slack.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { resize, scrollbarArgs } from './visual-fixture.ts';

test('Slack URL attachment shows a paginated attributed thread, highlights the selected reply and retains stale content across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-slack-view-')), providers = slackProviders();
  let service = await startWorkspaceService(directory, undefined, undefined, providers);
  const launch = () => electron.launch({ args: ['.', '--force-device-scale-factor=1', '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, TZ: 'UTC' } });
  let app = await launch();
  try {
    let page = await app.firstWindow(); await resize(app, page, 1280, 800); await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'Create your first project' }).click(); await page.getByLabel('Title', { exact: true }).fill('Billing'); await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await openProjectPicker(page, 'Billing');
    await page.getByRole('button', { name: 'From URL', exact: true }).click();
    await expect(page.getByLabel('Title', { exact: true })).toHaveCount(0); await page.getByLabel('Item URL').fill(slackUrl); await page.getByRole('button', { name: 'Attach Slack', exact: true }).click();
    await expect(page.getByRole('form', { name: 'New item' })).toHaveCount(0); await page.getByRole('article', { name: /^#billing · Keep the current billing cycle/ }).click();
    const detail = page.locator('.slack-detail'), frame = page.locator('.item-view:visible'); await expect(detail).toContainText('How should we handle plan changes'); await expect(detail).toContainText('<script>window.slackInjected=true</script>'); expect(await page.evaluate(() => 'slackInjected' in window)).toBe(false);
    const selected = detail.locator('[data-selected=true]'); await expect(selected).toHaveCount(1); await expect(selected).toHaveAttribute('data-message-ts', slackSelected); await expect(selected).toContainText('Sam'); await expect(frame.getByRole('link', { name: 'Open in Slack', exact: true })).toHaveAttribute('href', slackUrl); await expect(frame.locator('.view-meta')).toHaveText('Thread · 2');
    const first = detail.locator('.slack-thread-message').first(); await expect(first).toContainText('How should we handle plan changes for @Sam? See the plans page and plan_switch_v2.');
    await expect(first.getByRole('link', { name: 'the plans page', exact: true })).toHaveAttribute('href', 'https://www.example.com/plans'); await expect(first.locator('code')).toHaveText('plan_switch_v2');
    await expect(frame.locator('.view-freshness')).toHaveAttribute('datetime', /^\d{4}-.*Z$/);
    await expect(frame).toHaveScreenshot('slack-thread-detail.png', { mask: [frame.locator('.view-freshness')] });
    providers.pages[1].messages[0].text = 'Keep the current billing cycle. ' + 'Show a preview before confirmation, including the effective date and how the next invoice changes. '.repeat(5);
    providers.pages[1].messages.push(...Array.from({ length: 6 }, (_, index) => ({ type: 'message', ts: `${1790000001 + index}.000001`, thread_ts: providers.pages[1].messages[0].thread_ts, user: index % 2 ? 'U12345' : 'U67890', text: `Follow-up ${index + 1}: ` + 'The confirmation should match the preview so that the customer can verify the change. '.repeat(3), reply_count: 0 })));
    await frame.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(detail.locator('.slack-thread-message')).toHaveCount(8);
    // A bounded item can be narrower than the reading measure; preserve the
    // 76ch cap without requiring unused space at every user-configured size.
    const measure = await selected.evaluate(element => ({ width: element.getBoundingClientRect().width, cap: parseFloat(getComputedStyle(element).maxWidth) }));
    expect(measure.cap).toBeGreaterThan(0);
    expect(measure.width).toBeLessThanOrEqual(measure.cap + 1);
    expect(measure.width).toBeLessThanOrEqual((await detail.boundingBox())!.width);
    await expect(selected).toHaveCSS('border-left-width', '3px');
    const viewport = page.locator('.resource-detail:visible');
    await expect(viewport).toHaveScreenshot('slack-long-thread.png');
    await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(detail.getByText(/^Follow-up 6:/)).toBeVisible();
    await expect(viewport).toHaveScreenshot('slack-long-thread-end.png');
    providers.pages[1].messages[0].text = 'Ship the billing-cycle change.'; await frame.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(selected).toContainText('Ship the billing-cycle change.');
    const before = await service.control.read();
    await exitWithoutShutdown(app); await service.close(); service = await startWorkspaceService(directory, undefined, undefined, providers); app = await launch(); page = await app.firstWindow();
    await page.getByRole('article', { name: '#billing · Ship the billing-cycle change.', exact: true }).click(); await expect(page.locator('.slack-detail [data-selected=true]')).toContainText('Ship the billing-cycle change.'); expect((await service.control.read()).resources).toEqual(before.resources);
    providers.before(method => { if (method === 'conversations.replies') throw new Error('Slack message is unavailable'); });
    await page.locator('.item-view:visible').getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(page.locator('.slack-detail')).toContainText('Slack message is unavailable'); await expect(page.locator('.item-view:visible .view-freshness')).toHaveText(/^Saved copy · \d\d:\d\d$/); await expect(page.locator('.slack-detail [data-selected=true]')).toContainText('Ship the billing-cycle change.');
    expect(providers.calls.every(call => ['auth.test', 'conversations.info', 'conversations.replies', 'users.info'].includes(call.method))).toBe(true);
  } finally { await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a newly attached Slack thread gets one AI summary title that refresh keeps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-slack-title-'));
  const requests: string[] = [];
  const providers = { ...slackProviders(), titleClient: { async complete(request: { messages: { content: string }[] }) { requests.push(request.messages[0].content); return 'Billing cycle decision'; } } };
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  const app = await electron.launch({ args: ['.'], env: { ...process.env, ACT_TEST_DATA_DIR: directory, TZ: 'UTC' } });
  try {
    const page = await app.firstWindow(); await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'Create your first project' }).click(); await page.getByLabel('Title', { exact: true }).fill('Billing'); await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await openProjectPicker(page, 'Billing');
    await page.getByRole('button', { name: 'From URL', exact: true }).click();
    await page.getByLabel('Item URL').fill(slackUrl); await page.getByRole('button', { name: 'Attach Slack', exact: true }).click();
    const card = page.getByRole('article', { name: 'Billing cycle decision', exact: true });
    await expect(card).toBeVisible();
    expect(requests).toHaveLength(1); expect(JSON.parse(requests[0])).toMatchObject({ kind: 'Slack thread', text: expect.stringContaining('Keep the current billing cycle') });
    await card.click();
    providers.pages[1].messages[0].text = 'Ship the billing-cycle change.';
    await page.locator('.item-view:visible').getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('.slack-detail [data-selected=true]')).toContainText('Ship the billing-cycle change.');
    await page.getByRole('button', { name: 'Back to project' }).click();
    await expect(page.getByRole('article', { name: 'Billing cycle decision', exact: true })).toBeVisible();
    expect(requests).toHaveLength(1);
  } finally { await exitWithoutShutdown(app); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
