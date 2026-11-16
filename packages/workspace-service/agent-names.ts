import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { WorkspaceCommand, WorkspaceControl, WorkspaceState } from '../core/control.ts';
import type { SessionRecord } from '../session-runtime/protocol.ts';
import { findClaudeTranscript } from '../session-runtime/transcripts.ts';
import { nativeName, readClaudeName, renameClaudeSession } from '../session-runtime/native-names.ts';
import { renameCodexThreads } from '../session-runtime/codex.ts';
import { isOffMap } from '../../src/graph/archive.ts';

export const NAME_TICK_MS = 30_000;
/** A transcript that was not found is looked for again after this long; the search lists every Claude project folder.
 * A name a CLI refused (a deleted transcript or thread) is sent again after as long, or at once when the name changes. */
export const NAME_MISSING_RETRY_MS = 5 * 60_000;

/** How the ticks reach the native CLIs; every call is asynchronous. */
export interface NativeNameIo {
  findClaude(id: string): Promise<string | undefined>;
  statClaude(file: string): Promise<{ mtimeMs: number; size: number }>;
  readClaude(file: string): Promise<string | undefined>;
  renameClaude(id: string, name: string, cwd?: string): Promise<void>;
  renameCodex(names: { id: string; name: string }[]): Promise<string[]>;
}
export const nativeNameIo: NativeNameIo = {
  findClaude: id => findClaudeTranscript(id),
  statClaude: async file => { const { mtimeMs, size } = await stat(file); return { mtimeMs, size }; },
  readClaude: readClaudeName,
  renameClaude: renameClaudeSession,
  renameCodex: renameCodexThreads,
};
interface Runtime { call<T>(method: string, args?: unknown): Promise<T> }
interface Transcript { file: string; mtimeMs?: number; size?: number; name?: string }
type Node = WorkspaceState['nodes'][number];
type Resource = WorkspaceState['resources'][number];
interface Agent { node: Node; resource: Resource; provider: 'claude' | 'codex'; id: string; synced?: string }

/** Agents on the map whose conversation has a native ID. `nativeName` on the resource is the last name both sides agreed on. */
function namedAgents(state: WorkspaceState) {
  const resources = new Map(state.resources.map(resource => [resource.id, resource]));
  return state.nodes.flatMap((node): Agent[] => {
    const resource = node.resourceId ? resources.get(node.resourceId) : undefined;
    const provider = resource?.data.provider;
    if (resource?.pluginId !== 'agent.session' || (provider !== 'claude' && provider !== 'codex') || typeof resource.data.nativeSessionId !== 'string') return [];
    if (isOffMap(node, state.nodes)) return [];
    return [{ node, resource, provider, id: resource.data.nativeSessionId, synced: typeof resource.data.nativeName === 'string' ? resource.data.nativeName : undefined }];
  });
}

/** What the person named this conversation in its CLI and the table should take, if anything. Before the first agreement
 * the table's own name wins, unless it is still a creation default. */
export function adoptedName(title: string, synced: string | undefined, native: string | undefined, defaults: readonly string[]) {
  if (!native || native === synced) return undefined;
  if (synced === undefined && !defaults.includes(title)) return undefined;
  return native;
}
/** The table's name that a CLI does not show yet. A creation default (“Claude session”) is no name, so it never replaces one. */
export function pendingName(title: string, synced: string | undefined, defaults: readonly string[]) {
  const name = nativeName(title);
  return name && !defaults.includes(name) && name !== synced ? name : undefined;
}

/** Keeps one name per agent conversation across the table, Claude's and Codex's session pickers (AGENT-07b).
 * Claude: a running session takes the table's name from the prompt hook, because Claude writes the name it holds back
 * over any other; a stopped one is renamed in its transcript. Codex: a running thread is renamed through its terminal's
 * own server, a stopped one through a metadata process. A name typed with `/rename` in either CLI comes back here. */
export class AgentNames {
  private control: WorkspaceControl; private runtime: Runtime; private changed: () => Promise<void>; private allowed: () => boolean; private io: NativeNameIo; private now: () => number;
  private transcripts = new Map<string, Transcript>();
  private missing = new Map<string, number>();
  /** Names a CLI refused, by native ID: a stopped Codex thread costs a process for every attempt. */
  private refused = new Map<string, { name: string; until: number }>();
  private timer?: ReturnType<typeof setTimeout>; private running?: Promise<void>; private paused = true;
  constructor(control: WorkspaceControl, runtime: Runtime, changed: () => Promise<void>, allowed: () => boolean, io: NativeNameIo = nativeNameIo, now: () => number = Date.now) {
    this.control = control; this.runtime = runtime; this.changed = changed; this.allowed = allowed; this.io = io; this.now = now;
  }
  start() { this.paused = false; this.schedule(0); }
  async pause() { this.paused = true; clearTimeout(this.timer); await this.running; }
  private schedule(delay = NAME_TICK_MS) {
    clearTimeout(this.timer); if (this.paused) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick().catch(() => {}).finally(() => this.schedule()); }, delay); this.timer.unref?.();
  }
  tick() { this.running ??= this.tickOnce().finally(() => { this.running = undefined; }); return this.running; }
  private async tickOnce() {
    if (!this.allowed()) return;
    const agents = namedAgents(await this.control.read()), defaults = this.control.registry.get('agent.session')?.activityTitle?.defaults ?? [];
    if (!agents.length) return;
    const records = await this.runtime.call<SessionRecord[]>('sessions.list');
    const live = new Map(records.filter(record => ['starting', 'running'].includes(record.state)).map(record => [record.id, record]));
    const claude = new Set(agents.filter(agent => agent.provider === 'claude').map(agent => agent.id));
    for (const id of [...this.transcripts.keys(), ...this.missing.keys()]) if (!claude.has(id)) { this.transcripts.delete(id); this.missing.delete(id); }
    const known = new Set(agents.map(agent => agent.id));
    for (const id of this.refused.keys()) if (!known.has(id)) this.refused.delete(id);
    const agreed = new Map<string, { name: string; adopt?: string }>(), codex: { agent: Agent; name: string }[] = [];
    for (const agent of agents) {
      const record = live.get(String(agent.resource.data.sessionId));
      const native = agent.provider === 'claude' ? await this.claudeName(agent.id) : record?.native?.nativeSessionId === agent.id && !record.native.switched ? record.native.name : undefined;
      const adopt = adoptedName(agent.node.title, agent.synced, native, defaults);
      if (adopt) { agreed.set(agent.node.id, { name: adopt, ...(adopt !== agent.node.title ? { adopt: agent.node.title } : {}) }); continue; }
      if (native !== undefined && native === nativeName(agent.node.title) && native !== agent.synced) { agreed.set(agent.node.id, { name: native}); continue; }
      const name = pendingName(agent.node.title, agent.synced, defaults), refused = this.refused.get(agent.id);
      if (!name || (refused?.name === name && refused.until > this.now())) continue;
      if (agent.provider === 'codex') { codex.push({ agent, name }); continue; }
      if (record) continue; // The next prompt hook names it; Claude would write its own name back over this one.
      try { await this.io.renameClaude(agent.id, name, typeof agent.resource.data.cwd === 'string' ? agent.resource.data.cwd : undefined); agreed.set(agent.node.id, { name }); }
      catch { this.refuse(agent.id, name); } // Not saved on this computer.
    }
    const stopped: { agent: Agent; name: string }[] = [];
    for (const entry of codex) {
      const record = live.get(String(entry.agent.resource.data.sessionId));
      if (!record?.native || record.native.nativeSessionId !== entry.agent.id || record.native.switched) { stopped.push(entry); continue; }
      try { await this.runtime.call('sessions.rename', { sessionId: record.id, name: entry.name }); agreed.set(entry.agent.node.id, { name: entry.name}); }
      catch { stopped.push(entry); } // A supervisor from before this method: the thread is named on disk instead.
    }
    if (stopped.length) {
      const renamed = new Set(await this.io.renameCodex(stopped.map(({ agent, name }) => ({ id: agent.id, name }))).catch(() => [] as string[]));
      for (const { agent, name } of stopped) if (renamed.has(agent.id)) agreed.set(agent.node.id, { name }); else this.refuse(agent.id, name);
    }
    for (const agent of agents) if (agreed.has(agent.node.id)) this.refused.delete(agent.id);
    if (agreed.size) await this.record(agreed);
  }
  private refuse(id: string, name: string) { this.refused.set(id, { name, until: this.now() + NAME_MISSING_RETRY_MS }); }
  /** Records the name each CLI holds now. A name typed in a CLI renames the item only if the item kept the title it had
   * when that was decided; a newer name on the table is sent on the next tick. */
  private async record(agreed: Map<string, { name: string; adopt?: string }>) {
    for (let attempt = 0; attempt < 3 && this.allowed(); attempt++) {
      const state = await this.control.read(), commands: WorkspaceCommand[] = [];
      for (const agent of namedAgents(state)) {
        const entry = agreed.get(agent.node.id);
        if (!entry || agent.synced === entry.name) continue;
        if (entry.adopt !== undefined && entry.adopt === agent.node.title) commands.push({ type: 'node.update', id: agent.node.id, title: entry.name });
        commands.push({ type: 'item.update', id: agent.node.id, data: { ...agent.resource.data, nativeName: entry.name } });
      }
      if (!commands.length) return;
      try {
        await this.control.dispatch({ commandId: randomUUID(), expectedRevision: state.revision, actor: { kind: 'system', id: 'agent-names' }, commands });
        await this.changed(); return;
      } catch (error) { if ((error as { code?: string }).code !== 'REVISION_CONFLICT') throw error; }
    }
  }
  /** One stat of the transcript; its tail is read only when its time or size changed. */
  private async claudeName(id: string) {
    let transcript = this.transcripts.get(id);
    if (!transcript) {
      if ((this.missing.get(id) ?? -Infinity) > this.now()) return undefined;
      const file = await this.io.findClaude(id).catch(() => undefined);
      if (!file) { this.missing.set(id, this.now() + NAME_MISSING_RETRY_MS); return undefined; }
      this.missing.delete(id); transcript = { file }; this.transcripts.set(id, transcript);
    }
    try {
      const { mtimeMs, size } = await this.io.statClaude(transcript.file);
      if (mtimeMs !== transcript.mtimeMs || size !== transcript.size) Object.assign(transcript, { mtimeMs, size, name: await this.io.readClaude(transcript.file) });
      return transcript.name;
    } catch { this.transcripts.delete(id); return undefined; }
  }
}
