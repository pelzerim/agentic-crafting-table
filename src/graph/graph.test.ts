import assert from 'node:assert/strict';
import test from 'node:test';
import { automaticLink, collectConnectedContext, impliedLinks, incomingContextSources, moveNode, moveProject, saveLink, shownLinks } from './graph.ts';
import type { GraphLink, GraphNode } from './graph.ts';
import { buildAgentLaunch } from '../agents/project-context.ts';

const nodes: GraphNode[] = [
  { id: 'pr', resourceId: 'pr-1', title: 'PR #48', position: { x: 10, y: 10 } },
  { id: 'page', resourceId: 'page-1', title: 'Project brief', position: { x: 100, y: 10 } },
  { id: 'agent', resourceId: 'session-1', title: 'Implementation', position: { x: 200, y: 20 }, acceptsContext: true },
];
const reference: GraphLink = { id: 'related', sourceId: 'pr', targetId: 'page', kind: 'reference', label: 'Implements' };
const context: GraphLink = { id: 'context', sourceId: 'page', targetId: 'agent', kind: 'context', label: 'Provides context' };

test('automatic connections point toward either context receiver regardless of drag direction', () => {
  for (const [from, to] of [[nodes[1], nodes[2]], [nodes[2], nodes[1]]]) {
    const link = automaticLink('auto', from, to);
    assert.deepEqual(link, { id: 'auto', sourceId: 'page', targetId: 'agent', kind: 'context', label: '' });
    assert.deepEqual(incomingContextSources('agent', nodes, saveLink(nodes, [], link)), [nodes[1]]);
  }
});

test('automatic connections prefer the drop target for two receivers and otherwise stay informational', () => {
  const extension = { ...nodes[0], id: 'custom-receiver', acceptsContext: true };
  for (const [from, to] of [[extension, nodes[2]], [nodes[2], extension]]) {
    const link = automaticLink('auto', from, to);
    assert.equal(link.kind, 'context'); assert.equal(link.sourceId, from.id); assert.equal(link.targetId, to.id);
    assert.equal(saveLink([...nodes, extension], [], link).length, 1);
  }
  const link = automaticLink('auto', nodes[0], nodes[1]);
  assert.deepEqual(link, { id: 'auto', sourceId: 'pr', targetId: 'page', kind: 'reference', label: '' });
  assert.deepEqual(incomingContextSources('agent', nodes, saveLink(nodes, [], link)), []);
});

test('invalid automatic links are rejected without an informational fallback or changes to saved links', () => {
  const original = [reference, context], before = structuredClone(original);
  assert.throws(() => saveLink(nodes, original, automaticLink('auto', nodes[2], nodes[1])), /already have/);
  assert.throws(() => saveLink(nodes, original, automaticLink('auto', nodes[2], nodes[0]), () => 'one'), /only one item/);
  assert.throws(() => saveLink(nodes, original, automaticLink('auto', nodes[2], nodes[2])), /itself/);
  assert.throws(() => saveLink(nodes, original, automaticLink('auto', nodes[0], { id: 'missing' })), /endpoints/);
  assert.deepEqual(original, before);
});

test('one-item limits cover directions, link kinds and aliases, but count distinct resources', () => {
  const all = [...nodes, { ...nodes[1], id: 'page-alias' }, { ...nodes[2], id: 'agent-alias' }];
  const cardinality = (n: GraphNode) => n.resourceId === 'page-1' ? 'one' as const : 'many' as const;
  const first = saveLink(all, [], context, cardinality);
  assert.throws(() => saveLink(all, first, reference, cardinality), /Project brief can connect to only one item/);
  assert.throws(() => saveLink(all, first, { ...reference, targetId: 'page-alias' }, cardinality), /only one item/);
  // A second semantic link to the same resource does not create a second partner.
  const samePair = saveLink(all, first, { ...reference, sourceId: 'agent-alias', targetId: 'page-alias' }, cardinality);
  assert.equal(samePair.length, 2);
  const archived = all.map(n => n.id === 'agent' ? { ...n, archivedAt: '2026-09-25', completedAt: '2026-09-25' } : n);
  assert.throws(() => saveLink(archived, first, reference, cardinality), /only one item/);
  assert.equal(saveLink(all, first, { ...context, targetId: 'pr', kind: 'reference' }, cardinality)[0].targetId, 'pr');
  assert.equal(saveLink(all, [], reference, cardinality).length, 1);
});

test('rules on both endpoints give one-to-one or one-to-many without type branches', () => {
  const first = saveLink(nodes, [], reference, () => 'one');
  assert.throws(() => saveLink(nodes, first, context, () => 'one'), /only one item/);
  assert.throws(() => saveLink(nodes, first, { ...context, sourceId: 'pr' }, () => 'one'), /only one item/);
  const onePage = (n: GraphNode) => n.id === 'page' ? 'one' as const : 'many' as const;
  assert.equal(saveLink(nodes, first, { ...context, sourceId: 'pr' }, onePage).length, 2);
});

test('moving a project preserves the offsets of every member without moving other projects or changing links', () => {
  const project = { id: 'billing', title: 'Billing', position: { x: 30, y: 40 } };
  const members: GraphNode[] = nodes.map(n => ({ ...n, projectId: 'billing' }));
  members[1].archivedAt = '2026-09-24';
  const other = { ...nodes[2], id: 'outside', projectId: 'other' };
  const before = [project, ...members, other];
  const moved = moveProject(before, 'billing', { x: -50, y: 120 });
  for (let i = 1; i <= members.length; i++) {
    assert.equal(moved[i].position.x - moved[0].position.x, before[i].position.x - project.position.x);
    assert.equal(moved[i].position.y - moved[0].position.y, before[i].position.y - project.position.y);
  }
  assert.equal(moved[2].archivedAt, '2026-09-24');
  assert.equal(moved.at(-1), other);
  assert.deepEqual(project.position, { x: 30, y: 40 });
  assert.deepEqual(incomingContextSources('agent', moved, [context]).map(n => n.id), ['page']);
  assert.deepEqual(moveProject(moved, 'billing', project.position), before);
  assert.throws(() => moveProject(before, 'agent', { x: 0, y: 0 }), /Project/);
  assert.throws(() => moveProject(before, 'billing', { x: Infinity, y: 0 }), /finite/);
});

test('moving any node changes only its position, including negative canvas coordinates', () => {
  const moved = moveNode(nodes, 'agent', { x: -100, y: 250 });
  assert.deepEqual(moved[2].position, { x: -100, y: 250 });
  assert.deepEqual(nodes[2].position, { x: 200, y: 20 });
  assert.equal(moved[2].resourceId, 'session-1');
  assert.deepEqual(incomingContextSources('agent', moved, [context]).map(n => n.id), ['page']);
  assert.throws(() => moveNode(nodes, 'agent', { x: NaN, y: 0 }), /finite/);
});

test('informational links are symmetric; context has a valid receiving endpoint', () => {
  assert.throws(() => saveLink(nodes, [reference], { ...reference, id: 'reverse', sourceId: 'page', targetId: 'pr' }), /already have/);
  assert.throws(() => saveLink(nodes, [], { ...context, targetId: 'pr' }), /point to an agent/);
  assert.throws(() => saveLink(nodes, [], { ...reference, targetId: 'missing' }), /endpoints/);
  assert.throws(() => saveLink(nodes, [], { ...reference, targetId: 'pr' }), /itself/);
});

test('an informational relationship never pulls a second-hop resource into context', async () => {
  const reads: string[] = [];
  const briefs = await collectConnectedContext('agent', nodes, [reference, context], async node => {
    reads.push(node.id);
    return { summary: 'Downgrades apply at the next billing cycle.' };
  });
  assert.deepEqual(reads, ['page']);
  const launch = buildAgentLaunch({ id: 'billing', name: 'Billing', goal: 'Improve plan changes.' }, 'codex', 'Implement.', undefined, briefs);
  assert.match(launch.initialPrompt, /Downgrades apply at the next billing cycle/);
  assert.ok(!launch.initialPrompt.includes('PR #48'));
  assert.ok(launch.initialPrompt.endsWith('Your task\nImplement.'));
});

test('aliases deduplicate context and editing/removing links preserves nodes', () => {
  const aliases = [...nodes, { ...nodes[1], id: 'page-alias' }];
  const links = [context, { ...context, id: 'alias-link', sourceId: 'page-alias' }];
  assert.equal(incomingContextSources('agent', aliases, links).length, 1);
  assert.throws(() => saveLink(aliases, [context], links[1]), /already have/);
  const changed = saveLink(nodes, [context], { ...context, kind: 'reference', label: 'Related' });
  assert.equal(incomingContextSources('agent', nodes, changed).length, 0);
  assert.equal(nodes.length, 3);
});

test('a hover-revealed link is left out until one of its ends or the link itself is revealed', () => {
  const hidden: GraphLink = { ...context, reveal: 'hover' };
  const shown = (revealed: string[]) => shownLinks([reference, hidden], new Set(revealed)).map(link => link.id);
  assert.deepEqual(shown([]), ['related']);
  assert.deepEqual(shown(['pr']), ['related']);
  assert.deepEqual(shown(['page']), ['related', 'context']);
  assert.deepEqual(shown(['agent']), ['related', 'context']);
  assert.deepEqual(shown(['context']), ['related', 'context']);
});

const edges = (kind: GraphLink['kind'], ...pairs: string[]): GraphLink[] => pairs.map(pair => ({ id: pair, sourceId: pair[0], targetId: pair[1], kind, label: '' }));
const implied = (links: GraphLink[]) => [...impliedLinks(links)].sort();

test('a link that a path of two or more other links of its kind already draws is implied', () => {
  assert.deepEqual(implied(edges('context', 'AB', 'BC', 'AC')), ['AC']);
  assert.deepEqual(implied(edges('context', 'AB', 'BC', 'CD', 'AD')), ['AD']);
  assert.deepEqual(implied(edges('context', 'AB', 'BC', 'AC', 'CD', 'AD')), ['AC', 'AD'], 'a link it hides still counts as a path');
  assert.deepEqual(implied(edges('context', 'AB', 'BC', 'CA')), [], 'context follows its direction');
  assert.deepEqual(implied(edges('context', 'AC', 'CB', 'AB')), ['AB']);
  assert.deepEqual(implied(edges('context', 'AB', 'BA')), [], 'a direct opposite link is not a path');
});

test('a diamond keeps both parallel paths and hides only its shortcut', () => {
  assert.deepEqual(implied(edges('context', 'AB', 'AD', 'BC', 'DC')), []);
  assert.deepEqual(implied(edges('context', 'AB', 'AD', 'BC', 'DC', 'AC')), ['AC']);
  assert.deepEqual(implied(edges('blocks', 'AB', 'AD', 'BC', 'DC', 'AC')), ['AC']);
});

test('reference links connect both ways, and a cycle drops one link, the later one, never both', () => {
  assert.deepEqual(implied(edges('reference', 'AB', 'CB', 'AC')), ['AC']);
  assert.deepEqual(implied(edges('reference', 'BC', 'AC', 'AB')), ['AB']);
  assert.deepEqual(implied(edges('reference', 'AB', 'BC', 'CD', 'DA')), ['DA']);
  assert.deepEqual(implied(edges('context', 'AB', 'BA', 'AC', 'BC')), ['BC']);
  assert.deepEqual(implied(edges('context', 'AB', 'BA', 'BC', 'AC')), ['AC']);
  const ring = edges('reference', 'AB', 'BC', 'CA');
  assert.deepEqual(implied(ring), implied(ring.map(link => ({ ...link }))), 'the same links give the same result');
});

test('only a blocking path implies a blocking link, so it stays beside a reference or context path', () => {
  assert.deepEqual(implied([...edges('reference', 'AB', 'BC'), ...edges('blocks', 'AC')]), ['BC']);
  assert.deepEqual(implied([...edges('context', 'AB', 'BC'), ...edges('blocks', 'AC')]), []);
  assert.deepEqual(implied([...edges('blocks', 'AB', 'BC', 'AC'), ...edges('reference', 'AB', 'BC').map(link => ({ ...link, id: `ref-${link.id}` }))]), ['AC']);
});

test('a path of any kinds implies a reference or context link', () => {
  assert.deepEqual(implied([...edges('blocks', 'AB', 'BC'), ...edges('reference', 'AC')]), ['AC']);
  assert.deepEqual(implied([...edges('reference', 'AB', 'BC'), ...edges('context', 'AC')]), ['AC']);
  assert.deepEqual(implied([...edges('context', 'AB'), ...edges('blocks', 'BC'), ...edges('reference', 'CD', 'AD')]), ['AD']);
  assert.deepEqual(implied([...edges('blocks', 'BC'), ...edges('context', 'AB', 'AC')]), ['AC'], 'a blocking link runs both ways in a path');
  assert.deepEqual(implied([...edges('context', 'BA'), ...edges('reference', 'BC'), ...edges('context', 'AC')]), ['BC'], 'context still follows its direction');
});

test('two pull requests in a blocking chain keep one line to the agent that made both', () => {
  const links = [...edges('reference', 'PA', 'QA', 'PT', 'QT'), ...edges('blocks', 'PQ')];
  assert.deepEqual(implied(links), ['QA', 'QT']);
});

test('removing a link of the path draws the implied link again', () => {
  const links = edges('context', 'AB', 'BC', 'AC');
  assert.deepEqual(implied(links), ['AC']);
  assert.deepEqual(implied(links.filter(link => link.id !== 'BC')), []);
  assert.deepEqual(implied(links.filter(link => link.id !== 'AB')), []);
});

test('hover links are no path, and are never implied themselves', () => {
  const [ab, bc, ac] = edges('context', 'AB', 'BC', 'AC');
  assert.deepEqual(implied([{ ...ab, reveal: 'hover' }, bc, ac]), []);
  assert.deepEqual(implied([ab, bc, { ...ac, reveal: 'hover' }]), []);
});

test('an implied link is drawn like a hover link: while an end or the link itself is revealed', () => {
  const links = edges('context', 'AB', 'BC', 'AC'), hidden = impliedLinks(links);
  const shown = (revealed: string[]) => shownLinks(links, new Set(revealed), hidden).map(link => link.id);
  assert.deepEqual(shown([]), ['AB', 'BC']);
  assert.deepEqual(shown(['B']), ['AB', 'BC']);
  assert.deepEqual(shown(['A']), ['AB', 'BC', 'AC']);
  assert.deepEqual(shown(['C']), ['AB', 'BC', 'AC']);
  assert.deepEqual(shown(['AC']), ['AB', 'BC', 'AC']);
  assert.deepEqual(shownLinks(links, new Set()).map(link => link.id), ['AB', 'BC', 'AC']);
});
