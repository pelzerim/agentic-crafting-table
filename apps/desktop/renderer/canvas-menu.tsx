import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MenuAction, MenuActionId } from '../../../packages/core/context-menu.ts';
import { ItemIcon } from './icons.tsx';
import { canonical } from '../../../packages/core/control.ts';
import { ColorPicker } from './ui/color-picker.tsx';
import { useRecentColors } from './recent-colors.ts';

const ICONS: Partial<Record<MenuActionId, string>> = {
  open: 'open', connect: 'link', 'open-web': 'external', 'copy-url': 'copy', edit: 'settings', settings: 'settings', 'add-todo': 'square-check', 'remove-todo': 'square', 'auto-title': 'sparkles',
  complete: 'seen', reopen: 'refresh', below: 'undermap', surface: 'open', archive: 'archive', 'archive-browser': 'archive', 'new-item': 'plus', 'new-project': 'project',
  'remove-link': 'unlink', 'plot-auto': 'sparkles', 'make-blocking': 'link', 'make-normal': 'link', 'reverse-link': 'link', 'send-project': 'project', 'move-plot': 'sprout', 'plot-unpin': 'minus',
  'context-show': 'message-square', 'context-hide': 'message-square', 'context-add': 'message-square', 'standup-report': 'file-text',
};
/** Top-level rows lead with a 16px glyph; provider actions pick theirs from the action. */
/** What a person sees and would send, apart from each choice's fresh request id. */
const shape = (children: MenuAction[]) => canonical(children.map(action => action.mutation ? { ...action, mutation: { ...action.mutation, input: { ...action.mutation.input, requestId: undefined } } } : action));
const icon = (action: MenuAction) => ICONS[action.id] ?? (action.id.startsWith('convert:') ? 'refresh' : action.id.includes('review') ? 'review' : action.id.includes('merge') ? 'git-merge' : action.remote ? 'remote' : undefined);

export function CanvasMenu({ screen, avoid, actions, act, close, loadChoices, onHighlight, label = 'Context actions' }: {
  screen: { x: number; y: number }; actions: MenuAction[]; label?: string;
  /** An item's title row: the menu opens at the pointer but moves below or above it rather than covering it. */
  avoid?: { x: number; y: number; width: number; height: number };
  act(action: MenuAction): void; close(): void; /** `refreshed` replaces the entries while the submenu is open, when a saved answer was shown first. */
  loadChoices?(action: MenuAction, refreshed: (children: MenuAction[]) => void): Promise<MenuAction[]>;
  /** Hovered/focused options may point at map items and connections. */
  onHighlight?(highlight: MenuAction['highlight']): void;
}) {
  const root = useRef<HTMLDivElement>(null), menu = useRef<HTMLDivElement>(null), child = useRef<HTMLDivElement>(null);
  const [submenu, setSubmenu] = useState<MenuActionId>();
  const focusChild = useRef(false), trigger = useRef<HTMLButtonElement | null>(null);
  const group = actions.find(action => action.id === submenu);
  const [loaded, setLoaded] = useState<{ id: MenuActionId; children: MenuAction[] }>();
  const irreversible = Boolean(group?.choices?.irreversible && loaded?.id === group.id);
  // The loaded question is the confirmation when the type says a pick answers it.
  const asks = irreversible && !(group?.choices?.pickConfirms && loaded?.children.some(child => child.id === 'plugin:choice-prompt'));
  const [confirming, setConfirming] = useState<MenuActionId>(), [confirmText, setConfirmText] = useState(''), [confirmPick, setConfirmPick] = useState<string>();
  const { recent, remember } = useRecentColors();
  const children = group?.choices ? loaded?.id === group.id ? [...(irreversible ? [{ id: 'plugin:cancel' as const, label: 'Cancel' }] : []), ...loaded.children] : [{ id: 'plugin:loading' as const, label: group.choices.loadingLabel ?? 'Loading statuses…', disabled: true }] : group?.children;
  useEffect(() => setConfirming(undefined), [submenu]);
  useLayoutEffect(() => { setConfirmText(''); setConfirmPick(undefined); if (confirming) child.current?.querySelector<HTMLElement>('[data-confirm-text], [data-confirm-back]')?.focus(); }, [confirming]);
  /** A confirmation's pick: one radio per answer, the first checked, then the picked answer's plan and foot. */
  const pickOf = (pick: NonNullable<NonNullable<MenuAction['confirm']>['pick']>) => {
    const picked = pick.options.find(option => option.id === confirmPick) ?? pick.options[0];
    return <>
      <div className="resource-choice-pick" role="radiogroup" aria-label={pick.label}>
        {pick.options.map(option => <label key={option.id}><input type="radio" name="canvas-menu-pick" value={option.id} checked={option.id === picked.id} onChange={() => setConfirmPick(option.id)} /><span>{option.label}</span>{option.note && <small>{option.note}</small>}</label>)}
      </div>
      {picked.plan?.length ? <dl className="resource-choice-plan">{picked.plan.map(row => <div key={row.name} style={{ display: 'contents' }}><dt>{row.name}</dt><dd data-tone={row.tone}>{row.text}</dd></div>)}</dl> : null}
      {picked.foot && <p className="resource-choice-foot">{picked.foot}</p>}
    </>;
  };
  const confirmSubject = (action: MenuAction) => { const options = loaded?.children.filter(option => option.mutation) ?? [], prompt = loaded?.children.find(option => option.id === 'plugin:choice-prompt'); return options.length === 1 && prompt ? prompt.label : `${action.label}?`; };
  useEffect(() => {
    if (!group?.choices || !loadChoices) return;
    let disposed = false, shown = ''; setLoaded(undefined);
    // Changed entries end a confirmation in progress and focus the list again; unchanged ones are swapped in place.
    const refreshed = (children: MenuAction[]) => {
      if (disposed) return;
      if (shape(children) !== shown) { focusChild.current = Boolean(child.current?.contains(document.activeElement)); setConfirming(undefined); }
      shown = shape(children); setLoaded({ id: group.id, children });
    };
    void loadChoices(group, refreshed).then(children => { if (!disposed) { shown = shape(children); setLoaded({ id: group.id, children }); } })
      .catch(error => { if (!disposed) setLoaded({ id: group.id, children: [{ id: 'plugin:error', label: error.message ?? String(error), disabled: true }] }); });
    return () => { disposed = true; };
  }, [submenu]);
  const open = (action: MenuAction, button: HTMLButtonElement, focus: boolean) => {
    trigger.current = button; focusChild.current = focus; setSubmenu(action.id);
    if (focus && action.id === submenu) { const first = child.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'); if (first) { first.focus(); focusChild.current = false; } }
  };
  const back = () => { setSubmenu(undefined); trigger.current?.focus(); };
  useLayoutEffect(() => { menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }, []);
  useLayoutEffect(() => {
    if (group && focusChild.current && (!group.choices || loaded?.id === group.id)) { child.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); focusChild.current = false; }
    const panel = menu.current!, host = root.current!, parent = host.offsetParent as HTMLElement;
    const fit = () => {
      // Flip away from an edge instead of sliding back over what was clicked.
      const flip = (at: number, size: number, room: number) => at + size > room - 12 && at - size >= 12 ? at - size : at;
      const x = Math.round(Math.max(12, Math.min(flip(screen.x, panel.offsetWidth, parent.clientWidth), parent.clientWidth - panel.offsetWidth - 12)));
      let y = Math.round(Math.max(12, Math.min(flip(screen.y, panel.offsetHeight, parent.clientHeight), parent.clientHeight - panel.offsetHeight - 12)));
      if (avoid && x < avoid.x + avoid.width && avoid.x < x + panel.offsetWidth && y < avoid.y + avoid.height && avoid.y < y + panel.offsetHeight) {
        const below = Math.round(avoid.y + avoid.height + 4), above = Math.round(avoid.y - 4 - panel.offsetHeight);
        // A menu too tall for either side stays in view over the item rather than running off the map.
        y = below + panel.offsetHeight <= parent.clientHeight - 12 ? below : above >= 12 ? above : y;
      }
      host.style.left = `${x}px`; host.style.top = `${y}px`; panel.style.maxHeight = `${parent.clientHeight - 24}px`;
      if (child.current) {
        const sub = child.current;
        sub.style.maxHeight = `${parent.clientHeight - 24}px`;
        sub.style.left = `${x + panel.offsetWidth + sub.offsetWidth - 4 <= parent.clientWidth - 12 ? panel.offsetWidth - 4 : -sub.offsetWidth + 4}px`;
        const row = trigger.current?.getBoundingClientRect(), hostBounds = host.getBoundingClientRect();
        sub.style.top = `${Math.max(12 - y, Math.min((row?.top ?? hostBounds.top) - hostBounds.top - 6, parent.clientHeight - y - sub.offsetHeight - 12))}px`;
      }
    };
    const observer = new ResizeObserver(fit); observer.observe(panel); observer.observe(parent); if (child.current) observer.observe(child.current); fit();
    return () => observer.disconnect();
  }, [screen.x, screen.y, avoid, group, loaded]);
  const keyboard = (event: React.KeyboardEvent<HTMLDivElement>, nested: boolean) => {
    if (event.key !== 'Escape' && event.target instanceof HTMLTextAreaElement) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([data-row-rest])')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const direction = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (direction || event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); event.stopPropagation();
      if (!nested) setSubmenu(undefined);
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + direction + buttons.length) % buttons.length]?.focus();
    }
    if (nested && (event.key === 'ArrowLeft' || event.key === 'Escape')) { event.preventDefault(); event.stopPropagation(); back(); }
    else if (event.key === 'ArrowRight' && !nested) {
      const action = actions[index]; if (action?.children) { event.preventDefault(); event.stopPropagation(); open(action, buttons[index], true); }
    } else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(); }
  };
  /** A row of colours is the shared picker in its compact form: one Up/Down stop, Left/Right within it. */
  const row = (action: MenuAction, choices: NonNullable<MenuAction['row']>, nested: boolean) =>
    <div className="canvas-menu-row" onPointerEnter={() => { if (!nested) setSubmenu(undefined); }}>
      <span className="canvas-menu-row-label" aria-hidden="true">{action.label}</span>
      <ColorPicker compact label={action.label} custom={Boolean(action.customColor)} recent={recent} onRecent={remember}
        presets={choices.map(choice => ({ id: choice.value, label: choice.label, color: choice.swatch ?? 'var(--act-control)' }))}
        value={choices.find(choice => choice.checked)?.value ?? action.customColor?.shown}
        onChange={next => act({ ...action, value: 'custom' in next ? next.custom : next.id })} />
    </div>;
  const entries = (items: MenuAction[], nested = false) => items.map(action => <div key={action.id}>
    {action.divider && <div role="separator" />}
    {action.row ? row(action, action.row, nested) : nested && confirming === action.id ? <div className="canvas-menu-confirm" role="group" aria-label={action.label}>
      <p><b>{action.confirm?.prompt ?? confirmSubject(action)}</b>{action.confirm ? action.confirm.note ? ` ${action.confirm.note}` : '' : ' This can’t be undone from here.'}</p>
      {action.confirm?.text && <label className="resource-choice-text">{action.confirm.text.label}
        <textarea data-confirm-text rows={3} maxLength={action.confirm.text.maxLength} placeholder={action.confirm.text.placeholder} value={confirmText} onChange={event => setConfirmText(event.target.value)} /></label>}
      {action.confirm?.pick && pickOf(action.confirm.pick)}
      <button role="menuitem" tabIndex={-1} data-confirm-back onClick={() => { setConfirming(undefined); requestAnimationFrame(() => child.current?.querySelector<HTMLButtonElement>(`[data-action="${CSS.escape(action.id)}"]`)?.focus()); }}>Back</button>
      <button role="menuitem" tabIndex={-1} className="canvas-menu-go" onClick={() => {
        const field = action.confirm?.text?.field, pick = action.confirm?.pick;
        const extra = { ...(field && confirmText.trim() ? { [field]: confirmText } : {}), ...(pick && confirmPick ? { [pick.field]: confirmPick } : {}) };
        act(Object.keys(extra).length && action.mutation ? { ...action, mutation: { ...action.mutation, input: { ...action.mutation.input, ...extra } } } : action);
      }}>{action.confirm?.action ?? 'Confirm'}</button>
    </div> : <button data-action={action.id} role={action.checked === undefined ? "menuitem" : "menuitemradio"} aria-label={action.checked === undefined ? undefined : action.label} aria-checked={action.checked} disabled={action.disabled && !action.highlight || Boolean(nested && confirming && confirming !== action.id)} aria-disabled={action.disabled && action.highlight ? true : undefined} tabIndex={-1} title={action.description} data-destructive={action.destructive || undefined} data-remote={action.remote || undefined}
      aria-haspopup={action.children ? 'menu' : undefined} aria-expanded={action.children ? submenu === action.id : undefined}
      onPointerEnter={event => { onHighlight?.(action.highlight); if (action.children) open(action, event.currentTarget, false); else if (!nested) setSubmenu(undefined); }}
      onPointerLeave={() => onHighlight?.(undefined)} onFocus={() => onHighlight?.(action.highlight)} onBlur={() => onHighlight?.(undefined)}
      onClick={event => action.children ? open(action, event.currentTarget, true) : action.disabled ? undefined : action.id === 'plugin:cancel' ? close() : nested && (asks || action.confirm) && action.mutation ? setConfirming(action.id) : act(action)}>
      {!nested && <span className="canvas-menu-icon">{icon(action) && <ItemIcon icon={icon(action)} />}</span>}
      <span className="canvas-menu-label">{action.label}</span>{action.remote && <span className="canvas-menu-remote" title="Writes to the provider"><ItemIcon icon="remote" size={8} /></span>}{action.children && <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M3 1h2v2h2v2h2v2H7v2H5v2H3V9h2V7h2V5H5V3H3Z" /></svg>}
    </button>}
  </div>);
  return <div className="canvas-context" ref={root} style={{ left: screen.x, top: screen.y }}>
    <div ref={menu} className="canvas-menu" role="menu" aria-label={label} onKeyDown={event => keyboard(event, false)}>{entries(actions)}</div>
    {group && children && <div ref={child} className="canvas-menu canvas-submenu" role="menu" aria-label={group.label} onKeyDown={event => keyboard(event, true)}>{entries(children, true)}</div>}
  </div>;
}
