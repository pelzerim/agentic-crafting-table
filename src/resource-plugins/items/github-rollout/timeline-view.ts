import type { JsonObject, MountedResourceView, ResourceRecord, ResourceSnapshot, ResourceViewServices } from '../../types.ts';
import type { RolloutObservation, RolloutQueue, RolloutQueueRun } from '../../../../packages/provider-runtime/github-rollout.ts';
import { loadResourceChoices, openResourceChoices } from '../../choices.ts';
import { activeValidation, ATTACH_VALIDATION, VALIDATION_AGENT, currentVerdict, coveredJobs, duration, inferStages, activeFirst, liveness, quietLabel, rolloutTimeline, safeUrl, stageOf, verdictLabels } from './validation.ts';
import { queuePlan, queueRef, queueWho } from './queue.ts';
import type { RolloutEvent, SnapshotJob, TimelineEntry, TimelineGroup, ValidationCheck, ValidationMetric, ValidationView } from './validation.ts';
import { plainLine, readableSource, splitLead } from './report-text.ts';
import { renderMarkdown } from '../../markdown-view.ts';
import { formatWhen } from '../../format-when.ts';
import { PIXEL_GLYPHS, pixelGlyphElement } from '../../pixel-glyphs.ts';
import { mountViewHeader, staleNotice } from '../../view-header.ts';
import { AUTO_DEPLOY_OPERATION } from './auto-deploy.ts';
import { approvalAttempt, approvalOutcome, approvalUnconfirmed, rolloutActions, rolloutEmptyHint, rolloutTone, validationAgents } from './presentation.ts';
import type { ApprovalAttempt, ApprovalOutcome, RolloutActionId, ValidationAgents } from './presentation.ts';

type Observation = RolloutObservation & { state: string; approvable?: boolean };
interface ListData { validations: ValidationView[]; events: RolloutEvent[] }
type Filter = 'all' | 'validations' | 'jobs' | 'problems';

const GRIDS: Record<string, readonly string[]> = PIXEL_GLYPHS[8];
const VERDICT_GLYPH: Record<string, [string, string]> = { passed: ['check', 'Passed'], concerns: ['bang', 'Concerns'], failed: ['cross', 'Failed'], inconclusive: ['question', 'Inconclusive'],
  running: ['spinner', 'Validating'], requested: ['hourglass', 'Requested'], 'no-report': ['dash', 'No report'] };
const CHECK_GLYPH: Record<string, [string, string]> = { passed: ['check', 'Passed'], concern: ['bang', 'Concern'], failed: ['cross', 'Failed'], skipped: ['dash', 'Skipped'], running: ['spinner', 'Checking'], pending: ['pending', 'Planned'] };
const EVIDENCE_GLYPH: Record<string, string> = { dashboard: 'chart', logs: 'logs', job: 'job', run: 'play', pr: 'pr', other: 'chart' };
const SVG = 'http://www.w3.org/2000/svg';
const clock = (at: number) => formatWhen(at, 'stamp');
const time = (value?: string | null) => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : undefined; };
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const agentName = (view: ValidationView) => view.agent.provider ? view.agent.provider[0].toUpperCase() + view.agent.provider.slice(1) : view.agent.title.split(/\s+·\s+/)[0];
const minutes = (ms: number) => duration(ms).replace('<1m', '<1 min').replace(/m$/, ' min');
const initials = (login: string) => { const parts = login.split(/[-_.]+/).filter(Boolean); return (parts.length > 1 ? parts[0][0] + parts[1][0] : login.slice(0, 2)).toUpperCase(); };
const hue = (login: string) => [...login].reduce((sum, char) => sum + char.charCodeAt(0) * 37, 0) % 360;
const HOLDING = { approval: 'waiting for approval', protection: 'waiting on protection rules', failing: 'failing' } as const;
const failedJob = (job: SnapshotJob) => ['failure', 'timed_out', 'startup_failure'].includes(job.conclusion ?? '');
function jobState(job: SnapshotJob) {
  if (job.status === 'completed') return failedJob(job) ? 'failed' : job.conclusion === 'cancelled' ? 'cancelled' : job.conclusion === 'skipped' ? 'skipped' : 'done';
  return job.status === 'in_progress' ? 'running' : job.status === 'waiting' ? 'waiting' : 'queued';
}
/** How long an approval GitHub never confirmed is checked against the rollout, and how often the rollout is re-read meanwhile. */
const APPROVAL_CONFIRM_WAIT_MS = 60_000, APPROVAL_CONFIRM_POLL_MS = 5000;
const APPROVAL_CHECKING = 'Approval not confirmed yet; checking the rollout…';
const APPROVAL_UNSETTLED: Record<Exclude<ApprovalOutcome, 'approved'>, string> = { waiting: 'The approval did not go through. No validation was requested.',
  moved: 'This rollout moved to another run or attempt. No validation was requested.', unread: 'The rollout could not be re-read, so the approval is still unconfirmed. No validation was requested.' };
const JOB_GLYPH: Record<string, string> = { done: 'check', failed: 'cross', cancelled: 'cross', skipped: 'dash', running: 'spinner', waiting: 'hourglass', queued: 'pending' };
/** Below this view width the jobs rail folds on its own, unless it was opened at that width. */
const NARROW_VIEW = 700;
const TEXT_ENTRY = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="menu"]';

/** Rollout full view: a live-jobs rail beside a timeline of what the
 * rollout did and what validating agents reported. While queued behind other runs
 * the body is the queue ladder instead. */
export function mountRolloutTimeline(container: HTMLElement, resource: ResourceRecord, services: ResourceViewServices): MountedResourceView {
  const document = container.ownerDocument;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', ...children: (Node | string | false | undefined | null)[]) => {
    const node = document.createElement(tag); if (className) node.className = className;
    for (const child of children) if (child !== false && child !== undefined && child !== null) node.append(child);
    return node;
  };
  const pixel = (name: string, small = true) => {
    const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('viewBox', '0 0 8 8'); svg.setAttribute('class', `rv-px${small ? ' s12' : ''}`); svg.setAttribute('aria-hidden', 'true');
    GRIDS[name].forEach((row, y) => [...row].forEach((cell, x) => { if (cell !== 'X') return; const rect = document.createElementNS(SVG, 'rect'); for (const [key, value] of Object.entries({ x, y, width: 1, height: 1 })) rect.setAttribute(key, String(value)); svg.append(rect); }));
    return svg;
  };
  const button = (text: string | Node, className = '', label?: string) => { const node = el('button', className, text); node.type = 'button'; if (label) node.setAttribute('aria-label', label); return node; };
  const badgeKey = (view: ValidationView) => view.state === 'final' ? view.verdict ?? 'inconclusive' : view.resolvedBy ? 'no-report' : view.state;
  const badge = (key: string, stale = false) => { const [glyph, text] = VERDICT_GLYPH[key]; const node = el('span', `rv-badge${stale ? ' stale' : ''}`, pixel(glyph), text); node.dataset.v = key; return node; };
  /** An agent's text as Markdown: paragraphs, lists, emphasis, code and https links; any HTML stays visible text. */
  const prose = (className: string, source: string) => {
    const node = el('div', `rv-prose ${className}`); renderMarkdown(node, readableSource(source), { breaks: true });
    for (const link of node.querySelectorAll('a')) {
      const href = safeUrl(link.getAttribute('href') ?? '');
      if (!href) { link.replaceWith(...link.childNodes); continue; }
      link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    }
    return node;
  };
  const inline = (source: string) => { const node = prose('', source), only = node.childElementCount === 1 && node.firstElementChild?.tagName === 'P' ? node.firstElementChild : node; return [...only.childNodes]; };
  /** A validation under way: its last report and the lead's current step, amber once it went quiet. */
  const live = <K extends 'p' | 'span'>(tag: K, view: ValidationView, now: number) => {
    const state = liveness(view, now), reported = state.reportedAt;
    const when = state.quiet ? `${quietLabel(state.quietMs)}${reported === undefined ? '' : ` · last report ${clock(reported)}`}` : reported === undefined ? `Waiting for the first report since ${clock(view.updatedAt)}` : `Last report ${clock(reported)} · ${formatWhen(reported, 'relative', now)}`;
    const node = el(tag, 'rv-live', pixel(state.quiet ? 'bang' : 'hourglass'), el('span', '', [when, state.step].filter(Boolean).join(' · ')));
    if (state.quiet) node.dataset.quiet = '';
    return node;
  };
  const who = (view: ValidationView, short = false) => { const provider = view.agent.provider === 'codex' ? 'codex' : 'claude'; const node = el('span', 'rv-who', el('span', `rv-${provider}`, pixel(provider)), short ? agentName(view) : view.agent.title); return node; };

  const root = el('section', 'rollout-detail rv'); root.setAttribute('aria-label', 'Rollout'); root.tabIndex = -1;
  const status = button('Reading…', 'rollout-state'); status.disabled = true; status.dataset.tone = 'neutral';
  const repository = `${resource.data.owner}/${resource.data.repo}`, verdictLine = el('p', 'rv-verdict');
  const head = el('header', 'rv-head', verdictLine);
  const error = el('p', 'rollout-error'); error.setAttribute('role', 'status'); error.hidden = true;
  const attempts = el('div', 'rv-attempts'); attempts.setAttribute('role', 'tablist'); attempts.setAttribute('aria-label', 'Attempts');
  const railSummary = el('p', 'rv-rail-summary'), jobsList = el('ul', 'rv-jobs'), railFoot = el('p', 'rv-rail-foot');
  jobsList.setAttribute('aria-label', 'Rollout jobs');
  const fold = button('‹', 'rv-fold'); fold.setAttribute('aria-keyshortcuts', '['); fold.onclick = () => toggleRail();
  const strip = el('div', 'rv-strip'); strip.setAttribute('role', 'group'); strip.setAttribute('aria-label', 'Jobs, folded');
  const tip = el('span', 'rv-strip-tip'); tip.setAttribute('aria-hidden', 'true'); tip.hidden = true;
  const rail = el('aside', 'rv-rail', el('div', 'rv-rail-top', el('div', 'rv-rail-line', railSummary, fold), attempts), strip, el('div', 'rv-rail-list', jobsList), railFoot);
  rail.setAttribute('aria-label', 'Jobs by stage'); rail.id = `rv-rail-${resource.id}`; fold.setAttribute('aria-controls', rail.id);
  const filters = el('div', 'rv-filters');
  let agents: ValidationAgents = { agents: 0, ready: 0, blocked: 'Finding connected agents…' };
  const controls = Object.fromEntries(rolloutActions({ gate: false, ...agents }).map(action => {
    const control = button(action.label); control.disabled = true;
    if (action.id !== 'validate') { control.setAttribute('aria-haspopup', 'menu'); control.setAttribute('aria-expanded', 'false'); }
    if (action.id === 'approve-validate' || action.id === 'approve') control.dataset.irreversible = '';
    control.onclick = () => menu(control, action.id);
    return [action.id, control];
  })) as Record<RolloutActionId, HTMLButtonElement>;
  const feed = el('div', 'rv-feed'); feed.setAttribute('role', 'list'); feed.setAttribute('aria-label', 'Rollout timeline');
  const reuseNote = el('div', 'rv-reuse'); reuseNote.setAttribute('role', 'status'); reuseNote.hidden = true;
  const timeline = el('div', 'rv-timeline', el('div', 'rv-toolbar', filters), reuseNote, feed);
  const body = el('div', 'rv-body', rail, timeline, tip), ladder = el('section', 'rv-queue'); ladder.setAttribute('aria-label', 'Rollout queue'); ladder.hidden = true;
  const deployText = el('span'), deployPull = button('Open pull request', 'rv-auto-deploy-open'), deployLine = el('p', 'rv-auto-deploy', deployText, deployPull);
  deployLine.setAttribute('role', 'status'); deployLine.hidden = true;
  root.append(head, deployLine, error, body, ladder); container.append(root);
  /** The pull request whose auto deploy follows this rollout, and its step. */
  async function readAutoDeploy() {
    const value = await services.runAction(AUTO_DEPLOY_OPERATION, { operation: 'status' }).catch(() => undefined) as { state?: string; line?: string; pullNodeId?: string; pullTitle?: string } | undefined;
    if (disposed) return;
    deployLine.hidden = !value?.line || value.state === 'stopped';
    deployLine.dataset.state = value?.state ?? 'off';
    deployText.textContent = value?.line ? `Under auto deploy from ${value.pullTitle ?? 'its pull request'} · ${value.line.replace(/^Auto deploy · /, '')}` : '';
    deployPull.onclick = () => { if (value?.pullNodeId) services.openResource(value.pullNodeId); };
  }
  const header = mountViewHeader(document, services, root, { chip: status, menu: 'Actions', onRefresh: () => { void refreshAll(true); } });
  header.actions.append(...Object.values(controls)); header.update({ meta: [repository] });

  let active = false, disposed = false, generation = 0, loading = false, rendered = '', snapshot: ResourceSnapshot | undefined, list: ListData | undefined;
  let filter: Filter = 'all', jobFilter: string | undefined, attempt: number | undefined, picked: number | undefined;
  const expanded = new Map<string, boolean>(), shown = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined, listTimer: ReturnType<typeof setInterval> | undefined;
  let closeMenu: (() => void) | undefined;
  /** The chat validation a Validate request was shown instead of a second one, whether its card still has to be scrolled to,
   * and the one the service said covers the stage the run has reached. */
  let attached: string | undefined, reveal = false, reuse: string | undefined;
  const report = (message: string) => { if (active && !disposed) { error.textContent = message; error.hidden = !message; } };
  const validation = { load: 'options', apply: 'trigger', runtime: 'rollout.validation' }, approval = { load: 'rollout.approval.options', apply: 'rollout.approve', irreversible: true };
  const approvalLabels = { menu: 'Approve deployment', loading: 'Checking approvals…', pending: 'Approving on GitHub…', confirm: 'Confirm approval' };
  let approvalWait: { reread(): void; stop(): void } | undefined;
  /** Validation requests answered by a chat validation already covering the stage show it; one that was sent clears that. */
  const validating: Pick<ResourceViewServices, 'runAction'> = { runAction: async (action, input) => {
    const result = await services.runAction(action, input) as { attached?: unknown; sent?: unknown; validationId?: unknown } | undefined;
    if (action === validation.runtime && result?.attached === true && typeof result.validationId === 'string') { attached = result.validationId; reveal = true; jobFilter = undefined; filter = 'all'; }
    else if (action === validation.runtime && result?.sent === true) attached = undefined;
    return result as Awaited<ReturnType<ResourceViewServices['runAction']>>;
  } };
  /** Re-reads the rollout until it shows what became of an approval GitHub never confirmed, or the wait runs out.
   * Only a read that arrived after the approval counts. Resolves undefined once the view is left. */
  const confirmApproval = (tried: ApprovalAttempt) => new Promise<ApprovalOutcome | undefined>(resolve => {
    const deadline = Date.now() + APPROVAL_CONFIRM_WAIT_MS, before = snapshot;
    const finish = (outcome?: ApprovalOutcome) => { if (approvalWait !== wait) return; clearInterval(poll); approvalWait = undefined; if (outcome) render(); resolve(outcome); };
    const reread = (force: boolean) => { void load(force).then(() => {
      if (approvalWait !== wait) return;
      const outcome = snapshot === before ? 'unread' : approvalOutcome(tried, snapshot);
      if (outcome === 'approved' || outcome === 'moved' || Date.now() >= deadline) finish(outcome); else { render(); report(APPROVAL_CHECKING); }
    }); };
    const poll = setInterval(() => reread(true), APPROVAL_CONFIRM_POLL_MS);
    const wait = approvalWait = { reread: () => reread(false), stop: () => finish() };
    report(APPROVAL_CHECKING); render(); reread(true);
  });
  /** The approval confirmation; once GitHub took the approval, the validation is requested from the agent chosen before.
   * A refused approval requests nothing; one whose outcome is unknown is first checked against the rollout. */
  const approveThenValidate = (trigger: HTMLButtonElement, request: JsonObject) => openResourceChoices(trigger, { runAction: async (action, input) => {
    if (action !== 'resource.action' || input?.actionId !== approval.apply) return services.runAction(action, input);
    let result: Awaited<ReturnType<ResourceViewServices['runAction']>> = undefined;
    try { result = await services.runAction(action, input); }
    catch (failure) {
      const tried = approvalUnconfirmed(failure) && active && !disposed ? approvalAttempt(input.input as JsonObject) : undefined;
      if (!tried) throw failure;
      const outcome = await confirmApproval(tried);
      if (outcome !== 'approved') throw outcome ? new Error(APPROVAL_UNSETTLED[outcome]) : failure;
    }
    report('Sending the validation request…');
    try { await validating.runAction(validation.runtime, { operation: validation.apply, ...request }); }
    catch (failure) { await refreshAll(true); throw new Error(`Approved, but the validation request was not sent. ${(failure as Error).message}`); }
    return result;
  } }, approval, () => refreshAll(true), report, approvalLabels);
  /** The one-click request: an idle hidden validation agent of this rollout, else a new hidden one, scoped to the phase that ran
   * since the attempt's last validation. */
  const oneClick = (): JsonObject => ({ sourceResourceId: resource.id, value: VALIDATION_AGENT, requestId: crypto.randomUUID(), phased: true });
  let starting = false;
  /** Validate asks the rollout's validation agent in one click; while a chat validation covers the stage it shows that one instead.
   * Validate with… and Re-run (`again`) offer the agents. Approve and validate confirms the approval, then validates in one click. */
  const menu = (trigger: HTMLButtonElement, kind: RolloutActionId, again = false) => {
    if (!active || disposed || approvalWait && kind !== 'validate' && kind !== 'validate-with') return;
    if (trigger.getAttribute('aria-expanded') === 'true') { closeMenu?.(); return; }
    closeMenu?.();
    if (kind === 'validate' && reuse && !again) {
      report('');
      void validating.runAction(validation.runtime, { operation: validation.apply, sourceResourceId: resource.id, value: ATTACH_VALIDATION, requestId: crypto.randomUUID() })
        .then(() => refreshAll(true), () => { reuse = undefined; menu(trigger, kind); });
      return;
    }
    if (kind === 'validate' && !again) {
      if (starting) return;
      starting = true; trigger.disabled = true; report('Sending the validation request…');
      void validating.runAction(validation.runtime, { operation: validation.apply, ...oneClick() })
        .then(() => { report(''); }, failure => { report((failure as Error).message); }).finally(() => { starting = false; void refreshAll(true); });
      return;
    }
    closeMenu = kind === 'validate' || kind === 'validate-with' ? openResourceChoices(trigger, validating, validation, () => refreshAll(true), report, { menu: 'Trigger validation', loading: 'Finding connected agents…', pending: 'Sending the validation request…' })
      : kind === 'approve' ? openResourceChoices(trigger, services, approval, () => refreshAll(true), report, approvalLabels)
        : approveThenValidate(trigger, oneClick());
  };
  const showApproval = () => {
    if (picked !== undefined) { picked = undefined; render(true); }
    const approve = railFolded() ? null : jobsList.querySelector<HTMLButtonElement>('.rv-approve');
    if (!approve) { menu(status, 'approve'); return; }
    approve.scrollIntoView({ block: 'nearest' }); approve.focus();
  };
  status.onclick = () => { if (!status.disabled) showApproval(); };
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && jobFilter) { event.preventDefault(); event.stopPropagation(); jobFilter = undefined; render(true); } });

  /** The rail starts folded; opening it is saved in this item's view state. A narrow view folds it without saving, until it is opened at that width. */
  let railSaved = services.viewState?.().jobsRail !== 'open', narrow = false, openedNarrow = false;
  const railFolded = () => narrow ? !openedNarrow : railSaved;
  const paintRail = () => {
    const folded = railFolded(), label = folded ? 'Show the jobs rail' : 'Fold the jobs rail';
    root.dataset.rail = folded ? 'folded' : 'open'; fold.textContent = folded ? '›' : '‹';
    fold.setAttribute('aria-label', label); fold.title = `${label} ( [ )`; fold.setAttribute('aria-expanded', String(!folded));
    if (!folded) tip.hidden = true;
  };
  const toggleRail = () => {
    const next = !railFolded();
    if (narrow) openedNarrow = !next;
    if (next !== railSaved) { railSaved = next; services.saveViewState?.({ jobsRail: next ? null : 'open' }); }
    paintRail();
  };
  const sizes = new ResizeObserver(() => {
    const width = root.clientWidth; if (!width) return;
    const now = width < NARROW_VIEW; if (now === narrow) return;
    narrow = now; if (!narrow) openedNarrow = false; paintRail();
  });
  sizes.observe(root); paintRail();
  const railKey = (event: KeyboardEvent) => {
    if (event.key !== '[' || event.defaultPrevented || event.repeat || event.isComposing || event.metaKey || event.ctrlKey || body.hidden) return;
    const target = event.target instanceof Element ? event.target : null, frame = root.closest('[data-expanded-item-id]') ?? root;
    if (!target || !frame.contains(target) || target.closest(TEXT_ENTRY)) return;
    event.preventDefault(); toggleRail();
  };
  document.addEventListener('keydown', railKey);
  /** A folded glyph names its job beside the strip, on hover and on keyboard focus. */
  const showTip = (event: Event) => {
    const glyph = (event.target as Element).closest<HTMLElement>('.rv-strip-job'); if (!glyph) return;
    const base = body.getBoundingClientRect(), box = glyph.getBoundingClientRect(), scale = body.offsetWidth / (base.width || 1);
    tip.textContent = glyph.dataset.name ?? ''; tip.style.left = `${(box.right - base.left) * scale + 6}px`; tip.style.top = `${(box.top + box.height / 2 - base.top) * scale}px`; tip.hidden = false;
  };
  const hideTip = () => { tip.hidden = true; };
  strip.addEventListener('pointerover', showTip); strip.addEventListener('focusin', showTip); strip.addEventListener('pointerleave', hideTip); strip.addEventListener('focusout', hideTip);

  async function readList() {
    const connected = loadResourceChoices(services, validation.load, validation.runtime).then(choices => { reuse = typeof choices.context.rerun === 'string' ? choices.context.rerun : undefined; return validationAgents(choices.options); },
      (failure): ValidationAgents => ({ agents: 0, ready: 0, blocked: (failure as Error).message }));
    try { list = await services.runAction('rollout.validation', { operation: 'list' }) as unknown as ListData; }
    catch (failure) { if (!list) report((failure as Error).message); }
    await readAutoDeploy();
    agents = await connected;
  }
  async function refreshAll(force = false) { await Promise.all([load(force), readList()]); render(); }
  async function load(force = false) {
    if (!active || loading) return;
    loading = true; const current = generation; header.busy(true);
    try {
      const next = await services.runAction('resource.read', { refresh: force }) as unknown as ResourceSnapshot;
      if (disposed || !active || current !== generation) return;
      if (!next?.detail) throw new Error('Rollout content is unavailable.');
      snapshot = next;
      error.hidden = !next.stale; error.textContent = next.stale ? staleNotice({ observedAt: next.observedAt, error: next.error, provider: 'GitHub' }) : '';
      header.freshness({ observedAt: next.observedAt, stale: next.stale, error: next.error, provider: 'GitHub' });
    } catch (failure) {
      if (!disposed && active && current === generation) { error.hidden = false; error.textContent = (failure as Error).message; if (!snapshot) { status.textContent = 'Unavailable'; status.dataset.tone = 'red'; } else header.freshness({ observedAt: snapshot.observedAt, stale: true, error: (failure as Error).message, provider: 'GitHub' }); }
    } finally {
      loading = false;
      if (!disposed && active) { header.busy(false); clearTimeout(timer); timer = setTimeout(() => { void load().then(() => render()); }, current === generation ? 15_000 : 0); }
    }
  }

  function render(force = false) {
    if (!snapshot || disposed) return;
    const value = snapshot.detail as unknown as Observation, now = Date.now();
    const approvable = value.state === 'approval' && value.approvable === true;
    for (const action of rolloutActions({ gate: approvable, covered: Boolean(reuse), ...agents })) {
      const control = controls[action.id], reason = action.reason ?? (approvalWait && action.id.startsWith('approve') ? 'Checking whether the last approval went through.' : undefined);
      control.disabled = !!reason || action.id === 'validate' && starting; control.toggleAttribute('data-primary', action.primary);
      if (reason) control.title = reason; else control.removeAttribute('title');
    }
    const key = JSON.stringify([value, list, filter, jobFilter, picked, [...expanded], [...shown], Math.floor(now / 60_000), snapshot.indicators?.[0]?.label, list?.validations.map(view => liveness(view, now).quiet), attached]);
    // An open menu closes when anything behind it scrolls or is replaced; update once it closes.
    if (key === rendered && !force || !force && [root, header.element].some(part => part.querySelector('[aria-haspopup=menu][aria-expanded=true]'))) return;
    rendered = key;
    // The map closes the view on Escape unless the view owns it; keep it until this keypress is over.
    if (jobFilter) root.dataset.ownsEscape = ''; else setTimeout(() => { if (!jobFilter) delete root.dataset.ownsEscape; });
    const views = list?.validations ?? [], events = list?.events ?? [], run = value.run;
    const groups = rolloutTimeline(value, events, views), currentGroup = groups.find(group => group.current);
    const glyph = ({ passed: 'check', failed: 'cross', cancelled: 'cross', approval: 'bang', waiting: 'hourglass', unknown: 'bang', 'no-runs': 'pending', skipped: 'dash' } as Record<string, string>)[value.state] ?? 'spinner';
    const queue = value.state === 'queued' && value.queue?.ahead.length ? value.queue : undefined, stuck = queue?.ahead.some(entry => entry.stuck);
    status.replaceChildren(pixel(stuck ? 'bang' : glyph), stuck ? 'Queued · blocker stuck' : snapshot.indicators?.[0]?.label ?? snapshot.label); status.dataset.state = stuck ? 'queued-stuck' : value.state; status.dataset.tone = rolloutTone(status.dataset.state); status.disabled = !approvable;
    status.toggleAttribute('data-jump', approvable); if (approvable) status.title = 'Go to the approval gate'; else status.removeAttribute('title');
    const jobsDone = value.jobs.filter(job => job.status === 'completed').length;
    header.update({ meta: [repository, value.followsLatest ? `following ${value.branch ?? 'latest run'}` : 'pinned run', run && `run #${run.run_number}`, run && `attempt ${run.run_attempt}`, run && run.head_sha.slice(0, 7), value.jobs.length > 0 && `${jobsDone}/${value.jobs.length} jobs`],
      link: { url: value.url, provider: 'GitHub' } });
    const environments = [...new Set([...value.gates.map(gate => gate.environment.name), ...events.filter(event => event.environment).map(event => event.environment)])];
    renderVerdict(views, run, groups, environments);
    const runGroups = groups.filter(group => group.runId === run?.id).sort((a, b) => a.attempt - b.attempt);
    if (!runGroups.some(group => group.attempt === picked)) picked = undefined;
    attempt = picked ?? run?.run_attempt;
    const focused = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement.closest<HTMLElement>('[data-focus-key]')?.dataset.focusKey : undefined;
    body.hidden = !!queue; ladder.hidden = !queue;
    if (queue) renderLadder(queue, value, now);
    renderRail(value, runGroups, views, events, environments, now);
    renderReuse(views, now);
    renderFeed(value, groups, environments, currentGroup, now, views.length);
    if (reveal && attached) { reveal = false; feed.querySelector(`.rv-card[aria-label^="${CSS.escape(attached)} · "]`)?.scrollIntoView({ block: 'nearest' }); }
    if (focused) root.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focused)}"]`)?.focus();
  }

  /** Says which chat validation answered the request, with Re-run to ask for a second one anyway. */
  function renderReuse(views: ValidationView[], now: number) {
    const view = attached ? views.find(entry => entry.label === attached) : undefined;
    reuseNote.hidden = !view;
    if (!view) return;
    const state = view.state === 'final' && view.verdict ? `${verdictLabels[view.verdict].toLowerCase()} ${clock(view.finishedAt ?? view.updatedAt)}` : `still running · ${liveness(view, now).reportedAt === undefined ? 'no report yet' : `last report ${clock(liveness(view, now).reportedAt!)}`}`;
    const rerun = button('Re-run', 'rv-button'); rerun.setAttribute('aria-haspopup', 'menu'); rerun.setAttribute('aria-expanded', 'false'); rerun.onclick = () => menu(rerun, 'validate', true);
    const dismiss = button(pixelGlyphElement(document, 'close'), 'rv-chip-clear', 'Dismiss'); dismiss.onclick = () => { attached = undefined; render(true); };
    const origin = view.chat ? ', started from chat,' : ' of the last phase';
    reuseNote.replaceChildren(el('span', '', `Showing ${view.label}${origin} instead of a second validation: ${state}.`), rerun, dismiss);
  }

  function renderLadder(queue: RolloutQueue, value: Observation, now: number) {
    const plan = queuePlan(queue, now), stuck = plan.rungs.find(rung => rung.state === 'stuck'), count = queue.ahead.length, next = count === 1 && !stuck, branch = queue.branch ?? value.run?.head_branch;
    const eta = plan.startsInMs === undefined ? '' : minutes(plan.startsInMs);
    const heading = next ? 'Next up' : `${plural(count, 'rollout')} ahead of you`;
    const sub = stuck ? `${count === 1 ? 'It is' : `${queueRef(stuck.entry)} is`} ${HOLDING[stuck.entry.stuck!.reason]} and holding the queue`
      : next ? `Waiting for 1 rollout to finish${eta ? ` · ~${eta}` : ''}` : `Same workflow${branch ? ` on ${branch}` : ''}${eta ? ` · you start in ~${eta}` : ''}`;
    const link = (text: string, url?: string) => { const href = safeUrl(url ?? ''); if (!href) return undefined; const node = el('a', 'rv-rung-link view-link-out', text); node.href = href; node.target = '_blank'; node.rel = 'noopener noreferrer'; return node; };
    const rung = (entry: RolloutQueueRun, state: string, position: Node | string, meta: (Node | string | undefined)[], side: (Node | string | undefined)[]) => {
      const who = queueWho(entry), verb = entry.pull?.mergedBy ? 'merged by' : entry.pull?.author ? 'opened by' : 'pushed by';
      const since = time(entry.pull?.mergedBy ? entry.pull.mergedAt : entry.createdAt), avatar = el('span', 'rv-avatar', initials(who)); avatar.style.setProperty('--hue', String(hue(who))); avatar.setAttribute('aria-hidden', 'true');
      const title = el('div', 'rv-rung-title', entry.pull?.title ?? entry.title ?? `Run #${entry.number}`, ' ', el('span', 'rv-rung-num', entry.pull ? `#${entry.pull.number}` : `run #${entry.number}`));
      if (entry.pull) title.title = `${entry.pull.title} · #${entry.pull.number}${entry.pull.author ? ` by ${entry.pull.author}` : ''}`;
      const row = el('li', 'rv-rung', el('span', 'rv-pos', position), el('div', 'rv-rung-main', title, el('div', 'rv-rung-who', avatar, `${verb} `, el('b', '', who), since !== undefined ? ` · ${minutes(now - since)} ago` : ''), ...meta.filter((part): part is Node | string => part !== undefined)),
        el('div', 'rv-rung-side', ...side.filter((part): part is Node | string => part !== undefined)));
      row.dataset.state = state; return row;
    };
    const rows = plan.rungs.map((entry, index) => {
      const run = entry.entry, openRun = link('Open run', run.url);
      if (entry.state === 'stuck') {
        const stuckFor = minutes(entry.stuckMs ?? 0), environment = run.stuck!.environment ? ` for ${run.stuck!.environment}` : '';
        const text = run.stuck!.reason === 'approval' ? `Waiting approval${environment}` : run.stuck!.reason === 'protection' ? `Waiting on protection rules${environment}` : 'Failing';
        return rung(run, 'stuck', pixel('bang', false), [el('div', 'rv-rung-meta', `${text} · ${stuckFor}`)], [el('span', '', `stuck ${stuckFor}`), openRun]);
      }
      if (entry.state === 'running') {
        const jobs = run.jobs, bar = jobs?.total ? el('div', 'rv-prog', el('i')) : undefined;
        if (bar && jobs) (bar.firstChild as HTMLElement).style.width = `${Math.round(jobs.done / jobs.total * 100)}%`;
        return rung(run, 'running', pixel('play', false), [bar, el('div', 'rv-rung-meta', `Running${jobs ? ` · ${jobs.done}/${jobs.total} jobs` : ''}${jobs?.current ? ` · ${jobs.current}` : ''}`)],
          [entry.remainingMs !== undefined ? el('span', '', `~${minutes(entry.remainingMs)} left`) : undefined, openRun]);
      }
      return rung(run, 'queued', String(index + 1), [el('div', 'rv-rung-meta', `Queued${queue.typicalMs !== undefined && entry.remainingMs !== undefined ? ` · then ~${minutes(queue.typicalMs)}` : ''}`)], [link('Open PR', run.pull?.url) ?? openRun]);
    });
    const since = time(queue.you.startedAt ?? queue.you.createdAt);
    rows.push(rung(queue.you, 'you', 'you', [el('div', 'rv-rung-meta', [since !== undefined && `Queued since ${minutes(now - since)}`, eta && `starts in ~${eta}`].filter(Boolean).join(' · '))], []));
    const ladderList = el('ol', 'rv-ladder', ...rows); ladderList.setAttribute('aria-label', 'Runs ahead of this rollout');
    ladder.replaceChildren(el('div', '', el('h3', 'rv-queue-title', heading), el('p', 'rv-queue-sub', sub)), ladderList,
      el('p', 'rv-queue-hint', `Rungs leave as they finish; once your run starts this becomes the timeline and live jobs. GitHub does not expose concurrency groups, so this lists the same workflow${branch ? ` on ${branch}` : ''}.`));
  }

  function renderVerdict(views: ValidationView[], run: Observation['run'], groups: TimelineGroup[], environments: string[]) {
    const verdict = currentVerdict(views), running = activeValidation(views);
    const scopeText = (view: ValidationView) => {
      if (view.scope.environments?.length) return `the ${view.scope.environments.join(', ')}`;
      if (!view.scope.jobs?.length) return 'the whole run';
      const jobs = groups.find(group => group.runId === view.scope.runId && group.attempt === view.scope.attempt)?.jobs ?? [];
      const stages = [...new Set(jobs.filter(job => view.scope.jobs!.includes(job.id)).map(job => stageOf(job.name, environments)).filter(Boolean))];
      return stages.length ? `the ${stages.join(' and ')}` : plural(view.scope.jobs.length, 'job');
    };
    const parts: (Node | string)[] = [];
    if (verdict) {
      const age = Date.now() - (verdict.validation.finishedAt ?? verdict.validation.updatedAt);
      parts.push(badge(verdict.verdict), el('span', '', el('b', '', `Current verdict: ${verdictLabels[verdict.verdict].toLowerCase()}`), ` from ${agentName(verdict.validation)} on ${scopeText(verdict.validation)}, ${age < 60_000 ? 'just now' : `${duration(age)} ago`}.`));
      if (running) parts.push(el('span', 'rv-faint', `${agentName(running)} ${verdict.validation.agentNodeId === running.agentNodeId ? 'is re-checking' : 're-checking'}`), live('span', running, Date.now()));
    } else if (running) {
      const checks = running.report?.checks ?? [], done = checks.filter(check => !['running', 'pending'].includes(check.status)).length;
      parts.push(badge(running.state), el('span', '', el('b', '', `${agentName(running)} is validating ${scopeText(running).replace(/^the (?!whole)/, '')}`), checks.length ? ` · ${done} of ${checks.length} checks.` : ' · waiting for the first report.'), live('span', running, Date.now()), el('span', 'rv-faint', 'No verdict yet on this attempt.'));
    } else {
      const stale = views.filter(view => view.stale && view.state === 'final' && (view.verdict === 'failed' || view.verdict === 'concerns')).at(-1);
      parts.push(el('span', 'rv-faint', views.length ? 'No current verdict.' : 'No validations yet. Validate starts an agent that checks this rollout.'));
      if (stale) parts.push(el('span', '', `${agentName(stale)}'s ${stale.verdict} validation was about ${stale.scope.runId === run?.id ? `attempt ${stale.scope.attempt}` : `run ${stale.scope.runId}`} and no longer counts.`));
    }
    const resolved = views.filter(view => view.resolvedBy).length, stale = views.filter(view => view.stale).length;
    if (verdict && !running && (resolved || stale)) parts.push(el('span', 'rv-faint', [plural(views.length, 'validation'), resolved && `${resolved} resolved`, stale && `${stale} stale`].filter(Boolean).join(' · ')));
    verdictLine.replaceChildren(...parts);
  }

  function stampFor(view: ValidationView) {
    const key = view.state === 'final' ? view.verdict! : 'running', node = el('span', 'rv-stamp', pixel(key === 'running' ? 'search' : VERDICT_GLYPH[key][0]));
    node.dataset.v = key; node.title = `${view.label} · ${key === 'running' ? 'Validating' : verdictLabels[view.verdict!]} · ${agentName(view)}`; return node;
  }
  function renderRail(value: Observation, runGroups: TimelineGroup[], views: ValidationView[], events: RolloutEvent[], environments: string[], now: number) {
    const run = value.run, approvable = value.state === 'approval' && value.approvable === true;
    attempts.replaceChildren(...runGroups.map(group => {
      const current = group.current, state = current ? { approval: 'waiting', waiting: 'waiting', passed: 'passed', failed: 'failed', cancelled: 'cancelled' }[value.state] ?? 'running' : group.conclusion === 'success' ? 'passed' : group.conclusion === 'cancelled' ? 'cancelled' : 'failed';
      const tab = button(el('span', '', pixel(state === 'passed' ? 'check' : state === 'failed' || state === 'cancelled' ? 'cross' : state === 'waiting' ? 'gate' : 'spinner'), `#${group.attempt} ${state}`), 'rv-attempt');
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(group.attempt === attempt)); tab.dataset.state = state;
      tab.onclick = () => { picked = group.current ? undefined : group.attempt; render(true); };
      return tab;
    }));
    attempts.hidden = runGroups.length < 2;
    const group = runGroups.find(entry => entry.attempt === attempt), current = !!group?.current, jobs = group?.jobs ?? [];
    const running = jobs.filter(job => job.status === 'in_progress').length, done = jobs.filter(job => job.status === 'completed').length, blocked = jobs.filter(job => job.status === 'waiting').length;
    const waitingGate = current ? events.filter(event => event.runId === run?.id && event.attempt === attempt && event.kind === 'gate-waiting' && value.gates.some(gate => gate.environment.name === event.environment)) : [];
    const starts = jobs.map(job => time(job.started_at)).filter((entry): entry is number => entry !== undefined), ends = jobs.map(job => time(job.completed_at)).filter((entry): entry is number => entry !== undefined);
    const summary: (Node | string)[] = [];
    if (!current) summary.push(group?.label.replace(/^Attempt \d+ · /, '').replace(/ · superseded$/, '') ?? '', ` · ${done}/${jobs.length} done`);
    else if (value.state === 'passed' && starts.length && ends.length) summary.push(`${done}/${jobs.length} done · passed in ${duration(Math.max(...ends) - Math.min(...starts))}`);
    else {
      if (running) summary.push(el('b', '', `${running} running`));
      if (done) summary.push(`${done} done`);
      if (waitingGate.length) summary.push(`waiting approval ${duration(now - Math.min(...waitingGate.map(event => event.observedAt)))}`);
      if (blocked) summary.push(`${blocked} blocked`);
      const queued = jobs.length - running - done - blocked; if (queued > 0) summary.push(`${queued} queued`);
    }
    railSummary.replaceChildren(...summary.flatMap((part, index) => index && current ? [' · ', part] : [part]));
    const rows: HTMLElement[] = [], glyphs: HTMLElement[] = [], coverage = new Map<string, ValidationView[]>();
    for (const view of views.filter(entry => !entry.stale && entry.scope.runId === run?.id && entry.scope.attempt === attempt && !entry.resolvedBy && entry.state !== 'no-report'))
      for (const name of coveredJobs(view, jobs, environments)) coverage.set(name, [...coverage.get(name) ?? [], view]);
    const stages = inferStages(jobs, environments);
    for (const gate of events.filter(event => event.runId === run?.id && event.attempt === attempt && event.kind === 'gate-waiting')) {
      const name = stageOf(gate.environment, environments); if (!stages.some(stage => stage.name === name)) stages.push({ name, jobs: [] });
    }
    const pendingGate = (name: string) => current && value.gates.some(entry => stageOf(entry.environment.name, environments) === name);
    for (const stage of activeFirst(stages, pendingGate)) {
      if (stages.length > 1 || stage.name) {
        const header = el('li', 'rv-stage', el('span', '', stage.name || 'jobs'), el('span', 'rv-stage-count', `${stage.jobs.filter(job => job.status === 'completed').length}/${stage.jobs.length}`));
        header.setAttribute('role', 'presentation'); rows.push(header);
      }
      for (const gate of events.filter(event => event.runId === run?.id && event.attempt === attempt && event.kind === 'gate-waiting' && stageOf(event.environment, environments) === stage.name)) {
        const approved = events.find(event => event.runId === gate.runId && event.attempt === gate.attempt && event.kind === 'gate-approved' && event.environment === gate.environment);
        const open = current ? value.gates.find(entry => entry.environment.name === gate.environment) : undefined, pending = !!open, mine = !!open?.reviewers.length;
        const row = el('li', 'rv-gate'); row.setAttribute('role', 'presentation'); row.dataset.state = approved ? 'done' : mine ? 'gate' : pending ? 'held' : 'queued';
        const line = el('div', 'rv-row', el('span', 'rv-glyph', pixel(approved ? 'check' : 'gate')), el('span', 'rv-name', `${gate.environment} · ${approved ? `approved ${clock(approved.observedAt)}` : 'approval gate'}`),
          el('span', 'rv-time', approved ? duration(approved.observedAt - gate.observedAt) : pending ? duration(now - gate.observedAt) : ''));
        row.append(line);
        if (pending) {
          const note = el('div', 'rv-gate-note', el('span', '', mine ? 'Waiting for your approval' : 'Waiting on protection rules'));
          if (approvable) { const approve = button('Approve ▾', 'rv-approve'); approve.dataset.irreversible = ''; approve.setAttribute('aria-haspopup', 'menu'); approve.setAttribute('aria-expanded', 'false'); approve.onclick = () => menu(approve, 'approve'); note.append(approve); }
          row.append(note);
        }
        rows.push(row);
      }
      if (glyphs.length && stage.jobs.length) glyphs.push(el('hr'));
      for (const job of stage.jobs) {
        const state = jobState(job), started = time(job.started_at), completed = time(job.completed_at);
        const elapsed = state === 'running' && started !== undefined ? duration(now - started) : started !== undefined && completed !== undefined ? duration(completed - started) : '';
        const stamps = el('span', 'rv-stamps', ...(coverage.get(job.name) ?? []).slice(-2).map(stampFor));
        const pick = button(el('span', 'rv-row', el('span', 'rv-glyph', pixel(JOB_GLYPH[state])), el('span', 'rv-name', job.name), stamps, el('span', 'rv-time', elapsed)), 'rv-job-button', `${job.name}: ${state}${elapsed ? `, ${elapsed}` : ''}`);
        pick.title = job.name; pick.dataset.focusKey = `job:${job.name}`; pick.setAttribute('aria-pressed', String(jobFilter === job.name));
        pick.onclick = () => { jobFilter = jobFilter === job.name ? undefined : job.name; render(true); };
        const glyph = button(pixel(JOB_GLYPH[state]), 'rv-strip-job', `${job.name}: ${state}`); glyph.dataset.state = state; glyph.dataset.name = job.name; glyph.dataset.focusKey = `strip:${job.name}`;
        glyph.setAttribute('aria-pressed', String(jobFilter === job.name)); glyph.onclick = pick.onclick; glyphs.push(glyph);
        const row = el('li', 'rv-job', pick); row.dataset.state = state; if (jobFilter === job.name) row.classList.add('selected');
        if (state === 'waiting' && approvable) { const approve = button('Approve…', 'rv-approve rv-job-approve'); approve.title = `Approve the deployment ${job.name} is waiting for`; approve.dataset.irreversible = ''; approve.setAttribute('aria-haspopup', 'menu'); approve.setAttribute('aria-expanded', 'false'); approve.onclick = () => menu(approve, 'approve'); row.append(approve); }
        rows.push(row);
      }
    }
    if (!jobs.length) { const empty = el('li', 'rv-empty', run ? 'Waiting for jobs to be scheduled.' : 'No runs yet. This item will follow the next run.'); empty.setAttribute('role', 'presentation'); rows.push(empty); }
    const scroll = jobsList.parentElement!.scrollTop; jobsList.replaceChildren(...rows); jobsList.parentElement!.scrollTop = scroll;
    const stripScroll = strip.scrollTop; strip.replaceChildren(...glyphs); strip.scrollTop = stripScroll;
    railFoot.textContent = jobFilter ? 'Esc clears the job filter' : !current ? `#${attempt} was replaced by #${run?.run_attempt}`
      : run?.status === 'completed' && ends.length ? `Finished ${clock(Math.max(...ends))} · no further polling` : starts.length ? `Started ${clock(Math.min(...starts))} · ${duration(now - Math.min(...starts))} so far` : '';
  }

  const matches = (entry: TimelineEntry) => {
    if (jobFilter) return entry.kind === 'job' ? entry.job.name === jobFilter : entry.kind === 'validation' ? entry.covered.includes(jobFilter) : false;
    if (filter === 'validations') return entry.kind === 'validation';
    if (filter === 'jobs') return entry.kind === 'job' || entry.kind === 'gate' || entry.kind === 'run' || entry.kind === 'attempt' || entry.kind === 'queued';
    if (filter === 'problems') return entry.kind === 'job' ? entry.what === 'finished' && failedJob(entry.job) : entry.kind === 'validation' ? entry.validation.verdict === 'failed' || entry.validation.verdict === 'concerns' || entry.validation.state === 'no-report' : entry.kind === 'run' && entry.conclusion !== 'success';
    return true;
  };
  function renderFeed(value: Observation, groups: TimelineGroup[], environments: string[], currentGroup: TimelineGroup | undefined, now: number, validations: number) {
    const all = groups.flatMap(group => group.entries), count = (kind: Filter) => { const saved = filter; filter = kind; const result = all.filter(matches).length; filter = saved; return result; };
    if (jobFilter) {
      const clear = button(pixelGlyphElement(document, 'close'), 'rv-chip-clear', 'Clear job filter'); clear.onclick = () => { jobFilter = undefined; render(true); };
      const visible = all.filter(matches).length, attemptsCovered = groups.filter(group => group.entries.some(matches)).length;
      filters.replaceChildren(el('span', 'rv-chip rv-job-chip', pixel('job'), jobFilter, clear), el('span', 'rv-faint', `${visible} of ${all.length} events${attemptsCovered > 1 ? ` · ${attemptsCovered === 2 ? 'both' : attemptsCovered} attempts` : ''}`));
    } else filters.replaceChildren(...(['all', 'validations', 'jobs', 'problems'] as Filter[]).map(kind => {
      const chip = button(el('span', '', kind[0].toUpperCase() + kind.slice(1), el('span', 'rv-count', String(count(kind)))), 'rv-chip'); chip.setAttribute('aria-pressed', String(filter === kind)); chip.dataset.focusKey = `filter:${kind}`;
      chip.onclick = () => { filter = kind; render(true); }; return chip;
    }));
    const children: HTMLElement[] = [];
    for (const group of groups) {
      const entries = group.entries.filter(matches);
      if (!group.current) {
        if (!entries.length && (jobFilter || filter !== 'all')) continue;
        children.push(el('div', 'rv-divider', el('span', '', group.label)));
        const open = shown.has(`${group.runId}:${group.attempt}`) || !!jobFilter || filter !== 'all';
        if (!open) {
          const show = button('Show', 'rv-link'); show.onclick = () => { shown.add(`${group.runId}:${group.attempt}`); render(true); };
          children.push(el('p', 'rv-more', pixel('hourglass'), `${group.summary} · `, show)); continue;
        }
      }
      for (const entry of entries) children.push(renderEntry(entry, group, value, currentGroup, environments, now));
    }
    if (!children.length) {
      const hint = jobFilter ? undefined : rolloutEmptyHint({ jobs: value.jobs.length, validations });
      children.push(el('p', 'rv-empty-feed', jobFilter ? 'Nothing recorded for this job yet.' : value.run ? 'Nothing happened on this run yet.' : 'No runs yet.', hint && el('span', 'rv-empty-hint', hint)));
    }
    const scroll = feed.scrollTop; feed.replaceChildren(...children); feed.scrollTop = scroll;
  }

  const jobRef = (name: string) => { const ref = button(name, 'rv-jobref'); ref.onclick = () => { jobFilter = name; render(true); }; return ref; };
  function event(at: number, glyph: string, tone: string, approx: boolean, dim: boolean, ...content: (Node | string)[]) {
    const stamp = el('span', 'rv-time', `${approx ? '~' : ''}${formatWhen(at, 'time')}`); stamp.title = formatWhen(at, 'full');
    const row = el('div', `rv-event${dim ? ' old' : ''}`, stamp, el('span', 'rv-glyph', pixel(glyph)), el('span', 'rv-text', ...content));
    row.setAttribute('role', 'listitem'); row.dataset.tone = tone; return row;
  }
  function renderEntry(entry: TimelineEntry, group: TimelineGroup, value: Observation, currentGroup: TimelineGroup | undefined, environments: string[], now: number): HTMLElement {
    const old = !group.current;
    if (entry.kind === 'job') {
      const state = jobState(entry.job), finished = entry.what === 'finished';
      if (!finished) return event(entry.at, 'spinner', 'blue', false, old, jobRef(entry.job.name), ' started');
      const failed = failedJob(entry.job), took = entry.duration !== undefined ? duration(entry.duration) : '';
      return event(entry.at, failed ? 'cross' : state === 'skipped' ? 'dash' : 'check', failed ? 'bad' : 'ok', false, old, jobRef(entry.job.name),
        failed ? el('span', 'rv-bad', ` ${entry.job.conclusion === 'timed_out' ? 'timed out' : 'failed'}`) : ` ${state === 'skipped' ? 'skipped' : state === 'cancelled' ? 'cancelled' : 'finished'}`,
        took ? `${failed ? ' after ' : ' · '}${took}` : '', failed && entry.job.id && group.entries.some(other => other.kind === 'run' && other.conclusion !== 'success') ? ' · run failed' : '');
    }
    if (entry.kind === 'gate') {
      if (entry.what === 'approved') return event(entry.at, 'gate', 'ok', false, old, el('b', '', entry.environment), entry.actor === 'you' ? ' approved by you in the app' : ' approved on GitHub');
      const row = event(entry.at, 'gate', entry.pending ? 'amber' : 'dim', true, old, el('b', '', entry.environment), entry.pending ? ' is waiting for your approval' : ' waited for approval');
      if (entry.pending && value.approvable) { const jump = button('Go to approval ›', 'rv-link', 'Go to approval'); jump.onclick = showApproval; row.lastElementChild!.append(' ', jump); }
      return row;
    }
    if (entry.kind === 'attempt') {
      const wrap = el('div', 'rv-attempt-entry', event(entry.at, 'retry', 'ink', false, old, el('b', '', `Attempt ${entry.attempt} started`), ` · re-run on GitHub · same commit ${value.run?.head_sha.slice(0, 7) ?? ''}`));
      if (entry.stale.length && group.current) {
        const again = button(`Validate attempt ${entry.attempt} ›`, 'rv-link'); again.onclick = () => menu(controls.validate, 'validate');
        wrap.append(el('p', 'rv-system', `${entry.stale.map(view => `${view.label} (${agentName(view)}, ${view.verdict})`).join(', ')} ${entry.stale.length === 1 ? 'was' : 'were'} about an earlier attempt. ${entry.stale.length === 1 ? "It's" : "They're"} now stale and ${entry.stale.length === 1 ? 'its' : 'their'} Needs me entry was withdrawn. `, again));
      }
      wrap.setAttribute('role', 'listitem'); wrap.firstElementChild!.removeAttribute('role'); return wrap;
    }
    if (entry.kind === 'queued') return event(entry.at, 'hourglass', 'ink', false, old, el('b', '', 'Queued behind'), ` ${entry.blockers.join(', ')}`, entry.waited !== undefined ? ` · started after waiting ${minutes(entry.waited)}` : '');
    if (entry.kind === 'run') {
      const ok = entry.conclusion === 'success';
      return event(entry.at, ok ? 'check' : 'cross', ok ? 'ok' : 'bad', false, old, el('b', '', ok ? 'Run passed' : `Run ${entry.conclusion === 'cancelled' ? 'cancelled' : 'failed'}`), ` · ${entry.done}/${entry.total} jobs${entry.duration !== undefined ? ` · ${duration(entry.duration)}` : ''}`);
    }
    return renderCard(entry.validation, entry.covered, group, environments, now, currentGroup);
  }

  function renderCard(view: ValidationView, covered: string[], group: TimelineGroup, environments: string[], now: number, currentGroup: TimelineGroup | undefined) {
    const key = badgeKey(view), body = view.report, checks = body?.checks ?? [], final = view.state === 'final';
    const needsYou = view.current && (view.verdict === 'failed' || view.verdict === 'concerns');
    if (view.label === attached && !expanded.has(view.id)) expanded.set(view.id, true);
    const open = expanded.get(view.id) ?? (!jobFilter && !view.stale && !view.resolvedBy && (view.state === 'running' || needsYou));
    const card = el('article', `rv-card${view.stale ? ' stale' : ''}${view.resolvedBy ? ' resolved' : ''}`); card.dataset.v = key; card.setAttribute('role', 'listitem');
    card.setAttribute('aria-label', `${view.label} · ${VERDICT_GLYPH[key][1]} · ${view.agent.title}`);
    const scope = view.scope.environments?.length ? view.scope.environments.join(', ') : covered.length ? covered.map(name => name.replace(/^[^/]+\/\s*/, '')).join(' · ') : 'whole run';
    const pips = el('span', 'rv-pips', ...checks.map(check => { const pip = el('i'); pip.dataset.s = check.status; return pip; })); pips.setAttribute('aria-hidden', 'true');
    const tag = view.stale ? el('span', 'rv-tag', pixel('hourglass'), view.scope.runId === (currentGroup?.runId ?? view.scope.runId) ? `Attempt ${view.scope.attempt}` : `Run ${view.scope.runId}`) : view.resolvedBy ? el('span', 'rv-tag', `Resolved by ${view.resolvedBy}`) : undefined;
    const followup = body?.followup, origin = view.unrequested ? el('span', 'rv-tag', 'Unrequested') : view.chat ? el('span', 'rv-tag', 'Started from chat') : undefined, amended = followup ? el('span', 'rv-tag', 'Follow-up') : undefined;
    card.append(el('div', 'rv-card-head', badge(key, view.stale), who(view), el('span', 'rv-scope', `· ${scope}`), tag, origin, amended, el('span', 'rv-card-right', pips, el('span', 'rv-time', clock(final ? view.finishedAt ?? view.updatedAt : view.updatedAt)))));
    const { lead, rest } = splitLead(body?.summary ?? '');
    const fallback = key === 'no-report' ? `${agentName(view)} finished without reporting` : view.state === 'requested' ? `Waiting for ${agentName(view)}'s first report` : 'Validating…';
    if (lead) card.append(el('h3', 'rv-card-title', ...inline(lead)));
    else if (!rest || !open) { const title = el('h3', `rv-card-title${rest ? ' clamp' : ''}`, rest ? plainLine(rest) : fallback); card.append(title); }
    if (open && rest) card.append(prose('rv-summary', rest));
    const meta: string[] = [];
    if (jobFilter && covered.length) meta.push(`Covers ${covered.join(', ')}`);
    if (view.stale) meta.push(`${final ? `Final ${clock(view.finishedAt ?? view.updatedAt)}` : `Requested ${clock(view.requestedAt)}`}`, `about ${view.scope.runId === currentGroup?.runId ? `attempt ${view.scope.attempt}` : `run ${view.scope.runId}`}`);
    else if (jobFilter) meta.push(final ? `final ${clock(view.finishedAt ?? view.updatedAt)}` : `updated ${clock(view.updatedAt)}`);
    else if (view.resolvedBy) meta.push(final ? `Final ${clock(view.finishedAt ?? view.updatedAt)}` : `Requested ${clock(view.requestedAt)}`, 'a newer validation of the same scope passed or replaced it');
    else {
      const stage = view.scope.stage ? ` · ${view.scope.label ?? view.scope.focus ?? view.scope.stage}` : '';
      meta.push(view.unrequested ? `${view.label} · unrequested · first report ${clock(view.requestedAt)}` : view.chat ? `${view.label} · started from chat${stage} · first report ${clock(view.requestedAt)}` : view.automatic ? `${view.label} · automatic${stage} · requested ${clock(view.requestedAt)}` : `${view.label} · requested ${clock(view.requestedAt)} by you`);
      const progress = view.reports - (final ? 1 : 0) - (followup?.count ?? 0);
      if (progress > 0) meta.push(plural(progress, 'progress report'));
      if (followup) meta.push(`${followup.count > 1 ? `${followup.count} follow-ups, last` : 'follow-up'} ${clock(followup.at)}${followup.previous && followup.previous !== view.verdict ? ` · was ${verdictLabels[followup.previous].toLowerCase()}` : ''}`);
      else if (final) { meta.push(`final ${clock(view.finishedAt ?? view.updatedAt)}`); if (view.startedAt !== undefined) meta.push(`took ${duration((view.finishedAt ?? view.updatedAt) - view.requestedAt).replace('<1m', '<1 min').replace(/m$/, ' min')}`); }
      else if (view.reports) { meta.push(`updated ${clock(view.updatedAt)}`); const live = checks.find(check => check.status === 'running'); if (live) meta.push(`checking ${live.title.toLowerCase()}…`); }
    }
    card.append(el('p', 'rv-card-meta', meta.join(' · ')));
    if (!view.stale && !view.resolvedBy && (view.state === 'running' || view.state === 'requested')) card.append(live('p', view, now));
    if (key === 'no-report' && view.resolvedBy) {
      card.append(el('div', 'rv-noreport', el('span', '', `No report · ${view.resolvedBy} answered for this attempt.`)));
      return card;
    }
    if (key === 'no-report') {
      const ask = button('Ask to report', 'rv-button'); ask.onclick = async () => {
        ask.disabled = true;
        try { await services.runAction('rollout.validation', { operation: 'ask', validationId: view.label, requestId: crypto.randomUUID() }); await readList(); render(true); report(''); }
        catch (failure) { report((failure as Error).message); ask.disabled = false; }
      };
      card.append(el('div', 'rv-noreport', el('span', '', `No report · ${agentName(view)} went idle without calling workspace_report_validation.`), ask, agentControl(view)));
      return card;
    }
    const blocking = (body?.recommendations ?? []).filter(entry => entry.blocking), notes = (body?.recommendations ?? []).filter(entry => !entry.blocking);
    if (open && blocking.length && !view.stale) card.append(el('ul', 'rv-recs', ...blocking.map(entry => el('li', 'block', el('span', 'rv-rec-key', pixel('bang'), 'Blocking'), el('span', '', ...inline(entry.text))))));
    if (open && checks.length) card.append(el('ul', 'rv-checks', ...[...checks].sort((a, b) => rank(a) - rank(b)).map(check => renderCheck(view, check))));
    if (open && notes.length) card.append(el('ul', 'rv-recs', ...notes.map(entry => el('li', '', el('span', 'rv-rec-key', 'Next'), el('span', '', ...inline(entry.text))))));
    const counts = (['failed', 'concern', 'passed', 'skipped'] as const).map(status => [status, checks.filter(check => check.status === status).length] as const).filter(([, n]) => n)
      .map(([status, n]) => `${n} ${status === 'concern' ? (n === 1 ? 'concern' : 'concerns') : status}`);
    const togo = checks.filter(check => check.status === 'running' || check.status === 'pending').length; if (togo) counts.push(`${togo} to go`);
    const foot = el('div', 'rv-card-foot', el('span', '', counts.join(' · ') || (view.state === 'requested' ? 'No checks reported yet' : '')), agentControl(view));
    if (checks.length || blocking.length || notes.length || rest) { const toggle = button(open ? 'Hide report ▴' : 'Show report ▾', 'rv-link'); toggle.setAttribute('aria-expanded', String(open)); toggle.dataset.focusKey = `toggle:${view.id}`; toggle.onclick = () => { expanded.set(view.id, !open); render(true); }; foot.append(toggle); }
    card.append(foot);
    return card;
  }
  /** On the newest validation of an agent started hidden: Show validation agent while it is hidden, Hide validation agent once shown. */
  function agentControl(view: ValidationView) {
    if (!view.agentHidden && !view.agentHideable || list?.validations.filter(entry => entry.agentNodeId === view.agentNodeId).at(-1)?.id !== view.id) return undefined;
    const operation = view.agentHidden ? 'show' : 'hide', control = button(view.agentHidden ? 'Show validation agent' : 'Hide validation agent', 'rv-link');
    control.dataset.focusKey = `agent:${view.id}`;
    control.onclick = async () => {
      control.disabled = true;
      try {
        const result = await services.runAction('rollout.validation', { operation, validationId: view.label }) as { agentNodeId?: unknown } | undefined;
        report('');
        if (operation === 'show' && typeof result?.agentNodeId === 'string') { if (services.showOnMap) services.showOnMap(result.agentNodeId); else services.openResource(result.agentNodeId); }
        else { await readList(); render(true); }
      } catch (failure) { report((failure as Error).message); control.disabled = false; }
    };
    return control;
  }
  const rank = (check: ValidationCheck) => check.status === 'failed' ? 0 : check.status === 'concern' ? 1 : 2;
  /** A metric as before → after with its change; worse than before in amber. */
  const metricValue = (metric: ValidationMetric, check: ValidationCheck) => {
    const change = metric.before ? (metric.after - metric.before) / Math.abs(metric.before) : 0, worse = metric.better ? (metric.better === 'lower' ? change > .05 : change < -.05) : check.status === 'concern' || check.status === 'failed';
    const delta = Math.abs(change) >= 1 ? `${(metric.after / metric.before).toFixed(1)}×` : `${change >= 0 ? '+' : ''}${Math.round(change * 100)}%`;
    const unit = metric.unit ? `${metric.unit === '%' ? '' : ' '}${metric.unit}` : '';
    return el('span', 'rv-metric', el('span', 'rv-before', `${metric.before}${unit}`), ' → ', el('b', '', `${metric.after}${unit}`), metric.before ? el('span', `rv-delta${worse ? ' warn' : ''}`, delta) : '');
  };
  /** A disclosure: one truncated line with compact metrics, or the check as a block: its observation, labelled
   * metrics and evidence; a skipped check says why. Concerns and failures start open. */
  function renderCheck(view: ValidationView, check: ValidationCheck) {
    const key = `check:${view.id}:${check.id}`, open = expanded.get(key) ?? (check.status === 'concern' || check.status === 'failed');
    const [glyph, label] = CHECK_GLYPH[check.status], row = el('li', `rv-check${open ? ' open' : ''}`); row.dataset.s = check.status;
    const icon = el('span', 'rv-check-glyph', pixel(glyph)); icon.title = label; icon.dataset.s = check.status;
    const where = [check.target, check.method].filter(Boolean).join(' · ');
    const main = el('span', 'rv-check-main', el('span', 'rv-check-title', check.title), where && el('span', 'rv-target', where), !open && check.observation && el('span', 'rv-observation', plainLine(check.observation)));
    const toggle = button(el('span', 'rv-check-line', icon, main), 'rv-check-toggle'); toggle.setAttribute('aria-expanded', String(open)); toggle.dataset.focusKey = key;
    toggle.onclick = () => { expanded.set(key, !open); render(true); };
    const evidence = check.evidence?.length ? el('span', 'rv-evidence', ...check.evidence.map(item => { const link = el('a', 'rv-ev', pixel(EVIDENCE_GLYPH[item.kind ?? 'other'] ?? 'chart'), item.label, el('span', 'rv-out', '↗')); link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link; })) : undefined;
    row.append(toggle);
    if (!open) {
      if (evidence) row.append(evidence);
      row.append(el('div', 'rv-metrics', ...(check.metrics ?? []).map(metric => { const line = metricValue(metric, check); line.title = `${metric.label}${metric.window ? ` · ${metric.window}` : ''}`; return line; })));
      return row;
    }
    const observation = check.observation ? prose('rv-observation', check.observation) : undefined;
    const why = check.status === 'skipped' && observation ? el('div', 'rv-check-why', el('span', 'rv-rec-key', 'Skipped'), observation) : observation;
    const metrics = check.metrics?.length ? el('div', 'rv-metric-table', ...check.metrics.map(metric => el('div', 'rv-metric-row', el('span', 'rv-metric-label', metric.label, metric.window && el('span', 'rv-metric-window', metric.window)), metricValue(metric, check)))) : undefined;
    if (why || metrics || evidence) {
      const detail = el('div', 'rv-check-detail', why, metrics, evidence);
      detail.id = `rv-check-${resource.id}-${view.id}-${check.id}`.replace(/\s+/g, '-'); toggle.setAttribute('aria-controls', detail.id); row.append(detail);
    }
    return row;
  }

  let following = false, behind = false;
  /** Re-reads validations and events; a change that arrives during a read is read once more. */
  const follow = () => {
    if (!active || disposed) return;
    if (following) { behind = true; return; }
    following = true;
    void readList().then(() => render()).finally(() => { following = false; if (behind) { behind = false; follow(); } });
  };
  return {
    update() { follow(); approvalWait?.reread(); },
    setActive(value) {
      if (active === value) return; active = value; generation++; clearTimeout(timer); clearInterval(listTimer); approvalWait?.stop();
      // The workspace pushes changes through update; the timer only covers a missed one.
      if (value) { void refreshAll(); listTimer = setInterval(follow, 3000); }
    },
    dispose() { disposed = true; generation++; clearTimeout(timer); clearInterval(listTimer); approvalWait?.stop(); closeMenu?.(); sizes.disconnect(); document.removeEventListener('keydown', railKey); header.dispose(); root.remove(); },
  };
}
