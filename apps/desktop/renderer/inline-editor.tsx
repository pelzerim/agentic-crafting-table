import { defaultItemTitle, localItemTitle } from '../../../src/resource-plugins/generated-title.ts';
import { fieldDefaults } from '../../../src/resource-plugins/define.ts';
import { isOffMap } from '../../../src/graph/archive.ts';
import { creationConnections } from '../../../packages/core/resource-creation.ts';
import type { CreationConnection } from '../../../packages/core/resource-creation.ts';
import { automaticLink, validateLink } from '../../../src/graph/graph.ts';
import { resourceCardinality } from '../../../src/graph/resource-links.ts';
import { registryFromDescriptions } from '../../../src/resource-plugins/describe.client.ts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { WorkspaceCommand, WorkspaceState } from '../../../packages/core/control.ts';
import type { ResourceCreate } from '../../../packages/core/resource-creation.ts';
import type { PluginDescription } from '../../../src/resource-plugins/describe.client.ts';
import type { JsonObject, ResourceField, ResourceFields, SavedSessionOption } from '../../../src/resource-plugins/types.ts';
import { SessionPicker } from './session-picker.tsx';
import { useUrlCandidates } from './use-url-candidates.ts';
import { ItemIcon } from './icons.tsx';
import { FROM_URL, RUN_SKILL, itemChoices } from '../../../packages/core/item-picker.ts';
import { SkillPicker } from './skill-picker.tsx';
import { PixelCombobox } from './ui/combobox.tsx';
import { ItemPicker, PICKER_SIZE, WIDE_PICKER_SIZE } from './item-picker.tsx';
import type { MenuAction, MenuActionId } from '../../../packages/core/context-menu.ts';
import { useMovablePanel } from './use-movable-panel.ts';
import { useBubbleMotion } from './bubble-motion.ts';
import type { BubbleBounds } from './bubble-motion.ts';
import { DEFAULT_PROJECT_COLOR, PROJECT_COLORS, projectColor } from '../../../src/graph/project-colors.ts';
import { ColorPicker } from './ui/color-picker.tsx';
import { useRecentColors } from './recent-colors.ts';
import { PixelGlyph } from './ui/pixel-glyph.tsx';
import { DirectoryField, useDirectoryChoices } from './ui/directory-field.tsx';
import type { DirectoryChoices } from './ui/directory-field.tsx';
import { defaultDirectory } from '../../../packages/core/working-directories.ts';

type Editor = { mode: 'menu' | 'create' | 'edit'; initialType?: string; initialUrl?: string; connectedFromId?: string; nodeId?: string; projectId?: string; position: { x: number; y: number }; screen: { x: number; y: number } };
export function SelectField({ pluginId, name, field, values, change, searchable }: { pluginId?: string; name: string; field: ResourceField; values: JsonObject; change(key: string, value: string): void; searchable?: boolean }) {
  const [options, setOptions] = useState(field.options ?? []), [labels, setLabels] = useState<Record<string, string>>({}), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const latest = useRef({ values, change }); latest.current = { values, change };
  const dependency = field.dependsOn ? values[field.dependsOn] : undefined;
  useEffect(() => {
    if (!field.optionsSource || !pluginId) return;
    let cancelled = false; setLoading(true); setError('');
    void window.craftingTable.resourceOptions(pluginId, name, latest.current.values).then(result => {
      if (cancelled) return; setOptions(result.options); setLabels(result.labels ?? {});
      if (!result.options.includes(String(latest.current.values[name] ?? ''))) latest.current.change(name, result.default);
    }).catch(error => { if (!cancelled) { setError(error.message); setOptions([]); } }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [pluginId, name, field.optionsSource, dependency]);
  if (searchable) return <><PixelCombobox label={field.label} caption={field.label} disabled={loading} value={String(values[name] ?? '')} placeholder={loading ? 'Loading…' : 'Choose…'}
    options={options.map(option => ({ value: option, label: labels[option] ?? field.optionLabels?.[option] ?? option }))} change={value => change(name, value)} />{error && <small role="alert">{error}</small>}</>;
  return <><select aria-label={field.label} required={field.required} disabled={loading} value={String(values[name] ?? '')} onChange={event => change(name, event.target.value)}><option value="">{loading ? 'Loading…' : 'Choose…'}</option>{options.map(option => <option key={option} value={option}>{labels[option] ?? field.optionLabels?.[option] ?? option}</option>)}</select>{error && <small role="alert">{error}</small>}</>;
}
/** A colour field (a select that takes custom colours) is the shared colour picker, its options drawn in their menu swatches. */
function ColorField({ field, value, change }: { field: ResourceField; value: string | undefined; change(value: string): void }) {
  const { recent, remember } = useRecentColors();
  const presets = (field.options ?? []).map(option => ({ id: option, label: field.optionLabels?.[option] ?? option, color: field.menu?.swatches?.[option] ?? 'var(--act-control)' }));
  return <ColorPicker label={field.label} presets={presets} value={value ?? field.menu?.fallback} recent={recent} onRecent={remember} onChange={next => change('custom' in next ? next.custom : next.id)} />;
}
/** Native radios keep arrow keys and focus; the logos are the visible control. */
function BrandField({ name, field, value, change }: { name: string; field: ResourceField; value: string; change(value: string): void }) {
  return <div className="field-brands" role="radiogroup" aria-label={field.label}>{(field.options ?? []).map(option => {
    const label = field.optionLabels?.[option] ?? option;
    return <label key={option} title={label} data-selected={option === value || undefined}><input type="radio" name={name} aria-label={label} checked={option === value} onChange={() => change(option)} /><ItemIcon brand={field.optionBrands?.[option]} /></label>;
  })}</div>;
}
function Fields({ fields, values, change, pluginId, focusField, directories, projectDirectory, error }: { focusField?: string; fields: ResourceFields; values: JsonObject; change(key: string, value: string | number | boolean): void; pluginId?: string; directories: DirectoryChoices; projectDirectory?: string; error(message: string): void }) {
  return Object.entries(fields).filter(([, field]) => field.form !== false).map(([key, field]) => field.kind === 'select' && field.customColor
    ? <div key={key} className="field-color"><span aria-hidden="true">{field.label}</span><ColorField field={field} value={typeof values[key] === 'string' ? values[key] as string : undefined} change={value => change(key, value)} /></div>
    : field.optionBrands ? <div key={key} className="field-color"><span aria-hidden="true">{field.label}</span><BrandField name={key} field={field} value={String(values[key] ?? '')} change={value => change(key, value)} /></div>
    : <label key={key}>{field.label}
    {field.kind === 'directory' ? <DirectoryField label={field.label} required={field.required} value={String(values[key] ?? '')} change={value => change(key, value)} choices={directories} project={field.fromProject ? projectDirectory : undefined} error={error} />
      : field.kind === 'select' ? <SelectField pluginId={pluginId} name={key} field={field} values={values} change={change} />
      : field.multiline ? <textarea autoFocus={focusField === key} aria-label={field.label} required={field.required} value={String(values[key] ?? '')} onChange={event => change(key, event.target.value)} rows={Math.max(2, Math.min(16, field.rows ?? 3))} />
      : <input aria-label={field.label} type={field.kind === 'boolean' ? 'checkbox' : field.kind === 'number' ? 'number' : field.kind === 'url' ? 'url' : 'text'} required={field.required}
        min={field.min} max={field.max} step={field.integer ? 1 : 'any'} pattern={field.pattern} checked={field.kind === 'boolean' ? Boolean(values[key]) : undefined}
        value={field.kind === 'boolean' ? undefined : String(values[key] ?? '')} onChange={event => change(key, field.kind === 'boolean' ? event.target.checked : field.kind === 'number' ? Number(event.target.value) : event.target.value)} />}
    {field.description && <small>{field.description}</small>}
  </label>);
}

export function InlineEditor({ editor, state, plugins, quickIds, capabilities, save, close, writeInPlace, ground, act }: { editor: Editor; state: WorkspaceState; plugins: PluginDescription[]; quickIds: string[]; capabilities: string[]; save(commands: WorkspaceCommand[]): Promise<void>; close(): void;
  /** Paper types skip the form: the new tile opens on the map with the caret in it. */
  writeInPlace?(pluginId: string): void;
  /** A ring opened by right-clicking the ground also offers that ground's menu entries (MAP-31). */
  ground?: readonly MenuAction[]; act?(id: MenuActionId): void }) {
  const target = state.nodes.find(node => node.id === editor.nodeId), project = state.nodes.find(node => node.id === editor.projectId);
  const resource = state.resources.find(resource => resource.id === target?.resourceId);
  const textFirst = plugins.find(plugin => plugin.id === resource?.pluginId)?.generatedTitle;
  const editIdentity = resource ? JSON.stringify(textFirst ? [resource.pluginId, resource.schemaVersion, resource.data] : resource) : undefined;
  const originalResource = useRef(editIdentity);
  const [type, setType] = useState<string | undefined>(editor.mode === 'edit' ? resource?.pluginId ?? 'project' : editor.initialType);
  const [title, setTitle] = useState(editor.mode === 'edit' ? target?.title ?? '' : '');
  const [summary, setSummary] = useState(editor.mode === 'edit' ? target?.summary ?? '' : '');
  const [workingDirectory, setWorkingDirectory] = useState(editor.mode === 'edit' ? target?.workingDirectory ?? '' : '');
  const [color, setColor] = useState(editor.mode === 'edit' ? projectColor(target) : DEFAULT_PROJECT_COLOR);
  const [membership, setMembership] = useState(target?.projectId ?? '');
  const originalMembership = useRef(target?.projectId ?? '');
  const directories = useDirectoryChoices();
  const startDirectory = defaultDirectory({ project: project?.workingDirectory, global: directories.global, recent: directories.recent });
  const defaultsFor = (id?: string) => {
    const plugin = plugins.find(plugin => plugin.id === id);
    return fieldDefaults(plugin?.creation?.fields ?? plugin?.fields, { workingDirectory: startDirectory });
  };
  const [data, setData] = useState<JsonObject>(() => editor.mode === 'edit' ? resource?.data ?? {} : editor.initialType === FROM_URL && editor.initialUrl ? { url: editor.initialUrl } : defaultsFor(editor.initialType));
  useEffect(() => {
    if (!directories.loaded || editor.mode === 'edit') return;
    setData(old => ({ ...defaultsFor(type), ...old }));
  }, [directories.loaded]);
  const [ids] = useState(() => ({ nodeId: crypto.randomUUID(), resourceId: crypto.randomUUID(), linkId: crypto.randomUUID() }));
  const [resume, setResume] = useState<SavedSessionOption>();
  const [sessionMode, setSessionMode] = useState<'new' | 'continue'>('new');
  const pickerSize = ground ? WIDE_PICKER_SIZE : PICKER_SIZE, pickerPosition = { x: editor.screen.x - pickerSize.width / 2, y: editor.screen.y - pickerSize.height / 2 };
  const formPosition = { x: editor.screen.x - 150, y: editor.screen.y - 24 };
  const { panel, position, dragging, handle, moveTo } = useMovablePanel(type ? formPosition : pickerPosition, type === RUN_SKILL);
  const seed = useRef<BubbleBounds>(undefined);
  const [growFrom, setGrowFrom] = useState<BubbleBounds>();
  useLayoutEffect(() => {
    const from = seed.current, element = panel.current;
    if (!type || !from || !element) return;
    const parent = (element.offsetParent as HTMLElement).getBoundingClientRect();
    // Measure the chosen form before centering/clamping. Both commits happen
    // before paint, so the ring's empty seed becomes the form without a jump.
    moveTo({ x: from.x + from.width / 2 - parent.x - element.offsetWidth / 2, y: from.y + from.height / 2 - parent.y - element.offsetHeight / 2 });
    setGrowFrom(from); seed.current = undefined;
  }, [type]);
  useBubbleMotion(panel, growFrom, () => setGrowFrom(undefined));
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const submitted = useRef<ResourceCreate>(undefined);
  const fromUrl = type === FROM_URL && editor.mode !== 'edit';
  const detection = useUrlCandidates(String(data.url ?? ''), fromUrl);
  const [chosenUrlType, setChosenUrlType] = useState('');
  const detectedId = detection.candidates.length === 1 ? detection.candidates[0].pluginId : detection.candidates.find(candidate => candidate.pluginId === chosenUrlType)?.pluginId;
  const plugin = plugins.find(plugin => plugin.id === (fromUrl ? detectedId : type));
  const skillPlugin = plugins.find(plugin => plugin.id === 'agent.session');
  const providerTitle = plugin?.creation?.action === 'resource.attach' || plugin?.creation?.mode === 'url' || plugin?.creation?.group === 'url';
  const editLabel = !resource ? 'Project settings' : plugin?.generatedTitle ? `Edit ${plugin.name.toLowerCase()}` : 'Item settings';
  const awaitingUrl = fromUrl && (!plugin || detection.loading || Boolean(detection.error));
  const labelVariant = plugin?.creation?.labelByField;
  const createLabel = type === 'project' ? 'Create project' : labelVariant?.labels[String(data[labelVariant.field] ?? '')] ?? plugin?.creation?.label ?? 'Add item';
  const locked = Boolean(submitted.current) && plugin?.creation?.action !== 'resource.attach';
  const continuing = plugin?.creation?.resume && editor.mode !== 'edit' && sessionMode === 'continue';
  const unavailable = editor.mode === 'edit' ? '' : plugin?.creation?.requires === 'runtime' && !capabilities.includes(plugin.creation.action ?? '') ? 'The native runtime is unavailable. Reconnect and try again.'
    : plugin?.creation?.action === 'resource.attach' && !capabilities.includes(`resource.attach:${plugin.id}`) ? 'This provider is not connected yet.' : '';
  const select = (id: string) => {
    if (writeInPlace && editor.mode !== 'edit' && plugins.find(plugin => plugin.id === id)?.appearance?.paper) { writeInPlace(id); return; }
    submitted.current = undefined;
    seed.current = panel.current?.querySelector('.picker-center')?.getBoundingClientRect();
    setType(id); setChosenUrlType(''); setError(''); setResume(undefined); setSessionMode('new');
    setData(defaultsFor(id));
  };
  const backToChoices = () => { submitted.current = undefined; setGrowFrom(undefined); setType(undefined); moveTo(pickerPosition); };
  useEffect(() => {
    if (!type || type === RUN_SKILL || editor.mode === 'edit') return;
    const back = (event: MouseEvent | KeyboardEvent) => {
      if (event.type === 'keydown' && ((event as KeyboardEvent).key !== 'Escape' || (event.target as Element | null)?.closest?.('.act-combobox[data-open]'))) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (pending || locked) close(); else backToChoices();
    };
    window.addEventListener('contextmenu', back, true); window.addEventListener('keydown', back, true);
    return () => { window.removeEventListener('contextmenu', back, true); window.removeEventListener('keydown', back, true); };
  }, [type, pending, locked]);
  const source = state.nodes.find(node => node.id === editor.connectedFromId);
  const existingResume = resume && state.nodes.find(node => state.resources.some(resource => resource.id === node.resourceId && resource.data.nativeSessionId === resume.id));
  const fallbackTitle = defaultItemTitle(plugin, data);
  const newNode = existingResume ?? { id: ids.nodeId, resourceId: type === 'project' ? undefined : ids.resourceId, title: title || plugin?.name || 'Project', acceptsContext: plugin?.acceptsContext, position: editor.position };
  const link = editor.connectedFromId ? automaticLink(ids.linkId, source ?? { id: editor.connectedFromId }, newNode) : undefined;
  const connection: CreationConnection | undefined = link ? { id: link.id, otherId: editor.connectedFromId!, kind: link.kind, sourceIsNew: link.sourceId === newNode.id } : undefined;
  let linkError = '';
  if (connection && type && !awaitingUrl) {
    try {
      const command = creationConnections(connection, newNode.id)[0];
      if (command.type === 'link.save') validateLink(existingResume ? state.nodes : [...state.nodes, newNode], state.links, command.link, resourceCardinality(
        [...state.resources, { id: ids.resourceId, pluginId: plugin?.id ?? type, schemaVersion: plugin?.schemaVersion ?? 1, title: newNode.title, data: {} }], registryFromDescriptions(plugins)));
    } catch (error) { linkError = (error as Error).message; }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!type || awaitingUrl || linkError || (continuing && !resume)) return; setPending(true); setError('');
    try {
      const name = localItemTitle(plugin, data) ?? (title.trim() || (plugin?.creation?.action === 'resource.attach' ? plugin.name : defaultItemTitle(plugin, data) ?? ''));
      if (editor.mode === 'edit') {
        if (!target) throw new Error('Item is no longer available');
        if (!providerTitle && editIdentity !== originalResource.current) throw new Error('Item changed elsewhere. Your draft is kept here; close and reopen this form to edit the latest version.');
        if (resource && membership !== originalMembership.current && (target.projectId ?? '') !== originalMembership.current) throw new Error('Project membership changed elsewhere. Reopen settings to move this item.');
        const commands: WorkspaceCommand[] = providerTitle ? [] : resource && plugin?.generatedTitle ? [{ type: 'item.update', id: target.id, data }]
          : [{ type: 'node.update', id: target.id, title: name, ...(!resource ? { summary, workingDirectory, color } : {}) }, ...(resource && plugin?.creation?.requires !== 'runtime' ? [{ type: 'item.update' as const, id: target.id, data }] : [])];
        if (resource && membership !== originalMembership.current) commands.push({ type: 'node.attach', id: target.id, projectId: membership || null });
        if (commands.length) await save(commands);
      } else if (plugin?.creation?.action) {
        submitted.current ??= { requestId: crypto.randomUUID(), nodeId: ids.nodeId, resourceId: ids.resourceId, connection, pluginId: plugin.id, expectedRevision: state.revision, title: resume?.title ?? name, data: resume ? { provider: data.provider ?? 'claude', resumeNativeSessionId: resume.id } : fromUrl ? { url: String(data.url).trim() } : data, projectId: editor.projectId, position: editor.position };
        await window.craftingTable.resourceCreate(submitted.current);
      } else {
        const id = ids.nodeId;
        const commands: WorkspaceCommand[] = type === 'project' ? [{ type: 'project.create', id, title: name, summary, workingDirectory, color, position: editor.position }]
          : [{ type: 'item.add', id, resourceId: ids.resourceId, pluginId: type, title: name, data, projectId: editor.projectId, position: editor.position }];
        await save([...commands, ...creationConnections(connection, id)]);
      }
      close();
    } catch (error) {
      const failure = error as Error & { code?: string };
      if (['REVISION_CONFLICT', 'INVALID_REQUEST', 'ENOENT', 'EACCES', 'LAUNCH_FAILED'].includes(failure.code ?? '')) submitted.current = undefined;
      setError(failure.message + (submitted.current ? plugin?.creation?.action === 'resource.attach' ? ' Retry checks the same attachment.' : ' Retry checks the same launch.' : ''));
    } finally { setPending(false); }
  };
  const fields = editor.mode === 'edit' ? plugin?.creation?.requires === 'runtime' || providerTitle ? {} : plugin?.fields : plugin?.creation?.fields ?? plugin?.fields;
  const variantKeys = new Set(Object.values(fields ?? {}).flatMap(field => field.dependsOn ? [field.dependsOn] : []));
  const changeField = (key: string, value: string | number | boolean) => {
    if (plugin?.creation?.action === 'resource.attach') submitted.current = undefined;
    setData(old => ({ ...old, ...Object.fromEntries(Object.entries(fields ?? {}).filter(([, field]) => field.dependsOn === key).map(([name]) => [name, ''])), [key]: value }));
    if (variantKeys.has(key)) setResume(undefined);
  };
  if (type === RUN_SKILL && editor.projectId && skillPlugin) return <SkillPicker projectId={editor.projectId} state={state} plugin={skillPlugin} screen={formPosition} position={editor.position} connectedFromId={editor.connectedFromId} growFrom={seed.current} back={backToChoices} close={close} />;
  return <>{!type && <div className="picker-backdrop" aria-hidden="true" />}<form ref={panel} className={`inline-editor item-creation ${!type ? 'radial-picker' : ''}`} aria-label={editor.mode === 'edit' ? editLabel : 'New item'} data-project-id={editor.projectId ?? ''} data-world-x={editor.position.x} data-world-y={editor.position.y} data-dragging={dragging}
    style={{ left: position.x, top: position.y, transformOrigin: 'top left', ...(!type && ground ? { width: pickerSize.width } : {}) }} onSubmit={submit}>
    {type && <><div className="editor-heading" {...handle}><strong>{editor.mode === 'edit' ? editLabel : fromUrl ? 'From URL' : type ? plugin?.name ?? 'Project' : 'New item'}</strong>{editor.mode === 'edit' && <button type="button" aria-label="Close item form" onClick={close}><PixelGlyph name="close" /></button>}</div>
    <small className="placement-note">{type === 'project' ? 'New project' : project?.title ?? 'Floating · no project'}</small></>}
    {linkError && <p role="alert">{linkError}</p>}
    {!type ? <ItemPicker choices={itemChoices(plugins, editor.projectId, !!skillPlugin && capabilities.includes('agent.create'))} quickIds={quickIds} panel={panel} select={select} close={close} ground={ground} act={act} /> : <>
      <fieldset disabled={pending || locked}>
        {editor.mode === 'edit' && resource && <label>Project<select aria-label="Project membership" value={membership} onChange={event => setMembership(event.target.value)}><option value="">Floating · no project</option>{state.nodes.filter(node => !node.resourceId && !node.projectId && !isOffMap(node, state.nodes)).map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>}
        {editor.mode === 'edit' && providerTitle && <label>Name<input aria-label="Title" readOnly value={target?.title ?? ''} /><small>Title comes from the linked item.</small></label>}
        {editor.mode === 'edit' && plugin?.activation?.kind === 'browser' && capabilities.includes(`resource.attach:${plugin.id}`) && <button type="button" onClick={async () => {
          setPending(true); setError(''); try { await window.craftingTable.runtimeRun({ action: 'resource.read', nodeId: target!.id, arguments: { refresh: true } }); }
          catch (error) { setError((error as Error).message); } finally { setPending(false); }
        }}>Refresh title</button>}
        {(fromUrl || plugin?.creation?.mode === 'url') && editor.mode !== 'edit' ? <><label>URL<input autoFocus required type="url" aria-label="Item URL" maxLength={8192} value={String(data.url ?? '')} onChange={event => { submitted.current = undefined; setChosenUrlType(''); setError(''); setData({ url: event.target.value }); }} placeholder={fromUrl ? 'https://…' : plugin?.creation?.urlPlaceholder} /></label>
          {fromUrl && <div className="url-detection" role="status">
            {detection.loading ? 'Detecting item…' : detection.error ? <span role="alert">{detection.error}</span> : detection.candidates.length > 1 ? <label>Item type<select aria-label="Detected item type" value={chosenUrlType} onChange={event => { submitted.current = undefined; setChosenUrlType(event.target.value); }}><option value="">Choose a matching type…</option>{detection.candidates.map(candidate => <option key={candidate.pluginId} value={candidate.pluginId}>{plugins.find(plugin => plugin.id === candidate.pluginId)?.name ?? candidate.pluginId}</option>)}</select></label>
              : plugin ? <span className="detected-item"><ItemIcon icon={plugin.icon} brand={plugin.brand} tint={plugin.appearance?.brandTint} />{plugin.name}</span> : String(data.url ?? '').trim() ? detection.valid ? 'No installed item type supports this URL.' : 'Enter a valid http or https URL.' : 'Paste a link to detect its item type.'}
          </div>}
          <small>Title comes from the linked item.</small>{unavailable && <p role="alert">{unavailable}</p>}</> : <>
          {unavailable ? <p>{unavailable}</p> : <>
            {editor.mode !== 'edit' && <Fields pluginId={plugin?.id} fields={Object.fromEntries(Object.entries(fields ?? {}).filter(([key]) => variantKeys.has(key)))} values={data} change={changeField} directories={directories} projectDirectory={project?.workingDirectory} error={setError} />}
            {plugin?.creation?.resume && editor.mode !== 'edit' && <SessionPicker provider={String(data.provider ?? 'claude')}  pluginId={plugin.id} mode={sessionMode} changeMode={mode => { setSessionMode(mode); setResume(undefined); }} selected={resume} choose={setResume} />}
            {!continuing && <>{!plugin?.generatedTitle && !(editor.mode === 'edit' && providerTitle) && (editor.mode === 'edit' || plugin?.creation?.action !== 'resource.attach') && <label>{fallbackTitle ? 'Name (optional)' : 'Name'}<input aria-label="Title" autoFocus required={!fallbackTitle} maxLength={500} placeholder={fallbackTitle ?? ''} value={title} onChange={event => setTitle(event.target.value)} /></label>}
              {type === 'project' ? <><label>Project summary<textarea aria-label="Project summary" rows={2} maxLength={4000} placeholder="What are we building?" value={summary} onChange={event => setSummary(event.target.value)} /></label><ProjectColorPicker value={color} change={setColor} /><Fields fields={{ workingDirectory: { kind: 'directory', label: 'Project working directory', description: 'Optional default for new agents, terminals and other items with a working directory.' } }} values={{ workingDirectory }} change={(_key, value) => setWorkingDirectory(String(value))} directories={directories} error={setError} /></>
                : <Fields focusField={plugin?.generatedTitle?.field} pluginId={plugin?.id} fields={Object.fromEntries(Object.entries(fields ?? {}).filter(([key, field]) => !variantKeys.has(key) && !(field.kind === 'select' && field.options?.length === 1)))} values={data} change={changeField} directories={directories} projectDirectory={project?.workingDirectory} error={setError} />}</>}
          </>}
        </>}
      </fieldset>
      {plugin?.generatedTitle && <small>A short title is generated with Claude Haiku.</small>}
      <div className="editor-actions">{editor.mode !== 'edit' && <button type="button" disabled={pending || locked} onClick={backToChoices}>Back</button>}{!unavailable && <button type="submit" className="primary" disabled={pending || awaitingUrl || Boolean(linkError) || Boolean(continuing && !resume)}>{pending ? 'Saving…' : submitted.current ? plugin?.creation?.action === 'resource.attach' ? 'Retry attachment' : 'Retry same launch' : editor.mode === 'edit' ? 'Save changes' : continuing ? 'Resume session' : awaitingUrl ? 'Attach item' : createLabel}</button>}</div>
    </>}
    {error && <p role="alert">{error}</p>}
  </form></>;
}


function ProjectColorPicker({ value, change }: { value: string; change(color: string): void }) {
  const preset = PROJECT_COLORS.find(option => option.color === value), { recent, remember } = useRecentColors();
  return <fieldset className="project-color-picker"><legend>Neighborhood color <small>{preset?.label ?? value}</small></legend>
    <ColorPicker label="Neighborhood color" presets={PROJECT_COLORS} value={value} recent={recent} onRecent={remember}
      onChange={next => change('custom' in next ? next.custom : PROJECT_COLORS.find(option => option.id === next.id)!.color)} />
  </fieldset>;
}
