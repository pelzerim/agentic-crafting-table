import type { JsonObject, RelatedResourceItem, ResourceRecord, ResourceViewServices } from '../../types.ts';
import { formatWhen } from '../../format-when.ts';
import { VIDEO_NOTES_LIMIT } from './source.ts';

const STAMP = /\[(\d{1,3}):([0-5]\d)\]/g;
export const timeStamp = (seconds: number) => { const whole = Math.max(0, Math.floor(seconds)); return `[${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}]`; };

/** Where the player is and how to move it; either rejects or yields undefined while the player is not ready. */
export interface VideoClock { time(): Promise<number | undefined>; seek(seconds: number): Promise<void> }

type Sent = { to: string; at: string };
const sentOf = (value: unknown): Sent | undefined => value && typeof value === 'object' && typeof (value as Sent).to === 'string' && typeof (value as Sent).at === 'string' ? value as Sent : undefined;
/** A send started but not confirmed; the same draft to the same agent reuses its request, so the service never delivers it twice. */
type Pending = { requestId: string; targetNodeId: string; sessionId: string; fingerprint: string };
const pendingOf = (value: unknown): Pending | undefined => value && typeof value === 'object' && ['requestId', 'targetNodeId', 'sessionId', 'fingerprint'].every(key => typeof (value as JsonObject)[key] === 'string') ? value as Pending : undefined;
const fingerprint = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))).map(byte => byte.toString(16).padStart(2, '0')).join('');

/** The Notes panel beside the player: a draft saved into the item, `[mm:ss]` stamps that seek, and Send to agent. */
export function mountVideoNotes(document: Document, resource: ResourceRecord, services: ResourceViewServices, clock: VideoClock) {
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
  const panel = element('section', '', 'video-notes'), text = element('textarea', '', 'video-notes-text'), controls = element('div', '', 'pr-comment-controls');
  const addTime = element('button', 'Add time'), agents = element('select'), send = element('button', 'Send to agent ▸');
  const stamps = element('ul', '', 'video-notes-stamps'), feedback = element('small', '', 'pr-comment-feedback'), clear = element('button', 'Clear');
  panel.setAttribute('aria-label', 'Video notes');
  for (const button of [addTime, send, clear]) button.type = 'button';
  text.maxLength = VIDEO_NOTES_LIMIT; text.setAttribute('aria-label', 'Notes'); text.placeholder = 'Type while you watch. Add time puts [mm:ss] at the cursor.';
  text.value = typeof resource.data.notes === 'string' ? resource.data.notes : '';
  agents.setAttribute('aria-label', 'Agent for notes'); clear.hidden = true;
  feedback.setAttribute('role', 'status');
  controls.append(addTime, agents, send, clear);
  panel.append(text, controls, feedback, stamps);

  let saved: string | undefined = text.value, sent = sentOf(resource.data.notesSent), sending = false, timer: ReturnType<typeof setTimeout> | undefined;
  let related: RelatedResourceItem[] = [], offRelated: (() => void) | undefined;
  let pending = pendingOf(resource.data.notesPending);
  // One save at a time: each reads the item's latest revision before it writes.
  let chain: Promise<boolean> = Promise.resolve(true);
  const save = (patch: JsonObject) => chain = chain.then(async () => {
    try { await services.saveData?.(patch); return true; }
    catch { feedback.textContent = 'Notes could not be saved.'; return false; }
  });
  const flush = () => {
    clearTimeout(timer); timer = undefined;
    if (text.value === saved) return chain;
    const value = saved = text.value;
    return save({ notes: value || null }).then(ok => { if (!ok && saved === value) saved = undefined; return ok; });
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
    send.disabled = sending || Boolean(sent) || !ready || !text.value.trim();
    send.title = sent ? 'Sent. Edit the notes to send them again.' : !ready ? 'Wait until the agent is ready for a new prompt.' : !text.value.trim() ? 'Write some notes first' : `Send these notes to ${target.title}`;
  };
  const changed = () => {
    if (sent) { sent = undefined; feedback.textContent = ''; void save({ notesSent: null }); }
    clearTimeout(timer); timer = setTimeout(() => void flush(), 500);
    showSent(); renderStamps(); updateAgents();
  };
  text.oninput = changed;
  agents.onchange = updateAgents;
  addTime.onclick = async () => {
    const seconds = await clock.time().catch(() => undefined);
    if (seconds === undefined) { feedback.textContent = 'The player is not ready yet.'; return; }
    const stamp = `${timeStamp(seconds)} `, start = text.selectionStart, end = text.selectionEnd;
    if (text.value.length - (end - start) + stamp.length > VIDEO_NOTES_LIMIT) { feedback.textContent = 'Notes are full.'; return; }
    text.setRangeText(stamp, start, end, 'end'); text.focus(); changed();
  };
  send.onclick = async () => {
    const target = related.find(item => item.nodeId === agents.value), sessionId = target?.resource?.data.sessionId;
    if (!target || typeof sessionId !== 'string') return;
    sending = true; text.readOnly = true; updateAgents(); feedback.textContent = 'Sending…';
    try {
      if (!await flush()) return;
      const draft = await fingerprint(text.value);
      if (pending?.targetNodeId !== target.nodeId || pending.sessionId !== sessionId || pending.fingerprint !== draft) {
        const next = { requestId: crypto.randomUUID(), targetNodeId: target.nodeId, sessionId, fingerprint: draft };
        if (!await save({ notesPending: next })) return;
        pending = next;
      }
      await services.runAction('video.notes', { sourceResourceId: resource.id, targetNodeId: target.nodeId, sessionId, requestId: pending.requestId });
      sent = { to: target.title, at: new Date().toISOString() }; pending = undefined; showSent();
      await save({ notesSent: sent, notesPending: null });
    } catch (error) { feedback.textContent = (error as Error).message; }
    finally { sending = false; text.readOnly = false; updateAgents(); }
  };
  clear.onclick = () => {
    clearTimeout(timer); timer = undefined; text.value = saved = ''; sent = pending = undefined; feedback.textContent = '';
    void save({ notes: null, notesSent: null, notesPending: null }); showSent(); renderStamps(); updateAgents(); text.focus();
  };
  showSent(); renderStamps(); updateAgents();
  return {
    element: panel, text,
    setActive(active: boolean) {
      offRelated?.(); offRelated = undefined;
      if (active) offRelated = services.observeRelated?.(items => { related = items; updateAgents(); });
      else void flush();
    },
    dispose() { offRelated?.(); void flush(); },
  };
}
