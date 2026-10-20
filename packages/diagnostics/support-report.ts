import type { WorkspaceState } from '../core/control.ts';
import type { AppSettings } from '../core/settings.ts';
import type { SessionRecord } from '../session-runtime/protocol.ts';
import type { JobRecord } from '../workspace-service/sqlite-store.ts';

/** Allowlist, never redact arbitrary strings: private fields are not copied at all. */
export function supportReport(state: WorkspaceState, settings: AppSettings, jobs: JobRecord[], sessions?: SessionRecord[]) {
  const count = <T extends { state: string }>(values: T[], names: string[]) => Object.fromEntries(names.map(name => [name, values.filter(value => value.state === name).length]));
  return {
    version: 1,
    environment: { platform: process.platform, architecture: process.arch, node: process.versions.node, electron: process.versions.electron ?? null },
    workspace: { projects: state.nodes.filter(node => !node.resourceId).length, items: state.nodes.filter(node => node.resourceId).length,
      resources: state.resources.length, links: state.links.length, todos: state.todos.length, archived: state.nodes.filter(node => node.archivedAt).length },
    connections: { configured: settings.connections.length, enabled: settings.connections.filter(connection => connection.enabled).length },
    jobs: count(jobs, ['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'outcome-unknown']),
    sessions: { available: Boolean(sessions), counts: count(sessions ?? [], ['starting', 'running', 'exited', 'failed', 'lost']) },
    diagnostics: { fileMiB: settings.diagnostics.fileMiB, backups: settings.diagnostics.backups, terminalRecordings: 'preserved' as const },
  };
}
export type SupportReport = ReturnType<typeof supportReport>;
