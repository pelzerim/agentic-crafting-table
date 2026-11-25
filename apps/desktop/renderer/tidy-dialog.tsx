import { useEffect, useMemo, useRef, useState } from 'react';
import { finishedItems, planTidy, tidyFingerprint } from '../../../packages/core/tidy.ts';
import type { TidyRegroup } from '../../../packages/core/tidy.ts';
import type { ItemMapSizes } from '../../../packages/core/item-map-sizes.ts';
import type { ResourcePluginRegistry } from '../../../src/resource-plugins/registry.ts';
import { FloatingPanel } from './ui/floating-panel.tsx';
import { Button } from './ui/button.tsx';
import type { HistorySeen } from './map-history.ts';

export type TidyChoices = { lineUp: boolean; spacePlots: boolean; colors: boolean; archive: boolean; rename: boolean; regroup: boolean };
export const TIDY_DEFAULTS: TidyChoices = { lineUp: true, spacePlots: true, colors: true, archive: false, rename: false, regroup: false };
interface RenameRow { kind: 'item' | 'plot' | 'project'; id: string; from: string; to: string; ticked: boolean }
interface RegroupRow extends TidyRegroup { title: string; plotName: string }
export interface TidyApply { fingerprint: string; projectId?: string; options: TidyChoices; archives: string[]; renames: { kind: RenameRow['kind']; id: string; to: string }[]; regroup: TidyRegroup[] }
const CHOICES: { key: keyof TidyChoices; label: string; detail?: string; ai?: true }[] = [
  { key: 'lineUp', label: 'Line up items inside each plot' },
  { key: 'spacePlots', label: 'Space out the plots' },
  { key: 'colors', label: 'Give plots their own colours' },
  { key: 'archive', label: 'Archive finished work', detail: 'Done more than 3 days ago. Never working items, Needs me items or locked plots.' },
  { key: 'rename', label: 'Rename from context', detail: 'Suggests names for agent sessions, plots and projects. Names you chose stay.', ai: true },
  { key: 'regroup', label: 'Regroup by context', detail: 'Suggests moving items between plots of the same project.', ai: true },
];

/** Tidy (MAP-35): choices, a live preview as ghosts on the map plus a ticked list, then one Apply. */
export function TidyDialog({ seen: live, registry, sizes, projectId, title, ai, at, onGhosts, apply, close }: {
  seen: HistorySeen; registry: ResourcePluginRegistry; sizes?: ItemMapSizes; projectId?: string; title: string; ai: boolean; at: { x: number; y: number };
  onGhosts(ghosts: { id: string; position: { x: number; y: number } }[] | undefined): void; apply(request: TidyApply): Promise<void>; close(): void;
}) {
  // The preview holds the map it was made from; Apply sends its fingerprint, so a relevant change is refused, never half applied.
  const [seen, setSeen] = useState(live), latest = useRef(live);
  latest.current = live;
  const [choices, setChoices] = useState(TIDY_DEFAULTS), [off, setOff] = useState<ReadonlySet<string>>(new Set()), [on, setOn] = useState<ReadonlySet<string>>(new Set());
  const [suggested, setSuggested] = useState<{ renames: RenameRow[]; regroup: RegroupRow[]; limited?: boolean }>({ renames: [], regroup: [] }), [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState(''), [applying, setApplying] = useState(false);
  const plots = useMemo(() => (seen.plots?.list ?? []).filter(plot => projectId === undefined || plot.projectId === projectId), [seen.plots, projectId]);
  const now = useMemo(() => Date.now(), [seen]);
  const finished = useMemo(() => choices.archive ? finishedItems(seen.state.nodes, plots, now, projectId) : [], [choices.archive, seen.state.nodes, plots, now, projectId]);
  // Rows start ticked unless the row says otherwise; `off` and `on` hold what the person changed.
  const ticked = (key: string, initial = true) => initial ? !off.has(key) : on.has(key);
  const toggle = (key: string, initial: boolean, value: boolean) => {
    const edit = (set: ReadonlySet<string>, add: boolean) => { const next = new Set(set); if (add) next.add(key); else next.delete(key); return next; };
    if (initial) setOff(old => edit(old, !value)); else setOn(old => edit(old, value));
  };
  const archives = finished.filter(id => ticked(`a:${id}`));
  const renames = choices.rename ? suggested.renames.filter(row => ticked(`r:${row.kind}:${row.id}`, row.ticked)) : [];
  const regroup = choices.regroup ? suggested.regroup.filter(row => ticked(`g:${row.itemId}`)) : [];
  const [plan, fingerprint] = useMemo(() => {
    const input = { state: seen.state, registry, sizes, plots, projectId, now, regroup, archived: archives }, planned = planTidy(input, choices);
    return [planned, tidyFingerprint(input, planned)] as const;
  }, [seen.state, registry, sizes, plots, projectId, now, JSON.stringify(regroup), archives.join(), choices]);
  useEffect(() => { onGhosts(plan.moves.map(move => ({ id: move.id, position: move.to }))); }, [plan]);
  useEffect(() => () => onGhosts(undefined), []);
  useEffect(() => {
    if (!ai || (!choices.rename && !choices.regroup)) return;
    let live = true; setAsking(true); setProblem('');
    void window.craftingTable.runtimeRun({ action: 'map.tidy', nodeId: projectId ?? 'board', arguments: { operation: 'suggest', ...projectId ? { projectId } : {}, options: choices } })
      .then(result => { if (live) setSuggested(result as typeof suggested); }, error => { if (live) setProblem((error as Error).message); })
      .finally(() => { if (live) setAsking(false); });
    return () => { live = false; };
  }, [choices.rename, choices.regroup]);
  const titleOf = (id: string) => seen.state.nodes.find(node => node.id === id)?.title ?? 'Item';
  const changes = plan.moves.length + plan.colors.length + archives.length + renames.length + regroup.length;
  const submit = async () => {
    setApplying(true); setProblem('');
    try {
      await apply({ fingerprint, ...projectId ? { projectId } : {}, options: choices, archives, renames: renames.map(({ kind, id, to }) => ({ kind, id, to })), regroup: regroup.map(({ itemId, plotId, newPlot }) => ({ itemId, ...plotId ? { plotId } : { newPlot } })) });
      close();
    } catch (error) { setProblem((error as Error).message); setSeen(latest.current); }
    finally { setApplying(false); }
  };
  const row = (key: string, initial: boolean, label: string) => <li key={key}><label><input type="checkbox" checked={ticked(key, initial)} onChange={event => toggle(key, initial, event.target.checked)} /><span>{label}</span></label></li>;
  return <FloatingPanel as="form" role="dialog" className="tidy-dialog" label="Tidy" title={`Tidy ${title}`} closeLabel="Cancel tidy" close={close} at={at}
    onSubmit={event => { event.preventDefault(); if (changes && !applying) void submit(); }}>
    <fieldset className="tidy-choices"><legend>What to tidy</legend>
      {CHOICES.map(choice => <label key={choice.key} className="tidy-choice" data-disabled={choice.ai && !ai || undefined}>
        <input type="checkbox" checked={choices[choice.key]} disabled={choice.ai && !ai} onChange={event => setChoices(old => ({ ...old, [choice.key]: event.target.checked }))} />
        <span><b>{choice.label}</b>{(choice.ai && !ai ? 'Turn on AI features in Settings to use this.' : choice.detail) && <small>{choice.ai && !ai ? 'Turn on AI features in Settings to use this.' : choice.detail}</small>}</span>
      </label>)}
    </fieldset>
    <section className="tidy-preview" aria-label="Preview" aria-live="polite">
      <p className="tidy-summary">{changes ? [plan.moves.length && `${plan.moves.length} ${plan.moves.length === 1 ? 'item moves' : 'items move'}`, plan.colors.length && `${plan.colors.length} ${plan.colors.length === 1 ? 'plot colour changes' : 'plot colours change'}`].filter(Boolean).join(' · ') || 'Changes below' : asking ? 'Asking for suggestions…' : 'Already tidy. Nothing to change.'}</p>
      {choices.rename && suggested.renames.length > 0 && <><h3>Renames</h3><ul>{suggested.renames.map(entry => row(`r:${entry.kind}:${entry.id}`, entry.ticked, `${entry.from} → ${entry.to}`))}</ul></>}
      {suggested.regroup.length > 0 && choices.regroup && <><h3>Regroup</h3><ul>{suggested.regroup.map(entry => row(`g:${entry.itemId}`, true, `${entry.title} → ${entry.plotName}`))}</ul></>}
      {finished.length > 0 && <><h3>Archive</h3><ul>{finished.map(id => row(`a:${id}`, true, titleOf(id)))}</ul></>}
      {asking && changes > 0 && <p className="tidy-asking">Asking for suggestions…</p>}
      {!asking && suggested.limited && <p className="tidy-asking">Some suggestions were skipped to save the AI allowance.</p>}
    </section>
    {problem && <p className="tidy-problem" role="alert">{problem}</p>}
    <div className="tidy-actions">
      <Button onClick={close}>Cancel</Button>
      <Button type="submit" variant="primary" disabled={!changes || applying}>Apply</Button>
    </div>
  </FloatingPanel>;
}
