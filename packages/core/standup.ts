import * as z from 'zod/v4';
import { localDate } from './reminders.ts';

/** Standup report (STANDUP-01): what I did over a range, told as stories with their evidence. */
/** Off hides the rail's Actions slot and the Standup report settings and stops background digests; the code and tests stay. */
export const STANDUP_ENABLED = false;
export const STANDUP_RANGES = ['day', 'week', 'last-week'] as const;
export type StandupRange = typeof STANDUP_RANGES[number];
export const STANDUP_RANGE_LABELS: Record<StandupRange, string> = { day: '1 day', week: '7 days', 'last-week': 'Last week' };
export const STANDUP_INSTRUCTION_LIMIT = 500;
export const standupRequestSchema = z.object({
  range: z.enum(STANDUP_RANGES).default('day'),
  instruction: z.string().trim().max(STANDUP_INSTRUCTION_LIMIT).default(''),
}).strict();
export type StandupRequest = z.infer<typeof standupRequestSchema>;

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const midnight = (date: Date, offset = 0) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset).getTime();
const dayWords = (ms: number, month: boolean) => { const date = new Date(ms); return `${WEEKDAY[date.getDay()]} ${date.getDate()}${month ? ` ${MONTH[date.getMonth()]}` : ''}`; };
export interface StandupWindow { range: StandupRange; from: number; to: number; days: string[]; label: string; thisWeek: { from: number; to: number } }
/** Whole local days: 1 day is yesterday and today so far, 7 days the seven days before today and today so far,
 * Last week Monday to Sunday of the previous calendar week. Midnights come from the calendar, so DST changes keep whole days. */
export function standupWindow(range: StandupRange, now: number): StandupWindow {
  const today = new Date(now), monday = midnight(today, -((today.getDay() + 6) % 7));
  const from = range === 'day' ? midnight(today, -1) : range === 'week' ? midnight(today, -7) : midnight(new Date(monday), -7);
  const to = range === 'last-week' ? monday : now, days: string[] = [];
  for (let offset = 0; midnight(new Date(from), offset) < to; offset++) days.push(localDate(midnight(new Date(from), offset)));
  const last = range === 'last-week' ? midnight(new Date(monday), -1) : now;
  const sameMonth = new Date(from).getMonth() === new Date(last).getMonth();
  return { range, from, to, days, label: `${dayWords(from, !sameMonth)} – ${dayWords(last, true)}`, thisWeek: { from: monday, to: midnight(new Date(monday), 7) } };
}

export const STANDUP_STATES = ['done', 'ongoing', 'blocked'] as const;
const storySchema = z.object({
  title: z.string().trim().min(1).max(160),
  state: z.enum(STANDUP_STATES),
  bullets: z.array(z.string().trim().min(1).max(400)).min(1).max(4),
  evidence: z.array(z.string().min(1).max(300)).max(12),
  project: z.string().trim().min(1).max(120).optional(),
});
/** What the composing model must return. */
export const composedReportSchema = z.object({ stories: z.array(storySchema).max(40), outlook: z.array(storySchema).max(30).default([]) });
export type ComposedStory = z.infer<typeof storySchema>;

export const EVIDENCE_KINDS = ['agent', 'pr', 'rollout', 'review', 'ticket', 'todo', 'reminder', 'attention'] as const;
export interface StandupEvidence { id: string; kind: typeof EVIDENCE_KINDS[number]; label: string; url?: string; nodeId?: string }
/** A story as shown; facts shown without a model have no bullets. */
export interface StandupStory { id: string; title: string; state: typeof STANDUP_STATES[number]; bullets: string[]; evidence: string[]; project?: string }
export interface StandupReport {
  range: StandupRange; label: string;
  /** `facts`: the stored facts as a plain list, because `reason`. */
  mode: 'stories' | 'facts'; reason?: string;
  stories: StandupStory[]; outlook: StandupStory[]; evidence: Record<string, StandupEvidence>;
  /** What was read, e.g. "3 conversations, 2 pull requests, 4 facts". */
  read: string; notes: string[]; generatedAt: number; model?: string;
}
export interface StandupStatus { state: 'idle' | 'running' | 'done' | 'error'; request?: StandupRequest; step?: string; report?: StandupReport; error?: string }

/** The model's reply as JSON: the first object in it, also inside a code fence. */
export function modelJson(text: string): unknown {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Claude did not return a report.');
  try { return JSON.parse(text.slice(start, end + 1)); } catch { throw new Error('Claude did not return a report.'); }
}

/** Validates a composed report. A story is shown only when every evidence id it cites was in the input;
 * ongoing work belongs to the outlook, after the outlook's own entries. */
export function acceptReport(raw: unknown, known: ReadonlySet<string>) {
  const parsed = composedReportSchema.parse(raw);
  const grounded = (story: ComposedStory) => story.evidence.length > 0 && story.evidence.every(id => known.has(id));
  const all = [...parsed.stories, ...parsed.outlook], kept = all.filter(grounded);
  const stories = parsed.stories.filter(story => grounded(story) && story.state !== 'ongoing');
  const outlook = [...parsed.stories.filter(story => grounded(story) && story.state === 'ongoing'), ...parsed.outlook.filter(grounded)];
  const shown = (list: ComposedStory[], prefix: string): StandupStory[] => list.map((story, index) => ({ id: `${prefix}${index}`, title: story.title, state: story.state, bullets: story.bullets, evidence: [...new Set(story.evidence)], ...(story.project ? { project: story.project } : {}) }));
  return { stories: shown(stories, 's'), outlook: shown(outlook, 'o'), dropped: all.length - kept.length };
}

export type StandupShape = 'standup' | 'project';
export type StandupDetail = 'brief' | 'normal';
export interface StandupCopyOptions { shape: StandupShape; detail: StandupDetail; excluded: ReadonlySet<string> }
/** Done, Blocked, This week; or one group per project with This week last. Empty groups are left out. */
export function reportGroups(report: Pick<StandupReport, 'stories' | 'outlook'>, shape: StandupShape) {
  const groups: { heading: string; stories: StandupStory[] }[] = shape === 'standup'
    ? [{ heading: 'Done', stories: report.stories.filter(story => story.state === 'done') }, { heading: 'Blocked', stories: report.stories.filter(story => story.state !== 'done') }]
    : [...new Set(report.stories.map(story => story.project ?? 'Other'))].map(heading => ({ heading, stories: report.stories.filter(story => (story.project ?? 'Other') === heading) }));
  return [...groups, { heading: 'This week', stories: report.outlook }].filter(group => group.stories.length);
}

const slackEscape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const markdownEscape = (text: string) => text.replace(/([\\[\]*_`])/g, '\\$1');
function copyText(report: StandupReport, options: StandupCopyOptions, style: 'slack' | 'markdown') {
  const slack = style === 'slack', text = slack ? slackEscape : (value: string) => value;
  const lines = [slack ? `*Standup · ${text(report.label)}*` : `## Standup · ${report.label}`];
  for (const group of reportGroups(report, options.shape)) {
    const shown = group.stories.filter(story => !options.excluded.has(story.id));
    if (!shown.length) continue;
    lines.push('', slack ? `*${text(group.heading)}*` : `### ${group.heading}`);
    for (const story of shown) {
      lines.push('', slack ? `*${text(story.title)}*` : `**${markdownEscape(story.title)}**`);
      for (const bullet of options.detail === 'brief' ? story.bullets.slice(0, 1) : story.bullets) lines.push(`${slack ? '•' : '-'} ${text(bullet)}`);
      const chips = story.evidence.flatMap(id => report.evidence[id] ? [report.evidence[id]] : []).map(chip => chip.url
        ? slack ? `<${chip.url}|${text(chip.label).replace(/\|/g, '/')}>` : `[${markdownEscape(chip.label)}](${chip.url})`
        : slack ? text(chip.label) : markdownEscape(chip.label));
      if (chips.length) lines.push(...(slack ? [] : ['']), `${slack ? '' : 'Evidence: '}${chips.join(' · ')}`);
    }
  }
  return lines.join('\n');
}
/** Slack mrkdwn: bold headings, one • bullet per line, a blank line between stories, <url|label> links. */
export const slackText = (report: StandupReport, options: StandupCopyOptions) => copyText(report, options, 'slack');
/** Markdown with ## / ### headings, - bullets and [label](url) links. */
export const markdownText = (report: StandupReport, options: StandupCopyOptions) => copyText(report, options, 'markdown');
