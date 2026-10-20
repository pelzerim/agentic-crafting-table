import type { MountedResourceView, ResourceRecord, ResourceViewServices } from '../../types.ts';
import { renderMarkdown } from '../../markdown-view.ts';
import { findingKey, findingLabel, findingMarkdown, ignoredByPerson, kindLabels, locationText, locationUrl, reviewMarkdown, severityLabels, sortFindings, verificationLabels } from '../../../pull-requests/review-findings.ts';
import type { Finding, FindingLocation, FindingStatus, ReviewFindings } from '../../../pull-requests/review-findings.ts';
import { reviewTranscript } from '../../../pull-requests/review-transcript.ts';
import type { TranscriptLine } from '../../../pull-requests/review-transcript.ts';
import { formatWhen } from '../../format-when.ts';
import { PIXEL_GLYPHS, pixelGlyphElement } from '../../pixel-glyphs.ts';
import { REVIEW_LOOP_OPERATION } from './review-loop.ts';

interface FindingEvent { status: FindingStatus; sendId?: string; agentNodeId?: string; agentTitle?: string; actor: 'user' | 'agent' | 'system'; commit?: string; note?: string; at: number }
interface Send { id: string; agentNodeId: string; agentTitle: string; findingIds: string[]; note: string; prompt: string; state: 'queued' | 'delivering' | 'sent' | 'failed' | 'cancelled' | 'uncertain'; error?: string; createdAt: number; updatedAt: number }
interface DeskData {
  state: 'running' | 'complete' | 'failed'; reviewSessionId: string; format?: 'findings' | 'text'; review?: ReviewFindings; markdown?: string; reason?: string;
  statuses: Record<string, FindingStatus>; history: Record<string, FindingEvent[]>; sends: Send[];
  repository: string; pr: { nodeId?: string; title: string; number: number; url?: string }; headSha: string; baseSha?: string; provider?: string; model?: string; startedAt?: string; endedAt?: string;
}
interface Agent { nodeId: string; title: string; provider: 'claude' | 'codex'; direct: boolean; via: 'review' | 'pr'; linkedToPr: boolean; status: 'idle' | 'working' | 'stopped'; prompt?: boolean; summary: string }
interface Options { agents: Agent[]; suggested?: string; prLabel: string; newAgent?: { provider: 'claude' | 'codex'; available: boolean; reason?: string } }
/** The review loop this review is a round of, as `review.loop` status reports it for a review item. */
interface Loop { state: string; round: number; maxRounds: number; rounds: { round: number; reviewNodeId?: string }[]; seen: Record<string, number>; pullNumber?: number }

const GRIDS: Record<string, readonly string[]> = PIXEL_GLYPHS[8];
const KIND_ICON: Record<string, string> = { hardening: 'shield', security: 'lock', question: 'question' };
const LEVELS: Record<string, [string, string]> = Object.fromEntries(Object.entries(verificationLabels).map(([level, label]) => [level, [level, label]]));
const SVG = 'http://www.w3.org/2000/svg';

type Child = Node | string | false | undefined | null;
function h<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, props: Partial<Record<string, string | boolean | number>> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value); else if (key === 'text') node.textContent = String(value); else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child !== false && child !== undefined && child !== null) node.append(child);
  return node;
}
function pixel(document: Document, name: string, small = false) {
  const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('viewBox', '0 0 8 8'); svg.setAttribute('class', `rd-px${small ? ' s12' : ''}`); svg.setAttribute('aria-hidden', 'true');
  GRIDS[name].forEach((row, y) => [...row].forEach((cell, x) => { if (cell !== 'X') return; const rect = document.createElementNS(SVG, 'rect'); rect.setAttribute('x', String(x)); rect.setAttribute('y', String(y)); rect.setAttribute('width', '1'); rect.setAttribute('height', '1'); svg.append(rect); }));
  return svg;
}
/** Bugs use a rising four-bar meter; other kinds a pictogram. Never colour alone. */
function meter(document: Document, level: string, small = true) {
  const svg = document.createElementNS(SVG, 'svg'), filled = { low: 1, medium: 2, high: 3, critical: 4 }[level] ?? 0;
  svg.setAttribute('viewBox', '0 0 15 15'); svg.setAttribute('class', `rd-px${small ? ' s12' : ''}`); svg.setAttribute('aria-hidden', 'true');
  [4, 7, 10, 13].forEach((height, index) => { const rect = document.createElementNS(SVG, 'rect'); rect.setAttribute('x', String(index * 4)); rect.setAttribute('y', String(15 - height)); rect.setAttribute('width', '3'); rect.setAttribute('height', String(height)); if (index >= filled) rect.setAttribute('opacity', '.26'); svg.append(rect); });
  return svg;
}
const glyph = (document: Document, key: string, small = true) => key in KIND_ICON ? pixel(document, KIND_ICON[key], small) : meter(document, key, small);
export const findingGlyph = (document: Document, key: string) => glyph(document, key);
export const reviewGlyph = (document: Document) => pixel(document, 'search', true);
const badge = (document: Document, finding: Finding, large = false) => h(document, 'span', { class: `rd-sev${large ? ' lg' : ''}`, 'data-s': findingKey(finding) }, glyph(document, findingKey(finding), !large), findingLabel(finding));
const clock = (at?: number | string) => formatWhen(at, 'stamp');
const took = (start?: string, end?: string) => { const ms = Date.parse(end ?? '') - Date.parse(start ?? ''); if (!Number.isFinite(ms) || ms < 0) return ''; const minutes = Math.round(ms / 60_000); return minutes < 1 ? 'took <1 min' : `took ${minutes} min`; };
const short = (sha?: string) => (sha ?? '').slice(0, 7);
const range = (ids: string[]) => { const numbers = ids.map(id => Number(id.slice(1))).sort((a, b) => a - b); return numbers.length > 2 && numbers.every((value, index) => !index || value === numbers[index - 1] + 1) ? `F${numbers[0]}–F${numbers.at(-1)}` : ids.join(', '); };
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const displayModel = (model?: string) => ({ opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable', 'gpt-6-astra': 'Astra' } as Record<string, string>)[model ?? ''] ?? model ?? '';
/** Per review item for this app session: whether its summary is collapsed. */
const summaryCollapsed = new Map<string, boolean>();
const plainTerminal = (output: string) => output.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[@-_]/g, '').replace(/\r+\n/g, '\n').replace(/[^\n]*\r(?!\n)/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

/** The review findings layout: a finding list with the focused
 * finding's detail, a pinned send bar and an agent picker, above the run log. */
export function mountReviewDesk(container: HTMLElement, resource: ResourceRecord, services: ResourceViewServices): MountedResourceView {
  const document = container.ownerDocument, el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Record<string, string | boolean | number>> = {}, ...children: Child[]) => h(document, tag, props, ...children);
  const provider = resource.data.provider === 'codex' ? 'Codex' : 'Claude', providerKey = resource.data.provider === 'codex' ? 'codex' : 'claude';
  const root = el('section', { class: 'review-desk', 'aria-label': 'Review findings' });
  const frame = services.frameToolbar?.(), titlebar = el('div', { class: `rd-frame${frame ? '' : ' rd-titlebar'}` }), head = el('div', { class: 'rd-head' }), progress = el('div', { class: 'rd-progress', role: 'progressbar', 'aria-label': 'Reviewing' }, el('i'));
  const body = el('div', { class: 'rd-body' }), sendWrap = el('div', { class: 'rd-send-wrap' }), statusbar = el('div', { class: 'rd-statusbar' }), log = el('div', { class: 'rd-log' });
  const findingsTab = el('button', { type: 'button', role: 'tab', class: 'rd-tab' }), logTab = el('button', { type: 'button', role: 'tab', class: 'rd-tab', text: 'Run log' });
  root.append(head, progress, body, statusbar, log); container.append(root);
  if (frame) frame.append(titlebar); else root.prepend(titlebar);
  const logHead = el('div', { class: 'rd-log-head' }), transcriptBox = el('div', { class: 'rd-transcript', role: 'log', 'aria-label': 'Review transcript', tabindex: 0 }), terminalHost = el('div', { class: 'rd-terminal' });
  log.append(logHead, transcriptBox, terminalHost);
  const terminal = services.attachTerminal(String(resource.data.sessionId), terminalHost, { inlineToolbar: true, launchLabel: `${resource.data.provider} · ${resource.data.model} · ${short(String(resource.data.baseSha ?? ''))} → ${short(String(resource.data.headSha ?? ''))}` });

  let data: DeskData | undefined, loaded = '', error = '', active = false, disposed = false, showLog = false, chosenTab = false, timer: ReturnType<typeof setTimeout> | undefined;
  let focus = '', anchor = '', filter = 'all', selected = new Set<string>(), notes = false;
  let picker: { options?: Options; agent?: string; note: string; requestId: string; sendId?: string; preview?: string; busy: boolean; error: string; loadError: string; noAgents?: boolean } | undefined;
  let done: { send: Send; at: number } | undefined, logTail: string[] = [], connectHint = '', notice = '', target: string | undefined, menuOpen = false, options: Options | undefined;
  let transcript: TranscriptLine[] | undefined, rawLog = false, logFinal = false, loop: Loop | undefined, loopKey = '';
  const terminalShown = () => showLog && !(transcript && !rawLog);
  const ordered = () => data?.review ? sortFindings(data.review.findings) : [];
  const visible = () => ordered().filter(finding => filter === 'all' || findingKey(finding) === filter);
  const sendFor = (id?: string) => data?.sends.find(send => send.id === id);

  const setTab = (logVisible: boolean) => {
    showLog = logVisible; findingsTab.setAttribute('aria-selected', String(!showLog)); logTab.setAttribute('aria-selected', String(showLog));
    for (const part of [head, progress, body, statusbar]) part.hidden = showLog || (part === progress && data?.state !== 'running');
    log.hidden = !showLog; renderLog();
    if (showLog && !logFinal) void readLog().then(() => { if (showLog) renderLog(); });
  };
  findingsTab.onclick = () => { chosenTab = true; setTab(false); };
  logTab.onclick = () => { chosenTab = true; setTab(true); };

  const LINE_ICON: Record<TranscriptLine['kind'], string> = { start: 'search', text: '', tool: '', error: 'warning', done: 'check', plain: '' };
  /** Claude streams JSON events, shown as a transcript; other runs keep the native terminal. */
  function renderLog() {
    const readable = Boolean(transcript) && !rawLog;
    transcriptBox.hidden = !readable; terminalHost.hidden = readable; terminal.setActive?.(active && terminalShown());
    logHead.hidden = !transcript;
    if (transcript) {
      const toggle = el('button', { type: 'button', class: 'rd-btn quiet', text: rawLog ? 'Show transcript' : 'Show terminal output' });
      toggle.onclick = () => { rawLog = !rawLog; renderLog(); };
      logHead.replaceChildren(el('span', { text: rawLog ? 'Terminal output · Claude event stream' : `Transcript · ${data?.state === 'running' ? 'updating while the review runs' : 'from the recorded run'}` }), toggle);
    }
    if (!readable) return;
    const atEnd = transcriptBox.scrollHeight - transcriptBox.scrollTop - transcriptBox.clientHeight < 24;
    transcriptBox.replaceChildren(...transcript!.map(line => el('div', { class: `rd-tl ${line.kind}` },
      el('span', { class: 'rd-tl-mark' }, LINE_ICON[line.kind] ? pixel(document, LINE_ICON[line.kind], true) : line.kind === 'tool' ? '›' : ''),
      el('div', {}, el('span', { class: 'rd-tl-text', text: line.text }), line.detail ? el('span', { class: 'rd-tl-detail', text: line.detail }) : ''))));
    if (!transcript!.length) transcriptBox.append(el('p', { class: 'rd-tl-empty', text: 'Waiting for the first output…' }));
    if (atEnd) transcriptBox.scrollTop = transcriptBox.scrollHeight;
  }

  const revisions = () => `${short(data?.baseSha)} → ${short(data?.headSha)}`;
  const running = () => { const started = Date.parse(data?.startedAt ?? ''); return Number.isFinite(started) ? `Started ${clock(data!.startedAt)} · ${Math.max(0, Math.round((Date.now() - started) / 60_000))} min` : 'Starting'; };
  /** Run state, time and revisions: a compact chip in the frame title bar; details in its tooltip and the status bar. */
  function stateChip() {
    if (!data || data.state === 'running') {
      return el('span', { class: 'rd-chip rd-state-run', role: 'status', title: `${running()} · ${revisions()}` }, pixel(document, 'spinner', true), el('span', { class: 'rd-chip-text', text: 'Reviewing' }));
    }
    const failed = data.state === 'failed', facts = [clock(data.endedAt), took(data.startedAt, data.endedAt)].filter(Boolean).join(' · ');
    return el('span', { class: `rd-chip ${failed ? 'rd-state-bad' : 'rd-state-ok'}`, role: 'status', title: `${failed ? 'Ended with an error' : 'Completed'}${facts ? ` · ${facts}` : ''} · ${revisions()}` },
      pixel(document, failed ? 'warning' : 'check', true), el('span', { class: 'rd-chip-text', text: failed ? 'Ended with an error' : 'Completed' }));
  }

  function renderTitlebar() {
    const pr = data?.pr, ref = el('span', { class: 'rd-ref' }, el('b', { class: 'rd-model', text: `${frame ? '' : `${provider} · `}${displayModel(String(resource.data.model))}` }));
    if (pr?.number) ref.append(el('span', { class: 'rd-sep', text: '/' }), pixel(document, 'pr', true), pr.url ? el('a', { href: pr.url, title: pr.url, text: `${data!.repository} #${pr.number}` }) : el('span', { text: `#${pr.number}` }));
    findingsTab.replaceChildren(data?.state === 'running' ? pixel(document, 'spinner', true) : '', 'Findings', data?.review ? el('span', { class: 'rd-count', text: String(data.review.findings.length) }) : '');
    const tabs = el('div', { class: 'rd-tabs', role: 'tablist', 'aria-label': 'Review display' }, findingsTab, logTab);
    titlebar.replaceChildren(frame ? '' : el('span', { class: 'rd-glyph' }, pixel(document, 'search')), ref, stateChip(), tabs);
  }

  function copyButton(label: string, text: () => string) {
    const button = el('button', { type: 'button', class: 'rd-btn quiet', text: label });
    button.onclick = () => { void navigator.clipboard?.writeText(text()).then(() => { button.textContent = 'Copied'; setTimeout(() => { button.textContent = label; }, 1500); }).catch(() => {}); };
    return button;
  }
  /** The finished review as Markdown: composed from the findings, or the saved text as is. */
  const wholeReport = () => !data || data.state === 'running' ? undefined
    : data.review ? reviewMarkdown({ title: data.pr.title, repository: data.repository, number: data.pr.number, url: data.pr.url, headSha: data.headSha, review: data.review, statuses: data.statuses, history: data.history })
      : data.markdown || undefined;

  const collapsed = () => data?.format === 'findings' && summaryCollapsed.get(resource.id) === true;
  const setCollapsed = (value: boolean) => { summaryCollapsed.set(resource.id, value); renderHead(); };
  function renderHead() {
    const summary = el('p', { class: 'rd-summary', id: `rd-summary-${resource.id}` }), text = data?.review?.summary ?? '', cut = text.search(/[.!?](\s|$)/);
    if (!data || data.state === 'running') summary.textContent = `${provider} is reading the change. Findings appear here when the review finishes.`;
    else if (data.review) { if (cut > 0 && cut < text.length - 1) summary.append(el('b', { text: text.slice(0, cut + 1) }), text.slice(cut + 1)); else summary.textContent = text; summary.title = text; }
    else summary.textContent = 'Text review · no structured summary';
    const folded = collapsed(), title = el('h1', { text: data?.pr.title ?? resource.title });
    head.classList.toggle('collapsed', folded);
    const copyAll = wholeReport() ? copyButton('Copy whole report', () => wholeReport() ?? '') : '';
    if (data?.format !== 'findings') { head.replaceChildren(copyAll ? el('div', { class: 'rd-head-row' }, title, copyAll) : title, summary); return; }
    const toggle = el('button', { type: 'button', class: 'rd-disclose', 'aria-expanded': String(!folded), 'aria-controls': summary.id, 'aria-label': folded ? 'Show review summary' : 'Hide review summary', title: folded ? 'Show summary' : 'Hide summary' },
      el('span', { class: 'rd-chev-d', 'aria-hidden': 'true' }, pixelGlyphElement(document, folded ? 'chevron-right' : 'chevron')));
    toggle.onclick = event => { event.stopPropagation(); setCollapsed(!folded); };
    summary.hidden = folded;
    head.replaceChildren(el('div', { class: 'rd-head-row' }, toggle, title, folded && cut > 0 ? el('span', { class: 'rd-verdict', text: text.slice(0, cut + 1) }) : '', copyAll), summary);
  }
  /** Rounds of the review loop this review belongs to, each opening its review; the one shown here is marked current. */
  function loopStrip() {
    if (!loop) return '';
    const rounds = Array.from({ length: loop.maxRounds }, (_, index) => index + 1).map(round => {
      const target = loop!.rounds.find(entry => entry.round === round)?.reviewNodeId, button = el('button', { type: 'button', class: 'rd-round', text: `R${round}`, 'aria-label': `Round ${round}`,
        ...(round === loop!.round ? { 'aria-current': 'true' } : {}), ...(target ? { title: `Open the round ${round} review` } : { disabled: true, title: `Round ${round} has not run` }) });
      if (target && round !== loop!.round) button.onclick = event => { event.stopPropagation(); services.openResource(target); };
      return button;
    });
    return el('div', { class: 'rd-loop', role: 'group', 'aria-label': 'Review loop rounds' }, el('span', { class: 'rd-loop-text', text: `Part of a review loop on ${loop.pullNumber ? `#${loop.pullNumber}` : 'the pull request'}` }), ...rounds);
  }
  head.addEventListener('click', event => { if (collapsed() && !(event.target as HTMLElement).closest('a, button')) setCollapsed(false); });
  /** Reviewing starts with the first click or key in the list or detail; hover and scrolling don't count. */
  const startReviewing = (event: Event) => {
    const target = event.target as HTMLElement;
    if (data?.format !== 'findings' || summaryCollapsed.has(resource.id) || !target.closest('.rd-list, .rd-detail') || target.closest('.rd-pop')) return;
    if (event.type === 'click' && target.matches('.rd-rows, .rd-d-scroll')) return;
    if (event instanceof KeyboardEvent && ['Tab', 'Shift', 'Meta', 'Control', 'Alt', 'CapsLock'].includes(event.key)) return;
    setCollapsed(true);
  };
  body.addEventListener('click', startReviewing, true); body.addEventListener('keydown', startReviewing, true);

  function statusTag(id: string) {
    const status = data?.statuses[id] ?? 'open', last = data?.history[id]?.at(-1);
    if (status === 'fixed' && ignoredByPerson(last)) return el('span', { class: 'rd-stat ignored' }, pixel(document, 'minus', true), 'Ignored');
    if (status === 'fixed') return el('span', { class: 'rd-stat fixed' }, pixel(document, 'check', true), last?.commit ? 'Fixed in ' : 'Fixed', last?.commit ? el('span', { class: 'rd-mono', text: short(last.commit) }) : '');
    if (status === 'sent') return el('span', { class: 'rd-stat sent' }, pixel(document, 'send', true), `Sent to ${last?.agentTitle ?? 'an agent'} · ${clock(last?.at)}`);
    if (status === 'queued') return el('span', { class: 'rd-stat queued' }, pixel(document, 'send', true), `Queued for ${last?.agentTitle ?? 'an agent'}`);
    const failed = last?.sendId && last.actor === 'system' && last.note ? last : undefined;
    return failed ? el('span', { class: 'rd-stat failed', title: failed.note }, pixel(document, 'warning', true), `Not delivered to ${failed.agentTitle ?? 'the agent'}`) : undefined;
  }

  function locationChip(place: FindingLocation, compact = false) {
    const slash = place.path.lastIndexOf('/'), lines = `:${place.startLine}${place.endLine ? `–${place.endLine}` : ''}`;
    const text = el('span', { class: 'rd-p' }, el('span', {}, place.path.slice(0, slash + 1), el('span', { class: 'rd-f', text: place.path.slice(slash + 1) }), el('span', { class: 'rd-l', text: lines })));
    const url = data ? locationUrl(data.repository, data.headSha, place) : undefined;
    if (!url) return el('span', { class: `rd-loc-chip unlinked${compact ? ' w220' : ''}`, title: `${locationText(place)} · not a repository path at the reviewed head` }, text);
    return el('a', { class: `rd-loc-chip${compact ? ' w220' : ''}`, href: url, title: `${locationText(place)} · opens at reviewed head ${short(data!.headSha)} on GitHub` }, text, el('span', { class: 'rd-out', text: '↗' }));
  }

  function toggle(id: string, value = !selected.has(id)) { if (value) selected.add(id); else selected.delete(id); done = undefined; }
  const listbox = el('div', { class: 'rd-rows', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'Findings', tabindex: 0 });
  listbox.addEventListener('focus', () => { if (!focus && visible()[0]) { focus = visible()[0].id; render(); } });

  function renderList() {
    const all = ordered(), shown = visible(), counts = new Map<string, number>();
    for (const finding of all) counts.set(findingKey(finding), (counts.get(findingKey(finding)) ?? 0) + 1);
    const keys = ['critical', 'high', 'medium', 'low', 'hardening', 'security', 'question'].filter(key => counts.has(key));
    const chipLabel = (key: string) => key in severityLabels ? severityLabels[key as keyof typeof severityLabels] : key === 'security' ? 'Security' : kindLabels[key as keyof typeof kindLabels];
    const chips = el('div', { class: 'rd-filters', role: 'toolbar', 'aria-label': 'Filter findings' }, ...[['all', 'All', all.length] as const, ...keys.map(key => [key, chipLabel(key), counts.get(key)!] as const)].map(([key, label, count]) => {
      const chip = el('button', { type: 'button', class: 'rd-fchip', 'aria-pressed': String(filter === key), 'aria-label': `${label} ${count}` }, key === 'all' ? '' : glyph(document, key), label, el('span', { class: 'rd-c', text: String(count) }));
      chip.onclick = () => { filter = key; if (!visible().some(finding => finding.id === focus)) focus = visible()[0]?.id ?? ''; render(); };
      return chip;
    }));
    const inView = shown.filter(finding => selected.has(finding.id)).length, all_ = el('input', { type: 'checkbox', class: `rd-cb${inView && inView < shown.length ? ' mixed' : ''}`, 'aria-label': 'Select all findings in view' }) as HTMLInputElement;
    all_.checked = shown.length > 0 && inView === shown.length; all_.indeterminate = inView > 0 && inView < shown.length;
    all_.onchange = () => { const value = inView < shown.length; for (const finding of shown) toggle(finding.id, value); render(); };
    const clear = el('button', { type: 'button', class: 'rd-linkish', text: 'Clear' }); clear.onclick = () => { selected.clear(); done = undefined; render(); };
    const listHead = el('div', { class: 'rd-list-head' }, all_, el('span', { class: 'rd-selcount', text: selected.size ? `${selected.size} of ${all.length} selected` : `Select all ${shown.length}` }), selected.size ? clear : '',
      selected.size ? el('span', { class: 'rd-right rd-breakdown', title: selectedSummary().breakdown, text: selectedSummary().breakdown }) : el('span', { class: 'rd-right', text: 'Most severe first' }));
    const scroll = listbox.scrollTop;
    listbox.replaceChildren(...shown.map(finding => {
      const checked = selected.has(finding.id), tag = statusTag(finding.id), status = data!.statuses[finding.id] ?? 'open';
      const box = el('input', { type: 'checkbox', class: 'rd-cb', tabindex: -1, 'aria-label': `Select ${finding.id}` }) as HTMLInputElement; box.checked = checked;
      box.onclick = event => { event.stopPropagation(); toggle(finding.id, box.checked); focus = finding.id; render(); };
      const first = finding.locations[0], more = finding.locations.length - 1, level = LEVELS[finding.verification.level];
      const line3 = el('div', { class: 'rd-line3' }, el('span', { class: 'rd-loc', text: `${first.path.slice(first.path.lastIndexOf('/') + 1)}:${first.startLine}` }), more ? el('span', { text: `+${more}` }) : '',
        tag ?? el('span', { class: 'rd-ver' }, pixel(document, level[0], true), finding.verification.note && finding.verification.level === 'verified' && finding.verification.note.length < 24 ? finding.verification.note : level[1]));
      const row = el('div', { class: `rd-row${focus === finding.id && !notes ? ' active' : ''}${status === 'fixed' ? ' fixed' : ''}`, role: 'option', id: `rd-${resource.id}-${finding.id}`, 'aria-selected': String(checked), 'data-finding': finding.id },
        box, el('div', {}, el('div', { class: 'rd-line1' }, badge(document, finding), finding.qualifier ? el('span', { class: 'rd-qual', text: /accept/i.test(finding.qualifier) ? 'accepted' : finding.qualifier }) : '', loop?.seen[finding.id] ? el('span', { class: 'rd-seen', title: `Reported fixed in round ${loop.seen[finding.id]} of this review loop`, text: `seen in R${loop.seen[finding.id]}` }) : '', el('span', { class: 'rd-fid', text: finding.id })),
          el('div', { class: 'rd-title', title: finding.title, text: finding.title }), line3));
      row.onclick = () => { focus = finding.id; notes = false; render(); listbox.focus({ preventScroll: true }); };
      return row;
    }));
    if (!shown.length) listbox.append(el('p', { class: 'rd-empty-list', text: all.length ? 'No findings match this filter.' : 'No findings. The reviewer found nothing to fix.' }));
    if (focus && !notes) listbox.setAttribute('aria-activedescendant', `rd-${resource.id}-${focus}`); else listbox.removeAttribute('aria-activedescendant');
    const review = data!.review!, notesRow = el('div', { class: `rd-note-row${notes ? ' active' : ''}` }, el('span', { class: 'rd-group-label', text: 'Notes' }));
    const openNotes = el('button', { type: 'button', class: 'rd-linkish' }, pixel(document, 'check', true), `${review.checked.length} checked, correct`);
    const testNote = el('button', { type: 'button', class: 'rd-linkish' }, pixel(document, review.tests.ran ? 'verified' : 'unverified', true), review.tests.ran ? 'Tests run' : 'Tests not run');
    openNotes.onclick = testNote.onclick = () => { notes = true; render(); };
    notesRow.append(openNotes, el('span', { class: 'rd-sep', text: '·' }), testNote);
    listbox.append(notesRow); listbox.scrollTop = scroll;
    return el('div', { class: 'rd-list' }, chips, listHead, listbox);
  }

  function historyLine(event: FindingEvent, index: number, events: FindingEvent[]) {
    const who = event.agentTitle ?? 'the agent', when = clock(event.at);
    const text = event.status === 'queued' ? `Queued for ${who}` : event.status === 'sent' ? `Sent to ${who}` : event.status === 'fixed'
      ? event.actor === 'user' ? 'Ignored by you' : `Fixed by ${who}${event.commit ? ` in ${short(event.commit)}` : ''}${event.note ? ` · “${event.note}”` : ''}`
      : event.actor === 'user' ? (event.sendId ? `Cancelled send to ${who}` : ignoredByPerson(events[index - 1]) ? 'No longer ignored by you' : 'Reopened by you') : `Not delivered: ${event.note ?? 'the send did not complete'}`;
    return el('li', {}, el('span', { class: 'rd-mono rd-when', text: when }), text);
  }

  function renderDetail() {
    const detail = el('div', { class: 'rd-detail', 'aria-live': 'polite' }), review = data!.review!;
    if (notes) {
      detail.append(el('div', { class: 'rd-d-scroll' }, el('div', { class: 'rd-d-top' }, el('span', { class: 'rd-sev lg', 'data-s': 'notes' }, pixel(document, 'check'), 'Review notes')), el('h2', { class: 'rd-d-title', text: 'Checked and found correct' }),
        review.checked.length ? el('ul', { class: 'rd-checked' }, ...review.checked.map(item => el('li', { text: item }))) : el('p', { text: 'The review listed no checked areas.' }),
        el('h3', { class: 'rd-d-sub', text: review.tests.ran ? 'Tests run' : 'Tests not run' }), el('p', { text: review.tests.notes || '—' })));
      return detail;
    }
    const all = ordered(), finding = all.find(item => item.id === focus) ?? all[0];
    if (!finding) { detail.append(el('div', { class: 'rd-d-scroll' }, el('h2', { class: 'rd-d-title', text: 'Nothing to fix' }), el('p', { class: 'rd-d-ver', text: review.tests.notes }))); return detail; }
    const index = all.indexOf(finding), prev = el('button', { type: 'button', 'aria-label': 'Previous finding', text: '‹' }), next = el('button', { type: 'button', 'aria-label': 'Next finding', text: '›' });
    prev.disabled = index === 0; next.disabled = index === all.length - 1;
    prev.onclick = () => { focus = all[index - 1].id; render(); }; next.onclick = () => { focus = all[index + 1].id; render(); };
    const level = LEVELS[finding.verification.level], rows: [string, Child | Child[]][] = [['Where', el('div', { class: 'rd-locs' }, ...finding.locations.map(place => locationChip(place)))]];
    if (finding.when) rows.push(['When', finding.when]);
    if (finding.why?.length) rows.push(['Why it matters', finding.why.length > 1 ? el('ul', {}, ...finding.why.map(point => el('li', { text: point }))) : finding.why[0]]);
    if (finding.details) { const block = el('div', { class: 'markdown-content rd-details' }); renderMarkdown(block, finding.details); rows.push([finding.kind === 'hardening' ? 'Details' : 'Notes', block]); }
    if (finding.fix) rows.push([finding.kind === 'security' ? 'If revisited' : finding.kind === 'hardening' ? 'Suggestion' : finding.kind === 'question' ? 'To decide' : 'Suggested fix', el('div', { class: 'rd-fix', text: finding.fix })]);
    const events = data!.history[finding.id] ?? [];
    if (events.length) rows.push(['History', el('ul', { class: 'rd-history' }, ...events.map(historyLine))]);
    const dl = el('dl', { class: 'rd-dl' });
    for (const [label, value] of rows) dl.append(el('dt', { text: label }), el('dd', {}, ...(Array.isArray(value) ? value : [value])));
    const chosen = selected.has(finding.id), selectButton = el('button', { type: 'button', class: 'rd-btn', 'aria-pressed': String(chosen) }, el('span', { class: `rd-cb-look${chosen ? ' on' : ''}`, 'aria-hidden': 'true' }), chosen ? 'Selected' : 'Select for fixing');
    selectButton.onclick = () => { toggle(finding.id); render(); };
    const status = data!.statuses[finding.id] ?? 'open', ignored = status === 'fixed' && ignoredByPerson(events.at(-1));
    const mark = el('button', { type: 'button', class: 'rd-btn quiet', text: ignored ? 'Stop ignoring' : status === 'fixed' ? 'Reopen' : 'Ignore' });
    mark.disabled = status === 'queued';
    mark.onclick = () => void act(() => services.runAction('review.findings', { operation: 'mark', reviewSessionId: data!.reviewSessionId, findingIds: [finding.id], status: status === 'fixed' ? 'open' : 'fixed' }));
    const copy = copyButton('Copy as Markdown', () => findingMarkdown(finding));
    const tag = statusTag(finding.id);
    detail.append(
      el('div', { class: 'rd-d-scroll' },
        el('div', { class: 'rd-d-top' }, badge(document, finding, true), tag ?? '', el('div', { class: 'rd-pager' }, prev, el('span', { text: `${index + 1} of ${all.length}` }), next)),
        finding.qualifier ? el('p', { class: 'rd-d-qual', text: finding.qualifier }) : '',
        el('h2', { class: 'rd-d-title', text: finding.title }),
        el('div', { class: 'rd-d-ver' }, pixel(document, level[0], true), el('span', { text: finding.verification.note ? `${level[1]} · ${finding.verification.note}` : level[1] })),
        dl, el('div', { class: 'rd-d-actions' }, selectButton, mark, copy, status === 'sent' || status === 'fixed' && !ignored ? el('span', { class: 'rd-hint', text: 'Sent with the full review as context' }) : '')));
    return detail;
  }

  function selectedSummary() {
    const chosen = ordered().filter(finding => selected.has(finding.id)), counts = new Map<string, number>();
    for (const finding of chosen) counts.set(findingLabel(finding).toLowerCase(), (counts.get(findingLabel(finding).toLowerCase()) ?? 0) + 1);
    const hidden = chosen.filter(finding => !visible().includes(finding)).length;
    return { chosen, breakdown: [...counts].map(([label, count]) => `${count} ${label}`).join(' · ') + (hidden ? ` (${hidden} hidden by filter)` : '') };
  }
  const agentIcon = (agent?: Pick<Agent, 'provider'>) => el('span', { class: `rd-av ${agent?.provider ?? 'claude'}` }, pixel(document, agent?.provider ?? 'claude', true));

  const NEW = 'new';
  const providerName = (value?: string) => value === 'codex' ? 'Codex' : 'Claude';
  /** Who the split button sends to: the chosen agent, else the suggested one. */
  const currentTarget = () => { const agents = options?.agents ?? [], id = target ?? options?.suggested; return id === NEW && options?.newAgent?.available ? NEW : agents.find(agent => agent.nodeId === id)?.nodeId; };
  const targetName = (id?: string) => id === NEW ? `new ${providerName(options?.newAgent?.provider)} agent` : options?.agents.find(agent => agent.nodeId === id)?.title;
  /** Why a recipient cannot take the findings now; a prompt in its terminal is the person's to answer. */
  const busy = (agent: Agent) => agent.status === 'stopped' ? 'Stopped' : agent.prompt ? 'Waiting for you to answer a prompt in its terminal' : `Working${agent.summary ? `: ${agent.summary}` : ''}`;
  const waiting = (agent: Agent) => `${busy(agent)}. ${agent.status === 'working' ? 'Queued until it’s idle.' : 'Queued until you resume it and it’s idle.'}`;

  /** The floating split button: the main part opens the confirm step, the chevron chooses the recipient. */
  function renderSend() {
    sendWrap.replaceChildren();
    if (!data || data.state === 'running' || error) { sendWrap.remove(); return; }
    if (!sendWrap.isConnected) body.append(sendWrap);
    const whole = data.format === 'text', count = whole ? 0 : selected.size, ready = whole || count > 0, id = currentTarget(), name = targetName(id);
    if (done && !menuOpen) {
      const send = done.send, queued = send.state === 'queued', failed = ['failed', 'uncertain', 'cancelled'].includes(send.state), what = send.findingIds.length ? range(send.findingIds) : 'the review';
      const message = queued ? [`Queued ${what} for `, el('b', { text: send.agentTitle }), el('span', { text: ' · delivered when it’s ready' })]
        : failed ? [send.state === 'cancelled' ? 'Cancelled the send to ' : `Could not deliver ${what} to `, el('b', { text: send.agentTitle }), el('span', { text: send.error ? ` · ${send.error}` : '' })]
          : [`Sent ${what} to `, el('b', { text: send.agentTitle }), ` · ${clock(send.updatedAt)} `, el('span', { text: '· full review attached as context' })];
      const view = el('button', { type: 'button', class: 'rd-btn quiet', text: 'View message' }), open = el('button', { type: 'button', class: 'rd-btn quiet', text: 'Open agent ↗' }), dismiss = el('button', { type: 'button', class: 'rd-btn quiet rd-x', 'aria-label': 'Dismiss' }, pixelGlyphElement(document, 'close'));
      view.onclick = () => { picker = { note: send.note, requestId: send.id, preview: send.prompt, busy: false, error: '', loadError: '' }; renderPicker(); };
      open.onclick = () => services.openResource(send.agentNodeId); dismiss.onclick = () => { done = undefined; renderSend(); };
      const actions = el('div', { class: 'rd-toast-actions' });
      if (queued) { const cancel = el('button', { type: 'button', class: 'rd-btn quiet', text: 'Cancel send' }); cancel.onclick = () => void act(async () => { const result = await services.runAction('review.findings', { operation: 'cancel', sendId: send.id }); await reload(); done = { send: sendFor(send.id) ?? { ...send, state: (result as { state: Send['state'] }).state }, at: Date.now() }; }); actions.append(cancel); }
      actions.append(view, open, dismiss);
      sendWrap.append(el('div', { class: `rd-toast ${failed ? 'bad' : 'done'}`, role: 'status' }, el('div', { class: 'rd-msg' }, pixel(document, failed ? 'warning' : queued ? 'send' : 'check'), el('div', {}, ...message)), actions));
    } else if ((notice || connectHint) && !menuOpen) {
      const dismiss = el('button', { type: 'button', class: 'rd-btn quiet rd-x', 'aria-label': 'Dismiss' }, pixelGlyphElement(document, 'close')); dismiss.onclick = () => { notice = ''; connectHint = ''; renderSend(); };
      sendWrap.append(el('div', { class: `rd-toast ${notice ? 'bad' : ''}`, role: notice ? 'alert' : 'status' }, el('div', { class: 'rd-msg' }, pixel(document, notice ? 'warning' : 'link'), el('div', { text: notice || connectHint })), el('div', { class: 'rd-toast-actions' }, dismiss)));
    }
    const label = `Send ${whole ? 'whole review ' : count > 1 ? `${count} ` : ''}to ${name ?? 'an agent…'}`;
    const main = el('button', { type: 'button', class: `rd-btn rd-split-main${ready ? ' primary' : ''}`, disabled: !ready, 'aria-haspopup': 'dialog', 'aria-expanded': String(Boolean(picker && !picker.preview)),
      title: ready ? `${whole ? 'The whole review' : `${plural(count, 'finding')} (${selectedSummary().breakdown})`} · review the message before it goes` : 'Select findings to send (Space selects the focused one)' }, pixel(document, 'send', true), el('span', { class: 'rd-split-label', text: label }));
    main.onclick = () => { menuOpen = false; void openPicker(); };
    const chevron = el('button', { type: 'button', class: `rd-btn rd-split-chev${ready ? ' primary' : ''}`, 'aria-haspopup': 'menu', 'aria-expanded': String(menuOpen), 'aria-label': 'Choose who gets the findings', title: 'Choose an agent or start a new one' }, el('span', { class: 'rd-chev', 'aria-hidden': 'true' }, pixelGlyphElement(document, 'chevron')));
    chevron.onclick = () => { menuOpen = !menuOpen; renderSend(); if (menuOpen) (sendWrap.querySelector<HTMLElement>('[role=menu] [role^=menuitem]:not([aria-disabled=true])') ?? sendWrap.querySelector<HTMLElement>('[role=menu]'))?.focus(); else sendWrap.querySelector<HTMLElement>('.rd-split-chev')?.focus(); };
    const split = el('div', { class: 'rd-split', role: 'group', 'aria-label': 'Send findings' }, main, chevron);
    if (menuOpen) split.append(renderMenu(whole, ready));
    sendWrap.append(split);
  }

  function renderMenu(whole: boolean, ready: boolean) {
    const menu = el('div', { class: 'rd-menu', role: 'menu', 'aria-label': 'Send to', tabindex: -1 }), close = (focus = true) => { menuOpen = false; renderSend(); if (focus) sendWrap.querySelector<HTMLElement>('.rd-split-chev')?.focus(); };
    const fresh = options?.newAgent, what = whole ? 'the review' : 'the selected findings';
    const item = (role: string, disabled: boolean, content: Child[], activate: () => void, checked?: boolean) => {
      const node = el('button', { type: 'button', role, class: 'rd-menu-item', tabindex: -1, 'aria-disabled': disabled ? 'true' : false, ...(checked !== undefined ? { 'aria-checked': String(checked) } : {}) }, ...content);
      node.onclick = () => { if (!disabled) activate(); }; return node;
    };
    if (fresh) menu.append(item('menuitem', !fresh.available || !ready, [el('span', { class: 'rd-menu-icon' }, pixel(document, fresh.provider === 'codex' ? 'codex' : 'claude', true)),
      el('div', {}, el('b', { text: `Run in new ${providerName(fresh.provider)} agent` }), el('span', { text: !fresh.available ? fresh.reason ?? 'Unavailable here' : !ready ? 'Select findings first' : `Starts in the project’s directory with ${what} as its task` }))],
    () => { target = NEW; close(false); void openPicker(); }));
    const agents = options?.agents ?? [];
    menu.append(el('div', { class: `rd-menu-label${agents.length ? '' : ' empty'}`, role: 'presentation', text: agents.length ? 'Connected agents' : 'No agent is linked to this review or its PR yet. Link one on the map to choose it here.' }));
    for (const agent of agents) menu.append(item('menuitemradio', false, [agentIcon(agent), el('div', {}, el('b', { text: agent.title }), el('span', { text: agent.status === 'idle' ? agent.direct ? 'Idle · linked to this review' : 'Idle · linked to the PR' : waiting(agent) }))],
      () => { target = agent.nodeId; close(); }, currentTarget() === agent.nodeId));
    menu.onkeydown = event => {
      const items = [...menu.querySelectorAll<HTMLElement>('[role^=menuitem]:not([aria-disabled=true])')], index = items.indexOf(document.activeElement as HTMLElement);
      if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); event.stopPropagation(); close(event.key === 'Escape'); return; }
      const next = event.key === 'ArrowDown' ? items[(index + 1) % items.length] : event.key === 'ArrowUp' ? items[(index - 1 + items.length) % items.length] : event.key === 'Home' ? items[0] : event.key === 'End' ? items.at(-1) : undefined;
      if (!next) return; event.preventDefault(); event.stopPropagation(); next.focus();
    };
    return menu;
  }

  function renderStatusbar() {
    if (!data || data.state === 'running') statusbar.replaceChildren(el('span', { text: `${running()} · the run log is recording · closing this view doesn’t stop the review` }), el('span', { class: 'rd-right', text: `${provider} · ${displayModel(String(resource.data.model))}` }));
    else if (data.format === 'text') statusbar.replaceChildren(el('span', { text: `Saved output: ${((data.markdown ?? '').length / 1024).toFixed(1)} KB Markdown · ${[clock(data.endedAt), took(data.startedAt, data.endedAt)].filter(Boolean).join(' · ')} · ${revisions()}` }), el('span', { class: 'rd-right', text: 'Locations in text aren’t linked' }));
    else {
      const key = (...keys: string[]) => keys.map(value => el('kbd', { text: value }));
      statusbar.replaceChildren(el('div', { class: 'rd-keys' }, el('span', { class: 'rd-key-hint' }, 'Select findings to have an agent fix them'), el('span', {}, ...key('Space'), ' select'), el('span', {}, ...key('↑', '↓'), ' move'), el('span', {}, ...key('⏎'), ' send'), el('span', {}, ...key('⇧'), '+', ...key('↓'), ' extend'), el('span', {}, ...key('⌘', 'A'), ' all in filter')),
        el('span', { class: 'rd-right', title: `Locations open at the reviewed head ${short(data.headSha)}` }, [clock(data.endedAt), took(data.startedAt, data.endedAt)].filter(Boolean).join(' · ') + ' · ', el('span', { class: 'rd-mono', text: revisions() }), ' reviewed head'));
    }
  }

  const popWrap = el('div', { class: 'rd-pop-wrap' });
  async function loadOptions() { options = await services.runAction('review.findings', { operation: 'options' }) as unknown as Options; if (options.agents.length) connectHint = ''; return options; }
  async function openPicker() {
    if (picker && !picker.preview) { picker = undefined; render(); return; }
    if (data?.format === 'findings' && !selected.size) return;
    picker = { note: '', requestId: crypto.randomUUID(), sendId: crypto.randomUUID(), busy: false, error: '', loadError: '' }; render();
    try { await loadOptions(); if (!picker) return; picker.options = options; picker.agent = currentTarget(); picker.noAgents = !options!.agents.length && !options!.newAgent?.available; }
    catch (reason) { if (picker) picker.loadError = (reason as Error).message; }
    render(); (popWrap.querySelector('[role=radio][aria-checked=true], .rd-choice, textarea') as HTMLElement | null)?.focus();
  }
  async function sendNow() {
    if (!picker?.agent || picker.busy || !data) return;
    const findingIds = data.format === 'findings' ? ordered().filter(finding => selected.has(finding.id)).map(finding => finding.id) : [];
    picker.busy = true; picker.error = ''; renderPicker();
    try {
      const fresh = picker.agent === NEW, receipt = await services.runAction('review.findings', fresh
        ? { operation: 'spawn', requestId: picker.requestId, sendId: picker.sendId!, reviewSessionId: data.reviewSessionId, findingIds, provider: options?.newAgent?.provider ?? 'claude', note: picker.note }
        : { operation: 'send', requestId: picker.requestId, reviewSessionId: data.reviewSessionId, findingIds, agentNodeId: picker.agent, note: picker.note }) as { sendId: string; state: Send['state'] };
      await reload();
      const send = sendFor(receipt.sendId); picker = undefined; selected = new Set(); if (send) { done = { send, at: Date.now() }; target = send.agentNodeId; }
      if (fresh) await loadOptions().catch(() => {});
      render();
    } catch (reason) { if (picker) { picker.busy = false; picker.error = (reason as Error).message; renderPicker(); } }
  }
  async function preview() {
    if (!picker?.agent || !data) return;
    const findingIds = data.format === 'findings' ? ordered().filter(finding => selected.has(finding.id)).map(finding => finding.id) : [];
    try { picker.preview = (await services.runAction('review.findings', { operation: 'preview', findingIds, ...(picker.agent === NEW ? {} : { agentNodeId: picker.agent }), note: picker.note }) as { prompt: string }).prompt; }
    catch (reason) { picker.error = (reason as Error).message; }
    renderPicker();
  }

  function renderPicker() {
    popWrap.replaceChildren(); if (!picker || !data) { popWrap.remove(); return; }
    const pop = el('div', { class: 'rd-pop', role: 'dialog', 'aria-label': picker.preview && !picker.options ? 'Message sent to the agent' : 'Send findings to an agent' });
    popWrap.append(pop); if (!popWrap.isConnected) body.append(popWrap);
    const close = () => { picker = undefined; render(); };
    const chosen = ordered().filter(finding => selected.has(finding.id)), what = data.format === 'findings' ? plural(chosen.length, 'finding') : 'the whole review';
    if (picker.preview && !picker.options) {
      const back = el('button', { type: 'button', class: 'rd-btn quiet', text: 'Close' }); back.onclick = close;
      pop.append(el('div', { class: 'rd-pop-head' }, el('h4', { text: 'Message sent to the agent' })), el('pre', { class: 'rd-preview', text: picker.preview }), el('div', { class: 'rd-pop-foot' }, back)); return;
    }
    if (!picker.options) { pop.append(el('div', { class: 'rd-pop-head' }, el('h4', { text: `Send ${what} to an agent` })), el('p', { class: picker.loadError ? 'rd-pop-error' : 'rd-pop-loading', role: picker.loadError ? 'alert' : 'status', text: picker.loadError || 'Finding connected agents…' })); return; }
    const pr = picker.options.prLabel;
    if (picker.noAgents) {
      const connect = el('button', { type: 'button', class: 'rd-choice main' }, el('span', { class: 'rd-choice-icon' }, pixel(document, 'link')), el('div', {}, el('b', { text: 'Connect an existing agent…' }), el('span', { text: `Return to the map and draw a link from an agent to this review or to PR ${pr}, then send. Your selection stays here.` })));
      connect.onclick = () => { picker = undefined; done = undefined; connectHint = `Link an agent to this review or to PR ${pr} on the map, then send.`; render(); };
      const cancel = el('button', { type: 'button', class: 'rd-btn quiet', text: 'Cancel' }); cancel.onclick = close;
      pop.append(el('div', { class: 'rd-pop-head' }, el('h4', { text: 'No agent to send to' })),
        el('div', { class: 'rd-empty' }, el('p', {}, 'Findings go to an agent linked to ', el('b', { text: 'this review' }), ' or to ', el('b', { text: `PR ${pr}` }), ` on the map. Neither has one yet. ${data.format === 'findings' ? `Your ${what} stay selected.` : ''}`), connect),
        el('div', { class: 'rd-pop-foot' }, el('span', { class: 'rd-foot-note', text: 'Agents elsewhere on the map appear here once linked.' }), cancel)); return;
    }
    const agents = picker.options.agents, group = el('div', { class: 'rd-pop-sec', role: 'radiogroup', 'aria-label': 'Agent' });
    for (const [via, label] of [['review', 'Connected to this review'], ['pr', `Via PR ${pr}`]] as const) {
      const members = agents.filter(agent => agent.via === via); if (!members.length) continue;
      group.append(el('div', { class: 'rd-pop-label' }, el('span', { text: label })));
      for (const agent of members) {
        const on = picker.agent === agent.nodeId, wait = agent.status !== 'idle';
        const sub = wait ? el('div', { class: 'rd-sub', text: `${busy(agent)}. ${agent.status === 'working' ? 'The findings are queued and delivered when it’s idle.' : 'The findings are queued and delivered after you resume it and it’s idle.'}` })
          : el('div', { class: 'rd-sub' }, el('span', { class: 'rd-link-kind' }, pixel(document, agent.direct ? 'direct' : 'link', true), agent.direct ? agent.linkedToPr ? `Linked to this review and to PR ${pr}` : 'Linked to this review' : 'Linked to the PR, not the review'));
        const row = el('div', { class: `rd-agent${on ? ' chosen' : ''}${wait ? ' busy' : ''}`, role: 'radio', 'aria-checked': String(on), tabindex: on ? 0 : -1, 'data-agent': agent.nodeId },
          el('span', { class: `rd-radio${on ? ' on' : ''}` }), agentIcon(agent), el('div', {}, el('div', { class: 'rd-nm' }, agent.title, agent.nodeId === picker.options.suggested ? el('span', { class: 'rd-suggest', text: 'Suggested' }) : ''), sub),
          el('span', { class: `rd-st ${agent.status}` }, el('span', { class: 'rd-dot' }), agent.status === 'idle' ? 'Idle' : agent.status === 'stopped' ? 'Stopped' : agent.prompt ? 'Needs you' : 'Working'));
        row.onclick = () => { picker!.agent = agent.nodeId; target = agent.nodeId; picker!.preview = undefined; renderSend(); renderPicker(); (popWrap.querySelector(`[data-agent="${agent.nodeId}"]`) as HTMLElement | null)?.focus(); };
        group.append(row);
      }
    }
    const fresh = picker.options.newAgent;
    if (fresh?.available) {
      const on = picker.agent === NEW, row = el('div', { class: `rd-agent${on ? ' chosen' : ''}`, role: 'radio', 'aria-checked': String(on), tabindex: on ? 0 : -1, 'data-agent': NEW },
        el('span', { class: `rd-radio${on ? ' on' : ''}` }), agentIcon({ provider: fresh.provider }), el('div', {}, el('div', { class: 'rd-nm', text: `New ${providerName(fresh.provider)} agent` }),
          el('div', { class: 'rd-sub', text: 'Starts in the project’s working directory, linked to this review. The findings are delivered once it’s ready.' })), el('span', { class: 'rd-st idle' }, 'New'));
      row.onclick = () => { picker!.agent = NEW; target = NEW; picker!.preview = undefined; renderSend(); renderPicker(); (popWrap.querySelector(`[data-agent="${NEW}"]`) as HTMLElement | null)?.focus(); };
      if (!agents.length) group.append(el('p', { class: 'rd-sub rd-pop-note', text: `No agent is linked to this review or to PR ${pr}. Link one on the map to choose it here.` }));
      group.append(el('div', { class: 'rd-pop-label' }, el('span', { text: 'Start a new agent' })), row);
    }
    const choices = [...agents.map(agent => agent.nodeId), ...(fresh?.available ? [NEW] : [])];
    group.onkeydown = event => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return; event.preventDefault(); event.stopPropagation();
      const index = choices.indexOf(picker!.agent ?? ''), next = choices[(index + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length];
      picker!.agent = next; target = next; renderSend(); renderPicker(); (popWrap.querySelector(`[data-agent="${next}"]`) as HTMLElement | null)?.focus();
    };
    const note = el('textarea', { class: 'rd-note', placeholder: 'e.g. keep the existing API unchanged', 'aria-label': 'Note for the agent' }) as HTMLTextAreaElement; note.value = picker.note;
    note.oninput = () => { picker!.note = note.value; picker!.preview = undefined; };
    const agent = agents.find(candidate => candidate.nodeId === picker!.agent), queued = agent && agent.status !== 'idle';
    const manifest = el('div', { class: 'rd-manifest' },
      el('span', { class: 'rd-k', text: 'To fix' }), el('span', { class: 'rd-v' }, el('b', { text: data.format === 'findings' ? plural(chosen.length, 'finding') : 'Whole review' }), data.format === 'findings' ? el('span', { text: ` · ${chosen.map(finding => `${finding.id} ${findingLabel(finding)}`).join(', ')}` }) : ''),
      el('span', { class: 'rd-k', text: 'Context' }), el('span', { class: 'rd-v' }, el('b', { text: 'Full review' }), el('span', { text: ` · ${data.review ? `${plural(data.review.findings.length, 'finding')}, checks, tests note · ` : ''}PR ${pr} at ${short(data.headSha)}` })));
    const previewLink = el('button', { type: 'button', class: 'rd-linkish rd-preview-link', text: picker.preview ? 'Hide message' : 'Preview message' });
    previewLink.onclick = () => { if (picker!.preview) { picker!.preview = undefined; renderPicker(); } else void preview(); };
    const cancel = el('button', { type: 'button', class: 'rd-btn quiet', text: 'Cancel' }); cancel.onclick = close;
    const newOne = picker.agent === NEW && fresh?.available;
    const send = el('button', { type: 'button', class: 'rd-btn primary', disabled: !(agent || newOne) || picker.busy }, pixel(document, 'send', true), newOne ? `Start ${providerName(fresh!.provider)} agent and send` : agent ? `${queued ? 'Queue for' : 'Send to'} ${agent.title}` : 'Choose an agent');
    send.onclick = () => void sendNow();
    pop.append(el('div', { class: 'rd-pop-head' }, el('h4', { text: `Send ${what} to an agent` }), el('span', { text: `PR ${pr} · ${plural(agents.length, 'linked agent')}` })), group,
      el('div', { class: 'rd-pop-sec' }, el('div', { class: 'rd-pop-label' }, el('span', { text: 'Note for the agent' }), el('span', { class: 'rd-optional', text: 'optional' })), note), manifest,
      picker.preview ? el('pre', { class: 'rd-preview', text: picker.preview }) : '', picker.error ? el('p', { class: 'rd-pop-error', role: 'alert', text: picker.error }) : '',
      el('div', { class: 'rd-pop-foot' }, previewLink, cancel, send));
  }

  function renderRunning() {
    const skeleton = el('div', { class: 'rd-list' }, el('div', { class: 'rd-filters' }, ...[46, 64, 96].map(width => el('span', { class: 'rd-sk', style: `width:${width}px;height:26px` }))), el('div', { class: 'rd-list-head' }, el('span', { text: 'Waiting for findings…' })),
      ...[[64, 92, 40], [52, 78, 55], [88, 85, 30], [70, 66, 48]].map(([a, b, c]) => el('div', { class: 'rd-sk-row' }, el('span', { class: 'rd-sk', style: `width:${a}px;height:14px` }), el('span', { class: 'rd-sk', style: `width:${b}%` }), el('span', { class: 'rd-sk', style: `width:${c}%;opacity:.6` }))));
    const openLog = el('button', { type: 'button', class: 'rd-btn', text: 'Open run log' }); openLog.onclick = () => { chosenTab = true; setTab(true); };
    const detail = el('div', { class: 'rd-detail' }, el('div', { class: 'rd-d-scroll' }, el('div', { class: 'rd-d-top' }, el('span', { class: 'rd-sev lg', 'data-s': 'progress' }, pixel(document, 'spinner'), 'In progress')),
      el('h2', { class: 'rd-d-title', text: `Reviewing ${data?.pr.number ? `PR #${data.pr.number}` : 'the change'}` }), el('div', { class: 'rd-d-ver', text: 'You can close this view; the map card shows when it’s done.' }),
      logTail.length ? el('div', { class: 'rd-logtail', text: logTail.join('\n') }) : '', el('div', {}, openLog)));
    body.replaceChildren(skeleton, detail);
  }

  function renderText() {
    const retry = el('button', { type: 'button', class: 'rd-btn', text: 'Retry as findings' });
    retry.onclick = () => void act(async () => { retry.disabled = true; await services.runAction('review.retry', { requestId: crypto.randomUUID() }); });
    const legacy = /no findings JSON/i.test(data!.reason ?? ''), markdown = el('div', { class: 'rd-md markdown-content code-review-result' });
    if (data!.markdown) renderMarkdown(markdown, data!.markdown); else markdown.append(el('p', { text: 'This review returned no text. Check the run log.' }));
    const banner = el('div', { class: 'rd-banner', role: 'note' }, pixel(document, 'unverified'), el('div', {}, el('b', { text: 'Shown as text. ' }),
      legacy ? 'This review has no findings data, so it can’t be split into findings. Older reviews look like this too.' : `This review’s output didn’t match the findings format (${data!.reason}), so it can’t be split into findings.`), retry);
    body.replaceChildren(el('div', { class: 'rd-text' }, banner, markdown));
  }

  function render() {
    if (disposed) return;
    const refocus = document.activeElement === listbox;
    root.dataset.state = data?.state ?? 'running'; root.dataset.format = data?.format ?? '';
    // While a picker or selection is open, Escape dismisses it instead of closing the view.
    if (picker || selected.size || menuOpen) root.dataset.ownsEscape = ''; else delete root.dataset.ownsEscape;
    renderTitlebar(); renderHead(); const strip = loopStrip(); if (strip) head.prepend(strip);
    if (error) body.replaceChildren(el('p', { class: 'rd-pop-error', role: 'alert', text: error }));
    else if (!data || data.state === 'running') renderRunning();
    else if (data.format !== 'findings') renderText();
    else { if (!focus || !ordered().some(finding => finding.id === focus)) focus = ordered()[0]?.id ?? ''; body.replaceChildren(renderList(), renderDetail()); }
    renderSend(); renderStatusbar(); renderPicker(); setTab(showLog);
    if (refocus && listbox.isConnected) listbox.focus({ preventScroll: true });
  }

  async function act(work: () => Promise<unknown>) {
    try { error = ''; notice = ''; await work(); await reload(); } catch (reason) { error = ''; notice = (reason as Error).message; render(); }
  }
  async function readLoop() {
    const value = await services.runAction(REVIEW_LOOP_OPERATION, { operation: 'status' }).catch(() => undefined) as Loop | undefined, key = JSON.stringify(value ?? null);
    if (key === loopKey) return false;
    loopKey = key; loop = value && value.state !== 'off' && Array.isArray(value.rounds) ? { ...value, seen: value.seen ?? {} } : undefined; return true;
  }
  async function reload() {
    const loopChanged = await readLoop();
    try {
      const next = await services.runAction('review.findings', { operation: 'list' }) as unknown as DeskData, key = JSON.stringify(next);
      error = ''; if (key === loaded && next.state !== 'running') { if (loopChanged) render(); return; } loaded = key; data = next;
      if (done) { const current = sendFor(done.send.id); if (current) done = { ...done, send: current }; }
      if (data.state === 'running' && !chosenTab) showLog = false;
      if ((!options || !options.agents.length) && data.state !== 'running') loadOptions().then(() => { if (!picker) renderSend(); }).catch(() => {});
    } catch (reason) { error = (reason as Error).message; }
    if (data?.state === 'running' || showLog && !logFinal) await readLog();
    render();
  }
  async function readLog() {
    try {
      const finished = Boolean(data && data.state !== 'running'), snapshot = await services.runAction('session.read', {}) as { chunks?: { data: string }[] };
      const text = plainTerminal((snapshot.chunks ?? []).map(chunk => chunk.data).join(''));
      transcript = providerKey === 'claude' ? reviewTranscript(text) : undefined; logFinal = finished;
      logTail = (transcript ? transcript.map(line => line.detail ? `${line.text} · ${line.detail}` : line.text) : text.slice(-8000).split('\n'))
        .map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(-5).map(line => line.slice(0, 160));
    } catch { logTail = []; }
  }
  const schedule = () => { clearTimeout(timer); if (active && !disposed) timer = setTimeout(() => { void reload().finally(schedule); }, data?.state === 'running' ? 3000 : 5000); };
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const offRelated = services.observeRelated?.(() => { if (!active) return; clearTimeout(debounce); debounce = setTimeout(() => { void reload(); }, 150); });

  root.addEventListener('keydown', event => {
    const target = event.target as HTMLElement;
    if (target.closest('textarea, input:not([type=checkbox]), select') || showLog) { if (event.key === 'Escape' && picker) { picker = undefined; render(); event.stopPropagation(); } return; }
    if (target.closest('.rd-menu')) return;
    if (event.key === 'Escape') { if (menuOpen) menuOpen = false; else if (picker) picker = undefined; else if (selected.size) selected.clear(); else return; event.preventDefault(); event.stopPropagation(); render(); listbox.focus({ preventScroll: true }); return; }
    if (target.closest('.rd-pop')) { if (event.key === 'Enter' && !target.closest('button')) { event.preventDefault(); void sendNow(); } return; }
    if (data?.format !== 'findings' || data.state === 'running') return;
    const shown = visible(), index = shown.findIndex(finding => finding.id === focus);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!shown.length) return;
      const next = shown[Math.max(0, Math.min(shown.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
      if (event.shiftKey) { if (!anchor || !selected.size) anchor = focus || next.id; toggle(focus || next.id, true); toggle(next.id, true); }
      focus = next.id; notes = false;
    } else if (event.key === ' ' && focus && !target.closest('button')) { toggle(focus); anchor = focus; }
    else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { for (const finding of shown) toggle(finding.id, true); }
    else if (event.key === 'Enter' && selected.size && !target.closest('button, a')) { void openPicker(); }
    else if (/^[1-9]$/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) { const chip = body.querySelectorAll<HTMLButtonElement>('.rd-fchip')[Number(event.key) - 1]; if (!chip) return; chip.click(); }
    else return;
    event.preventDefault(); event.stopPropagation(); render();
    body.querySelector(`[data-finding="${focus}"]`)?.scrollIntoView?.({ block: 'nearest' });
    if (!target.closest('.rd-rows')) listbox.focus({ preventScroll: true });
  });

  setTab(false); render();
  return {
    update() {},
    setActive(value) { if (active === value) return; active = value; terminal.setActive?.(value && terminalShown()); clearTimeout(timer); if (value) void reload().finally(schedule); },
    dispose() { disposed = true; clearTimeout(timer); clearTimeout(debounce); offRelated?.(); terminal.dispose(); titlebar.remove(); root.remove(); },
  };
}
