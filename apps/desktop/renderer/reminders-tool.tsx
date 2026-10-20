import { useEffect, useRef, useState } from 'react';
import { WEEKDAYS, scheduleWords } from '../../../packages/core/reminders.ts';
import type { Reminder, ReminderDue, RemindersSnapshot, Weekday } from '../../../packages/core/reminders.ts';
import { RailPanel, SHEET_ORIGIN } from './rail-panel.tsx';
import type { PanelSize } from './rail-panel.tsx';
import { useRailTool } from './rail-state.ts';
import { railSlot } from './tool-rail.tsx';
import { shortcutKey, useWorkspaceShortcuts } from './shortcuts.ts';
import { ItemIcon } from './icons.tsx';
import { Button } from './ui/button.tsx';
import { PixelGlyph } from './ui/pixel-glyph.tsx';
import { WEEKDAY_DAYS, addRule, draftProblem, newReminderDraft, noticeReminders, railReminders, reminderStateWords, removeRule, setRuleDays, toggleRuleDay } from './reminder-view.ts';

const DAY_WORDS: Record<Weekday, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
type Editing = { draft: Reminder; added: boolean };

function useWindowFocus() {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const focus = () => setFocused(true), blur = () => setFocused(false);
    window.addEventListener('focus', focus); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('focus', focus); window.removeEventListener('blur', blur); };
  }, []);
  return focused;
}
/** Re-renders each half minute so "in 2 h 15" keeps counting down between snapshots. */
function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  return now;
}

/** Daily reminders as a rail tool (MAP-REMINDERS): the slot shows what is due, the sheet lists and
 * edits reminders, and a notice beside the slot offers Done and Snooze while the window is in front. */
export function RemindersTool({ reminders, size, onSize }: { reminders?: RemindersSnapshot; size: PanelSize; onSize(size: PanelSize): void }) {
  const { rail, open, pinned } = useRailTool('reminders');
  const setOpen = (value: boolean) => { if (value) rail.open('reminders'); else rail.close('reminders'); };
  // A call's own answer shows until the next broadcast snapshot, which already carries it.
  const [answer, setAnswer] = useState<RemindersSnapshot>();
  useEffect(() => setAnswer(undefined), [reminders]);
  const shown = answer ?? reminders, list = shown?.list ?? [], today = shown?.today ?? [];
  const [editing, setEditing] = useState<Editing>(), [error, setError] = useState(''), [pending, setPending] = useState(false);
  const [events, setEvents] = useState<ReadonlyMap<string, ReminderDue>>(new Map()), [dismissed, setDismissed] = useState<ReadonlyMap<string, number>>(new Map());
  const [pulse, setPulse] = useState(0), [noticeError, setNoticeError] = useState('');
  const focused = useWindowFocus(), now = useMinuteClock();
  const root = useRef<HTMLElement>(null), closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined), [draftSize, setDraftSize] = useState<PanelSize>(), [resizing, setResizing] = useState(false);
  useEffect(() => window.craftingTable.onReminderDue(event => {
    setEvents(current => new Map(current).set(event.reminder.id, event)); setPulse(value => value + 1);
  }), []);
  const { due, snoozed } = railReminders(today);
  const notice = noticeReminders(shown, events, dismissed)[0];
  useEffect(() => setNoticeError(''), [notice?.reminder.id, notice?.firing]);
  const close = () => {
    clearTimeout(closeTimer.current);
    if (root.current?.querySelector('.rail-panel-sheet')?.contains(document.activeElement)) root.current.querySelector<HTMLElement>('.rail-panel-toggle')?.focus();
    rail.unpin('reminders'); setOpen(false);
  };
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      closeRef.current();
    };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [open]);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const slotClick = () => { clearTimeout(closeTimer.current); if (open && pinned) close(); else rail.pin('reminders'); };
  useWorkspaceShortcuts({ 'rail.reminders': slotClick });
  const leave = () => {
    clearTimeout(closeTimer.current);
    if (pinned || resizing || editing) return;
    closeTimer.current = setTimeout(() => { if (!root.current?.querySelector('.rail-panel-sheet')?.contains(document.activeElement)) setOpen(false); }, 240);
  };
  const call = async (request: () => Promise<RemindersSnapshot>, fail: (message: string) => void) => {
    setPending(true); fail('');
    try { setAnswer(await request()); return true; } catch (failure) { fail((failure as Error).message); return false; } finally { setPending(false); }
  };
  const act = (id: string, action: 'done' | 10 | 30, fail: (message: string) => void = setError) => call(() => action === 'done' ? window.craftingTable.remindersDone(id) : window.craftingTable.remindersSnooze(id, action), fail);
  const save = (next: Reminder[]) => call(() => window.craftingTable.remindersSave(next), setError);
  const edit = (draft: Reminder, added = false) => { setError(''); setEditing({ draft, added }); rail.pin('reminders'); };
  const change = (patch: Partial<Reminder>) => setEditing(current => current && { ...current, draft: { ...current.draft, ...patch } });
  const submit = async () => {
    if (!editing) return;
    const problem = draftProblem(editing.draft);
    if (problem) { setError(problem); return; }
    const next = editing.added ? [...list, editing.draft] : list.map(reminder => reminder.id === editing.draft.id ? editing.draft : reminder);
    if (await save(next)) setEditing(undefined);
  };
  const remove = async (id: string) => { if (await save(list.filter(reminder => reminder.id !== id))) setEditing(undefined); };
  const cancel = () => { setEditing(undefined); setError(''); };
  const shownSize = draftSize ?? size;
  const actions = (reminder: Reminder, state: string, fail?: (message: string) => void) => <>
    <Button variant="primary" size="sm" disabled={pending} aria-label={`Mark ${reminder.label} done`} onClick={() => { void act(reminder.id, 'done', fail); }}>Done</Button>
    {state === 'due' && <>
      <Button size="sm" disabled={pending} aria-label={`Snooze ${reminder.label} 10 minutes`} onClick={() => { void act(reminder.id, 10, fail); }}>Snooze 10</Button>
      <Button size="sm" disabled={pending} aria-label={`Snooze ${reminder.label} 30 minutes`} onClick={() => { void act(reminder.id, 30, fail); }}>30 min</Button>
    </>}
  </>;
  const editor = ({ draft, added }: Editing) => <div className="reminders-editor" data-reminder-id={draft.id} role="group" aria-label={added ? 'New reminder' : `Edit ${list.find(reminder => reminder.id === draft.id)?.label ?? draft.label}`}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
    <input className="reminders-name" aria-label="Name" placeholder="Name, like Stretch" value={draft.label} maxLength={400} autoFocus onChange={event => change({ label: event.target.value })}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void submit(); } }} />
    {draft.rules.map((rule, index) => <div key={index} className="reminders-rule" role="group" aria-label={`Time ${index + 1}`}>
      <div className="reminders-days">{WEEKDAYS.map(day => <button key={day} type="button" className="reminders-day" aria-pressed={rule.days.includes(day)} onClick={() => change({ rules: toggleRuleDay(draft.rules, index, day) })}>{DAY_WORDS[day]}</button>)}</div>
      <div className="reminders-rule-tools">
        <button type="button" onClick={() => change({ rules: setRuleDays(draft.rules, index, WEEKDAY_DAYS) })}>Weekdays</button>
        <button type="button" onClick={() => change({ rules: setRuleDays(draft.rules, index, WEEKDAYS) })}>Daily</button>
        <input type="time" aria-label="Time" value={rule.time} required onChange={event => change({ rules: draft.rules.map((other, position) => position === index ? { ...other, time: event.target.value } : other) })} />
        {draft.rules.length > 1 && <button type="button" className="reminders-remove-rule" aria-label={`Remove time ${index + 1}`} title="Remove this time" onClick={() => change({ rules: removeRule(draft.rules, index) })}><PixelGlyph name="close" /></button>}
      </div>
    </div>)}
    <button type="button" className="reminders-add-rule" onClick={() => change({ rules: addRule(draft.rules) })}>+ another time</button>
    <div className="reminders-editor-actions">
      <label className="reminders-switch"><input type="checkbox" role="switch" checked={draft.enabled} onChange={event => change({ enabled: event.target.checked })} />On</label>
      {!added && <Button variant="danger" size="sm" disabled={pending} aria-label={`Delete ${draft.label}`} onClick={() => { void remove(draft.id); }}>Delete</Button>}
      <span className="reminders-spacer" />
      <Button size="sm" onClick={cancel}>Cancel</Button>
      <Button variant="primary" size="sm" disabled={pending} onClick={() => { void submit(); }}>Save</Button>
    </div>
  </div>;
  return <>
    <RailPanel slot="reminders" label="Reminders" className="reminders-tool" role="dialog" rootRef={root} open={open} close={close} closeLabel="Close reminders" size={shownSize} defaultWidth={380}
      onSize={next => { if (resizing) setDraftSize(next); else onSize(next); }} onResizing={active => { setResizing(active); if (active) { clearTimeout(closeTimer.current); setDraftSize(size); } else { if (draftSize) onSize(draftSize); setDraftSize(undefined); } }}
      onPointerEnter={() => clearTimeout(closeTimer.current)} onPointerLeave={leave}
      data={{ 'data-due': due > 0 || undefined, 'data-snoozed': (!due && snoozed) || undefined }}
      toggle={{ label: due ? `Reminders: ${due} due` : 'Reminders', title: 'Reminders · daily nudges at set times', pressed: pinned, className: 'reminders-toggle',
        shortcut: shortcutKey('rail.reminders'), onClick: slotClick, onDwell: () => { clearTimeout(closeTimer.current); setOpen(true); },
        icon: <ItemIcon icon="bell" />,
        badge: <>{(due > 0 || snoozed) && <i className="reminders-dot" aria-hidden="true" />}{due > 0 && <span className="reminders-count" aria-hidden="true">{due}</span>}{pulse > 0 && due > 0 && <i key={pulse} className="reminders-pulse" aria-hidden="true" />}</> }}
      heading={<h2 className="reminders-title">Reminders</h2>}>
      <ul className="reminders-list">{list.map((reminder, index) => {
        if (editing?.draft.id === reminder.id && !editing.added) return <li key={reminder.id}>{editor(editing)}</li>;
        const entry = today[index]?.reminderId === reminder.id ? today[index] : undefined, state = entry?.state ?? (reminder.enabled ? 'none' : 'off');
        return <li key={reminder.id} className="reminders-row" data-reminder-id={reminder.id} data-state={state}>
          <span className="reminders-label">{reminder.label}</span>
          <button type="button" className="reminders-edit" aria-label={`Edit ${reminder.label}`} title="Edit" disabled={pending} onClick={() => edit(structuredClone(reminder))}><PixelGlyph name="more" /></button>
          <span className="reminders-schedule">{scheduleWords(reminder.rules)}</span>
          <span className="reminders-state"><span>{entry ? reminderStateWords(entry, now) : reminder.enabled ? 'Not today' : 'Off'}</span>{(state === 'due' || state === 'snoozed') && actions(reminder, state)}</span>
        </li>;
      })}{editing?.added && <li>{editor(editing)}</li>}</ul>
      {!list.length && !editing && <p className="reminders-empty">No reminders yet.</p>}
      {error && <p className="reminders-error" role="alert">{error}</p>}
      {!editing?.added && <button type="button" className="reminders-add" disabled={pending} onClick={() => edit(newReminderDraft(crypto.randomUUID()), true)}>+ Add a reminder</button>}
    </RailPanel>
    {notice && focused && !open && <div className="reminders-notice" role="status" aria-label={`Reminder: ${notice.reminder.label}`} style={{ left: SHEET_ORIGIN.x, top: railSlot('reminders').y }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDismissed(current => new Map(current).set(notice.reminder.id, notice.firing)); } }}>
      <strong>{notice.reminder.label}</strong>
      <span className="reminders-notice-time">{notice.time} · {scheduleWords(notice.reminder.rules)}</span>
      <span className="reminders-notice-actions">{actions(notice.reminder, 'due', setNoticeError)}</span>
      {noticeError && <span className="reminders-error" role="alert">{noticeError}</span>}
    </div>}
  </>;
}
