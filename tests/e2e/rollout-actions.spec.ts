import { test, expect } from '@playwright/test';
import { rolloutFixture } from '../fixtures/rollout.ts';
import { rolloutHarness } from './rollout-harness.ts';
import { prActions } from './pr-actions.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';
import { githubFixture } from '../fixtures/github.ts';
import { githubRolloutConnector } from '../../src/resource-plugins/items/github-rollout/connector.ts';
import { rolloutPresentation } from '../../src/resource-plugins/items/github-rollout/service.ts';
import type { ResourcePluginRegistry } from '../../src/resource-plugins/registry.ts';
import { discoveredLinkId } from '../../packages/workspace-service/resources.ts';
import { rolloutDiscoveryKey } from '../../packages/provider-runtime/github-status.ts';

test('a report an agent files shows in the open rollout view at once, without the periodic read', async () => {
  test.setTimeout(90_000);
  const providers = rolloutFixture();
  const h = await rolloutHarness(providers, ['claude'], agent => [
    { type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'Rollout', projectId: 'project', position: { x: 260, y: 200 }, data: { owner: 'fixture', repo: 'web', runId: 101 } },
    agent('claude', 'Claude · validator', 60),
    { type: 'link.save', link: { id: 'rollout-claude', sourceId: 'rollout', targetId: 'claude', kind: 'context', label: '' } },
  ]);
  try {
    const { page } = h, detail = page.locator('.rollout-detail'), card = detail.locator('.rv-card[aria-label^="V1 · "]');
    // The view's timers run on the page clock, so pausing it leaves only what the service pushes.
    await page.clock.install();
    await page.locator('[data-item-id="rollout"]').click();
    await detail.getByRole('button', { name: 'Show the jobs rail', exact: true }).click();
    await expect(detail.getByRole('list', { name: 'Rollout jobs' }).getByRole('listitem')).toHaveCount(3);
    await page.evaluate(() => window.craftingTable.runtimeRun({ action: 'rollout.validation' as 'agent.resume', nodeId: 'rollout', arguments: { operation: 'trigger', sourceResourceId: 'rollout-r', value: 'claude', requestId: crypto.randomUUID() } }));
    await expect.poll(() => h.output('claude'), { timeout: 15_000 }).toContain('validationId "V1"');
    await page.clock.pauseAt(new Date(Date.now() + 60_000));
    await expect(card).toContainText('Waiting for Claude');
    await h.report('claude', 'rollout', { validationId: 'V1', sequence: 1, phase: 'progress', summary: 'Checking the preview rollout', checks: [{ id: 'C1', title: 'Preview instances ready', status: 'running' }] });
    await expect(card).toContainText('Checking the preview rollout');
    await expect(card).toHaveAttribute('data-v', 'running');
    await h.report('claude', 'rollout', { validationId: 'V1', sequence: 2, phase: 'final', verdict: 'passed', summary: 'Preview healthy', checks: [{ id: 'C1', title: 'Preview instances ready', status: 'passed' }] });
    await expect(card).toHaveAttribute('data-v', 'passed');
    await expect(detail.locator('.rv-verdict')).toContainText('Current verdict: passed');
  } finally { await h.close(); }
});

test('the rollout view has one Actions menu: Approve and validate, Approve, Validate and Validate with…, with reasons for what cannot apply', async () => {
  test.setTimeout(150_000);
  const providers = rolloutFixture();
  providers.run = { ...providers.run, status: 'waiting' }; providers.jobs = providers.jobs.map((job, index) => index ? { ...job, status: 'waiting' } : job);
  providers.gates = [{ environment: { id: 7, name: 'production' }, wait_timer: 0, current_user_can_approve: true, reviewers: [{ type: 'Team' }] }];
  const h = await rolloutHarness(providers, ['claude'], agent => [
    { type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'Rollout', projectId: 'project', position: { x: 260, y: 200 }, data: { owner: 'fixture', repo: 'web', runId: 101 } },
    agent('claude', 'Claude · validator', 60),
    { type: 'link.save', link: { id: 'rollout-claude', sourceId: 'rollout', targetId: 'claude', kind: 'context', label: '' } },
  ]);
  try {
    const { page } = h, frame = page.locator('[data-expanded-item-id]:visible'), detail = page.locator('.rollout-detail'), actions = prActions(page, frame);
    const reason = (name: string) => actions.item(name).locator('small');
    const validations = async () => (await page.evaluate(() => window.craftingTable.runtimeRun({ action: 'rollout.validation' as 'agent.resume', nodeId: 'rollout', arguments: { operation: 'list' } })) as any).validations as any[];
    const agents = async () => { const state = await h.service.control.read(); return state.nodes.filter(node => node.id !== 'claude' && state.resources.find(resource => resource.id === node.resourceId)?.pluginId === 'agent.session'); };
    // The menu lists what held when it opened, so it is reopened until the pushed state shows.
    const reopened = (check: () => Promise<void>) => expect(async () => { if (await actions.button.getAttribute('aria-expanded') === 'true') await page.keyboard.press('Escape'); await actions.open(); await check(); }).toPass();
    const dispatch = async (commands: WorkspaceCommand[]) => { const state = await h.service.control.read(); await h.service.control.dispatch({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'fixture' }, commands }); };
    await page.locator('[data-item-id="rollout"]').click();
    await expect(detail.locator('.rv-gate .rv-name')).toHaveText('production · approval gate');
    await expect(frame.getByRole('button', { name: 'Validate', exact: true })).toHaveCount(0);

    // A gate waits: Approve and validate leads, and the button takes the accent, whatever the connected agent does.
    await expect(actions.button).toHaveAttribute('data-primary', '');
    await actions.open();
    await expect(actions.menu.getByRole('menuitem')).toHaveText(['Approve and validate', 'Approve', 'Validate', 'Validate with…']);
    await expect(actions.item('Approve and validate')).toHaveAttribute('data-primary', '');
    for (const name of ['Approve and validate', 'Approve', 'Validate', 'Validate with…']) await expect(actions.item(name)).toBeEnabled();
    await page.keyboard.press('Escape'); await expect(actions.button).toBeFocused();
    await dispatch([{ type: 'node.update', id: 'claude', activity: 'working' }]);
    await reopened(() => expect(actions.item('Approve and validate')).toHaveAttribute('data-primary', '', { timeout: 500 }));
    // Validate with… keeps the connected agents, with why one cannot take the request.
    await actions.item('Validate with…').click();
    const offered = page.getByRole('menu', { name: 'Trigger validation', exact: true });
    await expect(offered.getByRole('menuitem')).toHaveText([/^Claude · validator/, /^Start a new agent/, 'Cancel']);
    await expect(offered.getByRole('menuitem', { name: 'Claude · validator', exact: true })).toBeDisabled(); await expect(offered.getByRole('menuitem', { name: /^Start a new agent/ })).toBeEnabled();
    await page.keyboard.press('Escape');
    await h.idle('claude');

    // Approve and validate confirms the approval, then starts a hidden validation agent. A failed approval sends nothing.
    const approval = page.getByRole('menu', { name: 'Approve deployment', exact: true });
    const approveAndValidate = async () => {
      await actions.pick('Approve and validate');
      await expect(approval.getByRole('menuitem', { name: 'Cancel', exact: true })).toBeFocused();
      await expect(approval.locator('.resource-choice-prompt')).toHaveText('Approve production for run #28?');
      await approval.getByRole('menuitem', { name: 'Confirm', exact: true }).click();
      await expect(approval.getByRole('menuitem', { name: 'Back', exact: true })).toBeFocused();
      expect(providers.approvals).toHaveLength(0); expect(await validations()).toHaveLength(0);
      await approval.getByRole('menuitem', { name: 'Confirm approval', exact: true }).click();
    };
    providers.replyToApproval(() => ({ status: 422, body: { message: 'Not allowed' } }));
    await approveAndValidate();
    await expect(detail.locator('.rollout-error')).toBeVisible(); await expect(detail.locator('.rollout-error')).not.toHaveText(/Approving|Sending/);
    expect(providers.approvals).toHaveLength(1); expect(await validations()).toHaveLength(0); expect(await agents()).toHaveLength(0);
    providers.replyToApproval(undefined); providers.approvals.length = 0;
    await approveAndValidate();
    await expect.poll(async () => (await validations()).map(view => [view.label, view.agentHidden]), { timeout: 30_000 }).toEqual([['V1', true]]);
    const [started] = await agents();
    expect(started.hiddenAt).toBeTruthy(); expect((await validations())[0].agentNodeId).toBe(started.id);
    expect(providers.approvals).toEqual([{ path: '/repos/fixture/web/actions/runs/101/pending_deployments', environmentIds: [7] }]);
    expect(await h.output('claude')).not.toContain('validationId');
    await expect(detail.locator('.rv-card[aria-label^="V1 · "]')).toBeVisible();
    await expect(frame.locator('.rollout-state')).toHaveText('Ongoing');

    // No gate waits any more: Approve says so and Validate leads. Validate with… asks the connected agent.
    await reopened(() => expect(actions.item('Validate')).toHaveAttribute('data-primary', '', { timeout: 500 }));
    await expect(actions.item('Approve and validate')).toBeDisabled(); await expect(actions.item('Approve')).toBeDisabled();
    await expect(reason('Approve')).toHaveText('No deployment is waiting for your approval.');
    await actions.item('Validate with…').click();
    await page.getByRole('menu', { name: 'Trigger validation', exact: true }).getByRole('menuitem', { name: 'Claude · validator', exact: true }).click();
    await expect.poll(() => h.output('claude'), { timeout: 15_000 }).toContain('validationId "V2"');
    expect(providers.approvals).toHaveLength(1);
  } finally { await h.close(); }
});

test('with no agent connected, Validate starts a hidden agent connected to the rollout and its pull request, that takes the request and reports V1; Show validation agent puts it on the map', async () => {
  test.setTimeout(180_000);
  const github = githubFixture(), rollouts = rolloutFixture();
  rollouts.run = { ...rollouts.run, repository: { full_name: 'fixture/billing' } };
  const providers = { ...github, host(registry: ResourcePluginRegistry) { const host = github.host(registry); host.register('github.rollout', githubRolloutConnector(() => rollouts.client)); host.present('github.rollout', rolloutPresentation); return host; } };
  const h = await rolloutHarness(providers, [], (): WorkspaceCommand[] => [
    { type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'Rollout', projectId: 'project', position: { x: 260, y: 200 }, data: { owner: 'fixture', repo: 'billing', runId: 101 } },
    { type: 'item.add', id: 'pr', resourceId: 'pr-r', pluginId: 'github.pull-request', connectionId: 'github-fixture', title: 'PR', projectId: 'project', position: { x: 260, y: 420 }, data: { owner: 'fixture', repo: 'billing', number: 42 } },
    { type: 'link.save', link: { id: discoveredLinkId('pr-r', rolloutDiscoveryKey(101)), sourceId: 'pr', targetId: 'rollout', kind: 'reference', label: '' } },
  ], { summary: 'BILLING_BRIEF' });
  try {
    const { page, service } = h, frame = page.locator('[data-expanded-item-id]:visible'), detail = page.locator('.rollout-detail'), actions = prActions(page, frame), card = detail.locator('.rv-card[aria-label^="V1 · "]');
    const agents = async () => { const state = await service.control.read(); return state.nodes.filter(node => state.resources.find(resource => resource.id === node.resourceId)?.pluginId === 'agent.session'); };
    const run = (input: object) => page.evaluate(input => window.craftingTable.runtimeRun({ action: 'rollout.validation' as 'agent.resume', nodeId: 'rollout', arguments: input as never }), input);
    await page.locator('[data-item-id="rollout"]').click();
    await detail.getByRole('button', { name: 'Show the jobs rail', exact: true }).click();
    await expect(detail.getByRole('list', { name: 'Rollout jobs' }).getByRole('listitem')).toHaveCount(3);

    // Auto validate is on for the pull request, and still nobody is started without a click.
    await h.tick(); await h.tick();
    expect(await agents()).toHaveLength(0); expect((await run({ operation: 'list' }) as any).validations).toHaveLength(0);

    // Validate with… offers only to start one; Validate does it in one click, without a menu.
    await expect(actions.button).toBeEnabled();
    await actions.pick('Validate with…');
    const list = page.getByRole('menu', { name: 'Trigger validation', exact: true }), entry = list.getByRole('menuitem', { name: /^Start a new agent/ });
    await expect(list.getByRole('menuitem')).toHaveText([/^Start a new agent/, 'Cancel']);
    await expect(entry).toHaveAttribute('title', 'A new Claude session beside this rollout, connected to it and its pull requests');
    await page.keyboard.press('Escape');
    await actions.open();
    await expect(actions.item('Validate')).toHaveAttribute('data-primary', '');
    await expect(actions.item('Validate')).not.toHaveAttribute('aria-haspopup', 'menu');
    await actions.item('Validate').click();
    await expect(list).toHaveCount(0);

    // One hidden agent in the rollout's project, connected to the rollout and to the pull request.
    await expect.poll(async () => (await agents()).length, { timeout: 30_000 }).toBe(1);
    const state = await service.control.read(), [agent] = await agents(), rollout = state.nodes.find(node => node.id === 'rollout')!, session = state.resources.find(resource => resource.id === agent.resourceId)!;
    expect(agent.title).toBe(`Validate · ${rollout.title}`); expect(agent.projectId).toBe('project');
    expect(agent.hiddenAt).toBeTruthy(); expect(agent.hideLabel).toBe('validation agent');
    expect(state.links.filter(link => link.targetId === agent.id).map(link => [link.sourceId, link.kind, link.label]).sort()).toEqual([['pr', 'context', ''], ['rollout', 'context', 'Validation']]);
    expect(session.data).toMatchObject({ provider: 'claude', model: 'opus', validation: { rolloutNodeId: 'rollout', validationId: 'V1' } });
    expect(session.data.cwd).toContain('craft-rollout-harness-');

    // The request opened the session in a real PTY, and the scripted agent filed its first report through the bridge.
    const terminal = h.session(String(session.data.sessionId)), printed = () => terminal.output().then(output => output.replace(/\r/g, ''));
    await expect.poll(printed, { timeout: 30_000 }).toContain('VALIDATION_REQUEST:Check whether this rollout works as intended:');
    expect(await printed()).toContain(`It is Agentic Crafting Table item rollout.\n\nPull request behind this rollout: ${state.nodes.find(node => node.id === 'pr')!.title} (https://github.com/fixture/billing/pull/42).`);
    expect(await printed()).toContain('workspace_report_validation (rolloutNodeId "rollout", validationId "V1")');
    await expect(card).toContainText('Planning the checks', { timeout: 30_000 });
    await expect(card).toHaveAttribute('data-v', 'running');
    await expect.poll(printed, { timeout: 30_000 }).toContain('NATIVE_READY:');
    await terminal.type('validation-final');
    await expect(card).toHaveAttribute('data-v', 'passed', { timeout: 30_000 });
    await expect(detail.locator('.rv-verdict')).toContainText('Current verdict: passed');

    // Repeating the same request starts nothing; the agent is offered like any connected one.
    const requestId = (await run({ operation: 'list' }) as any).validations[0].requestId;
    expect(await run({ operation: 'trigger', sourceResourceId: 'rollout-r', value: 'validation-agent', requestId })).toMatchObject({ sent: true, validationId: 'V1', agentNodeId: agent.id });
    expect(await agents()).toHaveLength(1); expect((await run({ operation: 'list' }) as any).validations).toHaveLength(1);
    await expect.poll(async () => ((await run({ operation: 'options' })) as any).options.map((option: any) => [option.id, Boolean(option.disabled)]), { timeout: 30_000 }).toEqual([[agent.id, false], ['new-agent', false]]);

    // The map draws neither the agent nor its links.
    const edge = page.locator(`.react-flow__edge[data-id="${state.links.find(link => link.sourceId === 'rollout' && link.targetId === agent.id)!.id}"]`);
    await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(page.locator('[data-item-id="rollout"]')).toBeVisible();
    await expect(page.locator(`[data-item-id="${agent.id}"]`)).toHaveCount(0);
    await page.locator('[data-item-id="rollout"]').hover(); await expect(edge).toHaveCount(0);

    // Show validation agent on its card closes the view and puts the agent beside the rollout, selected, with its links.
    await page.locator('[data-item-id="rollout"]').click();
    await card.getByRole('button', { name: 'Show validation agent', exact: true }).click();
    await expect(detail).toBeHidden();
    await expect(page.locator(`[data-item-id="${agent.id}"]`)).toBeVisible();
    await expect(page.locator(`[data-selected-id="${agent.id}"]`)).toHaveCount(1);
    const shown = (await service.control.read()).nodes.find(node => node.id === agent.id)!;
    expect(shown.hiddenAt).toBeUndefined(); expect(Math.abs(shown.position.x - rollout.position.x)).toBeLessThan(700); expect(Math.abs(shown.position.y - rollout.position.y)).toBeLessThan(400);
    await page.locator('[data-item-id="rollout"]').hover(); await expect(edge).toHaveCount(1);

    // Its right-click menu hides it again, and the rollout's shows it.
    await page.locator(`[data-item-id="${agent.id}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Hide validation agent', exact: true }).click();
    await expect(page.locator(`[data-item-id="${agent.id}"]`)).toHaveCount(0);
    await page.locator('[data-item-id="rollout"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Show validation agent', exact: true }).click();
    await expect(page.locator(`[data-item-id="${agent.id}"]`)).toBeVisible();
    await expect(page.locator(`[data-selected-id="${agent.id}"]`)).toHaveCount(1);
  } finally { await h.close(); }
});

/** A rollout waiting at one gate with a ready connected agent, where GitHub answers the approval with a reply that confirms nothing. */
async function unconfirmedApproval(applied: boolean, run: (input: { h: Awaited<ReturnType<typeof rolloutHarness>>; providers: ReturnType<typeof rolloutFixture>; approveAndValidate(): Promise<void>; validations(): Promise<unknown[]> }) => Promise<void>) {
  const providers = rolloutFixture();
  providers.run = { ...providers.run, status: 'waiting' }; providers.jobs = providers.jobs.map((job, index) => index ? { ...job, status: 'waiting' } : job);
  providers.gates = [{ environment: { id: 7, name: 'production' }, wait_timer: 0, current_user_can_approve: true, reviewers: [{ type: 'Team' }] }];
  providers.replyToApproval(() => {
    if (applied) { providers.gates = []; providers.run = { ...providers.run, status: 'in_progress' }; providers.jobs = providers.jobs.map(job => job.status === 'waiting' ? { ...job, status: 'in_progress' } : job); }
    return { status: 502, body: null };
  });
  const h = await rolloutHarness(providers, ['claude'], agent => [
    { type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'Rollout', projectId: 'project', position: { x: 260, y: 200 }, data: { owner: 'fixture', repo: 'web', runId: 101 } },
    agent('claude', 'Claude · validator', 60),
    { type: 'link.save', link: { id: 'rollout-claude', sourceId: 'rollout', targetId: 'claude', kind: 'context', label: '' } },
  ]);
  try {
    const { page } = h, actions = prActions(page, page.locator('[data-expanded-item-id]:visible'));
    await page.clock.install();
    await page.locator('[data-item-id="rollout"]').click();
    await expect(page.locator('.rollout-detail .rv-gate .rv-name')).toHaveText('production · approval gate');
    await run({ h, providers,
      async approveAndValidate() {
        const approval = page.getByRole('menu', { name: 'Approve deployment', exact: true });
        await expect(async () => { if (await actions.button.getAttribute('aria-expanded') === 'true') await page.keyboard.press('Escape'); await actions.open(); await expect(actions.item('Approve and validate')).toBeEnabled({ timeout: 500 }); }).toPass();
        await actions.item('Approve and validate').click();
        await approval.getByRole('menuitem', { name: 'Confirm', exact: true }).click();
        await approval.getByRole('menuitem', { name: 'Confirm approval', exact: true }).click();
      },
      async validations() { return (await page.evaluate(() => window.craftingTable.runtimeRun({ action: 'rollout.validation' as 'agent.resume', nodeId: 'rollout', arguments: { operation: 'list' } })) as any).validations; } });
  } finally { await h.close(); }
}

test('an approval GitHub applied but never confirmed still requests the validation once the rollout shows the gate approved', async () => {
  test.setTimeout(120_000);
  await unconfirmedApproval(true, async ({ h, providers, approveAndValidate, validations }) => {
    const detail = h.page.locator('.rollout-detail');
    await approveAndValidate();
    await expect.poll(async () => (await validations() as any[]).map(view => [view.label, view.agentHidden]), { timeout: 30_000 }).toEqual([['V1', true]]);
    expect(providers.approvals).toEqual([{ path: '/repos/fixture/web/actions/runs/101/pending_deployments', environmentIds: [7] }]);
    await expect(detail.locator('.rv-card[aria-label^="V1 · "]')).toBeVisible();
    await expect(detail.locator('.rollout-error')).toBeHidden();
    await expect(h.page.locator('[data-expanded-item-id]:visible .rollout-state')).toHaveText('Ongoing');
  });
});

test('an unconfirmed approval whose gate keeps waiting requests no validation and says so; leaving the view ends the wait', async () => {
  test.setTimeout(120_000);
  await unconfirmedApproval(false, async ({ h, providers, approveAndValidate, validations }) => {
    const { page } = h, error = page.locator('.rollout-detail .rollout-error');
    await approveAndValidate();
    await expect(error).toHaveText('Approval not confirmed yet; checking the rollout…');
    await page.clock.runFor(30_000);
    await expect(error).toHaveText('Approval not confirmed yet; checking the rollout…');
    await page.clock.runFor(31_000);
    await expect(error).toHaveText('The approval did not go through. No validation was requested.');
    expect(providers.approvals).toHaveLength(1); expect(await validations()).toHaveLength(0); expect(await h.output('claude')).not.toContain('validationId');

    // The gate is approved only after the person left: the wait ended with the view, so coming back within it sends nothing.
    await approveAndValidate();
    await expect(error).toHaveText('Approval not confirmed yet; checking the rollout…');
    await page.keyboard.press('Escape'); await expect(page.locator('.rollout-detail')).toBeHidden();
    providers.gates = []; providers.run = { ...providers.run, status: 'in_progress' };
    await h.tick();
    await page.locator('[data-item-id="rollout"]').click();
    await expect(page.locator('.rollout-detail .rv-gate .rv-name')).toHaveText(/production · approved/);
    await page.clock.runFor(61_000);
    await expect(error).toBeHidden();
    expect(providers.approvals).toHaveLength(2); expect(await validations()).toHaveLength(0); expect(await h.output('claude')).not.toContain('validationId');
  });
});
