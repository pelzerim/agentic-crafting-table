import { useState } from 'react';
import { moveItems } from '../../../src/graph/movement.ts';
import { createResourcePluginRegistry } from '../../../src/resource-plugins/builtins.ts';
import { ProjectMap } from './project-map.tsx';
import type { ProjectMapProps } from './project-map.tsx';
import { TerminalSurface } from './terminal.tsx';
import type { TerminalChannel } from './terminal.tsx';
import type { ResourceRecord } from '../../../src/resource-plugins/types.ts';

const resources: ResourceRecord[] = [
  { id: 'terminal-resource', pluginId: 'terminal.session', schemaVersion: 1, title: 'Renderer terminal', data: { sessionId: 'spike', workspaceId: 'local', shell: '/bin/zsh', cwd: '/tmp' } },
  { id: 'pr-resource', pluginId: 'github.pull-request', schemaVersion: 1, title: 'Plan switcher', data: { owner: 'example', repo: 'billing', number: 48 } },
  { id: 'ticket-resource', pluginId: 'linear.ticket', schemaVersion: 1, title: 'BIL-128 · Plan changes', data: { issueId: 'BIL-128' } },
];
const registry = createResourcePluginRegistry();

/** Explicit, isolated rendering fixture. No provider calls or shell execution. */
export function RendererSpike() {
  const [nodes, setNodes] = useState<ProjectMapProps['nodes']>([
    { id: 'billing', title: 'Billing redesign', position: { x: 200, y: 320 }, summary: 'Renderer fixture · sample data' },
    { id: 'terminal', title: 'Renderer terminal', resourceId: 'terminal-resource', projectId: 'billing', position: { x: 570, y: 200 }, summary: 'Terminal mounting check', activity: 'working', attention: 'input', attentionNote: 'Agent waiting' },
    { id: 'pr', title: 'Plan switcher', resourceId: 'pr-resource', projectId: 'billing', position: { x: 570, y: 400 }, summary: 'PR #48 · sample', attention: 'review', attentionNote: 'Review requested' },
    { id: 'ticket', title: 'BIL-128 · Plan changes', resourceId: 'ticket-resource', projectId: 'billing', position: { x: 850, y: 320 }, summary: '' },
  ]);
  const [channel] = useState<TerminalChannel>(() => {
    const listeners = new Set<(data: string) => void>();
    return { id: 'renderer-fixture', history: '\x1b[32mRenderer fixture — input is echoed, no commands run.\x1b[0m\r\n$ ', onOutput(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }, write(data) { for (const listener of listeners) listener(data === '\r' ? '\r\n$ ' : data); }, resize() {} };
  });
  return <ProjectMap nodes={nodes} resources={resources} links={[{ id: 'ticket-context', sourceId: 'ticket', targetId: 'terminal', kind: 'reference', label: '' }]}
    onMove={(id, position) => setNodes(old => moveItems(old, resources, registry, [{ id, position }]))}
    renderDetail={(node, active) => node.id === 'terminal' ? <TerminalSurface channel={channel} active={active} /> : <p>{node.title} · Renderer fixture</p>} />;
}
