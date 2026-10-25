import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptReport, markdownText, modelJson, reportGroups, slackText, standupWindow } from './standup.ts';
import type { StandupReport, StandupStory } from './standup.ts';

const inZone = <T>(zone: string, run: () => T) => {
  const previous = process.env.TZ; process.env.TZ = zone;
  try { return run(); } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
};

test('1 day is yesterday and today so far, in local days', () => inZone('America/New_York', () => {
  const now = new Date(2026, 9, 14, 9, 30).getTime(), window = standupWindow('day', now);
  assert.deepEqual(window.days, ['2026-10-13', '2026-10-14']);
  assert.equal(window.from, new Date(2026, 9, 13).getTime()); assert.equal(window.to, now);
  assert.equal(window.label, 'Tue 13 – Wed 14 Oct');
}));

test('7 days is the seven days before today and today so far', () => inZone('America/New_York', () => {
  const now = new Date(2026, 9, 14, 9, 30).getTime(), window = standupWindow('week', now);
  assert.deepEqual(window.days, ['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']);
  assert.equal(window.label, 'Wed 7 – Wed 14 Oct');
}));

test('last week is Monday to Sunday of the previous calendar week, also when today is a Monday or a Sunday', () => inZone('America/New_York', () => {
  const monday = standupWindow('last-week', new Date(2026, 9, 12, 8).getTime());
  assert.deepEqual(monday.days, ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
  assert.equal(monday.from, new Date(2026, 9, 5).getTime()); assert.equal(monday.to, new Date(2026, 9, 12).getTime());
  assert.equal(monday.label, 'Mon 5 – Sun 11 Oct');
  const sunday = standupWindow('last-week', new Date(2026, 9, 18, 23, 59).getTime());
  assert.deepEqual(sunday.days, monday.days);
  assert.deepEqual(standupWindow('last-week', new Date(2026, 10, 2, 10).getTime()).label, 'Mon 26 Oct – Sun 1 Nov');
}));

test('ranges across a DST change keep whole local days; the week is an hour longer', () => inZone('America/New_York', () => {
  // Daylight saving time ends on Sunday 1 November 2026 at 02:00 local.
  const day = standupWindow('day', new Date(2026, 10, 2, 9).getTime());
  assert.deepEqual(day.days, ['2026-11-01', '2026-11-02']); assert.equal(new Date(day.from).getHours(), 0);
  const last = standupWindow('last-week', new Date(2026, 10, 2, 9).getTime());
  assert.deepEqual(last.days, ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  assert.equal(last.to - last.from, (7 * 24 + 1) * 3_600_000);
  const spring = standupWindow('day', new Date(2026, 2, 9, 9).getTime());
  assert.deepEqual(spring.days, ['2026-03-08', '2026-03-09']);
  assert.equal(new Date(2026, 2, 9).getTime() - spring.from, 23 * 3_600_000);
}));

test('this week runs from this Monday to next Monday', () => inZone('UTC', () => {
  const window = standupWindow('day', Date.UTC(2026, 9, 14, 12));
  assert.equal(window.thisWeek.from, Date.UTC(2026, 9, 12)); assert.equal(window.thisWeek.to, Date.UTC(2026, 9, 19));
}));

const story = (title: string, evidence: string[], state: StandupStory['state'] = 'done', project?: string) => ({ title, state, bullets: [`Worked on ${title}.`], evidence, ...(project ? { project } : {}) });

test('a story citing evidence that was not in the input is dropped; one without evidence never shows', () => {
  const known = new Set(['agent:a:2026-10-13', 'pr:acme/billing/pull/7']);
  const accepted = acceptReport({ stories: [story('Real', ['agent:a:2026-10-13']), story('Invented', ['pr:acme/billing/pull/8']), story('Mixed', ['agent:a:2026-10-13', 'made-up']), { ...story('Bare', []), evidence: [] }] }, known);
  assert.deepEqual(accepted.stories.map(entry => entry.title), ['Real']);
  assert.equal(accepted.dropped, 3);
  assert.deepEqual(accepted.outlook, []);
});

test('ongoing work moves to this week and the outlook stays empty when nothing is open', () => {
  const known = new Set(['e1', 'e2', 'e3']);
  const accepted = acceptReport({ stories: [story('Shipped', ['e1']), story('Still going', ['e2'], 'ongoing')], outlook: [story('Review waiting', ['e3'], 'ongoing')] }, known);
  assert.deepEqual(accepted.stories.map(entry => entry.title), ['Shipped']);
  assert.deepEqual(accepted.outlook.map(entry => entry.title), ['Still going', 'Review waiting']);
  assert.deepEqual(accepted.stories.map(entry => entry.id), ['s0']); assert.deepEqual(accepted.outlook.map(entry => entry.id), ['o0', 'o1']);
});

test('a story longer than the report shows is shortened, never the whole report thrown away', () => {
  const known = new Set(Array.from({ length: 20 }, (_, index) => `e${index}`));
  const accepted = acceptReport({ stories: [{ ...story('Too many', ['e1']), title: 'T'.repeat(200), bullets: ['1', '2', '3', '4', '5'] }],
    outlook: [story('Wide', [...known], 'ongoing'), ...Array.from({ length: 35 }, (_, index) => story(`Open ${index}`, ['e1'], 'ongoing'))] }, known);
  assert.deepEqual(accepted.stories[0]!.bullets, ['1', '2', '3', '4']); assert.equal(accepted.stories[0]!.title.length, 160);
  assert.equal(accepted.outlook[0]!.evidence.length, 12); assert.equal(accepted.outlook.length, 30);
});

test('model JSON is read from a fenced reply', () => {
  assert.deepEqual(modelJson('Here it is:\n```json\n{"stories":[],"outlook":[]}\n```'), { stories: [], outlook: [] });
  assert.throws(() => modelJson('no json'), /did not return/);
});

const report: StandupReport = {
  range: 'day', label: 'Sun 11 – Mon 12 Oct', mode: 'stories', notes: [], read: '', generatedAt: 0,
  stories: [
    { id: 's0', title: 'Cart totals were off by a cent', state: 'done', project: 'Billing', bullets: ['Found that the cart rounded each line before adding them up.', 'Rounded once & shipped the fix.'], evidence: ['pr:1', 'agent:1'] },
    { id: 's1', title: 'Docs search in the site build', state: 'blocked', project: 'Website', bullets: ['Moved the search index into the docs build.', 'The deploy also changed page permissions; needs a decision.'], evidence: ['rollout:1'] },
    { id: 's2', title: 'Biome grounds', state: 'done', project: 'Crafting table', bullets: ['Shipped biome grounds for neighborhoods.'], evidence: ['agent:2'] },
  ],
  outlook: [{ id: 'o0', title: 'Retry button for billing exports', state: 'ongoing', project: 'Billing', bullets: ['Waiting on review of <#131>.'], evidence: ['pr:2'] }],
  evidence: {
    'pr:1': { id: 'pr:1', kind: 'pr', label: '#114 merged', url: 'https://github.com/acme/billing/pull/114' },
    'pr:2': { id: 'pr:2', kind: 'pr', label: '#131 open', url: 'https://github.com/acme/billing/pull/131' },
    'agent:1': { id: 'agent:1', kind: 'agent', label: 'Claude · cart totals', nodeId: 'n1' },
    'agent:2': { id: 'agent:2', kind: 'agent', label: 'Claude · biomes' },
    'rollout:1': { id: 'rollout:1', kind: 'rollout', label: 'Docs release · V2 concerns', url: 'https://github.com/acme/website/actions/runs/9' },
  },
};

test('groups follow the shape: Done, Blocked, This week, or by project with This week last', () => {
  assert.deepEqual(reportGroups(report, 'standup').map(group => [group.heading, group.stories.map(entry => entry.id)]), [['Done', ['s0', 's2']], ['Blocked', ['s1']], ['This week', ['o0']]]);
  assert.deepEqual(reportGroups(report, 'project').map(group => [group.heading, group.stories.map(entry => entry.id)]), [['Billing', ['s0']], ['Website', ['s1']], ['Crafting table', ['s2']], ['This week', ['o0']]]);
  assert.deepEqual(reportGroups({ ...report, outlook: [] }, 'standup').map(group => group.heading), ['Done', 'Blocked']);
});

test('Slack text: headings, one bullet per line, a blank line between stories, Slack links, unticked stories left out', () => {
  assert.equal(slackText(report, { shape: 'standup', detail: 'normal', excluded: new Set(['s2']) }), [
    '*Standup · Sun 11 – Mon 12 Oct*',
    '',
    '*Done*',
    '',
    '*Cart totals were off by a cent*',
    '• Found that the cart rounded each line before adding them up.',
    '• Rounded once &amp; shipped the fix.',
    '<https://github.com/acme/billing/pull/114|#114 merged> · Claude · cart totals',
    '',
    '*Blocked*',
    '',
    '*Docs search in the site build*',
    '• Moved the search index into the docs build.',
    '• The deploy also changed page permissions; needs a decision.',
    '<https://github.com/acme/website/actions/runs/9|Docs release · V2 concerns>',
    '',
    '*This week*',
    '',
    '*Retry button for billing exports*',
    '• Waiting on review of &lt;#131&gt;.',
    '<https://github.com/acme/billing/pull/131|#131 open>',
  ].join('\n'));
});

test('Markdown text: the same structure with Markdown headings and links; Brief keeps one bullet', () => {
  assert.equal(markdownText(report, { shape: 'standup', detail: 'brief', excluded: new Set(['s1', 'o0']) }), [
    '## Standup · Sun 11 – Mon 12 Oct',
    '',
    '### Done',
    '',
    '**Cart totals were off by a cent**',
    '- Found that the cart rounded each line before adding them up.',
    '',
    'Evidence: [#114 merged](https://github.com/acme/billing/pull/114) · Claude · cart totals',
    '',
    '**Biome grounds**',
    '- Shipped biome grounds for neighborhoods.',
    '',
    'Evidence: Claude · biomes',
  ].join('\n'));
  assert.equal(markdownText(report, { shape: 'standup', detail: 'normal', excluded: new Set(['s0', 's1', 's2', 'o0']) }), '## Standup · Sun 11 – Mon 12 Oct');
});
