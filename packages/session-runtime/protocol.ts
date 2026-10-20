import * as z from 'zod/v4';
const id = z.string().min(1).max(200);
export const launchSchema = z.object({
  sessionId: id, requestId: id, nodeId: id, workspaceId: id,
  predecessorId: id.optional(),
  // Retired startup-replay fields: accepted for old durable receipts, ignored.
  shellIntegration: z.boolean().optional(),
  startupCommand: z.object({ text: z.string().min(1).max(32_000), cwd: z.string().min(1).max(4096) }).optional(),
  readOnly: z.boolean().optional(),
  stopOnArchive: z.boolean().optional(),
  native: z.object({ provider: z.literal('codex'), nativeSessionId: z.string().uuid().optional(), model: z.string().max(100).optional(),
    instructions: z.string().max(32_000), context: z.string().max(32_000), config: z.record(z.string(), z.json()),
    initialPrompt: z.string().max(32_000).optional(),
    serverArguments: z.array(z.string().max(200_000)).max(100).default([]),
  }).optional(),
  executable: z.string().min(1).max(4096), args: z.array(z.string().max(200_000)).max(100),
  cwd: z.string().min(1).max(4096), cols: z.number().int().min(2).max(500).default(100), rows: z.number().int().min(2).max(300).default(30),
  // Explicit host-generated bindings, never credentials supplied by the renderer.
  bindings: z.partialRecord(z.enum(['ACT_DATA_DIR', 'ACT_NODE_ID', 'ACT_PROJECT_ID', 'ACT_SESSION_ID', 'CLAUDE_CODE_FORCE_SYNC_OUTPUT']), z.string()).optional(),
});
export type LaunchRequest = z.infer<typeof launchSchema>;
export interface NativeAgentState { provider: 'codex'; nativeSessionId: string; status: 'idle' | 'working' | 'input' | 'error' | 'unknown'; input?: 'approval' | 'question'; observedAt: string; readyAt?: string; completionId?: string }
export interface SessionRecord {
  id: string; requestId: string; nodeId: string; workspaceId: string; cwd: string;
  state: 'starting' | 'running' | 'exited' | 'failed' | 'lost';
  pid?: number; exitCode?: number; signal?: number; error?: string; cols: number; rows: number;
  createdAt: string; updatedAt: string;
  archivedAt?: string; removedAt?: string; predecessorId?: string;
  native?: NativeAgentState;
  commandTracking?: 'ready' | 'starting' | 'unsupported';
  lastCommand?: { text: string; cwd: string };
  lastCommandError?: string;
  readOnly?: boolean;
  stopOnArchive?: boolean;
  recordingComplete?: boolean; displayThroughSequence?: number;
  recordingDeletedAt?: string;
  stopRequestedAt?: string;
  /** When the person last pressed Enter, a lone Escape or a single digit in this
   * session's terminal, and the output sequence at that moment. Input the table
   * sends itself never counts. Kept in memory for the life of the process. */
  decisiveInputAt?: number; decisiveInputSequence?: number;
}
export interface OutputChunk { sequence: number; data: string }
export interface SessionSnapshot { session: SessionRecord; chunks: OutputChunk[]; firstSequence: number; lastSequence: number; truncated: boolean; hasMore?: boolean; recordingEnd?: number; replayFrom?: number }
export type SessionEvent = { kind: 'output'; sessionId: string; chunk: OutputChunk } | { kind: 'state'; session: SessionRecord };
export const sessionIdSchema = z.object({ sessionId: id });
export const recordingsSchema = z.object({ before: z.number().int().positive().optional() });
export const deleteRecordingSchema = sessionIdSchema.extend({ confirmation: z.literal('delete-recording') }).strict();
export interface RecordingPage {
  allocatedBytes: number; reusableBytes: number; nextBefore?: number;
  recordings: { id: string; nodeId: string; state: SessionRecord['state']; createdAt: string; deletedAt?: string; archivedAt?: string; removedAt?: string; hasOutput: boolean; cleanupPending?: boolean }[];
}
export const managedSessionsSchema = z.object({ view: z.enum(['active', 'archived', 'all']).default('active') });
export const manageSessionSchema = sessionIdSchema.extend({ action: z.enum(['archive', 'restore', 'remove']), preservePids: z.array(z.number().int().positive()).max(8).optional() });
export type SessionListView = z.infer<typeof managedSessionsSchema>['view'];
/** Settings → Sessions pages: Current is starting/running (including stopping), Ended is
 * exited/failed/lost, Archived is every archived state. Removed entries never appear. */
export const sessionPageSchema = z.object({ view: z.enum(['current', 'ended', 'archived']).default('current'),
  offset: z.number().int().min(0).max(1_000_000).default(0), limit: z.number().int().min(1).max(5000).default(50) }).strict();
export type SessionPageRequest = z.infer<typeof sessionPageSchema>;
export type SessionPageView = SessionPageRequest['view'];
export interface SessionPage { sessions: SessionRecord[]; total: number; counts: Record<SessionPageView, number> }
export type SessionManagementAction = z.infer<typeof manageSessionSchema>['action'];
export const stopSessionSchema = sessionIdSchema.extend({ preservePids: z.array(z.number().int().positive()).max(8).default([]) });
/** `source: 'user'` marks keys the person typed in the app's terminal; only the desktop main process sets it. */
export const inputSchema = sessionIdSchema.extend({ data: z.string().max(64 * 1024), encoding: z.literal('binary').optional(), source: z.literal('user').optional() })
  .refine(input => input.encoding !== 'binary' || !/[^\u0000-\u00ff]/.test(input.data), 'Binary input must contain only byte values');
export const resizeSchema = sessionIdSchema.extend({ cols: launchSchema.shape.cols, rows: launchSchema.shape.rows });
export const readSessionSchema = sessionIdSchema.extend({ after: z.number().int().nonnegative().optional(), history: z.boolean().optional(), through: z.number().int().nonnegative().optional(), tail: z.number().int().positive().optional() });
