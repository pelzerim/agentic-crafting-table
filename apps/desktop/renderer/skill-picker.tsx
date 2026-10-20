import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WorkspaceState } from '../../../packages/core/control.ts';
import type { ProjectSkillCatalog, SkillRun } from '../../../packages/core/skills.ts';
import type { PluginDescription } from '../../../src/resource-plugins/describe.client.ts';
import { isOffMap } from '../../../src/graph/archive.ts';
import { useMovablePanel } from './use-movable-panel.ts';
import { ErrorNotice } from './ui/notice.tsx';
import { SelectField } from './inline-editor.tsx';
import { automaticLink } from '../../../src/graph/graph.ts';
import { useBubbleMotion } from './bubble-motion.ts';
import type { BubbleBounds } from './bubble-motion.ts';
import { PixelGlyph } from './ui/pixel-glyph.tsx';
import { DirectoryField, useDirectoryChoices } from './ui/directory-field.tsx';
import { defaultDirectory } from '../../../packages/core/working-directories.ts';

export function SkillPicker({ projectId, screen, position: worldPosition, state, plugin, connectedFromId, growFrom, back, close }: { projectId: string; screen: { x: number; y: number }; position: { x: number; y: number }; state: WorkspaceState; plugin: PluginDescription; connectedFromId?: string; growFrom?: BubbleBounds; back?(): void; close(): void }) {
  const project = state.nodes.find(node => node.id === projectId), fields = plugin.creation!.fields!;
  const [provider, setProvider] = useState(String(fields.provider.default ?? '')), [model, setModel] = useState(String(fields.model.default ?? ''));
  const directories = useDirectoryChoices();
  const [cwd, setCwd] = useState(project?.workingDirectory ?? ''), [catalog, setCatalog] = useState<ProjectSkillCatalog>();
  useEffect(() => { if (directories.loaded) setCwd(old => old || defaultDirectory({ project: project?.workingDirectory, global: directories.global, recent: directories.recent })); }, [directories.loaded]);
  const [skillId, setSkill] = useState(''), [argumentsText, setArguments] = useState(''), [search, setSearch] = useState(''), [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [loadError, setLoadError] = useState(''), [error, setError] = useState('');
  const submitted = useRef<SkillRun>(undefined), [uncertain, setUncertain] = useState(false);
  const { panel, position, dragging, handle, moveTo } = useMovablePanel(screen);
  const [origin, setOrigin] = useState<BubbleBounds>();
  useEffect(() => { panel.current?.querySelector<HTMLInputElement>('[role=combobox]')?.focus({ preventScroll: true }); }, []);
  useLayoutEffect(() => {
    if (!growFrom || !panel.current) return;
    const parent = (panel.current.offsetParent as HTMLElement).getBoundingClientRect();
    moveTo({ x: growFrom.x + growFrom.width / 2 - parent.x - panel.current.offsetWidth / 2, y: growFrom.y + growFrom.height / 2 - parent.y - panel.current.offsetHeight / 2 });
    setOrigin(growFrom);
  }, [growFrom]);
  useBubbleMotion(panel, origin, () => setOrigin(undefined));
  const unavailable = !project || isOffMap(project, state.nodes);
  useEffect(() => {
    let cancelled = false; setCatalog(undefined); setSkill(''); setLoadError('');
    if (!cwd.trim() || unavailable) { setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      void window.craftingTable.projectSkills({ projectId, provider, cwd }).then(result => { if (!cancelled) setCatalog(result); })
        .catch(error => { if (!cancelled) setLoadError(error.message); }).finally(() => { if (!cancelled) setLoading(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [projectId, provider, cwd, refresh, unavailable]);
  const selected = catalog?.skills.find(skill => skill.id === skillId), locked = busy || uncertain;
  useEffect(() => {
    if (!back) return;
    const dismiss = (event: MouseEvent | KeyboardEvent) => {
      if (event.type === 'keydown' && ((event as KeyboardEvent).key !== 'Escape' || (event.target as Element | null)?.closest?.('.act-combobox[data-open]'))) return;
      event.preventDefault(); event.stopImmediatePropagation(); if (locked) close(); else back();
    };
    window.addEventListener('contextmenu', dismiss, true); window.addEventListener('keydown', dismiss, true);
    return () => { window.removeEventListener('contextmenu', dismiss, true); window.removeEventListener('keydown', dismiss, true); };
  }, [back, close, locked]);
  const run = async () => {
    if (busy || unavailable || !uncertain && (!selected || selected.unavailable || !model)) return;
    setBusy(true); setError('');
    try {
      if (!submitted.current) {
        const latest = await window.craftingTable.workspaceRead();
        const nodeId = crypto.randomUUID(), source = latest.state.nodes.find(node => node.id === connectedFromId);
        if (connectedFromId && !source) throw new Error('The connected item is no longer available.');
        const link = source && automaticLink(crypto.randomUUID(), source, { id: nodeId, acceptsContext: plugin.acceptsContext });
        submitted.current = { requestId: crypto.randomUUID(), nodeId, resourceId: crypto.randomUUID(), expectedRevision: latest.state.revision,
          ...(link ? { connection: { id: link.id, otherId: connectedFromId!, kind: link.kind, sourceIsNew: link.sourceId === nodeId } } : {}),
          provider, model, cwd: catalog!.cwd, skillId, arguments: argumentsText, position: worldPosition };
      }
      await window.craftingTable.runtimeRun({ action: 'skill.run', nodeId: projectId, arguments: submitted.current }); close();
    } catch (error) {
      const failure = error as { code?: string; message: string };
      const pending = ['LAUNCH_UNCERTAIN', 'TIMEOUT', 'CONNECTION_LOST'].includes(failure.code ?? '');
      setUncertain(pending); if (!pending) submitted.current = undefined;
      setError(failure.message);
    } finally { setBusy(false); }
  };
  return <form ref={panel} className="inline-editor skill-picker" aria-label="Run project skill" style={{ left: position.x, top: position.y, transformOrigin: 'top left' }} data-dragging={dragging} onSubmit={event => { event.preventDefault(); void run(); }}>
    <div className="editor-heading" {...handle}><strong>Run skill</strong>{!back && <button type="button" aria-label="Close skills" onClick={close}><PixelGlyph name="close" /></button>}</div>
    <small>{project?.title ?? 'Project unavailable'}</small>
    <fieldset disabled={locked || unavailable}>
      <SelectField searchable pluginId={plugin.id} name="provider" field={fields.provider} values={{ provider }} change={(_, value) => { setProvider(value); setModel(''); }} />
      <SelectField searchable pluginId={plugin.id} name="model" field={fields.model} values={{ provider, model }} change={(_, value) => setModel(value)} />
      <label>Working directory<DirectoryField label="Skill working directory" required value={cwd} change={setCwd} project={project?.workingDirectory} choices={directories} error={setError} /></label>
      <div className="saved-sessions-heading"><span>Installed skills</span><button type="button" aria-label="Refresh skills" onClick={() => setRefresh(value => value + 1)}><PixelGlyph name="refresh" /></button></div>
      <input type="search" aria-label="Find a skill" placeholder="Find a skill…" value={search} onChange={event => setSearch(event.target.value)} />
      <div className="saved-session-list skill-list" role="listbox" aria-label="Installed skills" aria-busy={loading}>
        {catalog?.skills.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(search.toLowerCase())).map(skill => <button type="button" role="option" key={skill.id} aria-selected={skillId === skill.id} disabled={Boolean(skill.unavailable)} title={skill.unavailable || skill.source || skill.description} onClick={() => setSkill(skill.id)}><strong>{skill.name}</strong><small>{skill.unavailable || skill.description}</small></button>)}
        {loading && <small>Finding skills…</small>}
        {catalog && !catalog.skills.length && <small>No installed skills in this folder.</small>}
      </div>
      {selected && <label>Arguments <small>Optional{selected.argumentHint ? ` · ${selected.argumentHint}` : ''}</small><textarea aria-label="Skill arguments" rows={2} value={argumentsText} onChange={event => setArguments(event.target.value)} /></label>}
    </fieldset>
    {catalog?.warnings.map(warning => <small role="status" key={warning}>{warning}</small>)}
    {(loadError || error || unavailable) && <ErrorNotice message={unavailable ? 'This project is no longer available.' : error || loadError} />}
    <div className="editor-actions">{back && <button type="button" disabled={locked} onClick={back}>Back</button>}<button type="submit" disabled={busy || unavailable || !uncertain && (!selected || Boolean(selected.unavailable) || !model || loading)}>{busy ? 'Starting…' : uncertain ? 'Reconnect to this run' : 'Run skill'}</button></div>
  </form>;
}
