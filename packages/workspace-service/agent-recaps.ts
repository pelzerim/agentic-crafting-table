import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { WorkspaceCommand, WorkspaceControl, WorkspaceState } from '../core/control.ts';
import { readRecap } from '../session-runtime/recaps.ts';
import type { Recap } from '../session-runtime/recaps.ts';
import { claudeConfigDirectory, findClaudeTranscript } from '../session-runtime/transcripts.ts';
import { isArchived } from '../../src/graph/archive.ts';

export const RECAP_TICK_MS = 30_000;
/** Node updates one tick writes at most; the rest follow on the next tick. */
export const RECAP_BATCH = 100;
/** A session whose transcript was not found is looked for again after this long; the search lists every Claude project folder. */
export const RECAP_MISSING_RETRY_MS = 5 * 60_000;

/** How the ticks reach Claude's transcripts; every call is asynchronous. */
export interface RecapFiles {
  find(sessionId: string): Promise<string | undefined>;
  stat(file: string): Promise<{ mtimeMs: number; size: number }>;
  read(file: string): Promise<Recap | undefined>;
}
export const recapFiles = (directory?: string): RecapFiles => ({
  find: sessionId => findClaudeTranscript(sessionId, directory ?? claudeConfigDirectory()),
  stat: async file => { const { mtimeMs, size } = await stat(file); return { mtimeMs, size }; },
  read: readRecap,
});

interface Transcript { file: string; mtimeMs?: number; size?: number; recap?: Recap }

/** Idle and waiting Claude agents, not archived, with the native session their transcript is named after. */
function recapAgents(state: WorkspaceState) {
  const resources = new Map(state.resources.map(resource => [resource.id, resource]));
  return state.nodes.flatMap(node => {
    const resource = node.resourceId ? resources.get(node.resourceId) : undefined;
    if (resource?.pluginId !== 'agent.session' || resource.data.provider !== 'claude' || typeof resource.data.nativeSessionId !== 'string') return [];
    if (node.activity === 'working' || isArchived(node, state.nodes)) return [];
    return [{ node, sessionId: resource.data.nativeSessionId }];
  });
}

/** Claude Code writes a recap into its transcript while the person is away, with no hook. Every tick looks at
 * the transcripts of idle Claude agents (one stat each, a tail read only when a file changed) and keeps the
 * newest recap that is newer than the agent's last turn end on its node. */
export class AgentRecaps {
  private control: WorkspaceControl; private changed: () => Promise<void>; private allowed: () => boolean; private files: RecapFiles;
  private transcripts = new Map<string, Transcript>();
  private missing = new Map<string, number>();
  private now: () => number;
  private timer?: ReturnType<typeof setTimeout>; private running?: Promise<void>; private paused = true;
  constructor(control: WorkspaceControl, changed: () => Promise<void>, allowed: () => boolean, files: RecapFiles = recapFiles(), now: () => number = Date.now) {
    this.control = control; this.changed = changed; this.allowed = allowed; this.files = files; this.now = now;
  }
  start() { this.paused = false; this.schedule(0); }
  async pause() { this.paused = true; clearTimeout(this.timer); await this.running; }
  private schedule(delay = RECAP_TICK_MS) {
    clearTimeout(this.timer); if (this.paused) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick().catch(() => {}).finally(() => this.schedule()); }, delay); this.timer.unref();
  }
  tick() { this.running ??= this.tickOnce().finally(() => { this.running = undefined; }); return this.running; }
  private async tickOnce() {
    if (!this.allowed()) return;
    const agents = recapAgents(await this.control.read()), sessions = new Set(agents.map(agent => agent.sessionId));
    for (const sessionId of this.transcripts.keys()) if (!sessions.has(sessionId)) this.transcripts.delete(sessionId);
    for (const sessionId of this.missing.keys()) if (!sessions.has(sessionId)) this.missing.delete(sessionId);
    for (const sessionId of sessions) await this.refresh(sessionId);
    for (let attempt = 0; attempt < 3 && this.allowed(); attempt++) {
      const state = await this.control.read(), commands: WorkspaceCommand[] = [];
      for (const { node, sessionId } of recapAgents(state)) {
        const transcript = this.transcripts.get(sessionId);
        if (!transcript || transcript.size === undefined) continue;
        const after = Date.parse(node.turnEndedAt ?? node.activityAt ?? '') || 0, recap = transcript.recap && Date.parse(transcript.recap.at) > after ? transcript.recap : undefined;
        if (JSON.stringify(recap) === JSON.stringify(node.recap)) continue;
        commands.push({ type: 'node.update', id: node.id, recap: recap ?? null });
        if (commands.length === RECAP_BATCH) break;
      }
      if (!commands.length) return;
      try {
        await this.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'system', id: 'recaps' }, commands });
        await this.changed(); return;
      } catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error; }
    }
  }
  /** One stat of the session's transcript; its tail is read only when its time or size changed. */
  private async refresh(sessionId: string) {
    let transcript = this.transcripts.get(sessionId);
    if (!transcript) {
      if ((this.missing.get(sessionId) ?? -Infinity) > this.now()) return;
      const file = await this.files.find(sessionId);
      if (!file) { this.missing.set(sessionId, this.now() + RECAP_MISSING_RETRY_MS); return; }
      this.missing.delete(sessionId);
      transcript = { file }; this.transcripts.set(sessionId, transcript);
    }
    try {
      const { mtimeMs, size } = await this.files.stat(transcript.file);
      if (mtimeMs === transcript.mtimeMs && size === transcript.size) return;
      const recap = await this.files.read(transcript.file);
      Object.assign(transcript, { mtimeMs, size, recap });
    } catch { this.transcripts.delete(sessionId); }
  }
}
