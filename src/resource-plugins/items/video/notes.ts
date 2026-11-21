import type { JsonObject, RelatedResourceItem, ResourceRecord, ResourceViewServices } from '../../types.ts';
import { formatWhen } from '../../format-when.ts';
import { VIDEO_NOTES_LIMIT } from './source.ts';

const STAMP = /\[(\d{1,3}):([0-5]\d)\]/g;
export const timeStamp = (seconds: number) => { const whole = Math.max(0, Math.floor(seconds)); return `[${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}]`; };

/** Where the player is and how to move it; either rejects or yields undefined while the player is not ready. */
export interface VideoClock { time(): Promise<number | undefined>; seek(seconds: number): Promise<void> }

type Sent = { to: string; at: string; fingerprint: string };
const fingerprint = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))).map(byte => byte.toString(16).padStart(2, '0')).join('');
/** A recorded send, only while the notes are the draft that was delivered. */
const sentFor = async (value: unknown, notes: string): Promise<Sent | undefined> => {
  const entry = value as Sent | undefined;
  return entry && typeof entry === 'object' && typeof entry.to === 'string' && typeof entry.at === 'string' && entry.fingerprint === await fingerprint(notes) ? entry : undefined;
};
const notesOf = (data: JsonObject) => typeof data.notes === 'string' ? data.notes : '';

/** The Notes panel beside the player: a draft saved into the item, `[mm:ss]` stamps that seek, and Send to agent. */
export function mountVideoNotes(document: Document, resource: ResourceRecord, services: ResourceViewServices, clock: VideoClock) {
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
  const panel = element('section', '', 'video-notes'), text = element('textarea', '', 'video-notes-text'), controls = element('div', '', 'pr-comment-controls');
  const addTime = element('button', 'Add time'), agents = element('select'), send = element('button', 'Send to agent ▸');
  const stamps = element('ul', '', 'video-notes-stamps'), feedback = element('small', '', 'pr-comment-feedback'), clear = element('button', 'Clear');
  const resolve = element('div', '', 'pr-comment-controls'), keep = element('button', 'Keep my draft'), useSaved = element('button', 'Use saved notes');
  panel.setAttribute('aria-label', 'Video notes');
  for (const button of [addTime, send, clear, keep, useSaved]) button.type = 'button';
  text.maxLength = VIDEO_NOTES_LIMIT; text.setAttribute('aria-label', 'Notes'); text.placeholder = 'Type while you watch. Add time puts [mm:ss] at the cursor.';
  text.value = notesOf(resource.data);
  agents.setAttribute('aria-label', 'Agent for notes'); clear.hidden = true;
  feedback.setAttribute('role', 'status');
  controls.append(addTime, agents, send, clear);
  resolve.hidden = true; resolve.append(keep, useSaved);
  panel.append(text, controls, feedback, resolve, stamps);

  // `confirmed` is the notes known saved; `queuedText` the newest draft handed to a save; `latest` the item's notes as last observed.
  let confirmed = text.value, queuedText: string | undefined = text.value, latest = text.value, conflict = false;
  let sent: Sent | undefined, sending = false, sends = 0, queued = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let related: RelatedResourceItem[] = [], offRelated: (() => void) | undefined, observed: JsonObject | undefined = resource.data;
  const showConflict = () => { resolve.hidden = !conflict; if (conflict) feedback.textContent = 'The saved notes changed elsewhere. Keep your draft or use the saved notes.'; };
  // One save at a time, each reading the item's latest revision. A notes save writes only over the notes known saved, and none runs after a conflict.
  let chain: Promise<boolean> = Promise.resolve(true);
  const save = (patch: JsonObject, notes?: string) => {
    queued++;
    return chain = chain.then(async () => {
      let ok = false;
      try {
        if (notes !== undefined && conflict) return false;
        if (await services.saveData?.(patch, notes !== undefined ? { notes: confirmed || null } : undefined) === false) { conflict = true; showConflict(); return false; }
        if (notes !== undefined) confirmed = notes;
        // What was observed before this write is older than it.
        observed = undefined;
        return ok = true;
      } catch { feedback.textContent = 'Notes could not be saved.'; return false; }
      finally {
        queued--;
        if (!ok && notes !== undefined) queuedText = undefined;
        if (observed) void adopt(observed);
      }
    });
  };
  // Resolves true once the draft on screen is saved.
  const flush = (): Promise<boolean> => {
    clearTimeout(timer); timer = undefined;
    if (conflict) { showConflict(); return Promise.resolve(false); }
    if (text.value !== queuedText) { const value = queuedText = text.value; void save({ notes: value || null }, value); }
    return chain.then(() => !conflict && text.value === confirmed);
  };
  const showSent = () => {
    panel.dataset.sent = String(Boolean(sent)); clear.hidden = !sent;
    if (sent) feedback.textContent = `Sent to ${sent.to} · ${formatWhen(sent.at, 'stamp')}`;
  };
  const renderStamps = () => {
    const found = text.value.split('\n').flatMap(line => [...line.matchAll(STAMP)].map(match => ({ seconds: Number(match[1]) * 60 + Number(match[2]), stamp: match[0], line: line.trim() }))).slice(0, 200);
    stamps.replaceChildren(...found.map(entry => {
      const item = element('li'), jump = element('button', entry.line.length > 80 ? `${entry.line.slice(0, 79)}…` : entry.line);
      jump.type = 'button'; jump.title = `Play from ${entry.stamp}`;
      jump.onclick = () => { void clock.seek(entry.seconds).catch(() => { feedback.textContent = 'The player is not ready yet.'; }); };
      item.append(jump); return item;
    }));
    stamps.hidden = !found.length;
  };
  const updateAgents = () => {
    const linked = related.filter(item => item.resource?.pluginId === 'agent.session'), selected = agents.value;
    agents.replaceChildren(...linked.map(item => { const option = element('option', item.title); option.value = item.nodeId; return option; }));
    if (linked.some(item => item.nodeId === selected)) agents.value = selected;
    agents.hidden = linked.length < 2; send.hidden = !linked.length;
    const target = linked.find(item => item.nodeId === agents.value), ready = target && target.activity === 'idle' && target.attention !== 'input' && Boolean(target.resource?.data.sessionId);
    send.disabled = sending || Boolean(sent) || !ready || !text.value.trim(); addTime.disabled = clear.disabled = sending;
    send.title = sent ? 'Sent. Edit the notes to send them again.' : !ready ? 'Wait until the agent is ready for a new prompt.' : !text.value.trim() ? 'Write some notes first' : `Send these notes to ${target.title}`;
  };
  // An editor with no unsaved typing shows the item's latest notes.
  const idle = () => !sending && !queued && !conflict && timer === undefined && text.value === confirmed;
  const take = (notes: string) => { const at = Math.min(text.selectionStart, notes.length); text.value = confirmed = queuedText = notes; text.setSelectionRange(at, at); };
  const adopt = async (data: JsonObject) => {
    const notes = latest = notesOf(data);
    if (!idle()) return;
    const next = await sentFor(data.notesSent, notes);
    if (!idle() || observed !== data) return;
    if (text.value !== notes) take(notes);
    if (!next && sent) feedback.textContent = '';
    sent = next; showSent(); renderStamps(); updateAgents();
  };
  const changed = () => {
    if (sent) { sent = undefined; feedback.textContent = ''; void save({ notesSent: null }); }
    clearTimeout(timer); timer = conflict ? undefined : setTimeout(() => void flush(), 500);
    showSent(); renderStamps(); updateAgents();
  };
  text.oninput = changed;
  agents.onchange = updateAgents;
  addTime.onclick = async () => {
    if (sending) return;
    const round = sends, seconds = await clock.time().catch(() => undefined);
    // A send started meanwhile owns the draft.
    if (sending || sends !== round) return;
    if (seconds === undefined) { feedback.textContent = 'The player is not ready yet.'; return; }
    const stamp = `${timeStamp(seconds)} `, start = text.selectionStart, end = text.selectionEnd;
    if (text.value.length - (end - start) + stamp.length > VIDEO_NOTES_LIMIT) { feedback.textContent = 'Notes are full.'; return; }
    text.setRangeText(stamp, start, end, 'end'); text.focus(); changed();
  };
  send.onclick = async () => {
    const target = related.find(item => item.nodeId === agents.value), sessionId = target?.resource?.data.sessionId;
    if (!target || typeof sessionId !== 'string') return;
    sending = true; sends++; text.readOnly = true; updateAgents(); feedback.textContent = 'Sending…';
    try {
      if (!await flush()) return;
      // The service sends only this draft, reuses the request of an unconfirmed send of it and records the delivery.
      const draft = text.value, print = await fingerprint(draft);
      await services.runAction('video.notes', { sourceResourceId: resource.id, targetNodeId: target.nodeId, sessionId, requestId: crypto.randomUUID(), fingerprint: print });
      // What was observed before the service's write is older than it.
      observed = undefined;
      if (text.value !== draft) { feedback.textContent = ''; return; }
      sent = { to: target.title, at: new Date().toISOString(), fingerprint: print }; showSent();
    } catch (error) { feedback.textContent = (error as Error).message; }
    finally { sending = false; text.readOnly = false; updateAgents(); if (observed) void adopt(observed); }
  };
  clear.onclick = () => {
    clearTimeout(timer); timer = undefined; text.value = queuedText = ''; sent = undefined; feedback.textContent = '';
    void save({ notes: null, notesSent: null, notesPending: null }, ''); showSent(); renderStamps(); updateAgents(); text.focus();
  };
  keep.onclick = () => { conflict = false; confirmed = latest; feedback.textContent = ''; showConflict(); void flush(); };
  useSaved.onclick = () => { conflict = false; feedback.textContent = ''; showConflict(); take(latest); renderStamps(); updateAgents(); };
  showSent(); renderStamps(); updateAgents();
  const offData = services.observeData?.(data => { observed = data; void adopt(data); });
  void adopt(resource.data);
  return {
    element: panel, text, flush,
    setActive(active: boolean) {
      offRelated?.(); offRelated = undefined;
      if (active) offRelated = services.observeRelated?.(items => { related = items; updateAgents(); });
      else void flush();
    },
    dispose() { offRelated?.(); offData?.(); void flush(); },
  };
}
