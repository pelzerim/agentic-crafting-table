import { useEffect, useMemo, useState } from 'react';
import type { WorkspaceState, WorkspaceCommand } from '../../../packages/core/control.ts';
import type { ResourcePluginRegistry } from '../../../src/resource-plugins/registry.ts';
import { automaticLink, validateLink } from '../../../src/graph/graph.ts';
import type { GraphLink } from '../../../src/graph/graph.ts';
import { resourceCardinality } from '../../../src/graph/resource-links.ts';
import { isOffMap } from '../../../src/graph/archive.ts';
import { FloatingPanel } from './ui/floating-panel.tsx';
import { PixelCombobox } from './ui/combobox.tsx';
import { itemOptions } from './ui/item-options.ts';
import { NodeIcon } from './ui/node-icon.tsx';
import { Segmented } from './ui/segmented.tsx';
import { Button } from './ui/button.tsx';
import { ErrorNotice } from './ui/notice.tsx';
import { useMapObstacles } from './use-map-obstacles.ts';

/** Keyboard alternative to dragging: choose an endpoint; the kind defaults to what a drop would make. */
export function ConnectionEditor({ draft, state, registry, save, close, highlight }: { draft: { sourceId: string; screen: { x: number; y: number } }; state: WorkspaceState; registry: ResourcePluginRegistry; save(commands: WorkspaceCommand[]): Promise<void>; close(): void; highlight(nodeId: string | undefined): void }) {
  const [targetId, setTarget] = useState(''), [kind, setKind] = useState<GraphLink['kind']>();
  const [id] = useState(() => crypto.randomUUID()), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const source = state.nodes.find(node => node.id === draft.sourceId), target = state.nodes.find(node => node.id === targetId);
  const targets = useMemo(() => itemOptions(state.nodes, node => node.id !== draft.sourceId && !isOffMap(node, state.nodes)), [state.nodes, draft.sourceId]);
  const auto = automaticLink(id, source ?? { id: draft.sourceId }, target ?? { id: targetId }), chosen = kind ?? auto.kind;
  const link: GraphLink = chosen === auto.kind ? auto : chosen === 'context' ? { ...auto, kind: 'context' } : { id, sourceId: draft.sourceId, targetId, kind: chosen, label: '' };
  const [browsing, setBrowsing] = useState<string>(), [area] = useState(() => ({ current: document.querySelector<HTMLDivElement>('.map-area') }));
  const chrome = useMapObstacles(area, innerWidth, innerHeight, false);
  const endpoints = useMapObstacles(area, innerWidth, innerHeight, false, [draft.sourceId, targetId].filter(Boolean).map(id => `[data-item-id="${CSS.escape(id)}"]`).join(','));
  useEffect(() => highlight(browsing ?? (targetId || undefined)), [browsing, targetId]);
  useEffect(() => () => highlight(undefined), []);
  let invalid = '';
  try { validateLink(state.nodes, state.links, link, resourceCardinality(state.resources, registry)); } catch (error) { invalid = (error as Error).message; }
  return <FloatingPanel as="form" className="connection-editor" label="Connect items" title="Connect items" closeLabel="Close connection" close={close} at={draft.screen}
    clear={area.current ? { endpoints, chrome, canvas: { width: area.current.clientWidth, height: area.current.clientHeight } } : undefined}
    returnTo={() => document.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(draft.sourceId)}"] .connect-handle`)} onSubmit={event => {
    event.preventDefault(); if (invalid || busy) return; setBusy(true); setError('');
    void save([{ type: 'link.save', link }]).then(close).catch(error => setError(error.message)).finally(() => setBusy(false));
  }}>
    <small>From {source?.title ?? 'Unavailable item'}</small>
    <PixelCombobox label="Connect to" caption="To" autoFocus disabled={busy} value={targetId} placeholder="Choose an item…" options={targets}
      icon={option => <NodeIcon state={state} registry={registry} nodeId={option.value} />} onActive={setBrowsing} change={value => { setTarget(value); setError(''); }} />
    <div className="act-combobox"><span className="act-combobox-caption" aria-hidden="true">Kind</span>
      <Segmented label="Kind" value={chosen} disabled={busy} change={value => { setKind(value); setError(''); }} options={[
        { value: 'context', label: 'Context', help: 'Context: the agent reads this item while it works.' },
        { value: 'reference', label: 'Reference', help: 'Reference: related background, not an instruction.' },
        { value: 'blocks', label: 'Blocks', help: `${target?.title ?? 'The chosen item'} waits until ${source?.title ?? 'this item'} is done` },
      ]} /></div>
    {(error || targetId && invalid) && <ErrorNotice message={error || invalid} />}
    <Button variant="primary" type="submit" disabled={busy || Boolean(invalid)} aria-busy={busy || undefined}>Connect</Button>
  </FloatingPanel>;
}
