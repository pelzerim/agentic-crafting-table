import test from 'node:test';
import assert from 'node:assert/strict';
import { ATTENTION_NOTE_LENGTH, attentionAge, attentionCounts, attentionCountText, attentionDetails, attentionItems, attentionLabel, attentionNote, attentionReasons, attentionTier, attentionTierInfo, attentionTierOf, attentionTiers, needsMeButton, nodeAttention, attentionRestorable } from './attention.ts';
import { projectActivity } from './project-neighborhoods.ts';

test('global attention deduplicates aliases and reasons, retains done items and excludes archived projects', () => {
  const node = (id: string, projectId?: string) => ({ id, title: id, position: { x: 0, y: 0 }, projectId });
  const nodes = [node('project'), { ...node('hidden'), archivedAt: 'archived' },
    { ...node('agent', 'project'), resourceId: 'session', activity: 'working', attention: 'input', completedAt: 'done' },
    { ...node('alias'), resourceId: 'session', attention: 'error' },
    { ...node('review', 'project'), resourceId: 'pr', attention: 'review' },
    { ...node('review-copy', 'project'), resourceId: 'pr', attention: 'review' },
    { ...node('hidden-child', 'hidden'), resourceId: 'lost', attention: 'error' },
    { ...node('archived'), resourceId: 'old', attention: 'input', archivedAt: 'archived' },
  ];
  const before = structuredClone(nodes), global = attentionItems(nodes);
  assert.equal(global.length, 2);
  assert.equal(global[0].node.id, 'alias'); assert.deepEqual(global[0].reasons, ['error', 'input']);
  assert.deepEqual(global[1].reasons, ['review']); assert.equal(global[1].aliases.length, 2);
  assert.equal(attentionItems(nodes, 'project')[0].node.id, 'agent');
  assert.deepEqual(projectActivity('project', nodes), { working: 1, needsMe: 2, asking: 1, turn: 1, finished: 0 });
  assert.deepEqual(attentionItems([...nodes].reverse()).map(({ identity, node, reasons }) => ({ identity, node, reasons })), global.map(({ identity, node, reasons }) => ({ identity, node, reasons })));
  assert.deepEqual(nodes, before);
});

test('one item can retain multiple independent attention sources', () => {
  const node = { id: 'pr', resourceId: 'resource', title: 'PR', attention: 'input', position: { x: 0, y: 0 }, attentionSources: { 'github.assignment': 'assigned', 'workflow.review': 'error' }, completedAt: 'done' };
  assert.deepEqual(attentionItems([node])[0].reasons, ['error', 'input', 'assigned']);
  assert.deepEqual(attentionItems([{ ...node, attentionSources: { 'workflow.review': 'error' } }])[0].reasons, ['error', 'input']);
  assert.equal(attentionItems([{ ...node, archivedAt: 'archived' }]).length, 0);
});

test('attention notes are one short plain line', () => {
  assert.equal(attentionNote('  Job needs\napproval.  '), 'Job needs approval');
  assert.equal(attentionNote('Agent\u0007 waiting​'), 'Agent waiting');
  assert.equal(attentionNote(' \n '), undefined); assert.equal(attentionNote(undefined), undefined);
  const long = attentionNote('The release of the photo gallery needs your approval before it goes live');
  assert.equal([...long!].length, ATTENTION_NOTE_LENGTH); assert.ok(long!.endsWith('…'));
});

test('items carry trigger notes in reason order and fall back to the category label per signal', () => {
  const base = { title: 'Rollout', position: { x: 0, y: 0 }, resourceId: 'rollout' };
  const nodes: Parameters<typeof attentionItems>[0][number][] = [
    { ...base, id: 'a', attention: 'input', attentionNote: 'Agent waiting', attentionSources: { completion: 'finished', 'provider:x': 'error' }, attentionNotes: { 'provider:x': 'Rollout failed' } },
    { ...base, id: 'b', attentionSources: { 'provider:x': 'error', other: 'finished' }, attentionNotes: { 'provider:x': 'Rollout failed', other: 'Agent finished' } },
  ];
  const [item] = attentionItems(nodes);
  assert.deepEqual(item.notes, ['Rollout failed', 'Agent waiting', 'Agent finished']);
  assert.deepEqual(item.details, ['Rollout failed', 'Agent waiting', 'Agent finished'], 'a reason noted anywhere drops its generic label');
  const plain = attentionItems([{ ...base, id: 'c', attention: 'review', attentionSources: { completion: 'finished' }, attentionNotes: { completion: 'Agent finished' } }])[0];
  assert.deepEqual([plain.notes, plain.details], [['Agent finished'], ['Ready for your review', 'Agent finished']]);
  assert.deepEqual(attentionDetails([{ ...nodes[0], attentionSeenVersion: 0 }]), { notes: [], details: [] }, 'seen signals have no notes');
});

const at = (id: string, extra: Record<string, unknown>) => ({ id, title: id, position: { x: 0, y: 0 }, resourceId: `r-${id}`, ...extra });

test('every reason has exactly one tier: stopped work asks, waiting work is my turn, results are finished', () => {
  assert.deepEqual(Object.keys(attentionTierOf).sort(), Object.keys(attentionReasons).sort());
  const byTier = (tier: string) => Object.entries(attentionTierOf).filter(([, value]) => value === tier).map(([reason]) => reason).sort();
  assert.deepEqual(byTier('asking'), ['error', 'input']);
  assert.deepEqual(byTier('turn'), ['assigned', 'checks-failing', 'comment', 'review', 'validation']);
  assert.deepEqual(byTier('finished'), ['approved', 'finished']);
  assert.deepEqual(attentionTiers.map(tier => attentionTierInfo[tier].name), ['Asking me', 'My turn', 'Finished']);
  assert.deepEqual(attentionTiers.map(tier => attentionTierInfo[tier].glyph), ['asking', 'my-turn', 'finished']);
});

test('an item takes its highest tier; the list sorts by tier, then the longest wait first', () => {
  assert.equal(attentionTier(['finished', 'review']), 'turn'); assert.equal(attentionTier(['approved', 'input']), 'asking'); assert.equal(attentionTier([]), undefined);
  const nodes = [
    at('done', { attention: 'finished', attentionAt: '2026-10-01T08:00:00.000Z' }),
    at('review-new', { attention: 'review', attentionAt: '2026-10-06T08:00:00.000Z' }),
    at('checks-old', { attention: 'checks-failing', attentionAt: '2026-10-05T08:00:00.000Z' }),
    at('ask-new', { attention: 'input', attentionAt: '2026-10-06T09:00:00.000Z' }),
    at('ask-old', { attention: 'error', attentionAt: '2026-10-06T07:00:00.000Z' }),
    at('ask-undated', { attention: 'input' }),
    at('both', { attention: 'none', attentionSources: { completion: 'finished', gate: 'input' }, attentionAt: '2026-10-06T08:30:00.000Z' }),
  ];
  const items = attentionItems(nodes);
  assert.deepEqual(items.map(item => [item.node.id, item.tier]), [['ask-old', 'asking'], ['both', 'asking'], ['ask-new', 'asking'], ['ask-undated', 'asking'], ['checks-old', 'turn'], ['review-new', 'turn'], ['done', 'finished']]);
  assert.equal(items[0].since, '2026-10-06T07:00:00.000Z'); assert.equal(items[3].since, undefined);
  assert.deepEqual(attentionItems([...nodes].reverse()).map(item => item.node.id), items.map(item => item.node.id));
});

test('the Needs me number counts Asking me and My turn; Finished is listed and counted only on request', () => {
  const items = attentionItems([at('a', { attention: 'input' }), at('b', { attention: 'review' }), at('c', { attention: 'comment' }), at('d', { attention: 'finished' }), at('e', { attention: 'approved' })]);
  assert.deepEqual(attentionCounts(items), { asking: 1, turn: 2, finished: 2, needsMe: 3, top: 'asking' });
  assert.deepEqual(attentionCounts(items, { countFinished: true }), { asking: 1, turn: 2, finished: 2, needsMe: 5, top: 'asking' });
  assert.deepEqual(attentionCounts(items.filter(item => item.tier === 'finished')), { asking: 0, turn: 0, finished: 2, needsMe: 0, top: 'finished' });
  assert.deepEqual(attentionCounts([]), { asking: 0, turn: 0, finished: 0, needsMe: 0 });
});

test('one wording: counts, labels and the rail button name the tiers the same way', () => {
  assert.equal(attentionCountText({ asking: 2, turn: 3, finished: 1 }), '2 asking · 3 my turn · 1 finished');
  assert.equal(attentionCountText({ asking: 0, turn: 1, finished: 0 }), '1 my turn'); assert.equal(attentionCountText({ asking: 0, turn: 0, finished: 0 }), '');
  assert.equal(attentionLabel('asking', 'Needs permission'), 'Asking me: Needs permission'); assert.equal(attentionLabel('finished'), 'Finished');
  assert.deepEqual(needsMeButton(attentionCounts([{ tier: 'asking' }, { tier: 'turn' }, { tier: 'finished' }])), { label: 'Needs me: 2', title: 'Needs me · 1 asking · 1 my turn · 1 finished' });
  assert.deepEqual(needsMeButton(attentionCounts([{ tier: 'finished' }])), { label: 'Needs me', title: 'Needs me · 1 finished' }, 'finished work is named, never counted');
  assert.deepEqual(needsMeButton(attentionCounts([])), { label: 'Needs me', title: 'Needs me · nothing needs me' });
});

test('a card reads its own tier, reason and age; seen attention has none', () => {
  const node = at('a', { attention: 'review', attentionSources: { gate: 'input' }, attentionNotes: { gate: 'Needs permission to push' }, attentionAt: '2026-10-06T08:00:00.000Z' });
  assert.deepEqual(nodeAttention(node), { tier: 'asking', reasons: ['input', 'review'], detail: 'Needs permission to push · Ready for your review', details: ['Needs permission to push', 'Ready for your review'], since: '2026-10-06T08:00:00.000Z' });
  assert.equal(nodeAttention({ ...node, attentionVersion: 2, attentionSeenVersion: 2 }), undefined);
  const now = Date.parse('2026-10-06T12:00:00.000Z');
  assert.deepEqual(['2026-10-06T11:59:40.000Z', '2026-10-06T11:56:00.000Z', '2026-10-06T08:00:00.000Z', '2026-10-04T11:00:00.000Z', undefined, 'nonsense'].map(since => attentionAge(since, now)), ['now', '4m', '4h', '2d', '', '']);
});

test('a validation with concerns asks to hold the release', () => {
  assert.equal(attentionReasons.validation, 'Validation concerns · hold the release');
});

test('a receipt is restorable while its cycles are unchanged and still carry a reason', () => {
  const node = { id: 'a', resourceId: 'r', title: 'a', attention: 'input', attentionVersion: 2, attentionSeenVersion: 2 } as Parameters<typeof attentionRestorable>[0][number];
  assert.deepEqual(attentionRestorable([node], { id: 'a', versions: { a: 2 } }), { tier: 'asking' });
  assert.equal(attentionRestorable([node], { id: 'a', versions: { a: 1 } }), undefined, 'a newer cycle');
  assert.equal(attentionRestorable([{ ...node, attention: 'none' }], { id: 'a', versions: { a: 2 } }), undefined, 'the reason is gone');
  assert.equal(attentionRestorable([node], { id: 'a', versions: {} }), undefined, 'nothing was acknowledged');
});
