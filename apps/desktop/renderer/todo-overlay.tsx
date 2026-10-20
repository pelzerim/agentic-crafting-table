import { Fragment, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, DragEvent as ReactDragEvent, Ref } from 'react';
import type { ViewState, WorkspaceCommand, WorkspaceState } from '../../../packages/core/control.ts';
import { archiveTodo, attachTodo, contextTodo, detachTodo, moveTodo, renameTodo, sendTargets, sendTodo } from '../../../packages/core/todos.ts';
import { laterGroupActions, sendToProjectAction, todoContextActions } from '../../../packages/core/context-menu.ts';
import { TodoContextPanel, contextCredit } from './todo-context.tsx';
import type { TodoContextMode } from './todo-context.tsx';
import { createPortal } from 'react-dom';
import { CanvasMenu } from './canvas-menu.tsx';
import { isArchived, isBelow, isOffMap } from '../../../src/graph/archive.ts';
import { LATER_AGE_DAYS, NEXT_SOFT_LIMIT, oldestTodo, todoList, untouchedDays, withoutMuted } from '../../../src/graph/todos.ts';
import type { TodoEntry, TodoHorizon, TodoList } from '../../../src/graph/todos.ts';
import { placeRows, placementFor } from './todo-placement.ts';
import type { Placement } from './todo-placement.ts';
import { projectColor } from '../../../src/graph/project-colors.ts';
import type { ResourcePluginRegistry } from '../../../src/resource-plugins/registry.ts';
import { presentResource, presentationIcon } from '../../../src/resource-plugins/views.ts';
import { splitReference } from '../../../src/graph/reference.ts';
import { ItemIcon } from './icons.tsx';
import { railSlot } from './tool-rail.tsx';
import { RailPanel } from './rail-panel.tsx';
import { useRailTool } from './rail-state.ts';
import type { PanelSize } from './rail-panel.tsx';
import { shortcutKey, useWorkspaceShortcuts } from './shortcuts.ts';
import { InlineTitle } from './inline-title.tsx';
import { PixelCombobox } from './ui/combobox.tsx';
import { itemOptions } from './ui/item-options.ts';
import { NodeIcon } from './ui/node-icon.tsx';
import { PixelGlyph } from './ui/pixel-glyph.tsx';

type Point = { x: number; y: number };
type Group = 'inbox' | TodoHorizon | 'done';
/** A row being dragged in the list: where it came from and where it would land (`before` names the row it would precede).
 * `rows` is the list as it was when the drag began, drawn until the drop; `height` is the dragged row's, which its gap keeps. */
type Move = { id: string; from: Group; rows: TodoList; height: number; target?: { group: TodoHorizon | 'done'; before?: string } };
/** A row as drawn: itself, the dragged row collapsed in its old place, or the gap showing where it would land. */
type Slot = { entry: TodoEntry; role?: 'source' | 'gap' };
/** A change the list can take back, offered in a toast. */
export interface TodoUndo { title: string; detail?: string; undo: WorkspaceCommand[] }
export interface TodoOverlayHandle {
  drag(id: string | undefined, point?: Point): void;
  drop(id: string, point: Point): Promise<boolean>;
  /** Opens the list with keyboard focus on this to-do's row. */
  show(id: string): void;
}
const LABELS: Record<Group, string> = { inbox: 'From Linear', next: 'Next', later: 'Later', done: 'Done' };
const EDITING = 'input:not([type=checkbox]), textarea, select, [contenteditable=true], [data-inline-title] input';
export function TodoOverlay({ state, registry, view, save, saveView, reveal, openWeb, onDragTodo, announce, doneArchiveDays, ref }: {
  state: WorkspaceState; registry: ResourcePluginRegistry; view: ViewState;
  /** Resolves with the revision the commands were saved at, when known. */
  save(commands: WorkspaceCommand[]): Promise<number | void>; saveView(patch: Partial<ViewState>): void;
  reveal(id: string): void; openWeb?(nodeId: string): void; onDragTodo?(todo: { id: string; title: string; nodeId?: string } | undefined): void;
  announce?(undo: TodoUndo): void; doneArchiveDays?: number; ref: Ref<TodoOverlayHandle>;
}) {
  const { rail, open, pinned } = useRailTool('todos');
  const setOpen = (value: boolean) => { if (value) rail.open('todos'); else rail.close('todos'); };
  const [draft, setDraft] = useState(view.todoOverlay?.draft ?? '');
  const [groupByProject, setGroupByProject] = useState(view.todoOverlay?.groupByProject ?? false);
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const [inboxOpen, setInboxOpen] = useState(false), [doneOpen, setDoneOpen] = useState(false);
  const [completion, setCompletion] = useState<{ id: string; value: boolean }>();
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [attaching, setAttaching] = useState<string>();
  const [choosing, setChoosing] = useState(false), [spotlight, setSpotlight] = useState<string>();
  useEffect(() => { if (!spotlight) return; const timer = setTimeout(() => setSpotlight(undefined), 2000); return () => clearTimeout(timer); }, [spotlight]);
  const [move, setMoveState] = useState<Move>();
  const moveRef = useRef<Move>(undefined);
  const setMove = (value: Move | undefined) => { moveRef.current = value; setMoveState(value); };
  const [dragId, setDragId] = useState<string>(), [dropTarget, setDropTarget] = useState<string>(), [references, setReferences] = useState<string>();
  // A row's context menu, or the Later group's, at a point of the workspace.
  const [menu, setMenu] = useState<{ id: string; screen: Point }>();
  // The one to-do whose context is open under its row; the text is drawn nowhere else.
  const [contextPanel, setContextPanel] = useState<{ id: string; mode: TodoContextMode }>();
  // Pinned to its rail slot; the list opens beside the rail rather than moving.
  const panel = useRef<HTMLFormElement>(null), sheet = useRef<HTMLDivElement>(null), position = railSlot('todos');
  const [dimensions, setDimensions] = useState<PanelSize>({ width: view.todoOverlay?.width, height: view.todoOverlay?.height });
  const [resizing, setResizing] = useState(false);
  const list = useRef<HTMLDivElement>(null), scroll = useRef(view.todoOverlay?.scrollTop ?? 0), over = useRef(false), keyboard = useRef(false);
  const shortcutFocus = useRef<string | undefined>(undefined), focusRow = useRef<string | undefined>(undefined);
  const collapseTimer = useRef<ReturnType<typeof setTimeout>>(undefined), persistTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Moves shown before their saves land; they are saved one after another, each on the revision the last one left. */
  const [placements, setPlacements] = useState<Placement[]>([]);
  const placed = useRef<Placement[]>([]), saves = useRef<Promise<unknown>>(Promise.resolve());
  // A saved move stays placed until the list is drawn from a revision that has it, so nothing reads the old order in between.
  const landed = useRef(new Map<Placement, number>()), revision = useRef(state.revision);
  revision.current = state.revision;
  const latest = () => placeRows(todoList(state), placed.current);
  // Saves and drop positions use the whole list; only the drawn rows leave muted projects out.
  const live = withoutMuted(placeRows(todoList(state), placements), state.nodes), now = Date.now();
  // A drag draws the list as it was when the drag began, so nothing from elsewhere reflows it until the drop.
  const canonical = move?.rows ?? live;
  const all = [...canonical.inbox, ...canonical.next, ...canonical.later, ...canonical.done];
  const groupIn = (list: TodoList, id: string): Group | undefined => (['inbox', 'next', 'later', 'done'] as const).find(group => list[group].some(entry => entry.id === id));
  const groupOf = (id: string) => groupIn(canonical, id);
  const dragged = move && all.find(entry => entry.id === move.id);
  useEffect(() => { if (move && !dragged) setMove(undefined); }, [move, dragged]);
  /** A group as drawn. While a row is dragged it stays collapsed in its place and only its gap moves, to where it would land. */
  const shown = (group: Group): Slot[] => {
    const rows: Slot[] = canonical[group].map(entry => entry.id === move?.id ? { entry, role: 'source' } : { entry });
    if (!dragged || !move) return rows;
    const target = move.target ?? { group: move.from };
    if (target.group !== group) return rows;
    let at = move.target ? (move.target.before ? rows.findIndex(slot => !slot.role && slot.entry.id === move.target!.before) : -1) : rows.findIndex(slot => slot.role === 'source') + 1;
    if (at < 0) at = group === 'done' ? 0 : rows.length;
    rows.splice(at, 0, { entry: dragged, role: 'gap' });
    return rows;
  };
  const entries = all;
  const referenceEntry = open ? entries.find(entry => entry.id === references && entry.nodeIds.length > 1) : undefined;
  useEffect(() => { if (references && !referenceEntry) setReferences(undefined); }, [references, referenceEntry]);
  const attachmentLabel = (id: string) => {
    const node = state.nodes.find(node => node.id === id), project = state.nodes.find(project => project.id === node?.projectId);
    return [node?.title ?? 'Unavailable item', project?.title ?? (node?.resourceId ? 'No project' : 'Project')].join(' · ');
  };
  const showItem = (id: string) => {
    const node = state.nodes.find(node => node.id === id);
    if (!node || isArchived(node, state.nodes)) { setError('This item is archived or unavailable. Restore it from Archive to show it on the map.'); return; }
    if (isBelow(node, state.nodes)) { setError('This item is in Undermap. Bring it back to show it here.'); return; }
    setError(''); setReferences(undefined); reveal(id);
  };
  const persistence = useRef(() => {}), mounted = useRef(false);
  persistence.current = () => saveView({ todoOverlay: { ...position, ...dimensions, draft, scrollTop: scroll.current, groupByProject } });
  const cancelCollapse = () => clearTimeout(collapseTimer.current);
  const scheduleCollapse = () => {
    cancelCollapse();
    if (pinned) return;
    collapseTimer.current = setTimeout(() => {
      if (!over.current && !resizing && !dragId && !move && !pending && !attaching && !choosing && !menu && !editing.size && contextPanel?.mode !== 'edit' && !(keyboard.current && panel.current?.contains(document.activeElement))) setOpen(false);
    }, 240);
  };
  useEffect(() => { if (!mounted.current) { mounted.current = true; return; } clearTimeout(persistTimer.current); if (!resizing) persistTimer.current = setTimeout(() => persistence.current(), 160); }, [position.x, position.y, draft, dimensions, resizing, groupByProject]);
  useEffect(() => { scheduleCollapse(); return cancelCollapse; }, [pinned, resizing, dragId, move, pending, attaching, choosing, editing, menu, contextPanel?.mode]);
  const menuEntry = open ? entries.find(entry => entry.id === menu?.id) : undefined;
  const contextEntry = entries.find(entry => entry.id === contextPanel?.id);
  useEffect(() => { if (contextPanel && (!contextEntry || !contextEntry.context && contextPanel.mode !== 'edit')) setContextPanel(undefined); }, [contextPanel, contextEntry]);
  useEffect(() => { if (menu && !menuEntry && menu.id !== '_later') setMenu(undefined); }, [menu, menuEntry]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => { if (!(event.target as HTMLElement).closest('.canvas-context')) setMenu(undefined); };
    window.addEventListener('pointerdown', dismiss, true);
    return () => window.removeEventListener('pointerdown', dismiss, true);
  }, [menu]);
  const send = (entry: TodoEntry, projectId: string) => commit([sendTodo(entry, projectId, { nodeId: crypto.randomUUID(), resourceId: crypto.randomUUID() })]);
  useEffect(() => () => { cancelCollapse(); clearTimeout(persistTimer.current); }, []);
  // A hidden list ignores scrollTop, so restore it whenever the sheet shows.
  useLayoutEffect(() => { if (open && list.current) list.current.scrollTop = scroll.current; }, [open]);
  useLayoutEffect(() => {
    if (attaching) panel.current?.querySelector<HTMLElement>('.todo-attach-target, .todo-new input')?.focus({ preventScroll: true });
  }, [attaching]);
  useLayoutEffect(() => {
    if (!shortcutFocus.current) return;
    panel.current?.querySelector<HTMLElement>(shortcutFocus.current)?.focus();
    shortcutFocus.current = undefined;
  }, [open, pinned]);
  // A row moved by key lands in another group; keep the keyboard on it.
  useLayoutEffect(() => {
    const id = focusRow.current; if (!id) return;
    const row = panel.current?.querySelector<HTMLElement>(`.todo-row[data-todo-id="${CSS.escape(id)}"]`);
    if (row && document.activeElement !== row) { row.focus({ preventScroll: false }); focusRow.current = undefined; }
  });
  const close = () => { cancelCollapse(); setChoosing(false); setAttaching(undefined); setReferences(undefined); rail.unpin('todos'); setOpen(false); };
  const slotClick = () => { cancelCollapse(); if (open && pinned) close(); else rail.pin('todos'); };
  useWorkspaceShortcuts({ 'rail.todos': () => { shortcutFocus.current = open && pinned ? '.todo-toggle' : '.rail-panel-close'; keyboard.current = true; slotClick(); }, 'todos.toggle': () => {
    // Focus with the visibility commit, before the next keystroke or field focus.
    // A deferred frame can steal focus from an editor the user has already entered.
    shortcutFocus.current = open && pinned ? '.todo-toggle' : '.rail-panel-close';
    setReferences(undefined); slotClick(); keyboard.current = true;
  } });
  useEffect(() => {
    const pointer = (event: PointerEvent) => {
      if (!keyboard.current || !panel.current || panel.current.contains(event.target as Node)) return;
      // Moving away ends keyboard navigation, but never interrupts text editing.
      const active = document.activeElement;
      if (active instanceof Element && panel.current.contains(active) && active.matches('input,textarea,[contenteditable]')) return;
      keyboard.current = false; scheduleCollapse();
    };
    window.addEventListener('pointermove', pointer);
    return () => window.removeEventListener('pointermove', pointer);
  }, [pinned, resizing, dragId, move, pending, attaching, choosing, editing, contextPanel?.mode]);
  const commit = async (commands: WorkspaceCommand[]) => {
    if (!commands.length) return true;
    setPending(true); setError('');
    try { await save(commands); return true; } catch (error) { setError((error as Error).message); return false; } finally { setPending(false); }
  };
  /** Where a to-do is now, so a move can be taken back. */
  const placeOf = (list: TodoList, entry: TodoEntry): WorkspaceCommand => {
    const group = groupIn(list, entry.id);
    if (group === 'done') return moveTodo(entry, 'done');
    if (group === 'inbox' || !group) return moveTodo(entry, entry.horizon === 'later' ? 'later' : 'next');
    return moveTodo(entry, group, list[group].findIndex(row => row.id === entry.id));
  };
  const setPlaced = (next: Placement[]) => { placed.current = next; setPlacements(next); };
  const settle = () => { const done = placed.current.filter(placement => (landed.current.get(placement) ?? Infinity) <= revision.current); if (done.length) { done.forEach(placement => landed.current.delete(placement)); setPlaced(placed.current.filter(placement => !done.includes(placement))); } };
  useEffect(settle, [state.revision]);
  /** Moves a row at once and queues its save behind any still in flight; ticking offers Undo, as everything Done folds out of sight.
   * A tick shows on the checkbox and the row folds once it is saved, so `shown` is false for it. */
  const moveTo = async (entry: TodoEntry, group: TodoHorizon | 'done', index?: number, shown = true) => {
    const list = latest(), back = placeOf(list, entry), from = groupIn(list, entry.id), placement = placementFor(list, entry, group, index);
    setError(''); if (shown) setPlaced([...placed.current, placement]);
    const saved = saves.current.then(() => save([moveTodo(entry, group, index)])).then(at => {
      if (shown) { landed.current.set(placement, typeof at === 'number' ? at : -Infinity); settle(); }
      return true;
    }, (error: Error) => { setError(error.message); if (shown) setPlaced(placed.current.filter(other => other !== placement)); return false; });
    saves.current = saved;
    if (await saved && group === 'done' && from !== 'done') announce?.({ title: 'Done', detail: entry.title, undo: from === 'inbox' ? [] : [back] });
  };
  const complete = (entry: TodoEntry, value: boolean) => {
    setCompletion({ id: entry.id, value });
    void moveTo(entry, value ? 'done' : entry.horizon === 'later' ? 'later' : 'next', undefined, false).finally(() => setCompletion(undefined));
  };
  const dismiss = async (entry: TodoEntry) => {
    if (await commit([{ type: 'todo.dismiss', id: entry.id, dismissed: true }])) announce?.({ title: 'Hidden until it changes', detail: [entry.triage?.label, entry.title].filter(Boolean).join(' '), undo: [{ type: 'todo.dismiss', id: entry.id, dismissed: false }] });
  };
  /** Index a dropped row takes in `group`, before the row named `before`, else last. */
  const dropIndex = (list: TodoList, id: string, group: TodoHorizon, before?: string) => {
    const rows = list[group].filter(row => row.id !== id), at = before ? rows.findIndex(row => row.id === before) : -1;
    return at < 0 ? rows.length : at;
  };
  /** Drops the row where its gap is, into the list as it is now; changes made elsewhere during the drag show from here on. */
  const finish = (current: Move) => {
    const list = latest(), entry = [...list.inbox, ...list.next, ...list.later, ...list.done].find(row => row.id === current.id), target = current.target;
    setMove(undefined); onDragTodo?.(undefined);
    if (!entry || !target) return;
    if (target.group === 'done') { if (groupIn(list, entry.id) !== 'done') void moveTo(entry, 'done'); return; }
    const index = dropIndex(list, entry.id, target.group, target.before);
    if (groupIn(list, entry.id) === target.group && list[target.group].findIndex(row => row.id === entry.id) === index) return;
    void moveTo(entry, target.group, index);
  };
  /** The row the pointer is above, among rows that could precede the dragged one in this section. The gap is as tall as
   * the row, so opening it before or after a row moves only the rows it passes and never changes this answer. */
  const rowBefore = (section: HTMLElement, y: number, current: Move) => {
    const project = all.find(row => row.id === current.id)?.projectId ?? '';
    return [...section.querySelectorAll<HTMLElement>('.todo-row[data-todo-id]:not([data-reordering="true"])')].filter(row => row.dataset.todoId !== current.id && (!groupByProject || row.dataset.project === project))
      .find(row => { const rect = row.getBoundingClientRect(); return y <= rect.top + rect.height / 2; })?.dataset.todoId;
  };
  const dropZone = (group: TodoHorizon | 'done') => ({
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      const current = moveRef.current; if (!current) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
      const before = group === 'done' ? undefined : rowBefore(event.currentTarget, event.clientY, current);
      if (current.target?.group !== group || current.target.before !== before) setMove({ ...current, target: { group, before } });
    },
    onDrop: (event: ReactDragEvent<HTMLElement>) => { const current = moveRef.current; if (!current?.target) return; event.preventDefault(); event.stopPropagation(); finish(current); },
  });
  const grip = (entry: TodoEntry, group: Group) => <button type="button" className="todo-order-grip" aria-label={`Reorder ${entry.title}`} title="Drag to Next, Later, Done or the map · N Next · L Later · Space done · ⌥↑↓ or ↑↓ here to move" draggable={!pending}
    onDragStart={event => {
      event.stopPropagation(); event.dataTransfer.setData('application/x-crafting-todo', entry.id); event.dataTransfer.setData('application/x-crafting-todo-map', entry.id);
      onDragTodo?.({ id: entry.id, title: entry.title, ...(entry.nodeId ? { nodeId: entry.nodeId } : {}) });
      event.dataTransfer.effectAllowed = 'move'; cancelCollapse();
      // The browser takes the drag image after this handler; the row collapses into its gap only after that.
      const started: Move = { id: entry.id, from: group, rows: live, height: event.currentTarget.closest('.todo-row')?.getBoundingClientRect().height ?? 0 };
      moveRef.current = started; setTimeout(() => { if (moveRef.current === started) setMoveState(started); });
    }}
    onDragEnd={() => { setMove(undefined); onDragTodo?.(undefined); }} onKeyDown={event => {
      if (event.altKey || event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault(); step(entry, event.key === 'ArrowUp' ? -1 : 1);
    }}>⠿</button>;
  /** Up or down by one within the row's group; with projects grouped, past the neighbour of its own project. */
  const step = (entry: TodoEntry, by: -1 | 1) => {
    const list = latest(), group = groupIn(list, entry.id);
    if (group !== 'next' && group !== 'later') return;
    const rows = list[group], drawn = withoutMuted(list, state.nodes)[group], peers = groupByProject ? drawn.filter(row => (row.projectId ?? '') === (entry.projectId ?? '')) : drawn, at = peers.findIndex(row => row.id === entry.id), neighbour = peers[at + by];
    if (!neighbour) return;
    focusRow.current = entry.id; void moveTo(entry, group, rows.findIndex(row => row.id === neighbour.id));
  };
  /** After a tick the row folds into Done, so the keyboard moves on to its neighbour; an undone row keeps it. */
  const keepFocus = (entry: TodoEntry, group: Group) => {
    if (group === 'done') { focusRow.current = entry.id; return; }
    const rows = canonical[group], at = rows.findIndex(row => row.id === entry.id); focusRow.current = (rows[at + 1] ?? rows[at - 1])?.id;
  };
  /** N, L, Space and Alt+↑/↓ on a focused row; fields, editors and menus keep their keys (KEY-01). */
  const rowKeys = (entry: TodoEntry, group: Group) => (event: ReactKeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (event.defaultPrevented || event.repeat || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || target.closest(EDITING) || target.closest('.todo-context, .canvas-context')) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (event.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) { event.preventDefault(); step(entry, key === 'ArrowUp' ? -1 : 1); return; }
    if (event.altKey || event.shiftKey) return;
    if (key === 'n' || key === 'l') {
      event.preventDefault(); const horizon = key === 'n' ? 'next' : 'later';
      if (group !== horizon) { focusRow.current = entry.id; void moveTo(entry, horizon); }
    } else if (key === ' ' && group !== 'inbox' && !(target instanceof HTMLInputElement && target.type === 'checkbox')) {
      event.preventDefault(); keepFocus(entry, group); complete(entry, group !== 'done');
    }
  };
  const attach = async (id: string, entry?: TodoEntry) => {
    try { if (await commit(attachTodo(state, entry, id, crypto.randomUUID()))) setAttaching(undefined); } catch (error) { setError((error as Error).message); }
  };
  const inside = (point: Point) => [panel.current?.querySelector('.rail-panel-toggle'), open ? sheet.current : undefined].some(element => {
    const rect = element?.getBoundingClientRect(); return rect && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
  });
  const target = (point: Point) => {
    const viewport = list.current!.getBoundingClientRect();
    if (point.x < viewport.left || point.x > viewport.right || point.y < viewport.top || point.y > viewport.bottom) return '';
    return [...panel.current!.querySelectorAll<HTMLElement>('[data-todo-id]')].find(row => {
      const rect = row.getBoundingClientRect(); return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
    })?.dataset.todoId ?? '';
  };
  useImperativeHandle(ref, () => ({
    drag(id, point) {
      setDragId(id); if (!id) { setDropTarget(undefined); return; } over.current = !!point && inside(point);
      if (over.current && point) { setOpen(true); cancelCollapse(); setDropTarget(target(point)); } else setDropTarget(undefined);
    },
    async drop(id, point) {
      if (!inside(point)) return false;
      const entry = entries.find(entry => entry.id === target(point));
      try { await attach(id, entry); } catch (error) { setError((error as Error).message); }
      return true; // A rejected attachment must never move the source into the overlay's world location.
    },
    show(id) {
      const group = groupOf(id); if (group === 'inbox') setInboxOpen(true); if (group === 'done') setDoneOpen(true);
      // The checkbox takes focus, or the row itself when it has none (an inbox ticket).
      const row = `.todo-row[data-todo-id="${CSS.escape(id)}"]`, focus = () => (panel.current?.querySelector<HTMLElement>(`${row} input[type=checkbox]`) ?? panel.current?.querySelector<HTMLElement>(row))?.focus();
      shortcutFocus.current = group === 'inbox' ? row : `${row} input[type=checkbox]`; keyboard.current = true;
      cancelCollapse(); setReferences(undefined); setSpotlight(id);
      if (open) requestAnimationFrame(() => { focus(); shortcutFocus.current = undefined; }); else setOpen(true);
    },
  }));
  const newTodo = async () => {
    if (!draft.trim()) return;
    if (await commit([{ type: 'todo.save', todo: { id: crypto.randomUUID(), title: draft.trim(), completed: false, nodeIds: attaching ? [attaching] : [] } }])) { setDraft(''); setAttaching(undefined); }
  };
  const toggleGrouping = () => setGroupByProject(value => !value);
  const nodeOf = (entry: TodoEntry) => entry.nodeId ? state.nodes.find(node => node.id === entry.nodeId) : undefined;
  const projectOf = (entry: TodoEntry) => entry.projectId ? state.nodes.find(node => node.id === entry.projectId) : undefined;
  /** The ticket behind a row, if it is one: its short name, its own title, its provider state and where it opens. A kept
   * item's title leads with its reference ("BIL-128 · Plan changes"); the row shows the words and the reference as a chip. */
  const ticketOf = (entry: TodoEntry) => {
    if (entry.triage) return { label: entry.triage.label, title: entry.title, status: entry.triage.status, url: entry.triage.url, brand: registry.get(state.todos.find(todo => todo.id === entry.id)?.triage?.item.pluginId ?? '')?.brand };
    const node = entry.providerTask ? nodeOf(entry) : undefined, split = node && splitReference(entry.title);
    return split ? { label: split.reference, title: split.rest, status: node.indicators?.[0]?.label, url: undefined, brand: registry.get(state.resources.find(resource => resource.id === node.resourceId)?.pluginId ?? '')?.brand } : undefined;
  };
  const row = (entry: TodoEntry, group: Group, role?: Slot['role']) => {
    const ticket = ticketOf(entry), title = ticket?.title ?? entry.title, project = projectOf(entry), age = group === 'later' ? untouchedDays(entry, now) : 0, inbox = group === 'inbox';
    const done = group === 'done', checked = completion?.id === entry.id ? completion.value : entry.completed;
    // The dragged row keeps its element, which the browser's drag began on, collapsed in place until the drop.
    return <Fragment key={role === 'gap' ? `gap:${entry.id}` : entry.id}><div className={role === 'source' ? 'todo-row-source' : 'todo-row'} tabIndex={role ? -1 : 0} aria-label={title} aria-hidden={role ? true : undefined} inert={role === 'gap' || undefined}
      style={role === 'gap' && move?.height ? { height: move.height, boxSizing: 'border-box' } : undefined} onKeyDown={rowKeys(entry, group)} onContextMenu={event => {
        if ((event.target as HTMLElement).closest('input:not([type=checkbox]), textarea, [contenteditable=true]')) return;
        event.preventDefault(); event.stopPropagation(); cancelCollapse();
        const host = panel.current?.offsetParent?.getBoundingClientRect();
        setMenu({ id: entry.id, screen: { x: event.clientX - (host?.left ?? 0), y: event.clientY - (host?.top ?? 0) } });
      }} onMouseDown={event => { if (event.button === 1) event.preventDefault(); }} onAuxClick={event => {
        if (event.button !== 1 || role) return;
        event.preventDefault();
        if (entry.nodeId) openWeb?.(entry.nodeId); else if (entry.triage?.url) void window.craftingTable.openUrl(entry.triage.url).catch(error => setError((error as Error).message));
      }} data-reordering={role === 'gap'} data-todo-id={role === 'source' ? undefined : entry.id} data-project={entry.projectId ?? ''} data-completed={done} data-inbox={inbox || undefined} data-spotlight={spotlight === entry.id || undefined} data-drop-target={dropTarget === entry.id}>
      {grip(entry, group)}
      {inbox ? <span className="todo-inbox-mark" aria-hidden="true"><ItemIcon icon="circle-dashed" brand={ticket?.brand} /></span>
        : <input type="checkbox" aria-label={`Complete ${title}`} title={entry.providerDone ? 'Done in its provider' : undefined} checked={checked} disabled={pending || entry.providerDone} onChange={event => complete(entry, event.target.checked)} />}
      {entry.providerTask || inbox ? <button type="button" className="todo-row-title todo-provider-title" onClick={() => { if (entry.nodeId) showItem(entry.nodeId); else if (entry.triage?.url) void window.craftingTable.openUrl(entry.triage.url).catch(error => setError((error as Error).message)); }}
        title={nodeOf(entry)?.title ?? entry.title}>{title}</button>
        : <InlineTitle className="todo-row-title" title={entry.title} save={async value => { await save([renameTodo(entry, value)]); }} onEditingChange={active => setEditing(previous => {
          if (previous.has(entry.id) === active) return previous;
          const next = new Set(previous); if (active) next.add(entry.id); else next.delete(entry.id); return next;
        })} />}
      <span className="todo-chips">
        {age >= LATER_AGE_DAYS && <span className="todo-chip todo-age" title={`Untouched for ${age} days`}>{age}d</span>}
        {ticket && <button type="button" className="todo-chip todo-ticket" disabled={!ticket.url && !entry.nodeId} aria-label={entry.nodeId ? `Show ${entry.title} on map` : `Open ${ticket.label} in the browser`} title={`${ticket.label} · ${entry.nodeId ? 'Show on the map' : 'Open in the browser'}`}
          onClick={() => { if (entry.nodeId) showItem(entry.nodeId); else if (ticket.url) void window.craftingTable.openUrl(ticket.url).catch(error => setError((error as Error).message)); }}>{ticket.label}</button>}
        {ticket?.status && <span className="todo-chip todo-state" title={`${ticket.label} is ${ticket.status} there`}>{ticket.status}</span>}
      </span>
      {entry.context && (() => {
        const open = contextPanel?.id === entry.id;
        return <button type="button" className="todo-links todo-context-glyph" aria-label={`${open ? 'Hide' : 'Show'} context for ${title}`} aria-expanded={open} title={['Has context', contextCredit(entry.context, ' ')].filter(Boolean).join(' · ')}
          onClick={() => setContextPanel(open ? undefined : { id: entry.id, mode: 'view' })}><PixelGlyph name="message" /></button>;
      })()}
      {inbox ? <span className="todo-take">
        <button type="button" disabled={pending} aria-label={`Take ${ticket?.label ?? title} into Next`} title="Take into Next · N" onClick={() => { void moveTo(entry, 'next'); }}>Next</button>
        <button type="button" disabled={pending} aria-label={`Take ${ticket?.label ?? title} into Later`} title="Take into Later · L" onClick={() => { void moveTo(entry, 'later'); }}>Later</button>
        <button type="button" disabled={pending} aria-label={`${ticket?.label ?? title} is not for me`} title="Not for me · hidden until it changes" onClick={() => { void dismiss(entry); }}><PixelGlyph name="close" /></button>
      </span> : <>
        {!attaching && (entry.nodeIds.length === 1 && !entry.providerTask || entry.source === 'checklist') && <span className="todo-row-actions">
          {entry.nodeIds.length === 1 && !entry.providerTask && <button type="button" className="todo-detach" title="Detach item" aria-label={`Detach ${state.nodes.find(node => node.id === entry.nodeIds[0])?.title ?? 'item'}`} disabled={pending} onClick={() => { void commit(detachTodo(state, entry, entry.nodeIds[0])); }}><ItemIcon icon="unlink" /></button>}
          {entry.source === 'checklist' && <button type="button" className="todo-archive" disabled={pending} aria-label={`Archive ${title}`} title="Archive to-do" onClick={() => { void commit([{ type: 'todo.archive', id: entry.id }]); }}><ItemIcon icon="archive" /></button>}
        </span>}
        {attaching ? <button type="button" className="todo-attach-target" disabled={pending} aria-label={`Attach to ${title}`} onClick={() => { void attach(attaching, entry); }}>+</button>
          : entry.nodeIds.length > 0 && !entry.providerTask && !(entry.nodeIds.length === 1 && entry.nodeIds[0] === entry.projectId) && <button type="button" className="todo-links" aria-label={entry.nodeIds.length === 1 ? `Show ${state.nodes.find(node => node.id === entry.nodeIds[0])?.title ?? 'item'} on map` : `Links for ${title}`} aria-expanded={entry.nodeIds.length > 1 ? references === entry.id : undefined} title={entry.nodeIds.map(attachmentLabel).join(', ')} onClick={() => entry.nodeIds.length === 1 ? showItem(entry.nodeIds[0]) : setReferences(references === entry.id ? undefined : entry.id)}>
            {entry.nodeIds.slice(0, 3).map(id => { const node = state.nodes.find(node => node.id === id), resource = state.resources.find(resource => resource.id === node?.resourceId), view = resource && presentResource(registry, resource); return <span key={id} className={`todo-attachment tone-${view?.appearance.tone ?? 'mint'}`}><ItemIcon icon={presentationIcon(view, Boolean(node?.completedAt))} brand={view?.brand} tint={view?.appearance.brandTint} /></span>; })}{entry.nodeIds.length > 3 && <small>+{entry.nodeIds.length - 3}</small>}
          </button>}
      </>}
      {/* The project column closes every row, empty without a project, so projects line up down the list. */}
      <span className="todo-project-cell">{project && <span className="todo-chip todo-project" style={{ '--chip': projectColor(project) } as React.CSSProperties} title={`Project ${project.title}`}>{project.title}</span>}</span>
    </div>
    {contextPanel?.id === entry.id && role !== 'gap' && <TodoContextPanel title={title} context={entry.context} mode={contextPanel.mode} pending={pending} setMode={mode => setContextPanel({ id: entry.id, mode })}
      save={text => commit([contextTodo(entry, text)])} close={() => setContextPanel(undefined)} />}
    </Fragment>;
  };
  /** Rows of one horizon, in project sub-groups when the person asked for them. */
  const rows = (group: TodoHorizon | 'done', items: Slot[]) => {
    if (!groupByProject || group === 'done') return items.map(slot => row(slot.entry, group, slot.role));
    const projects = state.nodes.filter(node => !node.resourceId && !node.projectId).sort((a, b) => (a.todoOrder ?? Infinity) - (b.todoOrder ?? Infinity));
    return [...projects.map(project => project.id as string | undefined), undefined].map(id => {
      const members = items.filter(slot => slot.entry.projectId === id); if (!members.length) return null;
      const project = id ? state.nodes.find(node => node.id === id) : undefined;
      return <div key={id ?? '_none'} className="todo-project-group" role="group" aria-label={`${project?.title ?? 'No project'} in ${LABELS[group]}`}>
        <h4><i style={{ background: project ? projectColor(project) : undefined }} aria-hidden="true" />{project?.title ?? 'No project'}</h4>
        {members.map(slot => row(slot.entry, group, slot.role))}
      </div>;
    });
  };
  const heading = (group: Group, count: number, extra?: React.ReactNode) => <h3 className="todo-group-heading">{LABELS[group]}<span className="todo-group-count">{count}</span>{extra}</h3>;
  const next = shown('next'), laterRows = shown('later'), doneRows = shown('done'), inboxRows = shown('inbox');
  const stale = canonical.later.filter(entry => untouchedDays(entry, now) >= LATER_AGE_DAYS);
  // The badge counts tickets waiting in From Linear to be taken; tickets marked Not for me are not in the inbox.
  const waiting = live.inbox.length;
  const empty = !canonical.inbox.length && !canonical.next.length && !canonical.later.length && !canonical.done.length;
  return <RailPanel slot="todos" label="To-dos" resizeLabel="Resize to-do list" className="todo-overlay" element="form" keepMounted open={open} close={close} closeLabel="Close to-do list" rootRef={panel} sheetRef={sheet}
    size={dimensions} defaultWidth={330} onSize={setDimensions} onResizing={active => { if (active) cancelCollapse(); setResizing(active); }} asideWidth={260}
    data={{ 'data-references': Boolean(referenceEntry), 'data-dragging': Boolean(move), 'data-map-dragging': !!dragId, 'data-drop-target': dropTarget === '' }}
    toggle={{ label: `${open && pinned ? 'Close to-dos' : 'Keep to-dos open'}${waiting ? `: ${waiting} in the inbox` : ''}`, title: `${waiting ? `${waiting} in the inbox · ` : ''}${open && pinned ? 'Kept open · Click to close · T toggles the list' : 'Rest here to peek · Click to keep open · T toggles the list'}`,
      badge: waiting > 0 && <span className="todo-triage-count todo-inbox-count" aria-hidden="true">{waiting}</span>,
      pressed: pinned, shortcut: `${shortcutKey('rail.todos')} ${shortcutKey('todos.toggle')}`, className: 'todo-toggle', icon: <ItemIcon icon="square-check" />, onClick: slotClick, onDwell: () => { cancelCollapse(); setOpen(true); } }}
    onSubmit={event => { event.preventDefault(); void newTodo(); }} onPointerEnter={() => { over.current = true; cancelCollapse(); }} onPointerLeave={() => { over.current = false; scheduleCollapse(); }}
    onPointerDownCapture={() => { keyboard.current = false; }} onKeyDownCapture={event => { keyboard.current = true; cancelCollapse(); if (event.key === 'Escape' && !(event.target as HTMLElement).closest('[data-inline-title], [data-todo-context-editor], .canvas-context')) close(); }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) { keyboard.current = false; scheduleCollapse(); } }}
    heading={<>
      <h2 className="todo-title">To-do</h2>
      <small className="todo-summary">{canonical.next.length} next · {canonical.later.length} later</small>
      <button type="button" className="todo-group-projects" tabIndex={open ? 0 : -1} aria-label="Group by project" aria-pressed={groupByProject} title={groupByProject ? 'Grouped by project · Click to list by when only' : 'Group Next and Later by project'} onClick={toggleGrouping}><PixelGlyph name="folder" size={12} /></button>
      <button type="button" className="todo-attach-control" tabIndex={open ? 0 : -1} aria-label="Attach map item to to-do" aria-expanded={choosing || Boolean(attaching)} title="Attach a map item" onClick={() => { cancelCollapse(); setAttaching(undefined); setChoosing(!choosing); }}><ItemIcon icon="link" /></button>
    </>}
    aside={referenceEntry && <section className="todo-reference-panel" aria-label={`Linked items for ${referenceEntry.title}`}>
      <header><strong>{referenceEntry.title}</strong><button type="button" aria-label="Close linked items" onClick={() => setReferences(undefined)}><PixelGlyph name="close" /></button></header>
      <div className="todo-reference-list">{referenceEntry.nodeIds.map(id => <div key={id}>
        <button type="button" onClick={() => showItem(id)}>{attachmentLabel(id)}</button>
        <button type="button" aria-label={`Detach ${state.nodes.find(node => node.id === id)?.title}`} title="Detach item" disabled={pending} onClick={() => { void commit(detachTodo(state, referenceEntry, id)); }}><ItemIcon icon="unlink" /></button>
      </div>)}</div>
    </section>}>
      {choosing && <div className="todo-choose-item"><PixelCombobox label="Item to attach" caption="Item" autoFocus defaultOpen value="" placeholder="Choose an item or project…" options={itemOptions(state.nodes, node => !isOffMap(node, state.nodes))}
        icon={option => <NodeIcon state={state} registry={registry} nodeId={option.value} />} change={value => { setAttaching(value); setChoosing(false); }} /></div>}
      {attaching && <div className="todo-attachment-hint">Choose a to-do for {state.nodes.find(node => node.id === attaching)?.title}<button type="button" aria-label="Cancel to-do attachment" onClick={() => setAttaching(undefined)}><PixelGlyph name="close" /></button></div>}
      <div className="todo-list" ref={list} onScroll={event => { scroll.current = event.currentTarget.scrollTop; clearTimeout(persistTimer.current); persistTimer.current = setTimeout(() => persistence.current(), 160); }}
        onDragLeave={event => { const current = moveRef.current; if (current?.target && !event.currentTarget.contains(event.relatedTarget as Node | null)) setMove({ ...current, target: undefined }); }}>
        {empty && <div className="todo-empty"><ItemIcon icon="square-check" /><p><strong>Nothing here yet</strong><span>Type below, or drag an item onto a to-do.</span></p></div>}
        {canonical.inbox.length > 0 && <section className="todo-group" data-group="inbox" aria-label={LABELS.inbox}>
          {heading('inbox', canonical.inbox.length, <button type="button" className="todo-group-fold" tabIndex={open ? 0 : -1} aria-expanded={inboxOpen} aria-label={`${inboxOpen ? 'Hide' : 'Show'} ${canonical.inbox.length} from Linear`} onClick={() => setInboxOpen(value => !value)}>{inboxOpen ? 'Hide' : 'Show'}</button>)}
          {inboxOpen && inboxRows.map(slot => row(slot.entry, 'inbox', slot.role))}
        </section>}
        {!empty && <>
          <section className="todo-group" data-group="next" aria-label={LABELS.next} data-drop-group={move?.target?.group === 'next' || undefined} {...dropZone('next')}>
            {heading('next', canonical.next.length)}
            {rows('next', next)}
            {!next.length && <p className="todo-hint">Drag something here, or press N on a row.</p>}
            {canonical.next.length > NEXT_SOFT_LIMIT && <p className="todo-limit" role="status">Next is getting long.<button type="button" disabled={pending} onClick={() => { const oldest = oldestTodo(canonical.next); if (oldest) void moveTo(oldest, 'later', 0); }}>Move the oldest to Later</button></p>}
          </section>
          <section className="todo-group" data-group="later" aria-label={LABELS.later} data-drop-group={move?.target?.group === 'later' || undefined} {...dropZone('later')}>
            {heading('later', canonical.later.length, <button type="button" className="todo-group-menu" tabIndex={open ? 0 : -1} aria-label="Later options" aria-haspopup="menu" onClick={event => {
              const host = panel.current?.offsetParent?.getBoundingClientRect(), box = event.currentTarget.getBoundingClientRect();
              cancelCollapse(); setMenu({ id: '_later', screen: { x: box.left - (host?.left ?? 0), y: box.bottom - (host?.top ?? 0) } });
            }}><PixelGlyph name="more" /></button>)}
            {rows('later', laterRows)}
            {!laterRows.length && <p className="todo-hint">Nothing for later.</p>}
          </section>
          <section className="todo-group" data-group="done" aria-label={LABELS.done} data-drop-group={move?.target?.group === 'done' || undefined} {...dropZone('done')}>
            {heading('done', canonical.done.length, canonical.done.length > 0 && <button type="button" className="todo-group-fold" tabIndex={open ? 0 : -1} aria-expanded={doneOpen} aria-label={`${doneOpen ? 'Fold' : 'Show'} ${canonical.done.length} done`} onClick={() => setDoneOpen(value => !value)}>{doneOpen ? 'Fold' : 'Show'}</button>)}
            {(doneOpen ? doneRows : doneRows.filter(slot => slot.role === 'gap')).map(slot => row(slot.entry, 'done', slot.role))}
            {(doneOpen || move) && <p className="todo-hint">{move && move.from !== 'done' ? 'Drop here to mark done.' : doneArchiveDays === undefined ? 'Done rows stay until you archive them.' : `Done rows go to Archive after ${doneArchiveDays} ${doneArchiveDays === 1 ? 'day' : 'days'}.`}</p>}
          </section>
        </>}
      </div>
      {error && <p role="alert">{error}</p>}
      {menu?.id === '_later' && panel.current?.offsetParent && createPortal(<CanvasMenu key={`later:${menu.screen.x}:${menu.screen.y}`} screen={menu.screen} actions={laterGroupActions(stale.length, LATER_AGE_DAYS)}
        act={action => { setMenu(undefined); if (action.id === 'archive-stale') void commit(stale.map(entry => archiveTodo(state, entry))); }} close={() => setMenu(undefined)} />, panel.current.offsetParent)}
      {menu && menuEntry && panel.current?.offsetParent && createPortal(<CanvasMenu key={`${menu.id}:${menu.screen.x}:${menu.screen.y}`} screen={menu.screen} actions={[sendToProjectAction(sendTargets(state, menuEntry)), ...todoContextActions(Boolean(menuEntry.context), contextPanel?.id === menuEntry.id)]}
        act={action => {
          setMenu(undefined);
          if (action.id.startsWith('send:')) void send(menuEntry, action.id.slice('send:'.length));
          else if (action.id === 'context-hide') setContextPanel(undefined);
          else if (action.id === 'context-show') setContextPanel({ id: menuEntry.id, mode: 'view' });
          else if (action.id === 'context-add') setContextPanel({ id: menuEntry.id, mode: 'edit' });
          else if (action.id === 'context-clear') setContextPanel({ id: menuEntry.id, mode: 'confirm' });
        }} close={() => setMenu(undefined)} />, panel.current.offsetParent)}
      <div className="todo-new"><input aria-label="New to-do" placeholder="Add to Next…" value={draft} maxLength={500} onChange={event => setDraft(event.target.value)} /><button className="todo-add" disabled={pending || !draft.trim()} aria-label="Add to-do" title="Add to-do · Enter"><ItemIcon icon="plus" /></button></div>
  </RailPanel>;
}
