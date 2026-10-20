import { expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { SqliteStore } from '../../packages/workspace-service/sqlite-store.ts';
import { connectWorkspace } from '../../packages/workspace-service/client.ts';
import { connectSupervisor } from '../../packages/session-runtime/client.ts';
import { WorkspaceControl, MemoryStore, stateSchema } from '../../packages/core/control.ts';
import type { WorkspaceCommand, WorkspaceState } from '../../packages/core/control.ts';
import { createResourcePluginRegistry } from '../../src/resource-plugins/builtins.ts';
import { isBelow } from '../../src/graph/archive.ts';
import { exitWithoutShutdown } from './exit-without-shutdown.ts';
import { scrollbarArgs } from './visual-fixture.ts';

export const WINDOW = { width: 1440, height: 900 };
export const NOW = '2026-10-06T09:00:00Z';
export interface Launched { app: ElectronApplication; page: Page; close(): Promise<void> }

/** The hidden app on a prepared workspace, in UTC with the clock fixed at `NOW`. */
/** Nodes, resources and links laid over an empty workspace, or a whole state. */
export type Seed = WorkspaceState | { nodes: unknown[]; resources: unknown[]; links: unknown[] };
export async function launchWorkspace(state: Seed, camera = { x: 140, y: 100, zoom: .7 }, options: { scale?: number; layout?: 'mirror' | 'classic' } = {}): Promise<Launched> {
  const directory = await mkdtemp(join(tmpdir(), 'act-undermap-mirror-'));
  const store = new SqliteStore(join(directory, 'workspace.sqlite'));
  try { await store.update(base => stateSchema.parse({ ...base, ...state })); await store.writeView('desktop', { camera }); } finally { store.close(); }
  const app = await electron.launch({ args: ['.', `--force-device-scale-factor=${options.scale ?? 1}`, '--disable-lcd-text', '--force-color-profile=srgb', ...scrollbarArgs], env: { ...process.env, ACT_TEST_DATA_DIR: directory, SHELL: '/bin/sh', TZ: 'UTC', LANG: 'en_US.UTF-8' } });
  const page = await app.firstWindow();
  await page.route(/^https?:\/\//, route => route.abort());
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.clock.setFixedTime(new Date(NOW));
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), WINDOW);
  await expect(page.getByText('Desktop connected')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  if (options.layout) await setLayout(page, options.layout);
  const close = async () => {
    await exitWithoutShutdown(app);
    for (const connect of [() => connectWorkspace(directory), () => connectSupervisor(join(directory, 'runtime'))]) {
      const client = await connect().catch(() => undefined);
      if (client) { try { const stopped = once(client, 'disconnected', { signal: AbortSignal.timeout(5000) }); await client.call('admin.shutdown'); await stopped; } catch { /* already gone */ } finally { client.close(); } }
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  return { app, page, close };
}

/** Settings → Map → Undermap layout, written the way the settings page saves it. */
export async function setLayout(page: Page, layout: 'mirror' | 'classic') {
  await page.evaluate(async layout => {
    const saved = await window.craftingTable.settingsRead();
    await window.craftingTable.settingsWrite({ expectedRevision: saved.revision, value: { ...saved.value, undermapLayout: layout } });
  }, layout);
}
export const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
export const apply = (page: Page, commands: WorkspaceCommand[]) => page.evaluate(async (commands: unknown[]) => {
  const { state } = await window.craftingTable.workspaceRead();
  await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor: { kind: 'user', id: 'test' }, commands: commands as never });
}, commands as unknown[]);
export const camera = async (page: Page) => (await page.evaluate(() => window.craftingTable.viewRead())).camera!;
export async function travel(page: Page, to: 'map' | 'below') {
  const started = Date.now();
  await page.locator('.below-portal').click();
  await expect(page.locator('.map-area')).toHaveAttribute('data-layer', to);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return Date.now() - started;
}
/** World position of a mounted card, as the map placed it. */
export const world = (page: Page, id: string) => page.locator(`[data-item-id="${id}"]`).evaluate(card => ({ x: Number((card as HTMLElement).dataset.worldX), y: Number((card as HTMLElement).dataset.worldY) }));
export const mountedCards = (page: Page) => page.locator('.react-flow__node .map-card').count();
export const dom = (page: Page) => page.evaluate(() => ({ nodes: document.querySelectorAll('.react-flow__node').length, cards: document.querySelectorAll('.react-flow__node .map-card').length, elements: document.querySelectorAll('*').length }));

const PROJECTS = [
  { id: 'billing', title: 'Billing redesign', x: 300, y: 300, key: 'BIL' },
  { id: 'docs', title: 'Docs site', x: 3300, y: 300, key: 'DOC' },
];
/** Two projects on the map and a hand-made history below: Billing with one month past its budget and two older
 * months, Docs with two months that fill its budget and an older one, and two items of no project. Stored positions below are
 * a strip far to the right, as the classic placement leaves them. */
export function monthsState(): Seed {
  const nodes: Record<string, unknown>[] = [], resources: Record<string, unknown>[] = [];
  const ticket = (id: string, title: string, projectId: string | undefined, position: { x: number; y: number }, extra: Record<string, unknown> = {}) => {
    nodes.push({ id, resourceId: `${id}-r`, title, position, ...(projectId ? { projectId } : {}), ...extra });
    resources.push({ id: `${id}-r`, pluginId: 'linear.ticket', schemaVersion: 1, title, data: { issueId: title.split(' ')[0] } });
  };
  for (const p of PROJECTS) {
    nodes.push({ id: p.id, title: p.title, position: { x: p.x, y: p.y }, summary: '' });
    ticket(`${p.id}-live-1`, `${p.key}-1 · live work`, p.id, { x: p.x + 350, y: p.y - 60 });
    ticket(`${p.id}-live-2`, `${p.key}-2 · more live work`, p.id, { x: p.x + 700, y: p.y + 110 });
  }
  let stored = 0;
  const send = (prefix: string, key: string, projectId: string | undefined, count: number, from: string, topic: string, hours = 6) => {
    for (let index = 0; index < count; index++) {
      const at = new Date(Date.parse(from) + index * hours * 3_600_000).toISOString(), position = { x: 9000 + (stored % 40) * 280, y: 4000 + Math.floor(stored++ / 40) * 120 };
      ticket(`${prefix}-${String(index).padStart(2, '0')}`, `${key}-${100 + stored} · ${topic} ${index + 1}`, projectId, position, { belowAt: at, mapPosition: { x: 700 + index, y: 500 } });
    }
  };
  send('bil-oct', 'BIL', 'billing', 40, '2026-10-01T08:00:00Z', 'invoice webhook', 2);
  send('bil-sep', 'BIL', 'billing', 30, '2026-09-02T08:00:00Z', 'plan switcher');
  send('bil-jun', 'BIL', 'billing', 9, '2026-06-03T08:00:00Z', 'rate limiter');
  send('doc-oct', 'DOC', 'docs', 3, '2026-10-02T08:00:00Z', 'sidebar order');
  send('doc-sep', 'DOC', 'docs', 25, '2026-09-10T08:00:00Z', 'search index');
  send('doc-dec', 'DOC', 'docs', 24, '2025-12-05T08:00:00Z', 'usage export');
  send('loose', 'OPS', undefined, 2, '2026-10-03T08:00:00Z', 'loose end');
  return { nodes, resources, links: [] };
}

function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }
const HISTORY_PROJECTS = [
  { id: 'billing', title: 'Billing redesign', x: 300, y: 300, key: 'BIL', repo: 'billing', weight: 4 },
  { id: 'mobile', title: 'Mobile app', x: 2300, y: 300, key: 'APP', repo: 'mobile', weight: 5 },
  { id: 'docs', title: 'Docs site', x: 300, y: 1500, key: 'DOC', repo: 'docs', weight: 2 },
  { id: 'website', title: 'Website', x: 2300, y: 1500, key: 'WEB', repo: 'website', weight: 3 },
];
const VERBS = ['Fix', 'Add', 'Remove', 'Refactor', 'Speed up', 'Guard', 'Rename', 'Migrate', 'Retry', 'Document'];
const THINGS = ['plan switcher', 'proration preview', 'invoice webhook', 'retry budget', 'sort order', 'image cropping', 'photo upload', 'search index', 'sidebar order', 'rate limiter', 'cart badge', 'dark mode', 'token refresh', 'usage export', 'cache key', 'flaky spec'];
/** Days each size of the audit's history is spread over. */
export const HISTORY_DAYS: Record<number, number> = { 10: 6, 100: 21, 300: 62, 1000: 180 };

/** A history of four projects, small units of work that
 * appear, are partly marked done and are sent below through the app's own commands, so the stored positions
 * are what the classic placement produced. Returns one state per requested count of items below. */
export async function history(targets: number[]): Promise<Map<number, WorkspaceState>> {
  const control = new WorkspaceControl(new MemoryStore(), createResourcePluginRegistry());
  const random = rng(20261006);
  let state = await control.apply({ type: 'project.create', id: HISTORY_PROJECTS[0].id, title: HISTORY_PROJECTS[0].title, summary: '', position: { x: HISTORY_PROJECTS[0].x, y: HISTORY_PROJECTS[0].y } } as never, 0);
  const run = async (command: unknown) => { state = await control.apply(command as never, state.revision); };
  for (const p of HISTORY_PROJECTS.slice(1)) await run({ type: 'project.create', id: p.id, title: p.title, summary: '', position: { x: p.x, y: p.y } });
  let n = 4000;
  const add = async (p: typeof HISTORY_PROJECTS[number], id: string, pluginId: string, title: string, data: Record<string, unknown>, slot: number, extra: Record<string, unknown> = {}) => {
    await run({ type: 'item.add', id, resourceId: `${id}-r`, pluginId, title, data, projectId: p.id, position: { x: p.x + 330 + (slot % 3) * 320, y: p.y - 60 + Math.floor(slot / 3) * 170 } });
    if (Object.keys(extra).length) await run({ type: 'node.update', id, ...extra });
  };
  for (const p of HISTORY_PROJECTS) {
    await add(p, `${p.id}-live-agent`, 'agent.session', 'Claude · implementation', { sessionId: `static-${p.id}`, provider: 'claude' }, 0, { summary: 'Working through the review comments', activity: 'working' });
    await add(p, `${p.id}-live-pr`, 'github.pull-request', `${VERBS[n % 10]} ${THINGS[n % 16]}`, { owner: 'example', repo: p.repo, number: n++ }, 1, { summary: `PR #${n - 1} · Ready for review` });
    await add(p, `${p.id}-live-ticket`, 'linear.ticket', `${p.key}-${n % 400} · ${THINGS[(n + 3) % 16]}`, { issueId: `${p.key}-${n % 400}` }, 2);
  }
  const snapshots = new Map<number, { state: WorkspaceState; units: number }>(), unitOf = new Map<string, number>();
  const belowCount = () => state.nodes.filter(node => node.resourceId && isBelow(node, state.nodes)).length;
  const wheel = HISTORY_PROJECTS.flatMap(p => Array(p.weight).fill(p)) as typeof HISTORY_PROJECTS;
  let unit = 0;
  const pending = [...targets].sort((a, b) => a - b);
  while (pending.length) {
    const p = wheel[Math.floor(random() * wheel.length)], ids: string[] = [], thing = THINGS[Math.floor(random() * 16)], verb = VERBS[Math.floor(random() * 10)];
    const number = n++;
    const item = async (kind: string, pluginId: string, title: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const id = `u${unit}-${kind}`; ids.push(id); unitOf.set(id, unit);
      await add(p, id, pluginId, title, data, 3 + ids.length - 1, extra);
    };
    await item('pr', 'github.pull-request', `${verb} ${thing}`, { owner: 'example', repo: p.repo, number }, { summary: `PR #${number} · Merged` });
    if (random() < .7) await item('agent', 'agent.session', `Claude · ${verb.toLowerCase()} ${thing}`, { sessionId: `static-u${unit}`, provider: 'claude' }, { summary: 'Finished · merged and deployed' });
    if (random() < .5) await item('ticket', 'linear.ticket', `${p.key}-${number % 900} · ${thing}`, { issueId: `${p.key}-${number % 900}` });
    if (random() < .4) await item('rollout', 'github.rollout', `Rollout · ${p.repo} #${number}`, { owner: 'example', repo: p.repo, runId: number });
    if (random() < .15) await item('note', 'workspace.note', 'Note', { text: `Remember: ${thing} needs a follow-up` });
    for (const id of ids) if (random() < .6) await run({ type: 'node.complete', id });
    if (random() < .5) await run({ type: 'nodes.action', ids, action: 'below' });
    else for (const id of ids) await run({ type: 'node.below', id });
    if (unit === 3 || unit === 5 || unit === 6) for (const id of ids) await run({ type: 'node.archive', id });
    unit++;
    while (pending.length && belowCount() >= pending[0]) snapshots.set(pending.shift()!, { state: structuredClone(state), units: unit });
  }
  // Spread the send dates over a believable period ending the day before `NOW`.
  const end = Date.parse('2026-10-05T16:00:00Z');
  return new Map([...snapshots].map(([size, shot]) => [size, stateSchema.parse({ ...shot.state, nodes: shot.state.nodes.map(node => {
    const at = unitOf.get(node.id); if (at === undefined) return node;
    const date = new Date(end - (1 - (at + 1) / shot.units) * (HISTORY_DAYS[size] ?? 30) * 86_400_000).toISOString();
    return { ...node, ...(node.belowAt ? { belowAt: date } : {}), ...(node.archivedAt ? { archivedAt: date } : {}), ...(node.completedAt ? { completedAt: date } : {}) };
  }) })]));
}
