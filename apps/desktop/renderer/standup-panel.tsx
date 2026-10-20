import { useEffect, useMemo, useRef, useState } from 'react';
import { STANDUP_INSTRUCTION_LIMIT, STANDUP_RANGES, STANDUP_RANGE_LABELS, markdownText, reportGroups, slackText } from '../../../packages/core/standup.ts';
import type { StandupDetail, StandupEvidence, StandupRange, StandupReport, StandupShape, StandupStatus, StandupStory } from '../../../packages/core/standup.ts';
import { FloatingPanel } from './ui/floating-panel.tsx';
import { Segmented } from './ui/segmented.tsx';
import { Button } from './ui/button.tsx';
import { ErrorNotice, Notice } from './ui/notice.tsx';
import { ItemIcon } from './icons.tsx';

const POLL_MS = 400;
const STATE_WORDS: Record<StandupStory['state'], string> = { done: 'Done', ongoing: 'Ongoing', blocked: 'Blocked' };
/** A run still going, or a report finished today, is picked up instead of asked for again. */
const resumable = (status: StandupStatus) => status.state === 'running'
  || status.state === 'done' && status.report !== undefined && new Date(status.report.generatedAt).toDateString() === new Date().toDateString();
const KIND_ICONS: Record<StandupEvidence['kind'], string> = { agent: 'terminal', pr: 'git-pull-request', rollout: 'rocket', review: 'review', ticket: 'square-check', todo: 'square-check', reminder: 'bell', attention: 'bang' };

/** The standup report (STANDUP-01) in a floating panel: range, shape and detail, stories with their evidence,
 * a rewrite instruction and copy for Slack or as Markdown. Only ticked stories are copied. */
export function StandupPanel({ close, reveal, openUrl, onMap }: { close(): void; reveal(nodeId: string): void; openUrl(url: string): void; onMap(nodeId: string): boolean }) {
  const [range, setRange] = useState<StandupRange>('last-week'), [shape, setShape] = useState<StandupShape>('standup'), [detail, setDetail] = useState<StandupDetail>('normal');
  const [instruction, setInstruction] = useState(''), [draft, setDraft] = useState(''), [status, setStatus] = useState<StandupStatus>({ state: 'running', step: 'Gathering what happened…' });
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set()), [copied, setCopied] = useState(''), [failure, setFailure] = useState('');
  const request = useRef(0), resumed = useRef<StandupStatus>(undefined), [ready, setReady] = useState(false);
  // The service keeps a report going after the panel closes, so reopening picks up that run or today's finished one.
  useEffect(() => {
    let live = true;
    void window.craftingTable.standupStatus().then(current => {
      if (!live) return;
      if (current.request && resumable(current)) {
        resumed.current = current; setRange(current.request.range); setInstruction(current.request.instruction ?? ''); setDraft(current.request.instruction ?? '');
      }
      setReady(true);
    }, () => { if (live) setReady(true); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!ready) return;
    const ticket = ++request.current; let timer: ReturnType<typeof setTimeout> | undefined;
    setStatus(old => ({ state: 'running', step: old.step ?? 'Gathering what happened…' })); setCopied(''); setFailure('');
    const poll = (next: StandupStatus) => {
      if (ticket !== request.current) return;
      setStatus(next);
      if (next.state === 'running') timer = setTimeout(() => { void window.craftingTable.standupStatus().then(poll, error => { if (ticket === request.current) setStatus({ state: 'error', error: error.message }); }); }, POLL_MS);
    };
    const prior = resumed.current; resumed.current = undefined;
    const same = prior?.request?.range === range && (prior.request.instruction ?? '') === instruction;
    (same ? Promise.resolve(prior) : window.craftingTable.standupOpen({ range, instruction })).then(poll, error => { if (ticket === request.current) setStatus({ state: 'error', error: error.message }); });
    return () => clearTimeout(timer);
  }, [ready, range, instruction]);
  const report = status.state === 'done' ? status.report : undefined;
  useEffect(() => setExcluded(new Set()), [report]);
  const groups = useMemo(() => report ? reportGroups(report, shape) : [], [report, shape]);
  const all = report ? [...report.stories, ...report.outlook] : [], included = all.filter(story => !excluded.has(story.id)).length;
  const copy = (style: 'slack' | 'markdown') => {
    if (!report) return;
    const text = (style === 'slack' ? slackText : markdownText)(report, { shape, detail, excluded });
    void navigator.clipboard.writeText(text).then(() => { setFailure(''); setCopied(style === 'slack' ? 'Copied for Slack' : 'Copied as Markdown'); }, error => setFailure(`Could not copy: ${error.message}`));
  };
  const toggle = (id: string, on: boolean) => setExcluded(old => { const next = new Set(old); if (on) next.delete(id); else next.add(id); return next; });
  const chip = (evidence: StandupEvidence) => {
    const target = evidence.nodeId && onMap(evidence.nodeId) ? () => reveal(evidence.nodeId!) : evidence.url ? () => openUrl(evidence.url!) : undefined;
    const body = <><ItemIcon icon={KIND_ICONS[evidence.kind]} /><span>{evidence.label}</span></>;
    return target ? <button key={evidence.id} type="button" className="standup-chip" data-kind={evidence.kind} title={evidence.nodeId && onMap(evidence.nodeId) ? 'Show on the map' : evidence.url} onClick={target}>{body}</button>
      : <span key={evidence.id} className="standup-chip" data-kind={evidence.kind}>{body}</span>;
  };
  const storyView = (story: StandupStory) => {
    const off = excluded.has(story.id), bullets = detail === 'brief' ? story.bullets.slice(0, 1) : story.bullets;
    return <article key={story.id} className="standup-story" data-off={off || undefined} aria-label={story.title}>
      <div className="standup-story-head">
        <input type="checkbox" checked={!off} aria-label={`Include “${story.title}”`} onChange={event => toggle(story.id, event.target.checked)} />
        <h4>{story.title}</h4>
        {shape === 'project' ? <span className="standup-state" data-state={story.state}>{STATE_WORDS[story.state]}</span> : story.project && <span className="standup-project">{story.project}</span>}
      </div>
      {bullets.length > 0 && <ul className="standup-bullets">{bullets.map((bullet, index) => <li key={index}>{bullet}</li>)}</ul>}
      <div className="standup-evidence">{story.evidence.flatMap(id => report!.evidence[id] ? [chip(report!.evidence[id])] : [])}</div>
    </article>;
  };
  const running = status.state === 'running', rewritable = !running && report?.mode !== 'facts';
  return <FloatingPanel className="standup-panel" label="Standup report" title="Standup report" closeLabel="Close standup report" close={close} role="dialog"
    at={{ x: Math.max(80, innerWidth / 2 - 330), y: 40 }} extras={report && <small className="standup-range-label">{report.label}</small>} data={{ 'data-state': status.state }}>
    <div className="standup-controls">
      <Segmented<StandupRange> label="Range" value={range} change={setRange} options={STANDUP_RANGES.map(value => ({ value, label: STANDUP_RANGE_LABELS[value] }))} />
      <Segmented<StandupShape> label="Shape" value={shape} change={setShape} options={[{ value: 'standup', label: 'Done · Blocked · This week' }, { value: 'project', label: 'By project' }]} />
      <Segmented<StandupDetail> label="Detail" value={detail} change={setDetail} options={[{ value: 'brief', label: 'Brief' }, { value: 'normal', label: 'Normal' }]} />
    </div>
    <div className="standup-body" aria-busy={running || undefined}>
      {running && <p className="standup-progress" role="status"><ItemIcon icon="clock" size={8} />{status.step ?? 'Working…'}</p>}
      {running && <p className="standup-note">You can close this panel: the report keeps going and is here when you come back.</p>}
      {status.state === 'error' && <ErrorNotice message={`The report could not be made: ${status.error}`} />}
      {report && <>
        {report.mode === 'facts' && report.reason && <Notice tone="info">{report.reason}</Notice>}
        {instruction && report.mode === 'stories' && <p className="standup-note">Rewritten: “{instruction}”</p>}
        {groups.map(group => <section key={group.heading} className="standup-group" aria-label={group.heading}>
          <h3>{group.heading}<span>{group.stories.length}</span></h3>
          {group.stories.map(storyView)}
        </section>)}
        {!groups.length && <p className="standup-empty">Nothing to report for {report.label}.</p>}
        {report.notes.map(note => <p key={note} className="standup-note">{note}</p>)}
        <p className="standup-read">{report.read}{report.model ? ` · written by ${report.model === 'sonnet' ? 'Claude Sonnet' : report.model}` : ''}</p>
      </>}
    </div>
    <form className="standup-rewrite" onSubmit={event => { event.preventDefault(); setInstruction(draft.trim()); }}>
      <input type="text" value={draft} maxLength={STANDUP_INSTRUCTION_LIMIT} aria-label="Tell Claude what to change" placeholder="Tell Claude what to change, e.g. leave out the docs work" disabled={!rewritable} onChange={event => setDraft(event.target.value)} />
      <Button type="submit" size="sm" disabled={!rewritable || draft.trim() === instruction}>Rewrite</Button>
    </form>
    <div className="standup-footer">
      <span role="status">{failure || copied || (report ? `${included} of ${all.length} ${all.length === 1 ? 'story' : 'stories'}` : '')}</span>
      <Button size="sm" disabled={!report || !included} onClick={() => copy('markdown')}>Copy Markdown</Button>
      <Button size="sm" variant="primary" disabled={!report || !included} onClick={() => copy('slack')}>Copy for Slack</Button>
    </div>
  </FloatingPanel>;
}
