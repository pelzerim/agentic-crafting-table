import { randomUUID } from 'node:crypto';
import type { WorkspaceControl } from '../core/control.ts';
import { archiveTodo } from '../core/todos.ts';
import { archiveDue, doneArchiveDays, todoList } from '../../src/graph/todos.ts';
import type { JsonObject } from '../../src/resource-plugins/types.ts';

export const TODO_SWEEP_MS = 60_000;

/** Sends Done rows to Archive once the days chosen in Settings → Items → To-do have passed (TODO-12),
 * the same way Archive works from the list. Quiet: nothing else changes and nothing is deleted. */
export class TodoSweeper {
  private control: WorkspaceControl; private settings: () => JsonObject | undefined; private changed: () => Promise<void>; private allowed: () => boolean; private now: () => number;
  private timer?: ReturnType<typeof setTimeout>; private running?: Promise<void>; private paused = true;
  constructor(control: WorkspaceControl, settings: () => JsonObject | undefined, changed: () => Promise<void>, allowed: () => boolean, now = Date.now) {
    this.control = control; this.settings = settings; this.changed = changed; this.allowed = allowed; this.now = now;
  }
  start() { this.paused = false; this.schedule(0); }
  async pause() { this.paused = true; clearTimeout(this.timer); await this.running; }
  /** A changed choice applies at once. */
  settingsChanged() { if (!this.paused) this.schedule(0); }
  private schedule(delay = TODO_SWEEP_MS) {
    clearTimeout(this.timer); if (this.paused) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.sweep().catch(() => {}).finally(() => this.schedule()); }, delay); this.timer.unref();
  }
  sweep() { this.running ??= this.sweepOnce().finally(() => { this.running = undefined; }); return this.running; }
  private async sweepOnce() {
    for (let attempt = 0; attempt < 5 && this.allowed(); attempt++) {
      const state = await this.control.read(), days = doneArchiveDays(this.settings()?.doneArchiveDays), now = this.now();
      const due = todoList(state).done.filter(entry => archiveDue(entry, days, now));
      if (!due.length) return;
      try {
        await this.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'system', id: 'todos' }, commands: due.map(entry => archiveTodo(state, entry)) });
        await this.changed(); return;
      } catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error; }
    }
  }
}
