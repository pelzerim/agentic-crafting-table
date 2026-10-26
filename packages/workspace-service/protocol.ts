import type { WorkspaceState } from '../core/control.ts';

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** `plots` is derived from the committed state and saved plot names (MAP-24); `reminders` is the
 * reminder list with today's states (MAP-REMINDERS). Older services omit either. */
export interface WorkspaceSnapshot { state: WorkspaceState; cursor: number; plots?: import('../../src/graph/plots.ts').PlotSnapshot; projectSummaries?: import('./project-summaries.ts').ProjectSummariesSnapshot; reminders?: import('../core/reminders.ts').RemindersSnapshot }
export interface WireError { message: string; code: string; currentRevision?: number }
export type ResponseFrame = { id: string; result: unknown } | { id: string; error: WireError } | { event: 'snapshot'; snapshot: WorkspaceSnapshot } | { event: 'settings'; settings: import('../core/settings.ts').SettingsSnapshot } | { event: 'recording-deleted'; sessionId: string } | ({ event: 'reminder-due' } & import('../core/reminders.ts').ReminderDue);
/** Error code of a write the service could not confirm: the provider may have applied it. A refusal keeps its own code. */
export const OUTCOME_UNKNOWN = 'OUTCOME_UNKNOWN';
/** Error codes of a request whose reply never arrived: the service may still have run it. */
export const REQUEST_TIMEOUT = 'TIMEOUT', CONNECTION_LOST = 'CONNECTION_LOST';
/** How long a provider action may run in the service: a slow GitHub write plus its refresh. */
export const PROVIDER_ACTION_MS = 180_000;
/** How long a caller waits for a reply: a request that waits on a provider a little longer than the service lets it run, so its own error arrives first. */
const PROVIDER_REPLIES: Record<string, number> = { 'runtime.run': PROVIDER_ACTION_MS + 20_000, 'github.inbox.read': 110_000, 'connections.accounts': 90_000 };
export const replyTimeout = (method: string) => PROVIDER_REPLIES[method] ?? 15_000;
export function serializeError(error: unknown): WireError {
  const value = error as { message?: string; code?: string; currentRevision?: number };
  return { message: value?.message ?? 'Workspace request failed', code: value?.code ?? 'INVALID_REQUEST', ...(typeof value?.currentRevision === 'number' ? { currentRevision: value.currentRevision } : {}) };
}
