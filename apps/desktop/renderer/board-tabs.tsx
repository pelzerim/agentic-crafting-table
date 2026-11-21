import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { BoardRecord } from '../../../src/graph/boards.ts';
import { PROJECT_COLORS } from '../../../src/graph/project-colors.ts';
import type { MenuAction } from '../../../packages/core/context-menu.ts';
import { CanvasMenu } from './canvas-menu.tsx';
import { ItemIcon } from './icons.tsx';
import { shortcutKey } from './shortcuts.ts';

/** The tabs above the map once there are two boards: one per board, its Needs me count, and + for a new one. */
export function BoardTabs({ boards, current, needs, rename, renamed, show, create, save, remove }: {
  boards: readonly BoardRecord[]; current: string; needs: Readonly<Record<string, number>>; rename?: string; renamed(): void;
  show(id: string): void; create(): Promise<BoardRecord | undefined>; save(board: BoardRecord): void; remove(id: string): void;
}) {
  const [renaming, setRenaming] = useState<string>(), [draft, setDraft] = useState('');
  const [menu, setMenu] = useState<{ id: string; screen: { x: number; y: number } }>();
  const strip = useRef<HTMLElement>(null);
  const startRename = (board: BoardRecord) => { setMenu(undefined); setRenaming(board.id); setDraft(board.name); };
  const finishRename = (event?: FormEvent) => {
    event?.preventDefault();
    const board = boards.find(candidate => candidate.id === renaming), name = draft.trim().slice(0, 40);
    setRenaming(undefined);
    if (board && name && name !== board.name) save({ ...board, name });
  };
  // A board made from the ground menu starts with its name selected.
  useEffect(() => { const board = boards.find(candidate => candidate.id === rename); if (board) { startRename(board); renamed(); } }, [rename, boards]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => { if (!(event.target as HTMLElement).closest('.canvas-context')) setMenu(undefined); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(undefined); };
    document.addEventListener('pointerdown', dismiss, true); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('keydown', escape); };
  }, [menu]);
  const menuBoard = menu && boards.find(board => board.id === menu.id);
  const actions: MenuAction[] = menuBoard ? [
    { id: 'board-rename', label: 'Rename board' },
    { id: 'board-color', label: 'Colour', row: [{ value: '', label: 'No colour', checked: !menuBoard.color }, ...PROJECT_COLORS.map(preset => ({ value: preset.color, label: preset.label, swatch: preset.color, checked: preset.color === menuBoard.color }))], customColor: { shown: menuBoard.color } },
    { id: 'board-delete', label: 'Delete board', destructive: true, divider: true, ...(boards.length < 2 ? { disabled: true, description: 'The last board cannot be deleted' } : {}) },
  ] : [];
  const openMenu = (id: string, at: { x: number; y: number }) => { const host = strip.current?.offsetParent?.getBoundingClientRect(); setMenu({ id, screen: { x: at.x - (host?.left ?? 0), y: at.y - (host?.top ?? 0) } }); };
  return <>
    <nav ref={strip} className="board-tabs" aria-label="Boards">
      <div role="tablist" aria-label="Boards">
        {boards.map((board, index) => {
          const count = needs[board.id] ?? 0, selected = board.id === current;
          if (renaming === board.id) return <form key={board.id} className="board-tab" data-selected={selected || undefined} onSubmit={finishRename}>
            <input autoFocus onFocus={event => event.currentTarget.select()} aria-label="Board name" maxLength={40} value={draft} onChange={event => setDraft(event.target.value)} onBlur={() => finishRename()} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setRenaming(undefined); } }} />
          </form>;
          return <button key={board.id} type="button" role="tab" className="board-tab" aria-selected={selected} data-selected={selected || undefined}
            title={index < 9 ? `${board.name} (${shortcutKey('board.1').replace('1–9', String(index + 1))})` : board.name}
            onClick={() => show(board.id)} onDoubleClick={() => startRename(board)}
            onContextMenu={event => { event.preventDefault(); event.stopPropagation(); openMenu(board.id, { x: event.clientX, y: event.clientY }); }}>
            {board.color && <i className="board-tab-color" style={{ background: board.color }} aria-hidden="true" />}
            <span className="board-tab-name">{board.name}</span>
            {count > 0 && <span className="board-tab-count" aria-label={`Needs me: ${count}`}>{count}</span>}
          </button>;
        })}
      </div>
      <button type="button" className="board-tab-add" aria-label="New board" title="New board" onClick={() => { void create().then(board => { if (board) { setRenaming(board.id); setDraft(board.name); } }); }}><ItemIcon icon="plus" /></button>
    </nav>
    {menu && menuBoard && <CanvasMenu key={menu.id} label="Board actions" screen={menu.screen} actions={actions} close={() => setMenu(undefined)}
      act={action => {
        setMenu(undefined);
        if (action.id === 'board-rename') startRename(menuBoard);
        else if (action.id === 'board-delete') remove(menuBoard.id);
        else if (action.id === 'board-color') { const { color: _, ...rest } = menuBoard, value = (action as MenuAction & { value?: string }).value; save(value ? { ...rest, color: value } : rest); }
      }} />}
  </>;
}
