import { test, expect } from '@playwright/test';
import { rolloutFixture } from '../fixtures/rollout.ts';
import { rolloutHarness } from './rollout-harness.ts';
import { longReport as prose } from '../fixtures/rollout-report.ts';

/** The feed scrolled from the top in screen-sized steps: a report longer than the view, in readable pieces. */
async function shots(page: import('@playwright/test').Page, name: string) {
  const feed = page.locator('.rv-feed'), view = page.locator('[data-expanded-item-id]:visible');
  const { scrollHeight, clientHeight } = await feed.evaluate(element => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
  for (let index = 0, top = 0; top < scrollHeight && index < 6; index++, top += clientHeight - 40) {
    await feed.evaluate((element, value) => { element.scrollTop = value; }, top);
    await view.screenshot({ path: `.local/rollout-validations/${name}-${index + 1}.png` });
  }
}

const markdown = 'Memory per instance grew with the instance count.\n\n1. 2 instances: 100 MB\n2. 4 instances: **150 MB**\n\nDetails in [the dashboard](https://metrics.example.com/d/memory), [an http link](http://insecure.example.com) and `top`.\n\n```\nmemory_mb{instance="a"} 150\n```\n\n<img src=x onerror="window.injected=1">';

/** Checks stack as separate blocks, and nothing in the card is wider than the card. */
async function separateBlocks(card: import('@playwright/test').Locator) {
  const boxes = await card.locator('.rv-check').evaluateAll(rows => rows.map(row => { const box = row.getBoundingClientRect(); return { top: box.top, bottom: box.bottom }; }));
  for (let index = 1; index < boxes.length; index++) expect(boxes[index].top).toBeGreaterThanOrEqual(boxes[index - 1].bottom - 1);
  expect(await card.evaluate(element => [element, ...element.querySelectorAll('*')].filter(node => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX === 'visible').map(node => node.className))).toEqual([]);
}

test('a validation report reads as a head, a summary and one block per check', async () => {
  test.setTimeout(120_000);
  const providers = rolloutFixture();
  const h = await rolloutHarness(providers, ['claude'], agent => [
    { type: 'item.add', id: 'rollout', resourceId: 'rollout-r', pluginId: 'github.rollout', title: 'Rollout', projectId: 'project', position: { x: 260, y: 200 }, data: { owner: 'fixture', repo: 'web', runId: 101 } },
    agent('claude', 'Claude · validator', 60),
    { type: 'link.save', link: { id: 'rollout-claude', sourceId: 'rollout', targetId: 'claude', kind: 'context', label: '' } },
  ]);
  try {
    const { page, app } = h, view = page.locator('[data-expanded-item-id]:visible'), detail = page.locator('.rollout-detail'), card = detail.locator('.rv-card[aria-label^="V1 · "]');
    await page.locator('[data-item-id="rollout"]').click();
    await page.evaluate(() => window.craftingTable.runtimeRun({ action: 'rollout.validation' as 'agent.resume', nodeId: 'rollout', arguments: { operation: 'trigger', sourceResourceId: 'rollout-r', value: 'claude', requestId: crypto.randomUUID() } }));
    await expect.poll(() => h.output('claude'), { timeout: 15_000 }).toContain('validationId "V1"');
    await h.report('claude', 'rollout', prose);
    await expect(card).toHaveAttribute('data-v', 'running');
    const row = (title: string) => card.locator('.rv-check', { hasText: title });
    for (const title of ['Instances ready', 'Settings applied', 'Long-term memory']) await row(title).locator('.rv-check-toggle').click();
    // The head is the summary's first sentence; the rest reads one sentence per paragraph in body weight.
    await expect(card.locator('.rv-card-title')).toHaveText('PR #12 deployed cleanly to both environments.');
    await expect(card.locator('.rv-summary p')).toHaveCount(3);
    await expect(card.locator('.rv-summary p').first()).toHaveText(/^The thumbnail service started on preview/);
    // Each check is its own block: status, title, target and method, then observation, labelled metrics and evidence.
    await expect(card.locator('.rv-check')).toHaveCount(6);
    await expect(row('Error rate and latency').locator('.rv-target')).toHaveText('live · metrics');
    await expect(row('Error rate and latency').locator('.rv-observation p')).toHaveCount(3);
    await expect(row('Error rate and latency').locator('.rv-metric-row')).toHaveCount(3);
    await expect(row('Error rate and latency').locator('.rv-metric-row').last()).toContainText('memory per instance');
    await expect(row('Error rate and latency').locator('.rv-metric-row').first()).toContainText('10 min before vs 10 min after');
    await expect(row('Long-term memory').locator('.rv-check-why')).toContainText('Skipped');
    await expect(row('Long-term memory').locator('.rv-observation')).toHaveText(prose.checks[4].observation);
    await expect(row('Image pipeline').locator('.rv-check-toggle')).toHaveAttribute('aria-expanded', 'false');
    await separateBlocks(card);
    await shots(page, 'report-prose');

    // A report written in Markdown keeps its paragraphs, lists, emphasis, code and https links, and never its HTML.
    await app.evaluate(({ shell }) => { (globalThis as any).openedUrls = []; shell.openExternal = async (url: string) => { (globalThis as any).openedUrls.push(url); }; });
    await h.report('claude', 'rollout', { validationId: 'V1', sequence: 2, phase: 'final', verdict: 'concerns',
      summary: 'Errors are flat; memory per instance is higher than before.\n\nThe settle window showed:\n- 1 of 4 instances retried once\n- p95 0.2 s, **0 failures**\n\nSee `thumbnails.env` for the cache mode.',
      checks: [{ id: 'C1', title: 'Memory per instance', status: 'concern', target: 'live', observation: markdown, metrics: [{ label: 'memory per instance', before: 100, after: 150, unit: 'MB', better: 'lower' }] },
        { id: 'C2', title: 'Error rate', status: 'passed', observation: 'Flat at 0.4 %.' }] });
    await expect(card).toHaveAttribute('data-v', 'concerns');
    await expect(card.locator('.rv-card-title')).toHaveText('Errors are flat; memory per instance is higher than before.');
    await expect(card.locator('.rv-summary > p')).toHaveText(['The settle window showed:', 'See thumbnails.env for the cache mode.']);
    await expect(card.locator('.rv-summary li')).toHaveText(['1 of 4 instances retried once', 'p95 0.2 s, 0 failures']);
    await expect(card.locator('.rv-summary strong')).toHaveText('0 failures');
    await expect(card.locator('.rv-summary code')).toHaveText('thumbnails.env');
    const observation = row('Memory per instance').locator('.rv-observation');
    await expect(observation.locator('> p')).toHaveCount(2);
    await expect(observation.locator('ol > li')).toHaveText(['2 instances: 100 MB', '4 instances: 150 MB']);
    await expect(observation.locator('pre')).toContainText('memory_mb{instance="a"} 150');
    await expect(observation.locator('a')).toHaveCount(1);
    await expect(observation.locator('a')).toHaveAttribute('href', 'https://metrics.example.com/d/memory');
    await expect(observation).toContainText('an http link');
    await expect(observation).toContainText('<img src=x');
    await expect(card.locator('img')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).injected)).toBeUndefined();
    await expect(card).not.toContainText('**');
    await separateBlocks(card);
    await observation.locator('a').click();
    await expect.poll(() => app.evaluate(() => (globalThis as any).openedUrls)).toEqual(['https://metrics.example.com/d/memory']);
    await shots(page, 'report-markdown');
  } finally { await h.close(); }
});
