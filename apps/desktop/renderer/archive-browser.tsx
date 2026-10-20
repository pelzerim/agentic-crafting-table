import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { WorkspaceState, WorkspaceCommand } from '../../../packages/core/control.ts';
import { isArchived } from '../../../src/graph/archive.ts';
import { useMovablePanel } from './use-movable-panel.ts';
import { RecordingStorage } from './recording-storage.tsx';
import { EmptyState, InlineConfirm, ListItem, Segmented, SettingsList } from './settings-ui.tsx';
import { SessionManager } from './session-manager.tsx';
import { ItemIcon } from './icons.tsx';
import { PixelGlyph } from './ui/pixel-glyph.tsx';

type ArchivedNode = WorkspaceState['nodes'][number];
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Restore is the row's action; permanent deletion waits in its ⋯ menu behind an inline confirm. */
function RowMenu({ title, open, toggle, remove, disabled }: { title: string; open: boolean; toggle(): void; remove(): void; disabled: boolean }) {
  return <span className="archive-row-menu">
    <button type="button" className="archive-more" aria-label={`More actions for ${title}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={toggle}><PixelGlyph name="more" /></button>
    {open && <span className="archive-menu" role="menu" aria-label={`Actions for ${title}`} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); toggle(); } }}>
      <button type="button" role="menuitem" autoFocus aria-label={`Delete ${title}`} onClick={remove}>Delete…</button>
    </span>}
  </span>;
}

type Tab = 'items' | 'todos' | 'sessions' | 'recordings';

/** The one home for archived things: items and projects, to-dos, sessions and their recordings. */
export function ArchiveBrowser({ state, save, close }: { state: WorkspaceState; save(commands: WorkspaceCommand[]): Promise<void>; close(): void }) {
  const [tab, setTab] = useState<Tab>('items'), [counts, setCounts] = useState<{ sessions?: number; recordings?: number }>({});
  useEffect(() => {
    let cancelled = false;
    void Promise.all([window.craftingTable.sessionsList('archived'), window.craftingTable.recordingsList()]).then(([sessions, page]) => {
      if (!cancelled) setCounts({ sessions: sessions.length, ...(page.nextBefore ? {} : { recordings: page.recordings.filter(entry => entry.archivedAt || entry.removedAt).length }) });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [tab]);
  const [query, setQuery] = useState(''), [pending, setPending] = useState(false), [error, setError] = useState('');
  const [confirm, setConfirm] = useState(''), [menu, setMenu] = useState('');
  const { panel, position, dragging, handle } = useMovablePanel({ x: 40, y: 60 });
  const project = (node: ArchivedNode) => state.nodes.find(parent => parent.id === node.projectId);
  const matches = (text: string) => text.toLowerCase().includes(query.toLowerCase());
  const archived = state.nodes.filter(node => isArchived(node, state.nodes));
  // Items that only inherit their project's archive return with it and are counted on the project row.
  const returning = (id: string) => archived.filter(node => node.resourceId && node.projectId === id && !node.archivedAt);
  const projects = archived.filter(node => !node.resourceId && node.archivedAt && (matches(node.title) || returning(node.id).some(child => matches(child.title))));
  const items = archived.filter(node => node.resourceId && node.archivedAt && matches(`${node.title} ${project(node)?.title ?? ''}`));
  const groups = [...items.reduce((map, node) => {
    const parent = project(node), key = parent?.id ?? '';
    map.set(key, { key: key || 'floating', title: parent?.title ?? 'No project', parent, items: [...map.get(key)?.items ?? [], node] });
    return map;
  }, new Map<string, { key: string; title: string; parent?: ArchivedNode; items: ArchivedNode[] }>()).values()].sort((a, b) => Number(!a.parent) - Number(!b.parent) || a.title.localeCompare(b.title));
  const todos = state.todos.filter(todo => todo.archivedAt && matches(todo.title));
  const run = async (command: WorkspaceCommand) => {
    setPending(true); setError(''); setConfirm(''); setMenu('');
    try { await save([command]); } catch (error) { setError((error as Error).message); } finally { setPending(false); }
  };
  const row = ({ key, title, icon, meta, restore, restoreLabel = 'Restore', blocked, remove, confirmLabel, message }: {
    key: string; title: string; icon: ReactNode; meta: ReactNode; restore: WorkspaceCommand; restoreLabel?: string; blocked?: boolean; remove: WorkspaceCommand; confirmLabel: string; message: ReactNode;
  }) => <ListItem key={key} data-archived-id={key} icon={icon} title={title} meta={meta} actions={<>
    <button type="button" className="archive-restore" disabled={pending || blocked} aria-label={`Restore ${title}`} onClick={() => { void run(restore); }}>{restoreLabel}</button>
    <RowMenu title={title} open={menu === key} disabled={pending} toggle={() => setMenu(menu === key ? '' : key)} remove={() => { setMenu(''); setConfirm(key); }} />
  </>}>
    {confirm === key && <InlineConfirm confirmLabel={confirmLabel} busy={pending} cancel={() => setConfirm('')} confirm={() => { void run(remove); }} message={message} />}
  </ListItem>;
  const itemCount = projects.length + items.length;
  const nothing = (title: string, hint: string) => <SettingsList label={title}><EmptyState title={query ? 'No matching entries' : title}>{hint}</EmptyState></SettingsList>;
  return <form ref={panel} className="inline-editor archive-browser settings-surface" aria-label="Archive" data-dragging={dragging} style={{ left: position.x, top: position.y }} onSubmit={event => event.preventDefault()}>
    <div className="editor-heading" {...handle}><strong>Archive</strong><button type="button" aria-label="Close archive" onClick={close}><PixelGlyph name="close" /></button></div>
    <div className="archive-tabs"><Segmented label="Archive views" value={tab} change={value => { setConfirm(''); setMenu(''); setTab(value); }} options={[
      { value: 'items', label: 'Items', name: 'Archived items', count: itemCount }, { value: 'todos', label: 'To-dos', name: 'Archived to-dos', count: todos.length },
      { value: 'sessions', label: 'Sessions', name: 'Archived sessions', count: counts.sessions }, { value: 'recordings', label: 'Recordings', name: 'Archived session recordings', count: counts.recordings }]} /></div>
    {(tab === 'items' || tab === 'todos') && <input aria-label="Search archive" placeholder="Find an item, project or to-do…" value={query} onChange={event => setQuery(event.target.value)} />}
    {error && <p className="archive-error" role="alert">{error}</p>}
    {tab === 'items' && <div className="archive-entries">
      {!itemCount && nothing('Nothing archived', 'Archive items from Undermap; they wait here until you restore or delete them.')}
      {projects.length > 0 && <section className="archive-group" aria-label="Projects"><h3 className="archive-group-title">Projects</h3><SettingsList label="Archived projects">
        {projects.map(node => { const returns = returning(node.id).length; return row({ key: node.id, title: node.title, icon: <ItemIcon icon="project" />,
          meta: returns ? `${count(returns, 'item returns', 'items return')} with the project` : 'Returns to the map', restore: { type: 'node.restore', id: node.id }, restoreLabel: 'Restore project',
          remove: { type: 'node.delete', id: node.id }, confirmLabel: 'Delete project', message: <><b>Delete {node.title} permanently?</b> Its items stay in the archive without a project. This can’t be undone.</> }); })}
      </SettingsList></section>}
      {groups.map(group => <section className="archive-group" key={group.key} aria-label={group.title}><h3 className="archive-group-title">{group.title}</h3><SettingsList label={`Archived items in ${group.title}`}>
        {group.items.map(node => { const blocked = Boolean(group.parent && isArchived(group.parent, state.nodes)); return row({ key: node.id, title: node.title, icon: <ItemIcon icon="item" />,
          meta: blocked ? `Restore ${group.title} first` : node.belowAt ? 'Returns to Undermap' : 'Returns to the map', restore: node.hiddenAt ? { type: 'node.show', id: node.id } : { type: 'node.restore', id: node.id }, blocked,
          remove: { type: 'node.delete', id: node.id }, confirmLabel: 'Delete permanently', message: <><b>Delete {node.title} permanently?</b> Provider data and sessions are kept. This can’t be undone.</> }); })}
      </SettingsList></section>)}
    </div>}
    {tab === 'todos' && <div className="archive-entries">
      {!todos.length && nothing('No archived to-dos', 'Archive a to-do from its row in the to-do list.')}
      {todos.length > 0 && <SettingsList label="Archived to-dos">
        {todos.map(todo => row({ key: `todo:${todo.id}`, title: todo.title, icon: <ItemIcon icon="square-check" />, meta: 'To-do', restore: { type: 'todo.restore', id: todo.id },
          remove: { type: 'todo.remove', id: todo.id }, confirmLabel: 'Delete permanently', message: <><b>Delete {todo.title} permanently?</b> Attached items stay on the map. This can’t be undone.</> }))}
      </SettingsList>}
    </div>}
    {tab === 'sessions' && <SessionManager archivedOnly nodeTitles={new Map(state.nodes.map(node => [node.id, node.title]))} />}
    {tab === 'recordings' && <RecordingStorage archive />}
  </form>;
}
