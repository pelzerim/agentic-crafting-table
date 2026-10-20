import * as z from 'zod/v4';
import { envelopeSchema } from '../core/control.ts';
import type { CommandEnvelope, CommandResult, WorkspaceControl, WorkspaceState } from '../core/control.ts';

export const headEnvelopeSchema = envelopeSchema.omit({ expectedRevision: true });
export type HeadEnvelope = z.infer<typeof headEnvelopeSchema>;
export const HEAD_ATTEMPTS = 5;

/** Applies an envelope sent without a revision to the newest workspace: read, dispatch against that revision, and
 * read again when someone else wrote first. The reducer still checks the revision on every attempt, so a write is
 * never applied to a workspace other than the one `allowed` saw. A commandId that was already committed is
 * dispatched against the revision it was committed with, so an exact retry replays and a changed payload is refused.
 * Revision-free writes to one workspace run one after another, so they only ever retry against a writer that named a revision. */
export async function applyAtHead(control: WorkspaceControl, input: unknown, allowed?: (state: WorkspaceState, envelope: HeadEnvelope) => void, attempts = HEAD_ATTEMPTS): Promise<CommandResult> {
  const envelope = headEnvelopeSchema.parse(input);
  const result = (queues.get(control) ?? Promise.resolve()).then(() => attemptAtHead(control, envelope, allowed, attempts));
  queues.set(control, result.catch(() => {}));
  return result;
}
const queues = new WeakMap<WorkspaceControl, Promise<unknown>>();
async function attemptAtHead(control: WorkspaceControl, envelope: HeadEnvelope, allowed: ((state: WorkspaceState, envelope: HeadEnvelope) => void) | undefined, attempts: number): Promise<CommandResult> {
  for (let attempt = 1; ; attempt++) {
    const committed = control.store.receiptRevision?.(envelope.commandId);
    if (committed !== undefined) return control.dispatch({ ...envelope, expectedRevision: committed } satisfies CommandEnvelope);
    const state = await control.read();
    allowed?.(state, envelope);
    try { return await control.dispatch({ ...envelope, expectedRevision: state.revision } satisfies CommandEnvelope); }
    catch (error) {
      // The same commandId committed between the receipt check and the dispatch: the next attempt replays it.
      const code = (error as { code?: string }).code;
      if ((code !== 'REVISION_CONFLICT' && code !== 'COMMAND_ID_CONFLICT') || attempt >= attempts) throw error;
    }
  }
}
