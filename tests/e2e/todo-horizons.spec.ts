import { expect } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { test } from './visual-fixture.ts';
import type { WorkspaceCommand } from '../../packages/core/control.ts';

const read = (page: Page) => page.evaluate(async () => (await window.craftingTable.workspaceRead()).state);
async function apply(page: Page, commands: WorkspaceCommand[], actor: { kind: 'user' | 'provider'; id: string } = { kind: 'user', id: 'fixture' }) {
  await page.evaluate(async ({ payload, actor }) => {
    const { state } = await window.craftingTable.workspaceRead();
    await window.craftingTable.workspaceApply({ commandId: crypto.randomUUID(), expectedRevision: state.revision, actor, commands: JSON.parse(payload) });
  }, { payload: JSON.stringify(commands), actor });
}
const key = (number: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(number).padStart(12, '0')}`;
const ticket = (number: number, title: string, status: string) => ({ source: 'linear', key: key(number), label: `APP-${number}`, status, url: `https://linear.app/fixture/issue/APP-${number}/ticket`,
  item: { pluginId: 'linear.ticket', title: `APP-${number} · ${title}`, data: { issueId: key(number) } } });
/** A sample: three in Next, a Linear ticket among four in Later, three done and four tickets waiting. */
async function seed(page: Page) {
  await apply(page, [
    { type: 'project.create', id: 'website', title: 'Website', summary: '', color: '#6fd6cf', position: { x: 300, y: 1100 } },
    { type: 'todo.save', todo: { id: 'retry', title: 'Agree the retry limit with finance', completed: false, nodeIds: ['billing'] } },
    { type: 'todo.save', todo: { id: 'key', title: 'Renew the docs site certificate', completed: false, nodeIds: ['website'] } },
    { type: 'todo.save', todo: { id: 'status', title: 'Show export status in the app', completed: false, nodeIds: ['billing'] } },
    { type: 'todo.save', todo: { id: 'deploy', title: 'Auto-publish docs on Mondays', completed: false, nodeIds: ['billing'], horizon: 'later' } },
    { type: 'todo.save', todo: { id: 'handover', title: 'Write the release notes template', completed: false, nodeIds: [], horizon: 'later' } },
    { type: 'todo.save', todo: { id: 'owners', title: 'Decide who owns docs page permissions', completed: false, nodeIds: [], horizon: 'later', triage: ticket(88, 'Decide who owns docs page permissions', 'Todo') } },
    { type: 'todo.save', todo: { id: 'holiday', title: 'Holiday banner draft', completed: false, nodeIds: [], horizon: 'later' } },
  ]);
  // Done lists the latest first; saved apart, oldest first, the three never tie on the millisecond.
  for (const [index, title] of ['Merge the invoice email templates', 'Fix the cart badge', 'Dark mode contrast'].entries()) {
    await apply(page, [{ type: 'todo.save', todo: { id: `done-${2 - index}`, title, completed: true, nodeIds: index === 0 ? ['website'] : [] } }]);
    await page.waitForTimeout(5);
  }
  await apply(page, ([[94, 'Flaky search results page', 'Triage'], [93, 'Upgrade the date picker', 'Backlog'], [91, 'Email on failed invoice runs', 'Todo'], [12, 'Docs: billing exports FAQ', 'Backlog']] as const)
    .map(([number, title, status]) => ({ type: 'todo.save', todo: { id: `inbox-${number}`, title, completed: false, nodeIds: [], horizon: 'inbox', triage: ticket(number, title, status) } })), { kind: 'provider', id: 'linear-fixture' });
}
async function openList(page: Page) {
  const list = page.getByRole('form', { name: 'To-dos', exact: true });
  if (await list.getAttribute('data-open') !== 'true') await page.getByRole('button', { name: /^Keep to-dos open/ }).click();
  await expect(list).toHaveAttribute('data-open', 'true');
  return list;
}
const group = (list: Locator, name: string) => list.getByRole('region', { name, exact: true });
const titles = (list: Locator, name: string) => group(list, name).locator('.todo-row .todo-row-title');
const NEXT = ['Agree the retry limit with finance', 'Renew the docs site certificate', 'Show export status in the app'];
const LATER = ['Auto-publish docs on Mondays', 'Write the release notes template', 'Decide who owns docs page permissions', 'Holiday banner draft'];
/** Drags a row by its grip the way the browser does: start, hover the target, then drop or cancel. */
async function drag(page: Page, list: Locator, title: string, target: Locator, finish: 'drop' | 'cancel' = 'drop', at: 'top' | 'middle' = 'middle') {
  const transfer = await page.evaluateHandle(() => new DataTransfer()), box = (await target.boundingBox())!;
  // The browser sends dragend to the element the drag began on, wherever the row is drawn by then.
  const grip = (await list.getByRole('button', { name: `Reorder ${title}`, exact: true }).elementHandle())!;
  await grip.dispatchEvent('dragstart', { dataTransfer: transfer });
  await target.dispatchEvent('dragover', { dataTransfer: transfer, clientY: at === 'top' ? box.y + 1 : box.y + box.height / 2 });
  return async () => { if (finish === 'drop') await target.dispatchEvent('drop', { dataTransfer: transfer }); await grip.dispatchEvent('dragend', { dataTransfer: transfer }); };
}

test('the sheet shows From Linear folded to a count, Next, Later and a folded Done; projects are chips and the badge counts the inbox only', async ({ visual: { page } }) => {
  await seed(page);
  const list = await openList(page);
  await expect(group(list, 'From Linear').locator('.todo-group-count')).toHaveText('4');
  await expect(group(list, 'From Linear').locator('.todo-row')).toHaveCount(0);
  await expect(titles(list, 'Next')).toHaveText(NEXT); await expect(titles(list, 'Later')).toHaveText(LATER);
  await expect(group(list, 'Done').locator('.todo-group-count')).toHaveText('3'); await expect(group(list, 'Done').locator('.todo-row')).toHaveCount(0);
  await expect(page.locator('.todo-inbox-count')).toHaveText('4');
  await expect(page.getByRole('button', { name: 'Close to-dos: 4 in the inbox', exact: true })).toBeVisible();
  await expect(list.locator('[data-todo-id="key"] .todo-project')).toHaveText('Website');
  await expect(list.locator('[data-todo-id="handover"] .todo-project')).toHaveCount(0);
  await expect(list.locator('[data-todo-id="owners"] .todo-chips .todo-chip')).toHaveText(['APP-88', 'Todo']);
  await expect(list.locator('.todo-summary')).toHaveText('3 next · 4 later');
  await page.mouse.move(700, 700);
  await expect(list.locator('.rail-panel-sheet')).toHaveScreenshot('todo-sheet.png');
});

test('an inbox ticket is taken with Next or Later or by dragging it, and Not for me hides it with Undo', async ({ visual: { page } }) => {
  await seed(page);
  const list = await openList(page), inbox = group(list, 'From Linear');
  await inbox.getByRole('button', { name: 'Show 4 from Linear', exact: true }).click();
  await expect(titles(list, 'From Linear')).toHaveText(['Flaky search results page', 'Upgrade the date picker', 'Email on failed invoice runs', 'Docs: billing exports FAQ']);
  await expect(inbox.locator('.todo-row').first().locator('.todo-chip')).toHaveText(['APP-94', 'Triage']);
  await page.mouse.move(700, 700);
  await expect(list.locator('.rail-panel-sheet')).toHaveScreenshot('todo-sheet-inbox.png');
  await inbox.getByRole('button', { name: 'Take APP-94 into Next', exact: true }).click();
  await expect(titles(list, 'Next')).toHaveText([...NEXT, 'Flaky search results page']);
  await expect(page.locator('.todo-inbox-count')).toHaveText('3');
  let state = await read(page);
  expect(state.todos.find(todo => todo.id === 'inbox-94')).toMatchObject({ horizon: 'next', triage: { label: 'APP-94' } });
  // Dragging into Later takes it there, at the place it is dropped.
  const finish = await drag(page, list, 'Upgrade the date picker', list.locator('[data-todo-id="handover"]'));
  await expect(titles(list, 'Later')).toHaveText([LATER[0], 'Upgrade the date picker', ...LATER.slice(1)]);
  expect((await read(page)).todos.find(todo => todo.id === 'inbox-93')?.horizon).toBe('inbox');
  await finish();
  await expect.poll(async () => (await read(page)).todos.find(todo => todo.id === 'inbox-93')?.horizon).toBe('later');
  await expect(titles(list, 'Later')).toHaveText([LATER[0], 'Upgrade the date picker', ...LATER.slice(1)]);
  await inbox.getByRole('button', { name: 'APP-91 is not for me', exact: true }).click();
  await expect(titles(list, 'From Linear')).toHaveText(['Docs: billing exports FAQ']);
  const toast = page.getByRole('status').filter({ hasText: 'Hidden until it changes' });
  await expect(toast).toContainText('APP-91 Email on failed invoice runs');
  await toast.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(titles(list, 'From Linear')).toHaveText(['Email on failed invoice runs', 'Docs: billing exports FAQ']);
  state = await read(page);
  expect(state.todos.find(todo => todo.id === 'inbox-91')?.dismissed).toBeUndefined();
  expect(state.nodes.some(node => node.title.includes('APP-'))).toBe(false);
});

test('ticking folds a row into Done with Undo; Done shows and folds, and unticking returns the row', async ({ visual: { page } }) => {
  await seed(page);
  const list = await openList(page);
  await list.getByRole('checkbox', { name: 'Complete Agree the retry limit with finance', exact: true }).click();
  await expect(titles(list, 'Next')).toHaveText(NEXT.slice(1)); await expect(group(list, 'Done').locator('.todo-group-count')).toHaveText('4');
  const toast = page.getByRole('status').filter({ hasText: 'Agree the retry limit with finance' });
  await toast.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(titles(list, 'Next')).toHaveText(NEXT);
  expect((await read(page)).todos.find(todo => todo.id === 'retry')?.completed).toBe(false);
  await list.locator('[data-todo-id="key"]').focus(); await page.keyboard.press('Space');
  await expect(titles(list, 'Next')).toHaveText([NEXT[0], NEXT[2]]);
  await expect(list.locator('[data-todo-id="status"]')).toBeFocused();
  await group(list, 'Done').getByRole('button', { name: 'Show 4 done', exact: true }).click();
  await expect(titles(list, 'Done')).toHaveCount(4); await expect(titles(list, 'Done').first()).toHaveText('Renew the docs site certificate');
  await expect(group(list, 'Done')).toContainText('Done rows go to Archive after 3 days.');
  await page.mouse.move(700, 700); await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(list.locator('.rail-panel-sheet')).toHaveScreenshot('todo-sheet-done.png');
  await group(list, 'Done').getByRole('checkbox', { name: 'Complete Renew the docs site certificate', exact: true }).uncheck();
  await expect(titles(list, 'Next')).toHaveText(NEXT);
  await group(list, 'Done').getByRole('button', { name: 'Fold 3 done', exact: true }).click();
  await expect(group(list, 'Done').locator('.todo-row')).toHaveCount(0);
});

test('N, L and Alt+arrows move a focused row; fields and editors keep their keys', async ({ visual: { page } }) => {
  await seed(page);
  const list = await openList(page), holiday = list.locator('[data-todo-id="holiday"]');
  await holiday.focus(); await page.keyboard.press('n');
  await expect(titles(list, 'Next')).toHaveText([...NEXT, 'Holiday banner draft']); await expect(holiday).toBeFocused();
  await expect(page.locator('.attention-list')).toHaveCount(0);
  await page.keyboard.press('Alt+ArrowUp');
  await expect(titles(list, 'Next')).toHaveText([NEXT[0], NEXT[1], 'Holiday banner draft', NEXT[2]]);
  await page.keyboard.press('Alt+ArrowUp');
  await expect(titles(list, 'Next')).toHaveText([NEXT[0], 'Holiday banner draft', NEXT[1], NEXT[2]]);
  await page.keyboard.press('Alt+ArrowDown');
  await expect(titles(list, 'Next')).toHaveText([NEXT[0], NEXT[1], 'Holiday banner draft', NEXT[2]]);
  await page.keyboard.press('l');
  await expect(titles(list, 'Later')).toHaveText([...LATER.filter(title => title !== 'Holiday banner draft'), 'Holiday banner draft']);
  expect((await read(page)).todos.find(todo => todo.id === 'holiday')?.horizon).toBe('later');
  const input = list.getByRole('textbox', { name: 'New to-do', exact: true });
  await input.focus(); await page.keyboard.type('nl ');
  await expect(input).toHaveValue('nl '); await expect(titles(list, 'Next')).toHaveText(NEXT);
  await list.locator('[data-todo-id="retry"]').getByRole('button', { name: 'Edit Agree the retry limit with finance', exact: true }).click();
  const editor = list.getByRole('textbox', { name: 'Edit title', exact: true });
  await editor.press('End'); await editor.pressSequentially(' now'); await editor.press('Enter');
  await expect(titles(list, 'Next').first()).toHaveText('Agree the retry limit with finance now');
  await expect(titles(list, 'Next')).toHaveCount(3);
});

test('rows move between Next, Later and Done by drag with the prospective place shown, saved only on drop', async ({ visual: { page } }) => {
  await seed(page);
  const list = await openList(page), before = await read(page);
  let finish = await drag(page, list, 'Renew the docs site certificate', list.locator('[data-todo-id="handover"]'), 'cancel');
  await expect(titles(list, 'Later')).toHaveText([LATER[0], 'Renew the docs site certificate', ...LATER.slice(1)]);
  await expect(list.locator('[data-todo-id="key"]')).toHaveAttribute('data-reordering', 'true');
  expect((await read(page)).revision).toBe(before.revision);
  await finish();
  await expect(titles(list, 'Next')).toHaveText(NEXT); await expect(titles(list, 'Later')).toHaveText(LATER);
  expect((await read(page)).revision).toBe(before.revision);
  finish = await drag(page, list, 'Renew the docs site certificate', list.locator('[data-todo-id="handover"]')); await finish();
  await expect.poll(async () => (await read(page)).todos.find(todo => todo.id === 'key')?.horizon).toBe('later');
  await expect(titles(list, 'Later')).toHaveText([LATER[0], 'Renew the docs site certificate', ...LATER.slice(1)]);
  expect((await read(page)).todos.find(todo => todo.id === 'key')?.nodeIds).toEqual(['website']);
  finish = await drag(page, list, 'Holiday banner draft', list.locator('[data-todo-id="retry"]'), 'drop', 'top'); await finish();
  await expect(titles(list, 'Next')).toHaveText(['Holiday banner draft', NEXT[0], NEXT[2]]);
  finish = await drag(page, list, 'Show export status in the app', group(list, 'Done')); await finish();
  await expect.poll(async () => (await read(page)).todos.find(todo => todo.id === 'status')?.completed).toBe(true);
  await expect(page.getByRole('status').filter({ hasText: 'Show export status in the app' })).toBeVisible();
  await page.reload(); const reopened = await openList(page);
  await expect(titles(reopened, 'Next')).toHaveText(['Holiday banner draft', NEXT[0]]);
});

type Drawn = { id: string; y: number };
type Frame = { at: number; next: string[]; later: string[] };
type DragWindow = { todoTransfer: DataTransfer; todoGrip: Element };
/** Rows as drawn, in list order, leaving out the placeholder of the row being moved. */
const drawn = (list: Locator) => list.evaluate(form => [...form.querySelectorAll<HTMLElement>('.todo-list .todo-row[data-todo-id]:not([data-reordering="true"])')]
  .map(row => ({ id: row.dataset.todoId!, y: Math.round(row.getBoundingClientRect().top) })));
/** Drags a row by its grip a step at a time, as the browser does: each event goes to whatever is under the pointer, and dragend to the grip the drag began on. */
async function slowDrag(page: Page, list: Locator, title: string) {
  const grip = list.getByRole('button', { name: `Reorder ${title}`, exact: true }), box = (await grip.boundingBox())!, x = box.x + 120;
  await grip.evaluate(element => {
    const held = window as unknown as DragWindow; held.todoTransfer = new DataTransfer(); held.todoGrip = element;
    element.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: held.todoTransfer }));
  });
  return {
    start: box.y + box.height / 2, x,
    over: (y: number) => page.evaluate(([x, y]) => new Promise<void>(resolve => {
      (document.elementFromPoint(x, y) ?? document.body).dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: (window as unknown as DragWindow).todoTransfer }));
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }), [x, y] as const),
    /** Drops at y and records the order of Next and Later in every frame for `ms` after. */
    drop: (y: number, ms: number) => page.evaluate(([x, y, ms]) => new Promise<Frame[]>(resolve => {
      const held = window as unknown as DragWindow, frames: Frame[] = [], ids = (group: string) => [...document.querySelectorAll<HTMLElement>(`section[data-group="${group}"] .todo-row[data-todo-id]`)].map(row => row.dataset.todoId!);
      const start = performance.now();
      (document.elementFromPoint(x, y) ?? document.body).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: held.todoTransfer }));
      held.todoGrip.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: held.todoTransfer }));
      const sample = () => { const at = performance.now() - start; frames.push({ at, next: ids('next'), later: ids('later') }); if (at < ms) requestAnimationFrame(sample); else resolve(frames); };
      requestAnimationFrame(sample);
    }), [x, y, ms] as const),
  };
}
/** Holds every workspace write in the main process for `ms`, as a large workspace does, so the list is seen while its save is in flight. */
const slowSaves = (app: ElectronApplication, ms: number) => app.evaluate(({ ipcMain }, ms) => {
  type Handler = (event: unknown, request: { method: string }) => Promise<unknown>;
  const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers, request = handlers.get('workspace:request');
  if (!request) throw new Error('No workspace request handler to slow down');
  handlers.set('workspace:request', async (event, input) => { if (input.method === 'apply') await new Promise(resolve => setTimeout(resolve, ms)); return request(event, input); });
}, ms);
/** Counts the workspace requests the renderer makes from now on, by method. */
const countRequests = async (app: ElectronApplication) => {
  await app.evaluate(({ ipcMain }) => {
    type Handler = (event: unknown, request: { method: string }) => Promise<unknown>;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers, request = handlers.get('workspace:request')!, counts: Record<string, number> = {};
    (globalThis as unknown as { requestCounts: Record<string, number> }).requestCounts = counts;
    handlers.set('workspace:request', async (event, input) => {
      counts[input.method] = (counts[input.method] ?? 0) + 1;
      try { return await request(event, input); } finally { counts[`${input.method} done`] = (counts[`${input.method} done`] ?? 0) + 1; }
    });
  });
  return () => app.evaluate(() => ({ ...(globalThis as unknown as { requestCounts: Record<string, number> }).requestCounts }));
};
/** Presses Alt+arrow on the focused row `times` times in one task, then records the order of Next in every frame for `ms`. */
const pressAndWatch = (page: Page, key: 'ArrowUp' | 'ArrowDown', times: number, ms: number) => page.evaluate(([key, times, ms]) => new Promise<Frame[]>(resolve => {
  const frames: Frame[] = [], ids = (group: string) => [...document.querySelectorAll<HTMLElement>(`section[data-group="${group}"] .todo-row[data-todo-id]`)].map(row => row.dataset.todoId!);
  const start = performance.now();
  for (let press = 0; press < times; press++) document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true }));
  const sample = () => { const at = performance.now() - start; frames.push({ at, next: ids('next'), later: ids('later') }); if (at < ms) requestAnimationFrame(sample); else resolve(frames); };
  requestAnimationFrame(sample);
}), [key, times, ms] as const);

test('a slow drag moves only a gap: other rows keep their order and move by its height, and outside changes wait for the drop', async ({ visual: { app, page } }) => {
  await seed(page); await slowSaves(app, 400);
  const list = await openList(page);
  await group(list, 'From Linear').getByRole('button', { name: 'Show 4 from Linear', exact: true }).click();
  const before = await drawn(list), height = Math.round((await list.locator('[data-todo-id="inbox-93"]').boundingBox())!.height);
  const order = before.map(row => row.id).filter(id => id !== 'inbox-93'), view = (await list.locator('.todo-list').boundingBox())!;
  const steady = async () => {
    const rows = await drawn(list);
    expect(rows.map(row => row.id)).toEqual(order);
    for (const row of rows) {
      const shift = row.y - before.find(start => start.id === row.id)!.y;
      expect([0, height, -height].some(allowed => Math.abs(shift - allowed) <= 1), `${row.id} moved ${shift}px; the gap is ${height}px`).toBe(true);
    }
    return rows;
  };
  const pointer = await slowDrag(page, list, 'Upgrade the date picker');
  let y = pointer.start;
  for (let next = y; next < view.y + view.height - 4; next += 6) { y = next; await pointer.over(y); await steady(); }
  // A change from elsewhere mid-drag: a new row in Next and two Later rows swapped. Nothing moves until the drop.
  const held = await steady();
  await apply(page, [{ type: 'todo.save', todo: { id: 'late', title: 'Arrives mid-drag', completed: false, nodeIds: [] } }, { type: 'todos.reorder', ids: ['holiday', 'deploy'], scope: 'items' }]);
  await expect.poll(async () => (await read(page)).todos.some(todo => todo.id === 'late')).toBe(true);
  await page.waitForTimeout(250);
  expect(await drawn(list)).toEqual(held);
  const { into, after } = await list.evaluate(form => {
    const gap = form.querySelector<HTMLElement>('.todo-row[data-reordering="true"]')!, section = gap.closest<HTMLElement>('section')!;
    const rows = [...section.querySelectorAll<HTMLElement>('.todo-row[data-todo-id]')];
    return { into: section.dataset.group as 'next' | 'later', after: rows[rows.indexOf(gap) + 1]?.dataset.todoId };
  });
  expect(['next', 'later']).toContain(into); expect(after).toBeTruthy();
  // The row lands where the gap was at once, and the list never shows the old order while the save is in flight.
  const frames = await pointer.drop(y, 800);
  expect(frames[0].at).toBeLessThan(100);
  for (const frame of frames) {
    expect(frame[into].indexOf('inbox-93'), `frame at ${Math.round(frame.at)}ms: Next ${frame.next.join(', ')} · Later ${frame.later.join(', ')}`).toBe(frame[into].indexOf(after!) - 1);
    expect(frame.later).toEqual(frames[0].later); expect(frame.next).toEqual(frames[0].next);
  }
  expect(frames[0].next).toContain('late');
  await expect.poll(async () => (await read(page)).todos.find(todo => todo.id === 'inbox-93')?.horizon).toBe(into);
  await page.reload(); const reopened = await openList(page);
  for (const name of ['next', 'later'] as const) expect(await reopened.locator(`section[data-group="${name}"] .todo-row[data-todo-id]`).evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.todoId))).toEqual(frames[0][name]);
});

test('rapid Alt+↑ presses all land at once, without flicker, and save in order', async ({ visual: { app, page } }) => {
  await seed(page); await slowSaves(app, 400);
  const list = await openList(page), holiday = list.locator('[data-todo-id="holiday"]');
  await holiday.focus(); await page.keyboard.press('n');
  await expect(titles(list, 'Next')).toHaveText([...NEXT, 'Holiday banner draft']);
  await expect.poll(async () => (await read(page)).todos.find(todo => todo.id === 'holiday')?.horizon).toBe('next');
  await expect(holiday).toBeFocused();
  const frames = await pressAndWatch(page, 'ArrowUp', 3, 800);
  expect(frames[0].at).toBeLessThan(100);
  for (const frame of frames) expect(frame.next, `frame at ${Math.round(frame.at)}ms`).toEqual(['holiday', 'retry', 'key', 'status']);
  await expect(holiday).toBeFocused();
  await expect.poll(async () => { const state = await read(page); return state.todos.filter(todo => todo.horizon === 'next' && !todo.completed).sort((a, b) => (a.todoOrder ?? 0) - (b.todoOrder ?? 0)).map(todo => todo.id); })
    .toEqual(['holiday', 'retry', 'key', 'status']);
  await expect(list.getByRole('alert')).toHaveCount(0);
  const down = await pressAndWatch(page, 'ArrowDown', 2, 800);
  for (const frame of down) expect(frame.next).toEqual(['retry', 'key', 'holiday', 'status']);
  await page.reload(); const reopened = await openList(page);
  await expect(titles(reopened, 'Next')).toHaveText([NEXT[0], NEXT[1], 'Holiday banner draft', NEXT[2]]);
});

test('a move saves once and takes the state the service broadcasts, without reading the workspace back', async ({ visual: { app, page } }) => {
  await seed(page);
  const list = await openList(page), status = list.locator('[data-todo-id="status"]');
  await status.focus();
  const counts = await countRequests(app);
  await page.keyboard.press('Alt+ArrowUp'); await page.keyboard.press('Alt+ArrowDown'); await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(async () => (await counts())['apply done']).toBe(3);
  await page.waitForTimeout(200);
  expect(await counts()).toEqual({ apply: 3, 'apply done': 3 });
  await expect(titles(list, 'Next')).toHaveText([NEXT[0], NEXT[2], NEXT[1]]);
  expect((await read(page)).todos.find(todo => todo.id === 'status')?.todoOrder).toBe(1);
});

test('Next warns above five rows and moves the oldest to Later on request', async ({ visual: { page } }) => {
  await seed(page);
  for (const id of ['retry', 'key', 'status']) { await apply(page, [{ type: 'todo.move', id, horizon: 'next' }]); await page.waitForTimeout(5); }
  await apply(page, ['Trim the long tests', 'Pair on the importer', 'Answer the pricing thread'].map((title, index) => ({ type: 'todo.save', todo: { id: `more-${index}`, title, completed: false, nodeIds: [] } })));
  const list = await openList(page), warning = group(list, 'Next').locator('.todo-limit');
  await expect(warning).toContainText('Next is getting long.');
  await page.mouse.move(700, 700);
  await expect(list.locator('.rail-panel-sheet')).toHaveScreenshot('todo-sheet-soft-limit.png');
  await warning.getByRole('button', { name: 'Move the oldest to Later', exact: true }).click();
  await expect(titles(list, 'Later').first()).toHaveText(NEXT[0]);
  await expect(warning).toHaveCount(0);
});

test('projects line up in one column at the right of every row, with links just left of it', async ({ visual: { page } }) => {
  await seed(page);
  await apply(page, [{ type: 'todo.save', todo: { id: 'handover', title: 'Write the release notes template', completed: false, nodeIds: ['pr', 'brief'], horizon: 'later' } }]);
  const list = await openList(page);
  const cells = await list.locator('section[data-group="next"] .todo-row, section[data-group="later"] .todo-row').evaluateAll(rows => rows.map(row => {
    const cell = row.querySelector('.todo-project-cell')?.getBoundingClientRect(), links = row.querySelector('.todo-links:not(.todo-context-glyph)')?.getBoundingClientRect();
    return { id: (row as HTMLElement).dataset.todoId, x: cell && Math.round(cell.x), width: cell && Math.round(cell.width), chip: Boolean(row.querySelector('.todo-project-cell .todo-project')), links: links && Math.round(links.right) };
  }));
  expect(cells.map(cell => cell.id)).toEqual(['retry', 'key', 'status', 'deploy', 'handover', 'owners', 'holiday']);
  expect(new Set(cells.map(cell => `${cell.x}/${cell.width}`)).size).toBe(1);
  expect(cells[0].width).toBeGreaterThan(40);
  expect(cells.find(cell => cell.id === 'holiday')).toMatchObject({ chip: false });
  const linked = cells.find(cell => cell.id === 'handover')!;
  expect(linked.chip).toBe(true); expect(linked.links! <= linked.x! && linked.links! >= linked.x! - 8).toBe(true);
  await list.getByRole('button', { name: 'Group by project', exact: true }).click();
  await expect(group(list, 'Next').getByRole('group').first()).toBeVisible();
  await expect(list.locator('section[data-group="next"] .todo-project-cell:visible, section[data-group="later"] .todo-project-cell:visible')).toHaveCount(0);
});

test('Group by project restores project groups inside Next and Later and is remembered', async ({ visual: { page } }) => {
  await seed(page);
  const list = await openList(page), toggle = list.getByRole('button', { name: 'Group by project', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(group(list, 'Next').getByRole('group')).toHaveText([/^Billing redesign/, /^Website/]);
  await expect(group(list, 'Later').getByRole('group').locator('h4')).toHaveText(['Billing redesign', 'No project']);
  await page.mouse.move(700, 700); await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(list.locator('.rail-panel-sheet')).toHaveScreenshot('todo-sheet-by-project.png');
  // Within a project group a row moves past its neighbours of the same project; its project never changes.
  await list.locator('[data-todo-id="status"]').focus(); await page.keyboard.press('Alt+ArrowUp');
  await expect(group(list, 'Next').getByRole('group', { name: 'Billing redesign in Next', exact: true }).locator('.todo-row-title')).toHaveText([NEXT[2], NEXT[0]]);
  await expect.poll(() => page.evaluate(async () => (await window.craftingTable.viewRead()).todoOverlay?.groupByProject)).toBe(true);
  await page.reload(); const reopened = await openList(page);
  await expect(reopened.getByRole('button', { name: 'Group by project', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await reopened.getByRole('button', { name: 'Group by project', exact: true }).click();
  await expect(group(reopened, 'Next').getByRole('group')).toHaveCount(0);
});

test('Later rows untouched for 30 days show their age and its menu archives them', async ({ visual: { page } }) => {
  await seed(page);
  await page.clock.setFixedTime(new Date(Date.now() + 34 * 86_400_000));
  await page.reload();
  const list = await openList(page);
  await expect(group(list, 'Later').locator('.todo-age')).toHaveText(['34d', '34d', '34d', '34d']);
  await expect(group(list, 'Next').locator('.todo-age')).toHaveCount(0);
  await group(list, 'Later').getByRole('button', { name: 'Later options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Archive rows untouched for 30 days', exact: true }).click();
  await expect(group(list, 'Later').locator('.todo-row')).toHaveCount(0);
  const state = await read(page);
  expect(state.todos.filter(todo => LATER.includes(todo.title)).every(todo => todo.archivedAt)).toBe(true);
});
