import test from 'node:test';
import assert from 'node:assert/strict';
import { actionRows } from './auto-deploy-actions.ts';
import type { ListedAction } from './auto-deploy-actions.ts';

const run = { label: 'On run #1842', resourceId: 'rollout-r' };
const events: ListedAction[] = [
  { at: 1, kind: 'armed', part: 'pull', text: 'armed by you' },
  { at: 1, kind: 'ready', part: 'pull', text: 'marked ready for review' },
  { at: 2, kind: 'rebase', part: 'pull', text: 'asked Claude · impl to rebase onto main (1/2)', links: [{ label: 'Claude · impl', resourceId: 'impl-r' }] },
  { at: 3, kind: 'findings', part: 'pull', text: 'sent 2 findings of Claude review to Claude · impl' },
  { at: 4, kind: 'merged', part: 'pull', text: 'merged into main' },
  { at: 5, kind: 'validate', part: 'rollout', text: 'asked Claude to validate staging · V1', group: run },
  { at: 6, kind: 'verdict', part: 'rollout', text: 'V1 passed', group: run },
  { at: 7, kind: 'approve', part: 'rollout', text: 'approved production', group: run },
];

test('the action list: newest last, a glyph and tone per kind, the rollout part under its run, the current step marked while armed', () => {
  const rows = actionRows(events, 'armed');
  assert.deepEqual(rows.map(row => row.type === 'group' ? `# ${row.label}` : `${row.glyph} ${row.tone} ${row.text}${row.now ? ' (now)' : ''}`), [
    'auto blue Armed by you', 'pr blue Marked ready for review', 'claude claude Asked Claude · impl to rebase onto main (1/2)', 'send claude Sent 2 findings of Claude review to Claude · impl', 'git-merge mint Merged into main',
    '# On run #1842', 'claude claude Asked Claude to validate staging · V1', 'check mint V1 passed', 'gate mint Approved production (now)']);
});

test('a halt is the amber last row; a finished list marks no current step; a verdict other than passed is amber', () => {
  const halted = actionRows([...events.slice(0, 4), { at: 9, kind: 'halted', part: 'pull', text: 'halted: The branch still has merge conflicts with main after 2 rebase attempts.' }], 'halted');
  assert.deepEqual(halted.at(-1), { type: 'action', at: 9, glyph: 'bang', tone: 'amber', text: 'Halted: The branch still has merge conflicts with main after 2 rebase attempts.', links: [] });
  assert.equal(actionRows(events, 'done').some(row => row.type === 'action' && row.now), false);
  assert.equal((actionRows([{ at: 1, kind: 'verdict', part: 'rollout', text: 'V1 found concerns', group: run }], 'halted')[1] as { tone: string }).tone, 'amber');
});
