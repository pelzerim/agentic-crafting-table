import { openProjectPicker } from './project-picker.ts';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { startWorkspaceService } from '../../packages/workspace-service/server.ts';
import { enableShowShip, githubFixture } from '../fixtures/github.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { scrollbarArgs, resize } from './visual-fixture.ts';
import { prActions } from './pr-actions.ts';

test('URL-only PR attachment reuses an agent-created item and displays real provider content safely across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-pr-view-')), providers = githubFixture();
  providers.pull.body = '## Changes\n\n**Billing** stays predictable.\n\n| Plan | Timing |\n| --- | --- |\n| Pro | Next cycle |\n\n- [x] Covered\n\n<script>window.providerScriptExecuted=true</script>';
  providers.comments[0].body = 'Please keep **the current cycle** unchanged.\n\n```ts\nscheduleNextCycle(plan)\n```';
  providers.inline = [{ ...providers.comments[0], id: 6, body: '> Code comment\n\n[Unsafe](javascript:alert(1)) ![attachment](https://example.invalid/image.png)', user: null }];
  let service = await startWorkspaceService(directory, undefined, undefined, providers);
  let app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    let page = await app.firstWindow();
    await page.getByRole('button', { name: 'Create your first project' }).click(); await page.getByLabel('Title', { exact: true }).fill('Billing'); await page.getByRole('button', { name: 'Create project', exact: true }).click();
    const state = await service.control.read(), projectId = state.nodes[0].id, nodeId = randomUUID();
    await page.evaluate(async ({ nodeId, projectId, position }) => {
      const snapshot = await window.craftingTable.workspaceRead();
      await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: snapshot.state.revision, actor: { kind: 'agent', id: 'fixture-agent' }, commands: [{ type: 'item.add', id: nodeId, resourceId: crypto.randomUUID(), projectId, pluginId: 'github.pull-request', title: 'PR from agent', data: { owner: 'fixture', repo: 'billing', number: 42 }, position }] });
    }, { nodeId, projectId, position: { x: state.nodes[0].position.x + 180, y: state.nodes[0].position.y + 80 } });
    await openProjectPicker(page, 'Billing');
    await page.getByRole('button', { name: 'From URL', exact: true }).click();
    await expect(page.getByLabel('Title', { exact: true })).toHaveCount(0);
    await page.getByLabel('Item URL').fill('https://github.com/fixture/billing/pull/42'); await page.getByRole('button', { name: 'Attach PR', exact: true }).click();
    await expect(page.getByRole('form', { name: 'New item' })).toHaveCount(0);
    const imported = await service.control.read(); expect(imported.nodes).toHaveLength(2); expect(imported.resources).toHaveLength(1); expect(imported.nodes.find(node => node.resourceId)?.id).toBe(nodeId);
    await page.getByRole('article', { name: providers.pull.title, exact: true }).click();
    await expect(page.locator('[data-expanded-item-id]:visible .card-label strong')).toHaveText(providers.pull.title); await expect(page.locator('.pr-content > h2')).toHaveCount(0);
    await expect(page.locator('.view-header .view-meta')).toHaveText(/^#42 · fixture\/billing · Review required · 1 file \+24 −6 · updated /);
    await expect(page.locator('.pr-description')).toBeHidden();
    await expect(page.locator('.pr-review-actions')).toBeHidden();
    await page.locator('.pr-description-panel > summary').click();
    await expect(page.locator('.pr-description h2')).toHaveText('Changes');
    await expect(page.locator('.pr-description table')).toContainText('Next cycle');
    await expect(page.locator('.pr-description input[type=checkbox]')).toBeDisabled();
    await expect(page.locator('.pr-comments .pr-comment')).toHaveCount(3);
    await expect(page.locator('.pr-comments strong')).toHaveText('the current cycle');
    await expect(page.locator('.pr-comments pre code')).toContainText('scheduleNextCycle(plan)');
    await expect(page.locator('.pr-comments a[href^="javascript:"],.pr-comments img,.pr-description script')).toHaveCount(0);
    await expect(page.locator('.pr-description')).not.toContainText('<script>');
    expect(await page.evaluate(() => 'providerScriptExecuted' in window)).toBe(false);
    await expect(page.locator('.view-header .view-chip')).toHaveText('Open'); await expect(page.locator('.view-header .view-chip')).toHaveAttribute('data-tone', 'green');
    await expect(page.locator('.pr-review-toggle')).toHaveAttribute('data-primary', ''); await expect(page.locator('.pr-merge')).not.toHaveAttribute('data-primary');
    await page.locator('.pr-description').evaluate(element => { element.setAttribute('data-preserved', 'yes'); });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
    await expect(page.locator('.pr-description')).toHaveAttribute('data-preserved', 'yes');
    await expect(page.locator('.view-header .view-freshness')).toHaveText('Read just now');
    const openPull = page.getByRole('link', { name: 'Open in GitHub', exact: true });
    await expect(openPull).toHaveAttribute('href', 'https://github.com/fixture/billing/pull/42');
    await app.evaluate(({ shell }) => { (globalThis as any).openedPulls = []; shell.openExternal = async url => { (globalThis as any).openedPulls.push(url); }; });
    const beforeOpen = providers.requests;
    await openPull.click();
    await expect.poll(() => app.evaluate(() => (globalThis as any).openedPulls)).toEqual(['https://github.com/fixture/billing/pull/42']);
    expect(providers.requests).toBe(beforeOpen);
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', nodeId);
    for (const name of ['Overview', 'Files', 'Discussion', 'Reviews']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Pull request content' })).toHaveCount(0);
    await prActions(page).pick('Review');
    await expect(page.getByRole('button', { name: 'Post /review on GitHub', exact: true })).toBeDisabled();
    await page.locator('.pr-workflow-help summary').click();
    await expect(page.locator('.pr-workflow-action')).toContainText('Workflow reviews are unavailable for this provider.');
    await prActions(page).pick('Review');
    await page.locator('.pr-content').evaluate(element => { element.scrollTop = 0; });
    await expect(page.locator('.pr-detail')).toHaveScreenshot('pull-request-markdown.png');
    await page.locator('.pr-description-panel > summary').click();
    await expect(page.locator('.pr-detail')).toHaveScreenshot('pull-request-overview.png');
    await page.locator('.pr-content').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(page.locator('.pr-detail')).toHaveScreenshot('pull-request-comments.png');
    await expect(page.locator('.pr-comment[data-kind=inline] .pr-comment-meta a')).toHaveAttribute('href', 'https://github.com/fixture/billing/pull/42#discussion_r6');
    const calls = providers.requests;
    await exitWithoutShutdown(app); await service.close(); service = await startWorkspaceService(directory, undefined, undefined, providers);
    app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } }); page = await app.firstWindow();
    await page.getByRole('article', { name: providers.pull.title, exact: true }).click();
    await expect(page.locator('[data-expanded-item-id]:visible .card-label strong')).toHaveText(providers.pull.title);
    expect(providers.requests).toBe(calls);
    await expect(page.locator('.pr-comments .pr-comment')).toHaveCount(3);
    providers.pull = { ...providers.pull, state: 'closed', merged: true };
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('.view-header .view-chip')).toHaveText('Merged');
    await expect(page.getByRole('link', { name: 'Open in GitHub', exact: true })).toHaveAttribute('href', 'https://github.com/fixture/billing/pull/42');
    await expect(page.locator('.pr-description')).toBeHidden();
    const savedComments = providers.comments;
    providers.comments = []; providers.inline = []; providers.reviewEntries = [];
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('.pr-comments .view-empty')).toContainText('No comments yet.'); await expect(page.locator('.pr-comments .view-empty').getByRole('link', { name: 'Open in GitHub', exact: true })).toHaveAttribute('href', 'https://github.com/fixture/billing/pull/42');
    providers.comments = savedComments; providers.comments[0].body = 'Updated **comment**';
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('.pr-comments strong')).toHaveText('comment');
    providers.fail(401); await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('.pr-detail > .pr-error')).toContainText('Couldn’t refresh from GitHub.'); await expect(page.locator('.view-header .view-freshness')).toHaveText(/^Saved copy · /);
    await expect(page.locator('[data-expanded-item-id]:visible .card-label strong')).toHaveText(providers.pull.title);
    await expect(page.locator('.pr-comments strong')).toHaveText('comment');
    expect((await service.control.read()).nodes).toHaveLength(2);
    await page.getByRole('button', { name: 'Back to project' }).click(); await expect(page.locator('.pr-detail')).toBeHidden();
  } finally { await app.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('background PR updates paint map indicators and approval enters Needs me until marked seen, including after restart', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = await mkdtemp(join(tmpdir(), 'craft-pr-poll-')), providers = githubFixture();
  let service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: randomUUID(), expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'item.add', id: 'pr', resourceId: 'pull', pluginId: 'github.pull-request', title: 'Saved pull request', data: { owner: 'fixture', repo: 'billing', number: 42 }, position: { x: 400, y: 220 } },
    { type: 'view.set', view: { mode: 'workspace', archive: false, todosOpen: false, camera: { x: 0, y: 0, zoom: 1 } } },
  ] });
  // Invoke the exact background tick after expiring only this isolated fixture's
  // cache, so no real minute or provider account is needed by the regression.
  const tick = async () => {
    const db = new DatabaseSync(service.store.file); db.exec('UPDATE resource_cache SET checked_at=0'); db.close();
    await service.resources.poll();
  };
  await tick();
  let app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    let page = await app.firstWindow();
    const card = () => page.locator('[data-item-id="pr"]');
    await expect(card().locator('[data-indicator="review-state"]')).toHaveAttribute('aria-label', 'Open');
    await expect(card().locator('[data-indicator="comments"]')).toHaveAttribute('aria-label', '2 unseen comments');
    await expect(page.locator('.map-area')).toHaveAttribute('data-focus', '');
    providers.reviewEntries[0].state = 'APPROVED'; providers.inline = [{ ...providers.comments[0], id: 100 }];
    await tick();
    await expect(card().locator('[data-indicator="review-state"]')).toHaveAttribute('aria-label', 'Approved');
    await expect(card().locator('[data-indicator="comments"]')).toHaveAttribute('aria-label', '3 unseen comments');
    await expect(page.getByRole('button', { name: 'Needs me: 1', exact: true })).toBeVisible();
    await expect(card()).toHaveScreenshot('pull-request-approved-card.png');
    await page.getByRole('button', { name: 'Needs me: 1', exact: true }).click();
    const list = () => page.getByRole('dialog', { name: 'Needs me', exact: true });
    await expect(list()).toContainText('PR approved · 2 new comments'); await expect(list().locator('.attention-summary')).toHaveCount(0);
    await list().getByRole('button', { name: `Open ${providers.pull.title}`, exact: true }).click();
    await expect(page.locator('.view-header .view-chip')).toHaveText('Open'); await expect(page.locator('.view-header .view-meta')).toContainText('✓ Approved');
    await expect(page.locator('.pr-merge')).toHaveAttribute('data-primary', '');
    await expect(page.getByRole('button', { name: 'Needs me: 1', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Needs me: 1', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Needs me: 1', exact: true }).click();
    await list().getByRole('button', { name: `Dismiss ${providers.pull.title} from Needs me`, exact: true }).click();
    await page.getByRole('button', { name: 'Close needs me', exact: true }).click();
    await tick(); await expect(page.getByRole('button', { name: 'Needs me: 1', exact: true })).toHaveCount(0);
    await exitWithoutShutdown(app); await service.close(); service = await startWorkspaceService(directory, undefined, undefined, providers);
    app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } }); page = await app.firstWindow();
    await tick(); await expect(card().locator('[data-indicator="review-state"]')).toHaveAttribute('aria-label', 'Approved');
    await expect(page.getByRole('button', { name: 'Needs me: 1', exact: true })).toHaveCount(0);
    providers.reviewEntries[0].state = 'CHANGES_REQUESTED'; await tick();
    await expect(card().locator('[data-indicator="review-state"]')).toHaveAttribute('aria-label', 'Changes requested');
    providers.reviewEntries[0].state = 'APPROVED'; await tick();
    await page.getByRole('button', { name: 'Needs me: 1', exact: true }).click();
    await list().getByRole('button', { name: `Dismiss ${providers.pull.title} from Needs me`, exact: true }).click();
    await expect(list()).toContainText('Nothing needs me.');
    await tick(); await expect(list()).toContainText('Nothing needs me.');
    providers.pull = { ...providers.pull, merged: true, state: 'closed' }; await tick();
    await expect(card().locator('[data-indicator="review-state"]')).toHaveAttribute('aria-label', 'Merged');
  } finally { await app.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});


test('Review desk shows connected summaries and revision context, adapts to narrow windows, and follows live links', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-pr-desk-')), providers = githubFixture();
  providers.reviewEntries[0] = { ...providers.reviewEntries[0], state: 'APPROVED', body: '' };
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  enableShowShip(service.store);
  const client = await connectWorkspace(directory);
  const apply = async (commands: unknown[]) => client.call('apply', { commandId: randomUUID(), expectedRevision: (await service.control.read()).revision, actor: { kind: 'user', id: 'fixture' }, commands });
  await apply([
    { type: 'project.create', id: 'project', title: 'Billing', position: { x: 100, y: 100 } },
    { type: 'item.add', id: 'pr', resourceId: 'pull', pluginId: 'github.pull-request', title: providers.pull.title, projectId: 'project', data: { owner: 'fixture', repo: 'billing', number: 42 }, position: { x: 400, y: 220 } },
    { type: 'item.create', id: 'review', projectId: 'project', resource: { id: 'review-resource', pluginId: 'code.review', schemaVersion: 1, title: 'Claude review · #42', data: { provider: 'claude', model: 'opus', sourcePrId: 'pr', sessionId: 'fixture-only', headSha: providers.pull.head.sha, baseSha: 'c'.repeat(40), baseTipSha: providers.pull.base.sha } }, position: { x: 700, y: 220 } },
    { type: 'node.update', id: 'review', summary: 'Checked billing paths. One retry edge case needs attention.', activity: 'complete' },
    { type: 'item.add', id: 'note', resourceId: 'note-resource', pluginId: 'workspace.note', title: 'Billing context', projectId: 'project', data: { text: 'Keep changes in the next billing cycle.' }, position: { x: 400, y: 400 } },
    { type: 'link.save', link: { id: 'review-link', sourceId: 'pr', targetId: 'review', kind: 'reference' } },
    { type: 'link.save', link: { id: 'note-link', sourceId: 'note', targetId: 'pr', kind: 'reference' } },
    { type: 'view.set', view: { mode: 'workspace', archive: false, todosOpen: false, camera: { x: 0, y: 0, zoom: 1 } } },
  ]);
  const app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow(); await resize(app, page, 1400, 1000);
    await page.getByRole('article', { name: providers.pull.title, exact: true }).click();
    await expect(page.locator('[data-expanded-item-id=pr] .card-label strong')).toHaveText(providers.pull.title);
    await expect(page.locator('[data-expanded-item-id=pr] .view-meta')).toContainText('#42 · fixture/billing');
    const review = page.getByRole('button', { name: 'Open review: Claude review · #42', exact: true, includeHidden: true });
    await expect(review).toContainText('Checked billing paths');
    await expect(review).toContainText('Current revision');
    await expect(page.locator('.pr-comment[data-kind=review]')).toHaveCount(0);
    await page.evaluate(async () => { const settings = await window.craftingTable.settingsRead(); await window.craftingTable.settingsWrite({ expectedRevision: settings.revision, value: { ...settings.value, pullRequestConversation: { ...settings.value.pullRequestConversation, activity: true } } }); });
    await expect(page.locator('.pr-comment[data-kind=review] .pr-comment-state')).toHaveText('Approved');
    const discussion = page.locator('.pr-discussion'), related = page.locator('.pr-related');
    await expect(review).toBeHidden();
    await related.locator('summary').click();
    await expect(review).toBeVisible();
    expect((await related.boundingBox())!.y).toBeLessThan((await discussion.boundingBox())!.y);
    await expect(page.locator('.pr-desk')).toHaveScreenshot('pull-request-review-desk.png');
    await expect(page.locator('[data-expanded-item-id=pr]')).toHaveScreenshot('pull-request-review-desk-frame.png');
    // One Actions menu holds what used to be a row of header buttons; the state-chosen action is marked.
    const actions = prActions(page); await actions.open();
    await expect(actions.menu.getByRole('menuitem')).toHaveText(['Review', 'Review loop', 'Show/Ship', 'Merge', 'Auto deploy', 'Convert to draft', 'Close…']);
    await expect(actions.menu.getByRole('separator')).toHaveCount(1);
    await expect(actions.item('Merge')).toHaveAttribute('data-primary', '');
    await expect(actions.menu).toHaveScreenshot('pull-request-actions-menu.png');
    await page.keyboard.press('Escape'); await expect(actions.menu).toHaveCount(0); await expect(actions.button).toBeFocused();
    await resize(app, page, 800, 700);
    await expect.poll(async () => (await related.boundingBox())!.y < (await discussion.boundingBox())!.y).toBe(true);
    expect(await page.locator('.pr-content').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(page.locator('.pr-desk')).toHaveScreenshot('pull-request-review-desk-narrow.png');
    await page.locator('.pr-description-panel > summary').click();
    await apply([{ type: 'node.update', id: 'review', summary: 'Updated result: retry fix verified.' }]);
    await expect(review).toContainText('Updated result: retry fix verified.');
    await expect(page.locator('.pr-description-panel')).toHaveAttribute('open', '');
    providers.pull.head.sha = 'd'.repeat(40);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(review).toContainText('Earlier revision');
    await expect(page.locator('.pr-comment[data-kind=review]')).toContainText('Earlier revision');
    await apply([{ type: 'link.remove', id: 'review-link' }, { type: 'link.remove', id: 'note-link' }]);
    await expect(related).toBeHidden();
    await apply([{ type: 'link.save', link: { id: 'note-link', sourceId: 'note', targetId: 'pr', kind: 'reference' } }]);
    await expect(related).toBeHidden(); await expect(page.locator('.pr-connected-context')).toHaveCount(0);
  } finally { await app.close(); client.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('PR comments render sanitized HTML, persist seen state, copy links, and reply without losing drafts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-pr-comments-')), providers = githubFixture();
  providers.comments[0].body = '<!-- linear-linkback --> <details><summary><a href="https://linear.app/fixture/issue/BIL-128">BIL-128 · Billing changes</a></summary><p>Keep the next cycle.</p><script>window.providerScriptExecuted=true</script><img src="https://invalid.example/track" onerror="alert(1)"><a href="javascript:alert(1)">bad</a><input type="text" autofocus></details>';
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: randomUUID(), expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'item.add', id: 'pr', resourceId: 'pull', pluginId: 'github.pull-request', title: providers.pull.title, data: { owner: 'fixture', repo: 'billing', number: 42 }, position: { x: 400, y: 220 } }] });
  const app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow(); await page.getByRole('article', { name: providers.pull.title, exact: true }).click();
    const comment = page.locator('.pr-comment[data-kind=discussion][data-comment-id="5"]');
    await expect(comment.locator('summary')).toHaveText('BIL-128 · Billing changes');
    await expect(comment.locator('script,img,a[href^="javascript:"]')).toHaveCount(0);
    await expect(comment).not.toContainText('<!-- linear-linkback -->');
    await comment.locator('.pr-comment-preview').click();
    await comment.locator('summary').click(); await expect(comment.locator('details p')).toBeVisible();
    expect(await page.evaluate(() => 'providerScriptExecuted' in window)).toBe(false);
    await comment.getByRole('button', { name: 'Copy link', exact: true }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('https://github.com/fixture/billing/pull/42#issuecomment-5');
    const fresh = comment.locator('.pr-comment-new');
    await expect(fresh).toHaveText('New'); await expect(fresh).toBeVisible();
    const bar = () => comment.evaluate(element => getComputedStyle(element).boxShadow);
    const newBar = await bar();
    await comment.getByRole('button', { name: 'Mark seen', exact: true }).click();
    await expect(comment).toHaveAttribute('data-seen', 'true'); await expect(comment.locator('.markdown-content')).toBeHidden();
    await expect(fresh).toBeHidden(); expect(await bar()).not.toBe(newBar);
    await expect(page.locator('.pr-comment').last()).toHaveAttribute('data-comment-id', '5');
    await page.reload(); await page.getByRole('article', { name: providers.pull.title, exact: true }).click();
    await expect(comment).toHaveAttribute('data-seen', 'true');
    await page.locator('.pr-seen > summary').click();
    await comment.getByRole('button', { name: 'Expand comment', exact: true }).click(); await expect(comment.locator('.markdown-content')).toBeVisible();
    providers.comments[0].body = 'Changed **issue**'; await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(comment).toHaveAttribute('data-seen', 'false'); await expect(fresh).toBeVisible();
    await comment.getByRole('button', { name: 'Reply', exact: true }).click(); await comment.getByRole('textbox').fill('Thanks, fixing this.');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(comment.getByRole('textbox')).toHaveValue('Thanks, fixing this.');
    await comment.getByRole('button', { name: 'Post reply', exact: true }).click();
    await expect.poll(() => providers.posts.length).toBe(1);
    expect(providers.posts[0]).toEqual({ path: '/repos/fixture/billing/issues/42/comments', body: 'In reply to https://github.com/fixture/billing/pull/42#issuecomment-5\n\nThanks, fixing this.' });
    await expect(page.locator('.pr-comments')).toContainText('Thanks, fixing this.');
    await expect(page.locator('.pr-connected-context')).toHaveCount(0);
  } finally { await app.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('PR conversation defaults to human comments and settings persist bot/activity visibility', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-pr-filters-')), providers = githubFixture();
  providers.comments.push({ ...providers.comments[0], id: 8, body: 'Automated checks passed.', user: { login: 'ci-service', type: 'Bot' } });
  providers.inline = [{ ...providers.comments[0], id: 9, body: 'Please handle this edge case.' }, { ...providers.comments[0], id: 10, in_reply_to_id: 9, body: 'I will fix that.' }];
  providers.reviewEntries.push({ ...providers.reviewEntries[0], id: 11, state: 'APPROVED', body: '' });
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: randomUUID(), expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'item.add', id: 'pr', resourceId: 'pull', pluginId: 'github.pull-request', title: providers.pull.title, data: { owner: 'fixture', repo: 'billing', number: 42 }, position: { x: 400, y: 220 } }] });
  const app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow();
    await page.getByRole('article', { name: providers.pull.title, exact: true }).click();
    await expect(page.locator('.pr-comment')).toHaveCount(4);
    await expect(page.locator('.pr-comments')).not.toContainText('Automated checks passed.');
    await expect(page.locator('.pr-comment[data-comment-id="11"]')).toHaveCount(0);
    await expect(page.locator('.pr-comments')).toContainText('I will fix that.');
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('treeitem', { name: 'Items', exact: true }).click();
    await page.keyboard.press('ArrowRight');
    await dialog.getByRole('treeitem', { name: 'GitHub pull request', exact: true }).click();
    await expect(dialog.getByLabel('Include bots and GitHub Actions')).not.toBeChecked();
    await dialog.getByLabel('Include bots and GitHub Actions').check();
    await dialog.getByLabel('Approvals and other review activity without comments').check();
    await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.getByRole('article', { name: providers.pull.title, exact: true }).click();
    await expect(page.locator('.pr-comment')).toHaveCount(6);
    await expect(page.locator('.pr-comments')).toContainText('Automated checks passed.');
    await page.reload(); await page.getByRole('article', { name: providers.pull.title, exact: true }).click();
    await expect(page.locator('.pr-comment')).toHaveCount(6);
    expect(providers.posts).toHaveLength(0);
  } finally { await app.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('conversation cards preview, group replies, retain expansion and resurface seen threads without writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-pr-threads-')), providers = githubFixture();
  providers.comments = []; providers.reviewEntries = [];
  const base = { user: { login: 'reviewer' }, created_at: '2026-09-25', updated_at: '2026-09-25' };
  providers.inline = [
    { ...base, id: 1, body: '**Important fix**\n\n' + '🪵'.repeat(190), path: 'src/billing.ts', line: 84 },
    { ...base, id: 2, body: 'I will add a test.', in_reply_to_id: 1, created_at: '2026-09-26' },
    { ...base, id: 3, body: 'Hidden automation root', user: { login: 'ci[bot]', type: 'Bot' } },
    { ...base, id: 4, body: 'Human response to automation', in_reply_to_id: 3 },
  ];
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: randomUUID(), expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'item.add', id: 'pr', resourceId: 'pull', pluginId: 'github.pull-request', title: providers.pull.title, data: { owner: 'fixture', repo: 'billing', number: 42 }, position: { x: 400, y: 220 } }] });
  const app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow(); await page.getByRole('article', { name: providers.pull.title, exact: true }).click();
    const thread = page.locator('[data-thread="inline:1"]'), root = thread.locator('[data-comment-id="1"]');
    await expect(thread.locator('.pr-comment')).toHaveCount(2);
    await expect(thread.locator('.pr-comment').last()).toHaveAttribute('data-reply', 'true');
    await expect(thread.locator('.pr-thread-path')).toHaveText('src/billing.ts:84');
    const preview = root.locator('.pr-comment-preview');
    await expect(preview).toHaveText('Important fix ' + '🪵'.repeat(166) + '…');
    await expect(root.locator('.markdown-content')).toBeHidden();
    await preview.focus(); await page.keyboard.press('Enter');
    await expect(root.locator('.markdown-content strong')).toBeVisible();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
    await expect(root.locator('.markdown-content')).toBeVisible();
    await root.getByRole('button', { name: 'Collapse comment', exact: true }).click();
    await expect(preview).toBeVisible();
    const hidden = page.locator('[data-thread="inline:3"]');
    await expect(hidden.locator('.pr-thread-context')).toHaveAttribute('href', 'https://github.com/fixture/billing/pull/42#discussion_r3');
    await expect(hidden.locator('.pr-comment')).toHaveCount(1);
    await expect(page.locator('.pr-detail')).toHaveScreenshot('pull-request-thread-cards.png');
    await root.getByRole('button', { name: 'Mark seen', exact: true }).click();
    await expect(thread).toBeVisible();
    await thread.locator('[data-comment-id="2"]').getByRole('button', { name: 'Mark seen', exact: true }).click();
    await expect(thread).toBeHidden(); await expect(page.locator('.pr-seen > summary')).toHaveText('Seen · 1');
    await page.locator('.pr-seen > summary').click(); await expect(thread).toBeVisible();
    providers.inline.push({ ...base, id: 5, body: 'New edge case', in_reply_to_id: 1, created_at: '2026-09-28' });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('.pr-comments [data-thread="inline:1"] .pr-comment')).toHaveCount(3);
    await expect(page.locator('.pr-seen')).toBeHidden();
    await page.locator('.pr-filters > summary').click();
    await page.getByLabel('Include bots and GitHub Actions', { exact: true }).check();
    await expect(hidden.locator('.pr-comment')).toHaveCount(2);
    await expect(hidden.locator('.pr-thread-context')).toHaveCount(0);
    expect(providers.posts).toHaveLength(0);
  } finally { await app.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('map comment pill disappears at zero unseen, survives restart and returns for edited comments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-pr-unseen-')), providers = githubFixture();
  providers.reviewEntries = [];
  providers.comments.push({ ...providers.comments[0], id: 8, body: 'Bot update', user: { login: 'ci[bot]', type: 'Bot' } });
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: randomUUID(), expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'item.add', id: 'pr', resourceId: 'pull', pluginId: 'github.pull-request', title: providers.pull.title, data: { owner: 'fixture', repo: 'billing', number: 42 }, position: { x: 400, y: 220 } }] });
  await service.resources.read('pr', true);
  let app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    let page = await app.firstWindow(), card = page.locator('[data-item-id="pr"]'), pill = card.locator('[data-indicator="comments"]');
    await expect(pill).toHaveAttribute('aria-label', '1 unseen comment');
    await card.click(); await page.getByRole('button', { name: 'Mark seen', exact: true }).click();
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(pill).toHaveCount(0);
    await expect(card.locator('[data-indicator="review-state"]')).toHaveAttribute('aria-label', 'Open');
    await expect(card).toHaveScreenshot('pull-request-all-comments-seen.png');
    await exitWithoutShutdown(app);
    app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
    page = await app.firstWindow(); card = page.locator('[data-item-id="pr"]'); pill = card.locator('[data-indicator="comments"]');
    await expect(pill).toHaveCount(0);
    await card.click(); await page.locator('.pr-seen > summary').click();
    await page.getByRole('button', { name: 'Mark unseen', exact: true }).click();
    await page.getByRole('button', { name: 'Back to project', exact: true }).click(); await expect(pill).toHaveAttribute('aria-label', '1 unseen comment');
    await card.click(); await page.getByRole('button', { name: 'Mark seen', exact: true }).click();
    providers.comments[0].body = 'Updated comment';
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('.pr-comments')).toContainText('Updated comment');
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(pill).toHaveAttribute('aria-label', '1 unseen comment');
    // Only automation remains: defaults hide the pill even though GitHub has a comment.
    providers.comments = providers.comments.filter(comment => comment.id === 8);
    await service.resources.read('pr', true); await expect(pill).toHaveCount(0);
    const beforeSettings = providers.requests;
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('treeitem', { name: 'Items', exact: true }).click();
    await dialog.getByRole('treeitem', { name: 'GitHub pull request', exact: true }).click();
    await dialog.getByLabel('Include bots and GitHub Actions').check();
    await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(pill).toHaveAttribute('aria-label', '1 unseen comment');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await dialog.getByRole('treeitem', { name: 'Items', exact: true }).click();
    await dialog.getByRole('treeitem', { name: 'GitHub pull request', exact: true }).click();
    await dialog.getByLabel('Human discussion comments').uncheck();
    await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(pill).toHaveCount(0);
    expect(providers.requests).toBe(beforeSettings); expect(providers.posts).toHaveLength(0);
  } finally { await app.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('expired PR content and Seen receipts display after restart while GitHub is still loading', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = await mkdtemp(join(tmpdir(), 'craft-pr-saved-')), providers = githubFixture();
  let service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: randomUUID(), expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [
    { type: 'item.add', id: 'pr', resourceId: 'pull', pluginId: 'github.pull-request', title: providers.pull.title, data: { owner: 'fixture', repo: 'billing', number: 42 }, position: { x: 400, y: 220 } },
  ] });
  let app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    let page = await app.firstWindow();
    await page.getByRole('article', { name: providers.pull.title, exact: true }).click();
    const comment = () => page.locator('.pr-comment[data-kind=discussion][data-comment-id="5"]');
    await comment().getByRole('button', { name: 'Mark seen', exact: true }).click();
    await expect(comment()).toHaveAttribute('data-seen', 'true');
    await exitWithoutShutdown(app); await service.close();
    const db = new DatabaseSync(join(directory, 'workspace.sqlite'));
    db.exec("UPDATE resource_cache SET checked_at=0 WHERE cache_key='snapshot'"); db.close();
    let start!: () => void;
    const entered = new Promise<void>(resolve => { start = resolve; });
    providers.delay(async () => { start(); await gate; });
    service = await startWorkspaceService(directory, undefined, undefined, providers);
    app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
    page = await app.firstWindow();
    await page.getByRole('article', { name: providers.pull.title, exact: true }).click();
    await entered;
    // These assertions run with the provider gate still closed: no network reply
    // can make them pass. Saved content must include local Seen state as well.
    await expect(page.locator('[data-expanded-item-id]:visible .card-label strong')).toHaveText(providers.pull.title);
    await expect(page.locator('.view-header')).toHaveAttribute('data-busy', ''); await expect(page.locator('.view-header .view-chip')).toHaveText('Open');
    await page.locator('.pr-description-panel > summary').click();
    await expect(page.locator('.pr-description')).toContainText('Preserve the current plan');
    await expect(page.locator('.pr-comments')).toContainText('The new schedule looks good.');
    await expect(comment()).toHaveAttribute('data-seen', 'true');
    await expect(page.locator('.pr-seen > summary')).toContainText('Seen');
    providers.pull = { ...providers.pull, title: 'Refreshed title after restart' };
    release();
    await expect(page.locator('[data-expanded-item-id]:visible .card-label strong')).toHaveText('Refreshed title after restart');
    await expect(page.locator('.view-header')).not.toHaveAttribute('data-busy'); await expect(page.locator('.view-header .view-freshness')).toHaveText('Read just now');
    // Disconnected credentials must not prevent another fresh view from reading
    // its saved snapshot or replace the known PR state with Unavailable.
    providers.accounts[0].enabled = false;
    await page.reload(); await page.getByRole('article', { name: providers.pull.title, exact: true }).click();
    await expect(page.locator('[data-expanded-item-id]:visible .card-label strong')).toHaveText(providers.pull.title);
    await expect(page.locator('.view-header .view-freshness')).toHaveText(/^Saved copy · /);
    await expect(page.locator('.view-header .view-chip')).toHaveText('Open');
    await expect(page.locator('.pr-comments')).toContainText('The new schedule looks good.');
    expect(providers.posts).toHaveLength(0);
  } finally { release(); await app.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Mark all seen above the comments marks every loaded comment seen at once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'craft-pr-seen-all-')), providers = githubFixture();
  providers.reviewEntries = [];
  providers.comments.push({ ...providers.comments[0], id: 6, body: 'Second remark' }, { ...providers.comments[0], id: 7, body: 'Third remark' });
  const service = await startWorkspaceService(directory, undefined, undefined, providers);
  await service.control.dispatch({ commandId: randomUUID(), expectedRevision: 0, actor: { kind: 'user', id: 'fixture' }, commands: [{ type: 'item.add', id: 'pr', resourceId: 'pull', pluginId: 'github.pull-request', title: providers.pull.title, data: { owner: 'fixture', repo: 'billing', number: 42 }, position: { x: 0, y: 0 } }] });
  await service.resources.read('pr', true);
  const app = await electron.launch({ args: ['.', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory } });
  try {
    const page = await app.firstWindow(), card = page.locator('[data-item-id="pr"]'), pill = card.locator('[data-indicator="comments"]');
    await expect(pill).toHaveAttribute('aria-label', '3 unseen comments');
    await card.click();
    const header = page.locator('.pr-conversation-header'), all = header.getByRole('button', { name: 'Mark all seen', exact: true });
    await expect(header.locator('h3')).toHaveText('Conversation · 3 unseen');
    await page.locator('.pr-comment[data-comment-id="6"]').getByRole('button', { name: 'Mark seen', exact: true }).click();
    await expect(header.locator('h3')).toHaveText('Conversation · 2 unseen');
    await all.click();
    await expect(header.locator('h3')).toHaveText('Conversation · 0 unseen');
    await expect(all).toBeHidden();
    await expect(page.locator('.pr-comments .pr-comment')).toHaveCount(0);
    await expect(page.locator('.pr-seen .pr-comment')).toHaveCount(3);
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(pill).toHaveCount(0);
    providers.comments.push({ ...providers.comments[0], id: 9, body: 'A later remark' });
    await service.resources.read('pr', true);
    await expect(pill).toHaveAttribute('aria-label', '1 unseen comment');
    await card.click(); await expect(all).toBeVisible();
    expect(providers.posts).toHaveLength(0);
  } finally { await app.close(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
